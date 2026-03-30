
import {
  Activity,
  ArrowLeftRight,
  ArrowUpDown,
  ClipboardPaste,
  Copy,
  Cpu,
  Disc,
  Download,
  FileAudio,
  Gauge,
  HelpCircle,
  Loader2,
  Mic,
  Minus,
  MousePointer2,
  Music,
  Palette,
  Pause,
  Play,
  Plus,
  PlusCircle,
  Redo,
  RefreshCw,
  RotateCcw,
  Scissors,
  SlidersHorizontal,
  Sparkles,
  Terminal,
  Trash2,
  Undo,
  Waves,
  X,
  Zap,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import PerformancePad from './components/PerformancePad';
import PianoRoll, { SelectionBounds } from './components/PianoRoll';
import SynthVisualizer from './components/SynthVisualizer';
import TimeNavigator from './components/TimeNavigator';
import { audioEngine } from './services/audioEngine';
import { composer } from './services/geminiComposer';
import { CompositionState, MidiEvent, MusicGenre, SYNTH_PRESETS, SynthConfig, SynthWaveType, Track, TRACK_COLORS } from './types';

// ---------------------------------------------------------------------------
// KB_SEQ — single source of truth for every sequencer keyboard shortcut.
//
// display: label rendered in the shortcuts modal (auto-adapts ⌘ / ⌃ by platform).
// hint:    short description of what the shortcut does.
//
// To remap a shortcut:
//   1. Change `display` here.
//   2. Update the matching case in the keydown handler below.
//
// The modal text is generated automatically from these values — no manual update needed.
// ---------------------------------------------------------------------------
const _IS_MAC = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);
const _MOD = _IS_MAC ? '⌘' : '⌃';

const KB_SEQ = {
  // ── Clipboard / edit ──────────────────────────────────────────────────────
  SELECT_ALL: { key: 'a',          display: `${_IS_MAC ? '⌘' : 'Ctrl+'}A`, hint: 'Select all notes',          mod: true },
  COPY:       { key: 'c',          display: `${_MOD}C`,     hint: 'Copy selection',            mod: true },
  CUT:        { key: 'x',          display: `${_MOD}X`,     hint: 'Cut selection',             mod: true },
  PASTE:      { key: 'v',          display: `${_MOD}V`,     hint: 'Paste at playhead',         mod: true },
  INJECT:     { key: 'i',          display: 'I',            hint: 'Inject patch bay notes' },
  UNDO:       { key: 'z',          display: `${_MOD}Z`,     hint: 'Undo',                      mod: true },
  REDO:       { key: 'z',          display: `${_MOD}⇧Z`,    hint: 'Redo',                      mod: true, shift: true },
  REDO_ALT:   { key: 'y',          display: `${_MOD}Y`,     hint: 'Redo (alt)',                mod: true },
  DELETE:            { key: 'Delete',     display: 'Del / ⌫',      hint: 'Delete selected notes' },
  CANCEL_SELECTION:  { key: 'g',          display: `${_MOD}G`,     hint: 'Cancel selection',          mod: true },
  // ── Transport ─────────────────────────────────────────────────────────────
  PLAY_PAUSE:   { key: ' ',          display: 'Space',        hint: 'Play / Pause' },
  REWIND:       { key: ['0', 'a'] as const, display: '0 / ^A',       hint: 'Rewind to beginning' },
  PREV_BAR:     { key: 'ArrowLeft',  display: '←',            hint: 'Back 1 measure' },
  NEXT_BAR:     { key: 'ArrowRight', display: '→',            hint: 'Forward 1 measure' },
  TOGGLE_TAB:   { key: 't',          display: 'T',            hint: 'Toggle Sequencer / Perform tab' },
  // ── Tracks ────────────────────────────────────────────────────────────────
  SELECT_TRACK: { key: '1-9' /* regex */, display: '1 – 9', hint: 'Select track by number' },
  MUTE_TRACK:   { key: 'm',          display: 'M',            hint: 'Mute / unmute active track' },
  // ── Emacs-style note navigation (Ctrl only) ────────────────────────────────
  // These move the playhead (the "point") forward/back note by note.
  // C-Space sets the mark; navigation while mark is active selects the region.
  SET_MARK:      { key: ' ',         display: '^Space',       hint: 'Set mark at playhead' },
  NAV_NEXT_NOTE: { key: 'f',         display: '^F',           hint: 'Jump to next note start' },
  NAV_PREV_NOTE: { key: 'b',         display: '^B',           hint: 'Jump to previous note start' },
  NAV_END_NOTE:  { key: 'e',         display: '^E',           hint: 'Jump to end of current note' },
  KILL_TO_END:   { key: 'k',         display: '^K',           hint: 'Kill (cut) notes from playhead to end' },
} as const;

// ---------------------------------------------------------------------------
// COLOR THEMES — token-based system
// Add any new theme by filling in one token object; no JSX conditionals needed.
// ---------------------------------------------------------------------------
interface NcTokens {
  // Page / chrome
  bg: string;           // page background
  hdr: string;          // header background
  toolbar: string;      // sequencer toolbar strip
  panel: string;        // right panel outer container
  card: string;         // standard card / section
  cardDeep: string;     // patch-bay + neural-stream panels
  inset: string;        // pill / inset containers (e.g. BPM box)
  inputBg: string;      // textarea / input background
  inputText: string;    // textarea text color
  inputPH: string;      // placeholder text color
  // Performance pad
  padBg: string;        // performance pad surface
  glassBg: string;      // glass overlay button bg
  glassBorder: string;  // glass overlay button border
  glassText: string;    // glass overlay button text
  stickyBg: string;     // sticky panel-header (note sequence)
  // Misc interactive
  sampleBtn: string;    // sample file button bg
  sampleBtnHov: string; // sample file button hover bg
  sampleBtnText: string;
  sampleBtnHovText: string;
  // Text hierarchy
  t1: string; t2: string; t3: string; t4: string;
  axisLabel: string;    // X/Y axis labels on pad
  // Borders
  b0: string; b1: string; b2: string; b3: string;
  // Subtle tint used for hover/active states (bg-white/5 → this)
  tint: string;
  // Accent colours (for text/icons — buttons that are bg-indigo-600 keep white text)
  indigo: string; emerald: string; cyan: string; red: string;
  // Canvas grid (PianoRoll)
  gridBar: string; gridBeat: string; gridEighth: string; gridSixteenth: string; gridOctave: string; gridPitch: string;
  // AI note brightness for canvas
  noteLightness: number;   // 38 light / 60 dark
  noteAltLightness: number; // 32 light / 40 dark
  noteAltAlpha: number;    // 0.75 light / 0.6 dark
}

interface NcTheme {
  id: string;
  label: string;
  desc: string;
  swatch: string;
  tokens: NcTokens;
}

const NC_THEMES: NcTheme[] = [
  {
    id: 'void', label: 'Void', desc: 'Deep-space black', swatch: '#020408',
    tokens: {
      bg: '#020408', hdr: '#020408',
      toolbar: 'rgba(15,23,42,0.6)',
      panel: 'rgba(15,23,42,0.2)',
      card: 'rgba(0,0,0,0.4)',
      cardDeep: 'rgba(2,6,23,0.8)',
      inset: '#0f172a',
      inputBg: 'rgba(0,0,0,0.4)', inputText: '#ffffff', inputPH: '#334155',
      padBg: '#0f172a',
      glassBg: 'rgba(0,0,0,0.6)', glassBorder: 'rgba(255,255,255,0.1)', glassText: '#94a3b8',
      stickyBg: 'rgba(2,6,23,0.9)',
      sampleBtn: '#0f172a', sampleBtnHov: '#1e293b', sampleBtnText: '#64748b', sampleBtnHovText: '#ffffff',
      t1: '#ffffff', t2: '#cbd5e1', t3: '#64748b', t4: '#334155', axisLabel: '#334155',
      b0: 'rgba(255,255,255,0.035)', b1: 'rgba(255,255,255,0.06)', b2: 'rgba(255,255,255,0.11)', b3: 'rgba(255,255,255,0.2)',
      tint: 'rgba(255,255,255,0.05)',
      indigo: '#818cf8', emerald: '#34d399', cyan: '#22d3ee', red: '#f87171',
      gridBar: 'rgba(255,255,255,0.22)', gridBeat: 'rgba(255,255,255,0.10)', gridEighth: 'rgba(255,255,255,0.06)', gridSixteenth: 'rgba(255,255,255,0.03)', gridOctave: 'rgba(255,255,255,0.18)', gridPitch: 'rgba(255,255,255,0.04)',
      noteLightness: 60, noteAltLightness: 40, noteAltAlpha: 0.6,
    },
  },
  {
    id: 'studio', label: 'Studio', desc: 'Warm paper — easy on eyes', swatch: '#f0ebe0',
    tokens: {
      bg: '#f5efe4', hdr: '#efe7d9',
      toolbar: 'rgba(226,216,197,0.9)',
      panel: 'rgba(255,249,240,0.74)',
      card: '#f8f1e5',
      cardDeep: '#e5d9c5',
      inset: '#d7cab4',
      inputBg: '#efe4d2', inputText: '#1f170d', inputPH: '#9b8264',
      padBg: '#ded1ba',
      glassBg: 'rgba(255,248,238,0.68)', glassBorder: 'rgba(66,46,14,0.08)', glassText: '#6f5b43',
      stickyBg: 'rgba(239,231,217,0.96)',
      sampleBtn: '#e4d8c6', sampleBtnHov: '#dacdb8', sampleBtnText: '#6f5b43', sampleBtnHovText: '#1f170d',
      t1: '#1f170d', t2: '#43311f', t3: '#7a6650', t4: '#a58d72', axisLabel: '#826d56',
      b0: 'rgba(40,28,8,0.04)', b1: 'rgba(40,28,8,0.07)', b2: 'rgba(40,28,8,0.11)', b3: 'rgba(40,28,8,0.18)',
      tint: 'rgba(40,28,8,0.04)',
      indigo: '#3730a3', emerald: '#047857', cyan: '#0e7490', red: '#b91c1c',
      gridBar: 'rgba(40,28,8,0.30)', gridBeat: 'rgba(40,28,8,0.15)', gridEighth: 'rgba(40,28,8,0.09)', gridSixteenth: 'rgba(40,28,8,0.05)',
      gridOctave: 'rgba(40,28,8,0.25)', gridPitch: 'rgba(40,28,8,0.07)',
      noteLightness: 38, noteAltLightness: 32, noteAltAlpha: 0.75,
    },
  },
  {
    id: 'ocean', label: 'Ocean', desc: 'Deep navy — cool & focused', swatch: '#0b1929',
    tokens: {
      bg: '#0b1929', hdr: '#0d1e32',
      toolbar: 'rgba(13,40,70,0.8)',
      panel: 'rgba(10,28,52,0.5)',
      card: 'rgba(10,30,58,0.6)',
      cardDeep: 'rgba(8,22,44,0.9)',
      inset: '#0d2240',
      inputBg: 'rgba(8,20,40,0.7)', inputText: '#cce4ff', inputPH: '#2d5a8a',
      padBg: '#0a1e38',
      glassBg: 'rgba(0,40,80,0.35)', glassBorder: 'rgba(80,160,255,0.12)', glassText: '#7ab8f5',
      stickyBg: 'rgba(8,22,44,0.92)',
      sampleBtn: '#0d2647', sampleBtnHov: '#163660', sampleBtnText: '#4d8ec4', sampleBtnHovText: '#cce4ff',
      t1: '#e8f4ff', t2: '#a8cef0', t3: '#4d8ec4', t4: '#2d5a8a', axisLabel: '#2d5a8a',
      b0: 'rgba(80,160,255,0.05)', b1: 'rgba(80,160,255,0.09)', b2: 'rgba(80,160,255,0.15)', b3: 'rgba(80,160,255,0.24)',
      tint: 'rgba(80,160,255,0.06)',
      indigo: '#60a5fa', emerald: '#34d399', cyan: '#22d3ee', red: '#f87171',
      gridBar: 'rgba(100,180,255,0.22)', gridBeat: 'rgba(100,180,255,0.10)', gridEighth: 'rgba(100,180,255,0.06)', gridSixteenth: 'rgba(100,180,255,0.03)', gridOctave: 'rgba(100,180,255,0.18)', gridPitch: 'rgba(100,180,255,0.04)',
      noteLightness: 62, noteAltLightness: 45, noteAltAlpha: 0.65,
    },
  },
];
type NcThemeId = string;
// ---------------------------------------------------------------------------

/** Grouped sections shown in the sequencer shortcuts modal. */
const SEQ_TUTORIAL_SECTIONS: { title: string; rows: { display: string; hint: string }[] }[] = [
  { title: 'Transport',  rows: [KB_SEQ.PLAY_PAUSE, KB_SEQ.REWIND, KB_SEQ.PREV_BAR, KB_SEQ.NEXT_BAR, KB_SEQ.TOGGLE_TAB] },
  { title: 'Navigate',   rows: [KB_SEQ.SET_MARK, KB_SEQ.REWIND, KB_SEQ.NAV_NEXT_NOTE, KB_SEQ.NAV_PREV_NOTE, KB_SEQ.NAV_END_NOTE] },
  { title: 'Tracks',     rows: [KB_SEQ.SELECT_TRACK, KB_SEQ.MUTE_TRACK] },
  { title: 'Selection',  rows: [KB_SEQ.SELECT_ALL, KB_SEQ.CANCEL_SELECTION] },
  { title: 'Clipboard',  rows: [KB_SEQ.COPY, KB_SEQ.CUT, KB_SEQ.PASTE, KB_SEQ.DELETE, KB_SEQ.KILL_TO_END] },
  { title: 'Actions',    rows: [KB_SEQ.INJECT] },
  { title: 'History',    rows: [KB_SEQ.UNDO, KB_SEQ.REDO, KB_SEQ.REDO_ALT] },
];
// ---------------------------------------------------------------------------

interface ValidationError {
  message: string;
  index: number;
}

interface TooltipCopy {
  musical: string;
  technical: string;
  tryText?: string;
}

type AppNotice = {
  kind: 'info' | 'success' | 'error';
  message: string;
};

const InfoTooltip: React.FC<{ copy: TooltipCopy; tokens: NcTokens }> = ({ copy, tokens }) => {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });

  const updatePosition = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const tooltipWidth = 288;
    const margin = 12;
    const left = Math.min(
      window.innerWidth - tooltipWidth - margin,
      Math.max(margin, rect.right - tooltipWidth)
    );
    const tooltipHeight = 150;
    const preferredTop = rect.bottom + 10;
    const top = preferredTop + tooltipHeight > window.innerHeight - margin
      ? Math.max(margin, rect.top - tooltipHeight - 10)
      : preferredTop;
    setPosition({ top, left });
  }, []);

  useEffect(() => {
    if (!open) return;
    updatePosition();
    window.addEventListener('scroll', updatePosition, true);
    window.addEventListener('resize', updatePosition);
    return () => {
      window.removeEventListener('scroll', updatePosition, true);
      window.removeEventListener('resize', updatePosition);
    };
  }, [open, updatePosition]);

  return (
    <span className="inline-flex items-center align-middle">
      <button
        ref={buttonRef}
        type="button"
        className="cursor-help transition-colors"
        style={{ color: open ? tokens.t2 : tokens.t4 }}
        aria-label="Show parameter help"
        onMouseEnter={() => { updatePosition(); setOpen(true); }}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => { updatePosition(); setOpen(true); }}
        onBlur={() => setOpen(false)}
      >
        <HelpCircle size={9} />
      </button>
      {open && typeof document !== 'undefined' && createPortal(
        <div
          className="pointer-events-none fixed z-[10000] w-72 rounded-xl border p-3 text-left normal-case tracking-normal text-[11px] leading-relaxed shadow-2xl"
          style={{
            top: position.top,
            left: position.left,
            backgroundColor: tokens.cardDeep,
            borderColor: tokens.b2,
            color: tokens.t2,
            boxShadow: `0 20px 40px ${tokens.tint}`,
          }}
        >
          <span className="block"><span style={{ color: tokens.indigo }} className="font-black">Musical:</span> {copy.musical}</span>
          <span className="mt-2 block"><span style={{ color: tokens.cyan }} className="font-black">Technical:</span> {copy.technical}</span>
          {copy.tryText ? <span className="mt-2 block"><span style={{ color: tokens.emerald }} className="font-black">Try:</span> {copy.tryText}</span> : null}
        </div>,
        document.body,
      )}
    </span>
  );
};

const SynthControlLabel: React.FC<{ label: string; copy?: TooltipCopy; tokens: NcTokens }> = ({ label, copy, tokens }) => (
  <span className="flex items-center gap-1">
    <span>{label}</span>
    {copy ? <InfoTooltip copy={copy} tokens={tokens} /> : null}
  </span>
);

const VOICE_TOOLTIPS: Record<string, TooltipCopy> = {
  waveType: {
    musical: 'Changes the core character of the sound before the filter shapes it.',
    technical: 'Selects the main oscillator waveform: sine, square, sawtooth, or triangle.',
    tryText: 'Use triangle for rounder tones and sawtooth for brighter, richer sounds.',
  },
  detune: {
    musical: 'Adds slight pitch offset for tension or thickness.',
    technical: 'Offsets the main oscillator pitch in cents relative to equal temperament.',
    tryText: 'Small amounts can make a lead feel less sterile; large amounts sound intentionally out of tune.',
  },
  osc2WaveType: {
    musical: 'Adds a second tone layer to make the sound fuller, rougher, or more colored.',
    technical: 'Chooses the waveform for the optional second oscillator mixed with the main oscillator.',
    tryText: 'Add a sawtooth second oscillator to give a triangle-based sound more harmonic body.',
  },
  osc2Detune: {
    musical: 'Separates the second tone slightly in pitch for width and chorusing.',
    technical: 'Offsets the second oscillator pitch in cents relative to the main oscillator.',
    tryText: 'Keep this subtle for warmth; larger values become obviously doubled.',
  },
  osc2Mix: {
    musical: 'Controls how much of the second tone is heard.',
    technical: 'Sets the gain of the second oscillator layer relative to the main oscillator.',
    tryText: 'A little goes a long way when thickening brass, strings, and pads.',
  },
  cutoff: {
    musical: 'Lower values sound darker and more muted; higher values sound brighter and more open.',
    technical: 'Sets the lowpass filter cutoff frequency, reducing frequencies above that point.',
    tryText: 'Lower it for mellow or distant sounds; raise it for brilliance and bite.',
  },
  resonance: {
    musical: 'Emphasizes the brightness edge, which can sound focused, nasal, or whistling at high settings.',
    technical: 'Boosts frequencies near the filter cutoff by increasing the filter Q.',
    tryText: 'A little adds presence; too much can make the sound feel synthetic very quickly.',
  },
  attack: {
    musical: 'Controls how quickly the note speaks, from instant attack to a slow swell.',
    technical: 'Sets the time the amplitude envelope takes to rise from silence to peak level.',
    tryText: 'Short for plucks and drums, longer for strings, brass swells, and pads.',
  },
  decay: {
    musical: 'Shapes how quickly the sound relaxes after the initial hit.',
    technical: 'Sets the time for the envelope to fall from peak to sustain level.',
    tryText: 'Fast decay makes sounds feel punchy; slower decay keeps them blooming longer.',
  },
  sustain: {
    musical: 'Determines how much body remains while the note is held.',
    technical: 'Sets the held level of the amplitude envelope after decay, as a fraction of the peak.',
    tryText: 'Low sustain feels percussive; high sustain feels continuous and supported.',
  },
  release: {
    musical: 'Controls how long the sound lingers after you let go.',
    technical: 'Sets the envelope time from the held level back down to silence after note-off.',
    tryText: 'Short release is tight and clean; long release creates tails and overlap.',
  },
  drive: {
    musical: 'Adds weight, punch, and harmonic intensity.',
    technical: 'Multiplies the voice level before the master bus, increasing perceived loudness and harmonic emphasis.',
    tryText: 'Use gentle drive to make a part feel forward; heavy drive can push it into aggressive territory.',
  },
  vibratoRate: {
    musical: 'Sets how fast the pitch wavers.',
    technical: 'Controls the frequency of the LFO modulating oscillator pitch.',
    tryText: 'Slower vibrato feels expressive; very fast vibrato starts sounding nervous or synthetic.',
  },
  vibratoDepth: {
    musical: 'Sets how dramatic the pitch wavering is.',
    technical: 'Controls the amplitude of pitch modulation in cents.',
    tryText: 'Keep it restrained for orchestral sounds unless you want an obvious effect.',
  },
  filterLfoRate: {
    musical: 'Sets how quickly the tone pulses in brightness.',
    technical: 'Controls the frequency of the LFO modulating the filter cutoff.',
    tryText: 'Slow values work well for pads and choir-like movement.',
  },
  filterLfoDepth: {
    musical: 'Controls how much the tone opens and closes over time.',
    technical: 'Sets the amount of cutoff modulation applied by the filter LFO in Hz.',
    tryText: 'A small amount adds life; large amounts create obvious sweeping motion.',
  },
  velocityToCutoff: {
    musical: 'Makes stronger notes sound brighter, like many acoustic instruments opening up under firmer articulation.',
    technical: 'Adds a velocity-scaled offset to the filter cutoff frequency for each note.',
    tryText: 'Useful when you want dynamic contrast without changing the base tone.',
  },
  transientMix: {
    musical: 'Adds a brief bite or click at the front of the note for definition.',
    technical: 'Mixes in a short high-frequency noise burst at note onset.',
    tryText: 'Helpful for making plucks, mallets, and accented brass cuts speak more clearly.',
  },
  noiseMix: {
    musical: 'Adds airy, noisy, or drum-like texture on top of the pitched tone.',
    technical: 'Blends white noise into the voice alongside the oscillators.',
    tryText: 'Raise it for snares and hats, or a little for breathier attacks.',
  },
  noiseHpCutoff: {
    musical: 'Moves the noise color from full-bodied to thin and bright.',
    technical: 'Highpass filters the noise layer, removing lower frequencies below the cutoff.',
    tryText: 'Lower values keep drum body; higher values isolate hiss and snap.',
  },
  freqSweepStart: {
    musical: 'Adds a downward pitch drop that is useful for kicks and other struck sounds.',
    technical: 'Sets the starting frequency for the oscillator before it exponentially falls over sweep time.',
    tryText: 'Try around 150 Hz for a kick-like thud.',
  },
  freqSweepTime: {
    musical: 'Controls how long the pitch drop lasts.',
    technical: 'Sets the duration of the exponential frequency sweep.',
    tryText: 'Longer sweeps feel deeper and heavier; short sweeps feel snappier.',
  },
};

interface AppEvent {
  event: MidiEvent;
  beatOffset: number;
  id: string;
  /** Which Track this event belongs to */
  trackId: string;
  isUser?: boolean;
  comment?: string;
}

// ---------------------------------------------------------------------------
// Track helpers — pure functions, no React state, easy to unit-test.
// ---------------------------------------------------------------------------

const DEFAULT_PRESET = 'Grand Piano' as const;

/** Build a fresh Track with sensible defaults. */
const createDefaultTrack = (id: string, name: string, color: string, presetName = DEFAULT_PRESET): Track => ({
  id,
  name,
  color,
  synthConfig: { ...SYNTH_PRESETS[presetName] },
  muted: false,
  volume: 1,
});

/**
 * Return the name of the best-matching preset for a SynthConfig, or `null` if
 * the config doesn't exactly match any preset. Used for the voice-header export.
 */
const findPresetName = (config: SynthConfig): string | null => {
  for (const [name, preset] of Object.entries(SYNTH_PRESETS)) {
    if (JSON.stringify(preset) === JSON.stringify(config)) return name;
  }
  return null;
};

/**
 * Serialise a SynthConfig as a voice-header fragment.
 * If it matches a named preset, emits `preset:"Name"` plus any overrides.
 * Otherwise emits all params explicitly.
 */
const serializeSynthConfig = (config: SynthConfig): string => {
  const presetName = findPresetName(config);
  if (presetName) return `preset:"${presetName}"`;
  const { waveType, detune, osc2WaveType, osc2Detune, osc2Mix, cutoff, resonance, attack, decay, sustain, release,
          vibratoRate, vibratoDepth, filterLfoRate, filterLfoDepth, velocityToCutoff, transientMix,
          drive, noiseMix, noiseHpCutoff, freqSweepStart, freqSweepTime } = config;
  const parts = [
    `wave:${waveType}`,
    `detune:${detune}`,
    osc2WaveType !== undefined ? `osc2Wave:${osc2WaveType}` : null,
    osc2Detune !== undefined ? `osc2Detune:${osc2Detune}` : null,
    osc2Mix !== undefined ? `osc2Mix:${osc2Mix}` : null,
    `cutoff:${cutoff}`,
    `resonance:${resonance}`,
    `attack:${attack}`,
    `decay:${decay}`,
    `sustain:${sustain}`,
    `release:${release}`,
    vibratoRate !== undefined ? `vibratoRate:${vibratoRate}` : null,
    vibratoDepth !== undefined ? `vibratoDepth:${vibratoDepth}` : null,
    filterLfoRate !== undefined ? `filterLfoRate:${filterLfoRate}` : null,
    filterLfoDepth !== undefined ? `filterLfoDepth:${filterLfoDepth}` : null,
    velocityToCutoff !== undefined ? `velocityToCutoff:${velocityToCutoff}` : null,
    transientMix !== undefined ? `transientMix:${transientMix}` : null,
    `drive:${drive}`,
    `noiseMix:${noiseMix}`,
    `noiseHpCutoff:${noiseHpCutoff}`,
    `freqSweepStart:${freqSweepStart}`,
    `freqSweepTime:${freqSweepTime}`,
  ].filter(Boolean);
  return parts.join(' ');
};

// ---------------------------------------------------------------------------
// Voice block parser
//
// Syntax understood by the Manual Patch Bay textarea:
//
//   [voice:1 name:"Lead" preset:"Grand Piano" cutoff:5500]
//   [P:60,V:100,T:0,D:1] ...
//
//   [voice:2 name:"Bass" preset:"Deep Bass"]
//   [P:40,V:90,T:0,D:2] ...
//
// Rules:
//   - voice:N is 1-based (maps to track index N-1).
//   - preset sets the base SynthConfig; individual params override it.
//   - Supported param keys: wave, detune, osc2Wave, osc2Detune, osc2Mix,
//     cutoff, resonance, attack, decay, sustain, release, vibratoRate,
//     vibratoDepth, filterLfoRate, filterLfoDepth, velocityToCutoff,
//     transientMix, drive, noiseMix, noiseHpCutoff, freqSweepStart,
//     freqSweepTime.
//   - If no voice headers are present, all notes go to voice 1 (track 0).
//   - Backward-compatible with old flat-format files (no voice headers).
// ---------------------------------------------------------------------------

interface VoiceBlock {
  /** 0-based track index */
  voiceIndex: number;
  /** Partial SynthConfig derived from the block header; null if no params */
  synthOverride: Partial<SynthConfig> | null;
  events: { event: MidiEvent; comment?: string }[];
}

/** Parse key:value pairs (including quoted strings) from a voice header body. */
const parseSynthParams = (paramStr: string): Partial<SynthConfig> | null => {
  const result: Record<string, any> = {};

  // preset:"Name" — load the named preset as the base
  const presetMatch = paramStr.match(/preset:"([^"]+)"/);
  if (presetMatch && SYNTH_PRESETS[presetMatch[1]]) {
    Object.assign(result, SYNTH_PRESETS[presetMatch[1]]);
  }

  // Individual param overrides: wave:sawtooth  cutoff:2800  noiseMix:0.7 …
  const kvRegex = /\b(wave|waveType|detune|osc2Wave|osc2WaveType|osc2Detune|osc2Mix|cutoff|resonance|attack|decay|sustain|release|vibratoRate|vibratoDepth|filterLfoRate|filterLfoDepth|velocityToCutoff|transientMix|drive|noiseMix|noiseHpCutoff|freqSweepStart|freqSweepTime):([^\s\]"]+)/g;
  let m;
  while ((m = kvRegex.exec(paramStr)) !== null) {
    const [, key, val] = m;
    if (key === 'wave' || key === 'waveType') result['waveType'] = val as SynthWaveType;
    else if (key === 'osc2Wave' || key === 'osc2WaveType') result['osc2WaveType'] = val as SynthWaveType;
    else result[key] = parseFloat(val);
  }

  return Object.keys(result).length > 0 ? (result as Partial<SynthConfig>) : null;
};

/** Extract MidiEvents from a text section (voice-header tokens already stripped).
 * Returns the parsed events plus any trailing comment lines that had no following
 * note in this section (so callers can carry them forward to the next block).
 */
const parseNoteEvents = (section: string): { events: { event: MidiEvent; comment?: string }[]; trailingComment?: string } => {
  const results: { event: MidiEvent; comment?: string }[] = [];
  const lines = section.split('\n');
  let pendingComment: string | undefined;

  for (const line of lines) {
    const trimmed = line.trim();
    // Accumulate consecutive comment lines instead of overwriting so that
    // e.g. "# --- Voice 2 ---\n# Slow, sustained..." both survive.
    if (trimmed.startsWith('#')) {
      pendingComment = pendingComment ? pendingComment + '\n' + trimmed : trimmed;
      continue;
    }

    const noteRegex = /\[\s*P:\s*([\d.]+)\s*,\s*V:\s*(\d+)\s*,\s*T:\s*([\d.]+)\s*,\s*D:\s*([\d.]+)\s*\]/g;
    let m;
    let found = false;
    const firstNoteIdx = results.length; // index of first note pushed on this line
    while ((m = noteRegex.exec(trimmed)) !== null) {
      results.push({
        event: { p: parseFloat(m[1]), v: parseInt(m[2]), t: parseFloat(m[3]), d: parseFloat(m[4]) },
        comment: found ? undefined : pendingComment,
      });
      pendingComment = undefined;
      found = true;
    }

    // Capture inline trailing comment, e.g. `[P:45,...] # A2 — Am root`
    if (found) {
      const inlineMatch = trimmed.match(/\]\s*(#.+)$/);
      if (inlineMatch) {
        const first = results[firstNoteIdx];
        const inline = inlineMatch[1].trim();
        first.comment = first.comment ? first.comment + '\n' + inline : inline;
      }
    }
  }

  // Any remaining pendingComment had no following note in this section —
  // return it so the caller can transfer it to the next block.
  return { events: results, trailingComment: pendingComment };
};

/**
 * Removes the given event IDs from the event list while keeping structural
 * comments intact. A comment attached to a deleted event is transferred to
 * the nearest surviving event on the same track (successor preferred,
 * predecessor as fallback). This ensures that section labels like
 * "# Bar 1: Fmaj9" survive even when every note in the bar is deleted.
 */
function deleteEventsPreservingComments(
  allEvents: AppEvent[],
  idsToDelete: ReadonlySet<string>
): AppEvent[] {
  // Work in beat order so successor/predecessor lookups are straightforward
  const sorted = [...allEvents].sort(
    (a, b) => (a.beatOffset + a.event.t) - (b.beatOffset + b.event.t)
  );

  // Map: targetId → extra comment string to prepend onto that event
  const transfers = new Map<string, string>();

  for (const ev of sorted) {
    if (!idsToDelete.has(ev.id) || !ev.comment) continue;
    const beat = ev.beatOffset + ev.event.t;

    // Prefer the nearest surviving event at-or-after this beat on the same track
    let target = sorted.find(
      o => !idsToDelete.has(o.id) && o.trackId === ev.trackId &&
           (o.beatOffset + o.event.t) >= beat
    );
    // Fall back to the nearest surviving event before this beat on the same track
    if (!target) {
      for (let i = sorted.length - 1; i >= 0; i--) {
        const o = sorted[i];
        if (!idsToDelete.has(o.id) && o.trackId === ev.trackId) { target = o; break; }
      }
    }
    if (!target) continue; // entire track deleted — comment is gone

    const prev = transfers.get(target.id);
    transfers.set(target.id, prev ? prev + '\n' + ev.comment : ev.comment);
  }

  return allEvents
    .filter(ev => !idsToDelete.has(ev.id))
    .map(ev => {
      const extra = transfers.get(ev.id);
      if (!extra) return ev;
      return { ...ev, comment: ev.comment ? extra + '\n' + ev.comment : extra };
    });
}

/**
 * Split `input` into voice blocks. Returns one VoiceBlock per [voice:N ...]
 * header found. Falls back to a single block at voiceIndex 0 if none found.
 */
const parseVoiceBlocks = (input: string): VoiceBlock[] => {
  // Regex matches the entire [voice:N …] token so we can split by it
  const headerRegex = /\[voice:(\d+)([^\]]*)\]/g;

  const headerMatches: { voiceIndex: number; params: string; pos: number; len: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = headerRegex.exec(input)) !== null) {
    headerMatches.push({
      voiceIndex: parseInt(m[1]) - 1, // 1-based → 0-based
      params: m[2],
      pos: m.index,
      len: m[0].length,
    });
  }

  // No headers → legacy flat format: one block, track 0
  if (headerMatches.length === 0) {
    const { events } = parseNoteEvents(input);
    return events.length > 0 ? [{ voiceIndex: 0, synthOverride: null, events }] : [];
  }

  // Any text before the first [voice:N] header may contain file-level
  // comments (title, key, tempo notes). Capture them and prepend to the
  // first event of the first block so they survive the round-trip.
  const preamble = input.slice(0, headerMatches[0].pos);
  const preambleComments = preamble
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('#'))
    .join('\n');

  // Carry inter-block comments forward: comment lines orphaned at the end of
  // one block's section (they appear before the next [voice:N] header in the
  // source, so the slice puts them in the previous block) are transferred to
  // the first event of the next block so nothing is silently dropped.
  let carryoverComment: string | undefined;
  const blocks = headerMatches.map((header, i) => {
    const sectionStart = header.pos + header.len;
    const sectionEnd = i + 1 < headerMatches.length ? headerMatches[i + 1].pos : input.length;
    const section = input.slice(sectionStart, sectionEnd);
    const { events, trailingComment } = parseNoteEvents(section);

    // Prepend comment carried over from the previous block, if any
    if (carryoverComment && events.length > 0) {
      const first = events[0];
      events[0] = { ...first, comment: first.comment ? carryoverComment + '\n' + first.comment : carryoverComment };
    }
    carryoverComment = trailingComment;

    return {
      voiceIndex: header.voiceIndex,
      synthOverride: parseSynthParams(header.params),
      events,
    };
  }).filter(b => b.events.length > 0);

  // Attach preamble comments to the first event of the first block
  if (preambleComments && blocks[0]?.events.length > 0) {
    const first = blocks[0].events[0];
    blocks[0].events[0] = {
      ...first,
      comment: first.comment ? preambleComments + '\n' + first.comment : preambleComments,
    };
  }

  return blocks;
};

const App: React.FC = () => {
  const navigate = useNavigate();
  const [apiKey, setApiKey] = useState(localStorage.getItem('gemini_api_key') || '');
  useEffect(() => {
    localStorage.setItem('gemini_api_key', apiKey);
  }, [apiKey]);

  const [state, setState] = useState<CompositionState>({
    isPlaying: false,
    tempo: 124,
    genre: MusicGenre.CYBERPUNK,
    isGenerating: false,
    minPitch: 36,
    maxPitch: 84,
    legatoMode: false
  });

  // ---------------------------------------------------------------------------
  // Multi-track state — the source of truth for all voice / synth configuration.
  // ---------------------------------------------------------------------------
  const [tracks, setTracks] = useState<Track[]>([
    createDefaultTrack('track-1', 'Track 1', TRACK_COLORS[0]),
  ]);
  /** ID of the track whose synth panel is shown in the Voice tab */
  const [activeTrackId, setActiveTrackId] = useState<string>('track-1');
  /** ID of the track that performance pad recordings are written to */
  const [recordingTrackId, setRecordingTrackId] = useState<string>('track-1');

  const [playbackBeat, setPlaybackBeat] = useState(0);
  const [isPaused, setIsPaused] = useState(true);
  const [events, setEvents] = useState<AppEvent[]>([]);
  const [rawStream, setRawStream] = useState("");
  const [isWarmingUp, setIsWarmingUp] = useState(false);
  const [userInput, setUserInput] = useState("");
  const [creativeDirection, setCreativeDirection] = useState("");
  const [rightPanelTab, setRightPanelTab] = useState<'session' | 'synth'>('session');
  const [mainTab, setMainTab] = useState<'sequencer' | 'performance'>('performance');

  const [tempBpm, setTempBpm] = useState("124");
  const [testNote, setTestNote] = useState<MidiEvent>({ p: 60, v: 100, t: 0, d: 0.5 });
  const [voicePanelOpen, setVoicePanelOpen] = useState({ basic: true, advanced: false });

  const [selectedEventIds, setSelectedEventIds] = useState<string[]>([]);
  const [selectionMarquee, setSelectionMarquee] = useState<SelectionBounds | null>(null);
  const [clipboard, setClipboard] = useState<{ event: MidiEvent; relativeBeat: number; trackId: string; comment?: string }[]>([]);

  const [history, setHistory] = useState<{ past: typeof events[], future: typeof events[] }>({ past: [], future: [] });

  const [isAIStreamActive, setIsAIStreamActive] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [notice, setNotice] = useState<AppNotice | null>(null);
  const [colorScheme, setColorScheme] = useState<NcThemeId>(
    () => (typeof localStorage !== 'undefined' ? localStorage.getItem('nc-theme') as NcThemeId : null) || 'void'
  );
  useEffect(() => { localStorage.setItem('nc-theme', colorScheme); }, [colorScheme]);
  const currentTheme = NC_THEMES.find(th => th.id === colorScheme) ?? NC_THEMES[0];
  const t = currentTheme.tokens;
  const themeVars = {
    '--nc-bg': t.bg,
    '--nc-hdr': t.hdr,
    '--nc-toolbar': t.toolbar,
    '--nc-panel': t.panel,
    '--nc-card': t.card,
    '--nc-card-deep': t.cardDeep,
    '--nc-inset': t.inset,
    '--nc-input-bg': t.inputBg,
    '--nc-input-text': t.inputText,
    '--nc-input-ph': t.inputPH,
    '--nc-pad-bg': t.padBg,
    '--nc-glass-bg': t.glassBg,
    '--nc-glass-border': t.glassBorder,
    '--nc-glass-text': t.glassText,
    '--nc-sticky-bg': t.stickyBg,
    '--nc-sample-btn': t.sampleBtn,
    '--nc-sample-btn-hov': t.sampleBtnHov,
    '--nc-sample-btn-text': t.sampleBtnText,
    '--nc-sample-btn-hov-text': t.sampleBtnHovText,
    '--nc-t1': t.t1,
    '--nc-t2': t.t2,
    '--nc-t3': t.t3,
    '--nc-t4': t.t4,
    '--nc-axis': t.axisLabel,
    '--nc-b0': t.b0,
    '--nc-b1': t.b1,
    '--nc-b2': t.b2,
    '--nc-b3': t.b3,
    '--nc-tint': t.tint,
    '--nc-indigo': t.indigo,
    '--nc-emerald': t.emerald,
    '--nc-cyan': t.cyan,
    '--nc-red': t.red,
  } as React.CSSProperties;
  const noticeAccent = notice?.kind === 'error'
    ? t.red
    : notice?.kind === 'success'
      ? t.emerald
      : t.indigo;
  const [beatWidth, setBeatWidth] = useState(100);
  // trackHeight is a percentage of the scroll-container viewport (100% = fills it).
  // trackHeights stores per-track overrides as the same unit.
  const [trackHeight, setTrackHeight] = useState(100);
  const [trackHeights, setTrackHeights] = useState<Record<string, number>>({});
  const clampTrackHeight = (v: number) => Math.max(10, Math.min(300, v));
  const trackResizeDragRef = useRef<{ trackId: string; startY: number; startHeightPct: number } | null>(null);
  const containerHeightRef = useRef(400); // live pixel height of the scroll container
  const trackScrollContainerRef = useRef<HTMLDivElement>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  // Detect touch/coarse-pointer device to show the Select Mode button
  const isTouchDevice = useMemo(() => typeof window !== 'undefined' && (navigator.maxTouchPoints > 0 || window.matchMedia('(pointer: coarse)').matches), []);
  const clampBeatWidth = (v: number) => Math.max(20, Math.min(600, v));

  const showNotice = useCallback((kind: AppNotice['kind'], message: string) => {
    setNotice({ kind, message });
  }, []);

  useEffect(() => {
    const body = document.body;
    body.dataset.theme = colorScheme;
    body.style.backgroundColor = '';
    body.style.color = '';

    Object.entries(themeVars).forEach(([key, value]) => {
      body.style.setProperty(key, String(value));
    });
  }, [colorScheme, t, themeVars]);

  // Keep containerHeightRef in sync with the scroll container's rendered size
  // so the drag-resize math always converts pixels → % correctly.
  useEffect(() => {
    const el = trackScrollContainerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      containerHeightRef.current = entries[0].contentRect.height || 400;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Scroll the active track lane into view whenever it changes,
  // or when switching to the sequencer tab (the container is hidden while on the
  // performance tab, so scrollIntoView is a no-op until the tab is visible).
  useEffect(() => {
    if (mainTab !== 'sequencer') return;
    const container = trackScrollContainerRef.current;
    if (!container) return;
    const lane = container.querySelector<HTMLElement>(`[data-trackid="${activeTrackId}"]`);
    lane?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [activeTrackId, mainTab]);

  // Per-track drag resize — wired to window so fast mouse moves don't drop
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const drag = trackResizeDragRef.current;
      if (!drag) return;
      const deltaPct = (e.clientY - drag.startY) / containerHeightRef.current * 100;
      const newPct = clampTrackHeight(drag.startHeightPct + deltaPct);
      setTrackHeights(prev => ({ ...prev, [drag.trackId]: newPct }));
    };
    const onUp = () => { trackResizeDragRef.current = null; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);
  const recordingStartBeatRef = useRef(0);
  const beatsGeneratedRef = useRef(0);
  const isGeneratingRef = useRef(false);
  const streamBufferRef = useRef("");
  const playbackBeatRef = useRef(0);
  const isPausedRef = useRef(true);
  const lastUpdateRef = useRef(performance.now());
  const scheduledNoteIds = useRef(new Set<string>());
  const queueThreshold = 12;

  // Use Vite's glob import to load all .txt files from the samples directory
  // eager: true loads the content immediately. as: 'raw' gives us the string content.
  const sampleModules = import.meta.glob('./samples/*.txt', { query: '?raw', import: 'default', eager: true });

  // Create an array of file names (stripped of path)
  const SAMPLE_FILES = Object.keys(sampleModules).map(path => path.split('/').pop() || path);

  const loadSample = (filename: string) => {
    // Reconstruct the path key to find the content
    const pathKey = `./samples/${filename}`;
    // @ts-ignore
    const content = sampleModules[pathKey];

    if (content) {
      setUserInput(content as string);
    } else {
      console.error('Sample not found:', filename);
      showNotice('error', 'Could not load that sample. Try another file.');
    }
  };

  const validation = useMemo(() => {
    const errors: ValidationError[] = [];
    const validEvents: { event: MidiEvent; comment?: string }[] = [];
    if (!userInput.trim()) return { errors, validEvents };
    const lines = userInput.split('\n');
    let pendingComments: string[] = [];

    lines.forEach((line, lineIndex) => {
      const trimmedLine = line.trim();
      if (trimmedLine.startsWith('#')) {
        pendingComments.push(trimmedLine);
        return;
      }
      if (!trimmedLine) return;

      // Strip voice-block headers — they are valid syntax, not note packets
      const codePart = line.split('#')[0].replace(/\[voice:\d+[^\]]*\]/g, '').trim();
      if (!codePart) return; // line was only a voice header or comment

      const packetRegex = /\[[^\]]*\]?/g;
      let match;
      let hasEventsOnLine = false;
      let foundPacket = false;

      while ((match = packetRegex.exec(codePart)) !== null) {
        foundPacket = true;
        const pair = match[0];
        const fullMatch = pair.match(/\[\s*P:\s*([\d.]+)\s*,\s*V:\s*(\d+)\s*,\s*T:\s*([\d.]+)\s*,\s*D:\s*([\d.]+)\s*\]/);
        if (!fullMatch) {
          if (!pair.endsWith(']')) errors.push({ message: `Line ${lineIndex + 1}: Missing bracket ']'`, index: lineIndex });
          else errors.push({ message: `Line ${lineIndex + 1}: Invalid format`, index: lineIndex });
        } else {
          const p = parseFloat(fullMatch[1]);
          const v = parseInt(fullMatch[2]);
          const t = parseFloat(fullMatch[3]);
          const d = parseFloat(fullMatch[4]);
          if (p < 0 || p > 127) {
            errors.push({ message: `Line ${lineIndex + 1}: P 0-127`, index: lineIndex });
          } else if (v < 0 || v > 127) {
            errors.push({ message: `Line ${lineIndex + 1}: V 0-127`, index: lineIndex });
          } else {
            const evt: { event: MidiEvent; comment?: string } = { event: { p, v, t, d } };
            if (!hasEventsOnLine && pendingComments.length > 0) {
               evt.comment = pendingComments.join('\n');
               pendingComments = [];
            }
            validEvents.push(evt);
            hasEventsOnLine = true;
          }
        }
      }

      if (!foundPacket) {
        errors.push({ message: `Line ${lineIndex + 1}: No events found`, index: lineIndex });
      }
    });
    return { errors, validEvents };
  }, [userInput]);

  // Keep the audio engine's "default" config in sync with the active track so
  // the performance pad always uses that track's sound.
  const activeTrack = tracks.find(t => t.id === activeTrackId) ?? tracks[0];
  useEffect(() => {
    audioEngine.updateConfig(activeTrack.synthConfig);
  }, [activeTrack.synthConfig]);

  useEffect(() => {
    setTempBpm(state.tempo.toString());
  }, [state.tempo]);

  const updateBpm = (newBpm: number) => {
    const clamped = Math.max(20, Math.min(300, newBpm));
    setState(s => ({ ...s, tempo: clamped }));
    audioEngine.setTempo(clamped);
    setTempBpm(clamped.toString());
  };

  const pushHistory = useCallback((currentEvents: typeof events) => {
    setHistory(curr => ({
      past: [...curr.past, currentEvents].slice(-20),
      future: []
    }));
  }, []);

  const undo = useCallback(() => {
    setHistory(curr => {
      if (curr.past.length === 0) return curr;
      const previous = curr.past[curr.past.length - 1];
      setEvents(previous);
      return { past: curr.past.slice(0, -1), future: [events, ...curr.future] };
    });
  }, [events]);

  const redo = useCallback(() => {
    setHistory(curr => {
      if (curr.future.length === 0) return curr;
      const next = curr.future[0];
      setEvents(next);
      // Select notes that were added back by this redo (present in next but not in current)
      const currentIds = new Set(events.map(e => e.id));
      const restoredIds = next.filter(e => !currentIds.has(e.id)).map(e => e.id);
      if (restoredIds.length > 0) setSelectedEventIds(restoredIds);
      return { past: [...curr.past, events], future: curr.future.slice(1) };
    });
  }, [events]);

  /**
   * Receives events recorded from the performance pad and appends them to the
   * sequencer, starting right after the last existing note. Also switches to
   * the sequencer tab so the result is immediately visible.
   */
  const handleCommitRecording = useCallback((recordedEvents: MidiEvent[]) => {
    const stamp = Date.now();
    const newIds = recordedEvents.map((_, i) => `recorded-${stamp}-${i}`);
    const baseOffset = recordingStartBeatRef.current;
    setEvents(prev => {
      pushHistory(prev);
      return [
        ...prev,
        ...recordedEvents.map((evt, i) => ({
          event: evt,
          beatOffset: baseOffset,
          id: newIds[i],
          trackId: recordingTrackId,
          isUser: true as const,
        })),
      ];
    });
    setSelectedEventIds(newIds);
    setMainTab('sequencer');
  }, [pushHistory, recordingTrackId]);

  const generateNextStream = async () => {
    if (!isAIStreamActive || isGeneratingRef.current) return;
    if (!apiKey) {
      setIsAIStreamActive(false);
      showNotice('info', 'Enter a Gemini API key in Session before starting AI generation.');
      return;
    }
    pushHistory(events);
    isGeneratingRef.current = true;
    setState(s => ({ ...s, isGenerating: true }));
    const startOffset = beatsGeneratedRef.current;
    beatsGeneratedRef.current += 8;

    let success = false;
    try {
      const generator = composer.streamComposition(apiKey, state.genre as MusicGenre, state.tempo, events, startOffset, creativeDirection);
      for await (const chunk of generator) {
        parseAndStore(chunk, startOffset);
      }
      success = true;
    } catch (e) {
      console.error("Stream failed", e);
      beatsGeneratedRef.current -= 8;
      // Stop AI immediately
      setIsAIStreamActive(false);
      showNotice('error', `AI generation stopped: ${e instanceof Error ? e.message : 'Unknown error'}. Check your API key and try again.`);
      // Note: We leave isGeneratingRef.current = true to prevent re-entry
      // by the animation loop until the component state updates fully.
    } finally {
      if (success) {
         isGeneratingRef.current = false;
      }
      setState(s => ({ ...s, isGenerating: false }));
    }
  };

  useEffect(() => {
    let animationId: number;
    const tick = () => {
      const now = performance.now();
      const delta = (now - lastUpdateRef.current) / 1000;
      lastUpdateRef.current = now;

      // TRIGGER FOR GENERATION (Moved outside play state condition)
      const remainingInQueue = beatsGeneratedRef.current - playbackBeatRef.current;
      if (isAIStreamActive && remainingInQueue < queueThreshold && !isGeneratingRef.current) {
        generateNextStream();
      }

      if (state.isPlaying && !isPausedRef.current) {
        const bps = state.tempo / 60;
        playbackBeatRef.current += delta * bps;
        setPlaybackBeat(playbackBeatRef.current);
        const currentBeat = playbackBeatRef.current;

        // Build a fast lookup so each note can find its track config in O(1)
        const trackMap = new Map<string, Track>(tracks.map(t => [t.id, t]));

        events.forEach(item => {
          const absoluteStart = item.beatOffset + item.event.t;
          if (absoluteStart >= currentBeat - 0.2 && absoluteStart < currentBeat + 0.5) {
            if (!scheduledNoteIds.current.has(item.id)) {
              const track = trackMap.get(item.trackId);
              if (!track || !track.muted) {
                audioEngine.scheduleNote(
                  item.event,
                  absoluteStart,
                  currentBeat,
                  state.legatoMode,
                  track?.synthConfig,
                  track?.volume ?? 1,
                );
              }
              scheduledNoteIds.current.add(item.id);
            }
          }
        });
      }
      animationId = requestAnimationFrame(tick);
    };
    animationId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animationId);
  }, [state.isPlaying, events, tracks, state.tempo, state.legatoMode, isAIStreamActive]);

  const parseAndStore = (textChunk: string, baseBeatOffset: number) => {
    streamBufferRef.current += textChunk;
    setRawStream(prev => (prev + textChunk).slice(-800));
    const regex = /\[\s*P:\s*([\d.]+)\s*,\s*V:\s*(\d+)\s*,\s*T:\s*([\d.]+)\s*,\s*D:\s*([\d.]+)\s*\]/g;
    let match;
    const newMidiEvents: AppEvent[] = [];
    // AI generates into whichever track is currently active
    const aiTrackId = activeTrackId;
    while ((match = regex.exec(streamBufferRef.current)) !== null) {
      const event: MidiEvent = { p: parseFloat(match[1]), v: parseInt(match[2]), t: parseFloat(match[3]), d: parseFloat(match[4]) };
      newMidiEvents.push({ event, beatOffset: baseBeatOffset, id: `note-${baseBeatOffset}-${match.index}-${event.p}`, trackId: aiTrackId });
    }
    if (newMidiEvents.length > 0) {
      streamBufferRef.current = streamBufferRef.current.replace(/\[\s*P:\s*[\d.]+\s*,\s*V:\s*\d+\s*,\s*T:\s*[\d.]+\s*,\s*D:\s*[\d.]+\s*\]/g, "");
      setEvents(prev => [...prev, ...newMidiEvents]);
    }
  };

  const handleInitializeAI = async () => {
    if (!apiKey.trim()) {
      showNotice('info', 'Enter a Gemini API key in Session before starting AI generation.');
      return;
    }

    audioEngine.init();
    audioEngine.setTempo(state.tempo);
    audioEngine.updateConfig(activeTrack.synthConfig);
    beatsGeneratedRef.current = 0;
    playbackBeatRef.current = 0;
    scheduledNoteIds.current.clear();
    streamBufferRef.current = "";
    isGeneratingRef.current = false; // Reset generator lock
    setHistory({ past: [], future: [] });
    setPlaybackBeat(0);
    setEvents([]);
    setSelectedEventIds([]);
    setRawStream("");

    // AI Specific State
    setIsAIStreamActive(true);
    setIsWarmingUp(true);

    // Auto-start playback for AI session
    isPausedRef.current = false;
    setIsPaused(false);
    setState(s => ({ ...s, isPlaying: true }));
    setTimeout(() => setIsWarmingUp(false), 2000);
  };

  const handleSeek = (beat: number) => {
    playbackBeatRef.current = Math.max(0, beat);
    setPlaybackBeat(playbackBeatRef.current);
    scheduledNoteIds.current.clear();
  };

  const handleInjectUserNotes = () => {
    if (validation.validEvents.length === 0 || validation.errors.length > 0) return;
    pushHistory(events);
    const baseOffset = playbackBeatRef.current;
    const blocks = parseVoiceBlocks(userInput);
    const stamp = Date.now();
    let globalIdx = 0;

    // Build a mutable copy of tracks so we can auto-create or patch configs
    let updatedTracks = [...tracks];
    const newEvents: AppEvent[] = [];

    blocks.forEach(({ voiceIndex, synthOverride, events: blockEvents }) => {
      // Auto-create tracks if the voice index exceeds what we have
      while (updatedTracks.length <= voiceIndex) {
        const idx = updatedTracks.length;
        const color = TRACK_COLORS[idx % TRACK_COLORS.length];
        updatedTracks.push(createDefaultTrack(`track-${stamp}-${idx}`, `Track ${idx + 1}`, color));
      }

      let track = updatedTracks[voiceIndex];
      // Apply synth overrides declared in the voice header
      if (synthOverride) {
        // Apply the override onto a clean default config rather than the existing
        // track config. This means no field from the previous voice leaks through —
        // optional fields (or any field) absent from the override revert to the
        // default instead of inheriting the old value.
        const cleanBase = { ...SYNTH_PRESETS[DEFAULT_PRESET] };
        track = { ...track, synthConfig: { ...cleanBase, ...synthOverride } };
        updatedTracks[voiceIndex] = track;
      }

      blockEvents.forEach(item => {
        newEvents.push({
          event: item.event,
          beatOffset: baseOffset,
          id: `user-${stamp}-${globalIdx++}`,
          trackId: track.id,
          isUser: true,
          comment: item.comment,
        });
      });
    });

    setTracks(updatedTracks);
    setEvents(prev => [...prev, ...newEvents]);
    setUserInput("");
  };

  const handleExportWav = async () => {
    if (events.length === 0 || isExporting) return;
    setIsExporting(true);
    try {
      const trackMap = new Map<string, Track>(tracks.map(t => [t.id, t]));
      const renderEvents = events
        .filter(e => !(trackMap.get(e.trackId)?.muted))
        .map(e => ({
          ...e,
          synthConfig: trackMap.get(e.trackId)?.synthConfig,
          trackVolume: trackMap.get(e.trackId)?.volume ?? 1,
        }));
      const blob = await audioEngine.renderToWav(renderEvents, state.tempo, state.legatoMode);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `neural-composer-${Date.now()}.wav`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error('WAV export failed', e);
      showNotice('error', `WAV export failed: ${e instanceof Error ? e.message : 'Unknown error'}`);
    } finally {
      setIsExporting(false);
    }
  };

  const handleDownload = () => {
    const sortedEvents = [...events].sort((a, b) => (a.beatOffset + a.event.t) - (b.beatOffset + b.event.t));
    let output = `# Neural Composer Export\n# Genre: ${state.genre}\n# Tempo: ${state.tempo}\n# Date: ${new Date().toLocaleString()}\n`;

    // Emit one voice block per track, each with their synth config, then their notes.
    tracks.forEach((track, idx) => {
      const trackEvents = sortedEvents.filter(e => e.trackId === track.id);
      if (trackEvents.length === 0) return;
      output += `\n[voice:${idx + 1} name:"${track.name}" ${serializeSynthConfig(track.synthConfig)}]\n`;
      trackEvents.forEach(e => {
        if (e.comment) output += `\n${e.comment}\n`;
        output += `[P:${e.event.p},V:${e.event.v},T:${(e.beatOffset + e.event.t).toFixed(3)},D:${e.event.d.toFixed(3)}]\n`;
      });
    });

    const blob = new Blob([output], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `neural-composer-export-${Date.now()}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleCopy = useCallback(() => {
    if (selectedEventIds.length === 0) return;
    let minBeat = Infinity;
    const selectedEvents = events.filter(e => {
      const isSelected = selectedEventIds.includes(e.id);
      if (isSelected) {
        const absStart = e.beatOffset + e.event.t;
        if (absStart < minBeat) minBeat = absStart;
      }
      return isSelected;
    });
    const clipboardData = selectedEvents.map(item => ({
      event: { ...item.event },
      relativeBeat: (item.beatOffset + item.event.t) - minBeat,
      trackId: item.trackId,
      comment: item.comment
    }));
    setClipboard(clipboardData);

    // Build clipboard text with voice block headers so pasting into the
    // Manual Patch Bay textarea preserves per-track routing.
    const byTrack = new Map<string, typeof clipboardData>();
    clipboardData.forEach(item => {
      if (!byTrack.has(item.trackId)) byTrack.set(item.trackId, []);
      byTrack.get(item.trackId)!.push(item);
    });
    let clipboardText = '';
    byTrack.forEach((items, tid) => {
      const trackIdx = tracks.findIndex(t => t.id === tid);
      const track = tracks[trackIdx];
      if (track) {
        clipboardText += `[voice:${trackIdx + 1} name:"${track.name}" ${serializeSynthConfig(track.synthConfig)}]\n`;
      }
      items.forEach(item => {
        if (item.comment) clipboardText += `${item.comment}\n`;
        clipboardText += `[P:${item.event.p},V:${item.event.v},T:${item.relativeBeat.toFixed(3)},D:${item.event.d.toFixed(3)}]\n`;
      });
      clipboardText += '\n';
    });
    navigator.clipboard?.writeText(clipboardText.trim()).catch(err => {
      console.error(err);
      showNotice('error', 'Could not copy the selection to the clipboard.');
    });
  }, [selectedEventIds, events, showNotice]);

  const handleCut = useCallback(() => {
    if (selectedEventIds.length === 0) return;
    pushHistory(events);
    handleCopy();
    setEvents(prev => deleteEventsPreservingComments(prev, new Set(selectedEventIds)));
    setSelectedEventIds([]);
  }, [selectedEventIds, events, handleCopy, pushHistory]);

  const handlePaste = useCallback(() => {
    if (clipboard.length === 0) return;
    pushHistory(events);
    const pasteBaseBeat = playbackBeatRef.current;
    const newEvents = clipboard.map((item, idx) => ({
      event: { ...item.event, t: item.relativeBeat },
      beatOffset: pasteBaseBeat,
      id: `paste-${pasteBaseBeat}-${idx}-${Date.now()}`,
      trackId: item.trackId,
      isUser: true,
      comment: item.comment
    }));
    setEvents(prev => [...prev, ...newEvents]);
    setSelectedEventIds(newEvents.map(e => e.id));
  }, [clipboard, events, pushHistory]);

  const handleDelete = useCallback(() => {
    if (selectedEventIds.length === 0) return;
    pushHistory(events);
    setEvents(prev => deleteEventsPreservingComments(prev, new Set(selectedEventIds)));
    setSelectedEventIds([]);
  }, [selectedEventIds, events, pushHistory]);

  const handleSelectAll = useCallback(() => {
    setSelectedEventIds(events.map(e => e.id));
  }, [events]);

  // ---------------------------------------------------------------------------
  // Patch-bay signal transforms.
  // Each transform operates on the raw userInput text: it parses every
  // [P:...,V:...,T:...,D:...] packet in order, applies the transform to the
  // array of MidiEvents, then splices the new values back in-place so that
  // comments and line structure are preserved.
  // ---------------------------------------------------------------------------
  const transformPatchBay = useCallback((fn: (evts: MidiEvent[]) => MidiEvent[]) => {
    const regex = /\[\s*P:\s*([\d.]+)\s*,\s*V:\s*(\d+)\s*,\s*T:\s*([\d.]+)\s*,\s*D:\s*([\d.]+)\s*\]/g;
    const parsed: MidiEvent[] = [];
    let m: RegExpExecArray | null;
    const src = userInput;
    while ((m = regex.exec(src)) !== null)
      parsed.push({ p: parseFloat(m[1]), v: parseInt(m[2]), t: parseFloat(m[3]), d: parseFloat(m[4]) });
    if (parsed.length === 0) return;
    const transformed = fn(parsed);
    let i = 0;
    setUserInput(src.replace(
      /\[\s*P:\s*[\d.]+\s*,\s*V:\s*\d+\s*,\s*T:\s*[\d.]+\s*,\s*D:\s*[\d.]+\s*\]/g,
      () => {
        const e = transformed[i++];
        const p = Math.round(Math.max(0, Math.min(127, e.p)));
        const v = Math.round(Math.max(0, Math.min(127, e.v)));
        return `[P:${p},V:${v},T:${e.t.toFixed(3)},D:${e.d.toFixed(3)}]`;
      }
    ));
  }, [userInput]);

  const patchTransforms = useMemo(() => ({
    reverseTime: () => transformPatchBay(evts => {
      const maxEnd = Math.max(...evts.map(e => e.t + e.d));
      return evts.map(e => ({ ...e, t: Math.max(0, maxEnd - e.t - e.d) }));
    }),
    invertPitch: () => transformPatchBay(evts => {
      const ps = evts.map(e => e.p);
      const lo = Math.min(...ps), hi = Math.max(...ps);
      return evts.map(e => ({ ...e, p: lo + hi - e.p }));
    }),
    transpose: (delta: number) => transformPatchBay(evts =>
      evts.map(e => ({ ...e, p: e.p + delta }))
    ),
    widenPitch: (factor: number) => transformPatchBay(evts => {
      const ps = evts.map(e => e.p);
      const center = (Math.min(...ps) + Math.max(...ps)) / 2;
      return evts.map(e => ({ ...e, p: center + (e.p - center) * factor }));
    }),
    normalizeVelocity: () => transformPatchBay(evts => {
      const vs = evts.map(e => e.v);
      const lo = Math.min(...vs), hi = Math.max(...vs);
      if (hi === lo) return evts.map(e => ({ ...e, v: 90 }));
      return evts.map(e => ({ ...e, v: 10 + ((e.v - lo) / (hi - lo)) * 110 }));
    }),
    volShift: (delta: number) => transformPatchBay(evts =>
      evts.map(e => ({ ...e, v: e.v + delta }))
    ),
    stretchTime: (factor: number) => transformPatchBay(evts =>
      evts.map(e => ({ ...e, t: e.t * factor, d: Math.max(0.05, e.d * factor) }))
    ),
    quantize: (grid: number) => transformPatchBay(evts =>
      evts.map(e => ({ ...e, t: Math.round(e.t / grid) * grid, d: Math.max(grid, Math.round(e.d / grid) * grid) }))
    ),
  }), [transformPatchBay]);

  const handleMoveSelection = (deltaBeat: number, deltaPitch: number, ids: string[]) => {
    if (ids.length === 0) return;
    pushHistory(events);
    setEvents(prev => prev.map(item => ids.includes(item.id) ? {
      ...item,
      beatOffset: item.beatOffset + deltaBeat,
      event: { ...item.event, p: Math.max(0, Math.min(127, item.event.p + Math.round(deltaPitch))) },
      isUser: true
    } : item));
  };

  const togglePlayback = useCallback(() => {
    audioEngine.init();
    if (!state.isPlaying) {
      // Manual start without AI
      setState(s => ({ ...s, isPlaying: true }));
      isPausedRef.current = false;
      setIsPaused(false);
    } else {
      // Toggle pause/play
      isPausedRef.current = !isPausedRef.current;
      setIsPaused(isPausedRef.current);
      // Do NOT clear scheduledNoteIds here: notes that were already pre-scheduled
      // in the WebAudio buffer would be re-scheduled on the next tick, playing twice.
    }
  }, [state.isPlaying]);

  const handleHardStop = () => {
    setIsAIStreamActive(false);
    isGeneratingRef.current = false;
    audioEngine.stopAll();
    beatsGeneratedRef.current = 0;
    playbackBeatRef.current = 0;
    scheduledNoteIds.current.clear();
    isPausedRef.current = true;
    setIsPaused(true);
    setPlaybackBeat(0);
    setEvents([]);
    setSelectedEventIds([]);
    setRawStream("");
    setState(s => ({ ...s, isPlaying: false, isGenerating: false }));
    const defaultTrack = createDefaultTrack('track-1', 'Track 1', TRACK_COLORS[0]);
    setTracks([defaultTrack]);
    setActiveTrackId('track-1');
    setRecordingTrackId('track-1');
  };

  const handleTestNote = () => {
    audioEngine.init();
    audioEngine.updateConfig(activeTrack.synthConfig);
    audioEngine.scheduleNote(testNote, 0, 0);
  };

  const bufferRemaining = Math.max(0, beatsGeneratedRef.current - playbackBeat);
  const totalViewRange = Math.max(beatsGeneratedRef.current, playbackBeat + 32, 128);

  /** Update a single synth param on the currently-active track. */
  const updateSynth = (key: keyof SynthConfig, val: any) => {
    setTracks(prev => prev.map(t =>
      t.id === activeTrackId ? { ...t, synthConfig: { ...t.synthConfig, [key]: val } } : t
    ));
  };

  /** Apply a full SynthConfig preset to the currently-active track. */
  const applyPresetToActiveTrack = (config: SynthConfig) => {
    setTracks(prev => prev.map(t =>
      t.id === activeTrackId ? { ...t, synthConfig: { ...config } } : t
    ));
  };

  // ---------------------------------------------------------------------------
  // Track management
  // ---------------------------------------------------------------------------
  const addTrack = () => {
    const id = `track-${Date.now()}`;
    const color = TRACK_COLORS[tracks.length % TRACK_COLORS.length];
    setTracks(prev => [...prev, createDefaultTrack(id, `Track ${prev.length + 1}`, color)]);
  };

  const removeTrack = (id: string) => {
    if (tracks.length <= 1) return; // always keep at least one track
    setTracks(prev => prev.filter(t => t.id !== id));
    setEvents(prev => prev.filter(e => e.trackId !== id));
    if (activeTrackId === id) setActiveTrackId(tracks.find(t => t.id !== id)?.id ?? '');
    if (recordingTrackId === id) setRecordingTrackId(tracks.find(t => t.id !== id)?.id ?? '');
  };

  const updateTrackName = (id: string, name: string) => {
    setTracks(prev => prev.map(t => t.id === id ? { ...t, name } : t));
  };

  const toggleTrackMute = (id: string) => {
    setTracks(prev => prev.map(t => t.id === id ? { ...t, muted: !t.muted } : t));
  };

  const updateTrackVolume = (id: string, volume: number) => {
    setTracks(prev => prev.map(t => t.id === id ? { ...t, volume } : t));
  };

  // True while the mouse is inside the PerformancePad surface.
  // Transport shortcuts (0, ←, →, 1-9, M) are suppressed while the pad is
  // focused so they don't conflict with pad key bindings.
  const isMouseInPadRef = useRef(false);
  // Emacs-style mark: set by C-Space, cleared by C-g or any non-nav action.
  // While active, every navigation command selects notes in [mark, point].
  const markBeatRef = useRef<number | null>(null);

  // Keyboard Shortcuts Effect
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;

      // Prevent triggering shortcuts when typing in inputs/textareas
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;

      // Space — play/pause; C-Space is excluded so it falls through to the mark handler
      if (e.key === KB_SEQ.PLAY_PAUSE.key && !e.ctrlKey && !e.metaKey && target.tagName !== 'BUTTON') {
        e.preventDefault();
        togglePlayback();
        return;
      }

      // ── Transport & track shortcuts — suppressed while pad is focused ───
      const padFocused = isMouseInPadRef.current;
      if (padFocused) return;

      // Seek to `beat` and, if a mark is active, select all notes in the
      // half-open interval [mark, point) — emacs region semantics.
      const seekToPoint = (beat: number) => {
        handleSeek(beat);
        if (markBeatRef.current !== null) {
          const lo = Math.min(markBeatRef.current, beat);
          const hi = Math.max(markBeatRef.current, beat);
          const ids = events
            .filter(ev => {
              const start = ev.beatOffset + ev.event.t;
              return start >= lo - 0.001 && start < hi - 0.001;
            })
            .map(ev => ev.id);
          setSelectedEventIds(ids);
        }
      };

      if (e.ctrlKey || e.metaKey) {
        switch (e.key.toLowerCase()) {
          case KB_SEQ.CUT.key:        e.preventDefault(); handleCut();       break;
          case KB_SEQ.SELECT_ALL.key: if (e.metaKey || (!_IS_MAC && e.ctrlKey)) { e.preventDefault(); handleSelectAll(); } break;
          case KB_SEQ.COPY.key:       e.preventDefault(); handleCopy();      break;
          case KB_SEQ.PASTE.key:      e.preventDefault(); handlePaste();     break;
          case KB_SEQ.UNDO.key:              e.preventDefault(); if (e.shiftKey) redo(); else undo(); break;
          case KB_SEQ.REDO_ALT.key:          e.preventDefault(); redo();            break;
          case KB_SEQ.CANCEL_SELECTION.key:  e.preventDefault(); setSelectedEventIds([]); markBeatRef.current = null; break;
        }
        // ── Ctrl-only (emacs-style note navigation) ──────────────────────
        // These intentionally fire on Ctrl but NOT Cmd to keep Cmd slots free.
        if (e.ctrlKey && !e.metaKey) {
          const cur = playbackBeatRef.current;
          if (e.key === KB_SEQ.SET_MARK.key) {
            // C-Space: set mark at current playhead position
            e.preventDefault();
            markBeatRef.current = cur;
            setSelectedEventIds([]);
          } else if ((KB_SEQ.REWIND.key as readonly string[]).includes(e.key)) {
            // C-a: rewind to beginning (emacs C-a)
            e.preventDefault();
            seekToPoint(0);
          } else if (e.key === KB_SEQ.NAV_NEXT_NOTE.key) {
            // C-f: jump to the start of the next note after the playhead
            e.preventDefault();
            const nexts = events.map(ev => ev.beatOffset + ev.event.t).filter(b => b > cur + 0.001).sort((a, b) => a - b);
            if (nexts.length) seekToPoint(nexts[0]);
          } else if (e.key === KB_SEQ.NAV_PREV_NOTE.key) {
            // C-b: jump to the start of the previous note before the playhead
            e.preventDefault();
            const prevs = events.map(ev => ev.beatOffset + ev.event.t).filter(b => b < cur - 0.001).sort((a, b) => b - a);
            if (prevs.length) seekToPoint(prevs[0]);
          } else if (e.key === KB_SEQ.NAV_END_NOTE.key) {
            // C-e: jump to the end of the most-recently-started note at or before the playhead
            e.preventDefault();
            const candidate = [...events]
              .filter(ev => ev.beatOffset + ev.event.t <= cur + 0.001)
              .sort((a, b) => (b.beatOffset + b.event.t) - (a.beatOffset + a.event.t))[0];
            if (candidate) seekToPoint(candidate.beatOffset + candidate.event.t + candidate.event.d);
          } else if (e.key === KB_SEQ.KILL_TO_END.key) {
            // C-k: kill (cut) all notes from playhead to end — emacs kill-line
            e.preventDefault();
            const killBeat = playbackBeatRef.current;
            const toKill = events.filter(ev => ev.beatOffset + ev.event.t >= killBeat - 0.001);
            if (toKill.length) {
              pushHistory(events);
              const killIds = new Set<string>(toKill.map(ev => ev.id));
              // Put killed notes in clipboard (relative to killBeat)
              setClipboard(toKill.map(ev => ({
                event: { ...ev.event },
                relativeBeat: (ev.beatOffset + ev.event.t) - killBeat,
                trackId: ev.trackId,
                comment: ev.comment,
              })));
              setEvents(prev => deleteEventsPreservingComments(prev, killIds));
              setSelectedEventIds([]);
            }
          }
        }
        return;
      }

      // Delete / Backspace — always available (pad doesn't use them)
      if (e.key === KB_SEQ.DELETE.key || e.key === 'Backspace') {
        e.preventDefault();
        handleDelete();
        return;
      }

      if (e.key.toLowerCase() === KB_SEQ.INJECT.key) {
        e.preventDefault();
        handleInjectUserNotes();
        return;
      }

      // KB_SEQ.REWIND — rewind to beginning
      if ((KB_SEQ.REWIND.key as readonly string[]).includes(e.key)) {
        e.preventDefault();
        seekToPoint(0);
        return;
      }

      // KB_SEQ.PREV_BAR — back 1 measure (4 beats)
      if (e.key === KB_SEQ.PREV_BAR.key && !e.shiftKey) {
        e.preventDefault();
        seekToPoint(Math.max(0, playbackBeatRef.current - 4));
        return;
      }

      // KB_SEQ.NEXT_BAR — forward 1 measure (4 beats)
      if (e.key === KB_SEQ.NEXT_BAR.key && !e.shiftKey) {
        e.preventDefault();
        seekToPoint(playbackBeatRef.current + 4);
        return;
      }

      // KB_SEQ.MUTE_TRACK — mute/unmute active track
      if (e.key.toLowerCase() === KB_SEQ.MUTE_TRACK.key) {
        e.preventDefault();
        toggleTrackMute(activeTrackId);
        return;
      }

      // KB_SEQ.TOGGLE_TAB — toggle between sequencer and performance tab
      if (e.key.toLowerCase() === KB_SEQ.TOGGLE_TAB.key) {
        e.preventDefault();
        setMainTab(prev => prev === 'sequencer' ? 'performance' : 'sequencer');
        return;
      }

      // KB_SEQ.SELECT_TRACK — 1-9 selects track by index
      if (/^[1-9]$/.test(e.key)) {
        const idx = parseInt(e.key) - 1;
        if (idx < tracks.length) {
          const track = tracks[idx];
          setActiveTrackId(track.id);
          setRecordingTrackId(track.id);
        }
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleCut, handleCopy, handlePaste, handleDelete, handleSelectAll, handleInjectUserNotes, undo, redo, togglePlayback, activeTrackId, tracks, events]);

  const waveOptions: SynthWaveType[] = ['sine', 'square', 'sawtooth', 'triangle'];

  return (
    <div className="app-shell flex flex-col w-full min-h-screen lg:h-screen overflow-x-hidden lg:overflow-hidden font-sans selection:bg-indigo-500/30" data-theme={colorScheme} style={{
      minHeight: '100dvh',
        backgroundColor: t.bg,
        color: t.t1,
        ...themeVars,
      } as React.CSSProperties}>
      <header className="flex-none flex flex-col md:flex-row justify-between items-center gap-4 p-4 lg:p-6" style={{ backgroundColor: t.hdr, paddingTop: 'calc(1rem + env(safe-area-inset-top, 0px))' }}>
        <div className="flex items-center gap-4">
          <div className={`p-3 rounded-2xl transition-all duration-1000 ${state.isPlaying ? 'bg-indigo-600 shadow-[0_0_30px_rgba(79,70,229,0.3)]' : 'bg-slate-900'}`}>
            <Zap className={`${state.isPlaying && !isPaused ? 'text-white fill-white animate-pulse' : 'text-slate-700'}`} size={28} />
          </div>
          <div>
            <h1 className="text-3xl font-black tracking-tighter text-white uppercase italic">Neural Composer</h1>
            <div className="flex items-center gap-2">
               <span className={`w-2 h-2 rounded-full ${isAIStreamActive ? 'bg-emerald-500 animate-ping' : 'bg-slate-800'}`} />
               <p className="text-slate-500 text-[10px] font-black uppercase tracking-widest">
                 {isAIStreamActive ? 'AI Stream Active' : state.isPlaying ? 'Playback Mode' : 'Ready'}
               </p>
            </div>
          </div>
        </div>

        <div className="flex gap-3 items-center flex-wrap justify-center p-1">
          <div className="flex items-center gap-1 p-1 rounded-xl mr-2" style={{ backgroundColor: t.card }}>
             <button
               onClick={() => setMainTab('sequencer')}
               className={`px-4 py-2.5 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all ${mainTab === 'sequencer' ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/20' : 'text-slate-500 hover:text-white hover:bg-white/5'}`}
             >
               Sequencer
             </button>
             <button
               onClick={() => setMainTab('performance')}
               className={`px-4 py-2.5 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all ${mainTab === 'performance' ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-500/20' : 'text-slate-500 hover:text-white hover:bg-white/5'}`}
             >
               Perform
             </button>
          </div>

          <div className="flex items-center gap-1 border-r border-white/10 pr-2 mr-1">
            <button onClick={() => handleSeek(0)} className="p-2 hover:bg-white/10 rounded-lg text-slate-400">
              <RotateCcw size={18} />
            </button>
            <button onClick={togglePlayback} className={`p-2 rounded-lg ${isPaused ? 'bg-emerald-500/20 text-emerald-500' : 'bg-amber-500/20 text-amber-500'}`}>
              {isPaused ? <Play size={18} fill="currentColor" /> : <Pause size={18} fill="currentColor" />}
            </button>
          </div>

          <div className="flex items-center rounded-xl p-1 mr-1" style={{ backgroundColor: t.cardDeep }}>
             <div className="px-2 border-r border-white/10 flex items-center gap-2 mr-1">
                <Gauge size={14} className="text-slate-600" />
                <span className="text-[10px] font-black text-slate-600 hidden xl:inline">BPM</span>
             </div>
             <button onClick={() => updateBpm(state.tempo - 1)} className="w-6 h-8 flex items-center justify-center hover:bg-white/10 rounded-lg text-slate-500 hover:text-indigo-400"><Minus size={12} /></button>
             <input type="number" value={tempBpm} onChange={(e) => setTempBpm(e.target.value)} onBlur={() => updateBpm(parseInt(tempBpm) || 120)} className="w-10 bg-transparent text-sm font-bold text-white text-center focus:outline-none" />
             <button onClick={() => updateBpm(state.tempo + 1)} className="w-6 h-8 flex items-center justify-center hover:bg-white/10 rounded-lg text-slate-500 hover:text-indigo-400"><Plus size={12} /></button>
          </div>

          <div className="flex items-center gap-1 rounded-xl p-1" style={{ backgroundColor: t.cardDeep }}>
             <button title="Toggle Legato Mode" onClick={() => setState(s => ({ ...s, legatoMode: !s.legatoMode }))} className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-bold border transition-colors ${state.legatoMode ? 'bg-indigo-500/20 text-indigo-400 border-indigo-500/50' : 'bg-transparent text-slate-500 border-transparent hover:bg-white/5'}`}>
               <Waves size={14} /> Legato
             </button>
          </div>

          <button onClick={() => navigate('/converter')} className="flex items-center gap-1 sm:gap-2 bg-black text-xs font-bold text-cyan-400 border border-cyan-500/20 hover:bg-cyan-500/10 hover:border-cyan-500/50 rounded-xl px-3 sm:px-4 py-2.5 transition-all shadow-lg shadow-cyan-500/10">
            <Mic size={14} /> <span className="sm:hidden">MIC</span><span className="hidden sm:inline">VOICE</span>
          </button>

          {!isAIStreamActive && events.length === 0 ? (
            <button onClick={handleInitializeAI} className="px-6 py-2.5 bg-indigo-600 hover:bg-indigo-500 rounded-xl font-bold text-sm text-white shadow-xl">INITIALIZE</button>
          ) : (
            <div className="flex gap-2">
              <button onClick={() => { setIsAIStreamActive(!isAIStreamActive); }} className={`flex items-center gap-2 px-4 py-2.5 rounded-xl font-bold text-xs border ${isAIStreamActive ? 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20' : 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20'}`}>
                {isAIStreamActive ? <><Disc size={14} className="animate-spin" /> FREEZE AI</> : <><RefreshCw size={14} /> UNFREEZE AI</>}
              </button>
              <button onClick={handleHardStop} className="px-4 py-2.5 bg-red-500/10 text-red-500 border border-red-500/20 rounded-xl font-bold text-xs">RESET</button>
            </div>
          )}
          <div className="w-px h-6 bg-white/10" />
          <button
            title="Keyboard shortcuts"
            onClick={() => setShowShortcuts(true)}
            className="p-2 rounded-xl hover:bg-white/5 text-slate-500 hover:text-slate-300 transition-colors"
          >
            <HelpCircle size={18} />
          </button>
          <button
            title="Appearance settings"
            onClick={() => setShowSettings(true)}
            className="p-2 rounded-xl hover:bg-white/5 text-slate-500 hover:text-slate-300 transition-colors"
          >
            <Palette size={18} />
          </button>
        </div>
      </header>

      {notice && createPortal(
        <div
          className="fixed inset-0 z-[9998] flex items-center justify-center px-4 py-6"
          onPointerDown={() => setNotice(null)}
        >
          <div className="absolute inset-0 nc-modal-backdrop" />
          <div
            className="relative z-10 mx-auto flex w-full max-w-xl items-start justify-between gap-3 rounded-3xl border px-5 py-4 text-sm shadow-2xl"
            onPointerDown={e => e.stopPropagation()}
            style={{
              backgroundColor: `color-mix(in srgb, ${noticeAccent} 10%, ${t.cardDeep})`,
              borderColor: `color-mix(in srgb, ${noticeAccent} 28%, ${t.b2})`,
              color: t.t1,
            }}
          >
            <div className="min-w-0">
              <div
                className="mb-1 text-[10px] font-black uppercase tracking-[0.24em]"
                style={{ color: `color-mix(in srgb, ${noticeAccent} 85%, ${t.t2})` }}
              >
                {notice.kind === 'error' ? 'Notice' : notice.kind === 'success' ? 'Saved' : 'Heads Up'}
              </div>
              <div className="leading-relaxed" style={{ color: t.t1 }}>{notice.message}</div>
              <div className="mt-3 text-[11px]" style={{ color: t.t3 }}>
                Click anywhere to dismiss.
              </div>
            </div>
            <button
              onClick={() => setNotice(null)}
              className="rounded-lg p-1 transition-opacity hover:opacity-100"
              style={{ color: t.t3, opacity: 0.8 }}
              aria-label="Dismiss notice"
            >
              <X size={14} />
            </button>
          </div>
        </div>,
        document.body
      )}

      <main className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-12 gap-6 p-4 lg:p-6 pt-0 lg:pt-0" style={{ paddingBottom: 'calc(1rem + env(safe-area-inset-bottom, 0px))' }}>
        <div className="lg:col-span-9 flex flex-col gap-4 min-h-0 overflow-y-auto custom-scrollbar pr-3" style={{ scrollbarGutter: 'stable' }}>
          {/* Both panels stay mounted at all times so their internal state is preserved across tab switches.
              Visibility is toggled purely with CSS (hidden / contents). */}
          <div className={mainTab === 'performance' ? 'flex-1 flex flex-col min-h-0 gap-2' : 'hidden'}>
            {/* Recording target track selector */}
            <div className="flex-none flex items-center gap-2 px-1 py-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
              <span className="text-xs font-black text-slate-500 uppercase tracking-widest">Rec →</span>
              <div className="flex gap-1 flex-wrap">
                {tracks.map(track => (
                  <button
                    key={track.id}
                    onClick={() => { setRecordingTrackId(track.id); setActiveTrackId(track.id); }}
                    className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-black transition-all ${recordingTrackId === track.id ? 'text-white' : 'text-slate-600 hover:text-slate-300'}`}
                    style={{ background: recordingTrackId === track.id ? `${track.color}1f` : undefined }}
                  >
                    <div className="w-1.5 h-1.5 rounded-full" style={{ background: track.color }} />
                    {track.name}
                  </button>
                ))}
              </div>
            </div>
            <PerformancePad
              bpm={state.tempo}
              onCommitRecording={handleCommitRecording}
              onRecordingStart={() => { recordingStartBeatRef.current = playbackBeatRef.current; }}
              isMouseInPadRef={isMouseInPadRef}
              theme={{
                cardDeep: t.cardDeep,
                border: t.b1,
                textPrimary: t.t1,
                textSecondary: t.t3,
                textMuted: t.t4,
                tint: t.tint,
                accent: t.indigo,
              }}
              onStartPlayback={() => {
                audioEngine.init();
                isPausedRef.current = false;
                setIsPaused(false);
                setState(s => ({ ...s, isPlaying: true }));
              }}
            />
          </div>
          <div className={mainTab === 'sequencer' ? 'contents' : 'hidden'}>
          {/* ── Multi-track stacked piano roll ── */}
          {/* Each track is a fixed 320px lane; the container scrolls vertically
              so adding many tracks never squashes the canvas area. */}
          <div className="relative flex flex-col border border-white/5 rounded-3xl overflow-hidden bg-black shadow-inner" style={{ minHeight: '350px', flex: 1 }}>
            {/* Scrollable track stack */}
            <div className="flex-1 overflow-y-auto custom-scrollbar" ref={trackScrollContainerRef}>
              {tracks.map((track) => (
                <div
                  key={track.id}
                  data-trackid={track.id}
                  className="relative flex border-b border-white/5 last:border-b-0"
                  style={{ height: `${(trackHeights[track.id] ?? trackHeight)}%` }}
                >
                  {/* Track header sidebar — fixed 44px wide, taller for controls */}
                  <div
                    className={`flex-none w-44 flex flex-col gap-1 p-2 border-r cursor-pointer transition-colors ${
                      activeTrackId === track.id
                        ? 'bg-white/[0.07] border-r-2'
                        : 'border-white/5 hover:bg-white/[0.03]'
                    }`}
                    style={activeTrackId === track.id ? { borderRightColor: track.color, borderLeftColor: track.color, borderLeft: `3px solid ${track.color}` } : undefined}
                    onClick={() => { setActiveTrackId(track.id); setRecordingTrackId(track.id); }}
                  >
                    {/* Row 1: colour dot + name + remove */}
                    <div className="flex items-center gap-1.5">
                      <div className="w-2.5 h-2.5 rounded-full flex-none" style={{ background: track.color }} />
                      <input
                        value={track.name}
                        onChange={e => updateTrackName(track.id, e.target.value)}
                        onClick={e => e.stopPropagation()}
                        className="flex-1 min-w-0 bg-transparent text-sm font-black text-white truncate focus:outline-none focus:ring-1 focus:ring-white/20 rounded px-0.5"
                      />
                      {tracks.length > 1 && (
                        <button
                          title="Remove track"
                          onClick={e => { e.stopPropagation(); removeTrack(track.id); }}
                          className="p-0.5 rounded text-slate-700 hover:text-red-400 transition-colors flex-none"
                        >
                          <X size={14} />
                        </button>
                      )}
                    </div>

                    {/* Row 2: mute toggle */}
                    <button
                      title={track.muted ? 'Unmute' : 'Mute'}
                      onClick={e => { e.stopPropagation(); toggleTrackMute(track.id); }}
                      className={`flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-black uppercase transition-colors border ${
                        track.muted
                          ? 'text-red-400 bg-red-500/10 border-red-500/20'
                          : 'text-slate-600 hover:text-slate-300 border-white/5 hover:bg-white/5'
                      }`}
                    >
                      {track.muted
                        ? <><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg> Muted</>
                        : <><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg> Live</>
                      }
                    </button>

                    {/* Row 3: volume slider + % label */}
                    <div className="flex flex-col gap-0.5" onClick={e => e.stopPropagation()}>
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] font-black text-slate-600 uppercase">Vol</span>
                        <span className="text-[11px] font-black tabular-nums" style={{ color: track.color }}>
                          {Math.round(track.volume * 100)}%
                        </span>
                      </div>
                      <input
                        type="range" min="0" max="1" step="0.05"
                        value={track.volume}
                        onChange={e => { e.stopPropagation(); updateTrackVolume(track.id, parseFloat(e.target.value)); }}
                        title={`Volume: ${Math.round(track.volume * 100)}%`}
                        className="w-full h-1 appearance-none rounded-full bg-slate-800 cursor-pointer"
                        style={{ accentColor: track.color, '--thumb-color': track.color } as React.CSSProperties}
                      />
                    </div>

                    {/* Row 4: rec target indicator + AI indicator */}
                    <div className="flex items-center gap-1.5 mt-auto">
                      {recordingTrackId === track.id && (
                        <span className="flex items-center gap-1 text-[11px] text-red-400 font-black uppercase">
                          <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" /> REC
                        </span>
                      )}
                      {activeTrackId === track.id && (
                        <span className="flex items-center gap-1 text-[11px] font-black uppercase" style={{ color: track.color }}>
                          <Zap size={12} /> AI
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Piano roll canvas for this track */}
                  <div className="flex-1 relative">
                    <PianoRoll
                      events={events.filter(e => e.trackId === track.id)}
                      currentBeat={playbackBeat}
                      selectedNoteIds={selectedEventIds}
                      selectionMarquee={selectionMarquee}
                      beatWidth={beatWidth}
                      trackColor={track.color}
                      gridColors={{ bar: t.gridBar, beat: t.gridBeat, eighth: t.gridEighth, sixteenth: t.gridSixteenth, octave: t.gridOctave, pitch: t.gridPitch }}
                      noteBrightness={{ lightness: t.noteLightness, altLightness: t.noteAltLightness, altAlpha: t.noteAltAlpha }}
                      onSeek={handleSeek}
                      onSelectionMarqueeChange={setSelectionMarquee}
                      onSelectNotes={setSelectedEventIds}
                      onMoveSelection={handleMoveSelection}
                      onZoomChange={v => setBeatWidth(clampBeatWidth(v))}
                      selectMode={selectMode}
                    />
                  </div>
                  {/* Drag handle — resize this track vertically */}
                  <div
                    className="absolute bottom-0 left-0 right-0 h-2 cursor-ns-resize group/handle z-10 flex items-center"
                    title="Drag to resize this track"
                    onMouseDown={e => {
                      e.preventDefault();
                      trackResizeDragRef.current = {
                        trackId: track.id,
                        startY: e.clientY,
                        startHeightPct: trackHeights[track.id] ?? trackHeight,
                      };
                    }}
                  >
                    <div className="w-full h-[2px] bg-white/20 group-hover/handle:bg-cyan-500/70 transition-colors shadow-[0_0_4px_rgba(255,255,255,0.1)]" />
                  </div>
                </div>
              ))}
            </div>

            {/* Add track — always visible at the bottom of the stack */}
            {/* Moved to toolbar — removed from here */}

            {isWarmingUp && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/95 backdrop-blur-xl z-20">
                <Loader2 className="animate-spin text-indigo-500 mb-4" size={64} />
                <h2 className="text-2xl font-black text-white uppercase italic">Connecting Neural Link...</h2>
              </div>
            )}

            <div className="absolute bottom-0 left-0 w-full h-1 bg-white/5 overflow-hidden">
               <div className="h-full bg-indigo-500 transition-all shadow-[0_0_10px_#6366f1]" style={{ width: `${Math.min(100, (bufferRemaining / queueThreshold) * 100)}%` }} />
            </div>
          </div>

          {/* ── Sequencer edit toolbar ── */}
          <div className="flex-none flex flex-wrap items-center gap-1 backdrop-blur-md nc-border rounded-2xl px-2 py-1.5" style={{ backgroundColor: t.toolbar, borderColor: t.b1 }}>
            {isTouchDevice && (
              <>
                <button
                  onClick={() => setSelectMode(v => !v)}
                  title={selectMode ? 'Exit Select Mode' : 'Select Mode: tap notes to select, drag to box-select'}
                  className={`nc-toolbar-btn flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[10px] font-black uppercase transition-colors border ${
                    selectMode
                      ? 'bg-cyan-500/20 text-cyan-400 border-cyan-500/40'
                      : 'text-slate-500 border-transparent'
                  }`}
                >
                  <MousePointer2 size={13} /> {selectMode ? 'Selecting' : 'Select'}
                </button>
                <div className="w-px h-5 bg-white/10 mx-1" />
              </>
            )}
            <button onClick={undo} disabled={history.past.length === 0} className="nc-toolbar-btn flex items-center gap-1.5 px-3 py-1.5 disabled:opacity-30 text-slate-400 rounded-xl text-xs font-black uppercase transition-colors"><Undo size={14} /> Undo</button>
            <button onClick={redo} disabled={history.future.length === 0} className="nc-toolbar-btn flex items-center gap-1.5 px-3 py-1.5 disabled:opacity-30 text-slate-400 rounded-xl text-xs font-black uppercase transition-colors"><Redo size={14} /> Redo</button>
            <div className="w-px h-5 bg-white/10 mx-1" />
            <button onClick={handleSelectAll} disabled={events.length === 0} className="nc-toolbar-btn flex items-center gap-1.5 px-3 py-1.5 disabled:opacity-30 hover:bg-indigo-500/10 text-slate-400 hover:text-indigo-400 rounded-xl text-xs font-black uppercase transition-colors"><Copy size={14} /> All</button>
            {selectedEventIds.length > 0 && (
              <>
                <button onClick={handleCopy} className="nc-toolbar-btn flex items-center gap-1.5 px-3 py-1.5 hover:bg-indigo-500/10 hover:text-indigo-400 text-slate-400 rounded-xl text-xs font-black uppercase transition-colors"><Copy size={14} /> Copy</button>
                <button onClick={handleCut} className="nc-toolbar-btn flex items-center gap-1.5 px-3 py-1.5 hover:bg-red-500/10 hover:text-red-400 text-slate-400 rounded-xl text-xs font-black uppercase transition-colors"><Scissors size={14} /> Cut</button>
                <button onClick={handleDelete} className="nc-toolbar-btn flex items-center gap-1.5 px-3 py-1.5 hover:bg-red-500/10 hover:text-red-400 text-slate-400 rounded-xl text-xs font-black uppercase transition-colors"><Trash2 size={14} /> Del</button>
                <button onClick={() => setSelectedEventIds([])} className="nc-toolbar-btn flex items-center gap-1.5 px-2 py-1.5 text-slate-600 hover:text-slate-400 rounded-xl transition-colors"><X size={14} /></button>
              </>
            )}
            {clipboard.length > 0 && (
              <button onClick={handlePaste} className="nc-toolbar-btn flex items-center gap-1.5 px-3 py-1.5 hover:bg-emerald-500/10 hover:text-emerald-400 text-slate-400 rounded-xl text-xs font-black uppercase transition-colors"><ClipboardPaste size={14} /> Paste</button>
            )}
            <div className="ml-auto" />
            <button onClick={() => { setTrackHeight(v => clampTrackHeight(Math.round(v / 1.25))); setTrackHeights({}); }} title="Shrink all tracks (Y zoom out)" className="nc-toolbar-btn flex items-center gap-1 px-2 py-1.5 text-slate-500 hover:text-slate-300 rounded-xl text-xs font-black transition-colors"><ZoomOut size={14} /></button>
            <button onClick={() => { setTrackHeight(100); setTrackHeights({}); }} title="Reset track height (33% = ~3 tracks fill viewport)" className="nc-toolbar-btn flex items-center justify-center gap-1.5 px-2 py-1.5 min-w-[5.25rem] text-slate-600 hover:text-slate-300 rounded-xl text-[10px] font-black tabular-nums transition-colors">
              <span className="w-[4ch] text-right">{Math.round(trackHeight)}%</span>
              <ArrowUpDown size={11} className="shrink-0" aria-hidden="true" />
            </button>
            <button onClick={() => { setTrackHeight(v => clampTrackHeight(Math.round(v * 1.25))); setTrackHeights({}); }} title="Grow all tracks (Y zoom in)" className="nc-toolbar-btn flex items-center gap-1 px-2 py-1.5 text-slate-500 hover:text-slate-300 rounded-xl text-xs font-black transition-colors"><ZoomIn size={14} /></button>
            <div className="w-px h-5 bg-white/10 mx-1" />
            <button onClick={() => setBeatWidth(v => clampBeatWidth(v / 1.25))} title="Zoom out (Ctrl+scroll)" className="nc-toolbar-btn flex items-center gap-1 px-2 py-1.5 text-slate-500 hover:text-slate-300 rounded-xl text-xs font-black transition-colors"><ZoomOut size={14} /></button>
            <button onClick={() => setBeatWidth(100)} title="Reset zoom" className="nc-toolbar-btn flex items-center justify-center gap-1.5 px-2 py-1.5 min-w-[5.25rem] text-slate-600 hover:text-slate-300 rounded-xl text-[10px] font-black tabular-nums transition-colors">
              <span className="w-[4ch] text-right">{Math.round(beatWidth / 100 * 100)}%</span>
              <ArrowLeftRight size={11} className="shrink-0" aria-hidden="true" />
            </button>
            <button onClick={() => setBeatWidth(v => clampBeatWidth(v * 1.25))} title="Zoom in (Ctrl+scroll)" className="nc-toolbar-btn flex items-center gap-1 px-2 py-1.5 text-slate-500 hover:text-slate-300 rounded-xl text-xs font-black transition-colors"><ZoomIn size={14} /></button>
          </div>

          <div className="grid grid-cols-[1fr_3fr] gap-4 h-[12rem] flex-none">
            <div className="rounded-2xl border p-4 font-mono text-xs flex flex-col overflow-hidden" style={{ backgroundColor: t.cardDeep, borderColor: t.b1 }}>
               <div className="flex items-center gap-2 text-slate-500 uppercase font-black text-xs mb-2 border-b border-white/5 pb-1"><Terminal size={12} /> Neural Stream</div>
              <div className="flex-1 text-slate-500 break-all overflow-y-auto custom-scrollbar italic leading-relaxed">{rawStream || "Standby..."}</div>
            </div>
            <div className="rounded-2xl border p-4 flex flex-col overflow-hidden group transition-all" style={{ backgroundColor: t.cardDeep, borderColor: t.b1 }}>
               <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2 text-slate-500 uppercase font-black text-xs"><Cpu size={12} /> Manual Patch Bay</div>
                  <button
                    onClick={handleInjectUserNotes}
                    disabled={validation.validEvents.length === 0 || validation.errors.length > 0}
                    className={`px-3 py-1 rounded-lg font-black text-[10px] uppercase flex items-center gap-1 transition-all ${
                      validation.validEvents.length > 0 && validation.errors.length === 0
                        ? 'bg-indigo-600 text-white hover:bg-indigo-500 shadow-lg shadow-indigo-500/20'
                        : 'cursor-not-allowed border'
                    }`}
                    style={validation.validEvents.length === 0 || validation.errors.length > 0
                      ? { backgroundColor: t.inset, color: t.t4, borderColor: t.b1 }
                      : undefined}
                  >
                    <PlusCircle size={10} /> Inject
                  </button>
               </div>

               {/* Signal transform toolbar */}
               <div className="flex flex-wrap gap-1 mb-2 pb-2 border-b border-white/5">
                 {/* Time */}
                 <span className="text-[10px] font-black text-slate-600 uppercase self-center mr-0.5">T</span>
                 <button onClick={patchTransforms.reverseTime} title="Reverse time: reflects every note's start time so T → (totalDuration − T − D). The last note becomes the first; the sequence plays backwards. Durations are unchanged." className="flex items-center gap-0.5 px-1.5 py-0.5 rounded-md bg-slate-900 hover:bg-indigo-500/20 hover:text-indigo-300 text-slate-400 text-[10px] font-black border border-white/5 transition-colors">
                   <ArrowLeftRight size={9} /> Rev
                 </button>
                 <button onClick={() => patchTransforms.stretchTime(2)} title="Stretch ×2: multiplies every T and D by 2. Notes are twice as far apart and twice as long — same melody, half the tempo." className="px-1.5 py-0.5 rounded-md bg-slate-900 hover:bg-indigo-500/20 hover:text-indigo-300 text-slate-400 text-[10px] font-black border border-white/5 transition-colors">×2</button>
                 <button onClick={() => patchTransforms.stretchTime(0.5)} title="Compress ×½: multiplies every T and D by 0.5. Notes are half as far apart and half as long — same melody, double the tempo." className="px-1.5 py-0.5 rounded-md bg-slate-900 hover:bg-indigo-500/20 hover:text-indigo-300 text-slate-400 text-[10px] font-black border border-white/5 transition-colors">×½</button>
                 <button onClick={() => patchTransforms.quantize(0.25)} title="Quantize to ¼ beat: snaps every T to the nearest 0.25-beat grid and rounds D up to the nearest 0.25. Tightens loose timing to 16th-note resolution." className="px-1.5 py-0.5 rounded-md bg-slate-900 hover:bg-indigo-500/20 hover:text-indigo-300 text-slate-400 text-[10px] font-black border border-white/5 transition-colors">Q¼</button>
                 <button onClick={() => patchTransforms.quantize(0.5)} title="Quantize to ½ beat: snaps every T to the nearest 0.5-beat grid and rounds D up to the nearest 0.5. Tightens loose timing to 8th-note resolution." className="px-1.5 py-0.5 rounded-md bg-slate-900 hover:bg-indigo-500/20 hover:text-indigo-300 text-slate-400 text-[10px] font-black border border-white/5 transition-colors">Q½</button>
                 <div className="w-px h-4 bg-white/10 self-center mx-0.5" />
                 {/* Pitch */}
                 <span className="text-[10px] font-black text-slate-600 uppercase self-center mr-0.5">P</span>
                 <button onClick={patchTransforms.invertPitch} title="Invert pitch: mirrors every note around the midpoint of the sequence's pitch range. P → (minP + maxP − P). A rising melody becomes falling; intervals are preserved in size but flipped in direction." className="flex items-center gap-0.5 px-1.5 py-0.5 rounded-md bg-slate-900 hover:bg-violet-500/20 hover:text-violet-300 text-slate-400 text-[10px] font-black border border-white/5 transition-colors">
                   <ArrowUpDown size={9} /> Inv
                 </button>
                 <button onClick={() => patchTransforms.widenPitch(1.5)} title="Widen ×1.5: scales every pitch away from the range's centre by 1.5×. Intervals grow larger — a minor 3rd becomes roughly a tritone. Clamps to 0–127." className="px-1.5 py-0.5 rounded-md bg-slate-900 hover:bg-violet-500/20 hover:text-violet-300 text-slate-400 text-[10px] font-black border border-white/5 transition-colors">Wide</button>
                 <button onClick={() => patchTransforms.widenPitch(1/1.5)} title="Narrow ÷1.5: scales every pitch toward the range's centre by ÷1.5. Intervals shrink — a major 6th becomes roughly a major 3rd. Useful to compress dramatic leaps." className="px-1.5 py-0.5 rounded-md bg-slate-900 hover:bg-violet-500/20 hover:text-violet-300 text-slate-400 text-[10px] font-black border border-white/5 transition-colors">Narr</button>
                 <button onClick={() => patchTransforms.transpose(1)} title="Transpose +1 semitone: adds 1 to every P (e.g. C4→C#4). Clamps at 127." className="px-1.5 py-0.5 rounded-md bg-slate-900 hover:bg-violet-500/20 hover:text-violet-300 text-slate-400 text-[10px] font-black border border-white/5 transition-colors">+1</button>
                 <button onClick={() => patchTransforms.transpose(-1)} title="Transpose −1 semitone: subtracts 1 from every P (e.g. C4→B3). Clamps at 0." className="px-1.5 py-0.5 rounded-md bg-slate-900 hover:bg-violet-500/20 hover:text-violet-300 text-slate-400 text-[10px] font-black border border-white/5 transition-colors">−1</button>
                 <button onClick={() => patchTransforms.transpose(12)} title="Transpose +1 octave: adds 12 to every P. Same notes, one octave higher. Clamps at 127." className="px-1.5 py-0.5 rounded-md bg-slate-900 hover:bg-violet-500/20 hover:text-violet-300 text-slate-400 text-[10px] font-black border border-white/5 transition-colors">+8ve</button>
                 <button onClick={() => patchTransforms.transpose(-12)} title="Transpose −1 octave: subtracts 12 from every P. Same notes, one octave lower. Clamps at 0." className="px-1.5 py-0.5 rounded-md bg-slate-900 hover:bg-violet-500/20 hover:text-violet-300 text-slate-400 text-[10px] font-black border border-white/5 transition-colors">−8ve</button>
                 <div className="w-px h-4 bg-white/10 self-center mx-0.5" />
                 {/* Velocity */}
                 <span className="text-[10px] font-black text-slate-600 uppercase self-center mr-0.5">V</span>
                 <button onClick={patchTransforms.normalizeVelocity} title="Normalize velocity: linearly stretches the velocity range so the quietest note → V=10 and the loudest → V=110, preserving relative dynamics. If all notes share the same velocity (no range), every note is set to V=90." className="px-1.5 py-0.5 rounded-md bg-slate-900 hover:bg-emerald-500/20 hover:text-emerald-300 text-slate-400 text-[10px] font-black border border-white/5 transition-colors">Norm</button>
                 <button onClick={() => patchTransforms.volShift(10)} title="Volume +10: adds 10 to every velocity. Clamps at 127." className="px-1.5 py-0.5 rounded-md bg-slate-900 hover:bg-emerald-500/20 hover:text-emerald-300 text-slate-400 text-[10px] font-black border border-white/5 transition-colors">+10</button>
                 <button onClick={() => patchTransforms.volShift(-10)} title="Volume −10: subtracts 10 from every velocity. Clamps at 0." className="px-1.5 py-0.5 rounded-md bg-slate-900 hover:bg-emerald-500/20 hover:text-emerald-300 text-slate-400 text-[10px] font-black border border-white/5 transition-colors">−10</button>
               </div>
               <textarea
                  value={userInput}
                  onChange={(e) => setUserInput(e.target.value)}
                  placeholder={`# Single voice (flat format):
[P:60,V:100,T:0,D:1]  # P=pitch 0-127, V=velocity, T=beat offset, D=duration in beats
[P:64,V:90,T:1,D:0.5] [P:67,V:85,T:1.5,D:0.5]

# Multi-voice format — one header per track:
[voice:1 name:"Lead" preset:"Crystal Lead"]
[P:69,V:80,T:0,D:1] [P:67,V:78,T:1,D:1]

[voice:2 name:"Bass" preset:"Deep Bass" cutoff:800]
[P:45,V:90,T:0,D:2] [P:47,V:85,T:2,D:2]

# Presets: Grand Piano, Crystal Lead, Deep Bass,
# Ghostly Pad, Neon Pluck, Warm Rhodes, Soft Strings,
# Spiccato Strings, French Horn, Brass Section, Grand Choir,
# Acid Bass, Kick Drum, Concert Timpani, Snare Hit, Rim Shot`}
                  className="flex-1 border rounded-xl p-3 font-mono text-[11px] focus:outline-none resize-none nc-input"
                  style={{ backgroundColor: t.inputBg, color: t.inputText, borderColor: validation.errors.length > 0 ? 'rgba(239,68,68,0.4)' : t.b1, ['--placeholder-color' as string]: t.inputPH }}
               />
               {validation.errors.length > 0 && (
                  <div className="mt-2 px-2 max-h-16 overflow-y-auto custom-scrollbar">
                    {validation.errors.map((err, i) => (
                      <div key={i} className="text-[10px] text-red-400 font-mono mb-0.5">• {err.message}</div>
                    ))}
                  </div>
               )}
            </div>
          </div>
          </div>
        </div>

        <div className="lg:col-span-3 flex flex-col h-full min-h-0">
          <div className="p-4 rounded-3xl border flex-1 flex flex-col overflow-hidden" style={{ backgroundColor: t.panel, borderColor: t.b1 }}>
            <div className="flex gap-2 mb-6 border-b border-white/5 pb-2 flex-none">
                <button onClick={() => setRightPanelTab('session')} className={`flex-1 py-2 text-xs font-black uppercase tracking-widest rounded-lg transition-all ${rightPanelTab === 'session' ? 'bg-indigo-500/20 text-indigo-400' : 'text-slate-600 hover:text-slate-400'}`}>Session</button>
                <button onClick={() => setRightPanelTab('synth')} className={`flex-1 py-2 text-xs font-black uppercase tracking-widest rounded-lg transition-all ${rightPanelTab === 'synth' ? 'bg-indigo-500/20 text-indigo-400' : 'text-slate-600 hover:text-slate-400'}`}>Voice</button>
            </div>

            <div className="flex-1 overflow-y-auto custom-scrollbar pr-2">
            {rightPanelTab === 'session' ? (
                <div className="space-y-6">
                  <div className="p-5 rounded-2xl border" style={{ backgroundColor: t.card, borderColor: t.b1 }}>
                     <div className="text-xs font-bold uppercase mb-2" style={{ color: t.t4 }}>Playhead</div>
                     <div className="text-4xl font-black text-white tabular-nums tracking-tighter mb-2">{Math.floor(playbackBeat / 4)}.<span className="text-indigo-500">{(Math.floor(playbackBeat % 4) + 1)}</span></div>
                     <TimeNavigator currentBeat={playbackBeat} totalBeats={totalViewRange} onSeek={handleSeek} />
                  </div>
                  <div className="p-5 rounded-2xl border" style={{ backgroundColor: t.card, borderColor: t.b1 }}>
                     <div className="text-xs font-bold uppercase mb-2" style={{ color: t.t4 }}>Composition History</div>
                     <div className="flex items-baseline gap-1 mb-1">
                        <div className="text-3xl font-black tabular-nums tracking-tighter text-indigo-400">{events.filter(e => e.isUser).length}</div>
                        <span className="text-xs text-slate-700 font-black uppercase">M</span>
                        <span className="mx-2 text-slate-800">|</span>
                        <div className="text-3xl font-black tabular-nums tracking-tighter text-indigo-800">{events.filter(e => !e.isUser).length}</div>
                        <span className="text-xs text-slate-700 font-black uppercase">N</span>
                     </div>
                     <div className="mt-4 grid grid-cols-2 gap-2">
                       <button onClick={handleDownload} className="w-full py-2 bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-400 rounded-lg border border-indigo-500/20 text-xs font-bold uppercase"><Download size={12} className="inline mr-2" /> Export Text</button>
                       <button onClick={handleExportWav} disabled={events.length === 0 || isExporting} className="w-full py-2 disabled:opacity-30 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 rounded-lg border border-emerald-500/20 text-xs font-bold uppercase">
                         {isExporting ? <Loader2 size={12} className="inline mr-2 animate-spin" /> : <FileAudio size={12} className="inline mr-2" />}
                         {isExporting ? 'Rendering…' : 'Export WAV'}
                       </button>
                     </div>
                  </div>

                  <div className="p-5 rounded-2xl border" style={{ backgroundColor: t.card, borderColor: t.b1 }}>
                     <div className="text-xs font-bold uppercase mb-2" style={{ color: t.t4 }}>Sample Compositions</div>
                     <div className="space-y-2">
                        {SAMPLE_FILES.map((file) => (
                           <button
                              key={file}
                              onClick={() => loadSample(file)}
                              className="w-full py-2 px-3 rounded-lg border text-xs font-mono text-left truncate transition-colors flex items-center gap-2 nc-sample-btn"
                           >
                              <Music size={12} />
                              {file}
                           </button>
                        ))}
                     </div>
                  </div>

                  <div className="mt-auto p-5 rounded-2xl border space-y-3" style={{ backgroundColor: t.card, borderColor: t.b1 }}>
                     <div className="text-xs font-bold uppercase flex items-center gap-2" style={{ color: t.t4 }}><Sparkles size={12} /> AI Settings</div>
                     <div className="space-y-2">
                       <label className="text-[10px] font-bold uppercase tracking-widest" style={{ color: t.t4 }}>API Key</label>
                       <input
                         type="password"
                         placeholder="Gemini API Key"
                         value={apiKey}
                         onChange={(e) => setApiKey(e.target.value)}
                         className="w-full border rounded-lg px-3 py-2 text-xs focus:outline-none nc-input"
                         style={{ backgroundColor: t.inputBg, color: t.inputText, borderColor: t.b2 }}
                       />
                     </div>
                     <div className="space-y-2">
                       <label className="text-[10px] font-bold uppercase tracking-widest" style={{ color: t.t4 }}>Style</label>
                       <select
                         className="w-full border rounded-lg px-3 py-2 text-xs font-bold cursor-pointer focus:outline-none nc-input"
                         style={{ backgroundColor: t.inputBg, color: t.inputText, borderColor: t.b2 }}
                         value={state.genre}
                         onChange={(e) => setState(s => ({ ...s, genre: e.target.value }))}
                       >
                         {Object.values(MusicGenre).map(g => (<option key={g} value={g}>{g}</option>))}
                       </select>
                     </div>
                     <div className="space-y-2">
                       <label className="text-[10px] font-bold uppercase tracking-widest" style={{ color: t.t4 }}>Creative Direction</label>
                       <textarea value={creativeDirection} onChange={(e) => setCreativeDirection(e.target.value)} placeholder="e.g. Add erratic fills..." className="w-full border rounded-lg p-2 text-xs h-20 focus:outline-none nc-input" style={{ backgroundColor: t.inputBg, color: t.inputText, borderColor: t.b2 }} />
                     </div>
                  </div>
                </div>
            ) : (
                <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-500">
                    {/* ── Track selector ── */}
                    <section>
                      <div className="flex items-center justify-between mb-2">
                        <div className="text-xs font-black text-slate-500 uppercase tracking-widest flex items-center gap-2"><Music size={12}/> Tracks</div>
                        <button
                          onClick={addTrack}
                          className="flex items-center gap-1 px-2 py-1 rounded-lg bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-400 text-[10px] font-black uppercase transition-colors border border-indigo-500/20"
                        >
                          <Plus size={9} /> Add
                        </button>
                      </div>
                      <div className="flex flex-col gap-1">
                        {tracks.map(track => (
                          <div key={track.id} className="flex items-center gap-1">
                            <button
                              onClick={() => { setActiveTrackId(track.id); setRecordingTrackId(track.id); }}
                              className={`flex-1 flex items-center gap-2 px-3 py-2 rounded-xl border text-xs font-black transition-all ${activeTrackId === track.id ? 'border-white/20 bg-white/5 text-white' : 'border-transparent text-slate-500 hover:text-slate-300 hover:bg-white/[0.03]'}`}
                            >
                              <div className="w-2 h-2 rounded-full flex-none" style={{ background: track.color }} />
                              <span className="truncate">{track.name}</span>
                              {track.muted && <span className="ml-auto text-[10px] text-red-400 uppercase">muted</span>}
                            </button>
                            {tracks.length > 1 && (
                              <button
                                title="Remove track"
                                onClick={() => removeTrack(track.id)}
                                className="p-1.5 rounded-lg text-slate-700 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                              >
                                <X size={10} />
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    </section>

                    <section>
                      <div className="flex flex-col gap-3 mb-4">
                        <div className="text-xs font-black text-slate-500 uppercase tracking-widest flex items-center gap-2"><Activity size={12}/> Analysis</div>
                        <div className="flex items-center gap-2 bg-black/40 p-1.5 rounded-xl border border-white/5">
                             <div className="grid grid-cols-3 gap-1 flex-1">
                                <div className="relative group">
                                  <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[10px] font-bold text-slate-500">P</span>
                                  <input type="number" value={testNote.p} onChange={(e) => setTestNote(curr => ({...curr, p: Math.min(127, Math.max(0, parseInt(e.target.value) || 0))}))} className="w-full bg-slate-900 border border-white/5 rounded-lg py-1 pl-5 pr-1 text-[11px] font-mono text-center focus:outline-none focus:border-indigo-500/50" />
                                </div>
                                <div className="relative group">
                                  <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[10px] font-bold text-slate-500">V</span>
                                  <input type="number" value={testNote.v} onChange={(e) => setTestNote(curr => ({...curr, v: Math.min(127, Math.max(0, parseInt(e.target.value) || 0))}))} className="w-full bg-slate-900 border border-white/5 rounded-lg py-1 pl-5 pr-1 text-[11px] font-mono text-center focus:outline-none focus:border-indigo-500/50" />
                                </div>
                                <div className="relative group">
                                  <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[10px] font-bold text-slate-500">D</span>
                                  <input type="number" step="0.1" value={testNote.d} onChange={(e) => setTestNote(curr => ({...curr, d: Math.max(0.1, parseFloat(e.target.value) || 0.1)}))} className="w-full bg-slate-900 border border-white/5 rounded-lg py-1 pl-5 pr-1 text-[11px] font-mono text-center focus:outline-none focus:border-indigo-500/50" />
                                </div>
                             </div>
                             <button
                              onClick={handleTestNote}
                              className="flex-none px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg border border-indigo-400 text-xs font-black uppercase transition-all active:scale-95 shadow-lg shadow-indigo-500/20"
                            >
                              <Music size={12}/>
                            </button>
                        </div>
                      </div>
                      <SynthVisualizer config={activeTrack.synthConfig} />

                      {/* Presets */}
                      <div className="grid grid-cols-2 gap-2 mb-6">
                        {Object.keys(SYNTH_PRESETS).map(name => (
                          <button
                            key={name}
                            onClick={() => applyPresetToActiveTrack(SYNTH_PRESETS[name])}
                            className={`px-2 py-1.5 rounded-lg text-[10px] font-black uppercase border transition-all ${JSON.stringify(activeTrack.synthConfig) === JSON.stringify(SYNTH_PRESETS[name]) ? 'bg-indigo-600 border-indigo-500 text-white' : 'bg-slate-900/50 border-white/5 text-slate-500 hover:text-slate-300'}`}
                          >
                            {name}
                          </button>
                        ))}
                      </div>

                      {/* Copy-to-text helper */}
                      <button
                        title="Copy a ready-to-paste voice header for this track to the clipboard"
                        onClick={() => {
                          const idx = tracks.findIndex(t => t.id === activeTrackId);
                          const header = `[voice:${idx + 1} name:"${activeTrack.name}" ${serializeSynthConfig(activeTrack.synthConfig)}]`;
                          navigator.clipboard.writeText(header).catch(() => {
                            showNotice('error', 'Could not copy the voice header to the clipboard.');
                          });
                        }}
                        className="w-full flex items-center justify-center gap-1.5 py-2 bg-slate-900/50 hover:bg-indigo-500/10 border border-white/5 hover:border-indigo-500/30 text-slate-500 hover:text-indigo-400 rounded-xl text-xs font-black uppercase transition-all mb-1"
                      >
                        <Copy size={10} /> Copy Voice Header
                      </button>
                    </section>

                    <section className="rounded-2xl border border-white/5 bg-black/40 overflow-hidden">
                      <button
                        onClick={() => setVoicePanelOpen(curr => ({ ...curr, basic: !curr.basic }))}
                        className="w-full flex items-center justify-between px-4 py-3 text-left"
                      >
                        <span className="flex items-center gap-2 text-xs font-black text-indigo-400 uppercase tracking-widest"><Waves size={14}/> Basic</span>
                        <span className="text-[10px] font-black uppercase text-slate-500">{voicePanelOpen.basic ? 'Hide' : 'Show'}</span>
                      </button>
                      {voicePanelOpen.basic && (
                        <div className="space-y-4 px-4 pb-4 border-t border-white/5">
                          <div className="pt-4">
                            <div className="flex items-center gap-2 text-xs font-black text-indigo-400 uppercase tracking-widest mb-2"><Waves size={14}/> Oscillator</div>
                            <div className="grid grid-cols-2 gap-2 mb-3">
                              {waveOptions.map(type => (
                                <button key={type} onClick={() => updateSynth('waveType', type)} className={`px-2 py-2 rounded-lg text-[10px] font-bold uppercase border transition-all ${activeTrack.synthConfig.waveType === type ? 'bg-indigo-600 border-indigo-500 text-white shadow-[0_0_10px_rgba(99,102,241,0.5)]' : 'bg-slate-900 border-slate-800 text-slate-500 hover:border-slate-700'}`}>{type}</button>
                              ))}
                            </div>
                              <div className="space-y-1">
                              <div className="flex justify-between text-[10px] font-bold text-slate-600 uppercase"><SynthControlLabel label="Waveform" copy={VOICE_TOOLTIPS.waveType} tokens={t} /><span>{activeTrack.synthConfig.waveType}</span></div>
                            </div>
                            <div className="space-y-1 mt-3">
                              <div className="flex justify-between text-[10px] font-bold text-slate-600 uppercase"><SynthControlLabel label="Detune" copy={VOICE_TOOLTIPS.detune} tokens={t} /><span>{activeTrack.synthConfig.detune}</span></div>
                              <input type="range" min="-50" max="50" value={activeTrack.synthConfig.detune} onChange={e => updateSynth('detune', parseInt(e.target.value))} className="w-full accent-indigo-500 h-1 bg-slate-800 rounded-full appearance-none" />
                            </div>
                          </div>

                          <div>
                            <div className="flex items-center gap-2 text-xs font-black text-indigo-400 uppercase tracking-widest mb-2"><SlidersHorizontal size={14}/> Filter</div>
                            <div className="space-y-3">
                              <div className="space-y-1">
                                <div className="flex justify-between text-[10px] font-bold text-slate-600 uppercase"><SynthControlLabel label="Cutoff" copy={VOICE_TOOLTIPS.cutoff} tokens={t} /><span>{activeTrack.synthConfig.cutoff}Hz</span></div>
                                <input type="range" min="10" max="8000" value={activeTrack.synthConfig.cutoff} onChange={e => updateSynth('cutoff', parseInt(e.target.value))} className="w-full accent-indigo-500 h-1 bg-slate-800 rounded-full appearance-none" />
                              </div>
                              <div className="space-y-1">
                                <div className="flex justify-between text-[10px] font-bold text-slate-600 uppercase"><SynthControlLabel label="Resonance" copy={VOICE_TOOLTIPS.resonance} tokens={t} /><span>{activeTrack.synthConfig.resonance.toFixed(1)}</span></div>
                                <input type="range" min="0" max="20" step="0.5" value={activeTrack.synthConfig.resonance} onChange={e => updateSynth('resonance', parseFloat(e.target.value))} className="w-full accent-indigo-500 h-1 bg-slate-800 rounded-full appearance-none" />
                              </div>
                            </div>
                          </div>

                          <div>
                            <div className="flex items-center gap-2 text-xs font-black text-indigo-400 uppercase tracking-widest mb-2"><Activity size={14}/> Envelope</div>
                            <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                              {[
                                { label: 'Attack', key: 'attack', min: 0.001, max: 2, step: 0.01, tooltip: VOICE_TOOLTIPS.attack },
                                { label: 'Decay', key: 'decay', min: 0.01, max: 2, step: 0.01, tooltip: VOICE_TOOLTIPS.decay },
                                { label: 'Sustain', key: 'sustain', min: 0, max: 1, step: 0.05, tooltip: VOICE_TOOLTIPS.sustain },
                                { label: 'Release', key: 'release', min: 0.01, max: 4, step: 0.05, tooltip: VOICE_TOOLTIPS.release },
                              ].map(p => (
                                <div key={p.key} className="space-y-1">
                                  <div className="flex justify-between text-[10px] font-bold text-slate-600 uppercase"><SynthControlLabel label={p.label} copy={p.tooltip} tokens={t} /></div>
                                  <input type="range" min={p.min} max={p.max} step={p.step} value={activeTrack.synthConfig[p.key as keyof SynthConfig] as number} onChange={e => updateSynth(p.key as keyof SynthConfig, parseFloat(e.target.value))} className="w-full accent-indigo-500 h-1 bg-slate-800 rounded-full appearance-none" />
                                </div>
                              ))}
                            </div>
                            <div className="space-y-1 mt-3">
                              <div className="flex items-center justify-between text-[10px] font-bold text-slate-600 uppercase">
                                <SynthControlLabel label="Drive" copy={VOICE_TOOLTIPS.drive} tokens={t} />
                                <span>{activeTrack.synthConfig.drive.toFixed(2)}×</span>
                              </div>
                              <input type="range" min={0.1} max={10} step={0.05} value={activeTrack.synthConfig.drive} onChange={e => updateSynth('drive', parseFloat(e.target.value))} className="w-full accent-indigo-500 h-1 bg-slate-800 rounded-full appearance-none" />
                            </div>
                          </div>
                        </div>
                      )}
                    </section>

                    <section className="rounded-2xl border border-white/5 bg-black/40 overflow-hidden">
                      <button
                        onClick={() => setVoicePanelOpen(curr => ({ ...curr, advanced: !curr.advanced }))}
                        className="w-full flex items-center justify-between px-4 py-3 text-left"
                      >
                        <span className="flex items-center gap-2 text-xs font-black text-indigo-400 uppercase tracking-widest"><Gauge size={14}/> Advanced</span>
                        <span className="text-[10px] font-black uppercase text-slate-500">{voicePanelOpen.advanced ? 'Hide' : 'Show'}</span>
                      </button>
                      {voicePanelOpen.advanced && (
                        <div className="space-y-4 px-4 pb-4 border-t border-white/5">
                          <div className="pt-4">
                            <div className="flex items-center gap-2 text-xs font-black text-indigo-400 uppercase tracking-widest mb-2"><Waves size={14}/> Oscillator Layering</div>
                            <div className="space-y-2 pt-1">
                              <div className="flex items-center gap-2 text-[10px] font-black text-slate-500 uppercase tracking-widest">
                                <SynthControlLabel label="Osc 2 Wave" copy={VOICE_TOOLTIPS.osc2WaveType} tokens={t} />
                              </div>
                              <div className="grid grid-cols-3 gap-2">
                                <button
                                  onClick={() => updateSynth('osc2WaveType', undefined)}
                                  className={`px-2 py-2 rounded-lg text-[10px] font-bold uppercase border transition-all ${activeTrack.synthConfig.osc2WaveType === undefined ? 'bg-indigo-600 border-indigo-500 text-white shadow-[0_0_10px_rgba(99,102,241,0.5)]' : 'bg-slate-900 border-slate-800 text-slate-500 hover:border-slate-700'}`}
                                >
                                  Off
                                </button>
                                {waveOptions.map(type => (
                                  <button
                                    key={`osc2-${type}`}
                                    onClick={() => updateSynth('osc2WaveType', type)}
                                    className={`px-2 py-2 rounded-lg text-[10px] font-bold uppercase border transition-all ${activeTrack.synthConfig.osc2WaveType === type ? 'bg-indigo-600 border-indigo-500 text-white shadow-[0_0_10px_rgba(99,102,241,0.5)]' : 'bg-slate-900 border-slate-800 text-slate-500 hover:border-slate-700'}`}
                                  >
                                    {type}
                                  </button>
                                ))}
                              </div>
                              <div className="space-y-1">
                                <div className="flex justify-between text-[10px] font-bold text-slate-600 uppercase"><SynthControlLabel label="Osc 2 Detune" copy={VOICE_TOOLTIPS.osc2Detune} tokens={t} /><span>{(activeTrack.synthConfig.osc2Detune ?? 0).toFixed(0)}c</span></div>
                                <input type="range" min="-50" max="50" value={activeTrack.synthConfig.osc2Detune ?? 0} onChange={e => updateSynth('osc2Detune', parseInt(e.target.value))} className="w-full accent-indigo-500 h-1 bg-slate-800 rounded-full appearance-none" />
                              </div>
                              <div className="space-y-1">
                                <div className="flex justify-between text-[10px] font-bold text-slate-600 uppercase"><SynthControlLabel label="Osc 2 Mix" copy={VOICE_TOOLTIPS.osc2Mix} tokens={t} /><span>{Math.round((activeTrack.synthConfig.osc2Mix ?? 0) * 100)}%</span></div>
                                <input type="range" min="0" max="1" step="0.01" value={activeTrack.synthConfig.osc2Mix ?? 0} onChange={e => updateSynth('osc2Mix', parseFloat(e.target.value))} className="w-full accent-indigo-500 h-1 bg-slate-800 rounded-full appearance-none" />
                              </div>
                            </div>
                          </div>

                          <div>
                            <div className="flex items-center gap-2 text-xs font-black text-indigo-400 uppercase tracking-widest mb-2"><Gauge size={14}/> Expression / Motion</div>
                            <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                              {[
                                { label: 'Vibrato Rate', key: 'vibratoRate' as keyof SynthConfig, min: 0, max: 12, step: 0.1, display: (v: number) => v === 0 ? 'off' : `${v.toFixed(1)}Hz`, tooltip: VOICE_TOOLTIPS.vibratoRate },
                                { label: 'Vibrato Depth', key: 'vibratoDepth' as keyof SynthConfig, min: 0, max: 50, step: 0.1, display: (v: number) => v === 0 ? 'off' : `${v.toFixed(1)}c`, tooltip: VOICE_TOOLTIPS.vibratoDepth },
                                { label: 'Filter LFO Rate', key: 'filterLfoRate' as keyof SynthConfig, min: 0, max: 12, step: 0.1, display: (v: number) => v === 0 ? 'off' : `${v.toFixed(1)}Hz`, tooltip: VOICE_TOOLTIPS.filterLfoRate },
                                { label: 'Filter LFO Depth', key: 'filterLfoDepth' as keyof SynthConfig, min: 0, max: 2000, step: 1, display: (v: number) => v === 0 ? 'off' : `${Math.round(v)}Hz`, tooltip: VOICE_TOOLTIPS.filterLfoDepth },
                                { label: 'Velocity -> Cutoff', key: 'velocityToCutoff' as keyof SynthConfig, min: 0, max: 2000, step: 10, display: (v: number) => v === 0 ? 'off' : `+${Math.round(v)}Hz`, tooltip: VOICE_TOOLTIPS.velocityToCutoff },
                                { label: 'Transient Mix', key: 'transientMix' as keyof SynthConfig, min: 0, max: 1, step: 0.01, display: (v: number) => `${Math.round(v * 100)}%`, tooltip: VOICE_TOOLTIPS.transientMix },
                              ].map(p => {
                                const raw = activeTrack.synthConfig[p.key];
                                const val = typeof raw === 'number' ? raw : 0;
                                return (
                                  <div key={p.key} className="space-y-1">
                                    <div className="flex justify-between text-[10px] font-bold text-slate-600 uppercase">
                                      <SynthControlLabel label={p.label} copy={p.tooltip} tokens={t} />
                                      <span>{p.display(val)}</span>
                                    </div>
                                    <input type="range" min={p.min} max={p.max} step={p.step} value={val} onChange={e => updateSynth(p.key, parseFloat(e.target.value))} className="w-full accent-indigo-500 h-1 bg-slate-800 rounded-full appearance-none" />
                                  </div>
                                );
                              })}
                            </div>
                          </div>

                          <div>
                            <div className="flex items-center gap-2 text-xs font-black text-indigo-400 uppercase tracking-widest mb-2"><Zap size={14}/> Noise / Drum Shaping</div>
                            <div className="space-y-3">
                              {[
                                { label: 'Noise Mix', key: 'noiseMix' as keyof SynthConfig, min: 0, max: 1, step: 0.01, display: (v: number) => `${Math.round(v * 100)}%`, tooltip: VOICE_TOOLTIPS.noiseMix },
                                { label: 'Noise HP Cutoff', key: 'noiseHpCutoff' as keyof SynthConfig, min: 100, max: 16000, step: 100, display: (v: number) => `${v}Hz`, tooltip: VOICE_TOOLTIPS.noiseHpCutoff },
                                { label: 'Freq Sweep Start', key: 'freqSweepStart' as keyof SynthConfig, min: 0, max: 400, step: 1, display: (v: number) => v === 0 ? 'off' : `${v}Hz`, tooltip: VOICE_TOOLTIPS.freqSweepStart },
                                { label: 'Freq Sweep Time', key: 'freqSweepTime' as keyof SynthConfig, min: 0, max: 1, step: 0.01, display: (v: number) => v === 0 ? 'off' : `${v.toFixed(2)}s`, tooltip: VOICE_TOOLTIPS.freqSweepTime },
                              ].map(p => {
                                const raw = activeTrack.synthConfig[p.key];
                                const val = typeof raw === 'number' ? raw : 0;
                                return (
                                  <div key={p.key} className="space-y-1">
                                    <div className="flex items-center justify-between text-[10px] font-bold text-slate-600 uppercase">
                                      <SynthControlLabel label={p.label} copy={p.tooltip} tokens={t} />
                                      <span>{p.display(val)}</span>
                                    </div>
                                    <input type="range" min={p.min} max={p.max} step={p.step} value={val} onChange={e => updateSynth(p.key, parseFloat(e.target.value))} className="w-full accent-indigo-500 h-1 bg-slate-800 rounded-full appearance-none" />
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        </div>
                      )}
                    </section>
                </div>
            )}
            </div>
          </div>
        </div>
      </main>

      {showSettings && createPortal(
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center"
          onPointerDown={() => setShowSettings(false)}
        >
          <div className="absolute inset-0 nc-modal-backdrop" />
          <div
            className="relative z-10 w-full max-w-xs mx-4 rounded-2xl border shadow-2xl overflow-hidden"
            onPointerDown={e => e.stopPropagation()}
            style={{ backgroundColor: t.cardDeep, borderColor: t.b1 }}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: t.b1 }}>
              <div className="flex items-center gap-2">
                <Palette size={16} style={{ color: t.indigo }} />
                <span className="text-sm font-black uppercase tracking-widest" style={{ color: t.t1 }}>Appearance</span>
              </div>
              <button onClick={() => setShowSettings(false)} className="transition-colors" style={{ color: t.t3 }}>
                <X size={16} />
              </button>
            </div>
            <div className="p-4 flex flex-col gap-2">
              {NC_THEMES.map(theme => (
                <button
                  key={theme.id}
                  onClick={() => setColorScheme(theme.id)}
                  className={`flex items-center gap-4 w-full px-4 py-3 rounded-xl border transition-all ${
                    colorScheme === theme.id
                      ? ''
                      : ''
                  }`}
                  style={colorScheme === theme.id
                    ? {
                        borderColor: `color-mix(in srgb, ${t.indigo} 40%, ${t.b2})`,
                        backgroundColor: `color-mix(in srgb, ${t.indigo} 12%, ${t.card})`,
                      }
                    : {
                        borderColor: t.b0,
                        backgroundColor: 'transparent',
                      }}
                >
                  {/* Swatch: mini preview of the actual UI in that theme */}
                  <span
                    className="w-10 h-10 rounded-xl flex-none border border-white/15 shadow-lg overflow-hidden relative"
                    style={{ background: theme.swatch }}
                  >
                    {/* Mini UI chrome lines — use actual theme token colours */}
                    <span className="absolute inset-x-0 top-0 h-[35%]" style={{ background: theme.tokens.hdr }} />
                    <span className="absolute left-0 top-[35%] bottom-0 w-[28%]" style={{ background: theme.tokens.card }} />
                  </span>
                  <span className="flex flex-col items-start gap-1">
                    <span className="text-sm font-black" style={{ color: t.t1 }}>{theme.label}</span>
                    <span className="text-[11px]" style={{ color: t.t3 }}>{theme.desc}</span>
                  </span>
                  <span className={`ml-auto w-2 h-2 rounded-full flex-none transition-opacity ${
                    colorScheme === theme.id ? 'opacity-100' : 'opacity-0'
                  }`} style={{ backgroundColor: t.indigo }} />
                </button>
              ))}
            </div>
            <div className="px-5 py-3 border-t text-[9px] uppercase tracking-widest" style={{ borderColor: t.b1, color: t.t4 }}>
              Click anywhere outside to close
            </div>
          </div>
        </div>,
        document.body
      )}

      {showShortcuts && createPortal(
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center"
          onPointerDown={() => setShowShortcuts(false)}
        >
          {/* Backdrop */}
          <div className="absolute inset-0 nc-modal-backdrop" />

          {/* Panel */}
          <div
            className="relative z-10 w-full max-w-md mx-4 rounded-2xl border shadow-2xl overflow-hidden"
            onPointerDown={e => e.stopPropagation()}
            style={{ backgroundColor: t.cardDeep, borderColor: t.b1 }}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: t.b1 }}>
              <div className="flex items-center gap-2">
                <HelpCircle size={16} style={{ color: t.indigo }} />
                <span className="text-sm font-black uppercase tracking-widest" style={{ color: t.t1 }}>Keyboard Shortcuts</span>
              </div>
              <button
                onClick={() => setShowShortcuts(false)}
                className="transition-colors"
                style={{ color: t.t3 }}
              >
                <X size={16} />
              </button>
            </div>

            <div className="p-5 grid grid-cols-2 gap-x-6 gap-y-5 max-h-[70vh] overflow-y-auto">
              {SEQ_TUTORIAL_SECTIONS.map(section => (
                <div key={section.title}>
                  <div className="text-[9px] font-black uppercase tracking-widest mb-2" style={{ color: t.t3 }}>
                    {section.title}
                  </div>
                  <div className="flex flex-col gap-1.5">
                    {section.rows.map(row => (
                      <div key={row.display} className="flex items-center justify-between gap-3">
                        <span
                          className="text-[10px] font-black px-1.5 py-0.5 rounded shrink-0 tabular-nums border"
                          style={{ backgroundColor: t.tint, borderColor: t.b1, color: t.t2 }}
                        >
                          {row.display}
                        </span>
                        <span className="text-[10px] text-right leading-tight" style={{ color: t.t3 }}>
                          {row.hint}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <div className="px-5 py-3 border-t text-[9px] leading-relaxed" style={{ borderColor: t.b1, color: t.t3 }}>
              <span className="uppercase tracking-widest">Transport &amp; track shortcuts</span> (0, ←, →, 1–9, M) fire only when mouse is <span className="italic">outside</span> the pad — the pad has its own shortcuts.
            </div>
          </div>
        </div>,
        document.body
      )}

      <style>{`
        .app-shell {
          user-select: none;
          -webkit-user-select: none;
          -webkit-touch-callout: none;
        }
        .app-shell input,
        .app-shell textarea {
          user-select: text;
          -webkit-user-select: text;
          -webkit-touch-callout: default;
        }
        .custom-scrollbar::-webkit-scrollbar { width: 3px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #1e293b; border-radius: 10px; }
        input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; height: 10px; width: 10px; border-radius: 50%; background: var(--thumb-color, #6366f1); cursor: pointer; border: 2px solid #000; box-shadow: 0 0 10px var(--thumb-color, #6366f1); }
        .nc-modal-backdrop {
          background: rgba(0, 0, 0, 0.42);
          backdrop-filter: blur(4px);
          -webkit-backdrop-filter: blur(4px);
        }

        /* =============================================================
           THEME-ADAPTIVE CSS
           All Tailwind utility classes are remapped to CSS custom-property
           tokens injected on the root element via data-theme="<id>".
           To add any new theme (dark or light), define one NcTokens object —
           no extra CSS rules are ever needed.
           ============================================================= */

        /* ── Text hierarchy ── */
        [data-theme] .text-white, [data-theme] .text-slate-100 { color: var(--nc-t1) !important; }
        [data-theme] .text-slate-200, [data-theme] .text-slate-300 { color: var(--nc-t2) !important; }
        [data-theme] .text-slate-400, [data-theme] .text-slate-500 { color: var(--nc-t3) !important; }
        [data-theme] .text-slate-600, [data-theme] .text-slate-700 { color: var(--nc-t4) !important; }
        [data-theme] .text-slate-800, [data-theme] .text-slate-900, [data-theme] .text-black { color: var(--nc-t2) !important; }
        /* Accent text */
        [data-theme] .text-indigo-400, [data-theme] .text-indigo-500 { color: var(--nc-indigo) !important; }
        [data-theme] .text-indigo-300, [data-theme] .text-indigo-800 { color: var(--nc-indigo) !important; }
        [data-theme] .text-emerald-400, [data-theme] .text-emerald-500 { color: var(--nc-emerald) !important; }
        [data-theme] .text-cyan-400 { color: var(--nc-cyan) !important; }
        [data-theme] .text-red-400, [data-theme] .text-red-500 { color: var(--nc-red) !important; }
        [data-theme] .text-amber-500 { color: var(--nc-red) !important; }
        [data-theme] .text-teal-300, [data-theme] .text-teal-600 { color: var(--nc-emerald) !important; }
        [data-theme] .text-violet-300 { color: var(--nc-indigo) !important; }
        [data-theme] [class~="text-indigo-400/40"] { color: color-mix(in srgb, var(--nc-indigo) 40%, transparent) !important; }
        [data-theme] [class~="text-emerald-400/40"] { color: color-mix(in srgb, var(--nc-emerald) 40%, transparent) !important; }
        [data-theme] [class~="text-red-400/40"] { color: color-mix(in srgb, var(--nc-red) 40%, transparent) !important; }
        [data-theme] [class~="text-cyan-400/40"] { color: color-mix(in srgb, var(--nc-cyan) 40%, transparent) !important; }

        /* ── Protect white text inside explicit dark accent buttons ──
           Must include [data-theme] to match the specificity (0,2,0) of the
           text-hierarchy rules above, then win by source-order tiebreak.      */
        [data-theme] [class*="bg-indigo-6"],
        [data-theme] [class*="bg-indigo-6"] * { color: white !important; }
        [data-theme] [class*="bg-red-6"],
        [data-theme] [class*="bg-red-6"] * { color: white !important; }
        [data-theme] [class*="bg-emerald-6"],
        [data-theme] [class*="bg-emerald-6"] * { color: white !important; }
        [data-theme] [class*="bg-amber-6"],
        [data-theme] [class*="bg-amber-6"] * { color: white !important; }
        [data-theme] [class*="bg-violet-6"],
        [data-theme] [class*="bg-violet-6"] * { color: white !important; }
        [data-theme] [class*="bg-cyan-6"],
        [data-theme] [class*="bg-cyan-6"] * { color: white !important; }

        /* ── Backgrounds: semantic tiers for shared Tailwind utilities ── */
        [data-theme] [class~="bg-black/40"]     { background-color: var(--nc-panel)     !important; }
        [data-theme] [class~="bg-black/70"]     { background-color: color-mix(in srgb, var(--nc-bg) 60%, black) !important; }
        [data-theme] [class~="bg-black/95"]     { background-color: color-mix(in srgb, var(--nc-bg) 25%, black) !important; }
        [data-theme] [class~="bg-slate-950/95"] { background-color: var(--nc-card-deep) !important; }
        [data-theme] [class~="bg-slate-900/40"] { background-color: var(--nc-panel)     !important; }
        [data-theme] [class~="bg-slate-900/50"] { background-color: var(--nc-toolbar)   !important; }
        [data-theme] [class~="bg-slate-900/95"] { background-color: var(--nc-card-deep) !important; }
        [data-theme] [class~="bg-white/5"]      { background-color: var(--nc-tint)      !important; }
        [data-theme] [class~="bg-white/10"]     { background-color: color-mix(in srgb, var(--nc-tint) 160%, white) !important; }
        [data-theme] [class*="bg-black/"]       { background-color: var(--nc-card)      !important; }
        [data-theme] [class*="bg-slate-950/"]   { background-color: var(--nc-card-deep) !important; }
        [data-theme] [class*="bg-slate-900/"]   { background-color: var(--nc-card)      !important; }
        [data-theme] [class*="bg-white/"]       { background-color: var(--nc-tint)      !important; }
        /* Accent tints — higher specificity via [class~=], override catch-alls above */
        [data-theme] [class~="bg-indigo-500/5"]   { background-color: color-mix(in srgb, var(--nc-indigo)  5%, transparent) !important; }
        [data-theme] [class~="bg-indigo-500/10"]  { background-color: color-mix(in srgb, var(--nc-indigo) 10%, transparent) !important; }
        [data-theme] [class~="bg-indigo-500/20"]  { background-color: color-mix(in srgb, var(--nc-indigo) 18%, transparent) !important; }
        [data-theme] [class~="bg-emerald-500/10"],
        [data-theme] [class~="bg-emerald-500/20"] { background-color: color-mix(in srgb, var(--nc-emerald) 12%, transparent) !important; }
        [data-theme] [class~="bg-red-500/10"]     { background-color: color-mix(in srgb, var(--nc-red)      10%, transparent) !important; }
        [data-theme] [class~="bg-cyan-500/10"]    { background-color: color-mix(in srgb, var(--nc-cyan)     10%, transparent) !important; }
        [data-theme] [class~="bg-amber-500/20"]   { background-color: color-mix(in srgb, var(--nc-red)      12%, transparent) !important; }
        /* Opaque Tailwind bg classes → inset token */
        [data-theme] .bg-black      { background-color: var(--nc-inset)     !important; }
        [data-theme] .bg-slate-900  { background-color: var(--nc-inset)     !important; }
        [data-theme] .bg-slate-800  { background-color: var(--nc-card-deep) !important; }

        /* ── Borders: slash-variant catch-alls ── */
        [data-theme] [class~="border-white/5"]  { border-color: var(--nc-b0) !important; }
        [data-theme] [class~="border-white/8"]  { border-color: var(--nc-b1) !important; }
        [data-theme] [class~="border-white/10"] { border-color: var(--nc-b1) !important; }
        [data-theme] [class~="border-white/15"] { border-color: var(--nc-b2) !important; }
        [data-theme] [class~="border-white/20"] { border-color: var(--nc-b2) !important; }
        [data-theme] [class~="border-white/25"] { border-color: var(--nc-b3) !important; }
        [data-theme] [class*="border-white/"] { border-color: var(--nc-b1) !important; }
        /* Accent borders */
        [data-theme] [class~="border-indigo-500/10"],
        [data-theme] [class~="border-indigo-500/20"],
        [data-theme] [class~="border-indigo-500/30"],
        [data-theme] [class~="border-indigo-500/50"] { border-color: color-mix(in srgb, var(--nc-indigo)  30%, transparent) !important; }
        [data-theme] [class~="border-indigo-400/20"] { border-color: color-mix(in srgb, var(--nc-indigo)  25%, transparent) !important; }
        [data-theme] [class~="border-emerald-500/20"]{ border-color: color-mix(in srgb, var(--nc-emerald) 28%, transparent) !important; }
        [data-theme] [class~="border-red-500/20"]    { border-color: color-mix(in srgb, var(--nc-red)     28%, transparent) !important; }
        [data-theme] [class~="border-cyan-500/20"],
        [data-theme] [class~="border-cyan-500/50"]   { border-color: color-mix(in srgb, var(--nc-cyan)    30%, transparent) !important; }
        [data-theme] [class~="border-teal-700/40"]   { border-color: color-mix(in srgb, var(--nc-emerald) 35%, transparent) !important; }

        /* ── 1px dividers ── */
        [data-theme] .w-px { background-color: var(--nc-b2) !important; }

        /* ── Scrollbar ── */
        [data-theme] .custom-scrollbar::-webkit-scrollbar-thumb { background: var(--nc-t4); border-radius: 10px; }

        /* ── Range inputs ── */
        [data-theme] input[type=range] { accent-color: var(--nc-indigo); }
        [data-theme] input[type=range]::-webkit-slider-thumb { border: 2px solid var(--nc-hdr); }

        /* ── Semantic utility classes (NC-specific patterns) ── */
        .nc-border  { border-color: var(--nc-b1) !important; }
        .nc-toolbar-btn {
          background-color: var(--nc-panel);
          border: 1px solid var(--nc-b0);
          color: var(--nc-t3);
        }
        .nc-toolbar-btn:hover:not(:disabled) {
          background-color: color-mix(in srgb, var(--nc-panel) 72%, var(--nc-card));
          color: var(--nc-t2);
        }
        .nc-toolbar-btn:disabled {
          color: var(--nc-t4);
        }
        .nc-input::placeholder { color: var(--nc-input-ph, var(--nc-t4)); }
        .nc-sample-btn {
          background-color: var(--nc-sample-btn) !important;
          color: var(--nc-sample-btn-text) !important;
          border-color: var(--nc-b1) !important;
        }
        .nc-sample-btn:hover {
          background-color: var(--nc-sample-btn-hov) !important;
          color: var(--nc-sample-btn-hov-text) !important;
        }
        .nc-glass-btn {
          background-color: var(--nc-glass-bg) !important;
          border-color: var(--nc-glass-border) !important;
          color: var(--nc-glass-text) !important;
        }
      `}</style>
    </div>
  );
};

export default App;
