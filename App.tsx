
import {
  Activity,
  ArrowLeftRight,
  ArrowUpDown,
  ClipboardPaste,
  Copy,
  Cpu,
  Disc,
  Download,
  Gauge,
  HelpCircle,
  Loader2,
  Mic,
  Minus,
  Music,
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
  Zap
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
import { CompositionState, MidiEvent, MusicGenre, SYNTH_PRESETS, SynthConfig, SynthWaveType } from './types';

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
  SELECT_ALL: { display: `${_MOD}A`,     hint: 'Select all notes' },
  COPY:       { display: `${_MOD}C`,     hint: 'Copy selection' },
  CUT:        { display: `${_MOD}X`,     hint: 'Cut selection' },
  PASTE:      { display: `${_MOD}V`,     hint: 'Paste at playhead' },
  UNDO:       { display: `${_MOD}Z`,     hint: 'Undo' },
  REDO:       { display: `${_MOD}⇧Z`,    hint: 'Redo' },
  REDO_ALT:   { display: `${_MOD}Y`,     hint: 'Redo (alt)' },
  DELETE:     { display: 'Del / ⌫',      hint: 'Delete selected notes' },
  PLAY_PAUSE: { display: 'Space',         hint: 'Play / Pause' },
} as const;

/** Grouped sections shown in the sequencer shortcuts modal. */
const SEQ_TUTORIAL_SECTIONS: { title: string; rows: { display: string; hint: string }[] }[] = [
  { title: 'Playback',   rows: [KB_SEQ.PLAY_PAUSE] },
  { title: 'Selection',  rows: [KB_SEQ.SELECT_ALL] },
  { title: 'Clipboard',  rows: [KB_SEQ.COPY, KB_SEQ.CUT, KB_SEQ.PASTE, KB_SEQ.DELETE] },
  { title: 'History',    rows: [KB_SEQ.UNDO, KB_SEQ.REDO, KB_SEQ.REDO_ALT] },
];
// ---------------------------------------------------------------------------

interface ValidationError {
  message: string;
  index: number;
}

interface AppEvent {
  event: MidiEvent;
  beatOffset: number;
  id: string;
  isUser?: boolean;
  comment?: string;
}

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

  const [synthConfig, setSynthConfig] = useState<SynthConfig>(SYNTH_PRESETS["Grand Piano"]);

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

  const [selectedEventIds, setSelectedEventIds] = useState<string[]>([]);
  const [selectionMarquee, setSelectionMarquee] = useState<SelectionBounds | null>(null);
  const [clipboard, setClipboard] = useState<{ event: MidiEvent; relativeBeat: number; comment?: string }[]>([]);

  const [history, setHistory] = useState<{ past: typeof events[], future: typeof events[] }>({ past: [], future: [] });

  const [isAIStreamActive, setIsAIStreamActive] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
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
      alert('Failed to load sample');
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

      // Skip empty lines (but keep pending comments)
      if (!trimmedLine) return;

      const codePart = line.split('#')[0];

      // If line contains only comments or whitespace
      if (!codePart.trim()) return;

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

  useEffect(() => {
    audioEngine.updateConfig(synthConfig);
  }, [synthConfig]);

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
          isUser: true as const,
        })),
      ];
    });
    setSelectedEventIds(newIds);
    setMainTab('sequencer');
  }, [pushHistory]);

  const generateNextStream = async () => {
    if (!isAIStreamActive || isGeneratingRef.current) return;
    if (!apiKey) {
      setIsAIStreamActive(false);
      alert('Please enter your Gemini API Key in the top bar to continue.');
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
      alert(`Generation failed: ${e instanceof Error ? e.message : 'Unknown error'}. Please check your API Key.`);
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

        events.forEach(item => {
          const absoluteStart = item.beatOffset + item.event.t;
          if (absoluteStart >= currentBeat - 0.2 && absoluteStart < currentBeat + 0.5) {
            if (!scheduledNoteIds.current.has(item.id)) {
              audioEngine.scheduleNote(item.event, absoluteStart, currentBeat, state.legatoMode);
              scheduledNoteIds.current.add(item.id);
            }
          }
        });
      }
      animationId = requestAnimationFrame(tick);
    };
    animationId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animationId);
  }, [state.isPlaying, events, state.tempo, state.legatoMode, isAIStreamActive]);

  const parseAndStore = (textChunk: string, baseBeatOffset: number) => {
    streamBufferRef.current += textChunk;
    setRawStream(prev => (prev + textChunk).slice(-800));
    const regex = /\[\s*P:\s*([\d.]+)\s*,\s*V:\s*(\d+)\s*,\s*T:\s*([\d.]+)\s*,\s*D:\s*([\d.]+)\s*\]/g;
    let match;
    const newMidiEvents: AppEvent[] = [];
    while ((match = regex.exec(streamBufferRef.current)) !== null) {
      const event: MidiEvent = { p: parseFloat(match[1]), v: parseInt(match[2]), t: parseFloat(match[3]), d: parseFloat(match[4]) };
      newMidiEvents.push({ event, beatOffset: baseBeatOffset, id: `note-${baseBeatOffset}-${match.index}-${event.p}` });
    }
    if (newMidiEvents.length > 0) {
      streamBufferRef.current = streamBufferRef.current.replace(/\[\s*P:\s*[\d.]+\s*,\s*V:\s*\d+\s*,\s*T:\s*[\d.]+\s*,\s*D:\s*[\d.]+\s*\]/g, "");
      setEvents(prev => [...prev, ...newMidiEvents]);
    }
  };

  const handleInitializeAI = async () => {
    audioEngine.init();
    audioEngine.setTempo(state.tempo);
    audioEngine.updateConfig(synthConfig);
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
    const newEvents = validation.validEvents.map((item, idx) => ({
      event: item.event,
      beatOffset: baseOffset,
      id: `user-${baseOffset}-${idx}-${Date.now()}`,
      isUser: true,
      comment: item.comment
    }));
    setEvents(prev => [...prev, ...newEvents]);
    setUserInput("");
  };

  const handleDownload = () => {
    const sortedEvents = [...events].sort((a, b) => (a.beatOffset + a.event.t) - (b.beatOffset + b.event.t));
    let output = `# Neural Composer Export\n# Genre: ${state.genre}\n# Tempo: ${state.tempo}\n# Date: ${new Date().toLocaleString()}\n\n`;
    sortedEvents.forEach(e => {
       if (e.comment) output += `\n${e.comment}\n`;
       output += `[P:${e.event.p},V:${e.event.v},T:${(e.beatOffset + e.event.t).toFixed(3)},D:${e.event.d.toFixed(3)}]\n`;
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
      comment: item.comment
    }));
    setClipboard(clipboardData);
    const clipboardText = clipboardData.map(item =>
      `${item.comment ? `\n${item.comment}\n` : ''}[P:${item.event.p},V:${item.event.v},T:${item.relativeBeat.toFixed(3)},D:${item.event.d.toFixed(3)}]`
    ).join(' ');
    navigator.clipboard.writeText(clipboardText).catch(err => console.error(err));
  }, [selectedEventIds, events]);

  const handleCut = useCallback(() => {
    if (selectedEventIds.length === 0) return;
    pushHistory(events);
    handleCopy();
    setEvents(prev => prev.filter(item => !selectedEventIds.includes(item.id)));
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
      isUser: true,
      comment: item.comment
    }));
    setEvents(prev => [...prev, ...newEvents]);
    setSelectedEventIds(newEvents.map(e => e.id));
  }, [clipboard, events, pushHistory]);

  const handleDelete = useCallback(() => {
    if (selectedEventIds.length === 0) return;
    pushHistory(events);
    setEvents(prev => prev.filter(item => !selectedEventIds.includes(item.id)));
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
  };

  const handleTestNote = () => {
    audioEngine.init();
    audioEngine.updateConfig(synthConfig);
    audioEngine.scheduleNote(testNote, 0, 0);
  };

  const bufferRemaining = Math.max(0, beatsGeneratedRef.current - playbackBeat);
  const totalViewRange = Math.max(beatsGeneratedRef.current, playbackBeat + 32, 128);

  const updateSynth = (key: keyof SynthConfig, val: any) => {
    setSynthConfig(prev => ({ ...prev, [key]: val }));
  };

  // Keyboard Shortcuts Effect
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;

      // Prevent triggering shortcuts when typing in inputs/textareas
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;

      if (e.ctrlKey || e.metaKey) {
        switch (e.key.toLowerCase()) {
          case 'x':
            e.preventDefault();
            handleCut();
            break;
          case 'a':
            e.preventDefault();
            handleSelectAll();
            break;
          case 'c':
            e.preventDefault();
            handleCopy();
            break;
          case 'v':
            e.preventDefault();
            handlePaste();
            break;
          case 'z':
            e.preventDefault();
            if (e.shiftKey) redo();
            else undo();
            break;
          case 'y':
            e.preventDefault();
            redo();
            break;
        }
      } else {
        if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault();
          handleDelete();
        }
        if (e.key === ' ' && target.tagName !== 'BUTTON') {
           e.preventDefault();
           togglePlayback();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleCut, handleCopy, handlePaste, handleDelete, handleSelectAll, undo, redo, togglePlayback]);

  const waveOptions: SynthWaveType[] = ['sine', 'square', 'sawtooth', 'triangle'];

  return (
    <div className="app-shell flex flex-col w-full min-h-screen lg:h-screen bg-[#020408] overflow-x-hidden lg:overflow-hidden text-slate-300 font-sans selection:bg-indigo-500/30">
      <header className="flex-none flex flex-col md:flex-row justify-between items-center gap-4 p-4 lg:p-6 border-b border-white/5 bg-[#020408]">
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

        <div className="flex gap-3 items-center flex-wrap justify-center bg-slate-900/50 backdrop-blur-xl p-2 rounded-2xl border border-white/5">
          <div className="flex items-center gap-1 bg-slate-900/50 p-1 rounded-xl border border-white/5 mr-2">
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

          <div className="flex items-center bg-black rounded-xl border border-white/5 p-1 mr-1">
             <div className="px-2 border-r border-white/10 flex items-center gap-2 mr-1">
                <Gauge size={14} className="text-slate-600" />
                <span className="text-[10px] font-black text-slate-600 hidden xl:inline">BPM</span>
             </div>
             <button onClick={() => updateBpm(state.tempo - 1)} className="w-6 h-8 flex items-center justify-center hover:bg-white/10 rounded-lg text-slate-500 hover:text-indigo-400"><Minus size={12} /></button>
             <input type="number" value={tempBpm} onChange={(e) => setTempBpm(e.target.value)} onBlur={() => updateBpm(parseInt(tempBpm) || 120)} className="w-10 bg-transparent text-sm font-bold text-white text-center focus:outline-none" />
             <button onClick={() => updateBpm(state.tempo + 1)} className="w-6 h-8 flex items-center justify-center hover:bg-white/10 rounded-lg text-slate-500 hover:text-indigo-400"><Plus size={12} /></button>
          </div>

          <div className="flex items-center gap-1 bg-black rounded-xl border border-white/5 p-1">
             <button title="Toggle Legato Mode" onClick={() => setState(s => ({ ...s, legatoMode: !s.legatoMode }))} className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-bold border transition-colors ${state.legatoMode ? 'bg-indigo-500/20 text-indigo-400 border-indigo-500/50' : 'bg-transparent text-slate-500 border-transparent hover:bg-white/5'}`}>
               <Waves size={14} /> Legato
             </button>
          </div>

          <button onClick={() => navigate('/converter')} className="flex items-center gap-1 sm:gap-2 bg-black text-xs font-bold text-cyan-400 border border-cyan-500/20 hover:bg-cyan-500/10 hover:border-cyan-500/50 rounded-xl px-3 sm:px-4 py-2.5 transition-all shadow-lg shadow-cyan-500/10">
            <Mic size={14} /> <span className="sm:hidden">MIC</span><span className="hidden sm:inline">VOICE</span>
          </button>

          <div className="relative group">
            <input
              type="password"
              placeholder="Gemini API Key"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="bg-black border border-white/5 text-xs font-bold rounded-xl px-4 py-2.5 w-32 focus:w-64 transition-all focus:outline-none focus:border-indigo-500/50 text-white placeholder:text-slate-600"
            />
          </div>

          <select className="bg-black border-none text-xs font-bold rounded-xl px-4 py-2.5 cursor-pointer hover:bg-slate-900" value={state.genre} onChange={(e) => setState(s => ({ ...s, genre: e.target.value }))}>
            {Object.values(MusicGenre).map(g => (<option key={g} value={g}>{g}</option>))}
          </select>
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
        </div>
      </header>

      <main className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-12 gap-6 p-4 lg:p-6 pt-0 lg:pt-0">
        <div className="lg:col-span-9 flex flex-col gap-4 min-h-0">
          {/* Both panels stay mounted at all times so their internal state is preserved across tab switches.
              Visibility is toggled purely with CSS (hidden / contents). */}
          <div className={mainTab === 'performance' ? 'flex-1 flex flex-col min-h-0' : 'hidden'}>
            <PerformancePad
              bpm={state.tempo}
              onCommitRecording={handleCommitRecording}
              onRecordingStart={() => { recordingStartBeatRef.current = playbackBeatRef.current; }}
              onStartPlayback={() => {
                audioEngine.init();
                isPausedRef.current = false;
                setIsPaused(false);
                setState(s => ({ ...s, isPlaying: true }));
              }}
            />
          </div>
          <div className={mainTab === 'sequencer' ? 'contents' : 'hidden'}>
          <div className="relative flex-1 min-h-[350px] border border-white/5 rounded-3xl overflow-hidden bg-black shadow-inner">
            <PianoRoll events={events} currentBeat={playbackBeat} selectedNoteIds={selectedEventIds} selectionMarquee={selectionMarquee} onSeek={handleSeek} onSelectionMarqueeChange={setSelectionMarquee} onSelectNotes={setSelectedEventIds} onMoveSelection={handleMoveSelection} />
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
          <div className="flex-none flex flex-wrap items-center gap-1 bg-slate-900/60 backdrop-blur-md border border-white/5 rounded-2xl px-2 py-1.5">
            <button onClick={undo} disabled={history.past.length === 0} className="flex items-center gap-1.5 px-3 py-1.5 disabled:opacity-30 hover:bg-white/5 text-slate-400 rounded-xl text-[10px] font-black uppercase transition-colors"><Undo size={14} /> Undo</button>
            <button onClick={redo} disabled={history.future.length === 0} className="flex items-center gap-1.5 px-3 py-1.5 disabled:opacity-30 hover:bg-white/5 text-slate-400 rounded-xl text-[10px] font-black uppercase transition-colors"><Redo size={14} /> Redo</button>
            <div className="w-px h-5 bg-white/10 mx-1" />
            <button onClick={handleSelectAll} disabled={events.length === 0} className="flex items-center gap-1.5 px-3 py-1.5 disabled:opacity-30 hover:bg-indigo-500/10 text-slate-400 hover:text-indigo-400 rounded-xl text-[10px] font-black uppercase transition-colors"><Copy size={14} /> All</button>
            {selectedEventIds.length > 0 && (
              <>
                <button onClick={handleCopy} className="flex items-center gap-1.5 px-3 py-1.5 hover:bg-indigo-500/10 text-indigo-400 rounded-xl text-[10px] font-black uppercase transition-colors"><Copy size={14} /> Copy</button>
                <button onClick={handleCut} className="flex items-center gap-1.5 px-3 py-1.5 hover:bg-red-500/10 text-red-400 rounded-xl text-[10px] font-black uppercase transition-colors"><Scissors size={14} /> Cut</button>
                <button onClick={handleDelete} className="flex items-center gap-1.5 px-3 py-1.5 hover:bg-red-500/10 text-red-400 rounded-xl text-[10px] font-black uppercase transition-colors"><Trash2 size={14} /> Del</button>
                <button onClick={() => setSelectedEventIds([])} className="flex items-center gap-1.5 px-2 py-1.5 hover:bg-white/5 text-slate-600 hover:text-slate-400 rounded-xl transition-colors"><X size={14} /></button>
              </>
            )}
            {clipboard.length > 0 && (
              <button onClick={handlePaste} className="flex items-center gap-1.5 px-3 py-1.5 hover:bg-emerald-500/10 text-emerald-400 rounded-xl text-[10px] font-black uppercase transition-colors"><ClipboardPaste size={14} /> Paste</button>
            )}
            <div className="ml-auto" />
            {selectedEventIds.length > 0 && (
              <span className="text-[9px] text-slate-600 font-black uppercase mr-2">{selectedEventIds.length} selected</span>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 min-h-[12rem] flex-none">
            <div className="bg-slate-950/50 rounded-2xl border border-white/5 p-4 font-mono text-[10px] flex flex-col overflow-hidden">
               <div className="flex items-center gap-2 text-slate-500 uppercase font-black mb-2 border-b border-white/5 pb-1"><Terminal size={12} /> Neural Stream</div>
               <div className="flex-1 text-indigo-400/40 break-all overflow-y-auto custom-scrollbar italic leading-relaxed">{rawStream || "Standby..."}</div>
            </div>
            <div className="bg-slate-950/80 rounded-2xl border border-indigo-500/10 p-4 flex flex-col overflow-hidden group hover:border-indigo-500/30 transition-all">
               <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2 text-indigo-400 uppercase font-black text-[10px]"><Cpu size={12} /> Manual Patch Bay</div>
                  <button
                    onClick={handleInjectUserNotes}
                    disabled={validation.validEvents.length === 0 || validation.errors.length > 0}
                    className={`px-3 py-1 rounded-lg font-black text-[9px] uppercase flex items-center gap-1 transition-all ${
                      validation.validEvents.length > 0 && validation.errors.length === 0
                        ? 'bg-indigo-600 text-white hover:bg-indigo-500 shadow-lg shadow-indigo-500/20'
                        : 'bg-slate-800 text-slate-600 cursor-not-allowed border border-white/5'
                    }`}
                  >
                    <PlusCircle size={10} /> Inject
                  </button>
               </div>

               {/* Signal transform toolbar */}
               <div className="flex flex-wrap gap-1 mb-2 pb-2 border-b border-white/5">
                 {/* Time */}
                 <span className="text-[8px] font-black text-slate-600 uppercase self-center mr-0.5">T</span>
                 <button onClick={patchTransforms.reverseTime} title="Reverse time: reflects every note's start time so T → (totalDuration − T − D). The last note becomes the first; the sequence plays backwards. Durations are unchanged." className="flex items-center gap-0.5 px-1.5 py-0.5 rounded-md bg-slate-900 hover:bg-indigo-500/20 hover:text-indigo-300 text-slate-400 text-[8px] font-black border border-white/5 transition-colors">
                   <ArrowLeftRight size={9} /> Rev
                 </button>
                 <button onClick={() => patchTransforms.stretchTime(2)} title="Stretch ×2: multiplies every T and D by 2. Notes are twice as far apart and twice as long — same melody, half the tempo." className="px-1.5 py-0.5 rounded-md bg-slate-900 hover:bg-indigo-500/20 hover:text-indigo-300 text-slate-400 text-[8px] font-black border border-white/5 transition-colors">×2</button>
                 <button onClick={() => patchTransforms.stretchTime(0.5)} title="Compress ×½: multiplies every T and D by 0.5. Notes are half as far apart and half as long — same melody, double the tempo." className="px-1.5 py-0.5 rounded-md bg-slate-900 hover:bg-indigo-500/20 hover:text-indigo-300 text-slate-400 text-[8px] font-black border border-white/5 transition-colors">×½</button>
                 <button onClick={() => patchTransforms.quantize(0.25)} title="Quantize to ¼ beat: snaps every T to the nearest 0.25-beat grid and rounds D up to the nearest 0.25. Tightens loose timing to 16th-note resolution." className="px-1.5 py-0.5 rounded-md bg-slate-900 hover:bg-indigo-500/20 hover:text-indigo-300 text-slate-400 text-[8px] font-black border border-white/5 transition-colors">Q¼</button>
                 <button onClick={() => patchTransforms.quantize(0.5)} title="Quantize to ½ beat: snaps every T to the nearest 0.5-beat grid and rounds D up to the nearest 0.5. Tightens loose timing to 8th-note resolution." className="px-1.5 py-0.5 rounded-md bg-slate-900 hover:bg-indigo-500/20 hover:text-indigo-300 text-slate-400 text-[8px] font-black border border-white/5 transition-colors">Q½</button>
                 <div className="w-px h-4 bg-white/10 self-center mx-0.5" />
                 {/* Pitch */}
                 <span className="text-[8px] font-black text-slate-600 uppercase self-center mr-0.5">P</span>
                 <button onClick={patchTransforms.invertPitch} title="Invert pitch: mirrors every note around the midpoint of the sequence's pitch range. P → (minP + maxP − P). A rising melody becomes falling; intervals are preserved in size but flipped in direction." className="flex items-center gap-0.5 px-1.5 py-0.5 rounded-md bg-slate-900 hover:bg-violet-500/20 hover:text-violet-300 text-slate-400 text-[8px] font-black border border-white/5 transition-colors">
                   <ArrowUpDown size={9} /> Inv
                 </button>
                 <button onClick={() => patchTransforms.widenPitch(1.5)} title="Widen ×1.5: scales every pitch away from the range's centre by 1.5×. Intervals grow larger — a minor 3rd becomes roughly a tritone. Clamps to 0–127." className="px-1.5 py-0.5 rounded-md bg-slate-900 hover:bg-violet-500/20 hover:text-violet-300 text-slate-400 text-[8px] font-black border border-white/5 transition-colors">Wide</button>
                 <button onClick={() => patchTransforms.widenPitch(1/1.5)} title="Narrow ÷1.5: scales every pitch toward the range's centre by ÷1.5. Intervals shrink — a major 6th becomes roughly a major 3rd. Useful to compress dramatic leaps." className="px-1.5 py-0.5 rounded-md bg-slate-900 hover:bg-violet-500/20 hover:text-violet-300 text-slate-400 text-[8px] font-black border border-white/5 transition-colors">Narr</button>
                 <button onClick={() => patchTransforms.transpose(1)} title="Transpose +1 semitone: adds 1 to every P (e.g. C4→C#4). Clamps at 127." className="px-1.5 py-0.5 rounded-md bg-slate-900 hover:bg-violet-500/20 hover:text-violet-300 text-slate-400 text-[8px] font-black border border-white/5 transition-colors">+1</button>
                 <button onClick={() => patchTransforms.transpose(-1)} title="Transpose −1 semitone: subtracts 1 from every P (e.g. C4→B3). Clamps at 0." className="px-1.5 py-0.5 rounded-md bg-slate-900 hover:bg-violet-500/20 hover:text-violet-300 text-slate-400 text-[8px] font-black border border-white/5 transition-colors">−1</button>
                 <button onClick={() => patchTransforms.transpose(12)} title="Transpose +1 octave: adds 12 to every P. Same notes, one octave higher. Clamps at 127." className="px-1.5 py-0.5 rounded-md bg-slate-900 hover:bg-violet-500/20 hover:text-violet-300 text-slate-400 text-[8px] font-black border border-white/5 transition-colors">+8ve</button>
                 <button onClick={() => patchTransforms.transpose(-12)} title="Transpose −1 octave: subtracts 12 from every P. Same notes, one octave lower. Clamps at 0." className="px-1.5 py-0.5 rounded-md bg-slate-900 hover:bg-violet-500/20 hover:text-violet-300 text-slate-400 text-[8px] font-black border border-white/5 transition-colors">−8ve</button>
                 <div className="w-px h-4 bg-white/10 self-center mx-0.5" />
                 {/* Velocity */}
                 <span className="text-[8px] font-black text-slate-600 uppercase self-center mr-0.5">V</span>
                 <button onClick={patchTransforms.normalizeVelocity} title="Normalize velocity: linearly stretches the velocity range so the quietest note → V=10 and the loudest → V=110, preserving relative dynamics. If all notes share the same velocity (no range), every note is set to V=90." className="px-1.5 py-0.5 rounded-md bg-slate-900 hover:bg-emerald-500/20 hover:text-emerald-300 text-slate-400 text-[8px] font-black border border-white/5 transition-colors">Norm</button>
                 <button onClick={() => patchTransforms.volShift(10)} title="Volume +10: adds 10 to every velocity. Clamps at 127." className="px-1.5 py-0.5 rounded-md bg-slate-900 hover:bg-emerald-500/20 hover:text-emerald-300 text-slate-400 text-[8px] font-black border border-white/5 transition-colors">+10</button>
                 <button onClick={() => patchTransforms.volShift(-10)} title="Volume −10: subtracts 10 from every velocity. Clamps at 0." className="px-1.5 py-0.5 rounded-md bg-slate-900 hover:bg-emerald-500/20 hover:text-emerald-300 text-slate-400 text-[8px] font-black border border-white/5 transition-colors">−10</button>
               </div>
               <textarea
                  value={userInput}
                  onChange={(e) => setUserInput(e.target.value)}
                  placeholder="[P:60,V:100,T:0,D:1] where pitch: 0-127, velocity: 0-127 volume, time: relative to playback measure in beat, duration: measured in beat"
                  className={`flex-1 bg-black/40 border rounded-xl p-3 font-mono text-[11px] text-white focus:outline-none placeholder:text-slate-700 resize-none ${validation.errors.length > 0 ? 'border-red-500/40' : 'border-white/5'}`}
               />
               {validation.errors.length > 0 && (
                  <div className="mt-2 px-2 max-h-16 overflow-y-auto custom-scrollbar">
                    {validation.errors.map((err, i) => (
                      <div key={i} className="text-[9px] text-red-400 font-mono mb-0.5">• {err.message}</div>
                    ))}
                  </div>
               )}
            </div>
          </div>
          </div>
        </div>

        <div className="lg:col-span-3 flex flex-col h-full min-h-0">
          <div className="bg-slate-900/20 p-4 rounded-3xl border border-white/5 flex-1 flex flex-col overflow-hidden">
            <div className="flex gap-2 mb-6 border-b border-white/5 pb-2 flex-none">
                <button onClick={() => setRightPanelTab('session')} className={`flex-1 py-2 text-[9px] font-black uppercase tracking-widest rounded-lg transition-all ${rightPanelTab === 'session' ? 'bg-indigo-500/20 text-indigo-400' : 'text-slate-600 hover:text-slate-400'}`}>Session</button>
                <button onClick={() => setRightPanelTab('synth')} className={`flex-1 py-2 text-[9px] font-black uppercase tracking-widest rounded-lg transition-all ${rightPanelTab === 'synth' ? 'bg-indigo-500/20 text-indigo-400' : 'text-slate-600 hover:text-slate-400'}`}>Voice</button>
            </div>

            <div className="flex-1 overflow-y-auto custom-scrollbar pr-2">
            {rightPanelTab === 'session' ? (
                <div className="space-y-6">
                  <div className="p-5 bg-black/40 rounded-2xl border border-white/5">
                     <div className="text-[10px] font-bold text-slate-600 uppercase mb-2">Playhead</div>
                     <div className="text-4xl font-black text-white tabular-nums tracking-tighter mb-2">{Math.floor(playbackBeat / 4)}.<span className="text-indigo-500">{(Math.floor(playbackBeat % 4) + 1)}</span></div>
                     <TimeNavigator currentBeat={playbackBeat} totalBeats={totalViewRange} onSeek={handleSeek} />
                  </div>
                  <div className="p-5 bg-black/40 rounded-2xl border border-white/5">
                     <div className="text-[10px] font-bold text-slate-600 uppercase mb-2">Composition History</div>
                     <div className="flex items-baseline gap-1 mb-1">
                        <div className="text-3xl font-black tabular-nums tracking-tighter text-indigo-400">{events.filter(e => e.isUser).length}</div>
                        <span className="text-[10px] text-slate-700 font-black uppercase">M</span>
                        <span className="mx-2 text-slate-800">|</span>
                        <div className="text-3xl font-black tabular-nums tracking-tighter text-indigo-800">{events.filter(e => !e.isUser).length}</div>
                        <span className="text-[10px] text-slate-700 font-black uppercase">N</span>
                     </div>
                     <button onClick={handleDownload} className="w-full mt-4 py-2 bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-400 rounded-lg border border-indigo-500/20 text-[10px] font-bold uppercase"><Download size={12} className="inline mr-2" /> Export</button>
                  </div>

                  <div className="p-5 bg-black/40 rounded-2xl border border-white/5">
                     <div className="text-[10px] font-bold text-slate-600 uppercase mb-2">Sample Compositions</div>
                     <div className="space-y-2">
                        {SAMPLE_FILES.map((file) => (
                           <button
                              key={file}
                              onClick={() => loadSample(file)}
                              className="w-full py-2 px-3 bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-white rounded-lg border border-white/5 text-[10px] font-mono text-left truncate transition-colors flex items-center gap-2"
                           >
                              <Music size={12} />
                              {file}
                           </button>
                        ))}
                     </div>
                  </div>

                  <div className="mt-auto p-4 bg-indigo-500/5 rounded-2xl border border-indigo-500/10">
                     <div className="text-[9px] font-black text-indigo-400 uppercase mb-2 flex items-center gap-2"><Sparkles size={10} /> Creative Direction for AI</div>
                     <textarea value={creativeDirection} onChange={(e) => setCreativeDirection(e.target.value)} placeholder="e.g. Add erratic fills..." className="w-full bg-slate-900/50 border border-indigo-500/10 rounded-lg p-2 text-[10px] text-slate-300 h-24 focus:outline-none" />
                  </div>
                </div>
            ) : (
                <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-500">
                    <section>
                      <div className="flex flex-col gap-3 mb-4">
                        <div className="text-[10px] font-black text-slate-500 uppercase tracking-widest flex items-center gap-2"><Activity size={12}/> Analysis</div>
                        <div className="flex items-center gap-2 bg-black/40 p-1.5 rounded-xl border border-white/5">
                             <div className="grid grid-cols-3 gap-1 flex-1">
                                <div className="relative group">
                                  <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[8px] font-bold text-slate-500">P</span>
                                  <input type="number" value={testNote.p} onChange={(e) => setTestNote(curr => ({...curr, p: Math.min(127, Math.max(0, parseInt(e.target.value) || 0))}))} className="w-full bg-slate-900 border border-white/5 rounded-lg py-1 pl-5 pr-1 text-[9px] font-mono text-center focus:outline-none focus:border-indigo-500/50" />
                                </div>
                                <div className="relative group">
                                  <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[8px] font-bold text-slate-500">V</span>
                                  <input type="number" value={testNote.v} onChange={(e) => setTestNote(curr => ({...curr, v: Math.min(127, Math.max(0, parseInt(e.target.value) || 0))}))} className="w-full bg-slate-900 border border-white/5 rounded-lg py-1 pl-5 pr-1 text-[9px] font-mono text-center focus:outline-none focus:border-indigo-500/50" />
                                </div>
                                <div className="relative group">
                                  <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[8px] font-bold text-slate-500">D</span>
                                  <input type="number" step="0.1" value={testNote.d} onChange={(e) => setTestNote(curr => ({...curr, d: Math.max(0.1, parseFloat(e.target.value) || 0.1)}))} className="w-full bg-slate-900 border border-white/5 rounded-lg py-1 pl-5 pr-1 text-[9px] font-mono text-center focus:outline-none focus:border-indigo-500/50" />
                                </div>
                             </div>
                             <button
                              onClick={handleTestNote}
                              className="flex-none px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg border border-indigo-400 text-[9px] font-black uppercase transition-all active:scale-95 shadow-lg shadow-indigo-500/20"
                            >
                              <Music size={12}/>
                            </button>
                        </div>
                      </div>
                      <SynthVisualizer config={synthConfig} />

                      <div className="grid grid-cols-2 gap-2 mb-6">
                        {Object.keys(SYNTH_PRESETS).map(name => (
                          <button
                            key={name}
                            onClick={() => setSynthConfig(SYNTH_PRESETS[name])}
                            className={`px-2 py-1.5 rounded-lg text-[7px] font-black uppercase border transition-all ${JSON.stringify(synthConfig) === JSON.stringify(SYNTH_PRESETS[name]) ? 'bg-indigo-600 border-indigo-500 text-white' : 'bg-slate-900/50 border-white/5 text-slate-500 hover:text-slate-300'}`}
                          >
                            {name}
                          </button>
                        ))}
                      </div>
                    </section>

                    <section className="space-y-4 p-4 bg-black/40 rounded-2xl border border-white/5">
                        <div className="flex items-center gap-2 text-[10px] font-black text-indigo-400 uppercase tracking-widest mb-2"><Waves size={14}/> Oscillator</div>
                        <div className="grid grid-cols-2 gap-2">
                            {waveOptions.map(type => (
                                <button key={type} onClick={() => updateSynth('waveType', type)} className={`px-2 py-2 rounded-lg text-[8px] font-bold uppercase border transition-all ${synthConfig.waveType === type ? 'bg-indigo-600 border-indigo-500 text-white shadow-[0_0_10px_rgba(99,102,241,0.5)]' : 'bg-slate-900 border-slate-800 text-slate-500 hover:border-slate-700'}`}>{type}</button>
                            ))}
                        </div>
                        <div className="space-y-1">
                            <div className="flex justify-between text-[8px] font-bold text-slate-600 uppercase"><span>Detune</span><span>{synthConfig.detune}</span></div>
                            <input type="range" min="-50" max="50" value={synthConfig.detune} onChange={e => updateSynth('detune', parseInt(e.target.value))} className="w-full accent-indigo-500 h-1 bg-slate-800 rounded-full appearance-none" />
                        </div>
                    </section>

                    <section className="space-y-4 p-4 bg-black/40 rounded-2xl border border-white/5">
                        <div className="flex items-center gap-2 text-[10px] font-black text-indigo-400 uppercase tracking-widest mb-2"><SlidersHorizontal size={14}/> VCF Filter</div>
                        <div className="space-y-3">
                            <div className="space-y-1">
                                <div className="flex justify-between text-[8px] font-bold text-slate-600 uppercase"><span>Cutoff</span><span>{synthConfig.cutoff}Hz</span></div>
                                <input type="range" min="100" max="8000" value={synthConfig.cutoff} onChange={e => updateSynth('cutoff', parseInt(e.target.value))} className="w-full accent-indigo-500 h-1 bg-slate-800 rounded-full appearance-none" />
                            </div>
                            <div className="space-y-1">
                                <div className="flex justify-between text-[8px] font-bold text-slate-600 uppercase"><span>Resonance</span><span>{synthConfig.resonance.toFixed(1)}</span></div>
                                <input type="range" min="0" max="20" step="0.5" value={synthConfig.resonance} onChange={e => updateSynth('resonance', parseFloat(e.target.value))} className="w-full accent-indigo-500 h-1 bg-slate-800 rounded-full appearance-none" />
                            </div>
                        </div>
                    </section>

                    <section className="space-y-4 p-4 bg-black/40 rounded-2xl border border-white/5">
                        <div className="flex items-center gap-2 text-[10px] font-black text-indigo-400 uppercase tracking-widest mb-2"><Activity size={14}/> ADSR Envelope</div>
                        <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                            {[
                                { label: 'Attack', key: 'attack', min: 0.001, max: 2, step: 0.01 },
                                { label: 'Decay', key: 'decay', min: 0.01, max: 2, step: 0.01 },
                                { label: 'Sustain', key: 'sustain', min: 0, max: 1, step: 0.05 },
                                { label: 'Release', key: 'release', min: 0.01, max: 4, step: 0.05 },
                            ].map(p => (
                                <div key={p.key} className="space-y-1">
                                    <div className="flex justify-between text-[7px] font-bold text-slate-600 uppercase"><span>{p.label}</span></div>
                                    <input type="range" min={p.min} max={p.max} step={p.step} value={synthConfig[p.key as keyof SynthConfig] as number} onChange={e => updateSynth(p.key as keyof SynthConfig, parseFloat(e.target.value))} className="w-full accent-indigo-500 h-1 bg-slate-800 rounded-full appearance-none" />
                                </div>
                            ))}
                        </div>
                    </section>
                </div>
            )}
            </div>
          </div>
        </div>
      </main>

      {showShortcuts && createPortal(
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center"
          onPointerDown={() => setShowShortcuts(false)}
        >
          {/* Backdrop */}
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />

          {/* Panel */}
          <div
            className="relative z-10 w-full max-w-md mx-4 rounded-2xl border border-white/10 bg-slate-900/95 shadow-2xl overflow-hidden"
            onPointerDown={e => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
              <div className="flex items-center gap-2">
                <HelpCircle size={16} className="text-indigo-400" />
                <span className="text-sm font-black uppercase tracking-widest text-white">Keyboard Shortcuts</span>
              </div>
              <button
                onClick={() => setShowShortcuts(false)}
                className="text-slate-500 hover:text-white transition-colors"
              >
                <X size={16} />
              </button>
            </div>

            <div className="p-5 grid grid-cols-2 gap-x-6 gap-y-5 max-h-[70vh] overflow-y-auto">
              {SEQ_TUTORIAL_SECTIONS.map(section => (
                <div key={section.title}>
                  <div className="text-[9px] font-black uppercase tracking-widest text-slate-500 mb-2">
                    {section.title}
                  </div>
                  <div className="flex flex-col gap-1.5">
                    {section.rows.map(row => (
                      <div key={row.display} className="flex items-center justify-between gap-3">
                        <span className="text-[10px] font-black bg-white/8 border border-white/10 text-slate-300 px-1.5 py-0.5 rounded shrink-0 tabular-nums">
                          {row.display}
                        </span>
                        <span className="text-[10px] text-slate-400 text-right leading-tight">
                          {row.hint}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <div className="px-5 py-3 border-t border-white/10 text-[9px] text-slate-600 uppercase tracking-widest">
              Click anywhere outside to close
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
        input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; height: 10px; width: 10px; border-radius: 50%; background: #6366f1; cursor: pointer; border: 2px solid #000; box-shadow: 0 0 10px #6366f1; }
      `}</style>
    </div>
  );
};

export default App;
