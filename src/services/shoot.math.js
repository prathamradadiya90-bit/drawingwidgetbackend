// Reference server maths for the Shoot game (port of TargetShootCartoon.swift).
// All positions are in "target points": the target picture is drawn 280 x 280 pt,
// (0,0) = centre of the picture, +x = right, +y = DOWN (screen coordinates).

export const CONFIG = {
  max_shots: 5,          // shots per player (10 shots total per match)
  path_length: 100,      // spots on the crosshair path
  range_x: 139,          // how far the crosshair can go left/right of the centre (pt)
  range_y: 168,          // how far up/down (pt)
  target_size: 280,      // pt, the picture is 1104 x 1104 px
  base_segment_ms: 800,  // ms from one spot to the next in shot round 1
  segment_step_ms: 50,   // 50 ms faster every shot round (800, 750, 700, 650, 600)
  result_pause_ms: 1200, // pause after a normal shot before the next turn starts
  bullseye_pause_ms: 1600, // pause after a 50 (bullseye)
  start_delay_ms: 1000,  // game start / rematch: crosshair starts 1 s after the event
  late_slack_ms: 1500,   // how old a shot's elapsed_ms may be compared to arrival
  early_slack_ms: 250,   // clock-sync error allowed the other way
  turn_timeout_ms: 15000,// auto-fire if shooter never taps within 15s
};

// Ring edges measured from the picture, in picture px, every 10 deg around the red dot
// (553.8, 560.8). 0 deg = right, then clockwise. Inner ring first.
export const EDGES = [
  [ // 50 points
    114, 114, 113, 113, 112, 112, 112, 112, 112, 111, 112, 112,
    112, 113, 113, 113, 113, 114, 113, 113, 113, 113, 112, 112,
    111, 111, 111, 110, 111, 111, 113, 113, 114, 114, 114, 114,
  ],
  [ // 40 points
    211, 211, 211, 208, 206, 204, 204, 208, 208, 208, 208, 209,
    210, 211, 211, 211, 214, 214, 215, 217, 219, 220, 221, 221,
    221, 220, 220, 220, 221, 221, 222, 214, 218, 219, 219, 212,
  ],
  [ // 30 points
    317, 315, 313, 310, 306, 303, 300, 298, 298, 298, 298, 298,
    300, 301, 304, 308, 312, 315, 317, 320, 321, 322, 322, 323,
    323, 323, 324, 324, 324, 324, 324, 324, 323, 322, 320, 318,
  ],
  [ // 20 points
    430, 427, 423, 417, 411, 407, 405, 404, 404, 406, 406, 407,
    409, 412, 416, 422, 428, 430, 432, 433, 436, 438, 439, 439,
    439, 439, 439, 438, 439, 439, 440, 440, 439, 438, 436, 433,
  ],
  [ // 10 points
    546, 545, 544, 540, 536, 534, 535, 536, 537, 538, 539, 540,
    540, 539, 539, 543, 546, 547, 548, 549, 550, 552, 552, 552,
    552, 552, 553, 554, 554, 554, 553, 552, 551, 550, 548, 547,
  ],
];

export const RING_POINTS = [50, 40, 30, 20, 10];

/** Helper to round to 4 decimals so DB, server and phones match identically */
export const round4 = (num) => Math.round(Number(num) * 10000) / 10000;

/**
 * Points for a shot at (x, y) target points. 0 = miss.
 */
export function scoreShot(x, y, cfg = CONFIG) {
  const scale = cfg.target_size / 1104;
  const dx = 552 + x / scale - 553.8;
  const dy = 552 + y / scale - 560.8;
  const distance = Math.sqrt(dx * dx + dy * dy);
  let degrees = (Math.atan2(dy, dx) * 180) / Math.PI;
  if (degrees < 0) degrees += 360;
  const index = Math.floor(degrees / 10) % 36;
  const blend = degrees / 10 - Math.floor(degrees / 10);
  for (let ring = 0; ring < 5; ring++) {
    const a = EDGES[ring][index];
    const b = EDGES[ring][(index + 1) % 36];
    if (distance <= a + (b - a) * blend) return RING_POINTS[ring];
  }
  return 0;
}

/**
 * Where the crosshair is `elapsedMs` after the turn started.
 * path = [{x,y}] in -1...1, turn = {path_progress, segment_ms}
 */
export function crosshairAt(path, turn, elapsedMs, cfg = CONFIG) {
  const progress = turn.path_progress + Math.max(0, elapsedMs) / turn.segment_ms;
  const step = Math.floor(progress);
  const t = progress - step;
  const ease = t * t * (3 - 2 * t);
  const from = path[step % path.length];
  const to = path[(step + 1) % path.length];
  return {
    progress: round4(progress),
    x: round4((from.x + (to.x - from.x) * ease) * cfg.range_x),
    y: round4((from.y + (to.y - from.y) * ease) * cfg.range_y),
  };
}

export const rand = (a, b) => a + Math.random() * (b - a);

/**
 * Generates a fresh random crosshair path with 100 spots, rounded to 4 decimals.
 */
export function newPath(cfg = CONFIG) {
  return Array.from({ length: cfg.path_length }, () => ({
    x: round4(rand(-1, 1)),
    y: round4(rand(-1, 1)),
  }));
}

/**
 * Shot round of the NEXT shot (1...max_shots), from how many shots both players made.
 */
export const shotRound = (totalShots) => Math.floor(totalShots / 2) + 1;

/**
 * Milliseconds per segment for a given shot round (1...5).
 */
export const segmentMs = (round, cfg = CONFIG) =>
  cfg.base_segment_ms - cfg.segment_step_ms * (round - 1);

/**
 * Called when the turn passes to `shooter`. Changes `path` in place (catch-up help).
 * stopProgress = progress where the last shot stopped.
 */
export function redoPathForTurn(path, stopProgress, round, myScore, otherScore, cfg = CONFIG) {
  if (round < 2) return;
  const help =
    round < cfg.max_shots && myScore < otherScore
      ? Math.min((otherScore - myScore) / 40, 1)
      : 0;
  const scale = cfg.target_size / 1104;
  const dotX = (553.8 - 552) * scale;
  const dotY = (560.8 - 552) * scale;
  const step = Math.floor(stopProgress);

  // Keep the two spots the crosshair is between right now (step, step + 1), redo the rest
  for (let i = 2; i < path.length; i++) {
    const k = (step + i) % path.length;
    if (Math.random() < help * 0.35) {
      const angle = rand(0, 2 * Math.PI);
      const radius = rand(0, 20);
      path[k] = {
        x: round4((dotX + Math.cos(angle) * radius) / cfg.range_x),
        y: round4((dotY + Math.sin(angle) * radius) / cfg.range_y),
      };
    } else {
      path[k] = {
        x: round4(rand(-1, 1) * (1 - 0.35 * help)),
        y: round4(rand(-1, 1) * (1 - 0.35 * help)),
      };
    }
  }
}

