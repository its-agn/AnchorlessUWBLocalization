// Tunable constants for ingestion, health and the placeholder estimator.

export const C_AIR_MPS = 299_702_547
/** Max physical pair separation (15 m) plus margin for noise and NLOS bias. */
export const MAX_RANGE_M = 17
/** Two measurements count as "the same instant" if within this window (2 TDMA cycles). */
export const SAME_INSTANT_US = 200_000
/** Packets older than this (vs. the newest timestamp seen) are rejected as stale. */
export const STALE_PACKET_US = 1_000_000
/** Range jump vs. the link's recent median that marks an outlier (spike). */
export const SPIKE_JUMP_M = 1.5
/** Only ranges this recent are used to judge spikes. */
export const SPIKE_WINDOW_US = 1_000_000
/** Valid ranges used to judge spikes. */
export const SPIKE_HISTORY = 7
/** Link with no valid range for this long is "down". */
export const LINK_DOWN_US = 1_000_000
/** Node with no valid range for this long is "stale"; longer is "offline". */
export const NODE_STALE_US = 500_000
export const NODE_OFFLINE_US = 2_000_000
/** Window for link rate / drop statistics. */
export const STATS_WINDOW_US = 2_000_000
/** RSSI - first-path power thresholds (dB) for the non-ML NLOS cue. */
export const NLOS_GAP_UNCERTAIN_DB = 6
export const NLOS_GAP_DB = 10
/** Estimator / health evaluation step. */
export const STEP_US = 100_000
/** Ranges older than this are not used by the estimator. */
export const ESTIMATOR_RANGE_AGE_US = 300_000
/** Trail length drawn on the map. */
export const TRAIL_US = 5_000_000
