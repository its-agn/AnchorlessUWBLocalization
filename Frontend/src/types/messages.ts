// Data contracts. The raw types mirror Localization/test_cases/README.md exactly.
// PipelineMessage is the format the future Python service will stream over WebSocket.

export type RangeStatus = 'ok' | 'timeout' | 'rx_error'

export interface Diag {
  channel: number
  rssi_dbm: number
  fp_power_dbm: number
  noise_std: number
  quality: number
}

/** One ranging attempt as produced by a node (raw, unvalidated shape). */
export interface Measurement {
  seq: number
  timestamp_us: number
  source_id: string
  target_id: string
  status: RangeStatus
  tof_ps: number | null
  tof_dtu: number | null
  distance_m: number | null
  diag: Diag | null
}

/** A line from a recording: whatever JSON was there, before validation. */
export interface RawLine {
  /** 1-based line number in measurements.jsonl (matches labels.jsonl). */
  line: number
  /** Parsed JSON, or undefined if the line was not valid JSON. */
  value: unknown
}

/** labels.jsonl entry. Scoring only, never fed to the pipeline. */
export interface Label {
  line: number
  seq: number
  source_id: string
  target_id: string
  true_distance_m: number
  condition: 'los' | 'nlos'
  blockers: string[]
  nlos_bias_m: number
  fault: string | null
  fault_detail?: Record<string, unknown>
}

export interface Obstacle {
  name: string
  material: string
  shape: 'segment' | 'circle'
  p1_m?: [number, number]
  p2_m?: [number, number]
  centre_m?: [number, number]
  radius_m?: number
  path?: {
    waypoints_m: [number, number][]
    loop: boolean
    speed_mps: number
    start_delay_s: number
  }
}

export interface Scenario {
  case: string
  title: string
  description: string
  duration_s: number
  arena_m: [number, number]
  node_height_m: number
  nodes: string[]
  initial_positions_m: Record<string, [number, number]>
  ranging: { cycle_s: number; pair_order: string[]; channel: number; method: string }
  obstacles: Obstacle[]
  offline_windows_s: Record<string, [number, number][]>
  expected_behaviour: string[]
  stats?: Record<string, unknown>
}

/** Ground truth: positions[node] = Float64Array of x,y pairs at 10 Hz from t = 0. */
export interface GroundTruth {
  dt_s: number
  nodes: string[]
  xy: Record<string, Float64Array>
  samples: number
}

/** A loaded recording (test case or dropped folder). */
export interface Recording {
  name: string
  lines: RawLine[]
  scenario: Scenario | null
  /** Truth data, only for display and scoring. */
  labels: Label[] | null
  truth: GroundTruth | null
}

// ---- Future live stream (Python pipeline -> frontend) -----------------------------

export interface NodeEstimateMsg {
  x_m: number
  y_m: number
  /** 2x2 covariance [xx, xy, yy] in m^2. */
  cov: [number, number, number]
  status: 'ok' | 'degraded' | 'lost'
}

export type PipelineMessage =
  | { type: 'measurement'; data: Measurement }
  | { type: 'estimate'; t_us: number; nodes: Record<string, NodeEstimateMsg>; degenerate?: boolean }
  | { type: 'hello'; nodes: string[]; arena_m?: [number, number] }
