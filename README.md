# Persona Projection

A separate interactive concept: touch the ring on the supplied Band film to project a glass conversation surface. The panel unfolds from the ring; minimizing preserves the conversation. Voice and text occupy the same panel, and Gmail opens as a permission sheet.

## Run

`npm install`, `npm run build`, then `npm start`.

Open http://localhost:8790. For development, `npm run dev` serves the interface at http://localhost:5180 and proxies the API at 8790.

## Configuration

Copy `.env.example` to `.env` and add your own credentials there. Never commit `.env`.

- ANTHROPIC_API_KEY enables model replies. Without it, the server uses its labelled rule-based fallback.
- ANTHROPIC_MODEL_TEXT and ANTHROPIC_MODEL_VOICE optionally select models available to your account.
- GOOGLE_CLIENT_ID enables browser Google sign-in. Authorize the exact local/deployed origin in Google Cloud, enable Gmail API, and add OAuth test users where required.
- DATABASE_URL optionally enables PostgreSQL. Without it, sessions use the local ignored .data directory.

Gmail access is read-only. The token stays in the browser, while a small recent inbox snapshot is sent to the app and, when enabled, its model. The sample inbox is explicitly labelled and requires a deliberate sample action.

## Architecture and provenance

This is a new project, not a continuation of the discarded visual design. The interface and stylesheet were built for this concept. The tested server, browser speech and Gmail utilities were copied from persona-onboarding2 to retain conversation continuity and error handling. Session cookies, browser storage and the default port are isolated from that project. No credentials or prior sessions were copied.

hero-1080.mp4 was supplied by the user; band-poster.jpg is a still extracted from that film. Branding is used for this Persona trial concept. Existing logo sources are documented in brand-sources.json and SVGL-LICENSE.txt. No hardware connection is claimed: interaction occurs in the browser.

## Checked

Production build and TypeScript check pass; all 23 inherited engine tests pass. Chrome walkthroughs at 1440×960 and 390×844 cover ring activation, naming, incoming-call UI, declining into text, name/need collection, sample Gmail and inbox brief. Further checks cover microphone denial, minimizing/reopening, reload continuity and confirmed reset. No page errors or horizontal overflow observed. With mocked browser speech and a fake microphone, the active call, mute, text during a call, return to voice and hangup also passed; this is not a real speech-quality test.

Real microphone conversation, real model quality, real Google OAuth and deployment remain unverified. No external accounts have been configured.

Reduced-motion preferences suppress projection and pulse animations; unsupported glass blur falls back to an opaque panel. The ring and all primary actions are keyboard buttons. On phones, the projection expands into a readable sheet.
