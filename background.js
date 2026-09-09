/**
 * SightScribe - Background Service Worker (Manifest V3)
 * Manages audio capture lifecycle, offscreen document orchestration,
 * side panel coordination, and transcript state distribution.
 */

import { normalizeForComparison } from './utils/text-dedup.js';

const OFFSCREEN_DOCUMENT_PATH = 'offscreen/offscreen.html';

// In-memory state (backed by storage.session where applicable)
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
