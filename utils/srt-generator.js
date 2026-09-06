/**
 * SightScribe - Subtitle & Transcript Exporters
 * Converts caption segments into SubRip (.srt) and plain text (.txt) formats.
 */

/**
 * Formats seconds into SRT timestamp format: HH:MM:SS,mmm
 * Example: 75.32 -> "00:01:15,320"
 * 
 * @param {number} seconds 
 * @returns {string}
 */
export function formatSrtTimestamp(seconds) {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const millis = Math.floor((seconds % 1) * 1000);

  const pad = (n, len = 2) => String(n).padStart(len, '0');

  return `${pad(hrs)}:${pad(mins)}:${pad(secs)},${pad(millis, 3)}`;
}

/**
 * Converts transcript segments into standard SubRip (.srt) subtitle string.
 * 
 * @param {Array<{ id: number, startSec: number, endSec: number, text: string }>} segments 
 * @returns {string} Formatted SRT text
 */
export function exportToSrt(segments) {
  if (!segments || segments.length === 0) {
    return '';
  }

  return segments
    .filter(seg => seg && seg.text && seg.text.trim().length > 0)
    .map((seg, index) => {
      const startTime = formatSrtTimestamp(seg.startSec);
      const endTime = formatSrtTimestamp(seg.endSec);
      const cleanText = seg.text.trim();

      return `${index + 1}\n${startTime} --> ${endTime}\n${cleanText}\n`;
    })
    .join('\n');
}

/**
 * Converts transcript segments into a clean, readable text document with timestamps.
 * 
 * @param {Array<{ id: number, startSec: number, endSec: number, text: string, timestamp: string }>} segments 
 * @returns {string}
 */
export function exportToTxt(segments) {
  if (!segments || segments.length === 0) {
    return '';
  }

  const header = `SightScribe Live Audio Transcription\nExported: ${new Date().toLocaleString()}\n----------------------------------------\n\n`;

  const body = segments
    .filter(seg => seg && seg.text && seg.text.trim().length > 0)
    .map(seg => `[${seg.timestamp || '00:00'}] ${seg.text.trim()}`)
    .join('\n\n');

  return header + body;
}

/**
 * Triggers a client-side file download in the browser.
 * 
 * @param {string} content 
 * @param {string} filename 
 * @param {string} mimeType 
 */
export function downloadFile(content, filename, mimeType = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
