import { fmt } from '@/lib/theme'
import { useApp } from '@/state/store'
import { StatusPill } from './Panels'

/** Headline numbers: one tile each, status shown with icon + text. */
export function SummaryStrip() {
  const session = useApp((s) => s.session)
  useApp((s) => s.frame)
  const showTruth = useApp((s) => s.showTruth)
  if (!session) return null
  const p = session.pipeline
  const nodes = [...p.nodeState.values()]
  const links = [...p.links.values()]
  const online = nodes.filter((n) => n.status === 'online').length
  const up = links.filter((l) => l.status === 'up').length
  const nlos = links.filter((l) => l.status === 'up' && l.nlos === 'nlos').length
  const rejected = Object.values(p.counters.rejected).reduce((s, v) => s + (v ?? 0), 0)
  const est = p.latestEstimate()?.est
  const sum = showTruth ? session.scorer?.summary() : undefined
  const tone = (ok: boolean, bad: boolean) => (bad ? 'critical' : ok ? 'good' : 'warning') as 'good' | 'warning' | 'critical'

  const tiles: { label: string; value: string; pill?: React.ReactNode }[] = [
    {
      label: 'Nodes online',
      value: `${online} / ${nodes.length}`,
      pill: <StatusPill tone={tone(online === nodes.length, online < 3)}>{online === nodes.length ? 'All reporting' : 'Missing nodes'}</StatusPill>,
    },
    {
      label: 'Links up',
      value: `${up} / ${links.length}`,
      pill:
        up === 0 ? (
          <StatusPill tone="muted">No data yet</StatusPill>
        ) : (
          <StatusPill tone={nlos ? 'warning' : 'good'}>{nlos ? `${nlos} NLOS` : 'No NLOS'}</StatusPill>
        ),
    },
    {
      label: 'Geometry',
      value: est ? (est.degenerate ? 'Poor' : 'Good') : '—',
      pill: est ? (
        <StatusPill tone={est.degenerate ? 'warning' : 'good'}>spread {fmt(est.spreadRatio, 2)}</StatusPill>
      ) : (
        <StatusPill tone="muted">waiting</StatusPill>
      ),
    },
    {
      label: 'Fit residual',
      value: est ? fmt(est.residualRms * 100, 1, ' cm') : '—',
      pill: <span className="text-muted-foreground">range vs estimate</span>,
    },
    {
      label: 'Rejected records',
      value: String(rejected),
      pill: <StatusPill tone={rejected ? 'warning' : 'good'}>{rejected ? 'See Events' : 'Clean'}</StatusPill>,
    },
  ]
  if (sum)
    tiles.push({
      label: 'Error vs truth',
      value: fmt(sum.fixedNow * 100, 0, ' cm'),
      pill: <span className="text-muted-foreground">shape {fmt(sum.shapeNow * 100, 0, ' cm')}</span>,
    })

  return (
    <div className="grid grid-cols-2 gap-2 px-4 pt-3 sm:grid-cols-3 lg:grid-cols-6">
      {tiles.map((t) => (
        <div key={t.label} className="rounded-xl bg-card px-3 py-2 ring-1 ring-foreground/10">
          <div className="text-xs text-muted-foreground">{t.label}</div>
          <div className="text-lg font-semibold tabular-nums">{t.value}</div>
          <div className="text-xs">{t.pill}</div>
        </div>
      ))}
    </div>
  )
}
