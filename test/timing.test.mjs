// Exercises the ACTUAL shipped source of both twins, sliced out of the files,
// so a drift between toolbar and MCP fails the test instead of shipping.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

const ROOT = ROOT_DIR + "/";

function slice(src, header) {
  const i = src.indexOf(header);
  if (i < 0) throw new Error("not found: " + header);
  let depth = 0, j = src.indexOf("{", i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === "{") depth++;
    else if (src[k] === "}") { depth--; if (!depth) return src.slice(i, k + 1); }
  }
  throw new Error("unbalanced: " + header);
}

const toolbarSrc = readFileSync(ROOT + "pinstage.js", "utf8");
const mcpSrc = readFileSync(ROOT + "mcp/pinstage-mcp.mjs", "utf8");

let NOW = 1_000_000;
const mk = (src, header) =>
  new Function("ts", "now", "WORKING_STATUSES", `${slice(src, header)}; return applyStatusTransition;`)(
    () => ({ _ts: NOW }), () => ({ _ts: NOW }), { in_progress: 1, deploying: 1 }
  );

const toolbar = mk(toolbarSrc, "function applyStatusTransition(data, status, actor) {");
const mcp = mk(mcpSrc, "function applyStatusTransition(data, status, actor) {");

const phaseTiming = new Function(
  "WORKING_STATUSES", `${slice(toolbarSrc, "function phaseTiming(d) {")}; return phaseTiming;`
)({ in_progress: 1, deploying: 1 });

const formatDuration = new Function(
  `${slice(toolbarSrc, "const formatDuration = (ms) => {")}; return formatDuration;`
)();

let fails = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log(`  FAIL ${label}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`); }
  else console.log(`  ok   ${label}`);
};

const ACTOR = { uid: "mcp", name: "Claude (dev)" };

console.log("\nformatDuration — the counter must speak h/m/s, not 3714s");
eq("0s", formatDuration(0), "0s");
eq("44s", formatDuration(44_000), "44s");
eq("59s", formatDuration(59_400), "59s");
eq("1m", formatDuration(60_000), "1m");
eq("2m 56s (was '176s')", formatDuration(176_000), "2m 56s");
eq("61m -> 1h 01m", formatDuration(3_660_000), "1h 01m");
eq("1h", formatDuration(3_600_000), "1h");
eq("3714s -> 1h 01m", formatDuration(3_714_000), "1h 01m");
eq("26h -> 1d 2h", formatDuration(93_600_000), "1d 2h");

for (const [name, apply] of [["toolbar", toolbar], ["mcp", mcp]]) {
  console.log(`\n${name}: the anchor must not move while work continues`);
  NOW = 1_000_000;
  let d = apply({ status: "open" }, "in_progress", ACTOR);
  const claimedAt = d.workStartedAt._ts;
  eq("claim stamps workStartedAt", claimedAt, 1_000_000);
  eq("claim stamps claimedBy", d.claimedBy.name, "Claude (dev)");

  // The original bug: a progress note bumped lastActivityAt and the timer restarted.
  NOW = 1_030_000;
  d.lastActivityAt = { _ts: NOW }; // what pinstage_reply does
  eq("a reply does NOT move the anchor", phaseTiming(d).start, claimedAt);
  eq("elapsed after a reply", formatDuration(NOW - phaseTiming(d).start), "30s");

  // Re-asserting in_progress (agents call set_status more than once).
  NOW = 1_100_000;
  d = apply(d, "in_progress", ACTOR);
  eq("re-claiming does NOT move the anchor", phaseTiming(d).start, claimedAt);

  NOW = 1_200_000;
  d = apply(d, "deploying", ACTOR);
  eq("deploy keeps workStartedAt", d.workStartedAt._ts, claimedAt);
  eq("deploy gets its own anchor", d.deployStartedAt._ts, 1_200_000);
  eq("deploy phase times the deploy", phaseTiming(d).start, 1_200_000);
  eq("deploy phase label", phaseTiming(d).phase, "deploy");

  NOW = 1_260_000;
  d = apply(d, "deployed", ACTOR);
  eq("deployed closes both measurements", [d.workEndedAt._ts, d.deployEndedAt._ts], [1_260_000, 1_260_000]);
  eq("total fix duration measurable", formatDuration(d.workEndedAt._ts - d.workStartedAt._ts), "4m 20s");
  eq("deployed shows no timer", phaseTiming(d), null);

  NOW = 1_300_000;
  const released = apply({ ...d, status: "deployed" }, "open", ACTOR);
  eq("release voids the measurement", [released.workStartedAt, released.claimedBy], [undefined, undefined]);
}

console.log("\nphaseTiming — a start it cannot know must not be invented");
eq("no anchors at all -> no timer", phaseTiming({ status: "in_progress", createdAt: { _ts: 1 } }), null);
eq("legacy claimedAt is exact", phaseTiming({ status: "in_progress", claimedBy: { claimedAt: { _ts: 5 } } }), { start: 5, exact: true, phase: "fix" });
eq("legacy lastActivity is approximate", phaseTiming({ status: "in_progress", lastActivityAt: { _ts: 7 } }), { start: 7, exact: false, phase: "fix" });
eq("createdAt is never an anchor", phaseTiming({ status: "deploying", createdAt: { _ts: 9 } }), null);
eq("resolved has no phase", phaseTiming({ status: "resolved", workStartedAt: { _ts: 1 } }), null);

console.log(fails ? `\n${fails} FAILED\n` : "\nall passed\n");
process.exit(fails ? 1 : 0);
