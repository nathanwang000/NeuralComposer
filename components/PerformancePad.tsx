import { Maximize2, Minimize2, Music } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { audioEngine } from '../services/audioEngine';
import { SynthConfig } from '../types';

type ModulationTarget = keyof SynthConfig | 'detune_semitone';

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
 * Revoices every step in the loop to minimise total voice-leading movement,
 * keeping the anchor step (the one active when the user triggers Smooth) fixed.
 * The result is a set of voicings that feel connected when played in sequence,
 * without changing any chord's pitch content — only register/octave placement.
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
 * This ensures steps adjacent to the anchor connect back cleanly without any
 * extra user parameters.
 *
 * ─── CANONICAL-FIRST STRATEGY ───────────────────────────────────────────────
 * Only one representative per pitch class (the highest note = canonical) drives
 * the optimisation. Lower octave duplicates are reattached afterward at their
 * original offset from their canonical, so they move implicitly with their leader.
 *
 * ─── ROLE-AWARE VOICE MATCHING ───────────────────────────────────────────────
 * Before placing any note in octave-space, `placeCanonicalVoices` determines
 * which pitch class in the new chord (B) corresponds to the melody, bass, and
 * inner voices of the previous chord (A) by greedy mod-12 distance matching in
 * priority order: melody first, bass second, inner voices third.
 *
 *   • |B| == |A|: bijection — every role is matched exactly once.
 *   • |B|  < |A|: the highest-priority roles are matched; excess A roles drop.
 *   • |B|  > |A|: all A roles are matched first; remaining B pitch classes
 *                 inherit the last inner-voice reference register.
 *
 * Roles are then placed structurally: melody unconstrained, bass clamped below
 * melody, inner voices clamped between them with collision nudging.
 *
 * ─── COMPLEXITY ─────────────────────────────────────────────────────────────
 * O(N · V²) where N = number of steps, V = max voices (notes) per step.
 *
 * The outer traversal visits each of the N steps once. Per step, the greedy
 * role-assignment in placeCanonicalVoices scans all unassigned B pcs for each
 * A role: at most V roles × V candidates = V² comparisons. The subsequent
 * octave-placement and collision nudging are O(V). Since V ≤ 6 in practice
 * (V² ≤ 36), the function is effectively O(N) for real sequences.
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
 * each step's notes in-place.
 *
 * The anchor (0-based step index) is held fixed; every other step is revoiced
 * to minimise voice-leading movement around the loop while preserving pitch
 * content. Melody, bass and inner voices are matched across chord changes by
 * role-aware greedy assignment before octave placement — see smoothVoicingSteps.
 *
 * Typically called with the currently active step as the anchor so the chord
 * that is currently sounding does not change register.
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
  { label: 'Ctn. Detune', value: 'detune' },
  { label: 'Discrete Detune', value: 'detune_semitone' },
  { label: 'Sustain', value: 'sustain' },
];

/**
 * Converts a step index (integer, 0 = centre) to cents by accumulating a
 * repeating interval pattern (values in semitones, each ≥ 1).
 * e.g. pattern=[7] stepsPerSide=4 → violin open strings a 5th apart.
 */
function stepToCents(step: number, pattern: number[]): number {
    if (step === 0 || pattern.length === 0) return 0;
    const sign = step > 0 ? 1 : -1;
    const n = Math.abs(step);
    let semitones = 0;
    for (let i = 0; i < n; i++) semitones += pattern[i % pattern.length];
    return sign * semitones * 100; // cents
}

const DETUNE_PATTERN_PRESETS: { label: string; pattern: number[]; semitoneRange: number }[] = [
    { label: 'Chromatic',  pattern: [1],             semitoneRange: 12 },
    { label: 'Whole Tone', pattern: [2],             semitoneRange: 12 },
    { label: 'Major',      pattern: [2,2,1,2,2,2,1], semitoneRange: 12 },
    { label: 'Nat Minor',  pattern: [2,1,2,2,1,2,2], semitoneRange: 12 },
    { label: 'Pentatonic', pattern: [2,3,2,2,3],     semitoneRange: 12 },
    { label: 'Guitar',     pattern: [5,5,5,4,5],     semitoneRange: 12 },
    { label: '5ths',       pattern: [7],             semitoneRange: 12 },
    { label: '4ths',       pattern: [5],             semitoneRange: 30 },
    { label: '3rds (maj)', pattern: [4],             semitoneRange: 12 },
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

// ---------------------------------------------------------------------------
// KB — single source of truth for every keyboard shortcut.
//
// key:     the exact e.key value(s) matched in onKeyDown.
//          For regex-matched keys (digits 1-9), this is a display string only;
//          the comment marks the entry accordingly.
// shift:   if true, the shortcut fires only when e.shiftKey is true.
// display: label rendered in the pad hint bar.
// hint:    short description rendered in the pad hint bar.
//
// To remap a shortcut:
//   1. Change `key` here.
//   2. Search the onKeyDown handler for the matching KB.<NAME>.key reference
//      and update it if the new key requires different matching logic.
//
// The hint bar text is generated automatically — no manual update needed.
// ---------------------------------------------------------------------------
const KB = {
    // ── Chord playback (hold) ─────────────────────────────────────────────
    PLAY:           { key: ['d', 'f'] as const,  display: 'D/F',    hint: 'Play'                       },

    // ── Step navigation ───────────────────────────────────────────────────
    RESET:          { key: '0',                  display: '0',  hint: 'Reset step'                 },
    BACK:           { key: 'b',                  display: 'B',      hint: 'Back step'                  },
    SECTIONS:       { key: '1-9' /* regex */,    display: '1-9',    hint: 'Jump section'               },

    // ── Transpose (plain arrows) ──────────────────────────────────────────
    SEMITONE_DN:    { key: 'ArrowLeft',           display: '←',      hint: 'Semitone −1'               },
    SEMITONE_UP:    { key: 'ArrowRight',          display: '→',      hint: 'Semitone +1'               },
    OCTAVE_UP:      { key: 'ArrowUp',             display: '↑',      hint: 'Octave +1'                 },
    OCTAVE_DN:      { key: 'ArrowDown',           display: '↓',      hint: 'Octave −1'                 },

    // ── Chord volume (Shift + arrow) ──────────────────────────────────────
    VOL_DN:         { key: 'ArrowLeft',  shift: true, display: '⇧←', hint: 'Vol −0.1'                 },
    VOL_UP:         { key: 'ArrowRight', shift: true, display: '⇧→', hint: 'Vol +0.1'                 },

    // ── Strum speed (Shift + arrow) ───────────────────────────────────────
    STRUM_UP:       { key: 'ArrowUp',    shift: true, display: '⇧↑', hint: 'Strum ×1.5'               },
    STRUM_DN:       { key: 'ArrowDown',  shift: true, display: '⇧↓', hint: 'Strum ÷1.5'               },

    // ── Note order ────────────────────────────────────────────────────────
    ORDER_RAND:     { key: 'r',                  display: 'R',      hint: 'Rand order'                 },
    ORDER_REV:      { key: 'R' /* Shift+r */,    display: '⇧R',     hint: 'Rev order'                  },
    ORDER_SORT:     { key: 's',                  display: 'S',      hint: 'Sort order'                 },

    // ── Voicing ───────────────────────────────────────────────────────────
    // A = Authentic (as-written), E = Exchange (invert up / drop down are
    // counterparts on the same key), C/⇧C = Compress / Widen (opposites),
    // G = Glide (smooth voice-leading).
    ORIGINAL:       { key: 'a',                  display: 'A',      hint: 'Authentic voicing'          },
    SMOOTH:         { key: 'g',                  display: 'G',      hint: 'Glide (smooth)'             },
    INVERT_1:       { key: 'e',                  display: 'E',      hint: '1st inv (exchange up)'      },
    DROP_1:         { key: 'E' /* Shift+e */,    display: '⇧E',     hint: 'Drop 1 (exchange down)'     },
    DROP_2:         { key: 'C' /* Shift+c */,    display: '⇧C',     hint: 'Drop 2 (widen)'             },
    COMPRESS:       { key: 'c',                  display: 'C',      hint: 'Compress'                   },

    // ── Solo / chord-note keys (hold; Shift=+oct, Ctrl=−oct) ─────────────
    RAND_NOTE:      { key: 'v',                  display: 'V',      hint: 'Rand note (⇧=+oct ⌃=−oct)' },
} as const;

/** Hint bar text shown at the bottom of the pad — auto-generated from KB. */
const KEY_HINT = (Object.values(KB) as { display: string; hint: string }[])
    .map(b => `${b.display}: ${b.hint}`)
    .join(' · ');

/**
 * Map from shifted e.key values back to their unshifted physical key.
 * Alpha keys are handled by .toLowerCase(); only punctuation that changes
 * shape when Shift is held needs an explicit entry here.
 */
const UNSHIFTED_KEY: Record<string, string> = {
    ':': ';', '"': "'", '{': '[', '}': ']', '<': ',', '>': '.', '?': '/',
    '~': '`', '!': '1', '@': '2', '#': '3', '$': '4', '%': '5',
    '^': '6', '&': '7', '*': '8', '(': '9', ')': '0', '_': '-', '+': '=',
    '|': '\\',
};

/**
 * Return the unshifted physical key string from any e.key value.
 * Shift+J → 'j', Shift+; → ';', Shift+[ → '[', etc.
 */
function physicalKeyOf(key: string): string {
    return UNSHIFTED_KEY[key] ?? key.toLowerCase();
}

// ---------------------------------------------------------------------------
// Solo key layout system
//
// NoteAddress — two addressing modes:
//   interval:  play bass + N semitones (root-relative, independent of chord content)
//   chordTone: play the Nth note of the chord sorted ascending
//              negative index counts from the top (-1 = highest note)
//
// KeyLayout — maps a physical key string to a NoteAddress.
//   Keys not present in the layout map are silently ignored.
//
// SOLO_LAYOUTS — named presets. The default ('chordTones') reproduces the
//   original J/K/L/; behaviour exactly so nothing changes on first load.
// ---------------------------------------------------------------------------
type NoteAddress =
    | { mode: 'interval';  semitones: number }
    | { mode: 'chordTone'; index: number };

type KeyLayout = Record<string, NoteAddress>;

type SoloLayoutName = 'chordTones' | 'wickiHayden' | 'diatonic' | 'chromatic' | 'chordBiased' | 'fullKBwikiHayden';

/**
 * Resolve a NoteAddress to a MIDI note number.
 * @param address  - the address from the active layout
 * @param chordMidi - the current step's notes (unsorted)
 * @param octaveShift - semitones from Shift/Ctrl modifier
 * @param majorKeyTonicOverride - if provided (0–11), overrides the bass pitch class
 *   with this major key tonic (same MIDI octave block as the chord's actual bass)
 */
function resolveNoteAddress(
    address: NoteAddress,
    chordMidi: number[],
    octaveShift: number,
    majorKeyTonicOverride?: number,
): number {
    const sorted = [...chordMidi].sort((a, b) => a - b);
    const bass = sorted[0] ?? 60;

    if (address.mode === 'interval') {
        let base: number;
        if (majorKeyTonicOverride !== undefined) {
            // keep the chord bass's MIDI octave block, just swap pitch class
            const octaveBlock = Math.floor(bass / 12);
            base = octaveBlock * 12 + majorKeyTonicOverride;
        } else {
            base = bass;
        }
        return base + address.semitones + octaveShift;
    }

    // chordTone mode: negative index counts from the top
    const rawIdx = address.index < 0 ? sorted.length + address.index : address.index;
    const idx = Math.max(0, Math.min(sorted.length - 1, rawIdx));
    return sorted[idx] + octaveShift;
}

// ---------------------------------------------------------------------------
// Key detection for interval-mode solo
//
// detectBestKey         → KeySpec with .label (display) and .relativeMajorTonic (bass)
//
// Both use the same exponentially-weighted chord history so recent chords matter
// more. Ambiguity between relative major/minor is resolved by a tonic-in-chord
// bonus: if the chord contains the key's own tonic note it scores slightly higher.
// ---------------------------------------------------------------------------

const MAJOR_SCALE_INTERVALS = [0, 2, 4, 5, 7, 9, 11] as const;

const KEY_NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

type KeySpec = { tonic: number; mode: 'major' | 'minor'; label: string; relativeMajorTonic: number };

/** All registered keys. Extend this array to add modes (Dorian, Phrygian, etc.). */
const ALL_KEYS: KeySpec[] = (() => {
    const keys: KeySpec[] = [];
    for (let t = 0; t < 12; t++) {
        keys.push({ tonic: t, mode: 'major', label: `${KEY_NOTE_NAMES[t]} major`, relativeMajorTonic: t });
        // Natural minor: tonic is a minor 6th (9 semitones) above the relative major tonic.
        // e.g. C major → A minor (A = C + 9)
        const minorTonic = (t + 9) % 12;
        keys.push({ tonic: minorTonic, mode: 'minor', label: `${KEY_NOTE_NAMES[minorTonic]} minor`, relativeMajorTonic: t });
    }
    return keys;
})();

/**
 * Score a single major key (by tonic 0–11) against a set of pitch classes.
 * Tonic, major-3rd and perfect-5th of the key each score 2; other diatonic
 * notes score 1; out-of-key notes score 0.
 */
function scoreMajorKey(tonic: number, pcs: Set<number>): number {
    const strong = new Set([
        tonic % 12,
        (tonic + 4) % 12, // major 3rd
        (tonic + 7) % 12, // perfect 5th
    ]);
    let score = 0;
    for (const interval of MAJOR_SCALE_INTERVALS) {
        const pc = (tonic + interval) % 12;
        if (pcs.has(pc)) score += strong.has(pc) ? 2 : 1;
    }
    return score;
}

/**
 * Build a chord history array from the sequence, going backwards from stepIndex.
 * history[0] = current step, history[1] = one step back, etc.
 * Does NOT wrap around: steps before index 0 are excluded so future chords
 * are never treated as past history (avoids contaminating step 0's key detection).
 */
function buildChordHistory(chordSequence: ChordStep[], stepIndex: number, maxDepth = 8): number[][] {
    const n = chordSequence.length;
    if (n === 0) return [];
    const history: number[][] = [];
    // Only go back as far as step 0 — no circular wrap
    const depth = Math.min(maxDepth, stepIndex + 1);
    for (let i = 0; i < depth; i++) {
        history.push(chordSequence[stepIndex - i].notes);
    }
    return history;
}

/**
 * Detect the best-matching key from chord history using incremental lookback
 * with candidate pruning.
 * Returns the full KeySpec so callers can read both `.label` (display) and
 * `.relativeMajorTonic` (bass pitch class for interval-mode solo) from the
 * same winner — guaranteeing the two never diverge.
 *
 * Algorithm:
 *   1. Start with all keys as candidates.
 *   2. Score each candidate against the current chord (depth 0).
 *   3. Prune to only the top-scoring candidates — discard the rest permanently.
 *   4. If exactly one candidate remains → return it.
 *   5. Otherwise score surviving candidates against the next step back and repeat.
 *   6. If still tied after full history, apply a bass-note tiebreak and return
 *      the leader among the surviving candidates.
 */
function detectBestKey(chordHistory: number[][]): KeySpec {
    if (chordHistory.length === 0) return ALL_KEYS[0];

    // Work with indices so pruning is cheap
    let candidates = ALL_KEYS.map((_, i) => i);
    const bassPc = ((Math.min(...chordHistory[0]) % 12) + 12) % 12;

    for (let depth = 0; depth < chordHistory.length; depth++) {
        const pcs = new Set(chordHistory[depth].map(m => ((m % 12) + 12) % 12));

        // Score only surviving candidates against this depth's chord
        const depthScores = candidates.map(i =>
            scoreMajorKey(ALL_KEYS[i].relativeMajorTonic, pcs)
        );

        // Prune to top scorers only
        const maxDepthScore = Math.max(...depthScores);
        candidates = candidates.filter((_, j) => depthScores[j] === maxDepthScore);

        if (candidates.length === 1) return ALL_KEYS[candidates[0]];
    }

    // Still tied — apply bass-note tiebreak among survivors
    const withBass = candidates.filter(i => ALL_KEYS[i].tonic === bassPc);
    if (withBass.length > 0) return ALL_KEYS[withBass[0]];
    return ALL_KEYS[candidates[0]];
}

const SOLO_LAYOUTS: Record<SoloLayoutName, { label: string; description: string; layout: KeyLayout }> = {
    // ── Default: reproduces original J/K/L/; chord-tone behaviour exactly ─
    chordTones: {
        label: 'Chord Tones',
        description: 'J K L ; → chord notes lo→hi (linear scale)',
        layout: {
            'j': { mode: 'chordTone', index: 0 },
            'k': { mode: 'chordTone', index: 1 },
            'l': { mode: 'chordTone', index: 2 },
            ';': { mode: 'chordTone', index: 3 },
        },
    },
    wickiHayden: {
        label: 'Wicki-Hayden',
        description: 'Wicki-Hayden layout: see wikipedia (isomorphic keyboard: translationally equivariant)',
        layout: {
            // bottom row
            'n': { mode: 'interval', semitones: -2 },
            'm': { mode: 'interval', semitones: 0 },
            ',': { mode: 'interval', semitones: 2 },
            '.': { mode: 'interval', semitones: 4 },
            '/': { mode: 'interval', semitones: 6 },
            // home row
            'h': { mode: 'interval', semitones: 3  },
            'j': { mode: 'interval', semitones: 5  },
            'k': { mode: 'interval', semitones: 7  },
            'l': { mode: 'interval', semitones: 9 },
            ';': { mode: 'interval', semitones: 11 },
            "'": { mode: 'interval', semitones: 13 },
            // top row
            'y': { mode: 'interval', semitones: 8 },
            'u': { mode: 'interval', semitones: 10 },
            'i': { mode: 'interval', semitones: 12 },
            'o': { mode: 'interval', semitones: 14 },
            'p': { mode: 'interval', semitones: 16 },
            '[': { mode: 'interval', semitones: 18 },
            ']': { mode: 'interval', semitones: 20 },
        }
    },
    fullKBwikiHayden: {
        label: '2 hands Wicki-Hayden',
        description: 'Wicki-Hayden layout extended to the bottom row (isomorphic keyboard: translationally equivariant)',
        layout: {
            // bottom row
            'z': { mode: 'interval', semitones: -12 },
            'x': { mode: 'interval', semitones: -10 },
            'c': { mode: 'interval', semitones: -8 },
            'v': { mode: 'interval', semitones: -6 },
            'b': { mode: 'interval', semitones: -4 },
            'n': { mode: 'interval', semitones: -2 },
            'm': { mode: 'interval', semitones: 0 },
            ',': { mode: 'interval', semitones: 2 },
            '.': { mode: 'interval', semitones: 4 },
            '/': { mode: 'interval', semitones: 6 },
            // home row
            'a': { mode: 'interval', semitones: -7 },
            's': { mode: 'interval', semitones: -5 },
            'd': { mode: 'interval', semitones: -3 },
            'f': { mode: 'interval', semitones: -1 },
            'g': { mode: 'interval', semitones: 1 },
            'h': { mode: 'interval', semitones: 3  },
            'j': { mode: 'interval', semitones: 5  },
            'k': { mode: 'interval', semitones: 7  },
            'l': { mode: 'interval', semitones: 9 },
            ';': { mode: 'interval', semitones: 11 },
            "'": { mode: 'interval', semitones: 13 },
            // top row
            'q': { mode: 'interval', semitones: -2 },
            'w': { mode: 'interval', semitones: 0 },
            'e': { mode: 'interval', semitones: 2 },
            'r': { mode: 'interval', semitones: 4 },
            't': { mode: 'interval', semitones: 6 },
            'y': { mode: 'interval', semitones: 8 },
            'u': { mode: 'interval', semitones: 10 },
            'i': { mode: 'interval', semitones: 12 },
            'o': { mode: 'interval', semitones: 14 },
            'p': { mode: 'interval', semitones: 16 },
            '[': { mode: 'interval', semitones: 18 },
            ']': { mode: 'interval', semitones: 20 },

        }
    },
    // ── Diatonic: home row = white keys (major scale), top row = accidentals ─
    // All intervals relative to bass note (semitone 0).
    // Home row H J K L ; '  → 0  2  4  5  7  9   (C D E F G A in C major)
    // Top row  Y U I O P [  → 1  3  6  8  10 11  (Db Eb F# Ab Bb B)
    // Bot row  N M , . /    → -1 -3 -5 -7 -8     (B  A  G  F  E below)
    diatonic: {
        label: 'Diatonic',
        description: 'Home row = scale tones, top row = accidentals, bottom row = lower approach',
        layout: {
            // home row
            'h': { mode: 'interval', semitones: 0  },
            'j': { mode: 'interval', semitones: 2  },
            'k': { mode: 'interval', semitones: 4  },
            'l': { mode: 'interval', semitones: 5  },
            ';': { mode: 'interval', semitones: 7  },
            "'": { mode: 'interval', semitones: 9  },
            // top row — accidentals
            'y': { mode: 'interval', semitones: 1  },
            'u': { mode: 'interval', semitones: 3  },
            'i': { mode: 'interval', semitones: 6  },
            'o': { mode: 'interval', semitones: 8  },
            'p': { mode: 'interval', semitones: 10 },
            '[': { mode: 'interval', semitones: 11 },
            // bottom row — lower chromatic approaches
            'n': { mode: 'interval', semitones: -1 },
            'm': { mode: 'interval', semitones: -3 },
            ',': { mode: 'interval', semitones: -5 },
            '.': { mode: 'interval', semitones: -7 },
            '/': { mode: 'interval', semitones: -8 },
        },
    },

    // ── Chromatic: fully linear, one semitone per key left→right ──────────
    // Top row Y U I O P [ ]  → 0  1  2  3  4  5  6
    // Home row H J K L ; '   → 7  8  9  10 11 12
    // Bottom row N M , . /   → -5 -4 -3 -2 -1
    chromatic: {
        label: 'Chromatic',
        description: 'Fully chromatic: each key = 1 semitone; top row starts at bass, home row +7',
        layout: {
            // top row: semitones 0–6
            'y': { mode: 'interval', semitones: 0  },
            'u': { mode: 'interval', semitones: 1  },
            'i': { mode: 'interval', semitones: 2  },
            'o': { mode: 'interval', semitones: 3  },
            'p': { mode: 'interval', semitones: 4  },
            '[': { mode: 'interval', semitones: 5  },
            ']': { mode: 'interval', semitones: 6  },
            // home row: semitones 7–12
            'h': { mode: 'interval', semitones: 7  },
            'j': { mode: 'interval', semitones: 8  },
            'k': { mode: 'interval', semitones: 9  },
            'l': { mode: 'interval', semitones: 10 },
            ';': { mode: 'interval', semitones: 11 },
            "'": { mode: 'interval', semitones: 12 },
            // bottom row: lower chromatic
            'n': { mode: 'interval', semitones: -5 },
            'm': { mode: 'interval', semitones: -4 },
            ',': { mode: 'interval', semitones: -3 },
            '.': { mode: 'interval', semitones: -2 },
            '/': { mode: 'interval', semitones: -1 },
        },
    },

    // ── Chord-biased: home row = chord tones, rows = chromatic neighbors ──
    // Home row J K L ;    → chord tones 0–3 (same as default)
    // Home row H          → chordTone -1 (top note, melody ceiling)
    // Top row  Y U   O P  → upper chromatic neighbors of each chord tone
    // Top row  I          → tritone / b5 above bass
    // Bot row  N M , . /  → lower chromatic approach notes
    chordBiased: {
        label: 'Chord-Biased',
        description: 'Home row = chord tones; reach up/down for chromatic approach notes',
        layout: {
            // home row — chord tones
            'h': { mode: 'chordTone', index: -1 },  // top note (melody ceiling)
            'j': { mode: 'chordTone', index: 0  },
            'k': { mode: 'chordTone', index: 1  },
            'l': { mode: 'chordTone', index: 2  },
            ';': { mode: 'chordTone', index: 3  },
            // top row — upper chromatic / color tones relative to bass
            'y': { mode: 'interval', semitones: 1  },  // b9
            'u': { mode: 'interval', semitones: 3  },  // #9 / b3
            'i': { mode: 'interval', semitones: 6  },  // b5 / #11
            'o': { mode: 'interval', semitones: 8  },  // b13 / #5
            'p': { mode: 'interval', semitones: 10 },  // b7
            '[': { mode: 'interval', semitones: 11 },  // maj7
            // bottom row — lower chromatic approach notes
            'n': { mode: 'interval', semitones: -1 },  // leading tone below
            'm': { mode: 'interval', semitones: -2 },  // b7 below
            ',': { mode: 'interval', semitones: -4 },  // b6 below
            '.': { mode: 'interval', semitones: -5 },  // 4th below
            '/': { mode: 'interval', semitones: -7 },  // 5th below
        },
    },
};

// Colour palette cycled per simultaneous touch point.
const TOUCH_COLORS = [
    { dot: '#818cf8', glow: 'rgba(99,102,241,0.22)',  ring: 'rgba(129,140,248,0.55)' }, // indigo
    { dot: '#a78bfa', glow: 'rgba(139,92,246,0.22)',  ring: 'rgba(167,139,250,0.55)' }, // violet
    { dot: '#e879f9', glow: 'rgba(217,70,239,0.22)',  ring: 'rgba(232,121,249,0.55)' }, // fuchsia
    { dot: '#22d3ee', glow: 'rgba(6,182,212,0.22)',   ring: 'rgba(34,211,238,0.55)'  }, // cyan
    { dot: '#34d399', glow: 'rgba(16,185,129,0.22)',  ring: 'rgba(52,211,153,0.55)'  }, // emerald
];

const PerformancePad: React.FC = () => {
    const padRef = useRef<HTMLDivElement>(null);
    const activePointerIdsRef = useRef<Set<number>>(new Set());
    // Maps pointer ID → audio voice-group ID for independently-releasable multi-touch chords.
    const pointerVoiceGroupRef = useRef<Map<number, number>>(new Map());
    const controlPointerIdRef = useRef<number | null>(null);
    const activeKeyboardKeysRef = useRef<Set<string>>(new Set());
    const isMouseInPadRef = useRef(false);
    const hoverPosRef = useRef({ x: 0.5, y: 0.5 });
    const [isPlaying, setIsPlaying] = useState(false);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [isFallbackFullscreen, setIsFallbackFullscreen] = useState(false);
    const [cursorPos, setCursorPos] = useState({ x: 0, y: 0 }); // 0-1 normalised
    // Per-finger positions for multi-touch visualisation.
    const [touchPoints, setTouchPoints] = useState<{ id: number; x: number; y: number }[]>([]);
    const [isTouchDevice, setIsTouchDevice] = useState(false);

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

    // Solo key layout
    const [currentLayout, setCurrentLayout] = useState<SoloLayoutName>('chordTones');
    const currentLayoutRef = useRef<SoloLayoutName>('chordTones');
    useEffect(() => { currentLayoutRef.current = currentLayout; }, [currentLayout]);

    // Detected key for interval-mode solo (updated whenever step or sequence changes)
    const [detectedKey, setDetectedKey] = useState<string>('');
    const detectedMajorTonicRef = useRef<number>(0);

    // Recompute detected key whenever sequence or step changes
    useEffect(() => {
        if (chordSequence.length === 0) { setDetectedKey(''); return; }
        // Mirror the same isPlaying correction used in playSoloKey:
        // while the pad is held currentNoteIndex has already advanced, so
        // the sounding step is one behind.
        const soundingIdx = isPlaying
            ? (currentNoteIndex - 1 + chordSequence.length) % chordSequence.length
            : currentNoteIndex % chordSequence.length;
        const history = buildChordHistory(chordSequence, soundingIdx);
        const best = detectBestKey(history);
        detectedMajorTonicRef.current = best.relativeMajorTonic;
        setDetectedKey(best.label);
    }, [chordSequence, currentNoteIndex, isPlaying]);

    // Mappings
    const [xTargets, setXTargets] = useState<ModulationTarget[]>(['cutoff']);
    const [yTargets, setYTargets] = useState<ModulationTarget[]>(['resonance']);
    const [xFlipped, setXFlipped] = useState(false);
    const [yFlipped, setYFlipped] = useState(false);

    // Discrete detune: per-axis interval pattern and independent lo/hi semitone ranges.
    // [1] = chromatic (default); [7] = 5ths (violin); [2,2,1,2,2,2,1] = major scale, etc.
    const [xDetunePattern, setXDetunePattern] = useState<number[]>([1]);
    const [xDetuneSemitoneRangeLo, setXDetuneSemitoneRangeLo] = useState(6);
    const [xDetuneSemitoneRangeHi, setXDetuneSemitoneRangeHi] = useState(6);
    const [xDetunePatternInput, setXDetunePatternInput] = useState('1');
    const [yDetunePattern, setYDetunePattern] = useState<number[]>([1]);
    const [yDetuneSemitoneRangeLo, setYDetuneSemitoneRangeLo] = useState(6);
    const [yDetuneSemitoneRangeHi, setYDetuneSemitoneRangeHi] = useState(6);
    const [yDetunePatternInput, setYDetunePatternInput] = useState('1');

    // Pad pixel size — updated by a ResizeObserver so we can show px/band feedback.
    const [padSize, setPadSize] = useState({ width: 0, height: 0 });

    // Derived: steps on each side from the pattern average interval.
    const xDetuneStepsLo = useMemo(() => {
        const avg = xDetunePattern.reduce((a, b) => a + b, 0) / xDetunePattern.length;
        return Math.max(1, Math.ceil(xDetuneSemitoneRangeLo / avg));
    }, [xDetunePattern, xDetuneSemitoneRangeLo]);
    const xDetuneStepsHi = useMemo(() => {
        const avg = xDetunePattern.reduce((a, b) => a + b, 0) / xDetunePattern.length;
        return Math.max(1, Math.ceil(xDetuneSemitoneRangeHi / avg));
    }, [xDetunePattern, xDetuneSemitoneRangeHi]);
    const yDetuneStepsLo = useMemo(() => {
        const avg = yDetunePattern.reduce((a, b) => a + b, 0) / yDetunePattern.length;
        return Math.max(1, Math.ceil(yDetuneSemitoneRangeLo / avg));
    }, [yDetunePattern, yDetuneSemitoneRangeLo]);
    const yDetuneStepsHi = useMemo(() => {
        const avg = yDetunePattern.reduce((a, b) => a + b, 0) / yDetunePattern.length;
        return Math.max(1, Math.ceil(yDetuneSemitoneRangeHi / avg));
    }, [yDetunePattern, yDetuneSemitoneRangeHi]);

    // Continuous detune: independent lo/hi semitone ranges per axis.
    const [xDetuneCentsRangeLo, setXDetuneCentsRangeLo] = useState(6);
    const [xDetuneCentsRangeHi, setXDetuneCentsRangeHi] = useState(6);
    const [yDetuneCentsRangeLo, setYDetuneCentsRangeLo] = useState(6);
    const [yDetuneCentsRangeHi, setYDetuneCentsRangeHi] = useState(6);

    // Track pad dimensions for the px/band density hint.
    useEffect(() => {
        const el = padRef.current;
        if (!el) return;
        const ro = new ResizeObserver(entries => {
            const { width, height } = entries[0].contentRect;
            setPadSize({ width, height });
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

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
        setIsTouchDevice(navigator.maxTouchPoints > 0 || 'ontouchstart' in window);
    }, []);

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

        // Prevent iOS Safari's pull-down-to-reveal-address-bar gesture from
        // "exiting" fallback fullscreen. Must be non-passive to call preventDefault.
        const lockTouchMove = (e: TouchEvent) => { e.preventDefault(); };
        document.addEventListener('touchmove', lockTouchMove, { passive: false });

        return () => {
            document.removeEventListener('touchmove', lockTouchMove);
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

        // On iOS Safari, requestFullscreen is either unsupported or exits on a
        // swipe-down gesture that cannot be suppressed. Always use the fixed-position
        // fallback on iOS so we can lock touchmove ourselves.
        const isIOS = /ipad|iphone|ipod/i.test(navigator.userAgent) ||
            (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

        if (isIOS) {
            setIsFallbackFullscreen(prev => !prev);
            return;
        }

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
    // x, y are 0-1; apply axis flip before mapping
    const mx = xFlipped ? 1 - x : x;
    const my = yFlipped ? 1 - y : y;
    const updates: Partial<SynthConfig> = {};

    // Helper to map 0-1 to parameter ranges; returns [synthConfigKey, value]
    const mapValue = (val: number, target: ModulationTarget, stepsLo: number, stepsHi: number, pattern: number[], contRangeLo: number, contRangeHi: number): [keyof SynthConfig, number] => {
        switch (target) {
            case 'cutoff':     return ['cutoff',    100 + (val * 8000)];
            case 'resonance':  return ['resonance', val * 20];
            case 'detune': {
                // Linear mapping identical to discrete but without snapping.
                // N = lo+hi+1 bands; centre of band i → i−lo semitones (×100 cents).
                // cents = (val*N − lo − 0.5)*100  →  centre of zero band = 0 cents.
                const N = contRangeLo + contRangeHi + 1;
                return ['detune', (val * N - contRangeLo - 0.5) * 100];
            }
            case 'detune_semitone': {
                // Equal-width N bands; val maps linearly across all N.
                const N = stepsLo + stepsHi + 1;
                const idx = Math.min(N - 1, Math.max(0, Math.floor(val * N)));
                return ['detune', stepToCents(idx - stepsLo, pattern)];
            }
            case 'sustain':    return ['sustain',   val];
            default:           return [target as keyof SynthConfig, 0];
        }
    };

    const accumulate = (key: keyof SynthConfig, value: number) => {
        updates[key] = ((updates[key] as number | undefined) ?? 0) + value as never;
    };

    xTargets.forEach(t => {
        const [key, value] = mapValue(mx, t, xDetuneStepsLo, xDetuneStepsHi, xDetunePattern, xDetuneCentsRangeLo, xDetuneCentsRangeHi);
        accumulate(key, value);
    });

    yTargets.forEach(t => {
        const [key, value] = mapValue(my, t, yDetuneStepsLo, yDetuneStepsHi, yDetunePattern, yDetuneCentsRangeLo, yDetuneCentsRangeHi);
        accumulate(key, value);
    });

    return updates;
  }, [xTargets, yTargets, xFlipped, yFlipped, xDetunePattern, xDetuneSemitoneRangeLo, xDetuneSemitoneRangeHi, xDetuneStepsLo, xDetuneStepsHi, yDetunePattern, yDetuneSemitoneRangeLo, yDetuneSemitoneRangeHi, yDetuneStepsLo, yDetuneStepsHi, xDetuneCentsRangeLo, xDetuneCentsRangeHi, yDetuneCentsRangeLo, yDetuneCentsRangeHi]);

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
     * octaveShift: semitones to add (+12 = up one octave, -12 = down one octave).
     */
    const playRandomNoteFromCurrentStep = useCallback((octaveShift = 0) => {
        const sequence = chordSequence.length > 0 ? chordSequence : [{ notes: [60], strumMs: 0 }];
        const stepIndex = isPlaying
            ? (currentNoteIndexRef.current - 1 + sequence.length) % sequence.length
            : currentNoteIndexRef.current % sequence.length;
        const step = sequence[stepIndex];
        const midi = step.notes[Math.floor(Math.random() * step.notes.length)];
        // not using chordVolumeRef.current because this is a solo note outside the continuous chord voices
        audioEngine.addContinuousNote(Math.max(0, Math.min(127, midi + octaveShift)), 100);
    }, [chordSequence, isPlaying]);

    /**
     * Play a note from the current step mapped linearly by keyIndex (0 = min pitch, 3 = max pitch).
     * Notes in the step are sorted ascending; keyIndex is scaled across them.
     * octaveShift: semitones to add (+12 = up one octave, -12 = down one octave).
     * Used by the UI buttons which don't go through the layout system.
     */
    const playNoteFromCurrentStepByLinearIndex = useCallback((keyIndex: number, octaveShift = 0) => {
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
        const midi = sorted[Math.min(noteIdx, sorted.length - 1)];
        audioEngine.addContinuousNote(Math.max(0, Math.min(127, midi + octaveShift)), 100);
    }, [chordSequence, isPlaying]);

    /**
     * Play a note using the active solo key layout.
     * Looks up the physical key in the current layout, resolves the NoteAddress
     * against the current chord step, and plays the result.
     * Returns true if the key was handled, false if the layout has no mapping for it.
     */
    const playSoloKey = useCallback((physicalKey: string, octaveShift = 0): boolean => {
        const layout = SOLO_LAYOUTS[currentLayoutRef.current].layout;
        const address = layout[physicalKey];
        if (!address) return false;

        const sequence = chordSequence.length > 0 ? chordSequence : [{ notes: [60], strumMs: 0 }];
        const stepIndex = isPlaying
            ? (currentNoteIndexRef.current - 1 + sequence.length) % sequence.length
            : currentNoteIndexRef.current % sequence.length;
        const step = sequence[stepIndex];
        if (step.notes.length === 0) return false;

        const tonicOverride = address.mode === 'interval'
            ? detectedMajorTonicRef.current
            : undefined;
        const midi = resolveNoteAddress(address, step.notes, octaveShift, tonicOverride);
        audioEngine.addContinuousNote(Math.max(0, Math.min(127, midi)), 100);
        return true;
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
        // Snapshots voicingBase first so the user can restore the original with O.
        setVoicingBase(prev => prev ?? sequenceInput);
        // Mark this change as voicing-originated so the parse effect doesn't clear the snapshot.
        voicingChangeInProgressRef.current = true;
        setSequenceInput(prev => transposeSequence(prev, delta));
    }, [sequenceInput]);

    /**
     * Revoice all steps for smooth voice-leading (key: N).
     *
     * Anchors to the current step (its voicing stays unchanged) and adjusts
     * every other step's register to minimise semitone movement between
     * consecutive chords around the loop. Melody, bass and inner voices are
     * matched by role across chord changes (not by fixed index), so the
     * smoothing adapts correctly even when chords have different note counts.
     *
     * Snapshots voicingBase first so the user can restore the original with O.
     */
    const applySmooth = useCallback(() => {
        setVoicingBase(prev => prev ?? sequenceInput);
        voicingChangeInProgressRef.current = true;
        setSequenceInput(prev => applySmoothVoicingToSequence(prev, currentNoteIndex));
    }, [sequenceInput, currentNoteIndex]);

    // Suppress iOS text-editing UI (undo bar, clipboard bubble, "looks like typing" prompt).
    // Must be a non-passive listener so preventDefault() is actually honoured by iOS Safari.
    // Skip controls (fullscreen button, etc.) so their taps still register.
    useEffect(() => {
        const el = padRef.current;
        if (!el) return;
        const suppressiOSTextUI = (e: TouchEvent) => {
            const target = e.target as HTMLElement | null;
            // Walk up the DOM: if the touch landed on a pad-control element, let it through
            // so buttons/sliders inside the pad remain tappable.
            let node: HTMLElement | null = target;
            while (node && node !== el) {
                if (node.dataset.padControl === 'true') return;
                node = node.parentElement;
            }
            e.preventDefault();
        };
        el.addEventListener('touchstart', suppressiOSTextUI, { passive: false });
        return () => el.removeEventListener('touchstart', suppressiOSTextUI);
    }, []);

    // Block iPadOS undo/redo gestures (3-finger swipe / shortcut bar) from triggering
    // the system undo popup. We only block these when the textarea is NOT focused,
    // so intentional undo inside the text field still works.
    useEffect(() => {
        const blockUndoRedo = (e: Event) => {
            const ie = e as InputEvent;
            if (ie.inputType === 'historyUndo' || ie.inputType === 'historyRedo') {
                const active = document.activeElement;
                const isInTextField = active && (
                    active.tagName === 'INPUT' ||
                    active.tagName === 'TEXTAREA' ||
                    (active as HTMLElement).isContentEditable
                );
                if (!isInTextField) {
                    e.preventDefault();
                }
            }
        };
        document.addEventListener('beforeinput', blockUndoRedo);
        return () => document.removeEventListener('beforeinput', blockUndoRedo);
    }, []);

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

            // Solo layout keys take priority over all other KB shortcuts.
            // This lets any physical key be claimed by the active layout —
            // including left-hand keys — without needing to clean up the
            // individual handlers below.
            // physicalKeyOf() strips Shift from e.key (J→j, ;→;, [→[, etc.).
            {
                const physicalKey = physicalKeyOf(e.key);
                const isLayoutKey = !!SOLO_LAYOUTS[currentLayoutRef.current].layout[physicalKey];
                if (isLayoutKey) {
                    e.preventDefault();
                    if (!e.repeat && !activeKeyboardKeysRef.current.has(physicalKey)) {
                        const octaveShift = e.shiftKey ? 12 : e.ctrlKey ? -12 : 0;
                        playSoloKey(physicalKey, octaveShift);
                        activeKeyboardKeysRef.current.add(physicalKey);
                    }
                    return;
                }
            }

            // KB.RESET: reset step counter
            if (e.key === KB.RESET.key) {
                e.preventDefault();
                setCurrentNoteIndex(0);
                currentNoteIndexRef.current = 0;
                return;
            }

            // KB.BACK: go back one step
            if (e.key === KB.BACK.key) {
                e.preventDefault();
                const seqLen = chordSequence.length > 0 ? chordSequence.length : 1;
                const prev = (currentNoteIndexRef.current - 1 + seqLen) % seqLen;
                currentNoteIndexRef.current = prev;
                setCurrentNoteIndex(prev);
                return;
            }

            // KB.SECTIONS: jump to section (digits 1-9, matched via /^[1-9]$/ regex)
            if (/^[1-9]$/.test(e.key)) {
                e.preventDefault();
                jumpToSection(parseInt(e.key) - 1);
                return;
            }

            // Keyboard shortcuts with an optional shift modifier — each KB entry is
            // matched independently using its own key + shift fields, so remapping
            // any entry in KB is sufficient to change behaviour here.
            {
                // Returns true when the event matches a KB entry exactly:
                //   • kb.shift === true  → key matches AND Shift is held
                //   • kb.shift falsy     → key matches AND Shift is NOT held
                const kb = (entry: { key: string; shift?: boolean }) =>
                    e.key === entry.key && (entry.shift ? e.shiftKey : !e.shiftKey);

                if (kb(KB.VOL_DN)) {
                    e.preventDefault();
                    setChordVolume(prev => {
                        const v = Math.max(0, Math.round((prev - 0.1) * 10) / 10);
                        chordVolumeRef.current = v;
                        return v;
                    });
                    return;
                }
                if (kb(KB.VOL_UP)) {
                    e.preventDefault();
                    setChordVolume(prev => {
                        const v = Math.min(1, Math.round((prev + 0.1) * 10) / 10);
                        chordVolumeRef.current = v;
                        return v;
                    });
                    return;
                }
                if (kb(KB.STRUM_UP)) {
                    e.preventDefault();
                    setSequenceInput(prev => scaleStrumSpeed(prev, 1.5));
                    return;
                }
                if (kb(KB.STRUM_DN)) {
                    e.preventDefault();
                    setSequenceInput(prev => scaleStrumSpeed(prev, 1 / 1.5));
                    return;
                }
                if (kb(KB.SEMITONE_DN)) {
                    e.preventDefault();
                    applyTranspose(-1);
                    return;
                }
                if (kb(KB.SEMITONE_UP)) {
                    e.preventDefault();
                    applyTranspose(1);
                    return;
                }
                if (kb(KB.OCTAVE_UP)) {
                    e.preventDefault();
                    applyTranspose(12);
                    return;
                }
                if (kb(KB.OCTAVE_DN)) {
                    e.preventDefault();
                    applyTranspose(-12);
                    return;
                }
            }

            // KB.ORDER_RAND / KB.ORDER_REV / KB.ORDER_SORT: reorder chord notes
            if (e.key === KB.ORDER_RAND.key) {
                e.preventDefault();
                setSequenceInput(prev => reorderChordNotes(prev, 'random'));
                return;
            }
            if (e.key === KB.ORDER_REV.key) {
                e.preventDefault();
                setSequenceInput(prev => reorderChordNotes(prev, 'reverse'));
                return;
            }
            if (e.key === KB.ORDER_SORT.key) {
                e.preventDefault();
                setSequenceInput(prev => reorderChordNotes(prev, 'sort'));
                return;
            }

            // KB.ORIGINAL: restore original voicing
            if (e.key === KB.ORIGINAL.key) {
                e.preventDefault();
                if (voicingBase) {
                    voicingChangeInProgressRef.current = true;
                    setSequenceInput(voicingBase);
                    setVoicingBase(null);
                }
                return;
            }

            // KB.INVERT_1 / KB.DROP_1 / KB.DROP_2 / KB.COMPRESS / KB.SMOOTH: voicing
            if (e.key === KB.INVERT_1.key) {
                e.preventDefault();
                applyVoicing(m => invertChord(m, 1));
                return;
            }
            if (e.key === KB.DROP_1.key) {
                e.preventDefault();
                applyVoicing(m => dropChord(m, 1));
                return;
            }
            if (e.key === KB.DROP_2.key) {
                e.preventDefault();
                applyVoicing(m => dropChord(m, 2));
                return;
            }
            if (e.key === KB.COMPRESS.key) {
                e.preventDefault();
                applyVoicing(compressVoicing);
                return;
            }
            if (e.key === KB.SMOOTH.key) {
                e.preventDefault();
                applySmooth();
                return;
            }

            // KB.RAND_NOTE: random note from current step (hold; Shift=+oct, Ctrl=−oct)
            if (e.key.toLowerCase() === KB.RAND_NOTE.key) {
                if (e.repeat || activeKeyboardKeysRef.current.has(KB.RAND_NOTE.key)) return;
                e.preventDefault();
                activeKeyboardKeysRef.current.add(KB.RAND_NOTE.key);
                const octaveShift = e.shiftKey ? 12 : e.ctrlKey ? -12 : 0;
                playRandomNoteFromCurrentStep(octaveShift);
                return;
            }

            // KB.PLAY: play chord (hold)
            const key = e.key.toLowerCase();
            if (!(KB.PLAY.key as readonly string[]).includes(key)) return;
            if (e.repeat || activeKeyboardKeysRef.current.has(key)) return;

            activeKeyboardKeysRef.current.add(key);
            const { x, y } = hoverPosRef.current;
            startTrigger(x, y);
        };

        const onKeyUp = (e: KeyboardEvent) => {
            // Release any key that was tracked as a held solo note or play key.
            // This covers: KB.PLAY keys, KB.RAND_NOTE, and any key in the active layout.
            // Normalise via physicalKeyOf so releasing Shift before the key
            // (which flips e.key from 'J' back to 'j') still finds the entry.
            const physicalKey = physicalKeyOf(e.key);
            const playKeys: string[] = [...KB.PLAY.key];
            const isTracked =
                playKeys.includes(physicalKey) ||
                physicalKey === KB.RAND_NOTE.key ||
                activeKeyboardKeysRef.current.has(physicalKey);
            if (!isTracked) return;

            activeKeyboardKeysRef.current.delete(physicalKey);
            stopTriggerIfIdle();
        };

        window.addEventListener('keydown', onKeyDown);
        window.addEventListener('keyup', onKeyUp);

        return () => {
            window.removeEventListener('keydown', onKeyDown);
            window.removeEventListener('keyup', onKeyUp);
        };
    }, [startTrigger, stopTriggerIfIdle, jumpToSection, playRandomNoteFromCurrentStep, playSoloKey, applyVoicing, applyTranspose, applySmooth, voicingBase, currentNoteIndex, chordSequence]);

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

    if (e.pointerType === 'touch') {
        // Multi-touch: all simultaneous fingers play the SAME chord step, each
        // with its own voice group (so releasing one finger stops only its chord).
        // The step counter advances only when the first finger goes down; additional
        // fingers joining an existing hold play the same chord step, not the next one.
        setIsPlaying(true);
        setCursorPos({ x, y });

        const isFirstFinger = activePointerIdsRef.current.size === 1;
        const sequence = chordSequence.length > 0 ? chordSequence : [{ notes: [60], strumMs: 0 }];
        // Use the step that was current when the first finger landed (not the
        // already-advanced index), so all fingers of this gesture share a step.
        const stepIndex = isFirstFinger
            ? currentNoteIndexRef.current
            : (currentNoteIndexRef.current - 1 + sequence.length) % sequence.length;
        const step = sequence[stepIndex % sequence.length];

        const groupId = audioEngine.startContinuousNotesGroup(
            step.notes,
            Math.round(chordVolumeRef.current * 100),
            step.strumMs,
            calculateParams(x, y),  // applied only to this finger's voices
        );
        pointerVoiceGroupRef.current.set(e.pointerId, groupId);

        // Track this finger's position for the visualiser.
        setTouchPoints(prev => [...prev.filter(p => p.id !== e.pointerId), { id: e.pointerId, x, y }]);

        // Only advance the step counter for the first finger.
        if (isFirstFinger) {
            const advancedIndex = (stepIndex + 1) % sequence.length;
            currentNoteIndexRef.current = advancedIndex;
            setCurrentNoteIndex(advancedIndex);
        }
    } else {
        // Mouse / pen: replace-all behaviour (same as before).
        startTrigger(x, y);
    }
  };

  const handlePointerMove = (e: React.PointerEvent) => {
        if (!isPlaying || !padRef.current) return;
        e.preventDefault();

    const rect = padRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height));

    if (e.pointerType === 'touch') {
        if (!activePointerIdsRef.current.has(e.pointerId)) return;
        // Update this finger's dot position.
        setTouchPoints(prev => prev.map(p => p.id === e.pointerId ? { ...p, x, y } : p));
        // Modulate only this finger's voice group — other fingers are unaffected.
        const groupId = pointerVoiceGroupRef.current.get(e.pointerId);
        if (groupId !== undefined) {
            audioEngine.updateVoiceGroup(groupId, calculateParams(x, y));
        }
        return;
    }

    // Mouse / pen
    if (controlPointerIdRef.current !== e.pointerId) return;
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

        // For touch: stop only this finger's voice group; other fingers keep playing.
        if (e.pointerType === 'touch') {
            const groupId = pointerVoiceGroupRef.current.get(e.pointerId);
            if (groupId !== undefined) {
                pointerVoiceGroupRef.current.delete(e.pointerId);
                audioEngine.stopVoiceGroup(groupId);
            }
            setTouchPoints(prev => prev.filter(p => p.id !== e.pointerId));
        }

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

    // Shared band overlay renderers — stepsLo bands below centre, stepsHi above.
    // All N = stepsLo+stepsHi+1 bands are equal width so edges are never clipped.
    const renderDetuneBandsX = (stepsLo: number, stepsHi: number, pattern: number[], flipped = false) => {
        const N = stepsLo + stepsHi + 1;
        const bandPct = 100 / N;
        const labelEvery = Math.max(1, Math.ceil(Math.max(stepsLo, stepsHi) / 5));
        const labelSteps = Array.from(new Set(
            Array.from({ length: N }, (_, i) => i - stepsLo)
                .filter(s => s === 0 || s === -stepsLo || s === stepsHi || Math.abs(s) % labelEvery === 0)
        ));
        return (
            <div className="absolute inset-0 pointer-events-none">
                {Array.from({ length: N }, (_, i) => {
                    const s = i - stepsLo;
                    const bg = s === 0 ? 'rgba(167,139,250,0.22)'
                        : Math.abs(s) % 2 === 0 ? 'rgba(99,102,241,0.13)'
                        : 'rgba(0,0,0,0)';
                    return <div key={s} className="absolute top-0 bottom-0 pointer-events-none"
                        style={{ left: `${i * bandPct}%`, width: `${bandPct}%`, backgroundColor: bg }} />;
                })}
                {labelSteps.map(s => {
                    const st = stepToCents(flipped ? -s : s, pattern) / 100;
                    return <div key={s} className="absolute text-[8px] font-black tabular-nums pointer-events-none select-none"
                        style={{ left: `${(s + stepsLo + 0.5) * bandPct}%`, bottom: 28, transform: 'translateX(-50%)',
                            color: s === 0 ? 'rgba(167,139,250,0.9)' : 'rgba(99,102,241,0.6)' }}>
                        {st > 0 ? `+${st}` : st}
                    </div>;
                })}
            </div>
        );
    };
    const renderDetuneBandsY = (stepsLo: number, stepsHi: number, pattern: number[], flipped = false) => {
        const N = stepsLo + stepsHi + 1;
        const bandPct = 100 / N;
        const labelEvery = Math.max(1, Math.ceil(Math.max(stepsLo, stepsHi) / 5));
        const labelSteps = Array.from(new Set(
            Array.from({ length: N }, (_, i) => i - stepsLo)
                .filter(s => s === 0 || s === -stepsLo || s === stepsHi || Math.abs(s) % labelEvery === 0)
        ));
        return (
            <div className="absolute inset-0 pointer-events-none">
                {Array.from({ length: N }, (_, i) => {
                    const s = i - stepsLo;
                    const bg = s === 0 ? 'rgba(167,139,250,0.22)'
                        : Math.abs(s) % 2 === 0 ? 'rgba(99,102,241,0.13)'
                        : 'rgba(0,0,0,0)';
                    return <div key={s} className="absolute left-0 right-0 pointer-events-none"
                        style={{ bottom: `${i * bandPct}%`, height: `${bandPct}%`, backgroundColor: bg }} />;
                })}
                {labelSteps.map(s => {
                    const st = stepToCents(flipped ? -s : s, pattern) / 100;
                    return <div key={s} className="absolute text-[8px] font-black tabular-nums pointer-events-none select-none"
                        style={{ bottom: `${(s + stepsLo + 0.5) * bandPct}%`, right: 8, transform: 'translateY(50%)',
                            color: s === 0 ? 'rgba(167,139,250,0.9)' : 'rgba(99,102,241,0.6)' }}>
                        {st > 0 ? `+${st}` : st}
                    </div>;
                })}
            </div>
        );
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
                            // Explicitly mark as non-editable so iOS won't show
                            // its undo/clipboard bar or "looks like you're typing" prompt.
                            WebkitUserModify: 'read-only' as any,
                            WebkitTapHighlightColor: 'transparent',
                            // Disable autocorrect-style input inference on iPad
                            MozUserSelect: 'none' as any,
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
            <div
                className="absolute top-3 right-3 z-20 flex flex-col items-end gap-2"
                onPointerDown={(e) => e.stopPropagation()}
                onPointerUp={(e) => e.stopPropagation()}
            >
                <div className="flex items-center gap-2">
                {isTouchDevice && (
                    <button
                        type="button"
                        data-pad-control="true"
                        onPointerDown={(e) => e.stopPropagation()}
                        onPointerUp={(e) => {
                            e.stopPropagation();
                            // Stop and release all ghost touch voice groups
                            pointerVoiceGroupRef.current.forEach((groupId) => {
                                audioEngine.stopVoiceGroup(groupId);
                            });
                            pointerVoiceGroupRef.current.clear();
                            activePointerIdsRef.current.clear();
                            controlPointerIdRef.current = null;
                            setTouchPoints([]);
                            setIsPlaying(false);
                        }}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-black/60 border border-white/10 text-slate-200 hover:text-white hover:border-white/20 text-[10px] font-black uppercase tracking-widest"
                    >
                        Reset
                    </button>
                )}
                <button
                    type="button"
                    data-pad-control="true"
                    onPointerDown={(e) => e.stopPropagation()}
                    onPointerUp={(e) => {
                        e.stopPropagation();
                        toggleFullscreen();
                    }}
                    className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-black/60 border border-white/10 text-slate-200 hover:text-white hover:border-white/20 text-[10px] font-black uppercase tracking-widest"
                >
                    {isFullscreen ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
                    {isFullscreen ? 'Exit' : 'Full'}
                </button>
                </div>
                {detectedKey && (
                    <div className="px-3 py-1.5 rounded-lg bg-black/60 border border-teal-700/40 text-teal-300 text-[10px] font-black uppercase tracking-widest pointer-events-none select-none">
                        ♩ {detectedKey}
                    </div>
                )}
            </div>

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
                    onPointerUp={(e) => e.stopPropagation()}
                >
                    {sections.map((s, i) => (
                        <button
                            key={s.label}
                            type="button"
                            data-pad-control="true"
                            title={`Jump to [${s.label}] — step ${s.startStep + 1}`}
                            onPointerDown={(e) => e.stopPropagation()}
                            onPointerUp={(e) => { e.stopPropagation(); jumpToSection(i); }}
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

            {/* Detune band overlays — shared renderer used by both 'detune' (continuous) and 'detune_semitone' (stepped).
                 Semitone-wide zones alternate fill colour; labels show the actual pitch offset. */}
            {xTargets.includes('detune_semitone') && renderDetuneBandsX(xFlipped ? xDetuneStepsHi : xDetuneStepsLo, xFlipped ? xDetuneStepsLo : xDetuneStepsHi, xDetunePattern, xFlipped)}
            {xTargets.includes('detune') && renderDetuneBandsX(xFlipped ? xDetuneCentsRangeHi : xDetuneCentsRangeLo, xFlipped ? xDetuneCentsRangeLo : xDetuneCentsRangeHi, [1], xFlipped)}
            {yTargets.includes('detune_semitone') && renderDetuneBandsY(yFlipped ? yDetuneStepsHi : yDetuneStepsLo, yFlipped ? yDetuneStepsLo : yDetuneStepsHi, yDetunePattern, yFlipped)}
            {yTargets.includes('detune') && renderDetuneBandsY(yFlipped ? yDetuneCentsRangeHi : yDetuneCentsRangeLo, yFlipped ? yDetuneCentsRangeLo : yDetuneCentsRangeHi, [1], yFlipped)}

            {/* Axis Labels */}
            <div className="absolute bottom-4 right-4 text-xs font-black text-slate-700 pointer-events-none select-none uppercase tracking-widest">
               X: {xTargets.join(', ') || 'None'}
            </div>
            <div className="absolute top-4 left-4 text-xs font-black text-slate-700 pointer-events-none select-none uppercase tracking-widest rotate-90 origin-top-left translate-x-4">
               Y: {yTargets.join(', ') || 'None'}
            </div>
                {!isTouchDevice && (
                <div className="absolute bottom-4 left-4 text-[10px] font-black text-slate-700 pointer-events-none select-none uppercase tracking-widest">
                    {KEY_HINT}
                </div>
                )}

            {/* Active Cursor/Visualizer */}
            {isPlaying && (
                <>
                    {touchPoints.length > 0 ? (
                        // Multi-touch: one visual cluster per finger, coloured distinctly.
                        touchPoints.map((pt, idx) => {
                            const c = TOUCH_COLORS[idx % TOUCH_COLORS.length];
                            return (
                                <React.Fragment key={pt.id}>
                                    {/* Crosshairs only when there's a single touch */}
                                    {touchPoints.length === 1 && (
                                        <>
                                            <div className="absolute w-full h-[1px] pointer-events-none blur-[1px]"
                                                style={{ bottom: `${pt.y * 100}%`, backgroundColor: c.ring }} />
                                            <div className="absolute h-full w-[1px] pointer-events-none blur-[1px]"
                                                style={{ left: `${pt.x * 100}%`, backgroundColor: c.ring }} />
                                        </>
                                    )}
                                    {/* Glow blob */}
                                    <div className="absolute w-36 h-36 rounded-full blur-xl pointer-events-none -translate-x-1/2 translate-y-1/2"
                                        style={{ left: `${pt.x * 100}%`, bottom: `${pt.y * 100}%`, backgroundColor: c.glow }} />
                                    {/* Expanding ripple ring */}
                                    <div className="absolute w-12 h-12 rounded-full border-2 pointer-events-none -translate-x-1/2 translate-y-1/2 animate-ping"
                                        style={{ left: `${pt.x * 100}%`, bottom: `${pt.y * 100}%`, borderColor: c.ring }} />
                                    {/* Centre dot */}
                                    <div className="absolute w-4 h-4 rounded-full pointer-events-none -translate-x-1/2 translate-y-1/2"
                                        style={{ left: `${pt.x * 100}%`, bottom: `${pt.y * 100}%`, backgroundColor: c.dot, boxShadow: `0 0 18px 4px ${c.dot}` }} />
                                </React.Fragment>
                            );
                        })
                    ) : (
                        // Mouse / keyboard: original single crosshair.
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
                    style={{ touchAction: 'pan-y' }}
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
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
                                title={`Reset to beginning (${KB.RESET.display})`}
                            onClick={() => { setCurrentNoteIndex(0); currentNoteIndexRef.current = 0; }}
                            className="text-[10px] bg-white/5 hover:bg-white/10 px-2 py-1 rounded text-slate-400 uppercase font-bold"
                        >
                            Reset
                        </button>
                        {(['lo', '2nd', '3rd', 'hi'] as const).map((label, i) => (
                            <button
                                key={label}
                                title={`Play chord note ${label} — touch/click to hold`}
                                onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); playNoteFromCurrentStepByLinearIndex(i); }}
                                onPointerUp={() => stopTriggerIfIdle()}
                                onPointerLeave={() => stopTriggerIfIdle()}
                                onPointerCancel={() => stopTriggerIfIdle()}
                                className="text-[10px] bg-white/5 hover:bg-violet-500/20 hover:text-violet-300 px-2 py-1 rounded text-slate-400 uppercase font-bold select-none"
                            >
                                ♩ {label}
                            </button>
                        ))}
                        <button
                            title={`${KB.RAND_NOTE.hint} (${KB.RAND_NOTE.display})`}
                            onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); playRandomNoteFromCurrentStep(); }}
                            onPointerUp={() => stopTriggerIfIdle()}
                            onPointerLeave={() => stopTriggerIfIdle()}
                            onPointerCancel={() => stopTriggerIfIdle()}
                            className="text-[10px] bg-white/5 hover:bg-fuchsia-500/20 hover:text-fuchsia-300 px-2 py-1 rounded text-slate-400 uppercase font-bold select-none"
                        >
                            {KB.RAND_NOTE.display} (rand)
                        </button>
                    </div>
                    {/* Solo key layout switcher */}
                    <div className="flex items-center gap-1 flex-wrap">
                        <span className="text-[9px] text-slate-700 font-black uppercase w-16 shrink-0">Solo Layout</span>
                        {(Object.entries(SOLO_LAYOUTS) as [SoloLayoutName, typeof SOLO_LAYOUTS[SoloLayoutName]][]).map(([name, spec]) => (
                            <button
                                key={name}
                                title={spec.description}
                                onClick={() => { setCurrentLayout(name); currentLayoutRef.current = name; }}
                                className={`text-[9px] px-2 py-1 rounded font-bold uppercase border transition-all ${
                                    currentLayout === name
                                        ? 'bg-violet-600 border-violet-500 text-white'
                                        : 'bg-white/5 hover:bg-violet-500/20 hover:text-violet-300 border-white/5 text-slate-500'
                                }`}
                            >
                                {spec.label}
                            </button>
                        ))}
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
                            title={voicingBase ? `Restore original voicing for all steps (${KB.ORIGINAL.display})` : `No voicing changes yet (${KB.ORIGINAL.display})`}
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
                            title={`Compress all steps: pull each note into the octave below the leading tone; duplicate pitch classes are spread one octave apart (${KB.COMPRESS.display})`}
                            onClick={() => applyVoicing(compressVoicing)}
                            className="text-[9px] bg-white/5 hover:bg-teal-500/20 hover:text-teal-300 px-2 py-1 rounded text-slate-400 font-bold transition-all"
                        >
                            Compress
                        </button>
                        <button
                            title={`Smooth (${KB.SMOOTH.display}): revoice every step so voices move as little as possible between chords. Anchored to the current step (its voicing is unchanged). Melody, bass and inner voices are matched by role across chord changes — not by fixed position — so chords with different note counts smooth correctly.`}
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
                                    title={`Drop ${n} (all steps): lower the ${ordinal(n)}-highest note by octaves until it no longer duplicates another note${n === 1 ? ` (${KB.DROP_1.display})` : n === 2 ? ` (${KB.DROP_2.display})` : ''}`}
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
                                    title={`${ordinal(k)} inversion (all steps): rotate the ${k} lowest pitch class${k > 1 ? 'es' : ''} above the top — octave doublings stay in place${k === 1 ? ` (${KB.INVERT_1.display})` : ''}`}
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
                            title={`Reverse note order within each chord (e.g. C4+E4+G4 → G4+E4+C4) (${KB.ORDER_REV.display})`}
                            onClick={() => setSequenceInput(prev => reorderChordNotes(prev, 'reverse'))}
                            className="text-[9px] bg-white/5 hover:bg-amber-500/20 hover:text-amber-300 px-2 py-1 rounded text-slate-400 font-bold transition-all"
                        >
                            Reverse
                        </button>
                        <button
                            title={`Randomise note order within each chord (${KB.ORDER_RAND.display})`}
                            onClick={() => setSequenceInput(prev => reorderChordNotes(prev, 'random'))}
                            className="text-[9px] bg-white/5 hover:bg-amber-500/20 hover:text-amber-300 px-2 py-1 rounded text-slate-400 font-bold transition-all"
                        >
                            Random
                        </button>
                        <button
                            title={`Sort notes by pitch low→high within each chord (${KB.ORDER_SORT.display})`}
                            onClick={() => setSequenceInput(prev => reorderChordNotes(prev, 'sort'))}
                            className="text-[9px] bg-white/5 hover:bg-amber-500/20 hover:text-amber-300 px-2 py-1 rounded text-slate-400 font-bold transition-all"
                        >
                            Sort ↑
                        </button>
                    </div>
                </div>
            </div>

            {/* Axis Mapping */}
            <div className="bg-slate-950/50 rounded-2xl border border-white/5 p-4 flex flex-col gap-4 overflow-y-auto max-h-64">
                {/* X Axis */}
                <div>
                     <div className="flex items-center gap-2 mb-2 text-slate-500 font-black uppercase text-xs">
                        <Maximize2 size={14} className="rotate-90" /> X-Axis Control (Left - Right)
                        <button
                            title={xFlipped ? 'X axis: flipped (right = low). Click to restore.' : 'X axis: normal (right = high). Click to flip.'}
                            onClick={() => setXFlipped(f => !f)}
                            className={`ml-auto text-[9px] px-2 py-0.5 rounded border font-bold uppercase transition-all ${
                                xFlipped ? 'bg-indigo-600 border-indigo-500 text-white' : 'bg-white/5 border-white/10 text-slate-500 hover:text-slate-300'
                            }`}
                        >{xFlipped ? '⇄ Flipped' : '⇄ Flip'}</button>
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
                        <button
                            title={yFlipped ? 'Y axis: flipped (top = low). Click to restore.' : 'Y axis: normal (top = high). Click to flip.'}
                            onClick={() => setYFlipped(f => !f)}
                            className={`ml-auto text-[9px] px-2 py-0.5 rounded border font-bold uppercase transition-all ${
                                yFlipped ? 'bg-emerald-600 border-emerald-500 text-white' : 'bg-white/5 border-white/10 text-slate-500 hover:text-slate-300'
                            }`}
                        >{yFlipped ? '⇅ Flipped' : '⇅ Flip'}</button>
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

                {/* Continuous Detune config — per-axis lo/hi range */}
                {(xTargets.includes('detune') || yTargets.includes('detune')) && (
                    <div className="flex flex-col gap-3">
                        <div className="flex items-center gap-2 text-slate-500 font-black uppercase text-xs">
                            <Music size={14} /> {AVAILABLE_TARGETS.find(t => t.value === 'detune')?.label}
                        </div>
                        {([
                            xTargets.includes('detune') && { label: 'X', lo: xDetuneCentsRangeLo, setLo: setXDetuneCentsRangeLo, hi: xDetuneCentsRangeHi, setHi: setXDetuneCentsRangeHi, pxSize: padSize.width },
                            yTargets.includes('detune') && { label: 'Y', lo: yDetuneCentsRangeLo, setLo: setYDetuneCentsRangeLo, hi: yDetuneCentsRangeHi, setHi: setYDetuneCentsRangeHi, pxSize: padSize.height },
                        ].filter(Boolean) as { label: string; lo: number; setLo: React.Dispatch<React.SetStateAction<number>>; hi: number; setHi: React.Dispatch<React.SetStateAction<number>>; pxSize: number }[]).map(({ label, lo, setLo, hi, setHi, pxSize }) => (
                            <div key={label} className="flex flex-col gap-1.5 border border-white/5 rounded-lg p-2">
                                <span className="text-[9px] text-slate-500 font-black uppercase">{label} Axis</span>
                                <div className="flex items-center gap-1.5 flex-wrap">
                                    <span className="text-[9px] text-slate-600 font-black uppercase shrink-0">− st</span>
                                    <button onClick={() => setLo(r => Math.max(1, r - 1))} className="text-[9px] bg-white/5 hover:bg-white/10 px-2 py-1 rounded text-slate-400 font-bold">−</button>
                                    <input type="number" min={1} max={120} value={lo}
                                        onChange={e => setLo(Math.max(1, Math.min(120, parseInt(e.target.value) || 1)))}
                                        className="bg-black/40 border border-white/10 rounded px-2 py-1 text-[10px] font-mono text-violet-300 focus:outline-none focus:border-violet-500/50 w-12 text-center" />
                                    <button onClick={() => setLo(r => Math.min(120, r + 1))} className="text-[9px] bg-white/5 hover:bg-white/10 px-2 py-1 rounded text-slate-400 font-bold">+</button>
                                    <span className="text-[9px] text-slate-600 font-black uppercase shrink-0 ml-2">+ st</span>
                                    <button onClick={() => setHi(r => Math.max(1, r - 1))} className="text-[9px] bg-white/5 hover:bg-white/10 px-2 py-1 rounded text-slate-400 font-bold">−</button>
                                    <input type="number" min={1} max={120} value={hi}
                                        onChange={e => setHi(Math.max(1, Math.min(120, parseInt(e.target.value) || 1)))}
                                        className="bg-black/40 border border-white/10 rounded px-2 py-1 text-[10px] font-mono text-violet-300 focus:outline-none focus:border-violet-500/50 w-12 text-center" />
                                    <button onClick={() => setHi(r => Math.min(120, r + 1))} className="text-[9px] bg-white/5 hover:bg-white/10 px-2 py-1 rounded text-slate-400 font-bold">+</button>
                                    <span className="text-[9px] text-slate-600 tabular-nums">
                                        {pxSize > 0 ? `~${Math.round(pxSize / (lo + hi + 1))}px/st` : ''}
                                    </span>
                                </div>
                            </div>
                        ))}
                    </div>
                )}

                {/* Pattern Step config — per-axis, visible when detune_semitone is active */}
                {(xTargets.includes('detune_semitone') || yTargets.includes('detune_semitone')) && (
                    <div className="flex flex-col gap-3">
                        <div className="flex items-center gap-2 text-slate-500 font-black uppercase text-xs">
                            <Music size={14} /> {AVAILABLE_TARGETS.find(t => t.value === 'detune_semitone')?.label}
                        </div>
                        {(() => {
                            const renderAxisConfig = (
                                axisLabel: string,
                                pattern: number[],
                                setPattern: (p: number[]) => void,
                                semitoneRangeLo: number,
                                setSemitoneRangeLo: React.Dispatch<React.SetStateAction<number>>,
                                semitoneRangeHi: number,
                                setSemitoneRangeHi: React.Dispatch<React.SetStateAction<number>>,
                                patternInput: string,
                                setPatternInput: (s: string) => void,
                                stepsLo: number,
                                stepsHi: number,
                                pxSize: number,
                            ) => (
                                <div key={axisLabel} className="flex flex-col gap-1.5 border border-white/5 rounded-lg p-2">
                                    <span className="text-[9px] text-slate-500 font-black uppercase">{axisLabel} Axis</span>
                                    {/* Presets — apply semitoneRange symmetrically to both lo and hi */}
                                    <div className="flex flex-wrap gap-1.5">
                                        {DETUNE_PATTERN_PRESETS.map(p => (
                                            <button
                                                key={p.label}
                                                title={`Intervals: [${p.pattern.join(', ')}] st · ±${p.semitoneRange} st range`}
                                                onClick={() => { setPattern(p.pattern); setSemitoneRangeLo(p.semitoneRange); setSemitoneRangeHi(p.semitoneRange); setPatternInput(p.pattern.join(', ')); }}
                                                className={`px-2 py-1 rounded text-[9px] font-bold uppercase border transition-all ${
                                                    JSON.stringify(pattern) === JSON.stringify(p.pattern) && semitoneRangeLo === p.semitoneRange && semitoneRangeHi === p.semitoneRange
                                                        ? 'bg-violet-600 border-violet-500 text-white'
                                                        : 'bg-slate-900 border-white/10 text-slate-500 hover:text-violet-300 hover:border-violet-500/30'
                                                }`}
                                            >{p.label}</button>
                                        ))}
                                    </div>
                                    {/* Manual pattern input */}
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <span className="text-[9px] text-slate-600 font-black uppercase shrink-0">Intervals (st)</span>
                                        <input
                                            type="text" value={patternInput}
                                            onChange={(e) => {
                                                setPatternInput(e.target.value);
                                                const parsed = e.target.value.split(',').map(n => parseInt(n.trim(), 10)).filter(n => n >= 1);
                                                if (parsed.length > 0) setPattern(parsed);
                                            }}
                                            className="bg-black/40 border border-white/10 rounded px-2 py-1 text-[10px] font-mono text-violet-300 focus:outline-none focus:border-violet-500/50 w-44"
                                            placeholder="e.g. 2, 2, 1, 2, 2, 2, 1"
                                            autoCorrect="off" autoCapitalize="off" spellCheck={false}
                                        />
                                    </div>
                                    {/* Lo / hi range + density hint */}
                                    <div className="flex items-center gap-1.5 flex-wrap">
                                        <span className="text-[9px] text-slate-600 font-black uppercase shrink-0">− st</span>
                                        <button onClick={() => setSemitoneRangeLo(r => Math.max(1, r - 1))} className="text-[9px] bg-white/5 hover:bg-white/10 px-2 py-1 rounded text-slate-400 font-bold">−</button>
                                        <input type="number" min={1} max={120} value={semitoneRangeLo}
                                            onChange={e => setSemitoneRangeLo(Math.max(1, Math.min(120, parseInt(e.target.value) || 1)))}
                                            className="bg-black/40 border border-white/10 rounded px-2 py-1 text-[10px] font-mono text-violet-300 focus:outline-none focus:border-violet-500/50 w-12 text-center" />
                                        <button onClick={() => setSemitoneRangeLo(r => Math.min(120, r + 1))} className="text-[9px] bg-white/5 hover:bg-white/10 px-2 py-1 rounded text-slate-400 font-bold">+</button>
                                        <span className="text-[9px] text-slate-600 font-black uppercase shrink-0 ml-2">+ st</span>
                                        <button onClick={() => setSemitoneRangeHi(r => Math.max(1, r - 1))} className="text-[9px] bg-white/5 hover:bg-white/10 px-2 py-1 rounded text-slate-400 font-bold">−</button>
                                        <input type="number" min={1} max={120} value={semitoneRangeHi}
                                            onChange={e => setSemitoneRangeHi(Math.max(1, Math.min(120, parseInt(e.target.value) || 1)))}
                                            className="bg-black/40 border border-white/10 rounded px-2 py-1 text-[10px] font-mono text-violet-300 focus:outline-none focus:border-violet-500/50 w-12 text-center" />
                                        <button onClick={() => setSemitoneRangeHi(r => Math.min(120, r + 1))} className="text-[9px] bg-white/5 hover:bg-white/10 px-2 py-1 rounded text-slate-400 font-bold">+</button>
                                        <span className="text-[9px] text-slate-600 tabular-nums">
                                            {stepsLo + stepsHi + 1} bands{pxSize > 0 ? ` · ~${Math.round(pxSize / (stepsLo + stepsHi + 1))}px/band` : ''}
                                        </span>
                                    </div>
                                </div>
                            );
                            return (
                                <>
                                    {xTargets.includes('detune_semitone') && renderAxisConfig('X', xDetunePattern, setXDetunePattern, xDetuneSemitoneRangeLo, setXDetuneSemitoneRangeLo, xDetuneSemitoneRangeHi, setXDetuneSemitoneRangeHi, xDetunePatternInput, setXDetunePatternInput, xDetuneStepsLo, xDetuneStepsHi, padSize.width)}
                                    {yTargets.includes('detune_semitone') && renderAxisConfig('Y', yDetunePattern, setYDetunePattern, yDetuneSemitoneRangeLo, setYDetuneSemitoneRangeLo, yDetuneSemitoneRangeHi, setYDetuneSemitoneRangeHi, yDetunePatternInput, setYDetunePatternInput, yDetuneStepsLo, yDetuneStepsHi, padSize.height)}
                                </>
                            );
                        })()}
                    </div>
                )}
            </div>
        </div>
    </div>
  );
};

export default PerformancePad;
