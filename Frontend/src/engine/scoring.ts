// Scoring against ground truth and labels. Display/benchmark only: nothing here
// feeds back into the pipeline or estimator.

import type { GroundTruth, Label } from '@/types/messages'
import { NLOS_GAP_DB } from './config'
import { IDENTITY, applyRigid, procrustes, type Rigid2D, type Vec2 } from './linalg'
import type { EstimateStep } from './pipeline'
import { truthAt } from './truth'
import type { Verdict } from './validate'

export interface ErrorPoint {
  t: number // s
  /** RMS error in the frame locked at the first good estimate (shows drift and unobservable motion). */
  fixed: number
  /** RMS error after re-aligning this step alone (shape quality only). */
  shape: number
}

export class Scorer {
  /** Transform from estimator frame to truth frame, locked once geometry is good. */
  locked: Rigid2D | null = null
  current: Rigid2D = IDENTITY
  readonly errors: ErrorPoint[] = []
  perNode: Record<string, number> = {}

  private readonly gt: GroundTruth

  constructor(gt: GroundTruth) {
    this.gt = gt
  }

  onStep(step: EstimateStep) {
    const truth = truthAt(this.gt, step.tUs)
    const ids = Object.keys(step.est.nodes).filter((id) => step.est.nodes[id].status !== 'lost' && truth[id])
    if (ids.length < 3) return
    const src: Vec2[] = ids.map((id) => [step.est.nodes[id].x, step.est.nodes[id].y])
    const dst = ids.map((id) => truth[id])
    const fit = procrustes(src, dst, true)

    const good = ids.filter((id) => step.est.nodes[id].status === 'ok').length >= 3 && !step.est.degenerate
    if (!this.locked && good) this.locked = fit.T
    this.current = this.locked ?? fit.T

    let e = 0
    this.perNode = {}
    ids.forEach((id, k) => {
      const p = applyRigid(this.current, src[k])
      const err = Math.hypot(p[0] - dst[k][0], p[1] - dst[k][1])
      this.perNode[id] = err
      e += err * err
    })
    this.errors.push({ t: step.tUs / 1e6, fixed: Math.sqrt(e / ids.length), shape: fit.rms })
  }

  summary() {
    const last = this.errors[this.errors.length - 1]
    const mean = (k: 'fixed' | 'shape') =>
      this.errors.length ? Math.sqrt(this.errors.reduce((s, p) => s + p[k] ** 2, 0) / this.errors.length) : NaN
    return {
      locked: this.locked != null,
      fixedNow: last?.fixed ?? NaN,
      shapeNow: last?.shape ?? NaN,
      fixedRun: mean('fixed'),
      shapeRun: mean('shape'),
    }
  }
}

export interface NlosConfusion {
  tp: number
  fp: number
  fn: number
  tn: number
}

/** How well the non-ML gap > 10 dB rule matches the labelled NLOS condition. */
export function nlosConfusion(verdicts: Verdict[], labels: Label[]): NlosConfusion {
  const c = { tp: 0, fp: 0, fn: 0, tn: 0 }
  for (const v of verdicts) {
    if (v.kind !== 'valid' || !v.m?.diag) continue
    const l = labels[v.line - 1]
    if (!l) continue
    const pred = v.m.diag.rssi_dbm - v.m.diag.fp_power_dbm > NLOS_GAP_DB
    const truth = l.condition === 'nlos'
    if (pred && truth) c.tp++
    else if (pred) c.fp++
    else if (truth) c.fn++
    else c.tn++
  }
  return c
}

export interface FaultCatch {
  fault: string
  total: number
  caught: number
}

/** Labelled faults (TC10) seen so far vs. how many ingest rejected or flagged. */
export function faultCatch(verdicts: Verdict[], labels: Label[]): FaultCatch[] {
  const byLine = new Map(verdicts.map((v) => [v.line, v]))
  const flagged = (line: number, f: 'out_of_order' | 'outlier') => byLine.get(line)?.flags.includes(f) ?? false
  const out = new Map<string, FaultCatch>()
  for (const v of verdicts) {
    const l = labels[v.line - 1]
    if (!l?.fault) continue
    const row = out.get(l.fault) ?? { fault: l.fault, total: 0, caught: 0 }
    row.total++
    let caught = v.kind === 'rejected'
    // Out-of-order is a swapped pair; flagging either member counts.
    if (l.fault === 'out_of_order')
      caught = flagged(v.line, 'out_of_order') || flagged(v.line + 1, 'out_of_order') || flagged(v.line - 1, 'out_of_order')
    if (l.fault === 'spike') caught = flagged(v.line, 'outlier')
    if (caught) row.caught++
    out.set(l.fault, row)
  }
  return [...out.values()].sort((a, b) => a.fault.localeCompare(b.fault))
}
