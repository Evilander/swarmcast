import { config, getProviderApiKey } from './config.js';
import { fetchWithTimeout } from './fetch-utils.js';

function resolveProvider(options = {}) {
  return options.provider || config.llm.provider;
}

async function callOpenAI(prompt, options = {}) {
  const key = getProviderApiKey('openai');
  if (!key) {
    throw new Error('OPENAI_API_KEY is not set.');
  }

  const body = {
    model: options.model || 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: options.temperature ?? 0.7,
    max_tokens: options.maxTokens || 2000
  };
  if (!options.raw) {
    body.response_format = { type: 'json_object' };
  }

  const response = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`
    },
    body: JSON.stringify(body),
    signal: options.signal
  });

  if (!response.ok) {
    throw new Error(`OpenAI error ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new Error('OpenAI response did not include message content.');
  }
  return content;
}

async function callAnthropic(prompt, options = {}) {
  const key = getProviderApiKey('anthropic');
  if (!key) {
    throw new Error('ANTHROPIC_API_KEY is not set.');
  }

  const response = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: options.model || 'claude-sonnet-4-6',
      max_tokens: options.maxTokens || 1000,
      messages: [{
        role: 'user',
        content: prompt + (options.raw ? '' : '\n\nRespond with ONLY valid JSON, no markdown.')
      }],
      temperature: options.temperature ?? 0.7
    }),
    signal: options.signal
  });

  if (!response.ok) {
    throw new Error(`Anthropic error ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  const content = data.content?.[0]?.text;
  if (typeof content !== 'string') {
    throw new Error('Anthropic response did not include text content.');
  }
  return content;
}

async function callGemini(prompt, options = {}) {
  const key = getProviderApiKey('gemini');
  if (!key) {
    throw new Error('GEMINI_API_KEY is not set.');
  }

  const model = options.model || 'gemini-2.0-flash';
  const response = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: prompt + (options.raw ? '' : '\n\nRespond with ONLY valid JSON, no markdown.')
          }]
        }],
        generationConfig: {
          temperature: options.temperature ?? 0.7,
          maxOutputTokens: options.maxTokens || 2000,
          ...(options.raw ? {} : { responseMimeType: 'application/json' })
        }
      }),
      signal: options.signal
    }
  );

  if (!response.ok) {
    throw new Error(`Gemini error ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof content !== 'string') {
    throw new Error('Gemini response did not include text content.');
  }
  return content;
}

export async function callLLM(prompt, options = {}) {
  const provider = resolveProvider(options);

  let raw;
  switch (provider) {
    case 'openai':
      raw = await callOpenAI(prompt, options);
      break;
    case 'anthropic':
      raw = await callAnthropic(prompt, options);
      break;
    case 'gemini':
      raw = await callGemini(prompt, options);
      break;
    default:
      throw new Error(`Unknown LLM provider: ${provider}`);
  }

  if (options.raw) {
    return raw.trim();
  }

  const cleaned = stripMarkdownFence(raw.trim());
  try {
    return JSON.parse(cleaned);
  } catch (error) {
    throw new Error(`LLM returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function callLLMBatch(prompts, options = {}) {
  return Promise.all(prompts.map((prompt) => callLLM(prompt, options)));
}

function stripMarkdownFence(value) {
  if (!value.startsWith('```')) {
    return value;
  }
  return value.replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '');
}
