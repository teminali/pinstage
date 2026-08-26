#!/usr/bin/env node
/**
 * Render one Pinstage Studio folder with Remotion.
 *
 *   node render.mjs                          the only recording, or the newest
 *   node render.mjs my-walkthrough-ab12cd34  a specific folder
 *   node render.mjs --dir /path/to/folder    anywhere
 *   node render.mjs --preset 2K --out cut.mp4
 *
 * Reads ~/Documents/pinstage/recordings (or PINSTAGE_STUDIO_DIR), takes the
 * project.json as the edit, and writes the result back INTO the same folder —
 * next to the masters that produced it, which is where anything looking for it
 * will look.
 *
 * The masters are symlinked into public/ rather than copied. A three gigabyte
 * screen recording should not be duplicated to be read.
 */
import { homedir } from "node:os";
import { join, basename, resolve } from "node:path";
import { readdir, readFile, mkdir, rm, symlink, stat, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";

const HERE = new URL(".", import.meta.url).pathname;
const STUDIO_DIR = process.env.PINSTAGE_STUDIO_DIR || join(homedir(), "Documents", "pinstage", "recordings");

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));

const readJson = async (p) => JSON.parse(await readFile(p, "utf8"));

async function pickFolder() {
  const explicit = flag("dir");
  if (explicit) return resolve(explicit);
  if (!existsSync(STUDIO_DIR)) {
    console.error(
      `Nothing in ${STUDIO_DIR}.\nIn Studio, open a recording and press "Sync to a folder" once — the browser cannot write there without being granted the folder.`
    );
    process.exit(1);
  }
  const entries = await readdir(STUDIO_DIR, { withFileTypes: true });
  const dirs = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const d = join(STUDIO_DIR, e.name);
    if (existsSync(join(d, "project.json"))) dirs.push(d);
  }
  if (!dirs.length) {
    console.error(`No folder under ${STUDIO_DIR} contains a project.json.`);
    process.exit(1);
  }
  if (positional[0]) {
    const want = dirs.find((d) => basename(d) === positional[0] || basename(d).startsWith(positional[0]));
    if (!want) {
      console.error(`No folder matched "${positional[0]}". Available:\n  ` + dirs.map(basename).join("\n  "));
      process.exit(1);
    }
    return want;
  }
  if (dirs.length === 1) return dirs[0];
  const withTime = await Promise.all(dirs.map(async (d) => ({ d, t: (await stat(join(d, "project.json"))).mtimeMs })));
  withTime.sort((a, b) => b.t - a.t);
  console.log(`Several recordings; taking the most recently edited (${basename(withTime[0].d)}).`);
  return withTime[0].d;
}

/** The picture's real shape, straight from the file rather than from a sidecar. */
async function probeSource(file) {
  return new Promise((res) => {
    const p = spawn("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file]);
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", () => {
      const [w, h] = out.trim().split(",").map(Number);
      res(w && h ? { width: w, height: h } : null);
    });
    p.on("error", () => res(null));
  });
}

const dir = await pickFolder();
const project = await readJson(join(dir, "project.json"));
const track = existsSync(join(dir, "track.json"))
  ? await readJson(join(dir, "track.json"))
  : { surface: { w: 1920, h: 1080 }, moves: [], clicks: [], keys: [] };
const manifest = existsSync(join(dir, "manifest.json")) ? await readJson(join(dir, "manifest.json")) : null;

if (flag("preset")) project.output = { ...(project.output || {}), preset: flag("preset") };

const screen = join(dir, "screen.webm");
if (!existsSync(screen)) {
  console.error(`No screen.webm in ${dir} — there is nothing to render.`);
  process.exit(1);
}
const camera = existsSync(join(dir, "camera.webm")) ? join(dir, "camera.webm") : null;

const probed = (await probeSource(screen)) || {
  width: manifest?.assets?.screen?.width || track.surface?.w || 1920,
  height: manifest?.assets?.screen?.height || track.surface?.h || 1080,
};

// Remotion serves from public/; symlink so nothing is duplicated.
const pub = join(HERE, "public");
await rm(pub, { recursive: true, force: true });
await mkdir(pub, { recursive: true });
await symlink(screen, join(pub, "screen.webm")).catch(() => copyFile(screen, join(pub, "screen.webm")));
if (camera) await symlink(camera, join(pub, "camera.webm")).catch(() => copyFile(camera, join(pub, "camera.webm")));

const props = {
  project,
  track,
  screenSrc: "screen.webm",
  cameraSrc: camera ? "camera.webm" : null,
  sourceWidth: probed.width,
  sourceHeight: probed.height,
};

const outName = flag("out", "render.mp4");
const outPath = join(dir, outName);
const propsFile = join(HERE, ".props.json");
await (await import("node:fs/promises")).writeFile(propsFile, JSON.stringify(props));

const clips = project.edit?.clips || [];
const kept = clips.reduce((n, c) => n + (c.srcEnd - c.srcStart) / (c.speed || 1), 0);
console.log(`\n${project.name}`);
console.log(`  folder  ${basename(dir)}`);
console.log(`  edit    ${(kept / 1000).toFixed(1)}s in ${clips.length} clip(s) · ${(project.edit?.segments || []).length} zooms`);
console.log(`  source  ${probed.width}×${probed.height}`);
console.log(`  preset  ${project.output?.preset || "1080p"}`);
console.log(`  writing ${outPath}\n`);

const child = spawn(
  "npx",
  ["remotion", "render", "src/index.ts", "PinstageStudio", outPath, "--props=" + propsFile, "--log=info"],
  { cwd: HERE, stdio: "inherit" }
);
child.on("close", (code) => {
  rm(propsFile, { force: true });
  if (code === 0) console.log(`\nDone: ${outPath}`);
  process.exit(code || 0);
});
