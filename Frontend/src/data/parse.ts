import type { GroundTruth, Label, RawLine, Scenario } from '@/types/messages'

/** Split JSONL text into lines; bad JSON is kept (value undefined) so validation can count it. */
export function parseJsonl(text: string): RawLine[] {
  const out: RawLine[] = []
  const rows = text.split('\n')
  for (let i = 0; i < rows.length; i++) {
    const s = rows[i].trim()
    if (!s) continue
    let value: unknown
    try {
      value = JSON.parse(s)
    } catch {
      value = undefined
    }
    out.push({ line: i + 1, value })
  }
  return out
}

export function parseLabels(text: string): Label[] {
  return parseJsonl(text)
    .map((r) => r.value as Label)
    .filter((l) => l && typeof l === 'object')
}

/** Parse ground_truth.csv (t_s,node_id,x_m,y_m,z_m) into per-node arrays at a fixed rate. */
export function parseGroundTruth(text: string): GroundTruth {
  const rows = text.trim().split('\n')
  const header = rows[0].split(',').map((h) => h.trim())
  const iT = header.indexOf('t_s')
  const iN = header.indexOf('node_id')
  const iX = header.indexOf('x_m')
  const iY = header.indexOf('y_m')
  const per = new Map<string, { t: number; x: number; y: number }[]>()
  for (let k = 1; k < rows.length; k++) {
    const c = rows[k].split(',')
    if (c.length < header.length) continue
    const id = c[iN]
    if (!per.has(id)) per.set(id, [])
    per.get(id)!.push({ t: +c[iT], x: +c[iX], y: +c[iY] })
  }
  const nodes = [...per.keys()].sort()
  const first = per.get(nodes[0]) ?? []
  const dt = first.length > 1 ? first[1].t - first[0].t : 0.1
  const samples = Math.min(...nodes.map((n) => per.get(n)!.length))
  const xy: Record<string, Float64Array> = {}
  for (const n of nodes) {
    const arr = new Float64Array(samples * 2)
    per.get(n)!.slice(0, samples).forEach((p, i) => {
      arr[2 * i] = p.x
      arr[2 * i + 1] = p.y
    })
    xy[n] = arr
  }
  return { dt_s: dt, nodes, xy, samples }
}

export function parseScenario(text: string): Scenario {
  return JSON.parse(text) as Scenario
}
