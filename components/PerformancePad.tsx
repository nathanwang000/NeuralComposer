import { Maximize2, Music } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { audioEngine } from '../services/audioEngine';
import { SynthConfig } from '../types';

type ModulationTarget = keyof SynthConfig | 'volume';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function noteToMidi(note: string): number {
  const regex = /^([A-G][#b]?)(-?\d+)$/i;
  const match = note.match(regex);
  if (!match) return 60; // Default Middle C

  let [_, name, octaveStr] = match;
  name = name.toUpperCase();
  let octave = parseInt(octaveStr);

  let index = NOTE_NAMES.indexOf(name);
  if (index === -1) {
    // Handle flats
    if (name.endsWith('B')) {
       const natural = name[0];
       const naturalIndex = NOTE_NAMES.indexOf(natural);
       index = (naturalIndex - 1 + 12) % 12;
    }
  }

  // C4 = 60
  // MIDI = (octave + 1) * 12 + index
  return (octave + 1) * 12 + index;
}

const AVAILABLE_TARGETS: { label: string; value: ModulationTarget }[] = [
  { label: 'Filter Cutoff', value: 'cutoff' },
  { label: 'Resonance', value: 'resonance' },
  { label: 'Detune', value: 'detune' },
  { label: 'Drive/Distortion', value: 'drive' },
  { label: 'Volume', value: 'volume' }, // Special case, mapped manually if needed or via drive
];

const PerformancePad: React.FC = () => {
  const padRef = useRef<HTMLDivElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [cursorPos, setCursorPos] = useState({ x: 0, y: 0 }); // 0-1 normalized

  // Sequence
  const [sequenceInput, setSequenceInput] = useState("C4, E4, G4, B4, C5, B4, G4, E4");
  const [noteSequence, setNoteSequence] = useState<number[]>([]);
  const [currentNoteIndex, setCurrentNoteIndex] = useState(0);

  // Mappings
  const [xTargets, setXTargets] = useState<ModulationTarget[]>(['cutoff']);
  const [yTargets, setYTargets] = useState<ModulationTarget[]>(['resonance']);

  useEffect(() => {
    // Parse sequence
    const notes = sequenceInput.split(/[, ]+/).filter(Boolean).map(n => noteToMidi(n.trim()));
    setNoteSequence(notes.length > 0 ? notes : [60]);
    setCurrentNoteIndex(0);
  }, [sequenceInput]);

  const calculateParams = useCallback((x: number, y: number) => {
    // x, y are 0-1
    const updates: Partial<SynthConfig> = {};

    // Helper to map 0-1 to parameter ranges
    const mapValue = (val: number, target: ModulationTarget) => {
        switch (target) {
            case 'cutoff': return 100 + (val * 8000); // 100Hz - 8100Hz
            case 'resonance': return val * 20; // 0 - 20
            case 'detune': return (val - 0.5) * 100; // -50 to +50 cents
            case 'drive': return val * 2.0; // 0 - 2.0
            // Volume is handled via direct gain modulation or drive hacks,
            // but let's assume 'drive' controls loudness/character for now as per AudioEngine implementation
            // or we might need to add explicit volume control to ActiveVoice params if requested.
            case 'volume':
                // drive is closest to volume in current engine without master gain access
                return val * 1.5;
            default: return 0;
        }
    };

    xTargets.forEach(t => {
        if (t === 'volume' || t === 'drive') {
            updates.drive = mapValue(x, t);
        } else {
             // @ts-ignore
            updates[t] = mapValue(x, t);
        }
    });

    yTargets.forEach(t => {
         if (t === 'volume' || t === 'drive') {
            updates.drive = mapValue(y, t);
        } else {
             // @ts-ignore
            updates[t] = mapValue(y, t);
        }
    });

    return updates;
  }, [xTargets, yTargets]);

  const handlePointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    if (!padRef.current) return;
    padRef.current.setPointerCapture(e.pointerId);

    const rect = padRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height)); // Y up is 1

    setIsPlaying(true);
    setCursorPos({ x, y });

    const note = noteSequence[currentNoteIndex % noteSequence.length];

    // Initial Params
    const params = calculateParams(x, y);
    audioEngine.updateActiveVoiceParams(params);

    // Start Note
    // Hardcoded velocity for now, or could map to pressure/Y-axis
    audioEngine.startContinuousNote(note, 100);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!isPlaying || !padRef.current) return;
    e.preventDefault();

    const rect = padRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height));

    setCursorPos({ x, y });
    const params = calculateParams(x, y);
    audioEngine.updateActiveVoiceParams(params);
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    e.preventDefault();
    setIsPlaying(false);
    audioEngine.stopContinuousNote();
    setCurrentNoteIndex(prev => (prev + 1) % noteSequence.length);
  };

  const toggleTarget = (axis: 'x' | 'y', target: ModulationTarget) => {
      const setFn = axis === 'x' ? setXTargets : setYTargets;
      setFn(prev => {
          if (prev.includes(target)) return prev.filter(t => t !== target);
          return [...prev, target];
      });
  };

  return (
    <div className="flex flex-col gap-4 h-full">
        {/* Main Pad Area */}
        <div
            ref={padRef}
            className="flex-1 relative bg-slate-900 rounded-3xl border border-white/10 touch-none cursor-crosshair overflow-hidden group shadow-inner transition-colors hover:border-indigo-500/30"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerLeave={handlePointerUp}
        >
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

            <div className="absolute inset-0 flex items-center justify-center pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity duration-700">
                {!isPlaying && <span className="text-slate-800 font-black text-6xl uppercase tracking-tighter mix-blend-screen">Touch Perf</span>}
            </div>
        </div>

        {/* Controls */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 flex-none h-auto">
            {/* Sequence Input */}
            <div className="bg-slate-950/50 rounded-2xl border border-white/5 p-4">
                <div className="flex items-center gap-2 mb-3 text-slate-500 font-black uppercase text-xs">
                    <Music size={14} /> Note Sequence
                </div>
                <textarea
                    className="w-full bg-black/40 border border-white/5 rounded-xl p-3 text-xs font-mono text-indigo-300 focus:outline-none focus:border-indigo-500/50 h-24 resize-none"
                    value={sequenceInput}
                    onChange={(e) => setSequenceInput(e.target.value)}
                    placeholder="e.g. C4, E4, G4, C5 (Separated by commas)"
                />
                <div className="flex justify-between items-center mt-2">
                    <div className="text-[10px] text-slate-600 font-bold uppercase">
                        Current Step: <span className="text-indigo-400">{currentNoteIndex + 1}</span> / {noteSequence.length}
                    </div>
                    <button
                        onClick={() => setCurrentNoteIndex(0)}
                        className="text-[10px] bg-white/5 hover:bg-white/10 px-2 py-1 rounded text-slate-400 uppercase font-bold"
                    >
                        Reset Step
                    </button>
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
