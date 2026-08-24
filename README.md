# Pinstage

**Pin comments on your staging environment.** A Figma/Vercel-style comment
layer for your own product: your team clicks anywhere on a page, pins a
thread there, attaches **annotated screenshots**, @mentions teammates — and
every thread is equally readable by your admin dashboard, scripts, or CI,
because Pinstage owns no data store of its own.

One file. Zero dependencies. Shadow-DOM UI with inline SVG icons. MIT.

> Built by [Teminali](https://github.com/teminali) and battle-tested on
> [M-Digital](https://mhasibudigital.com)'s staging environment, after hitting
> the walls of hosted preview-comment tools (seat limits, no API).

## What you get

- **Comment mode** — click anywhere; a numbered pin lands on that element and
  a thread opens. Pins re-anchor by CSS selector with a document-position
  fallback, survive SPA route changes, and reposition on scroll.
- **Screenshots** — the composer's camera button captures the current tab via
  the browser's native `getDisplayMedia` (pixel-perfect, no libraries), then
  opens a built-in annotation editor: **crop, pen, rectangle, arrow, three
  ink colors, undo** — before attaching. Paste an image into the composer or
  pick one from disk, too. Thumbnails render in threads with a lightbox.
- **Threads** — replies, resolve/reopen, deep links (`?mdthread=<id>` scrolls
  to the pin and opens the thread).
- **@mentions** — autocomplete from your team roster; notifications go
  through *your* notification system (optional adapter method).
- **Inbox** — every open/resolved thread across the app, one click from the bar.
- **Team-gated** — Pinstage renders *nothing* unless your backend says the
  signed-in user is on the team. It is UI, not a security boundary: every
  call carries the user's own token and your row-level security decides.

## Install

Serve `pinstage.js` from your app (or any static host) and initialize it on
the pages where it should exist — typically your staging build only:

```html
<script src="/toolbar/pinstage.js"></script>
<script>
  Pinstage.init({
    project: "my-web-app",              // shows up on threads and your dashboard
    environmentLabel: "Staging",
    appVersion: "1.2.3",                // optional, attached to new threads
    adapter: Pinstage.supabaseAdapter({
      url: "https://<ref>.supabase.co",
      anonKey: "<anon key>",
      getToken: async () => (await supabase.auth.getSession()).data.session?.access_token ?? null,
    }),
  });
</script>
```

> The **host** decides where the toolbar runs. Load the script on staging
> only; the SDK itself is environment-agnostic on purpose.

## Backends: the adapter interface

The UI core talks to a small adapter. The built-in Supabase adapter is one
implementation; wire any backend (REST, GraphQL, Firebase, …) by implementing:

```ts
interface Adapter {
  getIdentity():                Promise<{uid, name, email} | null>;  // null → toolbar stays invisible
  listTeam():                   Promise<Array<{uid, name, email?, role?}>>;
  listThreads(filter: {project, path?, status}): Promise<Array<{id, data}>>;
  getThread(id):                Promise<{id, data} | null>;
  createThread(row: {id, data}): Promise<void>;
  updateThreadData(id, data):   Promise<void>;         // full replace of data
  listComments(threadId):       Promise<Array<{id, data}>>;
  addComment(row: {id, data}):  Promise<void>;
  notifyMentions?(p: {targets, actor, threadId, path, url, body, project}): Promise<void>;
  uploadAttachment?(blob: Blob, meta: {threadId}): Promise<{url}>;  // enables screenshots
}
```

`data` shapes the SDK writes:

```
thread.data  = { project, path, query, anchor: {selector, relX, relY, docXPct,
                 docYPct}, preview, status: "open"|"resolved",
                 createdBy: {uid,name,email}, createdAt: {_ts}, lastActivityAt:
                 {_ts}, messageCount, appVersion, viewport, userAgent,
                 resolvedBy?, resolvedAt? }
comment.data = { threadId, authorUid, authorName, body, mentions: [uid],
                 attachments: [{url, w, h}], createdAt: {_ts} }
```

Your dashboard integrates by reading the same store the adapter writes — no
extra API needed. With the Supabase adapter, that store is three tables you
can query from anywhere (dashboard, cron, CLI) through PostgREST or any
Postgres client.

## Supabase adapter

```js
Pinstage.supabaseAdapter({
  url, anonKey,
  getToken: async () => "<user JWT or null>",
  tables: {           // optional name overrides (defaults shown)
    team: "mdTeamMembers",
    threads: "feedbackThreads",
    comments: "feedbackComments",
    notifications: "notifications",
  },
  uidFromClaims: (claims) => claims.app_metadata?.firebase_uid ?? claims.sub,  // default
  adminSelfRegister: {          // optional: platform admins auto-join the roster
    usersTable: "users",
    roleSelect: "data->>role",  // PostgREST select expression
    nameSelect: "data->>fullName",
    adminRole: "admin",         // compare a boolean flag with roleSelect "data->>isAdmin", adminRole "true"
  },
  mentionType: "md_toolbar_mention",  // notification row `type`
  storage: {                    // screenshots → a PUBLIC bucket with an
    bucket: "uploads",          // authenticated INSERT policy. storage: false
    prefix: "pinstage",         // disables attachments entirely.
  },
})
```

A ready-to-adapt schema — tables, `is_md_team()` helper, and row-level
security fencing everything to the roster — is in
[`examples/schema.supabase.sql`](examples/schema.supabase.sql).

## Design notes

- **One file, no build.** Vanilla ES2020; UI in a shadow root so host CSS and
  toolbar CSS cannot leak into each other; icons are inline SVG.
- **Anchoring** stores a short CSS path (`#id` preferred, `tag:nth-of-type`
  chain otherwise) plus the click's relative offset inside that element, with
  a document-percentage fallback for when the selector no longer matches.
- **Screenshot capture** uses `getDisplayMedia({preferCurrentTab})` — the
  toolbar hides itself during the grab, caps output at 2560px, and exports
  JPEG. The annotate editor is canvas-based: ops are re-drawn (undoable),
  crop flattens with its own undo history.
- **SPA-aware.** `history.pushState`/`replaceState` are wrapped and
  `popstate` observed; pins reload per pathname.
- **Timestamps** are `{_ts: <epoch ms>}` objects so they serialize cleanly
  through JSON stores.
- Wire-level names (`mdTeamMembers` defaults, `?mdthread=` deep-link param,
  `md_toolbar_mention`) predate the Pinstage name and are kept stable.

## Roadmap

- **Chrome extension distribution** — an options page mapping
  `domain pattern → project → backend config`, with a content script that
  injects this same file. The open problem is the auth bridge (a content
  script cannot read the host app's session directly); until that is solved
  per-app, the script-tag install remains the recommended path — it also
  works in every browser, including mobile.
- Ready-made adapters for Firebase and plain-REST backends.

## License

MIT © Teminali
