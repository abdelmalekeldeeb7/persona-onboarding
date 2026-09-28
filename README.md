# Persona Projection

A separate interactive concept: touch the ring on the supplied Band film to project a glass conversation surface. Activation now uses the calibrated film still with a 480ms downward pan/zoom and a 300ms panel entrance, rather than replaying the recorded touch gesture. The panel unfolds from the ring; minimizing preserves the conversation. Voice and text occupy the same panel, and Gmail opens as a permission sheet.

## Run

`npm install`, `npm run build`, then `npm start`.

Open http://localhost:8790. For development, `npm run dev` serves the interface at http://localhost:5180 and proxies the API at 8790.

## Configuration

Copy `.env.example` to `.env` and add your own credentials there. Never commit `.env`.

- ANTHROPIC_API_KEY enables Claude Haiku 4.5 for both typed and spoken conversation logic. Without it, the server uses its rule-based fallback.
- GEMINI_API_KEY enables generated call audio. Haiku still writes every reply; Gemini TTS reads that exact reply aloud. Browser speech remains the automatic fallback.
- GOOGLE_CLIENT_ID enables browser Google sign-in. Use a Web application OAuth client, authorize the exact local/deployed origins, enable Gmail API, and add OAuth test users while the consent screen is in testing. This flow does not use a client secret.
- DATABASE_URL optionally enables PostgreSQL. Without it, sessions use the local ignored .data directory.

Gmail access is read-only. The access token stays in the browser. Only eight recent inbox items—sender, subject, date, unread status and snippet—are sent to this app and included in Haiku's existing session context. The sample inbox is explicitly labelled and requires a deliberate sample action.

The voice call is a controlled cascade: browser speech recognition produces live captions, Haiku decides the reply and updates onboarding state, then Gemini TTS renders that exact text. Generated audio is requested through a session-owned, rate-limited server route; API keys never reach the browser. Barge-in, mute, hangup, silence recovery and text fallback remain available.
## Architecture and provenance

This is a new project, not a continuation of the discarded visual design. The interface and stylesheet were built for this concept. The tested server, browser speech and Gmail utilities were copied from persona-onboarding2 to retain conversation continuity and error handling. Session cookies, browser storage and the default port are isolated from that project. No credentials or prior sessions were copied.

hero-1080.mp4 was supplied by the user; band-poster.jpg is a still extracted from that film. Branding is used for this Persona trial concept. Existing logo sources are documented in brand-sources.json and SVGL-LICENSE.txt. No hardware connection is claimed: interaction occurs in the browser.

## Checked

Production build and TypeScript check pass; all 23 inherited engine tests pass. Chrome walkthroughs at 1440×960 and 390×844 cover ring activation, naming, incoming-call UI, declining into text, name/need collection, sample Gmail and inbox brief. Further checks cover microphone denial, minimizing/reopening, reload continuity and confirmed reset. No page errors or horizontal overflow observed. With mocked browser speech and a fake microphone, the active call, mute, text during a call, return to voice and hangup also passed; this is not a real speech-quality test.

Real microphone conversation, real model quality, real Google OAuth and deployment remain unverified. No external accounts have been configured.

Reduced-motion preferences suppress projection and pulse animations; unsupported glass blur falls back to an opaque panel. The ring and all primary actions are keyboard buttons. On phones, the projection expands into a readable sheet.

## Ring alignment correction

At the reported 1395�884 viewport and at 390�844, the hit target remains within one CSS pixel of the calibrated filmed ring before and after activation. The panel is fully visible by 550ms in local automated Chrome checks; repeated minimize/reopen produced no page errors. Video seeking, animated width/left/bottom and entrance blur were removed. This is a 2D camera-style pan of the supplied frame, not a newly rendered viewing angle.
