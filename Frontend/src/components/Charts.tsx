import { useMemo } from 'react'
import type uPlot from 'uplot'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { NLOS_GAP_DB, NLOS_GAP_UNCERTAIN_DB } from '@/engine/config'
import { truthDistance } from '@/engine/truth'
import { useApp } from '@/state/store'
import { guideLines } from '@/lib/uplotPlugins'
import { UChart } from './UChart'

const points = (stroke: string, size = 5): uPlot.Series['points'] => ({ show: true, size, stroke, fill: stroke, width: 0 })

function useXRange(): [number, number] {
  const session = useApp((s) => s.session)
  const frame = useApp((s) => s.frame)
  return useMemo(() => {
    if (!session) return [0, 30]
    if (session.durationUs) return [0, session.durationUs / 1e6]
    const t = session.tUs / 1e6
    return [Math.max(0, t - 30), Math.max(30, t)]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, session?.durationUs, session?.kind === 'live' ? Math.floor(frame / 30) : 0])
}

export function RangeChart() {
  const session = useApp((s) => s.session)
  const frame = useApp((s) => s.frame)
  const link = useApp((s) => s.selectedLink)
  const showTruth = useApp((s) => s.showTruth)
  const xRange = useXRange()
  const gt = session?.recording?.truth
  const withTruth = showTruth && !!gt

  const data = useMemo<uPlot.AlignedData>(() => {
    const h = link ? session?.pipeline.history.get(link) : undefined
    if (!h) return [[], [], [], []]
    const [a, b] = link!.split('-')
    const truth = withTruth ? h.t.map((t) => truthDistance(gt!, a, b, t * 1e6)) : h.t.map(() => null)
    return [h.t.slice(), h.range.slice(), h.outlier.slice(), truth]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, frame, link, withTruth])

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Range · {link ?? 'no link'}</CardTitle>
        <CardDescription>Measured range (m) per DS-TWR exchange. Spikes flagged by ingest are drawn separately.</CardDescription>
      </CardHeader>
      <CardContent>
        <UChart
          data={data}
          xRange={xRange}
          deps={[link, withTruth]}
          options={(c) => ({
            series: [
              { label: 't (s)', value: (_u, v) => (v == null ? '—' : v.toFixed(2)) },
              { label: 'Measured', stroke: c.series1, width: 2, points: { show: false }, spanGaps: false, value: (_u, v) => (v == null ? '—' : `${v.toFixed(3)} m`) },
              { label: 'Spike (ignored)', stroke: c.critical, width: 0, points: points(c.critical, 8), value: (_u, v) => (v == null ? '—' : `${v.toFixed(2)} m`) },
              { label: 'True distance', stroke: c.muted, width: 1.5, dash: [4, 4], points: { show: false }, show: withTruth, value: (_u, v) => (v == null ? '—' : `${v.toFixed(3)} m`) },
            ],
            axes: [{}, { label: 'm', size: 44 }],
          })}
        />
      </CardContent>
    </Card>
  )
}

export function GapChart() {
  const session = useApp((s) => s.session)
  const frame = useApp((s) => s.frame)
  const link = useApp((s) => s.selectedLink)
  const showTruth = useApp((s) => s.showTruth)
  const xRange = useXRange()
  const labels = session?.recording?.labels
  const withLabels = showTruth && !!labels

  const data = useMemo<uPlot.AlignedData>(() => {
    const h = link ? session?.pipeline.history.get(link) : undefined
    if (!h) return [[], [], []]
    if (!withLabels) return [h.t.slice(), h.gap.slice(), h.t.map(() => null)]
    const los = h.gap.map((g, i) => (labels![h.line[i] - 1]?.condition === 'nlos' ? null : g))
    const nlos = h.gap.map((g, i) => (labels![h.line[i] - 1]?.condition === 'nlos' ? g : null))
    return [h.t.slice(), los, nlos]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, frame, link, withLabels])

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>RSSI − first-path gap · {link ?? 'no link'}</CardTitle>
        <CardDescription>
          Non-ML NLOS cue: under {NLOS_GAP_UNCERTAIN_DB} dB is LOS, over {NLOS_GAP_DB} dB is NLOS.
          {withLabels && ' Points split by the true (labelled) condition.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <UChart
          data={data}
          xRange={xRange}
          deps={[link, withLabels]}
          options={(c) => ({
            series: [
              { label: 't (s)', value: (_u, v) => (v == null ? '—' : v.toFixed(2)) },
              { label: withLabels ? 'Labelled LOS' : 'Gap', stroke: c.series1, width: 0, points: points(c.series1, 4), value: (_u, v) => (v == null ? '—' : `${v.toFixed(1)} dB`) },
              { label: 'Labelled NLOS', stroke: c.series2, width: 0, points: points(c.series2, 4), show: withLabels, value: (_u, v) => (v == null ? '—' : `${v.toFixed(1)} dB`) },
            ],
            scales: { y: { range: (_u, lo, hi) => [Math.min(0, lo), Math.max(16, hi)] } },
            axes: [{}, { label: 'dB', size: 44 }],
            plugins: [
              guideLines([
                { y: NLOS_GAP_UNCERTAIN_DB, color: c.warning, label: `${NLOS_GAP_UNCERTAIN_DB} dB` },
                { y: NLOS_GAP_DB, color: c.critical, label: `${NLOS_GAP_DB} dB` },
              ]),
            ],
          })}
        />
      </CardContent>
    </Card>
  )
}

export function ErrorChart() {
  const session = useApp((s) => s.session)
  const frame = useApp((s) => s.frame)
  const xRange = useXRange()
  const scorer = session?.scorer

  const data = useMemo<uPlot.AlignedData>(() => {
    if (!scorer) return [[], [], []]
    const e = scorer.errors
    return [e.map((p) => p.t), e.map((p) => p.fixed), e.map((p) => p.shape)]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, frame])

  if (!scorer) return null
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Position error vs ground truth</CardTitle>
        <CardDescription>
          Fixed frame: aligned once, so drift and unobservable group motion show up. Shape: re-aligned every step.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <UChart
          data={data}
          xRange={xRange}
          options={(c) => ({
            series: [
              { label: 't (s)', value: (_u, v) => (v == null ? '—' : v.toFixed(2)) },
              { label: 'Fixed-frame RMS', stroke: c.series1, width: 2, points: { show: false }, value: (_u, v) => (v == null ? '—' : `${(v * 100).toFixed(0)} cm`) },
              { label: 'Shape RMS', stroke: c.series2, width: 2, points: { show: false }, value: (_u, v) => (v == null ? '—' : `${(v * 100).toFixed(0)} cm`) },
            ],
            scales: { y: { range: (_u, _lo, hi) => [0, Math.max(0.3, hi * 1.1)] } },
            axes: [{}, { label: 'm', size: 44 }],
          })}
        />
      </CardContent>
    </Card>
  )
}
