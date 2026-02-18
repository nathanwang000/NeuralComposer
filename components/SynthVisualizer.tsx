
import React, { useRef, useEffect } from 'react';
import { SynthConfig } from '../types';

interface SynthVisualizerProps {
  config: SynthConfig;
}

const SynthVisualizer: React.FC<SynthVisualizerProps> = ({ config }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const draw = () => {
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      // 1. Draw ADSR Envelope
      ctx.beginPath();
      ctx.strokeStyle = '#6366f1';
      ctx.lineWidth = 3;
      ctx.shadowBlur = 10;
      ctx.shadowColor = '#6366f1';

      const totalTime = config.attack + config.decay + 1.0 + config.release; // 1.0 for sustain hold visualization
      const scaleX = w / totalTime;
      const scaleY = h - 20;

      let curX = 0;
      ctx.moveTo(0, h);

      // Attack
      curX += config.attack;
      ctx.lineTo(curX * scaleX, h - scaleY);

      // Decay
      curX += config.decay;
      ctx.lineTo(curX * scaleX, h - (config.sustain * scaleY));

      // Sustain (visualized as a fixed duration segment)
      curX += 1.0; 
      ctx.lineTo(curX * scaleX, h - (config.sustain * scaleY));

      // Release
      curX += config.release;
      ctx.lineTo(curX * scaleX, h);

      ctx.stroke();
      ctx.shadowBlur = 0;

      // 2. Draw Filter Curve (simplified)
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(34, 211, 238, 0.4)';
      ctx.lineWidth = 2;
      
      const cutoffX = (Math.log10(config.cutoff) - 2) / (Math.log10(8000) - 2) * w;
      const resonanceHeight = config.resonance * 2;

      ctx.moveTo(0, h - 30);
      for(let x = 0; x < w; x++) {
        let y = h - 30;
        if (x < cutoffX) {
          // Flattening before cutoff with a bump for resonance
          const dist = Math.abs(x - cutoffX);
          if (dist < 40) {
            y -= (resonanceHeight * (1 - dist/40));
          }
        } else {
          // Steep drop after cutoff
          y += (x - cutoffX) * 2;
        }
        ctx.lineTo(x, Math.min(h, y));
      }
      ctx.stroke();
      
      // Cutoff Marker
      ctx.fillStyle = '#22d3ee';
      ctx.fillRect(cutoffX - 1, 0, 2, h);
    };

    draw();
  }, [config]);

  return (
    <div className="relative w-full h-32 bg-black rounded-xl border border-white/10 overflow-hidden mb-4 shadow-inner">
      <div className="absolute top-2 left-2 flex gap-2">
         <span className="text-[8px] font-black uppercase text-indigo-400 bg-indigo-500/10 px-1.5 py-0.5 rounded">Envelope</span>
         <span className="text-[8px] font-black uppercase text-cyan-400 bg-cyan-500/10 px-1.5 py-0.5 rounded">Filter</span>
      </div>
      <canvas ref={canvasRef} width={400} height={128} className="w-full h-full" />
    </div>
  );
};

export default SynthVisualizer;
