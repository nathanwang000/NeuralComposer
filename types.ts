
export type SynthWaveType = 'sine' | 'square' | 'sawtooth' | 'triangle';

/** Ordered colour palette for auto-assigning track colours. */
export const TRACK_COLORS = [
  '#6366f1', // indigo   (default track 1)
  '#22d3ee', // cyan
  '#f59e0b', // amber
  '#10b981', // emerald
  '#f43f5e', // rose
  '#a78bfa', // violet
  '#fb923c', // orange
  '#34d399', // green
] as const;

export interface MidiEvent {
  p: number; // Pitch (MIDI note 0-127, supports floats for microtonal/bends)
  v: number; // Velocity (0-127)
  t: number; // Start time offset in beats from start of movement
  d: number; // Duration in beats
}

export interface CompositionState {
  isPlaying: boolean;
  tempo: number;
  genre: string;
  isGenerating: boolean;
  minPitch: number;
  maxPitch: number;
  legatoMode: boolean;
}

export interface SynthConfig {
  waveType: SynthWaveType;
  detune: number;
  osc2WaveType?: SynthWaveType;
  osc2Detune?: number;
  osc2Mix?: number;
  cutoff: number;
  resonance: number;
  attack: number;
  decay: number;
  sustain: number;
  release: number;
  vibratoRate?: number;
  vibratoDepth?: number;
  filterLfoRate?: number;
  filterLfoDepth?: number;
  velocityToCutoff?: number;
  transientMix?: number;
  drive: number;
  /** 0–1. Blends white noise into the signal (0 = pure oscillator, 1 = pure noise). */
  noiseMix: number;
  /** Hz. Highpass cutoff applied to the noise component (e.g. 7000 for hi-hat, 1000 for snare). 0 = no highpass. */
  noiseHpCutoff: number;
  /** Hz. When > 0 the oscillator starts at this frequency and exponentially drops over freqSweepTime (kick/tabla pitch-drop). */
  freqSweepStart: number;
  /** Seconds. Duration of the exponential frequency sweep when freqSweepStart is set. 0 = no sweep. */
  freqSweepTime: number;
}

// ---------------------------------------------------------------------------
// Track — the core multi-voice building block. Each track owns its own synth
// config and event history. TRACK_COLORS provides an auto-assign palette so
// new tracks always get a distinct colour without extra configuration.
// ---------------------------------------------------------------------------
export interface Track {
  id: string;
  name: string;
  /** CSS colour string — use TRACK_COLORS for consistency */
  color: string;
  synthConfig: SynthConfig;
  muted: boolean;
  /** Per-track output gain multiplier, 0–1 */
  volume: number;
}

export enum MusicGenre {
  CLASSICAL = "Classical",
  JAZZ = "Jazz Fusion",
  AMBIENT = "Ambient Sci-Fi",
  TECHNO = "Hard Techno",
  LOFI = "Lo-Fi Hip Hop",
  CYBERPUNK = "Cyberpunk Synthwave"
}

export const SYNTH_PRESETS: Record<string, SynthConfig> = {
  "Deep Bass": {
    waveType: 'sawtooth',
    detune: 5,
    cutoff: 800, // Increased from 400 to hear harmonics
    resonance: 8,
    attack: 0.01,
    decay: 0.2,
    sustain: 0.1,
    release: 0.2,
    drive: 1.4,
    noiseMix: 0, noiseHpCutoff: 0, freqSweepStart: 0, freqSweepTime: 0
  },
  "Crystal Lead": {
    waveType: 'square',
    detune: 0,
    cutoff: 4500,
    resonance: 3,
    attack: 0.02,
    decay: 0.1,
    sustain: 0.4,
    release: 0.6,
    drive: 1.1,
    noiseMix: 0, noiseHpCutoff: 0, freqSweepStart: 0, freqSweepTime: 0
  },
  "Ghostly Pad": {
    waveType: 'sine',
    detune: 15,
    cutoff: 1800,
    resonance: 1,
    attack: 1.5,
    decay: 1.0,
    sustain: 0.8,
    release: 2.0,
    drive: 1.0,
    noiseMix: 0, noiseHpCutoff: 0, freqSweepStart: 0, freqSweepTime: 0
  },
  "Neon Pluck": {
    waveType: 'sawtooth',
    detune: 2,
    cutoff: 2800,
    resonance: 10,
    attack: 0.001,
    decay: 0.15,
    sustain: 0.0,
    release: 0.15,
    drive: 1.3,
    noiseMix: 0, noiseHpCutoff: 0, freqSweepStart: 0, freqSweepTime: 0
  },
  "Grand Piano": {
    waveType: 'triangle',
    detune: 0,
    cutoff: 5500,
    resonance: 1,
    attack: 0.001,
    decay: 0.9,
    sustain: 0.08,
    release: 0.6,
    drive: 3.0,
    noiseMix: 0, noiseHpCutoff: 0, freqSweepStart: 0, freqSweepTime: 0
  },
  "Warm Rhodes": {
    waveType: 'triangle',
    detune: 3,
    cutoff: 3200,
    resonance: 2,
    attack: 0.005,
    decay: 0.5,
    sustain: 0.25,
    release: 0.9,
    drive: 3.05,
    noiseMix: 0, noiseHpCutoff: 0, freqSweepStart: 0, freqSweepTime: 0
  },
  "Soft Strings": {
    waveType: 'sawtooth',
    detune: 8,
    cutoff: 2000,
    resonance: 1,
    attack: 0.8,
    decay: 0.5,
    sustain: 0.9,
    release: 1.4,
    drive: 1.0,
    noiseMix: 0, noiseHpCutoff: 0, freqSweepStart: 0, freqSweepTime: 0
  },
  "French Horn": {
    waveType: 'triangle',
    detune: 0,
    osc2WaveType: 'sawtooth',
    osc2Detune: 2,
    osc2Mix: 0.1,
    cutoff: 760,
    resonance: 2.2,
    attack: 0.16,
    decay: 0.55,
    sustain: 0.42,
    release: 1.35,
    vibratoRate: 4.9,
    vibratoDepth: 4.5,
    filterLfoRate: 0.16,
    filterLfoDepth: 38,
    velocityToCutoff: 240,
    transientMix: 0.01,
    drive: 1.05,
    noiseMix: 0,
    noiseHpCutoff: 0,
    freqSweepStart: 0,
    freqSweepTime: 0
  },
  "Brass Section": {
    waveType: 'square',
    detune: 8,
    osc2WaveType: 'sawtooth',
    osc2Detune: -5,
    osc2Mix: 0.32,
    cutoff: 2400,
    resonance: 6,
    attack: 0.015,
    decay: 0.22,
    sustain: 0.35,
    release: 0.45,
    vibratoRate: 5.8,
    vibratoDepth: 4,
    filterLfoRate: 0.7,
    filterLfoDepth: 120,
    velocityToCutoff: 500,
    transientMix: 0.08,
    drive: 1.45,
    noiseMix: 0,
    noiseHpCutoff: 0,
    freqSweepStart: 0,
    freqSweepTime: 0
  },
  "Spiccato Strings": {
    waveType: 'sawtooth',
    detune: 6,
    osc2WaveType: 'triangle',
    osc2Detune: -4,
    osc2Mix: 0.18,
    cutoff: 3000,
    resonance: 3,
    attack: 0.001,
    decay: 0.18,
    sustain: 0.05,
    release: 0.14,
    vibratoRate: 0,
    vibratoDepth: 0,
    filterLfoRate: 0,
    filterLfoDepth: 0,
    velocityToCutoff: 700,
    transientMix: 0.14,
    drive: 1.1,
    noiseMix: 0,
    noiseHpCutoff: 0,
    freqSweepStart: 0,
    freqSweepTime: 0
  },
  "Grand Choir": {
    waveType: 'sine',
    detune: 11,
    osc2WaveType: 'triangle',
    osc2Detune: -7,
    osc2Mix: 0.28,
    cutoff: 1200,
    resonance: 1,
    attack: 1.2,
    decay: 0.9,
    sustain: 0.94,
    release: 2.8,
    vibratoRate: 4.8,
    vibratoDepth: 3,
    filterLfoRate: 0.22,
    filterLfoDepth: 90,
    velocityToCutoff: 140,
    transientMix: 0,
    drive: 1.0,
    noiseMix: 0,
    noiseHpCutoff: 0,
    freqSweepStart: 0,
    freqSweepTime: 0
  },
  "Acid Bass": {
    waveType: 'sawtooth',
    detune: 0,
    cutoff: 600,
    resonance: 18,
    attack: 0.001,
    decay: 0.3,
    sustain: 0.0,
    release: 0.1,
    drive: 1.7,
    noiseMix: 0, noiseHpCutoff: 0, freqSweepStart: 0, freqSweepTime: 0
  },
  // ── Percussive ──────────────────────────────────────────────────────────────
  "Kick Drum": {
    // Pitch drops from 150 Hz → silence over 0.5 s — the classic thud.
    waveType: 'triangle',
    detune: 0,
    cutoff: 320,
    resonance: 6,
    attack: 0.001,
    decay: 0.25,
    sustain: 0.0,
    release: 0.15,
    drive: 10.0,
    freqSweepStart: 150,
    freqSweepTime: 0.5,
    noiseMix: 0,
    noiseHpCutoff: 0
  },
  "Concert Timpani": {
    waveType: 'triangle',
    detune: 0,
    osc2WaveType: 'sine',
    osc2Detune: -3,
    osc2Mix: 0.22,
    cutoff: 420,
    resonance: 8,
    attack: 0.001,
    decay: 0.45,
    sustain: 0.0,
    release: 0.28,
    vibratoRate: 0,
    vibratoDepth: 0,
    filterLfoRate: 0,
    filterLfoDepth: 0,
    velocityToCutoff: 180,
    transientMix: 0.18,
    drive: 2.4,
    freqSweepStart: 110,
    freqSweepTime: 0.18,
    noiseMix: 0.08,
    noiseHpCutoff: 200
  },
  "Snare Hit": {
    // 70% white noise (highpassed at 1 kHz) + 30% triangle body tone.
    waveType: 'triangle',
    detune: 0,
    cutoff: 3800,
    resonance: 5,
    attack: 0.001,
    decay: 0.12,
    sustain: 0.0,
    release: 0.08,
    drive: 1.5,
    noiseMix: 0.7,
    noiseHpCutoff: 1000,
    freqSweepStart: 180,
    freqSweepTime: 0.08
  },
  "Rim Shot": {
    // Almost all noise, cut very high — tight click.
    waveType: 'square',
    detune: 0,
    cutoff: 6000,
    resonance: 12,
    attack: 0.001,
    decay: 0.06,
    sustain: 0.0,
    release: 0.04,
    drive: 1.6,
    noiseMix: 0.85,
    noiseHpCutoff: 3000,
    freqSweepStart: 0,
    freqSweepTime: 0
  },
  "Marimba": {
    // Wooden mallet: triangle wave, fast decay, slight resonance warmth
    waveType: 'triangle',
    detune: 0,
    cutoff: 4200,
    resonance: 2,
    attack: 0.001,
    decay: 0.35,
    sustain: 0.0,
    release: 0.2,
    drive: 1.0,
    noiseMix: 0, noiseHpCutoff: 0, freqSweepStart: 0, freqSweepTime: 0
  },
  "Steel Drum": {
    // Bright metallic ping: high resonance sings on the transient
    waveType: 'triangle',
    detune: 4,
    cutoff: 5000,
    resonance: 14,
    attack: 0.001,
    decay: 0.5,
    sustain: 0.0,
    release: 0.3,
    drive: 1.1,
    noiseMix: 0, noiseHpCutoff: 0, freqSweepStart: 0, freqSweepTime: 0
  },
  "Tabla": {
    // Warm finger drum: pitch drops slightly, small noise layer for the skin snap.
    waveType: 'sawtooth',
    detune: 0,
    cutoff: 900,
    resonance: 9,
    attack: 0.001,
    decay: 0.28,
    sustain: 0.0,
    release: 0.18,
    drive: 1.3,
    freqSweepStart: 0,
    freqSweepTime: 0.12,
    noiseMix: 0.15,
    noiseHpCutoff: 800
  }
};
