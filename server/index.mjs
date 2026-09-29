import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { initStore, getSession, saveSession, listSessions } from './store.mjs';
import { newSession, handleTurn, handleEvent, publicState, carryOver, threadSummary } from './engine.mjs';
import { llmEnabled, llmProvider, ttsEnabled, speakCached, prefetchSpeech, warmKokoro } from './llm.mjs';

const app = express();
app.set('trust proxy', 1); // Railway terminates TLS at its proxy
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'microphone=(self), camera=(), geolocation=()',
  });
  next();
});
// Cross-site writes are refused outright (the owner cookie is also SameSite=Lax).
app.use('/api', (req, res, next) => {
  const origin = req.get('origin');
  if (req.method === 'POST' && origin && new URL(origin).host !== req.get('host')) return res.status(403).json({ error: 'cross-site' });
  next();
});
app.use(express.json({ limit: '200kb' }));
app.use(express.text({ type: 'text/plain', limit: '50kb' })); // sendBeacon payloads

// Per-session serialization: rapid-fire messages (people will spam) are processed in order,
// never interleaved, so state updates can't race.
const locks = new Map();
const depth = new Map();
function withLock(id, fn) {
  const prev = locks.get(id) || Promise.resolve();
  depth.set(id, (depth.get(id) || 0) + 1);
  const next = prev.catch(() => {}).then(fn);
  locks.set(id, next);
  next.finally(() => {
    depth.set(id, depth.get(id) - 1);
    if (!depth.get(id)) depth.delete(id);
    if (locks.get(id) === next) locks.delete(id);
  }).catch(() => {});
  return next;
}
// A queue this deep is a script, not a person typing.
const tooDeep = (id) => (depth.get(id) || 0) >= 12;

// ---------- session ownership ----------
// The session id is not a credential. Whoever created a session holds an HttpOnly owner
// cookie; the store keeps only its hash. Knowing someone's UUID gets you a 404.
const COOKIE = 'persona_projection_owner';
const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');
function readCookie(req) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, v] = part.trim().split('=');
    if (k === COOKIE && /^[A-Za-z0-9_-]{20,100}$/.test(v || '')) return v;
  }
  return null;
}
function ownerToken(req, res) {
  let t = readCookie(req);
  if (!t) {
    t = crypto.randomBytes(24).toString('base64url');
    res.cookie(COOKIE, t, { httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/api', maxAge: 90 * 864e5 });
  }
  return t;
}
function owns(req, s) {
  const t = readCookie(req);
  if (!t) return false;
  if (!s.owner) return false;
  const a = Buffer.from(hash(t)), b = Buffer.from(s.owner);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- rate limits (abuse only; normal fast typing is queued, never rejected) ----------
const buckets = new Map();
function allow(key, perMinute) {
  const now = Date.now();
  const b = buckets.get(key) || { tokens: perMinute, at: now };
  b.tokens = Math.min(perMinute, b.tokens + ((now - b.at) / 60e3) * perMinute);
  b.at = now;
  if (b.tokens < 1) { buckets.set(key, b); return false; }
  b.tokens -= 1;
  buckets.set(key, b);
  return true;
}
setInterval(() => { const cut = Date.now() - 10 * 60e3; for (const [k, b] of buckets) if (b.at < cut) buckets.delete(k); }, 60e3).unref();
function limited(res, key, perMinute) {
  if (allow(key, perMinute)) return false;
  res.set('Retry-After', '5').status(429).json({ error: 'slow down' });
  return true;
}

const ID_RE = /^[0-9a-f-]{36}$/;
async function load(req, res) {
  const id = req.params.id;
  if (!ID_RE.test(id)) { res.status(400).json({ error: 'bad id' }); return null; }
  const s = await getSession(id);
  if (!s || !owns(req, s)) { res.status(404).json({ error: 'not found' }); return null; }
  return s;
}

app.get('/api/config', (_req, res) => {
  res.json({
    googleClientId: process.env.GOOGLE_CLIENT_ID || null,
    llm: llmEnabled(),
    provider: llmProvider(),
    chatModel: llmProvider() === 'anthropic' ? (process.env.ANTHROPIC_MODEL_TEXT || 'claude-haiku-4-5-20251001') : null,
    voice: ttsEnabled() ? 'gemini' : 'browser',
  });
});

app.post('/api/session', async (req, res) => {
  if (limited(res, `new:${req.ip}`, 20)) return;
  const s = newSession();
  s.owner = hash(ownerToken(req, res));
  // "New chat" keeps who you are (names, Gmail, connectors) from one of your own conversations.
  const from = typeof req.body?.carryFrom === 'string' && ID_RE.test(req.body.carryFrom) ? await getSession(req.body.carryFrom) : null;
  if (from && owns(req, from)) carryOver(from, s);
  await saveSession(s);
  res.json({ state: publicState(s) });
});

app.get('/api/sessions', async (req, res) => {
  const t = readCookie(req);
  if (!t) return res.json({ threads: [] });
  if (limited(res, `list:${req.ip}`, 60)) return;
  const all = await listSessions(hash(t), 30);
  res.json({ threads: all.map(threadSummary).filter(Boolean) });
});

app.get('/api/session/:id', async (req, res) => {
  const s = await load(req, res); if (!s) return;
  // A reload during a live call is a hangup: record it so the conversation acknowledges it.
  if (s.call.active) {
    await withLock(s.id, async () => {
      const fresh = await getSession(s.id);
      const msgs = await handleEvent(fresh, { type: 'call_ended', reason: 'tab_closed' });
      await saveSession(fresh);
      res.json({ state: publicState(fresh), messages: msgs });
    });
    return;
  }
  res.json({ state: publicState(s) });
});

app.post('/api/session/:id/turn', async (req, res) => {
  const id = req.params.id;
  if (!ID_RE.test(id)) return res.status(400).json({ error: 'bad id' });
  if (limited(res, `turn:${id}`, 40)) return;
  if (tooDeep(id)) return res.set('Retry-After', '5').status(429).json({ error: 'slow down' });
  try {
    const out = await withLock(id, async () => {
      const s = await getSession(id);
      if (!s || !owns(req, s)) return null;
      const via = req.body?.via === 'voice' ? 'voice' : 'text';
      // A retried request (response lost on a flaky network) must not run the turn twice.
      const nonce = typeof req.body?.nonce === 'string' ? req.body.nonce.slice(0, 40) : null;
      if (nonce) {
        s.nonces ||= [];
        if (s.nonces.includes(nonce)) return { state: publicState(s), messages: s.transcript.slice(-1).filter((m) => m.role === 'agent') };
        s.nonces = [...s.nonces.slice(-19), nonce];
      }
      const messages = await handleTurn(s, { text: req.body?.text, via });
      if (via === 'voice' || s.call.active) for (const m of messages) if (m.role === 'agent') prefetchSpeech(m.text);
      await saveSession(s);
      return { state: publicState(s), messages };
    });
    if (!out) return res.status(404).json({ error: 'not found' });
    res.json(out);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'turn failed' });
  }
});

// Gemini renders Haiku's exact reply. Session ownership prevents this endpoint from
// becoming an open speech proxy; a fast failure lets the client use browser speech.
app.post('/api/session/:id/tts', async (req, res) => {
  const s = await load(req, res); if (!s) return;
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!ttsEnabled()) return res.status(404).json({ error: 'unavailable' });
  if (!text || text.length > 600) return res.status(400).json({ error: 'bad text' });
  if (limited(res, `tts:${s.id}`, 90)) return;
  try {
    const audio = await speakCached(text);
    res.set({ 'content-type': 'audio/wav', 'cache-control': 'no-store' }).send(audio);
  } catch (e) {
    console.error('[tts] failed:', e.message);
    res.status(502).json({ error: 'tts failed' });
  }
});

app.post('/api/session/:id/event', async (req, res) => {
  const id = req.params.id;
  if (!ID_RE.test(id)) return res.status(400).json({ error: 'bad id' });
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  // Voice diagnostics: which browser, which call step, which recognizer error. No message content.
  if (/^(call_|voice_diag|client_caps)/.test(String(body?.type || ''))) {
    const ua = String(req.get('user-agent') || '').replace(/^Mozilla\/5\.0 /, '').slice(0, 110);
    console.log(`[voice] ${id.slice(0, 8)} ${body.type}${body.reason ? ' reason=' + body.reason : ''}${body.detail ? ' ' + String(body.detail).slice(0, 80) : ''}${body.voice !== undefined ? ' voice=' + body.voice : ''} | ${ua}`);
    if (body.type === 'voice_diag') return res.json({ ok: true });
  }
  if (limited(res, `event:${id}`, 60)) return;
  try {
    const out = await withLock(id, async () => {
      const s = await getSession(id);
      if (!s || !owns(req, s)) return null;
      const messages = await handleEvent(s, body || {});
      if (s.call.active) for (const m of messages) if (m.role === 'agent') prefetchSpeech(m.text);
      await saveSession(s);
      return { state: publicState(s), messages };
    });
    if (!out) return res.status(404).json({ error: 'not found' });
    res.json(out);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'event failed' });
  }
});

app.get('/healthz', (_req, res) => res.send('ok'));

const dist = path.resolve('dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist, { index: false, maxAge: '1h' }));
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

const port = Number(process.env.PORT || 8790);
await initStore();
warmKokoro(); // load the voice model at boot, not on the first call
app.listen(port, () => console.log(`[persona] http://localhost:${port}  llm=${llmProvider() || "fallback"}`));
