#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
 * pinstage-mcp: an MCP server for the Pinstage issue queue
 * https://github.com/teminali/pinstage
 * v0.5.0 · MIT © Teminali
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Lets AI coding agents (Claude Code, Codex, any MCP client) work Pinstage
 * issues as native tools: list the queue, read a full thread with screenshot
 * URLs and technical context, reply, resolve, reopen, and mirror everything
 * to GitHub Issues. The loop: a teammate pins an issue on staging, the agent
 * reads it, fixes the code, replies and resolves, redeploys.
 *
 * Threads carry what the toolbar saw at the moment of the click - the
 * element's test id and text, the React or Vue component, the source file in
 * a dev build, and the console errors and failed requests from just before.
 * That context is rendered into every tool result, and served raw as JSON by
 * pinstage_get_context, so an agent can open the right file without
 * downloading the screenshot.
 *
 * Zero dependencies. Speaks MCP over stdio (newline-delimited JSON-RPC).
 *
 * SETUP (Claude Code):
 *   claude mcp add pinstage -- node /path/to/pinstage-mcp.mjs \
 *     --env-file /path/to/your-app/.env.local
 *
 * CLI MODE (cron / CI, no MCP client needed):
 *   node pinstage-mcp.mjs sync-github --env-file /path/to/.env.local
 *
 * CONFIG (environment variables, or KEY=VALUE lines in the --env-file):
 *   PINSTAGE_SUPABASE_URL    falls back to NEXT_PUBLIC_SUPABASE_URL
 *   PINSTAGE_SERVICE_KEY     falls back to SUPABASE_SERVICE_ROLE_KEY
 *   PINSTAGE_PROJECT         optional default project filter
 *   PINSTAGE_AUTHOR_NAME     name stamped on replies (default "AI Agent")
 *   PINSTAGE_TABLE_THREADS   table override (default "feedbackThreads")
 *   PINSTAGE_TABLE_COMMENTS  table override (default "feedbackComments")
 *   PINSTAGE_GITHUB_REPO     "owner/repo" for the GitHub Issues mirror
 *   PINSTAGE_GITHUB_TOKEN    falls back to GITHUB_TOKEN, then `gh auth token`
 *   PINSTAGE_APP_URL         app origin, used for deep links in issue bodies
 *   PINSTAGE_GITHUB_API      API base (default https://api.github.com; for
 *                            GitHub Enterprise, https://<host>/api/v3)
 *
 * The service-role key never leaves this process; the agent only sees tool
 * results. Point the env-file at the same .env.local your app already uses.
 * ═══════════════════════════════════════════════════════════════════════════ */

import { homedir } from "node:os";
import { join } from "node:path";
import { readdir, readFile, writeFile, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { execSync } from "node:child_process";

/* ── config ────────────────────────────────────────────────────────────────── */

const env = { ...process.env };
const efIdx = process.argv.indexOf("--env-file");
if (efIdx !== -1 && process.argv[efIdx + 1]) {
  for (const line of readFileSync(process.argv[efIdx + 1], "utf8").split("\n")) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=\s*("?)(.*)\2\s*$/);
    if (m && env[m[1]] === undefined) env[m[1]] = m[3];
  }
}

const URL_BASE = env.PINSTAGE_SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = env.PINSTAGE_SERVICE_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
const DEFAULT_PROJECT = env.PINSTAGE_PROJECT || null;
const AUTHOR = env.PINSTAGE_AUTHOR_NAME || "AI Agent";
const T_THREADS = env.PINSTAGE_TABLE_THREADS || "feedbackThreads";
const T_COMMENTS = env.PINSTAGE_TABLE_COMMENTS || "feedbackComments";

if (!URL_BASE || !KEY) {
  console.error("pinstage-mcp: missing PINSTAGE_SUPABASE_URL / PINSTAGE_SERVICE_KEY (or --env-file with NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)");
  process.exit(1);
}

/* GitHub Issues mirror (optional): PINSTAGE_GITHUB_REPO="owner/repo".
 * Token: PINSTAGE_GITHUB_TOKEN → GITHUB_TOKEN → `gh auth token`.
 * PINSTAGE_APP_URL (e.g. the staging origin) makes issue bodies carry a
 * deep link back to the exact pin. */
const GH_REPO = env.PINSTAGE_GITHUB_REPO || null;
const APP_URL = (env.PINSTAGE_APP_URL || "").replace(/\/$/, "");
/* GitHub Enterprise Server lives at https://<host>/api/v3. */
const GH_API = (env.PINSTAGE_GITHUB_API || "https://api.github.com").replace(/\/$/, "");

function ghToken() {
  if (env.PINSTAGE_GITHUB_TOKEN) return env.PINSTAGE_GITHUB_TOKEN;
  if (env.GITHUB_TOKEN) return env.GITHUB_TOKEN;
  try {
    return execSync("gh auth token", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/* ── Pinstage store (PostgREST, service role) ──────────────────────────────── */

const HEADERS = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

async function rest(path, init = {}) {
  const sentAt = Date.now();
  const res = await fetch(`${URL_BASE.replace(/\/$/, "")}/rest/v1/${path}`, {
    ...init,
    headers: { ...HEADERS, ...init.headers },
  });
  clock.observe(res.headers.get("date"), sentAt, Date.now());
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  // Prefer: return=minimal answers 201/204 with an EMPTY body - parse text,
  // never res.json() blindly, or inserts crash after succeeding.
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/* ── clock ─────────────────────────────────────────────────────────────────
 *  This process stamps timestamps that a teammate's BROWSER reads back, and
 *  reads timestamps that browser wrote. A developer laptop whose clock has
 *  drifted (or that just woke from sleep) therefore does not merely mislead
 *  itself - it publishes wrong elapsed times to everyone watching staging.
 *  Every PostgREST response carries a server-generated `Date`, which is the
 *  one clock both ends already share, so calibrate against it and stamp on
 *  that timeline. Deliberate twin of the `clock` object in pinstage.js.   */
const clock = {
  offset: 0,
  rtt: Infinity,
  at: 0,
  observe(header, sentAt, gotAt) {
    const server = Date.parse(header || "");
    if (!Number.isFinite(server)) return;
    const rtt = gotAt - sentAt;
    if (rtt > this.rtt && gotAt - this.at < 300000) return;
    // `Date` is whole-second, so the instant it names is uniformly spread over
    // the second that follows: +500ms is its mean.
    this.offset = server + 500 - (sentAt + gotAt) / 2;
    this.rtt = rtt;
    this.at = gotAt;
  },
  now() {
    return Date.now() + this.offset;
  },
};

const ts = () => ({ _ts: clock.now() });

/* ── status transitions ────────────────────────────────────────────────────
 *  Deliberate twin of `applyStatusTransition` in pinstage.js - change one,
 *  change the other. The phase anchors are stamped ONCE, by the transition
 *  that starts the phase, and never moved again; the toolbar's elapsed timer
 *  reads them. Before this, set_status wrote only `lastActivityAt`, so every
 *  progress note this server posted reset the user-visible timer to zero, and
 *  `claimedBy` - which the conflict lock and the "[IN PROGRESS - Claimed by
 *  …]" header both read - was never written at all.                       */
const WORKING_STATUSES = { in_progress: 1, deploying: 1 };

function applyStatusTransition(data, status, actor) {
  const t = ts();
  data.status = status;
  data.lastActivityAt = t;

  if (WORKING_STATUSES[status]) {
    if (!data.workStartedAt) data.workStartedAt = t;
    if (status === "deploying") {
      if (!data.deployStartedAt) data.deployStartedAt = t;
    } else if (data.deployStartedAt && !data.deployEndedAt) {
      data.deployEndedAt = t;
    }
    if (!data.claimedBy || data.claimedBy.uid !== actor.uid) {
      data.claimedBy = { uid: actor.uid, name: actor.name, author: actor.name, at: t };
    }
    delete data.workEndedAt;
  } else {
    if (data.deployStartedAt && !data.deployEndedAt) data.deployEndedAt = t;
    if (data.workStartedAt && !data.workEndedAt) data.workEndedAt = t;
  }

  if (status === "open") {
    // Released, not finished: the part-measured run is void.
    delete data.workStartedAt;
    delete data.workEndedAt;
    delete data.deployStartedAt;
    delete data.deployEndedAt;
    delete data.claimedBy;
  }
  return data;
}

const MCP_ACTOR = { uid: "mcp", name: AUTHOR };
const when = (t) => (t?._ts ? new Date(t._ts).toISOString().replace("T", " ").slice(0, 16) : "?");
const activity = (d) => d.lastActivityAt?._ts ?? d.createdAt?._ts ?? 0;

async function getThread(id) {
  const rows = await rest(`${T_THREADS}?id=eq.${encodeURIComponent(id)}&select=id,data`);
  if (!rows.length) throw new Error(`no thread with id ${id}`);
  return rows[0];
}

async function comments(threadId) {
  const rows = await rest(`${T_COMMENTS}?select=id,data&data->>threadId=eq.${encodeURIComponent(threadId)}`);
  return rows.sort((a, b) => (a.data.createdAt?._ts ?? 0) - (b.data.createdAt?._ts ?? 0));
}

async function postComment(threadId, text) {
  await rest(T_COMMENTS, {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      id: randomUUID(),
      data: { threadId, authorUid: "mcp", authorName: AUTHOR, body: text, mentions: [], createdAt: ts() },
    }),
  });
}

async function patchThread(id, data) {
  await rest(`${T_THREADS}?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ data }),
  });
}

/* ── technical context ─────────────────────────────────────────────────────
 *  The toolbar records what was clicked (element, component, source file)
 *  and what the page was doing at the time (console errors, failed
 *  requests). Rendering that as flat labelled lines rather than JSON keeps
 *  it cheap to read - for a human skimming the queue and for an agent
 *  deciding which file to open. Threads pinned before v0.5.0 carry none of
 *  it, so every field here is optional and simply drops out.              */

const has = (v) => v !== undefined && v !== null && v !== "";

const sourceRef = (s) => (s?.file ? s.file + (s.line ? ":" + s.line : "") : null);

const shortUrl = (u) => {
  try {
    const x = new URL(u, "http://relative.invalid");
    return x.pathname + (x.search ? "?…" : "");
  } catch {
    return u;
  }
};

const testIdRef = (a) => `${a.tag ?? "*"}[${a.testIdAttr || "data-testid"}="${a.testId}"]`;

/* Enough of the element to recognise it, on one line. */
function elementRef(d) {
  const c = d.context || {};
  const e = c.element || {};
  const bits = [];
  if (c.component) bits.push(`<${c.component}>`);
  if (e.tag) {
    let sel = e.tag;
    if (e.id) sel += "#" + e.id;
    if (e.classes) sel += "." + e.classes.trim().split(/\s+/)[0];
    if (e.testId) sel += `[${e.testIdAttr || "data-testid"}="${e.testId}"]`;
    bits.push(sel);
  }
  if (e.text) bits.push(`"${e.text}"`);
  if (!bits.length) return d.anchor?.selector || null;
  let out = bits.join(" ");
  /* People aim at a button and hit the label span inside it, so the test id
   * worth grepping for is usually a level or two up. */
  if (!e.testId) {
    const owner = (c.ancestors ?? []).find((a) => a.testId);
    if (owner) out += ` in ${testIdRef(owner)}`;
  }
  return out;
}

const isError = (r) => r.kind === "error" || r.kind === "rejection" || (r.kind === "console" && r.level === "error");

/* One line saying whether it is worth reading the diagnostics at all. */
function diagSummary(rows) {
  const errs = rows.filter(isError).length;
  const nets = rows.filter((r) => r.kind === "net");
  const parts = [];
  if (errs) parts.push(`${errs} error${errs > 1 ? "s" : ""}`);
  if (nets.length) {
    const worst = nets.find((n) => !n.status || n.status >= 400) || nets[0];
    parts.push(
      `${nets.length} request issue${nets.length > 1 ? "s" : ""}` +
        ` (${worst.status || "failed"} ${worst.method} ${shortUrl(worst.url)})`
    );
  }
  const rest = rows.length - errs - nets.length;
  if (rest) parts.push(`${rest} warning${rest > 1 ? "s" : ""}`);
  return parts.join(", ") || `${rows.length} entr${rows.length === 1 ? "y" : "ies"}`;
}

/* Labelled rows, aligned, with the labels an agent can scan for. */
function contextBlock(d) {
  const c = d.context || {};
  const e = c.element || {};
  const rows = [];
  const add = (k, v) => { if (has(v)) rows.push([k, v]); };

  add("environment", d.environment || (d.hostname === "localhost" || d.hostname === "127.0.0.1" ? "dev (localhost)" : "staging"));
  add("page", `${d.path ?? "?"}${d.query ?? ""}${d.hash ?? ""}`);
  add(
    "viewport",
    d.viewport
      ? d.viewport +
        (d.dpr && d.dpr !== 1 ? ` @${d.dpr}x` : "") +
        (d.scroll?.y ? `, scrolled ${d.scroll.y}px` : "")
      : null
  );
  add(
    "build",
    [d.appVersion ? "v" + d.appVersion : null, d.commit ? "commit " + d.commit : null, d.branch ? "branch " + d.branch : null]
      .filter(Boolean)
      .join(" · ") || null
  );
  add("element", e.tag ? e.tag + (e.id ? "#" + e.id : "") + (e.classes ? "." + e.classes.trim().split(/\s+/).join(".") : "") : null);
  add("testId", e.testId ? `${e.testId}  (${e.testIdAttr ?? "data-testid"})` : null);
  // surfaced on its own row, because it is the string most worth grepping
  if (!e.testId) {
    const owner = (c.ancestors ?? []).find((a) => a.testId);
    add("testId", owner ? `${owner.testId}  (on the parent ${testIdRef(owner)})` : null);
  }
  add("text", e.text ? `"${e.text}"` : null);
  add(
    "aria",
    [e.role ? "role=" + e.role : null, e.ariaLabel ? `aria-label="${e.ariaLabel}"` : null].filter(Boolean).join(" ") || null
  );
  add("attrs", e.data ? Object.entries(e.data).map(([k, v]) => `${k}="${v}"`).join(" ") : null);
  add("html", e.html);
  add("selector", d.anchor?.selector);
  add("component", c.component ? `<${c.component}>` + (c.framework ? ` (${c.framework})` : "") : null);
  add("source", sourceRef(c.source) ? sourceRef(c.source) + (c.source.column ? ":" + c.source.column : "") : null);
  add(
    "ancestors",
    (c.ancestors ?? [])
      .map((a) => (a.component ? `<${a.component}>` : a.tag) + (a.testId ? `[${a.testId}]` : a.id ? "#" + a.id : ""))
      .join(" < ") || null
  );
  add("browser", d.userAgent);

  if (!rows.length) return [];
  const w = Math.max(...rows.map(([k]) => k.length));
  return ["Context:", ...rows.map(([k, v]) => `  ${k.padEnd(w)}  ${v}`)];
}

/* The console and network tail from the seconds before the pin, oldest
 * first, so it reads as the sequence that led to the complaint. */
function diagnosticsBlock(d) {
  const rows = d.diagnostics;
  if (!Array.isArray(rows) || !rows.length) return [];
  const out = [`Diagnostics (${diagSummary(rows)}, oldest first):`];
  for (const r of rows) {
    const ago = !has(r.ago) ? "" : r.ago === 0 ? "now" : `-${r.ago}s`;
    const kind = r.kind === "console" ? `console.${r.level}` : r.kind;
    let text;
    if (r.kind === "net") {
      text = `${r.method} ${r.url} -> ${r.error ? "failed: " + r.error : r.status}` + (has(r.ms) ? ` (${r.ms}ms)` : "");
    } else {
      text = r.message + (r.at ? `\n${r.at}` : "");
    }
    const head = `  ${ago.padStart(5)}  ${kind.padEnd(13)}  `;
    const cont = " ".repeat(head.length);
    const [first, ...more] = String(text).split("\n");
    out.push(head + first, ...more.map((l) => cont + l.trim()));
  }
  return out;
}


/* ── smart multi-agent conflict avoidance ────────────────────────────────── */

function targetSignature(d) {
  const src = sourceRef(d?.context?.source);
  if (src) return src.split(":")[0];
  if (d?.context?.component) return "<" + d.context.component + ">";
  if (d?.context?.element?.testId) return "[data-testid='" + d.context.element.testId + "']";
  if (d?.path) return d.path;
  return "global";
}

const claimant = (d) => d.claimedBy?.name || d.claimedBy?.author || "Agent";

/* How long the current phase has been running, on the same anchors the
 * toolbar's timer reads - so the queue an agent sees and the badge a
 * teammate watches can never quote different numbers. */
function elapsedTag(d) {
  const start =
    d.status === "deploying"
      ? d.deployStartedAt?._ts ?? d.workStartedAt?._ts
      : d.workStartedAt?._ts;
  const anchor = start ?? d.claimedBy?.at?._ts ?? d.claimedBy?.claimedAt?._ts;
  if (!anchor) return "";
  const s = Math.max(0, Math.floor((clock.now() - anchor) / 1000));
  if (s < 60) return ` · ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return ` · ${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return ` · ${h}h ${String(m % 60).padStart(2, "0")}m`;
}

/* withContext: the list view wants the element and source inline; the detail
 * view suppresses them because the full Context block follows. */
function threadLine({ id, data: d }, withContext = true, lockedSignatures = new Map()) {
  const sig = targetSignature(d);
  let statusHeader = `[${d.status}]`;
  let safetyTag = "";

  if (d.status === "in_progress") {
    statusHeader = `[🔵 IN PROGRESS - Claimed by ${claimant(d)}${elapsedTag(d)}]`;
  } else if (d.status === "deploying") {
    statusHeader = `[🟣 DEPLOYING - Building staging by ${claimant(d)}${elapsedTag(d)}]`;
  } else if (d.status === "deployed") {
    statusHeader = `[🟢 DEPLOYED - Ready to verify]`;
  } else if (d.status === "open") {
    if (lockedSignatures.has(sig)) {
      const locker = lockedSignatures.get(sig);
      safetyTag = `\n  ⚠️ [CONFLICT LOCK - WAITING ON ACTIVE FIX on ${sig}]\n     Another agent is currently modifying ${sig} for issue ${locker.id}. Skip this to avoid merge/code overwrite conflicts.`;
    } else {
      safetyTag = `\n  ✅ [SAFE TO CLAIM - NO CONFLICT] (Target: ${sig})`;
    }
  }

  const lines = [
    `${statusHeader} ${id}${safetyTag}`,
    `  ${d.project ?? "?"} ${d.path ?? "?"}${d.query ?? ""}  ([${d.environment || "staging"}] v${d.appVersion ?? "?"}, ${d.viewport ?? "?"})`,
  ];
  if (withContext) {
    const el = elementRef(d);
    if (el) lines.push(`  element: ${el}`);
    const src = sourceRef(d.context?.source);
    if (src) lines.push(`  source: ${src}`);
    if (Array.isArray(d.diagnostics) && d.diagnostics.length) lines.push(`  diagnostics: ${diagSummary(d.diagnostics)}`);
  }
  lines.push(
    `  "${d.preview ?? ""}" - ${d.createdBy?.name ?? "?"}, opened ${when(d.createdAt)}, ${d.messageCount ?? 1} comment(s)` +
      (d.resolvedBy ? `, resolved by ${d.resolvedBy.name} ${when(d.resolvedAt)}` : "")
  );
  return lines.join("\n");
}

async function threadDetail(id) {
  const t = await getThread(id);
  const cs = await comments(id);
  const lines = [threadLine(t, false), ""];
  const ctx = contextBlock(t.data);
  if (ctx.length) lines.push(...ctx, "");
  const dg = diagnosticsBlock(t.data);
  if (dg.length) lines.push(...dg, "");
  lines.push("Thread:");
  for (const { data: c } of cs) {
    lines.push(`  ${when(c.createdAt)}  ${c.authorName}:`);
    lines.push("    " + String(c.body ?? "").split("\n").join("\n    "));
    for (const a of c.attachments ?? []) lines.push(`    [screenshot] ${a.url}`);
  }
  return lines.join("\n");
}

/* The same context as JSON, for an agent that would rather branch on fields
 * than parse lines. searchKeys is the point of the whole exercise: the
 * strings most likely to appear verbatim in the source, ordered by how
 * specific they are, so the first grep is usually the last one.            */
function contextPayload({ id, data: d }, screenshots) {
  const c = d.context || {};
  const e = c.element || {};
  const ancestors = c.ancestors ?? [];
  const searchKeys = [
    e.testId,
    ...ancestors.map((a) => a.testId),      // the aimed-at parent, usually
    c.component,
    ...ancestors.map((a) => a.component),
    e.id,
    e.ariaLabel,
    e.name,
    e.text,
  ]
    .filter((v) => has(v) && String(v).length > 1)
    .map(String);

  return {
    id,
    status: d.status,
    project: d.project ?? null,
    environment: ((d.environment || "").toLowerCase().includes("dev") || d.hostname === "localhost" || d.hostname === "127.0.0.1") ? "dev" : "staging",
    preview: d.preview ?? null,
    page: { path: d.path ?? null, query: d.query || null, hash: d.hash || null, scroll: d.scroll ?? null },
    build: { appVersion: d.appVersion ?? null, commit: d.commit ?? null, branch: d.branch ?? null },
    client: { viewport: d.viewport ?? null, dpr: d.dpr ?? null, userAgent: d.userAgent ?? null },
    selector: d.anchor?.selector ?? null,
    element: e.tag ? e : null,
    framework: c.framework ?? null,
    component: c.component ?? null,
    source: c.source ?? null,
    ancestors,
    diagnostics: d.diagnostics ?? [],
    screenshots: screenshots ?? [],
    searchKeys: [...new Set(searchKeys)],
  };
}

/* ── GitHub Issues one-way mirror ──────────────────────────────────────────── */
/*  Pinstage stays the primary store (the toolbar needs instant, session-
 *  authenticated writes); GitHub is the portable mirror: thread → issue,
 *  reply → issue comment, resolve/reopen → close/reopen. Sync state rides on
 *  the thread (data.github = {repo, number, url, syncedComments,
 *  syncedStatus}), so the sync is incremental and idempotent.               */

async function gh(pathname, init = {}) {
  const token = ghToken();
  if (!token) throw new Error("no GitHub token (PINSTAGE_GITHUB_TOKEN, GITHUB_TOKEN, or `gh auth login`)");
  const res = await fetch(GH_API + pathname, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "pinstage-mcp",
      ...init.headers,
    },
  });
  if (!res.ok) throw new Error(`GitHub ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

const ghCommentBody = (c) => {
  let body = `**${c.authorName ?? "?"}** (${when(c.createdAt)}):\n\n${c.body ?? ""}`;
  for (const a of c.attachments ?? []) body += `\n\n![screenshot](${a.url})`;
  return body;
};

async function syncGithub(repo = GH_REPO) {
  if (!repo) throw new Error("set PINSTAGE_GITHUB_REPO (owner/repo) or pass `repo`");
  const rows = await rest(`${T_THREADS}?select=id,data&limit=300`);
  const actions = [];

  for (const t of rows) {
    const d = t.data;
    if (DEFAULT_PROJECT && d.project && d.project !== DEFAULT_PROJECT) continue;
    const cs = (await comments(t.id)).map((c) => c.data);
    let g = d.github ? { ...d.github } : null;

    if (!g) {
      const meta = [
        `**Page:** \`${d.path ?? "?"}${d.query ?? ""}\``,
        `**Reported by:** ${d.createdBy?.name ?? "?"} - ${when(d.createdAt)}`,
        `**Build:** v${d.appVersion ?? "?"}${d.commit ? " · " + d.commit : ""}${d.branch ? " · " + d.branch : ""} · ${d.viewport ?? "?"}`,
      ];
      const elRef = elementRef(d);
      if (elRef) meta.push(`**Element:** \`${elRef}\``);
      const srcRef = sourceRef(d.context?.source);
      if (srcRef) meta.push(`**Source:** \`${srcRef}\``);
      if (APP_URL) {
        const sep = d.query ? "&" : "?";
        meta.push(`**Open on the app:** ${APP_URL}${d.path ?? "/"}${d.query ?? ""}${sep}mdthread=${t.id}`);
      }
      let body = meta.join("\n") + "\n";
      const first = cs[0];
      if (first?.body) body += `\n> ${String(first.body).split("\n").join("\n> ")}\n`;
      for (const a of first?.attachments ?? []) body += `\n![screenshot](${a.url})\n`;
      // Collapsed: useful when triaging, noise when scrolling the issue.
      const dg = diagnosticsBlock(d);
      if (dg.length) body += `\n<details><summary>${dg[0].replace(/:$/, "")}</summary>\n\n\`\`\`\n${dg.slice(1).join("\n")}\n\`\`\`\n</details>\n`;
      const ctx = contextBlock(d);
      if (ctx.length) body += `\n<details><summary>Technical context</summary>\n\n\`\`\`\n${ctx.slice(1).join("\n")}\n\`\`\`\n</details>\n`;
      body += `\n---\n_Synced from [Pinstage](https://github.com/teminali/pinstage) · thread \`${t.id}\`_`;

      const payload = { title: `${d.preview || "Pinstage issue"} (${d.path ?? "?"})`, body };
      let issue;
      try {
        issue = await gh(`/repos/${repo}/issues`, {
          method: "POST",
          body: JSON.stringify({ ...payload, labels: ["pinstage", d.project].filter(Boolean) }),
        });
      } catch {
        issue = await gh(`/repos/${repo}/issues`, { method: "POST", body: JSON.stringify(payload) });
      }
      g = { repo, number: issue.number, url: issue.html_url, syncedComments: Math.min(1, cs.length), syncedStatus: "open" };
      actions.push(`created ${repo}#${issue.number} for thread ${t.id}`);
    }

    for (const c of cs.slice(g.syncedComments)) {
      await gh(`/repos/${g.repo}/issues/${g.number}/comments`, { method: "POST", body: JSON.stringify({ body: ghCommentBody(c) }) });
    }
    if (cs.length > g.syncedComments) {
      actions.push(`${cs.length - g.syncedComments} comment(s) → ${g.repo}#${g.number}`);
      g.syncedComments = cs.length;
    }

    const status = d.status === "resolved" ? "resolved" : "open";
    if (status !== g.syncedStatus) {
      await gh(`/repos/${g.repo}/issues/${g.number}`, {
        method: "PATCH",
        body: JSON.stringify(status === "resolved" ? { state: "closed", state_reason: "completed" } : { state: "open" }),
      });
      actions.push(`${g.repo}#${g.number} → ${status === "resolved" ? "closed" : "reopened"}`);
      g.syncedStatus = status;
    }

    if (JSON.stringify(d.github) !== JSON.stringify(g)) await patchThread(t.id, { ...d, github: g });
  }

  return actions.length ? actions.join("\n") : "Everything already in sync.";
}

/* ── tools ─────────────────────────────────────────────────────────────────── */

/* ═══════════════════════════════════════════════════════════════════════════
 * Studio: editing recordings from the agent side
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Pinstage Studio records in the browser and writes each recording into a real
 * folder — by default ~/Documents/pinstage/recordings — because the agent that
 * edits these files runs on the same machine as the browser that made them.
 * Pushing gigabytes of video up to storage and back down again to bridge a gap
 * of zero millimetres would be absurd.
 *
 * What that means for an agent:
 *
 *   • The masters are read-only. `screen.webm` holds the screen and only the
 *     screen — no cursor, no webcam, no zoom, no captions. `camera.webm` holds
 *     the webcam. Never re-encode them; that is what makes an edit reversible.
 *
 *   • `project.json` is the ONE file to change. It is an edit decision list:
 *     which stretches survive, where the camera moves, what the captions say.
 *     Patch it and the open Studio picks the change up within seconds.
 *
 *   • Times are SOURCE milliseconds — where a moment sits in the original
 *     recording — for everything. `clips[]` additionally decides what survives
 *     into the finished film and in what order.
 */

const STUDIO_DIR =
  env.PINSTAGE_STUDIO_DIR || join(homedir(), "Documents", "pinstage", "recordings");

const readJson = async (p) => {
  try {
    return JSON.parse(await readFile(p, "utf8"));
  } catch (e) {
    return null;
  }
};

const sizeOf = async (p) => {
  try {
    return (await stat(p)).size;
  } catch (e) {
    return 0;
  }
};

const humanBytes = (b) =>
  b < 1024 ? b + " B"
  : b < 1048576 ? (b / 1024).toFixed(0) + " KB"
  : b < 1073741824 ? (b / 1048576).toFixed(1) + " MB"
  : (b / 1073741824).toFixed(2) + " GB";

const humanMs = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return m ? `${m}:${String(s % 60).padStart(2, "0")}` : `0:${String(s).padStart(2, "0")}`;
};

async function studioFolders() {
  let names;
  try {
    names = await readdir(STUDIO_DIR, { withFileTypes: true });
  } catch (e) {
    return [];
  }
  const out = [];
  for (const d of names) {
    if (!d.isDirectory()) continue;
    const dir = join(STUDIO_DIR, d.name);
    const project = await readJson(join(dir, "project.json"));
    if (!project) continue;
    const manifest = await readJson(join(dir, "manifest.json"));
    out.push({
      folder: d.name,
      dir,
      project,
      manifest,
      bytes: {
        screen: await sizeOf(join(dir, "screen.webm")),
        camera: await sizeOf(join(dir, "camera.webm")),
        export: await sizeOf(join(dir, "export.webm")),
      },
    });
  }
  return out.sort((a, b) => (b.project.updatedAt || 0) - (a.project.updatedAt || 0));
}

async function findStudio(idOrFolder) {
  const all = await studioFolders();
  if (!all.length) {
    throw new Error(
      `No recordings in ${STUDIO_DIR}. In Studio, open a recording and press "Sync to a folder" once — the browser cannot write there without being granted the folder.`
    );
  }
  const hit =
    all.find((r) => r.folder === idOrFolder) ||
    all.find((r) => r.project.id === idOrFolder) ||
    all.find((r) => r.folder.startsWith(String(idOrFolder))) ||
    (all.length === 1 ? all[0] : null);
  if (!hit) {
    throw new Error(
      `No recording matched "${idOrFolder}". Available: ${all.map((r) => r.folder).join(", ")}`
    );
  }
  return hit;
}

/**
 * Refuse an edit that would break the film rather than writing it and letting
 * the browser fall over. Every rule here corresponds to something that
 * genuinely goes wrong: overlapping clips put one source frame in two places,
 * a caption past the end never shows, a zoom of 12x is unwatchable.
 */
function validateEdit(edit, durationMs) {
  const problems = [];
  const clips = edit.clips || [];
  if (!Array.isArray(clips) || !clips.length) problems.push("edit.clips must hold at least one clip.");
  let prevEnd = -1;
  clips.forEach((c, i) => {
    if (typeof c.srcStart !== "number" || typeof c.srcEnd !== "number")
      problems.push(`clips[${i}] needs numeric srcStart and srcEnd.`);
    else {
      if (c.srcEnd <= c.srcStart) problems.push(`clips[${i}] ends before it starts.`);
      if (c.srcStart < 0 || c.srcEnd > durationMs + 1)
        problems.push(`clips[${i}] runs outside the recording (0–${Math.round(durationMs)}ms).`);
      if (c.srcStart < prevEnd)
        problems.push(`clips[${i}] overlaps the one before it; clips must be in source order and not overlap.`);
      prevEnd = c.srcEnd;
    }
    if (c.speed != null && (c.speed < 0.25 || c.speed > 4))
      problems.push(`clips[${i}].speed must be between 0.25 and 4.`);
  });
  (edit.segments || []).forEach((z, i) => {
    if (z.scale != null && (z.scale < 1 || z.scale > 4)) problems.push(`segments[${i}].scale must be 1–4.`);
    if (z.x != null && (z.x < 0 || z.x > 1)) problems.push(`segments[${i}].x must be 0–1.`);
    if (z.y != null && (z.y < 0 || z.y > 1)) problems.push(`segments[${i}].y must be 0–1.`);
    if (z.end != null && z.start != null && z.end <= z.start)
      problems.push(`segments[${i}] ends before it starts.`);
  });
  (edit.overlays || []).forEach((o, i) => {
    if (o.type === "caption") {
      if (!o.text) problems.push(`overlays[${i}] is a caption with no text.`);
      if (o.start > durationMs) problems.push(`overlays[${i}] starts after the recording ends.`);
    }
  });
  return problems;
}

/** Deep merge, with arrays replaced wholesale — a half-merged clip list is nonsense. */
function mergeDeep(base, patch) {
  if (Array.isArray(patch) || patch === null || typeof patch !== "object") return patch;
  const out = { ...(base || {}) };
  for (const k of Object.keys(patch)) out[k] = mergeDeep(base ? base[k] : undefined, patch[k]);
  return out;
}

function describeStudio(r) {
  const p = r.project;
  const e = p.edit || {};
  const clips = e.clips || [];
  const kept = clips.reduce((n, c) => n + (c.srcEnd - c.srcStart) / (c.speed || 1), 0);
  const lines = [
    `${p.name}`,
    `  folder    ${r.folder}`,
    `  recorded  ${humanMs(p.durationMs || 0)} · ${r.manifest?.assets?.screen?.width || "?"}×${r.manifest?.assets?.screen?.height || "?"}`,
    `  edit      ${humanMs(kept)} in ${clips.length} clip${clips.length === 1 ? "" : "s"}` +
      `, ${(e.segments || []).length} zooms, ${(e.overlays || []).filter((o) => o.type === "caption").length} captions` +
      `, ${(e.camShots || []).length} face shots`,
    `  output    ${(p.output && p.output.preset) || "1080p"}`,
    `  assets    screen ${humanBytes(r.bytes.screen)}` +
      (r.bytes.camera ? ` · camera ${humanBytes(r.bytes.camera)}` : "") +
      (r.bytes.export ? ` · last render ${humanBytes(r.bytes.export)}` : " · not rendered yet"),
  ];
  if (r.manifest?.assets?.pointer?.available === false)
    lines.push(`  note      no pointer track — a window or screen capture, so zooms must be placed by hand`);
  return lines.join("\n");
}

const STUDIO_TOOLS = [
  {
    name: "pinstage_studio_list",
    description:
      "List the screen recordings Pinstage Studio has written to this machine, with the state of each edit: how long the cut currently runs, how many clips, zooms, captions and webcam shots it has, and which assets exist. Start here.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const all = await studioFolders();
      if (!all.length)
        return `No recordings in ${STUDIO_DIR}.\n\nIn Studio, open a recording and press "Sync to a folder" once. The browser cannot write to a folder without being granted it, so this is a one-time step per machine.`;
      return (
        `${all.length} recording${all.length === 1 ? "" : "s"} in ${STUDIO_DIR}\n\n` +
        all.map(describeStudio).join("\n\n")
      );
    },
  },
  {
    name: "pinstage_studio_get",
    description:
      "The full edit decision list for one recording — clips, zoom segments, camera shots, captions, style and output settings — plus the asset manifest saying what each file is and when to use it. Read this before patching.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Folder name or project id (optional when there is only one)" } },
    },
    handler: async ({ id }) => {
      const r = await findStudio(id);
      return JSON.stringify({ folder: r.folder, dir: r.dir, project: r.project, manifest: r.manifest }, null, 2);
    },
  },
  {
    name: "pinstage_studio_patch",
    description:
      "Change the edit. Give a partial project — usually just an `edit` object — and it is merged into project.json; arrays replace wholesale rather than merging element-wise. The open Studio picks the change up within a few seconds. Never touch screen.webm or camera.webm: they are the masters, and every effect is applied at render time so an edit can always be redone.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Folder name or project id" },
        patch: {
          type: "object",
          description:
            "Partial project to merge. Times are SOURCE milliseconds. e.g. {\"edit\":{\"clips\":[{\"srcStart\":0,\"srcEnd\":12000,\"speed\":1}],\"overlays\":[{\"id\":\"c1\",\"type\":\"caption\",\"start\":1500,\"end\":4200,\"text\":\"Open Settings\",\"style\":\"clean\",\"y\":0.86}]}}",
        },
      },
      required: ["patch"],
    },
    handler: async ({ id, patch }) => {
      const r = await findStudio(id);
      const next = mergeDeep(r.project, patch);
      const problems = validateEdit(next.edit || {}, next.durationMs || 0);
      if (problems.length)
        return "Refused — that edit would not render:\n" + problems.map((p) => "  · " + p).join("\n");
      next.updatedAt = Date.now();
      await writeFile(join(r.dir, "project.json"), JSON.stringify(next, null, 2));
      const e = next.edit || {};
      const kept = (e.clips || []).reduce((n, c) => n + (c.srcEnd - c.srcStart) / (c.speed || 1), 0);
      return (
        `Patched ${r.folder}.\n` +
        `  cut now runs ${humanMs(kept)} in ${(e.clips || []).length} clip(s)\n` +
        `  ${(e.segments || []).length} zooms · ${(e.overlays || []).filter((o) => o.type === "caption").length} captions · ${(e.camShots || []).length} face shots\n` +
        `Studio will show this within a few seconds if it is open on that recording.`
      );
    },
  },
  {
    name: "pinstage_studio_cut_silence",
    description:
      "Drop the stretches where nothing happened. Uses the pointer track: any run longer than `minGapMs` with no click, keystroke or pointer movement becomes a gap between clips. The single highest-value edit on a screen recording, because dead air is what makes a tutorial feel long.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        minGapMs: { type: "number", description: "Shortest stretch of nothing worth cutting (default 2500)" },
        padMs: { type: "number", description: "Breathing room kept either side of a cut (default 350)" },
        dryRun: { type: "boolean", description: "Report what would be cut without changing anything" },
      },
    },
    handler: async ({ id, minGapMs = 2500, padMs = 350, dryRun }) => {
      const r = await findStudio(id);
      const track = await readJson(join(r.dir, "track.json"));
      if (!track) return "That recording has no track.json, so there is no activity to read.";
      const dur = r.project.durationMs || 0;
      const beats = []
        .concat((track.clicks || []).filter((c) => c.kind === "down").map((c) => c.t))
        .concat((track.keys || []).map((k) => k.t))
        .concat((track.moves || []).map((m) => m.t))
        .sort((a, b) => a - b);
      if (!beats.length) return "The pointer track is empty — nothing to judge activity by.";

      const keep = [];
      let from = 0;
      let last = 0;
      for (const t of beats) {
        if (t - last > minGapMs) {
          const end = Math.min(dur, last + padMs);
          if (end - from > 400) keep.push({ srcStart: from, srcEnd: end });
          from = Math.max(0, t - padMs);
        }
        last = t;
      }
      if (dur - from > 400) keep.push({ srcStart: from, srcEnd: dur });

      const kept = keep.reduce((n, c) => n + (c.srcEnd - c.srcStart), 0);
      const removed = dur - kept;
      if (!keep.length || removed < 500)
        return `Nothing worth cutting: no gap longer than ${minGapMs}ms without activity.`;
      const summary =
        `${humanMs(dur)} → ${humanMs(kept)} in ${keep.length} clips, removing ${humanMs(removed)} of dead air.`;
      if (dryRun) return "Would cut: " + summary + "\n(dryRun — nothing was changed)";

      const next = { ...r.project };
      next.edit = {
        ...next.edit,
        clips: keep.map((c, i) => ({ id: "cut-" + i, srcStart: c.srcStart, srcEnd: c.srcEnd, speed: 1, volume: 1, transitionMs: 0 })),
      };
      const problems = validateEdit(next.edit, dur);
      if (problems.length) return "Refused — the result would not render:\n" + problems.map((p) => "  · " + p).join("\n");
      next.updatedAt = Date.now();
      await writeFile(join(r.dir, "project.json"), JSON.stringify(next, null, 2));
      return "Cut: " + summary;
    },
  },
];

const TOOLS = [
  {
    name: "pinstage_list_issues",
    description:
      "List Pinstage issue threads. When you pick an issue to work on, you MUST immediately call pinstage_set_status with 'in_progress' before writing code or running build commands so the live UI badge pulses on the user's screen.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["active", "open", "in_progress", "deploying", "deployed", "resolved", "all"],
          description: "Filter by status (default active: open, in_progress, deploying, deployed)",
        },
        project: { type: "string", description: "Filter by project name" + (DEFAULT_PROJECT ? ` (default ${DEFAULT_PROJECT})` : "") },
      },
    },
    handler: async ({ status = "active", project = DEFAULT_PROJECT }) => {
      let q = `${T_THREADS}?select=id,data&limit=300`;
      if (status === "active") {
        q += `&data->>status=neq.resolved`;
      } else if (status !== "all") {
        q += `&data->>status=eq.${status}`;
      }
      if (project) q += `&data->>project=eq.${encodeURIComponent(project)}`;
      const rows = (await rest(q)).sort((a, b) => activity(b.data) - activity(a.data));
      if (!rows.length) return `No ${status === "all" ? "" : status + " "}issues.`;

      // Build locked file signatures map from active in_progress / deploying threads
      const lockedSignatures = new Map();
      rows.forEach((r) => {
        const st = r.data?.status;
        if (st === "in_progress" || st === "deploying") {
          const sig = targetSignature(r.data);
          if (sig && sig !== "global") {
            lockedSignatures.set(sig, { id: r.id, author: claimant(r.data || {}) });
          }
        }
      });

      const protocolHeader = "================================================================================\nPINSTAGE AUTONOMOUS DEV & VERIFICATION PROTOCOL (V2.0.0 LOCKED CONTRACT):\n1. SELECT SAFE ISSUE:\n   • Pick a [SAFE TO CLAIM - NO CONFLICT] issue (marked with green check).\n   • Do NOT pick [CONFLICT LOCK] issues while another agent is modifying the target file.\n2. MANDATORY FIRST TOOL CALL:\n   • Immediately call `pinstage_set_status({ id: \"<ID>\", status: \"in_progress\" })` BEFORE reading files or writing code.\n   • This claims the file lock and activates the live circular progress timer on the user screen.\n3. SURGICAL FIX & NON-REGRESSION GUARANTEE:\n   • Locate target code via `pinstage_get_context` and searchKeys.\n   • Make surgical, precise edits. Do NOT break existing features, layouts, or translations.\n   • Preserve all existing types, props, and handlers. Never introduce regressions.\n4. RIGOROUS END-TO-END VERIFICATION:\n   • Always cross-check, double-check, and verify before moving to another issue.\n   • Run type check (e.g. `tsc --noEmit`) and build checks to confirm zero errors.\n5. DEPLOY & RESOLUTION LIFECYCLE:\n   • Staging: status `deploying` -> run deploy script -> status `deployed` -> `pinstage_resolve`.\n   • Dev: status `deployed` -> `pinstage_resolve`.\n================================================================================\n";

      return protocolHeader + rows.map((r) => threadLine(r, true, lockedSignatures)).join("\n\n") + "\n\nUse pinstage_get_context or pinstage_get_issue for the full thread.";
    },
  },
  {
    name: "pinstage_get_issue",
    description:
      "Read one Pinstage issue thread in full: every comment, screenshot URLs (fetch one to view it), the technical context of the click (element, test id, text, component, source file in a dev build, CSS selector, build and browser), and the console errors and failed requests from just before the pin. Usually enough to find the code without opening the screenshot.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Thread id" } },
      required: ["id"],
    },
    handler: async ({ id }) => threadDetail(id),
  },
  {
    name: "pinstage_get_context",
    description:
      "The technical context of one Pinstage issue as JSON: clicked element (tag, id, classes, test id, text, attributes, outer tag), React/Vue component and source file, ancestor trail, CSS selector, page and build info, the console/network diagnostics captured at pin time, screenshot URLs, and searchKeys - the strings most likely to appear verbatim in the source. Use this to locate the code before reading any files.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Thread id" } },
      required: ["id"],
    },
    handler: async ({ id }) => {
      const t = await getThread(id);
      const shots = (await comments(id)).flatMap((c) => (c.data.attachments ?? []).map((a) => a.url));
      return JSON.stringify(contextPayload(t, shots), null, 2);
    },
  },
  {
    name: "pinstage_reply",
    description: "Post a reply into a Pinstage issue thread (without changing its status).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Thread id" },
        text: { type: "string", description: "Reply text" },
      },
      required: ["id", "text"],
    },
    handler: async ({ id, text }) => {
      const t = await getThread(id);
      await postComment(id, text);
      await patchThread(id, { ...t.data, lastActivityAt: ts(), messageCount: (t.data.messageCount || 0) + 1 });
      return `Replied on ${id}.`;
    },
  },
  {
    name: "pinstage_set_status",
    description:
      "MANDATORY FIRST STEP: Update issue status to 'in_progress' as soon as you start working on an issue. Statuses: 'in_progress' (agent coding fix - triggers blue pulse on UI), 'deploying' (building/deploying - triggers purple pulse), 'deployed' (live ready to test - emerald), 'open' (reset), or 'resolved' (verified & closed).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Thread id" },
        status: {
          type: "string",
          enum: ["open", "in_progress", "deploying", "deployed", "resolved"],
          description: "New status for the issue",
        },
        note: { type: "string", description: "Optional progress note or reply" },
      },
      required: ["id", "status"],
    },
    handler: async ({ id, status, note }) => {
      const t = await getThread(id);
      if (note) await postComment(id, note);
      const data = applyStatusTransition({ ...t.data }, status, MCP_ACTOR);
      data.messageCount = (t.data.messageCount || 0) + (note ? 1 : 0);
      if (status === "resolved") {
        data.resolvedBy = { uid: "mcp", name: AUTHOR };
        data.resolvedAt = ts();
      } else if (data.resolvedBy) {
        delete data.resolvedBy;
        delete data.resolvedAt;
      }
      await patchThread(id, data);
      return `Status of ${id} set to '${status}'${note ? " with note" : ""}.`;
    },
  },
  {
    name: "pinstage_resolve",
    description:
      "Resolve a Pinstage issue thread, optionally posting a closing reply first (say what was fixed). Do this after the fix is actually made.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Thread id" },
        note: { type: "string", description: "Optional closing reply, e.g. what was changed" },
      },
      required: ["id"],
    },
    handler: async ({ id, note }) => {
      const t = await getThread(id);
      if (note) await postComment(id, note);
      const data = applyStatusTransition({ ...t.data }, "resolved", MCP_ACTOR);
      data.resolvedBy = { uid: "mcp", name: AUTHOR };
      data.resolvedAt = ts();
      data.messageCount = (t.data.messageCount || 0) + (note ? 1 : 0);
      await patchThread(id, data);
      return `Resolved ${id}${note ? " with a closing reply" : ""}.`;
    },
  },
  {
    name: "pinstage_reopen",
    description: "Reopen a resolved Pinstage issue thread, optionally posting a reply saying why.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Thread id" },
        note: { type: "string", description: "Optional reply explaining the reopen" },
      },
      required: ["id"],
    },
    handler: async ({ id, note }) => {
      const t = await getThread(id);
      if (note) await postComment(id, note);
      const data = applyStatusTransition({ ...t.data }, "open", MCP_ACTOR);
      data.messageCount = (t.data.messageCount || 0) + (note ? 1 : 0);
      delete data.resolvedBy;
      delete data.resolvedAt;
      await patchThread(id, data);
      return `Reopened ${id}.`;
    },
  },
  {
    name: "pinstage_sync_github",
    description:
      "Mirror the Pinstage queue to GitHub Issues (one-way, incremental, idempotent): new threads become issues (screenshots inline, deep link back to the pin), new replies become issue comments, resolved/reopened states close/reopen the issue.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "owner/repo" + (GH_REPO ? ` (default ${GH_REPO})` : " (required - no PINSTAGE_GITHUB_REPO configured)") },
      },
    },
    handler: async ({ repo }) => syncGithub(repo || GH_REPO),
  },
  ...STUDIO_TOOLS,
];

/* ── CLI mode: `node pinstage-mcp.mjs sync-github` (for cron / CI) ─────────── */

if (process.argv.includes("sync-github")) {
  try {
    console.log(await syncGithub());
    process.exit(0);
  } catch (e) {
    console.error("sync-github failed:", e.message);
    process.exit(1);
  }
}

/* ── MCP over stdio (newline-delimited JSON-RPC 2.0) ───────────────────────── */

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  line = line.trim();
  if (!line) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // not JSON - ignore
  }
  const { id, method, params } = msg;

  try {
    if (method === "initialize") {
      reply(id, {
        protocolVersion: params?.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "pinstage-mcp", version: "0.5.0" },
      });
    } else if (method === "notifications/initialized" || method?.startsWith("notifications/")) {
      // notifications need no response
    } else if (method === "ping") {
      reply(id, {});
    } else if (method === "tools/list") {
      reply(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    } else if (method === "tools/call") {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return fail(id, -32602, `unknown tool: ${params?.name}`);
      try {
        const text = await tool.handler(params?.arguments || {});
        reply(id, { content: [{ type: "text", text }] });
      } catch (e) {
        reply(id, { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true });
      }
    } else if (id !== undefined) {
      fail(id, -32601, `method not found: ${method}`);
    }
  } catch (e) {
    if (id !== undefined) fail(id, -32603, e.message);
  }
});
