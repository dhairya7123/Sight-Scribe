/**
 * SightScribe - Screen Reader Module
 * Extracts visible browser tab content, chunks sentences for reliable Chrome TTS,
 * and manages spoken playback without interfering with captioning.
 */

/**
 * Splits plain text into digestible utterance chunks (~180-220 chars)
 * to prevent Chromium TTS from hanging or clipping on large text blocks.
 */
export function splitTextIntoChunks(text, maxLen = 200) {
  if (!text) return [];

  const sentences = text.match(/[^.!?\n]+[.!?\n]+|[^.!?\n]+$/g) || [text];
  const chunks = [];
  let current = '';

  for (const s of sentences) {
    const trimmed = s.replace(/\s+/g, ' ').trim();
    if (!trimmed) continue;

    if (trimmed.length > maxLen) {
      const words = trimmed.split(' ');
      for (const w of words) {
        if ((current + ' ' + w).trim().length > maxLen) {
          if (current.trim()) chunks.push(current.trim());
          current = w;
        } else {
          current = current ? current + ' ' + w : w;
        }
      }
    } else {
      if ((current + ' ' + trimmed).trim().length > maxLen) {
        if (current.trim()) chunks.push(current.trim());
        current = trimmed;
      } else {
        current = current ? current + ' ' + trimmed : trimmed;
      }
    }
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

/**
 * In-page function injected into the target tab to extract ONLY content
 * currently visible in the user's viewport.
 * Must be self-contained so it can be passed to chrome.scripting.executeScript.
 */
export function inPageExtractContents() {
  const windowHeight = window.innerHeight || document.documentElement.clientHeight;
  const windowWidth = window.innerWidth || document.documentElement.clientWidth;

  if (!document.body) {
    return { title: document.title || 'Untitled', text: '' };
  }

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
      // Continue if node disconnected
    }
  }

  const cleanSnippets = [];
  for (const snippet of visibleSnippets) {
    if (cleanSnippets.length === 0 || cleanSnippets[cleanSnippets.length - 1] !== snippet) {
      cleanSnippets.push(snippet);
    }
  }

  let fullVisibleText = cleanSnippets.join(' ').replace(/\s+/g, ' ').trim();

  // Check for visible images with alt text in viewport
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

/**
 * In-page function to show a floating indicator while screen reader is speaking.
 */
export function inPageShowBanner(message) {
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
  banner.textContent = message || '🔊 SightScribe: Reading visible screen... (Alt+Shift+R to stop)';
}

/**
 * In-page function to remove the floating indicator.
 */
export function inPageHideBanner() {
  const banner = document.getElementById('sightscribe-reader-indicator');
  if (banner) {
    banner.remove();
  }
}
