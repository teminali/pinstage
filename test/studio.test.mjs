// The zoom planner and camera are the whole feel of the feature, and they are
// pure functions — so they get tested properly, headlessly, on the real file.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
globalThis.window = {};
// node already provides a real crypto.randomUUID
// node provides navigator too; store.supported just reads false
new Function(readFileSync(join(ROOT_DIR, "pinstage-studio.js"), "utf8"))();
const S = window.PinstageStudio;

let fails = 0;
const ok = (label, cond, extra = "") => {
  if (!cond) { fails++; console.log(`  FAIL ${label} ${extra}`); }
  else console.log(`  ok   ${label}${extra ? " " + extra : ""}`);
};
const near = (label, got, want, tol) =>
  ok(label, Math.abs(got - want) <= tol, `(${typeof got === "number" ? got.toFixed(3) : got})`);

const surface = { w: 1440, h: 900, dpr: 2 };
const track = (clicks) => ({ surface, clicks: clicks.map(([t, x, y]) => ({ t, x, y, kind: "down" })), moves: [] });

console.log("\nzoom planner — clustering");
let segs = S.planZooms(track([[1000, 200, 300], [1600, 220, 310], [2100, 240, 290]]), 20000);
ok("three clicks in one spot -> ONE segment", segs.length === 1, `(got ${segs.length})`);
near("centre is the centroid x", segs[0].x, 220 / 1440, 0.01);

segs = S.planZooms(track([[1000, 200, 300], [12000, 1200, 800]]), 20000);
ok("far apart in time -> two segments", segs.length === 2, `(got ${segs.length})`);

segs = S.planZooms(track([[1000, 100, 100], [1500, 1350, 850]]), 20000);
ok("far apart in space -> two segments", segs.length === 2, `(got ${segs.length})`);

console.log("\nzoom planner — merge only when it is the same shot");
// Same area, briefly apart: one held shot, not two punches.
segs = S.planZooms(track([[1000, 200, 200], [4200, 250, 240]]), 20000);
ok("same area, short gap -> merged", segs.length === 1, `(got ${segs.length})`);
// Different area: two shots, because averaging them frames neither.
segs = S.planZooms(track([[1000, 200, 200], [4200, 1200, 700]]), 20000);
ok("different area -> NOT merged into a midpoint", segs.length === 2, `(got ${segs.length})`);
ok("first stays on its own target", Math.abs(segs[0].x - 200 / 1440) < 0.01);
ok("second stays on its own target", Math.abs(segs[1].x - 1200 / 1440) < 0.01);

console.log("\nzoom planner — edges");
ok("no clicks -> no segments", S.planZooms(track([]), 20000).length === 0);
segs = S.planZooms(track([[100, 50, 50]]), 20000);
ok("a click at t=100 cannot start before 0", segs[0].start >= 0, `(start ${segs[0].start})`);
segs = S.planZooms(track([[19900, 50, 50]]), 20000);
ok("a click at the end cannot run past the duration", segs[0].end <= 20000, `(end ${segs[0].end})`);

console.log("\ncamera — continuity");
segs = S.planZooms(track([[5000, 720, 450]]), 20000);
let keys = S.buildCameraTrack(segs);
const s0 = segs[0];
near("wide before the segment", S.cameraAt(keys, 0).scale, 1, 0.001);
near("wide long after", S.cameraAt(keys, 19000).scale, 1, 0.001);
near("held at full scale mid-segment", S.cameraAt(keys, s0.end - 10).scale, 2.0, 0.001);
near("centre lands on the click", S.cameraAt(keys, s0.end - 10).x, 0.5, 0.001);

// A threshold on per-frame delta only says "slow", not "continuous". A
// discontinuity is what actually reads as a glitch, and it has a signature:
// halving the timestep halves the largest step for a continuous function, and
// leaves it unchanged at a jump.
const maxStep = (k, dt) => {
  let m = 0, p = S.cameraAt(k, 0);
  for (let t = 0; t <= 20000; t += dt) {
    const c = S.cameraAt(k, t);
    m = Math.max(m, Math.abs(c.scale - p.scale) + Math.hypot(c.x - p.x, c.y - p.y));
    p = c;
  }
  return m;
};
let coarse = maxStep(keys, 16), fine = maxStep(keys, 4);
ok("camera is continuous (no jump cut)", fine < coarse * 0.45, `(16ms ${coarse.toFixed(4)} -> 4ms ${fine.toFixed(4)})`);

console.log("\ncamera — the seam between two zooms");
// Overlapping segments must hand off directly. A dip to wide and straight back
// in is the nauseating auto-zoom failure.
segs = S.planZooms(track([[2000, 300, 300], [4600, 1150, 700]]), 20000);
ok("two segments planned", segs.length === 2, `(got ${segs.length})`);
keys = S.buildCameraTrack(segs);
let minScaleBetween = Infinity;
for (let t = segs[0].end; t <= segs[1].start + segs[1].inMs; t += 8)
  minScaleBetween = Math.min(minScaleBetween, S.cameraAt(keys, t).scale);
ok("camera never releases to wide between them", minScaleBetween > 1.25, `(dipped to ${minScaleBetween.toFixed(2)}x)`);
coarse = maxStep(keys, 16); fine = maxStep(keys, 4);
ok("the pan is continuous too", fine < coarse * 0.45, `(${coarse.toFixed(4)} -> ${fine.toFixed(4)})`);

// Far apart in time: a real release IS wanted.
segs = S.planZooms(track([[2000, 300, 300], [14000, 1150, 700]]), 20000);
keys = S.buildCameraTrack(segs);
near("a long gap does return to wide", S.cameraAt(keys, 8000).scale, 1, 0.01);

console.log("\neasing — settle must overshoot, out must not");
const peakSettle = Math.max(...Array.from({ length: 200 }, (_, i) => S.ease.settle(i / 199)));
ok("settle overshoots (that is the camera feel)", peakSettle > 1.0, `(peak ${peakSettle.toFixed(3)})`);
ok("settle overshoot stays tasteful", peakSettle < 1.12, `(peak ${peakSettle.toFixed(3)})`);
near("settle(0)=0", S.ease.settle(0), 0, 1e-9);
near("settle(1)=1", S.ease.settle(1), 1, 1e-9);
const peakOut = Math.max(...Array.from({ length: 200 }, (_, i) => S.ease.out(i / 199)));
ok("release does NOT overshoot", peakOut <= 1.0 + 1e-9, `(peak ${peakOut.toFixed(3)})`);
near("glide(1)=1", S.ease.glide(1), 1, 1e-9);

console.log("\ncursor path — smooth through samples");
const moves = [];
for (let i = 0; i <= 60; i++) moves.push({ t: i * 16.7, x: 100 + i * 10, y: 300 + Math.sin(i / 6) * 80 });
ok("before the first sample", S.cursorAt(moves, -100).x === 100);
ok("after the last sample", S.cursorAt(moves, 99999).x === 700);
let jump = 0, p = S.cursorAt(moves, 0);
for (let t = 0; t < 1000; t += 4) {
  const c = S.cursorAt(moves, t);
  jump = Math.max(jump, Math.hypot(c.x - p.x, c.y - p.y));
  p = c;
}
ok("path has no discontinuities", jump < 6, `(max ${jump.toFixed(2)}px per 4ms)`);
ok("empty track -> null, not a crash", S.cursorAt([], 5) === null);

console.log("\nclick bounce");
const cl = [{ t: 1000, x: 0, y: 0, kind: "down" }];
ok("no bounce before the press", S.clickPhase(cl, 900, 350) === null);
near("bounce starts at 0", S.clickPhase(cl, 1000, 350), 0, 1e-9);
near("bounce half way", S.clickPhase(cl, 1175, 350), 0.5, 0.01);
ok("bounce is over after speed ms", S.clickPhase(cl, 1400, 350) === null);

console.log("\nformatting");
ok("0:05", S.formatDuration(5000) === "0:05", `(${S.formatDuration(5000)})`);
ok("2:56", S.formatDuration(176000) === "2:56", `(${S.formatDuration(176000)})`);
ok("3 hours of tutorial", S.formatDuration(3 * 3600e3 + 61e3) === "3:01:01", `(${S.formatDuration(3 * 3600e3 + 61e3)})`);
ok("1.4 GB", S.formatBytes(1.4 * 1073741824) === "1.40 GB", `(${S.formatBytes(1.4 * 1073741824)})`);

console.log(fails ? `\n${fails} FAILED\n` : "\nall passed\n");
process.exit(fails ? 1 : 0);
