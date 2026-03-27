<!-- <div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div> -->

# NeuralComposer

A playground for experimenting with musical ideas. The central goal of the **Perform tab** is to make a digital instrument intuitive enough that anyone — not just trained musicians — can enjoy *playing* music, not just listening to it. Much of the work here is exploring keyboard and touch configurations toward that end.

## Features

- **Voice to notes** — hum or sing into the mic; the app transcribes to MIDI (voice icon at the top)
- **Sequence tab** — compose music manually or with Gemini AI assistance; preload compositions under `samples/`
- **Perform tab** — enhanced live performance via customizable pad layout; preload chord sequences under `pad_samples/`
- **Percussion synthesis** — percussive presets use dedicated noise and frequency-sweep synthesis (not just a generic oscillator) for realistic kicks, snares, hi-hats, and more

## Run Locally

**Prerequisites:** Node.js

1. Install dependencies: `npm install`
2. Run the app: `npm run dev`
3. Enter your Gemini API key in the UI (Optional).

## Deploy

```
npm install && npm run build
```

Preview the result: `npm run preview`

---

# Performance Pad

The perform tab lets you trigger chord progressions and solo over them in real time. The sections below are notes on the instrument design — a brain dump of learnings from messing around with different keyboard and touch configurations.

## Observations

- **Pitch space as a 2D plane unifies all instrument layouts.** The x-axis encodes chromatic progression; the y-axis encodes the interval between "strings" (e.g., perfect 5th for violin, mixed intervals for guitar). Once you see any instrument as a 2D grid, fingering patterns across instruments become immediately comparable.

- **Isomorphism (translational equivariance) is not unique to Wicki-Hayden.** Violin's layout is equally isomorphic — any hand shape that produces a given interval pattern works identically across all positions. The effect is less obvious simply because violin only has 4 strings (4 y-values). A wider string instrument would make this symmetry as apparent as on a Wicki-Hayden keyboard.

- **String instruments are a horizontal mirror of keyboard instruments.** On violin and guitar the highest pitch falls under the pinky; on piano the highest pitch falls under the thumb. For string players learning keyboard (or vice versa), this x-axis flip creates an unintuitive mental block that is purely a layout convention, not a musical necessity.

- **String instruments have a structural ceiling on harmony.** Physical constraints (bow mechanics, string spacing) make 3-note voicings difficult and 4-note voicings essentially impossible on violin. Keyboard instruments place no such limit — any number of simultaneous pitches across the full range is trivially available, which fundamentally shapes how harmony is taught and practiced on each instrument.

## Tips for Playing

### Soloing

The pad auto-determines the key (minor or major) for the next chord. You can freely choose from the 1st, 3rd, 5th, 6th, 8th, or 10th degree from the major root (1, 3, 5 form the major triad; 6, 8, 10 form the minor triad from the relative major perspective).

On a Wicki-Hayden keyboard, these degrees map naturally onto the major and minor triad shapes.

### Playing on computer

- **Cascading effect** — solo with the left hand and layer octave changes or invert1/drop1 voicings to create a cascading sound.
- **Smooth chord transitions** — hold `D` while hitting `F` to carry the previous chord into the next, smoothing the transition.

### Playing on iPad

iPad adds one extra capability: triggering the same chord progression with multiple fingers simultaneously.

- **Translational equivariant keyboard** — setting both x and y axes to vary by semitone simulates an isomorphic (translational equivariant) keyboard layout.
- **Continuous sound change** — unlike on a computer, sliding a finger on iPad produces a continuous pitch-bending effect.

---

# Sample File Syntax Guide

This document covers the two sample file formats used in NeuralComposer:
- **Pad Samples** (`pad_samples/*.txt`) — human-readable chord notation for performance pads
- **MIDI Samples** (`samples/*.txt`) — parameter-based notation for full MIDI sequences

---

## Pad Sample Format (`pad_samples/`)

Used by the performance pad system. Designed to be compact and readable.

### Structure

```
[SectionName]
// optional comment
Note1+Note2+Note3@DURATION_BEATS_b, Note1+Note2@DURATION_BEATS_b, ...
```

### Section Headers

Sections group related chord progressions under a named style or mode. Wrap the name in square brackets:

```
[jazz]
[Natural Minor]
[bossa nova]
```

Section names are case-sensitive and may contain spaces.

### Comments

Single-line comments start with `//`:

```
// jazzy chord
```

### Chord Notation

Each chord is a group of simultaneous notes joined by `+`, followed by an optional strum annotation:

```
D4+C5+A4+F4@0.5b
```

| Part | Description |
|------|-------------|
| `D4` | Note name (`A`–`G`) + octave number |
| `+` | Separator between notes in a chord |
| `@0.5b` | Strum delay in **beats** (0.5 = half a beat between each note) |

Omitting the `@` annotation plays all notes of the chord simultaneously.

#### Note Names

Standard Western pitch notation: `C`, `D`, `E`, `F`, `G`, `A`, `B`
Append `#` for sharp or `b` for flat (e.g. `C#4`, `Gb5`).
Octave range: `0`–`8` (middle C = `C4`).

#### Strum Annotation

Written as `@<number>b`. The `b` suffix stands for **beats**:

```
@0.5b     // half a beat between each note
@0.25b    // quarter beat (16th note at 4/4)
@0b       // all notes fire simultaneously
```

The delay is **tempo-relative** — it scales automatically with the BPM setting so a `@0.25b` strum always sounds the same musically regardless of tempo.

Common values and their musical meaning:

| Value | At 120 BPM | Feel |
|-------|------------|------|
| `@0b` | 0 ms | Block chord (simultaneous) |
| `@0.1b` | 50 ms | Tight strum |
| `@0.25b` | 125 ms | Quarter-beat spread |
| `@0.5b` | 250 ms | Half-beat spread (jazzy) |
| `@0.75b` | 375 ms | Three-quarter-beat spread (lazy reggae) |

### Chord Sequences

Multiple chords on one line are comma-separated and play in order:

```
D4+C5+A4+F4@0.5b, B4+F5+G4+D5@0.5b, B4+E4+C4+G4@0.5b
```

### Full Example

```
[jazz]
// jazzy chord
D4+C5+A4+F4@0.5b, B4+F5+G4+D5@0.5b, B4+E4+C4+G4@0.5b, A3+C4+E5+G4@0.5b

[Natural Minor]
C5+A4+A5+E5@0.5b, D6+F5+A5+D5@0.5b, B4+D5+G4+G5@0.5b

[bossa nova]
G4+C4+B4+E5@0.5b, A4+C#6+E5+G5@0.5b, D4+F5+C5+A4@0.5b, G4+B4+D5+F5@0.5b
```

---

## Synth Config Reference

Each track carries a `SynthConfig` that controls how its notes are synthesised. All fields except the optional percussion extensions are required.

| Field | Type | Description |
|---|---|---|
| `waveType` | `sine \| square \| sawtooth \| triangle` | Base oscillator shape |
| `detune` | cents | Fine-tune offset from the note pitch |
| `cutoff` | Hz | Lowpass filter cutoff frequency |
| `resonance` | Q factor | Filter resonance/peak |
| `attack` | s | Amplitude envelope attack time |
| `decay` | s | Amplitude envelope decay time |
| `sustain` | 0–1 | Sustain level as a fraction of peak volume |
| `release` | s | Release time after note-off |
| `drive` | multiplier | Output gain before the master bus |

### Percussion extensions (optional)

These fields unlock synthesis techniques that a plain oscillator cannot replicate. Omit them (or set to `0`) on melodic presets — the engine treats them as disabled.

| Field | Type | Description |
|---|---|---|
| `noiseMix` | 0–1 | Blend of white noise vs oscillator. `0` = pure osc, `1` = pure noise |
| `noiseHpCutoff` | Hz | Highpass filter applied to the noise layer (e.g. `7000` for hi-hat, `1000` for snare) |
| `freqSweepStart` | Hz | Oscillator starts here and sweeps downward over `freqSweepTime`. `0` = use note pitch |
| `freqSweepTime` | s | Duration of the exponential pitch drop (e.g. `0.5` for a kick thud) |

**How the engine uses them:**
- **Kick-style** — `freqSweepStart: 150, freqSweepTime: 0.5` → pitch drops from 150 Hz to silence; `noiseMix: 0` keeps it clean.
- **Snare-style** — `noiseMix: 0.7, noiseHpCutoff: 1000` → 70% highpassed noise gives the crack; the remaining 30% oscillator adds body.
- **Hi-hat-style** — `noiseMix: 1, noiseHpCutoff: 7000` → pure high-frequency noise, very short decay.
- **Tonal percussion** (Marimba, Steel Drum) — no percussion extensions; the standard oscillator + ADSR path is sufficient.

---

## MIDI Sample Format (`samples/`)

Used for full compositions with precise timing, velocity, and duration. Parameters are expressed in beats rather than milliseconds, enabling tempo-independent playback.

### Structure

```
# Comment or section marker
[P:nn, V:nn, T:n.n, D:n.n], [P:nn, V:nn, T:n.n, D:n.n], ...
```

### Comments

Single-line comments start with `#`. They may appear on their own line or inline after events:

```
# Key: F Major | Tempo: 120 BPM
[P:41, V:70, T:3.0, D:3.0], # bass note
```

### Event Notation

Each note event is enclosed in square brackets as a comma-separated list of four parameters:

```
[P:60, V:90, T:2.0, D:0.66]
```

| Parameter | Name | Type | Range | Description |
|-----------|------|------|-------|-------------|
| `P` | Pitch | Integer | 0–127 | MIDI note number (middle C = 60) |
| `V` | Velocity | Integer | 0–127 | Note volume / intensity |
| `T` | Time | Float | ≥ 0.0 | Start time in beats from the beginning |
| `D` | Duration | Float | > 0.0 | Note duration in beats |

### Common MIDI Pitch Reference

| Note | Octave 3 | Octave 4 | Octave 5 |
|------|----------|----------|----------|
| C  | 48 | 60 | 72 |
| D  | 50 | 62 | 74 |
| E  | 52 | 64 | 76 |
| F  | 53 | 65 | 77 |
| G  | 55 | 67 | 79 |
| A  | 57 | 69 | 81 |
| B  | 59 | 71 | 83 |

### Simultaneous Notes (Chords)

To play notes at the same time, give them the same `T` value:

```
[P:41, V:70, T:3.0, D:3.0], [P:57, V:65, T:3.0, D:3.0], [P:64, V:65, T:3.0, D:3.0]
```

### Swing Notation

Swing is expressed by staggering event times using a 2:3 subdivision ratio (0.66 / 0.33 beats):

```
[P:60, V:90, T:2.0, D:0.66], [P:60, V:90, T:2.66, D:0.33]
```

### Section Markers

Bars and chord changes are annotated with comments for readability:

```
# --- Bar 1: Fmaj9 ---
[P:41, V:70, T:3.0, D:3.0], ...
```

### Full Example

```
# Jazzy Happy Birthday - Version 1
# Key: F Major | Tempo: 120 BPM (Swung Waltz)

# --- Bar 0: Pickup ---
[P:60, V:90, T:2.0, D:0.66], [P:60, V:90, T:2.66, D:0.33],

# --- Bar 1: Fmaj9 ---
[P:41, V:70, T:3.0, D:3.0], [P:57, V:65, T:3.0, D:3.0], [P:64, V:65, T:3.0, D:3.0],
[P:62, V:95, T:3.0, D:1.0], [P:60, V:95, T:4.0, D:1.0], [P:65, V:95, T:5.0, D:1.0],
```

### Multi-Voice / Multi-Track Format

A single `.txt` file can contain **multiple voices** (tracks), each separated by a `[voice:N ...]` header block. When loaded, the app creates one track per voice and routes each block's note events to it.

#### Voice Header Syntax

```
[voice:N name:"Display Name" preset:"Preset Name"]
```

| Field | Required | Description |
|-------|----------|-------------|
| `voice:N` | Yes | Voice index (1-based integer). Determines track order. |
| `name:"..."` | No | Human-readable label shown in the track sidebar. |
| `preset:"..."` | No | Synth preset to apply (see list below). Defaults to Grand Piano. |

#### Synth Parameter Overrides

Any `SynthConfig` field can be appended to the header to override individual preset values:

```
[voice:2 name:"Acid Lead" preset:"Crystal Lead" cutoff:1200 resonance:15 drive:1.8]
```

Available override parameters:

| Parameter | Type | Description |
|-----------|------|-------------|
| `waveType` | `sine` \| `square` \| `sawtooth` \| `triangle` | Oscillator waveform |
| `detune` | Float (cents) | Oscillator detune in cents |
| `cutoff` | Float (Hz) | Filter cutoff frequency |
| `resonance` | Float | Filter resonance / Q |
| `attack` | Float (s) | Envelope attack time in seconds |
| `decay` | Float (s) | Envelope decay time in seconds |
| `sustain` | Float (0–1) | Envelope sustain level |
| `release` | Float (s) | Envelope release time in seconds |
| `drive` | Float | Pre-filter overdrive multiplier |

#### Built-in Presets

| Preset Name | Character |
|-------------|-----------|
| `"Grand Piano"` | Bright triangle — clean piano articulation |
| `"Crystal Lead"` | Square wave — sharp synth lead |
| `"Deep Bass"` | Sawtooth — punchy low-end bass |
| `"Ghostly Pad"` | Sine — slow-attack atmospheric pad |
| `"Neon Pluck"` | Sawtooth — resonant staccato pluck |
| `"Warm Rhodes"` | Triangle — mellow electric piano |
| `"Soft Strings"` | Sawtooth — slow strings ensemble |
| `"Acid Bass"` | Sawtooth — high-resonance acid bass |
| `"Kick Drum"` | Triangle — deep thud with punchy drive |
| `"Snare Hit"` | Square wave — bright crack with mid-high bite |
| `"Rim Shot"` | Square wave — tight click, very short decay |
| `"Marimba"` | Triangle — wooden mallet, fast decay |
| `"Steel Drum"` | Triangle — bright metallic ping with high resonance |
| `"Tabla"` | Sawtooth — warm finger drum with resonant bloom |

> **Tip:** Open the **Synth** panel for any track and click **Copy Voice Header** to get a pre-filled `[voice:N ...]` header with the current settings, ready to paste into a file.

#### Note Events Within a Voice Block

All standard MIDI note events after a `[voice:N ...]` header belong to that voice, until the next voice header or end of file.

```
[voice:1 name:"Lead" preset:"Crystal Lead"]
# Am7 (T:0–4)
[P:64,V:70,T:0.000,D:0.500] [P:69,V:82,T:1.500,D:0.500]

[voice:2 name:"Piano" preset:"Warm Rhodes"]
# Rootless voicing
[P:52,V:65,T:0.000,D:2.000] [P:57,V:62,T:0.000,D:2.000]

[voice:3 name:"Bass" preset:"Deep Bass"]
# Walking quarter notes
[P:45,V:80,T:0.000,D:1.000] [P:47,V:78,T:1.000,D:1.000]
```

#### Full Multi-Voice Example

```
# Jazz Trio — Fly Me to the Moon
# Voice 1: melody lead, Voice 2: piano comp, Voice 3: walking bass

[voice:1 name:"Lead" preset:"Crystal Lead"]
[P:69,V:80,T:0.000,D:1.000] [P:67,V:78,T:1.000,D:1.000] [P:65,V:76,T:2.000,D:2.000]

[voice:2 name:"Piano" preset:"Warm Rhodes"]
[P:52,V:65,T:0.000,D:2.000] [P:55,V:62,T:0.000,D:2.000] [P:60,V:60,T:0.000,D:2.000]

[voice:3 name:"Bass" preset:"Deep Bass"]
[P:45,V:85,T:0.000,D:1.000] [P:47,V:80,T:1.000,D:1.000] [P:48,V:78,T:2.000,D:1.000] [P:50,V:80,T:3.000,D:1.000]
```

---

## Format Comparison

| Feature | Pad Samples | MIDI Samples |
|---------|-------------|--------------|
| Note encoding | Pitch name (`D4`, `C#5`) | MIDI number (`P:62`) |
| Timing unit | Beats (`@0.5b`) | Beats (`T:3.0`) |
| Velocity | Not specified | Explicit (`V:90`) |
| Chords | `+` joined notes | Same `T` value |
| Comments | `//` | `#` |
| Sections | `[SectionName]` | `# --- Bar N: Name ---` |
| Use case | Performance pads, loops | Full compositions |



