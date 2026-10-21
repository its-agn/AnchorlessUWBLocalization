# UWB Localization Frontend

Browser dashboard for the anchorless UWB localization system. It replays recorded
ranging data (the generated test cases or any `measurements.jsonl`) and can connect to
a live WebSocket stream. It shows:

- **Node map**: estimated positions with 2σ uncertainty ellipses, 5 s trails, and links
  coloured by state (LOS / uncertain / NLOS / down). Arena, obstacles and ground-truth
  "ghost" positions are drawn when the recording has them.
- **Links / Nodes / Events / Scenario** tabs: per-link range, RSSI−first-path gap,
  quality and drop rate; per-node health, seq resets and uncertainty; an event log of
  rejected packets, spikes, reboots, outages and geometry warnings.
- **Charts** for the selected link (range, NLOS gap) and position error vs ground truth.

Stack: Vite + React 19 + TypeScript, Tailwind v4 + shadcn/ui, Zustand, uPlot, Canvas 2D,
Vitest.

## Run

```bash
npm install
npm run dev        # http://localhost:5173 — test cases are served from ../Localization/test_cases
npm test           # engine tests against all 10 test cases
npm run build      # typecheck + production build
```

URL parameters: `?case=TC08_nlos_obstruction&t=12&paused` opens a case at 12 s,
`?live=ws://host:port/path` connects to a live stream.

## How it's organised

```
src/types/messages.ts    Data contracts: raw records, labels, scenario, and the live
                         PipelineMessage format the Python service should send
src/data/                Parsing, test-case loading, LiveSession (WebSocket)
src/engine/              Processing, in stages that stay separate:
  validate.ts              raw lines -> validated measurements (rejects/flags bad data)
  pipeline.ts              link/node health, events, chart history, runs the estimator
  estimator.ts             PLACEHOLDER solver (weighted SMACOF), see below
  scoring.ts, truth.ts     ground truth / labels: display and scoring only
  session.ts               replay clock (file order = arrival order)
  config.ts                thresholds (stale window, spike jump, NLOS dB, …)
src/components/          Map, tables, charts, header, replay bar (shadcn/ui in ui/)
tests/engine.test.ts     Runs every test case end to end
```

### Rules the code follows

- `labels.jsonl` and `ground_truth.csv` never reach the pipeline or estimator. They're
  used only by `scoring.ts` and for drawing, behind the "Ground truth" switch.
- The arena-frame view aligns the estimate to ground truth **once** (when geometry first
  becomes good) and then holds that transform. So drift and motion UWB can't observe
  (TC05) show up as growing "fixed-frame" error, while "shape" error re-aligns every step.
- Records are processed in file order, which is arrival order; a record whose timestamp is
  older than the newest seen is flagged out-of-order (or rejected as stale after 1 s).

### Placeholder estimator

`engine/estimator.ts` exists only so the map shows positions before the real Python
EKF exists. It's weighted SMACOF on the latest ranges (NLOS-gap down-weighting
optional), with Fisher-information covariances and a collinearity check. When the
Python service streams `{"type": "estimate", ...}` messages, those replace it
(`pipeline.external`), and nothing in the UI needs to change.

## Live stream format

One JSON message per WebSocket frame (see `src/types/messages.ts`):

```json
{"type": "hello", "nodes": ["N1", "N2", "N3", "N4", "N5"]}
{"type": "measurement", "data": { ...same record as measurements.jsonl... }}
{"type": "estimate", "t_us": 1200000, "nodes": {"N1": {"x_m": 1.0, "y_m": 1.0, "cov": [0.01, 0, 0.01], "status": "ok"}}}
```
