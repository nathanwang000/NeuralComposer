import { MidiEvent, SynthConfig } from '../types';

interface ActiveVoice {
  osc: OscillatorNode;
  filter: BiquadFilterNode;
  env: GainNode;
  pitch: number;
  levelPerDrive: number;
  startTime: number;
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

  private activeVoices: ActiveVoice[] = [];
  private voiceGroups = new Map<number, ActiveVoice[]>();
  private nextGroupId = 0;

  // baseConfig is the source of truth for sequencer playback (scheduleNote).
  // It is written ONLY by updateConfig() which is called from App.tsx when the
  // synth panel changes. updateActiveVoiceParams() may mutate this.config for
  // live pad modulation without ever touching baseConfig, so the two paths
  // never interfere with each other.
  private baseConfig: SynthConfig = { ...this.config };

  private buildContext() {
    this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0.3;
    this.masterGain.connect(this.ctx.destination);
  }

  init() {
    if (this.ctx && this.ctx.state !== 'closed') return;
    this.buildContext();

    // Best-effort resume when the page becomes visible. On iOS this won't
    // work without a user gesture, but ensureRunning() handles that on the
    // next touch/click.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.ctx && this.ctx.state !== 'running') {
        this.ctx.resume().catch(() => {});
      }
    });
  }

  /**
   * Called at the start of every user-gesture-driven play path.
   * Recreates the AudioContext if iOS has put it into an unrecoverable
   * interrupted/closed state, then awaits resume() so oscillators are only
   * created once the context is truly running.
   */
  private async ensureRunning(): Promise<void> {
    if (!this.ctx || this.ctx.state === 'closed') {
      this.buildContext();
    }
    if (!this.ctx) return;
    if (this.ctx.state === 'running') return;

    // Race resume() against a 600 ms deadline. On iOS after video playback
    // the promise can hang indefinitely (audio session still owned by the
    // video player), so we detect the timeout and rebuild from scratch.
    try {
      await Promise.race([
        this.ctx.resume(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('AudioContext resume timeout')), 600)
        ),
      ]);
    } catch {
      // Stuck context: nuke it and create a fresh one.
      // A new AudioContext created inside a user gesture starts in 'running'
      // state on iOS, bypassing the stale audio session entirely.
      try { this.ctx.close(); } catch {}
      this.buildContext();
      await this.ctx!.resume().catch(() => {});
    }
  }

  /** Call from inside a user-gesture handler so the browser lifts its
   *  autoplay restriction. Returns when the context is running (or recovers). */
  resume(): Promise<void> {
    return this.ensureRunning();
  }

  setTempo(bpm: number) {
    this.tempo = bpm;
  }

  updateConfig(newConfig: SynthConfig) {
    this.config = { ...newConfig };
    this.baseConfig = { ...newConfig };
    if (this.activeVoices.length > 0) {
      this.updateActiveVoiceParams(newConfig);
    }
  }

  updateActiveVoiceParams(params: Partial<SynthConfig>) {
    this.config = { ...this.config, ...params };

    if (this.activeVoices.length > 0 && this.ctx) {
      const now = this.ctx.currentTime;
      const rampTime = 0.05;
      this.activeVoices.forEach((voice) => {
        const { osc, filter, env } = voice;

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
            voice.levelPerDrive * this.config.drive * this.config.sustain
          );
          env.gain.setTargetAtTime(sustainLevel, now, rampTime);
        }
      });
    }
  }

  private midiToFreq(midi: number): number {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  // Track the end time of the last note to detect legato phrases (for potential future use or global legato logic)
  private globalLastNoteEndTime: number = 0;

  scheduleNote(event: MidiEvent, eventAbsoluteBeat: number, currentPlaybackBeat: number, legato: boolean = false) {
    if (!this.ctx || !this.masterGain || this.ctx.state !== 'running') return;

    const secondsPerBeat = 60 / this.tempo;
    const beatDistance = eventAbsoluteBeat - currentPlaybackBeat;

    const playAt = this.ctx.currentTime + (beatDistance * secondsPerBeat);
    const noteDuration = event.d * secondsPerBeat;

    if (playAt < this.ctx.currentTime - 0.05) return;

    const actualStart = Math.max(playAt, this.ctx.currentTime);
    const freq = this.midiToFreq(event.p);

    // Waveform compensation: use baseConfig so pad overrides don't affect sequencer volume.
    const waveCorrection = this.baseConfig.waveType === 'sine' ? 1.1 : (this.baseConfig.waveType === 'sawtooth' ? 0.9 : 1.0);
    const targetVolume = (event.v / 127) * 0.4 * this.baseConfig.drive * waveCorrection;

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
    // Use baseConfig (App.tsx synth panel) so pad transient overrides (detune,
    // cutoff, etc.) do not bleed into sequencer playback.
    const sc = this.baseConfig;
    osc.type = sc.waveType as OscillatorType;
    osc.frequency.setValueAtTime(freq, actualStart);
    osc.detune.setValueAtTime(sc.detune, actualStart);

    // 2. Configure Filter
    const filterEnvAmount = sc.cutoff * 1.5;
    filter.type = 'lowpass';
    filter.Q.setValueAtTime(sc.resonance, actualStart);

    // Filter Envelope
    filter.frequency.setValueAtTime(sc.cutoff, actualStart);

    if (isLegatoTransition) {
        // Legato: Less filter movement to sound "connected"
        filter.frequency.setValueAtTime(sc.cutoff + (filterEnvAmount * 0.5), actualStart);
        filter.frequency.exponentialRampToValueAtTime(sc.cutoff, actualStart + sc.decay);
    } else {
      // Full filter sweep
        filter.frequency.exponentialRampToValueAtTime(Math.min(20000, sc.cutoff + filterEnvAmount), actualStart + sc.attack);
        filter.frequency.exponentialRampToValueAtTime(sc.cutoff, actualStart + sc.attack + sc.decay);
    }

    // 3. ADSR Volume Logic
    const attackEnd = actualStart + sc.attack;
    const decayEnd = attackEnd + sc.decay;
    const releaseStart = actualStart + noteDuration;
    const releaseEnd = releaseStart + sc.release;

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
        env.gain.exponentialRampToValueAtTime(Math.max(0.001, targetVolume * sc.sustain), decayEnd);
        env.gain.setValueAtTime(targetVolume * sc.sustain, releaseStart);
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

  private createContinuousVoice(midi: number, velocity: number, startTime: number, cfg: SynthConfig = this.config): ActiveVoice | null {
    if (!this.ctx) this.init();
    if (!this.ctx || !this.masterGain) return null;

    const now = Math.max(startTime, this.ctx.currentTime);
    const freq = this.midiToFreq(midi);

    const waveCorrection = cfg.waveType === 'sine' ? 1.1 : (cfg.waveType === 'sawtooth' ? 0.9 : 1.0);
    const levelPerDrive = (velocity / 127) * 0.4 * waveCorrection;
    const targetVolume = levelPerDrive * cfg.drive;

    const osc = this.ctx.createOscillator();
    const filter = this.ctx.createBiquadFilter();
    const env = this.ctx.createGain();

    osc.type = cfg.waveType as OscillatorType;
    osc.frequency.setValueAtTime(freq, now);
    osc.detune.setValueAtTime(cfg.detune, now);

    const filterEnvAmount = cfg.cutoff * 1.5;
    filter.type = 'lowpass';
    filter.Q.setValueAtTime(cfg.resonance, now);

    const startCutoff = Math.max(100, cfg.cutoff);
    filter.frequency.setValueAtTime(startCutoff, now);

    filter.frequency.exponentialRampToValueAtTime(
        Math.min(20000, Math.max(100, cfg.cutoff + filterEnvAmount)),
        now + cfg.attack
    );
    filter.frequency.exponentialRampToValueAtTime(
        Math.max(100, cfg.cutoff),
        now + cfg.attack + cfg.decay
    );

    const safeSustain = Math.max(0.001, targetVolume * cfg.sustain);
    const safeVolume = Math.max(0.001, targetVolume);

    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(safeVolume, now + cfg.attack);
    env.gain.exponentialRampToValueAtTime(safeSustain, now + cfg.attack + cfg.decay);

    osc.connect(filter);
    filter.connect(env);
    env.connect(this.masterGain);

    osc.start(now);

    return {
      osc,
      filter,
      env,
      pitch: midi,
      levelPerDrive,
      startTime: now
    };
  }

  async startContinuousNotes(midis: number[], velocity: number, strumMs: number = 0): Promise<void> {
    if (!midis || midis.length === 0) return;

    this.stopContinuousNote();

    // Ensure the AudioContext is truly running before creating any voices.
    // This handles iOS tab-switch / video-interruption recovery inside the
    // user-gesture path so the browser will always honour the resume.
    await this.ensureRunning();
    if (!this.ctx) return;

    const baseStartTime = this.ctx.currentTime;
    const safeStepDelaySeconds = Math.max(0, strumMs) / 1000;

    const voices = midis
      .map((midi, index) => this.createContinuousVoice(midi, velocity, baseStartTime + (index * safeStepDelaySeconds)))
      .filter((voice): voice is ActiveVoice => voice !== null);

    this.activeVoices = voices;
  }

  /**
   * Start a chord additively (without stopping existing voices).
   * Returns an opaque group ID that can be passed to stopVoiceGroup() to
   * release only these voices, leaving all others playing.
   * params: synth parameter overrides applied ONLY to this group's voices —
   *   other simultaneously-playing groups are completely unaffected.
   * Used for multi-touch: each finger gets its own group and its own settings.
   */
  async startContinuousNotesGroup(midis: number[], velocity: number, strumMs: number = 0, params?: Partial<SynthConfig>): Promise<number> {
    if (!midis || midis.length === 0) return -1;

    // Ensure the AudioContext is truly running — always called from a user gesture.
    await this.ensureRunning();
    if (!this.ctx) return -1;

    // Snapshot a config for this group only — never touches other groups.
    const groupCfg: SynthConfig = params ? { ...this.config, ...params } : { ...this.config };

    const baseStartTime = this.ctx.currentTime;
    const safeStepDelaySeconds = Math.max(0, strumMs) / 1000;

    const voices = midis
      .map((midi, index) => this.createContinuousVoice(midi, velocity, baseStartTime + (index * safeStepDelaySeconds), groupCfg))
      .filter((voice): voice is ActiveVoice => voice !== null);

    this.activeVoices.push(...voices);
    const id = this.nextGroupId++;
    this.voiceGroups.set(id, voices);
    return id;
  }

  /**
   * Update synth params for a single voice group only.
   * Call this on pointer-move for the corresponding touch finger so each
   * finger modulates only its own voices.
   */
  updateVoiceGroup(groupId: number, params: Partial<SynthConfig>) {
    const group = this.voiceGroups.get(groupId);
    if (!group || !this.ctx) return;
    const now = this.ctx.currentTime;
    const rampTime = 0.05;
    group.forEach(voice => {
      const { osc, filter, env } = voice;
      if (params.cutoff !== undefined) {
        filter.frequency.setTargetAtTime(params.cutoff, now, rampTime);
      }
      if (params.resonance !== undefined) {
        filter.Q.setTargetAtTime(params.resonance, now, rampTime);
      }
      if (params.detune !== undefined) {
        osc.detune.setTargetAtTime(params.detune, now, rampTime);
      }
      if (params.sustain !== undefined || params.drive !== undefined) {
        const drive = params.drive ?? this.config.drive;
        const sustain = params.sustain ?? this.config.sustain;
        const sustainLevel = Math.max(0.001, voice.levelPerDrive * drive * sustain);
        env.gain.setTargetAtTime(sustainLevel, now, rampTime);
      }
    });
  }

  /**
   * Release only the voices belonging to the given group ID.
   * Other simultaneously-playing groups are unaffected.
   */
  stopVoiceGroup(groupId: number) {
    const group = this.voiceGroups.get(groupId);
    this.voiceGroups.delete(groupId);
    if (!group || !this.ctx) return;

    const now = this.ctx.currentTime;
    const releaseDuration = Math.max(0.01, this.config.release);
    const groupSet = new Set(group);

    group.forEach(({ osc, env, filter, startTime }) => {
      try {
        const releaseStart = Math.max(now, startTime);
        const releaseTime = releaseStart + releaseDuration;

        if (typeof env.gain.cancelAndHoldAtTime === 'function') {
          env.gain.cancelAndHoldAtTime(releaseStart);
        } else {
          env.gain.cancelScheduledValues(releaseStart);
          env.gain.setValueAtTime(Math.max(0.001, env.gain.value), releaseStart);
        }
        if (typeof filter.frequency.cancelAndHoldAtTime === 'function') {
          filter.frequency.cancelAndHoldAtTime(releaseStart);
        } else {
          filter.frequency.cancelScheduledValues(releaseStart);
        }

        env.gain.exponentialRampToValueAtTime(0.001, releaseTime);
        osc.stop(releaseTime + 0.1);
      } catch (e) {
        console.warn('Error stopping voice group', e);
      }
    });

    this.activeVoices = this.activeVoices.filter(v => !groupSet.has(v));
  }

  startContinuousNote(midi: number, velocity: number) {
    this.startContinuousNotes([midi], velocity);
  }

  /** Update the gain of all currently-playing continuous voices to reflect a new velocity value.
   *  Call this whenever the chord volume changes while notes are sounding. */
  setActiveVoicesVelocity(velocity: number) {
    if (this.activeVoices.length === 0 || !this.ctx) return;
    const now = this.ctx.currentTime;
    const rampTime = 0.05;
    const waveCorrection = this.config.waveType === 'sine' ? 1.1 : (this.config.waveType === 'sawtooth' ? 0.9 : 1.0);
    this.activeVoices.forEach(voice => {
      voice.levelPerDrive = (velocity / 127) * 0.4 * waveCorrection;
      const sustainLevel = Math.max(0.001, voice.levelPerDrive * this.config.drive * this.config.sustain);
      voice.env.gain.setTargetAtTime(sustainLevel, now, rampTime);
    });
  }

  /** Start a note and add it to the active voice pool without stopping existing voices. */
  async addContinuousNote(midi: number, velocity: number): Promise<void> {
    await this.ensureRunning();
    if (!this.ctx) return;
    const voice = this.createContinuousVoice(midi, velocity, this.ctx.currentTime);
    if (voice) this.activeVoices.push(voice);
  }

  stopContinuousNote() {
    this.voiceGroups.clear();
    if (this.activeVoices.length === 0 || !this.ctx) return;

    const now = this.ctx.currentTime;
    const releaseDuration = Math.max(0.01, this.config.release);

    this.activeVoices.forEach(({ osc, env, filter, startTime }) => {
      try {
        const releaseStart = Math.max(now, startTime);
        const releaseTime = releaseStart + releaseDuration;

        if (typeof env.gain.cancelAndHoldAtTime === 'function') {
          env.gain.cancelAndHoldAtTime(releaseStart);
        } else {
          env.gain.cancelScheduledValues(releaseStart);
          env.gain.setValueAtTime(Math.max(0.001, env.gain.value), releaseStart);
        }

        if (typeof filter.frequency.cancelAndHoldAtTime === 'function') {
          filter.frequency.cancelAndHoldAtTime(releaseStart);
        } else {
          filter.frequency.cancelScheduledValues(releaseStart);
        }

        env.gain.exponentialRampToValueAtTime(0.001, releaseTime);
        osc.stop(releaseTime + 0.1);
      } catch (e) {
        console.warn("Error stopping note", e);
      }
    });

    this.activeVoices = [];
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

  /**
   * Play a short metronome click. accent=true → higher pitch (beat 1 of measure).
   * Uses its own lightweight oscillator so it never interferes with voice management.
   */
  playMetronomeClick(accent: boolean = false) {
    if (!this.ctx) this.init();
    if (!this.ctx || !this.masterGain) return;
    if (this.ctx.state !== 'running') return;

    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(accent ? 1400 : 900, now);

    gain.gain.setValueAtTime(accent ? 0.45 : 0.28, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + (accent ? 0.07 : 0.05));

    osc.connect(gain);
    gain.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 0.12);
  }
}

export const audioEngine = new AudioEngine();
