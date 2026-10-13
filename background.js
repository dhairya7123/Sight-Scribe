/**
 * SightScribe - Background Service Worker (Manifest V3)
 * Manages audio capture lifecycle, offscreen document orchestration,
 * side panel coordination, screen narration, and text-to-speech for accessibility.
 */

import { normalizeForComparison } from './utils/text-dedup.js';
import { generateScreenNarration } from './utils/narrator.js';

const OFFSCREEN_DOCUMENT_PATH = 'offscreen/offscreen.html';

// In-memory state for audio/video captions
let state = {
  isCapturing: false,
  capturedTabId: null,
  capturedTabTitle: '',
  capturedTabFavicon: '',
  transcripts: [],
  audioLevel: 0,
  isSpeaking: false,
  transcriptionState: 'idle', // 'idle' | 'processing' | 'error'
  lastError: null
};

// In-memory state for Screen Narrator & TTS
let ttsState = {
  isSpeaking: false,
  isPaused: false,
  currentText: '',
  source: null, // 'narration' | 'page_text' | 'selection' | 'hover'
  progressPercent: 0,
  hoverReaderEnabled: false,
  lastNarrationText: '',
  lastPageText: ''
};

// Default settings
const DEFAULT_SETTINGS = {
  provider: 'groq',
  apiKey: '',
  model: 'whisper-large-v3-turbo',
  language: '',
  chunkDuration: 3.5,
  vadThreshold: 0.008,
  customEndpoint: 'http://localhost:8000/v1/audio/transcriptions'
};

const DEFAULT_TTS_SETTINGS = {
  rate: 1.0,
  pitch: 1.0,
  voiceName: ''
};

// Initialize settings, side panel behavior, and accessibility context menu
chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(['sightscribe_settings', 'sightscribe_tts_settings']);
  if (!existing.sightscribe_settings) {
    await chrome.storage.local.set({ sightscribe_settings: DEFAULT_SETTINGS });
  }
  if (!existing.sightscribe_tts_settings) {
    await chrome.storage.local.set({ sightscribe_tts_settings: DEFAULT_TTS_SETTINGS });
  }

  // Ensure side panel is available across browser
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
  }

  // Create context menu for quick selection reading
  try {
    chrome.contextMenus.create({
      id: 'sightscribe-read-selection',
      title: 'SightScribe: Read selected text aloud',
      contexts: ['selection']
    });
  } catch (e) {}
});

/**
 * Handle context menu clicks
 */
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'sightscribe-read-selection' && info.selectionText) {
    speakText(info.selectionText, { source: 'selection' });
  }
});

/**
 * Handle keyboard shortcut commands
 */
chrome.commands.onCommand.addListener((command) => {
  if (command === 'narrate_screen') {
    handleNarrateScreen();
  } else if (command === 'read_page_text') {
    handleReadPageText();
  } else if (command === 'stop_reading') {
    stopTTS();
  }
});

/**
 * Ensures the offscreen document is created and ready
 */
async function ensureOffscreenDocument() {
  if (chrome.offscreen && chrome.offscreen.hasDocument) {
    const hasDoc = await chrome.offscreen.hasDocument();
    if (hasDoc) return;
  }

  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: ['USER_MEDIA'],
      justification: 'Captures and processes tab audio for live captions and transcription'
    });
  } catch (err) {
    if (!err.message.includes('Only a single offscreen document may be created')) {
      console.error('Failed to create offscreen document:', err);
      throw err;
    }
  }
}

/**
 * Broadcasts an event to all open extension contexts (sidepanel, popup)
 */
function broadcast(action, payload = {}) {
  chrome.runtime.sendMessage({ action, ...payload }).catch(() => {
    // Expected when no popup or side panel is currently open
  });
}

/**
 * Updates extension action badge
 */
function updateBadge(active) {
  if (active) {
    chrome.action.setBadgeText({ text: 'LIVE' });
    chrome.action.setBadgeBackgroundColor({ color: '#4f46e5' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

/**
 * Message handler
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Ignore messages targeted strictly for offscreen
  if (message.target === 'offscreen') return;

  switch (message.action) {
    // --- Audio Captions Actions ---
    case 'GET_STATE': {
      sendResponse({ ...state });
      break;
    }

    case 'START_CAPTURE': {
      handleStartCapture(message.tabId)
        .then(() => sendResponse({ success: true }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;
    }

    case 'STOP_CAPTURE': {
      handleStopCapture()
        .then(() => sendResponse({ success: true }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;
    }

    case 'CLEAR_TRANSCRIPT': {
      state.transcripts = [];
      broadcast('TRANSCRIPTS_CLEARED');
      sendResponse({ success: true });
      break;
    }

    case 'OPEN_SIDEPANEL': {
      const windowId = message.windowId || (sender.tab ? sender.tab.windowId : null);
      if (chrome.sidePanel && chrome.sidePanel.open) {
        if (windowId) {
          chrome.sidePanel.open({ windowId }).catch(console.error);
        } else {
          chrome.windows.getCurrent((win) => {
            if (win && win.id) {
              chrome.sidePanel.open({ windowId: win.id }).catch(console.error);
            }
          });
        }
      }
      sendResponse({ success: true });
      break;
    }

    // --- Accessibility / Screen Narrator & TTS Actions ---
    case 'NARRATE_SCREEN': {
      handleNarrateScreen()
        .then((res) => sendResponse({ success: true, ...res }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;
    }

    case 'READ_PAGE_TEXT': {
      handleReadPageText()
        .then((res) => sendResponse({ success: true, ...res }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;
    }

    case 'READ_SELECTION': {
      handleReadSelection()
        .then((res) => sendResponse({ success: true, ...res }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;
    }

    case 'GET_TTS_STATE': {
      sendResponse({ ...ttsState });
      break;
    }

    case 'GET_TTS_VOICES': {
      chrome.tts.getVoices((voices) => {
        sendResponse({ voices: voices || [] });
      });
      return true;
    }

    case 'TTS_PLAY_TEXT': {
      if (message.text) {
        speakText(message.text, { source: message.source || 'manual' });
        sendResponse({ success: true });
      }
      break;
    }

    case 'TTS_SPEAK_SNIPPET': {
      if (message.text) {
        // Fast snippet speech for hover reader
        speakText(message.text, { source: 'hover', enqueue: false });
      }
      break;
    }

    case 'TTS_PAUSE': {
      pauseTTS();
      sendResponse({ success: true });
      break;
    }

    case 'TTS_RESUME': {
      resumeTTS();
      sendResponse({ success: true });
      break;
    }

    case 'TTS_STOP': {
      stopTTS();
      sendResponse({ success: true });
      break;
    }

    case 'TOGGLE_HOVER_READER': {
      toggleHoverReader(message.enabled)
        .then((enabled) => sendResponse({ success: true, enabled }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;
    }

    case 'UPDATE_HOVER_READER_STATE': {
      ttsState.hoverReaderEnabled = !!message.enabled;
      broadcast('TTS_STATE_CHANGED', { ttsState: { ...ttsState } });
      break;
    }

    // --- Messages coming from Offscreen Document ---
    case 'NEW_TRANSCRIPT_SEGMENT': {
      if (message.segment && message.segment.text) {
        // Defensive check: Do not store or broadcast if identical to previous segment
        const last = state.transcripts[state.transcripts.length - 1];
        if (last && normalizeForComparison(last.text) === normalizeForComparison(message.segment.text)) {
          break;
        }

        state.transcripts.push(message.segment);
        broadcast('NEW_TRANSCRIPT_SEGMENT', { segment: message.segment });
      }
      break;
    }

    case 'AUDIO_LEVEL': {
      state.audioLevel = message.level || 0;
      state.isSpeaking = !!message.isSpeaking;
      broadcast('AUDIO_LEVEL', {
        level: state.audioLevel,
        isSpeaking: state.isSpeaking
      });
      break;
    }

    case 'TRANSCRIPTION_STATE': {
      state.transcriptionState = message.state || 'idle';
      broadcast('TRANSCRIPTION_STATE', { state: state.transcriptionState });
      break;
    }

    case 'CAPTURE_STATUS': {
      if (message.status === 'active') {
        state.isCapturing = true;
        updateBadge(true);
      } else if (message.status === 'stopped') {
        state.isCapturing = false;
        updateBadge(false);
      }
      broadcast('STATE_CHANGED', { state: { ...state } });
      break;
    }

    case 'CAPTURE_ERROR': {
      state.lastError = message.error;
      broadcast('CAPTURE_ERROR', { error: message.error });
      break;
    }

    case 'STREAM_ENDED_BY_USER': {
      handleStopCapture();
      broadcast('CAPTURE_ERROR', { error: 'Audio capture was stopped by user or tab was closed.' });
      break;
    }
  }

  return true;
});

/**
 * Initiates tab capture
 */
async function handleStartCapture(explicitTabId) {
  let targetTab;

  if (explicitTabId) {
    targetTab = await chrome.tabs.get(explicitTabId).catch(() => null);
  }

  if (!targetTab) {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    targetTab = tabs[0];
  }

  if (!targetTab || !targetTab.id) {
    throw new Error('No active browser tab found to capture audio from.');
  }

  // Check if tab is a chrome internal URL
  if (targetTab.url && (targetTab.url.startsWith('chrome://') || targetTab.url.startsWith('chrome-extension://'))) {
    throw new Error('Chrome does not allow capturing audio from internal browser pages. Please open a website like YouTube, Spotify, or any video/audio page.');
  }

  // 1. Get media stream ID from tabCapture
  const streamId = await new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: targetTab.id }, (id) => {
      if (chrome.runtime.lastError) {
        return reject(new Error(chrome.runtime.lastError.message));
      }
      if (!id) {
        return reject(new Error('Failed to obtain stream ID for tab.'));
      }
      resolve(id);
    });
  });

  // 2. Ensure offscreen document is alive
  await ensureOffscreenDocument();

  // 3. Load user settings
  const storage = await chrome.storage.local.get('sightscribe_settings');
  const settings = storage.sightscribe_settings || DEFAULT_SETTINGS;

  // 4. Update internal state
  state.isCapturing = true;
  state.capturedTabId = targetTab.id;
  state.capturedTabTitle = targetTab.title || 'Active Tab';
  state.capturedTabFavicon = targetTab.favIconUrl || '';
  state.lastError = null;
  updateBadge(true);

  // 5. Send start command to offscreen document
  chrome.runtime.sendMessage({
    target: 'offscreen',
    action: 'START_STREAM',
    streamId,
    settings
  });

  broadcast('STATE_CHANGED', { state: { ...state } });
}

/**
 * Stops tab capture
 */
async function handleStopCapture() {
  state.isCapturing = false;
  state.audioLevel = 0;
  state.isSpeaking = false;
  state.transcriptionState = 'idle';
  updateBadge(false);

  chrome.runtime.sendMessage({
    target: 'offscreen',
    action: 'STOP_STREAM'
  }).catch(() => {});

  broadcast('STATE_CHANGED', { state: { ...state } });
}

// Clean up if captured tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  if (state.isCapturing && state.capturedTabId === tabId) {
    handleStopCapture();
    broadcast('CAPTURE_ERROR', { error: 'The captured tab was closed.' });
  }
});

/* =========================================================================
 * ACCESSIBILITY & TEXT-TO-SPEECH (TTS) CONTROLLER
 * ========================================================================= */

/**
 * Handles screen narration generation and speech synthesis
 */
async function handleNarrateScreen() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const activeTab = tabs[0];
  if (!activeTab || !activeTab.id) {
    throw new Error('No active browser tab found to narrate.');
  }

  broadcast('NARRATION_STATUS', { status: 'analyzing', message: 'Analyzing screen visual layout...' });

  // 1. Capture screen snapshot (jpeg base64)
  let screenshotBase64 = null;
  try {
    screenshotBase64 = await chrome.tabs.captureVisibleTab(null, { format: 'jpeg', quality: 65 });
  } catch (err) {
    console.warn('Could not capture visible tab snapshot:', err.message);
  }

  // 2. Request DOM summary from content script
  let domSummary = {
    title: activeTab.title || '',
    url: activeTab.url || '',
    domain: activeTab.url ? new URL(activeTab.url).hostname : ''
  };

  try {
    const response = await chrome.tabs.sendMessage(activeTab.id, { action: 'GET_PAGE_SUMMARY' });
    if (response && response.summary) {
      domSummary = response.summary;
    }
  } catch (err) {
    console.warn('Could not contact content script for page summary:', err.message);
  }

  // 3. Retrieve settings
  const storage = await chrome.storage.local.get('sightscribe_settings');
  const settings = storage.sightscribe_settings || DEFAULT_SETTINGS;

  // 4. Generate screen narration (AI vision or structured DOM synthesis)
  const result = await generateScreenNarration({ screenshotBase64, domSummary, settings });
  const narrationText = result.narration;

  ttsState.lastNarrationText = narrationText;
  broadcast('NARRATION_STATUS', {
    status: 'ready',
    narration: narrationText,
    source: result.source
  });

  // 5. Speak narration aloud
  speakText(narrationText, { source: 'narration' });

  return { narration: narrationText, source: result.source };
}

/**
 * Handles reading the main text on the active webpage out loud
 */
async function handleReadPageText() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const activeTab = tabs[0];
  if (!activeTab || !activeTab.id) {
    throw new Error('No active browser tab found.');
  }

  let textToRead = '';
  try {
    const response = await chrome.tabs.sendMessage(activeTab.id, { action: 'GET_PAGE_TEXT' });
    if (response && response.text) {
      textToRead = response.text;
    }
  } catch (err) {
    throw new Error('Please refresh this webpage to allow SightScribe to read the text.');
  }

  if (!textToRead || textToRead.trim().length < 5) {
    throw new Error('No readable text found on this page.');
  }

  ttsState.lastPageText = textToRead;
  broadcast('PAGE_TEXT_READY', { text: textToRead });

  // Speak out loud
  speakText(textToRead, { source: 'page_text', activeTabId: activeTab.id });
  return { text: textToRead };
}

/**
 * Handles reading selected text out loud
 */
async function handleReadSelection() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const activeTab = tabs[0];
  if (!activeTab || !activeTab.id) {
    throw new Error('No active browser tab found.');
  }

  const response = await chrome.tabs.sendMessage(activeTab.id, { action: 'GET_SELECTION_TEXT' });
  const selected = response ? response.selectedText : '';

  if (!selected || selected.trim().length === 0) {
    throw new Error('No text is currently selected on this page. Highlight some text with your mouse or cursor first.');
  }

  speakText(selected, { source: 'selection', activeTabId: activeTab.id });
  return { text: selected };
}

/**
 * Toggles Hover-To-Read Interactive Screen Reader Mode
 */
async function toggleHoverReader(desiredState) {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const activeTab = tabs[0];
  if (!activeTab || !activeTab.id) {
    throw new Error('No active browser tab found.');
  }

  const nextState = desiredState !== undefined ? desiredState : !ttsState.hoverReaderEnabled;
  try {
    await chrome.tabs.sendMessage(activeTab.id, {
      action: 'TOGGLE_HOVER_READER',
      enabled: nextState
    });
  } catch (err) {
    throw new Error('Please refresh this tab to enable the interactive screen reader.');
  }

  ttsState.hoverReaderEnabled = nextState;
  broadcast('TTS_STATE_CHANGED', { ttsState: { ...ttsState } });
  return nextState;
}

/**
 * Speaks text using Chrome TTS API
 */
async function speakText(text, options = {}) {
  if (!text || text.trim() === '') return;

  const storage = await chrome.storage.local.get('sightscribe_tts_settings');
  const ttsSettings = storage.sightscribe_tts_settings || DEFAULT_TTS_SETTINGS;

  // Stop any currently active speech before starting new sentence
  chrome.tts.stop();

  ttsState.isSpeaking = true;
  ttsState.isPaused = false;
  ttsState.currentText = text;
  ttsState.source = options.source || 'manual';
  ttsState.progressPercent = 0;
  broadcast('TTS_STATE_CHANGED', { ttsState: { ...ttsState } });

  const speakOptions = {
    rate: ttsSettings.rate || 1.0,
    pitch: ttsSettings.pitch || 1.0,
    enqueue: false,
    onEvent: (event) => {
      switch (event.type) {
        case 'start':
          ttsState.isSpeaking = true;
          ttsState.isPaused = false;
          broadcast('TTS_STATE_CHANGED', { ttsState: { ...ttsState } });
          break;

        case 'word':
          if (event.charIndex !== undefined && text.length > 0) {
            ttsState.progressPercent = Math.min(100, Math.round((event.charIndex / text.length) * 100));
            broadcast('TTS_PROGRESS', {
              charIndex: event.charIndex,
              progressPercent: ttsState.progressPercent
            });
          }
          break;

        case 'end':
        case 'interrupted':
        case 'cancelled':
        case 'error':
          ttsState.isSpeaking = false;
          ttsState.isPaused = false;
          ttsState.progressPercent = 100;
          broadcast('TTS_STATE_CHANGED', { ttsState: { ...ttsState } });
          break;
      }
    }
  };

  if (ttsSettings.voiceName && ttsSettings.voiceName.trim() !== '') {
    speakOptions.voiceName = ttsSettings.voiceName.trim();
  }

  chrome.tts.speak(text, speakOptions);
}

function pauseTTS() {
  chrome.tts.pause();
  ttsState.isPaused = true;
  broadcast('TTS_STATE_CHANGED', { ttsState: { ...ttsState } });
}

function resumeTTS() {
  chrome.tts.resume();
  ttsState.isPaused = false;
  broadcast('TTS_STATE_CHANGED', { ttsState: { ...ttsState } });
}

function stopTTS() {
  chrome.tts.stop();
  ttsState.isSpeaking = false;
  ttsState.isPaused = false;
  ttsState.progressPercent = 0;
  broadcast('TTS_STATE_CHANGED', { ttsState: { ...ttsState } });
}
