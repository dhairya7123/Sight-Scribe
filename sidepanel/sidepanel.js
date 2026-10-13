/**
 * SightScribe - Side Panel Application Logic
 * Real-time caption feed, audio visualizer, auto-scrolling, search, SRT/TXT export,
 * Screen Narrator, and Text-to-Speech Accessibility Suite.
 */

import { exportToSrt, exportToTxt, downloadFile } from '../utils/srt-generator.js';
import { normalizeForComparison } from '../utils/text-dedup.js';

// Tabs
const tabCaptionsBtn = document.getElementById('tabCaptionsBtn');
const tabNarratorBtn = document.getElementById('tabNarratorBtn');
const feedContainer = document.getElementById('feedContainer');
const narratorContainer = document.getElementById('narratorContainer');
const visualizerWrapper = document.getElementById('visualizerWrapper');
const captionsToolbar = document.getElementById('captionsToolbar');
const captionsFooter = document.getElementById('captionsFooter');

// DOM Elements - Header & Status
const statusPill = document.getElementById('statusPill');
const statusText = document.getElementById('statusText');
const activeTabCard = document.getElementById('activeTabCard');
const tabFavicon = document.getElementById('tabFavicon');
const tabTitle = document.getElementById('tabTitle');
const visualizerCanvas = document.getElementById('visualizerCanvas');

// DOM Elements - Captions Tab
const searchInput = document.getElementById('searchInput');
const clearSearchBtn = document.getElementById('clearSearchBtn');
const copyAllBtn = document.getElementById('copyAllBtn');
const downloadSrtBtn = document.getElementById('downloadSrtBtn');
const downloadTxtBtn = document.getElementById('downloadTxtBtn');
const clearTranscriptsBtn = document.getElementById('clearTranscriptsBtn');
const emptyState = document.getElementById('emptyState');
const transcriptsList = document.getElementById('transcriptsList');
const jumpBottomBtn = document.getElementById('jumpBottomBtn');
const providerInfo = document.getElementById('providerInfo');
const segmentCount = document.getElementById('segmentCount');
const toggleCaptureBtn = document.getElementById('toggleCaptureBtn');
const toggleCaptureText = document.getElementById('toggleCaptureText');
const playIcon = toggleCaptureBtn.querySelector('.play-icon');
const stopIcon = toggleCaptureBtn.querySelector('.stop-icon');

// DOM Elements - Screen Narrator & TTS Tab
const narrateScreenBtn = document.getElementById('narrateScreenBtn');
const readPageTextBtn = document.getElementById('readPageTextBtn');
const readSelectionBtn = document.getElementById('readSelectionBtn');
const hoverReaderToggle = document.getElementById('hoverReaderToggle');
const speechPlayerBox = document.getElementById('speechPlayerBox');
const playerStatusBadge = document.getElementById('playerStatusBadge');
const playerStatusText = document.getElementById('playerStatusText');
const ttsPlayPauseBtn = document.getElementById('ttsPlayPauseBtn');
const ttsPlayIcon = document.getElementById('ttsPlayIcon');
const ttsPauseIcon = document.getElementById('ttsPauseIcon');
const ttsStopBtn = document.getElementById('ttsStopBtn');
const spokenSourceTag = document.getElementById('spokenSourceTag');
const spokenTextContent = document.getElementById('spokenTextContent');
const copySpokenTextBtn = document.getElementById('copySpokenTextBtn');
const ttsSpeedSelect = document.getElementById('ttsSpeedSelect');
const ttsVoiceSelect = document.getElementById('ttsVoiceSelect');

// Toasts
const errorToast = document.getElementById('errorToast');
const errorMessage = document.getElementById('errorMessage');
const closeToastBtn = document.getElementById('closeToastBtn');
const successToast = document.getElementById('successToast');
const successMessage = document.getElementById('successMessage');

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
let activeTab = 'captions'; // 'captions' | 'narrator'
let currentTtsState = {
  isSpeaking: false,
  isPaused: false,
  hoverReaderEnabled: false
};

// Initialize
init();

async function init() {
  setupNavigationTabs();
  setupEventListeners();
  setupNarratorEventListeners();
  setupVisualizer();
  await loadState();
  await loadTtsVoicesAndSettings();
  await loadProviderSettings();
}

/**
 * Navigation tabs (Live Captions vs Screen Narrator)
 */
function setupNavigationTabs() {
  tabCaptionsBtn.addEventListener('click', () => switchTab('captions'));
  tabNarratorBtn.addEventListener('click', () => switchTab('narrator'));
}

function switchTab(target) {
  activeTab = target;
  if (target === 'captions') {
    tabCaptionsBtn.classList.add('active');
    tabCaptionsBtn.setAttribute('aria-selected', 'true');
    tabNarratorBtn.classList.remove('active');
    tabNarratorBtn.setAttribute('aria-selected', 'false');

    feedContainer.classList.remove('hidden');
    feedContainer.classList.add('active');
    narratorContainer.classList.add('hidden');
    narratorContainer.classList.remove('active');

    visualizerWrapper.classList.remove('hidden');
    captionsToolbar.classList.remove('hidden');
    captionsFooter.classList.remove('hidden');
  } else {
    tabNarratorBtn.classList.add('active');
    tabNarratorBtn.setAttribute('aria-selected', 'true');
    tabCaptionsBtn.classList.remove('active');
    tabCaptionsBtn.setAttribute('aria-selected', 'false');

    narratorContainer.classList.remove('hidden');
    narratorContainer.classList.add('active');
    feedContainer.classList.add('hidden');
    feedContainer.classList.remove('active');

    visualizerWrapper.classList.add('hidden');
    captionsToolbar.classList.add('hidden');
    captionsFooter.classList.add('hidden');
  }
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
    console.warn('Could not retrieve caption state:', err);
  }

  try {
    const tts = await chrome.runtime.sendMessage({ action: 'GET_TTS_STATE' });
    if (tts) {
      applyTtsState(tts);
    }
  } catch (err) {
    console.warn('Could not retrieve TTS state:', err);
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
 * Load voices into dropdown and restore saved TTS settings
 */
async function loadTtsVoicesAndSettings() {
  try {
    const res = await chrome.runtime.sendMessage({ action: 'GET_TTS_VOICES' });
    const voices = (res && res.voices) ? res.voices : [];

    // Filter to usable english/standard voices
    ttsVoiceSelect.innerHTML = '<option value="">Default System Voice</option>';
    voices.forEach(v => {
      const opt = document.createElement('option');
      opt.value = v.voiceName;
      opt.textContent = `${v.voiceName} (${v.lang || 'standard'})`;
      ttsVoiceSelect.appendChild(opt);
    });

    // Restore saved settings
    const storage = await chrome.storage.local.get('sightscribe_tts_settings');
    const saved = storage.sightscribe_tts_settings;
    if (saved) {
      if (saved.rate) ttsSpeedSelect.value = String(saved.rate);
      if (saved.voiceName) ttsVoiceSelect.value = saved.voiceName;
    }
  } catch (e) {
    console.warn('Could not load TTS voices:', e);
  }
}

/**
 * Save TTS settings on change
 */
async function saveTtsSettings() {
  const settings = {
    rate: parseFloat(ttsSpeedSelect.value) || 1.0,
    pitch: 1.0,
    voiceName: ttsVoiceSelect.value || ''
  };
  await chrome.storage.local.set({ sightscribe_tts_settings: settings });
}

/**
 * Apply caption state object to UI
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
 * Apply TTS state to Narrator UI
 */
function applyTtsState(tts) {
  currentTtsState = tts;
  hoverReaderToggle.checked = !!tts.hoverReaderEnabled;

  if (tts.isSpeaking) {
    playerStatusBadge.className = 'player-status-badge speaking';
    playerStatusText.textContent = tts.isPaused ? 'Speech Paused' : 'Speaking Out Loud';
    ttsPlayIcon.classList.toggle('hidden', !tts.isPaused);
    ttsPauseIcon.classList.toggle('hidden', tts.isPaused);
  } else {
    playerStatusBadge.className = 'player-status-badge';
    playerStatusText.textContent = 'Speech Ready';
    ttsPlayIcon.classList.remove('hidden');
    ttsPauseIcon.classList.add('hidden');
  }

  if (tts.currentText && tts.currentText.trim()) {
    spokenTextContent.textContent = tts.currentText;
    if (tts.source === 'narration') {
      spokenSourceTag.textContent = 'Screen Narration';
    } else if (tts.source === 'page_text') {
      spokenSourceTag.textContent = 'Page Text';
    } else if (tts.source === 'selection') {
      spokenSourceTag.textContent = 'Selected Text';
    } else if (tts.source === 'hover') {
      spokenSourceTag.textContent = 'Hover Reader';
    }
  }
}

/**
 * Event listeners - Screen Narrator & TTS
 */
function setupNarratorEventListeners() {
  // 1. Narrate Screen
  narrateScreenBtn.addEventListener('click', async () => {
    try {
      playerStatusBadge.className = 'player-status-badge speaking';
      playerStatusText.textContent = 'Analyzing Screen...';
      spokenSourceTag.textContent = 'Screen Narration';
      spokenTextContent.textContent = 'Analyzing screen layout, visuals, and headings...';

      const res = await chrome.runtime.sendMessage({ action: 'NARRATE_SCREEN' });
      if (!res || !res.success) {
        showError(res?.error || 'Failed to narrate screen.');
      } else {
        showSuccess('Narrating screen out loud!');
      }
    } catch (err) {
      showError(err.message || 'Error requesting screen narration.');
    }
  });

  // 2. Read Page Text Aloud
  readPageTextBtn.addEventListener('click', async () => {
    try {
      playerStatusBadge.className = 'player-status-badge speaking';
      playerStatusText.textContent = 'Extracting Text...';
      spokenSourceTag.textContent = 'Page Text';
      spokenTextContent.textContent = 'Extracting readable text from active webpage...';

      const res = await chrome.runtime.sendMessage({ action: 'READ_PAGE_TEXT' });
      if (!res || !res.success) {
        showError(res?.error || 'Failed to read page text.');
      } else {
        showSuccess('Reading screen text out loud!');
      }
    } catch (err) {
      showError(err.message || 'Error extracting webpage text.');
    }
  });

  // 3. Read Selection
  readSelectionBtn.addEventListener('click', async () => {
    try {
      const res = await chrome.runtime.sendMessage({ action: 'READ_SELECTION' });
      if (!res || !res.success) {
        showError(res?.error || 'No text selected on the page.');
      } else {
        showSuccess('Reading selected text!');
      }
    } catch (err) {
      showError(err.message || 'Error reading selected text.');
    }
  });

  // 4. Hover Reader Toggle
  hoverReaderToggle.addEventListener('change', async (e) => {
    try {
      const res = await chrome.runtime.sendMessage({
        action: 'TOGGLE_HOVER_READER',
        enabled: e.target.checked
      });
      if (res && res.success) {
        showSuccess(res.enabled ? 'Screen Reader Hover mode activated' : 'Screen Reader Hover mode stopped');
      }
    } catch (err) {
      showError(err.message || 'Could not toggle hover reader.');
      e.target.checked = !e.target.checked;
    }
  });

  // 5. Play / Pause
  ttsPlayPauseBtn.addEventListener('click', async () => {
    if (currentTtsState.isSpeaking && !currentTtsState.isPaused) {
      await chrome.runtime.sendMessage({ action: 'TTS_PAUSE' });
    } else if (currentTtsState.isPaused) {
      await chrome.runtime.sendMessage({ action: 'TTS_RESUME' });
    } else {
      // Re-read current text
      const text = spokenTextContent.textContent.trim();
      if (text && text.length > 5) {
        await chrome.runtime.sendMessage({ action: 'TTS_PLAY_TEXT', text, source: 'manual' });
      }
    }
  });

  // 6. Stop TTS
  ttsStopBtn.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ action: 'TTS_STOP' });
    showSuccess('Speech stopped');
  });

  // 7. Copy Spoken Text
  copySpokenTextBtn.addEventListener('click', async () => {
    const text = spokenTextContent.textContent.trim();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      showSuccess('Spoken text copied to clipboard!');
    } catch (e) {
      showError('Failed to copy text.');
    }
  });

  // 8. Settings change
  ttsSpeedSelect.addEventListener('change', saveTtsSettings);
  ttsVoiceSelect.addEventListener('change', saveTtsSettings);
}

/**
 * Event listeners - Captions
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

      // TTS and Narrator broadcasts
      case 'TTS_STATE_CHANGED':
        if (message.ttsState) {
          applyTtsState(message.ttsState);
        }
        break;

      case 'NARRATION_STATUS':
        if (message.status === 'analyzing') {
          playerStatusBadge.className = 'player-status-badge speaking';
          playerStatusText.textContent = 'Analyzing Screen...';
        } else if (message.status === 'ready' && message.narration) {
          spokenSourceTag.textContent = message.source === 'ai_vision' ? 'AI Vision Narration' : 'DOM Screen Narration';
          spokenTextContent.textContent = message.narration;
        }
        break;

      case 'PAGE_TEXT_READY':
        if (message.text) {
          spokenSourceTag.textContent = 'Page Text';
          spokenTextContent.textContent = message.text;
        }
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
    visualizerEnergy += (visualizerTargetEnergy - visualizerEnergy) * 0.25;

    const width = visualizerCanvas.width;
    const height = visualizerCanvas.height;
    canvasCtx.clearRect(0, 0, width, height);

    const activeEnergy = isCapturing ? visualizerEnergy : 0.05;

    for (let i = 0; i < barCount; i++) {
      const progress = i / barCount;
      const wave = Math.sin(Date.now() * 0.005 + i * 0.4) * 0.3 + 0.7;
      const barHeight = Math.max(3, activeEnergy * height * wave * (1 - Math.abs(progress - 0.5) * 0.4));

      const x = i * (barWidth + barGap) + 4;
      const y = height - barHeight;

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
