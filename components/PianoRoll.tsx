
import React, { useEffect, useRef } from 'react';
import { MidiEvent } from '../types';

interface PianoRollProps {
  events: { event: MidiEvent; beatOffset: number }[];
  currentBeat: number;
  onSeek?: (beat: number) => void;
}

const PianoRoll: React.FC<PianoRollProps> = ({ events, currentBeat, onSeek }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const beatWidth = 100;

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!onSeek || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const w = canvasRef.current.width;
    
    // Calculate what beat the clicked X corresponds to
    // The playhead (currentBeat) is always at (w / 2)
    const relativeX = x - (w / 2);
    const beatDelta = relativeX / beatWidth;
    const targetBeat = Math.max(0, currentBeat + beatDelta);
    onSeek(targetBeat);
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationFrame: number;

    const draw = () => {
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      const startX = (w / 2) - (currentBeat * beatWidth);

      // Grid Rendering
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 1;

      // Vertical beat lines
      const firstVisibleBeat = Math.floor(currentBeat - (w / 2) / beatWidth);
      const lastVisibleBeat = Math.ceil(currentBeat + (w / 2) / beatWidth);

      for (let i = Math.max(0, firstVisibleBeat); i <= lastVisibleBeat; i++) {
        const x = startX + (i * beatWidth);
        ctx.beginPath();
        ctx.strokeStyle = i % 4 === 0 ? '#1e293b' : '#0f172a';
        ctx.lineWidth = i % 4 === 0 ? 2 : 1;
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
        
        if (i % 4 === 0) {
          ctx.fillStyle = '#334155';
          ctx.font = '10px JetBrains Mono';
          ctx.fillText(`M${i/4 + 1}`, x + 5, 15);
        }
      }

      // Horizontal note lines (octaves)
      const noteHeight = h / 48; // About 4 octaves
      for (let i = 0; i < 48; i++) {
        const y = h - (i * noteHeight);
        ctx.beginPath();
        ctx.strokeStyle = i % 12 === 0 ? '#1e293b' : '#0a0f1a';
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }

      // Notes
      events.forEach(({ event, beatOffset }) => {
        const absoluteBeat = beatOffset + event.t;
        const x = startX + absoluteBeat * beatWidth;
        const width = event.d * beatWidth;
        const noteIndex = event.p - 36; // C2 as base
        const y = h - (noteIndex * noteHeight) - noteHeight;

        if (x + width < 0 || x > w) return;

        // Color based on pitch
        const hue = (event.p * 13) % 360;
        const isActive = currentBeat >= absoluteBeat && currentBeat <= absoluteBeat + event.d;
        
        ctx.fillStyle = isActive 
          ? `hsla(${hue}, 80%, 60%, 1)` 
          : `hsla(${hue}, 50%, 40%, 0.6)`;
        
        ctx.fillRect(x, y, width - 1, noteHeight - 1);
        
        if (isActive) {
          ctx.shadowBlur = 15;
          ctx.shadowColor = `hsla(${hue}, 80%, 60%, 0.8)`;
          ctx.strokeStyle = 'white';
          ctx.lineWidth = 1;
          ctx.strokeRect(x, y, width - 1, noteHeight - 1);
        }
        ctx.shadowBlur = 0;
      });

      // Playhead
      ctx.strokeStyle = '#6366f1';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(w / 2, 0);
      ctx.lineTo(w / 2, h);
      ctx.stroke();
      
      // Playhead Glow
      ctx.shadowBlur = 20;
      ctx.shadowColor = 'rgba(99, 102, 241, 0.4)';
      ctx.stroke();
      ctx.shadowBlur = 0;

      animationFrame = requestAnimationFrame(draw);
    };

    draw();
    return () => cancelAnimationFrame(animationFrame);
  }, [events, currentBeat]);

  return (
    <canvas 
      ref={canvasRef} 
      onClick={handleCanvasClick}
      className="w-full h-full rounded-lg bg-black cursor-crosshair" 
      width={1600} 
      height={800} 
    />
  );
};

export default PianoRoll;
