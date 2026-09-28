# Handoff: Persona Band — Projected Onboarding

## Overview
A cinematic onboarding for Persona. The page opens on the Persona Band film. The user touches the Band's ring; a hand presses it, the camera pushes in, a cone of light rises from the ring and a glass panel unfolds from it. Inside the panel the user names their Persona, takes (or declines) a voice call, shares their name and what's on their mind, optionally connects Gmail (sample inbox), and gets one immediate inbox insight. Minimizing folds the panel back into the ring without losing anything. Below the hero: a short product section.

## About the design files
`Persona Onboarding.dc.html` is a **design reference built in HTML** — a working prototype of look, motion and behavior, not production code. Recreate it inside the existing `persona-projection` app using its framework and patterns, and wire it to the existing backend (session continuity, voice, hang-up recovery, typed corrections, mic-denied fallback, sample Gmail). In the prototype all conversation, voice level and Gmail are **simulated**; replace them with real API calls. Do not add capabilities the backend doesn't support.

To open the prototype: serve this folder with a static server (`npx serve .`) and open `Persona Onboarding.dc.html` (it needs `support.js` beside it). **Do not open it by double-clicking (file://)** — the browser blocks loading the film that way.

**Video seeking requirement (important):** the design jumps around inside `hero.mp4` (4.6s rest, 5.0s press, 12.0s green ring). Browsers can only seek if the server supports HTTP range requests (`Accept-Ranges: bytes`, `206 Partial Content`). Many simple servers and some hosts don't, and then every seek snaps back to 0 — the intro, press and green ring break. The prototype works around this by fetching the whole film as a Blob and playing it from an object URL. In production either keep that approach or make sure the video is served with range support (most CDNs, Vercel, Netlify, S3/CloudFront, nginx do this by default; Python's `http.server` does not). The template markup (inline styles) is between `<x-dc>` tags; all logic is the `class Component` in the `<script data-dc-script>` block.

## Fidelity
**High fidelity.** Colors, type, spacing, timings and easing are final. Match them.

---

## Page structure
Root: full-viewport hero (`100vh`, background `#fcfcfc`, overflow hidden), followed by two scrolling product sections.

### Hero chrome
- **Header** height 94px desktop / 72px mobile; horizontal padding 5% desktop / 22px mobile.
  - Left: logo `assets/mark.svg` (25×27, mobile 22×27) + "Persona", 23px (20 mobile), weight 500, letter-spacing −1px, `#252527`, gap 8px.
  - Center (desktop): "A little closer." 12px `#9b9ba0`.
  - Right: sound toggle + "Start over" (opens reset confirm).
- **Title block** (top-left, absolute; left 8% / 12% ≥1600 / 6% <1050 / 28px mobile):
  - Overline "MEET YOUR PERSONA" 9px, weight 500, tracking .19em, `#8c8c95`.
  - H1 "Your world. / A little *lighter.*" size clamp(40px, 4.2vw, 64px) (44 mobile), weight 450, line-height 1.06, tracking −.055em; italic word `#9a9aa2`.
  - Lead "One touch. A conversation that stays with you." 13px (11 mobile) `#93939a`, line-height 1.7.
  - When panel opens: opacity → .3 (0 on mobile/<1050), translateY −22px, blur 3px.
- **Footer** 50px (44 mobile), top border `1px #efeff2`, 10px `#9f9fa8`: "Made to feel *personal.*" · contextual hint · "PERSONA · INTERACTIVE CONCEPT" (8px, tracking .12em, desktop only).
  - Hint copy: closed/new "No forms. Just a first hello." · closed/returning "Pick up here anytime." · open "Tap the ring to tuck this away."

### Band stage (the film)
- Media: `assets/hero.mp4` (1920×1080, 19.6s) over poster `assets/band-poster.jpg`, `mix-blend-mode: multiply`, in one container sized to 16:9.
  - Desktop: width = viewport width, bottom-anchored.
  - Mobile: width = 1.8 × viewport, left offset −0.4 × viewport.
- **Ring calibration** (critical): ring center at **49.05% x, 47.22% y** of the 16:9 media; lit outline diameter ≈ **3.33%** of media width (64px at 1920). The click target, glow, camera pivot (`transform-origin`), beam origin and panel fold point all use these normalized coordinates inside the same transformed container — never viewport guesses. Click target min 44px.
- Film timeline used:
  - 0 → 4.6s: intro, hand enters, ring lights white (plays once on load).
  - 4.6s: **resting frame** (white ring, no finger).
  - 5.0 → 6.15s: finger comes in and presses (6.15s = contact).
  - 6.15 → 8.2s: hand leaves (played fast, ≥3.2×).
  - 12.0s: **active frame** — full green ring. Hold here while open.
- `assets/press/f000–f084.jpg`: 85 frames (1280×720, 24fps) covering 4.6→8.1s, used to play the press **in reverse** on close (browsers can't play video backwards smoothly).

### "Touch the ring" prompt (closed state)
Centered under the ring (top 54% / 56% mobile): gradient stem 1px × 54px (42 mobile), then pill button "Touch the ring ↗" (12px `#53535c`, bg `#ffffffe6`, border `1px #e7e7eb`, radius 99px, padding 12×17), note "Your Persona is right here." 10px `#a1a1a8`. Returning users: "Pick up where we left off" / "Nothing's lost." Hidden during intro, press and close.

---

## Motion system
All motion uses `transform`/`opacity` only. `prefers-reduced-motion`: all transitions off, intro and hand press skipped.

### Intro (first load)
Poster hidden; video fades in (opacity .45s) on `playing`, plays 0→4.6s, pauses. Then ring glow fades in (.8s) and prompt appears. Safety timeout 6.6s → jump to 4.6s. Clicking during intro skips to resting frame. Must not depend on `document.visibilityState`.

### Open (≈850ms after contact)
1. **Click** → ring brightens instantly (<100ms); video plays 5.0s at 1.5× (configurable 1–2.5×). Fallback timer opens anyway at the expected contact time +250ms; any pause/stall/error opens immediately.
2. **Contact (6.15s)** → power-on sound; ring "contact" pulse (scale .84 → 1, .55s `cubic-bezier(.3,0,.2,1)`), halo ring expands (scale .8→2.8, fade, .7s).
3. **Camera** (delay 80ms, 600ms, `cubic-bezier(.45,.05,.2,1)`): stage `translate3d(tx,ty,0) rotate(-1.5deg) scale(1.26)` (mobile 1.12; short desktop ≤680px 1.12) so the ring lands horizontally centered, `WH − 104px` from the top of the main area (mobile −92, short −48).
4. **Panel** unfolds from the ring: `transform-origin: 50% 100%`; from `translate3d(dx,dy,-200px) rotateX(-74deg) scale(.4)` to `rotateX(3deg) scale(1)`; 560ms `cubic-bezier(.2,.75,.2,1)` delay 250ms. Parent `main` has `perspective:1400px; perspective-origin: ringX ringY`.
5. **Glass build**: edge highlight opacity at 320ms (.16s) → glass fill at 450ms (.32s) → one sheen sweep (translateX −75%→75%, 1s from 420ms) → tint drifts in.
6. **Content stagger** (opacity 0→1, translateY 8→0, .26s/.36s): header 520ms, body 600ms, input 680ms, footer 760ms.
7. **Focus** first input at 850ms. Video then jumps ahead to 12.0s (green active ring).

### Close
- Ring or "–" or Esc → power-off sound → panel folds back (content recedes 0–90ms, glass fades from 120ms, transform 380ms `cubic-bezier(.55,0,.8,.3)` delay 120ms) → beam retracts → camera returns (500ms, delay 420ms) → one quiet "absorb" pulse at ~880ms. Ring stays **green until the panel is gone**, then the film returns to the white resting frame (4.6s) at ~820ms.
- Calls and conversation keep running while closed; a dark pill "`<Name>` · call in progress" appears bottom-right to return.

### Projection cone (stacked layout)
Between ring and panel bottom:
- Core cone: clip-path trapezoid from ring top (width ≈ 1.24× ring radius) to panel bottom (panel width − 36px). Vertical gradient green near ring (`#c4f2d5b3`) → `#d6ebdf73` → `#e9f0f659` → `#ffffff99` at panel edge.
- Two edge lines (SVG, 1px) gradient `#c9f5d8` .95 → white .55 → white .9.
- Landing glow along panel bottom: 14px radial white/`#eafaf0`.
- Wide halo and ring-cap glow: **only shown during a live call** (they're positioned statically and would drift from the moving wrist otherwise).
- Cone scales from the ring (`scale(1,0)`→`scale(1)`, 360ms delay 360ms).

### Ring light states (overlay on the filmed ring; ring overlay only visible during a live call)
- idle: breathe 4.2s · hover/focus: bloom `0 0 18px 5px` · active (open): breathe 3.2s green `#98f0b9`
- incoming call: pulse 1.1s, `#b4f5cb`
- listening / speaking: glow radius follows voice level live (`6+22·level` px blur), `#8cefb1`
- thinking: breathe 1.1s · muted: dim, still · Gmail connected: bloom .9s `#8fd1a8`
- No drawn circle on top of the ring and no rotating arc.

### Sound
Web Audio, generated (no files). On: 20ms filtered noise click + sine 420→880Hz (.34s) + 1320Hz chime. Off: click + sine 760→300Hz (.32s). Toggle in header; setting persists for the session.

---

## Projected panel
- Desktop: width min(440px, vw−80), centered horizontally above the ring; top 16px (40 ≥1600, 0 short); height stops above the strap (min 280, max 700). Short desktop (≤680 tall): width 400, height `ringY − 38 − top`.
- Mobile: left/right 14px, top 8px, height ≥400 ending 58px above the ring.
- Radius 29px (26 mobile).
- **Glass**: bg `linear-gradient(150deg,#ffffffad,#f7f9fb85 50%,#eef2f69e)` (mobile more opaque: `#ffffffc2 / #f7f9fb9e / #eef2f6b3`), `backdrop-filter: blur(30px) saturate(1.8)`; border `1px #ffffffd9`; inner highlights `inset 0 1.5px 0 #fff, inset 0 -1px 0 #ffffff8c, inset ±1px 0 0 #ffffff59`; hairline `0 0 0 .5px #0000001f`; shadow `0 30px 80px -30px #26303d47, 0 3px 12px #00000006`. Tint layer: radial `#d9efe01f` from bottom + top white fade. Slight `rotateX(3deg)` stays after opening (disable via tilt setting).
- Blur never animates; only the glass layer's opacity does.

### Panel header (72px, padding 0 20/22)
Mini ring 30px (dark disc `radial-gradient(#3a3b40,#1f2023)` + 1.5px lit ring reacting to state) · Name 13px/550 · status 10px `#9a9ca4`: "A first hello" → "Here with you" / "With Sam" · "Calling…" · "Listening / Speaking / Thinking" · "Mic paused". Buttons 30×30 radius 9: "···" (memory, only after naming) and "–" (minimize).

### Screens inside the panel (no visible steps)
1. **Naming** — overline "LET'S MAKE THIS PERSONAL"; H2 "First, a name." 35px (33 mobile, 28 short), 450, tracking −.05em; "What would you like to call me?" 13px `#8c8e96`; input 52px, radius 15, bg `#ffffffb3`, border `#dddfe7`, placeholder "A name that feels right", max 32; send 35×35 radius 10 `#292a2f`; chips Nova · Cleo · Atlas · You choose (10px `#8f929c`); note "Then, a quick call to get to know you. / We can always stay in text." (hidden on short). After naming: "`<Name>`. I like it. Give me a second." → 1.1s → incoming.
2. **Incoming call** — HUD logo disc (glass disc with `mark.svg` at 40%, 1.5px lit ring 7px outside; hidden on short heights); overline "A QUICK HELLO"; H2 "`<Name>` is calling." 29px; "Tell me a little about yourself. / No script. Start anywhere."; buttons "Keep typing" (outline) and "Answer" (dark `#292a2e`), 12px, radius 99, padding 13×18/20; note "Your browser will ask for microphone access."
3. **Active voice** — HUD logo; overline = state; live caption 19px (17 mobile, 15 short), `#3f434b` when Persona speaks, `#8f959f` listening ("I'm listening." / muted "I'll wait."); optional "Connect Gmail while we talk" row; inline sample-inbox card when the insight is spoken. Pinned controls (48px circles, 40 short): Mute/Unmute, Text, End call (`#fae9e9` / `#c46a6a`).
4. **Chat** — transcript (Persona messages 13px/1.75 `#45484f` with name label; user bubbles `#dfe4ed80`, radius 16 16 4 16, right-aligned, left margin 38); system lines 9px centered ("Call started", "Call ended", "Staying in text", "Microphone unavailable", "Gmail connected · sample inbox"); "Call in progress · back to voice" pill when live; resume banner "NOTHING'S LOST / We were talking about …" on reopen (6s); suggestion chips on the last message; composer 18px radius, mic button, placeholder "Tell `<Name>` what's on your mind", send 30px circle `#303239`.
5. **Gmail permission sheet** (slides up inside panel, 360ms) — Gmail icon tile 52px; H2 "A little context. / A lot less *explaining.*"; lead "Connect Gmail so `<Name>` can look at recent senders, subjects and previews with you."; facts: "Read-only. Nothing can be sent, deleted or changed." (green dot) · "Reads recent senders, subjects and message previews." · "A small inbox snapshot reaches this app and its configured model."; notice "Google sign-in isn't set up in this preview. The inbox you'll see is a sample, and it's labelled that way."; "Explore a sample inbox" / "Not now".
6. **Inbox insight** — "Two things may need your attention. Dana and Marcus are both waiting on a reply." + card (Dana Whitfield — "Does Friday 10am work for you instead?"; Marcus Lee — "Can you send v2 by Monday?"; "Also due Oct 14 · Chase statement"; labelled "Sample"). Chips: "Help me reply to Dana" · "What's due soon?" · "What else is in there?".
7. **Memory sheet** — "The little things / worth remembering." Editable fields: Your Persona · Your name · On your mind · Gmail status. "Start fresh" → confirm "A fresh start?" / "Forget this conversation" / "Keep it".

Panel footer 9px: "Your conversation stays with you." / "Voice and text, together." / "Your inbox stays read-only."

### Conversation rules (replace simulation with backend)
Collect name → need → optional Gmail; never re-ask known facts; accept corrections ("call me Alex", "actually it's…"); mic denied → switch to text with "I can't hear you from here, so let's keep typing."; hang up → "Pick up here anytime. Nothing's lost."; decline → "Keep typing. I'm here."

---

## Product sections (below hero)
- **Section 1** — padding 96/0/40 (56/0/24 mobile), top border `#efeff2`, centered: overline "WHILE YOU GET ON WITH YOUR DAY"; H2 "It handles the rest. / *Then lets you know.*" clamp(36px, 3.4vw, 52px) (34 mobile); line "Calls, bookings, errands and inbox, each one reported back when it's done."; image `assets/completions.png` (max 1048px, multiply, mask fading all four edges). *Copy is placeholder — replace with approved marketing copy.*
- **Section 2** — "Your Persona is waiting. / Choose *yours*." 30px (24 mobile); `assets/lineup.png` (max 520px, multiply); dark button "Touch the ring ↑" scrolls to top then opens the panel.
- Product images were cropped from yourpersona.com/band screenshots at low resolution; replace with original assets.

## State
`open, intro, pressing, closing, scene (naming|incoming|voice|chat), sheet (gmail|memory|reset|null), live, status (listening|speaking|thinking), muted, level, agentName, userName, need, connected, transcript[], text, busy, resumed, soundOn`. Persist session (names, transcript, connected) across reloads via the backend.

## Design tokens
- Ink `#252527`; secondary `#8c8e96`, `#9a9ca4`, `#a1a1a8`; body text `#45484f`
- Page `#fcfcfc`; hairlines `#efeff2`, `#e7e7eb`, `#dddfe7`
- Primary button `#292a2e` / `#303239`; danger `#fae9e9` / `#c46a6a`
- Greens: `#98f0b9` active, `#8cefb1` voice, `#b4f5cb` incoming, `#8fd1a8` confirm, `#8fc4a1` fact dot, `#5f7a67` on `#e5eee58c` live pill
- Font: Inter (400/450/500/550/600 + italic 400/450), `font-synthesis:none`, antialiased
- Radii: 8, 9, 10, 13, 15, 16, 18, 22, 26, 29, 99
- Overline: 9px / 500 / .19em tracking

## Assets
- `assets/hero.mp4` — supplied Persona Band film (do not replace)
- `assets/band-poster.jpg` — calibrated still (ring at 941.75, 510 px in 1920×1080)
- `assets/press/f000–f084.jpg` — extracted from hero.mp4 (4.6–8.1s) for reverse playback
- `assets/mark.svg` — Persona logo; `assets/gmail.svg` — Gmail mark
- `assets/completions.png`, `assets/lineup.png` — from user-supplied screenshots of yourpersona.com/band

## Files
- `Persona Onboarding.dc.html` — the full prototype (template + logic)
- `support.js` — runtime needed to open the prototype locally
- `assets/` — all media above

## Prototype settings (for reviewing states)
viewport (auto/desktop/mobile) · intro · greenClose · pressAnim (always/first/off) · pressSpeed · sound · reviewNav (scene jump buttons) · micDenied · tilt
