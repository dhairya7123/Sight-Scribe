/**
 * SightScribe - Text Deduplication & Subtitle Cleaning Engine
 * Eliminates repeated phrases, overlapping boundaries, Whisper prompt hallucinations,
 * and audio looping artifacts across chunks and within individual captions.
 */

/**
 * Normalizes text for comparison: lowercases, removes punctuation/symbols, trims extra spaces.
 * @param {string} str
 * @returns {string}
 */
export function normalizeForComparison(str) {
  if (!str) return '';
  return str
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, '') // Unicode punctuation & symbols (including ♪, ♫, quotes, dashes)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Common Whisper hallucinations and noise artifacts to suppress
 */
const HALLUCINATION_PHRASES = new Set([
  'thank you',
  'thank you.',
  'thank you for watching',
  'thank you for watching.',
  'thank you for watching!',
  'thanks for watching',
  'thanks for watching.',
  'thanks for watching!',
  'thank you so much',
  'subtitles by the amaraorg community',
  'subtitles by the amara community',
  'subtitles by the amara',
  'subtitles by',
  'translated by',
  'captioned by',
  'subscribe to my channel',
  'please subscribe',
  'like and subscribe',
  'dont forget to subscribe',
  'subscribe',
  'watching',
  'you',
  'bye',
  'bye bye',
  'goodbye',
  'see you next time'
]);

/**
 * Cleans out hallucinations, brackets/parentheses descriptions (e.g. [Music], (Applause)),
 * and musical symbols.
 * Returns empty string if the text is deemed pure noise or a hallucination.
 * 
 * @param {string} text
 * @returns {string}
 */
export function cleanHallucinations(text) {
  if (!text) return '';

  let cleaned = text
    .replace(/[♪♫🎵🎶]/g, ' ') // Remove musical notes
    .replace(/\[[^\]]*\]/g, ' ') // Remove [Music], [Applause], [laughter]
    .replace(/\([^)]*\)/g, ' ') // Remove (music), (applause)
    .replace(/\s+/g, ' ')
    .trim();

  // If text is only punctuation, dashes, or dots without words/numbers
  if (!/[a-zA-Z0-9\u00C0-\u024F\u1E00-\u1EFF\u0400-\u04FF\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/.test(cleaned)) {
    return '';
  }

  const normalized = normalizeForComparison(cleaned);
  if (!normalized || normalized.length < 2) {
    return '';
  }

  if (HALLUCINATION_PHRASES.has(normalized)) {
    return '';
  }

  return cleaned;
}

/**
 * Collapses repeating loops of n-grams inside the text itself.
 * Example:
 * "Never gonna give you up never gonna give you up" -> "Never gonna give you up"
 * "Yeah yeah yeah yeah" -> "Yeah"
 * 
 * @param {string} text
 * @returns {string}
 */
export function collapseIntraRepetitions(text) {
  if (!text) return '';
  const words = text.trim().split(/\s+/);
  if (words.length < 2) return text;

  // Max phrase length to check for repeats: up to half the length of words, capped at 10
  const maxN = Math.min(Math.floor(words.length / 2), 10);

  for (let n = maxN; n >= 1; n--) {
    let changed = false;
    const result = [];
    let i = 0;

    while (i < words.length) {
      if (i + 2 * n <= words.length) {
        const sliceA = words.slice(i, i + n).map(normalizeForComparison).join(' ');
        const sliceB = words.slice(i + n, i + 2 * n).map(normalizeForComparison).join(' ');

        if (sliceA && sliceA === sliceB) {
          result.push(...words.slice(i, i + n));
          i += 2 * n;

          // Skip any further consecutive repeats of the same pattern
          while (i + n <= words.length) {
            const nextSlice = words.slice(i, i + n).map(normalizeForComparison).join(' ');
            if (nextSlice === sliceA) {
              i += n;
            } else {
              break;
            }
          }
          changed = true;
          continue;
        }
      }
      result.push(words[i]);
      i++;
    }

    if (changed) {
      words.length = 0;
      words.push(...result);
    }
  }

  return words.join(' ');
}

/**
 * Strips overlapping prefix words from newText if they match the tail of prevText.
 * E.g.:
 * prevText: "I was walking down the street"
 * newText: "down the street looking for a friend"
 * Output: "looking for a friend"
 * 
 * @param {string} newText
 * @param {string} prevText
 * @returns {string}
 */
export function stripOverlappingPrefix(newText, prevText) {
  if (!prevText || !newText) return newText;

  const prevWords = prevText.trim().split(/\s+/);
  const newWords = newText.trim().split(/\s+/);

  const maxOverlap = Math.min(prevWords.length, newWords.length, 12);

  for (let k = maxOverlap; k >= 1; k--) {
    const prevSlice = prevWords.slice(prevWords.length - k).map(normalizeForComparison).join(' ');
    const newSlice = newWords.slice(0, k).map(normalizeForComparison).join(' ');

    if (prevSlice && prevSlice === newSlice) {
      // If overlap is only 1 word, only strip if it's substantial or matches closely
      if (k === 1) {
        const word = newWords[0];
        if (word.length < 3 && prevWords.length > 1) {
          continue;
        }
      }

      const remaining = newWords.slice(k);
      return remaining.join(' ');
    }
  }

  return newText;
}

/**
 * Checks if newText is an exact duplicate, substring, or redundant echo of recent texts.
 * 
 * @param {string} newText
 * @param {Array<string>} recentTexts - Recent 1-3 previous segments
 * @returns {boolean}
 */
export function isDuplicateOrRedundant(newText, recentTexts) {
  if (!newText || !recentTexts || recentTexts.length === 0) return false;

  const newNorm = normalizeForComparison(newText);
  if (!newNorm) return true;

  for (const prev of recentTexts) {
    if (!prev) continue;
    const prevNorm = normalizeForComparison(prev);
    if (!prevNorm) continue;

    // 1. Exact match
    if (newNorm === prevNorm) {
      return true;
    }

    // 2. New text is completely contained inside recent segment (substring echo)
    if (prevNorm.includes(newNorm)) {
      return true;
    }

    // 3. Word set overlap / Jaccard similarity for short repetitive snippets
    const newWords = new Set(newNorm.split(' '));
    const prevWords = new Set(prevNorm.split(' '));
    let intersection = 0;
    for (const w of newWords) {
      if (prevWords.has(w)) intersection++;
    }
    const union = new Set([...newWords, ...prevWords]).size;
    const jaccard = union > 0 ? intersection / union : 0;

    // If similarity is extremely high (> 85%) and word count is similar
    if (jaccard >= 0.85 && Math.abs(newWords.size - prevWords.size) <= 1) {
      return true;
    }
  }

  return false;
}

/**
 * Pipeline processor: Cleans, deduplicates, and strips overlapping words.
 * Returns the sanitized caption string, or null if the segment is redundant/empty.
 * 
 * @param {string} rawText - Transcribed text from Whisper
 * @param {Array<string>} recentTexts - Recent 1-3 text segments
 * @returns {string|null}
 */
export function sanitizeTranscriptSegment(rawText, recentTexts = []) {
  if (!rawText) return null;

  // 1. Filter hallucinations & noise
  let text = cleanHallucinations(rawText);
  if (!text) return null;

  // 2. Collapse intra-chunk loops (e.g., "word word word" or "phrase phrase")
  text = collapseIntraRepetitions(text);
  if (!text) return null;

  // 3. Check for duplicates against recent segments
  if (recentTexts.length > 0 && isDuplicateOrRedundant(text, recentTexts)) {
    return null;
  }

  // 4. Strip prefix overlap with the immediate previous segment
  if (recentTexts.length > 0 && recentTexts[0]) {
    text = stripOverlappingPrefix(text, recentTexts[0]);
  }

  // 5. Re-check after stripping overlap
  text = text.trim();
  if (!text || text.length < 2) {
    return null;
  }

  const normAfter = normalizeForComparison(text);
  if (!normAfter || normAfter.length < 2) {
    return null;
  }

  if (recentTexts.length > 0 && isDuplicateOrRedundant(text, recentTexts)) {
    return null;
  }

  // Capitalize first character if needed
  if (text.length > 0) {
    text = text.charAt(0).toUpperCase() + text.slice(1);
  }

  return text;
}
