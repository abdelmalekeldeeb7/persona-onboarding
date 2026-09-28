// Claude replies via fetch (no SDK). One forced tool call returns both the reply and
// extracted facts, so state and wording cannot disagree.
const KEY = () => process.env.ANTHROPIC_API_KEY;
const GEMINI_KEY = () => process.env.GEMINI_API_KEY;
// One model owns both surfaces so a call and the text thread share the same judgment.
const MODEL = (via) => via === 'voice'
  ? process.env.ANTHROPIC_MODEL_VOICE || 'claude-haiku-4-5-20251001'
  : process.env.ANTHROPIC_MODEL_TEXT || 'claude-haiku-4-5-20251001';
const BASE = () => (process.env.LLM_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');

// A Gemini key by itself enables speech only; it never changes the conversation model.
export const llmProvider = () => KEY() ? 'anthropic' : null;
export const llmEnabled = () => !!llmProvider();

const TOOL = {
  name: 'respond',
  description: 'Send your reply to the user and record any facts they clearly stated this turn.',
  input_schema: {
    type: 'object',
    properties: {
      say: { type: 'string', description: 'Exactly what you say to the user.' },
      agent_name: { type: 'string', description: 'The name the user chose for you (or accepted), if stated this turn.' },
      user_name: { type: 'string', description: 'What the user wants to be called, if stated or corrected this turn.' },
      need: { type: 'string', description: 'Short summary of what they want help with, if stated or changed this turn.' },
      gmail_intent: { type: 'string', enum: ['connect', 'skip'], description: 'Only if the user said they want to connect Gmail now, or declined it.' },
      mode_intent: { type: 'string', enum: ['call', 'text', 'end_call'], description: 'Only if the user asked to start a call, switch to typing, or end the call.' },
      asked_about_gmail: { type: 'boolean', description: 'True if your message offers to connect Gmail.' },
      connector: { type: 'string', enum: ['notion', 'google_calendar', 'slack', 'google_drive'], description: 'Only when your message suggests adding one of these connectors because it clearly fits their need.' },
    },
    required: ['say'],
  },
};

export function llmRespond(system, messages, via = 'text') { return anthropicRespond(system, messages, via); }

async function anthropicRespond(system, messages, via) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Number(process.env.LLM_TIMEOUT_MS || (via === 'voice' ? 8000 : 15000)));
  try {
    const res = await fetch(`${BASE()}/v1/messages`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': KEY(),
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL(via),
        max_tokens: 700,
        system,
        messages,
        tools: [TOOL],
        tool_choice: { type: 'tool', name: 'respond' },
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    const block = data.content?.find((b) => b.type === 'tool_use');
    if (!block?.input?.say) throw new Error('no tool output');
    return block.input;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Gemini speech (the call's voice) ----------
// The words still come from llmRespond; this only turns them into audio, so every
// hangup/fact/turn rule on the server stays in charge.
// A quota 429 trips a breaker so every later line doesn't wait on a doomed request and
// calls stay in one consistent voice. Per-day quota: stay off for an hour; otherwise briefly.
let ttsDownUntil = 0;
const geminiReady = () => !!GEMINI_KEY() && process.env.GEMINI_TTS !== 'off' && Date.now() >= ttsDownUntil;
// Kokoro (open weights, Apache-2.0) runs on this server: no key, no quota. It is the default
// call voice so every line sounds the same. TTS_PROVIDER=gemini prefers Gemini when it has quota.
const kokoroOn = () => process.env.TTS_PROVIDER !== 'gemini' && process.env.KOKORO !== 'off';
export const ttsEnabled = () => (kokoroOn() && kokoroState !== 'failed') || geminiReady();

let kokoro = null, kokoroState = 'idle', kokoroQueue = Promise.resolve();
export function warmKokoro() {
  if (!kokoroOn() || kokoro) return kokoro;
  kokoroState = 'loading';
  const t = Date.now();
  kokoro = import('kokoro-js')
    .then(({ KokoroTTS }) => KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'q8', device: 'cpu' }))
    .then((model) => {
      kokoroState = 'ready';
      console.log(`[tts] kokoro ready in ${Date.now() - t}ms`);
      return model;
    })
    .catch((e) => { kokoroState = 'failed'; console.error('[tts] kokoro unavailable:', e.message); throw e; });
  kokoro.catch(() => {});
  return kokoro;
}
async function kokoroSpeak(text) {
  const model = await warmKokoro();
  // One CPU-bound render at a time, in request order, so a reply's sentences finish in sequence.
  const job = kokoroQueue.then(async () => {
    const audio = await model.generate(text, { voice: process.env.KOKORO_VOICE || 'af_heart', speed: 1.05 });
    return Buffer.from(audio.toWav());
  });
  kokoroQueue = job.catch(() => {});
  return job;
}
async function synthesize(text) {
  if (process.env.TTS_PROVIDER === 'gemini' && geminiReady()) return geminiSpeak(text);
  if (kokoroOn() && kokoroState !== 'failed') return kokoroSpeak(text);
  return geminiSpeak(text);
}

// Voice turns prefetch their audio while the reply travels to the browser; the browser's
// request then joins the in-flight render instead of starting from zero.
const ttsCache = new Map();
export function speakCached(text) {
  const key = text.trim();
  let p = ttsCache.get(key);
  if (!p) {
    p = synthesize(key);
    ttsCache.set(key, p);
    p.catch(() => ttsCache.delete(key));
    setTimeout(() => ttsCache.delete(key), 5 * 60e3).unref?.();
    if (ttsCache.size > 200) ttsCache.delete(ttsCache.keys().next().value);
  }
  return p;
}
export function prefetchSpeech(text) {
  if (!ttsEnabled() || !text) return;
  for (const line of speechChunks(text)) speakCached(line).catch(() => {});
}
// Must match the browser's chunking (src/lib/call.ts) so prefetched keys line up.
export function speechChunks(text) {
  const parts = (text.match(/[^.!?]+[.!?]+["'”’)]*\s*|[^.!?]+$/g) || [text]).map((x) => x.trim()).filter(Boolean);
  const out = [];
  for (const part of parts) {
    if (out.length && part.length < 12) out[out.length - 1] += ' ' + part;
    else out.push(part);
  }
  return out;
}

export async function geminiSpeak(text) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Number(process.env.TTS_TIMEOUT_MS || 12000));
  try {
    const model = process.env.GEMINI_TTS_MODEL || 'gemini-3.8-flash-lite-tts';
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': GEMINI_KEY(), 'Api-Revision': '2026-05-20' },
      body: JSON.stringify({
        model,
        input: [{ type: 'user_input', content: [{
          type: 'text',
          text,
          annotations: [{ type: 'speech_metadata', style: 'warm, calm and conversational; natural phone-call pacing' }],
        }] }],
        response_format: { type: 'audio', mime_type: 'audio/wav' },
        generation_config: {
          speech_config: [{ voice: process.env.GEMINI_TTS_VOICE || 'Kore' }],
        },
      }),
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      if (res.status === 429) {
        ttsDownUntil = Date.now() + (/per day|daily/i.test(body) ? 60 * 60e3 : 60e3);
        console.warn('[tts] quota hit; using browser voice until', new Date(ttsDownUntil).toISOString());
      }
      throw new Error(`HTTP ${res.status}: ${body}`);
    }
    const data = await res.json();
    const audio = data.outputAudio || data.output_audio || data.steps
      ?.flatMap((step) => step.content || [])
      .find((part) => part.type === 'audio' && part.data);
    if (!audio?.data) throw new Error(`no audio (${data.status || 'no output'})`);
    return Buffer.from(audio.data, 'base64');
  } finally {
    clearTimeout(timer);
  }
}
