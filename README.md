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
- **AI ready**: a bundled MCP server turns the queue into native tools for
  Claude Code, Codex, or any MCP client.
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
thread.data  = { project, path, query, anchor, preview,
                 status: "open" | "resolved",
                 createdBy: {uid, name, email},
                 createdAt: {_ts}, lastActivityAt: {_ts}, messageCount,
                 appVersion, viewport, userAgent, resolvedBy?, resolvedAt? }

comment.data = { threadId, authorUid, authorName, body,
                 mentions: [uid], attachments: [{url, w, h}],
                 createdAt: {_ts} }
```

Timestamps are `{_ts: <epoch ms>}` objects so they serialize cleanly through
JSON stores.

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

## AI agents (MCP server)

`mcp/pinstage-mcp.mjs` is a zero-dependency MCP server that exposes the
queue as tools: `pinstage_list_issues`, `pinstage_get_issue` (full thread
with screenshot URLs), `pinstage_reply`, `pinstage_resolve`,
`pinstage_reopen`, and `pinstage_sync_github`.

```bash
claude mcp add pinstage -- node /path/to/pinstage/mcp/pinstage-mcp.mjs \
  --env-file /path/to/your-app/.env.local
```

The service key stays inside the MCP process. The agent only sees tool
results. Configuration is documented at the top of the file.

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

Token resolution: `PINSTAGE_GITHUB_TOKEN`, then `GITHUB_TOKEN`, then
`gh auth token`. Set `PINSTAGE_APP_URL` so issue bodies can deep-link back
to the pin.

## Building a dashboard on top

There is no extra API to learn. With the Supabase adapter, the queue is
three plain tables you can read through PostgREST, SQL, or any Supabase
client. M-Digital's admin panel is exactly that: a page that lists threads,
replies, resolves, and links back to the pins.

## Design notes

- Anchors store a short CSS path (`#id` preferred, then a `tag:nth-of-type`
  chain) plus the click's relative offset inside that element, with a
  document-position fallback when the selector no longer matches.
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
