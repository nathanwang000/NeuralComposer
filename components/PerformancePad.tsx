import { Maximize2, Minimize2, Music } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { audioEngine } from '../services/audioEngine';
import { SynthConfig } from '../types';

type ModulationTarget = keyof SynthConfig;

type ChordStep = {
    notes: number[];
    strumMs: number;
};

// Semitone values for natural notes
const BASE_SEMITONES: Record<string, number> = {
  C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11,
};

function noteToMidi(note: string): number {
  // Supports any number of sharps (#, ##, ...), flats (b, bb, ...),
  // and the double-sharp shorthand (x), e.g. E#, E##, Dbb, Cx, B##
  const regex = /^([A-G])(x|[#b]+)?(-?\d+)$/i;
  const match = note.match(regex);
  if (!match) return 60; // Default Middle C

  const [_, noteLetter, accidental, octaveStr] = match;
  const octave = parseInt(octaveStr);
  const baseSemitone = BASE_SEMITONES[noteLetter.toUpperCase()];

  let offset = 0;
  if (accidental) {
    if (accidental.toLowerCase() === 'x') {
      offset = 2; // double sharp shorthand
    } else {
      for (const ch of accidental) {
        if (ch === '#') offset += 1;
        else if (ch === 'b') offset -= 1;
      }
    }
  }

  // C4 = 60; octave boundary crossings are handled automatically,
  // e.g. B##4 → 71 + 2 = 73 = C#5, Cb4 → 60 - 1 = 59 = B3
  return (octave + 1) * 12 + baseSemitone + offset;
}

const CANONICAL_NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function midiToNote(midi: number): string {
  const clamped = Math.max(0, Math.min(127, midi));
  const octave = Math.floor(clamped / 12) - 1;
  const name = CANONICAL_NOTES[clamped % 12];
  return `${name}${octave}`;
}

/** Strip // line comments from a sequence string. */
function stripComments(sequence: string): string {
  return sequence
    .split('\n')
    .map(line => {
      const idx = line.indexOf('//');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
}

/**
 * Apply a transform only to the non-comment portion of each line,
 * preserving any trailing // ... comment as-is.
 */
function applyToNonComments(sequence: string, transform: (code: string) => string): string {
  return sequence
    .split('\n')
    .map(line => {
      const idx = line.indexOf('//');
      if (idx === -1) return transform(line);
      return transform(line.slice(0, idx)) + line.slice(idx);
    })
    .join('\n');
}

function transposeSequence(sequence: string, delta: number): string {
  // Match note tokens like C4, F#3, Db-1, Cx5 etc. — skip comment text.
  return applyToNonComments(sequence, code =>
    code.replace(/([A-G](?:x|[#b]+)?-?\d+)/gi, (match) => {
      const midi = noteToMidi(match);
      return midiToNote(midi + delta);
    })
  );
}

function scaleStrumSpeed(sequence: string, factor: number): string {
  // Scale every @Xms value by factor; 0ms stays 0ms — skip comment text.
  return applyToNonComments(sequence, code =>
    code.replace(/@\s*(\d+(?:\.\d+)?)\s*ms?/gi, (_, ms) => {
      const scaled = Math.round(parseFloat(ms) * factor);
      return `@${Math.max(0, scaled)}ms`;
    })
  );
}

function reorderChordNotes(sequence: string, mode: 'reverse' | 'random' | 'sort'): string {
  return applyToNonComments(sequence, code => code
    .split(',')
    .map(step => {
      const trimmed = step.trim();
      const match = trimmed.match(/^(.*?)(@\s*\d+(?:\.\d+)?\s*ms?)?$/i);
      const notesPart = (match?.[1] ?? trimmed).trim();
      const strumPart = match?.[2] ?? '';
      const notes = notesPart.split('+').map(n => n.trim()).filter(Boolean);
      if (mode === 'reverse') {
        notes.reverse();
      } else if (mode === 'sort') {
        notes.sort((a, b) => noteToMidi(a) - noteToMidi(b));
      } else {
        // Fisher-Yates shuffle
        for (let i = notes.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [notes[i], notes[j]] = [notes[j], notes[i]];
        }
      }
      return notes.join('+') + strumPart;
    })
    .join(', ')
  );
}

const AVAILABLE_TARGETS: { label: string; value: ModulationTarget }[] = [
  { label: 'Filter Cutoff', value: 'cutoff' },
  { label: 'Resonance', value: 'resonance' },
  { label: 'Detune', value: 'detune' },
  { label: 'Sustain', value: 'sustain' },
];

const CHORD_PRESETS: { label: string; description: string; sequence: string }[] = [
  {
    label: 'Jazz ii-V-I',
    description: 'Dm7 → G7 → Cmaj7 → Am7',
    sequence: 'D3+F3+A3+C4@40ms, G3+B3+D4+F4@40ms, C3+E3+G3+B3@40ms, A2+C3+G3+E4@40ms',
  },
  {
    label: 'Funky E7',
    description: 'E7 → A7 → B7 dominant groove',
    sequence: 'E3+G#3+B3+D4@15ms, E3+G#3+B3+D4@15ms, A3+C#4+E4+G4@15ms, A3+C#4+E4+G4@15ms, B3+D#4+F#4+A4@15ms, A3+C#4+E4+G4@15ms',
  },
  {
    label: 'Japanese In',
    description: 'Hirajōshi-flavoured voicings (C In scale)',
    sequence: 'C4+Db4+G4@70ms, G3+Ab3+Eb4@70ms, F3+Gb3+C4+Eb4@80ms, Ab3+C4+Eb4+G4@70ms',
  },
  {
    label: 'Natural Minor',
    description: 'Am: i → iv → VII → III → V → i',
    sequence: 'A3+C4+E4+A4@30ms, D4+F4+A4+D5@30ms, G3+B3+D4+G4@30ms, C4+E4+G4+C5@30ms, E4+G#4+B4+E5@25ms, A3+C4+E4+A4@30ms',
  },
  {
    label: 'Lo-fi Chill',
    description: 'Cmaj9 → Fmaj7 → Am7 → G6/9',
    sequence: 'C3+E3+G3+B3+D4@55ms, F3+A3+C4+E4+G4@55ms, A2+C3+E3+G3+B3@55ms, G3+A3+B3+D4+E4@55ms',
  },
  {
    label: 'Bossa Nova',
    description: 'Cmaj7 → A7 → Dm7 → G7',
    sequence: 'C3+G3+B3+E4@35ms, A3+E4+G4+C#5@35ms, D3+A3+C4+F4@35ms, G3+B3+D4+F4@35ms',
  },
  {
    label: 'Whole Tone',
    description: 'Augmented dreamy wash (C whole-tone scale)',
    sequence: 'C4+E4+G#4+A#4@60ms, D4+F#4+A#4+C4@60ms, E4+G#4+C5+D5@60ms, F#4+A#4+D5+E5@60ms',
  },
  {
    label: 'Phrygian Stomp',
    description: 'E Phrygian flamenco-style i → bII',
    sequence: 'E3+G3+B3+E4@20ms, F3+A3+C4+F4@20ms, E3+G3+B3+E4@20ms, F3+A3+C4+F4@60ms, E3+G3+B3+E4@20ms',
  },
];

const PerformancePad: React.FC = () => {
    const padRef = useRef<HTMLDivElement>(null);
    const activePointerIdsRef = useRef<Set<number>>(new Set());
    const controlPointerIdRef = useRef<number | null>(null);
    const activeKeyboardKeysRef = useRef<Set<string>>(new Set());
    const isMouseInPadRef = useRef(false);
    const hoverPosRef = useRef({ x: 0.5, y: 0.5 });
    const [isPlaying, setIsPlaying] = useState(false);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [isFallbackFullscreen, setIsFallbackFullscreen] = useState(false);
    const [cursorPos, setCursorPos] = useState({ x: 0, y: 0 }); // 0-1 normalized

    // Sequence
    const [sequenceInput, setSequenceInput] = useState("C4+E4+G4+B5+C5+E6+G6+E5+C5+B4@200ms, D4+E4+G4+B5+C5+E6+G6+E5+C5+B4@200ms,F4+C5+A5,F4+C5+A5,F4+C5+G5,F4+C5+F5,E4+C5+G5");
    const [chordSequence, setChordSequence] = useState<ChordStep[]>([]);
    const [currentNoteIndex, setCurrentNoteIndex] = useState(0);
    const currentNoteIndexRef = useRef(0);

    // Mappings
    const [xTargets, setXTargets] = useState<ModulationTarget[]>(['cutoff']);
    const [yTargets, setYTargets] = useState<ModulationTarget[]>(['resonance']);

    useEffect(() => {
        const parsedChords = stripComments(sequenceInput)
            .split(',')
            .map(step => step.trim())
            .filter(Boolean)
            .map((step): ChordStep | null => {
                const match = step.match(/^(.*?)(?:@\s*(\d+(?:\.\d+)?)\s*ms?)?$/i);
                const notesPart = (match?.[1] ?? step).trim();
                const rawStrum = match?.[2];
                const parsedStrum = rawStrum !== undefined ? Number(rawStrum) : 0;
                const strumMs = Number.isFinite(parsedStrum) ? Math.max(0, parsedStrum) : 0;

                const notes = notesPart
                    .split('+')
                    .map(n => n.trim())
                    .filter(Boolean)
                    .map(n => noteToMidi(n));

                if (notes.length === 0) return null;
                return { notes, strumMs };
            })
            .filter((step): step is ChordStep => step !== null);

        const newSequence = parsedChords.length > 0 ? parsedChords : [{ notes: [60], strumMs: 0 }];
        setChordSequence(newSequence);
        // Only reset the step counter when the number of steps changes (e.g. editing the
        // sequence structure), not when notes are merely transposed in place.
        setCurrentNoteIndex(prev => {
            const reset = prev >= newSequence.length;
            if (reset) currentNoteIndexRef.current = 0;
            return reset ? 0 : prev;
        });
    }, [sequenceInput]);

    useEffect(() => {
        currentNoteIndexRef.current = currentNoteIndex;
    }, [currentNoteIndex]);

    useEffect(() => {
        const syncFullscreenState = () => {
            const active = document.fullscreenElement === padRef.current;
            setIsFullscreen(active || isFallbackFullscreen);
        };

        document.addEventListener('fullscreenchange', syncFullscreenState);
        return () => {
            document.removeEventListener('fullscreenchange', syncFullscreenState);
        };
    }, [isFallbackFullscreen]);

    useEffect(() => {
        if (!isFallbackFullscreen) return;

        const scrollY = window.scrollY;
        const prevBodyPosition = document.body.style.position;
        const prevBodyTop = document.body.style.top;
        const prevBodyLeft = document.body.style.left;
        const prevBodyRight = document.body.style.right;
        const prevBodyWidth = document.body.style.width;
        const prevBodyOverflow = document.body.style.overflow;
        const prevHtmlOverflow = document.documentElement.style.overflow;
        const prevBodyOverscroll = document.body.style.overscrollBehavior;
        const prevHtmlOverscroll = document.documentElement.style.overscrollBehavior;

        document.body.style.position = 'fixed';
        document.body.style.top = '0';
        document.body.style.left = '0';
        document.body.style.right = '0';
        document.body.style.width = '100%';
        document.body.style.overflow = 'hidden';
        document.documentElement.style.overflow = 'hidden';
        document.body.style.overscrollBehavior = 'none';
        document.documentElement.style.overscrollBehavior = 'none';
        window.scrollTo(0, 0);

        return () => {
            document.body.style.position = prevBodyPosition;
            document.body.style.top = prevBodyTop;
            document.body.style.left = prevBodyLeft;
            document.body.style.right = prevBodyRight;
            document.body.style.width = prevBodyWidth;
            document.body.style.overflow = prevBodyOverflow;
            document.documentElement.style.overflow = prevHtmlOverflow;
            document.body.style.overscrollBehavior = prevBodyOverscroll;
            document.documentElement.style.overscrollBehavior = prevHtmlOverscroll;
            window.scrollTo(0, scrollY);
        };
    }, [isFallbackFullscreen]);

    const toggleFullscreen = useCallback(async () => {
        const el = padRef.current;
        if (!el) return;

        try {
            if (document.fullscreenElement === el) {
                await document.exitFullscreen();
                return;
            }

            if (!document.fullscreenElement && el.requestFullscreen) {
                await el.requestFullscreen();
                return;
            }
        } catch {
            setIsFallbackFullscreen(prev => !prev);
            return;
        }

        if (document.fullscreenElement) {
            await document.exitFullscreen();
        } else {
            setIsFallbackFullscreen(prev => !prev);
        }
    }, []);

  const calculateParams = useCallback((x: number, y: number) => {
    // x, y are 0-1
    const updates: Partial<SynthConfig> = {};

    // Helper to map 0-1 to parameter ranges
    const mapValue = (val: number, target: ModulationTarget) => {
        switch (target) {
            case 'cutoff': return 100 + (val * 8000); // 100Hz - 8100Hz
            case 'resonance': return val * 20; // 0 - 20
            case 'detune': return (val - 0.5) * 100; // -50 to +50 cents
            case 'sustain': return val; // 0 - 1
            default: return 0;
        }
    };

    xTargets.forEach(t => {
         // @ts-ignore
        updates[t] = mapValue(x, t);
    });

    yTargets.forEach(t => {
         // @ts-ignore
        updates[t] = mapValue(y, t);
    });

    return updates;
  }, [xTargets, yTargets]);

    const updateHoverFromClientPosition = useCallback((clientX: number, clientY: number) => {
        if (!padRef.current) return null;

        const rect = padRef.current.getBoundingClientRect();
        const x = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        const y = Math.max(0, Math.min(1, 1 - (clientY - rect.top) / rect.height));
        hoverPosRef.current = { x, y };
        return { x, y };
    }, []);

    const startTrigger = useCallback((x: number, y: number) => {
        setIsPlaying(true);
        setCursorPos({ x, y });

        const sequence = chordSequence.length > 0 ? chordSequence : [{ notes: [60], strumMs: 0 }];
        const nextIndex = currentNoteIndexRef.current;
        const step = sequence[nextIndex % sequence.length];

        const params = calculateParams(x, y);
        audioEngine.updateActiveVoiceParams(params);
        audioEngine.startContinuousNotes(step.notes, 100, step.strumMs);

        const advancedIndex = (nextIndex + 1) % sequence.length;
        currentNoteIndexRef.current = advancedIndex;
        setCurrentNoteIndex(advancedIndex);
    }, [calculateParams, chordSequence]);

    const stopTriggerIfIdle = useCallback(() => {
        if (activePointerIdsRef.current.size > 0) return;
        if (activeKeyboardKeysRef.current.size > 0) return;

        setIsPlaying(false);
        audioEngine.stopContinuousNote();
    }, []);

    const handleMouseEnter = (e: React.MouseEvent) => {
        isMouseInPadRef.current = true;
        updateHoverFromClientPosition(e.clientX, e.clientY);
    };

    const handleMouseMove = (e: React.MouseEvent) => {
        updateHoverFromClientPosition(e.clientX, e.clientY);
    };

    const handleMouseLeave = () => {
        isMouseInPadRef.current = false;
    };

    useEffect(() => {
        const isTypingElement = (target: EventTarget | null) => {
            const el = target as HTMLElement | null;
            if (!el) return false;
            const tag = el.tagName;
            return el.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
        };

        const onKeyDown = (e: KeyboardEvent) => {
            if (!isMouseInPadRef.current) return;
            if (isTypingElement(e.target)) return;

            // Space: reset step counter
            if (e.key === ' ') {
                e.preventDefault();
                setCurrentNoteIndex(0);
                currentNoteIndexRef.current = 0;
                return;
            }

            // Arrow keys
            if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
                e.preventDefault();
                if (e.shiftKey) {
                    // Shift+Up/Down: scale strum speed ×/÷1.5
                    const strumFactor: Record<string, number> = {
                        ArrowUp: 1.5, ArrowDown: 1 / 1.5,
                    };
                    if (strumFactor[e.key] !== undefined) {
                        setSequenceInput(prev => scaleStrumSpeed(prev, strumFactor[e.key]));
                    }
                } else {
                    // Arrow: transpose semitones / octaves
                    const arrowDelta: Record<string, number> = {
                        ArrowLeft: -1, ArrowRight: 1, ArrowUp: 12, ArrowDown: -12,
                    };
                    setSequenceInput(prev => transposeSequence(prev, arrowDelta[e.key]));
                }
                return;
            }

            // R / Shift+R / S: reorder chord notes
            if (e.key === 'r') {
                e.preventDefault();
                setSequenceInput(prev => reorderChordNotes(prev, 'random'));
                return;
            }
            if (e.key === 'R') {
                e.preventDefault();
                setSequenceInput(prev => reorderChordNotes(prev, 'reverse'));
                return;
            }
            if (e.key === 's') {
                e.preventDefault();
                setSequenceInput(prev => reorderChordNotes(prev, 'sort'));
                return;
            }

            const key = e.key.toLowerCase();
            if (key !== 'd' && key !== 'f') return;
            if (e.repeat || activeKeyboardKeysRef.current.has(key)) return;

            activeKeyboardKeysRef.current.add(key);
            const { x, y } = hoverPosRef.current;
            startTrigger(x, y);
        };

        const onKeyUp = (e: KeyboardEvent) => {
            const key = e.key.toLowerCase();
            if (key !== 'd' && key !== 'f') return;

            activeKeyboardKeysRef.current.delete(key);
            stopTriggerIfIdle();
        };

        window.addEventListener('keydown', onKeyDown);
        window.addEventListener('keyup', onKeyUp);

        return () => {
            window.removeEventListener('keydown', onKeyDown);
            window.removeEventListener('keyup', onKeyUp);
        };
    }, [startTrigger, stopTriggerIfIdle]);

  const handlePointerDown = (e: React.PointerEvent) => {
        const target = e.target as HTMLElement;
        if (target.closest('[data-pad-control="true"]')) {
            return;
        }

    e.preventDefault();
    if (!padRef.current) return;

        activePointerIdsRef.current.add(e.pointerId);
        controlPointerIdRef.current = e.pointerId;
    padRef.current.setPointerCapture(e.pointerId);

    const rect = padRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height)); // Y up is 1
                hoverPosRef.current = { x, y };
                startTrigger(x, y);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
        if (!isPlaying || !padRef.current || controlPointerIdRef.current !== e.pointerId) return;
        e.preventDefault();

    const rect = padRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height));

    setCursorPos({ x, y });
    const params = calculateParams(x, y);
    audioEngine.updateActiveVoiceParams(params);
  };

    const handlePointerEnd = (e: React.PointerEvent) => {
        if (!activePointerIdsRef.current.has(e.pointerId)) return;
        e.preventDefault();

        if (padRef.current?.hasPointerCapture(e.pointerId)) {
            padRef.current.releasePointerCapture(e.pointerId);
        }

        activePointerIdsRef.current.delete(e.pointerId);

        if (controlPointerIdRef.current === e.pointerId) {
            const remainingPointers = Array.from(activePointerIdsRef.current);
            controlPointerIdRef.current = remainingPointers.length > 0 ? remainingPointers[remainingPointers.length - 1] : null;
        }

        if (activePointerIdsRef.current.size > 0) {
            return;
        }

        stopTriggerIfIdle();
  };

  const toggleTarget = (axis: 'x' | 'y', target: ModulationTarget) => {
      const setFn = axis === 'x' ? setXTargets : setYTargets;
      setFn(prev => {
          if (prev.includes(target)) return prev.filter(t => t !== target);
          return [...prev, target];
      });
  };

    const padElement = (
        <div
            ref={padRef}
                        className={`flex-1 min-h-[300px] relative bg-slate-900 rounded-3xl border border-white/10 cursor-crosshair overflow-hidden group shadow-inner transition-colors hover:border-indigo-500/30 select-none ${isFallbackFullscreen ? 'fixed inset-0 min-h-0 rounded-none bg-slate-950' : ''}`}
                        style={{
                            touchAction: 'none',
                            userSelect: 'none',
                            WebkitUserSelect: 'none',
                            WebkitTouchCallout: 'none',
                            ...(isFallbackFullscreen
                                ? {
                                        position: 'fixed',
                                        top: 0,
                                        left: 0,
                                        right: 0,
                                        bottom: 0,
                                        zIndex: 2147483647,
                                        margin: 0,
                                        width: '100vw',
                                        height: '100dvh',
                                        minHeight: '100dvh',
                                        maxHeight: '100dvh',
                                    }
                                : {}),
                        }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerEnd}
            onPointerCancel={handlePointerEnd}
            onLostPointerCapture={handlePointerEnd}
            onMouseEnter={handleMouseEnter}
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseLeave}
            onContextMenu={(e) => e.preventDefault()}
        >
            <button
                type="button"
                data-pad-control="true"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    toggleFullscreen();
                }}
                className="absolute top-3 right-3 z-20 inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-black/60 border border-white/10 text-slate-200 hover:text-white hover:border-white/20 text-[10px] font-black uppercase tracking-widest"
            >
                {isFullscreen ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
                {isFullscreen ? 'Exit' : 'Full'}
            </button>

            {/* Grid Lines */}
            <div className="absolute inset-0 grid grid-cols-4 grid-rows-4 pointer-events-none opacity-20">
                 {Array.from({length: 16}).map((_, i) => (
                     <div key={i} className="border border-indigo-500/30" />
                 ))}
            </div>

            {/* Axis Labels */}
            <div className="absolute bottom-4 right-4 text-xs font-black text-slate-700 pointer-events-none select-none uppercase tracking-widest">
               X: {xTargets.join(', ') || 'None'}
            </div>
            <div className="absolute top-4 left-4 text-xs font-black text-slate-700 pointer-events-none select-none uppercase tracking-widest rotate-90 origin-top-left translate-x-4">
               Y: {yTargets.join(', ') || 'None'}
            </div>
                <div className="absolute bottom-4 left-4 text-[10px] font-black text-slate-700 pointer-events-none select-none uppercase tracking-widest hidden md:block">
                    D/F: Play · ←→: Semitone · ↑↓: Octave · ⇧↑↓: Strum×÷1.5 · R: Random · ⇧R: Reverse · S: Sort · Space: Reset
                </div>

            {/* Active Cursor/Visualizer */}
            {isPlaying && (
                <>
                    <div
                        className="absolute w-full h-[1px] bg-indigo-500/50 pointer-events-none blur-[1px]"
                        style={{ bottom: `${cursorPos.y * 100}%` }}
                    />
                    <div
                        className="absolute h-full w-[1px] bg-indigo-500/50 pointer-events-none blur-[1px]"
                        style={{ left: `${cursorPos.x * 100}%` }}
                    />
                    <div
                        className="absolute w-32 h-32 rounded-full bg-indigo-500/20 blur-xl pointer-events-none -translate-x-1/2 translate-y-1/2 transition-transform duration-75"
                        style={{ left: `${cursorPos.x * 100}%`, bottom: `${cursorPos.y * 100}%` }}
                    />
                     <div
                        className="absolute w-4 h-4 rounded-full bg-white shadow-[0_0_20px_white] pointer-events-none -translate-x-1/2 translate-y-1/2"
                        style={{ left: `${cursorPos.x * 100}%`, bottom: `${cursorPos.y * 100}%` }}
                    />
                </>
            )}

            {/* <div className="absolute inset-0 flex items-center justify-center pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity duration-700">
                {!isPlaying && <span className="text-slate-800 font-black text-6xl uppercase tracking-tighter mix-blend-screen">Touch Perf</span>}
            </div> */}
        </div>
    );

    return (
        <div
            className="flex flex-col gap-4 h-full select-none"
            style={{ userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none' }}
            onContextMenu={(e) => e.preventDefault()}
        >
        {/* Main Pad Area */}
        {isFallbackFullscreen ? createPortal(padElement, document.body) : padElement}

        {/* Controls */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 flex-none h-auto">
            {/* Sequence Input */}
            <div className="bg-slate-950/50 rounded-2xl border border-white/5 p-4">
                <div className="flex items-center gap-2 mb-3 text-slate-500 font-black uppercase text-xs">
                    <Music size={14} /> Note Sequence
                </div>
                {/* Chord presets */}
                <div className="flex flex-wrap gap-1.5 mb-2">
                    {CHORD_PRESETS.map(preset => (
                        <button
                            key={preset.label}
                            title={preset.description}
                            onClick={() => setSequenceInput(preset.sequence)}
                            className="px-2 py-1 rounded-lg text-[9px] font-bold uppercase border border-white/5 bg-slate-900 text-slate-500 hover:text-indigo-300 hover:border-indigo-500/30 transition-all"
                        >
                            {preset.label}
                        </button>
                    ))}
                </div>
                <textarea
                    className="w-full bg-black/40 border border-white/5 rounded-xl p-3 text-xs font-mono text-indigo-300 focus:outline-none focus:border-indigo-500/50 h-24 resize-none"
                    value={sequenceInput}
                    onChange={(e) => setSequenceInput(e.target.value)}
                    placeholder="e.g. C4+E4+G4@12ms, // tonic&#10;D4+F#4+A4 // use // for comments"
                />
                <div className="flex flex-col gap-1.5 mt-2">
                    <div className="flex items-center gap-1 flex-wrap">
                        <span className="text-[9px] text-slate-700 font-black uppercase w-16 shrink-0">Transpose</span>
                        {([[-12, '↓ Octave (↓ Arrow)'], [-1, '−1 Semitone (← Arrow)'], [1, '+1 Semitone (→ Arrow)'], [12, '↑ Octave (↑ Arrow)']] as const).map(([delta, tooltip]) => (
                            <button
                                key={delta}
                                title={tooltip}
                                onClick={() => setSequenceInput(prev => transposeSequence(prev, delta))}
                                className="text-[9px] bg-white/5 hover:bg-indigo-500/20 hover:text-indigo-300 px-2 py-1 rounded text-slate-400 font-bold tabular-nums transition-all"
                            >
                                {delta > 0 ? `+${delta}` : delta}
                            </button>
                        ))}
                    </div>
                    <div className="flex items-center gap-1 flex-wrap">
                        <span className="text-[9px] text-slate-700 font-black uppercase w-16 shrink-0">Strum</span>
                        {([[1/1.5, '÷1.5', 'Slow strum (÷1.5) (⇧↓)'], [1.5, '×1.5', 'Speed strum up (×1.5) (⇧↑)']] as [number, string, string][]).map(([factor, label, tooltip]) => (
                            <button
                                key={label}
                                title={tooltip}
                                onClick={() => setSequenceInput(prev => scaleStrumSpeed(prev, factor))}
                                className="text-[9px] bg-white/5 hover:bg-emerald-500/20 hover:text-emerald-300 px-2 py-1 rounded text-slate-400 font-bold tabular-nums transition-all"
                            >
                                {label}
                            </button>
                        ))}
                        <div className="flex-1" />
                        <div className="text-[10px] text-slate-600 font-bold uppercase">
                            Step: <span className="text-indigo-400">{currentNoteIndex + 1}</span>/<span className="text-slate-600">{chordSequence.length}</span>
                        </div>
                        <button
                            title="Reset to step 1 (Space)"
                            onClick={() => { setCurrentNoteIndex(0); currentNoteIndexRef.current = 0; }}
                            className="text-[10px] bg-white/5 hover:bg-white/10 px-2 py-1 rounded text-slate-400 uppercase font-bold"
                        >
                            Reset
                        </button>
                    </div>
                    <div className="flex items-center gap-1 flex-wrap">
                        <span className="text-[9px] text-slate-700 font-black uppercase w-16 shrink-0">Order</span>
                        <button
                            title="Reverse note order within each chord (e.g. C4+E4+G4 → G4+E4+C4) (⇧R)"
                            onClick={() => setSequenceInput(prev => reorderChordNotes(prev, 'reverse'))}
                            className="text-[9px] bg-white/5 hover:bg-amber-500/20 hover:text-amber-300 px-2 py-1 rounded text-slate-400 font-bold transition-all"
                        >
                            Reverse
                        </button>
                        <button
                            title="Randomise note order within each chord (R)"
                            onClick={() => setSequenceInput(prev => reorderChordNotes(prev, 'random'))}
                            className="text-[9px] bg-white/5 hover:bg-amber-500/20 hover:text-amber-300 px-2 py-1 rounded text-slate-400 font-bold transition-all"
                        >
                            Random
                        </button>
                        <button
                            title="Sort notes by pitch low→high within each chord (S)"
                            onClick={() => setSequenceInput(prev => reorderChordNotes(prev, 'sort'))}
                            className="text-[9px] bg-white/5 hover:bg-amber-500/20 hover:text-amber-300 px-2 py-1 rounded text-slate-400 font-bold transition-all"
                        >
                            Sort ↑
                        </button>
                    </div>
                </div>
            </div>

            {/* Axis Mapping */}
            <div className="bg-slate-950/50 rounded-2xl border border-white/5 p-4 flex flex-col gap-4">
                {/* X Axis */}
                <div>
                     <div className="flex items-center gap-2 mb-2 text-slate-500 font-black uppercase text-xs">
                        <Maximize2 size={14} className="rotate-90" /> X-Axis Control (Left - Right)
                    </div>
                    <div className="flex flex-wrap gap-2">
                        {AVAILABLE_TARGETS.map(t => (
                            <button
                                key={`x-${t.value}`}
                                onClick={() => toggleTarget('x', t.value)}
                                className={`px-2 py-1 rounded text-[10px] font-bold uppercase border transition-all ${
                                    xTargets.includes(t.value)
                                    ? 'bg-indigo-600 border-indigo-500 text-white'
                                    : 'bg-slate-900 border-white/10 text-slate-500 hover:text-slate-300'
                                }`}
                            >
                                {t.label}
                            </button>
                        ))}
                    </div>
                </div>

                {/* Y Axis */}
                <div>
                     <div className="flex items-center gap-2 mb-2 text-slate-500 font-black uppercase text-xs">
                        <Maximize2 size={14} /> Y-Axis Control (Bottom - Top)
                    </div>
                    <div className="flex flex-wrap gap-2">
                        {AVAILABLE_TARGETS.map(t => (
                            <button
                                key={`y-${t.value}`}
                                onClick={() => toggleTarget('y', t.value)}
                                className={`px-2 py-1 rounded text-[10px] font-bold uppercase border transition-all ${
                                    yTargets.includes(t.value)
                                    ? 'bg-emerald-600 border-emerald-500 text-white'
                                    : 'bg-slate-900 border-white/10 text-slate-500 hover:text-slate-300'
                                }`}
                            >
                                {t.label}
                            </button>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    </div>
  );
};

export default PerformancePad;
