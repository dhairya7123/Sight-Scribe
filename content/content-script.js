/**
 * SightScribe - In-Page Content Script
 * 1. Listens for in-page accessibility shortcuts (Alt+Shift+R to toggle, Alt+Shift+S / Esc to stop)
 * 2. Extracts only content currently visible in the user's viewport
 * 3. Displays a floating indicator banner while screen reader is speaking
 */

(function () {
  if (window.__sightscribe_reader_injected) return;
  window.__sightscribe_reader_injected = true;

  let isReadingActive = false;

  // 1. Keyboard Shortcut Listener (Capture phase to ensure precedence)
  window.addEventListener('keydown', (e) => {
    const isKeyR = e.code === 'KeyR' || e.key === 'R' || e.key === 'r';
    const isKeyS = e.code === 'KeyS' || e.key === 'S' || e.key === 's';

    // Alt + Shift + R: Toggle Screen Reader for visible content
    if (e.altKey && e.shiftKey && isKeyR) {
      e.preventDefault();
      e.stopPropagation();
      chrome.runtime.sendMessage({ action: 'TOGGLE_SCREEN_READER' }).catch(() => {});
      return;
    }

    // Alt + Shift + S or Escape (when reading): Stop Screen Reader
    if ((e.altKey && e.shiftKey && isKeyS) || (e.key === 'Escape' && isReadingActive)) {
      e.preventDefault();
      e.stopPropagation();
      chrome.runtime.sendMessage({ action: 'STOP_SCREEN_READER' }).catch(() => {});
      return;
    }
  }, true);

  // 2. Message Listener from Background Worker
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'EXTRACT_VISIBLE_TEXT') {
      const result = extractVisibleContents();
      sendResponse(result);
      return true;
    }

    if (message.action === 'SHOW_READER_BANNER') {
      isReadingActive = true;
      showReaderBanner(message.text);
      sendResponse({ success: true });
      return true;
    }

    if (message.action === 'HIDE_READER_BANNER') {
      isReadingActive = false;
      hideReaderBanner();
      sendResponse({ success: true });
      return true;
    }
  });

  /**
   * Extracts text and prominent descriptions strictly visible within the current viewport.
   */
  function extractVisibleContents() {
    const windowHeight = window.innerHeight || document.documentElement.clientHeight;
    const windowWidth = window.innerWidth || document.documentElement.clientWidth;

    const excludedTags = new Set([
      'SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'CANVAS',
      'NAV', 'FOOTER', 'IFRAME', 'OBJECT', 'EMBED'
    ]);

    const walker = document.createTreeWalker(
      document.body || document.documentElement,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;

          const tag = parent.tagName.toUpperCase();
          if (excludedTags.has(tag)) return NodeFilter.FILTER_REJECT;
          if (parent.getAttribute('aria-hidden') === 'true') return NodeFilter.FILTER_REJECT;

          const style = window.getComputedStyle(parent);
          if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) {
            return NodeFilter.FILTER_REJECT;
          }

          const text = node.textContent.trim();
          if (!text) return NodeFilter.FILTER_REJECT;

          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    const range = document.createRange();
    const visibleSnippets = [];
    let node;

    while ((node = walker.nextNode())) {
      try {
        range.selectNodeContents(node);
        const rect = range.getBoundingClientRect();

        // Check if text node physically overlaps the visible viewport
        const isInView = (
          rect.bottom > 5 &&
          rect.top < (windowHeight - 5) &&
          rect.right > 0 &&
          rect.left < windowWidth &&
          rect.width > 0 &&
          rect.height > 0
        );

        if (isInView) {
          const text = node.textContent.trim();
          if (text) {
            visibleSnippets.push(text);
          }
        }
      } catch (err) {
        // Continue if a dynamic node detached
      }
    }

    // Join snippets while avoiding duplicate runs
    const cleanSnippets = [];
    for (const snippet of visibleSnippets) {
      if (cleanSnippets.length === 0 || cleanSnippets[cleanSnippets.length - 1] !== snippet) {
        cleanSnippets.push(snippet);
      }
    }

    let fullVisibleText = cleanSnippets.join(' ').replace(/\s+/g, ' ').trim();

    // Check for visible images with meaningful alt text
    const images = document.querySelectorAll('img[alt]');
    const visibleAlts = [];
    for (const img of images) {
      const alt = img.getAttribute('alt')?.trim();
      if (!alt || alt.length < 3) continue;
      const r = img.getBoundingClientRect();
      if (r.bottom > 5 && r.top < (windowHeight - 5) && r.right > 0 && r.left < windowWidth && r.width > 25 && r.height > 25) {
        visibleAlts.push(`Image: ${alt}`);
      }
    }

    if (visibleAlts.length > 0) {
      if (fullVisibleText) {
        fullVisibleText += '. ' + visibleAlts.join('. ');
      } else {
        fullVisibleText = visibleAlts.join('. ');
      }
    }

    return {
      title: document.title || 'Current View',
      text: fullVisibleText,
      count: cleanSnippets.length
    };
  }

  function showReaderBanner(customText) {
    let banner = document.getElementById('sightscribe-reader-indicator');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'sightscribe-reader-indicator';
      banner.style.cssText = [
        'position: fixed !important',
        'top: 14px !important',
        'right: 14px !important',
        'z-index: 2147483647 !important',
        'background: #0f172a !important',
        'color: #38bdf8 !important',
        'border: 2px solid #38bdf8 !important',
        'box-shadow: 0 4px 16px rgba(0,0,0,0.6) !important',
        'padding: 8px 14px !important',
        'border-radius: 8px !important',
        'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important',
        'font-size: 12px !important',
        'font-weight: 600 !important',
        'display: flex !important',
        'align-items: center !important',
        'gap: 8px !important',
        'pointer-events: none !important',
        'user-select: none !important',
        'transition: opacity 0.2s ease !important'
      ].join(';');
      document.body.appendChild(banner);
    }
    banner.textContent = customText || '🔊 SightScribe: Reading visible screen... (Alt+Shift+R to stop)';
  }

  function hideReaderBanner() {
    const banner = document.getElementById('sightscribe-reader-indicator');
    if (banner) {
      banner.remove();
    }
  }
})();
