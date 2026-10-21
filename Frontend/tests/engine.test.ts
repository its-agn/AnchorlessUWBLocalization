import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseGroundTruth, parseJsonl, parseLabels, parseScenario } from '@/data/parse'
import { ReplaySession } from '@/engine/session'
import { faultCatch, nlosConfusion } from '@/engine/scoring'
import type { Recording } from '@/types/messages'

const ROOT = path.resolve(import.meta.dirname, '../../Localization/test_cases')
const CASES = fs.readdirSync(ROOT).filter((d) => d.startsWith('TC')).sort()

function load(name: string): Recording {
  const f = (n: string) => fs.readFileSync(path.join(ROOT, name, n), 'utf8')
  return {
    name,
    lines: parseJsonl(f('measurements.jsonl')),
    scenario: parseScenario(f('scenario.json')),
    labels: parseLabels(f('labels.jsonl')),
    truth: parseGroundTruth(f('ground_truth.csv')),
  }
}

function runAll(name: string, nlosWeighting = true) {
  const rec = load(name)
  const s = new ReplaySession(rec, { nlosWeighting })
  s.runUntil(s.durationUs)
  return { rec, s }
}

describe('parsing', () => {
  it.each(CASES)('%s parses every line and labels line up', (name) => {
    const rec = load(name)
    expect(rec.lines.length).toBeGreaterThan(1000)
    expect(rec.labels!.length).toBe(rec.lines.length)
    expect(rec.truth!.nodes).toEqual(['N1', 'N2', 'N3', 'N4', 'N5'])
  })
})

describe('replay', () => {
  it.each(CASES)('%s processes every line exactly once', (name) => {
    const { rec, s } = runAll(name)
    expect(s.pipeline.counters.lines).toBe(rec.lines.length)
    expect(s.pipeline.verdicts.map((v) => v.line)).toEqual(rec.lines.map((l) => l.line))
  })

  it('seeking backwards gives the same result as a fresh run', () => {
    const rec = load('TC04_all_moving_random')
    const a = new ReplaySession(rec, { nlosWeighting: true })
    a.runUntil(12e6)
    const b = new ReplaySession(rec, { nlosWeighting: true })
    b.runUntil(20e6)
    b.seek(12e6)
    expect(b.pipeline.counters).toEqual(a.pipeline.counters)
    expect(b.pipeline.latestEstimate()).toEqual(a.pipeline.latestEstimate())
  })
})

describe('ingest', () => {
  it('TC01 rejects nothing', () => {
    const { s } = runAll('TC01_static_baseline_los')
    expect(s.pipeline.counters.rejected).toEqual({})
    expect(s.pipeline.counters.flagged.outlier ?? 0).toBe(0)
  })

  it('TC10 catches every labelled fault', () => {
    const { rec, s } = runAll('TC10_invalid_and_outliers')
    const caught = faultCatch(s.pipeline.verdicts, rec.labels!)
    for (const row of caught) expect(row, row.fault).toMatchObject({ caught: row.total })
    // And does not reject clean data.
    const cleanRejected = s.pipeline.verdicts.filter((v) => v.kind === 'rejected' && !rec.labels![v.line - 1].fault)
    expect(cleanRejected).toEqual([])
  })

  it('TC09 sees the N4 reboot and outage', () => {
    const { s } = runAll('TC09_dropouts_and_recovery')
    expect(s.pipeline.nodeState.get('N4')!.seqResets).toBe(1)
    const kinds = s.pipeline.events.map((e) => `${e.kind}:${e.text.split(' ')[0]}`)
    expect(kinds).toContain('node_offline:N4')
    expect(kinds).toContain('node_online:N4')
    expect(s.pipeline.events.some((e) => e.kind === 'link_down' && e.text.includes('N2-N3'))).toBe(true)
  })
})

describe('NLOS cue', () => {
  it('TC08 gap rule matches labels well and flags the permanent NLOS links', () => {
    const { rec, s } = runAll('TC08_nlos_obstruction')
    const c = nlosConfusion(s.pipeline.verdicts, rec.labels!)
    expect(c.tp / (c.tp + c.fn)).toBeGreaterThan(0.9)
    expect(c.fp / (c.fp + c.tn)).toBeLessThan(0.05)
    expect(s.pipeline.links.get('N1-N2')!.nlos).toBe('nlos')
    expect(s.pipeline.links.get('N4-N5')!.nlos).toBe('nlos')
  })
})

describe('placeholder estimator', () => {
  it('TC01 recovers the static layout within 0.15 m', () => {
    const { s } = runAll('TC01_static_baseline_los')
    expect(s.scorer!.summary().shapeRun).toBeLessThan(0.15)
    expect(s.scorer!.summary().fixedNow).toBeLessThan(0.15)
  })

  it('TC07 flags degenerate geometry early, then recovers', () => {
    const { s } = runAll('TC07_collinear_degenerate')
    const at = (t: number) => s.pipeline.estimates.find((e) => e.tUs >= t * 1e6)!.est
    expect(at(5).degenerate).toBe(true)
    expect(at(20).degenerate).toBe(false)
    const late = s.scorer!.errors.filter((e) => e.t > 18)
    expect(Math.max(...late.map((e) => e.shape))).toBeLessThan(0.3)
  })

  it('TC05 shape stays right while the fixed-frame error shows the unseen group motion', () => {
    const { s } = runAll('TC05_rigid_group_motion')
    const sum = s.scorer!.summary()
    expect(sum.shapeRun).toBeLessThan(0.15)
    expect(sum.fixedNow).toBeGreaterThan(2)
  })

  it('TC08 NLOS weighting lowers position error', () => {
    const on = runAll('TC08_nlos_obstruction', true).s.scorer!.summary().shapeRun
    const off = runAll('TC08_nlos_obstruction', false).s.scorer!.summary().shapeRun
    expect(on).toBeLessThan(off)
  })

  it.each(CASES)('%s: summary', (name) => {
    const { s } = runAll(name)
    const sum = s.scorer!.summary()
    console.log(
      name.padEnd(28),
      `shape ${sum.shapeRun.toFixed(3)}  fixed ${sum.fixedRun.toFixed(3)}  locked ${sum.locked}`,
      JSON.stringify(s.pipeline.counters.rejected),
      JSON.stringify(s.pipeline.counters.flagged),
    )
    expect(Number.isFinite(sum.shapeRun)).toBe(true)
  })
})
