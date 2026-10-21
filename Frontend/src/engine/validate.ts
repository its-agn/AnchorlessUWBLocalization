// Ingestion: turns raw lines into validated measurements, rejects or flags bad ones.
// Stage 1 of the pipeline (raw -> processed). Never looks at labels or ground truth.

import type { Measurement, RangeStatus, RawLine } from '@/types/messages'
import { MAX_RANGE_M, SPIKE_HISTORY, SPIKE_JUMP_M, SPIKE_WINDOW_US, STALE_PACKET_US } from './config'
import { median } from './linalg'

export type RejectReason =
  | 'bad_json'
  | 'missing_field'
  | 'invalid_node_id'
  | 'duplicate'
  | 'negative_range'
  | 'impossible_range'
  | 'stale'

export type Flag = 'out_of_order' | 'outlier'

export interface Verdict {
  line: number
  /** valid = usable range; failed = timeout/rx_error attempt; rejected = dropped by ingest. */
  kind: 'valid' | 'failed' | 'rejected'
  reason?: RejectReason
  flags: Flag[]
  /** Present unless the line was rejected before it could be read. */
  m?: Measurement
  /** Newest timestamp seen minus this record's timestamp (us). */
  ageUs: number
  /** Set when this source's seq went backwards in time order (reboot). */
  seqReset?: { from: number; to: number }
}

export const pairKey = (a: string, b: string) => (a < b ? `${a}-${b}` : `${b}-${a}`)

const STATUSES: RangeStatus[] = ['ok', 'timeout', 'rx_error']
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

export class Validator {
  private seen = new Set<string>()
  private lastSeq = new Map<string, { seq: number; ts: number }>()
  private recent = new Map<string, { t: number; d: number }[]>()
  private pendingJump = new Map<string, { t: number; d: number }[]>()
  /** Newest timestamp accepted so far: our notion of "now" on the shared clock. */
  newestTs = -Infinity

  private readonly nodes: Set<string>

  constructor(nodes: Set<string>) {
    this.nodes = nodes
  }

  check(raw: RawLine): Verdict {
    const v = raw.value as Record<string, unknown> | undefined
    const reject = (reason: RejectReason, m?: Measurement, ageUs = 0): Verdict => ({
      line: raw.line,
      kind: 'rejected',
      reason,
      flags: [],
      m,
      ageUs,
    })
    if (!v || typeof v !== 'object') return reject('bad_json')

    const status = v.status as RangeStatus
    if (
      !isNum(v.seq) ||
      !isNum(v.timestamp_us) ||
      typeof v.source_id !== 'string' ||
      typeof v.target_id !== 'string' ||
      !STATUSES.includes(status)
    )
      return reject('missing_field')
    if (status === 'ok') {
      const d = v.diag as Record<string, unknown> | null
      if (!isNum(v.tof_ps) || !isNum(v.distance_m) || !d || !isNum(d.rssi_dbm) || !isNum(d.fp_power_dbm))
        return reject('missing_field')
    }
    const m = v as unknown as Measurement
    const ageUs = Math.max(0, this.newestTs - m.timestamp_us)

    if (!this.nodes.has(m.source_id) || !this.nodes.has(m.target_id) || m.source_id === m.target_id)
      return reject('invalid_node_id', m, ageUs)

    const key = `${m.source_id}|${m.seq}|${m.timestamp_us}`
    if (this.seen.has(key)) return reject('duplicate', m, ageUs)
    this.seen.add(key)

    if (ageUs > STALE_PACKET_US) return reject('stale', m, ageUs)

    if (status === 'ok') {
      if (m.distance_m! < 0) return reject('negative_range', m, ageUs)
      if (m.distance_m! > MAX_RANGE_M) return reject('impossible_range', m, ageUs)
    }

    const flags: Flag[] = []
    if (m.timestamp_us < this.newestTs) flags.push('out_of_order')
    else this.newestTs = m.timestamp_us

    // A seq that goes backwards while time moves forward means the source rebooted.
    let seqReset: Verdict['seqReset']
    const last = this.lastSeq.get(m.source_id)
    if (!last || m.timestamp_us >= last.ts) {
      if (last && m.seq < last.seq) seqReset = { from: last.seq, to: m.seq }
      this.lastSeq.set(m.source_id, { seq: m.seq, ts: m.timestamp_us })
    }

    if (status !== 'ok') return { line: raw.line, kind: 'failed', flags, m, ageUs, seqReset }

    // Spike: a jump far from this link's recent median.
    const pk = pairKey(m.source_id, m.target_id)
    const d = m.distance_m!
    const now = m.timestamp_us
    // Only judge against recent ranges: after an outage the nodes may have moved.
    const hist = (this.recent.get(pk) ?? []).filter((h) => now - h.t <= SPIKE_WINDOW_US)
    this.recent.set(pk, hist)
    if (hist.length >= 3 && Math.abs(d - median(hist.map((h) => h.d))) > SPIKE_JUMP_M) {
      // Several consistent "outliers" in a row are a real step change, not spikes: adopt them.
      const jump = [...(this.pendingJump.get(pk) ?? []), { t: now, d }]
      const ds = jump.map((h) => h.d)
      const consistent = Math.max(...ds) - Math.min(...ds) < SPIKE_JUMP_M
      if (jump.length >= 3 && consistent) {
        this.recent.set(pk, jump)
        this.pendingJump.delete(pk)
      } else {
        flags.push('outlier')
        this.pendingJump.set(pk, consistent ? jump : [{ t: now, d }])
      }
    } else {
      this.pendingJump.delete(pk)
      hist.push({ t: now, d })
      if (hist.length > SPIKE_HISTORY) hist.shift()
    }
    return { line: raw.line, kind: 'valid', flags, m, ageUs, seqReset }
  }
}

/** Without a scenario, treat ids that show up in at least 2% of records as the node set. */
export function inferNodes(lines: RawLine[]): string[] {
  const count = new Map<string, number>()
  for (const { value } of lines) {
    const v = value as Record<string, unknown> | undefined
    for (const k of ['source_id', 'target_id']) {
      const id = v?.[k]
      if (typeof id === 'string') count.set(id, (count.get(id) ?? 0) + 1)
    }
  }
  const min = Math.max(1, lines.length * 0.02)
  return [...count.entries()].filter(([, c]) => c >= min).map(([id]) => id).sort()
}
