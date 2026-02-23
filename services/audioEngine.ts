
import { MidiEvent, SynthConfig } from '../types';

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
        // Legato: Skip Attack, start at Sustain volume immediately (with tiny fade in to avoid clicks)
        // This simulates the "fingered legato" where the sound doesn't die down between notes
        env.gain.setValueAtTime(0, actualStart);
        env.gain.linearRampToValueAtTime(targetVolume * this.config.sustain, actualStart + 0.02); // 20ms quick fade

        // No decay needed if we are already at sustain. Just hold level.
        env.gain.setValueAtTime(targetVolume * this.config.sustain, releaseStart);
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

  stopAll() {
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
