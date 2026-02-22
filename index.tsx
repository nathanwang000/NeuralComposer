
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import App from './App';
import ContinuousAudioLab from './components/ContinuousAudioLab';
import VoiceToMidiConverter from './components/VoiceToMidiConverter';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<App />} />
        <Route path="/converter" element={<VoiceToMidiConverter />} />
        <Route path="/lab" element={<ContinuousAudioLab />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
);
