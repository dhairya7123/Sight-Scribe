# 🎙️ SightScribe - Live Video & Audio Captions Browser Extension

**SightScribe** is a high-performance Chrome / Chromium extension (Manifest V3) that listens to audio playing in any browser tab (songs, YouTube videos, Spotify Web, Netflix, podcasts, lectures, Twitter/X clips) and generates **real-time AI captions and live transcripts** in a persistent side panel.

---

## ✨ Features

- **Hear Any Tab Audio**: Captures internal tab audio using Chrome's native `tabCapture` API without needing a microphone or external cables.
- **Uninterrupted Speaker Passthrough**: Connects audio directly through Web Audio API passthrough so you can keep listening to your music or video through your speakers/headphones with zero lag or muting.
- **Blazing Fast AI Transcription**:
  - **Groq Whisper Turbo (`whisper-large-v3-turbo`)**: Sub-500ms latency, free tier with no credit card required.
  - **OpenAI Whisper (`whisper-1`)**: Industry-standard high accuracy.
  - **Custom OpenAI-compatible endpoints**: Support for local AI servers (Faster-Whisper, vLLM, LocalAI).
- **Persistent Side Panel**:
  - Seamlessly sits alongside any web page or video.
  - Live auto-scrolling caption cards with timestamps `[MM:SS]`.
  - Floating "Jump to live" toggle if you scroll back to read lyrics.
- **Live Animated Equalizer**: Real-time 28-band visualizer that reacts to the beat of songs and voices.
- **Voice Activity Detection (VAD) & Silence Filtering**:
  - Automatically suppresses API calls during song breaks or video pauses to eliminate hallucinated captions and save your API quota.
- **Full Subtitle & Transcript Exporter**:
  - **Download .SRT**: Standard SubRip subtitles with millisecond-accurate timing (`00:01:23,456 --> 00:01:27,000`).
  - **Download .TXT**: Formatted transcript with timestamps.
  - **Copy All / Copy Line**: Single-click clipboard actions.
- **Real-time Search Filter**: Instantly search through transcribed song lyrics or spoken phrases.
- **Multilingual**: Supports automatic language detection or explicit translation across 30+ languages (English, Spanish, French, German, Japanese, Chinese, Hindi, etc.).

---

## 🚀 Installation Guide

### 1. Load the Extension into Chrome / Brave / Edge
1. Open Chrome and navigate to `chrome://extensions` (or `brave://extensions`, `edge://extensions`).
2. Enable **Developer mode** using the toggle in the top-right corner.
3. Click **Load unpacked**.
4. Select the directory:
   ```
   E:\SightScribe
   ```
5. SightScribe is now installed! Pin it to your Chrome toolbar for easy access.

---

## 🔑 Getting a Free Groq API Key (30 Seconds)

Groq provides free, ultra-fast access to OpenAI's Whisper model (`whisper-large-v3-turbo`), transcribing audio in real time:

1. Visit [https://console.groq.com/keys](https://console.groq.com/keys).
2. Sign in with your Google or GitHub account (no credit card required).
3. Click **Create API Key**.
4. Copy your key (`gsk_...`).
5. Open the **SightScribe** popup, paste the key into the **API Key** field, and click **Save Settings**.
6. You can click **Test Connection** to verify that your key is active.

*(Optional: You can also use an OpenAI API key from [platform.openai.com](https://platform.openai.com/api-keys) if preferred).*

---

## 🎧 How to Use SightScribe

1. **Open any tab** with audio playing (e.g. YouTube, Spotify Web, Netflix, SoundCloud, Twitter/X).
2. Click the **SightScribe** extension icon in your toolbar.
3. Click **Open Side Panel Transcript** to dock the live captions alongside your video.
4. Click **Start Captions**.
5. As audio plays, watch the real-time audio visualizer bounce and read live timestamped captions!
6. Click **SRT** or **TXT** at any time to export the transcript.

---

## 🛠️ Project Structure

```
SightScribe/
├── manifest.json            # Manifest V3 configuration & permissions
├── background.js            # Background service worker (state & stream routing)
├── offscreen/
│   ├── offscreen.html       # Offscreen DOM context for Web Audio
│   └── offscreen.js         # PCM audio capture, passthrough, VAD & Whisper API
├── sidepanel/
│   ├── sidepanel.html       # Side panel layout & controls
│   ├── sidepanel.css        # Cyber-slate responsive dark theme
│   └── sidepanel.js         # Live feed, equalizer, search & export handlers
├── popup/
│   ├── popup.html           # Toolbar popup modal
│   ├── popup.css            # Popup styling & responsive form controls
│   └── popup.js             # Start/Stop toggle, key verification & settings
├── utils/
│   ├── audio-helpers.js     # 16kHz downsampler, 16-bit WAV encoder, RMS/VAD
│   └── srt-generator.js     # SRT subtitle generator & TXT exporter
├── icons/
│   ├── icon.svg             # Vector soundwave & caption icon
│   ├── icon16.png
│   ├── icon32.png
│   ├── icon48.png
│   └── icon128.png
└── README.md                # Documentation & quickstart guide
```

---

## 🔒 Privacy & Permissions
SightScribe processes audio strictly from the specific tab you choose to caption. Tab audio is converted into short PCM WAV slices and dispatched directly to your chosen Whisper endpoint (Groq or OpenAI) using your personal API key. Audio is never stored or routed through any third-party intermediary servers.
