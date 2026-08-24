# Pinstage MCP server

This is the part of Pinstage that closes the loop. The toolbar collects
issues from your team; this MCP server hands those issues to an AI coding
agent as native tools. The agent lists the queue, reads a thread with its
screenshots and technical context, fixes the code, replies, resolves, and
mirrors everything to GitHub Issues.

The whole workflow, end to end:

1. A teammate finds a bug on staging, clicks Comment, pins a thread to the
   exact element, and attaches an annotated screenshot. The toolbar records
   what was clicked and what the page was doing at the time.
2. You tell your agent "check staging feedback".
3. The agent calls `pinstage_list_issues` and sees, per issue, the component
   and the source file the pin sits on plus a one-line diagnostics summary.
   It opens the right file directly - usually without fetching a screenshot.
4. The agent replies with what it changed and calls `pinstage_resolve`.
5. The teammate re-checks on staging and reopens the thread if needed.

## Agent Operating Modes & Protocol

When an AI coding assistant connects to Pinstage, it operates across 3 standardized modes:

1. 🔄 **Auto Dev Mode (Continuous Autonomous Loop)**:
   - Polls for newly reported issues across the project.
   - Sets status to `in_progress` via `pinstage_set_status`.
   - Locates exact DOM element and source file with `pinstage_get_context`.
   - Implements and verifies the fix.
   - **Environment Branching**:
     - If reported on **Staging**: sets status `deploying` ➔ deploys to staging ➔ sets status `deployed` ➔ resolves.
     - If reported on **Dev (localhost)**: sets status `deployed` ➔ resolves without triggering staging builds.
   - Loops continuously until stopped by developer.

2. 📦 **Fix Existing Issues & Stop**:
   - Lists active open issues.
   - Fixes and resolves issues in sequence (or smart staging batches) and stops.

3. 🎯 **Fix Specific Issues**:
   - Presents issue queue for the developer to pick which issue(s) to fix.

### Major Staging Issue Safety Guard
- **High Threshold**: Database schema migrations, security/RLS changes, payment processing alterations, or destructive data operations.
- **Protocol**: Major issues are flagged (`[⚠️ Flagged: Major change — awaiting developer review]`), and the agent presents the implementation plan in chat and waits for explicit developer review before executing. Routine UI/UX, styling, and component bugs proceed automatically.

## Why the context matters

A pin without context costs an agent a screenshot fetch (an image is roughly
a thousand tokens) and then a guess at which button was meant. A pin with
context costs three lines:

```
element: <SubmitButton> span.label "Place order" in button[data-testid="checkout-submit"]
source: /src/checkout/SubmitButton.tsx:42
diagnostics: 2 errors, 2 request issues (500 POST /api/orders), 1 warning
```

Component names and source files come from React's and Vue's dev-build
metadata, so they appear on staging builds and vanish on production ones.
Test ids, element text and diagnostics work in any build. Threads pinned
before Pinstage 0.5.0 have none of this, and every tool degrades to exactly
what the thread carries.

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
| `PINSTAGE_GITHUB_API` | no | `https://api.github.com` | API base; for GitHub Enterprise, `https://<host>/api/v3` |

The fallbacks mean that for a typical Supabase app, pointing `--env-file` at
the `.env.local` you already have is a complete setup.

## Tools

### `pinstage_list_issues`

Lists threads: id, status, project, page path, build info, the element and
source file the pin sits on, a diagnostics summary, preview, author, and
activity. Arguments: `status` (`open`, `resolved`, `all`; default `open`)
and `project` (defaults to `PINSTAGE_PROJECT`).

```
[open] d72a79f3-2ed8-470e-a569-cfcfccf6ab19
  checkout-app /checkout?step=2  (v1.2.3, 1440x900)
  element: <SubmitButton> span.label "Place order" in button[data-testid="checkout-submit"]
  source: /src/checkout/SubmitButton.tsx:42
  diagnostics: 2 errors, 2 request issues (500 POST /api/orders), 1 warning
  "Place order does nothing on the second attempt" - Amina K., opened 2026-08-24 16:42, 1 comment(s)
```

### `pinstage_get_issue`

Reads one thread in full: every comment in order, a `[screenshot] <url>`
line per attachment (fetch the URL to view it), a `Context:` block, and a
`Diagnostics:` block. Argument: `id`.

```
Context:
  page       /checkout?step=2
  viewport   1440x900
  build      v1.2.3 · commit a1b2c3d · branch fix/checkout-total
  element    span.label
  testId     checkout-submit  (on the parent button[data-testid="checkout-submit"])
  text       "Place order"
  html       <span class="label"></span>
  selector   #submit > span
  component  <SubmitButton> (react)
  source     /src/checkout/SubmitButton.tsx:42:6
  ancestors  <SubmitButton>[checkout-submit] < <CheckoutForm>[checkout-form]
  browser    Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ...

Diagnostics (2 errors, 2 request issues (500 POST /api/orders), 1 warning, oldest first):
    -12s  console.error  TypeError: Cannot read properties of null (reading 'total')
                         at computeTotal (checkout.ts:88)
    -11s  net            POST /api/orders -> 500 (412ms)
     -3s  rejection      Error: checkout: total is undefined
```

### `pinstage_get_context`

The same context as JSON, for branching on fields rather than parsing lines:
`element`, `framework`, `component`, `source`, `ancestors`, `selector`,
`page`, `build`, `client`, `diagnostics`, `screenshots`, and `searchKeys`.
Argument: `id`.

`searchKeys` is the point of the exercise - the strings most likely to
appear verbatim in your source, most specific first, so the first grep is
usually the last one:

```json
"searchKeys": ["checkout-submit", "checkout-form", "SubmitButton", "CheckoutForm", "Place order"]
```

Test ids from the ancestors are included, because people aim at a button and
hit the label span inside it.

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

- a new thread becomes an issue, with screenshots rendered inline, the
  element, source file and commit in the header, the diagnostics and the
  full context in collapsed `<details>` blocks, and a deep link back to the
  exact pin (`PINSTAGE_APP_URL` + `?mdthread=<id>`)
- new replies become issue comments
- resolved threads close their issue, reopened threads reopen it

Sync state is stored on each thread, so running it twice does nothing extra.
Argument: `repo` (defaults to `PINSTAGE_GITHUB_REPO`). For GitHub Enterprise
set `PINSTAGE_GITHUB_API` to `https://<host>/api/v3`.

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
- The agent can only do what the seven tools allow: read the queue,
  comment, and change thread status. It cannot touch other tables.
- Screenshots live in your public storage bucket; treat their URLs as
  public.
- Diagnostics text comes from the browser and can carry request URLs and
  error messages. Narrow it at the source with the toolbar's
  `diagnostics.ignore` and `diagnostics.redact` options.
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
| No `element` / `source` / `diagnostics` lines | The thread was pinned before 0.5.0, or the app is a production build (React and Vue strip source metadata) - test ids, text and diagnostics should still be there |
| `pinstage_get_context` returns nulls | Same cause; check `selector`, which every version records |

## Testing by hand

The server is plain JSON-RPC on stdio, so you can drive it with `printf`:

```bash
printf '%s\n%s\n%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}' \
 '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"pinstage_list_issues","arguments":{}}}' \
 | node pinstage-mcp.mjs --env-file /path/to/.env.local
```
