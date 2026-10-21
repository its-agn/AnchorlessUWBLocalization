// The processing pipeline the UI visualises. Stages are kept separate:
//   raw lines -> Validator (processed measurements) -> link/node health
//   -> PlaceholderEstimator (position estimates).
// Never sees labels or ground truth (see scoring.ts for that).

import type { RawLine } from '@/types/messages'
import {
  ESTIMATOR_RANGE_AGE_US,
  LINK_DOWN_US,
  NLOS_GAP_DB,
  NLOS_GAP_UNCERTAIN_DB,
  NODE_OFFLINE_US,
  NODE_STALE_US,
  STATS_WINDOW_US,
  TRAIL_US,
} from './config'
import { PlaceholderEstimator, type EstimateResult, type RangeInput } from './estimator'
import { median } from './linalg'
import { Validator, pairKey, type Flag, type RejectReason, type Verdict } from './validate'

export type NlosLevel = 'los' | 'uncertain' | 'nlos' | 'unknown'

export interface LinkState {
  key: string
  a: string
  b: string
  status: 'up' | 'down' | 'unknown'
  nlos: NlosLevel
  /** Latest valid range. */
  lastUs: number | null
  range: number | null
  gap: number | null
  quality: number | null
  /** Valid ranges per second over the stats window. */
  rateHz: number
  /** Share of attempts that failed (timeout / rx_error) over the stats window. */
  dropPct: number
  valid: number
  failed: number
  rejected: number
  outliers: number
}

export interface NodeState {
  id: string
  status: 'online' | 'stale' | 'offline' | 'unknown'
  lastValidUs: number | null
  lastSeq: number | null
  seqResets: number
  rangesPerSec: number
}

export type Severity = 'info' | 'warn' | 'error'

export interface PipelineEvent {
  id: number
  tUs: number
  severity: Severity
  kind: string
  text: string
}

/** Column store per link for charts (one row per 'ok' record). */
export interface LinkHistory {
  t: number[] // seconds
  range: (number | null)[]
  outlier: (number | null)[]
  gap: number[]
  quality: number[]
  line: number[]
}

export interface Counters {
  lines: number
  valid: number
  timeout: number
  rx_error: number
  rejected: Partial<Record<RejectReason, number>>
  flagged: Partial<Record<Flag, number>>
  seqResets: number
}

export interface EstimateStep {
  tUs: number
  est: EstimateResult
}

const MAX_EVENTS = 1000

export class Pipeline {
  readonly nodes: string[]
  readonly links: Map<string, LinkState>
  readonly nodeState: Map<string, NodeState>
  readonly history = new Map<string, LinkHistory>()
  readonly verdicts: Verdict[] = []
  readonly events: PipelineEvent[] = []
  readonly estimates: EstimateStep[] = []
  readonly counters: Counters = { lines: 0, valid: 0, timeout: 0, rx_error: 0, rejected: {}, flagged: {}, seqResets: 0 }
  readonly estimator: PlaceholderEstimator
  /** Last estimate pushed from outside (live Python service); overrides the placeholder. */
  external = false

  private validator: Validator
  private attempts = new Map<string, { t: number; ok: boolean }[]>()
  private nodeHits = new Map<string, number[]>()
  private recent = new Map<string, { t: number; d: number; gap: number }[]>()
  private gaps = new Map<string, number[]>()
  private eventId = 0
  private degenerate = false
  nowUs = 0

  constructor(nodes: string[], opts = { nlosWeighting: true }) {
    this.nodes = [...nodes].sort()
    this.validator = new Validator(new Set(this.nodes))
    this.estimator = new PlaceholderEstimator(this.nodes, opts)
    this.links = new Map()
    for (let i = 0; i < this.nodes.length; i++)
      for (let j = i + 1; j < this.nodes.length; j++) {
        const a = this.nodes[i]
        const b = this.nodes[j]
        const key = pairKey(a, b)
        this.links.set(key, {
          key, a, b, status: 'unknown', nlos: 'unknown', lastUs: null, range: null, gap: null, quality: null,
          rateHz: 0, dropPct: 0, valid: 0, failed: 0, rejected: 0, outliers: 0,
        })
        this.history.set(key, { t: [], range: [], outlier: [], gap: [], quality: [], line: [] })
        this.attempts.set(key, [])
        this.recent.set(key, [])
        this.gaps.set(key, [])
      }
    this.nodeState = new Map(
      this.nodes.map((id) => [id, { id, status: 'unknown', lastValidUs: null, lastSeq: null, seqResets: 0, rangesPerSec: 0 }]),
    )
    for (const id of this.nodes) this.nodeHits.set(id, [])
  }

  private emit(tUs: number, severity: Severity, kind: string, text: string) {
    this.events.push({ id: this.eventId++, tUs, severity, kind, text })
    if (this.events.length > MAX_EVENTS) this.events.shift()
  }

  ingest(raw: RawLine): Verdict {
    const v = this.validator.check(raw)
    this.verdicts.push(v)
    const c = this.counters
    c.lines++
    const m = v.m
    const t = m?.timestamp_us ?? this.nowUs
    const who = m ? `${m.source_id}→${m.target_id}` : 'unreadable line'

    if (v.kind === 'rejected') {
      c.rejected[v.reason!] = (c.rejected[v.reason!] ?? 0) + 1
      if (m) {
        const link = this.links.get(pairKey(m.source_id, m.target_id))
        if (link) link.rejected++
      }
      const extra =
        v.reason === 'stale' ? ` (${(v.ageUs / 1e6).toFixed(1)} s late)` : m?.distance_m != null && (v.reason === 'negative_range' || v.reason === 'impossible_range') ? ` (${m.distance_m.toFixed(2)} m)` : ''
      this.emit(this.nowUs, 'warn', 'rejected', `Line ${raw.line} ${who} rejected: ${v.reason!.replace('_', ' ')}${extra}`)
      return v
    }
    for (const f of v.flags) c.flagged[f] = (c.flagged[f] ?? 0) + 1
    if (v.seqReset) {
      c.seqResets++
      const ns = this.nodeState.get(m!.source_id)!
      ns.seqResets++
      this.emit(t, 'warn', 'seq_reset', `${m!.source_id} seq reset ${v.seqReset.from} → ${v.seqReset.to} (reboot)`)
    }
    if (v.flags.includes('out_of_order'))
      this.emit(t, 'info', 'out_of_order', `Line ${raw.line} ${who} arrived out of order (${(v.ageUs / 1e3).toFixed(0)} ms behind)`)

    const key = pairKey(m!.source_id, m!.target_id)
    const link = this.links.get(key)!
    const src = this.nodeState.get(m!.source_id)!
    if (!v.flags.includes('out_of_order') || src.lastSeq == null) src.lastSeq = m!.seq

    if (v.kind === 'failed') {
      if (m!.status === 'timeout') c.timeout++
      else c.rx_error++
      link.failed++
      this.attempts.get(key)!.push({ t, ok: false })
      return v
    }

    const d = m!.distance_m!
    const gap = m!.diag!.rssi_dbm - m!.diag!.fp_power_dbm
    const h = this.history.get(key)!
    const outlier = v.flags.includes('outlier')
    // Keep rows time-sorted (out-of-order packets land a few rows back).
    let k = h.t.length
    while (k > 0 && h.t[k - 1] > t / 1e6) k--
    h.t.splice(k, 0, t / 1e6)
    h.range.splice(k, 0, outlier ? null : d)
    h.outlier.splice(k, 0, outlier ? d : null)
    h.gap.splice(k, 0, gap)
    h.quality.splice(k, 0, m!.diag!.quality)
    h.line.splice(k, 0, raw.line)
    if (outlier) {
      link.outliers++
      this.emit(t, 'warn', 'outlier', `${key} spike ignored: ${d.toFixed(2)} m (recent ~${(link.range ?? NaN).toFixed(2)} m)`)
      return v
    }

    c.valid++
    link.valid++
    link.lastUs = Math.max(link.lastUs ?? 0, t)
    link.range = d
    link.gap = gap
    link.quality = m!.diag!.quality
    this.attempts.get(key)!.push({ t, ok: true })
    this.recent.get(key)!.push({ t, d, gap })
    const g = this.gaps.get(key)!
    g.push(gap)
    if (g.length > 5) g.shift()
    for (const id of [m!.source_id, m!.target_id]) {
      const ns = this.nodeState.get(id)!
      ns.lastValidUs = Math.max(ns.lastValidUs ?? 0, t)
      this.nodeHits.get(id)!.push(t)
    }
    return v
  }

  /** Evaluate health at time tUs and run the estimator. Called every STEP_US. */
  step(tUs: number) {
    this.nowUs = tUs
    const winStart = tUs - STATS_WINDOW_US
    const winS = Math.min(STATS_WINDOW_US, Math.max(tUs, 1)) / 1e6

    for (const link of this.links.values()) {
      const att = this.attempts.get(link.key)!
      while (att.length && att[0].t < winStart) att.shift()
      const ok = att.filter((a) => a.ok).length
      link.rateHz = ok / winS
      link.dropPct = att.length ? (100 * (att.length - ok)) / att.length : 0
      const rec = this.recent.get(link.key)!
      while (rec.length && rec[0].t < tUs - 2 * ESTIMATOR_RANGE_AGE_US) rec.shift()

      const up = link.lastUs != null && tUs - link.lastUs <= LINK_DOWN_US
      const status = link.lastUs == null ? 'unknown' : up ? 'up' : 'down'
      if (status === 'down' && link.status === 'up')
        this.emit(tUs, 'warn', 'link_down', `Link ${link.key} down (no valid range for ${(LINK_DOWN_US / 1e6).toFixed(0)} s)`)
      if (status === 'up' && link.status === 'down') this.emit(tUs, 'info', 'link_up', `Link ${link.key} restored`)
      link.status = status

      const g = this.gaps.get(link.key)!
      const mg = median(g)
      const nlos: NlosLevel = !up || !g.length ? 'unknown' : mg > NLOS_GAP_DB ? 'nlos' : mg > NLOS_GAP_UNCERTAIN_DB ? 'uncertain' : 'los'
      if (nlos === 'nlos' && link.nlos !== 'nlos')
        this.emit(tUs, 'warn', 'nlos', `Link ${link.key} looks NLOS (RSSI−FP gap ${mg.toFixed(1)} dB)`)
      if (link.nlos === 'nlos' && nlos === 'los') this.emit(tUs, 'info', 'los', `Link ${link.key} back to LOS`)
      if (nlos !== 'unknown') link.nlos = nlos
      else if (!up) link.nlos = 'unknown'
    }

    for (const ns of this.nodeState.values()) {
      const hits = this.nodeHits.get(ns.id)!
      while (hits.length && hits[0] < winStart) hits.shift()
      ns.rangesPerSec = hits.length / winS
      if (ns.lastValidUs == null) continue
      const age = tUs - ns.lastValidUs
      const status = age > NODE_OFFLINE_US ? 'offline' : age > NODE_STALE_US ? 'stale' : 'online'
      if (status !== ns.status && ns.status !== 'unknown') {
        if (status === 'online') this.emit(tUs, 'info', 'node_online', `${ns.id} back online`)
        else if (status === 'stale') this.emit(tUs, 'warn', 'node_stale', `${ns.id} stale: no valid range for ${(age / 1e3).toFixed(0)} ms`)
        else this.emit(tUs, 'error', 'node_offline', `${ns.id} offline`)
      }
      ns.status = status
    }

    if (this.external) return
    const ranges: RangeInput[] = []
    for (const [key, rec] of this.recent) {
      const fresh = rec.filter((r) => r.t >= tUs - ESTIMATOR_RANGE_AGE_US && r.t <= tUs)
      if (!fresh.length) continue
      const l = this.links.get(key)!
      ranges.push({ a: l.a, b: l.b, d: median(fresh.map((r) => r.d)), gap: median(fresh.map((r) => r.gap)) })
    }
    const est = this.estimator.update(ranges)
    if (est) this.pushEstimate(tUs, est)
  }

  pushEstimate(tUs: number, est: EstimateResult) {
    if (est.degenerate !== this.degenerate) {
      this.emit(
        tUs,
        est.degenerate ? 'warn' : 'info',
        'geometry',
        est.degenerate
          ? `Poor geometry: nodes nearly collinear (spread ${est.spreadRatio.toFixed(2)}), lateral positions unreliable`
          : 'Geometry recovered: estimates well conditioned',
      )
      this.degenerate = est.degenerate
    }
    this.estimates.push({ tUs, est })
  }

  latestEstimate(): EstimateStep | null {
    return this.estimates.length ? this.estimates[this.estimates.length - 1] : null
  }

  /** Estimated trail per node for the last TRAIL_US. */
  trails(): Record<string, [number, number][]> {
    const out: Record<string, [number, number][]> = {}
    const from = this.nowUs - TRAIL_US
    for (let k = this.estimates.length - 1; k >= 0 && this.estimates[k].tUs >= from; k--) {
      for (const [id, n] of Object.entries(this.estimates[k].est.nodes)) {
        if (n.status === 'lost') continue
        ;(out[id] ??= []).push([n.x, n.y])
      }
    }
    for (const id in out) out[id].reverse()
    return out
  }
}
