// Builds what the map draws, in display coordinates, from the session.
// Keeps frame handling (relative vs. truth-aligned) out of the drawing code.

import { applyRigid, applyRigidCov, type Vec2 } from '@/engine/linalg'
import type { LinkState } from '@/engine/pipeline'
import type { Session } from '@/engine/session'
import { truthAt } from '@/engine/truth'
import type { Obstacle } from '@/types/messages'

export interface MapNode {
  id: string
  p: Vec2
  cov: [number, number, number]
  status: 'ok' | 'degraded' | 'lost'
  links: number
  health: string
  error: number | null
}

export interface MapModel {
  frame: 'truth' | 'relative'
  bounds: { x0: number; x1: number; y0: number; y1: number }
  arena: [number, number] | null
  obstacles: { o: Obstacle; person?: Vec2 }[]
  nodes: MapNode[]
  links: { link: LinkState; a: Vec2; b: Vec2 }[]
  trails: Record<string, Vec2[]>
  truth: Record<string, Vec2> | null
  truthTrails: Record<string, Vec2[]> | null
  degenerate: boolean
  waiting: boolean
}

/** Position of a scripted moving obstacle (e.g. the walking person in TC08). */
export function obstacleAt(o: Obstacle, tS: number): Vec2 | undefined {
  if (!o.path) return undefined
  const wps = o.path.loop ? [...o.path.waypoints_m, o.path.waypoints_m[0]] : o.path.waypoints_m
  const segs = wps.slice(1).map((p, i) => ({ a: wps[i], b: p, len: Math.hypot(p[0] - wps[i][0], p[1] - wps[i][1]) }))
  const total = segs.reduce((s, g) => s + g.len, 0)
  let d = Math.max(0, tS - o.path.start_delay_s) * o.path.speed_mps
  d = o.path.loop ? d % total : Math.min(d, total)
  for (const g of segs) {
    if (d <= g.len) {
      const f = g.len ? d / g.len : 0
      return [g.a[0] + f * (g.b[0] - g.a[0]), g.a[1] + f * (g.b[1] - g.a[1])]
    }
    d -= g.len
  }
  return wps[wps.length - 1]
}

export function buildMapModel(s: Session, frameMode: 'truth' | 'relative', showTruth: boolean): MapModel {
  const p = s.pipeline
  const scen = s.recording?.scenario ?? null
  const truthFrame = frameMode === 'truth' && !!s.scorer
  const T = truthFrame ? s.scorer!.current : null
  const map = (q: Vec2): Vec2 => (T ? applyRigid(T, q) : q)

  const last = p.latestEstimate()
  const nodes: MapNode[] = []
  if (last) {
    for (const [id, n] of Object.entries(last.est.nodes)) {
      nodes.push({
        id,
        p: map([n.x, n.y]),
        cov: T ? applyRigidCov(T, n.cov) : n.cov,
        status: n.status,
        links: n.links,
        health: p.nodeState.get(id)?.status ?? 'unknown',
        error: showTruth && s.scorer ? (s.scorer.perNode[id] ?? null) : null,
      })
    }
  }
  const pos = new Map(nodes.map((n) => [n.id, n.p]))
  const links = [...p.links.values()]
    .filter((l) => pos.has(l.a) && pos.has(l.b))
    .map((link) => ({ link, a: pos.get(link.a)!, b: pos.get(link.b)! }))

  const trails: Record<string, Vec2[]> = {}
  for (const [id, pts] of Object.entries(p.trails())) trails[id] = pts.map(map)

  let truth: Record<string, Vec2> | null = null
  let truthTrails: Record<string, Vec2[]> | null = null
  const gt = s.recording?.truth
  if (showTruth && gt && truthFrame) {
    truth = truthAt(gt, s.tUs)
    truthTrails = {}
    for (const id of gt.nodes) {
      const pts: Vec2[] = []
      for (let t = Math.max(0, s.tUs - 5e6); t <= s.tUs; t += 200_000) pts.push(truthAt(gt, t)[id])
      truthTrails[id] = pts
    }
  }

  const obstacles = truthFrame && scen
    ? scen.obstacles
        .filter((o) => !o.path || showTruth)
        .map((o) => ({ o, person: obstacleAt(o, s.tUs / 1e6) }))
    : []

  // Bounds: the arena in the truth frame (grown to fit strays), otherwise fit the nodes.
  const pts: Vec2[] = [...nodes.map((n) => n.p), ...Object.values(truth ?? {})]
  let bounds
  if (truthFrame && scen) {
    const [w, h] = scen.arena_m
    const lim = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
    const xs = pts.map((q) => lim(q[0], -5, w + 5))
    const ys = pts.map((q) => lim(q[1], -5, h + 5))
    bounds = {
      x0: Math.min(0, ...xs) - 0.6,
      x1: Math.max(w, ...xs) + 0.6,
      y0: Math.min(0, ...ys) - 0.6,
      y1: Math.max(h, ...ys) + 0.6,
    }
  } else if (pts.length) {
    const xs = pts.map((q) => q[0])
    const ys = pts.map((q) => q[1])
    bounds = { x0: Math.min(...xs) - 1.5, x1: Math.max(...xs) + 1.5, y0: Math.min(...ys) - 1.5, y1: Math.max(...ys) + 1.5 }
  } else bounds = { x0: -1, x1: 11, y0: -1, y1: 11 }

  return {
    frame: truthFrame ? 'truth' : 'relative',
    bounds,
    arena: truthFrame && scen ? scen.arena_m : null,
    obstacles,
    nodes,
    links,
    trails,
    truth,
    truthTrails,
    degenerate: !!last?.est.degenerate,
    waiting: !last,
  }
}
