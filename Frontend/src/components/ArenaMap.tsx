import { useEffect, useMemo, useRef, useState } from 'react'
import { eig2, type Vec2 } from '@/engine/linalg'
import type { LinkState } from '@/engine/pipeline'
import { fmt, vizColors, type VizColors } from '@/lib/theme'
import { useApp } from '@/state/store'
import { buildMapModel, type MapModel, type MapNode } from './mapModel'

interface View {
  scale: number
  ox: number
  oy: number
  toPx: (p: Vec2) => Vec2
}

function makeView(m: MapModel, w: number, h: number): View {
  const { x0, x1, y0, y1 } = m.bounds
  const scale = Math.min(w / (x1 - x0), h / (y1 - y0))
  const ox = (w - scale * (x1 - x0)) / 2 - scale * x0
  const oy = (h - scale * (y1 - y0)) / 2 + scale * y1
  return { scale, ox, oy, toPx: (p) => [ox + scale * p[0], oy - scale * p[1]] }
}

function linkColor(l: LinkState, c: VizColors) {
  if (l.status !== 'up') return c.axis
  if (l.nlos === 'nlos') return c.critical
  if (l.nlos === 'uncertain') return c.warning
  return c.good
}

function draw(ctx: CanvasRenderingContext2D, m: MapModel, v: View, c: VizColors, selected: string | null, hover: string | null) {
  const { toPx, scale } = v
  const W = ctx.canvas.width
  const H = ctx.canvas.height
  ctx.clearRect(0, 0, W, H)

  // 1 m grid
  ctx.lineWidth = 1
  ctx.strokeStyle = c.grid
  ctx.beginPath()
  for (let x = Math.ceil(m.bounds.x0); x <= m.bounds.x1; x++) {
    const [px] = toPx([x, 0])
    ctx.moveTo(px, 0)
    ctx.lineTo(px, H)
  }
  for (let y = Math.ceil(m.bounds.y0); y <= m.bounds.y1; y++) {
    const [, py] = toPx([0, y])
    ctx.moveTo(0, py)
    ctx.lineTo(W, py)
  }
  ctx.stroke()

  ctx.font = "12px Geist Variable, sans-serif"
  ctx.fillStyle = c.muted
  if (m.arena) {
    const [ax, ay] = toPx([0, m.arena[1]])
    const [bx, by] = toPx([m.arena[0], 0])
    ctx.strokeStyle = c.axis
    ctx.lineWidth = 1.5
    ctx.strokeRect(ax, ay, bx - ax, by - ay)
    ctx.fillText(`${m.arena[0]} × ${m.arena[1]} m arena`, ax + 4, ay - 6)
  } else {
    ctx.fillText('Relative frame (gauge: first solution) · grid 1 m', 8, 16)
  }

  // Obstacles
  for (const { o, person } of m.obstacles) {
    ctx.strokeStyle = c.muted
    ctx.fillStyle = c.muted
    ctx.globalAlpha = 0.5
    if (o.shape === 'segment' && o.p1_m && o.p2_m) {
      const a = toPx(o.p1_m)
      const b = toPx(o.p2_m)
      ctx.lineWidth = 6
      ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.moveTo(a[0], a[1])
      ctx.lineTo(b[0], b[1])
      ctx.stroke()
    } else if (o.shape === 'circle') {
      const centre = person ?? o.centre_m
      if (centre) {
        const p = toPx(centre)
        ctx.beginPath()
        ctx.arc(p[0], p[1], (o.radius_m ?? 0.3) * scale, 0, Math.PI * 2)
        ctx.fill()
      }
    }
    ctx.globalAlpha = 1
    const at = o.p1_m ?? person ?? o.centre_m
    if (at) {
      const p = toPx(at)
      ctx.fillStyle = c.muted
      ctx.fillText(o.name.replace('_', ' '), p[0] + 8, p[1] - 8)
    }
  }

  // Ground-truth trails (dashed)
  if (m.truthTrails) {
    ctx.setLineDash([3, 4])
    ctx.lineWidth = 1
    ctx.strokeStyle = c.muted
    for (const pts of Object.values(m.truthTrails)) polyline(ctx, pts.map(toPx))
    ctx.setLineDash([])
  }

  // Estimate trails
  ctx.lineWidth = 2
  ctx.strokeStyle = c.series1
  ctx.globalAlpha = 0.35
  for (const pts of Object.values(m.trails)) polyline(ctx, pts.map(toPx))
  ctx.globalAlpha = 1

  // Links
  for (const { link, a, b } of m.links) {
    const pa = toPx(a)
    const pb = toPx(b)
    const sel = link.key === selected || link.key === hover
    ctx.strokeStyle = linkColor(link, c)
    ctx.lineWidth = sel ? 4 : 2
    ctx.globalAlpha = link.status === 'up' ? 0.35 + 0.65 * (link.quality ?? 0.5) : 0.6
    ctx.setLineDash(link.status === 'up' ? [] : [5, 5])
    ctx.beginPath()
    ctx.moveTo(pa[0], pa[1])
    ctx.lineTo(pb[0], pb[1])
    ctx.stroke()
    ctx.setLineDash([])
    ctx.globalAlpha = 1
    if (sel) {
      // Label off to the side of the link so it doesn't sit on node labels.
      const len = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]) || 1
      const nx = -(pb[1] - pa[1]) / len
      const ny = (pb[0] - pa[0]) / len
      const flip = ny > 0 ? -1 : 1
      const mid: Vec2 = [(pa[0] + pb[0]) / 2 + flip * nx * 16, (pa[1] + pb[1]) / 2 + flip * ny * 16]
      label(ctx, `${link.key} ${fmt(link.range, 2, ' m')}`, mid, c)
    }
  }

  // Truth ghosts and error vectors
  if (m.truth) {
    for (const n of m.nodes) {
      const t = m.truth[n.id]
      if (!t) continue
      const pt = toPx(t)
      const pn = toPx(n.p)
      ctx.strokeStyle = c.muted
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(pn[0], pn[1])
      ctx.lineTo(pt[0], pt[1])
      ctx.stroke()
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.arc(pt[0], pt[1], 7, 0, Math.PI * 2)
      ctx.stroke()
    }
  }

  // Nodes: 2-sigma ellipse, marker, label
  for (const n of m.nodes) {
    const p = toPx(n.p)
    const [l1, l2] = eig2(n.cov[0], n.cov[1], n.cov[2])
    const ang = Math.atan2(l1 - n.cov[0], n.cov[1] || 1e-12)
    const r1 = Math.min(2 * Math.sqrt(Math.max(l1, 0)) * scale, 4000)
    const r2 = Math.min(2 * Math.sqrt(Math.max(l2, 0)) * scale, 4000)
    const statusColor = n.status === 'ok' ? c.series1 : n.status === 'degraded' ? c.warning : c.axis
    if (n.status !== 'lost') {
      ctx.fillStyle = statusColor
      ctx.strokeStyle = statusColor
      ctx.globalAlpha = 0.12
      ctx.beginPath()
      ctx.ellipse(p[0], p[1], Math.max(r1, 1), Math.max(r2, 1), -ang, 0, Math.PI * 2)
      ctx.fill()
      ctx.globalAlpha = 0.6
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.globalAlpha = 1
    }

    ctx.beginPath()
    ctx.arc(p[0], p[1], 9, 0, Math.PI * 2)
    ctx.fillStyle = n.status === 'lost' ? c.surface : c.node
    ctx.fill()
    ctx.lineWidth = 2.5
    ctx.strokeStyle = n.status === 'ok' ? c.surface : statusColor
    if (n.status !== 'ok') ctx.setLineDash([3, 2])
    ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = c.text
    ctx.font = "600 13px Geist Variable, sans-serif"
    ctx.fillText(n.status === 'lost' ? `${n.id} (lost, last known)` : n.id, p[0] + 12, p[1] + 4)
    ctx.font = "12px Geist Variable, sans-serif"
  }

  if (m.degenerate || m.waiting) {
    const text = m.waiting ? 'Waiting for enough ranges to estimate positions…' : 'Poor geometry: nodes nearly collinear, lateral positions unreliable'
    ctx.font = "600 13px Geist Variable, sans-serif"
    const w = ctx.measureText(text).width + 20
    ctx.fillStyle = m.waiting ? c.axis : c.warning
    ctx.globalAlpha = 0.9
    roundRect(ctx, 8, H / devicePixelRatio - 34, w, 26)
    ctx.globalAlpha = 1
    ctx.fillStyle = m.waiting ? c.surface : '#1a1a19'
    ctx.fillText(text, 18, H / devicePixelRatio - 17)
  }
}

function polyline(ctx: CanvasRenderingContext2D, pts: Vec2[]) {
  if (pts.length < 2) return
  ctx.beginPath()
  ctx.moveTo(pts[0][0], pts[0][1])
  for (const p of pts.slice(1)) ctx.lineTo(p[0], p[1])
  ctx.stroke()
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, 6)
  ctx.fill()
}

function label(ctx: CanvasRenderingContext2D, text: string, at: Vec2, c: VizColors) {
  ctx.font = "600 13px Geist Variable, sans-serif"
  const w = ctx.measureText(text).width + 10
  ctx.fillStyle = c.surface
  ctx.globalAlpha = 0.9
  roundRect(ctx, at[0] - w / 2, at[1] - 10, w, 20)
  ctx.globalAlpha = 1
  ctx.fillStyle = c.text
  ctx.fillText(text, at[0] - w / 2 + 5, at[1] + 4)
  ctx.font = "12px Geist Variable, sans-serif"
}

function distToSegment(p: Vec2, a: Vec2, b: Vec2) {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const L = dx * dx + dy * dy || 1
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L))
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
}

type Hit = { kind: 'node'; node: MapNode } | { kind: 'link'; link: LinkState } | null

export function ArenaMap() {
  const session = useApp((s) => s.session)
  const frame = useApp((s) => s.frame)
  const frameMode = useApp((s) => s.frameMode)
  const showTruth = useApp((s) => s.showTruth)
  const theme = useApp((s) => s.theme)
  const selected = useApp((s) => s.selectedLink)
  const setSel = useApp((s) => s.set)
  const wrap = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ w: 600, h: 600 })
  const [mouse, setMouse] = useState<Vec2 | null>(null)

  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const model = useMemo(() => (session ? buildMapModel(session, frameMode, showTruth) : null), [session, frame, frameMode, showTruth])
  const view = useMemo(() => (model ? makeView(model, size.w, size.h) : null), [model, size])

  const hit: Hit = useMemo(() => {
    if (!model || !view || !mouse) return null
    for (const n of model.nodes) {
      const p = view.toPx(n.p)
      if (Math.hypot(p[0] - mouse[0], p[1] - mouse[1]) < 14) return { kind: 'node', node: n }
    }
    let best: { d: number; link: LinkState } | null = null
    for (const l of model.links) {
      const d = distToSegment(mouse, view.toPx(l.a), view.toPx(l.b))
      if (d < 10 && (!best || d < best.d)) best = { d, link: l.link }
    }
    return best ? { kind: 'link', link: best.link } : null
  }, [model, view, mouse])

  useEffect(() => {
    const cv = canvas.current
    if (!cv || !model || !view) return
    const dpr = window.devicePixelRatio || 1
    cv.width = Math.round(size.w * dpr)
    cv.height = Math.round(size.h * dpr)
    const ctx = cv.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    draw(ctx, model, view, vizColors(cv), selected, hit?.kind === 'link' ? hit.link.key : null)
  }, [model, view, size, selected, hit, theme])

  return (
    <div ref={wrap} className="relative h-full min-h-[320px] w-full">
      <canvas
        ref={canvas}
        className="absolute inset-0 h-full w-full"
        style={{ cursor: hit ? 'pointer' : 'default' }}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          setMouse([e.clientX - r.left, e.clientY - r.top])
        }}
        onMouseLeave={() => setMouse(null)}
        onClick={() => {
          if (hit?.kind === 'link') setSel('selectedLink', hit.link.key)
        }}
        role="img"
        aria-label="Map of estimated node positions and ranging links"
      />
      {hit && mouse && (
        <div
          className="pointer-events-none absolute z-10 rounded-md border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md"
          style={{ left: Math.min(mouse[0] + 14, size.w - 190), top: mouse[1] + 14 }}
        >
          {hit.kind === 'node' ? (
            <div className="space-y-0.5">
              <div className="font-semibold">{hit.node.id}</div>
              <div>Estimate: {hit.node.status} · {hit.node.links} ranges</div>
              <div>Health: {hit.node.health}</div>
              <div>1σ: {fmt(Math.sqrt(Math.max(eig2(...hit.node.cov)[0], 0)) * 100, 0, ' cm')}</div>
              {hit.node.error != null && <div>Error vs truth: {fmt(hit.node.error * 100, 0, ' cm')}</div>}
            </div>
          ) : (
            <div className="space-y-0.5">
              <div className="font-semibold">{hit.link.key}</div>
              <div>Range: {fmt(hit.link.range, 3, ' m')} · {hit.link.status}</div>
              <div>RSSI−FP gap: {fmt(hit.link.gap, 1, ' dB')} ({hit.link.nlos})</div>
              <div>Drop: {fmt(hit.link.dropPct, 0, '%')} · {fmt(hit.link.rateHz, 1, ' Hz')}</div>
              <div className="text-muted-foreground">Click to chart this link</div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
