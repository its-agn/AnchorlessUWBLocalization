"""Generate synthetic UWB two-way-ranging (ToF) test cases for the A01 anchorless
localization project.

Each test case is a 20-30 s recording of 5 DWM3001C-style nodes on a flat 10 x 10 m
floor, ranging every pair on a TDMA schedule (10 pairs x 10 Hz = 40 ranges/s per node).
The farthest two nodes are always <= 15 m apart, so every valid ToF is <= ~50 ns.

Output (per case, under test_cases/TCxx_<name>/):
    measurements.jsonl  what the nodes report - feed this to the pipeline
    labels.jsonl        truth for each measurement line (same line order)
    ground_truth.csv    true node positions at 10 Hz
    scenario.json       layout, obstacles, injected faults, expected behaviour, stats

Usage:
    python generate_uwb_test_cases.py [--out DIR]

Output is deterministic: every case has a fixed seed, so re-running yields identical files.
"""

import argparse
import csv
import json
import math
from dataclasses import dataclass, field
from itertools import combinations
from pathlib import Path
from typing import Callable

import numpy as np

# --- Physical / radio constants ------------------------------------------------------
C_AIR = 299_702_547.0                 # speed of light in air, m/s
DTU_S = 1.0 / (128 * 499.2e6)         # DW3000 device time unit, ~15.65 ps
CHANNEL = 5                           # UWB channel 5 (6.5 GHz)
MAX_RANGE_M = 15.0                    # hard limit on node separation for this data set
MAX_TOF_PS = MAX_RANGE_M / C_AIR * 1e12

# --- Network layout ------------------------------------------------------------------
NODE_IDS = ["N1", "N2", "N3", "N4", "N5"]
PAIRS = list(combinations(range(len(NODE_IDS)), 2))   # 10 pairs, one TDMA slot each
CYCLE_S = 0.100                       # one full ranging round
SLOT_S = 0.010                        # one DS-TWR exchange
ARENA_M = 10.0                        # flat square floor, 10 x 10 m (diagonal 14.14 m)
NODE_Z_M = 1.0                        # every node mounted at the same height

# --- Error model ---------------------------------------------------------------------
PAIR_BIAS_M = 0.04                    # residual antenna-delay bias per pair, U(-x, +x)
LOS_SIGMA_BASE_M = 0.04
LOS_SIGMA_PER_M = 0.004               # sigma grows ~4 mm per metre of range
RSSI_AT_1M_DBM = -63.0
PATH_LOSS_EXP = 2.0
SHADOWING_DB = 1.5

MATERIALS = {
    "person":   {"bias_m": (0.20, 0.50), "sigma_m": 0.18, "atten_db": (8.0, 12.0)},
    "drywall":  {"bias_m": (0.30, 0.80), "sigma_m": 0.15, "atten_db": (6.0, 9.0)},
    "concrete": {"bias_m": (0.60, 1.50), "sigma_m": 0.30, "atten_db": (12.0, 15.0)},
}


# --- Trajectories --------------------------------------------------------------------
# A trajectory is a callable t -> np.array([x, y]); a scenario combines one per node.

def fixed(x, y):
    p = np.array([x, y], float)
    return lambda t: p


def waypoint_path(waypoints, speed, start_delay=0.0, loop=True):
    """Constant-speed walk along straight segments; holds at the start until start_delay."""
    pts = np.asarray(waypoints, float)
    if loop:
        pts = np.vstack([pts, pts[:1]])
    seg = np.linalg.norm(np.diff(pts, axis=0), axis=1)
    cum = np.concatenate([[0.0], np.cumsum(seg)])
    total = cum[-1]

    def f(t):
        s = max(t - start_delay, 0.0) * speed
        s = s % total if loop else min(s, total)
        i = min(int(np.searchsorted(cum, s, side="right")) - 1, len(seg) - 1)
        a = (s - cum[i]) / seg[i]
        return pts[i] + a * (pts[i + 1] - pts[i])
    return f


def offset_of(base, dx, dy):
    """Follows another trajectory at a constant offset (parallel motion)."""
    d = np.array([dx, dy], float)
    return lambda t: base(t) + d


def combine(*node_fns):
    return lambda t: np.vstack([f(t) for f in node_fns])


def rigid_formation(offsets, keyframes):
    """Formation that translates/rotates as one rigid body.

    keyframes: [(t, cx, cy, heading_deg), ...], linearly interpolated.
    """
    offsets = np.asarray(offsets, float)
    kt, kx, ky, kh = (np.array(col, float) for col in zip(*keyframes))

    def f(t):
        th = math.radians(np.interp(t, kt, kh))
        rot = np.array([[math.cos(th), -math.sin(th)], [math.sin(th), math.cos(th)]])
        return np.array([np.interp(t, kt, kx), np.interp(t, kt, ky)]) + offsets @ rot.T
    return f


def random_walks(rng, starts, duration, speed_range, dt=0.01, margin=0.6, min_sep=1.0):
    """Smoothed pedestrian-like random walks that stay in the arena and avoid each other."""
    starts = np.asarray(starts, float)
    n = len(starts)
    steps = int(round(duration / dt)) + 2
    pos = np.empty((steps, n, 2))
    pos[0] = starts
    lo, hi = speed_range
    heading = rng.uniform(0, 2 * math.pi, n)
    speed = rng.uniform(lo, hi, n)
    cruise = rng.uniform(lo, hi, n)
    for k in range(1, steps):
        heading += rng.normal(0, 0.9 * math.sqrt(dt), n)
        if rng.random() < 0.2 * dt:
            cruise = rng.uniform(lo, hi, n)
        speed = np.clip(speed + 0.8 * (cruise - speed) * dt
                        + rng.normal(0, 0.2 * math.sqrt(dt), n), lo, hi)
        p = pos[k - 1]
        for i in range(n):
            away = p[i] - p
            dist = np.linalg.norm(away, axis=1)
            dist[i] = np.inf
            j = int(np.argmin(dist))
            if dist[j] < min_sep:
                target = math.atan2(away[j, 1], away[j, 0])
                err = (target - heading[i] + math.pi) % (2 * math.pi) - math.pi
                heading[i] += 3.0 * err * dt
        new = p + speed[:, None] * np.c_[np.cos(heading), np.sin(heading)] * dt
        for ax in (0, 1):
            out = (new[:, ax] < margin) | (new[:, ax] > ARENA_M - margin)
            heading[out] = (math.pi - heading[out]) if ax == 0 else -heading[out]
            new[:, ax] = np.clip(new[:, ax], margin, ARENA_M - margin)
        pos[k] = new

    def f(t):
        x = t / dt
        i = min(int(x), steps - 2)
        a = x - i
        return pos[i] + a * (pos[i + 1] - pos[i])
    return f


# --- Obstacles -----------------------------------------------------------------------

def _orient(a, b, c):
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def _segments_cross(p1, p2, q1, q2):
    return (_orient(q1, q2, p1) * _orient(q1, q2, p2) < 0
            and _orient(p1, p2, q1) * _orient(p1, p2, q2) < 0)


def _point_segment_dist(c, a, b):
    ab = b - a
    s = np.clip(np.dot(c - a, ab) / np.dot(ab, ab), 0.0, 1.0)
    return float(np.linalg.norm(a + s * ab - c))


@dataclass
class Obstacle:
    name: str
    material: str
    shape: str                          # "segment" or "circle"
    geom: tuple                         # ((x1, y1), (x2, y2)) or ((cx, cy), radius)
    path: Callable | None = None        # moving circle: t -> centre
    path_info: dict | None = None       # serialisable description of the path

    def blocks(self, a, b, t):
        if self.shape == "segment":
            return _segments_cross(a, b, np.array(self.geom[0]), np.array(self.geom[1]))
        centre = self.path(t) if self.path else np.array(self.geom[0])
        return _point_segment_dist(centre, a, b) < self.geom[1]

    def describe(self):
        d = {"name": self.name, "material": self.material, "shape": self.shape}
        if self.shape == "segment":
            d["p1_m"], d["p2_m"] = list(self.geom[0]), list(self.geom[1])
        else:
            d["radius_m"] = self.geom[1]
            if self.path_info:
                d["path"] = self.path_info
            else:
                d["centre_m"] = list(self.geom[0])
        d["model"] = {k: list(v) if isinstance(v, tuple) else v
                      for k, v in MATERIALS[self.material].items()}
        return d


# --- Scenario spec -------------------------------------------------------------------

@dataclass
class CaseSpec:
    number: int
    slug: str
    title: str
    description: str
    duration_s: float
    positions: Callable | None          # t -> (5, 2) array of node x, y
    expected: list
    positions_factory: Callable | None = None   # rng -> positions, for seeded random walks
    obstacles: list = field(default_factory=list)
    extra_loss: Callable | None = None  # (src_id, dst_id, t) -> added failure probability
    offline: dict = field(default_factory=dict)   # node_id -> [(t0, t1), ...]
    inject_faults: bool = False
    extra_check: Callable | None = None
    notes: dict = field(default_factory=dict)

    @property
    def name(self):
        return f"TC{self.number:02d}_{self.slug}"

    def is_offline(self, node_id, t):
        return any(t0 <= t < t1 for t0, t1 in self.offline.get(node_id, []))


# --- Measurement model ---------------------------------------------------------------

def tof_fields(distance_m):
    tof_s = distance_m / C_AIR
    tof_ps = round(tof_s * 1e12, 1)
    return {"tof_ps": tof_ps,
            "tof_dtu": int(round(tof_s / DTU_S)),
            "distance_m": round(tof_ps * 1e-12 * C_AIR, 3)}


def failed_fields():
    return {"tof_ps": None, "tof_dtu": None, "distance_m": None}


def quality_score(rssi_dbm, fp_gap_db):
    q_gap = min(max(1.0 - max(fp_gap_db - 4.0, 0.0) / 10.0, 0.0), 1.0)
    q_snr = min(max((rssi_dbm + 100.0) / 30.0, 0.0), 1.0)
    return round(0.6 * q_gap + 0.4 * q_snr, 2)


def simulate(spec, rng):
    """Run the TDMA schedule and return [(record, label), ...] in arrival order."""
    pair_bias = rng.uniform(-PAIR_BIAS_M, PAIR_BIAS_M, len(PAIRS))
    nlos_params = {}                    # (pair_index, obstacle name) -> (bias, atten)
    seq = {n: 0 for n in NODE_IDS}
    was_offline = {n: False for n in NODE_IDS}
    out = []

    for c in range(int(round(spec.duration_s / CYCLE_S))):
        for s, (i, j) in enumerate(PAIRS):
            src, dst = (i, j) if c % 2 == 0 else (j, i)   # initiator alternates per round
            src_id, dst_id = NODE_IDS[src], NODE_IDS[dst]
            t = c * CYCLE_S + s * SLOT_S + 0.002 + rng.uniform(-0.0005, 0.0005)

            off = spec.is_offline(src_id, t)
            if was_offline[src_id] and not off:
                seq[src_id] = 0                 # node rebooted: sequence counter restarts
            was_offline[src_id] = off
            if off:
                continue                        # a powered-off node reports nothing

            pos = spec.positions(t)
            a, b = pos[i], pos[j]
            d_true = float(np.linalg.norm(a - b))
            blockers = [o for o in spec.obstacles if o.blocks(a, b, t)]

            bias = atten = 0.0
            sigma2 = (LOS_SIGMA_BASE_M + LOS_SIGMA_PER_M * d_true) ** 2
            for o in blockers:
                key = (s, o.name)
                if key not in nlos_params:
                    m = MATERIALS[o.material]
                    nlos_params[key] = (rng.uniform(*m["bias_m"]), rng.uniform(*m["atten_db"]))
                bias += nlos_params[key][0]
                atten += nlos_params[key][1]
                sigma2 += MATERIALS[o.material]["sigma_m"] ** 2
            nlos = bool(blockers)

            p_fail = 0.005 + 0.025 * min(max((d_true - 3.0) / 11.0, 0.0), 1.0)
            if nlos:
                p_fail += 0.03
            if spec.extra_loss:
                p_fail += spec.extra_loss(src_id, dst_id, t)
            if spec.is_offline(dst_id, t):
                p_fail = 1.0

            record = {"seq": seq[src_id], "timestamp_us": int(round(t * 1e6)),
                      "source_id": src_id, "target_id": dst_id}
            seq[src_id] += 1

            if rng.random() < p_fail:
                record["status"] = "timeout" if rng.random() < 0.8 else "rx_error"
                record.update(failed_fields())
                record["diag"] = {"channel": CHANNEL, "rssi_dbm": None, "fp_power_dbm": None,
                                  "noise_std": None, "quality": None}
                nlos_bias = 0.0
            else:
                sigma = math.sqrt(sigma2)
                if nlos:
                    # NLOS error is positively skewed: zero-mean gamma on top of the bias
                    theta = sigma / math.sqrt(2.0)
                    err = bias + rng.gamma(2.0, theta) - 2.0 * theta
                    atten += rng.normal(0, 1.0)
                    fp_gap = rng.uniform(10.5, 13.0) + 0.25 * atten
                else:
                    err = rng.normal(0, sigma)
                    fp_gap = rng.uniform(1.5, 5.5)
                d_meas = d_true + pair_bias[s] + err
                rssi = (RSSI_AT_1M_DBM - 10 * PATH_LOSS_EXP * math.log10(max(d_true, 0.1))
                        - atten + rng.normal(0, SHADOWING_DB))
                record["status"] = "ok"
                record.update(tof_fields(d_meas))
                record["diag"] = {"channel": CHANNEL,
                                  "rssi_dbm": round(rssi, 1),
                                  "fp_power_dbm": round(rssi - fp_gap, 1),
                                  "noise_std": round(float(rng.normal(42.0, 4.0)), 1),
                                  "quality": quality_score(rssi, fp_gap)}
                nlos_bias = bias

            label = {"seq": record["seq"], "source_id": src_id, "target_id": dst_id,
                     "true_distance_m": round(d_true, 4),
                     "condition": "nlos" if nlos else "los",
                     "blockers": [o.name for o in blockers],
                     "nlos_bias_m": round(nlos_bias, 3),
                     "fault": None}
            out.append((record, label))
    return out


# --- Fault injection (TC10) ----------------------------------------------------------

FAULT_COUNTS = {"spike": 12, "negative_range": 6, "impossible_range": 6, "missing_field": 6,
                "invalid_node_id": 5, "stale_timestamp": 6, "out_of_order": 5, "duplicate": 8}


def inject_faults(rows, rng):
    rows = [(dict(r), dict(l)) for r, l in rows]

    def pick(k, pred=lambda r, l: True):
        idx = [n for n, (r, l) in enumerate(rows)
               if r.get("status") == "ok" and l["fault"] is None and pred(r, l)]
        return sorted(rng.choice(idx, size=min(k, len(idx)), replace=False).tolist())

    def set_distance(r, d):
        r.update(tof_fields(d))

    for n in pick(FAULT_COUNTS["spike"]):
        r, l = rows[n]
        add = float(rng.uniform(3.0, 8.0))
        set_distance(r, r["distance_m"] + add)
        l["fault"], l["fault_detail"] = "spike", {"added_m": round(add, 3)}

    # Negative ToF at very close range (antenna-delay over-correction / receiver saturation)
    close = lambda r, l: {r["source_id"], r["target_id"]} == {"N1", "N2"} and l["true_distance_m"] < 0.9
    for n in pick(FAULT_COUNTS["negative_range"], close):
        r, l = rows[n]
        set_distance(r, -float(rng.uniform(0.03, 0.25)))
        l["fault"] = "negative_range"

    for n in pick(FAULT_COUNTS["impossible_range"]):
        r, l = rows[n]
        set_distance(r, float(rng.uniform(18.0, 60.0)))
        l["fault"] = "impossible_range"

    for n in pick(FAULT_COUNTS["missing_field"]):
        r, l = rows[n]
        key = ["distance_m", "target_id", "timestamp_us", "tof_ps"][int(rng.integers(4))]
        del r[key]
        l["fault"], l["fault_detail"] = "missing_field", {"field": key}

    for k, n in enumerate(pick(FAULT_COUNTS["invalid_node_id"])):
        r, l = rows[n]
        if k % 2 == 0:
            r["target_id"] = "N7"               # node that does not exist
        else:
            r["target_id"] = r["source_id"]     # node ranging itself
        l["fault"], l["fault_detail"] = "invalid_node_id", {"target_id": r["target_id"]}

    # Late delivery: a packet shows up 2-5 s after its timestamp
    for n in sorted(pick(FAULT_COUNTS["stale_timestamp"],
                         lambda r, l: r["timestamp_us"] < 0.7 * rows[-1][0]["timestamp_us"]),
                    reverse=True):
        r, l = rows.pop(n)
        delay = float(rng.uniform(2.0, 5.0))
        target_ts = r["timestamp_us"] + delay * 1e6
        dest = next((m for m in range(n, len(rows))
                     if rows[m][0].get("timestamp_us", 0) > target_ts), len(rows))
        l["fault"], l["fault_detail"] = "stale_timestamp", {"delivered_late_s": round(delay, 2)}
        rows.insert(dest, (r, l))

    for n in pick(FAULT_COUNTS["out_of_order"]):
        if n + 1 < len(rows) and rows[n + 1][1]["fault"] is None and rows[n][1]["fault"] is None:
            rows[n], rows[n + 1] = rows[n + 1], rows[n]
            rows[n][1]["fault"] = rows[n + 1][1]["fault"] = "out_of_order"

    for n in sorted(pick(FAULT_COUNTS["duplicate"]), reverse=True):
        r, l = rows[n]
        dup_label = dict(l, fault="duplicate")
        rows.insert(n + 1, (dict(r), dup_label))
    return rows


# --- Checks --------------------------------------------------------------------------

def check_case(spec, rows):
    """Assert the generated data meets the physical constraints; return summary stats."""
    labels = [l for _, l in rows]
    true_d = np.array([l["true_distance_m"] for l in labels])
    assert true_d.max() <= MAX_RANGE_M, f"{spec.name}: true range {true_d.max():.2f} m > 15 m"
    assert true_d.min() >= 0.3, f"{spec.name}: nodes too close ({true_d.min():.2f} m)"

    # Ground truth over the full run, not just at measurement instants
    for t in np.arange(0.0, spec.duration_s, 0.05):
        p = spec.positions(t)
        assert ((p >= 0) & (p <= ARENA_M)).all(), f"{spec.name}: node left arena at t={t:.2f}"
        for i, j in PAIRS:
            assert np.linalg.norm(p[i] - p[j]) <= MAX_RANGE_M

    clean_ok = [(r, l) for r, l in rows if l["fault"] is None and r.get("status") == "ok"]
    meas = np.array([r["distance_m"] for r, _ in clean_ok])
    assert (meas > 0).all() and (meas <= MAX_RANGE_M).all(), \
        f"{spec.name}: valid distance outside (0, 15] m: {meas.min():.3f}..{meas.max():.3f}"
    for r, _ in clean_ok:
        assert abs(r["tof_ps"] * 1e-12 * C_AIR - r["distance_m"]) < 5e-4
        assert abs(r["tof_dtu"] * DTU_S * C_AIR - r["distance_m"]) < 5e-3

    expected_n = spec.duration_s / CYCLE_S * len(PAIRS)
    assert 0.9 * expected_n <= len(rows) <= 1.05 * expected_n, f"{spec.name}: {len(rows)} records"

    err = lambda subset: np.array([r["distance_m"] - l["true_distance_m"] for r, l in subset])
    los_err = err([x for x in clean_ok if x[1]["condition"] == "los"])
    assert abs(los_err.mean()) < 0.03 and 0.03 < los_err.std() < 0.12, \
        f"{spec.name}: LOS error mean {los_err.mean():.3f} std {los_err.std():.3f}"
    nlos_rows = [x for x in clean_ok if x[1]["condition"] == "nlos"]
    if nlos_rows:
        nlos_err = err(nlos_rows)
        gaps = np.array([r["diag"]["rssi_dbm"] - r["diag"]["fp_power_dbm"] for r, _ in nlos_rows])
        assert nlos_err.mean() > 0.15 and gaps.mean() > 10.0, f"{spec.name}: weak NLOS signature"

    if spec.extra_check:
        spec.extra_check(spec)

    faults = {}
    nlos_links = {}                     # obstacle -> {"Na-Nb": measurements blocked}
    for l in labels:
        if l["fault"]:
            faults[l["fault"]] = faults.get(l["fault"], 0) + 1
        pair = "-".join(sorted((l["source_id"], l["target_id"])))
        for o in l["blockers"]:
            links = nlos_links.setdefault(o, {})
            links[pair] = links.get(pair, 0) + 1
    nlos_links = {o: dict(sorted(v.items())) for o, v in sorted(nlos_links.items())}
    statuses = [r.get("status") for r, _ in rows]
    return {
        "records": len(rows),
        "ok": statuses.count("ok"),
        "timeout": statuses.count("timeout"),
        "rx_error": statuses.count("rx_error"),
        "nlos_measurements": sum(1 for l in labels if l["condition"] == "nlos"),
        "nlos_links": nlos_links,
        "faults": faults,
        "true_range_m": [round(float(true_d.min()), 3), round(float(true_d.max()), 3)],
        "valid_measured_range_m": [round(float(meas.min()), 3), round(float(meas.max()), 3)],
        "max_valid_tof_ps": max(r["tof_ps"] for r, _ in clean_ok),
        "los_error_mean_m": round(float(los_err.mean()), 4),
        "los_error_std_m": round(float(los_err.std()), 4),
    }


def check_rigid_motion(spec):
    times = np.arange(0.0, spec.duration_s, 0.05)
    snaps = np.array([spec.positions(t) for t in times])
    for i, j in PAIRS:
        assert np.linalg.norm(snaps[:, i] - snaps[:, j], axis=1).std() < 1e-3
    centroid = snaps.mean(axis=1)
    assert np.linalg.norm(centroid[-1] - centroid[0]) > 5.0


# --- The ten cases -------------------------------------------------------------------

def build_cases():
    cases = []

    pentagon = [(5 + 4 * math.cos(math.radians(90 + 72 * k)),
                 5 + 4 * math.sin(math.radians(90 + 72 * k))) for k in range(5)]
    cases.append(CaseSpec(
        1, "static_baseline_los", "Static baseline, line of sight",
        "Five stationary nodes on a regular pentagon (radius 4 m, centred at 5,5). All links "
        "are line of sight. Use this case to measure the raw ranging noise floor and per-pair "
        "bias, and to verify basic multilateration.",
        20.0, combine(*(fixed(*p) for p in pentagon)),
        ["Every link LOS; errors ~N(pair bias, 4-7 cm)",
         "Localization should recover the pentagon (up to rotation/reflection) within ~0.1 m",
         "Estimated positions should stay still"]))

    cases.append(CaseSpec(
        2, "static_long_range", "Static, long range near the 15 m limit",
        "Four nodes in the corners of the floor and one off-centre. The diagonals are about "
        "13.5 m, close to the 15 m limit. Range noise grows with distance, RSSI drops to "
        "about -86 dBm, and timeouts are more frequent on the longest links.",
        20.0, combine(fixed(0.2, 0.2), fixed(9.8, 0.3), fixed(9.8, 9.8), fixed(0.3, 9.7),
                      fixed(5.2, 4.6)),
        ["Long-link sigma ~9-10 cm vs ~6 cm on short links",
         "Timeout rate ~2-3% on 13 m+ links",
         "Confidence weighting by range/RSSI should improve the fit"]))

    cases.append(CaseSpec(
        3, "single_mover", "One moving node, four static",
        "N1-N4 stand still on the corners of an 8 x 8 m square. After 2 s, N5 walks a "
        "4 x 4 m rectangle inside the square at 1.0 m/s and loops it for the rest of the run.",
        30.0, combine(fixed(1, 1), fixed(9, 1), fixed(9, 9), fixed(1, 9),
                      waypoint_path([(3, 3), (7, 3), (7, 7), (3, 7)], 1.0, start_delay=2.0)),
        ["Static nodes should stay put",
         "N5 track should trace a 4 x 4 m rectangle at 1 m/s"]))

    def tc04(rng):
        return random_walks(rng, [(2, 2), (8, 2), (8, 8), (2, 8), (5, 5)], 30.0, (0.3, 1.2))
    cases.append(CaseSpec(
        4, "all_moving_random", "All five nodes moving",
        "Every node follows a smoothed pedestrian-like random walk at 0.3-1.2 m/s. Nodes "
        "stay inside the floor and steer away from each other. All links are line of sight.",
        30.0, None,
        ["All pairwise ranges change continuously",
         "Cooperative localization should track every node; compare to ground_truth.csv"],
        positions_factory=tc04))

    formation = [(0.0, 1.5), (1.45, 0.4), (0.85, -1.25), (-0.9, -1.2), (-1.4, 0.45)]
    keyframes = [(0.0, 2.0, 4.5, 0.0), (3.0, 2.0, 4.5, 0.0), (10.5, 8.0, 4.5, 0.0),
                 (12.5, 8.0, 4.5, 0.0), (17.5, 8.0, 4.5, 30.0), (25.0, 8.0, 4.5, 30.0)]
    cases.append(CaseSpec(
        5, "rigid_group_motion", "Whole group moves as a rigid body",
        "The five nodes form a compact, slightly irregular formation (~3 m across) that moves "
        "as one rigid body. It holds still for 3 s, translates 6 m in +x at 0.8 m/s, pauses "
        "for 2 s, rotates 30 deg about its centre over 5 s, then holds. Pairwise distances "
        "never change, so the ranges look identical to a static scene. This is the "
        "documented failure mode that the IMU is meant to fix.",
        25.0, rigid_formation(formation, keyframes),
        ["Ranges are statistically stationary for the whole run",
         "UWB-only localization cannot see the translation/rotation; it should report "
         "a static shape (or flag reduced observability)",
         "Ground truth shows 6 m translation + 30 deg rotation"],
        extra_check=check_rigid_motion,
        notes={"formation_offsets_m": formation,
               "keyframes_t_cx_cy_heading_deg": keyframes}))

    n1_path = waypoint_path([(2, 3.5), (8, 3.5), (8, 5.0), (2, 5.0)], 1.0, start_delay=2.0)
    cases.append(CaseSpec(
        6, "parallel_pair", "Two nodes walking side by side",
        "N3-N5 are static. After 2 s, N1 and N2 walk the same loop side by side, with N2 "
        "always 1.5 m in +y from N1, at 1.0 m/s. The N1-N2 range stays constant at 1.5 m, "
        "but their ranges to the static nodes change, so the motion is observable.",
        25.0, combine(n1_path, offset_of(n1_path, 0.0, 1.5),
                      fixed(1, 1), fixed(9, 1), fixed(5, 9)),
        ["N1-N2 measured range constant ~1.5 m",
         "N1/N2 tracks should be parallel and 1.5 m apart",
         "Contrast with TC05, where no static node is present"]))

    cases.append(CaseSpec(
        7, "collinear_degenerate", "Near-collinear geometry, then recovery",
        "All five nodes start almost on the line y = 5, with at most 5 cm lateral offset. "
        "This geometry is degenerate: the 2D solution is ill-conditioned and has a "
        "reflection ambiguity across the line. At t = 12 s, N4 walks 2 m off the line at "
        "1 m/s, after which the geometry is well conditioned.",
        25.0, combine(fixed(1, 5.02), fixed(3, 4.97), fixed(5, 5.04),
                      waypoint_path([(7, 4.99), (7, 6.99)], 1.0, start_delay=12.0, loop=False),
                      fixed(9, 5.03)),
        ["Before 12 s: solver should flag poor geometry (high GDOP / low confidence)",
         "Lateral position of nodes is essentially unobservable before 12 s",
         "After ~14 s: estimates converge"]))

    person_path = waypoint_path([(7.0, 9.6), (7.0, 0.4)], 1.0, start_delay=3.0)
    obstacles_tc08 = [
        Obstacle("drywall_partition", "drywall", "segment", ((5.0, 0.3), (5.0, 3.0))),
        Obstacle("concrete_pillar", "concrete", "circle", ((4.78, 5.76), 0.30)),
        Obstacle("walking_person", "person", "circle", ((7.0, 9.6), 0.25), path=person_path,
                 path_info={"waypoints_m": [[7.0, 9.6], [7.0, 0.4]], "loop": True,
                            "speed_mps": 1.0, "start_delay_s": 3.0}),
    ]
    cases.append(CaseSpec(
        8, "nlos_obstruction", "NLOS: wall, pillar and a walking person",
        "Five static nodes. A drywall partition permanently blocks N1-N2, and a concrete "
        "pillar permanently blocks N4-N5. From t = 3 s, a person walks back and forth "
        "along x = 7 and briefly blocks N1-N2, N1-N3, N2-N4, N2-N5, N3-N4 and N3-N5 as "
        "they cross. NLOS ranges read long (+0.2 to +1.5 m), with higher variance and "
        "lower RSSI. Their RSSI minus first-path power gap is above 10 dB, against under "
        "6 dB for LOS. labels.jsonl marks every NLOS measurement and its blockers.",
        30.0, combine(fixed(1, 1), fixed(9, 1.5), fixed(8.5, 8.5), fixed(1.5, 8),
                      fixed(5.6, 5.2)),
        ["N1-N2 and N4-N5 biased long for the whole run",
         "Short NLOS bursts on links the person crosses",
         "RSSI - FP power > 10 dB flags NLOS (non-ML baseline)",
         "NLOS-aware weighting should reduce position error vs. naive LS"],
        obstacles=obstacles_tc08))

    def tc09(rng):
        return random_walks(rng, [(1.5, 5), (5, 1.5), (8.5, 5), (5, 8.5), (5, 5)], 30.0,
                            (0.3, 0.9))
    burst = lambda s, d, t: 1.0 if {s, d} == {"N2", "N3"} and 6.0 <= t < 8.0 else 0.0
    cases.append(CaseSpec(
        9, "dropouts_and_recovery", "Packet loss, burst outage and a node dropout",
        "All nodes are moving. On top of the normal timeouts there is 5% random packet "
        "loss, and the N2-N3 link fails completely from 6 s to 8 s. N4 powers off from "
        "10 s to 14 s: it sends no reports, and other nodes ranging to it record "
        "timeouts. When N4 comes back it has rebooted, so its seq counter restarts at 0.",
        30.0, None,
        ["System tolerates missing ranges without diverging (MVP 1.d)",
         "N2-N3 link expires after 6 s and is restored at 8 s",
         "N4 estimate marked degraded/stale during 10-14 s, recovers automatically (MVP 1.e)",
         "Pipeline handles N4 seq reset to 0 after reboot"],
        positions_factory=tc09,
        extra_loss=lambda s, d, t: 0.05 + burst(s, d, t),
        offline={"N4": [(10.0, 14.0)]}))

    cases.append(CaseSpec(
        10, "invalid_and_outliers", "Corrupted, impossible and malformed packets",
        "Slow motion: N2 walks toward N1 until they are 0.4 m apart, then back, and N5 "
        "drifts along the top edge. About 2% of records are corrupted with spikes "
        "(+3 to 8 m), negative ToF at close range, impossible ranges (18-60 m), missing "
        "fields, unknown or self-referencing node IDs, packets delivered 2-5 s late, "
        "swapped (out-of-order) packets and exact duplicates. Each fault is labelled in "
        "labels.jsonl. Apart from the labelled faults, every range is within (0, 15] m.",
        25.0, combine(fixed(3, 5), waypoint_path([(6.5, 5), (3.4, 5)], 0.4, start_delay=2.0),
                      fixed(1.5, 1.5), fixed(8.5, 2.0),
                      waypoint_path([(5, 8.5), (8, 8.5)], 0.3)),
        ["Ingestion rejects/flags every labelled fault (MVP 3.f)",
         "Negative and > 15 m ranges rejected as physically impossible",
         "Duplicates (same source_id + seq) dropped; stale packets flagged by age",
         "Localization output unaffected by the injected faults"],
        inject_faults=True,
        notes={"fault_counts_requested": FAULT_COUNTS}))
    return cases


# --- Output --------------------------------------------------------------------------

def write_jsonl(path, items):
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        for item in items:
            f.write(json.dumps(item) + "\n")


def write_case(spec, rows, stats, seed, out_dir):
    case_dir = out_dir / spec.name
    case_dir.mkdir(parents=True, exist_ok=True)

    write_jsonl(case_dir / "measurements.jsonl", (r for r, _ in rows))
    write_jsonl(case_dir / "labels.jsonl",
                (dict(line=n, **l) for n, (_, l) in enumerate(rows, start=1)))

    with open(case_dir / "ground_truth.csv", "w", encoding="utf-8", newline="\n") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["t_s", "node_id", "x_m", "y_m", "z_m"])
        for k in range(int(round(spec.duration_s / CYCLE_S)) + 1):
            t = k * CYCLE_S
            for node_id, (x, y) in zip(NODE_IDS, spec.positions(t)):
                w.writerow([f"{t:.1f}", node_id, f"{x:.4f}", f"{y:.4f}", f"{NODE_Z_M:.4f}"])

    p0 = spec.positions(0.0)
    scenario = {
        "case": spec.name,
        "title": spec.title,
        "description": spec.description,
        "duration_s": spec.duration_s,
        "seed": seed,
        "arena_m": [ARENA_M, ARENA_M],
        "node_height_m": NODE_Z_M,
        "nodes": NODE_IDS,
        "initial_positions_m": {n: [round(float(x), 4), round(float(y), 4)]
                                for n, (x, y) in zip(NODE_IDS, p0)},
        "ranging": {"method": "DS-TWR", "channel": CHANNEL, "cycle_s": CYCLE_S,
                    "slot_s": SLOT_S, "pair_rate_hz": 1 / CYCLE_S,
                    "pair_order": [f"{NODE_IDS[i]}-{NODE_IDS[j]}" for i, j in PAIRS],
                    "initiator": "alternates every cycle"},
        "obstacles": [o.describe() for o in spec.obstacles],
        "offline_windows_s": spec.offline,
        "expected_behaviour": spec.expected,
        "stats": stats,
    }
    scenario.update(spec.notes)
    with open(case_dir / "scenario.json", "w", encoding="utf-8", newline="\n") as f:
        json.dump(scenario, f, indent=2)
        f.write("\n")


README_HEAD = """\
# Synthetic UWB ToF test cases

Ten time-series test cases of simulated DWM3001C two-way-ranging data for the A01
anchorless localization project. They were generated by `../generate_uwb_test_cases.py`;
re-running that script reproduces these files exactly.

## Setup common to all cases

- **Nodes:** 5 nodes (`N1`-`N5`) on a flat 10 x 10 m floor, all mounted at z = 1.0 m, so
  the problem is effectively 2D. The farthest pair is always <= 15 m apart, so every valid
  ToF is <= {max_tof:.0f} ps (~{max_dtu} DTU).
- **Ranging:** DS-TWR on channel 5. Each pair gets one 10 ms TDMA slot in a 100 ms cycle,
  so every pair is ranged at 10 Hz and each node makes 40 ranges/s. The initiator
  (`source_id`) alternates every cycle.
- **Timestamps:** `timestamp_us` is microseconds since the start of the run, on a shared
  (already synchronized) clock.
- **`seq`:** a per-source-node counter. It restarts at 0 when a node reboots (TC09).

## Files in each case folder

| File | Contents |
|------|----------|
| `measurements.jsonl` | One ranging attempt per line. This is the pipeline input. |
| `labels.jsonl` | Truth for the same line number in `measurements.jsonl`: `true_distance_m`, `condition` (`los`/`nlos`), `blockers`, `nlos_bias_m`, `fault`. |
| `ground_truth.csv` | True `x_m, y_m, z_m` of every node at 10 Hz. |
| `scenario.json` | Layout, obstacles, offline windows, expected behaviour and generated statistics. |

Keep `labels.jsonl` away from the system under test. Use it only for scoring.

## Measurement record

```json
{example}
```

| Field | Meaning |
|-------|---------|
| `status` | `ok`, `timeout` (no response) or `rx_error` (corrupted frame). Failed attempts have `null` ToF, distance and diagnostics. |
| `tof_ps` | One-way time of flight in picoseconds. |
| `tof_dtu` | The same ToF in DW3000 device time units (1 DTU = 1/(128 x 499.2 MHz) ~ 15.65 ps). |
| `distance_m` | `tof_ps` x c_air, with c_air = 299,702,547 m/s. |
| `diag.rssi_dbm` | Estimated total received power. |
| `diag.fp_power_dbm` | First-path power. RSSI minus FP power is < 6 dB for LOS and > 10 dB for NLOS. |
| `diag.noise_std` | CIR noise standard deviation (accumulator units). |
| `diag.quality` | 0-1 confidence derived from SNR and the FP/RSSI gap. |

## Error model

- **LOS:** a fixed per-pair antenna-delay bias, U(+/-4 cm), plus Gaussian noise with
  sigma = 4 cm + 0.4 cm per metre of range.
- **NLOS:** an extra positive bias that depends on the material (person 0.2-0.5 m,
  drywall 0.3-0.8 m, concrete 0.6-1.5 m), positively skewed noise, 6-15 dB extra
  attenuation, and a higher timeout probability.
- **RSSI:** -63 dBm at 1 m with path-loss exponent 2, plus 1.5 dB shadowing.
- **Timeouts:** ~0.5% at short range, rising to ~3% at 14 m.

## Cases

| Case | Duration | Records | ok / timeout / rx_err | NLOS | Faults | True range (m) | LOS err mean / std (m) |
|------|---------:|--------:|----------------------:|-----:|-------:|---------------:|-----------------------:|
"""


def write_readme(out_dir, cases_and_stats):
    example = None
    rows = []
    for spec, stats in cases_and_stats:
        if example is None:
            with open(out_dir / spec.name / "measurements.jsonl", encoding="utf-8") as f:
                example = next(l for l in f if '"ok"' in l).strip()
        faults = sum(stats["faults"].values())
        rows.append(
            f"| {spec.name} | {spec.duration_s:.0f} s | {stats['records']} | "
            f"{stats['ok']} / {stats['timeout']} / {stats['rx_error']} | "
            f"{stats['nlos_measurements']} | {faults} | "
            f"{stats['true_range_m'][0]:.2f}-{stats['true_range_m'][1]:.2f} | "
            f"{stats['los_error_mean_m']:+.3f} / {stats['los_error_std_m']:.3f} |")
    details = [f"\n### {spec.name}: {spec.title}\n\n{spec.description}\n\nExpected:\n"
               + "\n".join(f"- {e}" for e in spec.expected) + "\n"
               for spec, _ in cases_and_stats]
    text = (README_HEAD.format(max_tof=MAX_TOF_PS, max_dtu=int(MAX_TOF_PS * 1e-12 / DTU_S),
                               example=example)
            + "\n".join(rows) + "\n" + "".join(details))
    with open(out_dir / "README.md", "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--out", type=Path,
                        default=Path(__file__).resolve().parent / "test_cases")
    args = parser.parse_args()

    results = []
    for spec in build_cases():
        seed = 1000 + spec.number
        rng = np.random.default_rng(seed)
        if spec.positions_factory:
            spec.positions = spec.positions_factory(rng)
        rows = simulate(spec, rng)
        if spec.inject_faults:
            rows = inject_faults(rows, rng)
        stats = check_case(spec, rows)
        write_case(spec, rows, stats, seed, args.out)
        results.append((spec, stats))

    write_readme(args.out, results)

    print(f"{'case':<28}{'records':>8}{'ok':>7}{'nlos':>6}{'faults':>7}"
          f"{'true max m':>11}{'meas max m':>11}{'max ToF ns':>11}{'LOS err std':>12}")
    for spec, s in results:
        print(f"{spec.name:<28}{s['records']:>8}{s['ok']:>7}{s['nlos_measurements']:>6}"
              f"{sum(s['faults'].values()):>7}{s['true_range_m'][1]:>11.2f}"
              f"{s['valid_measured_range_m'][1]:>11.2f}{s['max_valid_tof_ps'] / 1000:>11.2f}"
              f"{s['los_error_std_m']:>12.3f}")
    print(f"\nAll checks passed. Output: {args.out}")


if __name__ == "__main__":
    main()
