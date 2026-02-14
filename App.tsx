
import React, { useState, useEffect, useRef } from 'react';
import { MusicGenre, MidiEvent, CompositionState } from './types';
import { audioEngine } from './services/audioEngine';
import { composer } from './services/geminiComposer';
import PianoRoll from './components/PianoRoll';
import { 
  Play, 
  Pause, 
  Square, 
  Music, 
  Zap, 
  RefreshCw, 
  Terminal, 
  Loader2, 
  Disc, 
  StopCircle, 
  RotateCcw,
  FastForward,
  SkipBack
} from 'lucide-react';

const App: React.FC = () => {
  const [state, setState] = useState<CompositionState>({
    isPlaying: false, // Overall engine state
    tempo: 124,
    genre: MusicGenre.CYBERPUNK,
    isGenerating: false,
  });

  const [playbackBeat, setPlaybackBeat] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const [events, setEvents] = useState<{ event: MidiEvent; beatOffset: number; id: string }[]>([]);
  const [rawStream, setRawStream] = useState("");
  const [isWarmingUp, setIsWarmingUp] = useState(false);
  
  const beatsGeneratedRef = useRef(0);
  const isStreamActiveRef = useRef(false); 
  const isGeneratingRef = useRef(false); 
  const isWarmingUpRef = useRef(false);
  const streamBufferRef = useRef("");
  
  const playbackBeatRef = useRef(0);
  const isPausedRef = useRef(true);
  const lastUpdateRef = useRef(performance.now());
  const scheduledNoteIds = useRef(new Set<string>());
  const timelineRef = useRef<HTMLDivElement>(null);
  
  const queueThreshold = 12; 

  // Main UI and Playback Loop
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

        // JIT Scheduling
        // Check notes in the next 100ms window (about 0.2 beats at 120bpm)
        const lookaheadBeats = 0.5;
        const currentBeat = playbackBeatRef.current;
        
        events.forEach(item => {
          const absoluteStart = item.beatOffset + item.event.t;
          if (absoluteStart >= currentBeat && absoluteStart < currentBeat + lookaheadBeats) {
            if (!scheduledNoteIds.current.has(item.id)) {
              audioEngine.scheduleNote(item.event, absoluteStart, currentBeat);
              scheduledNoteIds.current.add(item.id);
            }
          }
        });

        // Trigger more generation if the stream is active and we are reaching the end of the buffer
        const remainingInQueue = beatsGeneratedRef.current - playbackBeatRef.current;
        if (isStreamActiveRef.current && remainingInQueue < queueThreshold && !isGeneratingRef.current) {
          generateNextStream();
        }
      }

      animationId = requestAnimationFrame(tick);
    };

    animationId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animationId);
  }, [state.isPlaying, events, state.tempo]);

  const parseAndStore = (textChunk: string, baseBeatOffset: number) => {
    streamBufferRef.current += textChunk;
    setRawStream(prev => (prev + textChunk).slice(-800));

    const regex = /\[\s*P:\s*(\d+)\s*,\s*V:\s*(\d+)\s*,\s*T:\s*([\d.]+)\s*,\s*D:\s*([\d.]+)\s*\]/g;
    let match;
    const newMidiEvents: { event: MidiEvent; beatOffset: number; id: string }[] = [];

    while ((match = regex.exec(streamBufferRef.current)) !== null) {
      const event: MidiEvent = {
        p: parseInt(match[1]),
        v: parseInt(match[2]),
        t: parseFloat(match[3]),
        d: parseFloat(match[4])
      };
      
      newMidiEvents.push({ 
        event, 
        beatOffset: baseBeatOffset,
        id: `note-${baseBeatOffset}-${match.index}-${event.p}`
      });
    }

    if (newMidiEvents.length > 0) {
      streamBufferRef.current = streamBufferRef.current.replace(/\[\s*P:\s*(\d+)\s*,\s*V:\s*(\d+)\s*,\s*T:\s*([\d.]+)\s*,\s*D:\s*([\d.]+)\s*\]/g, "");
      
      setEvents(prev => [...prev, ...newMidiEvents]);
      
      if (isWarmingUpRef.current) {
        isWarmingUpRef.current = false;
        setIsWarmingUp(false);
        isPausedRef.current = false;
        setIsPaused(false);
      }
    }
  };

  const generateNextStream = async () => {
    if (!isStreamActiveRef.current || isGeneratingRef.current) return;
    
    isGeneratingRef.current = true;
    setState(s => ({ ...s, isGenerating: true }));
    
    const startOffset = beatsGeneratedRef.current;
    beatsGeneratedRef.current += 8;
    
    try {
      const generator = composer.streamComposition(state.genre as MusicGenre, state.tempo);
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
    
    isStreamActiveRef.current = true;
    isWarmingUpRef.current = true;
    isPausedRef.current = true;
    setIsPaused(true);
    
    beatsGeneratedRef.current = 0;
    playbackBeatRef.current = 0;
    setPlaybackBeat(0);
    streamBufferRef.current = "";
    scheduledNoteIds.current.clear();
    
    setEvents([]);
    setRawStream("");
    setIsWarmingUp(true);
    setState(s => ({ ...s, isPlaying: true }));
    
    generateNextStream();
  };

  const togglePlayback = () => {
    isPausedRef.current = !isPausedRef.current;
    setIsPaused(isPausedRef.current);
    scheduledNoteIds.current.clear();
  };

  const handleRewind = () => {
    playbackBeatRef.current = 0;
    setPlaybackBeat(0);
    scheduledNoteIds.current.clear();
  };

  const handleTimelineSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!state.isPlaying || !timelineRef.current) return;
    const rect = timelineRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const percentage = Math.max(0, Math.min(1, x / rect.width));
    const targetBeat = percentage * beatsGeneratedRef.current;
    
    playbackBeatRef.current = targetBeat;
    setPlaybackBeat(targetBeat);
    scheduledNoteIds.current.clear();
  };

  const handleStopStream = () => {
    isStreamActiveRef.current = false;
    setState(s => ({ ...s, isGenerating: false }));
  };

  const handleHardStop = () => {
    isStreamActiveRef.current = false;
    isWarmingUpRef.current = false;
    isPausedRef.current = true;
    audioEngine.stopAll();
    setIsWarmingUp(false);
    setIsPaused(true);
    setState(s => ({ ...s, isPlaying: false, isGenerating: false }));
  };

  const bufferRemaining = Math.max(0, beatsGeneratedRef.current - playbackBeat);

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
          {state.isPlaying && (
            <div className="flex items-center gap-1 border-r border-white/10 pr-2 mr-1">
              <button 
                onClick={handleRewind}
                className="p-2 hover:bg-white/10 rounded-lg text-slate-400 transition-colors"
                title="Rewind to start"
              >
                <RotateCcw size={18} />
              </button>
              <button 
                onClick={togglePlayback}
                className={`p-2 rounded-lg transition-all ${isPaused ? 'bg-emerald-500/20 text-emerald-500' : 'bg-amber-500/20 text-amber-500'}`}
              >
                {isPaused ? <Play size={18} fill="currentColor" /> : <Pause size={18} fill="currentColor" />}
              </button>
            </div>
          )}

          <select 
            className="bg-black border-none text-xs font-bold rounded-xl px-4 py-2.5 focus:ring-2 ring-indigo-500 cursor-pointer hover:bg-slate-900 transition-colors"
            value={state.genre}
            onChange={(e) => setState(s => ({ ...s, genre: e.target.value }))}
            disabled={state.isPlaying}
          >
            {Object.values(MusicGenre).map(g => (
              <option key={g} value={g}>{g}</option>
            ))}
          </select>

          {!state.isPlaying ? (
            <button
              onClick={handleStart}
              className="flex items-center gap-2 px-6 py-2.5 bg-indigo-600 hover:bg-indigo-500 rounded-xl font-bold text-sm text-white shadow-xl shadow-indigo-500/10 transition-all transform active:scale-95"
            >
              <Play size={16} fill="white" /> INITIALIZE
            </button>
          ) : (
            <div className="flex gap-2">
              <button
                onClick={isStreamActiveRef.current ? handleStopStream : () => { isStreamActiveRef.current = true; generateNextStream(); }}
                className={`flex items-center gap-2 px-4 py-2.5 rounded-xl font-bold text-xs border transition-all ${
                  isStreamActiveRef.current 
                  ? 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20' 
                  : 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20'
                }`}
              >
                {isStreamActiveRef.current ? <><Disc size={14} className="animate-spin" /> FREEZE AI</> : <><RefreshCw size={14} /> UNFREEZE AI</>}
              </button>
              <button
                onClick={handleHardStop}
                className="flex items-center gap-2 px-4 py-2.5 bg-red-500/10 text-red-500 border border-red-500/20 rounded-xl font-bold text-xs hover:bg-red-500 hover:text-white transition-all"
              >
                <StopCircle size={14} /> RESET ALL
              </button>
            </div>
          )}
        </div>
      </header>

      <main className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-6 min-h-0">
        <div className="lg:col-span-9 flex flex-col gap-4">
          <div className="relative flex-1 min-h-[400px] border border-white/5 rounded-3xl overflow-hidden shadow-2xl bg-black">
            <PianoRoll 
              events={events} 
              currentBeat={playbackBeat} 
              onSeek={(beat) => {
                playbackBeatRef.current = beat;
                setPlaybackBeat(beat);
                scheduledNoteIds.current.clear();
              }}
            />
            
            {isWarmingUp && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/95 backdrop-blur-xl z-20">
                <div className="relative mb-8">
                   <div className="absolute inset-0 blur-3xl bg-indigo-500/30 animate-pulse rounded-full" />
                   <Loader2 className="animate-spin text-indigo-500 relative" size={72} strokeWidth={1.5} />
                </div>
                <h2 className="text-3xl font-black text-white tracking-tighter uppercase italic mb-2">Syncing Neural Grid</h2>
                <div className="flex items-center gap-3 text-slate-600 font-mono text-xs uppercase tracking-widest">
                  <span className="w-8 h-[1px] bg-slate-800" />
                  Generating Start Buffer
                  <span className="w-8 h-[1px] bg-slate-800" />
                </div>
              </div>
            )}

            <div className="absolute top-6 left-6 flex flex-col gap-2 z-10 pointer-events-none">
              {state.isGenerating && (
                <div className="flex items-center gap-3 bg-indigo-500/20 backdrop-blur-md px-4 py-2 rounded-2xl border border-indigo-500/30 text-[10px] font-black text-indigo-400">
                  <RefreshCw size={14} className="animate-spin" /> AI THINKING
                </div>
              )}
              {isPaused && state.isPlaying && (
                <div className="flex items-center gap-3 bg-amber-500/20 backdrop-blur-md px-4 py-2 rounded-2xl border border-amber-500/30 text-[10px] font-black text-amber-400">
                  <Pause size={14} /> PLAYBACK PAUSED
                </div>
              )}
            </div>

            <div className="absolute bottom-0 left-0 w-full h-1 bg-white/5 overflow-hidden">
               <div 
                 className="h-full bg-indigo-500 transition-all duration-300 shadow-[0_0_10px_#6366f1]" 
                 style={{ width: `${Math.min(100, (bufferRemaining / queueThreshold) * 100)}%` }}
               />
            </div>
          </div>

          <div className="h-40 bg-slate-950/50 rounded-2xl border border-white/5 p-5 font-mono text-[10px] overflow-hidden flex flex-col">
             <div className="flex items-center justify-between mb-3 border-b border-white/5 pb-2">
                <div className="text-slate-500 flex items-center gap-2 uppercase tracking-tighter font-bold">
                  <Terminal size={14} /> Token Stream
                </div>
             </div>
             <div className="flex-1 text-indigo-400/40 break-all overflow-y-auto custom-scrollbar leading-relaxed">
               {rawStream || "Standby for signal..."}
               <span className="w-1.5 h-3 bg-indigo-600 inline-block ml-1 animate-pulse" />
             </div>
          </div>
        </div>

        <div className="lg:col-span-3 space-y-6">
          <div className="bg-slate-900/20 p-6 rounded-3xl border border-white/5 h-full flex flex-col">
            <h3 className="text-xs font-black text-slate-600 mb-8 uppercase tracking-widest flex items-center gap-2">
              <Disc size={16} className="text-indigo-500" /> Session Control
            </h3>
            
            <div className="space-y-6 flex-1">
              <div className="p-5 bg-black/40 rounded-2xl border border-white/5 group transition-colors hover:border-indigo-500/20">
                 <div className="text-[10px] font-bold text-slate-600 uppercase mb-2">Playhead</div>
                 <div className="text-4xl font-black text-white tabular-nums leading-none tracking-tighter mb-2">
                   {Math.floor(playbackBeat / 4)}.<span className="text-indigo-500">{(Math.floor(playbackBeat % 4) + 1)}</span>
                 </div>
                 <div className="text-[9px] text-slate-700 font-bold uppercase">Measure.Beat</div>
              </div>

              <div className="p-5 bg-black/40 rounded-2xl border border-white/5">
                 <div className="text-[10px] font-bold text-slate-600 uppercase mb-2">Timeline Range</div>
                 <div 
                   ref={timelineRef}
                   onClick={handleTimelineSeek}
                   className={`h-4 bg-slate-800/50 rounded-full overflow-hidden relative cursor-pointer group transition-all ${state.isPlaying ? 'hover:bg-slate-800' : 'cursor-not-allowed'}`}
                 >
                    <div 
                      className="absolute top-0 h-full bg-indigo-500 transition-all shadow-[0_0_15px_rgba(99,102,241,0.5)]" 
                      style={{ 
                        left: 0, 
                        width: `${(playbackBeat / Math.max(1, beatsGeneratedRef.current)) * 100}%` 
                      }} 
                    />
                    <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                       <span className="text-[8px] font-black text-white uppercase tracking-widest drop-shadow-md">Jump to Beat</span>
                    </div>
                 </div>
                 <div className="flex justify-between mt-2 text-[9px] font-bold text-slate-700 uppercase">
                    <span>Start</span>
                    <span>AI End ({Math.floor(beatsGeneratedRef.current)}b)</span>
                 </div>
              </div>

              <div className="p-5 bg-black/40 rounded-2xl border border-white/5">
                 <div className="text-[10px] font-bold text-slate-600 uppercase mb-2">Composition History</div>
                 <div className="flex items-baseline gap-1 mb-1">
                    <div className="text-3xl font-black tabular-nums tracking-tighter text-indigo-400">
                      {events.length}
                    </div>
                    <span className="text-[10px] text-slate-700 font-black uppercase">neural notes</span>
                 </div>
                 <div className="text-[10px] text-slate-600 italic">Continuous JIT scheduling active.</div>
              </div>

              <div className="mt-auto space-y-2">
                 <div className="p-4 bg-indigo-500/5 rounded-2xl border border-indigo-500/10">
                    <div className="text-[9px] font-black text-indigo-400 uppercase mb-1">Interactive Sidebar</div>
                    <p className="text-[10px] text-slate-600 leading-relaxed italic">
                      Click the timeline bar above to quickly scrub through the entire generated history.
                    </p>
                 </div>
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
