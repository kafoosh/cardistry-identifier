# Cardistry Identifier

Track your hands live through the camera while doing cardistry, record moves, and (later) have the app recognise them. Hand tracking runs entirely in the browser with MediaPipe Hand Landmarker; nothing is uploaded.

See [docs/build-plan.md](docs/build-plan.md) for the full roadmap: live wireframe, local recording, a shared Cloudflare-backed library, DTW recognition, routines, a trained model and card tracking.

## Status

- [x] **Milestone 1: live wireframe.** Camera on phone or laptop (front/rear switch), two-hand tracking with a GPU-to-CPU fallback, wireframe overlay, fps and inference time, and per-hand tracking quality (share of frames each hand was seen, confidence, and dropouts over the last 5 s) to measure how much the cards hide the hands.
- [x] **Milestone 2: record and save locally.** Record button with a 3 s countdown and a 10 s cap, landmark capture plus an optional video clip, a save sheet to name the move (starter moves or a new one), camera angle and dominant hand, and a "My moves" library (IndexedDB) with wireframe replay at 1×, 0.5× and 0.25×, rename, delete, and JSON/video export. Each recording shows how much of it had hands tracked and its longest dropout.
- [ ] Milestone 3: shared backend (Cloudflare Workers, D1, R2, Turnstile)
- [ ] Milestone 4: recognise moves (DTW)

## Run locally

```sh
npm install
npm run dev
```

Open the printed URL. Camera access needs `localhost` or HTTPS; to try it on a phone, use the deployed site (or `npm run dev -- --host` with an HTTPS tunnel).

## How it works

- `src/tracking/handTracker.ts` loads the Hand Landmarker (VIDEO mode, 2 hands). The WASM runtime is copied into `public/mediapipe` from `node_modules` by `scripts/copy-wasm.mjs`, and the model lives in `public/models`, so the app has no runtime CDN dependency.
- `src/tracking/trackingLoop.ts` runs detection on every new video frame, outside React.
- `src/tracking/handIdentity.ts` keeps each hand in a stable slot (A/B) by position, because MediaPipe's left/right label can swap when hands overlap.
- `src/recording/recorder.ts` captures frames from the loop (and a `MediaRecorder` clip); `src/storage/db.ts` keeps summaries, frames and videos in separate IndexedDB stores so listing stays fast.
- Add `?cpu` to the URL to force the CPU delegate if the GPU path misbehaves on a device.
- Landmarks are always stored in raw camera coordinates. The front-camera preview is mirrored with CSS only.

## Deploying

The build is a static site with a relative base path, so it works on GitHub Pages (`/cardistry-identifier/`) and Cloudflare Pages alike.

**GitHub Pages:** in the repo, go to Settings → Pages and set Source to "GitHub Actions". Every push to `main` then deploys via `.github/workflows/pages.yml`.

From milestone 3 the API runs on Cloudflare Workers, and the site moves to Cloudflare Pages.
