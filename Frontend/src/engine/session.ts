// A Session wraps one data source (recorded replay or live stream) and the
// pipeline + scorer it drives. The UI only talks to Session.

import type { Recording } from '@/types/messages'
import { STEP_US } from './config'
import { Pipeline } from './pipeline'
import { Scorer } from './scoring'
import { inferNodes } from './validate'

export interface SessionOptions {
  nlosWeighting: boolean
}

export interface Session {
  kind: 'replay' | 'live'
  name: string
  pipeline: Pipeline
  scorer: Scorer | null
  recording: Recording | null
  /** Current time on the shared clock (us). */
  tUs: number
  durationUs: number | null
  /** Live only: connection state. */
  connection?: 'connecting' | 'open' | 'closed' | 'error'
  dispose(): void
}

export class ReplaySession implements Session {
  readonly kind = 'replay'
  readonly name: string
  pipeline!: Pipeline
  scorer: Scorer | null = null
  readonly durationUs: number
  tUs = 0
  /** Arrival time of each line: newest timestamp seen so far in file order. */
  private readonly arrival: Float64Array
  private idx = 0
  private nextStep = STEP_US

  readonly recording: Recording
  private opts: SessionOptions

  constructor(recording: Recording, opts: SessionOptions) {
    this.recording = recording
    this.opts = opts
    this.name = recording.scenario?.case ?? recording.name
    const n = recording.lines.length
    this.arrival = new Float64Array(n)
    let newest = 0
    for (let i = 0; i < n; i++) {
      const ts = (recording.lines[i].value as { timestamp_us?: unknown } | undefined)?.timestamp_us
      if (typeof ts === 'number' && Number.isFinite(ts) && ts > newest && ts < newest + 60e6) newest = ts
      this.arrival[i] = newest
    }
    this.durationUs = Math.max(recording.scenario ? recording.scenario.duration_s * 1e6 : 0, newest)
    this.reset()
  }

  private reset() {
    const nodes = this.recording.scenario?.nodes ?? inferNodes(this.recording.lines)
    this.pipeline = new Pipeline(nodes, { nlosWeighting: this.opts.nlosWeighting })
    this.scorer = this.recording.truth ? new Scorer(this.recording.truth) : null
    this.idx = 0
    this.nextStep = STEP_US
    this.tUs = 0
  }

  setOptions(opts: SessionOptions) {
    this.opts = opts
    const t = this.tUs
    this.reset()
    this.runUntil(t)
  }

  private doStep(t: number) {
    this.pipeline.step(t)
    const est = this.pipeline.latestEstimate()
    if (this.scorer && est && est.tUs === t) this.scorer.onStep(est)
  }

  /** Feed every line that has arrived by tUs, stepping health/estimator every STEP_US. */
  runUntil(tUs: number) {
    const lines = this.recording.lines
    const t = Math.min(tUs, this.durationUs)
    while (this.idx < lines.length && this.arrival[this.idx] <= t) {
      while (this.arrival[this.idx] > this.nextStep) {
        this.doStep(this.nextStep)
        this.nextStep += STEP_US
      }
      this.pipeline.ingest(lines[this.idx++])
    }
    while (this.nextStep <= t) {
      this.doStep(this.nextStep)
      this.nextStep += STEP_US
    }
    this.tUs = t
  }

  seek(tUs: number) {
    if (tUs < this.tUs) this.reset()
    this.runUntil(tUs)
  }

  get finished() {
    return this.tUs >= this.durationUs
  }

  dispose() {}
}
