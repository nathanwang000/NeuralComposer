
export type SynthWaveType = 'sine' | 'square' | 'sawtooth' | 'triangle';

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
  cutoff: number;
  resonance: number;
  attack: number;
  decay: number;
  sustain: number;
  release: number;
  drive: number;
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
    drive: 1.4
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
    drive: 1.1
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
    drive: 1.0
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
    drive: 1.3
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
    drive: 1.0
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
    drive: 1.05
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
    drive: 1.0
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
    drive: 1.7
  }
};
