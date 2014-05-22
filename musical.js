(function(global, module, define) {

// A variable that can be used to interrupt things.
var interrupted = false;

// Tests for the presence of HTML5 Web Audio (or webkit's version).
function isAudioPresent() {
  return !!(global.AudioContext || global.webkitAudioContext);
}

// All our audio funnels through the same AudioContext with a
// DynamicsCompressorNode used as the main output, to compress the
// dynamic range of all audio.  getAudioTop sets this up.
var audioTop = null;
function getAudioTop() {
  if (!audioTop) {
    var ac = new (global.AudioContext || global.webkitAudioContext),
        firstTime = null;
    audioTop = {
      ac: ac,
      out: null
    }
    resetAudio();
  }
  return audioTop;
}

// When audio needs to be interrupted globally (e.g., when you press the
// stop button in the IDE), resetAudio does the job.
function resetAudio() {
  if (audioTop) {
    // Disconnect the top-level node and make a new one.
    if (audioTop.out) {
      audioTop.out.disconnect();
      audioTop.out = null;
    }
    var dcn = audioTop.ac.createDynamicsCompressor();
    dcn.ratio = 16;
    dcn.attack = 0.0005;
    dcn.connect(audioTop.ac.destination);
    audioTop.out = dcn;
  }
}

// For precise scheduling of future notes, the AudioContext currentTime is
// cached and is held constant until the script releases to the event loop.
var audioDelay = 0.00;    // Adjust to delay the start of any sound.
function audioCurrentStartTime() {
  if (audioTop.currentStart != null) {
    return audioTop.currentStart;
  }
  audioTop.currentStart = audioTop.ac.currentTime + audioDelay;
  setTimeout(function() { audioTop.currentStart = null; }, 0);
  return audioTop.currentStart;
}

// All further details of audio handling are encapsulated in the Instrument
// class, which knows how to synthesize a basic timbre; how to play and
// schedule a tone; and how to parse and sequence a song written in ABC
// notation.
var Instrument = (function() {
  // The constructor accepts a timbre string or object, specifying
  // its default sound.  The main mechanisms in Instrument are for handling
  // sequencing of a (potentially large) set of notes over a (potentially
  // long) period of time.  The overall strategy:
  //
  //                       Events:      'noteon'        'noteoff'
  //                                      |               |
  // tone()-(quick tones)->| _startSet -->| _finishSet -->| _cleanupSet -->|
  //   \                   |  /           | Playing tones | Done tones     |
  //    \---- _queue ------|-/                                             |
  //      of future tones  |3 secs ahead sent to WebAudio, removed when done
  //
  // The reason for this queuing is to reduce the complexity of the
  // node graph sent to WebAudio: at any time, WebAudio is only
  // responsible for about 3 seconds of music.  If too many nodes
  // are sent to WebAudio at once, audio output distorts badly.
  function Instrument(options) {
    this._timbre = parseTimbre(options);  // The default timbre.
    this._queue = [];                     // A queue of future tones to play.
    this._minQueueTime = Infinity;        // The earliest time in _queue.
    this._maxScheduledTime = 0;           // The latest time in _queue.
    this._unsortedQueue = false;          // True if _queue is unsorted.
    this._startSet = [];                  // Unstarted tones sent to WebAudio.
    this._finishSet = {};                 // Started tones playing in WebAudio.
    this._cleanupSet = [];                // Tones waiting for cleanup.
    this._conflictCount = 0;              // Counter for early ended tones.
    this._callbackSet = [];               // A set of scheduled callbacks.
    this._handlers = {};                  // 'noteon' and 'noteoff' handlers.
    this._now = null;                     // A cached current-time value.
    if (isAudioPresent()) {
      this.silence();                     // Initializes top-level audio node.
    }
  }

  Instrument.bufferSecs = 3;     // Seconds ahead to put notes in WebAudio.
  Instrument.toneLength = 10;    // Default duration of a tone.
  Instrument.cleanupDelay = 0.1; // Silent time before disconnecting gain nodes.
  Instrument.nowDelay = 0.00;    // Adjust to delay the start of any sound.

  // Sets the default timbre for the instrument.  See defaultTimbre.
  Instrument.prototype.setTimbre = function(t) {
    this._timbre = parseTimbre(t);
  };
  // Returns the default timbre for the instrument as a string.
  Instrument.prototype.getTimbre = function(t) {
    return printOptionAsString(this._timbre);
  };
  // Silences the instrument immediately by reinitializing the audio system
  // and emptying the scheduler.  Carefully notifies all notes that have
  // started but not yet finished, and sequences that are awaiting
  // scheduled callbacks.  Doesn't notify notes that have not yet started.
  Instrument.prototype.silence = function() {
    var j;
    // Clear future notes.
    this._queue.length = 0;
    this._minQueueTime = Infinity;
    this._maxScheduledTime = 0;
    // Don't notify notes that haven't started yet.
    this._startSet.length = 0;
    // Flush finish callbacks that are promised.
    for (j in this._finishSet) if (this._finishSet.hasOwnProperty(j)) {
      this._trigger('noteoff', this._finishSet[j]);
    }
    this._finishSet = {};
    // Flush one-time callacks that are promised.
    for (j = 0; j < this._callbackSet.length; ++j) {
      this._callbackSet[j].callback();
    }
    this._callbackSet.length = 0;
    if (this._out) {
      this._out.disconnect();
    }
    this._atop = getAudioTop();
    this._out = this._atop.ac.createGain();
    this._out.gain.value = this._timbre.gain;
    this._out.connect(this._atop.out);
  };
  // Future notes should be scheduled relative to now(), which provides
  // access to audioCurrentStartTime(), a time that holds steady until.
  // until the script releases to the event loop.  (_doPoll clears the
  // cached _now).
  Instrument.prototype.now = function() {
    if (this._now != null) {
      return this._now;
    }
    this._startPollTimer(true);
    this._now = audioCurrentStartTime();
    return this._now;
  };
  // Register an event handler.  Done without jQuery to reduce dependencies.
  Instrument.prototype.on = function(ev, cb) {
    if (!this._handlers.hasOwnProperty(ev)) {
      this._handlers[ev] = [];
    }
    this._handlers[ev].push(cb);
  };
  // Unregister an event handler.  Done without jQuery to reduce dependencies.
  Instrument.prototype.off = function(ev, cb) {
    if (this._handlers.hasOwnProperty(ev)) {
      if (!cb) {
        this._handlers[ev] = [];
      } else {
        var j, hunt = this._handlers[ev];
        for (j = 0; j < hunt.length; ++j) {
          if (hunt[j] === cb) {
            hunt.splice(j, 1);
            j -= 1;
          }
        }
      }
    }
  };
  // Trigger an event, notifying any registered handlers.
  Instrument.prototype._trigger = function(ev, record) {
    var cb = this._handlers[ev], j;
    if (!cb) {
      return;
    }
    for (j = 0; j < cb.length; ++j) {
      cb[j](record);
    }
  };
  // Tells the WebAudio API to play a tone (now or soon).  The passed
  // record specifies a start time and release time, an ADSR envelope,
  // and other timbre parameters.  This function sets up a WebAudio
  // node graph for the tone generators and filters for the tone.
  Instrument.prototype._makeSound = function(record) {
    var timbre = record.timbre || this._timbre,
        starttime = record.time,
        releasetime = starttime + record.duration,
        attacktime = Math.min(releasetime, starttime + timbre.attack),
        decaystarttime = attacktime,
        stoptime = releasetime + timbre.release,
        doubled = timbre.detune && timbre.detune != 1.0,
        amp = timbre.gain * record.velocity * (doubled ? 0.5 : 1.0),
        ac = this._atop.ac,
        g, f, o, o2, pwave, k, wf, bwf;
    // Only hook up tone generators if it is an audible sound.
    if (record.duration > 0 && record.velocity > 0) {
      g = ac.createGain();
      g.gain.setValueAtTime(0, starttime);
      g.gain.linearRampToValueAtTime(amp, attacktime);
      // For the beginning of the decay, use linearRampToValue instead
      // of setTargetAtTime, because it avoids http://crbug.com/254942.
      while (decaystarttime < attacktime + 1/32 &&
             decaystarttime + 1/256 < releasetime) {
        // Just trace out the curve in increments of 1/256 sec
        // for up to 1/32 seconds.
        decaystarttime += 1/256;
        g.gain.linearRampToValueAtTime(
            amp * (timbre.sustain + (1 - timbre.sustain) *
                Math.exp((attacktime - decaystarttime) / timbre.decay)),
            decaystarttime);
      }
      // For the rest of the decay, use setTargetAtTime.
      g.gain.setTargetAtTime(amp * timbre.sustain,
          decaystarttime, timbre.decay);
      // Then at release time, mark the value and ramp to zero.
      g.gain.setValueAtTime(amp * (timbre.sustain + (1 - timbre.sustain) *
          Math.exp((attacktime - releasetime) / timbre.decay)), releasetime);
      g.gain.linearRampToValueAtTime(0, stoptime);
      g.connect(this._out);
      // Hook up a low-pass filter if cutoff is specified.
      if ((!timbre.cutoff && !timbre.cutfollow) || timbre.cutoff == Infinity) {
        f = g;
      } else {
        // Apply the cutoff frequency, but if the note is higher or lower
        // than that frequency, adjust the cutoff frequency using cutfollow.
        f = ac.createBiquadFilter();
        f.frequency.value = timbre.cutoff +
           (record.frequency - timbre.cutoff) * timbre.cutfollow;
        f.Q.value = timbre.resonance;
        f.connect(g);
      }
      // Hook up the main oscillator.
      function makeOscillator() {
        var o = ac.createOscillator();
        try {
          if (wavetable.hasOwnProperty(timbre.wave)) {
            // Use a customized wavetable.
            pwave = wavetable[timbre.wave].wave;
            if (wavetable[timbre.wave].freq) {
              bwf = 0;
              // Look for a higher-frequency variant.
              for (k in wavetable[timbre.wave].freq) {
                wf = Number(k);
                if (record.frequency > wf && wf > bwf) {
                  bwf = wf;
                  pwave = wavetable[timbre.wave].freq[bwf];
                }
              }
            }
            o.setPeriodicWave(pwave);
          } else {
            o.type = timbre.wave;
          }
        } catch(e) {
          if (window.console) { window.console.log(e); }
          // If unrecognized, just use square.
          // TODO: support "noise" or other wave shapes.
          o.type = 'square';
        }
        return o;
      }
      o = makeOscillator();
      o.frequency.value = record.frequency;
      o.connect(f);
      o.start(starttime);
      o.stop(stoptime);
      // Hook up a detuned oscillator.
      if (doubled) {
        o2 = makeOscillator();
        o2.frequency.value = record.frequency * timbre.detune;
        o2.connect(f);
        o2.start(starttime);
        o2.stop(stoptime);
      }
      // Store nodes in the record so that they can be modified
      // in case the tone is truncated later.
      record.gainNode = g;
      record.oscillators = [o];
      if (doubled) { record.oscillators.push(o2); }
      record.cleanuptime = stoptime;
    } else {
      // Inaudible sounds are scheduled: their purpose is to truncate
      // audible tones at the same pitch.  But duration is set to zero
      // so that they are cleaned up quickly.
      record.duration = 0;
    }
    this._startSet.push(record);
  };
  // Truncates a sound previously scheduled by _makeSound by using
  // cancelScheduledValues and directly ramping down to zero.
  // Can only be used to shorten a sound.
  Instrument.prototype._truncateSound = function(record, releasetime) {
    if (releasetime < record.time + record.duration) {
      record.duration = Math.max(0, releasetime - record.time);
      if (record.gainNode) {
        var timbre = record.timbre || this._timbre,
            starttime = record.time,
            attacktime = Math.min(releasetime, starttime + timbre.attack),
            stoptime = releasetime + timbre.release,
            cleanuptime = stoptime + Instrument.cleanupDelay,
            doubled = timbre.detune && timbre.detune != 1.0,
            amp = timbre.gain * record.velocity * (doubled ? 0.5 : 1.0),
            j, g = record.gainNode;
        // Cancel any envelope points after the new releasetime.
        g.gain.cancelScheduledValues(releasetime);
        if (releasetime <= starttime) {
          // Release before start?  Totally silence the note.
          g.gain.setValueAtTime(0, releasetime);
        } else if (releasetime <= attacktime) {
          // Release before attack is done?  Interrupt ramp up.
          g.gain.linearRampToValueAtTime(
            amp * (releasetime - starttime) / (attacktime - starttime));
        } else {
          // Release during decay?  Interrupt decay down.
          g.gain.setValueAtTime(amp * (timbre.sustain + (1 - timbre.sustain) *
            Math.exp((attacktime - releasetime) / timbre.decay)), releasetime);
        }
        // Then ramp down to zero according to record.release.
        g.gain.linearRampToValueAtTime(0, stoptime);
        // After stoptime, stop the oscillators.  This is necessary to
        // eliminate extra work for WebAudio for no-longer-audible notes.
        if (record.oscillators) {
          for (j = 0; j < record.oscillators.length; ++j) {
            record.oscillators[j].stop(stoptime);
          }
        }
        // Schedule disconnect.
        record.cleanuptime = cleanuptime;
      }
    }
  };
  // The core scheduling loop is managed by Instrument._doPoll.  It reads
  // the audiocontext's current time and pushes tone records from one
  // stage to the next.
  //
  // 1. The first stage is the _queue, which has tones that have not
  //    yet been given to WebAudio. This loop scans _queue to find
  //    notes that need to begin in the next few seconds; then it
  //    sends those to WebAduio and moves them to _startSet. Because
  //    scheduled songs can be long, _queue can be large.
  //
  // 2. Second is _startSet, which has tones that have been given to
  //    WebAudio, but whose start times have not yet elapsed. When
  //    the time advances past the start time of a record, a 'noteon'
  //    notification is fired for the tone, and it is moved to
  //    _finishSet.
  //
  // 3. _finishSet represents the notes that are currently sounding.
  //    The programming model for Instrument is that only one tone of
  //    a specific frequency may be played at once within a Instrument,
  //    so only one tone of a given frequency may exist in _finishSet
  //    at once.  When there is a conflict, the sooner-to-end-note
  //    is truncated.
  //
  // 4. After a note is released, it may have a litle release time
  //    (depending on timbre.release), after which the nodes can
  //    be totally disconnected and cleaned up.  _cleanupSet holds
  //    notes for which we are awaiting cleanup.
  Instrument.prototype._doPoll = function() {
    this._pollTimer = null;
    this._now = null;
    if (interrupted) {
      this.silence();
      return;
    }
    var now = this._atop.ac.currentTime,
        j, work, when, freq, record, conflict, save;
    // Schedule a batch of notes
    if (this._minQueueTime - now <= Instrument.bufferSecs) {
      if (this._unsortedQueue) {
        this._queue.sort(function(a, b) {
          if (a.time != b.time) { return a.time - b.time; }
          if (a.duration != b.duration) { return a.duration - b.duration; }
          return a.frequency - b.frequency;
        });
        this._unsortedQueue = false;
      }
      for (j = 0; j < this._queue.length; ++j) {
        if (this._queue[j].time - now > Instrument.bufferSecs) { break; }
      }
      if (j > 0) {
        work = this._queue.splice(0, j);
        for (j = 0; j < work.length; ++j) {
          this._makeSound(work[j]);
        }
        this._minQueueTime =
          (this._queue.length > 0) ? this._queue[0].time : Infinity;
      }
    }
    // Disconnect notes from the cleanup set.
    for (j = 0; j < this._cleanupSet.length; ++j) {
      record = this._cleanupSet[j];
      if (record.cleanuptime < now) {
        if (record.gainNode) {
          // This explicit disconnect is needed or else Chrome's WebAudio
          // starts getting overloaded after a couple thousand notes.
          record.gainNode.disconnect();
          record.gainNode = null;
        }
        this._cleanupSet.splice(j, 1);
        j -= 1;
      }
    }
    // Notify about any notes finishing.
    for (freq in this._finishSet) if (this._finishSet.hasOwnProperty(freq)) {
      record = this._finishSet[freq];
      when = record.time + record.duration;
      if (when <= now) {
        this._trigger('noteoff', record);
        if (record.cleanuptime != Infinity) {
          this._cleanupSet.push(record);
        }
        delete this._finishSet[freq];
      }
    }
    // Call any specific one-time callbacks that were registered.
    for (j = 0; j < this._callbackSet.length; ++j) {
      if (this._callbackSet[j].time <= now) {
        this._callbackSet[j].callback();
        this._callbackSet.splice(j, 1);
        j -= 1;
      }
    }
    // Notify about any notes starting.
    for (j = 0; j < this._startSet.length; ++j) {
      if (this._startSet[j].time <= now) {
        save = record = this._startSet[j];
        freq = record.frequency;
        conflict = null;
        if (this._finishSet.hasOwnProperty(freq)) {
          // If there is already a note at the same frequency playing,
          // then release the one that starts first, immediately.
          conflict = this._finishSet[freq];
          if (conflict.time < record.time || (conflict.time == record.time &&
              conflict.duration < record.duration)) {
            // Our new sound conflicts with an old one: end the old one
            // and notify immediately of its noteoff event.
            this._truncateSound(conflict, record.time);
            this._trigger('noteoff', conflict);
            delete this._finishSet[freq];
          } else {
            // A conflict from the future has already scheduled,
            // so our own note shouldn't sound.  Truncate ourselves
            // immediately, and suppress our own noteon and noteoff.
            this._truncateSound(record, conflict.time);
            conflict = record;
          }
        }
        this._startSet.splice(j, 1);
        j -= 1;
        if (record.duration > 0 && record.velocity > 0 && conflict !== record) {
          this._finishSet[freq] = record;
          this._trigger('noteon', record);
        }
      }
    }
    this._startPollTimer();
  };
  // Schedules the next _doPoll call by examining times in the various
  // sets and determining the soonest event that needs _doPoll processing.
  Instrument.prototype._startPollTimer = function(soon) {
    var instrument = this,
        earliest = Infinity, j, delay;
    if (this._pollTimer) {
      if (this._now != null) {
        // We have already set the poll timer to come back instantly.
        return;
      }
      // We might have updated information: clear the timer and look again.
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
    if (soon) {
      // Timer due to now() call: schedule immediately.
      earliest = 0;
    } else {
      // Timer due to notes starting: wake up for 'noteon' notification.
      for (j = 0; j < this._startSet.length; ++j) {
        earliest = Math.min(earliest, this._startSet[j].time);
      }
      // Timer due to notes finishing: wake up for 'noteoff' notification.
      for (j in this._finishSet) if (this._finishSet.hasOwnProperty(j)) {
        earliest = Math.min(
          earliest, this._finishSet[j].time + this._finishSet[j].duration);
      }
      // Timer due to scheduled callback.
      for (j = 0; j < this._callbackSet.length; ++j) {
        earliest = Math.min(earliest, this._callbackSet[j].time);
      }
      // Timer due to cleanup: add a second to give some time to batch up.
      if (this._cleanupSet.length > 0) {
        earliest = Math.min(earliest, this._cleanupSet[0].cleanuptime + 1);
      }
      // Timer due to sequencer events: subtract a second to stay ahead.
      earliest = Math.min(earliest, this._minQueueTime - 1);
    }
    delay = Math.max(0, earliest - this._atop.ac.currentTime);
    if (isNaN(delay)) {
      return;
    }
    if (delay == Infinity) { return; }
    this._pollTimer = setTimeout(
        function() { instrument._doPoll(); }, Math.round(delay * 1000));
  };
  // The low-level tone function.
  Instrument.prototype.tone =
  function(pitch, velocity, duration, delay, timbre) {
    if (!this._atop) {
      return { release: (function() {}) };
    }
    var midi, frequency;
    if (!pitch) { pitch = 'C'; }
    if (isNaN(pitch)) {
      midi = pitchToMidi(pitch);
      frequency = midiToFrequency(midi);
    } else {
      frequency = Number(pitch);
      if (frequency < 0) {
        midi = -frequency;
        frequency = midiToFrequency(midi);
      } else {
        midi = frequencyToMidi(frequency);
      }
    }
    var ac = this._atop.ac,
        now = this.now(),
        time = now + (delay || 0),
        record = {
          time: time,
          on: false,
          frequency: frequency,
          midi: midi,
          velocity: (velocity == null ? 1 : velocity),
          duration: (duration == null ? Instrument.toneLength : duration),
          timbre: timbre,
          instrument: this,
          gainNode: null,
          oscillators: null,
          cleanuptime: Infinity
        };
    if (time < now + Instrument.bufferSecs) {
      this._makeSound(record);
    } else {
      if (!this._unsortedQueue && this._queue.length &&
          time < this._queue[this._queue.length -1].time) {
        this._unsortedQueue = true;
      }
      this._queue.push(record);
      this._minQueueTime = Math.min(this._minQueueTime, record.time);

    }
  };
  // The low-level callback scheduling method.
  Instrument.prototype.schedule = function(delay, callback) {
    this._callbackSet.push({ time: this.now() + delay, callback: callback });
  };
  // The high-level sequencing method.
  Instrument.prototype.play = function(abcstring) {
    var args = Array.prototype.slice.call(arguments),
        done = null,
        opts = {}, subfile,
        abcfile, argindex, tempo, timbre, k, delay, maxdelay = 0, attenuate,
        voicename, stems, ni, vn, j, stem, note, beatsecs, secs, files = [];
    // Look for continuation as last argument.
    if (args.length && 'function' == typeof(args[args.length - 1])) {
      done = args.pop();
    }
    if (!this._atop) {
      if (done) { done(); }
      return;
    }
    // Look for options as first object.
    argindex = 0;
    if ('object' == typeof(args[0])) {
      for (k in args[0]) if (args[0].hasOwnProperty(k)) {
        opts[k] = args[0][k];
      }
      argindex = 1;
    }
    // Parse any number of ABC files as input.
    for (; argindex < args.length; ++argindex) {
      // Handle splitting of ABC subfiles at X: lines.
      subfile = args[argindex].split(/\n(?=X:)/);
      for (k = 0; k < subfile.length; ++k) {
        abcfile = parseABCFile(subfile[k]);
        if (!abcfile) continue;
        // Take tempo markings from the first file, and share them.
        if (!opts.tempo && abcfile.tempo) {
          opts.tempo = abcfile.tempo;
          if (abcfile.unitbeat) {
            opts.tempo *= abcfile.unitbeat / (abcfile.unitnote || 1);
          }
        }
        // Ignore files without songs.
        if (!abcfile.voice) continue;
        files.push(abcfile);
      }
    }
    // Default tempo to 120 if nothing else is specified.
    if (!opts.tempo) { opts.tempo = 120; }
    beatsecs = 60.0 / opts.tempo;
    // Schedule all notes from all the files.
    for (k = 0; k < files.length; ++k) {
      abcfile = files[k];
      // Each file can have multiple voices (e.g., left and right hands)
      for (vn in abcfile.voice) if (abcfile.voice.hasOwnProperty(vn)) {
        // Each voice could have a separate timbre.
        timbre = parseTimbre(opts.timbre || abcfile.voice[vn].timbre ||
           abcfile.timbre || this._timbre);
        // Each voice has a series of stems (notes or chords).
        stems = abcfile.voice[vn].stems;
        if (!stems) continue;
        // Starting at delay zero (now), schedule all tones.
        delay = 0;
        for (ni = 0; ni < stems.length; ++ni) {
          stem = stems[ni];
          // Attenuate chords to reduce clipping.
          attenuate = 1 / Math.sqrt(stem.note.length);
          // Schedule every note inside a stem.
          for (j = 0; j < stem.note.length; ++j) {
            note = stem.note[j];
            if (note.holdover) {
              // Skip holdover notes from ties.
              continue;
            }
            secs = (note.time || stem.time) * beatsecs;
            if (stem.staccato) {
              // Shorten staccato notes.
              secs = Math.min(Math.min(secs, beatsecs / 16),
                  timbre.attack + timbre.decay);
            }
            this.tone(                     // Play the tone:
              note.pitch,                  // at the given pitch
              note.velocity || attenuate,  // with the given volume
              secs,                        // for the given duration
              delay,                       // starting at the proper time
              timbre);                     // with the selected timbre
          }
          delay += stem.time * beatsecs;   // Advance the sequenced time.
        }
        maxdelay = Math.max(delay, maxdelay);
      }
    }
    this._maxScheduledTime =
        Math.max(this._maxScheduledTime, this.now() + maxdelay);
    if (done) {
      // Schedule a "done" callback after all sequencing is complete.
      this.schedule(maxdelay, done);
    }
  };

  // The default sound is a square wave with a pretty quick decay to zero.
  var defaultTimbre = parseOptionString(
    "wave:square;gain:0.5;" +
    "attack:0.002;decay:0.4;sustain:0;release:0.1;" +
    "cutoff:0;cutfollow:0,resonance:0;detune:0");

  // A timbre can specify any of the fields of defaultTimbre; any
  // unspecified fields are treated as they are set in defaultTimbre.
  function parseTimbre(options) {
    if (!options) {
      options = {};
    } else if (typeof(options) == 'string') {
      options = parseOptionString(options, 'wave');
    }
    var result = {}, key;
    for (key in defaultTimbre) if (defaultTimbre.hasOwnProperty(key)) {
      if (options.hasOwnProperty(key)) {
        result[key] = options[key];
      } else {
        result[key] = defaultTimbre[key];
      }
    }
    return result;
  }

  // Parses an ABC file to an object with the following structure:
  // {
  //   X: value from the X: lines in header (\n separated for multiple values)
  //   K: value from the K: lines in header, etc.
  //   tempo: Q: line parsed as beatsecs
  //   timbre: ... I:timbre line as parsed by parseTimbre
  //   voice: {
  //     myname: { // voice with id "myname"
  //       V: value from the V:myname lines
  //       stems: [...] as parsed by parseABCstems
  //       timbre: ... I:timbre line as parsed by parseTimbre
  //    }
  //  }
  // }
  // ABC files are idiosyncratic to parse: the written specifications
  // do not necessarily reflect the defacto standard implemented by
  // ABC content on the web.  This implementation is designed to be
  // practical, working on content as it appears on the web, and only
  // using the written standard as a guideline.
  var ABCheader = /^([A-Za-z]):\s*(.*)$/;
  function parseABCFile(str) {
    var lines = str.split('\n'),
        result = {
          voice: {}
        },
        context = result, timbre,
        j, header, stems, key = {}, accent = {}, out, firstvoice;
    // Shifts context to a voice with the given id given.  If no id
    // given, then just sticks with the current voice.  If the current
    // voice is unnamed and empty, renames the current voice.
    function startVoiceContext(id) {
      id = id || '';
      if (!id && context !== result) {
        return;
      }
      if (id && context !== result && !context.id &&
          (!context.stems || !context.stems.length)) {
        // If currently in an empty unnamed voice context, then
        // delete it and switch to the new named context.
        delete result.voice[context.id];
        context.id = id;
        result.voice[id] = context;
        accent = {};
      } else if (result.voice.hasOwnProperty(id)) {
        // Resume a named voice.
        context = result.voice[id];
        accent = {};
      } else {
        // Start a new voice.
        context = { id: id };
        result.voice[id] = context;
        accent = {};
      }
    }
    // For picking a default voice, looks for the first voice name.
    function firstVoiceName() {
      if (result.V) {
        return result.V.split(/\s+/)[0];
      } else {
        return '';
      }
    }
    // ABC files are parsed one line at a time.
    for (j = 0; j < lines.length; ++j) {
      // First, check to see if the line is a header line.
      header = ABCheader.exec(lines[j]);
      if (header) {
        // The following headers are recognized and processed.
        switch(header[1]) {
          case 'V':
            // A V: header switches voices if in the body.
            // If in the header, then it is just advisory.
            if (context !== result) {
              startVoiceContext(header[2].split(' ')[0]);
            }
            break;
          case 'M':
            parseMeter(header[2], context);
            break;
          case 'L':
            parseUnitNote(header[2], context);
            break;
          case 'Q':
            parseTempo(header[2], context);
            break;
          case 'I':
            timbre = /^timbre\s+(.*)$/.exec(header[2]);
            if (timbre) {
              context.timbre = parseTimbre(timbre);
            }
            break;
        }
        // All headers (including unrecognized ones) are
        // just accumulated as properties. Repeated header
        // lines are accumulated as multiline properties.
        if (context.hasOwnProperty(header[1])) {
          context[header[1]] += '\n' + header[2];
        } else {
          context[header[1]] = header[2];
        }
        // The K header is special: it should be the last one
        // before the voices and notes begin.
        if (header[1] == 'K' && context === result) {
          key = keysig(header[2]);
          startVoiceContext(firstVoiceName());
        }
      } else {
        // Parse a non-header line, looking for notes.
        out = {};
        stems = parseABCNotes(lines[j], key, accent, out);
        if (out.voiceid) {
          // Handle a note line that starts with [V:voiceid] as speced.
          // (actually, in practice you see V:voiceid\n lines.)
          startVoiceContext(out.voiceid);
        }
        if (stems && stems.length) {
          if (context === result) {
            // If no voice has been selected, then use the first voice.
            startVoiceContext(firstVoiceName());
          }
          // Push the line of stems into the voice.
          if (!('stems' in context)) { context.stems = []; }
          context.stems.push.apply(context.stems, stems);
        }
      }
    }
    if (result.voice) {
      // Calculate times for all the tied notes.  This happens at the end
      // because in principle, the first note of a song could be tied all
      // the way through to the last note.
      for (j in result.voice) {
        if (result.voice[j].stems) {
          processTies(result.voice[j].stems);
        }
      }
    }
    return result;
  }
  // Parse M: lines.  "3/4" is 3/4 time and "C" is 4/4 (common) time.
  function parseMeter(mline, beatinfo) {
    var d = /^C/.test(mline) ? 4/4 : durationToTime(mline);
    if (!d) { return; }
    if (!beatinfo.unitnote) {
      if (d < 0.75) {
        beatinfo.unitnote = 1/16;
      } else {
        beatinfo.unitnote = 1/8;
      }
    }
  }
  // Parse L: lines, e.g., "1/8".
  function parseUnitNote(lline, beatinfo) {
    var d = durationToTime(lline);
    if (!d) { return; }
    beatinfo.unitnote = d;
  }
  // Parse Q: line, e.g., "1/4=66".
  function parseTempo(qline, beatinfo) {
    var parts = qline.split(/\s+|=/), j, unit = null, tempo = null;
    for (j = 0; j < parts.length; ++j) {
      // It could be reversed, like "66=1/4", or just "120", so
      // determine what is going on by looking for a slash etc.
      if (parts[j].indexOf('/') >= 0 || /^[1-4]$/.test(parts[j])) {
        // The note-unit (e.g., 1/4).
        unit = unit || durationToTime(parts[j]);
      } else {
        // The tempo-number (e.g., 120)
        tempo = tempo || Number(parts[j]);
      }
    }
    if (unit) {
      beatinfo.unitbeat = unit;
    }
    if (tempo) {
      beatinfo.tempo = tempo;
    }
  }
  // Run through all the notes, adding up time for tied notes,
  // and marking notes that were held over with holdover = true.
  function processTies(stems) {
    var tied = {}, nextTied, j, k, note, firstNote;
    for (j = 0; j < stems.length; ++j) {
      nextTied = {};
      for (k = 0; k < stems[j].note.length; ++k) {
        firstNote = note = stems[j].note[k];
        if (tied.hasOwnProperty(note.pitch)) {  // Pitch was tied from before.
          firstNote = tied[note.pitch];   // Get the earliest note in the tie.
          firstNote.time += note.time;    // Extend its time.
          note.holdover = true;           // Silence this note as a holdover.
        }
        if (note.tie) {                   // This note is tied with the next.
          nextTied[note.pitch] = firstNote;  // Save it away.
        }
      }
      tied = nextTied;
    }
  }
  // Returns a map of A-G -> accidentals, according to the key signature.
  // When n is zero, there are no accidentals (e.g., C major or A minor).
  // When n is positive, there are n sharps (e.g., for G major, n = 1).
  // When n is negative, there are -n flats (e.g., for F major, n = -1).
  function accidentals(n) {
    var sharps = 'FCGDAEB',
        result = {}, j;
    if (!n) {
      return result;
    }
    if (n > 0) {  // Handle sharps.
      for (j = 0; j < n && j < 7; ++j) {
        result[sharps.charAt(j)] = '^';
      }
    } else {  // Flats are in the opposite order.
      for (j = 0; j > n && j > -7; --j) {
        result[sharps.charAt(6 + j)] = '_';
      }
    }
    return result;
  }
  // Decodes the key signature line (e.g., K: C#m) at the front of an ABC tune.
  // Supports the whole range of scale systems listed in the ABC spec.
  function keysig(k) {
    if (!k) { return {}; }
    var key, sigcodes = {
      // Major
      'c#':7, 'f#':6, 'b':5, 'e':4, 'a':3, 'd':2, 'g':1, 'c':0,
      'f':-1, 'bb':-2, 'eb':-3, 'ab':-4, 'db':-5, 'gb':-6, 'cb':-7,
      // Minor
      'a#m':7, 'd#m':6, 'g#m':5, 'c#m':4, 'f#m':3, 'bm':2, 'em':1, 'am':0,
      'dm':-1, 'gm':-2, 'cm':-3, 'fm':-4, 'bbm':-5, 'ebm':-6, 'abm':-7,
      // Mixolydian
      'g#mix':7, 'c#mix':6, 'f#mix':5, 'bmix':4, 'emix':3,
      'amix':2, 'dmix':1, 'gmix':0, 'cmix':-1, 'fmix':-2,
      'bbmix':-3, 'ebmix':-4, 'abmix':-5, 'dbmix':-6, 'gbmix':-7,
      // Dorian
      'd#dor':7, 'g#dor':6, 'c#dor':5, 'f#dor':4, 'bdor':3,
      'edor':2, 'ador':1, 'ddor':0, 'gdor':-1, 'cdor':-2,
      'fdor':-3, 'bbdor':-4, 'ebdor':-5, 'abdor':-6, 'dbdor':-7,
      // Phrygian
      'e#phr':7, 'a#phr':6, 'd#phr':5, 'g#phr':4, 'c#phr':3,
      'f#phr':2, 'bphr':1, 'ephr':0, 'aphr':-1, 'dphr':-2,
      'gphr':-3, 'cphr':-4, 'fphr':-5, 'bbphr':-6, 'ebphr':-7,
      // Lydian
      'f#lyd':7, 'blyd':6, 'elyd':5, 'alyd':4, 'dlyd':3,
      'glyd':2, 'clyd':1, 'flyd':0, 'bblyd':-1, 'eblyd':-2,
      'ablyd':-3, 'dblyd':-4, 'gblyd':-5, 'cblyd':-6, 'fblyd':-7,
      // Locrian
      'b#loc':7, 'e#loc':6, 'a#loc':5, 'd#loc':4, 'g#loc':3,
      'c#loc':2, 'f#loc':1, 'bloc':0, 'eloc':-1, 'aloc':-2,
      'dloc':-3, 'gloc':-4, 'cloc':-5, 'floc':-6, 'bbloc':-7
    };
    k = k.replace(/\s+/g, '').toLowerCase().substr(0, 5);
    var scale = k.match(/maj|min|mix|dor|phr|lyd|loc|m/);
    if (scale) {
      if (scale == 'maj') {
        key = k.substr(0, scale.index);
      } else if (scale == 'min') {
        key = k.substr(0, scale.index + 1);
      } else {
        key = k.substr(0, scale.index + scale.length);
      }
    } else {
      key = /^[a-g][#b]?/.exec(k) || '';
    }
    var result = accidentals(sigcodes[key]);
    var extras = k.substr(key.length).match(/(__|_|=|\^\^|\^)[a-g]/g);
    if (extras) {
      for (j = 0; j < extras.length; ++j) {
        var note = extras[j].charAt(extras[j].length - 1).toUpperCase();
        if (extras[j].charAt(0) == '=') {
          delete result[note];
        } else {
          result[note] = extras[j].substr(0, extras[j].length - 1);
        }
      }
    }
    return result;
  }
  // Parses a single line of ABC notes (i.e., not a header line).
  // The general strategy is to tokenize the line using the following
  // regexp, and then to delegate processing of single notes and
  // stems (sets of notes between [...]) to parseStem.
  var ABCtoken = /(?:^\[V:[^\]\s]*\])|\s+|%[^\n]*|![^!]*!|\[|\]|>+|<+|(?:(?:\^\^|\^|__|_|=|)[A-Ga-g](?:,+|'+|))|\(\d+(?::\d+){0,2}|\d*\/\d+|\d+\/?|\/+|[xzXZ]|\[?\|\]?|:?\|:?|::|./g;
  function parseABCNotes(str, key, accent, out) {
    var tokens = str.match(ABCtoken), result = [], parsed = null,
        index = 0, dotted = 0, beatlet = null, t;
    if (!tokens) {
      return null;
    }
    while (index < tokens.length) {
      // Ignore %comments and !markings!
      if (/^[\s%!]/.test(tokens[index])) { index++; continue; }
      // Grab a voice id out of [V:id]
      if (/^\[V:\S*\]$/.test(tokens[index])) {
        out.voiceid = tokens[index].substring(3, tokens[index].length - 1);
        index++;
        continue;
      }
      // Handled dotted notation abbreviations.
      if (/</.test(tokens[index])) {
        dotted = -tokens[index++].length;
        continue;
      }
      if (/>/.test(tokens[index])) {
        dotted = tokens[index++].length;
        continue;
      }
      if (/^\(\d+(?::\d+)*/.test(tokens[index])) {
        beatlet = parseBeatlet(tokens[index]);
      }

      // Handle measure markings by clearing accidentals.
      if (/\|/.test(tokens[index])) {
        for (t in accent) if (accent.hasOwnProperty(t)) {
          delete accent[t];
        }
        index++;
        continue;
      }
      parsed = parseStem(tokens, index, key, accent);
      // Skip unparsable bits
      if (parsed === null) {
        index++;
        continue;
      }
      // Process a parsed stem.
      if (parsed !== null) {
        if (beatlet) {
          t = (beatlet.time - 1) * parsed.stem.time;
          syncopateStem(parsed.stem, t);
          beatlet.count -= 1;
          if (!beatlet.count) {
            beatlet = null;
          }
        }
        // If syncopated with > or < notation, shift part of a beat
        // between this stem and the previous one.
        if (dotted && result.length) {
          if (dotted > 0) {
            t = (1 - Math.pow(0.5, dotted)) * parsed.stem.time;
          } else {
            t = (Math.pow(0.5, -dotted) - 1) * result[result.length - 1].time;
          }
          syncopateStem(result[result.length - 1], t);
          syncopateStem(parsed.stem, -t);
        }
        dotted = 0;
        // Add the stem to the sequence of stems for this voice.
        result.push(parsed.stem);
        // Advance the parsing index since a stem is multiple tokens.
        index = parsed.index;
      }
    }
    return result;
  }
  // Adjusts the beats for a stem and the contained notes.
  function syncopateStem(stem, t) {
    var j, stemtime = stem.time, newtime = stemtime + t;
    stem.time = newtime;
    for (j = 0; j < stem.note.length; ++j) {
      note = stem.note[j];
      // Only adjust a note's duration if it matched the stem's duration.
      if (note.time == stemtime) { note.time = newtime; }
    }
  }
  // Parses notation of the form (3 or (5:2:10, which means to do
  // the following 3 notes in the space of 2 notes, or to do the following
  // 10 notes at the rate of 5 notes per 2 beats.
  function parseBeatlet(token) {
    var m = /^\((\d+)(?::(\d+)(?::(\d+))?)?$/.exec(token);
    if (!m) { return null; }
    var count = Number(m[1]),
        beats = Number(m[2]) || 2,
        duration = Number(m[3]) || count;
    return {
      time: beats / count,
      count: duration
    };
  }
  // Parses a stem, which may be a single note, or which may be
  // a chorded note.
  function parseStem(tokens, index, key, accent) {
    var note = [],
        duration = '', staccato = false,
        noteDuration, noteTime,
        lastNote = null, minStemTime = Infinity, j;
    // A single staccato marking applies to the entire stem.
    if (index < tokens.length && '.' == tokens[index]) {
      staccato = true;
      index++;
    }
    if (index < tokens.length && tokens[index] == '[') {
      // Deal with [CEG] chorded notation.
      index++;
      // Scan notes within the chord.
      while (index < tokens.length) {
        // Ignore !markings! and space and %comments.
        if (/^[\s%!]/.test(tokens[index])) {
          index++;
          continue;
        }
        if (/[A-Ga-g]/.test(tokens[index])) {
          // Grab a pitch.
          lastNote = {
            pitch: applyAccent(tokens[index++], key, accent),
            tie: false
          }
          lastNote.frequency = pitchToFrequency(lastNote.pitch);
          note.push(lastNote);
        } else if (/[xzXZ]/.test(tokens[index])) {
          // Grab a rest.
          lastNote = null;
          index++;
        } else if ('.' == tokens[index]) {
          // A staccato mark applies to the entire stem.
          staccato = true;
          index++;
          continue;
        } else {
          // Stop parsing the stem if something is unrecognized.
          break;
        }
        // After a pitch or rest, look for a duration.
        if (index < tokens.length &&
            /^(?![\s%!]).*[\d\/]/.test(tokens[index])) {
          noteDuration = tokens[index++];
          noteTime = durationToTime(noteDuration);
        } else {
          noteDuration = '';
          noteTime = 1;
        }
        // If it's a note (not a rest), store the duration
        if (lastNote) {
          lastNote.duration = noteDuration;
          lastNote.time = noteTime;
        }
        // When a stem has more than one duration, use the shortest
        // one for timing. The standard says to pick the first one,
        // but in practice, transcribed music online seems to
        // follow the rule that the stem's duration is determined
        // by the shortest contained duration.
        if (noteTime && noteTime < minStemTime) {
          duration = noteDuration;
          minStemTime = noteTime;
        }
        // After a duration, look for a tie mark.  Individual notes
        // within a stem can be tied.
        if (index < tokens.length && '-' == tokens[index]) {
          if (lastNote) {
            note[note.length - 1].tie = true;
          }
          index++;
        }
      }
      // The last thing in a chord should be a ].  If it isn't, then
      // this doesn't look like a stem after all, and return null.
      if (tokens[index] != ']') {
        return null;
      }
      index++;
    } else if (index < tokens.length && /[A-Ga-g]/.test(tokens[index])) {
      // Grab a single note.
      lastNote = {
        pitch: applyAccent(tokens[index++], key, accent),
        tie: false,
        duration: '',
        time: 1
      }
      lastNote.frequency = pitchToFrequency(lastNote.pitch);
      note.push(lastNote);
    } else if (index < tokens.length && /^[xzXZ]$/.test(tokens[index])) {
      // Grab a rest - no pitch.
      index++;
    } else {
      // Something we don't recognize - not a stem.
      return null;
    }
    // Right after a [chord], note, or rest, look for a duration marking.
    if (index < tokens.length && /^(?![\s%!]).*[\d\/]/.test(tokens[index])) {
      duration = tokens[index++];
      noteTime = durationToTime(duration);
      // Apply the duration to all the ntoes in the stem.
      // NOTE: spec suggests multiplying this duration, but that
      // idiom is not seen (so far) in practice.
      for (j = 0; j < note.length; ++j) {
        note[j].duration = duration;
        note[j].time = noteTime;
      }
    }
    // Then look for a trailing tie marking.  Will tie every note in a chord.
    if (index < tokens.length && '-' == tokens[index]) {
      index++;
      for (j = 0; j < note.length; ++j) {
        note[j].tie = true;
      }
    }
    return {
      index: index,
      stem: {
        note: note,
        duration: duration,
        staccato: staccato,
        time: durationToTime(duration)
      }
    };
  }
  // Normalizes pitch markings by stripping leading = if present.
  function stripNatural(pitch) {
    if (pitch.length > 0 && pitch.charAt(0) == '=') {
      return pitch.substr(1);
    }
    return pitch;
  }
  // Processes an accented pitch, automatically applying accidentals
  // that have accumulated within the measure, and also saving
  // explicit accidentals to continue to apply in the measure.
  function applyAccent(pitch, key, accent) {
    var m = /^(\^\^|\^|__|_|=|)([A-Ga-g])(.*)$/.exec(pitch), letter;
    if (!m) { return pitch; }
    // Note that an accidental in one octave applies in other octaves.
    letter = m[2].toUpperCase();
    if (m[1].length > 0) {
      // When there is an explicit accidental, then remember it for
      // the rest of the measure.
      accent[letter] = m[1];
      return stripNatural(pitch);
    }
    if (accent.hasOwnProperty(letter)) {
      // Accidentals from this measure apply to unaccented notes.
      return stripNatural(accent[letter] + m[2] + m[3]);
    }
    if (key.hasOwnProperty(letter)) {
      // Key signatures apply by default.
      return stripNatural(key[letter] + m[2] + m[3]);
    }
    return stripNatural(pitch);
  }
  // Converts a midi note number to a frequency in Hz.
  function midiToFrequency(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }
  // Converts a frequency in Hz to the closest midi number.
  function frequencyToMidi(freq) {
    return Math.round(69 + Math.log(freq / 440) * 12 / Math.LN2);
  }
  // Converts an ABC pitch (such as "^G,,") to a midi note number.
  function pitchToMidi(pitch) {
    var m = /^(\^\^|\^|__|_|=|)([A-Ga-g])(,+|'+|)$/.exec(pitch);
    if (!m) { return null; }
    var n = {C:-9,D:-7,E:-5,F:-4,G:-2,A:0,B:2,c:3,d:5,e:7,f:8,g:10,a:12,b:14};
    var a = { '^^':2, '^':1, '': 0, '=':0, '_':-1, '__':-2 };
    var semitone =
      n[m[2]] + a[m[1]] + (/,/.test(m[3]) ? -12 : 12) * m[3].length;
    return semitone + 69; // 69 = midi code for "A", which is A4.
  }
  // Converts an ABC pitch to a frequency in Hz.
  function pitchToFrequency(pitch) {
    return midiToFrequency(pitchToMidi(pitch));
  }
  // Converts an ABC duration to a number (e.g., "/3"->0.333 or "11/2"->1.5).
  function durationToTime(duration) {
    var m = /^(\d*)(?:\/(\d*))?$|^(\/+)$/.exec(duration), n, d, i = 0, ilen;
    if (!m) return;
    if (m[3]) return Math.pow(0.5, m[3].length);
    d = (m[2] ? parseFloat(m[2]) : /\//.test(duration) ? 2 : 1);
    // Handle mixed frations:
    ilen = 0;
    n = (m[1] ? parseFloat(m[1]) : 1);
    while (ilen + 1 < m[1].length && n > d) {
      ilen += 1
      i = parseFloat(m[1].substring(0, ilen))
      n = parseFloat(m[1].substring(ilen))
    }
    return i + (n / d);
  }

  // An options string looks like a (simplified) CSS properties string,
  // of the form prop:value;prop:value; etc.  If defaultProp is supplied
  // then the string can begin with "value" (i.e., value1;prop:value2)
  // and that first value will be interpreted as defaultProp:value1.
  // Some rudimentary quoting can be done, e.g., value:"prop", etc.
  function parseOptionString(str, defaultProp) {
    var result = {}, key = null;
    if (str == null) { return result; }
    if (typeof(str) == 'object') {
      for (key in str) if (str.hasOwnProperty(key)) {
        result[key] = str[key];
      }
      return result;
    }
    str = '' + str;
    // Each token is an identifier, a quoted or parenthesized string,
    // a run of whitespace, or any other non-matching character.
    var token = str.match(/[-a-zA-Z_][-\w]*|"[^"]*"|'[^']'|\([^()]*\)|\s+|./g),
        t, value, arg,
        seencolon = false, vlist = [], firstval = true;

    // While parsing, commitvalue() validates and unquotes a prop:value
    // pair and commits it to the result.
    function commitvalue() {
      // Trim whitespace
      while (vlist.length && /^\s/.test(vlist[vlist.length - 1])) {vlist.pop();}
      while (vlist.length && /^\s/.test(vlist[0])) { vlist.shift(); }
      if (vlist.length == 1 && (
            /^".*"$/.test(vlist[0]) || /^'.*'$/.test(vlist[0]))) {
        // Unquote quoted string.
        value = vlist[0].substr(1, vlist[0].length - 2);
      } else if (vlist.length == 2 && vlist[0] == 'url' &&
          /^(.*)$/.test(vlist[1])) {
        // Remove url(....) from around a string.
        value = vlist[1].substr(1, vlist[1].length - 2);
      } else {
        // Form the string for the value.
        arg = vlist.join('');
        // Convert the value to a number if it looks like a number.
        if (arg == "") {
          value = arg;
        } else if (isNaN(arg)) {
          value = arg;
        } else {
          value = Number(arg);
        }
      }
      // Deal with a keyless first value.
      if (!seencolon && firstval && defaultProp && vlist.length) {
        // value will already have been formed.
        key = defaultProp;
      }
      if (key) {
        result[key] = value;
      }
    }
    // Now the parsing: just iterate through all the tokens.
    for (j = 0; j < token.length; ++j) {
      t = token[j];
      if (!seencolon) {
        // Before a colon, remember the first identifier as the key.
        if (!key && /^[a-zA-Z_-]/.test(t)) {
          key = t;
        }
        // And also look for the colon.
        if (t == ':') {
          seencolon = true;
          vlist.length = 0;
          continue;
        }
      }
      if (t == ';') {
        // When a semicolon is seen, form the value and save it.
        commitvalue();
        // Then reset the parsing state.
        key = null;
        vlist.length = 0;
        seencolon = false;
        firstval = false;
        continue;
      }
      // Accumulate all tokens into the vlist.
      vlist.push(t);
    }
    commitvalue();
    return result;
  }
  // Prints a map of options as a parsable string.
  // The inverse of parseOptionString.
  function printOptionAsString(obj) {
    var result = [];
    function quoted(s) {
      if (/[\s;]/.test(s)) {
        if (s.indexOf('"') < 0) {
          return '"' + s + '"';
        }
        return "'" + s + "'";
      }
      return s;
    }
    for (var k in obj) if (obj.hasOwnProperty(k)) {
      result.push(k + ':' + quoted(obj[k]) + ';');
    }
    return result.join(' ');
  }

  // wavetable is a table of names for nonstandard waveforms.
  // The table maps names to objects that have wave: and freq:
  // properties. The wave: property is a PeriodicWave to use
  // for the oscillator.  The freq: property, if present,
  // is a map from higher frequencies to more PeriodicWave
  // objects; when a frequency higher than the given threshold
  // is requested, the alternate PeriodicWave is used.
  var wavetable = (function(wavedata) {
    if (!isAudioPresent()) { return {}; }
    function makePeriodicWave(ac, data) {
      var n = data.real.length,
          real = new Float32Array(n),
          imag = new Float32Array(n),
          j;
      for (j = 0; j < n; ++j) {
        real[j] = data.real[j];
        imag[j] = data.imag[j];
      }
      return ac.createPeriodicWave(real, imag);
    }
    function makeMultiple(data, mult, amt) {
      var result = { real: [], imag: [] }, j, n = data.real.length, m;
      for (j = 0; j < n; ++j) {
        m = Math.log(mult[Math.min(j, mult.length - 1)]);
        result.real.push(data.real[j] * Math.exp(amt * m));
        result.imag.push(data.imag[j] * Math.exp(amt * m));
      }
      return result;
    }
    var result = {}, k, d, n, j, ff, record, pw, ac = getAudioTop().ac;
    for (k in wavedata) {
      record = result[k] = {};
      d = wavedata[k];
      record.wave = makePeriodicWave(ac, d);
      // A strategy for computing higher frequency waveforms: apply
      // multipliers to each harmonic according to d.mult.  These
      // multipliers can be interpolated and applied at any number
      // of transition frequencies.
      if (d.mult) {
        ff = wavedata[k].freq;
        record.freq = {};
        for (j = 0; j < ff.length; ++j) {
          record.freq[ff[j]] =
            makePeriodicWave(ac, makeMultiple(d, d.mult, (j + 1) / ff.length));
        }
      }
    }
    return result;
  })({
    // Currently the only nonstandard waveform is "piano".
    // It is based on the first 32 harmonics from the example:
    // https://github.com/GoogleChrome/web-audio-samples
    // /blob/gh-pages/samples/audio/wave-tables/Piano
    // That is a terrific sound for the lowest piano tones.
    // For higher tones, interpolate to a customzed wave
    // shape created by hand.
    piano: {
      real: [0, 0, -0.203569, 0.5, -0.401676, 0.137128, -0.104117, 0.115965,
             -0.004413, 0.067884, -0.00888, 0.0793, -0.038756, 0.011882,
             -0.030883, 0.027608, -0.013429, 0.00393, -0.014029, 0.00972,
             -0.007653, 0.007866, -0.032029, 0.046127, -0.024155, 0.023095,
             -0.005522, 0.004511, -0.003593, 0.011248, -0.004919, 0.008505],
      imag: [0, 0.147621, 0, 0.000007, -0.00001, 0.000005, -0.000006, 0.000009,
             0, 0.000008, -0.000001, 0.000014, -0.000008, 0.000003,
             -0.000009, 0.000009, -0.000005, 0.000002, -0.000007, 0.000005,
             -0.000005, 0.000005, -0.000023, 0.000037, -0.000021, 0.000022,
             -0.000006, 0.000005, -0.000004, 0.000014, -0.000007, 0.000012],
      // How to adjust the harmonics for the higest notes.
      mult: [1, 4.3, 1, 0.08, 0.05, 0.05, 0.05, 0.02, 54, 1, 11, 0.05],
      // The frequencies at which to interpolate the harmonics.
      freq: [100, 110, 130, 160, 200, 400, 720, 1360]
    }
  });

  return Instrument;
})();

var impl = {
  Instrument: Instrument
};

if (module && module.exports) {
  // Nodejs usage: export the impl object as the package.
  module.exports = impl;
} else if (define && define.amd) {
  // Requirejs usage: define the impl object as the package.
  define(function() { return impl; });
} else {
  // Plain script tag usage: stick Instrument on the window object.
  for (var exp in impl) if (impl.hasOwnProperty(exp)) {
    global[exp] = impl[exp];
  }
}

})(
  this,                                     // global (window) object
  (typeof module) == 'object' && module,    // present in node.js
  (typeof define) == 'function' && define   // present with an AMD loader
);
