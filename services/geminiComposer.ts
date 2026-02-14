
import { GoogleGenAI, Chat, GenerateContentResponse } from "@google/genai";
import { MidiEvent, MusicGenre } from "../types";

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

export class GeminiComposer {
  private chat: Chat | null = null;
  private currentGenre: string = "";

  private initChat(genre: MusicGenre, tempo: number) {
    this.chat = ai.chats.create({
      model: 'gemini-3-flash-preview',
      config: {
        systemInstruction: `You are a real-time MIDI streaming engine. 
        Your output must be a continuous stream of MIDI events in this EXACT format:
        [P:pitch,V:velocity,T:startBeat,D:duration]
        
        Rules:
        1. Pitch (P): 0-127.
        2. Velocity (V): 0-127.
        3. Start Beat (T): Relative to the start of THIS specific request. You should cover 8 beats per request.
        4. Duration (D): In beats (e.g., 0.25, 0.5, 1.0).
        5. STYLE: ${genre}. Tempo: ${tempo} BPM.
        6. NO TEXT, NO MARKDOWN, NO EXPLANATIONS. Only the bracketed events.
        7. Maintain musical continuity with previous requests.`,
      },
    });
    this.currentGenre = genre;
  }

  async *streamComposition(genre: MusicGenre, tempo: number): AsyncGenerator<string> {
    if (!this.chat || this.currentGenre !== genre) {
      this.initChat(genre, tempo);
    }

    const prompt = `Generate the next 8 beats of music. Start from beat 0 relative to this prompt. Be creative.`;

    try {
      const result = await this.chat!.sendMessageStream({ message: prompt });
      for await (const chunk of result) {
        const text = (chunk as GenerateContentResponse).text;
        if (text) yield text;
      }
    } catch (error) {
      console.error("Gemini Stream Error:", error);
      // Reset chat on major error to recover
      this.chat = null;
    }
  }
}

export const composer = new GeminiComposer();
