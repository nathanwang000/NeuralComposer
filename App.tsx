
import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { MusicGenre, MidiEvent, CompositionState } from './types';
import { audioEngine } from './services/audioEngine';
import { composer } from './services/geminiComposer';
import PianoRoll, { SelectionBounds } from './components/PianoRoll';
import TimeNavigator from './components/TimeNavigator';
import { 
  Play, 
  Pause, 
  Zap, 
  RefreshCw, 
  Terminal, 
  Loader2, 
  Disc, 
  RotateCcw,
  PlusCircle,
  AlertTriangle,
  CheckCircle2,
  Cpu,
  Scissors,
  Copy,
  ClipboardPaste,
  X,
  History,
  Trash2,
  Undo,
  Redo,
  Sparkles,
  Gauge,
  Minus,
  Plus,
  Download
} from 'lucide-react';

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
  const [state, setState] = useState<CompositionState>({
    isPlaying: false,
    tempo: 124,
    genre: MusicGenre.CYBERPUNK,
    isGenerating: false,
  });

  const [playbackBeat, setPlaybackBeat] = useState(0);
  const [isPaused, setIsPaused] = useState(true); // Start conceptually paused
  const [events, setEvents] = useState<AppEvent[]>([]);
  const [rawStream, setRawStream] = useState("");
  const [isWarmingUp, setIsWarmingUp] = useState(false);
  const [userInput, setUserInput] = useState("");
  const [creativeDirection, setCreativeDirection] = useState("");
  
  // BPM Input Buffer State
  const [tempBpm, setTempBpm] = useState("124");

  // Selection State
  const [selectedEventIds, setSelectedEventIds] = useState<string[]>([]);
  const [selectionMarquee, setSelectionMarquee] = useState<SelectionBounds | null>(null);
  const [clipboard, setClipboard] = useState<{ event: MidiEvent; relativeBeat: number; comment?: string }[]>([]);
  
  // Undo/Redo History
  const [history, setHistory] = useState<{ past: typeof events[], future: typeof events[] }>({ past: [], future: [] });

  const beatsGeneratedRef = useRef(0);
  const isStreamActiveRef = useRef(false); 
  const isGeneratingRef = useRef(false); 
  const isWarmingUpRef = useRef(false);
  const streamBufferRef = useRef("");
  const playbackBeatRef = useRef(0);
  const isPausedRef = useRef(true);
  const lastUpdateRef = useRef(performance.now());
  const scheduledNoteIds = useRef(new Set<string>());
  const queueThreshold = 12; 

const validation = useMemo(() => {
    const errors: ValidationError[] = [];
    const validEvents: { event: MidiEvent; comment?: string }[] = [];
    
    if (!userInput.trim()) return { errors, validEvents };

    const lines = userInput.split('\n');
    let pendingComments: string[] = [];

    lines.forEach((line, lineIndex) => {
      const trimmedLine = line.trim();
      
      // Feature: Allow comments starting with #
      if (trimmedLine.startsWith('#')) {
        pendingComments.push(trimmedLine);
        return;
      }
      
      if (!trimmedLine && pendingComments.length === 0) return; 

      // Remove inline comments for parsing
      const codePart = line.split('#')[0];

      const packetRegex = /\[[^\]]*\]?/g;
      let match;
      let hasEventsOnLine = false;
      
      while ((match = packetRegex.exec(codePart)) !== null) {
        const pair = match[0];
        const fullMatch = pair.match(/\[\s*P:\s*(\d+)\s*,\s*V:\s*(\d+)\s*,\s*T:\s*([\d.]+)\s*,\s*D:\s*([\d.]+)\s*\]/);
        
        if (!fullMatch) {
          if (!pair.endsWith(']')) errors.push({ message: `Line ${lineIndex + 1}: Missing bracket ']'`, index: lineIndex });
          else errors.push({ message: `Line ${lineIndex + 1}: Invalid format`, index: lineIndex });
        } else {
          const p = parseInt(fullMatch[1]);
          const v = parseInt(fullMatch[2]);
          const t = parseFloat(fullMatch[3]);
          const d = parseFloat(fullMatch[4]);
          
          if (p < 0 || p > 127) {
            errors.push({ message: `Line ${lineIndex + 1}: P 0-127`, index: lineIndex });
          } else if (v < 0 || v > 127) {
            errors.push({ message: `Line ${lineIndex + 1}: V 0-127`, index: lineIndex });
          } else {
            const evt: { event: MidiEvent; comment?: string } = { event: { p, v, t, d } };
            // Attach pending comments to the first event found after the comments
            if (!hasEventsOnLine && pendingComments.length > 0) {
               evt.comment = pendingComments.join('\n');
               pendingComments = [];
            }
            validEvents.push(evt);
            hasEventsOnLine = true;
          }
        }
      }
    });

    return { errors, validEvents };
  }, [userInput]);

  // const validation = useMemo(() => {
  //   const errors: ValidationError[] = [];
  //   const validEvents: { event: MidiEvent; comment?: string }[] = [];
    
  //   if (!userInput.trim()) return { errors, validEvents };

  //   const lines = userInput.split('\n');
  //   let pendingComments: string[] = [];

  //   lines.forEach((line, lineIndex) => {
  //     const trimmedLine = line.trim();
      
  //     // Feature: Allow comments starting with #
  //     if (trimmedLine.startsWith('#')) {
  //       pendingComments.push(trimmedLine);
  //       return;
  //     }
      
  //     if (!trimmedLine && pendingComments.length === 0) return; 

  //     const packetRegex = /\[[^\]]*\]?/g;
  //     let match;
  //     let hasEventsOnLine = false;
  //     let foundAnyMatch = false;
      
  //     while ((match = packetRegex.exec(line)) !== null) {
  //       foundAnyMatch = true;
  //       const pair = match[0];
  //       const fullMatch = pair.match(/\[\s*P:\s*(\d+)\s*,\s*V:\s*(\d+)\s*,\s*T:\s*([\d.]+)\s*,\s*D:\s*([\d.]+)\s*\]/);
        
  //       if (!fullMatch) {
  //         if (!pair.endsWith(']')) errors.push({ message: `Line ${lineIndex + 1}: Missing bracket ']'`, index: lineIndex });
  //         else errors.push({ message: `Line ${lineIndex + 1}: Invalid format`, index: lineIndex });
  //       } else {
  //         const p = parseInt(fullMatch[1]);
  //         const v = parseInt(fullMatch[2]);
  //         const t = parseFloat(fullMatch[3]);
  //         const d = parseFloat(fullMatch[4]);
          
  //         if (p < 0 || p > 127) {
  //           errors.push({ message: `Line ${lineIndex + 1}: P 0-127`, index: lineIndex });
  //         } else {
  //           const evt: { event: MidiEvent; comment?: string } = { event: { p, v, t, d } };
  //           // Attach pending comments to the first event found after the comments
  //           if (!hasEventsOnLine && pendingComments.length > 0) {
  //              evt.comment = pendingComments.join('\n');
  //              pendingComments = [];
  //           }
  //           validEvents.push(evt);
  //           hasEventsOnLine = true;
  //         }
  //       }
  //     }
  //   });

  //   return { errors, validEvents };
  // }, [userInput]);

  // Sync temp BPM if state changes externally (e.g. reset)
  useEffect(() => {
    setTempBpm(state.tempo.toString());
  }, [state.tempo]);

  const updateBpm = (newBpm: number) => {
    const clamped = Math.max(20, Math.min(300, newBpm));
    setState(s => ({ ...s, tempo: clamped }));
    audioEngine.setTempo(clamped);
    setTempBpm(clamped.toString());
  };

  const handleBpmBlur = () => {
    const val = parseInt(tempBpm);
    if (!isNaN(val)) {
      updateBpm(val);
    } else {
      setTempBpm(state.tempo.toString());
    }
  };

  // Undo/Redo Logic
  const pushHistory = useCallback((currentEvents: typeof events) => {
    setHistory(curr => ({
      past: [...curr.past, currentEvents].slice(-20), // Limit history to last 20 steps
      future: []
    }));
  }, []);

  const undo = useCallback(() => {
    setHistory(curr => {
      if (curr.past.length === 0) return curr;
      const previous = curr.past[curr.past.length - 1];
      const newPast = curr.past.slice(0, -1);
      setEvents(previous);
      return {
        past: newPast,
        future: [events, ...curr.future]
      };
    });
  }, [events]);

  const redo = useCallback(() => {
    setHistory(curr => {
      if (curr.future.length === 0) return curr;
      const next = curr.future[0];
      const newFuture = curr.future.slice(1);
      setEvents(next);
      return {
        past: [...curr.past, events],
        future: newFuture
      };
    });
  }, [events]);

  useEffect(() => {
    let animationId: number;
    const tick = () => {
      const now = performance.now();
      const delta = (now - lastUpdateRef.current) / 1000;
      lastUpdateRef.current = now;
      if (state.isPlaying && !isPausedRef.current) {
        const bps = state.tempo / 60;
        playbackBeatRef.current += delta * bps;
        setPlaybackBeat(playbackBeatRef.current);
        const currentBeat = playbackBeatRef.current;
        events.forEach(item => {
          const absoluteStart = item.beatOffset + item.event.t;
          // Look behind slightly (0.2 beats) to ensure we don't skip notes at T=0 if the frame jumped
          // Look ahead 0.5 beats for scheduling
          if (absoluteStart >= currentBeat - 0.2 && absoluteStart < currentBeat + 0.5) {
            if (!scheduledNoteIds.current.has(item.id)) {
              audioEngine.scheduleNote(item.event, absoluteStart, currentBeat);
              scheduledNoteIds.current.add(item.id);
            }
          }
        });
        const remainingInQueue = beatsGeneratedRef.current - playbackBeatRef.current;
        if (isStreamActiveRef.current && remainingInQueue < queueThreshold && !isGeneratingRef.current) {
          generateNextStream();
        }
      }
      animationId = requestAnimationFrame(tick);
    };
    animationId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animationId);
  }, [state.isPlaying, events, state.tempo, creativeDirection]); 

  const parseAndStore = (textChunk: string, baseBeatOffset: number) => {
    streamBufferRef.current += textChunk;
    setRawStream(prev => (prev + textChunk).slice(-800));
    const regex = /\[\s*P:\s*(\d+)\s*,\s*V:\s*(\d+)\s*,\s*T:\s*([\d.]+)\s*,\s*D:\s*([\d.]+)\s*\]/g;
    let match;
    const newMidiEvents: AppEvent[] = [];
    while ((match = regex.exec(streamBufferRef.current)) !== null) {
      const event: MidiEvent = { p: parseInt(match[1]), v: parseInt(match[2]), t: parseFloat(match[3]), d: parseFloat(match[4]) };
      newMidiEvents.push({ event, beatOffset: baseBeatOffset, id: `note-${baseBeatOffset}-${match.index}-${event.p}` });
    }
    if (newMidiEvents.length > 0) {
      streamBufferRef.current = streamBufferRef.current.replace(/\[\s*P:\s*(\d+)\s*,\s*V:\s*(\d+)\s*,\s*T:\s*([\d.]+)\s*,\s*D:\s*([\d.]+)\s*\]/g, "");
      setEvents(prev => [...prev, ...newMidiEvents]);
      if (isWarmingUpRef.current) {
        isWarmingUpRef.current = false;
        setIsWarmingUp(false);
      }
    }
  };

  const generateNextStream = async () => {
    if (!isStreamActiveRef.current || isGeneratingRef.current) return;
    
    // Save current state to history before generating new content
    pushHistory(events);

    isGeneratingRef.current = true;
    setState(s => ({ ...s, isGenerating: true }));
    const startOffset = beatsGeneratedRef.current;
    beatsGeneratedRef.current += 8;
    
    // We pass the current 'events' state to the composer so it knows the full history
    // including manual edits.
    try {
      const generator = composer.streamComposition(
        state.genre as MusicGenre, 
        state.tempo, 
        events, // Pass full history
        startOffset, // The absolute beat where new music should start
        creativeDirection // Pass user prompt
      );
      
      for await (const chunk of generator) {
        if (!isStreamActiveRef.current) break;
        parseAndStore(chunk, startOffset);
      }
    } catch (e) {
      console.error("Stream failed", e);
      beatsGeneratedRef.current -= 8;
    } finally {
      isGeneratingRef.current = false;
      setState(s => ({ ...s, isGenerating: false }));
    }
  };

  const handleStart = async () => {
    audioEngine.init();
    audioEngine.setTempo(state.tempo);
    
    // Reset Everything
    beatsGeneratedRef.current = 0;
    playbackBeatRef.current = 0;
    scheduledNoteIds.current.clear();
    streamBufferRef.current = "";
    setHistory({ past: [], future: [] }); // Reset history on new session
    
    // Clear React State
    setPlaybackBeat(0);
    setEvents([]);
    setSelectedEventIds([]);
    setRawStream("");
    
    // Set Active State
    isStreamActiveRef.current = true;
    isWarmingUpRef.current = true;
    setIsWarmingUp(true);
    
    // Start playing immediately
    isPausedRef.current = false;
    setIsPaused(false);
    
    setState(s => ({ ...s, isPlaying: true }));
    // Removed explicit generateNextStream() to let the useEffect loop trigger it 
    // after the state resets are propagated. This ensures history is clean.
  };

  const handleSeek = (beat: number) => {
    playbackBeatRef.current = Math.max(0, beat);
    setPlaybackBeat(playbackBeatRef.current);
    scheduledNoteIds.current.clear();
  };

  const handleInjectUserNotes = () => {
    if (validation.validEvents.length === 0 || validation.errors.length > 0) return;
    pushHistory(events); // Save History
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
    // Sort events by absolute time
    const sortedEvents = [...events].sort((a, b) => 
      (a.beatOffset + a.event.t) - (b.beatOffset + b.event.t)
    );

    let output = `# Neural Composer Export\n# Genre: ${state.genre}\n# Tempo: ${state.tempo}\n# Date: ${new Date().toLocaleString()}\n\n`;
    
    sortedEvents.forEach(e => {
       if (e.comment) {
         output += `\n${e.comment}\n`;
       }
       const absT = (e.beatOffset + e.event.t).toFixed(3);
       const d = e.event.d.toFixed(3);
       output += `[P:${e.event.p},V:${e.event.v},T:${absT},D:${d}]\n`;
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
    
    // Find min beat to normalize relative positions
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

    // Also write to system clipboard
    const clipboardText = clipboardData.map(item => 
      `${item.comment ? `\n${item.comment}\n` : ''}[P:${item.event.p},V:${item.event.v},T:${item.relativeBeat.toFixed(3)},D:${item.event.d.toFixed(3)}]`
    ).join(' ');
    
    navigator.clipboard.writeText(clipboardText).catch(err => console.error('Failed to write to clipboard', err));

  }, [selectedEventIds, events]);

  const handleCut = useCallback(() => {
    if (selectedEventIds.length === 0) return;
    pushHistory(events); // Save History
    handleCopy();
    setEvents(prev => prev.filter(item => !selectedEventIds.includes(item.id)));
    setSelectedEventIds([]);
  }, [selectedEventIds, events, handleCopy, pushHistory]);

  const handlePaste = useCallback(() => {
    if (clipboard.length === 0) return;
    pushHistory(events); // Save History
    const pasteBaseBeat = playbackBeatRef.current;
    
    const newEvents = clipboard.map((item, idx) => {
      const id = `paste-${pasteBaseBeat}-${idx}-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
      return {
        event: { ...item.event, t: item.relativeBeat },
        beatOffset: pasteBaseBeat,
        id: id,
        isUser: true,
        comment: item.comment
      };
    });

    setEvents(prev => [...prev, ...newEvents]);
    setSelectedEventIds(newEvents.map(e => e.id));
  }, [clipboard, events, pushHistory]);

  const handleDelete = useCallback(() => {
    if (selectedEventIds.length === 0) return;
    pushHistory(events); // Save History
    setEvents(prev => prev.filter(item => !selectedEventIds.includes(item.id)));
    setSelectedEventIds([]);
  }, [selectedEventIds, events, pushHistory]);

  const handleMoveSelection = (deltaBeat: number, deltaPitch: number, ids: string[]) => {
    if (ids.length === 0) return;
    pushHistory(events); // Save History
    
    setEvents(prev => prev.map(item => {
      if (ids.includes(item.id)) {
        return {
          ...item,
          beatOffset: item.beatOffset + deltaBeat,
          event: {
            ...item.event,
            p: Math.max(0, Math.min(127, item.event.p + Math.round(deltaPitch)))
          },
          isUser: true
        };
      }
      return item;
    }));
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isCtrl = e.ctrlKey || e.metaKey;
      const isInputActive = document.activeElement?.tagName === 'TEXTAREA' || document.activeElement?.tagName === 'INPUT';

      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (!isInputActive) {
          handleDelete();
        }
        return;
      }

      if (!isCtrl) return;

      if (e.key === 'z' || e.key === 'Z') {
        e.preventDefault();
        if (e.shiftKey) {
          redo();
        } else {
          undo();
        }
      } else if (e.key === 'y' || e.key === 'Y') {
        e.preventDefault();
        redo();
      } else if (e.key === 'c' || e.key === 'C') {
        if (!isInputActive) {
           e.preventDefault();
           handleCopy();
        }
      } else if (e.key === 'v' || e.key === 'V') {
        if (!isInputActive) {
          handlePaste();
        }
      } else if (e.key === 'x' || e.key === 'X') {
        if (!isInputActive) {
          handleCut();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleCopy, handlePaste, handleCut, handleDelete, undo, redo]);

  const togglePlayback = () => {
    audioEngine.init(); 
    if (!state.isPlaying) {
      setState(s => ({ ...s, isPlaying: true }));
      isPausedRef.current = false;
      setIsPaused(false);
    } else {
      isPausedRef.current = !isPausedRef.current;
      setIsPaused(isPausedRef.current);
      scheduledNoteIds.current.clear();
    }
  };

  const handleHardStop = () => {
    isStreamActiveRef.current = false;
    isWarmingUpRef.current = false;
    isGeneratingRef.current = false;
    
    audioEngine.stopAll();
    
    beatsGeneratedRef.current = 0;
    playbackBeatRef.current = 0;
    scheduledNoteIds.current.clear();
    streamBufferRef.current = "";
    isPausedRef.current = true;
    setHistory({ past: [], future: [] });
    
    setIsWarmingUp(false);
    setIsPaused(true);
    setPlaybackBeat(0);
    setEvents([]);
    setSelectedEventIds([]);
    setRawStream("");
    
    setState(s => ({ ...s, isPlaying: false, isGenerating: false }));
    // NOT clearing creativeDirection (persists)
  };

  const bufferRemaining = Math.max(0, beatsGeneratedRef.current - playbackBeat);
  const totalViewRange = Math.max(beatsGeneratedRef.current, playbackBeat + 32, 128);

  return (
    <div className="min-h-screen flex flex-col p-4 md:p-8 max-w-7xl mx-auto overflow-hidden bg-[#020408]">
      <header className="flex flex-col md:flex-row justify-between items-center gap-4 mb-6">
        <div className="flex items-center gap-4">
          <div className={`p-3 rounded-2xl transition-all duration-1000 ${state.isPlaying ? 'bg-indigo-600 shadow-[0_0_30px_rgba(79,70,229,0.3)]' : 'bg-slate-900'}`}>
            <Zap className={`${state.isPlaying && !isPaused ? 'text-white fill-white animate-pulse' : 'text-slate-700'}`} size={28} />
          </div>
          <div>
            <h1 className="text-3xl font-black tracking-tighter text-white uppercase italic">Neural Composer</h1>
            <div className="flex items-center gap-2">
               <span className={`w-2 h-2 rounded-full ${isStreamActiveRef.current ? 'bg-emerald-500 animate-ping' : 'bg-slate-800'}`} />
               <p className="text-slate-500 text-[10px] font-black uppercase tracking-widest">
                 {isStreamActiveRef.current ? 'AI Stream Active' : state.isPlaying ? 'Manual Mode' : 'Ready'}
               </p>
            </div>
          </div>
        </div>
        
        <div className="flex gap-3 items-center bg-slate-900/50 backdrop-blur-xl p-2 rounded-2xl border border-white/5">
          <div className="flex items-center gap-1 border-r border-white/10 pr-2 mr-1">
            <button onClick={() => handleSeek(0)} className="p-2 hover:bg-white/10 rounded-lg text-slate-400">
              <RotateCcw size={18} />
            </button>
            <button onClick={togglePlayback} className={`p-2 rounded-lg ${isPaused ? 'bg-emerald-500/20 text-emerald-500' : 'bg-amber-500/20 text-amber-500'}`}>
              {isPaused ? <Play size={18} fill="currentColor" /> : <Pause size={18} fill="currentColor" />}
            </button>
          </div>

          {/* New BPM Selector */}
          <div className="flex items-center bg-black rounded-xl border border-white/5 p-1 mr-1">
             <div className="px-2 border-r border-white/10 flex items-center gap-2 mr-1">
                <Gauge size={14} className="text-slate-600" />
                <span className="text-[10px] font-black text-slate-600 hidden xl:inline">BPM</span>
             </div>
             
             <button 
               onClick={() => updateBpm(state.tempo - 1)} 
               className="w-6 h-8 flex items-center justify-center hover:bg-white/10 rounded-lg text-slate-500 hover:text-indigo-400 transition-colors active:scale-90"
             >
               <Minus size={12} />
             </button>
             
             <input 
                 type="number" 
                 value={tempBpm}
                 onChange={(e) => setTempBpm(e.target.value)}
                 onBlur={handleBpmBlur}
                 onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                 className="w-10 bg-transparent text-sm font-bold text-white text-center focus:outline-none appearance-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
             />

             <button 
               onClick={() => updateBpm(state.tempo + 1)} 
               className="w-6 h-8 flex items-center justify-center hover:bg-white/10 rounded-lg text-slate-500 hover:text-indigo-400 transition-colors active:scale-90"
             >
               <Plus size={12} />
             </button>
          </div>

          <select 
            className="bg-black border-none text-xs font-bold rounded-xl px-4 py-2.5 cursor-pointer hover:bg-slate-900"
            value={state.genre}
            onChange={(e) => setState(s => ({ ...s, genre: e.target.value }))}
          >
            {Object.values(MusicGenre).map(g => (<option key={g} value={g}>{g}</option>))}
          </select>
          {!state.isPlaying && events.length === 0 ? (
            <button onClick={handleStart} className="px-6 py-2.5 bg-indigo-600 hover:bg-indigo-500 rounded-xl font-bold text-sm text-white shadow-xl">
              INITIALIZE
            </button>
          ) : (
            <div className="flex gap-2">
              <button onClick={isStreamActiveRef.current 
                  ? () => { isStreamActiveRef.current = false; setState(s => ({ ...s, isGenerating: false })); } 
                  : () => { 
                      isStreamActiveRef.current = true; 
                      // Sync generation to start ahead of current playhead if restarting
                      beatsGeneratedRef.current = Math.max(beatsGeneratedRef.current, Math.ceil(playbackBeatRef.current));
                      generateNextStream(); 
                    }}
                className={`flex items-center gap-2 px-4 py-2.5 rounded-xl font-bold text-xs border ${isStreamActiveRef.current ? 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20' : 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20'}`}>
                {isStreamActiveRef.current ? <><Disc size={14} className="animate-spin" /> FREEZE AI</> : <><RefreshCw size={14} /> UNFREEZE AI</>}
              </button>
              <button onClick={handleHardStop} className="px-4 py-2.5 bg-red-500/10 text-red-500 border border-red-500/20 rounded-xl font-bold text-xs">
                RESET
              </button>
            </div>
          )}
        </div>
      </header>

      <main className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-6 min-h-0">
        <div className="lg:col-span-9 flex flex-col gap-4">
          <div className="relative flex-1 min-h-[350px] border border-white/5 rounded-3xl overflow-hidden bg-black shadow-inner">
            <PianoRoll 
              events={events} 
              currentBeat={playbackBeat} 
              selectedNoteIds={selectedEventIds}
              selectionMarquee={selectionMarquee}
              onSeek={handleSeek}
              onSelectionMarqueeChange={setSelectionMarquee}
              onSelectNotes={setSelectedEventIds}
              onMoveSelection={handleMoveSelection}
            />
            {isWarmingUp && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/95 backdrop-blur-xl z-20">
                <Loader2 className="animate-spin text-indigo-500 mb-4" size={64} />
                <h2 className="text-2xl font-black text-white uppercase italic">Connecting Neural Link...</h2>
              </div>
            )}
            
            {/* Floating Toolbar */}
            <div className={`absolute bottom-6 right-6 flex flex-col gap-2 z-30 transition-all duration-300`}>
              <div className="bg-slate-900/80 backdrop-blur-md border border-indigo-500/20 p-2 rounded-2xl flex items-center gap-1 shadow-2xl">
                
                {/* Undo / Redo */}
                <button 
                  onClick={undo}
                  disabled={history.past.length === 0}
                  title="Undo (Ctrl+Z)"
                  className="p-3 disabled:opacity-30 hover:bg-white/5 text-slate-400 rounded-xl transition-all flex flex-col items-center gap-1 min-w-[50px]"
                >
                  <Undo size={18} />
                  <span className="text-[8px] font-black uppercase opacity-50">Undo</span>
                </button>
                <button 
                  onClick={redo}
                  disabled={history.future.length === 0}
                  title="Redo (Ctrl+Y)"
                  className="p-3 disabled:opacity-30 hover:bg-white/5 text-slate-400 rounded-xl transition-all flex flex-col items-center gap-1 min-w-[50px]"
                >
                  <Redo size={18} />
                  <span className="text-[8px] font-black uppercase opacity-50">Redo</span>
                </button>

                <div className="w-px h-8 bg-white/5 mx-1" />

                {selectedEventIds.length > 0 ? (
                  <>
                    <button 
                      onClick={handleDelete}
                      title="Delete Selected (Del)"
                      className="p-3 hover:bg-red-500/20 text-red-400 rounded-xl transition-all flex flex-col items-center gap-1 min-w-[50px]"
                    >
                      <Trash2 size={18} />
                      <span className="text-[8px] font-black uppercase opacity-50">DEL</span>
                    </button>
                    <div className="w-px h-8 bg-white/5 mx-1" />
                    <button 
                      onClick={handleCut}
                      title="Cut Selected (Ctrl+X)"
                      className="p-3 hover:bg-red-500/20 text-red-400 rounded-xl transition-all flex flex-col items-center gap-1 min-w-[50px]"
                    >
                      <Scissors size={18} />
                      <span className="text-[8px] font-black uppercase opacity-50">^X</span>
                    </button>
                    <button 
                      onClick={handleCopy}
                      title="Copy Selected (Ctrl+C)"
                      className="p-3 hover:bg-indigo-500/20 text-indigo-400 rounded-xl transition-all flex flex-col items-center gap-1 min-w-[50px]"
                    >
                      <Copy size={18} />
                      <span className="text-[8px] font-black uppercase opacity-50">^C</span>
                    </button>
                    <div className="w-px h-8 bg-white/5 mx-1" />
                    <button 
                      onClick={() => setSelectedEventIds([])}
                      title="Clear Selection"
                      className="p-3 hover:bg-slate-800 text-slate-500 rounded-xl transition-all"
                    >
                      <X size={18} />
                    </button>
                  </>
                ) : (
                  clipboard.length > 0 && (
                    <button 
                      onClick={handlePaste}
                      title="Paste at Playhead (Ctrl+V)"
                      className="p-3 hover:bg-emerald-500/20 text-emerald-400 rounded-xl transition-all flex flex-col items-center gap-1 min-w-[50px]"
                    >
                      <ClipboardPaste size={18} />
                      <span className="text-[8px] font-black uppercase opacity-50">^V</span>
                    </button>
                  )
                )}
              </div>
            </div>

            <div className="absolute bottom-0 left-0 w-full h-1 bg-white/5 overflow-hidden">
               <div className="h-full bg-indigo-500 transition-all shadow-[0_0_10px_#6366f1]" style={{ width: `${Math.min(100, (bufferRemaining / queueThreshold) * 100)}%` }} />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 h-48">
            <div className="bg-slate-950/50 rounded-2xl border border-white/5 p-4 font-mono text-[10px] flex flex-col overflow-hidden">
               <div className="flex items-center gap-2 text-slate-500 uppercase font-black mb-2 border-b border-white/5 pb-1">
                  <Terminal size={12} /> Neural Stream
               </div>
               <div className="flex-1 text-indigo-400/40 break-all overflow-y-auto custom-scrollbar italic leading-relaxed">
                 {rawStream || "Standby..."}
                 <span className="w-1.5 h-3 bg-indigo-600 inline-block ml-1 animate-pulse" />
               </div>
            </div>

            <div className="bg-slate-950/80 rounded-2xl border border-indigo-500/10 p-4 flex flex-col overflow-hidden group hover:border-indigo-500/30 transition-all">
               <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2 text-indigo-400 uppercase font-black text-[10px]">
                    <Cpu size={12} /> Manual Patch Bay
                  </div>
                  <div className="flex items-center gap-2">
                    {userInput && validation.errors.length === 0 && (
                      <span className="text-[9px] font-black text-emerald-500 flex items-center gap-1 uppercase">
                        <CheckCircle2 size={10} /> {validation.validEvents.length} READY
                      </span>
                    )}
                    <button 
                      onClick={handleInjectUserNotes}
                      disabled={validation.validEvents.length === 0 || validation.errors.length > 0}
                      className={`px-3 py-1 rounded-lg font-black text-[9px] uppercase transition-all flex items-center gap-1 ${
                        validation.validEvents.length > 0 && validation.errors.length === 0 
                        ? 'bg-indigo-600 text-white hover:bg-indigo-500 active:scale-95 shadow-lg shadow-indigo-500/20' 
                        : 'bg-slate-800 text-slate-500 cursor-not-allowed opacity-50'
                      }`}
                    >
                      <PlusCircle size={10} /> Inject
                    </button>
                  </div>
               </div>
               
               <div className="flex-1 flex flex-col gap-2 min-h-0">
                  <textarea 
                    value={userInput}
                    onChange={(e) => setUserInput(e.target.value)}
                    placeholder="e.g. # Intro Melody\n[P:60,V:100,T:0,D:1]\n[P:62,V:100,T:1,D:1] means C4 followed by D4 at volume 100 start on beat 0 and 1 for 1 beat each."
                    className="flex-1 bg-black/40 border border-white/5 rounded-xl p-3 font-mono text-[11px] text-white focus:outline-none focus:ring-1 ring-indigo-500/50 placeholder:text-slate-700 resize-none"
                  />
                  <div className="h-10 overflow-y-auto custom-scrollbar bg-black/20 rounded-lg p-2 font-mono text-[9px]">
                    {validation.errors.length > 0 ? (
                      <div className="text-amber-500 space-y-1 animate-pulse">
                        {validation.errors.map((err, i) => (
                          <div key={i} className="flex items-start gap-1">
                            <AlertTriangle size={8} className="mt-0.5" /> {err.message}
                          </div>
                        ))}
                      </div>
                    ) : userInput ? (
                      <div className="text-emerald-500/70 italic flex items-center gap-1">
                        <CheckCircle2 size={8} /> Syntax Valid. Ready to sequence at T+{playbackBeat.toFixed(1)}
                      </div>
                    ) : (
                      <div className="text-slate-500 flex flex-col justify-center h-full gap-1">
                        <div className="text-slate-600 flex items-center gap-1">
                          <Scissors size={8} /> Lines starting with # are comments
                        </div>
                      </div>
                    )}
                  </div>
               </div>
            </div>
          </div>
        </div>

        <div className="lg:col-span-3 space-y-6">
          <div className="bg-slate-900/20 p-6 rounded-3xl border border-white/5 h-full flex flex-col">
            <h3 className="text-xs font-black text-slate-600 mb-8 uppercase tracking-widest flex items-center gap-2">
              <Disc size={16} className="text-indigo-500" /> Session Control
            </h3>
            
            <div className="space-y-6 flex-1">
              <div className="p-5 bg-black/40 rounded-2xl border border-white/5">
                 <div className="text-[10px] font-bold text-slate-600 uppercase mb-2">Playhead</div>
                 <div className="text-4xl font-black text-white tabular-nums tracking-tighter mb-2">
                   {Math.floor(playbackBeat / 4)}.<span className="text-indigo-500">{(Math.floor(playbackBeat % 4) + 1)}</span>
                 </div>
                 <div className="text-[9px] text-slate-700 font-bold uppercase tracking-widest">Measure.Beat</div>
              </div>

              {/* Time Navigator Widget */}
              <div className="p-5 bg-black/40 rounded-2xl border border-white/5">
                 <TimeNavigator 
                  currentBeat={playbackBeat} 
                  totalBeats={totalViewRange} 
                  onSeek={handleSeek} 
                />
              </div>

              <div className="p-5 bg-black/40 rounded-2xl border border-white/5">
                 <div className="text-[10px] font-bold text-slate-600 uppercase mb-2">Composition History</div>
                 <div className="flex items-baseline gap-1 mb-1">
                    <div className="text-3xl font-black tabular-nums tracking-tighter text-indigo-400">
                      {events.filter(e => e.isUser).length}
                    </div>
                    <span className="text-[10px] text-slate-700 font-black uppercase">manual</span>
                    <span className="mx-2 text-slate-800">|</span>
                    <div className="text-3xl font-black tabular-nums tracking-tighter text-indigo-800">
                      {events.filter(e => !e.isUser).length}
                    </div>
                    <span className="text-[10px] text-slate-700 font-black uppercase">neural</span>
                 </div>
                 <div className="mt-2 text-[9px] text-slate-600 flex flex-col gap-1 italic uppercase font-bold">
                    <div className="flex items-center gap-1">
                       <History size={10} /> Total: {events.length} events
                    </div>
                    <div className="flex items-center gap-1">
                       <Copy size={10} /> Clipboard: {clipboard.length > 0 ? `${clipboard.length} notes` : 'Empty'}
                    </div>
                 </div>
                 {events.length > 0 && (
                   <button 
                      onClick={handleDownload}
                      className="w-full mt-4 py-2 bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-400 rounded-lg border border-indigo-500/20 text-[10px] font-bold uppercase flex items-center justify-center gap-2 transition-all"
                   >
                      <Download size={12} /> Export Session
                   </button>
                 )}
              </div>

              <div className="mt-auto p-4 bg-indigo-500/5 rounded-2xl border border-indigo-500/10">
                 <div className="text-[9px] font-black text-indigo-400 uppercase mb-2 flex items-center gap-2">
                    <Sparkles size={10} /> Creative Direction
                 </div>
                 <textarea
                    value={creativeDirection}
                    onChange={(e) => setCreativeDirection(e.target.value)}
                    placeholder="e.g. Use a walking bass line, keep it sparse, add erratic drum fills..."
                    className="w-full bg-slate-900/50 border border-indigo-500/10 rounded-lg p-2 text-[10px] text-slate-300 focus:outline-none focus:border-indigo-500/50 resize-none h-24"
                 />
              </div>
            </div>
          </div>
        </div>
      </main>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar { width: 2px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #1e293b; border-radius: 10px; }
      `}</style>
    </div>
  );
};

export default App;
