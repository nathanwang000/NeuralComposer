import React, { useEffect, useMemo, useRef, useState } from 'react';
import { MidiEvent } from '../types';

export interface SelectionBounds {
  startBeat: number;
  endBeat: number;
  minPitch: number;
  maxPitch: number;
}

interface PianoRollProps {
  events: { event: MidiEvent; beatOffset: number; isUser?: boolean; id: string }[];
  currentBeat: number;
  selectedNoteIds: string[];
  selectionMarquee: SelectionBounds | null;
  beatWidth?: number;
  /** Hex / CSS colour for this track's notes. Falls back to cyan for user notes. */
  trackColor?: string;
  /** When true, render grid in light-friendly colours. */
  light?: boolean;
  /** When true, touch interactions select/deselect notes instead of seeking. */
  selectMode?: boolean;
  onSeek?: (beat: number) => void;
  onSelectionMarqueeChange?: (bounds: SelectionBounds | null) => void;
  onSelectNotes?: (ids: string[]) => void;
  onMoveSelection?: (deltaBeat: number, deltaPitch: number, ids: string[]) => void;
  onZoomChange?: (newBeatWidth: number) => void;
}

const PianoRoll: React.FC<PianoRollProps> = ({
  events,
  currentBeat,
  selectedNoteIds,
  selectionMarquee,
  beatWidth = 100,
  trackColor = '#22d3ee',
  light = false,
  selectMode = false,
  onSeek,
  onSelectionMarqueeChange,
  onSelectNotes,
  onMoveSelection,
  onZoomChange,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [dragStart, setDragStart] = useState<{ x: number, y: number, beat: number, pitch: number } | null>(null);
  const [dragEnd, setDragEnd] = useState<{ x: number, y: number, beat: number, pitch: number } | null>(null);
  const [isMoving, setIsMoving] = useState(false);

  // Keep a ref so the wheel handler always sees the latest value without re-registering
  const beatWidthRef = useRef(beatWidth);
  useEffect(() => { beatWidthRef.current = beatWidth; }, [beatWidth]);

  // Compute the bounding box of the currently selected notes
  const selectionBounds = useMemo(() => {
    if (selectedNoteIds.length === 0) return null;
    let start = Infinity;
    let end = -Infinity;
    let minP = 127;
    let maxP = 0;
    let hasNotes = false;

    events.forEach(e => {
      if (selectedNoteIds.includes(e.id)) {
        hasNotes = true;
        const absStart = e.beatOffset + e.event.t;
        const absEnd = absStart + e.event.d;
        if (absStart < start) start = absStart;
        if (absEnd > end) end = absEnd;
        if (e.event.p < minP) minP = e.event.p;
        if (e.event.p > maxP) maxP = e.event.p;
      }
    });

    if (!hasNotes) return null;
    // Add small padding for easier clicking
    return { startBeat: start, endBeat: end, minPitch: minP, maxPitch: maxP };
  }, [selectedNoteIds, events]);

  const getMusicCoords = (x: number, y: number, canvas: HTMLCanvasElement) => {
    const w = canvas.width;
    const h = canvas.height;
    const relativeX = x - (w / 2);
    const beat = currentBeat + (relativeX / beatWidth);
    const noteHeight = h / 72;
    const pitch = Math.floor((h - y) / noteHeight) + 24;
    return { beat, pitch };
  };

  const isInsideRect = (beat: number, pitch: number, rect: SelectionBounds | null) => {
    if (!rect) return false;
    return beat >= rect.startBeat && beat <= rect.endBeat &&
           pitch >= rect.minPitch && pitch <= rect.maxPitch;
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (canvas.width / rect.width);
    const y = (e.clientY - rect.top) * (canvas.height / rect.height);

    const coords = getMusicCoords(x, y, canvas);

    // Check if clicking inside the existing selection bounds to move
    if (selectionBounds && isInsideRect(coords.beat, coords.pitch, selectionBounds)) {
      setIsMoving(true);
      setDragStart({ x, y, ...coords });
    } else {
      // Start new selection marquee
      setIsMoving(false);
      setDragStart({ x, y, ...coords });
      setDragEnd(null);
      if (onSelectNotes) onSelectNotes([]); // Deselect existing
    }
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!dragStart || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (canvas.width / rect.width);
    const y = (e.clientY - rect.top) * (canvas.height / rect.height);

    const coords = getMusicCoords(x, y, canvas);
    setDragEnd({ x, y, ...coords });

    if (!isMoving && onSelectionMarqueeChange) {
      onSelectionMarqueeChange({
        startBeat: Math.min(dragStart.beat, coords.beat),
        endBeat: Math.max(dragStart.beat, coords.beat),
        minPitch: Math.min(dragStart.pitch, coords.pitch),
        maxPitch: Math.max(dragStart.pitch, coords.pitch),
      });
    }
  };

  const handleMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!dragStart) return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (canvas.width / rect.width);
    const y = (e.clientY - rect.top) * (canvas.height / rect.height);
    const coords = getMusicCoords(x, y, canvas);

    const isClick = !dragEnd || (Math.abs(dragEnd.x - dragStart.x) < 5 && Math.abs(dragEnd.y - dragStart.y) < 5);

    if (isMoving) {
      if (!isClick && onMoveSelection) {
        onMoveSelection(coords.beat - dragStart.beat, coords.pitch - dragStart.pitch, selectedNoteIds);
      }
      setIsMoving(false);
    } else {
      if (isClick) {
        // Click without drag -> Seek
        if (onSeek) onSeek(Math.max(0, dragStart.beat));
        if (onSelectionMarqueeChange) onSelectionMarqueeChange(null);
        if (onSelectNotes) onSelectNotes([]);
      } else {
        // Marquee selection finished
        if (onSelectionMarqueeChange) onSelectionMarqueeChange(null);

        // Calculate what's inside the marquee
        if (onSelectNotes) {
           const selectionRect = {
              startBeat: Math.min(dragStart.beat, coords.beat),
              endBeat: Math.max(dragStart.beat, coords.beat),
              minPitch: Math.min(dragStart.pitch, coords.pitch),
              maxPitch: Math.max(dragStart.pitch, coords.pitch),
           };

           const captured = events.filter(({ event, beatOffset }) => {
              const absoluteStart = beatOffset + event.t;
              const absoluteEnd = absoluteStart + event.d;
              return absoluteStart < selectionRect.endBeat && absoluteEnd > selectionRect.startBeat &&
                     event.p >= selectionRect.minPitch && event.p <= selectionRect.maxPitch;
           }).map(n => n.id);

           onSelectNotes(captured);
        }
      }
    }

    setDragStart(null);
    setDragEnd(null);
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
      const noteHeight = h / 72;

      // Vertical beat lines
      const firstVisibleBeat = Math.floor(currentBeat - (w / 2) / beatWidth);
      const lastVisibleBeat = Math.ceil(currentBeat + (w / 2) / beatWidth);

      for (let i = Math.max(0, firstVisibleBeat); i <= lastVisibleBeat; i++) {
        const x = startX + (i * beatWidth);
        ctx.beginPath();
        ctx.strokeStyle = light
          ? (i % 4 === 0 ? 'rgba(60,40,10,0.18)' : 'rgba(60,40,10,0.07)')
          : (i % 4 === 0 ? '#1e293b' : '#0f172a');
        ctx.lineWidth = i % 4 === 0 ? 2 : 1;
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }

      // Horizontal note lines
      for (let i = 0; i < 72; i++) {
        const y = h - (i * noteHeight);
        ctx.beginPath();
        ctx.strokeStyle = light
          ? (i % 12 === 0 ? 'rgba(60,40,10,0.16)' : 'rgba(60,40,10,0.05)')
          : (i % 12 === 0 ? '#1e293b' : '#0a0f1a');
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }

      // Move Deltas
      let deltaBeat = 0;
      let deltaPitch = 0;
      if (isMoving && dragStart && dragEnd) {
        deltaBeat = dragEnd.beat - dragStart.beat;
        deltaPitch = dragEnd.pitch - dragStart.pitch;
      }

      // Notes
      events.forEach(({ event, beatOffset, isUser, id }) => {
        let absoluteBeatStart = beatOffset + event.t;
        let pitch = event.p;

        const isSelected = selectedNoteIds.includes(id);

        // Apply visual offset if moving and this note is selected
        if (isSelected && isMoving) {
          absoluteBeatStart += deltaBeat;
          pitch += deltaPitch;
        }

        const absoluteBeatEnd = absoluteBeatStart + event.d;
        const x = startX + absoluteBeatStart * beatWidth;
        const width = event.d * beatWidth;
        const noteIndex = pitch - 24;
        const y = h - (noteIndex * noteHeight) - noteHeight;

        if (x + width < 0 || x > w) return;

        const isActive = currentBeat >= absoluteBeatStart && currentBeat <= absoluteBeatEnd;

        if (isUser) {
          ctx.fillStyle = isSelected ? '#ef4444' : (isActive ? trackColor : `${trackColor}66`);
          ctx.shadowBlur = isSelected ? 20 : (isActive ? 15 : 5);
          ctx.shadowColor = isSelected ? '#ef4444' : trackColor;
        } else {
          // AI-generated notes: derive a subtle hue shift from trackColor so they
          // remain visually distinct from user notes while staying in-family.
          const hue = (event.p * 13) % 360;
          ctx.fillStyle = isSelected
            ? '#ef4444'
            : (isActive ? `hsla(${hue}, 70%, ${light ? 38 : 60}%, 1)` : `hsla(${hue}, 55%, ${light ? 32 : 40}%, ${light ? 0.75 : 0.6})`);
          if (isSelected) {
            ctx.shadowBlur = 20;
            ctx.shadowColor = '#ef4444';
          }
        }

        ctx.fillRect(x, y, width - 1, noteHeight - 1);
        ctx.shadowBlur = 0;
      });

      // Draw Active Marquee Selection (Dashed)
      if (selectionMarquee) {
        const { startBeat, endBeat, minPitch, maxPitch } = selectionMarquee;
        let x = startX + startBeat * beatWidth;
        let wRect = (endBeat - startBeat) * beatWidth;
        let yStart = h - ((maxPitch - 24 + 1) * noteHeight);
        let hRect = (maxPitch - minPitch + 1) * noteHeight;

        ctx.strokeStyle = '#22d3ee';
        ctx.setLineDash([5, 5]);
        ctx.lineWidth = 1;
        ctx.strokeRect(x, yStart, wRect, hRect);
        ctx.fillStyle = 'rgba(34, 211, 238, 0.1)';
        ctx.fillRect(x, yStart, wRect, hRect);
        ctx.setLineDash([]);
      }

      // Draw Persistent Window around selected notes (Solid)
      if (selectionBounds && selectedNoteIds.length > 0) {
        let boundStart = selectionBounds.startBeat + (isMoving ? deltaBeat : 0);
        let boundEnd = selectionBounds.endBeat + (isMoving ? deltaBeat : 0);
        let boundMinP = selectionBounds.minPitch + (isMoving ? Math.round(deltaPitch) : 0);
        let boundMaxP = selectionBounds.maxPitch + (isMoving ? Math.round(deltaPitch) : 0);

        let selX = startX + boundStart * beatWidth;
        let selW = (boundEnd - boundStart) * beatWidth;
        let selYStart = h - ((boundMaxP - 24 + 1) * noteHeight);
        let selH = (boundMaxP - boundMinP + 1) * noteHeight;

        ctx.strokeStyle = isMoving ? '#6366f1' : 'rgba(34, 211, 238, 0.8)';
        ctx.lineWidth = 2;
        ctx.strokeRect(selX, selYStart, selW, selH);
        ctx.fillStyle = isMoving ? 'rgba(99, 102, 241, 0.05)' : 'rgba(34, 211, 238, 0.02)';
        ctx.fillRect(selX, selYStart, selW, selH);
      }

      // Playhead
      ctx.strokeStyle = '#6366f1';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(w / 2, 0);
      ctx.lineTo(w / 2, h);
      ctx.stroke();

      animationFrame = requestAnimationFrame(draw);
    };

    draw();
    return () => cancelAnimationFrame(animationFrame);
  }, [events, currentBeat, dragStart, dragEnd, selectedNoteIds, selectionMarquee, selectionBounds, isMoving, beatWidth, light]);

  // ── Touch handlers (select mode only) ─────────────────────────────────────
  // Converts a touch clientX/Y into scaled canvas coordinates + music coords.
  const getCanvasCoords = (clientX: number, clientY: number, canvas: HTMLCanvasElement) => {
    const rect = canvas.getBoundingClientRect();
    const x = (clientX - rect.left) * (canvas.width / rect.width);
    const y = (clientY - rect.top) * (canvas.height / rect.height);
    return { x, y, ...getMusicCoords(x, y, canvas) };
  };

  const handleTouchStart = (e: React.TouchEvent<HTMLCanvasElement>) => {
    if (!selectMode) return;
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas || e.touches.length === 0) return;
    const touch = e.touches[0];
    const coords = getCanvasCoords(touch.clientX, touch.clientY, canvas);
    if (selectionBounds && isInsideRect(coords.beat, coords.pitch, selectionBounds)) {
      setIsMoving(true);
      setDragStart(coords);
    } else {
      setIsMoving(false);
      setDragStart(coords);
      setDragEnd(null);
      // Don't clear selection yet — wait for touchend to decide tap vs drag
    }
  };

  const handleTouchMove = (e: React.TouchEvent<HTMLCanvasElement>) => {
    if (!selectMode) return;
    e.preventDefault();
    if (!dragStart || !canvasRef.current || e.touches.length === 0) return;
    const canvas = canvasRef.current;
    const touch = e.touches[0];
    const coords = getCanvasCoords(touch.clientX, touch.clientY, canvas);
    setDragEnd(coords);
    if (!isMoving && onSelectionMarqueeChange) {
      onSelectionMarqueeChange({
        startBeat: Math.min(dragStart.beat, coords.beat),
        endBeat:   Math.max(dragStart.beat, coords.beat),
        minPitch:  Math.min(dragStart.pitch, coords.pitch),
        maxPitch:  Math.max(dragStart.pitch, coords.pitch),
      });
    }
  };

  const handleTouchEnd = (e: React.TouchEvent<HTMLCanvasElement>) => {
    if (!selectMode) return;
    e.preventDefault();
    if (!dragStart) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const touch = e.changedTouches[0];
    const coords = getCanvasCoords(touch.clientX, touch.clientY, canvas);
    // Use a wider tap threshold for fingers
    const isClick = !dragEnd || (Math.abs(dragEnd.x - dragStart.x) < 15 && Math.abs(dragEnd.y - dragStart.y) < 15);
    if (isMoving) {
      if (!isClick && onMoveSelection) {
        onMoveSelection(coords.beat - dragStart.beat, coords.pitch - dragStart.pitch, selectedNoteIds);
      }
      setIsMoving(false);
    } else {
      if (isClick) {
        // Tap → toggle the note under the finger
        if (onSelectionMarqueeChange) onSelectionMarqueeChange(null);
        const tappedNote = events.find(({ event, beatOffset }) => {
          const absStart = beatOffset + event.t;
          const absEnd = absStart + event.d;
          return dragStart.beat >= absStart && dragStart.beat <= absEnd && event.p === dragStart.pitch;
        });
        if (tappedNote && onSelectNotes) {
          if (selectedNoteIds.includes(tappedNote.id)) {
            onSelectNotes(selectedNoteIds.filter(id => id !== tappedNote.id));
          } else {
            onSelectNotes([...selectedNoteIds, tappedNote.id]);
          }
        }
      } else {
        // Drag → box-select
        if (onSelectionMarqueeChange) onSelectionMarqueeChange(null);
        if (onSelectNotes) {
          const sel = {
            startBeat: Math.min(dragStart.beat, coords.beat),
            endBeat:   Math.max(dragStart.beat, coords.beat),
            minPitch:  Math.min(dragStart.pitch, coords.pitch),
            maxPitch:  Math.max(dragStart.pitch, coords.pitch),
          };
          onSelectNotes(
            events.filter(({ event, beatOffset }) => {
              const s = beatOffset + event.t;
              const en = s + event.d;
              return s < sel.endBeat && en > sel.startBeat &&
                     event.p >= sel.minPitch && event.p <= sel.maxPitch;
            }).map(n => n.id)
          );
        }
      }
    }
    setDragStart(null);
    setDragEnd(null);
  };

  // Ctrl+wheel → zoom
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handleWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      const next = Math.max(20, Math.min(600, beatWidthRef.current * factor));
      onZoomChange?.(next);
    };
    canvas.addEventListener('wheel', handleWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', handleWheel);
  }, [onZoomChange]);

  return (
    <canvas
      ref={canvasRef}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={() => {
        setDragStart(null);
        setDragEnd(null);
        setIsMoving(false);
      }}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onContextMenu={(e) => e.preventDefault()}
      className={`w-full h-full rounded-lg bg-black select-none ${selectMode ? 'cursor-pointer' : 'cursor-crosshair'}`}
      style={{ userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none', touchAction: selectMode ? 'none' : 'auto' }}
      width={1600}
      height={800}
    />
  );
};

export default PianoRoll;
