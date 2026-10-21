// Tiny dense linear algebra for n <= ~10 (5 nodes). No dependencies on purpose:
// this has to stay small enough to port to node hardware later.

export type Mat = number[][]
export type Vec2 = [number, number]

export const zeros = (n: number, m = n): Mat => Array.from({ length: n }, () => new Array(m).fill(0))

/** Gauss-Jordan inverse with partial pivoting. Returns null if singular. */
export function invert(a: Mat): Mat | null {
  const n = a.length
  const m = a.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))])
  for (let c = 0; c < n; c++) {
    let p = c
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r
    if (Math.abs(m[p][c]) < 1e-12) return null
    ;[m[c], m[p]] = [m[p], m[c]]
    const d = m[c][c]
    for (let k = 0; k < 2 * n; k++) m[c][k] /= d
    for (let r = 0; r < n; r++) {
      if (r === c) continue
      const f = m[r][c]
      if (f === 0) continue
      for (let k = 0; k < 2 * n; k++) m[r][k] -= f * m[c][k]
    }
  }
  return m.map((row) => row.slice(n))
}

/** Jacobi eigen-decomposition of a symmetric matrix. Eigenvalues sorted descending. */
export function eigSym(a: Mat): { values: number[]; vectors: Mat } {
  const n = a.length
  const A = a.map((r) => [...r])
  const V = zeros(n)
  for (let i = 0; i < n; i++) V[i][i] = 1
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += A[i][j] ** 2
    if (off < 1e-20) break
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(A[p][q]) < 1e-15) continue
        const theta = (A[q][q] - A[p][p]) / (2 * A[p][q])
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
        const c = 1 / Math.sqrt(t * t + 1)
        const s = t * c
        for (let k = 0; k < n; k++) {
          const akp = A[k][p]
          const akq = A[k][q]
          A[k][p] = c * akp - s * akq
          A[k][q] = s * akp + c * akq
        }
        for (let k = 0; k < n; k++) {
          const apk = A[p][k]
          const aqk = A[q][k]
          A[p][k] = c * apk - s * aqk
          A[q][k] = s * apk + c * aqk
        }
        for (let k = 0; k < n; k++) {
          const vkp = V[k][p]
          const vkq = V[k][q]
          V[k][p] = c * vkp - s * vkq
          V[k][q] = s * vkp + c * vkq
        }
      }
    }
  }
  const order = A.map((_, i) => i).sort((i, j) => A[j][j] - A[i][i])
  return {
    values: order.map((i) => A[i][i]),
    vectors: order.map((i) => V.map((row) => row[i])), // each entry is one eigenvector
  }
}

/** Eigenvalues (descending) of a symmetric 2x2 [[a, b], [b, c]]. */
export function eig2(a: number, b: number, c: number): [number, number] {
  const tr = (a + c) / 2
  const d = Math.sqrt(((a - c) / 2) ** 2 + b * b)
  return [tr + d, tr - d]
}

export interface Rigid2D {
  /** Rotation angle (rad). */
  theta: number
  /** Mirror y before rotating. */
  reflect: boolean
  tx: number
  ty: number
}

export const IDENTITY: Rigid2D = { theta: 0, reflect: false, tx: 0, ty: 0 }

export function applyRigid(T: Rigid2D, p: Vec2): Vec2 {
  const x = p[0]
  const y = T.reflect ? -p[1] : p[1]
  const c = Math.cos(T.theta)
  const s = Math.sin(T.theta)
  return [c * x - s * y + T.tx, s * x + c * y + T.ty]
}

/** Rotate a covariance [xx, xy, yy] by the rigid transform. */
export function applyRigidCov(T: Rigid2D, cov: [number, number, number]): [number, number, number] {
  let [xx, xy, yy] = cov
  if (T.reflect) xy = -xy
  const c = Math.cos(T.theta)
  const s = Math.sin(T.theta)
  return [
    c * c * xx - 2 * c * s * xy + s * s * yy,
    c * s * (xx - yy) + (c * c - s * s) * xy,
    s * s * xx + 2 * c * s * xy + c * c * yy,
  ]
}

/**
 * Least-squares rigid transform mapping src onto dst (2D Procrustes / Kabsch).
 * With allowReflection, also tries the mirrored solution and keeps the better one.
 */
export function procrustes(
  src: Vec2[],
  dst: Vec2[],
  allowReflection: boolean,
  weights?: number[],
): { T: Rigid2D; rms: number } {
  const n = src.length
  const w = weights ?? new Array(n).fill(1)
  if (n === 0) return { T: IDENTITY, rms: 0 }
  const solve = (reflect: boolean) => {
    const P = src.map(([x, y]) => [x, reflect ? -y : y] as Vec2)
    const pc = wmean(P, w)
    const qc = wmean(dst, w)
    let sc = 0
    let ss = 0
    for (let i = 0; i < n; i++) {
      const px = P[i][0] - pc[0]
      const py = P[i][1] - pc[1]
      const qx = dst[i][0] - qc[0]
      const qy = dst[i][1] - qc[1]
      sc += w[i] * (px * qx + py * qy)
      ss += w[i] * (px * qy - py * qx)
    }
    const theta = n > 1 ? Math.atan2(ss, sc) : 0
    const c = Math.cos(theta)
    const s = Math.sin(theta)
    const T: Rigid2D = { theta, reflect, tx: qc[0] - (c * pc[0] - s * pc[1]), ty: qc[1] - (s * pc[0] + c * pc[1]) }
    let e = 0
    for (let i = 0; i < n; i++) {
      const p = applyRigid(T, src[i])
      e += (p[0] - dst[i][0]) ** 2 + (p[1] - dst[i][1]) ** 2
    }
    return { T, rms: Math.sqrt(e / n) }
  }
  const a = solve(false)
  if (!allowReflection) return a
  const b = solve(true)
  return b.rms < a.rms ? b : a
}

function wmean(ps: Vec2[], w: number[]): Vec2 {
  let x = 0
  let y = 0
  let s = 0
  ps.forEach((p, i) => {
    x += w[i] * p[0]
    y += w[i] * p[1]
    s += w[i]
  })
  return [x / s, y / s]
}

export function mean(ps: Vec2[]): Vec2 {
  let x = 0
  let y = 0
  for (const p of ps) {
    x += p[0]
    y += p[1]
  }
  return [x / ps.length, y / ps.length]
}

export function median(xs: number[]): number {
  if (xs.length === 0) return NaN
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
