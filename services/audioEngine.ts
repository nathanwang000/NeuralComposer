import { MidiEvent, SynthConfig } from '../types';

interface ActiveVoice {
  osc: OscillatorNode;
  filter: BiquadFilterNode;
  env: GainNode;
  pitch: number;
  levelPerDrive: number;
}

class AudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private tempo: number = 120;
  private config: SynthConfig = {
    waveType: 'sawtooth',
    detune: 0,
    cutoff: 2000,
    resonance: 1,
    attack: 0.01,
    decay: 0.1,
    sustain: 0.5,
    release: 0.3,
    drive: 1.0
  };

  private activeVoice: ActiveVoice | null = null;

  init() {
    if (this.ctx && this.ctx.state !== 'closed') return;
    this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0.3;
    this.masterGain.connect(this.ctx.destination);
  }

  setTempo(bpm: number) {
    this.tempo = bpm;
  }

  updateConfig(newConfig: SynthConfig) {
    this.config = { ...newConfig };
    if (this.activeVoice) {
      this.updateActiveVoiceParams(newConfig);
    }
  }

  updateActiveVoiceParams(params: Partial<SynthConfig>) {
    this.config = { ...this.config, ...params };

    if (this.activeVoice && this.ctx) {
      const { osc, filter, env } = this.activeVoice;
      const now = this.ctx.currentTime;
      const rampTime = 0.05;

      if (params.cutoff !== undefined) {
        filter.frequency.setTargetAtTime(params.cutoff, now, rampTime);
      }
      if (params.resonance !== undefined) {
        filter.Q.setTargetAtTime(params.resonance, now, rampTime);
      }

      if (params.detune !== undefined) {
        osc.detune.setTargetAtTime(params.detune, now, rampTime);
      }
      if (params.waveType !== undefined && params.waveType !== osc.type) {
         osc.type = params.waveType as OscillatorType;
      }

      if (params.sustain !== undefined || params.drive !== undefined) {
        const sustainLevel = Math.max(
          0.001,
          this.activeVoice.levelPerDrive * this.config.drive * this.config.sustain
        );
        env.gain.setTargetAtTime(sustainLevel, now, rampTime);
      }
    }
  }

  private midiToFreq(midi: number): number {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  // Track the end time of the last note to detect legato phrases (for potential future use or global legato logic)
  private globalLastNoteEndTime: number = 0;

  scheduleNote(event: MidiEvent, eventAbsoluteBeat: number, currentPlaybackBeat: number, legato: boolean = false) {
    if (!this.ctx || !this.masterGain) return;

    const secondsPerBeat = 60 / this.tempo;
    const beatDistance = eventAbsoluteBeat - currentPlaybackBeat;

    const playAt = this.ctx.currentTime + (beatDistance * secondsPerBeat);
    const noteDuration = event.d * secondsPerBeat;

    if (playAt < this.ctx.currentTime - 0.05) return;

    const actualStart = Math.max(playAt, this.ctx.currentTime);
    const freq = this.midiToFreq(event.p);

    // Waveform compensation: Sines are pure fundamental, Saws have lots of energy. Adjust accordingly.
    const waveCorrection = this.config.waveType === 'sine' ? 1.1 : (this.config.waveType === 'sawtooth' ? 0.9 : 1.0);
    const targetVolume = (event.v / 127) * 0.4 * this.config.drive * waveCorrection;

    // --- Polyphonic Legato Logic ---
    // Instead of reusing oscillators (which kills polyphony), we start a NEW oscillator for every note.
    // "Legato" here means: if we are close to the previous note, we skip the attack phase
    // and start directly at the sustain level to simulate a connected phrase.

    const isLegatoTransition = legato && (actualStart < this.globalLastNoteEndTime + 0.1);

    // Nodes
    const osc = this.ctx.createOscillator();
    const filter = this.ctx.createBiquadFilter();
    const env = this.ctx.createGain();

    // 1. Configure Oscillator
    osc.type = this.config.waveType as OscillatorType;
    osc.frequency.setValueAtTime(freq, actualStart);
    osc.detune.setValueAtTime(this.config.detune, actualStart);

    // 2. Configure Filter
    const filterEnvAmount = this.config.cutoff * 1.5;
    filter.type = 'lowpass';
    filter.Q.setValueAtTime(this.config.resonance, actualStart);

    // Filter Envelope
    filter.frequency.setValueAtTime(this.config.cutoff, actualStart);

    if (isLegatoTransition) {
        // Legato: Less filter movement to sound "connected"
        filter.frequency.setValueAtTime(this.config.cutoff + (filterEnvAmount * 0.5), actualStart);
        filter.frequency.exponentialRampToValueAtTime(this.config.cutoff, actualStart + this.config.decay);
    } else {
      // Full filter sweep
        filter.frequency.exponentialRampToValueAtTime(Math.min(20000, this.config.cutoff + filterEnvAmount), actualStart + this.config.attack);
        filter.frequency.exponentialRampToValueAtTime(this.config.cutoff, actualStart + this.config.attack + this.config.decay);
    }

    // 3. ADSR Volume Logic
    const attackEnd = actualStart + this.config.attack;
    const decayEnd = attackEnd + this.config.decay;
    const releaseStart = actualStart + noteDuration;
    const releaseEnd = releaseStart + this.config.release;

    env.gain.cancelScheduledValues(actualStart);

    if (isLegatoTransition) {
        // Legato: Skip Attack, start at target volume immediately (with tiny fade in to avoid clicks)
        // This simulates the "fingered legato" where the sound doesn't die down between notes
        env.gain.setValueAtTime(0, actualStart);
        env.gain.linearRampToValueAtTime(targetVolume, actualStart + 0.02); // 20ms quick fade

        // No decay needed, just hold level.
        env.gain.setValueAtTime(targetVolume, releaseStart);
    } else {
        // Normal Envelop
        env.gain.setValueAtTime(0, actualStart);
        env.gain.linearRampToValueAtTime(targetVolume, attackEnd);
        env.gain.exponentialRampToValueAtTime(Math.max(0.001, targetVolume * this.config.sustain), decayEnd);
        env.gain.setValueAtTime(targetVolume * this.config.sustain, releaseStart);
    }

    // Release (always the same)
    env.gain.exponentialRampToValueAtTime(0.001, releaseEnd);

    // Connect Graph
    osc.connect(filter);
    filter.connect(env);
    env.connect(this.masterGain);

    osc.start(actualStart);
    osc.stop(releaseEnd + 0.1); // Simple stop, no need for hour-long safety buffer anymore

    // Update tracking
    // For polyphony, we just track the "latest" known note end to know if the "music" is continuous.
    // It's a simplification but works well for detecting phrases.
    if (releaseEnd > this.globalLastNoteEndTime) {
        this.globalLastNoteEndTime = releaseEnd;
    }
  }

  startContinuousNote(midi: number, velocity: number) {
    if (!this.ctx) this.init();
    if (!this.ctx || !this.masterGain) return;

    this.stopContinuousNote();

    const now = this.ctx.currentTime;
    const freq = this.midiToFreq(midi);

    const waveCorrection = this.config.waveType === 'sine' ? 1.1 : (this.config.waveType === 'sawtooth' ? 0.9 : 1.0);
    const levelPerDrive = (velocity / 127) * 0.4 * waveCorrection;
    const targetVolume = levelPerDrive * this.config.drive;

    const osc = this.ctx.createOscillator();
    const filter = this.ctx.createBiquadFilter();
    const env = this.ctx.createGain();

    osc.type = this.config.waveType as OscillatorType;
    osc.frequency.setValueAtTime(freq, now);
    osc.detune.setValueAtTime(this.config.detune, now);

    const filterEnvAmount = this.config.cutoff * 1.5;
    filter.type = 'lowpass';
    filter.Q.setValueAtTime(this.config.resonance, now);

    const startCutoff = Math.max(100, this.config.cutoff);
    filter.frequency.setValueAtTime(startCutoff, now);

    filter.frequency.exponentialRampToValueAtTime(
        Math.min(20000, Math.max(100, this.config.cutoff + filterEnvAmount)),
        now + this.config.attack
    );
    filter.frequency.exponentialRampToValueAtTime(
        Math.max(100, this.config.cutoff),
        now + this.config.attack + this.config.decay
    );

    const safeSustain = Math.max(0.001, targetVolume * this.config.sustain);
    const safeVolume = Math.max(0.001, targetVolume);

    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(safeVolume, now + this.config.attack);
    env.gain.exponentialRampToValueAtTime(safeSustain, now + this.config.attack + this.config.decay);

    osc.connect(filter);
    filter.connect(env);
    env.connect(this.masterGain);

    osc.start(now);

    this.activeVoice = {
      osc,
      filter,
      env,
      pitch: midi,
      levelPerDrive
    };
  }

  stopContinuousNote() {
    if (!this.activeVoice || !this.ctx) return;

    const { osc, env, filter } = this.activeVoice;
    const now = this.ctx.currentTime;
    const releaseTime = now + Math.max(0.01, this.config.release);

    try {
      if (typeof env.gain.cancelAndHoldAtTime === 'function') {
        env.gain.cancelAndHoldAtTime(now);
      } else {
        env.gain.cancelScheduledValues(now);
        env.gain.setValueAtTime(Math.max(0.001, env.gain.value), now);
      }

      if (typeof filter.frequency.cancelAndHoldAtTime === 'function') {
        filter.frequency.cancelAndHoldAtTime(now);
      } else {
        filter.frequency.cancelScheduledValues(now);
      }

      env.gain.exponentialRampToValueAtTime(0.001, releaseTime);

      osc.stop(releaseTime + 0.1);
    } catch (e) {
      console.warn("Error stopping note", e);
    }

    this.activeVoice = null;
  }

  stopAll() {
    this.stopContinuousNote();
    if (this.ctx) {
      this.ctx.close();
      this.ctx = null;
    }
    this.globalLastNoteEndTime = 0;
  }

  get currentTime(): number {
    return this.ctx?.currentTime || 0;
  }
}

export const audioEngine = new AudioEngine();
