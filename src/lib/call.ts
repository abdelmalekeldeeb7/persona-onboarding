// Browser voice call: speech recognition in, speech synthesis out.
// Framework-agnostic so any UI can drive it. Handles barge-in, echo, silence,
// recognizer restarts, mic denial and mute.

export type CallStatus = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'ended';
export type EndReason = 'user' | 'agent' | 'silence' | 'error' | 'mic_denied' | 'unsupported' | 'tab_closed';

type Handlers = {
  onStatus?: (s: CallStatus) => void;
  onCaption?: (text: string) => void; // live interim transcript
  onUtterance?: (text: string) => void; // a finished user utterance to send
  onBargeIn?: (heardText: string) => void;
  onLevel?: (level: number) => void; // 0..1 mic level for visuals
  onEnd?: (reason: EndReason, info: { midSpeech: boolean; partial: string }) => void;
  onReprompt?: (text: string, strike: number) => void; // locally generated nudge (silence)
  onSilenceText?: (strike: number) => string;
};

type CallOptions = {
  synthesize?: (text: string, signal?: AbortSignal) => Promise<ArrayBuffer>;
};

// Must match speechChunks in server/llm.mjs so prefetched audio is reused.
export function speechChunks(text: string) {
  const parts = (text.match(/[^.!?]+[.!?]+["'”’)]*\s*|[^.!?]+$/g) || [text]).map((x) => x.trim()).filter(Boolean);
  const out: string[] = [];
  for (const part of parts) {
    if (out.length && part.length < 12) out[out.length - 1] += ' ' + part;
    else out.push(part);
  }
  return out.length ? out : [text];
}

const SR: any = typeof window !== 'undefined' && ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);

export const voiceSupport = () => ({
  recognition: !!SR,
  synthesis: typeof window !== 'undefined' && 'speechSynthesis' in window,
});

// Give people time to finish a thought. Browser speech recognition often emits
// several partials during one sentence, so interim text gets a longer endpoint.
const ENDPOINT_MS = 1100;
const INTERIM_ENDPOINT_MS = 1500;
const BARGE_CONFIRM_MS = 450;
// People trail off ("because…", "uh…") mid-thought; wait longer before treating that as the end.
const TRAILING_MS = 2600;
const TRAILING = /(?:^|\s)(?:u+h+|u+m+|e+r+m*|hmm+|and|but|so|because|cause|or|the|a|an|to|of|with|like|that|which|if|when|my|i|i'm|is|are|was|for|about|just|um,|uh,)[\s,.…-]*$/i;
const BACKCHANNEL = /^(m+hm+|mm+|uh[- ]?huh|yeah|yep|yes|right|okay|ok|sure|got it|i see)[.!?, ]*$/i;
const HOLD_ON = /^(please )?(hold on|one sec(?:ond)?|give me a moment|wait a sec(?:ond)?)[.! ]*$/i;

export class Call {
  status: CallStatus = 'idle';
  muted = false;
  rate = 1.04;
  private h: Handlers;
  private rec: any = null;
  private active = false;
  private finalBuf = '';
  private interim = '';
  // Chrome keeps growing one result while a sentence continues. Once a partial
  // result is sent, remember it so later versions only contribute new words.
  private sentByIndex = new Map<number, string>();
  private interimByIndex = new Map<number, string>();
  private endpointTimer: any = null;
  private bargeTimer: any = null;
  private bargeCandidate = '';
  private silenceTimer: any = null;
  private silenceStrikes = 0;
  private holdOn = false;
  private restarts = 0;
  private recRunning = false;
  private lastRecStart = 0;
  private watchdog: any = null;
  private onWake = () => this.resume();
  private stream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private raf = 0;
  private speakingText = '';
  private heardText = '';
  private lastSpokeAt = 0;
  private voice: SpeechSynthesisVoice | null = null;
  private speakToken = 0;
  private synthesize?: (text: string, signal?: AbortSignal) => Promise<ArrayBuffer>;
  private remoteAudio: HTMLAudioElement | null = null;
  private remoteAudioUrl = '';

  constructor(h: Handlers, options: CallOptions = {}) { this.h = h; this.synthesize = options.synthesize; }

  /** Call synchronously inside the user's tap: Safari only allows speech/audio started by a gesture. */
  static unlock() {
    try { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); } catch {}
    try { const AC = window.AudioContext || (window as any).webkitAudioContext; const ac = new AC(); ac.resume().finally(() => setTimeout(() => ac.close(), 200)); } catch {}
  }

  async start() {
    if (this.active) return;
    if (!SR) { this.finish('unsupported'); return; }
    this.active = true;
    this.set('connecting');
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      this.finish('mic_denied');
      return;
    }
    if (!this.active) { this.stopStream(); return; }
    this.meter();
    this.pickVoice();
    this.listen();
    // A Google sign-in popup, tab switch or recognizer hiccup can silently stop listening.
    // Keep checking, and restart as soon as the page has focus again.
    this.watchdog = setInterval(() => this.resume(), 2500);
    addEventListener('focus', this.onWake);
    document.addEventListener('visibilitychange', this.onWake);
    this.set('thinking'); // waiting for the agent's greeting
  }

  /** Agent speaks. Resolves when finished or interrupted. */
  async speak(text: string): Promise<void> {
    if (!this.active) return;
    const token = ++this.speakToken;
    this.stopSpeech();
    this.clearSilence();
    this.speakingText = text;
    this.heardText = '';
    this.set('speaking');
    if (this.synthesize) {
      // Sentences render in parallel so the first one can start while later ones finish.
      const chunks = speechChunks(text);
      const controller = new AbortController();
      const renders = chunks.map((line) => this.synthesize!(line, controller.signal)
        .then((data) => ({ kind: 'audio' as const, data }))
        .catch(() => ({ kind: 'failed' as const })));
      const wait = <T,>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<{ kind: 'slow' }>((r) => setTimeout(() => r({ kind: 'slow' }), ms))]);
      try {
        let spokenSoFar: string[] = [];
        for (let i = 0; i < chunks.length; i++) {
          const result = await wait(renders[i], i === 0 ? 4500 : 8000);
          if (token !== this.speakToken || !this.active) { controller.abort(); return; }
          if (result.kind !== 'audio') {
            controller.abort();
            // One voice per call: after a real failure, stay on the browser voice.
            if (result.kind === 'failed') this.synthesize = undefined;
            const rest = chunks.slice(i).join(' ');
            if ('speechSynthesis' in window) await this.speakInBrowser(rest, token, spokenSoFar.join(' '));
            else this.spoken();
            return;
          }
          await this.playGenerated(result.data, token, chunks[i], spokenSoFar.join(' '));
          if (token !== this.speakToken || !this.active) return;
          spokenSoFar.push(chunks[i]);
        }
        this.spoken();
        return;
      } catch {
        controller.abort();
        this.synthesize = undefined;
        // Playback failed; the browser voice reads the whole line.
      }
    }
    if ('speechSynthesis' in window) await this.speakInBrowser(text, token);
    else this.spoken();
  }

  private speakInBrowser(text: string, token: number, already = ''): Promise<void> {
    const chunks = text.match(/[^.!?]+[.!?]*\s*/g) || [text]; // Chrome cuts off long utterances
    return new Promise((resolve) => {
      let i = 0;
      const heardChunks: string[] = already ? [already] : [];
      const next = () => {
        if (token !== this.speakToken || !this.active) return resolve();
        if (i >= chunks.length) {
          this.spoken();
          return resolve();
        }
        const chunk = chunks[i++].trim();
        const u = new SpeechSynthesisUtterance(chunk);
        let advanced = false;
        // Safari sometimes never fires onend; move on after a generous estimate of the chunk's length.
        const guard = setTimeout(() => { if (!advanced) { advanced = true; heardChunks.push(chunk); next(); } }, 2500 + chunk.length * 95);
        const go = () => { if (advanced) return false; advanced = true; clearTimeout(guard); return true; };
        if (this.voice) u.voice = this.voice;
        u.rate = this.rate;
        u.onboundary = (event: any) => {
          const partial = chunk.slice(0, event.charIndex || 0).replace(/\s+\S*$/, '').trim();
          this.heardText = [...heardChunks, partial].filter(Boolean).join(' ');
        };
        u.onend = () => {
          if (!go()) return;
          heardChunks.push(chunk);
          this.heardText = heardChunks.join(' ');
          next();
        };
        u.onerror = () => { if (go()) next(); };
        if (i === 1) setTimeout(() => { if (token === this.speakToken && this.active) speechSynthesis.speak(u); }, 60);
        else speechSynthesis.speak(u);
      };
      next();
    });
  }

  private playGenerated(data: ArrayBuffer, token: number, line: string, already: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(new Blob([data], { type: 'audio/wav' }));
      const audio = new Audio(url);
      this.remoteAudio = audio;
      this.remoteAudioUrl = url;
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        if (this.remoteAudio === audio) this.remoteAudio = null;
        if (this.remoteAudioUrl === url) this.remoteAudioUrl = '';
        URL.revokeObjectURL(url);
        ok ? resolve() : reject(new Error('audio_playback_failed'));
      };
      audio.onended = () => done(true);
      audio.onerror = () => done(false);
      audio.ontimeupdate = () => {
        if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
        const chars = Math.floor(line.length * Math.min(1, audio.currentTime / audio.duration));
        this.heardText = [already, line.slice(0, chars).replace(/\s+\S*$/, '').trim()].filter(Boolean).join(' ');
      };
      audio.play().catch(() => done(false));
      if (token !== this.speakToken) { audio.pause(); done(true); }
    });
  }

  private spoken() {
    this.lastSpokeAt = Date.now();
    this.speakingText = '';
    if (this.status === 'speaking') this.set('listening');
    this.armSilence();
  }

  private stopSpeech() {
    try { speechSynthesis.cancel(); } catch {}
    if (this.remoteAudio) { this.remoteAudio.pause(); this.remoteAudio = null; }
    if (this.remoteAudioUrl) { URL.revokeObjectURL(this.remoteAudioUrl); this.remoteAudioUrl = ''; }
  }

  thinking() { if (this.active && this.status !== 'speaking') this.set('thinking'); }
  listening() { if (this.active && this.status === 'thinking') { this.set('listening'); this.armSilence(); } }

  interrupt() {
    const heard = this.heardText;
    this.speakToken++;
    this.stopSpeech();
    this.speakingText = '';
    this.lastSpokeAt = Date.now();
    if (this.active) this.set('listening');
    return heard;
  }

  setMuted(m: boolean) {
    this.muted = m;
    this.stream?.getAudioTracks().forEach((t) => (t.enabled = !m));
    if (m) { this.finalBuf = ''; this.interim = ''; this.h.onCaption?.(''); this.clearSilence(); }
    else this.armSilence();
  }

  end(reason: EndReason = 'user') { this.finish(reason); }

  /** Restart listening if the recognizer died (popup focus loss, network blip). */
  resume() {
    if (!this.active || this.muted || document.visibilityState === 'hidden') return;
    if (!this.recRunning && Date.now() - this.lastRecStart > 2000) {
      try { this.rec?.abort(); } catch {}
      this.rec = null;
      this.listen();
    }
    if (this.status === 'thinking' && !this.speakingText && Date.now() - this.lastSpokeAt > 15000) this.set('listening');
  }

  // ---- internals ----

  private listen() {
    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || 'en-US';
    this.sentByIndex.clear();
    this.interimByIndex.clear();
    rec.onresult = (e: any) => {
      this.recRunning = true;
      if (this.muted) return;
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const full = r[0].transcript;
        const txt = this.unsent(i, full);
        if (r.isFinal) {
          this.sentByIndex.delete(i);
          this.interimByIndex.delete(i);
          if (txt.trim() && !this.isEcho(txt)) this.finalBuf += ' ' + txt;
        } else {
          this.interimByIndex.set(i, full);
          interim += ' ' + txt;
        }
      }
      this.interim = this.isEcho(interim) ? '' : interim;
      const live = (this.finalBuf + ' ' + this.interim).trim();
      if (this.status === 'speaking' && BACKCHANNEL.test(live)) {
        this.finalBuf = '';
        this.interim = '';
        clearTimeout(this.endpointTimer);
        clearTimeout(this.bargeTimer);
        this.bargeCandidate = '';
        this.h.onCaption?.('');
        return;
      }
      this.h.onCaption?.(live);
      if (!live) return;
      this.clearSilence();
      this.silenceStrikes = 0;
      // Confirm a real, stable phrase before stopping speech. A quick “yeah”
      // or a recognizer flicker must never cut the user-facing reply off.
      if (this.status === 'speaking') {
        const words = live.split(/\s+/).filter(Boolean);
        const meaningful = words.length >= 3 || (words.length >= 2 && live.length >= 14);
        if (meaningful) {
          if (this.bargeCandidate !== live) {
            this.bargeCandidate = live;
            clearTimeout(this.bargeTimer);
            const candidate = live;
            this.bargeTimer = setTimeout(() => {
              if (this.status !== 'speaking' || this.bargeCandidate !== candidate) return;
              const heard = this.interrupt();
              this.h.onBargeIn?.(heard);
              this.bargeCandidate = '';
            }, BARGE_CONFIRM_MS);
          }
        } else {
          clearTimeout(this.bargeTimer);
          this.bargeCandidate = '';
        }
      }
      clearTimeout(this.endpointTimer);
      const wait = TRAILING.test(live) ? TRAILING_MS : this.finalBuf ? ENDPOINT_MS : INTERIM_ENDPOINT_MS;
      this.endpointTimer = setTimeout(() => this.flush(), wait);
    };
    rec.onstart = () => { this.recRunning = true; this.restarts = 0; };
    rec.onaudiostart = () => { this.recRunning = true; };
    rec.onerror = (e: any) => {
      if (e.error === 'service-not-allowed') this.finish('unsupported'); // Safari: Dictation/Siri is off
      else if (e.error === 'not-allowed') this.finish('mic_denied');
      else if (e.error === 'network' || e.error === 'audio-capture') { if (++this.restarts > 4) this.finish('error'); }
      // 'no-speech' and 'aborted' are routine; onend restarts us.
    };
    rec.onend = () => {
      if (this.rec === rec) this.recRunning = false;
      if (!this.active) return;
      setTimeout(() => { if (this.active && this.rec === rec) try { rec.start(); } catch { this.rec = null; this.listen(); } }, 150);
    };
    this.rec = rec;
    this.lastRecStart = Date.now();
    try { rec.start(); } catch {}
  }

  // Words of a recognizer result that have not already been sent.
  private unsent(i: number, full: string) {
    const prev = this.sentByIndex.get(i);
    if (!prev) return full;
    const words = (x: string) => x.toLowerCase().match(/[a-z0-9']+/g) || [];
    const sent = words(prev), now = words(full);
    const same = sent.filter((w, k) => now[k] === w).length;
    if (!sent.length || same / sent.length < 0.6) return full;
    // Drop as many leading raw words as were already sent.
    return full.trim().split(/\s+/).slice(sent.length).join(' ');
  }

  private flush() {
    const text = (this.finalBuf + ' ' + this.interim).replace(/\s+/g, ' ').trim();
    for (const [i, t] of this.interimByIndex) this.sentByIndex.set(i, t);
    this.interimByIndex.clear();
    this.finalBuf = '';
    this.interim = '';
    this.h.onCaption?.('');
    if (!text || this.muted) return;
    if (HOLD_ON.test(text)) {
      this.holdOn = true;
      this.silenceStrikes = 0;
      this.h.onReprompt?.('Of course. Take your time.', 0);
      void this.speak('Of course. Take your time.');
      return;
    }
    this.set('thinking');
    this.h.onUtterance?.(text);
  }

  // The recognizer can hear our own TTS through speakers. Drop text that mostly
  // repeats what we are saying (or just said).
  private isEcho(txt: string) {
    const said = (this.speakingText || (Date.now() - this.lastSpokeAt < 1500 ? '__recent__' : '')).toLowerCase();
    if (!said || !txt.trim()) return false;
    if (said === '__recent__') return false;
    const w = txt.toLowerCase().match(/[a-z']+/g) || [];
    if (!w.length) return false;
    const bag = new Set(said.match(/[a-z']+/g) || []);
    const hit = w.filter((x) => bag.has(x)).length;
    return hit / w.length >= 0.7;
  }

  private armSilence() {
    this.clearSilence();
    if (!this.active || this.muted) return;
    const delay = this.holdOn ? 45000 : [25000, 30000, 60000, 12000][Math.min(this.silenceStrikes, 3)];
    this.holdOn = false;
    this.silenceTimer = setTimeout(async () => {
      if (!this.active || this.status !== 'listening') return;
      this.silenceStrikes++;
      if (this.silenceStrikes === 1) {
        const t = this.h.onSilenceText?.(1) || 'No rush. I’m still here when you’re ready.';
        this.h.onReprompt?.(t, 1);
        await this.speak(t);
      } else if (this.silenceStrikes === 2) {
        const t = 'Take all the time you need. I’m right here.';
        this.h.onReprompt?.(t, 2);
        await this.speak(t);
      } else if (this.silenceStrikes === 3) {
        const t = 'I’ll stay on the line a little longer. If you need a moment, just say “hold on.”';
        this.h.onReprompt?.(t, 3);
        await this.speak(t);
      } else {
        const t = "I'll hang up for now. You can keep going by typing, or call me back anytime.";
        this.h.onReprompt?.(t, 4);
        await this.speak(t);
        this.finish('silence');
      }
    }, delay);
  }
  private clearSilence() { clearTimeout(this.silenceTimer); }

  private meter() {
    try {
      const Ctx = window.AudioContext || (window as any).webkitAudioContext;
      this.audioCtx = new Ctx();
      const src = this.audioCtx.createMediaStreamSource(this.stream!);
      const an = this.audioCtx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      const buf = new Uint8Array(an.fftSize);
      const loop = () => {
        an.getByteTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += ((v - 128) / 128) ** 2;
        const lvl = this.muted ? 0 : Math.min(1, Math.sqrt(sum / buf.length) * 4);
        this.h.onLevel?.(lvl);
        this.raf = requestAnimationFrame(loop);
      };
      loop();
    } catch {}
  }

  private pickVoice() {
    if (!('speechSynthesis' in window)) return;
    const choose = () => {
      const vs = speechSynthesis.getVoices();
      const pref = [/Samantha/i, /Google US English/i, /Aria.*Natural/i, /Jenny.*Natural/i, /Natural/i, /Google.*English/i, /en-US/i];
      for (const p of pref) { const v = vs.find((x) => p.test(x.name) || p.test(x.lang)); if (v) { this.voice = v; return; } }
    };
    choose();
    if (!this.voice) speechSynthesis.onvoiceschanged = choose;
  }

  private stopStream() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  private finish(reason: EndReason) {
    const wasActive = this.active || reason === 'unsupported' || reason === 'mic_denied';
    const partial = (this.finalBuf + ' ' + this.interim).replace(/\s+/g, ' ').trim();
    const midSpeech = !!partial;
    this.active = false;
    clearInterval(this.watchdog);
    removeEventListener('focus', this.onWake);
    document.removeEventListener('visibilitychange', this.onWake);
    clearTimeout(this.endpointTimer);
    clearTimeout(this.bargeTimer);
    this.clearSilence();
    this.speakToken++;
    this.stopSpeech();
    try { this.rec?.abort(); } catch {}
    this.rec = null;
    cancelAnimationFrame(this.raf);
    this.audioCtx?.close().catch(() => {});
    this.audioCtx = null;
    this.stopStream();
    this.finalBuf = this.interim = '';
    this.h.onLevel?.(0);
    this.h.onCaption?.('');
    this.set('ended');
    if (wasActive) this.h.onEnd?.(reason, { midSpeech, partial });
  }

  private set(s: CallStatus) {
    if (this.status === s) return;
    this.status = s;
    this.h.onStatus?.(s);
  }
}
