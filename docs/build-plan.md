# Cardistry Identifier: Build Plan

A web app that tracks your hands live through the camera, lets you record and name cardistry moves, and later recognises a move as you perform it.

## 1. Feasibility and risks

**Verdict: feasible.** Browser hand tracking (MediaPipe Hand Landmarker) gives 21 3D points per hand at roughly 30 fps on a modern laptop or phone, with no server needed for tracking. Recognising a move from a sequence of those points is a well-studied problem (gesture / sign-language recognition).

| Risk | Why it matters | Mitigation |
|---|---|---|
| Occlusion by cards | Packets cover fingertips, so landmarks jitter or drop out | Store per-frame confidence, interpolate short gaps, record from a consistent angle, add many examples per move |
| Fast motion and blur | Cuts and spins are quick; 30 fps can miss frames | Ask for good lighting, use the highest frame rate the device allows, smooth landmarks |
| Hand swaps and mislabelled hands | MediaPipe can swap left/right when hands overlap | Track hands by position continuity, not just the handedness label |
| Camera angle and person variation | Same move looks different per angle, hand size, speed | Normalise (wrist-centred, scale by palm size, rotate to a canonical frame); time-warp for speed |
| Similar moves | Many cuts share the same finger pattern | Show top-3 guesses with confidence; let users confirm or correct |
| Small dataset early on | Trained models need many examples | Start with template matching, which works from 1 to 5 examples per move |

Landmarks only track hands. Card tracking is a later stage (see 4b); it is doable but needs a custom detector.

## 2. Recommended stack

- **Frontend:** TypeScript + Vite + React. `@mediapipe/tasks-vision` Hand Landmarker (GPU delegate, `VIDEO` running mode, `numHands: 2`). Canvas overlay to draw the wireframe on top of the `<video>`.
- **Recording:** `MediaRecorder` for the optional local video clip; landmark frames captured in parallel from the same loop.
- **Recognition (v1):** runs in the browser in plain TypeScript (DTW). Later a small model via TensorFlow.js or ONNX Runtime Web, trained offline in Python.
- **Backend: all Cloudflare, no sign-in.**
  - **Pages** hosts the static app (free, HTTPS included, which camera access requires).
  - **Workers / Pages Functions** provide a small API: upload, list moves, vote, report, delete.
  - **D1** (SQLite) holds moves, recordings metadata, votes and reports.
  - **R2** holds the landmark sequence files and the bundled template file.
  - **Turnstile** (free, invisible captcha) guards uploads, votes and reports.
  - **Cloudflare Access** (free for small teams) protects the `/admin` moderation page, so only you can approve and remove things.

**Devices: phone and laptop.** One responsive web app for both.
- Front/back camera switch on phones (rear camera gives better tracking); mirror the preview for front cameras but never the stored landmarks, and record which camera was used.
- Phones run MediaPipe's lighter settings (lower input resolution) and fall back to CPU if the GPU delegate fails; show fps so users know when tracking is struggling.
- Portrait and landscape layouts; a "prop your phone up" framing guide, since cardistry needs both hands free.

## 2b. Running it for free

Goal: $0/month until the app has real traction. Free-tier limits change, so check them before launch; the numbers below are approximate.

| Piece | Free option | Why it stays free |
|---|---|---|
| Hand tracking | MediaPipe in the browser | Runs on the user's device, no server compute |
| Recognition | DTW / TF.js model in the browser | Same, inference is client-side |
| Hosting | Cloudflare Pages | Static site, no bandwidth cap |
| API | Cloudflare Workers (~100k requests/day) | Only uploads, votes and listings hit it |
| Database | Cloudflare D1 (~5 GB, ~5M row reads/day) | Only metadata lives here |
| Landmark files | Cloudflare R2 (~10 GB, no egress fees) | A gzipped recording is ~20 KB, so 10 GB holds ~500,000 recordings |
| Spam protection | Cloudflare Turnstile | Free, unlimited |
| Moderation login | Cloudflare Access | Free for up to ~50 users |
| Model training | Google Colab free tier or your own laptop | Small sequence models train in minutes |
| Domain | Free `*.pages.dev` subdomain | A custom domain is the only likely cost (~$10/yr), and optional |

**Rules that keep it free**
- **No video storage in v1.** Video is what would blow through free storage. Clips stay on the user's device (downloadable) and only landmarks are uploaded.
- **Serve one bundled template file** from R2, cached on the CDN and rebuilt when moves change (a scheduled Worker cron), instead of every client querying every recording.
- **Downsample and quantise landmarks** (e.g. 15 fps, 16-bit ints) before upload; roughly halves size again.
- **Cap uploads** per device and per IP per day, and recording length (e.g. 10 s).
- **No pausing:** unlike Supabase, Cloudflare free projects don't sleep when idle, so no keep-alive job is needed.
- **Upgrade path:** if limits are hit, Workers Paid is ~$5/month and raises every limit above substantially.

## 3. Data model

D1 is SQLite, so types are simple; ids are random UUID strings.

```
moves
  id            text pk
  name          text            -- "Sybil", "Charlier cut"
  slug          text unique
  aliases       text            -- JSON array of other names
  category      text            -- cut, spring, display, flourish...
  description   text
  credited_to   text null       -- original creator of the move, if known
  status        text            -- proposed, approved, merged
  created_by    text            -- anonymous device id
  created_at    integer         -- unix ms

recordings
  id             text pk
  move_id        text -> moves
  device_id      text            -- anonymous id stored in the uploader's browser
  delete_hash    text            -- hash of a secret kept by the uploader, to delete later
  nickname       text null       -- optional display name, no account
  fps            real
  frame_count    integer
  duration_ms    integer
  handedness     text            -- left-dominant / right-dominant
  camera_view    text            -- front, top-down, side
  device         text
  r2_key         text            -- R2 key of the sequence file
  quality_score  real            -- mean landmark presence/confidence
  status         text            -- pending, approved, rejected
  created_at     integer

votes                            -- confirms a recording shows the move
  recording_id  text -> recordings
  device_id     text
  vote          integer          -- +1 / -1
  primary key (recording_id, device_id)

reports
  id            text pk
  target_type   text             -- move, recording
  target_id     text
  reason        text
  device_id     text
  resolved      integer          -- 0 / 1
```

**Sequence file** (one per recording, in R2): an array of frames, each holding `t` (ms), and for each of up to two hands: `handedness`, `score`, and 21 × `[x, y, z]` landmarks (normalised image coords). Store raw landmarks so features can be recomputed when the normalisation changes. At 30 fps, a 5-second move is about 150 frames ≈ 40 KB uncompressed for two hands; gzip roughly halves that.

## 3b. Shared, community database

Moves are shared: anyone can upload recordings without signing in, and everyone's recognition uses the whole library.

- **No accounts.** On first visit the app creates a random device id in the browser. Uploads, votes and reports are tied to it. An optional nickname can be shown on recordings. Clearing browser data means a new id, which is fine for this use.
- **Deleting your own uploads:** each upload returns a secret delete key that stays in the browser (only its hash is stored), so the uploader can remove it later without an account.
- **Contributing:** when saving, a user either picks an existing move (search by name or alias) or proposes a new one. A new move starts as `proposed` and becomes `approved` after you approve it on the admin page or after enough confirming votes, which keeps duplicates like "Sybil" vs "Sybil cut" out.
- **Trust and quality:** recordings are scored automatically (landmark coverage, length, steadiness) and low-quality ones are held back. Recordings with net downvotes or reports drop out of the matching set. Only `approved` recordings feed recognition.
- **Spam without sign-in:** Turnstile on every write, per-IP and per-device rate limits in the Worker, size and length caps, and server-side validation of every sequence file before it is stored. Votes are one per device per recording; since device ids are cheap to fake, votes only auto-approve when they come from several different IPs, and you have final say on the admin page.
- **Moderation:** a `/admin` page behind Cloudflare Access (your email only) to approve or merge moves, reject recordings and resolve reports.
- **Privacy:** landmarks contain no face or identity, and there are no accounts or emails stored. Video clips are not uploaded in v1. The upload screen says plainly that landmark data is shared publicly and used to train the shared model.
- **Scale:** each client downloads the bundled templates for approved moves and matches locally. When the library outgrows in-browser DTW, Stage 2's trained model takes over, retrained periodically on the approved data.

## 4. Recognition approach

**Preprocessing (shared by all stages)**
1. Fill short gaps (≤ 5 frames) by interpolation; drop recordings with poor coverage.
2. Normalise each hand: translate to the wrist, scale by wrist-to-middle-knuckle distance, rotate to a canonical palm orientation.
3. Features per frame: normalised landmark positions, finger joint angles, fingertip distances, inter-hand vector, velocities.
4. Smooth with a light filter (One Euro filter works well for landmarks).

**Stage 1: template matching with DTW (MVP)**
- Compare a live window against every saved recording using Dynamic Time Warping, which tolerates speed differences.
- Score = smallest DTW distance per move; show the move if it beats a threshold, with top-3 shown.
- Live detection uses a sliding window (e.g. last 1 to 4 s) evaluated a few times per second; motion-energy gating so idle hands are not classified.
- Pros: works with a handful of examples, no training, easy to debug. Cons: slows down as the library grows (fine up to a few hundred recordings, helped by downsampling and a lower-bound prune such as LB_Keogh).

**Stage 2: trained sequence classifier**
- Once there are about 20 to 50 recordings per move across several people, train a small model offline: 1D temporal CNN or GRU/LSTM, or a lightweight transformer, on the feature sequences.
- Augment with time stretching, small rotations/scales, mirroring (for left-handed users), and random landmark dropout to mimic card occlusion.
- Export to TF.js/ONNX and run in the browser. Keep DTW as a fallback for moves with too few examples.
- Add an "unknown move" class (or a confidence threshold) so random handling is not forced into a label.

**Stage 3: moves inside a continuous routine (required)**
- *First version (DTW):* run subsequence DTW over the live stream, so a template can match anywhere in it, not just in a fixed window. Keep matches above a confidence threshold and suppress overlapping ones, giving a timeline like "Charlier 0:02 to 0:04, Sybil 0:05 to 0:09".
- *Labelled routines:* add a "Record routine" mode. After recording, the user scrubs the wireframe replay and marks where each move starts and ends. Those segments become extra training recordings, and the whole routine is kept as a test case.
- *Trained version:* a temporal segmentation model (e.g. a temporal convolutional network) that labels every frame with a move or "transition", trained on labelled routines plus single-move recordings stitched together synthetically.
- Embedding model (contrastive learning) later, so new moves can be added from a few examples without retraining.

## 4b. Card tracking (later stage)

Yes, this can be added, and it stays free, but it is the most work. Hand landmarks alone can't always tell apart moves with the same finger pattern but different packet handling.

- **Model:** a small object detector (e.g. YOLO-nano class, or MediaPipe Model Maker's object detector) trained to find card packets, and later the packet count and orientation. Exported to ONNX/TF.js and run in the browser at a lower rate than hand tracking (e.g. 10 fps) to stay fast on phones.
- **Features added:** number of packets, packet centres relative to the hands, packet rotation, which hand holds which packet. These are appended to the hand features, so DTW and the trained models use them without other changes.
- **Training data:** needs labelled video frames, which conflicts with "no video upload". Plan: you label frames from your own recordings locally using a free tool (Label Studio or CVAT), with a few hundred to a couple of thousand frames to start. Later, an opt-in "donate frames" button could upload a handful of still frames (not full video) to R2.
- **Training:** free on Google Colab.
- **When:** only after hand-only recognition is working, and only if specific moves keep getting confused.

## 5. MVP milestones

1. **Live wireframe.** Camera permission, Hand Landmarker running, skeleton drawn over video, fps counter. Test with a deck in hand to see real occlusion.
2. **Record and save locally.** Record button with countdown, capture landmark frames (+ optional video), name the move, replay the wireframe. Store in IndexedDB first.
3. **Shared backend.** Cloudflare Worker API, D1 tables, R2 uploads with Turnstile and rate limits, anonymous device ids and delete keys, a public library page to browse moves and replay anyone's recordings.
4. **Recognise (DTW).** Preprocessing pipeline, "Identify" mode with live top-3 guesses and confidence, threshold tuning.
5. **Community and moderation.** Propose new moves, vote on recordings, report bad data, an `/admin` page behind Cloudflare Access for approving and merging moves. Users confirm or correct guesses, and corrected attempts become new recordings.
6. **Routine mode.** Subsequence DTW on the live stream with a move timeline, plus "Record routine" with move-boundary marking.
7. **Trained model.** Export dataset, Python training notebook, browser inference for single moves and routine segmentation, compared against DTW on a held-out set of people.
8. **Card tracking.** Label frames, train the packet detector, add card features to recognition.

**Starter moves** for milestones 1 to 4: Charlier cut, Revolution cut, Swing cut, L cuts, Sybil, Spring, Molecule spin. Record each about 5 times, from both phone and laptop.
- Charlier and Revolution cut are both one-handed cuts with similar finger motion, so they are a good early test of whether hands alone can tell close moves apart.
- Spring and Molecule spin hide fingers behind cards and move fast, so they will show how bad occlusion is.

Milestones 1 to 4 are a usable MVP. Milestone 1 doubles as the main risk check: if tracking through the cards is too unstable, we learn it before building anything else.

## 6. Decisions so far

1. Shared community database.
2. Landmarks only, no video upload in v1 (cost).
3. Cloudflare (Pages, Workers, D1, R2), no user accounts.
4. Starter moves: Charlier cut, Revolution cut, Swing cut, L cuts, Sybil, Spring, Molecule spin.
5. Support both phone and laptop cameras.
6. Recognise moves inside continuous routines (Stage 3, milestone 6).
7. Card tracking as a later stage (4b, milestone 8).

## 7. Open questions

None right now. New questions will come out of milestone 1, once tracking is tested with a real deck.
