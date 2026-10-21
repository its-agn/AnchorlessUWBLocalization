import { useEffect, useRef } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { vizColors, type VizColors } from '@/lib/theme'
import { useApp } from '@/state/store'

export interface UChartProps {
  data: uPlot.AlignedData
  /** Builds series/axes/hooks; re-run when the theme or `deps` change. */
  options: (c: VizColors) => Omit<uPlot.Options, 'width' | 'height'>
  height?: number
  /** x-axis range (seconds), fixed so the chart doesn't rescale while playing. */
  xRange: [number, number]
  deps?: unknown[]
}

/** Thin React wrapper: creates uPlot once per option set, then only pushes new data. */
export function UChart({ data, options, height = 150, xRange, deps = [] }: UChartProps) {
  const el = useRef<HTMLDivElement>(null)
  const plot = useRef<uPlot | null>(null)
  const theme = useApp((s) => s.theme)

  useEffect(() => {
    const host = el.current
    if (!host) return
    const c = vizColors(host)
    const base = options(c)
    const axis = (a: uPlot.Axis = {}): uPlot.Axis => ({
      stroke: c.muted,
      grid: { stroke: c.grid, width: 1 },
      ticks: { stroke: c.grid, width: 1 },
      font: '11px Geist Variable, sans-serif',
      ...a,
    })
    const u = new uPlot(
      {
        ...base,
        width: host.clientWidth || 400,
        height,
        scales: { ...base.scales, x: { time: false, range: () => xRange } },
        axes: (base.axes ?? [{}, {}]).map(axis),
        cursor: { drag: { x: false, y: false }, ...base.cursor },
      },
      data,
      host,
    )
    plot.current = u
    const ro = new ResizeObserver(() => u.setSize({ width: host.clientWidth, height }))
    ro.observe(host)
    return () => {
      ro.disconnect()
      u.destroy()
      plot.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme, height, xRange[0], xRange[1], ...deps])

  useEffect(() => {
    plot.current?.setData(data, true)
  }, [data])

  return <div ref={el} className="w-full" />
}
