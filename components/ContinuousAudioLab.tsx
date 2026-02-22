
import { ArrowLeft, Mic, Play, Square, StopCircle, Zap } from 'lucide-react';
import { AMDF } from 'pitchfinder';
import React, { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { audioEngine } from '../services/audioEngine';
import { MidiEvent } from '../types';

const ContinuousAudioLab: React.FC = () => {
    const navigate = useNavigate();
    const [isRecording, setIsRecording] = useState(false);
    const [isPlaying, setIsPlaying] = useState(false);
    const [status, setStatus] = useState<string>('Ready');
    const [capturedEvents, setCapturedEvents] = useState<MidiEvent[]>([]);

    // Refs
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const audioChunksRef = useRef<Blob[]>([]);
    const audioContextRef = useRef<AudioContext | null>(null);

    // Constants
    const BPM = 120;
    const SAMPLE_RATE = 44100;
    const TEMPO_SEC_PER_BEAT = 60 / BPM;

    const detectPitch = AMDF({
        sampleRate: SAMPLE_RATE,
        minFrequency: 82,
        maxFrequency: 1000,
        sensitivity: 0.1,
        ratio: 5
    });

    const frequencyToMidi = (freq: number): number => {
        if (!freq || freq <= 0) return 0;
        // Float precision for continuous pitch
        return 69 + 12 * Math.log2(freq / 440);
    };

    const processAudio = async (blob: Blob) => {
        setStatus('Processing...');

        if (!audioContextRef.current) {
            audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
        }

        const arrayBuffer = await blob.arrayBuffer();
        const audioBuffer = await audioContextRef.current.decodeAudioData(arrayBuffer);
        const rawData = audioBuffer.getChannelData(0);

        // Sampling Window
        // 1024 samples @ 44.1k = ~23ms resolution
        const bufferSize = 1024;

        const newEvents: MidiEvent[] = [];

        // Simple smoothing filter
        let lastPitch = 0;
        const PITCH_SMOOTHING = 0.5;

        for (let i = 0; i < rawData.length; i += bufferSize) {
            const chunk = rawData.slice(i, i + bufferSize);
            const rms = Math.sqrt(chunk.reduce((sum, val) => sum + val * val, 0) / chunk.length);

            if (rms > 0.02) {
                 const freq = detectPitch(chunk);
                 if (freq) {
                     let midiPitch = frequencyToMidi(freq);

                     // Basic Low Pass Filter for Pitch
                     if (lastPitch > 0) {
                        midiPitch = lastPitch * PITCH_SMOOTHING + midiPitch * (1 - PITCH_SMOOTHING);
                     }
                     lastPitch = midiPitch;

                     const timeInSeconds = i / SAMPLE_RATE;
                     const durationInSeconds = bufferSize / SAMPLE_RATE;

                     newEvents.push({
                         p: parseFloat(midiPitch.toFixed(2)),
                         v: Math.min(127, Math.floor(rms * 1000)), // Approximate volume
                         t: parseFloat((timeInSeconds / TEMPO_SEC_PER_BEAT).toFixed(3)),
                         d: parseFloat((durationInSeconds / TEMPO_SEC_PER_BEAT).toFixed(3))
                     });
                 } else {
                    lastPitch = 0; // Reset smoothing on silence/unvoiced
                 }
            } else {
                lastPitch = 0;
            }
        }

        setCapturedEvents(newEvents);
        setStatus(`Extracted ${newEvents.length} continuous samples`);
    };

    const startRecording = async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            mediaRecorderRef.current = new MediaRecorder(stream);
            audioChunksRef.current = [];

            mediaRecorderRef.current.ondataavailable = (event) => {
                if (event.data.size > 0) audioChunksRef.current.push(event.data);
            };

            mediaRecorderRef.current.onstop = () => {
                const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/wav' });
                processAudio(audioBlob);
            };

            mediaRecorderRef.current.start();
            setIsRecording(true);
            setStatus('Recording...');
        } catch (err) {
            console.error(err);
            setStatus('Error: Mic blocked');
        }
    };

    const stopRecording = () => {
        if (mediaRecorderRef.current && isRecording) {
            mediaRecorderRef.current.stop();
            setIsRecording(false);
            mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
        }
    };

    const handlePlay = async () => {
        if (capturedEvents.length === 0) return;

        setIsPlaying(true);
        audioEngine.init();
        audioEngine.setTempo(BPM);

        const startTime = audioEngine.currentTime + 0.1;

        capturedEvents.forEach(event => {
            // Note: scheduleNote expects absolute beat. We can simulate playback starting at beat 0
            audioEngine.scheduleNote(event, event.t, 0, true);
        });

        // Auto stop after duration
        const endBeat = capturedEvents[capturedEvents.length-1].t + capturedEvents[capturedEvents.length-1].d;
        setTimeout(() => setIsPlaying(false), (endBeat * TEMPO_SEC_PER_BEAT * 1000) + 100);
    };

    const handleCopy = async () => {
        if (capturedEvents.length === 0) return;

        // Format as NeuralComposer string format: [P:60,V:90,T:8.0,D:0.66]
        const formatted = capturedEvents.map(e =>
            `[P:${e.p}, V:${e.v}, T:${e.t}, D:${e.d}]`
        ).join(', ');

        await navigator.clipboard.writeText(formatted);
        setStatus('Copied to clipboard!');
        setTimeout(() => setStatus('Ready'), 2000);
    };

    return (
        <div className="min-h-screen bg-gray-950 text-white p-8 font-mono">
            <button
                onClick={() => navigate('/')}
                className="flex items-center gap-2 mb-8 text-indigo-400 hover:text-indigo-300 transition-colors"
            >
                <ArrowLeft size={20} />
                Back to Composer
            </button>

            <div className="max-w-4xl mx-auto space-y-8">
                <div className="space-y-2 border-l-4 border-indigo-500 pl-4">
                    <h1 className="text-3xl font-bold text-white flex items-center gap-3">
                        <Zap className="text-yellow-400" fill="currentColor" />
                        Continuous Audio Lab
                    </h1>
                    <p className="text-gray-400">
                        Experimental continuous pitch tracking & legato synthesis.
                        <span className="ml-2 px-2 py-0.5 bg-indigo-900/50 rounded text-xs text-indigo-300 border border-indigo-700">
                            Float Precision
                        </span>
                    </p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {/* Controls */}
                    <div className="bg-gray-900 p-8 rounded-xl border border-gray-800 shadow-xl">
                        <div className="flex flex-col items-center gap-6">
                            <div className="relative group">
                                <div className={`absolute -inset-1 bg-gradient-to-r from-indigo-500 to-purple-600 rounded-full blur opacity-25 group-hover:opacity-75 transition duration-1000 group-hover:duration-200 ${isRecording ? 'opacity-100 animate-pulse' : ''}`}></div>
                                <button
                                    onClick={isRecording ? stopRecording : startRecording}
                                    className={`relative w-24 h-24 rounded-full flex items-center justify-center transition-all transform hover:scale-105 active:scale-95 ${
                                        isRecording
                                        ? 'bg-gray-900 border-4 border-red-500 text-red-500'
                                        : 'bg-indigo-600 text-white shadow-lg'
                                    }`}
                                >
                                    {isRecording ? <Square size={32} fill="currentColor" /> : <Mic size={40} />}
                                </button>
                            </div>

                            <div className="text-center space-y-1">
                                <div className={`text-sm font-bold tracking-widest uppercase ${status.startsWith('Error') ? 'text-red-500' : 'text-gray-500'}`}>
                                    {status}
                                </div>
                                {capturedEvents.length > 0 && (
                                    <div className="text-xs text-emerald-500 font-mono">
                                        {capturedEvents.length} samples captured
                                    </div>
                                )}
                            </div>
                        </div>

                        {capturedEvents.length > 0 && (
                            <div className="mt-8 pt-8 border-t border-gray-800 flex flex-col gap-4 items-center">
                                <button
                                    onClick={handlePlay}
                                    disabled={isPlaying}
                                    className="w-full flex items-center justify-center gap-2 px-6 py-3 bg-gray-800 hover:bg-gray-700 rounded-lg font-bold transition-colors disabled:opacity-50"
                                >
                                    {isPlaying ? <StopCircle size={20} className="animate-pulse text-indigo-400" /> : <Play size={20} className="text-emerald-400" />}
                                    {isPlaying ? 'Playing Legato...' : 'Test Playback'}
                                </button>
                                <button
                                    onClick={handleCopy}
                                    className="text-xs text-gray-500 hover:text-white transition-colors flex items-center gap-2"
                                >
                                    <Square size={12} className="rotate-45" /> Copy Data for Main UI
                                </button>
                            </div>
                        )}
                    </div>

                    {/* Visualization (Micro-PianoRoll) */}
                    <div className="bg-gray-900 p-6 rounded-xl border border-gray-800 h-[400px] relative overflow-hidden">
                        <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-4">Pitch Trajectory</h3>

                        {capturedEvents.length === 0 ? (
                            <div className="absolute inset-0 flex items-center justify-center text-gray-700 text-sm">
                                Recording visualization will appear here
                            </div>
                        ) : (
                            <ContinuousViz events={capturedEvents} />
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};

// Simple canvas component to visualize the curves
const ContinuousViz: React.FC<{ events: MidiEvent[] }> = ({ events }) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    React.useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const w = canvas.width;
        const h = canvas.height;
        ctx.clearRect(0,0,w,h);

        // Find bounds
        let minP = 127, maxP = 0;
        events.forEach(e => {
            if (e.p < minP) minP = e.p;
            if (e.p > maxP) maxP = e.p;
        });

        // Add padding
        minP -= 2; maxP += 2;
        const range = maxP - minP || 12; // Avoid div by zero

        const totalDuration = events[events.length-1].t + events[events.length-1].d;

        ctx.beginPath();
        ctx.strokeStyle = '#6366f1';
        ctx.lineWidth = 2;

        events.forEach((e, i) => {
            const x = (e.t / totalDuration) * w;
            const y = h - ((e.p - minP) / range) * h;

            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);

            // Draw point
            ctx.fillStyle = `rgba(99, 102, 241, ${e.v / 127})`;
            ctx.fillRect(x-1, y-1, 2, 2);
        });

        ctx.stroke();

        // Draw grid lines
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 0.5;
        for(let p = Math.ceil(minP); p <= maxP; p++) {
           const y = h - ((p - minP) / range) * h;
           ctx.beginPath();
           ctx.moveTo(0, y);
           ctx.lineTo(w, y);
           ctx.stroke();
        }

    }, [events]);

    return <canvas ref={canvasRef} width={600} height={320} className="w-full h-full bg-black/50 rounded" />;
}

export default ContinuousAudioLab;
