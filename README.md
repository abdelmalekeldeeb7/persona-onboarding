# Persona Onboarding

**Live demo:** https://web-production-12e0c1.up.railway.app (Chrome on desktop or Android works best for voice)

Onboarding for a new Persona user. You touch the ring on the Band and a glass panel projects from it. From there, a conversation collects four things: **a name for the agent, the user's name, a Gmail connection, and something they want help with**. It moves between **voice call and text** without losing anything, and treats setup as optional. Once the agent knows what the user needs, it starts helping, and anything still missing is picked up gently later.

## What it does

- **The call gathers everything except the agent's name.** Naming happens on the first screen. The agent then offers a voice call (a web-simulated call using the browser's speech recognition) to collect the user's name, their need and Gmail. Every reply is written by Claude Haiku 4.5.
- **Voice and text are one conversation.** You can switch mid-call, hang up, call back or reload the page. Facts are stored in server-side session state (Postgres), not only in the transcript, so nothing is lost.
- **It's built for users who don't follow the script:**
  - Hangups, including repeated drops, closing the tab mid-call and mic denial, each get a context-aware recovery line.
  - Silence gets gentle reprompts, then a graceful hangup.
  - Interruptions (barge-in), filler-only speech ("um"), stutters, self-corrections ("Sam, no, Samir") and sentences split across pauses are handled.
  - So are prompt injection, gibberish, refusals ("no calls", "not telling you my name"), mid-conversation renames, and "forget everything".
- **Onboarding is optional.** "Skip setup, just start" goes straight to help. "Just let me in" works at any point. The agent graduates the user to the main experience as soon as it knows the need.
- **Gmail is real, read-only OAuth** (the access token stays in the browser). A snapshot of 8 recent messages, triaged by the server, gives an immediate "it already gets me" moment. If Google blocks the account (the app is in Testing), the agent explains why and offers a clearly labelled sample inbox.
- **Other connectors:** the agent suggests Notion, Google Calendar, Slack or Drive when one fits the user's need, and the user can add it to their setup. Only Gmail is live; the agent never claims to read the others.
- **Honesty guardrails:**
  - The agent can't claim to have sent, deleted or connected anything.
  - It won't invent emails when the snapshot is empty.
  - It can't say "give me a second" and then stall.
  - A typed "yes" to "forget everything?" really erases the session.

## Architecture

- `server/engine.mjs`: the onboarding state machine (phases, goals, cards, hangup and Gmail events, server-answered intents such as recap, reset and injection). It holds the facts; the model only proposes them.
- `server/llm.mjs`: Claude Haiku 4.5 through one forced `respond` tool call, which returns both the reply and the extracted facts so state and wording can't disagree. Also holds the TTS providers.
- `server/index.mjs`: Express API. Sessions are owned via an HttpOnly cookie (someone else's session ID returns 404). It also handles per-session serialization of rapid messages, rate limits, idempotent turn nonces and cross-site write blocking.
- `src/lib/call.ts`: the browser voice call. It covers:
  - Endpointing that waits longer on trailing words ("because…").
  - Deduplication of growing partial transcripts.
  - Barge-in and echo filtering.
  - A recognizer watchdog that recovers after the Google popup or a tab switch.
  - Sentence-chunked, prefetched speech.
- `src/App.jsx`: the ring and projection interface.

## Testing

- `npm run test:engine`: 28 engine tests (hangups, Gmail failures, resets, hostile payloads, speech cleanup, skip flow).
- A live stress run against the deployed app (22 difficult personas at once, a 30-message burst, and security probes) finished with 0 server errors and no quality flags. Median reply time was ~1.2s, p90 ~2.3s.

## Tradeoffs

- **Voice output** uses the browser's speech synthesis. Gemini TTS, which works when `GEMINI_API_KEY` has quota, was blocked by its free-tier limit of 10 requests per day. A self-hosted Kokoro model (`kokoro-js`, Apache-2.0) took about 1s per sentence locally but 12s on Railway's shared CPU, so it's off there (`KOKORO=off`). Whichever voice a call starts with, it stays on it.
- **Voice input** is the Web Speech API: free, with live captions, best in Chrome. The server cleans up the transcript (fillers, stutters) before it reaches the model.
- **Gmail**'s restricted read-only scope means Google's Testing mode (whitelisted testers) until the app is verified. Other accounts get the sample inbox.
- **Connectors other than Gmail** are recorded as the user's intent but not integrated, which keeps the scope honest.

## Run locally

```
npm install
cp .env.example .env   # add ANTHROPIC_API_KEY; GOOGLE_CLIENT_ID and GEMINI_API_KEY are optional
npm run build && npm start   # http://localhost:8790
```

Without `ANTHROPIC_API_KEY`, a rule-based fallback runs the conversation. Without `DATABASE_URL`, sessions are stored in `.data/`.

Product imagery is from yourpersona.com/band. The hero film was supplied for this concept.
