/**
 * SightScribe - Audio Helper Utilities
 * High-performance audio conversion and processing for Whisper AI transcription.
 */

/**
 * Encodes Float32Array PCM samples into a standard 16-bit mono WAV Blob.
 * Whisper performs best with 16kHz mono 16-bit PCM WAV files.
 * 
 * @param {Float32Array} samples - Normalized audio samples (-1.0 to 1.0)
 * @param {number} sampleRate - Sample rate in Hz (default: 16000)
 * @returns {Blob} - WAV audio Blob
 */
export function encodeWAV(samples, sampleRate = 16000) {
  const numChannels = 1;
  const bytesPerSample = 2; // 16-bit
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  // RIFF chunk descriptor
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true); // ChunkSize
  writeString(view, 8, 'WAVE');

  // fmt sub-chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
  view.setUint16(20, 1, true); // AudioFormat (1 for PCM)
  view.setUint16(22, numChannels, true); // NumChannels (1 mono)
  view.setUint32(24, sampleRate, true); // SampleRate
  view.setUint32(28, byteRate, true); // ByteRate
  view.setUint16(32, blockAlign, true); // BlockAlign
  view.setUint16(34, 16, true); // BitsPerSample (16 bits)

  // data sub-chunk
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true); // Subchunk2Size

  // Write 16-bit PCM samples with clipping protection
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    let s = Math.max(-1, Math.min(1, samples[i]));
    // Convert -1.0..1.0 to -32768..32767
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

function writeString(view, offset, string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

/**
 * Downsamples audio buffer from inputSampleRate (e.g. 48000Hz or 44100Hz)
 * to targetSampleRate (e.g. 16000Hz for Whisper).
 * Uses linear interpolation for clean high-frequency roll-off.
 * 
 * @param {Float32Array} buffer - Source PCM samples
 * @param {number} inputSampleRate - Current sample rate
 * @param {number} targetSampleRate - Desired sample rate (default: 16000)
 * @returns {Float32Array} - Downsampled PCM samples
 */
export function downsampleBuffer(buffer, inputSampleRate, targetSampleRate = 16000) {
  if (inputSampleRate === targetSampleRate) {
    return buffer;
  }
  if (inputSampleRate < targetSampleRate) {
    // If lower, return as-is
    return buffer;
  }

  const sampleRateRatio = inputSampleRate / targetSampleRate;
  const newLength = Math.round(buffer.length / sampleRateRatio);
  const result = new Float32Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;

  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * sampleRateRatio);
    // Average samples in the bucket
    let accum = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
      accum += buffer[i];
      count++;
    }
    result[offsetResult] = count > 0 ? accum / count : 0;
    offsetResult++;
    offsetBuffer = nextOffsetBuffer;
  }

  return result;
}

/**
 * Calculates Root Mean Square (RMS) energy of audio buffer.
 * Used for Voice Activity Detection and silence skipping.
 * 
 * @param {Float32Array} buffer 
 * @returns {number} RMS value between 0.0 and 1.0
 */
export function calculateRMS(buffer) {
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) {
    sum += buffer[i] * buffer[i];
  }
  return Math.sqrt(sum / buffer.length);
}

/**
 * Formats time in seconds to MM:SS or HH:MM:SS string.
 * 
 * @param {number} totalSeconds 
 * @returns {string} Formatted timestamp
 */
export function formatTime(totalSeconds) {
  const sec = Math.floor(totalSeconds % 60);
  const min = Math.floor((totalSeconds / 60) % 60);
  const hrs = Math.floor(totalSeconds / 3600);

  const pad = (n) => String(n).padStart(2, '0');

  if (hrs > 0) {
    return `${pad(hrs)}:${pad(min)}:${pad(sec)}`;
  }
  return `${pad(min)}:${pad(sec)}`;
}
