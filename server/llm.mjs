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
    },
    required: ['say'],
  },
};

export function llmRespond(system, messages, via = 'text') { return anthropicRespond(system, messages, via); }

async function anthropicRespond(system, messages, via) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Number(process.env.LLM_TIMEOUT_MS || 15000));
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
export const ttsEnabled = () => !!GEMINI_KEY() && process.env.GEMINI_TTS !== 'off';

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
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
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
