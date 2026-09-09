/**
 * SightScribe - Side Panel Application Logic
 * Real-time caption feed, audio visualizer, auto-scrolling, search, and SRT/TXT export.
 */

import { exportToSrt, exportToTxt, downloadFile } from '../utils/srt-generator.js';
import { normalizeForComparison } from '../utils/text-dedup.js';

// DOM Elements
const statusPill = document.getElementById('statusPill');
const statusText = document.getElementById('statusText');
const activeTabCard = document.getElementById('activeTabCard');
const tabFavicon = document.getElementById('tabFavicon');
const tabTitle = document.getElementById('tabTitle');
const visualizerCanvas = document.getElementById('visualizerCanvas');
const searchInput = document.getElementById('searchInput');
const clearSearchBtn = document.getElementById('clearSearchBtn');
const copyAllBtn = document.getElementById('copyAllBtn');
const downloadSrtBtn = document.getElementById('downloadSrtBtn');
const downloadTxtBtn = document.getElementById('downloadTxtBtn');
const clearTranscriptsBtn = document.getElementById('clearTranscriptsBtn');
const feedContainer = document.getElementById('feedContainer');
const emptyState = document.getElementById('emptyState');
const transcriptsList = document.getElementById('transcriptsList');
const jumpBottomBtn = document.getElementById('jumpBottomBtn');
const errorToast = document.getElementById('errorToast');
const errorMessage = document.getElementById('errorMessage');
const closeToastBtn = document.getElementById('closeToastBtn');
const successToast = document.getElementById('successToast');
const successMessage = document.getElementById('successMessage');
const providerInfo = document.getElementById('providerInfo');
const segmentCount = document.getElementById('segmentCount');
const toggleCaptureBtn = document.getElementById('toggleCaptureBtn');
const toggleCaptureText = document.getElementById('toggleCaptureText');
const playIcon = toggleCaptureBtn.querySelector('.play-icon');
const stopIcon = toggleCaptureBtn.querySelector('.stop-icon');

// Visualizer setup
const canvasCtx = visualizerCanvas.getContext('2d');
let visualizerEnergy = 0;
let visualizerTargetEnergy = 0;
let animFrameId = null;

// State
let isCapturing = false;
let transcripts = [];
let userScrolledUp = false;
let searchTerm = '';

// Initialize
init();

async function init() {
  setupEventListeners();
  setupVisualizer();
  await loadState();
  await loadProviderSettings();
}

/**
 * Fetch current state from background service worker
 */
async function loadState() {
  try {
    const state = await chrome.runtime.sendMessage({ action: 'GET_STATE' });
    if (state) {
      applyState(state);
    }
  } catch (err) {
    console.warn('Could not retrieve state:', err);
  }
}

/**
 * Load provider settings for UI display
 */
async function loadProviderSettings() {
  try {
    const storage = await chrome.storage.local.get('sightscribe_settings');
    const settings = storage.sightscribe_settings;
    if (settings) {
      const pName = settings.provider === 'groq' ? 'Groq Whisper' :
                    settings.provider === 'openai' ? 'OpenAI Whisper' : 'Custom Whisper';
      providerInfo.textContent = `Engine: ${pName}`;
    }
  } catch (e) {}
}

/**
 * Apply state object to UI
 */
function applyState(state) {
  isCapturing = state.isCapturing;
  updateCaptureButton(isCapturing);

  if (isCapturing) {
    statusPill.className = 'status-pill listening';
    statusText.textContent = state.transcriptionState === 'processing' ? 'Transcribing...' : 'Listening';
    activeTabCard.classList.remove('hidden');
    tabTitle.textContent = state.capturedTabTitle || 'Active Tab';
    if (state.capturedTabFavicon) {
      tabFavicon.src = state.capturedTabFavicon;
      tabFavicon.style.display = 'inline-block';
    } else {
      tabFavicon.style.display = 'none';
    }
  } else {
    statusPill.className = 'status-pill idle';
    statusText.textContent = 'Idle';
    activeTabCard.classList.add('hidden');
  }

  if (Array.isArray(state.transcripts)) {
    const deduped = [];
    for (const seg of state.transcripts) {
      if (!seg || !seg.text) continue;
      const prev = deduped[deduped.length - 1];
      if (prev && normalizeForComparison(prev.text) === normalizeForComparison(seg.text)) {
        continue;
      }
      deduped.push(seg);
    }
    transcripts = deduped;
    renderTranscripts();
  }
}

/**
 * Event listeners
 */
function setupEventListeners() {
  // Capture toggle
  toggleCaptureBtn.addEventListener('click', handleToggleCapture);

  // Search
  searchInput.addEventListener('input', (e) => {
    searchTerm = e.target.value.toLowerCase().trim();
    clearSearchBtn.classList.toggle('hidden', !searchTerm);
    renderTranscripts();
  });

  clearSearchBtn.addEventListener('click', () => {
    searchInput.value = '';
    searchTerm = '';
    clearSearchBtn.classList.add('hidden');
    renderTranscripts();
  });

  // Action buttons
  copyAllBtn.addEventListener('click', handleCopyAll);
  downloadSrtBtn.addEventListener('click', handleDownloadSrt);
  downloadTxtBtn.addEventListener('click', handleDownloadTxt);
  clearTranscriptsBtn.addEventListener('click', handleClearTranscripts);

  // Scroll detection
  feedContainer.addEventListener('scroll', () => {
    const threshold = 60;
    const isAtBottom = feedContainer.scrollHeight - feedContainer.scrollTop - feedContainer.clientHeight <= threshold;
    userScrolledUp = !isAtBottom;
    jumpBottomBtn.classList.toggle('hidden', isAtBottom || transcripts.length === 0);
  });

  jumpBottomBtn.addEventListener('click', () => {
    scrollToBottom(true);
  });

  closeToastBtn.addEventListener('click', () => {
    errorToast.classList.add('hidden');
  });

  // Background message listener
  chrome.runtime.onMessage.addListener((message) => {
    switch (message.action) {
      case 'NEW_TRANSCRIPT_SEGMENT':
        if (message.segment && message.segment.text) {
          const last = transcripts[transcripts.length - 1];
          if (last && normalizeForComparison(last.text) === normalizeForComparison(message.segment.text)) {
            // Drop duplicate
            break;
          }
          transcripts.push(message.segment);
          appendSegment(message.segment);
          updateSegmentCount();
          if (!userScrolledUp) {
            scrollToBottom(true);
          }
        }
        break;

      case 'AUDIO_LEVEL':
        visualizerTargetEnergy = (message.level || 0) / 100;
        break;

      case 'TRANSCRIPTION_STATE':
        if (isCapturing) {
          if (message.state === 'processing') {
            statusPill.className = 'status-pill processing';
            statusText.textContent = 'Transcribing...';
          } else if (message.state === 'error') {
            statusPill.className = 'status-pill error';
            statusText.textContent = 'Error';
          } else {
            statusPill.className = 'status-pill listening';
            statusText.textContent = 'Listening';
          }
        }
        break;

      case 'STATE_CHANGED':
        if (message.state) {
          applyState(message.state);
        }
        break;

      case 'TRANSCRIPTS_CLEARED':
        transcripts = [];
        renderTranscripts();
        break;

      case 'CAPTURE_ERROR':
        showError(message.error || 'An error occurred during audio capture.');
        break;
    }
  });
}

/**
 * Handle Start/Stop Captions
 */
async function handleToggleCapture() {
  toggleCaptureBtn.disabled = true;

  try {
    if (!isCapturing) {
      // Validate API key first
      const storage = await chrome.storage.local.get('sightscribe_settings');
      const settings = storage.sightscribe_settings;
      if (!settings || !settings.apiKey || settings.apiKey.trim() === '') {
        showError('Please set your Groq or OpenAI API key in the extension popup settings before starting.');
        toggleCaptureBtn.disabled = false;
        return;
      }

      const res = await chrome.runtime.sendMessage({ action: 'START_CAPTURE' });
      if (!res || !res.success) {
        showError(res?.error || 'Failed to start audio capture.');
      } else {
        isCapturing = true;
        updateCaptureButton(true);
      }
    } else {
      await chrome.runtime.sendMessage({ action: 'STOP_CAPTURE' });
      isCapturing = false;
      updateCaptureButton(false);
    }
  } catch (err) {
    showError(err.message || 'Communication error with extension background.');
  } finally {
    toggleCaptureBtn.disabled = false;
  }
}

/**
 * Toggle button state & styling
 */
function updateCaptureButton(capturing) {
  if (capturing) {
    toggleCaptureBtn.className = 'btn-primary stop';
    toggleCaptureText.textContent = 'Stop Captions';
    playIcon.classList.add('hidden');
    stopIcon.classList.remove('hidden');
  } else {
    toggleCaptureBtn.className = 'btn-primary start';
    toggleCaptureText.textContent = 'Start Captions';
    playIcon.classList.remove('hidden');
    stopIcon.classList.add('hidden');
  }
}

/**
 * Renders all transcripts (with search filtering)
 */
function renderTranscripts() {
  transcriptsList.innerHTML = '';

  const filtered = searchTerm
    ? transcripts.filter(t => t.text.toLowerCase().includes(searchTerm))
    : transcripts;

  if (filtered.length === 0) {
    emptyState.classList.remove('hidden');
    transcriptsList.classList.add('hidden');
  } else {
    emptyState.classList.add('hidden');
    transcriptsList.classList.remove('hidden');

    const fragment = document.createDocumentFragment();
    filtered.forEach((segment, idx) => {
      const card = createCaptionCard(segment, idx === filtered.length - 1);
      fragment.appendChild(card);
    });
    transcriptsList.appendChild(fragment);
  }

  updateSegmentCount();
  if (!userScrolledUp) {
    scrollToBottom(false);
  }
}

/**
 * Appends a single newly transcribed segment
 */
function appendSegment(segment) {
  emptyState.classList.add('hidden');
  transcriptsList.classList.remove('hidden');

  // Remove latest highlight from previous cards
  const previousLatest = transcriptsList.querySelector('.caption-card.latest');
  if (previousLatest) {
    previousLatest.classList.remove('latest');
  }

  // If search filter is active, only append if matches
  if (searchTerm && !segment.text.toLowerCase().includes(searchTerm)) {
    return;
  }

  const card = createCaptionCard(segment, true);
  transcriptsList.appendChild(card);
}

/**
 * Creates a DOM card for a caption segment
 */
function createCaptionCard(segment, isLatest) {
  const card = document.createElement('div');
  card.className = `caption-card ${isLatest ? 'latest' : ''}`;
  card.dataset.id = segment.id;

  let displayText = segment.text;
  if (searchTerm) {
    // Highlight matching query
    const regex = new RegExp(`(${escapeRegex(searchTerm)})`, 'gi');
    displayText = displayText.replace(regex, '<mark style="background: rgba(245, 158, 11, 0.4); color: white; border-radius: 2px; padding: 0 2px;">$1</mark>');
  }

  card.innerHTML = `
    <div class="caption-header">
      <span class="timestamp-pill">[${segment.timestamp || '00:00'}]</span>
      <div class="segment-actions">
        <button class="card-action-btn copy-seg-btn" title="Copy this line">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
          </svg>
        </button>
      </div>
    </div>
    <div class="caption-text">${displayText}</div>
  `;

  // Single card copy handler
  const copyBtn = card.querySelector('.copy-seg-btn');
  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(segment.text).then(() => {
      showSuccess('Caption copied to clipboard');
    });
  });

  return card;
}

function updateSegmentCount() {
  const count = transcripts.length;
  segmentCount.textContent = `${count} caption${count === 1 ? '' : 's'}`;
}

function scrollToBottom(smooth = true) {
  feedContainer.scrollTo({
    top: feedContainer.scrollHeight,
    behavior: smooth ? 'smooth' : 'auto'
  });
}

/**
 * Copy all transcript text
 */
async function handleCopyAll() {
  if (transcripts.length === 0) {
    showError('No captions to copy yet.');
    return;
  }

  const plainText = exportToTxt(transcripts);
  try {
    await navigator.clipboard.writeText(plainText);
    showSuccess('All transcripts copied to clipboard!');
  } catch (e) {
    showError('Failed to copy to clipboard.');
  }
}

/**
 * Export SubRip Subtitle file (.SRT)
 */
function handleDownloadSrt() {
  if (transcripts.length === 0) {
    showError('No captions to export.');
    return;
  }

  const srtContent = exportToSrt(transcripts);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  downloadFile(srtContent, `sightscribe-captions-${timestamp}.srt`, 'text/plain;charset=utf-8');
  showSuccess('SRT subtitles exported!');
}

/**
 * Export clean transcript document (.TXT)
 */
function handleDownloadTxt() {
  if (transcripts.length === 0) {
    showError('No captions to export.');
    return;
  }

  const txtContent = exportToTxt(transcripts);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  downloadFile(txtContent, `sightscribe-transcript-${timestamp}.txt`, 'text/plain;charset=utf-8');
  showSuccess('TXT transcript exported!');
}

/**
 * Clear all transcripts
 */
async function handleClearTranscripts() {
  if (transcripts.length === 0) return;

  if (confirm('Clear all recorded captions for this session?')) {
    await chrome.runtime.sendMessage({ action: 'CLEAR_TRANSCRIPT' });
    transcripts = [];
    renderTranscripts();
    showSuccess('Transcripts cleared');
  }
}

/**
 * Toast notifications
 */
function showError(msg) {
  errorMessage.textContent = msg;
  errorToast.classList.remove('hidden');
  setTimeout(() => {
    errorToast.classList.add('hidden');
  }, 5000);
}

function showSuccess(msg) {
  successMessage.textContent = msg;
  successToast.classList.remove('hidden');
  setTimeout(() => {
    successToast.classList.add('hidden');
  }, 2500);
}

function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Equalizer / Audio Spectrum Visualizer
 */
function setupVisualizer() {
  const barCount = 28;
  const barWidth = 8;
  const barGap = 4;

  function renderVisualizer() {
    // Smooth interpolation towards target energy
    visualizerEnergy += (visualizerTargetEnergy - visualizerEnergy) * 0.25;

    const width = visualizerCanvas.width;
    const height = visualizerCanvas.height;
    canvasCtx.clearRect(0, 0, width, height);

    const activeEnergy = isCapturing ? visualizerEnergy : 0.05;

    for (let i = 0; i < barCount; i++) {
      // Simulate realistic frequency curve
      const progress = i / barCount;
      const wave = Math.sin(Date.now() * 0.005 + i * 0.4) * 0.3 + 0.7;
      const barHeight = Math.max(3, activeEnergy * height * wave * (1 - Math.abs(progress - 0.5) * 0.4));

      const x = i * (barWidth + barGap) + 4;
      const y = height - barHeight;

      // Color gradient from Indigo to Cyan
      const grad = canvasCtx.createLinearGradient(0, height, 0, 0);
      if (isCapturing && activeEnergy > 0.1) {
        grad.addColorStop(0, '#4f46e5');
        grad.addColorStop(1, '#06b6d4');
      } else {
        grad.addColorStop(0, '#1e293b');
        grad.addColorStop(1, '#334155');
      }

      canvasCtx.fillStyle = grad;
      canvasCtx.beginPath();
      canvasCtx.roundRect(x, y, barWidth, barHeight, [2, 2, 0, 0]);
      canvasCtx.fill();
    }

    animFrameId = requestAnimationFrame(renderVisualizer);
  }

  renderVisualizer();
}
