
import { GoogleGenAI, GenerateContentResponse } from "@google/genai";
import { MidiEvent, MusicGenre } from "../types";

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

// Structure matching the App's event state
interface CompositionEvent {
  event: MidiEvent;
  beatOffset: number;
}

export class GeminiComposer {
  
  async *streamComposition(
    genre: MusicGenre, 
    tempo: number, 
    existingEvents: CompositionEvent[], 
    nextStartBeat: number
  ): AsyncGenerator<string> {
    
    // 1. Serialize History
    // We convert the disjointed chunks into a linear, absolute-time timeline for the model.
    // We sort by time to ensure the model reads the music chronologically.
    const historyString = existingEvents
      .map(e => ({
        p: e.event.p,
        v: e.event.v,
        t: Number((e.beatOffset + e.event.t).toFixed(3)), // Absolute Beat Time
        d: Number(e.event.d.toFixed(3))
      }))
      .sort((a, b) => a.t - b.t)
      .map(e => `[P:${e.p},V:${e.v},T:${e.t},D:${e.d}]`)
      .join(' ');

    // 2. Construct the Prompt
    // We provide the history and ask for the next chunk relative to 'nextStartBeat'.
    const systemInstruction = `You are a real-time MIDI streaming engine.
    
    CONTEXT:
    The user is composing a ${genre} track at ${tempo} BPM.
    
    HISTORY:
    Here is the complete musical history so far (T is absolute beat time):
    ${historyString}
    
    TASK:
    Generate the next 8 beats of music starting strictly from Absolute Beat ${nextStartBeat}.
    Be creative and don't always repeat previous generated motifs, explore new ideas in your creation.
    For example, go for multiple lines when appropriate, transpose a theme, invert some notes, change octaves...
    
    OUTPUT FORMAT:
    [P:pitch,V:velocity,T:relativeStart,D:duration]
    
    CRITICAL RULES:
    1. Pitch (P): 0-127.
    2. Velocity (V): 0-127.
    3. Start Beat (T): MUST be relative to the requested start beat (${nextStartBeat}). 
       Example: If a note starts at absolute beat ${nextStartBeat}, output T:0. 
       If it starts at ${nextStartBeat + 1}, output T:1.
    4. Duration (D): In beats.
    5. NO TEXT. NO MARKDOWN. ONLY EVENTS.
    6. Continue the musical idea from the HISTORY. If the user manually changed the history (e.g., changed a chord), you MUST follow that new harmony.`;

    const prompt = `Generate 8 beats starting from beat ${nextStartBeat}.`;

    try {
      // We use generateContentStream (stateless) instead of chat (stateful)
      // because we are manually injecting the true state of the application every time.
      const responseStream = await ai.models.generateContentStream({
        model: 'gemini-flash-lite-latest',
        config: {
          systemInstruction: systemInstruction,
          temperature: 0.9, // High creativity
        },
        contents: [{ role: 'user', parts: [{ text: prompt }] }]
      });

      for await (const chunk of responseStream) {
        const text = (chunk as GenerateContentResponse).text;
        if (text) yield text;
      }
    } catch (error) {
      console.error("Gemini Stream Error:", error);
    }
  }
}

export const composer = new GeminiComposer();
