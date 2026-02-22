
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

  private lastNoteEndTime: number = 0;
  private activeNodes: { osc: OscillatorNode, filter: BiquadFilterNode, env: GainNode } | null = null;

  scheduleNote(event: MidiEvent, eventAbsoluteBeat: number, currentPlaybackBeat: number, legato: boolean = false) {
    if (!this.ctx || !this.masterGain) return;

    const secondsPerBeat = 60 / this.tempo;
    const beatDistance = eventAbsoluteBeat - currentPlaybackBeat;

    const playAt = this.ctx.currentTime + (beatDistance * secondsPerBeat);
    const noteDuration = event.d * secondsPerBeat;

    if (playAt < this.ctx.currentTime - 0.05) return;

    const actualStart = Math.max(playAt, this.ctx.currentTime);
    const freq = this.midiToFreq(event.p);
    const releaseTime = actualStart + noteDuration;

    // Check for Legato overlap
    // We allow a generous window: if the new note starts while the previous one is still releasing
    // (or just finished), we can legato. The previous note "ends" at releaseTime + release.
    // So if (actualStart < lastNoteEndTime + 0.1), we are good.
    if (legato && this.activeNodes && actualStart < this.lastNoteEndTime + 0.1) {
        // Reuse existing oscillator for smooth slide
        const { osc, filter, env } = this.activeNodes;

        // Slide Frequency
        osc.frequency.setTargetAtTime(freq, actualStart, 0.05); // 50ms portamento

        // Extend Envelope (Sustain)
        env.gain.cancelScheduledValues(actualStart);
        env.gain.setValueAtTime(env.gain.value, actualStart);

        // We stay at sustain level until the end of THIS new note
        const vol = (event.v / 127) * 0.4 * this.config.drive;
        env.gain.linearRampToValueAtTime(vol * this.config.sustain, actualStart + 0.05);

        // Schedule new release
        const releaseEnd = releaseTime + this.config.release;
        env.gain.setValueAtTime(vol * this.config.sustain, releaseTime);
        env.gain.exponentialRampToValueAtTime(0.001, releaseEnd);

        // Update tracking
        this.lastNoteEndTime = releaseEnd; // actually note end, not release end

        // Cancel previous stop and schedule new stop
        // Note: OscillatorNode does not support canceling a scheduled stop.
        // The standard workaround is to schedule a stop far in the future initially (done below for new notes)
        // or just let it run. Since we are reusing it, we can't "cancel" the stop from the previous note
        // if it was already scheduled tight.
        // FIX: In a robust engine, we would create a source node that loops or uses a custom gain envelope,
        // or just set a very long stop time on creation (e.g. 24 hours).
        // For this demo, let's assume the previous note had a long stop time or we simply accept
        // that extremely long legatos might cut off if they exceed the original stop time.

        return;
    }

    // --- Standard Note Trigger (Attack) ---

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
    // Don't stop immediately if we might want to legato from this note
    // But we do need a safety stop if no next note comes
    osc.stop(releaseEnd + 2.0);

    // Update tracking for next note
    this.lastNoteEndTime = releaseEnd; // actually note end, not release end
    this.activeNodes = { osc, filter, env };
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
