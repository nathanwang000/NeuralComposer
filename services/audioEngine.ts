
import { MidiEvent } from '../types';

class AudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private tempo: number = 120;
  private scheduledNoteIds = new Set<string>();

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

  setVolume(vol: number) {
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(vol, this.ctx.currentTime, 0.1);
    }
  }

  private midiToFreq(midi: number): number {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  /**
   * Schedules a note based on the current context time and its distance from the playhead.
   * @param event The MIDI event
   * @param eventAbsoluteBeat The beat number where this note starts in the global timeline
   * @param currentPlaybackBeat The beat number where the playhead currently is
   */
  scheduleNote(event: MidiEvent, eventAbsoluteBeat: number, currentPlaybackBeat: number) {
    if (!this.ctx || !this.masterGain) return;

    const secondsPerBeat = 60 / this.tempo;
    const beatDistance = eventAbsoluteBeat - currentPlaybackBeat;
    
    // Calculate start time in the AudioContext timeline
    const playAt = this.ctx.currentTime + (beatDistance * secondsPerBeat);
    const noteDuration = event.d * secondsPerBeat;

    // Don't play notes that are already in the past
    if (playAt < this.ctx.currentTime - 0.05) return;

    const osc = this.ctx.createOscillator();
    const env = this.ctx.createGain();

    if (event.p < 45) {
      osc.type = 'sine';
    } else if (event.p > 85) {
      osc.type = 'triangle';
    } else {
      osc.type = 'square';
    }

    osc.frequency.setValueAtTime(this.midiToFreq(event.p), Math.max(playAt, this.ctx.currentTime));
    
    const velocityGain = (event.v / 127) * 0.4;
    const actualStart = Math.max(playAt, this.ctx.currentTime);
    
    env.gain.setValueAtTime(0, actualStart);
    env.gain.linearRampToValueAtTime(velocityGain, actualStart + 0.01);
    env.gain.exponentialRampToValueAtTime(0.001, actualStart + noteDuration);

    osc.connect(env);
    env.connect(this.masterGain);

    osc.start(actualStart);
    osc.stop(actualStart + noteDuration + 0.1);
  }

  stopAll() {
    if (this.ctx) {
      this.ctx.close();
      this.ctx = null;
    }
    this.scheduledNoteIds.clear();
  }

  get isRunning(): boolean {
    return !!this.ctx && this.ctx.state !== 'closed';
  }

  get currentTime(): number {
    return this.ctx?.currentTime || 0;
  }
}

export const audioEngine = new AudioEngine();
