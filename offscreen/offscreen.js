/**
 * SightScribe - Audio Processor & AI Whisper Client (Offscreen Document)
 * Captures tab audio stream, maintains speaker passthrough, buffers PCM audio,
 * filters silence, and sends audio chunks to Groq or OpenAI Whisper API.
 */

import { encodeWAV, downsampleBuffer, calculateRMS, formatTime } from '../utils/audio-helpers.js';

let audioCtx = null;
let mediaStream = null;
let sourceNode = null;
let scriptNode = null;
let analyserNode = null;

let isCapturing = false;
let sessionStartTime = 0;
let chunkStartTime = 0;
let segmentCounter = 1;
let promptContext = '';

// Active settings
let currentSettings = {
  provider: 'groq',
  apiKey: '',
  model: 'whisper-large-v3-turbo',
  language: '',
  chunkDuration: 3.5, // seconds
  vadThreshold: 0.008, // RMS silence threshold
  customEndpoint: ''
};

// PCM audio buffer accumulator
let pcmBuffer = [];
let accumulatedSampleCount = 0;
let lastLevelBroadcastTime = 0;
let isTranscribingNow = false;

// Common hallucination strings to filter out
const HALLUCINATIONS = new Set([
  'thank you.',
  'thank you for watching!',
  'thank you for watching.',
  'thanks for watching!',
  'thanks for watching.',
  'subtitles by the amara.org community',
  'subtitles by the amara community',
  'subscribe to my channel',
  'please subscribe',
  'like and subscribe'
]);

/**
 * Listen for messages from background script
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'offscreen') return;

  switch (message.action) {
    case 'START_STREAM':
      handleStartStream(message.streamId, message.settings);
      sendResponse({ status: 'starting' });
      break;

    case 'STOP_STREAM':
      handleStopStream();
      sendResponse({ status: 'stopped' });
      break;

    case 'UPDATE_SETTINGS':
      if (message.settings) {
        currentSettings = { ...currentSettings, ...message.settings };
      }
      sendResponse({ status: 'settings_updated' });
      break;

    case 'PING':
      sendResponse({ status: 'pong', isCapturing });
      break;
  }
  return true;
});

/**
 * Starts audio capture and streaming pipeline
 */
async function handleStartStream(streamId, settings) {
  if (isCapturing) {
    handleStopStream();
  }

  if (settings) {
    currentSettings = { ...currentSettings, ...settings };
  }

  try {
    // 1. Capture the tab audio stream
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId
        }
      },
      video: false
    });

    // Detect if stream track ends abruptly (e.g. user closed tab)
    mediaStream.getAudioTracks().forEach(track => {
      track.onended = () => {
        chrome.runtime.sendMessage({
          action: 'STREAM_ENDED_BY_USER'
        });
        handleStopStream();
      };
    });

    // 2. Setup Web Audio graph
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') {
      await audioCtx.resume();
    }

    sourceNode = audioCtx.createMediaStreamSource(mediaStream);

    // CRITICAL: Passthrough audio to speakers so the user can continue hearing sound!
    sourceNode.connect(audioCtx.destination);

    // Analyser node for live volume metering
    analyserNode = audioCtx.createAnalyser();
    analyserNode.fftSize = 256;
    analyserNode.smoothingTimeConstant = 0.5;
    sourceNode.connect(analyserNode);

    // ScriptProcessor node for collecting raw PCM samples
    const bufferSize = 4096;
    scriptNode = audioCtx.createScriptProcessor(bufferSize, 1, 1);
    sourceNode.connect(scriptNode);
    // Connect to destination to keep audio processing alive
    scriptNode.connect(audioCtx.destination);

    // State initialization
    isCapturing = true;
    pcmBuffer = [];
    accumulatedSampleCount = 0;
    sessionStartTime = Date.now();
    chunkStartTime = 0;
    segmentCounter = 1;
    promptContext = '';

    const targetSamplesPerChunk = Math.round(audioCtx.sampleRate * (currentSettings.chunkDuration || 3.5));

    scriptNode.onaudioprocess = (event) => {
      if (!isCapturing) return;

      const inputChannel = event.inputBuffer.getChannelData(0);
      // Copy audio data to buffer
      const clone = new Float32Array(inputChannel.length);
      clone.set(inputChannel);
      pcmBuffer.push(clone);
      accumulatedSampleCount += clone.length;

      // Broadcast real-time audio volume level every ~100ms for visualizer
      const now = Date.now();
      if (now - lastLevelBroadcastTime > 100) {
        lastLevelBroadcastTime = now;
        broadcastAudioLevel();
      }

      // When accumulated audio reaches target chunk duration, process it
      if (accumulatedSampleCount >= targetSamplesPerChunk) {
        processBufferedAudio(targetSamplesPerChunk);
      }
    };

    chrome.runtime.sendMessage({
      action: 'CAPTURE_STATUS',
      status: 'active',
      sampleRate: audioCtx.sampleRate
    });

  } catch (err) {
    console.error('Error starting audio capture stream:', err);
    chrome.runtime.sendMessage({
      action: 'CAPTURE_ERROR',
      error: err.message || 'Failed to capture tab audio'
    });
    handleStopStream();
  }
}

/**
 * Calculates current audio level from analyser and notifies background
 */
function broadcastAudioLevel() {
  if (!analyserNode) return;
  const dataArray = new Uint8Array(analyserNode.frequencyBinCount);
  analyserNode.getByteFrequencyData(dataArray);

  let sum = 0;
  for (let i = 0; i < dataArray.length; i++) {
    sum += dataArray[i];
  }
  const average = sum / dataArray.length;
  const normalizedLevel = Math.min(100, Math.round((average / 255) * 100 * 1.5));

  chrome.runtime.sendMessage({
    action: 'AUDIO_LEVEL',
    level: normalizedLevel,
    isSpeaking: normalizedLevel > 15
  });
}

/**
 * Flattens accumulated PCM chunks, downsamples to 16kHz, evaluates VAD,
 * and dispatches to Whisper API
 */
async function processBufferedAudio(expectedSampleCount) {
  if (pcmBuffer.length === 0) return;

  // Flatten accumulated chunks into a single Float32Array
  const totalLength = accumulatedSampleCount;
  const mergedSamples = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of pcmBuffer) {
    mergedSamples.set(chunk, offset);
    offset += chunk.length;
  }

  // Keep an overlap of 0.3s for seamless audio continuity
  const overlapSampleCount = Math.round(audioCtx.sampleRate * 0.3);
  const leftoverSamples = mergedSamples.slice(Math.max(0, totalLength - overlapSampleCount));

  // Reset accumulator
  pcmBuffer = [leftoverSamples];
  accumulatedSampleCount = leftoverSamples.length;

  const currentChunkStart = chunkStartTime;
  const currentChunkDuration = totalLength / audioCtx.sampleRate;
  const currentChunkEnd = currentChunkStart + currentChunkDuration;
  chunkStartTime = currentChunkEnd - 0.3; // Next chunk starts after overlap

  // Downsample from native rate (e.g. 48000Hz) to 16000Hz (Whisper optimal)
  const downsampled = downsampleBuffer(mergedSamples, audioCtx.sampleRate, 16000);

  // Measure RMS for Voice Activity Detection
  const rms = calculateRMS(downsampled);
  const threshold = currentSettings.vadThreshold !== undefined ? currentSettings.vadThreshold : 0.008;

  // If audio is practically silent (video paused or quiet song pause), skip API request
  if (rms < threshold) {
    return;
  }

  // Encode to standard 16-bit 16kHz WAV Blob
  const wavBlob = encodeWAV(downsampled, 16000);

  // Send to Whisper API asynchronously
  transcribeAudioChunk(wavBlob, currentChunkStart, currentChunkEnd);
}

/**
 * Sends audio chunk to Groq or OpenAI Whisper API
 */
async function transcribeAudioChunk(wavBlob, startSec, endSec) {
  const { provider, apiKey, model, language, customEndpoint } = currentSettings;

  if (!apiKey || apiKey.trim() === '') {
    chrome.runtime.sendMessage({
      action: 'CAPTURE_ERROR',
      error: 'API key is missing. Please set your key in SightScribe settings.'
    });
    return;
  }

  // Notify UI that a chunk is being processed
  chrome.runtime.sendMessage({
    action: 'TRANSCRIPTION_STATE',
    state: 'processing'
  });

  try {
    let endpointUrl = '';
    let selectedModel = '';

    if (provider === 'groq') {
      endpointUrl = 'https://api.groq.com/openai/v1/audio/transcriptions';
      selectedModel = model || 'whisper-large-v3-turbo';
    } else if (provider === 'openai') {
      endpointUrl = 'https://api.openai.com/v1/audio/transcriptions';
      selectedModel = model || 'whisper-1';
    } else if (provider === 'custom') {
      endpointUrl = customEndpoint || 'http://localhost:8000/v1/audio/transcriptions';
      selectedModel = model || 'whisper-1';
    }

    const formData = new FormData();
    formData.append('file', wavBlob, 'audio.wav');
    formData.append('model', selectedModel);
    formData.append('response_format', 'verbose_json');
    formData.append('temperature', '0');

    if (language && language.trim() !== '') {
      formData.append('language', language.trim());
    }

    // Supply prompt context from previous segment to preserve flow & lyrics
    if (promptContext) {
      formData.append('prompt', promptContext);
    }

    const response = await fetch(endpointUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey.trim()}`
      },
      body: formData
    });

    if (!response.ok) {
      let errText = await response.text();
      try {
        const parsed = JSON.parse(errText);
        if (parsed.error && parsed.error.message) {
          errText = parsed.error.message;
        }
      } catch (e) {
        // use raw text
      }
      throw new Error(`Whisper API error (${response.status}): ${errText}`);
    }

    const result = await response.json();
    let transcribedText = (result.text || '').trim();

    // Check for empty or hallucinated text
    if (!transcribedText || transcribedText.length < 2) {
      chrome.runtime.sendMessage({
        action: 'TRANSCRIPTION_STATE',
        state: 'idle'
      });
      return;
    }

    const normalizedText = transcribedText.toLowerCase().replace(/[.,!?;:]/g, '').trim();
    if (HALLUCINATIONS.has(normalizedText)) {
      chrome.runtime.sendMessage({
        action: 'TRANSCRIPTION_STATE',
        state: 'idle'
      });
      return;
    }

    // Update prompt context with the last 25 words
    const words = transcribedText.split(/\s+/);
    promptContext = words.slice(-25).join(' ');

    // Broadcast new caption segment to background and UI
    chrome.runtime.sendMessage({
      action: 'NEW_TRANSCRIPT_SEGMENT',
      segment: {
        id: segmentCounter++,
        startSec: Math.max(0, startSec),
        endSec: Math.max(startSec + 0.1, endSec),
        timestamp: formatTime(startSec),
        text: transcribedText,
        detectedLanguage: result.language || null
      }
    });

    chrome.runtime.sendMessage({
      action: 'TRANSCRIPTION_STATE',
      state: 'idle'
    });

  } catch (err) {
    console.error('Transcription error:', err);
    chrome.runtime.sendMessage({
      action: 'CAPTURE_ERROR',
      error: err.message || 'Error communicating with transcription API'
    });
    chrome.runtime.sendMessage({
      action: 'TRANSCRIPTION_STATE',
      state: 'error'
    });
  }
}

/**
 * Cleanly tears down the audio stream and resets graph
 */
function handleStopStream() {
  isCapturing = false;

  if (scriptNode) {
    try {
      scriptNode.disconnect();
      scriptNode.onaudioprocess = null;
    } catch (e) {}
    scriptNode = null;
  }

  if (analyserNode) {
    try {
      analyserNode.disconnect();
    } catch (e) {}
    analyserNode = null;
  }

  if (sourceNode) {
    try {
      sourceNode.disconnect();
    } catch (e) {}
    sourceNode = null;
  }

  if (audioCtx) {
    try {
      audioCtx.close();
    } catch (e) {}
    audioCtx = null;
  }

  if (mediaStream) {
    try {
      mediaStream.getTracks().forEach(track => track.stop());
    } catch (e) {}
    mediaStream = null;
  }

  pcmBuffer = [];
  accumulatedSampleCount = 0;
  promptContext = '';

  chrome.runtime.sendMessage({
    action: 'CAPTURE_STATUS',
    status: 'stopped'
  });
}
