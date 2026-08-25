// The clock and the median denominator, sliced out of the shipped toolbar.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(ROOT_DIR, "pinstage.js"), "utf8");

function slice(src, header, open = "{") {
  const i = src.indexOf(header);
  if (i < 0) throw new Error("not found: " + header);
  let depth = 0;
  for (let k = src.indexOf(open, i); k < src.length; k++) {
    if (src[k] === open) depth++;
    else if (src[k] === "}") { depth--; if (!depth) return src.slice(i, k + 1); }
  }
  throw new Error("unbalanced");
}

const clock = new Function(`${slice(src, "const clock = {")}; return clock;`)();

let fails = 0;
const near = (label, got, want, tol) => {
  const ok = Math.abs(got - want) <= tol;
  if (!ok) { fails++; console.log(`  FAIL ${label}: got ${got}, want ${want}±${tol}`); }
  else console.log(`  ok   ${label} (${got})`);
};
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log(`  FAIL ${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
  else console.log(`  ok   ${label}`);
};

console.log("\nclock — a laptop 90s behind the server must still measure correctly");
// Local clock reads 90s BEHIND real time. Server says the truth.
const realNow = Date.parse("2026-08-25T10:00:00Z");
const localNow = realNow - 90_000;
// A 40ms exchange straddling localNow.
clock.observe("Tue, 25 Aug 2026 10:00:00 GMT", localNow - 20, localNow + 20);
near("offset recovers the 90s skew", clock.offset, 90_000, 600);

console.log("\nclock — the lowest-round-trip sample wins");
clock.rtt = Infinity; clock.at = 0; clock.offset = 0;
// Slow, LOPSIDED exchange: the server answered early in a 3.1s window, so
// its midpoint estimate is ~1.45s out. This is the sample a tight one must beat.
clock.observe("Tue, 25 Aug 2026 10:00:00 GMT", localNow - 3000, localNow + 100); // 3.1s RTT
const sloppy = clock.offset;
clock.observe("Tue, 25 Aug 2026 10:00:00 GMT", localNow - 10, localNow + 10);     // 20ms RTT, tight
near("sloppy sample is ~1.45s out", sloppy, 91_950, 200);
near("tight sample replaced it", clock.offset, 90_000, 600);
eq("and it actually changed", clock.offset !== sloppy, true);
const tight = clock.offset;
clock.observe("Tue, 25 Aug 2026 10:00:00 GMT", localNow - 2000, localNow + 2000); // sloppy again
eq("a worse sample is ignored while fresh", clock.offset, tight);

console.log("\nclock — junk headers must not poison the offset");
clock.observe(null, localNow, localNow + 5);
clock.observe("not a date", localNow, localNow + 5);
eq("offset survived junk", clock.offset, tight);

console.log("\ntypicalDurationMs — no denominator until there is evidence");
const store = { fix: {}, deploy: {} };
globalThis.localStorage = {
  getItem: () => JSON.stringify(store),
  setItem: () => {},
};
const typical = new Function("project",
  'const DURATION_KEY = "pinstage:durations:" + project;' +
  `${slice(src, "function loadDurations() {")};` +
  `${slice(src, "function typicalDurationMs(phase) {")}; return typicalDurationMs;`
)("test");
eq("0 samples -> null (ring stays indeterminate)", typical("fix"), null);
store.fix = { a: 10_000, b: 20_000 };
eq("2 samples -> still null", typical("fix"), null);
store.fix = { a: 10_000, b: 20_000, c: 300_000 };
eq("3 samples -> median, not mean", typical("fix"), 20_000);
store.fix = { a: 10_000, b: 20_000, c: 30_000, d: 40_000 };
eq("even count -> midpoint", typical("fix"), 25_000);

console.log(fails ? `\n${fails} FAILED\n` : "\nall passed\n");
process.exit(fails ? 1 : 0);
