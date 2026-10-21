import type { GroundTruth } from '@/types/messages'
import type { Vec2 } from './linalg'

/** Linearly interpolated true position of every node at tUs. */
export function truthAt(gt: GroundTruth, tUs: number): Record<string, Vec2> {
  const f = tUs / 1e6 / gt.dt_s
  const i = Math.max(0, Math.min(gt.samples - 1, Math.floor(f)))
  const j = Math.min(gt.samples - 1, i + 1)
  const a = Math.max(0, Math.min(1, f - i))
  const out: Record<string, Vec2> = {}
  for (const n of gt.nodes) {
    const xy = gt.xy[n]
    out[n] = [xy[2 * i] + a * (xy[2 * j] - xy[2 * i]), xy[2 * i + 1] + a * (xy[2 * j + 1] - xy[2 * i + 1])]
  }
  return out
}

export function truthDistance(gt: GroundTruth, a: string, b: string, tUs: number): number | null {
  const p = truthAt(gt, tUs)
  if (!p[a] || !p[b]) return null
  return Math.hypot(p[a][0] - p[b][0], p[a][1] - p[b][1])
}
