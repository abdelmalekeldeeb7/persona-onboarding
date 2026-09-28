// Browser voice call: speech recognition in, speech synthesis out.
// Framework-agnostic so any UI can drive it. Handles barge-in, echo, silence,
// recognizer restarts, mic denial and mute.

export type CallStatus = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'ended';
export type EndReason = 'user' | 'agent' | 'silence' | 'error' | 'mic_denied' | 'unsupported' | 'tab_closed';

type Handlers = {
  onStatus?: (s: CallStatus) => void;
  onCaption?: (text: string) => void; // live interim transcript
  onUtterance?: (text: string) => void; // a finished user utterance to send
  onBargeIn?: () => void;
  onLevel?: (level: number) => void; // 0..1 mic level for visuals
  onEnd?: (reason: EndReason, info: { midSpeech: boolean; partial: string }) => void;
  onReprompt?: (text: string, strike: number) => void; // locally generated nudge (silence)
};

type CallOptions = {
  synthesize?: (text: string, signal?: AbortSignal) => Promise<ArrayBuffer>;
};

const SR: any = typeof window !== 'undefined' && ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);

export const voiceSupport = () => ({
  recognition: !!SR,
  synthesis: typeof window !== 'undefined' && 'speechSynthesis' in window,
});

const ENDPOINT_MS = 620; // short pause after a recognized phrase before responding
const SILENCE_MS = 13000;

export class Call {
  status: CallStatus = 'idle';
  muted = false;
  rate = 1.04;
  private h: Handlers;
  private rec: any = null;
  private active = false;
  private finalBuf = '';
  private interim = '';
  private endpointTimer: any = null;
  private silenceTimer: any = null;
  private silenceStrikes = 0;
  private restarts = 0;
  private stream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private raf = 0;
  private speakingText = '';
  private lastSpokeAt = 0;
  private voice: SpeechSynthesisVoice | null = null;
  private speakToken = 0;
  private synthesize?: (text: string, signal?: AbortSignal) => Promise<ArrayBuffer>;
  private remoteAudio: HTMLAudioElement | null = null;
  private remoteAudioUrl = '';

  constructor(h: Handlers, options: CallOptions = {}) { this.h = h; this.synthesize = options.synthesize; }

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
    this.set('thinking'); // waiting for the agent's greeting
  }

  /** Agent speaks. Resolves when finished or interrupted. */
  async speak(text: string): Promise<void> {
    if (!this.active) return;
    const token = ++this.speakToken;
    this.stopSpeech();
    this.clearSilence();
    this.speakingText = text;
    this.set('speaking');
    if (this.synthesize) {
      const controller = new AbortController();
      try {
        const generated = this.synthesize(text, controller.signal)
          .then((data) => ({ kind: 'audio' as const, data }))
          .catch((error) => ({ kind: 'failed' as const, error }));
        // Do not leave a live conversation silent while cloud speech is rendered.
        const result = await Promise.race([
          generated,
          new Promise<{ kind: 'slow' }>((resolve) => setTimeout(() => resolve({ kind: 'slow' }), 850)),
        ]);
        if (token !== this.speakToken || !this.active) { controller.abort(); return; }
        if (result.kind === 'audio') {
          await this.playGenerated(result.data, token);
          if (token !== this.speakToken || !this.active) return;
          this.spoken();
          return;
        }
        // A slow request is canceled so its late audio cannot interrupt the fallback.
        controller.abort();
      } catch {
        // Network, quota and model failures fall back to the browser voice.
      }
    }
    if ('speechSynthesis' in window) await this.speakInBrowser(text, token);
    else this.spoken();
  }

  private speakInBrowser(text: string, token: number): Promise<void> {
    const chunks = text.match(/[^.!?]+[.!?]*\s*/g) || [text]; // Chrome cuts off long utterances
    return new Promise((resolve) => {
      let i = 0;
      const next = () => {
        if (token !== this.speakToken || !this.active) return resolve();
        if (i >= chunks.length) {
          this.spoken();
          return resolve();
        }
        const u = new SpeechSynthesisUtterance(chunks[i++].trim());
        if (this.voice) u.voice = this.voice;
        u.rate = this.rate;
        u.onend = next;
        u.onerror = next;
        speechSynthesis.speak(u);
      };
      next();
    });
  }

  private playGenerated(data: ArrayBuffer, token: number): Promise<void> {
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
    this.speakToken++;
    this.stopSpeech();
    this.speakingText = '';
    this.lastSpokeAt = Date.now();
    if (this.active) this.set('listening');
  }

  setMuted(m: boolean) {
    this.muted = m;
    this.stream?.getAudioTracks().forEach((t) => (t.enabled = !m));
    if (m) { this.finalBuf = ''; this.interim = ''; this.h.onCaption?.(''); this.clearSilence(); }
    else this.armSilence();
  }

  end(reason: EndReason = 'user') { this.finish(reason); }

  // ---- internals ----

  private listen() {
    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || 'en-US';
    rec.onresult = (e: any) => {
      if (this.muted) return;
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const txt = r[0].transcript;
        if (r.isFinal) {
          if (!this.isEcho(txt)) this.finalBuf += ' ' + txt;
        } else interim += txt;
      }
      this.interim = this.isEcho(interim) ? '' : interim;
      const live = (this.finalBuf + ' ' + this.interim).trim();
      this.h.onCaption?.(live);
      if (!live) return;
      this.clearSilence();
      this.silenceStrikes = 0;
      // Barge-in: user starts talking over the agent.
      if (this.status === 'speaking' && live.split(/\s+/).length >= 2) {
        this.interrupt();
        this.h.onBargeIn?.();
      }
      clearTimeout(this.endpointTimer);
      this.endpointTimer = setTimeout(() => this.flush(), this.finalBuf ? ENDPOINT_MS : 900);
    };
    rec.onerror = (e: any) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') this.finish('mic_denied');
      else if (e.error === 'network' || e.error === 'audio-capture') { if (++this.restarts > 4) this.finish('error'); }
      // 'no-speech' and 'aborted' are routine; onend restarts us.
    };
    rec.onend = () => {
      if (!this.active) return;
      setTimeout(() => { if (this.active && this.rec === rec) try { rec.start(); } catch { this.rec = null; this.listen(); } }, 150);
    };
    this.rec = rec;
    try { rec.start(); } catch {}
  }

  private flush() {
    const text = (this.finalBuf + ' ' + this.interim).replace(/\s+/g, ' ').trim();
    this.finalBuf = '';
    this.interim = '';
    this.h.onCaption?.('');
    if (!text || this.muted) return;
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
    this.silenceTimer = setTimeout(async () => {
      if (!this.active || this.status !== 'listening') return;
      this.silenceStrikes++;
      if (this.silenceStrikes === 1) {
        const t = 'Still there? Take your time.';
        this.h.onReprompt?.(t, 1);
        await this.speak(t);
      } else {
        const t = "I'll hang up for now. You can keep going by typing, or call me back anytime.";
        this.h.onReprompt?.(t, 2);
        await this.speak(t);
        this.finish('silence');
      }
    }, SILENCE_MS);
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
    clearTimeout(this.endpointTimer);
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
