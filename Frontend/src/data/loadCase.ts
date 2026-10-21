import type { Recording } from '@/types/messages'
import { parseGroundTruth, parseJsonl, parseLabels, parseScenario } from './parse'

/** Test cases served by the dev server from Localization/test_cases (see vite.testcases.ts). */
export async function listCases(): Promise<string[]> {
  try {
    const r = await fetch('/cases/index.json')
    if (!r.ok) return []
    return (await r.json()) as string[]
  } catch {
    return []
  }
}

async function fetchText(url: string): Promise<string | null> {
  const r = await fetch(url)
  return r.ok ? r.text() : null
}

export async function loadCase(name: string): Promise<Recording> {
  const base = `/cases/${encodeURIComponent(name)}/`
  const [m, s, l, g] = await Promise.all([
    fetchText(base + 'measurements.jsonl'),
    fetchText(base + 'scenario.json'),
    fetchText(base + 'labels.jsonl'),
    fetchText(base + 'ground_truth.csv'),
  ])
  if (m == null) throw new Error(`No measurements.jsonl for ${name}`)
  return {
    name,
    lines: parseJsonl(m),
    scenario: s ? parseScenario(s) : null,
    labels: l ? parseLabels(l) : null,
    truth: g ? parseGroundTruth(g) : null,
  }
}

/** Build a recording from user-picked files (a case folder or just measurements.jsonl). */
export async function loadFiles(files: File[]): Promise<Recording> {
  const byName = new Map(files.map((f) => [f.name, f]))
  const m = byName.get('measurements.jsonl') ?? files.find((f) => f.name.endsWith('.jsonl') && f.name !== 'labels.jsonl')
  if (!m) throw new Error('Pick a measurements.jsonl file (or a whole case folder).')
  const read = (n: string) => byName.get(n)?.text() ?? Promise.resolve(null)
  const [s, l, g] = await Promise.all([read('scenario.json'), read('labels.jsonl'), read('ground_truth.csv')])
  const folder = (m as File & { webkitRelativePath?: string }).webkitRelativePath?.split('/')[0]
  const scenario = s ? parseScenario(s) : null
  return {
    name: scenario?.case ?? folder ?? m.name,
    lines: parseJsonl(await m.text()),
    scenario,
    labels: l ? parseLabels(l) : null,
    truth: g ? parseGroundTruth(g) : null,
  }
}
