/** Read the data-viz CSS tokens (they change with light/dark). */
export function vizColors(el: Element) {
  const cs = getComputedStyle(el)
  const v = (n: string) => cs.getPropertyValue(n).trim()
  return {
    series1: v('--viz-series-1'),
    series2: v('--viz-series-2'),
    good: v('--viz-good'),
    warning: v('--viz-warning'),
    critical: v('--viz-critical'),
    grid: v('--viz-grid'),
    axis: v('--viz-axis'),
    node: v('--viz-node'),
    surface: v('--viz-surface'),
    text: v('--foreground'),
    muted: v('--muted-foreground'),
    border: v('--border'),
  }
}
export type VizColors = ReturnType<typeof vizColors>

export const fmt = (v: number | null | undefined, digits = 2, unit = '') =>
  v == null || !Number.isFinite(v) ? '—' : `${v.toFixed(digits)}${unit}`

export const fmtTime = (us: number) => {
  const s = us / 1e6
  const m = Math.floor(s / 60)
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`
}
