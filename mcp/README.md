# Pinstage MCP server

This is the part of Pinstage that closes the loop. The toolbar collects
issues from your team; this MCP server hands those issues to an AI coding
agent as native tools. The agent lists the queue, reads a thread with its
screenshots, fixes the code, replies, resolves, and mirrors everything to
GitHub Issues.

The whole workflow, end to end:

1. A teammate finds a bug on staging, clicks Comment, pins a thread to the
   exact element, and attaches an annotated screenshot.
2. You tell your agent "check staging feedback".
3. The agent calls `pinstage_list_issues`, reads the thread with
   `pinstage_get_issue`, opens the screenshot URL, and fixes the code.
4. The agent replies with what it changed and calls `pinstage_resolve`.
5. The teammate re-checks on staging and reopens the thread if needed.

One file, zero dependencies, Node 18 or newer. It speaks MCP over stdio
(newline-delimited JSON-RPC), so it works with any MCP client.

## Prerequisites

- Node 18+ on the machine where the agent runs
- The Pinstage schema in your Supabase project
  (see [`../examples/schema.supabase.sql`](../examples/schema.supabase.sql))
- Your Supabase service-role key. The server needs it to read and write the
  queue without a browser session. It stays inside the server process; the
  agent only ever sees tool results.

## Setup

### Claude Code

Option A, per user (one command):

```bash
claude mcp add pinstage -- node /path/to/pinstage/mcp/pinstage-mcp.mjs \
  --env-file /path/to/your-app/.env.local
```

Option B, per project (shared config): create `.mcp.json` in your project
root. Team members get prompted once to approve the server.

```json
{
  "mcpServers": {
    "pinstage": {
      "command": "node",
      "args": [
        "/path/to/pinstage/mcp/pinstage-mcp.mjs",
        "--env-file", "/path/to/your-app/.env.local"
      ],
      "env": {
        "PINSTAGE_PROJECT": "my-web-app",
        "PINSTAGE_AUTHOR_NAME": "Claude (dev)",
        "PINSTAGE_GITHUB_REPO": "owner/repo",
        "PINSTAGE_APP_URL": "https://staging.example.com"
      }
    }
  }
}
```

If the paths are machine specific, add `.mcp.json` to `.gitignore` and keep
a template in your project docs instead.

### Codex CLI

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.pinstage]
command = "node"
args = ["/path/to/pinstage/mcp/pinstage-mcp.mjs", "--env-file", "/path/to/your-app/.env.local"]

[mcp_servers.pinstage.env]
PINSTAGE_PROJECT = "my-web-app"
PINSTAGE_AUTHOR_NAME = "Codex (dev)"
```

### Cursor

Create `.cursor/mcp.json` in your project (same JSON shape as the Claude
Code example above).

### Any other MCP client

Launch command: `node pinstage-mcp.mjs --env-file <path>`. Transport: stdio.
The server implements `initialize`, `tools/list`, `tools/call`, and `ping`.

## Configuration reference

Every setting can come from the process environment or from `KEY=VALUE`
lines in the `--env-file`. Environment wins over the file.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `PINSTAGE_SUPABASE_URL` | yes | falls back to `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `PINSTAGE_SERVICE_KEY` | yes | falls back to `SUPABASE_SERVICE_ROLE_KEY` | service-role key |
| `PINSTAGE_PROJECT` | no | none | default project filter for listing and syncing |
| `PINSTAGE_AUTHOR_NAME` | no | `AI Agent` | name stamped on the agent's replies |
| `PINSTAGE_TABLE_THREADS` | no | `feedbackThreads` | thread table override |
| `PINSTAGE_TABLE_COMMENTS` | no | `feedbackComments` | comment table override |
| `PINSTAGE_GITHUB_REPO` | for the mirror | none | `owner/repo` that receives mirrored issues |
| `PINSTAGE_GITHUB_TOKEN` | no | `GITHUB_TOKEN`, then `gh auth token` | token with issue write access |
| `PINSTAGE_APP_URL` | no | none | app origin, used for deep links in issue bodies |

The fallbacks mean that for a typical Supabase app, pointing `--env-file` at
the `.env.local` you already have is a complete setup.

## Tools

### `pinstage_list_issues`

Lists threads: id, status, project, page path, preview, author, build info,
and activity. Arguments: `status` (`open`, `resolved`, `all`; default
`open`) and `project` (defaults to `PINSTAGE_PROJECT`).

### `pinstage_get_issue`

Reads one thread in full: metadata, every comment in order, and a
`[screenshot] <url>` line for each attachment. Fetch the URL to view the
screenshot. Argument: `id`.

### `pinstage_reply`

Posts a reply into a thread without changing its status. The reply appears
in the toolbar and the admin dashboard under `PINSTAGE_AUTHOR_NAME`.
Arguments: `id`, `text`.

### `pinstage_resolve`

Resolves a thread, optionally posting a closing reply first. Use the note to
say what was actually changed. Arguments: `id`, `note` (optional).

### `pinstage_reopen`

Reopens a resolved thread, optionally with a reply saying why.
Arguments: `id`, `note` (optional).

### `pinstage_sync_github`

Mirrors the queue to GitHub Issues, one way and incrementally:

- a new thread becomes an issue, with screenshots rendered inline and a deep
  link back to the exact pin (`PINSTAGE_APP_URL` + `?mdthread=<id>`)
- new replies become issue comments
- resolved threads close their issue, reopened threads reopen it

Sync state is stored on each thread, so running it twice does nothing extra.
Argument: `repo` (defaults to `PINSTAGE_GITHUB_REPO`).

## CLI mode

The GitHub mirror also runs without any MCP client, for cron or CI:

```bash
node pinstage-mcp.mjs sync-github --env-file /path/to/.env.local
```

Example cron line, hourly:

```
0 * * * * PINSTAGE_GITHUB_REPO=owner/repo node /path/to/pinstage/mcp/pinstage-mcp.mjs sync-github --env-file /path/to/.env.local
```

## Security model

- The service-role key lives only in this process. Tool results contain
  issue text and screenshot URLs, never credentials.
- The agent can only do what the six tools allow: read the queue, comment,
  and change thread status. It cannot touch other tables.
- Screenshots live in your public storage bucket; treat their URLs as
  public.
- The GitHub token is used only for the mirror and is resolved lazily, so
  everything else works without one.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Server missing from the agent's tool list | Config not approved yet (Claude Code prompts once per project), or a wrong path in the config |
| `missing PINSTAGE_SUPABASE_URL / PINSTAGE_SERVICE_KEY` on startup | The `--env-file` path is wrong, or the file lacks the Supabase variables |
| Tools return `401` or `403` | The key is not the service-role key |
| `pinstage_list_issues` returns nothing | The queue is empty, or `PINSTAGE_PROJECT` filters everything out |
| `sync-github` fails with `no GitHub token` | Set `PINSTAGE_GITHUB_TOKEN` or `GITHUB_TOKEN`, or run `gh auth login` |
| Replies crash mid-call | Update the server; versions before 0.4.1 mishandled empty PostgREST responses |

## Testing by hand

The server is plain JSON-RPC on stdio, so you can drive it with `printf`:

```bash
printf '%s\n%s\n%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}' \
 '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"pinstage_list_issues","arguments":{}}}' \
 | node pinstage-mcp.mjs --env-file /path/to/.env.local
```
