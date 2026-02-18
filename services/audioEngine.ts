
import { MidiEvent, SynthConfig, SynthWaveType } from '../types';

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

  scheduleNote(event: MidiEvent, eventAbsoluteBeat: number, currentPlaybackBeat: number) {
    if (!this.ctx || !this.masterGain) return;

    const secondsPerBeat = 60 / this.tempo;
    const beatDistance = eventAbsoluteBeat - currentPlaybackBeat;
    
    const playAt = this.ctx.currentTime + (beatDistance * secondsPerBeat);
    const noteDuration = event.d * secondsPerBeat;

    if (playAt < this.ctx.currentTime - 0.05) return;

    const actualStart = Math.max(playAt, this.ctx.currentTime);
    const freq = this.midiToFreq(event.p);
    
    // Nodes
    const osc = this.ctx.createOscillator();
    const filter = this.ctx.createBiquadFilter();
    const env = this.ctx.createGain();

    // 1. Configure Oscillator - Explicitly set type from config
    osc.type = this.config.waveType as OscillatorType;
    osc.frequency.setValueAtTime(freq, actualStart);
    osc.detune.setValueAtTime(this.config.detune, actualStart);

    // 2. Configure Filter with Envelope (Sweep)
    // A simple filter envelope makes oscillator character much more obvious
    const filterEnvAmount = this.config.cutoff * 1.5; 
    filter.type = 'lowpass';
    filter.Q.setValueAtTime(this.config.resonance, actualStart);
    
    // Start at base cutoff
    filter.frequency.setValueAtTime(this.config.cutoff, actualStart);
    // Sweep up during attack
    filter.frequency.exponentialRampToValueAtTime(Math.min(20000, this.config.cutoff + filterEnvAmount), actualStart + this.config.attack);
    // Decay back to base sustain level
    filter.frequency.exponentialRampToValueAtTime(this.config.cutoff, actualStart + this.config.attack + this.config.decay);

    // 3. ADSR Volume Logic
    // Waveform compensation: Sines are pure fundamental, Saws have lots of energy. Adjust accordingly.
    const waveCorrection = this.config.waveType === 'sine' ? 1.5 : (this.config.waveType === 'sawtooth' ? 0.8 : 1.0);
    const v = (event.v / 127) * 0.4 * this.config.drive * waveCorrection;
    
    const attackEnd = actualStart + this.config.attack;
    const decayEnd = attackEnd + this.config.decay;
    const releaseStart = actualStart + noteDuration;
    const releaseEnd = releaseStart + this.config.release;

    env.gain.setValueAtTime(0, actualStart);
    env.gain.linearRampToValueAtTime(v, attackEnd);
    env.gain.exponentialRampToValueAtTime(Math.max(0.001, v * this.config.sustain), decayEnd);
    env.gain.setValueAtTime(v * this.config.sustain, releaseStart);
    env.gain.exponentialRampToValueAtTime(0.001, releaseEnd);

    // Connect Graph
    osc.connect(filter);
    filter.connect(env);
    env.connect(this.masterGain);

    osc.start(actualStart);
    osc.stop(releaseEnd + 0.1);
  }

  stopAll() {
    if (this.ctx) {
      this.ctx.close();
      this.ctx = null;
    }
  }

  get currentTime(): number {
    return this.ctx?.currentTime || 0;
  }
}

export const audioEngine = new AudioEngine();
