<p align="center">
  <img src="assets/logo-mark.png" width="88" alt="Pinstage logo">
</p>

# Pinstage

**Pin comments on your staging environment.**

Pinstage is a Figma-style comment layer for your own product. Your team
clicks anywhere on a page, pins a thread to that spot, attaches annotated
screenshots, and @mentions teammates. Issues land in your own database, so
your admin dashboard, your scripts, and your AI coding agent can all read
and resolve the same queue.

One file. Zero dependencies. MIT licensed.

Built by [Teminali](https://github.com/teminali) and used in production on
[M-Digital](https://mhasibudigital.com)'s staging environment.

## Features

- **Comment mode**: click anywhere, a numbered pin lands on that element, a
  thread opens. Pins re-anchor by CSS selector, survive SPA route changes,
  and reposition on scroll.
- **Screenshots**: capture the current tab natively (no libraries), then
  annotate with crop, pen, rectangle, arrow, three ink colors, and undo.
  You can also paste an image or pick one from disk.
- **Threads**: replies, resolve and reopen, and deep links. Opening
  `?mdthread=<id>` scrolls to the pin and opens the thread.
- **@mentions**: autocomplete from your team roster, delivered through your
  own notification system.
- **Inbox**: every open and resolved thread across the app, one click from
  the toolbar.
- **Team gated**: Pinstage renders nothing unless your backend says the
  signed-in user is on the team.
- **Technical context**: each thread records what was actually clicked - the
  element's test id and text, the React or Vue component behind it, the
  source file in a dev build - along with the console errors and failed
  requests from the seconds before the pin.
- **AI ready**: a bundled MCP server turns the queue into native tools for
  Claude Code, Codex, or any MCP client, technical context included.
- **GitHub Issues mirror**: threads sync one way into a repo you choose.

## Quick start

Serve `pinstage.js` from your app and initialize it on the pages where it
should exist. Usually that means your staging build only.

```html
<script src="/toolbar/pinstage.js"></script>
<script>
  Pinstage.init({
    project: "my-web-app",
    environmentLabel: "Staging",
    appVersion: "1.2.3",
    adapter: Pinstage.supabaseAdapter({
      url: "https://<ref>.supabase.co",
      anonKey: "<anon key>",
      getToken: async () =>
        (await supabase.auth.getSession()).data.session?.access_token ?? null,
    }),
  });
</script>
```

Create the tables with [`examples/schema.supabase.sql`](examples/schema.supabase.sql),
add your first team members, and the toolbar appears for them on the next
page load.

## How it works

Pinstage has no server of its own. The toolbar talks to your backend with
the signed-in user's own token, and your row-level security decides what is
allowed. Pinstage is UI, not a security boundary.

The host app decides where the toolbar exists:

- **Staging**: load the script, done. The toolbar is visible to team members.
- **Production**: pass `startHidden: true`. Pinstage boots as a small dot and
  shows no pins until the user expands it, so comments never float around
  for someone who did not ask. The choice is remembered per user.
- **Everyone else sees nothing.** Users who are not on the team roster get
  no toolbar, no pins, and no way to read threads.

## Backends and the adapter interface

The UI core talks to a small adapter. The built-in Supabase adapter is one
implementation. To use another backend (REST, GraphQL, Firebase), implement
these methods and pass your object as `adapter`:

```ts
interface Adapter {
  getIdentity():                Promise<{uid, name, email} | null>;  // null: toolbar stays invisible
  listTeam():                   Promise<Array<{uid, name, email?, role?}>>;
  listThreads(filter: {project, path?, status}): Promise<Array<{id, data}>>;
  getThread(id):                Promise<{id, data} | null>;
  createThread(row: {id, data}): Promise<void>;
  updateThreadData(id, data):   Promise<void>;         // full replace of data
  listComments(threadId):       Promise<Array<{id, data}>>;
  addComment(row: {id, data}):  Promise<void>;
  notifyMentions?(p): Promise<void>;                   // optional
  uploadAttachment?(blob, {threadId}): Promise<{url}>; // optional, enables screenshots
}
```

The data shapes Pinstage writes:

```
thread.data  = { project, path, query, hash, anchor, context, diagnostics,
                 preview,
                 status: "open" | "resolved",
                 createdBy: {uid, name, email},
                 createdAt: {_ts}, lastActivityAt: {_ts}, messageCount,
                 appVersion, commit, branch,
                 viewport, dpr, scroll: {x, y}, userAgent,
                 resolvedBy?, resolvedAt? }

context      = { element: {tag, id, classes, testId, testIdAttr, text, html,
                           data, role, ariaLabel, name, type, href, ...},
                 framework: "react" | "vue",
                 component, source: {file, line, column},
                 ancestors: [{tag, id, testId, testIdAttr, component}] }

diagnostics  = [ {kind: "console", level, message, t, ago}
               | {kind: "error" | "rejection", message, at, t, ago}
               | {kind: "net", method, url, status, ms, error, t, ago} ]

comment.data = { threadId, authorUid, authorName, body,
                 mentions: [uid], attachments: [{url, w, h}],
                 createdAt: {_ts} }
```

Thread timestamps are `{_ts: <epoch ms>}` objects so they serialize cleanly
through JSON stores. Diagnostics entries are a flat log rather than thread
metadata, so they carry a raw epoch `t` plus `ago` in seconds.

`context` and `diagnostics` are absent on threads pinned before 0.5.0, and
`context` is `null` if the fingerprint could not be read. Every reader
degrades to whatever the thread actually has.

## Supabase adapter reference

```js
Pinstage.supabaseAdapter({
  url, anonKey,
  getToken: async () => "<user JWT or null>",

  // Optional. Defaults shown.
  tables: {
    team: "mdTeamMembers",
    threads: "feedbackThreads",
    comments: "feedbackComments",
    notifications: "notifications",
  },
  uidFromClaims: (claims) => claims.app_metadata?.firebase_uid ?? claims.sub,
  adminSelfRegister: {          // lets platform admins auto-join the roster
    usersTable: "users",
    roleSelect: "data->>role",  // PostgREST select expression
    nameSelect: "data->>fullName",
    adminRole: "admin",         // for a boolean flag use "data->>isAdmin" and "true"
  },
  mentionType: "md_toolbar_mention",
  storage: {                    // screenshots go to a PUBLIC bucket with an
    bucket: "uploads",          // authenticated INSERT policy.
    prefix: "pinstage",         // storage: false disables attachments.
  },
})
```

## Technical context

The distance between "the button does nothing" and the line of code is
usually one grep - if you know the test id, the component name, or the
source file. Pinstage reads all three off the DOM at the moment of the
click, and records what the page was doing at the time.

| Field | What it holds |
|---|---|
| `context.element` | tag, id, classes, test id (`data-testid`, `data-cy`, `data-qa`, ...), `role` and `aria-label`, `name` / `type` / `href`, the visible text, the remaining `data-*`, and the element's open tag |
| `context.component` | the React or Vue component that owns the element |
| `context.source` | `{file, line, column}` - the JSX or SFC it was compiled from |
| `context.ancestors` | the nearest parents carrying a test id, an id, or a component boundary |
| `diagnostics` | console errors and warnings, uncaught exceptions, promise rejections, and failed or slow requests from the seconds before the pin |
| `commit`, `branch` | which tree the report came from, if you pass them |

Component and source come from the framework's own dev-build metadata
(React's fiber `_debugSource`, Vue's `__file`). Production builds strip
both, which is the point: this is staging instrumentation. Everything else -
test ids, text, diagnostics - works in any build.

The MCP server renders it into every tool result, so an agent reads this:

```
element: <SubmitButton> span.label "Place order" in button[data-testid="checkout-submit"]
source: /src/checkout/SubmitButton.tsx:42
diagnostics: 2 errors, 2 request issues (500 POST /api/orders), 1 warning
```

instead of fetching a screenshot to work out which button was meant.

### Tuning the capture

```js
Pinstage.init({
  // ...
  appVersion: "1.2.3",
  commitSha: "a1b2c3d",           // whatever your build already exposes
  branch: "fix/checkout-total",

  diagnostics: {                  // all optional; defaults shown
    console: true,                // console.error and console.warn
    errors:  true,                // window errors and unhandled rejections
    network: true,                // failed requests, and successes over slowMs
    ignore:  [],                  // ["/api/health", /\/analytics\//]
    redact:  undefined,           // (text) => text, over every URL and message
    limit:    30,                 // entries held in memory
    windowMs: 60000,              // how far back a pin looks
    max:      12,                 // entries written onto one thread
    slowMs:   3000,               // a success this slow is still worth noting
  },
});
```

`diagnostics: false` turns the capture off entirely.

### What leaves the page

The buffer is in memory and is only ever written onto a thread a team member
deliberately creates. Nothing is transmitted on its own.

Successful requests are not recorded at all - only failures and anything
slower than `slowMs` - so ordinary traffic never reaches your database.
Pinstage's own requests and logging are excluded from its own report. What
does get recorded is request URLs and error messages, which can carry query
parameters or user data: `ignore` and `redact` are there for that, and
`diagnostics: false` if you would rather collect none of it.

Note that the buffer is installed for anyone who loads the script, before
the team check resolves, because the errors worth catching are usually the
ones that fire during page load. Users who are not on the roster still get
no toolbar, no pins, and no way to send anything anywhere.

## AI agents (MCP server)

`mcp/pinstage-mcp.mjs` is a zero-dependency MCP server that exposes the
queue as tools: `pinstage_list_issues`, `pinstage_get_issue` (full thread
with screenshot URLs and the context above), `pinstage_get_context` (the
same context as JSON, with `searchKeys` - the strings most likely to appear
verbatim in your source), `pinstage_reply`, `pinstage_resolve`,
`pinstage_reopen`, and `pinstage_sync_github`.

```bash
claude mcp add pinstage -- node /path/to/pinstage/mcp/pinstage-mcp.mjs \
  --env-file /path/to/your-app/.env.local
```

The service key stays inside the MCP process. The agent only sees tool
results.

**Full guide: [mcp/README.md](mcp/README.md)** covers setup for Claude Code,
Codex, and Cursor, the complete configuration reference, every tool, the
recommended team workflow, cron usage, the security model, and
troubleshooting.

## GitHub Issues mirror

Pinstage stays the primary store, because the toolbar needs instant writes
with the user's session. GitHub is a one-way mirror so issues also live
where your boards and CI already look:

- a thread becomes an issue, with screenshots inline and a deep link back to
  the exact pin
- each reply becomes an issue comment
- resolve closes the issue, reopen reopens it

The sync is incremental and idempotent. Run it as the `pinstage_sync_github`
agent tool, or from cron or CI:

```bash
PINSTAGE_GITHUB_REPO=owner/repo node mcp/pinstage-mcp.mjs sync-github \
  --env-file /path/to/your-app/.env.local
```

Mirrored issues carry the element, the source file and the commit in the
header, with the diagnostics and the full context in collapsed `<details>`
blocks.

Token resolution: `PINSTAGE_GITHUB_TOKEN`, then `GITHUB_TOKEN`, then
`gh auth token`. Set `PINSTAGE_APP_URL` so issue bodies can deep-link back
to the pin, and `PINSTAGE_GITHUB_API` for GitHub Enterprise
(`https://<host>/api/v3`).

## Building a dashboard on top

There is no extra API to learn. With the Supabase adapter, the queue is
three plain tables you can read through PostgREST, SQL, or any Supabase
client. M-Digital's admin panel is exactly that: a page that lists threads,
replies, resolves, and links back to the pins.

## Design notes

- Anchors store a short CSS path (`#id` preferred, then a `tag:nth-of-type`
  chain) plus the click's relative offset inside that element, with a
  document-position fallback when the selector no longer matches. The
  toolbar is taken out of hit testing with `display: none` for that one
  `elementFromPoint` call: clearing `pointer-events` on the shadow host is
  not enough, because the comment overlay sets `pointer-events: auto` and
  `elementFromPoint` retargets shadow content back to the host.
- The diagnostics buffer wraps `console`, `fetch` and `XMLHttpRequest` once
  per page and holds a bounded ring in memory. Pinstage takes its own handle
  on `fetch` before instrumenting anything, so its traffic stays out of its
  own report.
- Screenshot capture uses `getDisplayMedia({preferCurrentTab})`. The toolbar
  hides itself during the grab, caps output at 2560px, and exports JPEG.
- The annotation editor is canvas based. Drawing operations are replayable
  for undo; crop flattens with its own undo history.
- `history.pushState` and `replaceState` are wrapped and `popstate` is
  observed, so pins reload per pathname in single-page apps.
- Some wire-level names predate the Pinstage name and are kept stable:
  the `mdTeamMembers` default table, the `?mdthread=` deep-link parameter,
  and the `md_toolbar_mention` notification type.

## Roadmap

- Chrome extension as a second install channel: an options page mapping
  domain patterns to projects and backend config, with a content script that
  injects this same file. The open problem is the auth bridge, since a
  content script cannot read the host app's session directly. Until that is
  solved, the script tag remains the recommended path. It also works in
  every browser, including mobile.
- Ready-made adapters for Firebase and plain REST backends.
- Linear and Jira mirrors, following the GitHub pattern.

## License

MIT © Teminali
