# NOVA — AI Voice Assistant

**A neon-futuristic, browser-only voice assistant** — live speech-to-text, a reactive audio-reactive orb, spoken replies, and a pluggable reasoning layer that can run fully offline or call Claude.

NOVA runs entirely as static HTML/CSS/JS. No build step, no framework, no backend required to try it — though for real AI answers (instead of the offline core) you'll want to wire up a proxy or an API key, both covered below.

---

## Features

- **Voice in, voice out** — live speech-to-text while you talk, and spoken replies via the browser's text-to-speech, using the native Web Speech API.
- **Reactive canvas orb** — a hand-coded animated orb that visually responds to mic input level and app state (idle / listening / thinking / speaking).
- **Hands-free mode** — keep listening automatically after each reply, instead of tapping the mic every turn.
- **Live transcript panel** — every exchange lands as a timestamped card; includes quick-start suggestion chips, a text composer (for typing instead of speaking), and a clear-conversation button.
- **Three swappable reasoning engines** (see below): an offline rule-based core that needs no network or keys, a proxy mode for calling your own backend, and a direct-to-Claude browser mode for local development.
- **Configurable voice** — recognition language (8 languages included), speaking voice, speech rate, and pitch, with a one-click preview.
- **Keyboard shortcuts** — `Space` to toggle the mic, `Esc` to stop.
- **Settings persist locally** via `localStorage` — nothing is sent anywhere unless you're in proxy or Claude-direct mode.

## Reasoning engines

NOVA ships with three interchangeable "brains," switchable from the settings sheet:

| Engine | What it does | Use it for |
|---|---|---|
| **Offline core** (`local`) | A hand-written rule engine: tells the time/date, does arithmetic and percentages (own expression parser, no `eval`), flips coins, rolls dice, handles greetings/small talk, and otherwise tells you honestly that it can't answer and points you at the other engines. | Works instantly, no setup, no network. |
| **Proxy** (`proxy`) | Sends the conversation to a backend URL you provide, which holds the real Anthropic API key server-side and forwards the request to Claude. | **Recommended** for anything shared, deployed, or public. |
| **Claude direct** (`anthropic`) | Calls the Anthropic Messages API straight from the browser using your own API key, via the `anthropic-dangerous-direct-browser-access` header. | **Local development only.** The key lives in `localStorage` and is visible to anyone with devtools — never ship this mode publicly. |

The system prompt is tuned specifically for speech: short answers, no markdown/symbols, numbers spelled out the way you'd say them out loud ("20 percent" instead of "20%").

## Getting started

Clone the repo and serve it with any static file server — **don't open `index.html` directly via `file://`**, since the Web Speech API and some fetch behavior need a proper origin.

```bash
git clone https://github.com/<your-username>/<repo-name>.git
cd <repo-name>
python -m http.server 8000
# then open http://localhost:8000
```

Or use VS Code's **Live Server** extension and click "Open with Live Server" on `index.html`.

Out of the box, NOVA runs on the **offline core** — no setup needed. To connect real AI:

1. Click the settings icon (top right).
2. Pick an engine:
   - **Proxy** — enter your backend's URL. It should accept `{ messages, system }` as JSON and return either `{ text }` or a raw Anthropic Messages API response.
   - **Claude direct** — paste your Anthropic API key (local development only — see the warning above).
3. Pick a model, recognition language, and voice, then hit **Preview voice** to check it sounds right.

### GitHub Pages

1. Push `index.html`, `app.js`, and `style.css` to the repo (root of `main` is fine).
2. Go to **Settings → Pages**.
3. Set source to `main` branch, `/ (root)`.
4. Your live demo will be at `https://<your-username>.github.io/<repo-name>/`.

Note: if you deploy with Claude-direct mode available, anyone can open devtools and read an API key you've entered into that browser's `localStorage` — it's a per-visitor risk, not something baked into the deployed site itself, but worth knowing before you point people at it.

## Browser support

NOVA depends on the **Web Speech API** (`SpeechRecognition` / `webkitSpeechRecognition` and `speechSynthesis`), which has uneven browser support — it works best in **Chrome** and **Edge**. Firefox and Safari have partial or no support for speech recognition, so the mic button may not work there even though typed input and voice replies still will.

## Tech stack

Three files, zero dependencies:

| File | Purpose |
|---|---|
| `index.html` | Markup — topbar, orb stage, transcript panel, settings sheet |
| `style.css` | All styling — dark neon theme, aurora background, orb glow, responsive layout |
| `app.js` | Everything else: state machine, canvas orb renderer, mic level meter (Web Audio `AnalyserNode`), speech-to-text, text-to-speech, the three reasoning engines, transcript UI, settings persistence |

Fonts (Space Grotesk, Sora) load from Google Fonts — an internet connection is needed for those and for the proxy/Claude-direct engines, but the app itself needs no build tools or package manager.

## Project structure

```
.
├── index.html
├── style.css
└── app.js
```

## Limitations

- Offline core is intentionally simple — it's a fast, zero-setup fallback for time/date/math/small-talk, not a language model.
- Speech recognition accuracy and availability depend entirely on the browser and OS.
- Claude-direct mode is not safe for any public or shared deployment — use the proxy engine instead.

## License

MIT — use it, modify it, ship it.
