export type Card =
  | { type: 'call_offer'; closed?: boolean }
  | { type: 'call_back'; closed?: boolean }
  | { type: 'end_call'; closed?: boolean }
  | { type: 'gmail'; autostart?: boolean; retry?: boolean; closed?: boolean };

export type Msg = {
  id: string;
  t: number;
  role: 'user' | 'agent' | 'system';
  text: string;
  via: 'voice' | 'text';
  card?: Card;
  changes?: { field: string; from: string | null; to: string }[];
  pending?: boolean;
  failed?: boolean;
};

export type State = {
  id: string;
  agentName: string | null;
  userName: string | null;
  need: string | null;
  gmail: { status: 'none' | 'offered' | 'connected' | 'skipped'; email: string | null; simulated: boolean };
  phase: 'name_agent' | 'intro' | 'onboarding' | 'main';
  call: { active: boolean; count: number; hangups: number };
  transcript: Msg[];
  llm: boolean;
};

export type Reply = { state: State; messages: Msg[] };

const KEY = 'persona.projection.session';

async function req<T>(path: string, body?: unknown, retries = 2): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (r.status === 404) throw Object.assign(new Error('not found'), { status: 404 });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()) as T;
    } catch (e: any) {
      if (e.status === 404 || i >= retries) throw e;
      await new Promise((res) => setTimeout(res, 600 * (i + 1)));
    }
  }
}

export const api = {
  config: () => req<{ googleClientId: string | null; llm: boolean }>('/api/config'),
  async resume(): Promise<Reply> {
    const id = safeGet(KEY);
    if (id) {
      try {
        const r = await req<Reply>(`/api/session/${id}`);
        return { state: r.state, messages: r.messages ?? [] };
      } catch (e: any) {
        if (e.status !== 404) throw e;
      }
    }
    return api.fresh();
  },
  async fresh(): Promise<Reply> {
    const r = await req<{ state: State }>('/api/session', {});
    safeSet(KEY, r.state.id);
    return { state: r.state, messages: [] };
  },
  turn: (id: string, text: string, via: 'voice' | 'text') => req<Reply>(`/api/session/${id}/turn`, { text, via }, 1),
  event: (id: string, ev: Record<string, unknown>) => req<Reply>(`/api/session/${id}/event`, ev),
  beacon(id: string, ev: Record<string, unknown>) {
    try {
      navigator.sendBeacon(`/api/session/${id}/event`, new Blob([JSON.stringify(ev)], { type: 'text/plain' }));
    } catch {}
  },
};

function safeGet(k: string) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k: string, v: string) { try { localStorage.setItem(k, v); } catch {} }
