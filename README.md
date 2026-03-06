<!-- <div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div> -->

# Run and deploy

This contains everything you need to run your app locally.

If you have music to preload into the app, put it under `samples/`

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Run the app:
   `npm run dev`
3. Enter your Gemini API key in the UI when prompted.

## Deployment commands

`npm install && npm run build`

preview the result
`npm run preview`

## NeuralComposer Sample File Syntax Guide

This document covers the two sample file formats used in NeuralComposer:
- **Pad Samples** (`pad_samples/*.txt`) — human-readable chord notation for performance pads
- **MIDI Samples** (`samples/*.txt`) — parameter-based notation for full MIDI sequences

---

### Pad Sample Format (`pad_samples/`)

Used by the performance pad system. Designed to be compact and readable.

#### Structure

```
[SectionName]
// optional comment
Note1+Note2+Note3@DURATIONms, Note1+Note2@DURATIONms, ...
```

#### Section Headers

Sections group related chord progressions under a named style or mode. Wrap the name in square brackets:

```
[jazz]
[Natural Minor]
[bossa nova]
```

Section names are case-sensitive and may contain spaces.

#### Comments

Single-line comments start with `//`:

```
// jazzy chord
```

#### Chord Notation

Each chord is a group of simultaneous notes joined by `+`, followed by a duration:

```
D4+C5+A4+F4@305ms
```

| Part | Description |
|------|-------------|
| `D4` | Note name (`A`–`G`) + octave number |
| `+` | Separator between notes in a chord |
| `@305ms` | Duration in milliseconds |

##### Note Names

Standard Western pitch notation: `C`, `D`, `E`, `F`, `G`, `A`, `B`
Append `#` for sharp or `b` for flat (e.g. `C#4`, `Gb5`).
Octave range: `0`–`8` (middle C = `C4`).

##### Duration

Written as `@<number>ms`. The `ms` suffix is required:

```
@305ms    // 305 milliseconds
```

> **Note:** The `m` shorthand (e.g. `@305m`) also appears in some files and is treated as equivalent to `ms`.

#### Chord Sequences

Multiple chords on one line are comma-separated and play in order:

```
D4+C5+A4+F4@305ms, B4+F5+G4+D5@305ms, B4+E4+C4+G4@305ms
```

#### Full Example

```
[jazz]
// jazzy chord
D4+C5+A4+F4@305ms, B4+F5+G4+D5@305ms, B4+E4+C4+G4@305ms, A3+C4+E5+G4@305ms

[Natural Minor]
C5+A4+A5+E5@305ms, D6+F5+A5+D5@305ms, B4+D5+G4+G5@305ms

[bossa nova]
G4+C4+B4+E5@305ms, A4+C#6+E5+G5@305ms, D4+F5+C5+A4@305ms
```

---

### MIDI Sample Format (`samples/`)

Used for full compositions with precise timing, velocity, and duration. Parameters are expressed in beats rather than milliseconds, enabling tempo-independent playback.

#### Structure

```
# Comment or section marker
[P:nn, V:nn, T:n.n, D:n.n], [P:nn, V:nn, T:n.n, D:n.n], ...
```

#### Comments

Single-line comments start with `#`. They may appear on their own line or inline after events:

```
# Key: F Major | Tempo: 120 BPM
[P:41, V:70, T:3.0, D:3.0], # bass note
```

#### Event Notation

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

#### Common MIDI Pitch Reference

| Note | Octave 3 | Octave 4 | Octave 5 |
|------|----------|----------|----------|
| C  | 48 | 60 | 72 |
| D  | 50 | 62 | 74 |
| E  | 52 | 64 | 76 |
| F  | 53 | 65 | 77 |
| G  | 55 | 67 | 79 |
| A  | 57 | 69 | 81 |
| B  | 59 | 71 | 83 |

#### Simultaneous Notes (Chords)

To play notes at the same time, give them the same `T` value:

```
[P:41, V:70, T:3.0, D:3.0], [P:57, V:65, T:3.0, D:3.0], [P:64, V:65, T:3.0, D:3.0]
```

#### Swing Notation

Swing is expressed by staggering event times using a 2:3 subdivision ratio (0.66 / 0.33 beats):

```
[P:60, V:90, T:2.0, D:0.66], [P:60, V:90, T:2.66, D:0.33]
```

#### Section Markers

Bars and chord changes are annotated with comments for readability:

```
# --- Bar 1: Fmaj9 ---
[P:41, V:70, T:3.0, D:3.0], ...
```

#### Full Example

```
# Jazzy Happy Birthday - Version 1
# Key: F Major | Tempo: 120 BPM (Swung Waltz)

# --- Bar 0: Pickup ---
[P:60, V:90, T:2.0, D:0.66], [P:60, V:90, T:2.66, D:0.33],

# --- Bar 1: Fmaj9 ---
[P:41, V:70, T:3.0, D:3.0], [P:57, V:65, T:3.0, D:3.0], [P:64, V:65, T:3.0, D:3.0],
[P:62, V:95, T:3.0, D:1.0], [P:60, V:95, T:4.0, D:1.0], [P:65, V:95, T:5.0, D:1.0],
```

---

### Format Comparison

| Feature | Pad Samples | MIDI Samples |
|---------|-------------|--------------|
| Note encoding | Pitch name (`D4`, `C#5`) | MIDI number (`P:62`) |
| Timing unit | Milliseconds (`@305ms`) | Beats (`T:3.0`) |
| Velocity | Not specified | Explicit (`V:90`) |
| Chords | `+` joined notes | Same `T` value |
| Comments | `//` | `#` |
| Sections | `[SectionName]` | `# --- Bar N: Name ---` |
| Use case | Performance pads, loops | Full compositions |

