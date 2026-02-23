import { ArrowLeft, Download, Mic, Square, Upload } from 'lucide-react';
import { AMDF } from 'pitchfinder';
import React, { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MidiEvent } from '../types';

const VoiceToMidiConverter: React.FC = () => {
    const navigate = useNavigate();
    const [isRecording, setIsRecording] = useState(false);
    const [audioUrl, setAudioUrl] = useState<string | null>(null);
    const [midiOutput, setMidiOutput] = useState<string>('');
    const [status, setStatus] = useState<string>('Ready');
    const [copied, setCopied] = useState(false);
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const audioChunksRef = useRef<Blob[]>([]);
    const audioContextRef = useRef<AudioContext | null>(null);

    // Constants
    const BPM = 120; // Fixed BPM as requested
    const SAMPLE_RATE = 44100;
    const TEMPO_SEC_PER_BEAT = 60 / BPM;

    // Pitch detection setup
    // AMDF is good for speech/monophonic instruments
    const detectPitch = AMDF({
        sampleRate: SAMPLE_RATE,
        minFrequency: 82, // E2
        maxFrequency: 1000, // ~B5
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

        const rawData = audioBuffer.getChannelData(0); // Mono channel
        // Sampling Window
        // 1024 samples @ 44.1k = ~23ms resolution
        const bufferSize = 1024;

        const events: MidiEvent[] = [];
        
        // Simple smoothing filter
        let lastPitch = 0;
        const PITCH_SMOOTHING = 0.5;

        // Threshold for silence/noise
        // We iterate through the buffer in chunks
        for (let i = 0; i < rawData.length; i += bufferSize) {
            const chunk = rawData.slice(i, i + bufferSize);
            // Basic silence detection by amplitude
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

                     events.push({
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

        formatOutput(events);
        setStatus('Ready');
    };

    const formatOutput = (events: MidiEvent[]) => {
        // Format: [P:60,V:100,T:0,D:1]
        const formatted = events.map(e => `[P:${e.p},V:${e.v},T:${e.t},D:${e.d}]`).join(', ');
        setMidiOutput(formatted);
    };

    const startRecording = async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            mediaRecorderRef.current = new MediaRecorder(stream);
            audioChunksRef.current = [];

            mediaRecorderRef.current.ondataavailable = (event) => {
                if (event.data.size > 0) {
                    audioChunksRef.current.push(event.data);
                }
            };

            mediaRecorderRef.current.onstop = () => {
                const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/wav' });
                const url = URL.createObjectURL(audioBlob);
                setAudioUrl(url);
                processAudio(audioBlob);
            };

            mediaRecorderRef.current.start();
            setIsRecording(true);
            setStatus('Recording...');
        } catch (err) {
            console.error('Error accessing microphone:', err);
            setStatus('Error: Mic blocked');
        }
    };

    const stopRecording = () => {
        if (mediaRecorderRef.current && isRecording) {
            mediaRecorderRef.current.stop();
            setIsRecording(false);
            // Stop all tracks to release mic
            mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
        }
    };

    const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (file) {
            const url = URL.createObjectURL(file);
            setAudioUrl(url);
            processAudio(file);
        }
    };

    const handleCopy = async () => {
        if (!midiOutput) return;
        try {
            await navigator.clipboard.writeText(midiOutput);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
        } catch (e) {
            setCopied(false);
        }
    };

    return (
        <div className="min-h-screen bg-gray-900 text-white p-8 font-mono">
            <button
                onClick={() => navigate('/')}
                className="flex items-center gap-2 mb-8 text-cyan-400 hover:text-cyan-300 transition-colors"
            >
                <ArrowLeft size={20} />
                Back to Composer
            </button>

            <div className="max-w-3xl mx-auto space-y-8">
                <div className="space-y-2">
                    <h1 className="text-3xl font-bold text-cyan-500">Voice to Sequence</h1>
                    <p className="text-gray-400">
                        Convert humming or singing into event data.
                        <span className="ml-2 px-2 py-0.5 bg-gray-800 rounded text-xs text-yellow-500">
                            Deterministic • Monophonic
                        </span>
                    </p>
                </div>

                {/* Input Section */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {/* Live Recording */}
                    <div className="bg-gray-800 p-6 rounded-lg border border-gray-700 hover:border-cyan-500/50 transition-colors">
                        <h2 className="text-lg font-bold mb-4 flex items-center gap-2">
                            <Mic size={18} /> Live Input
                        </h2>

                        <div className="flex flex-col items-center justify-center p-8 bg-gray-900 rounded border border-gray-700 border-dashed">
                            {!isRecording ? (
                                <button
                                    onClick={startRecording}
                                    className="w-16 h-16 rounded-full bg-red-500 hover:bg-red-400 flex items-center justify-center shadow-lg shadow-red-500/20 transition-all hover:scale-105"
                                >
                                    <Mic size={32} className="text-white" />
                                </button>
                            ) : (
                                <button
                                    onClick={stopRecording}
                                    className="w-16 h-16 rounded-full bg-gray-700 hover:bg-gray-600 flex items-center justify-center animate-pulse"
                                >
                                    <Square size={32} className="text-red-500" fill="currentColor" />
                                </button>
                            )}
                            <p className="mt-4 text-sm text-gray-500">
                                {isRecording ? 'Recording... Tap to stop' : 'Tap to Record'}
                            </p>
                        </div>
                    </div>

                    {/* File Upload */}
                    <div className="bg-gray-800 p-6 rounded-lg border border-gray-700 hover:border-cyan-500/50 transition-colors">
                        <h2 className="text-lg font-bold mb-4 flex items-center gap-2">
                            <Upload size={18} /> Upload File
                        </h2>

                        <label className="flex flex-col items-center justify-center h-full p-8 bg-gray-900 rounded border border-gray-700 border-dashed cursor-pointer hover:bg-gray-800/50 transition-colors">
                            <Upload size={32} className="text-gray-500 mb-2" />
                            <span className="text-sm text-gray-500">Select Audio File</span>
                            <input
                                type="file"
                                accept="audio/*"
                                onChange={handleFileUpload}
                                className="hidden"
                            />
                        </label>
                    </div>
                </div>

                {/* Playback & Status */}
                {audioUrl && (
                    <div className="bg-gray-800 p-4 rounded-lg flex items-center justify-between border border-gray-700">
                        <div className="flex items-center gap-4">
                            <audio src={audioUrl} controls className="h-8" />
                            <a
                                href={audioUrl}
                                download="recording.wav"
                                className="flex items-center gap-1 text-sm text-cyan-400 hover:text-cyan-300"
                            >
                                <Download size={14} /> Download
                            </a>
                        </div>
                        <div className="text-sm font-bold">
                            Status: <span className="text-cyan-400">{status}</span>
                        </div>
                    </div>
                )}

                {/* Output */}
                <div className="bg-gray-800 p-6 rounded-lg border border-gray-700">
                    <div className="flex items-center justify-between mb-4">
                        <h2 className="text-lg font-bold">Sequence Output</h2>
                        <span className="text-xs text-gray-500 bg-gray-900 px-2 py-1 rounded">
                            Fixed Tempo: {BPM} BPM
                        </span>
                    </div>
                    <div className="relative">
                        <textarea
                            value={midiOutput}
                            readOnly
                            className="w-full h-32 bg-gray-900 border border-gray-700 rounded p-4 font-mono text-sm text-green-400 focus:outline-none focus:border-cyan-500 pr-16"
                            placeholder="Generated sequence data will appear here..."
                        />
                        <button
                            onClick={handleCopy}
                            className={`absolute top-4 right-4 flex items-center gap-1 px-3 py-1.5 rounded-lg font-bold text-xs border transition-all shadow ${copied ? 'bg-emerald-600 text-white border-emerald-700' : 'bg-cyan-900/80 text-cyan-300 border-cyan-500/20 hover:bg-cyan-500/20 hover:text-cyan-100 hover:border-cyan-400'}`}
                            style={{ zIndex: 2 }}
                            title="Copy to clipboard"
                        >
                            <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" className="inline-block align-middle">
                                <rect x="9" y="9" width="13" height="13" rx="2" className="fill-none" />
                                <rect x="3" y="3" width="13" height="13" rx="2" className="fill-none" />
                            </svg>
                            {copied ? 'Copied!' : 'Copy'}
                        </button>
                    </div>
                    <div className="mt-4 text-xs text-gray-500">
                        Copy this text and paste it into the <strong>Manual Patch Bay</strong> on the main screen.
                    </div>
                </div>
            </div>
        </div>
    );
};

export default VoiceToMidiConverter;
