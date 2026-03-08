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

type Section = {
    label: string;
    startStep: number; // 0-based index into chordSequence
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
      const commentIdx = line.indexOf('//');
      const codePart = commentIdx === -1 ? line : line.slice(0, commentIdx);
      // Preserve section marker lines ([label] or [label]:) unchanged
      if (/^\s*\[[^\]]+\]:?\s*$/.test(codePart)) return line;
      if (commentIdx === -1) return transform(line);
      return transform(line.slice(0, commentIdx)) + line.slice(commentIdx);
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

// ---------------------------------------------------------------------------
// Voicing / coloring transforms — operate on MIDI note arrays.
// All preserve the original pitch classes; only octave placement changes.
// ---------------------------------------------------------------------------

/**
 * k-th inversion (k ≥ 1).
 *
 * Only the "canonical" notes participate in the rotation — for each pitch class,
 * the highest instance is canonical; lower octave duplicates are spectators and
 * never move.
 *
 * One inversion step: take the lowest canonical note, raise it by the minimum
 * number of octaves needed to land strictly above the current canonical top.
 * k-th inversion = 1st inversion applied k times.
 *
 * Example: [C3, C4, E4, G4]
 *   canonical: [C4, E4, G4]  spectators: [C3]
 *   1st inv → canonical [E4, G4, C5]  → full [C3, E4, G4, C5]
 *   2nd inv → canonical [G4, C5, E5]  → full [C3, G4, C5, E5]
 */
function invertChord(midi: number[], k: number): number[] {
  if (k <= 0 || midi.length < 2) return midi;

  // Build canonical set: highest note per pitch class
  const highestByPc = new Map<number, number>();
  for (const m of midi) {
    const pc = ((m % 12) + 12) % 12;
    if (!highestByPc.has(pc) || m > highestByPc.get(pc)!) highestByPc.set(pc, m);
  }

  // Spectators: all notes that are NOT the canonical representative of their class
  const usedCanonical = new Set(highestByPc.values());
  const spectators: number[] = [];
  const canonicalCounts = new Map<number, number>();
  for (const m of midi) {
    if (usedCanonical.has(m) && !canonicalCounts.has(m)) {
      canonicalCounts.set(m, 1); // first occurrence is canonical, consume it
    } else {
      spectators.push(m);
    }
  }

  // Canonical set as a sorted mutable array
  let canonical = [...highestByPc.values()].sort((a, b) => a - b);

  // Apply 1st inversion k times
  const clampedK = k % canonical.length; // full rotations cancel out
  for (let step = 0; step < clampedK; step++) {
    const top = canonical[canonical.length - 1];
    let note = canonical[0];
    // Raise by minimum octaves to clear the current top
    while (note <= top) note += 12;
    // Clamp to MIDI range
    while (note > 127) note -= 12;
    canonical = [...canonical.slice(1), note].sort((a, b) => a - b);
  }

  return [...canonical, ...spectators].sort((a, b) => a - b);
}

/**
 * Drop-n: sort ascending, drop the nth-highest note down one octave.
 * If the result duplicates another note in the chord, keeps dropping by
 * additional octaves until unique or until going below MIDI 0.
 * Identity if midi.length ≤ n.
 */
function dropChord(midi: number[], n: number): number[] {
  if (n < 1 || midi.length <= n) return midi;
  const s = [...midi].sort((a, b) => a - b);
  const idx = s.length - n;
  s[idx] -= 12;
  // Keep dropping while there's a duplicate and we're still in MIDI range
  while (s[idx] >= 0 && s.some((v, i) => i !== idx && v === s[idx])) {
    s[idx] -= 12;
  }
  // If we went below 0, revert to one step above (closest valid position)
  if (s[idx] < 0) s[idx] += 12;
  return s.sort((a, b) => a - b);
}

/**
 * Compress voicing: keep the highest note (leading tone) fixed; pull every other
 * note by octaves so it sits within the 12-semitone window directly below it.
 *
 * Notes that share a pitch class (i.e. differ only by octave) are spread out
 * rather than collapsed: the highest occurrence of each pitch class lands as
 * close to the leading tone as possible (within [top−12, top]), and each
 * additional duplicate is placed one octave below the previous one.
 */
function compressVoicing(midi: number[]): number[] {
  if (midi.length < 2) return midi;
  const top = Math.max(...midi);

  // Group by pitch class (0–11)
  const byClass = new Map<number, number>();  // pc → count
  for (const m of midi) {
    const pc = ((m % 12) + 12) % 12;
    byClass.set(pc, (byClass.get(pc) ?? 0) + 1);
  }

  const result: number[] = [];
  for (const [pc, count] of byClass) {
    // Highest instance of this pitch class that is ≤ top (always in (top−12, top]).
    // Add 12 (one octave) before % to keep the operand non-negative: min(top − pc) = −11.
    const highest = top - ((top - pc + 12) % 12);
    for (let i = 0; i < count; i++) {
      const note = highest - 12 * i;
      if (note >= 0 && note <= 127) result.push(note); // skip if out of MIDI range
    }
  }

  return result.sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Smooth voicing — canonical + greedy + anchor-regularised loop smoothing
// ---------------------------------------------------------------------------

/**
 * Split a MIDI chord into canonical voices and octave-duplicate followers.
 *
 * Canonical voice: the HIGHEST note for each pitch class present.
 * Duplicate: any note whose pitch class already has a higher canonical;
 *   stored as { pc, offset } where offset is the signed semitone delta from
 *   its canonical (always a negative multiple of 12).
 *
 * Duplicates are stored so they can be reattached after canonical voices are
 * rearranged, preserving their relative register without influencing the
 * voice-leading optimisation.
 */
function splitCanonical(midi: number[]): {
  canonical: number[];
  duplicates: { pc: number; offset: number }[];
} {
  const highestByPc = new Map<number, number>();
  for (const m of midi) {
    const pc = ((m % 12) + 12) % 12;
    if (!highestByPc.has(pc) || m > highestByPc.get(pc)!) highestByPc.set(pc, m);
  }
  const canonical = [...highestByPc.values()].sort((a, b) => a - b);
  // Walk notes descending so the first hit of each pc is the canonical (highest)
  const consumedPcs = new Set<number>();
  const duplicates: { pc: number; offset: number }[] = [];
  for (const m of [...midi].sort((a, b) => b - a)) {
    const pc = ((m % 12) + 12) % 12;
    if (!consumedPcs.has(pc)) {
      consumedPcs.add(pc); // canonical — skip
    } else {
      duplicates.push({ pc, offset: m - highestByPc.get(pc)! }); // offset ≤ -12
    }
  }
  return { canonical, duplicates };
}

/**
 * Reattach duplicates to a rearranged canonical set.
 *
 * Each duplicate finds the canonical representative of its pitch class and
 * is placed at canonicalNote + originalOffset, clamped to [0, 127] by
 * octave-shifting without changing pitch class.
 */
function reattachDuplicates(
  canonical: number[],
  duplicates: { pc: number; offset: number }[],
): number[] {
  const canonByPc = new Map<number, number>();
  for (const m of canonical) canonByPc.set(((m % 12) + 12) % 12, m);
  const result = [...canonical];
  for (const { pc, offset } of duplicates) {
    const base = canonByPc.get(pc);
    if (base === undefined) continue; // pitch class dropped — skip duplicate too
    let note = base + offset;
    while (note < 0)   note += 12;
    while (note > 127) note -= 12;
    result.push(note);
  }
  return result.sort((a, b) => a - b);
}

/**
 * Enumerate candidate octave placements for a set of pitch classes.
 *
 * For each pc, generates up to three MIDI candidates (previous, -12, +12)
 * centred on the nearest note in `reference` that shares that pitch class.
 * This keeps the search space at 3^N (≤ 729 for N=6) while still covering
 * the musically relevant register range.
 *
 * Results are filtered to the MIDI range [0, 127] and deduplicated per pc.
 */
/**
 * Return the MIDI note with pitch class `pc` nearest to `target` by absolute
 * semitone distance. Searches across the full MIDI range [0, 127].
 */
function nearestOctave(pc: number, target: number): number {
  let note = pc;
  while (note + 12 <= target) note += 12;
  // note is now the largest pc-note ≤ target; note+12 is the smallest pc-note > target.
  // note-12 is always further from target (it's below note which is already ≤ target),
  // so only check whether note+12 is closer.
  if (note + 12 <= 127 && Math.abs(note + 12 - target) < Math.abs(note - target)) note += 12;
  return Math.max(0, Math.min(127, note));
}

/**
 * ROLE-AWARE CANONICAL VOICE PLACEMENT.
 *
 * Places each pitch class in `pcs` (chord B) at the octave that minimises a
 * weighted blend of two reference chords (prev = chord A, anchor):
 *
 *   target(pc) = (1 − λ) · prevRef(pc)  +  λ · anchorRef(pc)
 *
 * ── ROLE ASSIGNMENT (done first, before any octave placement) ────────────
 *
 *   Roles are inherited from A = prevCanon (highest = melody, lowest = bass,
 *   middle = inner voices) and matched to B's pitch classes in priority order:
 *
 *     1. Melody  — A's melody pc matched to the closest unassigned B pc
 *     2. Bass    — A's bass pc matched to the closest remaining B pc
 *     3. Inner   — each A inner pc matched to the closest remaining B pc
 *
 *   Matching uses mod-12 pitch-class distance (greedy, one role at a time).
 *
 *   • len(B) == len(A): bijection — every B note gets exactly one A role.
 *   • len(B) <  len(A): melody matched first, then bass, then inner voices;
 *     leftover A roles are simply dropped (B doesn't have enough notes).
 *   • len(B) >  len(A): after all A roles are assigned, excess B pcs each
 *     inherit the reference of the last-assigned inner voice (or the
 *     bass/melody midpoint when no inner voice exists).
 *
 * ── PLACEMENT ────────────────────────────────────────────────────────────
 *
 *   1. Melody pc: placed near its blended MIDI target, unconstrained.
 *   2. Bass pc:   placed near its blended MIDI target, clamped below melody.
 *   3. Inner pcs: each clamped inside (bass, melody); collisions resolved
 *                 by octave-nudging.
 */
function placeCanonicalVoices(
  pcs: number[],
  prevCanon: number[],
  anchorCanon: number[],
  lambda: number,
): number[] {
  if (pcs.length === 0) return [];

  const pcOf      = (m: number): number => ((m % 12) + 12) % 12;
  const mod12dist = (a: number, b: number): number =>
    Math.min(((a - b + 12) % 12), ((b - a + 12) % 12));

  // Fall back to the other array if one is empty.
  const refPrev   = prevCanon.length   > 0 ? prevCanon   : anchorCanon;
  const refAnchor = anchorCanon.length > 0 ? anchorCanon : prevCanon;

  // ── BUILD PRIORITY-ORDERED A-ROLE LIST ───────────────────────────────────
  // roleIdx 0 = melody, 1 = bass, 2+ = inner voices (ascending).
  type ARole = { prevMidi: number; anchorMidi: number };
  const aRoles: ARole[] = [];

  if (refPrev.length >= 1) {
    // Melody = highest note
    aRoles.push({
      prevMidi:   refPrev[refPrev.length - 1],
      anchorMidi: refAnchor[refAnchor.length - 1],
    });
  }
  if (refPrev.length >= 2) {
    // Bass = lowest note
    aRoles.push({
      prevMidi:   refPrev[0],
      anchorMidi: refAnchor[0],
    });
    // Inner voices: indices 1 … refPrev.length-2 (ascending order)
    for (let i = 1; i < refPrev.length - 1; i++) {
      const innerIdx      = i - 1; // 0-based inner index
      const anchorInnerN  = refAnchor.length - 2; // number of inner voices in anchor
      const anchorMidi    = anchorInnerN > 0 && innerIdx < anchorInnerN
        ? refAnchor[innerIdx + 1]
        : refAnchor[Math.floor(refAnchor.length / 2)];
      aRoles.push({ prevMidi: refPrev[i], anchorMidi });
    }
  }

  // ── GREEDY ROLE ASSIGNMENT ────────────────────────────────────────────────
  // For each A-role (in priority order) pick the closest unassigned B pc.
  type BEntry = { pc: number; prevMidi: number; anchorMidi: number; roleIdx: number };
  const assigned: BEntry[] = [];
  const unassigned = new Set<number>(pcs.map((_, i) => i)); // indices into pcs

  for (let ri = 0; ri < aRoles.length && unassigned.size > 0; ri++) {
    const { prevMidi, anchorMidi } = aRoles[ri];
    const rolePc = pcOf(prevMidi);
    let bestI = -1, bestDist = Infinity;
    for (const idx of unassigned) {
      const d = mod12dist(pcs[idx], rolePc);
      if (d < bestDist) { bestDist = d; bestI = idx; }
    }
    unassigned.delete(bestI);
    assigned.push({ pc: pcs[bestI], prevMidi, anchorMidi, roleIdx: ri });
  }

  // Extra B pcs (len(B) > len(A)): inherit the last inner-voice reference.
  if (unassigned.size > 0) {
    const lastInner   = [...assigned].reverse().find(a => a.roleIdx >= 2);
    const fallbackPrev =
      lastInner          ? lastInner.prevMidi :
      assigned.length >= 2 ? (assigned[0].prevMidi + assigned[1].prevMidi) / 2 :
      refPrev[Math.floor(refPrev.length / 2)] ?? 60;
    const fallbackAnchor =
      lastInner          ? lastInner.anchorMidi :
      assigned.length >= 2 ? (assigned[0].anchorMidi + assigned[1].anchorMidi) / 2 :
      refAnchor[Math.floor(refAnchor.length / 2)] ?? 60;
    for (const idx of unassigned) {
      assigned.push({
        pc: pcs[idx],
        prevMidi:   fallbackPrev,
        anchorMidi: fallbackAnchor,
        roleIdx: aRoles.length + idx,
      });
    }
  }

  // Single-note shortcut (no melody/bass split needed).
  if (pcs.length === 1) {
    const e = assigned[0];
    return [nearestOctave(e.pc, (1 - lambda) * e.prevMidi + lambda * e.anchorMidi)];
  }

  // ── PLACEMENT ─────────────────────────────────────────────────────────────
  const melodyEntry  = assigned.find(a => a.roleIdx === 0)!;
  const bassEntry    = assigned.find(a => a.roleIdx === 1)!;
  const innerEntries = assigned.filter(a => a.roleIdx !== 0 && a.roleIdx !== 1);

  // 1. Melody — unconstrained
  const melodyNote = nearestOctave(
    melodyEntry.pc,
    (1 - lambda) * melodyEntry.prevMidi + lambda * melodyEntry.anchorMidi,
  );

  // 2. Bass — must sit strictly below melody
  let bassNote = nearestOctave(
    bassEntry.pc,
    (1 - lambda) * bassEntry.prevMidi + lambda * bassEntry.anchorMidi,
  );
  while (bassNote >= melodyNote) bassNote -= 12;
  if (bassNote < 0) bassNote += 12; // best-effort at MIDI floor

  if (innerEntries.length === 0) {
    return [bassNote, melodyNote].sort((a, b) => a - b);
  }

  // 3. Inner voices — clamped to (bass, melody), collisions resolved
  const placed: number[] = [];
  for (const entry of innerEntries) {
    let note = nearestOctave(
      entry.pc,
      (1 - lambda) * entry.prevMidi + lambda * entry.anchorMidi,
    );
    while (note <= bassNote)   note += 12;
    while (note >= melodyNote) note -= 12;
    if (note <= bassNote || note >= melodyNote) {
      note = nearestOctave(entry.pc, (bassNote + melodyNote) / 2);
    }
    const collides = () => placed.some(p => p === note);
    let tries = 0;
    while (collides() && tries++ < 4) {
      const up = note + 12, down = note - 12;
      const upOk = up < melodyNote, downOk = down > bassNote;
      const mid  = (bassNote + melodyNote) / 2;
      if (upOk && (!downOk || Math.abs(up - mid) <= Math.abs(down - mid))) note = up;
      else if (downOk) note = down;
      else break;
    }
    placed.push(note);
  }

  placed.sort((a, b) => a - b);
  return [bassNote, ...placed, melodyNote].sort((a, b) => a - b);
}

/**
 * SMOOTH VOICING — core algorithm.
 *
 * Revoices all steps to minimise voice-leading movement around a cyclic loop,
 * keeping the anchor step (current step when the user presses Smooth) fixed.
 *
 * ─── TWO-OBJECTIVE COST ──────────────────────────────────────────────────────
 * For every non-anchor step t, we balance:
 *   (a) Continuity  – stay close to the previously solved step  [transitionCost]
 *   (b) Loop closure – stay close to the fixed anchor step       [anchorCost]
 *
 *   total_cost(t) = (1 − λ(t)) · transitionCost + λ(t) · anchorCost
 *
 * ─── ANCHOR-REGULARISATION SCHEDULE ────────────────────────────────────────
 * No user-facing lambda is needed. The weight is derived from cyclic distance:
 *
 *   d(t)    = min(|t − anchor|, N − |t − anchor|)   ∈ [1, floor(N/2)]
 *   D       = floor(N / 2)                            max cyclic distance
 *   λ(t)    = 1 − (d(t) − 1) / max(1, D − 1)        ∈ [0, 1]
 *
 *   d = 1  → λ = 1  → only care about matching the anchor   (immediate neighbours)
 *   d = D  → λ = 0  → only care about transition continuity  (opposite the anchor)
 *   between → linear interpolation
 *
 * This ensures the steps immediately adjacent to the anchor connect back cleanly
 * without any extra user parameters.
 *
 * ─── CANONICAL-FIRST STRATEGY ───────────────────────────────────────────────
 * Only one representative per pitch class (the highest note = canonical) drives
 * the optimisation. Lower octave duplicates are reattached afterward at their
 * original offset from their canonical, minimising their own travel implicitly.
 *
 * ─── PLACEMENT STRATEGY — O(N) per step ───────────────────────────────────
 * Pitch classes are fixed per step; only octave placement changes. Since
 * identities are fixed, there is no matching/permutation problem — each pc maps
 * deterministically to the blend of its prev and anchor counterparts.
 * `placeCanonicalVoices` handles this in O(N) with structural role enforcement.
 *
 * ─── TRAVERSAL ORDER ────────────────────────────────────────────────────────
 * Steps are solved in forward order anchor+1, anchor+2, … wrapping around back
 * to anchor−1. Each step sees the already-solved previous step as its transition
 * reference, so continuity cost is always well-defined.
 */
function smoothVoicingSteps(steps: number[][], anchorIdx: number): number[][] {
  const N = steps.length;
  if (N < 2) return steps;

  const anchorMidi = steps[anchorIdx];
  const { canonical: anchorCanon } = splitCanonical(anchorMidi);

  // Precompute anchor-regularisation weight for each step
  const D = Math.floor(N / 2);
  const lambdaForStep = (t: number): number => {
    const rel = ((t - anchorIdx) + N) % N;
    const d   = Math.min(rel, N - rel);
    if (d === 0) return 1;
    if (D <= 1)  return 1;
    return Math.max(0, Math.min(1, 1 - (d - 1) / (D - 1)));
  };

  const result: number[][] = [...steps]; // anchor slot stays unchanged

  // Forward traversal from anchor+1 around the loop
  for (let i = 1; i < N; i++) {
    const t       = (anchorIdx + i) % N;
    const prevIdx = (t - 1 + N) % N;
    const { canonical: prevCanon }       = splitCanonical(result[prevIdx]);
    const { canonical: rawCanon, duplicates } = splitCanonical(steps[t]);
    const pcs = rawCanon.map(m => ((m % 12) + 12) % 12);

    const lam           = lambdaForStep(t);
    const bestCandidate = placeCanonicalVoices(pcs, prevCanon, anchorCanon, lam);

    result[t] = reattachDuplicates(bestCandidate.sort((a, b) => a - b), duplicates);
  }

  return result;
}

/**
 * Apply smooth voicing to a raw sequence string.
 *
 * Parses all note steps (preserving comments, section markers, strum times and
 * whitespace), computes smooth voicings via smoothVoicingSteps, then rewrites
 * each step's notes in-place. The anchor is the 0-based step index that should
 * stay unchanged (typically the currently playing step).
 */
function applySmoothVoicingToSequence(sequence: string, anchorStepIndex: number): string {
  // ── Phase 1: parse all MIDI arrays in order ──────────────────────────────
  const midiSteps: number[][] = [];
  for (const line of sequence.split('\n')) {
    const commentIdx = line.indexOf('//');
    const codePart   = commentIdx === -1 ? line : line.slice(0, commentIdx);
    const trimmed    = codePart.trim();
    if (!trimmed || /^\[([^\]]+)\]:?\s*$/.test(trimmed)) continue;
    for (const token of codePart.split(',')) {
      const t = token.trim();
      if (!t) continue;
      const m = t.match(/^(.*?)(@\s*\d+(?:\.\d+)?\s*ms?)?$/i);
      const notesPart  = (m?.[1] ?? t).trim();
      const noteStrings = notesPart.split('+').map(n => n.trim()).filter(Boolean);
      if (noteStrings.length === 0) continue;
      midiSteps.push(noteStrings.map(n => noteToMidi(n)));
    }
  }
  if (midiSteps.length < 2) return sequence;

  // ── Phase 2: compute smoothed voicings ───────────────────────────────────
  const smoothed = smoothVoicingSteps(
    midiSteps,
    Math.min(anchorStepIndex, midiSteps.length - 1),
  );

  // ── Phase 3: rewrite the string (same structure, only note names change) ──
  let stepIdx = 0;
  return sequence
    .split('\n')
    .map(line => {
      const commentIdx  = line.indexOf('//');
      const codePart    = commentIdx === -1 ? line : line.slice(0, commentIdx);
      const commentSuffix = commentIdx === -1 ? '' : line.slice(commentIdx);
      const trimmed     = codePart.trim();
      if (!trimmed || /^\[([^\]]+)\]:?\s*$/.test(trimmed)) return line;
      const newTokens = codePart.split(',').map(token => {
        const t = token.trim();
        if (!t) return token;
        const m = t.match(/^(.*?)(@\s*\d+(?:\.\d+)?\s*ms?)?$/i);
        const notesPart   = (m?.[1] ?? t).trim();
        const strumPart   = m?.[2] ?? '';
        const noteStrings = notesPart.split('+').map(n => n.trim()).filter(Boolean);
        if (noteStrings.length === 0) return token;
        const leading = token.match(/^(\s*)/)?.[1] ?? '';
        const notes   = smoothed[stepIdx++] ?? noteStrings.map(n => noteToMidi(n));
        return leading + notes.map(midi => midiToNote(midi)).join('+') + strumPart;
      });
      return newTokens.join(',') + commentSuffix;
    })
    .join('\n');
}

/**
 * Apply a MIDI-level transform to a single chord step (0-based stepIndex) inside
 * the raw sequence string, preserving all other text (comments, strum values,
 * section markers, whitespace, other steps).
 */
function applyColoringToStep(
  sequence: string,
  stepIndex: number,
  transform: (midi: number[]) => number[],
): string {
  let counter = 0;
  return sequence
    .split('\n')
    .map(line => {
      const commentIdx = line.indexOf('//');
      const codePart = commentIdx === -1 ? line : line.slice(0, commentIdx);
      const commentSuffix = commentIdx === -1 ? '' : line.slice(commentIdx);
      const trimmed = codePart.trim();

      // Pass through empty lines and section markers unchanged
      if (!trimmed || /^\[([^\]]+)\]:?\s*$/.test(trimmed)) return line;

      const tokens = codePart.split(',');
      const newTokens = tokens.map(token => {
        const t = token.trim();
        if (!t) return token;
        const m = t.match(/^(.*?)(@\s*\d+(?:\.\d+)?\s*ms?)?$/i);
        const notesPart = (m?.[1] ?? t).trim();
        const strumPart = m?.[2] ?? '';
        const noteStrings = notesPart.split('+').map(n => n.trim()).filter(Boolean);
        if (noteStrings.length === 0) return token;

        const isTarget = counter === stepIndex;
        counter++;
        if (!isTarget) return token;

        const transformed = transform(noteStrings.map(n => noteToMidi(n)));
        const leading = token.match(/^(\s*)/)?.[1] ?? '';
        return leading + transformed.map(midi => midiToNote(midi)).join('+') + strumPart;
      });

      return newTokens.join(',') + commentSuffix;
    })
    .join('\n');
}

/** Apply a MIDI transform to every note-step in a sequence string. */
function applyVoicingToAllSteps(
  sequence: string,
  transform: (midi: number[]) => number[],
): string {
  return sequence
    .split('\n')
    .map(line => {
      const commentIdx = line.indexOf('//');
      const codePart = commentIdx === -1 ? line : line.slice(0, commentIdx);
      const commentSuffix = commentIdx === -1 ? '' : line.slice(commentIdx);
      const trimmed = codePart.trim();
      if (!trimmed || /^\[([^\]]+)\]:?\s*$/.test(trimmed)) return line;
      const tokens = codePart.split(',');
      const newTokens = tokens.map(token => {
        const t = token.trim();
        if (!t) return token;
        const m = t.match(/^(.*?)(@\s*\d+(?:\.\d+)?\s*ms?)?$/i);
        const notesPart = (m?.[1] ?? t).trim();
        const strumPart = m?.[2] ?? '';
        const noteStrings = notesPart.split('+').map(n => n.trim()).filter(Boolean);
        if (noteStrings.length === 0) return token;
        const transformed = transform(noteStrings.map(n => noteToMidi(n)));
        const leading = token.match(/^(\s*)/)?.[1] ?? '';
        return leading + transformed.map(midi => midiToNote(midi)).join('+') + strumPart;
      });
      return newTokens.join(',') + commentSuffix;
    })
    .join('\n');
}

/** Ordinal label: 1 → "1st", 2 → "2nd", 3 → "3rd", 4 → "4th", … */
function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}

/**
 * Extract the MIDI notes for a specific 0-based step index from a raw sequence string,
 * using the same parsing rules as the main sequence parser.
 */
function getStepMidi(sequence: string, stepIndex: number): number[] | null {
  let counter = 0;
  for (const line of sequence.split('\n')) {
    const commentIdx = line.indexOf('//');
    const codePart = commentIdx === -1 ? line : line.slice(0, commentIdx);
    const trimmed = codePart.trim();
    if (!trimmed || /^\[([^\]]+)\]:?\s*$/.test(trimmed)) continue;
    for (const token of codePart.split(',')) {
      const t = token.trim();
      if (!t) continue;
      const m = t.match(/^(.*?)(@\s*\d+(?:\.\d+)?\s*ms?)?$/i);
      const notesPart = (m?.[1] ?? t).trim();
      const noteStrings = notesPart.split('+').map(n => n.trim()).filter(Boolean);
      if (noteStrings.length === 0) continue;
      if (counter === stepIndex) return noteStrings.map(n => noteToMidi(n));
      counter++;
    }
  }
  return null;
}

const AVAILABLE_TARGETS: { label: string; value: ModulationTarget }[] = [
  { label: 'Filter Cutoff', value: 'cutoff' },
  { label: 'Resonance', value: 'resonance' },
  { label: 'Detune', value: 'detune' },
  { label: 'Sustain', value: 'sustain' },
];

// ---------------------------------------------------------------------------
// pad_samples/*.txt — loaded at build time via Vite glob import.
// Each file's content is used verbatim as a note-sequence preset.
// The first line starting with "//" (if any) is treated as the description;
// all remaining non-empty, non-comment lines form the sequence.
// ---------------------------------------------------------------------------
const _padSampleRaw = import.meta.glob('../pad_samples/*.txt', { query: '?raw', eager: true, import: 'default' }) as Record<string, string>;

function parsePadSampleFile(path: string, content: string): { label: string; description: string; sequence: string } | null {
    const filename = path.split('/').pop()?.replace(/\.txt$/i, '') ?? path;
    const lines = content.split('\n');
    let description = '';
    const sequenceLines: string[] = [];
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('//')) {
            if (!description) description = trimmed.replace(/^\/\/+\s*/, '');
        } else if (trimmed) {
            sequenceLines.push(line);
        }
    }
    const sequence = sequenceLines.join('\n').trim();
    if (!sequence) return null; // skip empty files
    return { label: filename, description: description || filename, sequence };
}

const PAD_SAMPLE_PRESETS: { label: string; description: string; sequence: string }[] = Object.entries(_padSampleRaw)
    .map(([path, content]) => parsePadSampleFile(path, content))
    .filter((p): p is NonNullable<typeof p> => p !== null);

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
    const [sections, setSections] = useState<Section[]>([]);
    const [currentNoteIndex, setCurrentNoteIndex] = useState(0);
    const currentNoteIndexRef = useRef(0);
    const [chordVolume, setChordVolume] = useState(1.0);
    const chordVolumeRef = useRef(1.0);

    // Voicing snapshot — set on the first voicing edit, cleared on any external sequence change
    const [voicingBase, setVoicingBase] = useState<string | null>(null);
    const voicingChangeInProgressRef = useRef(false);

    // Mappings
    const [xTargets, setXTargets] = useState<ModulationTarget[]>(['cutoff']);
    const [yTargets, setYTargets] = useState<ModulationTarget[]>(['resonance']);

    useEffect(() => {
        // If this change didn't come from a voicing button, clear the voicing snapshot.
        if (!voicingChangeInProgressRef.current) {
            setVoicingBase(null);
        }
        voicingChangeInProgressRef.current = false;

        // Parse line-by-line so [label]: markers can live alongside chord steps.
        const rawLines = sequenceInput.split('\n');
        const parsedSteps: ChordStep[] = [];
        const parsedSections: Section[] = [];

        for (const rawLine of rawLines) {
            const commentIdx = rawLine.indexOf('//');
            const codePart = commentIdx === -1 ? rawLine : rawLine.slice(0, commentIdx);
            const trimmed = codePart.trim();
            if (!trimmed) continue;

            // Section marker: [label] or [label]:
            const sectionMatch = trimmed.match(/^\[([^\]]+)\]:?\s*$/);
            if (sectionMatch) {
                parsedSections.push({ label: sectionMatch[1].trim(), startStep: parsedSteps.length });
                continue;
            }

            // Chord steps — comma-separated within this line
            for (const token of trimmed.split(',')) {
                const t = token.trim();
                if (!t) continue;
                const match = t.match(/^(.*?)(?:@\s*(\d+(?:\.\d+)?)\s*ms?)?$/i);
                const notesPart = (match?.[1] ?? t).trim();
                const rawStrum = match?.[2];
                const parsedStrum = rawStrum !== undefined ? Number(rawStrum) : 0;
                const strumMs = Number.isFinite(parsedStrum) ? Math.max(0, parsedStrum) : 0;
                const notes = notesPart.split('+').map(n => n.trim()).filter(Boolean).map(n => noteToMidi(n));
                if (notes.length === 0) continue;
                parsedSteps.push({ notes, strumMs });
            }
        }

        const newSequence = parsedSteps.length > 0 ? parsedSteps : [{ notes: [60], strumMs: 0 }];
        setChordSequence(newSequence);
        setSections(parsedSections);
        // Only reset the step counter when the sequence shrinks past the current position.
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
        chordVolumeRef.current = chordVolume;
        audioEngine.setActiveVoicesVelocity(Math.round(chordVolume * 100));
    }, [chordVolume]);

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
        audioEngine.startContinuousNotes(step.notes, Math.round(chordVolumeRef.current * 100), step.strumMs);

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

    /**
     * Plays one random note from the current step without advancing the step counter.
     * If the pad/key is held (isPlaying), the "current" step is the one already sounding
     * (one behind the advanced pointer). Otherwise it is the next-to-play step.
     */
    const playRandomNoteFromCurrentStep = useCallback(() => {
        const sequence = chordSequence.length > 0 ? chordSequence : [{ notes: [60], strumMs: 0 }];
        const stepIndex = isPlaying
            ? (currentNoteIndexRef.current - 1 + sequence.length) % sequence.length
            : currentNoteIndexRef.current % sequence.length;
        const step = sequence[stepIndex];
        const midi = step.notes[Math.floor(Math.random() * step.notes.length)];
        // not using chordVolumeRef.current because this is a solo note outside the continuous chord voices
        audioEngine.addContinuousNote(midi, 100);
    }, [chordSequence, isPlaying]);

    /**
     * Play a note from the current step mapped linearly by keyIndex (0 = min pitch, 3 = max pitch).
     * Notes in the step are sorted ascending; keyIndex is scaled across them.
     */
    const playNoteFromCurrentStepByLinearIndex = useCallback((keyIndex: number) => {
        const sequence = chordSequence.length > 0 ? chordSequence : [{ notes: [60], strumMs: 0 }];
        const stepIndex = isPlaying
            ? (currentNoteIndexRef.current - 1 + sequence.length) % sequence.length
            : currentNoteIndexRef.current % sequence.length;
        const step = sequence[stepIndex];
        const sorted = [...step.notes].sort((a, b) => a - b);
        if (sorted.length === 0) return;
        const noteIdx = sorted.length === 1
            ? 0
            : Math.round((keyIndex / 3) * (sorted.length - 1));

        // not using chordVolumeRef.current because this is a solo note outside the continuous chord voices
        audioEngine.addContinuousNote(sorted[Math.min(noteIdx, sorted.length - 1)], 100);
    }, [chordSequence, isPlaying]);

    const jumpToSection = useCallback((sectionIndex: number) => {
        if (sectionIndex < 0 || sectionIndex >= sections.length) return;
        const step = sections[sectionIndex].startStep;
        currentNoteIndexRef.current = step;
        setCurrentNoteIndex(step);
    }, [sections]);

    /**
     * Apply a voicing/coloring transform to the current step.
     * Snapshots the full sequence the first time it's called (so "Original" can restore it),
     * and marks the change as voicing-originated so the parse effect doesn't clear the snapshot.
     */
    const applyVoicing = useCallback((transform: (midi: number[]) => number[]) => {
        setVoicingBase(prev => prev ?? sequenceInput);
        voicingChangeInProgressRef.current = true;
        setSequenceInput(prev => applyVoicingToAllSteps(prev, transform));
    }, [sequenceInput]);

    /**
     * Transpose all notes by `delta` semitones.
     * Multiples of 12 (octave shifts) are treated as voicing changes — the voicing
     * snapshot is preserved so "Original" can restore the previous octave placement.
     * Non-octave shifts (e.g. ±1) are pitch changes and will clear the snapshot.
     */
    const applyTranspose = useCallback((delta: number) => {
        if (delta % 12 === 0) {
            setVoicingBase(prev => prev ?? sequenceInput);
            voicingChangeInProgressRef.current = true;
        }
        setSequenceInput(prev => transposeSequence(prev, delta));
    }, [sequenceInput]);

    /**
     * Apply smooth voicing to the full sequence, anchored to the current step.
     * Snapshots voicingBase first so the user can restore the original with O.
     */
    const applySmooth = useCallback(() => {
        setVoicingBase(prev => prev ?? sequenceInput);
        voicingChangeInProgressRef.current = true;
        setSequenceInput(prev => applySmoothVoicingToSequence(prev, currentNoteIndex));
    }, [sequenceInput, currentNoteIndex]);

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

            // B: go back one step
            if (e.key === 'b') {
                e.preventDefault();
                const seqLen = chordSequence.length > 0 ? chordSequence.length : 1;
                const prev = (currentNoteIndexRef.current - 1 + seqLen) % seqLen;
                currentNoteIndexRef.current = prev;
                setCurrentNoteIndex(prev);
                return;
            }

            // Digit 1-9: jump to section
            if (/^[1-9]$/.test(e.key)) {
                e.preventDefault();
                jumpToSection(parseInt(e.key) - 1);
                return;
            }

            // Arrow keys
            if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
                e.preventDefault();
                if (e.shiftKey) {
                    // Shift+Left/Right: chord volume −/+ 0.1
                    if (e.key === 'ArrowLeft') {
                        setChordVolume(prev => {
                            const v = Math.max(0, Math.round((prev - 0.1) * 10) / 10);
                            chordVolumeRef.current = v;
                            return v;
                        });
                        return;
                    }
                    if (e.key === 'ArrowRight') {
                        setChordVolume(prev => {
                            const v = Math.min(1, Math.round((prev + 0.1) * 10) / 10);
                            chordVolumeRef.current = v;
                            return v;
                        });
                        return;
                    }
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
                    applyTranspose(arrowDelta[e.key]);
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

            // O: restore original voicing
            if (e.key === 'o') {
                e.preventDefault();
                if (voicingBase) {
                    voicingChangeInProgressRef.current = true;
                    setSequenceInput(voicingBase);
                    setVoicingBase(null);
                }
                return;
            }

            // I: 1st inversion  |  Shift+I: drop leading tone (Drop 1)  |  U: Drop 2
            if (e.key === 'i') {
                e.preventDefault();
                applyVoicing(m => invertChord(m, 1));
                return;
            }
            if (e.key === 'I') {
                e.preventDefault();
                applyVoicing(m => dropChord(m, 1));
                return;
            }
            if (e.key === 'u') {
                e.preventDefault();
                applyVoicing(m => dropChord(m, 2));
                return;
            }
            if (e.key === 'c') {
                e.preventDefault();
                applyVoicing(compressVoicing);
                return;
            }
            if (e.key === 'n') {
                e.preventDefault();
                applySmooth();
                return;
            }

            // V: random note from current step
            if (e.key === 'v') {
                if (e.repeat || activeKeyboardKeysRef.current.has('v')) return;
                e.preventDefault();
                activeKeyboardKeysRef.current.add('v');
                playRandomNoteFromCurrentStep();
                return;
            }

            // J/K/L/;: linear chord notes (min → max pitch across the chord)
            const chordKeyMap: Record<string, number> = { j: 0, k: 1, l: 2, ';': 3 };
            if (e.key in chordKeyMap) {
                if (e.repeat || activeKeyboardKeysRef.current.has(e.key)) return;
                e.preventDefault();
                activeKeyboardKeysRef.current.add(e.key);
                playNoteFromCurrentStepByLinearIndex(chordKeyMap[e.key]);
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
            const tracked = ['d', 'f', 'j', 'k', 'l', ';', 'v'];
            // ';' does not lowercase-transform, so also handle it by raw key
            const raw = e.key;
            if (!tracked.includes(key) && !tracked.includes(raw)) return;

            activeKeyboardKeysRef.current.delete(key);
            activeKeyboardKeysRef.current.delete(raw);
            stopTriggerIfIdle();
        };

        window.addEventListener('keydown', onKeyDown);
        window.addEventListener('keyup', onKeyUp);

        return () => {
            window.removeEventListener('keydown', onKeyDown);
            window.removeEventListener('keyup', onKeyUp);
        };
    }, [startTrigger, stopTriggerIfIdle, jumpToSection, playRandomNoteFromCurrentStep, playNoteFromCurrentStepByLinearIndex, applyVoicing, applyTranspose, applySmooth, voicingBase, currentNoteIndex, chordSequence]);

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

    // Derive the active section: last section whose startStep <= currentNoteIndex
    const currentSection = sections.length > 0
        ? [...sections].reverse().find(s => s.startStep <= currentNoteIndex) ?? null
        : null;

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

            {/* Current section badge */}
            {/* {currentSection && (
                <div className="absolute top-3 left-3 z-20 px-3 py-1.5 rounded-lg bg-black/60 border border-indigo-500/30 text-indigo-300 text-[10px] font-black uppercase tracking-widest pointer-events-none">
                    ▶ {currentSection.label}
                </div>
            )} */}

            {/* Section jump buttons on the pad (touch-friendly, fullscreen only) */}
            {sections.length > 0 && isFullscreen && (
                <div
                    data-pad-control="true"
                    className="absolute bottom-12 left-3 z-20 flex flex-wrap gap-1"
                    onPointerDown={(e) => e.stopPropagation()}
                >
                    {sections.map((s, i) => (
                        <button
                            key={s.label}
                            type="button"
                            data-pad-control="true"
                            title={`Jump to [${s.label}] — step ${s.startStep + 1}`}
                            onClick={(e) => { e.stopPropagation(); jumpToSection(i); }}
                            className={`px-2 py-1 rounded text-[9px] font-black uppercase border transition-all ${
                                currentSection?.label === s.label
                                    ? 'bg-indigo-600/80 border-indigo-400 text-white'
                                    : 'bg-black/60 border-white/10 text-slate-400 hover:text-indigo-300 hover:border-indigo-500/30'
                            }`}
                        >
                            {i + 1}: {s.label}
                        </button>
                    ))}
                </div>
            )}

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
                    D/F: Play · ←→: Semitone · ↑↓: Octave · ⇧←→: Vol · ⇧↑↓: Strum · R: Rand · ⇧R: Rev · S: Sort · I: 1st Inv · ⇧I: Drop1 · U: Drop2 · C: Compress · N: Smooth · O: Orig · J/K/L/;: Chord Keys · V: Rand Note · Space: Reset · 1-9: Section
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
            <div className="bg-slate-950/50 rounded-2xl border border-white/5 p-4 overflow-y-auto max-h-64">
                <div className="sticky top-0 z-10 flex items-center gap-2 mb-3 text-slate-500 font-black uppercase text-xs bg-slate-950/90 backdrop-blur-sm py-1 -mx-4 px-4 -mt-1">
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
                    {PAD_SAMPLE_PRESETS.length > 0 && (
                        <>
                            <span className="text-[9px] text-slate-700 font-black uppercase self-center px-1">·</span>
                            {PAD_SAMPLE_PRESETS.map(preset => (
                                <button
                                    key={preset.label}
                                    title={preset.description}
                                    onClick={() => setSequenceInput(preset.sequence)}
                                    className="px-2 py-1 rounded-lg text-[9px] font-bold uppercase border border-teal-900/60 bg-slate-900 text-teal-600 hover:text-teal-300 hover:border-teal-500/40 transition-all"
                                >
                                    {preset.label}
                                </button>
                            ))}
                        </>
                    )}
                </div>
                <textarea
                    className="w-full bg-black/40 border border-white/5 rounded-xl p-3 text-xs font-mono text-indigo-300 focus:outline-none focus:border-indigo-500/50 h-24 resize-none"
                    value={sequenceInput}
                    onChange={(e) => setSequenceInput(e.target.value)}
                    placeholder="e.g. [verse]:\nC4+E4+G4@12ms, // tonic\n[chorus]:\nG3+B3+D4@30ms"
                />
                <div className="flex flex-col gap-1.5 mt-2">
                    <div className="flex items-center gap-1 flex-wrap">
                        <span className="text-[9px] text-slate-700 font-black uppercase w-16 shrink-0">Transpose</span>
                        {([[-12, '↓ Octave (↓ Arrow)'], [-1, '−1 Semitone (← Arrow)'], [1, '+1 Semitone (→ Arrow)'], [12, '↑ Octave (↑ Arrow)']] as const).map(([delta, tooltip]) => (
                            <button
                                key={delta}
                                title={tooltip}
                                onClick={() => applyTranspose(delta)}
                                className="text-[9px] bg-white/5 hover:bg-indigo-500/20 hover:text-indigo-300 px-2 py-1 rounded text-slate-400 font-bold tabular-nums transition-all"
                            >
                                {delta > 0 ? `+${delta}` : delta}
                            </button>
                        ))}
                    </div>
                    <div className="flex items-center gap-1 flex-wrap">
                        <span className="text-[9px] text-slate-700 font-black uppercase w-16 shrink-0">Chord Vol</span>
                        <button
                            title="Decrease chord volume by 0.1 (⇧← Arrow)"
                            onClick={() => setChordVolume(prev => { const v = Math.max(0, Math.round((prev - 0.1) * 10) / 10); chordVolumeRef.current = v; return v; })}
                            className="text-[9px] bg-white/5 hover:bg-rose-500/20 hover:text-rose-300 px-2 py-1 rounded text-slate-400 font-bold tabular-nums transition-all"
                        >
                            −0.1
                        </button>
                        <div className="text-[10px] font-bold tabular-nums px-2 py-1 rounded bg-black/30 border border-white/5" style={{ color: chordVolume < 0.4 ? '#f87171' : chordVolume < 0.8 ? '#fbbf24' : '#a5b4fc' }}>
                            {chordVolume.toFixed(1)}
                        </div>
                        <button
                            title="Increase chord volume by 0.1 (⇧→ Arrow)"
                            onClick={() => setChordVolume(prev => { const v = Math.min(1, Math.round((prev + 0.1) * 10) / 10); chordVolumeRef.current = v; return v; })}
                            className="text-[9px] bg-white/5 hover:bg-indigo-500/20 hover:text-indigo-300 px-2 py-1 rounded text-slate-400 font-bold tabular-nums transition-all"
                        >
                            +0.1
                        </button>
                        <div className="w-24 h-1.5 rounded-full bg-white/5 overflow-hidden ml-1">
                            <div className="h-full rounded-full transition-all duration-150" style={{ width: `${chordVolume * 100}%`, background: chordVolume < 0.4 ? '#f87171' : chordVolume < 0.8 ? '#fbbf24' : '#818cf8' }} />
                        </div>
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
                        {(['j', 'k', 'l', ';'] as const).map((key, i) => (
                            <button
                                key={key}
                                title={`Play chord note ${i + 1}/4 (${i === 0 ? 'lowest' : i === 3 ? 'highest' : `mid-${i}`} pitch) (${key.toUpperCase()})`}
                                onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); playNoteFromCurrentStepByLinearIndex(i); }}
                                onPointerUp={() => stopTriggerIfIdle()}
                                onPointerLeave={() => stopTriggerIfIdle()}
                                onPointerCancel={() => stopTriggerIfIdle()}
                                className="text-[10px] bg-white/5 hover:bg-violet-500/20 hover:text-violet-300 px-2 py-1 rounded text-slate-400 uppercase font-bold select-none"
                            >
                                {key === ';' ? '; (hi)' : key === 'j' ? 'j (lo)' : key}
                            </button>
                        ))}
                        <button
                            title="Play one random note from the current step (V)"
                            onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); playRandomNoteFromCurrentStep(); }}
                            onPointerUp={() => stopTriggerIfIdle()}
                            onPointerLeave={() => stopTriggerIfIdle()}
                            onPointerCancel={() => stopTriggerIfIdle()}
                            className="text-[10px] bg-white/5 hover:bg-fuchsia-500/20 hover:text-fuchsia-300 px-2 py-1 rounded text-slate-400 uppercase font-bold select-none"
                        >
                            v (rand)
                        </button>
                    </div>
                    {sections.length > 0 && (
                        <div className="flex items-center gap-1 flex-wrap">
                            <span className="text-[9px] text-slate-700 font-black uppercase w-16 shrink-0">Sections</span>
                            {sections.map((s, i) => (
                                <button
                                    key={s.label}
                                    title={`Jump to [${s.label}] — step ${s.startStep + 1} · Key ${i + 1}`}
                                    onClick={() => jumpToSection(i)}
                                    className={`text-[9px] px-2 py-1 rounded font-bold uppercase border transition-all ${
                                        currentSection?.label === s.label
                                            ? 'bg-indigo-600 border-indigo-500 text-white'
                                            : 'bg-white/5 hover:bg-indigo-500/20 hover:text-indigo-300 border-white/5 text-slate-500'
                                    }`}
                                >
                                    {i + 1}: {s.label}
                                </button>
                            ))}
                        </div>
                    )}
                    <div className="flex items-center gap-1 flex-wrap">
                        <span className="text-[9px] text-slate-700 font-black uppercase w-16 shrink-0">Voicing</span>
                        <button
                            title={voicingBase ? 'Restore original voicing for all steps (O)' : 'No voicing changes yet (O)'}
                            disabled={!voicingBase}
                            onClick={() => {
                                if (!voicingBase) return;
                                voicingChangeInProgressRef.current = true;
                                setSequenceInput(voicingBase);
                                setVoicingBase(null);
                            }}
                            className={`text-[9px] px-2 py-1 rounded font-bold transition-all ${voicingBase ? 'bg-white/5 hover:bg-orange-500/20 hover:text-orange-300 text-slate-400' : 'opacity-25 cursor-not-allowed bg-white/5 text-slate-600'}`}
                        >
                            Original
                        </button>
                        <button
                            title="Compress all steps: pull each note into the octave below the leading tone; duplicate pitch classes are spread one octave apart (C)"
                            onClick={() => applyVoicing(compressVoicing)}
                            className="text-[9px] bg-white/5 hover:bg-teal-500/20 hover:text-teal-300 px-2 py-1 rounded text-slate-400 font-bold transition-all"
                        >
                            Compress
                        </button>
                        <button
                            title="Smooth all steps (N): revoice each step for minimal voice-leading movement around the loop, anchored to the current step. Melody and bass are preserved; inner voices move as little as possible."
                            onClick={applySmooth}
                            className="text-[9px] bg-white/5 hover:bg-cyan-500/20 hover:text-cyan-300 px-2 py-1 rounded text-slate-400 font-bold transition-all"
                        >
                            Smooth
                        </button>
                        {(() => {
                            const noteCount = chordSequence[currentNoteIndex]?.notes.length ?? 0;
                            return Array.from({ length: Math.max(0, noteCount - 1) }, (_, i) => i + 1).map(n => (
                                <button
                                    key={`drop-${n}`}
                                    title={`Drop ${n} (all steps): lower the ${ordinal(n)}-highest note by octaves until it no longer duplicates another note${n === 1 ? ' (⇧I)' : n === 2 ? ' (U)' : ''}`}
                                    onClick={() => applyVoicing(m => dropChord(m, n))}
                                    className="text-[9px] bg-white/5 hover:bg-sky-500/20 hover:text-sky-300 px-2 py-1 rounded text-slate-400 font-bold transition-all"
                                >
                                    Drop {n}
                                </button>
                            ));
                        })()}
                        {(() => {
                            const noteCount = chordSequence[currentNoteIndex]?.notes.length ?? 0;
                            if (noteCount < 2) return null;
                            return Array.from({ length: noteCount - 1 }, (_, i) => i + 1).map(k => (
                                <button
                                    key={`inv-${k}`}
                                    title={`${ordinal(k)} inversion (all steps): rotate the ${k} lowest pitch class${k > 1 ? 'es' : ''} above the top — octave doublings stay in place${k === 1 ? ' (I)' : ''}`}
                                    onClick={() => applyVoicing(m => invertChord(m, k))}
                                    className="text-[9px] bg-white/5 hover:bg-purple-500/20 hover:text-purple-300 px-2 py-1 rounded text-slate-400 font-bold transition-all"
                                >
                                    {ordinal(k)} inv
                                </button>
                            ));
                        })()}
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
