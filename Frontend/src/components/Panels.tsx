import { AlertTriangle, CheckCircle2, CircleSlash, Info, XCircle } from 'lucide-react'
import { useMemo } from 'react'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { eig2 } from '@/engine/linalg'
import type { LinkState, NodeState, Severity } from '@/engine/pipeline'
import { faultCatch, nlosConfusion } from '@/engine/scoring'
import { cn } from '@/lib/utils'
import { fmt, fmtTime } from '@/lib/theme'
import { useApp } from '@/state/store'

/** Status pill: icon + text + color, never color alone. */
export function StatusPill({ tone, children }: { tone: 'good' | 'warning' | 'critical' | 'muted'; children: React.ReactNode }) {
  const Icon = { good: CheckCircle2, warning: AlertTriangle, critical: XCircle, muted: CircleSlash }[tone]
  const color = {
    good: 'text-(--viz-good)',
    warning: 'text-(--viz-warning)',
    critical: 'text-(--viz-critical)',
    muted: 'text-muted-foreground',
  }[tone]
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      <Icon className={cn('size-3.5 shrink-0', color)} aria-hidden />
      <span>{children}</span>
    </span>
  )
}

function linkTone(l: LinkState) {
  if (l.status === 'down') return { tone: 'critical' as const, text: 'Down' }
  if (l.status === 'unknown') return { tone: 'muted' as const, text: 'No data' }
  if (l.nlos === 'nlos') return { tone: 'critical' as const, text: 'NLOS' }
  if (l.nlos === 'uncertain') return { tone: 'warning' as const, text: 'Uncertain' }
  return { tone: 'good' as const, text: 'LOS' }
}

export function LinkTable() {
  const session = useApp((s) => s.session)
  useApp((s) => s.frame)
  const selected = useApp((s) => s.selectedLink)
  const set = useApp((s) => s.set)
  const showTruth = useApp((s) => s.showTruth)
  if (!session) return null
  const links = [...session.pipeline.links.values()]
  const labels = session.recording?.labels
  const conf = showTruth && labels ? nlosConfusion(session.pipeline.verdicts, labels) : null

  return (
    <div className="space-y-3">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Link</TableHead>
            <TableHead>State</TableHead>
            <TableHead className="text-right">Range</TableHead>
            <TableHead className="text-right">Gap</TableHead>
            <TableHead className="text-right">Quality</TableHead>
            <TableHead className="text-right">Drop</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {links.map((l) => {
            const s = linkTone(l)
            return (
              <TableRow
                key={l.key}
                data-state={l.key === selected ? 'selected' : undefined}
                className={cn('cursor-pointer', l.status === 'down' && 'text-muted-foreground')}
                title={l.status === 'down' ? 'Values are the last valid range before the link went down' : undefined}
                onClick={() => set('selectedLink', l.key)}
              >
                <TableCell className="font-medium">{l.key}</TableCell>
                <TableCell>
                  <StatusPill tone={s.tone}>{s.text}</StatusPill>
                </TableCell>
                <TableCell className="text-right tabular-nums">{fmt(l.range, 3)}</TableCell>
                <TableCell className="text-right tabular-nums">{fmt(l.gap, 1)}</TableCell>
                <TableCell className="text-right tabular-nums">{fmt(l.quality, 2)}</TableCell>
                <TableCell className="text-right tabular-nums">{fmt(l.dropPct, 0, '%')}</TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
      <p className="px-2 text-xs text-muted-foreground">
        Range in m, gap = RSSI − first-path power in dB, drop = failed attempts over the last 2 s. Click a row to chart it.
      </p>
      {conf && conf.tp + conf.fn > 0 && (
        <div className="rounded-lg border px-3 py-2 text-xs">
          <div className="mb-1 font-medium">NLOS rule vs labels (scoring only)</div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 tabular-nums text-muted-foreground">
            <span>Detected NLOS: {conf.tp} / {conf.tp + conf.fn} ({fmt((100 * conf.tp) / (conf.tp + conf.fn), 0, '%')})</span>
            <span>False alarms: {conf.fp} / {conf.fp + conf.tn}</span>
          </div>
        </div>
      )}
    </div>
  )
}

function nodeTone(n: NodeState) {
  if (n.status === 'online') return 'good' as const
  if (n.status === 'stale') return 'warning' as const
  if (n.status === 'offline') return 'critical' as const
  return 'muted' as const
}

export function NodeTable() {
  const session = useApp((s) => s.session)
  useApp((s) => s.frame)
  const showTruth = useApp((s) => s.showTruth)
  if (!session) return null
  const est = session.pipeline.latestEstimate()?.est
  const scorer = showTruth ? session.scorer : null
  const sum = scorer?.summary()

  return (
    <div className="space-y-3">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Node</TableHead>
            <TableHead>Health</TableHead>
            <TableHead>Estimate</TableHead>
            <TableHead className="text-right">1σ</TableHead>
            <TableHead className="text-right">Ranges/s</TableHead>
            <TableHead className="text-right">Seq</TableHead>
            {scorer && <TableHead className="text-right">Error</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {[...session.pipeline.nodeState.values()].map((n) => {
            const e = est?.nodes[n.id]
            const sd = e ? Math.sqrt(Math.max(eig2(...e.cov)[0], 0)) : null
            return (
              <TableRow key={n.id}>
                <TableCell className="font-medium">{n.id}</TableCell>
                <TableCell>
                  <StatusPill tone={nodeTone(n)}>{n.status === 'unknown' ? 'No data' : n.status}</StatusPill>
                </TableCell>
                <TableCell>
                  {e ? (
                    <StatusPill tone={e.status === 'ok' ? 'good' : e.status === 'degraded' ? 'warning' : 'critical'}>
                      {e.status} · {e.links} links
                    </StatusPill>
                  ) : (
                    <StatusPill tone="muted">none</StatusPill>
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">{sd == null ? '—' : sd > 2 ? '> 2 m' : fmt(sd * 100, 0, ' cm')}</TableCell>
                <TableCell className="text-right tabular-nums">{fmt(n.rangesPerSec, 1)}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {n.lastSeq ?? '—'}
                  {n.seqResets > 0 && (
                    <Badge variant="outline" className="ml-1">
                      {n.seqResets} reset
                    </Badge>
                  )}
                </TableCell>
                {scorer && <TableCell className="text-right tabular-nums">{fmt((scorer.perNode[n.id] ?? NaN) * 100, 0, ' cm')}</TableCell>}
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
      {sum && (
        <div className="rounded-lg border px-3 py-2 text-xs">
          <div className="mb-1 font-medium">Position RMS vs ground truth (scoring only)</div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 tabular-nums text-muted-foreground">
            <span>Fixed frame now: {fmt(sum.fixedNow * 100, 0, ' cm')}</span>
            <span>Whole run: {fmt(sum.fixedRun * 100, 0, ' cm')}</span>
            <span>Shape now: {fmt(sum.shapeNow * 100, 0, ' cm')}</span>
            <span>Whole run: {fmt(sum.shapeRun * 100, 0, ' cm')}</span>
          </div>
          {!sum.locked && <div className="mt-1 text-(--viz-warning)">Frame not locked yet: geometry has not been good enough.</div>}
        </div>
      )}
      <p className="px-2 text-xs text-muted-foreground">
        Estimates come from a placeholder solver in the browser; the Python EKF will replace it. 1σ is the larger axis of
        the uncertainty ellipse from range geometry.
      </p>
    </div>
  )
}

const SEV_ICON: Record<Severity, React.ReactNode> = {
  info: <Info className="size-3.5 text-muted-foreground" aria-label="info" />,
  warn: <AlertTriangle className="size-3.5 text-(--viz-warning)" aria-label="warning" />,
  error: <XCircle className="size-3.5 text-(--viz-critical)" aria-label="error" />,
}

export function EventLog() {
  const session = useApp((s) => s.session)
  const frame = useApp((s) => s.frame)
  const showTruth = useApp((s) => s.showTruth)
  const events = useMemo(() => (session ? [...session.pipeline.events].reverse().slice(0, 300) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session, frame])
  if (!session) return null
  const c = session.pipeline.counters
  const rejected = Object.values(c.rejected).reduce((s, v) => s + (v ?? 0), 0)
  const labels = session.recording?.labels
  const faults = showTruth && labels ? faultCatch(session.pipeline.verdicts, labels) : []

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2 text-xs">
        <Counter label="Records" value={c.lines} />
        <Counter label="Valid ranges" value={c.valid} />
        <Counter label="Timeouts / rx errors" value={`${c.timeout} / ${c.rx_error}`} />
        <Counter label="Rejected" value={rejected} />
        <Counter label="Spikes / out of order" value={`${c.flagged.outlier ?? 0} / ${c.flagged.out_of_order ?? 0}`} />
        <Counter label="Seq resets" value={c.seqResets} />
      </div>
      {rejected > 0 && (
        <div className="flex flex-wrap gap-1">
          {Object.entries(c.rejected).map(([k, v]) => (
            <Badge key={k} variant="secondary">
              {k.replace('_', ' ')}: {v}
            </Badge>
          ))}
        </div>
      )}
      {faults.length > 0 && (
        <div className="rounded-lg border px-3 py-2 text-xs">
          <div className="mb-1 font-medium">Labelled faults caught by ingest (scoring only)</div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 tabular-nums text-muted-foreground">
            {faults.map((f) => (
              <StatusPill key={f.fault} tone={f.caught === f.total ? 'good' : 'warning'}>
                {f.fault.replace('_', ' ')}: {f.caught}/{f.total}
              </StatusPill>
            ))}
          </div>
        </div>
      )}
      <ScrollArea className="h-80 rounded-lg border">
        <ul className="divide-y text-xs">
          {events.length === 0 && <li className="p-3 text-muted-foreground">No events yet.</li>}
          {events.map((e) => (
            <li key={e.id} className="flex items-start gap-2 px-3 py-1.5">
              <span className="mt-0.5">{SEV_ICON[e.severity]}</span>
              <span className="w-12 shrink-0 tabular-nums text-muted-foreground">{fmtTime(e.tUs)}</span>
              <span>{e.text}</span>
            </li>
          ))}
        </ul>
      </ScrollArea>
    </div>
  )
}

function Counter({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg border px-2.5 py-1.5">
      <div className="text-muted-foreground">{label}</div>
      <div className="text-sm font-medium tabular-nums">{value}</div>
    </div>
  )
}

export function ScenarioPanel() {
  const session = useApp((s) => s.session)
  const sc = session?.recording?.scenario
  if (!sc) return <p className="p-2 text-sm text-muted-foreground">No scenario.json for this source.</p>
  return (
    <div className="space-y-3 px-1 text-sm">
      <div>
        <div className="font-medium">{sc.title}</div>
        <p className="mt-1 text-muted-foreground">{sc.description}</p>
      </div>
      <div>
        <div className="mb-1 font-medium">Expected behaviour</div>
        <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
          {sc.expected_behaviour.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      </div>
      <div className="text-xs text-muted-foreground">
        {sc.ranging.method} · channel {sc.ranging.channel} · {sc.nodes.length} nodes · {sc.duration_s} s ·{' '}
        {sc.arena_m[0]} × {sc.arena_m[1]} m
      </div>
    </div>
  )
}
