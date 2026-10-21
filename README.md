# AnchorlessUWBLocalization
UWB Ranging and Localization in GPS-denied environments, without the use of anchor nodes.

Mobile nodes range to each other with peer-to-peer UWB time-of-flight (Qorvo DWM3001C,
DS-TWR). A central computer works out where the nodes are relative to each other, with no
fixed anchors, using an IMU to cover motion that ranges alone can't see and a lightweight
model to down-weight non-line-of-sight (NLOS) ranges.

## Repository

| Folder | What's there |
|--------|--------------|
| `Localization/` | `generate_uwb_test_cases.py` and the 10 synthetic test cases it produces (`test_cases/TC01`–`TC10`) |
| `Frontend/` | Browser dashboard that replays recordings or shows a live stream |

Firmware, the Python backend and the real localization (EKF) aren't written yet.

## Frontend dashboard

The dashboard shows what the system sees: where the nodes are, which links are healthy,
which ranges look NLOS, and which packets were bad. Use it to watch a test case play out,
debug the data, and compare results with ground truth.

### Run it

Requires Node.js 20.19+ or 22.12+.

```bash
cd Frontend
npm install
npm run dev        # open http://localhost:5173
```

The dev server serves `Localization/test_cases/` directly, so all 10 test cases show up in
the case picker with nothing to copy.

### What's on screen

- **Top bar:** pick a test case, open your own recording (`measurements.jsonl`, plus
  `scenario.json`, `labels.jsonl` and `ground_truth.csv` if you have them), or connect to
  a live stream. Play, pause, seek and change speed (0.5×–10×).
- **Summary tiles:** nodes online, links up and how many are NLOS, geometry quality, fit
  residual, rejected records, and position error vs ground truth.
- **Node map:** estimated positions with 2σ uncertainty ellipses and 5 s trails. Links are
  green (LOS), amber (uncertain), red (NLOS) or dashed (down). Walls, pillars and moving
  obstacles are drawn, and hollow rings mark the true positions. Hover for details; click
  a link to chart it.
- **Tabs:**
  - **Links:** range, signal gap, quality and drop rate for each pair.
  - **Nodes:** health, uncertainty, seq counter and reboots for each node.
  - **Events:** a log of rejected packets, spikes, reboots, outages and geometry warnings.
  - **Scenario:** the test case's description and expected behaviour.
- **Charts:** range and RSSI − first-path power gap for the selected link, and position
  error over time.

Switches in the top bar turn the ground-truth overlay on or off, turn NLOS down-weighting
on or off (to compare results), and toggle the map between the arena frame and the raw
relative frame.

### How it works

All the processing runs in the browser, in separate stages:

1. **Ingest** (`src/engine/validate.ts`) checks every record. It rejects missing fields,
   unknown nodes, duplicates, negative or impossible ranges, and packets more than 1 s
   late. It flags spikes and out-of-order packets, and it notices seq resets (reboots).
2. **Health** (`src/engine/pipeline.ts`) tracks each link (up/down, drop rate, NLOS from
   the RSSI − first-path gap: under 6 dB is LOS, over 10 dB is NLOS) and each node
   (online, stale or offline), and logs an event whenever something changes.
3. **Estimate** (`src/engine/estimator.ts`) solves for positions every 100 ms from the
   latest ranges. This is a **placeholder** solver (weighted SMACOF), so the map has
   something to show until the real EKF exists. It reports uncertainty for each node and
   flags near-collinear layouts instead of giving confident wrong answers.
4. **Scoring** (`src/engine/scoring.ts`) compares estimates with ground truth and labels.
   Ground truth is only used for display and scoring; it never reaches the solver.

"Fixed-frame" error aligns the estimate to ground truth once and then holds that
alignment, so drift and group motion that UWB can't observe (TC05) show up as error.
"Shape" error re-aligns every step and measures only the shape.

### Live data

Open the **Live** box and enter a WebSocket URL, or use `?live=ws://host:port/path`. The
stream sends one JSON message per frame:

```json
{"type": "hello", "nodes": ["N1", "N2", "N3", "N4", "N5"]}
{"type": "measurement", "data": { "...same record as measurements.jsonl..." }}
{"type": "estimate", "t_us": 1200000, "nodes": {"N1": {"x_m": 1.0, "y_m": 1.0, "cov": [0.01, 0, 0.01], "status": "ok"}}}
```

Once the Python service sends `estimate` messages, they replace the placeholder solver.
The full format is in `Frontend/src/types/messages.ts`.

### Other commands

```bash
npm test           # run the pipeline end to end on all 10 test cases
npm run build      # typecheck and production build
npm run lint
```

Link to a specific view with `?case=TC08_nlos_obstruction&t=12&paused`.

Stack: Vite, React 19, TypeScript, Tailwind CSS + shadcn/ui, Zustand, uPlot, Canvas 2D,
Vitest. More detail is in [`Frontend/README.md`](Frontend/README.md).

## Test data

To regenerate the synthetic test cases:

```bash
python Localization/generate_uwb_test_cases.py
```

See [`Localization/test_cases/README.md`](Localization/test_cases/README.md) for the
data format and what each case tests.
