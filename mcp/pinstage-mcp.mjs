#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
 * pinstage-mcp — an MCP server that lets AI coding agents work your
 * Pinstage issue queue (github.com/teminali/pinstage) as native tools.
 *
 * Claude Code, Codex, or any MCP client can list open issues, read a full
 * thread (with screenshot URLs), reply, resolve, and reopen — the loop
 * becomes: teammate pins an issue on staging → the agent reads it → fixes the
 * code → replies + resolves → redeploys. No REST glue, no scripts.
 *
 * Zero dependencies. Speaks MCP over stdio (newline-delimited JSON-RPC).
 *
 * SETUP (Claude Code):
 *   claude mcp add pinstage -- node /path/to/pinstage-mcp.mjs \
 *     --env-file /path/to/your-app/.env.local
 *
 *   …or with explicit env:
 *     PINSTAGE_SUPABASE_URL=https://<ref>.supabase.co \
 *     PINSTAGE_SERVICE_KEY=<service role key> \
 *     claude mcp add pinstage -- node /path/to/pinstage-mcp.mjs
 *
 * CONFIG (env, or KEY=VALUE lines in the --env-file):
 *   PINSTAGE_SUPABASE_URL   (falls back to NEXT_PUBLIC_SUPABASE_URL)
 *   PINSTAGE_SERVICE_KEY    (falls back to SUPABASE_SERVICE_ROLE_KEY)
 *   PINSTAGE_PROJECT        optional default project filter
 *   PINSTAGE_AUTHOR_NAME    name stamped on replies (default "AI Agent")
 *   PINSTAGE_TABLE_THREADS / PINSTAGE_TABLE_COMMENTS  table overrides
 *
 * The service-role key never leaves this process; the agent only sees tool
 * results. Point the env-file at the same .env.local your app already uses.
 * ═══════════════════════════════════════════════════════════════════════════ */

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

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

/* ── Pinstage store (PostgREST, service role) ──────────────────────────────── */

const HEADERS = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

async function rest(path, init = {}) {
  const res = await fetch(`${URL_BASE.replace(/\/$/, "")}/rest/v1/${path}`, {
    ...init,
    headers: { ...HEADERS, ...init.headers },
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
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

function threadLine({ id, data: d }) {
  return [
    `[${d.status}] ${id}`,
    `  ${d.project ?? "?"} ${d.path ?? "?"}${d.query ?? ""}  (v${d.appVersion ?? "?"}, ${d.viewport ?? "?"})`,
    `  "${d.preview ?? ""}" — ${d.createdBy?.name ?? "?"}, opened ${when(d.createdAt)}, ${d.messageCount ?? 1} comment(s)` +
      (d.resolvedBy ? `, resolved by ${d.resolvedBy.name} ${when(d.resolvedAt)}` : ""),
  ].join("\n");
}

async function threadDetail(id) {
  const t = await getThread(id);
  const cs = await comments(id);
  const lines = [threadLine(t), "", "Thread:"];
  for (const { data: c } of cs) {
    lines.push(`  ${when(c.createdAt)}  ${c.authorName}:`);
    lines.push("    " + String(c.body ?? "").split("\n").join("\n    "));
    for (const a of c.attachments ?? []) lines.push(`    [screenshot] ${a.url}`);
  }
  return lines.join("\n");
}

/* ── tools ─────────────────────────────────────────────────────────────────── */

const TOOLS = [
  {
    name: "pinstage_list_issues",
    description:
      "List Pinstage issue threads (comments pinned on the app by the team). Returns id, status, project, page path, preview, author, activity. Default: open issues only.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["open", "resolved", "all"], description: "Filter by status (default open)" },
        project: { type: "string", description: "Filter by project name" + (DEFAULT_PROJECT ? ` (default ${DEFAULT_PROJECT})` : "") },
      },
    },
    handler: async ({ status = "open", project = DEFAULT_PROJECT }) => {
      let q = `${T_THREADS}?select=id,data&limit=300`;
      if (status !== "all") q += `&data->>status=eq.${status}`;
      if (project) q += `&data->>project=eq.${encodeURIComponent(project)}`;
      const rows = (await rest(q)).sort((a, b) => activity(b.data) - activity(a.data));
      if (!rows.length) return `No ${status === "all" ? "" : status + " "}issues.`;
      return rows.map(threadLine).join("\n\n") + "\n\nUse pinstage_get_issue for the full thread.";
    },
  },
  {
    name: "pinstage_get_issue",
    description:
      "Read one Pinstage issue thread in full: metadata, every comment, and screenshot URLs (fetch a screenshot URL to view it).",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Thread id" } },
      required: ["id"],
    },
    handler: async ({ id }) => threadDetail(id),
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
];

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
    return; // not JSON — ignore
  }
  const { id, method, params } = msg;

  try {
    if (method === "initialize") {
      reply(id, {
        protocolVersion: params?.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "pinstage-mcp", version: "0.3.0" },
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
