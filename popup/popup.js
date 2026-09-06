/**
 * SightScribe - Popup Application Logic
 * Quick start/stop toggle, side panel opener, and AI engine configuration.
 */

// DOM Elements
const toggleBtn = document.getElementById('toggleBtn');
const toggleBtnText = document.getElementById('toggleBtnText');
const toggleBtnSub = document.getElementById('toggleBtnSub');
const iconPlay = toggleBtn.querySelector('.icon-play');
const iconStop = toggleBtn.querySelector('.icon-stop');
const statusBadge = document.getElementById('statusBadge');
const statusLabel = document.getElementById('statusLabel');
const openSidePanelBtn = document.getElementById('openSidePanelBtn');
const activeTabNotice = document.getElementById('activeTabNotice');
const popupFavicon = document.getElementById('popupFavicon');
const popupTabTitle = document.getElementById('popupTabTitle');

const toggleSettingsBtn = document.getElementById('toggleSettingsBtn');
const settingsChevron = document.getElementById('settingsChevron');
const settingsBody = document.getElementById('settingsBody');

const providerSelect = document.getElementById('providerSelect');
const apiKeyInput = document.getElementById('apiKeyInput');
const apiKeyLink = document.getElementById('apiKeyLink');
const toggleKeyVisibilityBtn = document.getElementById('toggleKeyVisibilityBtn');
const testApiKeyBtn = document.getElementById('testApiKeyBtn');
const testKeyStatus = document.getElementById('testKeyStatus');

const modelSelect = document.getElementById('modelSelect');
const customEndpointGroup = document.getElementById('customEndpointGroup');
const customEndpointInput = document.getElementById('customEndpointInput');
const languageSelect = document.getElementById('languageSelect');
const chunkDurationRange = document.getElementById('chunkDurationRange');
const chunkDurationVal = document.getElementById('chunkDurationVal');
const vadThresholdRange = document.getElementById('vadThresholdRange');
const vadThresholdVal = document.getElementById('vadThresholdVal');
const saveSettingsBtn = document.getElementById('saveSettingsBtn');
const saveStatus = document.getElementById('saveStatus');
const popupToast = document.getElementById('popupToast');
const popupToastMessage = document.getElementById('popupToastMessage');

let isCapturing = false;
let currentSettings = {};

init();

async function init() {
  setupEventListeners();
  await loadSavedSettings();
  await loadState();
}

/**
 * Event Listeners
 */
function setupEventListeners() {
  toggleBtn.addEventListener('click', handleToggleCapture);
  openSidePanelBtn.addEventListener('click', handleOpenSidePanel);

  // Settings toggle
  toggleSettingsBtn.addEventListener('click', () => {
    settingsBody.classList.toggle('hidden');
    settingsChevron.classList.toggle('rotated');
  });

  // Engine switch
  providerSelect.addEventListener('change', handleProviderChange);

  // Toggle API key visibility
  toggleKeyVisibilityBtn.addEventListener('click', () => {
    const isPassword = apiKeyInput.type === 'password';
    apiKeyInput.type = isPassword ? 'text' : 'password';
  });

  // Test API key
  testApiKeyBtn.addEventListener('click', handleTestApiKey);

  // Range sliders
  chunkDurationRange.addEventListener('input', (e) => {
    chunkDurationVal.textContent = `${e.target.value}s`;
  });

  vadThresholdRange.addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    if (v < 0.005) vadThresholdVal.textContent = 'High Sensitivity';
    else if (v <= 0.012) vadThresholdVal.textContent = 'Normal';
    else vadThresholdVal.textContent = 'Strict';
  });

  // Save settings
  saveSettingsBtn.addEventListener('click', handleSaveSettings);

  // Background message listener
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'STATE_CHANGED' && message.state) {
      applyState(message.state);
    } else if (message.action === 'CAPTURE_ERROR') {
      showToast(message.error || 'Audio capture failed');
    }
  });
}

/**
 * Load settings from storage
 */
async function loadSavedSettings() {
  const storage = await chrome.storage.local.get('sightscribe_settings');
  currentSettings = storage.sightscribe_settings || {
    provider: 'groq',
    apiKey: '',
    model: 'whisper-large-v3-turbo',
    language: '',
    chunkDuration: 3.5,
    vadThreshold: 0.008,
    customEndpoint: 'http://localhost:8000/v1/audio/transcriptions'
  };

  providerSelect.value = currentSettings.provider || 'groq';
  apiKeyInput.value = currentSettings.apiKey || '';
  languageSelect.value = currentSettings.language || '';
  chunkDurationRange.value = currentSettings.chunkDuration || 3.5;
  chunkDurationVal.textContent = `${chunkDurationRange.value}s`;
  vadThresholdRange.value = currentSettings.vadThreshold || 0.008;

  const v = parseFloat(vadThresholdRange.value);
  if (v < 0.005) vadThresholdVal.textContent = 'High Sensitivity';
  else if (v <= 0.012) vadThresholdVal.textContent = 'Normal';
  else vadThresholdVal.textContent = 'Strict';

  customEndpointInput.value = currentSettings.customEndpoint || '';

  updateProviderUI(currentSettings.provider);
  modelSelect.value = currentSettings.model || 'whisper-large-v3-turbo';
}

/**
 * Load current capture state from background
 */
async function loadState() {
  try {
    const state = await chrome.runtime.sendMessage({ action: 'GET_STATE' });
    if (state) {
      applyState(state);
    }
  } catch (err) {
    console.warn('Could not get background state:', err);
  }
}

/**
 * Updates UI based on capture state
 */
function applyState(state) {
  isCapturing = state.isCapturing;

  if (isCapturing) {
    toggleBtn.className = 'btn-toggle stop';
    toggleBtnText.textContent = 'Stop Captions';
    toggleBtnSub.textContent = 'Recording tab audio...';
    iconPlay.classList.add('hidden');
    iconStop.classList.remove('hidden');

    statusBadge.className = 'status-badge listening';
    statusLabel.textContent = 'Listening';

    activeTabNotice.classList.remove('hidden');
    popupTabTitle.textContent = state.capturedTabTitle || 'Active Tab';
    if (state.capturedTabFavicon) {
      popupFavicon.src = state.capturedTabFavicon;
      popupFavicon.style.display = 'inline-block';
    } else {
      popupFavicon.style.display = 'none';
    }
  } else {
    toggleBtn.className = 'btn-toggle start';
    toggleBtnText.textContent = 'Start Captions';
    toggleBtnSub.textContent = 'Hear audio from current tab';
    iconPlay.classList.remove('hidden');
    iconStop.classList.add('hidden');

    statusBadge.className = 'status-badge idle';
    statusLabel.textContent = 'Idle';
    activeTabNotice.classList.add('hidden');
  }
}

/**
 * Handle Start/Stop toggle
 */
async function handleToggleCapture() {
  toggleBtn.disabled = true;

  try {
    if (!isCapturing) {
      const apiKey = apiKeyInput.value.trim();
      if (!apiKey) {
        showToast('Please enter your API Key below before starting.');
        // Expand settings drawer if closed
        settingsBody.classList.remove('hidden');
        settingsChevron.classList.add('rotated');
        apiKeyInput.focus();
        toggleBtn.disabled = false;
        return;
      }

      // Auto save if user typed key without saving
      await handleSaveSettings(false);

      const res = await chrome.runtime.sendMessage({ action: 'START_CAPTURE' });
      if (!res || !res.success) {
        showToast(res?.error || 'Failed to start audio capture.');
      }
    } else {
      await chrome.runtime.sendMessage({ action: 'STOP_CAPTURE' });
    }
  } catch (err) {
    showToast(err.message || 'Error communicating with background worker.');
  } finally {
    toggleBtn.disabled = false;
  }
}

/**
 * Open Chrome Side Panel
 */
async function handleOpenSidePanel() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const currentTab = tabs[0];
    if (currentTab && currentTab.windowId) {
      await chrome.runtime.sendMessage({
        action: 'OPEN_SIDEPANEL',
        windowId: currentTab.windowId
      });
    }
  } catch (err) {
    console.error('Error opening side panel:', err);
  }
}

/**
 * Updates UI when switching between Groq and OpenAI
 */
function handleProviderChange() {
  const provider = providerSelect.value;
  updateProviderUI(provider);
}

function updateProviderUI(provider) {
  modelSelect.innerHTML = '';

  if (provider === 'groq') {
    apiKeyLink.href = 'https://console.groq.com/keys';
    apiKeyLink.textContent = 'Get Free Groq Key ↗';
    apiKeyInput.placeholder = 'gsk_...';
    customEndpointGroup.classList.add('hidden');

    modelSelect.innerHTML = `
      <option value="whisper-large-v3-turbo">whisper-large-v3-turbo (Fastest & Free)</option>
      <option value="whisper-large-v3">whisper-large-v3 (Maximum Accuracy)</option>
    `;
  } else if (provider === 'openai') {
    apiKeyLink.href = 'https://platform.openai.com/api-keys';
    apiKeyLink.textContent = 'Get OpenAI Key ↗';
    apiKeyInput.placeholder = 'sk-...';
    customEndpointGroup.classList.add('hidden');

    modelSelect.innerHTML = `
      <option value="whisper-1">whisper-1 (OpenAI)</option>
    `;
  } else if (provider === 'custom') {
    apiKeyLink.href = '#';
    apiKeyLink.textContent = 'Local/Custom';
    apiKeyInput.placeholder = 'Optional API key...';
    customEndpointGroup.classList.remove('hidden');

    modelSelect.innerHTML = `
      <option value="whisper-1">whisper-1</option>
      <option value="whisper-large-v3">whisper-large-v3</option>
    `;
  }
}

/**
 * Tests connection to the selected Whisper API
 */
async function handleTestApiKey() {
  const provider = providerSelect.value;
  const key = apiKeyInput.value.trim();

  if (!key && provider !== 'custom') {
    testKeyStatus.className = 'test-status error';
    testKeyStatus.textContent = 'Key required';
    return;
  }

  testKeyStatus.className = 'test-status loading';
  testKeyStatus.textContent = 'Testing...';

  try {
    let url = '';
    if (provider === 'groq') {
      url = 'https://api.groq.com/openai/v1/models';
    } else if (provider === 'openai') {
      url = 'https://api.openai.com/v1/models';
    } else {
      url = customEndpointInput.value.trim() || 'http://localhost:8000/v1/models';
    }

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${key}`
      }
    });

    if (res.ok) {
      testKeyStatus.className = 'test-status success';
      testKeyStatus.textContent = '✓ Connected!';
    } else {
      testKeyStatus.className = 'test-status error';
      testKeyStatus.textContent = `✗ Failed (${res.status})`;
    }
  } catch (err) {
    testKeyStatus.className = 'test-status error';
    testKeyStatus.textContent = '✗ Connection error';
  }

  setTimeout(() => {
    testKeyStatus.textContent = '';
  }, 4000);
}

/**
 * Saves settings to Chrome local storage
 */
async function handleSaveSettings(showFeedback = true) {
  const newSettings = {
    provider: providerSelect.value,
    apiKey: apiKeyInput.value.trim(),
    model: modelSelect.value,
    language: languageSelect.value,
    chunkDuration: parseFloat(chunkDurationRange.value),
    vadThreshold: parseFloat(vadThresholdRange.value),
    customEndpoint: customEndpointInput.value.trim()
  };

  currentSettings = newSettings;
  await chrome.storage.local.set({ sightscribe_settings: newSettings });

  // Notify background/offscreen
  chrome.runtime.sendMessage({
    target: 'offscreen',
    action: 'UPDATE_SETTINGS',
    settings: newSettings
  }).catch(() => {});

  if (showFeedback) {
    saveStatus.textContent = '✓ Saved';
    setTimeout(() => {
      saveStatus.textContent = '';
    }, 2000);
  }
}

/**
 * Show temporary error toast
 */
function showToast(msg) {
  popupToastMessage.textContent = msg;
  popupToast.classList.remove('hidden');
  setTimeout(() => {
    popupToast.classList.add('hidden');
  }, 4500);
}
