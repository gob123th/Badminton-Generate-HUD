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
js/app.js         UI controller: wizard 1 วิดีโอ → 2 สนาม → 3 ผู้เล่น (cards) → 4 สร้างวิดีโอ — one step visible, stepper +
                  back/next (`go()`: next only when `missing(step)` is null: video, court, ≥ 1 player); model loading; progress
js/config.js      DEFAULT_CONFIG (players: [] — never preset names), localStorage (key bhud.config.v3; v2 migrated minus players), corners per file, import/export JSON
js/stage.js       Interactive canvas: 'calibrate' (click/drag 4 court corners, padded border for off-frame corners) / 'assign'
js/court.js       Court model (13.4 × 6.1 m, net y=6.7), 4-point homography image↔court, court lines
js/detector.js    YOLO11-pose ONNX 640×640 (letterbox, NMS, 17 keypoints) + zoomed far-court tiles. WebGPU → WASM fallback
js/bytetrack.js   ByteTrack port (Kalman xyah, two-stage association, greedy matching)
js/players.js     Track → named player: known IDs, then court distance + shirt-colour histogram; hard court-side rule; EMA smoothing
js/stats.js       Distance moved (dead-band + teleport filter), gamified stamina
js/shuttle.js     TrackNetV3 ONNX: median background + 8 RGB frames @512×288 → 8 heatmaps → blob centre;
                  WasbTracker (assist): WASB 3 frames ImageNet-normalised → 3 heatmaps → heat-weighted blob + 300 px gate
js/rally.js       PURE (no browser APIs, testable in node): trajectory cleanup, gap fill, hits, hitter, speed, rallies, scoring; shuttleStateAt()
js/hud.js         All HUD drawing on canvas: floor rings, name tags, top HUD, player panel (avatars), court map, shuttle = faint circle
                  (`shuttleMark`; no trail, no LOCK ON — it was in the way), speed badge with game-style rank (SPEED_RANKS:
                  C/B/A/S/SS/SSS, EST.; thresholds `cfg.render.badge.ranks`, default 100/200/300/400/500 km/h) shown
                  `badge.secs` (0.7) + 0.3 s fade; `badge.mode` 'hit' = next to the hit point (following the shuttle it was
                  unreadable), 'fixed' = layout panel 'speedBadge' (draggable in step 4), 'off'; highlight banner.
                  Style from cfg.render: theme (THEMES), frame (angled/rounded/tech via frame()/frameFill()/corners()),
                  ringStyle (neon/solid/minimal), ringColor (player/team/theme + teamColors)
js/layout.js      LayoutEditor (step 4): drag HUD panels to move, corner handle to resize → cfg.render.layout {x, y, scale}
js/clip.js        ClipPlayer: plays a span of the source video on a canvas with an overlay (score review: watch a rally)
js/pipeline.js    openVideo/grabFrame + renderVideo(): pass 0 bg median → pass 1 analyze → rally analysis → pass 2 render+encode
models/           yolo11n-pose.onnx, yolo11s-pose.onnx (AGPL-3.0, Ultralytics), tracknetv3.onnx (MIT, qaz812345/TrackNetV3),
                  wasb.onnx (MIT, nttcom/WASB-SBDT badminton weights, exported from PyTorch with sigmoid; 5 MB)
fonts/            Kanit-Regular/SemiBold (Thai), BebasNeue-Regular (Latin/numbers only — never Thai text)
```

### Data flow (renderVideo)
1. **Pass 0** (shuttle on): 32 frames sampled across the range → per-pixel median background for TrackNet.
2. **Pass 1** – per frame: draw to canvas → YOLO (every `stride` frames) → ByteTrack → PlayerTracker → StatsTracker →
   push a **snapshot** (players' pos/head/show, dist/sta) + boxes; feed TrackNet (batches of 8). Live preview = HUD without shuttle.
   `cfg.model.assist`: WASB runs on the same frames; its position fills only frames where TrackNetV3 found nothing.
   `cfg.model.stride` > 1 (YOLO every 2/3/5 frames): after pass 1 `interpolateBetween` (players.js) interpolates snapshot
   pos/head and the analysis boxes between detected frames (they were held → stepping rings, lagging racket zones).
3. **Analysis** – `analyzeShuttle(rawPos, boxes)` over the whole range (needs the future of the trajectory).
   Scoring: `autoWinners` → optional `opts.review` (app pauses the pipeline, user fixes winners / adds missed points) → `buildScore` timeline.
4. **Pass 2** – decode again, draw HUD from snapshot[i] + `shuttleStateAt(i)`, encode via mediabunny `CanvasSource`;
   audio packets are copied, not re-encoded. Output: StreamTarget to a file handle (File System Access) or BufferTarget blob.
   Highlight reel (`cfg.highlight`): `pickHighlights` (rally.js) picks the top rallies (shots + top speed), from 1 s before
   the serve to `downAt` (the next serve's set-up, ≤ 25 s — clips ending 1 s after the last *detected* hit stopped before
   the shuttle was down; player speed was too noisy to find the end of a point), merged; pass 2 feeds the same rendered frames inside those spans (+ their audio packets, re-timed) to a second in-memory
   Output, with `hud.highlight()` banner/fade drawn *after* the main CanvasSource.add (which captures synchronously).
   Rallies marked "not a point" in the review are skipped.

Panel placement (topHud, playerPanel, courtMap, speedBadge) goes through `HudRenderer.rect(name)` (default spot or the stage's layout, scale via `scaleOf`) — draw code and
the layout editor must both use it.

Output stage (`cfg.render.stage`): 'overlay' (HUD on the video), 'landscape' (16:9, video inset top-left, panels around it) or
'portrait' (9:16, width = video height). `HudRenderer.geometry()` gives the output size `OW × OH` and the video rect; in-video
elements (rings, tags, shuttle circle, speed badge) are drawn through `inVideo()` (transform + clip), panels in output pixels,
`drawBase()` draws the frame + themed background. Each stage has its own layout (`layoutKey(stage)` → `layout` /
`layoutLandscape` / `layoutPortrait`). Pass 1's live preview always uses 'overlay' (the canvas is the video for detection);
pass 2 resizes the canvas to `OW × OH` before creating the encoder.

HudRenderer only reads snapshots (`{t, players, stats, shuttle, dets, preview}`) — keep pass 1 state out of it.

## Domain rules & gotchas (learned the hard way)
- **First frame timestamp may be > 0** (e.g. 0.033 s). `CanvasSink.getCanvas(0)` then returns null. Always clamp to `vid.firstTs` (see `grabFrame`).
- **Corner click order is free:** `orderCorners` (court.js, also applied in the `Court` constructor) sorts the 4 points
  clockwise from the top edge's left end → TL, TR, BR, BL; the stage re-sorts on release and labels the corners then.
  A user clicked TL, TR, BL, BR → bow-tie homography and crossed lines.
- **iOS (any browser, Chrome included = WebKit):** not supported; the banner says so (`browser.ios`) instead of "open in
  Chrome". On a user's iPhone the frame vanished / the tab crashed ("Can't open this page") in step 3 after picking
  frames and people — not reproduced here (no WebKit/iPhone). Suspected: WebKit's total canvas-memory limit (canvases
  count until GC). So: one reused frame canvas (`refreshFrame`), crop canvases zeroed after `toDataURL`, and the stage
  display canvas capped at 2560×1440 px (`Stage.k` scale; drawing and points stay in frame px — a 4K frame + border was
  ~4900×3200). Don't create full-size canvases per user action.
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
  high lob after TrackNet lost the rise (> 0.5 s) is dropped (shuttle-circle gap only; hits/score unaffected).
  Debug: `__lastResult.debug` holds `{rawShuttle, boxes, others}` to replay rally.js variants in the page or node.
- **Rallies come from serves** (`detectServes` / `ralliesFromServes`, rally.js) when ≥ 2 are found: before every serve the
  players stand still (mean speed < 0.35 m/s ≥ 0.7 s) with someone within 1.8 m behind a short service line, then all move.
  Verified by eye on "หมู มาย…" 0–120 s (serve/receive stances at each detected stretch). A rally = serve → hits chained
  < 4 s from it, ≥ 4 s long; `limit` = next serve's quiet start (the review clip plays to it). The server = the hit near the
  serve, else the first shuttle position after it given to the nearest racket zone (`guessed`). Hit-chain rallies are the
  fallback (no players / one serve). TrackNet misses much of the shuttle in casual footage — never rely on hits alone.
- **Service court parity** (right ⇔ serving team's score even): `detectServes` gives each serve a `box` ('R'/'L', vote of
  the players near the short lines, > 0.3 m off the centre line; server and receiver are both in their own right/left).
  `autoWinners` runs a score from `ctx.start`: when exactly one team's score + 1 fits the next serve's box, that team won
  (`by: 'box'`, strongest). `buildScore` flags ⚠ when the box contradicts the running score (missed / extra point).
- **Scoring is off by default** (`score.enabled: false`, config `rev` 1 turns it off once for configs saved before): the
  user found the guess wrong too often. Rallies / highlights don't need it.
- **WASB assist** (`cfg.model.assist`, on): compared with TrackNetV3 by eye on "ต้า วา vs หมู ฟ้าช" 0–120 s (python,
  same pre/post-processing as the app): inside our court they agree on ~90 % of frames; TrackNetV3-only points were mostly
  shuttles lying on the floor, WASB-only ones included high lobs near the roof (and more legs / net / posts). WebGPU on
  this Mac: YOLO 25.7 ms per tile (×4 at 720p), TrackNetV3 14.5 ms/frame, WASB 14.5 ms/frame. 40 s clip end-to-end:
  stride 1 without WASB 149 s, stride 5 with WASB 71 s; hits found 6 → 16 (not verified one by one).
- **Scoring** (rally point, teams A/B): winner = team of the next rally's server (strongest), else shuttle landing spot, else
  last hitter loses. The landing spot is used only if the shuttle was *falling* into its last point and that maps within court
  ± 2 m — a mid-air last point (lost track / static false blob) mapped to 32 m and handed the point to the team that hit it out.
  With a known last hitter: own side (didn't cross) or out → hitter loses; inside the other half → hitter wins. Serve-court parity (right court ⇔ even score)
  flags missed points. Everything depends on rally splitting — always offer the review step; it is an estimate.
- **Still blobs are not the shuttle:** TrackNet locks onto static spots (net-post top, wall sign) for a few frames at a
  time, recurring at the same pixel; also a lying/held shuttle. `analyzeShuttle` 1b drops still runs (≥ 4 frames within
  4 px) lasting ≥ 0.5 s or recurring at the same spot ≥ 2 other times. Verified by eye on "หมู มาย…" (516,386 = net post).
- **Hits** = horizontal velocity reversal, or falling→rising (gravity can't do that), or a new flight appearing *that leaves
  fast or rising* (a lob re-acquired mid-air, falling slowly, gave a fake hit + speed badge); dedupe 0.4 s. Rally = hits chained < 4 s apart with no shuttle loss > 1 s between them, ≥ 2 hits
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
