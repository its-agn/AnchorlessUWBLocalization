// Live source: connects to the (future) Python pipeline service over WebSocket.
// Accepts PipelineMessage JSON: raw measurements go through the same browser
// pipeline; 'estimate' messages replace the placeholder estimator's output.

import { STEP_US } from '@/engine/config'
import { Pipeline } from '@/engine/pipeline'
import type { Session } from '@/engine/session'
import type { PipelineMessage } from '@/types/messages'

const DEFAULT_NODES = ['N1', 'N2', 'N3', 'N4', 'N5']

export class LiveSession implements Session {
  readonly kind = 'live'
  readonly name: string
  pipeline: Pipeline
  readonly scorer = null
  readonly recording = null
  readonly durationUs = null
  tUs = 0
  connection: Session['connection'] = 'connecting'
  private ws: WebSocket
  private line = 0
  private nextStep = STEP_US

  private readonly nlosWeighting: boolean
  private readonly onChange: () => void

  constructor(url: string, nlosWeighting: boolean, onChange: () => void) {
    this.nlosWeighting = nlosWeighting
    this.onChange = onChange
    this.name = url
    this.pipeline = new Pipeline(DEFAULT_NODES, { nlosWeighting })
    this.ws = new WebSocket(url)
    this.ws.onopen = () => this.setConn('open')
    this.ws.onerror = () => this.setConn('error')
    this.ws.onclose = () => this.setConn(this.connection === 'error' ? 'error' : 'closed')
    this.ws.onmessage = (ev) => this.onMessage(ev.data)
  }

  private setConn(c: Session['connection']) {
    this.connection = c
    this.onChange()
  }

  private onMessage(data: unknown) {
    let msg: PipelineMessage
    try {
      msg = JSON.parse(String(data))
    } catch {
      this.pipeline.ingest({ line: ++this.line, value: undefined })
      return
    }
    if (msg.type === 'hello') {
      this.pipeline = new Pipeline(msg.nodes, { nlosWeighting: this.nlosWeighting })
      this.tUs = 0
      this.nextStep = STEP_US
    } else if (msg.type === 'measurement') {
      const ts = msg.data?.timestamp_us
      if (typeof ts === 'number') this.advance(ts)
      this.pipeline.ingest({ line: ++this.line, value: msg.data })
    } else if (msg.type === 'estimate') {
      this.pipeline.external = true
      this.advance(msg.t_us)
      const nodes = Object.fromEntries(
        Object.entries(msg.nodes).map(([id, n]) => [id, { x: n.x_m, y: n.y_m, cov: n.cov, status: n.status, links: 0 }]),
      )
      this.pipeline.pushEstimate(msg.t_us, { nodes, degenerate: !!msg.degenerate, spreadRatio: NaN, residualRms: NaN })
    }
  }

  private advance(ts: number) {
    // First message, or a clock jump: start stepping from here instead of from 0.
    if (this.tUs === 0 || ts - this.nextStep > 10e6) this.nextStep = Math.ceil(ts / STEP_US) * STEP_US
    while (ts > this.nextStep) {
      this.pipeline.step(this.nextStep)
      this.nextStep += STEP_US
    }
    this.tUs = Math.max(this.tUs, ts)
  }

  dispose() {
    this.ws.onclose = null
    this.ws.close()
  }
}
