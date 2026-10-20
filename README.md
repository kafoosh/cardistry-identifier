# Cardistry Identifier

Track your hands live through the camera while doing cardistry, record moves, and (later) have the app recognise them. Hand tracking runs entirely in the browser with MediaPipe Hand Landmarker; nothing is uploaded unless you choose to share a recording, and then only its landmarks.

See [docs/build-plan.md](docs/build-plan.md) for the full roadmap: live wireframe, local recording, a shared Cloudflare-backed library, DTW recognition, routines, a trained model and card tracking.

## Status

- [x] **Milestone 1: live wireframe.** Camera on phone or laptop (front/rear switch), two-hand tracking with a GPU-to-CPU fallback, wireframe overlay, fps and inference time, and per-hand tracking quality (share of frames each hand was seen, confidence, and dropouts over the last 5 s) to measure how much the cards hide the hands.
- [x] **Milestone 2: record and save locally.** Record button with a 3 s countdown and a 10 s cap, landmark capture plus an optional video clip, a save sheet to name the move (starter moves or a new one), camera angle and dominant hand, and a "My moves" library (IndexedDB) with wireframe replay at 1×, 0.5× and 0.25×, rename, delete, and JSON/video export. Each recording shows how much of it had hands tracked and its longest dropout.
- [x] **Milestone 3: shared library.** A Cloudflare Worker API (`api/`) with D1: share a recording's landmarks (never video), browse moves, replay anyone's recordings, and delete your own with a delete key kept in your browser. No accounts: an anonymous device id, Turnstile on uploads, per-device and per-IP daily limits, and server-side validation of every sequence. New move names become `proposed` moves.
- [x] **Milestone 4: recognise moves (DTW).** Preprocessing (gap filling, wrist-centred and palm-scaled hands rotated upright, left hands mirrored onto right, hands ordered by activity, resampled to 15 fps). An **Identify** mode matches the last few seconds live against your saved recordings with subsequence DTW in a Web Worker, gated on hand motion, showing the top 3 with a sensitivity slider. **Test recognition** in My moves runs a leave-one-out check over your takes, shows which moves get confused, and sets the match threshold from your data.

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
- `src/recognition/motion.ts` measures finger motion (wrist-relative, palm-scaled, smoothed) with on/off hysteresis. It drives auto-start/stop recording, trims idle ends off every take, and gates Identify so idle hands are never matched.
- `findOutliers` in `recognizer.ts` flags takes far from the rest of their move; they're left out of matching and marked "unusual" in My moves.
- `src/recognition/` holds feature extraction (`features.ts`), DTW and subsequence DTW (`dtw.ts`), ranking and the self-test (`recognizer.ts`), and the live loop (`identifier.ts`); matching runs in `matcher.worker.ts`.
- Add `?cpu` to the URL to force the CPU delegate if the GPU path misbehaves on a device.
- Landmarks are always stored in raw camera coordinates. The front-camera preview is mirrored with CSS only.

## Deploying

The build is a static site with a relative base path, so it works on GitHub Pages (`/cardistry-identifier/`) and Cloudflare Pages alike.

**GitHub Pages:** in the repo, go to Settings → Pages and set Source to "GitHub Actions". Every push to `main` then deploys via `.github/workflows/pages.yml`.

**API (Cloudflare Worker + D1):** `.github/workflows/api.yml` deploys `api/` on pushes that touch it. It needs these repository secrets: `CLOUDFLARE_API_TOKEN` (the "Edit Cloudflare Workers" template plus Account → D1 → Edit), `CLOUDFLARE_ACCOUNT_ID`, and `TURNSTILE_SECRET`. On first run it creates the `cardistry` D1 database and applies `api/migrations`. The site stays on GitHub Pages; the API allows it via `ALLOWED_ORIGINS` in `api/wrangler.toml`.

Sequence files are stored gzipped in D1 rather than R2, because R2 needs a payment card on the account and a recording is only a few KB.

The app finds the API through `src/config.ts` (overridable with `VITE_API_BASE` and `VITE_TURNSTILE_SITEKEY` at build time).

### Local API

```sh
cd api
npm install
npm run db:migrate:local
npm run dev            # http://localhost:8787, Turnstile skipped
```

Then build or run the app with `VITE_API_BASE=http://localhost:8787`.
