
import React, { useRef, useEffect } from 'react';

interface TimeNavigatorProps {
  currentBeat: number;
  totalBeats: number;
  onSeek: (beat: number) => void;
}

const TimeNavigator: React.FC<TimeNavigatorProps> = ({ currentBeat, totalBeats, onSeek }) => {
  const containerRef = useRef<HTMLDivElement>(null);

  const handleInteraction = (e: React.MouseEvent | React.TouchEvent) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = ('touches' in e) ? e.touches[0].clientX : (e as React.MouseEvent).clientX;
    const position = Math.max(0, Math.min(1, (x - rect.left) / rect.width));
    onSeek(position * totalBeats);
  };

  return (
    <div className="space-y-2">
      <div className="flex justify-between items-center text-[9px] font-black text-slate-600 uppercase tracking-widest">
        <span>Timeline Overview</span>
        <span className="text-indigo-500">{Math.floor(totalBeats)} Beats</span>
      </div>
      <div 
        ref={containerRef}
        onMouseDown={handleInteraction}
        className="relative h-8 bg-black/40 border border-white/5 rounded-xl cursor-pointer overflow-hidden group transition-all hover:border-indigo-500/30"
      >
        {/* Progress Background */}
        <div 
          className="absolute inset-y-0 left-0 bg-indigo-500/5 transition-all"
          style={{ width: `${(currentBeat / totalBeats) * 100}%` }}
        />
        
        {/* Playhead Marker */}
        <div 
          className="absolute inset-y-0 w-0.5 bg-indigo-500 shadow-[0_0_10px_#6366f1] z-10"
          style={{ left: `${(currentBeat / totalBeats) * 100}%` }}
        />

        {/* Visual Pulse for Playhead */}
        <div 
          className="absolute inset-y-0 w-4 bg-indigo-500/10 blur-sm"
          style={{ left: `calc(${(currentBeat / totalBeats) * 100}% - 8px)` }}
        />

        {/* Grid Markers */}
        <div className="absolute inset-0 flex justify-between px-1 pointer-events-none opacity-20">
          {[...Array(10)].map((_, i) => (
            <div key={i} className="w-px h-full bg-slate-700" />
          ))}
        </div>
      </div>
    </div>
  );
};

export default TimeNavigator;
