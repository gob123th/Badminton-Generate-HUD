# Badminton HUD — Web App

Static web app (no build step, no server code). User drops a fixed-camera badminton video → browser runs
player detection/tracking + shuttle tracking → renders a broadcast/game-style HUD → exports MP4 (original audio) + stats.json.
Everything runs client-side; videos never leave the user's machine. UI is Thai / English (switch in the top bar); HUD labels are English.

The sibling folder `../` holds the original Python CLI (Phase 1 only). The web app is the main product now.

## Run / test

```bash
cd webapp && python3 -m http.server 8080      # or VS Code Live Server (127.0.0.1:5500)
```
Open in Chrome/Edge (needs WebGPU + WebCodecs; Safari not supported). `file://` does not work (ES modules, fetch of models).

- Quick check: drop `../sample_video/กอล์ฟ หมู vs วา มาร์ค.mp4`, click the 4 court corners once (saved per file in localStorage), press "ทดสอบ 15 วินาที", render.
  No player names or court corners are preset in code — players come from detection + the user's cards.
- Debug: `window.__app` (state, stage, loadVideo, detectPlayers), `window.__lastResult` (blob + stats after render).
- Tracking regression harness: `js/_diag.js` (dev only, not loaded by the app). In the console:
  `const m = await import('/js/_diag.js'); m.run({ start: 0, end: 180 })` → poll `window.__diag`
  (reports per-player net-crossing frames `flips` and same-side shirt-colour swaps `swaps`/`swapLog`).
  Serve the video as `webapp/_full.mp4` for it; delete afterwards. Players come from the saved config
  (name the cards in the app first); pass `corners` for a clip other than the sample.

## Architecture

```
index.html        UI shell + importmap (CDN libs pinned: onnxruntime-web@1.30.0, mediabunny@1.60.0)
css/style.css     Dark navy UI; design tokens in :root; Kanit (UI/Thai) + Bebas Neue (numbers)
js/i18n.js        UI strings TH/EN: t(key, vars), data-i18n / data-i18n-title / data-i18n-aria, lang in localStorage bhud.lang
js/app.js         UI controller: steps 1 วิดีโอ → 2 สนาม → 3 ผู้เล่น (cards) → 4 สร้างวิดีโอ; model loading; progress
js/config.js      DEFAULT_CONFIG (players: [] — never preset names), localStorage (key bhud.config.v3; v2 migrated minus players), corners per file, import/export JSON
js/stage.js       Interactive canvas: 'calibrate' (click/drag 4 court corners, padded border for off-frame corners) / 'assign'
js/court.js       Court model (13.4 × 6.1 m, net y=6.7), 4-point homography image↔court, court lines
js/detector.js    YOLO11-pose ONNX 640×640 (letterbox, NMS, 17 keypoints) + zoomed far-court tiles. WebGPU → WASM fallback
js/bytetrack.js   ByteTrack port (Kalman xyah, two-stage association, greedy matching)
js/players.js     Track → named player: known IDs, then court distance + shirt-colour histogram; hard court-side rule; EMA smoothing
js/stats.js       Distance moved (dead-band + teleport filter), gamified stamina
js/shuttle.js     TrackNetV3 ONNX: median background + 8 RGB frames @512×288 → 8 heatmaps → blob centre
js/rally.js       PURE (no browser APIs, testable in node): trajectory cleanup, gap fill, hits, hitter, speed, rallies, scoring; shuttleStateAt()
js/hud.js         All HUD drawing on canvas: floor rings, name tags, top HUD, player panel (avatars), court map, LOCK ON (no trail),
                  speed badge with game-style rank (SPEED_RANKS: C/B/A/S/SS, EST.)
js/layout.js      LayoutEditor (step 4): drag HUD panels to move, corner handle to resize → cfg.render.layout {x, y, scale}
js/clip.js        ClipPlayer: plays a span of the source video on a canvas with an overlay (score review: watch a rally)
js/pipeline.js    openVideo/grabFrame + renderVideo(): pass 0 bg median → pass 1 analyze → rally analysis → pass 2 render+encode
models/           yolo11n-pose.onnx, yolo11s-pose.onnx (AGPL-3.0, Ultralytics), tracknetv3.onnx (MIT, qaz812345/TrackNetV3)
fonts/            Kanit-Regular/SemiBold (Thai), BebasNeue-Regular (Latin/numbers only — never Thai text)
```

### Data flow (renderVideo)
1. **Pass 0** (shuttle on): 32 frames sampled across the range → per-pixel median background for TrackNet.
2. **Pass 1** – per frame: draw to canvas → YOLO (every `stride` frames) → ByteTrack → PlayerTracker → StatsTracker →
   push a **snapshot** (players' pos/head/show, dist/sta) + boxes; feed TrackNet (batches of 8). Live preview = HUD without shuttle.
3. **Analysis** – `analyzeShuttle(rawPos, boxes)` over the whole range (needs the future of the trajectory).
   Scoring: `autoWinners` → optional `opts.review` (app pauses the pipeline, user fixes winners / adds missed points) → `buildScore` timeline.
4. **Pass 2** – decode again, draw HUD from snapshot[i] + `shuttleStateAt(i)`, encode via mediabunny `CanvasSource`;
   audio packets are copied, not re-encoded. Output: StreamTarget to a file handle (File System Access) or BufferTarget blob.

Panel placement goes through `HudRenderer.rect(name)` (default spot or `cfg.render.layout`, scale via `scaleOf`) — draw code and
the layout editor must both use it.

HudRenderer only reads snapshots (`{t, players, stats, shuttle, dets, preview}`) — keep pass 1 state out of it.

## Domain rules & gotchas (learned the hard way)
- **First frame timestamp may be > 0** (e.g. 0.033 s). `CanvasSink.getCanvas(0)` then returns null. Always clamp to `vid.firstTs` (see `grabFrame`).
- **Court coords:** x = width 0..6.1 (left→right seen from the near baseline), y = 0 far baseline → 13.4 near baseline.
  `orientation: 'behind'` = corners clicked TL,TR,BR,BL map to far-left, far-right, near-right, near-left. `'side'` rotates.
- **One detector session:** app queues detection runs and rendering awaits them — a render started while the auto-detect
  after loading a video was still running hung the tab.
- **Players never cross the net** within a game: `PlayerTracker.onSide()` is a hard rule (0.6 m slack). End changes between games are NOT handled yet.
- Same-side partners are separated by a 16-bin torso colour histogram (`torsoHist`). The fingerprint comes from the player card (`players[i].hist`, saved when the user names cards) or is averaged over the first 45 non-overlapping frames — then **frozen** (an EMA-updated model drifted after an overlap and locked in the swap). A detection that matches a same-side partner's shirt by > 0.12 is vetoed for this player, in both the known-ID and the distance steps.
- Verified on the sample clip: old tracker put the two far-side players on the wrong person in ~60% of far-side frames; the frozen-fingerprint tracker had 0 wrong frames in the measured window. Ground truth used: far side = one white shirt, one navy shirt.
- **Far-side players are too small for the 640 px full-frame pass** (e.g. ~90 px tall in 720p → ~45 px → YOLO score < 0.1, both
  far players missed). `Court.farTiles()` adds overlapping ~native-resolution tiles over the far-half band, full frame width
  (≤ 4 tiles) so neighbouring-court people are found too; `detect(…, rois)` merges by NMS and drops boxes cut by an inner tile
  edge. Costs 1 + tiles inferences per detected frame (720p: 1 + 3).
- Foot point = ankle keypoints (conf > 0.35) else bbox bottom-centre. Tag anchor = bbox top-centre. Both EMA-smoothed (alphas tuned at 30 fps, `fpsAlpha` rescales).
- **Shot speed is an estimate:** hitter→receiver court distance D over flight time T, drag-corrected
  `v0 = L(e^{D/L} − 1)/T`, `L = vt²/g`, vt = 7 m/s, exponent capped at 2.2, T ≥ 0.25 s, must cross the net. Image-space speed was tried and is useless for this camera angle (motion is mostly in depth).
- **Neighbouring courts' shuttles:** TrackNet blobs are masked to `Court.airPolygon()` (floor + 8 m) — with an oblique camera that
  barely helps. The real filter is in `analyzeShuttle` 2b: runs (split at gaps and at > 200 px/frame jumps = TrackNet switching
  courts) are kept when the shuttle sits in our players' racket zones (0.6 bh) in more frames than in *other* people's
  (`others` = detections that aren't our players, from pass 1); unclaimed mid-air runs are kept if they continue a kept run
  within 0.5 s along its velocity. Verified by eye on the "หมู มาย vs มาร์ค กอล์ฟ" clip 200–240 s. Known loss: the apex of a
  high lob after TrackNet lost the rise (> 0.5 s) is dropped (LOCK ON gap only; hits/score unaffected).
  Debug: `__lastResult.debug` holds `{rawShuttle, boxes, others}` to replay rally.js variants in the page or node.
- **Scoring** (rally point, teams A/B): winner = team of the next rally's server (strongest), else shuttle landing spot, else
  last hitter loses. The landing spot is used only if the shuttle was *falling* into its last point and that maps within court
  ± 2 m — a mid-air last point (lost track / static false blob) mapped to 32 m and handed the point to the team that hit it out.
  With a known last hitter: own side (didn't cross) or out → hitter loses; inside the other half → hitter wins. Serve-court parity (right court ⇔ even score)
  flags missed points. Everything depends on rally splitting — always offer the review step; it is an estimate.
- **Hits** = horizontal velocity reversal, or falling→rising (gravity can't do that), or a new flight appearing; dedupe 0.4 s. Rally = hits chained < 4 s apart with no shuttle loss > 1 s between them, ≥ 2 hits
  (without the loss rule, casual hits between points chained a whole 40 s clip into one rally).
- Thai text: draw with canvas `fillText` using the "HUD Thai" (Kanit) font only; Bebas has no Thai glyphs. Wait for `loadFonts()` before rendering.
- Models > 30 MB must be split for some transfer tools; GitHub accepts ≤ 100 MB per file. Don't ship zips without `models/`.
- Headless Chromium crashes on WebGPU inference — force WASM (`navigator.gpu = undefined`) for automated tests; it's ~1 fps there.

## Conventions
- Vanilla ES modules, no framework, no bundler. Keep files small and single-purpose; prefer extending existing modules.
- Pin CDN versions in the importmap (exact versions ≥ 2 weeks old). No other runtime network calls besides models/fonts in this folder.
- Config changes: add defaults to `DEFAULT_CONFIG` (deep-merged with saved config). Bump the localStorage key only for breaking shape changes.
- UI copy: add keys to both `th` and `en` in i18n.js (no literal UI strings in other files), concise; status lines via `setStatus(id, text, 'ok'|'warn'|'err')`, transient messages via `toast()`.
- `rally.js` must stay pure so it can be tested in node with recorded positions.
- Anything shown as a measurement that isn't one (speed, stamina) is labelled EST / gamified.

## Roadmap / known gaps
- Automatic court-line detection (currently manual 4-click or preset).
- End-change detection (teams switch sides between games).
- Audio onset (racket "pock") as a secondary hit signal; InpaintNet from TrackNetV3 for longer gaps.
