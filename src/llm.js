// LLM provider abstraction — supports OpenAI, Anthropic, and Gemini

function getConfig() {
  const provider = process.env.LLM_PROVIDER || 'openai';
  return {
    provider,
    openaiKey: process.env.OPENAI_API_KEY,
    anthropicKey: process.env.ANTHROPIC_API_KEY,
    geminiKey: process.env.GEMINI_API_KEY
  };
}

async function callOpenAI(prompt, options = {}) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY not set');

  const body = {
    model: options.model || 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: options.temperature ?? 0.7,
    max_tokens: options.maxTokens || 2000
  };
  if (!options.raw) body.response_format = { type: 'json_object' };

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI error ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.choices[0].message.content;
}

async function callAnthropic(prompt, options = {}) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not set');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: options.model || 'claude-sonnet-4-6',
      max_tokens: options.maxTokens || 1000,
      messages: [{ role: 'user', content: prompt + (options.raw ? '' : '\n\nRespond with ONLY valid JSON, no markdown.') }],
      temperature: options.temperature ?? 0.7
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic error ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.content[0].text;
}

async function callGemini(prompt, options = {}) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not set');

  const model = options.model || 'gemini-2.0-flash';
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt + (options.raw ? '' : '\n\nRespond with ONLY valid JSON, no markdown.') }] }],
        generationConfig: {
          temperature: options.temperature ?? 0.7,
          maxOutputTokens: options.maxTokens || 2000,
          ...(options.raw ? {} : { responseMimeType: 'application/json' })
        }
      })
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini error ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.candidates[0].content.parts[0].text;
}

export async function callLLM(prompt, options = {}) {
  const config = getConfig();
  const provider = options.provider || config.provider;

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

  // Raw mode: return text as-is (for prose, briefs, etc.)
  if (options.raw) return raw.trim();

  // Parse JSON from response, handling potential markdown wrapping
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    console.error(`Failed to parse LLM response as JSON:`, cleaned.slice(0, 200));
    throw new Error(`LLM returned invalid JSON: ${e.message}`);
  }
}

// Run multiple prompts in parallel
export async function callLLMBatch(prompts, options = {}) {
  return Promise.all(prompts.map(p => callLLM(p, options)));
}
