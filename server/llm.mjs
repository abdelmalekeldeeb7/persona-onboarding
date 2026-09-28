// Anthropic Messages API via fetch (no SDK). One forced tool call returns both the reply
// and any extracted facts, so extraction and wording can never disagree.
const KEY = () => process.env.ANTHROPIC_API_KEY;
// Voice needs speed; typed replies can afford a stronger model.
const MODEL = (via) => via === 'voice'
  ? process.env.ANTHROPIC_MODEL_VOICE || 'claude-haiku-4-5-20251001'
  : process.env.ANTHROPIC_MODEL_TEXT || 'claude-sonnet-5';
const BASE = () => (process.env.LLM_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');

export const llmEnabled = () => !!KEY();

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

export async function llmRespond(system, messages, via = 'text') {
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
