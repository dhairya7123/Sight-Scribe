/**
 * SightScribe - Background Service Worker (Manifest V3)
 * Manages audio capture lifecycle, offscreen document orchestration,
 * side panel coordination, transcript state distribution, and
 * tab content Screen Reader with keyboard shortcuts.
 */

import { normalizeForComparison } from './utils/text-dedup.js';
import {
  splitTextIntoChunks,
  inPageExtractContents,
  inPageShowBanner,
  inPageHideBanner
} from './utils/screen-reader.js';

const OFFSCREEN_DOCUMENT_PATH = 'offscreen/offscreen.html';

// In-memory state for captions (backed by storage.session where applicable)
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

// In-memory state for screen reader
let screenReaderState = {
  isReading: false,
  tabId: null,
  title: '',
  totalChunks: 0,
  currentChunkIndex: 0
};
let ttsQueue = [];
let ttsQueueIndex = 0;

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

// Initialize settings and side panel behavior
chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get('sightscribe_settings');
  if (!existing.sightscribe_settings) {
    await chrome.storage.local.set({ sightscribe_settings: DEFAULT_SETTINGS });
  }

  // Ensure side panel is available across browser
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
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
  } else if (screenReaderState.isReading) {
    chrome.action.setBadgeText({ text: 'READ' });
    chrome.action.setBadgeBackgroundColor({ color: '#0284c7' });
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
    case 'GET_STATE': {
      sendResponse({ ...state });
      break;
    }

    case 'START_CAPTURE': {
      handleStartCapture(message.tabId)
        .then(() => sendResponse({ success: true }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true; // Keep response channel open
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

    // --- Screen Reader Controls ---
    case 'TOGGLE_SCREEN_READER': {
      handleToggleScreenReader(message.tabId)
        .then((res) => sendResponse(res))
        .catch((err) => sendResponse({ active: false, error: err.message }));
      return true;
    }

    case 'STOP_SCREEN_READER': {
      handleStopScreenReader()
        .then((res) => sendResponse(res))
        .catch((err) => sendResponse({ active: false, error: err.message }));
      return true;
    }

    case 'GET_SCREEN_READER_STATE': {
      sendResponse({ ...screenReaderState });
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
 * Keyboard shortcuts listener
 */
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle_screen_reader') {
    await handleToggleScreenReader();
  } else if (command === 'stop_screen_reader') {
    await handleStopScreenReader();
  }
});

/**
 * Initiates tab capture for captions
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

/**
 * Toggles the Screen Reader for the active browser tab
 */
async function handleToggleScreenReader(targetTabId = null) {
  if (screenReaderState.isReading) {
    await handleStopScreenReader();
    return { active: false };
  }
  return await handleStartScreenReader(targetTabId);
}

/**
 * Starts reading the active browser tab out loud
 */
async function handleStartScreenReader(explicitTabId = null) {
  let targetTab;
  if (explicitTabId) {
    targetTab = await chrome.tabs.get(explicitTabId).catch(() => null);
  }
  if (!targetTab) {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    targetTab = tabs[0];
  }

  if (!targetTab || !targetTab.id) {
    speakOneOffNotice('No active browser tab found to read.');
    return { active: false, error: 'No active tab' };
  }

  // Check for restricted browser pages
  if (targetTab.url && (
    targetTab.url.startsWith('chrome://') ||
    targetTab.url.startsWith('chrome-extension://') ||
    targetTab.url.startsWith('edge://') ||
    targetTab.url.startsWith('about:') ||
    targetTab.url.startsWith('view-source:')
  )) {
    speakOneOffNotice('Cannot read internal browser pages. Please navigate to any webpage to use the screen reader.');
    return { active: false, error: 'Restricted page' };
  }

  // Stop any previous utterance
  try {
    chrome.tts.stop();
  } catch (e) {}

  // Extract visible content from active tab
  let extracted = null;
  try {
    const injectionResults = await chrome.scripting.executeScript({
      target: { tabId: targetTab.id },
      func: inPageExtractContents
    });
    if (injectionResults && injectionResults[0] && injectionResults[0].result) {
      extracted = injectionResults[0].result;
    }
  } catch (err) {
    console.warn('Script execution error:', err);
    speakOneOffNotice('Cannot access page content. Please refresh the page and try again.');
    return { active: false, error: err.message };
  }

  if (!extracted || (!extracted.text && !extracted.title)) {
    speakOneOffNotice('No readable text found on this tab.');
    return { active: false, error: 'No text' };
  }

  // Build utterance queue
  const titleIntro = `Reading webpage: ${extracted.title || 'Untitled'}.`;
  const contentChunks = splitTextIntoChunks(extracted.text);

  ttsQueue = [titleIntro, ...contentChunks];
  ttsQueueIndex = 0;

  screenReaderState.isReading = true;
  screenReaderState.tabId = targetTab.id;
  screenReaderState.title = extracted.title || 'Webpage';
  screenReaderState.totalChunks = ttsQueue.length;
  screenReaderState.currentChunkIndex = 0;

  // Show floating indicator on tab
  chrome.scripting.executeScript({
    target: { tabId: targetTab.id },
    func: inPageShowBanner,
    args: ['🔊 SightScribe: Reading tab... (Alt+Shift+R to stop)']
  }).catch(() => {});

  updateBadge(state.isCapturing);
  broadcast('SCREEN_READER_STATE_CHANGED', { state: { ...screenReaderState } });

  speakNextChunk();
  return { active: true };
}

/**
 * Stops screen reader playback
 */
async function handleStopScreenReader() {
  screenReaderState.isReading = false;
  ttsQueue = [];
  ttsQueueIndex = 0;

  try {
    chrome.tts.stop();
  } catch (e) {}

  if (screenReaderState.tabId) {
    chrome.scripting.executeScript({
      target: { tabId: screenReaderState.tabId },
      func: inPageHideBanner
    }).catch(() => {});
  }

  screenReaderState.tabId = null;
  updateBadge(state.isCapturing);
  broadcast('SCREEN_READER_STATE_CHANGED', { state: { ...screenReaderState } });
  return { active: false };
}

/**
 * Sequential chunk speech loop for Chrome TTS
 */
function speakNextChunk() {
  if (!screenReaderState.isReading || ttsQueueIndex >= ttsQueue.length) {
    handleStopScreenReader();
    return;
  }

  const chunk = ttsQueue[ttsQueueIndex];
  screenReaderState.currentChunkIndex = ttsQueueIndex;

  chrome.tts.speak(chunk, {
    rate: 1.0,
    enqueue: false,
    onEvent: (event) => {
      if (!screenReaderState.isReading) return;

      if (event.type === 'end') {
        ttsQueueIndex++;
        speakNextChunk();
      } else if (event.type === 'error' || event.type === 'interrupted' || event.type === 'cancelled') {
        if (event.type === 'error') {
          console.warn('TTS playback error:', event);
          ttsQueueIndex++;
          speakNextChunk();
        }
      }
    }
  });
}

/**
 * Speaks a brief one-off announcement
 */
function speakOneOffNotice(text) {
  try {
    chrome.tts.stop();
    chrome.tts.speak(text, { rate: 1.0 });
  } catch (e) {}
}

// Clean up if closed tab was captured or being read
chrome.tabs.onRemoved.addListener((tabId) => {
  if (state.isCapturing && state.capturedTabId === tabId) {
    handleStopCapture();
    broadcast('CAPTURE_ERROR', { error: 'The captured tab was closed.' });
  }
  if (screenReaderState.isReading && screenReaderState.tabId === tabId) {
    handleStopScreenReader();
  }
});
