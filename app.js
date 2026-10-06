/* ============================================================================
   NOVA — AI Voice Assistant
   ----------------------------------------------------------------------------
   Web Speech API (SpeechRecognition + speechSynthesis) + a reactive canvas orb
   + a pluggable reasoning layer (offline rule engine / proxy / Claude direct).

   Structure
     1.  Config & persisted settings
     2.  DOM references
     3.  Tiny helpers (toasts, time, sanitising)
     4.  App state machine
     5.  Orb renderer (canvas)
     6.  Mic level meter (Web Audio AnalyserNode)
     7.  Speech-to-text
     8.  Text-to-speech
     9.  Reasoning layer: Claude / proxy / offline core
     10. Conversation turn handling + transcript UI
     11. Settings sheet
     12. Event wiring & boot
   ========================================================================== */

'use strict';

/* ==========================================================================
   1 · CONFIG & SETTINGS
   ========================================================================== */

const ASSISTANT_NAME = 'NOVA';

/**
 * Voice-tuned system prompt. Replies are spoken aloud, so they must stay short
 * and free of markdown / symbols that a speech synthesiser reads badly.
 */
const SYSTEM_PROMPT = [
  `You are ${ASSISTANT_NAME}, a voice assistant. Your replies are spoken aloud by a`,
  `speech synthesiser, so write for the ear, not the eye.`,
  ``,
  `- Answer in 1-3 short sentences unless the person asks for depth.`,
  `- Lead with the answer. No preamble, no restating the question.`,
  `- Plain prose only: no markdown, bullet points, headings, emoji, or code fences.`,
  `- Spell things out the way a person would say them: "20 percent", "3 times 4".`,
  `- If a request is ambiguous, ask one brief clarifying question instead of guessing.`,
  `- If you don't know something, say so plainly.`
].join('\n');

/** Defaults, overridden by anything found in localStorage. */
const DEFAULTS = {
  engine: 'local',                       // 'local' | 'proxy' | 'anthropic'
  proxyUrl: '',
  apiKey: '',
  model: 'claude-opus-5',
  baseUrl: 'https://api.anthropic.com',
  lang: 'en-US',
  voiceURI: '',
  rate: 1.02,
  pitch: 1.0,
  muted: false,
  handsFree: false
};

const STORE_KEY = 'nova.settings.v1';

const settings = (() => {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); } catch { /* corrupt — ignore */ }
  return { ...DEFAULTS, ...saved };
})();

function saveSettings() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch { /* private mode */ }
}

/** Conversation history in Messages-API shape. Trimmed to keep requests small. */
const history = [];
const MAX_HISTORY_TURNS = 20;

/* ==========================================================================
   2 · DOM
   ========================================================================== */

const $ = (sel) => document.querySelector(sel);

const dom = {
  body:        document.body,
  statusDot:   $('#statusPill .pill__dot'),
  statusLabel: $('#statusLabel'),
  engineLabel: $('#engineLabel'),

  orbWrap:  $('#orbWrap'),
  orb:      $('#orb'),
  eq:       $('#eq'),
  liveText: $('#liveText'),

  btnMic:   $('#btnMic'),
  micLabel: $('#micLabel'),
  btnMute:  $('#btnMute'),
  btnAuto:  $('#btnAuto'),

  feed:       $('#feed'),
  emptyState: $('#emptyState'),
  turnCount:  $('#turnCount'),
  btnClear:   $('#btnClear'),

  composer:  $('#composer'),
  textInput: $('#textInput'),

  btnSettings: $('#btnSettings'),
  sheet:       $('#sheet'),
  segEngine:   $('#segEngine'),
  engineHint:  $('#engineHint'),
  proxyUrl:    $('#proxyUrl'),
  apiKey:      $('#apiKey'),
  modelId:     $('#modelId'),
  langSel:     $('#langSel'),
  voiceSel:    $('#voiceSel'),
  rate:        $('#rate'),
  rateVal:     $('#rateVal'),
  pitch:       $('#pitch'),
  pitchVal:    $('#pitchVal'),
  btnTestVoice: $('#btnTestVoice'),

  toasts: $('#toasts')
};

/* ==========================================================================
   3 · HELPERS
   ========================================================================== */

function toast(message, kind = '', ms = 3800) {
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ` toast--${kind}` : '');
  el.textContent = message;
  dom.toasts.appendChild(el);
  setTimeout(() => {
    el.classList.add('toast--out');
    setTimeout(() => el.remove(), 320);
  }, ms);
}

const clockTime = (d = new Date()) =>
  d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const lerp  = (a, b, t) => a + (b - a) * t;

/** Shortest signed distance between two hues, for smooth colour blending. */
function hueLerp(a, b, t) {
  let d = ((b - a + 540) % 360) - 180;
  return (a + d * t + 360) % 360;
}

/* ==========================================================================
   4 · STATE MACHINE
   ========================================================================== */

const STATUS_TEXT = {
  idle:      'Ready',
  listening: 'Listening…',
  thinking:  'Thinking…',
  speaking:  'Speaking…',
  error:     'Error'
};

const app = {
  state: 'idle',
  listening: false,
  busy: false,         // a request is in flight
  pendingAuto: false   // hands-free re-listen queued
};

function setState(next) {
  app.state = next;
  dom.body.dataset.state = next;
  dom.statusDot.dataset.state = next;
  dom.statusLabel.textContent = STATUS_TEXT[next] || next;
  orb.setState(next);

  dom.btnMic.setAttribute('aria-pressed', String(next === 'listening'));
  dom.micLabel.textContent =
    next === 'listening' ? 'Listening — tap to stop'
    : next === 'thinking' ? 'Working on it'
    : next === 'speaking' ? 'Tap to interrupt'
    : 'Tap to speak';
}

/* ==========================================================================
   5 · ORB RENDERER
   ========================================================================== */

/** Per-state hue pair + motion character. */
const ORB_LOOKS = {
  idle:      { hues: [188, 272], spin: 0.10, wobble: 0.55, bloom: 0.85 },
  listening: { hues: [172, 205], spin: 0.20, wobble: 1.00, bloom: 1.15 },
  thinking:  { hues: [ 42, 284], spin: 0.52, wobble: 0.85, bloom: 1.00 },
  speaking:  { hues: [303, 266], spin: 0.26, wobble: 1.25, bloom: 1.25 },
  error:     { hues: [352,  12], spin: 0.12, wobble: 0.40, bloom: 0.75 }
};

class Orb {
  constructor(canvas, wrap) {
    this.canvas = canvas;
    this.wrap = wrap;
    this.ctx = canvas.getContext('2d');
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);

    this.w = 0;
    this.h = 0;

    this.hueA = ORB_LOOKS.idle.hues[0];
    this.hueB = ORB_LOOKS.idle.hues[1];
    this.look = ORB_LOOKS.idle;

    this.level = 0;        // smoothed 0..1 audio energy
    this.targetLevel = 0;
    this.spin = 0;
    this.t = 0;
    this.reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Orbiting motes
    this.motes = Array.from({ length: 44 }, (_, i) => ({
      a: (i / 44) * Math.PI * 2 + Math.random(),
      r: 0.78 + Math.random() * 0.55,
      s: 0.25 + Math.random() * 0.85,
      z: 0.4 + Math.random() * 0.6
    }));

    this._resize();
    if ('ResizeObserver' in window) {
      new ResizeObserver(() => this._resize()).observe(wrap);
    } else {
      window.addEventListener('resize', () => this._resize());
    }

    this._last = performance.now();
    requestAnimationFrame((t) => this._frame(t));
  }

  _resize() {
    const rect = this.wrap.getBoundingClientRect();
    const size = Math.max(120, Math.min(rect.width, rect.height));
    this.w = size;
    this.h = size;
    this.canvas.width = Math.round(size * this.dpr);
    this.canvas.height = Math.round(size * this.dpr);
  }

  setState(state) {
    this.look = ORB_LOOKS[state] || ORB_LOOKS.idle;
  }

  /** Feed 0..1 energy from the mic, or from synthesised speech cadence. */
  setLevel(v) {
    this.targetLevel = clamp(v, 0, 1);
  }

  _frame(now) {
    const dt = Math.min((now - this._last) / 1000, 0.05);
    this._last = now;
    this.t += dt;

    // ease colours + energy toward their targets
    this.hueA = hueLerp(this.hueA, this.look.hues[0], 1 - Math.pow(0.001, dt));
    this.hueB = hueLerp(this.hueB, this.look.hues[1], 1 - Math.pow(0.001, dt));
    this.level = lerp(this.level, this.targetLevel, 1 - Math.pow(0.0008, dt));
    this.spin += dt * this.look.spin;

    this._draw();
    requestAnimationFrame((t) => this._frame(t));
  }

  _draw() {
    const { ctx, dpr } = this;
    const W = this.w, H = this.h;
    const cx = W / 2, cy = H / 2;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const t = this.t;
    const lvl = this.level;
    const breath = this.reduced ? 0 : Math.sin(t * 1.15) * 0.5 + 0.5; // 0..1
    const R = W * 0.27 * (1 + breath * 0.028 + lvl * 0.075);

    const cA = (a = 1, l = 62) => `hsla(${this.hueA.toFixed(1)}, 95%, ${l}%, ${a})`;
    const cB = (a = 1, l = 62) => `hsla(${this.hueB.toFixed(1)}, 92%, ${l}%, ${a})`;

    /* ---- outer bloom ---- */
    const bloomR = R * (2.55 + lvl * 0.5) * this.look.bloom;
    const bloom = ctx.createRadialGradient(cx, cy, R * 0.2, cx, cy, bloomR);
    bloom.addColorStop(0, cA(0.30 + lvl * 0.22, 58));
    bloom.addColorStop(0.45, cB(0.13 + lvl * 0.12, 52));
    bloom.addColorStop(1, 'hsla(240, 60%, 10%, 0)');
    ctx.fillStyle = bloom;
    ctx.beginPath();
    ctx.arc(cx, cy, bloomR, 0, Math.PI * 2);
    ctx.fill();

    /* ---- rotating technical rings ---- */
    ctx.save();
    ctx.lineCap = 'round';
    const rings = [
      { r: 1.62, w: 1.0, dash: [2, 16], speed: 1.0,  a: 0.55 },
      { r: 1.42, w: 1.6, dash: [46, 30], speed: -0.7, a: 0.45 },
      { r: 1.24, w: 1.0, dash: [4, 10], speed: 1.7,  a: 0.35 }
    ];
    for (const ring of rings) {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(this.spin * ring.speed * Math.PI * 2);
      ctx.setLineDash(ring.dash);
      ctx.lineWidth = ring.w;
      ctx.strokeStyle = cA(ring.a * (0.65 + lvl * 0.5), 70);
      ctx.beginPath();
      ctx.arc(0, 0, R * ring.r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();

    /* ---- sweeping accent arc ---- */
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(this.spin * Math.PI * 2 * 1.15);
    const sweep = ctx.createLinearGradient(-R, 0, R, 0);
    sweep.addColorStop(0, cA(0, 70));
    sweep.addColorStop(1, cB(0.85, 72));
    ctx.strokeStyle = sweep;
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(0, 0, R * 1.42, -0.85, 0.32);
    ctx.stroke();
    ctx.restore();

    /* ---- waveform rings ---- */
    const drawWave = (radius, amp, freqs, alpha, width, phase) => {
      const steps = 200;
      ctx.beginPath();
      for (let i = 0; i <= steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        let d = 0;
        for (const f of freqs) {
          d += Math.sin(a * f.k + t * f.s + phase) * f.w;
        }
        const r = radius * (1 + d * amp);
        const x = cx + Math.cos(a) * r;
        const y = cy + Math.sin(a) * r;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.closePath();
      const g = ctx.createLinearGradient(cx - radius, cy - radius, cx + radius, cy + radius);
      g.addColorStop(0, cA(alpha, 68));
      g.addColorStop(1, cB(alpha, 66));
      ctx.strokeStyle = g;
      ctx.lineWidth = width;
      ctx.shadowColor = cA(0.85, 62);
      ctx.shadowBlur = 16 + lvl * 26;
      ctx.stroke();
      ctx.shadowBlur = 0;
    };

    const wob = this.look.wobble * (0.035 + lvl * 0.16);
    drawWave(R * 1.06, wob, [
      { k: 3, s: 1.1, w: 0.55 }, { k: 5, s: -1.7, w: 0.3 }, { k: 8, s: 2.3, w: 0.18 }
    ], 0.95, 2.1, 0);
    drawWave(R * 0.94, wob * 0.8, [
      { k: 4, s: -1.4, w: 0.5 }, { k: 7, s: 2.0, w: 0.26 }, { k: 11, s: -2.6, w: 0.14 }
    ], 0.5, 1.2, 1.9);

    /* ---- core ---- */
    const coreR = R * (0.74 + lvl * 0.06);
    const core = ctx.createRadialGradient(
      cx - coreR * 0.28, cy - coreR * 0.32, coreR * 0.05,
      cx, cy, coreR
    );
    core.addColorStop(0, `hsla(${this.hueA.toFixed(1)}, 100%, 97%, 0.98)`);
    core.addColorStop(0.28, cA(0.85, 72));
    core.addColorStop(0.68, cB(0.62, 52));
    core.addColorStop(1, `hsla(${this.hueB.toFixed(1)}, 85%, 22%, 0.85)`);
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
    ctx.fill();

    // inner shading for depth
    const shade = ctx.createRadialGradient(cx, cy, coreR * 0.55, cx, cy, coreR);
    shade.addColorStop(0, 'rgba(0,0,0,0)');
    shade.addColorStop(1, 'rgba(2,2,10,0.55)');
    ctx.fillStyle = shade;
    ctx.beginPath();
    ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
    ctx.fill();

    // specular highlight
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    const spec = ctx.createRadialGradient(
      cx - coreR * 0.34, cy - coreR * 0.4, 0,
      cx - coreR * 0.34, cy - coreR * 0.4, coreR * 0.72
    );
    spec.addColorStop(0, 'rgba(255,255,255,0.55)');
    spec.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = spec;
    ctx.beginPath();
    ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // rim light
    ctx.strokeStyle = `hsla(${this.hueA.toFixed(1)}, 100%, 88%, ${0.4 + lvl * 0.4})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
    ctx.stroke();

    /* ---- orbiting motes ---- */
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    for (const m of this.motes) {
      const a = m.a + t * m.s * 0.32 + this.spin * 0.8;
      const rr = R * m.r * (1 + Math.sin(t * 0.7 + m.a) * 0.06 + lvl * 0.1);
      const x = cx + Math.cos(a) * rr;
      const y = cy + Math.sin(a) * rr * 0.94;
      const size = (0.9 + m.z * 1.9) * (1 + lvl * 0.9);
      ctx.fillStyle = (m.z > 0.55 ? cA : cB)(0.15 + m.z * 0.55 * (0.5 + lvl * 0.7), 80);
      ctx.beginPath();
      ctx.arc(x, y, size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

const orb = new Orb(dom.orb, dom.orbWrap);

/* ---- equaliser bars under the orb ---- */
const EQ_BARS = 30;
const eqBars = [];
for (let i = 0; i < EQ_BARS; i++) {
  const bar = document.createElement('span');
  dom.eq.appendChild(bar);
  eqBars.push(bar);
}

let eqPhase = 0;
function paintEq(level) {
  eqPhase += 0.09;
  const mid = (EQ_BARS - 1) / 2;
  for (let i = 0; i < EQ_BARS; i++) {
    const falloff = 1 - Math.abs(i - mid) / (mid + 2);           // taper at the edges
    const noise = 0.45 + 0.55 * Math.abs(Math.sin(eqPhase * (0.7 + i * 0.11) + i));
    const h = 3 + level * 23 * falloff * noise;
    eqBars[i].style.height = h.toFixed(1) + 'px';
    eqBars[i].style.opacity = (0.35 + level * 0.65).toFixed(2);
  }
}

/* ==========================================================================
   6 · MIC LEVEL METER
   ========================================================================== */

const meter = {
  ctx: null,
  analyser: null,
  stream: null,
  data: null,
  raf: 0,
  active: false,

  async start() {
    if (this.active) return true;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('unsupported');
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true }
      });
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      const src = this.ctx.createMediaStreamSource(this.stream);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0.75;
      src.connect(this.analyser);
      this.data = new Uint8Array(this.analyser.fftSize);
      this.active = true;
      this._loop();
      return true;
    } catch {
      this.active = false;
      return false;   // fall back to synthetic animation
    }
  },

  _loop() {
    if (!this.active) return;
    this.analyser.getByteTimeDomainData(this.data);
    let sum = 0;
    for (let i = 0; i < this.data.length; i++) {
      const v = (this.data[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / this.data.length);
    const level = clamp(Math.pow(rms * 3.4, 0.85), 0, 1);
    if (app.state === 'listening') {
      orb.setLevel(level);
      paintEq(level);
    }
    this.raf = requestAnimationFrame(() => this._loop());
  },

  stop() {
    this.active = false;
    cancelAnimationFrame(this.raf);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.ctx && this.ctx.state !== 'closed') this.ctx.close().catch(() => {});
    this.ctx = null;
    this.analyser = null;
  }
};

/* Synthetic energy for states where there is no analysable signal
   (speaking / thinking), plus a calm idle drift. */
let synthT = 0;
setInterval(() => {
  synthT += 0.08;
  if (app.state === 'speaking') {
    const v = 0.34 + 0.3 * Math.abs(Math.sin(synthT * 2.4)) + 0.16 * Math.abs(Math.sin(synthT * 5.7));
    orb.setLevel(clamp(v, 0, 1));
    paintEq(v * 0.9);
  } else if (app.state === 'thinking') {
    const v = 0.2 + 0.14 * Math.abs(Math.sin(synthT * 3.1));
    orb.setLevel(v);
    paintEq(v * 0.6);
  } else if (app.state === 'listening' && !meter.active) {
    const v = 0.22 + 0.2 * Math.abs(Math.sin(synthT * 1.9));
    orb.setLevel(v);
    paintEq(v);
  } else if (app.state === 'idle' || app.state === 'error') {
    orb.setLevel(0.05);
    paintEq(0.07);
  }
}, 55);

/* ==========================================================================
   7 · SPEECH-TO-TEXT
   ========================================================================== */

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

const stt = {
  rec: null,
  supported: Boolean(SR),
  finalText: '',
  stopping: false,

  init() {
    if (!this.supported) return;
    const rec = new SR();
    rec.lang = settings.lang;
    rec.continuous = false;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onstart = () => {
      app.listening = true;
      this.finalText = '';
      setState('listening');
      setLive('', 'Listening…');
    };

    rec.onresult = (event) => {
      let interim = '';
      let final = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        if (res.isFinal) final += res[0].transcript;
        else interim += res[0].transcript;
      }
      if (final) this.finalText += final;
      setLive(this.finalText, interim);
    };

    rec.onerror = (event) => {
      const code = event.error;
      if (code === 'no-speech') {
        setLive('', 'Didn’t catch that — try again.');
      } else if (code === 'not-allowed' || code === 'service-not-allowed') {
        toast('Microphone blocked. Allow mic access in your browser’s site settings.', 'err', 6000);
        setState('error');
        setTimeout(() => setState('idle'), 2200);
      } else if (code === 'audio-capture') {
        toast('No microphone found.', 'err');
      } else if (code !== 'aborted') {
        toast(`Speech recognition error: ${code}`, 'warn');
      }
    };

    rec.onend = () => {
      app.listening = false;
      meter.stop();
      const text = this.finalText.trim();
      this.finalText = '';
      if (app.state === 'listening') setState('idle');
      if (text) handleUtterance(text);
      else if (!this.stopping) setLive('', '');
      this.stopping = false;
    };

    this.rec = rec;
  },

  async start() {
    if (!this.supported || app.listening) return;
    tts.cancel();                    // barge-in: stop NOVA mid-sentence
    this.rec.lang = settings.lang;
    await meter.start();             // ok if this fails — synthetic fallback
    try {
      this.rec.start();
    } catch {
      /* start() throws if already running; ignore */
    }
  },

  stop() {
    if (!this.supported || !app.listening) return;
    this.stopping = true;
    try { this.rec.stop(); } catch { /* noop */ }
  }
};

function setLive(finalText, interim) {
  if (!finalText && !interim) {
    dom.liveText.innerHTML = '<span class="live__hint">Tap the mic and start speaking</span>';
    return;
  }
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  dom.liveText.innerHTML =
    (finalText ? `<span class="final">${esc(finalText)}</span> ` : '') +
    (interim ? `<span class="interim">${esc(interim)}</span>` : '');
}

/* ==========================================================================
   8 · TEXT-TO-SPEECH
   ========================================================================== */

const tts = {
  synth: window.speechSynthesis || null,
  voices: [],
  queueId: 0,

  get supported() { return Boolean(this.synth); },

  loadVoices() {
    if (!this.supported) return;
    this.voices = this.synth.getVoices() || [];
    if (!this.voices.length) return;

    const current = settings.voiceURI;
    dom.voiceSel.innerHTML = '<option value="">System default</option>';
    for (const v of this.voices) {
      const opt = document.createElement('option');
      opt.value = v.voiceURI;
      opt.textContent = `${v.name} · ${v.lang}${v.localService ? '' : ' · cloud'}`;
      dom.voiceSel.appendChild(opt);
    }
    dom.voiceSel.value = this.voices.some((v) => v.voiceURI === current) ? current : '';
  },

  /** Best-effort voice pick: explicit choice → nicest match for the language. */
  pickVoice() {
    if (!this.voices.length) return null;
    if (settings.voiceURI) {
      const chosen = this.voices.find((v) => v.voiceURI === settings.voiceURI);
      if (chosen) return chosen;
    }
    const lang = settings.lang.toLowerCase();
    const base = lang.split('-')[0];
    const pool = this.voices.filter((v) => v.lang?.toLowerCase().startsWith(base));
    const preferred = ['natural', 'neural', 'google', 'samantha', 'aria', 'jenny', 'zira'];
    const exact = pool.filter((v) => v.lang?.toLowerCase() === lang);
    const search = (list) => list.find((v) => preferred.some((p) => v.name.toLowerCase().includes(p)));
    return search(exact) || exact[0] || search(pool) || pool[0] || this.voices[0];
  },

  /** Split into speech-sized chunks so audio starts almost immediately. */
  chunk(text) {
    const parts = text.replace(/\s+/g, ' ').trim().split(/(?<=[.!?…])\s+/);
    const out = [];
    let buf = '';
    for (const p of parts) {
      if ((buf + ' ' + p).trim().length > 180) {
        if (buf) out.push(buf.trim());
        buf = p;
      } else {
        buf = (buf + ' ' + p).trim();
      }
    }
    if (buf) out.push(buf);
    return out.length ? out : [text];
  },

  speak(text, { onDone } = {}) {
    if (!this.supported || settings.muted || !text.trim()) {
      onDone?.();
      return;
    }
    this.cancel();
    const id = ++this.queueId;
    const chunks = this.chunk(text);
    const voice = this.pickVoice();
    setState('speaking');

    chunks.forEach((part, i) => {
      const u = new SpeechSynthesisUtterance(part);
      if (voice) { u.voice = voice; u.lang = voice.lang; }
      else u.lang = settings.lang;
      u.rate = settings.rate;
      u.pitch = settings.pitch;
      u.volume = 1;

      if (i === chunks.length - 1) {
        u.onend = () => {
          if (id !== this.queueId) return;   // superseded
          if (app.state === 'speaking') setState('idle');
          onDone?.();
        };
        u.onerror = u.onend;
      }
      this.synth.speak(u);
    });
  },

  cancel() {
    if (!this.supported) return;
    this.queueId++;
    try { this.synth.cancel(); } catch { /* noop */ }
    if (app.state === 'speaking') setState('idle');
  }
};

/* ==========================================================================
   9 · REASONING LAYER
   ========================================================================== */

const ENGINE_META = {
  local:     { label: 'Offline core', hint: 'Built-in rule engine. Works with no network and no keys.' },
  proxy:     { label: 'Proxy · Claude', hint: 'Calls your own backend, which holds the API key and talks to Claude. The safest option for anything shared or deployed.' },
  anthropic: { label: 'Claude direct', hint: 'Calls the Anthropic Messages API straight from this page. Requires the browser-access header and exposes your key — local development only.' }
};

/** Route a turn to the active engine. Returns the reply text. */
async function askAI(userText) {
  const turn = { role: 'user', content: userText };
  const messages = [...history, turn].slice(-MAX_HISTORY_TURNS * 2);

  switch (settings.engine) {
    case 'anthropic': return askClaudeDirect(messages);
    case 'proxy':     return askProxy(messages);
    default:          return localBrain(userText);
  }
}

/**
 * Direct browser → Anthropic Messages API call.
 *
 * `anthropic-dangerous-direct-browser-access: true` is what makes the CORS
 * preflight succeed from a browser origin. The name is a warning: the key is
 * visible to anyone with devtools. Ship the proxy engine instead.
 */
async function askClaudeDirect(messages) {
  if (!settings.apiKey) {
    throw new Error('No API key set. Open settings and paste an Anthropic key, or switch engines.');
  }

  const res = await fetch(`${settings.baseUrl.replace(/\/+$/, '')}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': settings.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: settings.model,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      // Voice turns want speed: shallow reasoning, short answers.
      output_config: { effort: 'low' },
      messages
    })
  });

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      detail = body?.error?.message || detail;
    } catch { /* non-JSON error body */ }
    if (res.status === 401) detail = 'Invalid API key.';
    if (res.status === 429) detail = 'Rate limited — wait a moment and try again.';
    throw new Error(detail);
  }

  return extractText(await res.json());
}

/**
 * Proxy engine. Your server receives { messages, system, model } and either
 * returns { text } or forwards the raw Messages API response.
 */
async function askProxy(messages) {
  if (!settings.proxyUrl) {
    throw new Error('No proxy endpoint set. Open settings to add one, or switch engines.');
  }

  const res = await fetch(settings.proxyUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages, system: SYSTEM_PROMPT, model: settings.model })
  });

  if (!res.ok) {
    let detail = `Proxy returned HTTP ${res.status}`;
    try {
      const body = await res.json();
      detail = body?.error?.message || body?.error || detail;
    } catch { /* ignore */ }
    throw new Error(detail);
  }

  const data = await res.json();
  if (typeof data === 'string') return data;
  if (typeof data.text === 'string') return data.text;
  if (typeof data.reply === 'string') return data.reply;
  return extractText(data);
}

/** Pull spoken text out of a Messages API response object. */
function extractText(data) {
  if (data?.stop_reason === 'refusal') {
    return 'I’m not able to help with that one. Ask me something else and I’ll pick it up from there.';
  }
  const text = (data?.content || [])
    .filter((b) => b?.type === 'text' && b.text)
    .map((b) => b.text)
    .join('\n')
    .trim();
  if (!text) throw new Error('The model returned an empty response.');
  return text;
}

/* ---------------------------------------------------------------------------
   Offline core — a compact rule engine so the app is useful with zero config.
   Handles greetings, identity, time/date, arithmetic, unit-ish conversions,
   dice/coins, jokes, and a graceful catch-all.
   ------------------------------------------------------------------------- */

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/** Recursive-descent arithmetic evaluator (no eval, no injection surface). */
function evalMath(input) {
  const src = input
    .toLowerCase()
    .replace(/\bplus\b/g, '+').replace(/\bminus\b/g, '-')
    .replace(/\b(?:times|multiplied by|x)\b/g, '*')
    .replace(/\b(?:divided by|over)\b/g, '/')
    .replace(/\bto the power of\b/g, '^')
    .replace(/\bpercent of\b/g, '% of')
    .replace(/[,\s]/g, '');

  let i = 0;
  const peek = () => src[i];
  const eat = (ch) => { if (src[i] === ch) { i++; return true; } return false; };

  function parseExpr() {
    let v = parseTerm();
    for (;;) {
      if (eat('+')) v += parseTerm();
      else if (eat('-')) v -= parseTerm();
      else return v;
    }
  }
  function parseTerm() {
    let v = parseUnary();
    for (;;) {
      if (eat('*')) v *= parseUnary();
      else if (eat('/')) v /= parseUnary();
      else if (eat('%')) v %= parseUnary();
      else return v;
    }
  }
  function parseUnary() {
    if (eat('-')) return -parseUnary();
    if (eat('+')) return parseUnary();
    return parsePower();
  }
  function parsePower() {
    const base = parseAtom();
    if (eat('^')) return Math.pow(base, parseUnary());
    return base;
  }
  function parseAtom() {
    if (eat('(')) {
      const v = parseExpr();
      if (!eat(')')) throw new Error('bad parens');
      return v;
    }
    const fn = /^(sqrt|sin|cos|tan|log|ln|abs|round|floor|ceil)/.exec(src.slice(i));
    if (fn) {
      i += fn[0].length;
      const arg = parseAtom();
      switch (fn[0]) {
        case 'sqrt': return Math.sqrt(arg);
        case 'sin': return Math.sin(arg);
        case 'cos': return Math.cos(arg);
        case 'tan': return Math.tan(arg);
        case 'log': return Math.log10(arg);
        case 'ln': return Math.log(arg);
        case 'abs': return Math.abs(arg);
        case 'round': return Math.round(arg);
        case 'floor': return Math.floor(arg);
        case 'ceil': return Math.ceil(arg);
      }
    }
    if (src.startsWith('pi', i)) { i += 2; return Math.PI; }
    if (peek() === 'e' && !/\d/.test(src[i + 1] || '')) { i++; return Math.E; }
    const num = /^\d*\.?\d+/.exec(src.slice(i));
    if (!num) throw new Error('unexpected token');
    i += num[0].length;
    return parseFloat(num[0]);
  }

  const value = parseExpr();
  if (i !== src.length) throw new Error('trailing input');
  if (!Number.isFinite(value)) throw new Error('not finite');
  return value;
}

const fmtNum = (n) =>
  Number.isInteger(n) ? n.toLocaleString()
    : parseFloat(n.toFixed(6)).toLocaleString(undefined, { maximumFractionDigits: 6 });

function localBrain(raw) {
  const q = raw.trim();
  const t = q.toLowerCase().replace(/[?!.]+$/, '').trim();
  const has = (...words) => words.some((w) => t.includes(w));
  const now = new Date();

  // greetings
  if (/^(hi|hey|hello|yo|hiya|good (morning|afternoon|evening)|namaste)\b/.test(t)) {
    const hour = now.getHours();
    const part = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
    return pick([
      `Good ${part}. I'm ${ASSISTANT_NAME} — what can I do for you?`,
      `Hey there. ${ASSISTANT_NAME} here, listening.`,
      `Hello. Ask me anything and I'll take a swing at it.`
    ]);
  }

  // identity / capability
  if (has('who are you', 'your name', 'what are you', 'introduce yourself')) {
    return `I'm ${ASSISTANT_NAME}, a voice interface running entirely in your browser. Right now I'm on my offline core, which handles time, dates, maths and small talk. Connect an AI engine in settings and I can answer anything.`;
  }
  if (has('what can you do', 'help me', 'your features', 'capabilities', 'commands')) {
    return `On the offline core I can tell you the time and date, run calculations, flip coins, roll dice, and chat a little. Open settings and point me at Claude, and I'll handle open-ended questions too.`;
  }

  // time & date
  if (has('what time', 'the time', 'current time', 'clock')) {
    return `It's ${now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`;
  }
  if (has('what day', 'what date', "today's date", 'the date', 'what is today')) {
    return `Today is ${now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}.`;
  }
  if (has('what year')) return `We're in ${now.getFullYear()}.`;

  // dice, coins, randomness
  if (has('flip a coin', 'toss a coin', 'heads or tails')) {
    return `${Math.random() < 0.5 ? 'Heads' : 'Tails'}.`;
  }
  const dice = /roll (?:a |an )?(?:(\d+)\s*(?:sided|d))?\s*(?:dice|die|d(\d+))?/.exec(t);
  if (dice && has('roll')) {
    const sides = parseInt(dice[1] || dice[2] || '6', 10);
    const safe = clamp(sides || 6, 2, 1000);
    return `You rolled a ${1 + Math.floor(Math.random() * safe)} on a ${safe}-sided die.`;
  }
  const between = /(?:random|number|pick).*?between\s+(-?\d+)\s*(?:and|to)\s*(-?\d+)/.exec(t);
  if (between) {
    const lo = Math.min(+between[1], +between[2]);
    const hi = Math.max(+between[1], +between[2]);
    return `${lo + Math.floor(Math.random() * (hi - lo + 1))}.`;
  }

  // percent of
  const pct = /([\d.]+)\s*(?:percent|%)\s*of\s*([\d.,]+)/.exec(t);
  if (pct) {
    const v = (parseFloat(pct[1]) / 100) * parseFloat(pct[2].replace(/,/g, ''));
    return `${pct[1]} percent of ${pct[2]} is ${fmtNum(v)}.`;
  }

  // arithmetic
  const mathish = t.replace(/^(what(?:'s| is)|calculate|compute|solve|how much is|equals?)\s*/i, '');
  if (/[\d)]\s*[-+*/^%x]|\b(?:plus|minus|times|divided by|multiplied by|sqrt|square root)\b/.test(mathish)) {
    try {
      const value = evalMath(mathish.replace(/square root of/g, 'sqrt'));
      return `That's ${fmtNum(value)}.`;
    } catch { /* fall through to the catch-all */ }
  }

  // pleasantries
  if (has('thank', 'thanks', 'appreciate it')) {
    return pick(['Anytime.', 'Happy to help.', 'You got it.']);
  }
  if (has('how are you', 'how do you feel', "how's it going")) {
    return `Running clean and listening closely. More importantly — what do you need?`;
  }
  if (has('joke', 'make me laugh', 'something funny')) {
    return pick([
      `I told my microphone a secret. Now it just repeats it to everyone — classic transcription problem.`,
      `Why did the neural net cross the road? Because the gradient pointed that way.`,
      `I'd tell you a UDP joke, but you might not get it.`,
      `My favourite kind of silence is the two hundred milliseconds right before someone says "actually".`
    ]);
  }
  if (has('goodbye', 'bye', 'see you', 'good night')) {
    return pick(['Talk soon.', 'Goodbye — tap the mic whenever you need me.', 'See you.']);
  }

  // catch-all: acknowledge, then point at the upgrade path
  const topic = q.length > 70 ? q.slice(0, 67).trim() + '…' : q;
  return pick([
    `I heard you clearly: "${topic}". That one needs a real language model — open settings and connect Claude, and I'll answer it properly.`,
    `"${topic}" is past what my offline core covers. Add an AI engine in settings and ask me again.`,
    `I've got that as "${topic}". My built-in rules handle time, maths and small talk; connect Claude in settings for open questions like this.`
  ]);
}

/* ==========================================================================
   10 · TURNS & TRANSCRIPT
   ========================================================================== */

let turnCount = 0;

function addMessage(role, text, { typing = false } = {}) {
  dom.emptyState?.remove();

  const el = document.createElement('article');
  const cls = role === 'user' ? 'msg--user' : role === 'error' ? 'msg--err' : 'msg--ai';
  el.className = `msg ${cls}${typing ? ' msg--typing' : ''}`;

  const who = role === 'user' ? 'You' : role === 'error' ? 'System' : ASSISTANT_NAME;

  const top = document.createElement('div');
  top.className = 'msg__top';
  top.innerHTML =
    `<span class="msg__who">${who}</span><span class="msg__time">${clockTime()}</span>`;

  const body = document.createElement('p');
  body.className = 'msg__text';
  if (typing) {
    body.innerHTML = '<i></i><i></i><i></i>';
  } else {
    body.textContent = text;
  }

  // Replay button on spoken replies
  if (role === 'assistant' && !typing && tts.supported) {
    const replay = document.createElement('button');
    replay.type = 'button';
    replay.className = 'msg__replay';
    replay.title = 'Speak again';
    replay.setAttribute('aria-label', 'Speak this reply again');
    replay.innerHTML =
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M8 5.5v13l10-6.5z"/></svg>`;
    replay.addEventListener('click', () => tts.speak(text));
    top.appendChild(replay);
  }

  el.append(top, body);
  dom.feed.appendChild(el);
  dom.feed.scrollTo({ top: dom.feed.scrollHeight, behavior: 'smooth' });
  return el;
}

function bumpTurnCount() {
  turnCount++;
  dom.turnCount.textContent = `${turnCount} exchange${turnCount === 1 ? '' : 's'}`;
}

async function handleUtterance(text) {
  if (!text.trim() || app.busy) return;

  app.busy = true;
  addMessage('user', text);
  bumpTurnCount();
  setLive('', '');
  setState('thinking');

  const placeholder = addMessage('assistant', '', { typing: true });

  try {
    const reply = await askAI(text);

    history.push({ role: 'user', content: text });
    history.push({ role: 'assistant', content: reply });
    if (history.length > MAX_HISTORY_TURNS * 2) {
      history.splice(0, history.length - MAX_HISTORY_TURNS * 2);
    }

    placeholder.remove();
    addMessage('assistant', reply);

    // Speak immediately, then optionally re-open the mic.
    tts.speak(reply, {
      onDone: () => {
        if (settings.handsFree && stt.supported) {
          setTimeout(() => { if (app.state === 'idle' && !app.busy) stt.start(); }, 420);
        }
      }
    });
    if (settings.muted) setState('idle');
  } catch (err) {
    placeholder.remove();
    const message = err?.message || 'Something went wrong reaching the model.';
    addMessage('error', message);
    toast(message, 'err', 5200);
    setState('error');
    setTimeout(() => { if (app.state === 'error') setState('idle'); }, 2400);
  } finally {
    app.busy = false;
  }
}

/* ==========================================================================
   11 · SETTINGS SHEET
   ========================================================================== */

function syncEngineUI() {
  const engine = settings.engine;
  for (const btn of dom.segEngine.querySelectorAll('button')) {
    btn.setAttribute('aria-checked', String(btn.dataset.engine === engine));
  }
  dom.engineHint.textContent = ENGINE_META[engine].hint;
  dom.engineLabel.textContent = ENGINE_META[engine].label;

  for (const field of document.querySelectorAll('[data-engine-only]')) {
    const allowed = field.dataset.engineOnly.split(/\s+/);
    field.hidden = !allowed.includes(engine);
  }
}

function openSheet() {
  dom.sheet.hidden = false;
  tts.loadVoices();
  dom.sheet.querySelector('.segmented button[aria-checked="true"]')?.focus();
}
function closeSheet() { dom.sheet.hidden = true; }

function hydrateSettingsForm() {
  dom.proxyUrl.value = settings.proxyUrl;
  dom.apiKey.value = settings.apiKey;
  dom.modelId.value = settings.model;
  dom.langSel.value = settings.lang;
  dom.rate.value = settings.rate;
  dom.rateVal.textContent = Number(settings.rate).toFixed(2);
  dom.pitch.value = settings.pitch;
  dom.pitchVal.textContent = Number(settings.pitch).toFixed(2);
  dom.btnMute.setAttribute('aria-pressed', String(settings.muted));
  dom.btnMute.querySelector('span').textContent = settings.muted ? 'Voice off' : 'Voice on';
  dom.btnAuto.setAttribute('aria-pressed', String(settings.handsFree));
  syncEngineUI();
}

/* ==========================================================================
   12 · WIRING & BOOT
   ========================================================================== */

/* --- mic --- */
dom.btnMic.addEventListener('click', () => {
  if (!stt.supported) {
    toast('This browser has no Speech Recognition API. Use Chrome or Edge, or type your message.', 'warn', 6000);
    dom.textInput.focus();
    return;
  }
  if (app.listening) stt.stop();
  else if (app.state === 'speaking') tts.cancel();   // barge-in
  else if (!app.busy) stt.start();
});

/* --- voice / hands-free toggles --- */
dom.btnMute.addEventListener('click', () => {
  settings.muted = !settings.muted;
  if (settings.muted) tts.cancel();
  saveSettings();
  dom.btnMute.setAttribute('aria-pressed', String(settings.muted));
  dom.btnMute.querySelector('span').textContent = settings.muted ? 'Voice off' : 'Voice on';
  toast(settings.muted ? `${ASSISTANT_NAME}'s voice is muted` : `${ASSISTANT_NAME} will speak replies`);
});

dom.btnAuto.addEventListener('click', () => {
  settings.handsFree = !settings.handsFree;
  saveSettings();
  dom.btnAuto.setAttribute('aria-pressed', String(settings.handsFree));
  toast(settings.handsFree ? 'Hands-free on — I’ll keep listening after each reply' : 'Hands-free off');
});

/* --- text composer --- */
dom.composer.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = dom.textInput.value.trim();
  if (!text) return;
  dom.textInput.value = '';
  handleUtterance(text);
});

/* --- suggestion chips --- */
dom.feed.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (chip) handleUtterance(chip.dataset.suggest);
});

/* --- clear --- */
dom.btnClear.addEventListener('click', () => {
  tts.cancel();
  history.length = 0;
  turnCount = 0;
  dom.turnCount.textContent = '0 exchanges';
  dom.feed.innerHTML = '';
  dom.feed.appendChild(dom.emptyState);
  setLive('', '');
  toast('Conversation cleared');
});

/* --- settings sheet --- */
dom.btnSettings.addEventListener('click', openSheet);
dom.sheet.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeSheet(); });

dom.segEngine.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-engine]');
  if (!btn) return;
  settings.engine = btn.dataset.engine;
  saveSettings();
  syncEngineUI();
});

dom.proxyUrl.addEventListener('change', () => { settings.proxyUrl = dom.proxyUrl.value.trim(); saveSettings(); });
dom.apiKey.addEventListener('change', () => { settings.apiKey = dom.apiKey.value.trim(); saveSettings(); });
dom.modelId.addEventListener('change', () => { settings.model = dom.modelId.value; saveSettings(); });
dom.langSel.addEventListener('change', () => {
  settings.lang = dom.langSel.value;
  saveSettings();
  if (stt.rec) stt.rec.lang = settings.lang;
  tts.loadVoices();
});
dom.voiceSel.addEventListener('change', () => { settings.voiceURI = dom.voiceSel.value; saveSettings(); });
dom.rate.addEventListener('input', () => {
  settings.rate = parseFloat(dom.rate.value);
  dom.rateVal.textContent = settings.rate.toFixed(2);
  saveSettings();
});
dom.pitch.addEventListener('input', () => {
  settings.pitch = parseFloat(dom.pitch.value);
  dom.pitchVal.textContent = settings.pitch.toFixed(2);
  saveSettings();
});
dom.btnTestVoice.addEventListener('click', () => {
  const wasMuted = settings.muted;
  settings.muted = false;
  tts.speak(`This is ${ASSISTANT_NAME}. Voice, rate and pitch are set the way you like them.`, {
    onDone: () => { settings.muted = wasMuted; }
  });
});

/* --- keyboard --- */
document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');

  if (e.code === 'Space' && !typing && !e.repeat && dom.sheet.hidden) {
    e.preventDefault();
    dom.btnMic.click();
  }
  if (e.key === 'Escape') {
    if (!dom.sheet.hidden) { closeSheet(); return; }
    tts.cancel();
    stt.stop();
  }
  if (e.key === '/' && !typing) { e.preventDefault(); dom.textInput.focus(); }
});

/* --- speech synthesis voices arrive asynchronously --- */
if (tts.supported) {
  tts.loadVoices();
  tts.synth.addEventListener?.('voiceschanged', () => tts.loadVoices());
  window.speechSynthesis.onvoiceschanged = () => tts.loadVoices();
}

/* --- tidy up --- */
window.addEventListener('beforeunload', () => { tts.cancel(); meter.stop(); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden && app.listening) stt.stop();
});

/* --- boot --- */
stt.init();
hydrateSettingsForm();
setState('idle');
setLive('', '');

if (!stt.supported) {
  dom.micLabel.textContent = 'Voice input unavailable';
  toast('Speech recognition needs Chrome, Edge, or Safari. You can still type.', 'warn', 6500);
}
if (!tts.supported) {
  toast('This browser can’t synthesise speech — replies will be text only.', 'warn', 6000);
}
