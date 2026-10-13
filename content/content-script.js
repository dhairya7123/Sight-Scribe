/**
 * SightScribe - Content Script for Web Accessibility
 * Extracts screen structure & text, supports hover-to-read interactive screen reader,
 * and highlights active speech for visually challenged and low-vision users.
 */

(function () {
  // Prevent duplicate script injection
  if (window.__sightscribe_content_injected) return;
  window.__sightscribe_content_injected = true;

  let isHoverReaderActive = false;
  let lastHoveredElement = null;
  let hoverDebounceTimer = null;
  let indicatorElement = null;

  /**
   * Listen for messages from background worker, popup, or sidepanel
   */
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.action) {
      case 'GET_PAGE_SUMMARY': {
        const summary = extractPageSummary();
        sendResponse({ success: true, summary });
        break;
      }

      case 'GET_PAGE_TEXT': {
        const extracted = extractPageReadableText();
        sendResponse({ success: true, ...extracted });
        break;
      }

      case 'GET_SELECTION_TEXT': {
        const selected = window.getSelection() ? window.getSelection().toString().trim() : '';
        sendResponse({ success: true, selectedText: selected });
        break;
      }

      case 'TOGGLE_HOVER_READER': {
        setHoverReaderMode(message.enabled !== undefined ? message.enabled : !isHoverReaderActive);
        sendResponse({ success: true, enabled: isHoverReaderActive });
        break;
      }

      case 'STOP_READER': {
        setHoverReaderMode(false);
        clearAllHighlights();
        sendResponse({ success: true });
        break;
      }

      case 'HIGHLIGHT_TEXT_SNIPPET': {
        highlightSnippet(message.text);
        sendResponse({ success: true });
        break;
      }
    }
    return true;
  });

  /**
   * Extracts page structure, landmarks, headings, images, and controls for Screen Narration
   */
  function extractPageSummary() {
    const title = document.title || '';
    const url = window.location.href;
    const domain = window.location.hostname;

    // Meta description
    let description = '';
    const metaDesc = document.querySelector('meta[name="description"]') || document.querySelector('meta[property="og:description"]');
    if (metaDesc) {
      description = metaDesc.getAttribute('content') || '';
    }

    // Check for playing or visible videos
    const videos = document.querySelectorAll('video');
    const hasVideo = videos.length > 0;

    // Headings (H1 to H3)
    const headings = [];
    document.querySelectorAll('h1, h2, h3').forEach((h) => {
      const text = h.innerText.trim();
      if (text && text.length > 2 && text.length < 150) {
        headings.push({ tag: h.tagName.toLowerCase(), text });
      }
    });

    // Key images with alt or aria-label
    const images = [];
    document.querySelectorAll('img[alt], [role="img"]').forEach((img) => {
      const alt = (img.getAttribute('alt') || img.getAttribute('aria-label') || '').trim();
      if (alt && alt.length > 3 && alt.length < 200 && isElementVisible(img)) {
        images.push({ alt });
      }
    });

    // Interactive forms & inputs
    const forms = [];
    const searchInputs = document.querySelectorAll('input[type="search"], input[name*="search" i], input[placeholder*="search" i]');
    if (searchInputs.length > 0) {
      forms.push({ purpose: 'search bar' });
    }
    const loginInputs = document.querySelectorAll('input[type="password"]');
    if (loginInputs.length > 0) {
      forms.push({ purpose: 'login form' });
    }

    // First paragraphs of readable content
    const paragraphs = [];
    const mainContainer = document.querySelector('main, article, [role="main"]') || document.body;
    mainContainer.querySelectorAll('p').forEach((p) => {
      const text = p.innerText.trim();
      if (text && text.length > 30 && isElementVisible(p)) {
        paragraphs.push(text);
      }
    });

    return {
      title,
      url,
      domain,
      description,
      hasVideo,
      headings: headings.slice(0, 8),
      images: images.slice(0, 6),
      forms: forms.slice(0, 3),
      paragraphs: paragraphs.slice(0, 5)
    };
  }

  /**
   * Extracts clean, readable text from the main page body, stripping ads and nav clutter
   */
  function extractPageReadableText() {
    // 1. Check if user currently has text selected
    const selected = window.getSelection() ? window.getSelection().toString().trim() : '';
    if (selected && selected.length > 10) {
      return {
        text: selected,
        source: 'selection',
        paragraphs: [selected]
      };
    }

    // 2. Identify primary content container
    const candidates = [
      document.querySelector('article'),
      document.querySelector('[role="main"]'),
      document.querySelector('main'),
      document.querySelector('.post-content, .article-content, .entry-content, #content'),
      document.body
    ];

    let contentRoot = candidates.find(el => el !== null) || document.body;

    // Clone root to avoid modifying live DOM
    const clone = contentRoot.cloneNode(true);

    // Strip out noise: scripts, styles, navigations, footers, headers, modals
    const junkSelectors = [
      'script', 'style', 'noscript', 'iframe', 'svg',
      'nav', 'footer', 'header', 'aside',
      '.navigation', '.nav', '.menu', '.sidebar',
      '.cookie-banner', '.ad', '.ads', '.advertisement',
      '[aria-hidden="true"]'
    ];

    junkSelectors.forEach(sel => {
      clone.querySelectorAll(sel).forEach(el => el.remove());
    });

    // Collect readable blocks
    const blocks = [];
    const blockElements = clone.querySelectorAll('h1, h2, h3, h4, p, li, blockquote');

    if (blockElements.length > 0) {
      blockElements.forEach(el => {
        const text = el.textContent.trim().replace(/\s+/g, ' ');
        if (text && text.length > 15) {
          blocks.push(text);
        }
      });
    }

    // Fallback if structured blocks were empty
    if (blocks.length === 0) {
      const rawText = clone.textContent.trim().replace(/\s+/g, ' ');
      if (rawText) {
        blocks.push(rawText);
      }
    }

    const fullText = blocks.join('\n\n');
    return {
      text: fullText,
      source: 'page_body',
      paragraphs: blocks
    };
  }

  /**
   * Toggles Interactive Screen Reader / Hover-To-Read Mode
   */
  function setHoverReaderMode(enable) {
    isHoverReaderActive = enable;

    if (isHoverReaderActive) {
      document.addEventListener('mouseover', handleMouseOver, true);
      document.addEventListener('keydown', handleTabNavigation, true);
      showIndicator();
      // Announce mode activation via TTS
      chrome.runtime.sendMessage({
        action: 'TTS_SPEAK_SNIPPET',
        text: 'SightScribe Screen Reader mode enabled. Hover or tab over any element to hear it.'
      });
    } else {
      document.removeEventListener('mouseover', handleMouseOver, true);
      document.removeEventListener('keydown', handleTabNavigation, true);
      removeIndicator();
      clearFocusOutline();
    }
  }

  function handleMouseOver(e) {
    if (!isHoverReaderActive) return;

    const target = e.target;
    if (!target || target === document.body || target === document.documentElement) return;
    if (target.closest('#sightscribe-sr-indicator')) return;

    // Debounce to prevent audio barrage
    clearTimeout(hoverDebounceTimer);
    hoverDebounceTimer = setTimeout(() => {
      focusAndSpeakElement(target);
    }, 120);
  }

  function handleTabNavigation(e) {
    if (!isHoverReaderActive || e.key !== 'Tab') return;
    setTimeout(() => {
      const focused = document.activeElement;
      if (focused && focused !== document.body) {
        focusAndSpeakElement(focused);
      }
    }, 50);
  }

  function focusAndSpeakElement(el) {
    if (lastHoveredElement) {
      lastHoveredElement.classList.remove('sightscribe-sr-focused');
    }
    lastHoveredElement = el;
    el.classList.add('sightscribe-sr-focused');

    const accessibleDescription = getElementAccessibleLabel(el);
    if (accessibleDescription) {
      chrome.runtime.sendMessage({
        action: 'TTS_SPEAK_SNIPPET',
        text: accessibleDescription
      });
    }
  }

  function clearFocusOutline() {
    if (lastHoveredElement) {
      lastHoveredElement.classList.remove('sightscribe-sr-focused');
      lastHoveredElement = null;
    }
  }

  /**
   * Constructs an accessible description of an element for blind/low-vision users
   */
  function getElementAccessibleLabel(el) {
    // 1. Aria label
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();

    // 2. Images
    if (el.tagName === 'IMG') {
      const alt = el.getAttribute('alt');
      return alt && alt.trim() ? `Image: ${alt.trim()}` : 'Image without description';
    }

    // 3. Links and Buttons
    const role = el.getAttribute('role') || el.tagName.toLowerCase();
    const isInteractive = ['a', 'button', 'input', 'select', 'textarea'].includes(el.tagName.toLowerCase());

    const text = el.innerText ? el.innerText.trim() : (el.value || '');
    if (!text && isInteractive) {
      const title = el.getAttribute('title') || el.getAttribute('placeholder');
      if (title) return `${role}: ${title}`;
      return `${role}`;
    }

    if (text) {
      // Keep description concise if element has giant paragraphs
      const preview = text.length > 200 ? `${text.slice(0, 200)}...` : text;
      if (isInteractive) {
        return `${role}: ${preview}`;
      }
      return preview;
    }

    return null;
  }

  function isElementVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }

  function clearAllHighlights() {
    document.querySelectorAll('.sightscribe-reading-highlight').forEach(el => {
      el.classList.remove('sightscribe-reading-highlight');
    });
    clearFocusOutline();
  }

  function highlightSnippet(text) {
    clearAllHighlights();
    if (!text || text.length < 5) return;

    // Find element containing text
    const cleanSnippet = text.trim().slice(0, 50).toLowerCase();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.nodeValue && node.nodeValue.toLowerCase().includes(cleanSnippet)) {
        const parent = node.parentElement;
        if (parent && isElementVisible(parent)) {
          parent.classList.add('sightscribe-reading-highlight');
          parent.scrollIntoView({ behavior: 'smooth', block: 'center' });
          break;
        }
      }
    }
  }

  function showIndicator() {
    if (indicatorElement) return;
    indicatorElement = document.createElement('div');
    indicatorElement.id = 'sightscribe-sr-indicator';
    indicatorElement.innerHTML = `
      <span class="sr-pulse"></span>
      <span>SightScribe Screen Reader Active</span>
      <button class="sr-close-btn" title="Turn off screen reader">&times;</button>
    `;
    indicatorElement.querySelector('.sr-close-btn').addEventListener('click', () => {
      setHoverReaderMode(false);
      chrome.runtime.sendMessage({
        action: 'UPDATE_HOVER_READER_STATE',
        enabled: false
      });
    });
    document.body.appendChild(indicatorElement);
  }

  function removeIndicator() {
    if (indicatorElement) {
      indicatorElement.remove();
      indicatorElement = null;
    }
  }

  // Keyboard accessibility shortcuts
  window.addEventListener('keydown', (e) => {
    // Alt + Shift + N = Narrate Screen
    if (e.altKey && e.shiftKey && (e.key === 'N' || e.key === 'n')) {
      e.preventDefault();
      chrome.runtime.sendMessage({ action: 'NARRATE_SCREEN' });
    }
    // Alt + Shift + R = Read Screen Text Out Loud
    if (e.altKey && e.shiftKey && (e.key === 'R' || e.key === 'r')) {
      e.preventDefault();
      chrome.runtime.sendMessage({ action: 'READ_PAGE_TEXT' });
    }
    // Alt + Shift + S = Stop Speech
    if (e.altKey && e.shiftKey && (e.key === 'S' || e.key === 's')) {
      e.preventDefault();
      chrome.runtime.sendMessage({ action: 'TTS_STOP' });
    }
  });

})();
