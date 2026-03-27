import { MidiEvent, SynthConfig } from '../types';

// ---------------------------------------------------------------------------
// WAV encoder — converts a Web Audio AudioBuffer to a WAV Blob (16-bit PCM).
// No external libraries required.
// ---------------------------------------------------------------------------
function audioBufferToWav(buffer: AudioBuffer): Blob {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const numSamples = buffer.length;
  const bytesPerSample = 2; // 16-bit
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numSamples * blockAlign;
  const headerSize = 44;

  const arrayBuffer = new ArrayBuffer(headerSize + dataSize);
  const view = new DataView(arrayBuffer);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  const clamp16 = (n: number) => Math.max(-32768, Math.min(32767, n));

  // RIFF header
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);          // PCM chunk size
  view.setUint16(20, 1, true);           // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);          // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  // Interleaved PCM samples
  const channels = Array.from({ length: numChannels }, (_, c) => buffer.getChannelData(c));
  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    for (let c = 0; c < numChannels; c++) {
      view.setInt16(offset, clamp16(Math.round(channels[c][i] * 32767)), true);
      offset += 2;
    }
  }

  return new Blob([arrayBuffer], { type: 'audio/wav' });
}
// ---------------------------------------------------------------------------

interface ActiveVoice {
  osc: OscillatorNode;
  filter: BiquadFilterNode;
  env: GainNode;
  /** Looped noise source, present only when noiseMix > 0. Must be stopped alongside osc. */
  noiseSrc?: AudioBufferSourceNode;
  /** True for sustain=0 presets (percussion). Voice self-terminates; stop paths should not cancel its envelope. */
  isOneShot: boolean;
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

  /**
   * Build and connect the synthesis graph for a single note into `ctx`, with
   * all output routed to `destination`. Works with both a live AudioContext
   * and an OfflineAudioContext, so live playback and WAV export share one path.
   *
   * Returns the `releaseEnd` timestamp so callers can update their legato
   * tracking variable.
   *
   * @param stopOffset  Maximum allowed stop time (use Infinity for live ctx).
   */
  private buildNoteGraph(
    ctx: BaseAudioContext,
    destination: AudioNode,
    sc: SynthConfig,
    freq: number,
    velocity: number,
    actualStart: number,
    noteDuration: number,
    isLegatoTransition: boolean,
    trackVolume: number = 1,
    stopOffset: number = Infinity,
  ): number {
    const noiseMix = sc.noiseMix ?? 0;
    const freqSweepStart = sc.freqSweepStart ?? 0;
    const freqSweepTime = sc.freqSweepTime ?? 0;

    const waveCorrection = sc.waveType === 'sine' ? 1.1 : (sc.waveType === 'sawtooth' ? 0.9 : 1.0);
    const vol = Math.max(0, Math.min(1, trackVolume));
    const targetVolume = (velocity / 127) * 0.4 * sc.drive * waveCorrection * vol;

    const osc = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const env = ctx.createGain();

    // 1. Oscillator frequency / sweep
    osc.type = sc.waveType as OscillatorType;
    osc.detune.setValueAtTime(sc.detune, actualStart);
    if (freqSweepStart > 0 && freqSweepTime > 0) {
      osc.frequency.setValueAtTime(freqSweepStart, actualStart);
      osc.frequency.exponentialRampToValueAtTime(0.01, actualStart + freqSweepTime);
    } else if (freqSweepTime > 0) {
      osc.frequency.setValueAtTime(freq, actualStart);
      osc.frequency.exponentialRampToValueAtTime(Math.max(0.01, freq * 0.5), actualStart + freqSweepTime);
    } else {
      osc.frequency.setValueAtTime(freq, actualStart);
    }

    // 2. Filter envelope
    const filterEnvAmount = sc.cutoff * 1.5;
    filter.type = 'lowpass';
    filter.Q.setValueAtTime(sc.resonance, actualStart);
    filter.frequency.setValueAtTime(sc.cutoff, actualStart);
    if (isLegatoTransition) {
      filter.frequency.setValueAtTime(sc.cutoff + filterEnvAmount * 0.5, actualStart);
      filter.frequency.exponentialRampToValueAtTime(sc.cutoff, actualStart + sc.decay);
    } else {
      filter.frequency.exponentialRampToValueAtTime(Math.min(20000, sc.cutoff + filterEnvAmount), actualStart + sc.attack);
      filter.frequency.exponentialRampToValueAtTime(sc.cutoff, actualStart + sc.attack + sc.decay);
    }

    // 3. ADSR amplitude envelope
    const attackEnd = actualStart + sc.attack;
    const decayEnd = attackEnd + sc.decay;
    const releaseStart = actualStart + noteDuration;
    const releaseEnd = releaseStart + sc.release;

    env.gain.cancelScheduledValues(actualStart);
    if (isLegatoTransition) {
      env.gain.setValueAtTime(0, actualStart);
      env.gain.linearRampToValueAtTime(targetVolume, actualStart + 0.02);
      env.gain.setValueAtTime(targetVolume, releaseStart);
    } else {
      env.gain.setValueAtTime(0, actualStart);
      env.gain.linearRampToValueAtTime(targetVolume, attackEnd);
      env.gain.exponentialRampToValueAtTime(Math.max(0.001, targetVolume * sc.sustain), decayEnd);
      env.gain.setValueAtTime(targetVolume * sc.sustain, releaseStart);
    }
    env.gain.exponentialRampToValueAtTime(0.001, releaseEnd);

    // 4. Oscillator path (scaled by 1 - noiseMix)
    if (noiseMix < 1) {
      const oscPreGain = ctx.createGain();
      oscPreGain.gain.setValueAtTime(1 - noiseMix, actualStart);
      osc.connect(filter);
      filter.connect(oscPreGain);
      oscPreGain.connect(env);
    }

    // 5. Noise path (active when noiseMix > 0)
    if (noiseMix > 0) {
      const noiseDuration = releaseEnd - actualStart + 0.05;
      const noiseSamples = Math.ceil(ctx.sampleRate * noiseDuration);
      const noiseBuffer = ctx.createBuffer(1, noiseSamples, ctx.sampleRate);
      const data = noiseBuffer.getChannelData(0);
      for (let i = 0; i < noiseSamples; i++) data[i] = Math.random() * 2 - 1;
      const noiseSrc = ctx.createBufferSource();
      noiseSrc.buffer = noiseBuffer;
      const noiseHp = ctx.createBiquadFilter();
      noiseHp.type = 'highpass';
      noiseHp.frequency.value = sc.noiseHpCutoff ?? 1000;
      const noisePreGain = ctx.createGain();
      noisePreGain.gain.setValueAtTime(noiseMix, actualStart);
      noiseSrc.connect(noiseHp);
      noiseHp.connect(noisePreGain);
      noisePreGain.connect(env);
      noiseSrc.start(actualStart);
      noiseSrc.stop(Math.min(releaseEnd + 0.05, stopOffset));
    }

    env.connect(destination);
    osc.start(actualStart);
    osc.stop(Math.min(releaseEnd + 0.1, stopOffset));

    return releaseEnd;
  }

  /**
   * Schedule a single MIDI event for future playback.
   * `config` overrides the engine's global baseConfig — pass a track's own
   * SynthConfig here so each track can have its own sound.
   * `trackVolume` (0–1) is the per-track gain multiplier; defaults to 1.
   */
  scheduleNote(event: MidiEvent, eventAbsoluteBeat: number, currentPlaybackBeat: number, legato: boolean = false, config?: SynthConfig, trackVolume: number = 1) {
    if (!this.ctx || !this.masterGain || this.ctx.state !== 'running') return;

    const secondsPerBeat = 60 / this.tempo;
    const beatDistance = eventAbsoluteBeat - currentPlaybackBeat;

    const playAt = this.ctx.currentTime + (beatDistance * secondsPerBeat);
    const noteDuration = event.d * secondsPerBeat;

    if (playAt < this.ctx.currentTime - 0.05) return;

    const actualStart = Math.max(playAt, this.ctx.currentTime);
    const freq = this.midiToFreq(event.p);

    // Use the supplied per-track config when available; fall back to baseConfig
    // so the performance-pad synth panel still controls untracked notes.
    const sc = config ?? this.baseConfig;
    const isLegatoTransition = legato && (actualStart < this.globalLastNoteEndTime + 0.1);

    const releaseEnd = this.buildNoteGraph(
      this.ctx, this.masterGain, sc, freq, event.v,
      actualStart, noteDuration, isLegatoTransition, trackVolume,
    );

    if (releaseEnd > this.globalLastNoteEndTime) {
      this.globalLastNoteEndTime = releaseEnd;
    }
  }

  private createContinuousVoice(midi: number, velocity: number, startTime: number, cfg: SynthConfig = this.config): ActiveVoice | null {
    if (!this.ctx) this.init();
    if (!this.ctx || !this.masterGain) return null;

    const now = Math.max(startTime, this.ctx.currentTime);
    const freq = this.midiToFreq(midi);

    const noiseMix = cfg.noiseMix ?? 0;
    const freqSweepStart = cfg.freqSweepStart ?? 0;
    const freqSweepTime = cfg.freqSweepTime ?? 0;

    const waveCorrection = cfg.waveType === 'sine' ? 1.1 : (cfg.waveType === 'sawtooth' ? 0.9 : 1.0);
    const levelPerDrive = (velocity / 127) * 0.4 * waveCorrection;
    const targetVolume = levelPerDrive * cfg.drive;

    const osc = this.ctx.createOscillator();
    const filter = this.ctx.createBiquadFilter();
    const env = this.ctx.createGain();

    // Oscillator frequency / sweep
    osc.type = cfg.waveType as OscillatorType;
    osc.detune.setValueAtTime(cfg.detune, now);
    if (freqSweepStart > 0 && freqSweepTime > 0) {
      osc.frequency.setValueAtTime(freqSweepStart, now);
      osc.frequency.exponentialRampToValueAtTime(0.01, now + freqSweepTime);
    } else if (freqSweepTime > 0) {
      osc.frequency.setValueAtTime(freq, now);
      osc.frequency.exponentialRampToValueAtTime(Math.max(0.01, freq * 0.5), now + freqSweepTime);
    } else {
      osc.frequency.setValueAtTime(freq, now);
    }

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

    // For percussive (sustain=0) presets, auto-stop after the natural decay+release
    // so they behave identically to sequencer playback regardless of hold duration.
    const isOneShot = cfg.sustain === 0;
    const oneShotEnd = isOneShot ? now + cfg.attack + cfg.decay + cfg.release : Infinity;

    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(safeVolume, now + cfg.attack);
    env.gain.exponentialRampToValueAtTime(safeSustain, now + cfg.attack + cfg.decay);
    if (isOneShot) {
      env.gain.exponentialRampToValueAtTime(0.001, oneShotEnd);
    }

    let voice_noiseSrc: AudioBufferSourceNode | undefined;

    // Oscillator path (scaled by 1 - noiseMix)
    if (noiseMix < 1) {
      const oscPreGain = this.ctx.createGain();
      oscPreGain.gain.setValueAtTime(1 - noiseMix, now);
      osc.connect(filter);
      filter.connect(oscPreGain);
      oscPreGain.connect(env);
    }

    // Noise path — looped so it never runs out during an indefinite hold
    if (noiseMix > 0) {
      const loopSamples = this.ctx.sampleRate; // 1 s loop
      const noiseBuffer = this.ctx.createBuffer(1, loopSamples, this.ctx.sampleRate);
      const data = noiseBuffer.getChannelData(0);
      for (let i = 0; i < loopSamples; i++) data[i] = Math.random() * 2 - 1;
      const noiseSrc = this.ctx.createBufferSource();
      noiseSrc.buffer = noiseBuffer;
      noiseSrc.loop = true;
      const noiseHp = this.ctx.createBiquadFilter();
      noiseHp.type = 'highpass';
      noiseHp.frequency.value = cfg.noiseHpCutoff ?? 1000;
      const noisePreGain = this.ctx.createGain();
      noisePreGain.gain.setValueAtTime(noiseMix, now);
      noiseSrc.connect(noiseHp);
      noiseHp.connect(noisePreGain);
      noisePreGain.connect(env);
      noiseSrc.start(now);
      // noiseSrc is stored on the voice so stop paths can call noiseSrc.stop() explicitly.
      voice_noiseSrc = noiseSrc;
    }

    env.connect(this.masterGain);
    osc.start(now);
    if (isOneShot) {
      osc.stop(oneShotEnd + 0.05);
      voice_noiseSrc?.stop(oneShotEnd + 0.05);
    }

    return {
      osc,
      filter,
      env,
      noiseSrc: voice_noiseSrc,
      isOneShot,
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

    group.forEach(({ osc, noiseSrc, env, filter, startTime, isOneShot }) => {
      // One-shot voices self-terminate — cancelling their envelope would freeze
      // the gain mid-decay, causing an unintended sustain.
      if (isOneShot) return;
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
        noiseSrc?.stop(releaseTime + 0.1);
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

    this.activeVoices.forEach(({ osc, noiseSrc, env, filter, startTime, isOneShot }) => {
      // One-shot voices self-terminate — cancelling their envelope would freeze
      // the gain mid-decay, causing an unintended sustain.
      if (isOneShot) return;
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
        noiseSrc?.stop(releaseTime + 0.1);
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
   * Offline render: synthesises every supplied event and returns a WAV Blob.
   * Each event may carry its own `synthConfig` (from a Track); events without
   * one fall back to the engine's current baseConfig.
   * No live AudioContext is touched.
   *
   * @param events   - absolute-beat-positioned events to render
   * @param tempo    - BPM used for beat→seconds conversion
   * @param legato   - whether to apply legato transitions
   */
  async renderToWav(
    events: { event: MidiEvent; beatOffset: number; synthConfig?: SynthConfig; trackVolume?: number }[],
    tempo: number,
    legato: boolean = false,
  ): Promise<Blob> {
    const secondsPerBeat = 60 / tempo;

    // Compute total duration (last note end + generous release tail)
    let lastEnd = 0;
    for (const { event, beatOffset, synthConfig } of events) {
      const sc = synthConfig ?? this.baseConfig;
      const end = (beatOffset + event.t + event.d) * secondsPerBeat + sc.release + 0.5;
      if (end > lastEnd) lastEnd = end;
    }
    const totalSeconds = Math.max(1, lastEnd);

    const sampleRate = 44100;
    const offlineCtx = new OfflineAudioContext(2, Math.ceil(sampleRate * totalSeconds), sampleRate);

    const masterGain = offlineCtx.createGain();
    masterGain.gain.value = 0.3;
    masterGain.connect(offlineCtx.destination);

    const midiToFreq = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);

    // Sort by absolute start time so legato detection matches live playback
    const sorted = [...events].sort(
      (a, b) => (a.beatOffset + a.event.t) - (b.beatOffset + b.event.t),
    );

    let globalLastNoteEndTime = 0;

    for (const { event, beatOffset, synthConfig: trackConfig, trackVolume } of sorted) {
      const sc = trackConfig ?? this.baseConfig;
      const actualStart = (beatOffset + event.t) * secondsPerBeat;
      const noteDuration = event.d * secondsPerBeat;
      const freq = midiToFreq(event.p);
      const isLegatoTransition = legato && (actualStart < globalLastNoteEndTime + 0.1);

      const releaseEnd = this.buildNoteGraph(
        offlineCtx, masterGain, sc, freq, event.v,
        actualStart, noteDuration, isLegatoTransition,
        /* trackVolume */ trackVolume ?? 1, /* stopOffset */ totalSeconds,
      );

      if (releaseEnd > globalLastNoteEndTime) globalLastNoteEndTime = releaseEnd;
    }

    const buffer = await offlineCtx.startRendering();
    return audioBufferToWav(buffer);
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
