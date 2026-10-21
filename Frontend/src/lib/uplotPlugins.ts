import type uPlot from 'uplot'

/** Dashed horizontal guide lines (e.g. NLOS thresholds), drawn under the series. */
export function guideLines(values: { y: number; color: string; label: string }[]): uPlot.Plugin {
  return {
    hooks: {
      drawAxes: [
        (u) => {
          const ctx = u.ctx
          ctx.save()
          ctx.setLineDash([4, 4])
          ctx.lineWidth = 1
          ctx.font = `${11 * devicePixelRatio}px Geist Variable, sans-serif`
          for (const g of values) {
            const y = u.valToPos(g.y, 'y', true)
            if (y < u.bbox.top || y > u.bbox.top + u.bbox.height) continue
            ctx.strokeStyle = g.color
            ctx.beginPath()
            ctx.moveTo(u.bbox.left, y)
            ctx.lineTo(u.bbox.left + u.bbox.width, y)
            ctx.stroke()
            ctx.fillStyle = g.color
            ctx.textAlign = 'right'
            ctx.fillText(g.label, u.bbox.left + u.bbox.width - 4 * devicePixelRatio, y - 4 * devicePixelRatio)
          }
          ctx.restore()
        },
      ],
    },
  }
}
