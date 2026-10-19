/**
 * SightScribe - Screen Reader Module
 * Extracts browser tab content, chunks sentences for reliable Chrome TTS,
 * and manages spoken playback without interfering with captioning.
 */

/**
 * Splits plain text into digestible utterance chunks (~180-220 chars)
 * to prevent Chromium TTS from hanging or clipping on large text blocks.
 */
export function splitTextIntoChunks(text, maxLen = 200) {
  if (!text) return [];

  // Match sentences ending with punctuation or newlines
  const sentences = text.match(/[^.!?\n]+[.!?\n]+|[^.!?\n]+$/g) || [text];
  const chunks = [];
  let current = '';

  for (const s of sentences) {
    const trimmed = s.replace(/\s+/g, ' ').trim();
    if (!trimmed) continue;

    if (trimmed.length > maxLen) {
      // Split overly long sentence by words
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
 * In-page function injected into the target tab to extract visible content.
 * Must be self-contained so it can be passed to chrome.scripting.executeScript.
 */
export function inPageExtractContents() {
  const pageTitle = document.title || 'Untitled Webpage';

  // Check if page has no body (e.g. XML or PDF viewer)
  if (!document.body) {
    return { title: pageTitle, text: '' };
  }

  // Tags that definitely do not represent readable article/page text
  const excludedTags = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'CANVAS',
    'NAV', 'FOOTER', 'IFRAME', 'OBJECT', 'EMBED'
  ]);

  // Find candidate main content container if available
  const mainCandidate = document.querySelector('main, [role="main"], article, #content, .content, #main, .post-content');
  const root = mainCandidate || document.body;

  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;

        if (excludedTags.has(parent.tagName.toUpperCase())) {
          return NodeFilter.FILTER_REJECT;
        }

        if (parent.getAttribute('aria-hidden') === 'true') {
          return NodeFilter.FILTER_REJECT;
        }

        // Avoid reading invisible elements
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

  const textSnippets = [];
  let node;
  while ((node = walker.nextNode())) {
    const val = node.textContent.trim();
    if (val) textSnippets.push(val);
  }

  let fullText = textSnippets.join(' ').replace(/\s+/g, ' ').trim();

  // If tree walking yielded very little, fallback to innerText
  if (fullText.length < 50 && document.body.innerText) {
    fullText = document.body.innerText.replace(/\s+/g, ' ').trim();
  }

  return {
    title: pageTitle,
    text: fullText
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
      'box-shadow: 0 4px 16px rgba(0,0,0,0.5) !important',
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
      'transition: all 0.2s ease !important'
    ].join(';');
    document.body.appendChild(banner);
  }
  banner.textContent = message || '🔊 SightScribe: Reading tab... (Alt+Shift+R to stop)';
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
