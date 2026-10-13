/**
 * SightScribe - Screen Narrator Engine
 * Generates natural spoken descriptions of web screens for visually challenged users
 * using AI Vision (Groq/OpenAI) or intelligent DOM structural synthesis.
 */

/**
 * Generates a complete screen narration for the visually challenged.
 * 
 * @param {Object} params
 * @param {string|null} params.screenshotBase64 - Base64 data URL (image/jpeg) of visible tab
 * @param {Object} params.domSummary - Structural summary of the webpage from content script
 * @param {Object} params.settings - SightScribe settings (provider, apiKey, etc.)
 * @returns {Promise<{ narration: string, source: 'ai_vision'|'dom_synthesis' }>}
 */
export async function generateScreenNarration({ screenshotBase64, domSummary, settings = {} }) {
  const { provider, apiKey, customEndpoint } = settings;

  // Try AI Vision if an API key is available and a screenshot was captured
  if (apiKey && apiKey.trim() !== '' && screenshotBase64) {
    try {
      const visionResult = await callVisionAPI({
        provider: provider || 'groq',
        apiKey: apiKey.trim(),
        customEndpoint,
        screenshotBase64,
        domSummary: domSummary || {}
      });

      if (visionResult && visionResult.trim().length > 20) {
        return {
          narration: cleanTextForSpeech(visionResult),
          source: 'ai_vision'
        };
      }
    } catch (err) {
      console.warn('Vision API call failed, falling back to DOM synthesis:', err.message);
    }
  }

  // Fallback to rich DOM structural narrative
  const domNarrative = buildDomNarrative(domSummary || {});
  return {
    narration: cleanTextForSpeech(domNarrative),
    source: 'dom_synthesis'
  };
}

/**
 * Calls Groq or OpenAI Vision chat completion endpoint with the screen image.
 */
async function callVisionAPI({ provider, apiKey, customEndpoint, screenshotBase64, domSummary }) {
  let endpointUrl = '';
  let modelName = '';

  if (provider === 'groq') {
    endpointUrl = 'https://api.groq.com/openai/v1/chat/completions';
    modelName = 'llama-3.2-11b-vision-preview';
  } else if (provider === 'openai') {
    endpointUrl = 'https://api.openai.com/v1/chat/completions';
    modelName = 'gpt-4o-mini';
  } else if (provider === 'custom') {
    endpointUrl = customEndpoint ? `${customEndpoint.replace(/\/transcriptions.*$/, '')}/chat/completions` : 'http://localhost:8000/v1/chat/completions';
    modelName = 'gpt-4o-mini';
  }

  const promptText = `You are SightScribe Screen Narrator, an audio accessibility assistant for visually challenged and blind users.
Analyze this screen image and describe what is currently displayed in clear, spoken, natural language.
- Mention the application or webpage name and general purpose.
- Describe the primary layout (navigation, main section, sidebars).
- Highlight prominent visual media (videos, banners, major photos, charts) and what they depict.
- Summarize the main readable headline or active content.
Keep the description fluent and conversational in 2 to 3 concise paragraphs.
Do not use markdown symbols like asterisks, hashtags, or bullet points, because this text will be read aloud through Text-To-Speech.`;

  const pageContext = `Page Title: "${domSummary.title || 'Current Webpage'}". URL: "${domSummary.url || ''}". Description: "${domSummary.description || ''}".`;

  const response = await fetch(endpointUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: modelName,
      messages: [
        {
          role: 'system',
          content: promptText
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `${pageContext}\nPlease narrate this screen out loud.`
            },
            {
              type: 'image_url',
              image_url: {
                url: screenshotBase64
              }
            }
          ]
        }
      ],
      max_tokens: 500,
      temperature: 0.3
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Vision API error (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  return content || '';
}

/**
 * Builds a natural, informative spoken screen narration from DOM layout and accessibility metadata.
 * Used when offline, when no API key is provided, or as an instant local fallback.
 * 
 * @param {Object} summary
 * @returns {string}
 */
export function buildDomNarrative(summary) {
  const parts = [];

  const title = summary.title ? summary.title.trim() : '';
  const domain = summary.domain ? summary.domain.trim() : '';
  const hasVideo = !!summary.hasVideo;
  const headings = summary.headings || [];
  const images = summary.images || [];
  const paragraphs = summary.paragraphs || [];
  const forms = summary.forms || [];

  // Introduction
  if (title && domain) {
    parts.push(`You are currently on ${domain}, viewing the page titled ${title}.`);
  } else if (title) {
    parts.push(`You are viewing a page titled ${title}.`);
  } else {
    parts.push(`You are viewing the current web browser tab.`);
  }

  // Active media
  if (hasVideo) {
    parts.push(`A video player is present on this page.`);
  }

  // Headings & Main Topics
  if (headings.length > 0) {
    const topHeadings = headings.slice(0, 3).map(h => h.text).filter(Boolean);
    if (topHeadings.length === 1) {
      parts.push(`The primary headline is: ${topHeadings[0]}.`);
    } else if (topHeadings.length > 1) {
      parts.push(`Key sections on this screen include: ${topHeadings.join(', and ')}.`);
    }
  }

  // Visual Images & Media
  const meaningfulImages = images.filter(img => img.alt && img.alt.trim().length > 3).slice(0, 3);
  if (meaningfulImages.length > 0) {
    const descriptions = meaningfulImages.map(img => img.alt.trim()).join('; and ');
    parts.push(`Prominent visuals include: ${descriptions}.`);
  } else if (images.length > 0) {
    parts.push(`There are ${images.length} images displayed across the layout.`);
  }

  // Interactive controls
  if (forms.length > 0) {
    const formDescs = forms.slice(0, 2).map(f => f.purpose || 'input form').join(' and ');
    parts.push(`Interactive controls available include: ${formDescs}.`);
  }

  // Main Content Preview
  if (paragraphs.length > 0) {
    const preview = paragraphs.slice(0, 2).join(' ');
    if (preview.length > 0) {
      parts.push(`Content preview: ${preview.slice(0, 300)}...`);
    }
  }

  return parts.join(' ');
}

/**
 * Cleans text for pleasant, smooth Text-To-Speech reading.
 * Strips markdown symbols, asterisks, extra whitespace, and noisy artifacts.
 * 
 * @param {string} text
 * @returns {string}
 */
export function cleanTextForSpeech(text) {
  if (!text) return '';
  return text
    .replace(/[*_#`~>]/g, ' ') // Strip markdown formatting
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // Convert markdown links to text
    .replace(/https?:\/\/\S+/g, '') // Strip raw URLs
    .replace(/\s+/g, ' ') // Collapse multiple spaces
    .trim();
}
