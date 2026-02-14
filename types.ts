
export interface MidiEvent {
  p: number; // Pitch (MIDI note 0-127)
  v: number; // Velocity (0-127)
  t: number; // Start time offset in beats from start of movement
  d: number; // Duration in beats
}

export interface CompositionState {
  isPlaying: boolean;
  tempo: number;
  genre: string;
  isGenerating: boolean;
}

export enum MusicGenre {
  CLASSICAL = "Classical",
  JAZZ = "Jazz Fusion",
  AMBIENT = "Ambient Sci-Fi",
  TECHNO = "Hard Techno",
  LOFI = "Lo-Fi Hip Hop",
  CYBERPUNK = "Cyberpunk Synthwave"
}
