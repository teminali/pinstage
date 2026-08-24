# md-toolbar

A Figma/Vercel-style **staging toolbar** for your own product: your team clicks
anywhere on a page, pins a comment there, @mentions teammates, and every
thread is equally readable by your admin dashboard, scripts, or CI — because
the toolbar owns no data store of its own.

Built by [Muhasibu Digital](https://mhasibudigital.com) to run its own staging
environment after hitting the walls of hosted preview-comment tools (seat
limits, no API). Zero dependencies, one file, shadow-DOM UI.

## What you get

- **Comment mode** — click anywhere, a numbered pin lands on that element, a
  thread opens. Pins re-anchor by CSS selector with a document-position
  fallback, and survive SPA route changes.
- **Threads** — replies, resolve/reopen, deep links (`?mdthread=<id>` scrolls
  to the pin and opens the thread).
- **@mentions** — autocomplete from your team roster; mentioned people get a
  notification through *your* notification system (optional adapter method).
- **Inbox** — every open/resolved thread across the app, one click from the bar.
- **Team-gated** — the toolbar renders *nothing* unless your backend says the
  signed-in user is on the team. It is UI, not a security boundary: every
  call carries the user's own token and your row-level security decides.

## Install

Serve `md-toolbar.js` from your app (or any static host) and initialize it on
the pages where it should exist — typically your staging build only:

```html
<script src="/toolbar/md-toolbar.js"></script>
<script>
  MDToolbar.init({
    project: "my-web-app",              // shows up on threads and your dashboard
    environmentLabel: "Staging",
    appVersion: "1.2.3",                // optional, attached to new threads
    adapter: MDToolbar.supabaseAdapter({
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
                 createdAt: {_ts} }
```

Your dashboard integrates by reading the same store the adapter writes — no
extra API needed. With the Supabase adapter, that store is three tables you
can query from anywhere (dashboard, cron, CLI) through PostgREST or any
Postgres client.

## Supabase adapter

```js
MDToolbar.supabaseAdapter({
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
    roleSelect: "data->>role",  // PostgREST select expression for the role
    nameSelect: "data->>fullName",
    adminRole: "admin",
  },
  mentionType: "md_toolbar_mention",  // notification row `type`
})
```

A ready-to-adapt schema — tables, `is_md_team()` helper, and row-level
security fencing everything to the roster — is in
[`examples/schema.supabase.sql`](examples/schema.supabase.sql).

## Design notes

- **One file, no build.** Vanilla ES2020, injected UI in a shadow root so
  host CSS and toolbar CSS cannot leak into each other.
- **Anchoring** stores a short CSS path (`#id` preferred, `tag:nth-of-type`
  chain otherwise) plus the click's relative offset inside that element, with
  a document-percentage fallback for when the selector no longer matches.
- **SPA-aware.** `history.pushState`/`replaceState` are wrapped and
  `popstate` observed; pins reload per pathname.
- **Timestamps** are `{_ts: <epoch ms>}` objects so they serialize cleanly
  through JSON stores.

## License

MIT © Muhasibu Digital
