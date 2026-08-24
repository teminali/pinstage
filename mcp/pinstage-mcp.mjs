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
  const res = await fetch(`${URL_BASE.replace(/\/$/, "")}/rest/v1/${path}`, {
    ...init,
    headers: { ...HEADERS, ...init.headers },
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  // Prefer: return=minimal answers 201/204 with an EMPTY body - parse text,
  // never res.json() blindly, or inserts crash after succeeding.
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const ts = () => ({ _ts: Date.now() });
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

/* withContext: the list view wants the element and source inline; the detail
 * view suppresses them because the full Context block follows. */
function threadLine({ id, data: d }, withContext = true) {
  const lines = [
    `[${d.status}] ${id}`,
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

const TOOLS = [
  {
    name: "pinstage_list_issues",
    description:
      "List Pinstage issue threads (comments pinned on the app by the team). Returns id, status (open, in_progress, deploying, deployed, resolved), project, page path, the element and source file the pin sits on, a diagnostics summary, preview, author, and activity. Default: active (non-resolved) issues.",
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
      // not rows.map(threadLine): map would pass the index as withContext
      return rows.map((r) => threadLine(r)).join("\n\n") + "\n\nUse pinstage_get_context or pinstage_get_issue for the full thread.";
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
      "Update the live progress status of a Pinstage issue thread. Statuses: \x27in_progress\x27 (agent has begun working on the fix), \x27deploying\x27 (fix is building/deploying to staging), \x27deployed\x27 (fix is live on staging ready to test), \x27open\x27 (reset to open), or \x27resolved\x27 (verified and closed). Optionally posts a comment note.",
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
      const data = {
        ...t.data,
        status,
        lastActivityAt: ts(),
        messageCount: (t.data.messageCount || 0) + (note ? 1 : 0),
      };
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
      await patchThread(id, {
        ...t.data,
        status: "resolved",
        resolvedBy: { uid: "mcp", name: AUTHOR },
        resolvedAt: ts(),
        lastActivityAt: ts(),
        messageCount: (t.data.messageCount || 0) + (note ? 1 : 0),
      });
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
      const data = { ...t.data, status: "open", lastActivityAt: ts(), messageCount: (t.data.messageCount || 0) + (note ? 1 : 0) };
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
