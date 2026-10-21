// PLACEHOLDER position estimator, so the map has estimates before the real
// Python EKF exists. Weighted SMACOF (stress majorization) on the latest ranges,
// warm-started from the previous solution. Replace by streaming estimates from the
// Python service (PipelineMessage 'estimate'); the UI does not depend on this file.
//
// Output frame: relative only (gauge freedom). It is the first solution's frame,
// carried forward by aligning each new solution to the previous one.

import { NLOS_GAP_DB, NLOS_GAP_UNCERTAIN_DB } from './config'
import { eig2, eigSym, invert, procrustes, applyRigid, zeros, type Vec2 } from './linalg'

/** Reference layout update rate per step (10 Hz): ~2 s time constant. */
const REF_ALPHA = 0.05

export interface RangeInput {
  a: string
  b: string
  d: number
  /** RSSI - first-path power gap (dB), for NLOS down-weighting. */
  gap: number
}

export interface NodeEstimate {
  x: number
  y: number
  /** Covariance [xx, xy, yy] (m^2) from range geometry. */
  cov: [number, number, number]
  status: 'ok' | 'degraded' | 'lost'
  links: number
}

export interface EstimateResult {
  nodes: Record<string, NodeEstimate>
  /** Shape is close to a line: lateral positions are unobservable. */
  degenerate: boolean
  /** sqrt(minor / major) spread of the node cloud; 0 = collinear. */
  spreadRatio: number
  /** Weighted RMS of (estimated distance - measured range), m. */
  residualRms: number
}

export interface EstimatorOptions {
  nlosWeighting: boolean
}

/** Range noise model (matches the measured LOS spread in the test data). */
export function rangeSigma(d: number, gap: number, nlosWeighting: boolean): number {
  let s = 0.05 + 0.005 * d
  if (nlosWeighting) {
    if (gap > NLOS_GAP_DB) s *= 5
    else if (gap > NLOS_GAP_UNCERTAIN_DB) s *= 2
  }
  return s
}

export class PlaceholderEstimator {
  private X = new Map<string, Vec2>()
  /** Slow-moving average of each node's position: the gauge reference. */
  private ref = new Map<string, Vec2>()
  opts: EstimatorOptions

  private readonly nodes: string[]

  constructor(nodes: string[], opts: EstimatorOptions = { nlosWeighting: true }) {
    this.nodes = nodes
    this.opts = opts
  }

  reset() {
    this.X.clear()
    this.ref.clear()
  }

  update(ranges: RangeInput[]): EstimateResult | null {
    const ids = this.nodes
    const idx = new Map(ids.map((id, i) => [id, i]))
    const n = ids.length
    const W = zeros(n)
    const D = zeros(n)
    const deg = new Array(n).fill(0)
    for (const r of ranges) {
      const i = idx.get(r.a)
      const j = idx.get(r.b)
      if (i == null || j == null) continue
      const w = 1 / rangeSigma(r.d, r.gap, this.opts.nlosWeighting) ** 2
      W[i][j] = W[j][i] = w
      D[i][j] = D[j][i] = r.d
      deg[i]++
      deg[j]++
    }

    // Solve over the largest connected component of nodes with >= 2 ranges.
    const active = largestComponent(n, W, (i) => deg[i] >= 2)
    if (active.length < 3) return this.X.size ? this.hold(ids, deg) : null

    // Initialise: classical MDS the first time, otherwise warm start
    // (new nodes start at their neighbours' weighted centre, nudged off it).
    if (this.X.size === 0) {
      const init = classicalMds(active, D, W)
      active.forEach((i, k) => this.X.set(ids[i], init[k]))
    }
    for (const i of active) {
      if (this.X.has(ids[i])) continue
      const nb = active.filter((j) => W[i][j] > 0 && this.X.has(ids[j]))
      if (nb.length === 0) continue
      const c = nb.reduce<Vec2>((s, j) => [s[0] + this.X.get(ids[j])![0], s[1] + this.X.get(ids[j])![1]], [0, 0])
      this.X.set(ids[i], [c[0] / nb.length + 0.5, c[1] / nb.length + 0.5])
    }
    const act = active.filter((i) => this.X.has(ids[i]))
    const prev = act.map((i) => this.X.get(ids[i])!)
    const next = smacof(act, prev, D, W, 40)

    // Keep the gauge still: rigidly align the new solution to a slowly updated
    // reference layout (not just the last step, which would random-walk). Iterative
    // reweighting ignores nodes that moved, so static nodes anchor the frame.
    const ref = act.map((i) => this.ref.get(ids[i]) ?? this.X.get(ids[i])!)
    let { T } = procrustes(next, ref, false)
    for (let it = 0; it < 3; it++) {
      const w = next.map((p, k) => {
        const q = applyRigid(T, p)
        return 1 / ((q[0] - ref[k][0]) ** 2 + (q[1] - ref[k][1]) ** 2 + 0.05 ** 2)
      })
      T = procrustes(next, ref, false, w).T
    }
    act.forEach((i, k) => {
      const p = applyRigid(T, next[k])
      this.X.set(ids[i], p)
      const r = this.ref.get(ids[i])
      this.ref.set(ids[i], r ? [r[0] + REF_ALPHA * (p[0] - r[0]), r[1] + REF_ALPHA * (p[1] - r[1])] : p)
    })

    return this.result(ids, act, D, W, deg)
  }

  /** No solvable graph this step: keep last positions, mark everything lost. */
  private hold(ids: string[], deg: number[]): EstimateResult {
    const nodes: Record<string, NodeEstimate> = {}
    ids.forEach((id, i) => {
      const p = this.X.get(id)
      if (p) nodes[id] = { x: p[0], y: p[1], cov: [4, 0, 4], status: 'lost', links: deg[i] }
    })
    return { nodes, degenerate: true, spreadRatio: 0, residualRms: NaN }
  }

  private result(ids: string[], act: number[], D: number[][], W: number[][], deg: number[]): EstimateResult {
    const nodes: Record<string, NodeEstimate> = {}
    const inAct = new Set(act)
    let res = 0
    let wsum = 0
    ids.forEach((id, i) => {
      const p = this.X.get(id)
      if (!p) return
      if (!inAct.has(i)) {
        nodes[id] = { x: p[0], y: p[1], cov: [4, 0, 4], status: 'lost', links: deg[i] }
        return
      }
      // Fisher information from range directions: J = sum w u u^T. cov = J^-1.
      let jxx = 0
      let jxy = 0
      let jyy = 0
      for (const j of act) {
        if (j === i || W[i][j] === 0) continue
        const q = this.X.get(ids[j])!
        const dx = p[0] - q[0]
        const dy = p[1] - q[1]
        const r = Math.hypot(dx, dy) || 1e-9
        const ux = dx / r
        const uy = dy / r
        jxx += W[i][j] * ux * ux
        jxy += W[i][j] * ux * uy
        jyy += W[i][j] * uy * uy
        if (j > i) {
          res += W[i][j] * (r - D[i][j]) ** 2
          wsum += W[i][j]
        }
      }
      const det = jxx * jyy - jxy * jxy
      const cov: [number, number, number] =
        det > 1e-9 ? [jyy / det, -jxy / det, jxx / det] : [25, 0, 25]
      const sdMax = Math.sqrt(Math.max(0, eig2(cov[0], cov[1], cov[2])[0]))
      const status = deg[i] >= 3 && sdMax < 0.5 ? 'ok' : 'degraded'
      nodes[id] = { x: p[0], y: p[1], cov, status, links: deg[i] }
    })

    // Spread of the node cloud: near-collinear layouts give a reflection ambiguity.
    const pts = act.map((i) => this.X.get(ids[i])!)
    const mx = pts.reduce((s, p) => s + p[0], 0) / pts.length
    const my = pts.reduce((s, p) => s + p[1], 0) / pts.length
    let sxx = 0
    let sxy = 0
    let syy = 0
    for (const p of pts) {
      sxx += (p[0] - mx) ** 2
      sxy += (p[0] - mx) * (p[1] - my)
      syy += (p[1] - my) ** 2
    }
    const [l1, l2] = eig2(sxx, sxy, syy)
    const spreadRatio = l1 > 0 ? Math.sqrt(Math.max(0, l2) / l1) : 0
    const degenerate = spreadRatio < 0.12
    if (degenerate) {
      for (const id of Object.keys(nodes)) if (nodes[id].status === 'ok') nodes[id].status = 'degraded'
    }
    return { nodes, degenerate, spreadRatio, residualRms: wsum > 0 ? Math.sqrt(res / wsum) : NaN }
  }
}

function largestComponent(n: number, W: number[][], ok: (i: number) => boolean): number[] {
  const seen = new Array(n).fill(false)
  let best: number[] = []
  for (let s = 0; s < n; s++) {
    if (seen[s] || !ok(s)) continue
    const comp: number[] = []
    const stack = [s]
    seen[s] = true
    while (stack.length) {
      const i = stack.pop()!
      comp.push(i)
      for (let j = 0; j < n; j++) {
        if (!seen[j] && ok(j) && W[i][j] > 0) {
          seen[j] = true
          stack.push(j)
        }
      }
    }
    if (comp.length > best.length) best = comp
  }
  return best.sort((a, b) => a - b)
}

/** Classical MDS; missing distances are filled with shortest-path sums. */
export function classicalMds(act: number[], D: number[][], W: number[][]): Vec2[] {
  const m = act.length
  const S = zeros(m)
  for (let a = 0; a < m; a++)
    for (let b = 0; b < m; b++) S[a][b] = a === b ? 0 : W[act[a]][act[b]] > 0 ? D[act[a]][act[b]] : Infinity
  for (let k = 0; k < m; k++)
    for (let a = 0; a < m; a++) for (let b = 0; b < m; b++) S[a][b] = Math.min(S[a][b], S[a][k] + S[k][b])
  const D2 = S.map((r) => r.map((v) => v * v))
  const rowMean = D2.map((r) => r.reduce((s, v) => s + v, 0) / m)
  const all = rowMean.reduce((s, v) => s + v, 0) / m
  const B = D2.map((r, a) => r.map((v, b) => -0.5 * (v - rowMean[a] - rowMean[b] + all)))
  const { values, vectors } = eigSym(B)
  const s1 = Math.sqrt(Math.max(values[0], 0))
  const s2 = Math.sqrt(Math.max(values[1], 1e-6))
  return act.map((_, k) => [vectors[0][k] * s1, vectors[1][k] * s2] as Vec2)
}

/** Weighted SMACOF iterations (Guttman transform). */
export function smacof(act: number[], X0: Vec2[], D: number[][], W: number[][], iters: number): Vec2[] {
  const m = act.length
  const V = zeros(m)
  for (let a = 0; a < m; a++)
    for (let b = 0; b < m; b++) {
      if (a === b) continue
      const w = W[act[a]][act[b]]
      V[a][b] = -w
      V[a][a] += w
    }
  // Pseudo-inverse of the (connected) Laplacian: (V + 11^T/m)^-1 - 11^T/m.
  const Vp = invert(V.map((r) => r.map((v) => v + 1 / m)))
  if (!Vp) return X0
  for (let a = 0; a < m; a++) for (let b = 0; b < m; b++) Vp[a][b] -= 1 / m

  let X = X0.map((p) => [...p] as Vec2)
  for (let it = 0; it < iters; it++) {
    const BX: Vec2[] = X.map(() => [0, 0])
    for (let a = 0; a < m; a++) {
      for (let b = 0; b < m; b++) {
        if (a === b) continue
        const w = W[act[a]][act[b]]
        if (w === 0) continue
        const dx = X[a][0] - X[b][0]
        const dy = X[a][1] - X[b][1]
        const dist = Math.hypot(dx, dy)
        if (dist < 1e-9) continue
        const f = (w * D[act[a]][act[b]]) / dist
        BX[a][0] += f * dx
        BX[a][1] += f * dy
      }
    }
    X = Vp.map((row) => {
      let x = 0
      let y = 0
      for (let b = 0; b < m; b++) {
        x += row[b] * BX[b][0]
        y += row[b] * BX[b][1]
      }
      return [x, y] as Vec2
    })
  }
  return X
}
