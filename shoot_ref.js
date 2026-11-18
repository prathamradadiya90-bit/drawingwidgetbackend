// Reference server maths for the Shoot game (port of TargetShootCartoon.swift).
// All positions are in "target points": the target picture is drawn 280 x 280 pt,
// (0,0) = centre of the picture, +x = right, +y = DOWN (screen coordinates).

const CONFIG = {
  max_shots: 5,          // shots per player
  path_length: 100,      // spots on the crosshair path
  range_x: 139,          // how far the crosshair can go left/right of the centre (pt)
  range_y: 168,          // how far up/down (pt)
  target_size: 280,      // pt, the picture is 1104 x 1104 px
  base_segment_ms: 800,  // ms from one spot to the next in shot round 1
  segment_step_ms: 50,   // 50 ms faster every shot round (800, 750, 700, 650, 600)
  result_pause_ms: 1200, // pause after a shot before the next turn starts
  bullseye_pause_ms: 1600,
  start_delay_ms: 1000,  // game start / rematch: crosshair starts 1 s after the event
  late_slack_ms: 1500,   // how old a shot's elapsed_ms may be compared to arrival
  early_slack_ms: 250,   // clock-sync error allowed the other way
};

// Ring edges measured from the picture, in picture px, every 10 deg around the red dot
// (553.8, 560.8). 0 deg = right, then clockwise. Inner ring first.
const EDGES = [
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
const RING_POINTS = [50, 40, 30, 20, 10];

// Points for a shot at (x, y) target points. 0 = miss.
function scoreShot(x, y, cfg = CONFIG) {
  const scale = cfg.target_size / 1104;
  const dx = 552 + x / scale - 553.8;
  const dy = 552 + y / scale - 560.8;
  const distance = Math.sqrt(dx * dx + dy * dy);
  let degrees = Math.atan2(dy, dx) * 180 / Math.PI;
  if (degrees < 0) degrees += 360;
  const index = Math.floor(degrees / 10) % 36;
  const blend = degrees / 10 - Math.floor(degrees / 10);
  for (let ring = 0; ring < 5; ring++) {
    const a = EDGES[ring][index], b = EDGES[ring][(index + 1) % 36];
    if (distance <= a + (b - a) * blend) return RING_POINTS[ring];
  }
  return 0;
}

// Where the crosshair is `elapsedMs` after the turn started.
// path = [{x,y}] in -1...1, turn = {path_progress, segment_ms}
function crosshairAt(path, turn, elapsedMs, cfg = CONFIG) {
  const progress = turn.path_progress + Math.max(0, elapsedMs) / turn.segment_ms;
  const step = Math.floor(progress);
  const t = progress - step;
  const ease = t * t * (3 - 2 * t);
  const from = path[step % path.length];
  const to = path[(step + 1) % path.length];
  return {
    progress,
    x: (from.x + (to.x - from.x) * ease) * cfg.range_x,
    y: (from.y + (to.y - from.y) * ease) * cfg.range_y,
  };
}

const rand = (a, b) => a + Math.random() * (b - a);

function newPath(cfg = CONFIG) {
  return Array.from({ length: cfg.path_length }, () => ({ x: rand(-1, 1), y: rand(-1, 1) }));
}

// Shot round of the NEXT shot (1...max_shots), from how many shots both players made.
const shotRound = (totalShots) => Math.floor(totalShots / 2) + 1;
const segmentMs = (round, cfg = CONFIG) => cfg.base_segment_ms - cfg.segment_step_ms * (round - 1);

// Called when the turn passes to `shooter`. Changes `path` in place (catch-up help).
// stopProgress = progress where the last shot stopped.
function redoPathForTurn(path, stopProgress, round, myScore, otherScore, cfg = CONFIG) {
  if (round < 2) return;
  const help = round < cfg.max_shots && myScore < otherScore ? Math.min((otherScore - myScore) / 40, 1) : 0;
  const scale = cfg.target_size / 1104;
  const dotX = (553.8 - 552) * scale;
  const dotY = (560.8 - 552) * scale;
  const step = Math.floor(stopProgress);
  // keep the two spots the crosshair is between right now (step, step + 1), redo the rest
  for (let i = 2; i < path.length; i++) {
    const k = (step + i) % path.length;
    if (Math.random() < help * 0.35) {
      const angle = rand(0, 2 * Math.PI);
      const radius = rand(0, 20);
      path[k] = {
        x: (dotX + Math.cos(angle) * radius) / cfg.range_x,
        y: (dotY + Math.sin(angle) * radius) / cfg.range_y,
      };
    } else {
      path[k] = { x: rand(-1, 1) * (1 - 0.35 * help), y: rand(-1, 1) * (1 - 0.35 * help) };
    }
  }
}

module.exports = { CONFIG, EDGES, scoreShot, crosshairAt, newPath, shotRound, segmentMs, redoPathForTurn };

// ---- self test: node shoot_ref.js ----
if (require.main === module) {
  const assert = require('assert');
  const scale = 280 / 1104;
  const dot = { x: (553.8 - 552) * scale, y: (560.8 - 552) * scale };
  assert.strictEqual(scoreShot(dot.x, dot.y), 50);
  assert.strictEqual(scoreShot(0, 0), 50);
  // straight right of the dot: ring edges at 0 deg are 114/211/317/430/546 px
  const at = (px) => scoreShot(dot.x + px * scale, dot.y);
  assert.strictEqual(at(113), 50); assert.strictEqual(at(115), 40);
  assert.strictEqual(at(210), 40); assert.strictEqual(at(212), 30);
  assert.strictEqual(at(316), 30); assert.strictEqual(at(318), 20);
  assert.strictEqual(at(429), 20); assert.strictEqual(at(431), 10);
  assert.strictEqual(at(545), 10); assert.strictEqual(at(547), 0);
  assert.strictEqual(scoreShot(139, 168), 0);
  // crosshair timing
  const path = [{ x: 0, y: 0 }, { x: 1, y: -1 }, { x: -1, y: 1 }];
  const turn = { path_progress: 0, segment_ms: 800 };
  assert.deepStrictEqual(crosshairAt(path, turn, 0), { progress: 0, x: 0, y: 0 });
  assert.deepStrictEqual(crosshairAt(path, turn, 800), { progress: 1, x: 139, y: -168 });
  const mid = crosshairAt(path, turn, 400);
  assert.ok(Math.abs(mid.x - 69.5) < 1e-9 && Math.abs(mid.y + 84) < 1e-9);
  assert.deepStrictEqual([1, 2, 3, 4, 5].map((r) => segmentMs(r)), [800, 750, 700, 650, 600]);
  assert.deepStrictEqual([0, 1, 2, 3, 8, 9].map(shotRound), [1, 1, 2, 2, 5, 5]);
  // catch-up help keeps the two current spots
  const p = newPath(); const keep = [p[7], p[8]];
  redoPathForTurn(p, 7.4, 3, 0, 60);
  assert.ok(p[7] === keep[0] && p[8] === keep[1]);
  // average points without help, to compare with the comment in the Swift file (~18 a shot, ~4% bullseye)
  let total = 0, bulls = 0; const N = 200000;
  for (let i = 0; i < N; i++) {
    const s = scoreShot(rand(-1, 1) * 139, rand(-1, 1) * 168); total += s; if (s === 50) bulls++;
  }
  console.log('all asserts passed; uniform random spot: avg', (total / N).toFixed(1), 'bullseye', (100 * bulls / N).toFixed(1) + '%');
}
