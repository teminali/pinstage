/* ═══════════════════════════════════════════════════════════════════════════
 * Pinstage: pin comments on your staging environment
 * https://github.com/teminali/pinstage
 * v0.5.0 · MIT © Teminali
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A Figma-style comment layer for your own product. Team members click
 * anywhere on a page, pin a thread there, attach annotated screenshots, and
 * @mention teammates. Every thread is equally readable by your admin
 * dashboard, scripts, CI, or an AI agent (see mcp/pinstage-mcp.mjs), because
 * Pinstage owns no data store of its own.
 *
 * ARCHITECTURE
 *   The UI core talks to a small ADAPTER interface. Use the built-in
 *   Supabase adapter, or implement these methods against any backend and the
 *   toolbar works unchanged:
 *
 *   adapter = {
 *     getIdentity():            Promise<{uid,name,email}|null>   // null: toolbar stays invisible
 *     listTeam():               Promise<[{uid,name,email,role}]> // @mention picker
 *     listThreads({project, path?, status}): Promise<[{id,data}]>
 *     getThread(id):            Promise<{id,data}|null>
 *     createThread({id,data}):  Promise<void>
 *     updateThreadData(id, data): Promise<void>                  // full data replace
 *     listComments(threadId):   Promise<[{id,data}]>
 *     addComment({id,data}):    Promise<void>
 *     notifyMentions?(payload): Promise<void>                    // optional
 *     uploadAttachment?(blob, {threadId}): Promise<{url}>        // optional, enables screenshots
 *   }
 *
 * QUICK START (Supabase backend, schema in examples/schema.supabase.sql):
 *
 *   <script src="/toolbar/pinstage.js"></script>
 *   <script>
 *     Pinstage.init({
 *       project: "my-web-app",
 *       adapter: Pinstage.supabaseAdapter({
 *         url: "https://<ref>.supabase.co",
 *         anonKey: "<anon key>",
 *         getToken: async () => sessionAccessTokenOrNull,
 *       }),
 *     });
 *   </script>
 *
 * The HOST decides where this runs. Load the script on staging only, or on
 * production with startHidden: true for a quiet toolbar that shows nothing
 * until the user expands it. All writes go through your backend's row-level
 * security with the user's own token. Pinstage is UI, not a security
 * boundary.
 *
 * TECHNICAL CONTEXT
 *   Every thread carries what a human would otherwise have to be asked for:
 *   the clicked element's test id, classes and text, the React or Vue
 *   component behind it, the source file in a dev build, and the console
 *   errors and failed requests from the seconds before the pin. An agent
 *   reading the issue through mcp/pinstage-mcp.mjs lands on the right file
 *   without opening the screenshot. See `diagnostics` in init() to tune or
 *   disable the capture.
 *
 * Zero dependencies. One file, no build step. UI lives in a shadow root so
 * host CSS and toolbar CSS cannot touch each other. Icons are inline SVG.
 * ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  if (window.Pinstage) return; // idempotent under double-injection

  /* Handles taken before the diagnostics buffer instruments anything, so
   * Pinstage's own requests never show up in the traffic it collects. */
  const nativeFetch = typeof window.fetch === "function" ? window.fetch.bind(window) : null;

  /* ── tiny utilities ─────────────────────────────────────────────────────── */

  const uuid = () =>
    crypto.randomUUID
      ? crypto.randomUUID()
      : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
          const r = (Math.random() * 16) | 0;
          return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
        });

  const now = () => ({ _ts: Date.now() });

  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const timeAgo = (ts) => {
    if (!ts) return "";
    const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
    if (s < 60) return "just now";
    const m = Math.floor(s / 60);
    if (m < 60) return m + "m ago";
    const h = Math.floor(m / 60);
    if (h < 24) return h + "h ago";
    return Math.floor(h / 24) + "d ago";
  };

  const initials = (name) =>
    String(name || "?")
      .split(/\s+/)
      .map((w) => w[0])
      .filter(Boolean)
      .slice(0, 2)
      .join("")
      .toUpperCase();

  function decodeJwt(token) {
    try {
      const b64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return null;
    }
  }

  /* ── inline SVG icon set (stroke style, currentColor) ───────────────────── */

  const I = {
    comment: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
    inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    minus: '<path d="M5 12h14"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
    undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>',
    crop: '<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/>',
    pen: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/>',
    square: '<rect x="3" y="3" width="18" height="18" rx="2"/>',
    arrow: '<path d="M7 7h10v10"/><path d="M7 17 17 7"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    send: '<path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/>',
    reopen: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  };
  const svg = (name, size = 16) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[name]}</svg>`;

  /* The Pinstage mark (see assets/logo.svg) - amber pin, white bubble.
   * Literal colors on purpose: this is the brand, not a themable glyph. */
  const logo = (size = 16) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">` +
    `<path fill="#F59E0B" d="M12 1.9C7.2 1.9 3.6 5.6 3.6 10.1c0 4.7 4.9 9.4 7.2 11.7.7.7 1.7.7 2.4 0 2.3-2.3 7.2-7 7.2-11.7 0-4.5-3.6-8.2-8.4-8.2z"/>` +
    `<circle cx="12" cy="9.7" r="4.1" fill="#fff"/>` +
    `<path fill="#fff" d="M10.3 12.9 8.9 14.4l.5-2.6z"/>` +
    `</svg>`;

  /* Selector for the element under a click - stable-ish across renders:
   * prefer the nearest #id ancestor, else a short tag:nth-of-type chain. */
  function cssPath(el) {
    if (!(el instanceof Element)) return "body";
    const parts = [];
    let node = el;
    while (node && node !== document.body && parts.length < 6) {
      if (node.id) {
        parts.unshift("#" + CSS.escape(node.id));
        return parts.join(" > ");
      }
      let sel = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const sibs = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (sibs.length > 1) sel += ":nth-of-type(" + (sibs.indexOf(node) + 1) + ")";
      }
      parts.unshift(sel);
      node = parent;
    }
    return parts.length ? parts.join(" > ") : "body";
  }

  /* ═══════════════════════════════════════════════════════════════════════ */
  /* Diagnostics ring buffer                                                  */
  /* ═══════════════════════════════════════════════════════════════════════ */
  /* Console errors, uncaught exceptions and failed requests, kept in memory
   * only. Creating a pin snapshots the entries from the seconds before the
   * click onto the thread, so whoever picks the issue up - a teammate or an
   * agent - gets the stack trace and the 500 that came with the complaint
   * instead of just the prose.
   *
   * Nothing is transmitted on its own: the buffer leaves the page only on a
   * thread a team member deliberately creates. Hosts narrow or disable it
   * with init({ diagnostics: … }); see install() for the options.           */

  const diag = (function () {
    const buf = [];
    let opts = null;

    const push = (e) => {
      if (!opts) return;
      e.t = Date.now();
      buf.push(e);
      if (buf.length > opts.limit) buf.shift();
    };

    const clip = (v, n) => {
      const str = String(v ?? "");
      return str.length > n ? str.slice(0, n) + "…" : str;
    };

    /* console.error(anything) - Errors and objects flattened to one readable
     * line, because that is what ends up in front of the reader. */
    const flatten = (a) => {
      if (a instanceof Error) return a.stack || a.name + ": " + a.message;
      if (typeof a === "string") return a;
      try { return clip(JSON.stringify(a), 300); } catch { return String(a); }
    };

    const ignored = (url) =>
      opts.ignore.some((p) => (p instanceof RegExp ? p.test(url) : String(url).includes(p)));

    const scrub = (v) => {
      const str = String(v ?? "");
      if (typeof opts.redact !== "function") return str;
      try { return String(opts.redact(str) ?? ""); } catch { return str; }
    };

    /* Only failures and stalls earn their tokens: a wall of 200s tells a
     * reader nothing the code does not already say. */
    function recordRequest(method, url, status, ms, err) {
      if (!url || ignored(url)) return;
      if (!err && status >= 200 && status < 400 && ms < opts.slowMs) return;
      push({
        kind: "net",
        method,
        url: clip(scrub(url), 300),
        status: err ? 0 : status,
        ms: Math.round(ms),
        error: err ? clip(err.message || err, 200) : undefined,
      });
    }

    function installNetwork() {
      if (typeof window.fetch === "function") {
        const orig = window.fetch.bind(window);
        window.fetch = function (input, init) {
          const started = Date.now();
          const url = typeof input === "string" ? input : input?.url ?? String(input);
          const method = String(init?.method || input?.method || "GET").toUpperCase();
          return orig(input, init).then(
            (res) => { recordRequest(method, url, res.status, Date.now() - started); return res; },
            (err) => { recordRequest(method, url, 0, Date.now() - started, err); throw err; }
          );
        };
      }

      const XHR = window.XMLHttpRequest;
      if (!XHR) return;
      const open = XHR.prototype.open;
      const send = XHR.prototype.send;
      XHR.prototype.open = function (method, url) {
        this.__pinstage = { method: String(method || "GET").toUpperCase(), url: String(url) };
        return open.apply(this, arguments);
      };
      XHR.prototype.send = function () {
        const req = this.__pinstage;
        if (req) {
          req.started = Date.now();
          this.addEventListener("loadend", () => {
            // status 0 after loadend means the request never landed
            recordRequest(req.method, req.url, this.status, Date.now() - req.started,
              this.status ? null : new Error("request failed"));
          });
        }
        return send.apply(this, arguments);
      };
    }

    /* Options, all optional:
     *   console  false to skip console.error / console.warn
     *   errors   false to skip window errors and promise rejections
     *   network  false to skip failed and slow requests
     *   ignore   [string | RegExp] request URLs never to record
     *   redact   (text) => text, run over every URL and message
     *   limit    entries held in memory (default 30)
     *   windowMs how far back a pin looks (default 60000)
     *   max      entries written onto one thread (default 12)
     *   slowMs   a successful request this slow is still worth noting (3000) */
    function install(o) {
      if (opts) return; // once per page
      opts = {
        console: o.console !== false,
        errors: o.errors !== false,
        network: o.network !== false,
        ignore: o.ignore || [],
        redact: o.redact,
        limit: o.limit || 30,
        windowMs: o.windowMs || 60000,
        max: o.max || 12,
        slowMs: o.slowMs || 3000,
      };

      if (opts.console) {
        for (const level of ["error", "warn"]) {
          const orig = console[level];
          console[level] = function () {
            try {
              const msg = Array.from(arguments).map(flatten).join(" ");
              // Pinstage's own logging is noise in Pinstage's own report
              if (!msg.startsWith("[pinstage]")) push({ kind: "console", level, message: clip(scrub(msg), 600) });
            } catch { /* never break the host's logging */ }
            return orig.apply(console, arguments);
          };
        }
      }

      if (opts.errors) {
        window.addEventListener("error", (ev) => {
          if (!ev.error && !ev.message) return;
          push({
            kind: "error",
            message: clip(scrub(ev.error?.stack || ev.message), 800),
            at: ev.filename ? scrub(ev.filename) + ":" + ev.lineno + ":" + ev.colno : undefined,
          });
        }, true);
        window.addEventListener("unhandledrejection", (ev) => {
          const r = ev.reason;
          push({ kind: "rejection", message: clip(scrub(r?.stack || r?.message || r), 800) });
        });
      }

      if (opts.network) installNetwork();
    }

    /* What the pin carries: the tail of the buffer, inside the time window.
     * Entries keep a raw epoch `t` plus `ago` seconds, so a reader does not
     * have to do arithmetic to see the order of events. */
    function snapshot() {
      if (!opts) return null;
      const from = Date.now() - opts.windowMs;
      const rows = buf.filter((e) => e.t >= from).slice(-opts.max);
      if (!rows.length) return null;
      return rows.map((e) => ({ ...e, ago: Math.round((Date.now() - e.t) / 1000) }));
    }

    return { install, snapshot, buffer: buf };
  })();

  /* ═══════════════════════════════════════════════════════════════════════ */
  /* Element fingerprint                                                      */
  /* ═══════════════════════════════════════════════════════════════════════ */
  /* The distance between "the button does nothing" and the line of code is
   * usually one grep - if you know the test id, the component name, or the
   * source file. All three are readable from the DOM at click time, and the
   * last two only in a dev build, which is exactly where Pinstage runs.     */

  const TEST_ID_ATTRS = ["data-testid", "data-test-id", "data-test", "data-cy", "data-qa", "data-pw"];

  const oneLine = (v, n) => {
    const str = String(v ?? "").replace(/\s+/g, " ").trim();
    return str.length > n ? str.slice(0, n) + "…" : str;
  };

  const testIdOf = (el) => {
    for (const a of TEST_ID_ATTRS) {
      const v = el.getAttribute(a);
      if (v) return { value: v, attr: a };
    }
    return null;
  };

  /* React puts the fiber on the node as an own property whose key carries a
   * random suffix (`__reactFiber$k3l…`), so it has to be found by prefix. */
  function reactFiber(el) {
    const k = Object.keys(el).find((k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"));
    return k ? el[k] : null;
  }

  const fiberName = (t) =>
    typeof t === "function" ? t.displayName || t.name || null
      : t && typeof t === "object" ? t.displayName || t.render?.displayName || t.render?.name || null
      : null;

  /* Dev builds hang the JSX origin on the fiber as _debugSource (React 18 and
   * earlier) - the single most useful field here, and absent in production
   * builds by design. Walk up: the clicked <button> is a host fiber, its
   * component is a few `return`s above it. */
  function reactInfo(el) {
    let f = reactFiber(el);
    if (!f) return null;
    const out = {};
    for (let i = 0; f && i < 12; f = f.return, i++) {
      const src = f._debugSource || f._debugOwner?._debugSource;
      if (src && !out.source) out.source = { file: src.fileName, line: src.lineNumber, column: src.columnNumber };
      if (!out.component) out.component = fiberName(f.type);
      if (out.source && out.component) break;
    }
    return out.component || out.source ? { framework: "react", ...out } : null;
  }

  function vueInfo(el) {
    const c3 = el.__vueParentComponent; // Vue 3
    if (c3?.type) {
      const t = c3.type;
      const name = t.name || t.__name || null;
      if (name || t.__file) return { framework: "vue", component: name, source: t.__file ? { file: t.__file } : undefined };
    }
    const c2 = el.__vue__; // Vue 2
    if (c2?.$options) {
      const o = c2.$options;
      if (o.name || o.__file) return { framework: "vue", component: o.name || null, source: o.__file ? { file: o.__file } : undefined };
    }
    return null;
  }

  /* The clicked node is often a bare <span> inside the component that owns
   * it, so look a few levels up before giving up. */
  function frameworkInfo(el) {
    for (let node = el, i = 0; node && i < 6; node = node.parentElement, i++) {
      const info = reactInfo(node) || vueInfo(node);
      if (info) return info;
    }
    return null;
  }

  const componentOf = (node) => {
    const f = reactFiber(node);
    if (f) {
      for (let x = f, i = 0; x && i < 3; x = x.return, i++) {
        const n = fiberName(x.type);
        if (n) return n;
      }
    }
    return vueInfo(node)?.component || null;
  };

  function describeElement(el) {
    if (!(el instanceof Element)) return null;
    const d = { tag: el.tagName.toLowerCase() };
    if (el.id) d.id = el.id;

    const cls = el.getAttribute("class");
    if (cls) d.classes = oneLine(cls, 200);

    const tid = testIdOf(el);
    if (tid) { d.testId = tid.value; d.testIdAttr = tid.attr; }

    const data = {};
    for (const { name, value } of Array.from(el.attributes)) {
      if (!name.startsWith("data-") || TEST_ID_ATTRS.includes(name)) continue;
      if (Object.keys(data).length >= 8) break;
      data[name] = oneLine(value, 60);
    }
    if (Object.keys(data).length) d.data = data;

    for (const a of ["role", "aria-label", "name", "type", "href", "placeholder", "alt", "title", "disabled"]) {
      const v = el.getAttribute(a);
      if (v !== null) d[a === "aria-label" ? "ariaLabel" : a] = oneLine(v, 120) || true;
    }

    const text = oneLine(el.textContent, 80);
    if (text) d.text = text;

    // cloneNode(false): the open tag only, so a click on a big container
    // does not serialize its whole subtree just to be truncated
    d.html = oneLine(el.cloneNode(false).outerHTML, 300);
    return d;
  }

  /* Only the ancestors that mean something to a reader - a test id, an id,
   * or a component boundary. Layout wrappers are skipped. */
  function ancestorTrail(el) {
    const out = [];
    let node = el.parentElement;
    for (let i = 0; node && node !== document.body && i < 12 && out.length < 4; node = node.parentElement, i++) {
      const tid = testIdOf(node);
      const component = componentOf(node);
      if (!tid && !node.id && !component) continue;
      out.push({
        tag: node.tagName.toLowerCase(),
        id: node.id || undefined,
        testId: tid?.value,
        testIdAttr: tid?.attr,
        component: component || undefined,
      });
    }
    return out;
  }

  /* The whole technical context of one click, in the shape the MCP server
   * and the GitHub mirror read back. */
  function contextFromElement(el) {
    const ctx = { element: describeElement(el) };
    const fw = frameworkInfo(el);
    if (fw) {
      ctx.framework = fw.framework;
      if (fw.component) ctx.component = fw.component;
      if (fw.source) ctx.source = fw.source;
    }
    const trail = ancestorTrail(el);
    if (trail.length) ctx.ancestors = trail;
    return ctx;
  }

  /* ═══════════════════════════════════════════════════════════════════════ */
  /* Built-in Supabase adapter (PostgREST + RLS + Storage)                    */
  /* ═══════════════════════════════════════════════════════════════════════ */

  /**
   * Pinstage.supabaseAdapter(options)
   *
   * options:
   *   url, anonKey            - the Supabase project
   *   getToken()              - async, returns the signed-in user's JWT (or null)
   *   tables?                 - { team, threads, comments, notifications } name overrides
   *   uidFromClaims?(claims)  - where your app's uid lives in the JWT
   *                             (default: app_metadata.firebase_uid ?? sub)
   *   adminSelfRegister?      - { usersTable, roleSelect, nameSelect, adminRole }
   *                             lets platform admins auto-join the team roster
   *                             on first use. Off unless provided.
   *   mentionType?            - notification `type` value (default "md_toolbar_mention")
   *   storage?                - { bucket: "uploads", prefix: "pinstage" }: the
   *                             PUBLIC Supabase Storage bucket screenshots
   *                             upload to (authenticated insert policy
   *                             required). Set storage: false to disable
   *                             attachments entirely.
   */
  function supabaseAdapter(opts) {
    const T = Object.assign(
      { team: "mdTeamMembers", threads: "feedbackThreads", comments: "feedbackComments", notifications: "notifications" },
      opts.tables || {}
    );
    const uidFromClaims =
      opts.uidFromClaims || ((c) => (c.app_metadata && c.app_metadata.firebase_uid) || c.sub);

    async function rest(path, init_) {
      const token = await opts.getToken();
      if (!token) throw new Error("no session");
      const res = await (nativeFetch || fetch)(opts.url.replace(/\/$/, "") + "/rest/v1/" + path, {
        ...(init_ || {}),
        headers: {
          apikey: opts.anonKey,
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
          ...((init_ && init_.headers) || {}),
        },
      });
      if (!res.ok) throw new Error("[pinstage] " + res.status + " " + (await res.text()));
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    }

    const adapter = {
      async getIdentity() {
        const token = await opts.getToken();
        if (!token) return null;
        const claims = decodeJwt(token) || {};
        const uid = uidFromClaims(claims);
        if (!uid) return null;
        const email = claims.email || null;

        const rows = await rest(T.team + "?id=eq." + encodeURIComponent(uid) + "&select=id,data");
        if (rows.length) {
          const d = rows[0].data || {};
          if ((d.status || "active") !== "active") return null;
          return { uid, name: d.name || email || uid, email: d.email || email };
        }

        // Optional: platform admins join the roster on first use so they can
        // be @-mentioned without a manual roster entry.
        const asr = opts.adminSelfRegister;
        if (asr) {
          try {
            const me = await rest(
              asr.usersTable + "?id=eq." + encodeURIComponent(uid) +
                "&select=role:" + asr.roleSelect + ",name:" + asr.nameSelect
            );
            if (me.length && me[0].role === (asr.adminRole || "admin")) {
              const member = {
                id: uid,
                data: { email, name: me[0].name || email || uid, role: "Admin", status: "active", addedBy: uid, addedAt: now() },
              };
              await rest(T.team, {
                method: "POST",
                body: JSON.stringify(member),
                headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
              });
              return { uid, name: member.data.name, email };
            }
          } catch (e) {
            console.debug("[pinstage] admin self-register skipped:", e.message);
          }
        }
        return null;
      },

      async listTeam() {
        const rows = await rest(T.team + "?select=id,data&order=data->>name.asc");
        return rows
          .filter((r) => ((r.data && r.data.status) || "active") === "active")
          .map((r) => ({ uid: r.id, name: r.data.name || r.data.email || r.id, email: r.data.email, role: r.data.role }));
      },

      async listThreads({ project, path, status }) {
        let q = T.threads + "?select=id,data&data->>project=eq." + encodeURIComponent(project);
        if (status === "open" || status === "active" || !status) {
          q += "&data->>status=neq.resolved";
        } else if (status === "resolved") {
          q += "&data->>status=eq.resolved";
        } else if (status !== "all") {
          q += "&data->>status=eq." + encodeURIComponent(status);
        }
        q += "&order=data->lastActivityAt->_ts.desc.nullslast&limit=100";
        if (path != null) q += "&data->>path=eq." + encodeURIComponent(path);
        return rest(q);
      },

      async getThread(id) {
        const rows = await rest(T.threads + "?id=eq." + encodeURIComponent(id) + "&select=id,data");
        return rows.length ? rows[0] : null;
      },

      async createThread(row) {
        await rest(T.threads, { method: "POST", body: JSON.stringify(row), headers: { Prefer: "return=minimal" } });
      },

      async updateThreadData(id, data) {
        await rest(T.threads + "?id=eq." + encodeURIComponent(id), {
          method: "PATCH",
          body: JSON.stringify({ data }),
          headers: { Prefer: "return=minimal" },
        });
      },

      async listComments(threadId) {
        return rest(
          T.comments + "?select=id,data&data->>threadId=eq." + encodeURIComponent(threadId) +
            "&order=data->createdAt->_ts.asc"
        );
      },

      async addComment(row) {
        await rest(T.comments, { method: "POST", body: JSON.stringify(row), headers: { Prefer: "return=minimal" } });
      },

      async notifyMentions({ targets, actor, threadId, path, url, body, project }) {
        if (!targets.length) return;
        const rows = targets.map((uid) => ({
          id: uuid(),
          data: {
            userId: uid,
            type: opts.mentionType || "md_toolbar_mention",
            title: actor.name + " mentioned you on " + project,
            message: body.slice(0, 180),
            read: false,
            createdAt: now(),
            data: { threadId, path, url },
          },
        }));
        await rest(T.notifications, { method: "POST", body: JSON.stringify(rows), headers: { Prefer: "return=minimal" } });
      },
    };

    // Screenshot/image attachments → a public Supabase Storage bucket. The
    // comment embeds the public URL. Set storage: false to strip the feature.
    if (opts.storage !== false) {
      adapter.uploadAttachment = async function uploadAttachment(blob, meta) {
        const token = await opts.getToken();
        if (!token) throw new Error("no session");
        const bucket = (opts.storage && opts.storage.bucket) || "uploads";
        const prefix = (opts.storage && opts.storage.prefix) || "pinstage";
        const ext = (blob.type.split("/")[1] || "jpg").replace("jpeg", "jpg");
        const path = prefix + "/" + ((meta && meta.threadId) || "misc") + "/" + uuid() + "." + ext;
        const base = opts.url.replace(/\/$/, "");
        const res = await (nativeFetch || fetch)(base + "/storage/v1/object/" + bucket + "/" + path, {
          method: "POST",
          headers: { apikey: opts.anonKey, Authorization: "Bearer " + token, "Content-Type": blob.type },
          body: blob,
        });
        if (!res.ok) throw new Error("[pinstage] upload " + res.status + " " + (await res.text()));
        return { url: base + "/storage/v1/object/public/" + bucket + "/" + path };
      };
    }

    return adapter;
  }

  /* ═══════════════════════════════════════════════════════════════════════ */
  /* UI core                                                                  */
  /* ═══════════════════════════════════════════════════════════════════════ */

  function init(cfg) {
    // Back-compat / convenience: allow passing supabase config directly.
    if (!cfg?.adapter && cfg?.supabaseUrl) {
      cfg.adapter = supabaseAdapter({ url: cfg.supabaseUrl, anonKey: cfg.supabaseAnonKey, getToken: cfg.getToken });
    }
    if (!cfg || !cfg.adapter) {
      console.warn("[pinstage] init: an adapter is required");
      return;
    }
    if (init._booted) return;
    init._booted = true;

    const adapter = cfg.adapter;
    const project = cfg.project || "unknown";
    const canAttach = typeof adapter.uploadAttachment === "function";

    /* Installed before identity resolves, because the errors worth catching
     * are usually the ones that fire during page load. In memory only until
     * a team member pins a thread; `diagnostics: false` opts out entirely. */
    if (cfg.diagnostics !== false) diag.install(cfg.diagnostics || {});

    /* Production-friendly quiet mode: with startHidden true the toolbar
     * boots as the small dot and pins stay off the page until the user
     * expands it - comments never "float around" for someone who didn't ask.
     * The choice is remembered per user per project. */
    const HIDE_KEY = "pinstage:" + project + ":hidden";
    const storedHidden = (() => {
      try { return localStorage.getItem(HIDE_KEY); } catch { return null; }
    })();

    const state = {
      me: null,
      team: [],
      threads: [],
      mode: "idle",
      openThreadId: null,
      inboxOpen: false,
      inboxTab: "open",
      hidden: storedHidden != null ? storedHidden === "1" : !!cfg.startHidden,
      pathname: location.pathname,
    };

    function setHidden(v) {
      state.hidden = v;
      try { localStorage.setItem(HIDE_KEY, v ? "1" : "0"); } catch { /* private mode */ }
      if (v) { closeCards(); setMode("idle"); }
      renderBar();
      renderPins();
    }

    /* ── data flows on top of the adapter ── */

    async function loadThreadsForPage() {
      state.threads = await adapter.listThreads({ project, path: state.pathname, status: "open" });
      renderPins();
      renderBar();
    }

    async function notifyMentions(mentions, threadId, body) {
      if (!adapter.notifyMentions) return;
      const targets = mentions.filter((uid) => uid !== state.me.uid);
      if (!targets.length) return;
      const url = location.origin + state.pathname + location.search +
        (location.search ? "&" : "?") + "mdthread=" + threadId;
      try {
        await adapter.notifyMentions({ targets, actor: state.me, threadId, path: state.pathname, url, body: body || "screenshot", project });
      } catch (e) {
        console.debug("[pinstage] mention notify failed:", e.message);
      }
    }

    async function uploadAll(threadId, atts) {
      if (!atts.length || !canAttach) return [];
      const out = [];
      for (const a of atts) {
        const { url } = await adapter.uploadAttachment(a.blob, { threadId });
        out.push({ url, w: a.w, h: a.h });
      }
      return out;
    }

    async function createThread(anchor, context, body, mentions, atts) {
      const threadId = uuid();
      const thread = {
        id: threadId,
        data: {
          project,
          path: state.pathname,
          query: location.search || "",
          hash: location.hash || "",
          anchor,
          context,                                  // element, component, source
          diagnostics: diag.snapshot(),             // console + network, or null
          preview: body.slice(0, 140) || "Screenshot",
          status: "open",
          createdBy: { uid: state.me.uid, name: state.me.name, email: state.me.email },
          createdAt: now(),
          lastActivityAt: now(),
          messageCount: 1,
          environment: cfg.environmentLabel || (location.hostname === "localhost" || location.hostname === "127.0.0.1" ? "Dev" : "Staging"),
          hostname: location.hostname,
          appVersion: cfg.appVersion || null,
          commit: cfg.commitSha || null,
          branch: cfg.branch || null,
          viewport: window.innerWidth + "x" + window.innerHeight,
          dpr: window.devicePixelRatio || 1,
          scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) },
          userAgent: navigator.userAgent,
        },
      };
      await adapter.createThread(thread);
      await addComment(threadId, body, mentions, true, atts);
      state.threads.push(thread);
      renderPins();
      return threadId;
    }

    async function addComment(threadId, body, mentions, isFirst, atts) {
      const attachments = await uploadAll(threadId, atts || []);
      await adapter.addComment({
        id: uuid(),
        data: {
          threadId,
          authorUid: state.me.uid,
          authorName: state.me.name,
          body,
          mentions,
          attachments,
          createdAt: now(),
        },
      });
      if (!isFirst) {
        const row = await adapter.getThread(threadId);
        if (row) {
          const data = row.data;
          data.messageCount = (data.messageCount || 0) + 1;
          data.lastActivityAt = now();
          await adapter.updateThreadData(threadId, data);
        }
      }
      await notifyMentions(mentions, threadId, body);
    }

    async function setThreadStatus(threadId, status) {
      const row = await adapter.getThread(threadId);
      if (!row) return;
      const data = row.data;
      data.status = status;
      data.lastActivityAt = now();
      if (status === "resolved") {
        data.resolvedBy = { uid: state.me.uid, name: state.me.name };
        data.resolvedAt = now();
        state.threads = state.threads.filter((t) => t.id !== threadId);
      } else {
        delete data.resolvedBy;
        delete data.resolvedAt;
        const idx = state.threads.findIndex((t) => t.id === threadId);
        if (idx !== -1) {
          state.threads[idx].data = data;
        } else {
          await loadThreadsForPage();
        }
      }
      await adapter.updateThreadData(threadId, data);
      renderPins();
      renderBar();
    }

    /* ── anchoring ── */
    function anchorFromPoint(clientX, clientY) {
      host.style.display = "none";
      const el = document.elementFromPoint(clientX, clientY) || document.body;
      host.style.display = "";
      const r = el.getBoundingClientRect();
      const de = document.documentElement;
      const anchor = {
        selector: cssPath(el),
        relX: r.width ? (clientX - r.left) / r.width : 0.5,
        relY: r.height ? (clientY - r.top) / r.height : 0.5,
        docXPct: clientX / de.clientWidth,
        docYPct: (clientY + window.scrollY) / Math.max(1, de.scrollHeight),
      };
      let context = null;
      try { context = contextFromElement(el); } catch { /* never block a comment */ }
      return { anchor, context, element: el };
    }

    function anchorFromClick(ev) {
      return anchorFromPoint(ev.clientX, ev.clientY);
    }

    function anchorPoint(a) {
      if (a && a.selector) {
        try {
          const el = document.querySelector(a.selector);
          if (el) {
            const r = el.getBoundingClientRect();
            if (r.width || r.height) return { x: r.left + r.width * (a.relX ?? 0.5), y: r.top + r.height * (a.relY ?? 0.5) };
          }
        } catch { /* bad selector - fall through */ }
      }
      const de = document.documentElement;
      return {
        x: (a?.docXPct ?? 0.5) * de.clientWidth,
        y: (a?.docYPct ?? 0.5) * Math.max(1, de.scrollHeight) - window.scrollY,
      };
    }

    /* ── shadow-DOM UI ── */
    const host = document.createElement("div");
    host.setAttribute("data-pinstage", "");
    Object.assign(host.style, { position: "fixed", inset: "0", zIndex: String(cfg.zIndex || 2147483000), pointerEvents: "none" });
    const root = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `
      * { box-sizing: border-box; margin: 0; padding: 0; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
      button { cursor: pointer; border: 0; background: none; color: inherit; font: inherit; display: inline-flex; align-items: center; gap: 6px; }
      svg { flex: none; }
      .bar { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%);
        display: flex; align-items: center; gap: 2px; padding: 4px;
        background: #0e0f13; color: #e7e8ea; border: 1px solid #2a2c33; border-radius: 999px;
        box-shadow: 0 8px 30px rgba(0,0,0,.35); pointer-events: auto; }
      .bar .brand { display: flex; align-items: center; gap: 6px; padding: 0 10px; border-right: 1px solid #2a2c33; color: #fbbf24; }
      .bar .brand .env { font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
      .bar > button { height: 32px; padding: 0 12px; border-radius: 999px; font-size: 12.5px; font-weight: 600; color: #b6b8bf; justify-content: center; }
      .bar > button:hover { background: #1c1e24; color: #fff; }
      .bar > button.active { background: #f59e0b; color: #16130a; }
      .bar .badge { min-width: 16px; height: 16px; padding: 0 4px; border-radius: 999px; background: #f59e0b;
        color: #16130a; font-size: 10px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; }
      .dot { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); width: 34px; height: 34px;
        border-radius: 999px; background: #0e0f13; color: #fbbf24; border: 1px solid #2a2c33; pointer-events: auto;
        justify-content: center; box-shadow: 0 8px 30px rgba(0,0,0,.35); }
      .overlay { position: fixed; inset: 0; cursor: crosshair; pointer-events: auto; }
      .overlay .hint { position: fixed; top: 14px; left: 50%; transform: translateX(-50%);
        background: #0e0f13; color: #e7e8ea; border: 1px solid #2a2c33; padding: 7px 14px; border-radius: 999px; font-size: 12.5px; }
      .pinbtn { position: fixed; width: 28px; height: 28px; margin: -14px 0 0 -14px; border-radius: 999px 999px 999px 4px;
        background: #f59e0b; color: #16130a; font-size: 12px; font-weight: 800; justify-content: center;
        pointer-events: auto; border: 2px solid #fff; box-shadow: 0 3px 10px rgba(0,0,0,.35); transition: transform .12s; }
      .pinbtn:hover { transform: scale(1.12); }
      .pinbtn.st-open { background: #f59e0b; color: #16130a; }
      .pinbtn.st-in-progress { background: #0284c7; color: #fff; animation: psPulseBlue 1.8s infinite; }
      .pinbtn.st-deploying { background: #9333ea; color: #fff; animation: psPulsePurple 1.8s infinite; }
      .pinbtn.st-deployed { background: #059669; color: #fff; }
      .pinbtn.st-resolved { background: #475569; color: #cbd5e1; opacity: .75; }

      @keyframes psPulseBlue {
        0% { box-shadow: 0 0 0 0 rgba(2, 132, 199, 0.7); }
        70% { box-shadow: 0 0 0 9px rgba(2, 132, 199, 0); }
        100% { box-shadow: 0 0 0 0 rgba(2, 132, 199, 0); }
      }
      @keyframes psPulsePurple {
        0% { box-shadow: 0 0 0 0 rgba(147, 51, 234, 0.7); }
        70% { box-shadow: 0 0 0 9px rgba(147, 51, 234, 0); }
        100% { box-shadow: 0 0 0 0 rgba(147, 51, 234, 0); }
      }

      .stbadge { display: inline-flex; align-items: center; gap: 4px; padding: 2px 7px; border-radius: 999px; font-size: 10.5px; font-weight: 700; border: 1px solid transparent; }
      .stbadge .stdot { width: 5px; height: 5px; border-radius: 999px; }
      .stbadge.st-open { background: rgba(245, 158, 11, 0.15); color: #fbbf24; border-color: rgba(245, 158, 11, 0.35); }
      .stbadge.st-open .stdot { background: #fbbf24; }
      .stbadge.st-in-progress { background: rgba(2, 132, 199, 0.18); color: #38bdf8; border-color: rgba(56, 189, 248, 0.4); }
      .stbadge.st-in-progress .stdot { background: #38bdf8; animation: psDotPulse 1.2s infinite; }
      .stbadge.st-deploying { background: rgba(147, 51, 234, 0.18); color: #c084fc; border-color: rgba(192, 132, 252, 0.4); }
      .stbadge.st-deploying .stdot { background: #c084fc; animation: psDotPulse 1.2s infinite; }
      .stbadge.st-deployed { background: rgba(5, 150, 105, 0.18); color: #34d399; border-color: rgba(52, 211, 153, 0.4); }
      .stbadge.st-deployed .stdot { background: #34d399; }
      .stbadge.st-resolved { background: rgba(71, 85, 105, 0.25); color: #94a3b8; border-color: rgba(148, 163, 184, 0.25); }
      .stbadge.st-resolved .stdot { background: #94a3b8; }

      @keyframes psDotPulse {
        0%, 100% { opacity: 1; transform: scale(1); }
        50% { opacity: .4; transform: scale(0.75); }
      }

      .rowhead { display: flex; align-items: center; justify-content: space-between; gap: 6px; margin-bottom: 3px; }
      .rowhead .p { font-size: 11px; color: #fbbf24; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
      .card { position: fixed; width: 340px; max-width: calc(100vw - 24px); background: #0e0f13; color: #e7e8ea;
        border: 1px solid #2a2c33; border-radius: 14px; box-shadow: 0 16px 50px rgba(0,0,0,.5);
        pointer-events: auto; display: flex; flex-direction: column; overflow: hidden; }
      .card .head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #22242b; cursor: grab; user-select: none; -webkit-user-select: none; touch-action: none; }
      .card .head:active { cursor: grabbing; }
      .card .head .t { font-size: 12.5px; font-weight: 700; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; pointer-events: none; }
      .card .head .av { pointer-events: none; }
      .card .head .stbadge { pointer-events: none; }
      .card .head .t { font-size: 12.5px; font-weight: 700; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .card .head button { color: #8b8e98; font-size: 12px; padding: 4px 8px; border-radius: 8px; }
      .card .head button:hover { background: #1c1e24; color: #fff; }
      .card .head button.res { color: #34d399; }
      .msgs { max-height: 260px; overflow-y: auto; padding: 10px 12px; display: flex; flex-direction: column; gap: 10px; }
      .msg { display: flex; gap: 8px; }
      .av { width: 24px; height: 24px; border-radius: 999px; background: #2a2c33; color: #e7e8ea; font-size: 10px;
        font-weight: 700; display: inline-flex; align-items: center; justify-content: center; flex: none; }
      .msg .b { min-width: 0; flex: 1; }
      .msg .who { font-size: 11px; color: #8b8e98; margin-bottom: 2px; }
      .msg .who b { color: #e7e8ea; font-size: 11.5px; }
      .msg .txt { font-size: 13px; line-height: 1.45; white-space: pre-wrap; word-wrap: break-word; }
      .msg .txt .mn { color: #fbbf24; font-weight: 600; }
      .atts { display: flex; gap: 6px; margin-top: 6px; flex-wrap: wrap; }
      .atts img { height: 64px; max-width: 120px; object-fit: cover; border-radius: 8px; border: 1px solid #2a2c33; cursor: zoom-in; }
      .compose { position: relative; border-top: 1px solid #22242b; padding: 10px 12px; }
      .compose textarea { width: 100%; min-height: 60px; resize: none; background: #16181d; color: #e7e8ea;
        border: 1px solid #2a2c33; border-radius: 10px; padding: 8px 10px; font-size: 13px; line-height: 1.4; outline: none; }
      .compose textarea:focus { border-color: #f59e0b55; }
      .chips { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
      .chip { position: relative; width: 56px; height: 42px; border-radius: 8px; overflow: hidden; border: 1px solid #2a2c33; }
      .chip img { width: 100%; height: 100%; object-fit: cover; display: block; }
      .chip button { position: absolute; top: 2px; right: 2px; width: 16px; height: 16px; border-radius: 999px;
        background: rgba(0,0,0,.65); color: #fff; justify-content: center; }
      .compose .row { display: flex; align-items: center; gap: 4px; margin-top: 8px; }
      .compose .iconbtn { width: 30px; height: 30px; border-radius: 8px; color: #8b8e98; justify-content: center; }
      .compose .iconbtn:hover { background: #1c1e24; color: #fff; }
      .compose .hintline { font-size: 10.5px; color: #6b6e78; flex: 1; text-align: right; margin-right: 8px; }
      .compose .send { background: #f59e0b; color: #16130a; font-size: 12.5px; font-weight: 700; padding: 6px 14px; border-radius: 999px; }
      .compose .send:disabled { opacity: .45; cursor: default; }
      .mentions { position: absolute; bottom: calc(100% - 4px); left: 12px; right: 12px; background: #16181d;
        border: 1px solid #2a2c33; border-radius: 10px; overflow: hidden; box-shadow: 0 10px 30px rgba(0,0,0,.5); }
      .mentions button { display: flex; width: 100%; align-items: center; gap: 8px; padding: 7px 10px; font-size: 12.5px; color: #e7e8ea; }
      .mentions button:hover { background: #22242b; }
      .inboxcard { position: fixed; right: 16px; bottom: 64px; width: 380px; max-width: calc(100vw - 24px);
        max-height: min(520px, calc(100vh - 96px)); }
      .tabs { display: flex; gap: 2px; padding: 8px 10px 0; }
      .tabs button { font-size: 12px; font-weight: 600; color: #8b8e98; padding: 6px 12px; border-radius: 8px 8px 0 0; }
      .tabs button.on { background: #16181d; color: #fff; }
      .rows { overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 6px; background: #16181d; flex: 1; }
      .rowitem { text-align: left; background: #0e0f13; border: 1px solid #22242b; border-radius: 10px; padding: 9px 11px; display: block; width: 100%; }
      .rowitem:hover { border-color: #f59e0b66; }
      .rowitem .p { font-size: 11px; color: #fbbf24; font-weight: 600; margin-bottom: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .rowitem .s { font-size: 12.5px; color: #e7e8ea; line-height: 1.35; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
      .rowitem .m { font-size: 10.5px; color: #6b6e78; margin-top: 4px; }
      .empty { padding: 26px 12px; text-align: center; font-size: 12.5px; color: #6b6e78; }
      .editor { position: fixed; inset: 0; background: rgba(4,5,8,.8); display: flex; flex-direction: column;
        align-items: center; justify-content: center; gap: 12px; pointer-events: auto; }
      .editor canvas { max-width: calc(100vw - 48px); max-height: calc(100vh - 150px); border-radius: 10px;
        box-shadow: 0 20px 60px rgba(0,0,0,.6); background: #000; touch-action: none; }
      .etools { display: flex; align-items: center; gap: 4px; background: #0e0f13; border: 1px solid #2a2c33;
        padding: 5px; border-radius: 999px; color: #b6b8bf; }
      .etools button { width: 32px; height: 32px; border-radius: 999px; justify-content: center; }
      .etools button:hover { background: #1c1e24; color: #fff; }
      .etools button.on { background: #f59e0b; color: #16130a; }
      .etools .sep { width: 1px; height: 18px; background: #2a2c33; margin: 0 3px; }
      .etools .sw { width: 18px; height: 18px; border-radius: 999px; border: 2px solid transparent; padding: 0; }
      .etools .sw.on { border-color: #fff; }
      .etools .use { width: auto; padding: 0 14px; background: #f59e0b; color: #16130a; font-size: 12.5px; font-weight: 700; }
      .lightbox { position: fixed; inset: 0; background: rgba(4,5,8,.88); display: flex; align-items: center;
        justify-content: center; pointer-events: auto; cursor: zoom-out; }
      .lightbox img { max-width: 92vw; max-height: 92vh; border-radius: 10px; }
    `;
    root.appendChild(style);

    const ui = {
      bar: document.createElement("div"),
      pins: document.createElement("div"),
      layer: document.createElement("div"),
      top: document.createElement("div"), // editor / lightbox - above cards
    };
    root.appendChild(ui.pins);
    root.appendChild(ui.layer);
    root.appendChild(ui.bar);
    root.appendChild(ui.top);

    /* ── screenshots: capture + annotate ── */

    async function captureTab() {
      if (!navigator.mediaDevices?.getDisplayMedia) return null;
      host.style.display = "none"; // keep Pinstage itself out of the shot
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: { displaySurface: "browser" },
          audio: false,
          preferCurrentTab: true,
          selfBrowserSurface: "include",
        });
        const video = document.createElement("video");
        video.srcObject = stream;
        video.muted = true;
        await video.play();
        // Give the share-dialog a beat to dismiss so it isn't in the frame.
        await new Promise((r) => setTimeout(r, 450));
        const scale = Math.min(1, 2560 / Math.max(video.videoWidth, video.videoHeight || 1));
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(video.videoWidth * scale));
        c.height = Math.max(1, Math.round(video.videoHeight * scale));
        c.getContext("2d").drawImage(video, 0, 0, c.width, c.height);
        stream.getTracks().forEach((t) => t.stop());
        return c;
      } catch (e) {
        console.debug("[pinstage] capture cancelled:", e.message);
        return null;
      } finally {
        host.style.display = "";
      }
    }

    /** Annotation editor over a captured canvas. Resolves a JPEG Blob, or null. */
    function openEditor(baseCanvas) {
      return new Promise((resolve) => {
        let base = baseCanvas;
        let ops = [];        // {tool, color, points|x/y/w/h|x1..y2}
        const history = [];  // pre-crop {base, ops} snapshots
        let tool = "pen";
        let color = "#ef4444";
        let drag = null;

        const wrap = document.createElement("div");
        wrap.className = "editor";
        const cv = document.createElement("canvas");
        const ctx = cv.getContext("2d");
        const tools = document.createElement("div");
        tools.className = "etools";
        wrap.appendChild(cv);
        wrap.appendChild(tools);
        ui.top.appendChild(wrap);

        const lw = () => Math.max(3, Math.round(base.width / 420));

        function drawOp(o) {
          ctx.strokeStyle = o.color;
          ctx.lineWidth = lw();
          ctx.lineCap = "round";
          ctx.lineJoin = "round";
          if (o.tool === "pen") {
            ctx.beginPath();
            o.points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
            ctx.stroke();
          } else if (o.tool === "square") {
            ctx.strokeRect(o.x, o.y, o.w, o.h);
          } else if (o.tool === "arrow") {
            const a = Math.atan2(o.y2 - o.y1, o.x2 - o.x1);
            const hl = lw() * 4;
            ctx.beginPath();
            ctx.moveTo(o.x1, o.y1);
            ctx.lineTo(o.x2, o.y2);
            ctx.moveTo(o.x2, o.y2);
            ctx.lineTo(o.x2 - hl * Math.cos(a - 0.45), o.y2 - hl * Math.sin(a - 0.45));
            ctx.moveTo(o.x2, o.y2);
            ctx.lineTo(o.x2 - hl * Math.cos(a + 0.45), o.y2 - hl * Math.sin(a + 0.45));
            ctx.stroke();
          }
        }

        function redraw(marquee) {
          cv.width = base.width;
          cv.height = base.height;
          ctx.drawImage(base, 0, 0);
          ops.forEach(drawOp);
          if (drag && tool !== "crop") drawOp(dragOp());
          if (marquee && drag) {
            const { x, y, w, h } = normRect(drag);
            ctx.save();
            ctx.fillStyle = "rgba(4,5,8,.55)";
            // dim everything but the marquee
            ctx.beginPath();
            ctx.rect(0, 0, cv.width, cv.height);
            ctx.rect(x, y, w, h);
            ctx.fill("evenodd");
            ctx.strokeStyle = "#f59e0b";
            ctx.lineWidth = Math.max(2, lw() / 2);
            ctx.setLineDash([8, 6]);
            ctx.strokeRect(x, y, w, h);
            ctx.restore();
          }
        }

        const normRect = (d) => ({
          x: Math.min(d.x0, d.x1), y: Math.min(d.y0, d.y1),
          w: Math.abs(d.x1 - d.x0), h: Math.abs(d.y1 - d.y0),
        });

        const dragOp = () =>
          tool === "pen"
            ? { tool, color, points: drag.points }
            : tool === "square"
              ? { tool, color, ...normRect(drag) }
              : { tool, color, x1: drag.x0, y1: drag.y0, x2: drag.x1, y2: drag.y1 };

        function toCanvas(e) {
          const r = cv.getBoundingClientRect();
          return { x: ((e.clientX - r.left) * cv.width) / r.width, y: ((e.clientY - r.top) * cv.height) / r.height };
        }

        cv.addEventListener("pointerdown", (e) => {
          cv.setPointerCapture(e.pointerId);
          const p = toCanvas(e);
          drag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y, points: [p] };
        });
        cv.addEventListener("pointermove", (e) => {
          if (!drag) return;
          const p = toCanvas(e);
          drag.x1 = p.x;
          drag.y1 = p.y;
          drag.points.push(p);
          redraw(tool === "crop");
        });
        cv.addEventListener("pointerup", () => {
          if (!drag) return;
          if (tool === "crop") {
            const { x, y, w, h } = normRect(drag);
            drag = null;
            if (w > 24 && h > 24) {
              history.push({ base, ops: [...ops] });
              redraw(false); // flatten ops into the pixels we crop
              const c2 = document.createElement("canvas");
              c2.width = Math.round(w);
              c2.height = Math.round(h);
              c2.getContext("2d").drawImage(cv, x, y, w, h, 0, 0, w, h);
              base = c2;
              ops = [];
            }
          } else {
            ops.push(dragOp());
            drag = null;
          }
          redraw(false);
        });

        function toolBtn(name, tip) {
          const b = document.createElement("button");
          b.innerHTML = svg(name);
          b.title = tip;
          b.addEventListener("click", () => {
            tool = name;
            tools.querySelectorAll("button[data-tool]").forEach((x) => x.classList.toggle("on", x === b));
          });
          b.dataset.tool = name;
          return b;
        }

        const pen = toolBtn("pen", "Draw");
        pen.classList.add("on");
        tools.appendChild(pen);
        tools.appendChild(toolBtn("square", "Rectangle"));
        tools.appendChild(toolBtn("arrow", "Arrow"));
        tools.appendChild(toolBtn("crop", "Crop"));
        tools.insertAdjacentHTML("beforeend", '<span class="sep"></span>');
        ["#ef4444", "#f59e0b", "#3b82f6"].forEach((c, i) => {
          const b = document.createElement("button");
          b.className = "sw" + (i === 0 ? " on" : "");
          b.style.background = c;
          b.title = "Ink color";
          b.addEventListener("click", () => {
            color = c;
            tools.querySelectorAll(".sw").forEach((x) => x.classList.toggle("on", x === b));
          });
          tools.appendChild(b);
        });
        tools.insertAdjacentHTML("beforeend", '<span class="sep"></span>');
        const undo = document.createElement("button");
        undo.innerHTML = svg("undo");
        undo.title = "Undo";
        undo.addEventListener("click", () => {
          if (ops.length) ops.pop();
          else if (history.length) ({ base, ops } = history.pop());
          redraw(false);
        });
        tools.appendChild(undo);
        const cancel = document.createElement("button");
        cancel.innerHTML = svg("x");
        cancel.title = "Discard";
        const use = document.createElement("button");
        use.className = "use";
        use.innerHTML = svg("check") + "<span>Use</span>";
        tools.appendChild(cancel);
        tools.appendChild(use);

        const cleanup = () => {
          wrap.remove();
          removeEventListener("keydown", onKey, true);
        };
        const onKey = (e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            cleanup();
            resolve(null);
          }
        };
        addEventListener("keydown", onKey, true);
        cancel.addEventListener("click", () => { cleanup(); resolve(null); });
        use.addEventListener("click", () => {
          redraw(false);
          cv.toBlob((b) => { cleanup(); resolve(b); }, "image/jpeg", 0.85);
        });

        redraw(false);
      });
    }

    function showLightbox(url) {
      const lb = document.createElement("div");
      lb.className = "lightbox";
      lb.innerHTML = `<img src="${esc(url)}">`;
      lb.addEventListener("click", () => lb.remove());
      ui.top.appendChild(lb);
    }

    /* ── mention-aware composer with attachments ── */
    function buildComposer(placeholder, onSubmit) {
      const wrap = document.createElement("div");
      wrap.className = "compose";
      wrap.innerHTML = `
        <textarea placeholder="${esc(placeholder)}"></textarea>
        <div class="chips"></div>
        <div class="row"></div>`;
      const ta = wrap.querySelector("textarea");
      const chips = wrap.querySelector(".chips");
      const row = wrap.querySelector(".row");
      const picked = new Map(); // "@Name" token -> uid
      const atts = [];          // {blob, w, h, objUrl}
      let dropdown = null;

      const send = document.createElement("button");
      send.className = "send";
      send.innerHTML = svg("send", 14) + "<span>Post</span>";
      send.disabled = true;

      const syncSend = () => { send.disabled = !(ta.value.trim() || atts.length); };

      function addAttachment(blob) {
        if (!blob || atts.length >= 3) return;
        const objUrl = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
          atts.push({ blob, w: img.naturalWidth, h: img.naturalHeight, objUrl });
          renderChips();
          syncSend();
        };
        img.src = objUrl;
      }

      function renderChips() {
        chips.innerHTML = "";
        atts.forEach((a, i) => {
          const chip = document.createElement("div");
          chip.className = "chip";
          chip.innerHTML = `<img src="${a.objUrl}"><button title="Remove">${svg("x", 10)}</button>`;
          chip.querySelector("button").addEventListener("click", () => {
            URL.revokeObjectURL(a.objUrl);
            atts.splice(i, 1);
            renderChips();
            syncSend();
          });
          chips.appendChild(chip);
        });
      }

      if (canAttach) {
        const shot = document.createElement("button");
        shot.className = "iconbtn";
        shot.innerHTML = svg("camera");
        shot.title = "Capture & annotate a screenshot of this tab";
        shot.addEventListener("click", async () => {
          const grabbed = await captureTab();
          if (!grabbed) return;
          const blob = await openEditor(grabbed);
          if (blob) addAttachment(blob);
        });
        row.appendChild(shot);

        const file = document.createElement("input");
        file.type = "file";
        file.accept = "image/*";
        file.style.display = "none";
        file.addEventListener("change", () => {
          if (file.files?.[0]) addAttachment(file.files[0]);
          file.value = "";
        });
        const pick = document.createElement("button");
        pick.className = "iconbtn";
        pick.innerHTML = svg("image");
        pick.title = "Attach an image (or paste one into the text box)";
        pick.addEventListener("click", () => file.click());
        row.appendChild(pick);
        row.appendChild(file);

        ta.addEventListener("paste", (e) => {
          const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
          if (item) {
            e.preventDefault();
            addAttachment(item.getAsFile());
          }
        });
      }

      row.insertAdjacentHTML("beforeend", '<span class="hintline">@ to mention · Esc to close</span>');
      row.appendChild(send);

      const closeDropdown = () => { if (dropdown) { dropdown.remove(); dropdown = null; } };

      function openDropdown(list, replaceFrom) {
        closeDropdown();
        if (!list.length) return;
        dropdown = document.createElement("div");
        dropdown.className = "mentions";
        list.slice(0, 6).forEach((m) => {
          const b = document.createElement("button");
          b.innerHTML = `<span class="av">${esc(initials(m.name))}</span><span>${esc(m.name)}</span>`;
          b.addEventListener("click", () => {
            const token = "@" + m.name;
            picked.set(token, m.uid);
            ta.value = ta.value.slice(0, replaceFrom) + token + " " + ta.value.slice(ta.selectionStart);
            closeDropdown();
            ta.focus();
            syncSend();
          });
          dropdown.appendChild(b);
        });
        wrap.appendChild(dropdown);
      }

      ta.addEventListener("input", () => {
        syncSend();
        const upto = ta.value.slice(0, ta.selectionStart);
        const m = upto.match(/@([\w .-]{0,20})$/);
        if (m) {
          const q = m[1].toLowerCase();
          openDropdown(
            state.team.filter((t) => t.uid !== state.me.uid && t.name.toLowerCase().includes(q)),
            ta.selectionStart - m[0].length
          );
        } else closeDropdown();
      });
      ta.addEventListener("keydown", (e) => {
        if (e.key === "Escape") closeDropdown();
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !send.disabled) send.click();
        e.stopPropagation();
      });
      send.addEventListener("click", async () => {
        const body = ta.value.trim();
        if (!body && !atts.length) return;
        const mentions = [...new Set([...picked.entries()].filter(([tok]) => body.includes(tok)).map(([, uid]) => uid))];
        send.disabled = true;
        send.innerHTML = "<span>…</span>";
        try {
          await onSubmit(body, mentions, atts.map(({ blob, w, h }) => ({ blob, w, h })));
          atts.forEach((a) => URL.revokeObjectURL(a.objUrl));
        } catch (e) {
          console.warn("[pinstage] post failed:", e);
          send.innerHTML = svg("send", 14) + "<span>Post</span>";
          send.disabled = false;
        }
      });
      setTimeout(() => ta.focus(), 30);
      return wrap;
    }

    function renderBody(text, mentions) {
      let html = esc(text);
      state.team.forEach((m) => {
        if ((mentions || []).includes(m.uid)) {
          html = html.split(esc("@" + m.name)).join(`<span class="mn">@${esc(m.name)}</span>`);
        }
      });
      return html;
    }


    function makeCardDraggable(card) {
      const head = card.querySelector(".head");
      if (!head) return;
      head.style.cursor = "grab";
      head.style.userSelect = "none";
      head.style.touchAction = "none";

      let dragging = false;
      let startX = 0;
      let startY = 0;
      let initLeft = 0;
      let initTop = 0;

      const onPointerDown = (e) => {
        if (e.target && e.target.closest("button, input, textarea, a, select")) return;
        dragging = true;
        head.style.cursor = "grabbing";
        startX = e.clientX;
        startY = e.clientY;
        const rect = card.getBoundingClientRect();
        initLeft = rect.left;
        initTop = rect.top;
        try { head.setPointerCapture(e.pointerId); } catch {}
        e.preventDefault();
      };

      const onPointerMove = (e) => {
        if (!dragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        const w = card.offsetWidth || 340;
        const h = card.offsetHeight || 200;
        const maxLeft = Math.max(8, window.innerWidth - w - 8);
        const maxTop = Math.max(8, window.innerHeight - h - 8);
        const newLeft = Math.min(Math.max(8, initLeft + dx), maxLeft);
        const newTop = Math.min(Math.max(8, initTop + dy), maxTop);
        card.style.left = newLeft + "px";
        card.style.top = newTop + "px";
        card.style.right = "auto";
        card.style.bottom = "auto";
      };

      const onPointerUp = (e) => {
        if (!dragging) return;
        dragging = false;
        head.style.cursor = "grab";
        try { head.releasePointerCapture(e.pointerId); } catch {}
      };

      head.addEventListener("pointerdown", onPointerDown);
      head.addEventListener("pointermove", onPointerMove);
      head.addEventListener("pointerup", onPointerUp);
      head.addEventListener("pointercancel", onPointerUp);
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
    }

    function makePinDraggable(pin, onDrop, onClick) {
      pin.style.cursor = "grab";
      pin.style.touchAction = "none";
      pin.style.userSelect = "none";

      let dragging = false;
      let startX = 0;
      let startY = 0;
      let pX = 0;
      let pY = 0;
      let hasMoved = false;

      const onPointerDown = (e) => {
        e.stopPropagation();
        e.preventDefault();
        dragging = true;
        hasMoved = false;
        startX = e.clientX;
        startY = e.clientY;
        pX = parseFloat(pin.style.left) || startX;
        pY = parseFloat(pin.style.top) || startY;
        pin.style.cursor = "grabbing";
        try { pin.setPointerCapture(e.pointerId); } catch {}
      };

      const onPointerMove = (e) => {
        if (!dragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (!hasMoved && Math.hypot(dx, dy) > 4) {
          hasMoved = true;
        }
        if (hasMoved) {
          pin.style.left = (pX + dx) + "px";
          pin.style.top = (pY + dy) + "px";
        }
      };

      const onPointerUp = async (e) => {
        if (!dragging) return;
        dragging = false;
        pin.style.cursor = "grab";
        try { pin.releasePointerCapture(e.pointerId); } catch {}
        if (!hasMoved) {
          if (onClick) onClick(e);
        } else {
          if (onDrop) await onDrop(e.clientX, e.clientY);
        }
      };

      pin.addEventListener("pointerdown", onPointerDown);
      pin.addEventListener("pointermove", onPointerMove);
      pin.addEventListener("pointerup", onPointerUp);
      pin.addEventListener("pointercancel", onPointerUp);
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
    }

    function placeCard(card, x, y) {
      ui.layer.appendChild(card);
      const r = card.getBoundingClientRect();
      card.style.left = Math.min(Math.max(8, x + 18), window.innerWidth - r.width - 8) + "px";
      card.style.top = Math.min(Math.max(8, y - 20), window.innerHeight - r.height - 8) + "px";
    }

    function closeCards() {
      ui.layer.innerHTML = "";
      state.openThreadId = null;
    }

    function openNewThreadCard(initialAnchor, initialContext, initialX, initialY) {
      closeCards();
      let curAnchor = initialAnchor;
      let curContext = initialContext;
      let curX = initialX;
      let curY = initialY;

      // Floating draggable placement pin marker
      const tempPin = document.createElement("div");
      tempPin.className = "pinbtn newpin st-open";
      tempPin.textContent = "+";
      tempPin.style.left = curX + "px";
      tempPin.style.top = curY + "px";
      tempPin.title = "Drag to move pin location";
      ui.layer.appendChild(tempPin);

      makePinDraggable(
        tempPin,
        async (dropX, dropY) => {
          const res = anchorFromPoint(dropX, dropY);
          curAnchor = res.anchor;
          curContext = res.context;
          curX = dropX;
          curY = dropY;
        },
        null
      );

      const card = document.createElement("div");
      card.className = "card";
      card.innerHTML = `<div class="head"><span class="av">${esc(initials(state.me.name))}</span>
        <span class="t">New comment</span><button class="x">${svg("x", 14)}</button></div>`;
      card.querySelector(".x").addEventListener("click", () => {
        tempPin.remove();
        closeCards();
      });
      card.appendChild(
        buildComposer("Describe the issue or leave feedback…", async (body, mentions, atts) => {
          await createThread(curAnchor, curContext, body, mentions, atts);
          tempPin.remove();
          closeCards();
          setMode("idle");
        })
      );
      placeCard(card, initialX, initialY);
      makeCardDraggable(card);
    }

    async function openThreadCard(thread, x, y) {
      closeCards();
      state.openThreadId = thread.id;
      const d = thread.data || {};
      const card = document.createElement("div");
      card.className = "card";
      const st = d.status || "open";
      const meta = getStatusMeta(st);
      const resolved = st === "resolved";
      card.innerHTML = `<div class="head">
          <span class="t">${esc(d.createdBy?.name || "Thread")} · ${esc(timeAgo(d.createdAt?._ts))}</span>
          <span class="stbadge ${meta.class}"><span class="stdot"></span>${meta.label}</span>
          <button class="res" title="${resolved ? "Reopen" : "Resolve"}">${svg(resolved ? "reopen" : "check", 14)}<span>${resolved ? "Reopen" : "Resolve"}</span></button>
          <button class="x">${svg("x", 14)}</button>
        </div>
        <div class="msgs"><div class="empty">Loading…</div></div>`;
      card.querySelector(".x").addEventListener("click", closeCards);
      card.querySelector(".res").addEventListener("click", async () => {
        await setThreadStatus(thread.id, resolved ? "open" : "resolved");
        closeCards();
      });
      card.appendChild(
        buildComposer("Reply…", async (body, mentions, atts) => {
          await addComment(thread.id, body, mentions, false, atts);
          await fill();
          const ta = card.querySelector(".compose textarea");
          ta.value = "";
          card.querySelector(".compose .chips").innerHTML = "";
          const send = card.querySelector(".compose .send");
          send.innerHTML = svg("send", 14) + "<span>Post</span>";
          send.disabled = true;
        })
      );
      placeCard(card, x, y);
      makeCardDraggable(card);

      const fill = async () => {
        const comments = await adapter.listComments(thread.id);
        const box = card.querySelector(".msgs");
        box.innerHTML = comments.length
          ? comments
              .map(
                (c) => `<div class="msg"><span class="av">${esc(initials(c.data.authorName))}</span>
                  <div class="b"><div class="who"><b>${esc(c.data.authorName)}</b> · ${esc(timeAgo(c.data.createdAt?._ts))}</div>
                  <div class="txt">${renderBody(c.data.body, c.data.mentions)}</div>
                  ${(c.data.attachments || []).length
                    ? `<div class="atts">${c.data.attachments.map((a) => `<img src="${esc(a.url)}" loading="lazy">`).join("")}</div>`
                    : ""}
                  </div></div>`
              )
              .join("")
          : `<div class="empty">No comments</div>`;
        box.querySelectorAll(".atts img").forEach((img) =>
          img.addEventListener("click", () => showLightbox(img.src))
        );
        box.scrollTop = box.scrollHeight;
      };
      await fill();
    }

    /* ── pins ── */
    function getStatusMeta(status) {
      switch (status) {
        case "in_progress":
          return { key: "in_progress", label: "Agent fixing…", class: "st-in-progress" };
        case "deploying":
          return { key: "deploying", label: "Deploying…", class: "st-deploying" };
        case "deployed":
          return { key: "deployed", label: "Deployed · Ready to test", class: "st-deployed" };
        case "resolved":
          return { key: "resolved", label: "Resolved", class: "st-resolved" };
        case "open":
        default:
          return { key: "open", label: "Open", class: "st-open" };
      }
    }

    function renderPins() {
      ui.pins.innerHTML = "";
      if (state.hidden) return;
      state.threads.forEach((t, i) => {
        const p = anchorPoint(t.data?.anchor);
        const st = t.data?.status || "open";
        const meta = getStatusMeta(st);
        const pin = document.createElement("button");
        pin.className = "pinbtn " + meta.class;
        pin.textContent = String(i + 1);
        pin.style.left = p.x + "px";
        pin.style.top = p.y + "px";
        pin.title = "[" + meta.label + "] " + (t.data?.preview || "") + " (Drag to move)";
        makePinDraggable(
          pin,
          async (dropX, dropY) => {
            const { anchor, context } = anchorFromPoint(dropX, dropY);
            t.data.anchor = anchor;
            t.data.context = context;
            t.data.lastActivityAt = now();
            await adapter.updateThreadData(t.id, t.data);
            renderPins();
          },
          () => openThreadCard(t, p.x, p.y)
        );
        ui.pins.appendChild(pin);
      });
    }

    let rafPending = false;
    const reposition = () => {
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        renderPins();
      });
    };
    addEventListener("scroll", reposition, { passive: true, capture: true });
    addEventListener("resize", reposition, { passive: true });

    /* ── comment mode ── */
    function setMode(mode) {
      state.mode = mode;
      ui.layer.querySelectorAll(".overlay").forEach((o) => o.remove());
      if (mode === "comment") {
        const overlay = document.createElement("div");
        overlay.className = "overlay";
        overlay.innerHTML = `<div class="hint">Click anywhere to leave a comment · Esc to exit</div>`;
        overlay.addEventListener("click", (ev) => {
          if (ev.target !== overlay) return;
          const { anchor, context } = anchorFromClick(ev);
          overlay.remove();
          state.mode = "idle";
          renderBar();
          openNewThreadCard(anchor, context, ev.clientX, ev.clientY);
        });
        ui.layer.appendChild(overlay);
      }
      renderBar();
    }

    addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if (state.mode === "comment") setMode("idle");
        else closeCards();
      }
    });

    /* ── inbox ── */
    async function renderInbox() {
      closeCards();
      const card = document.createElement("div");
      card.className = "card inboxcard";
      card.innerHTML = `<div class="head"><span class="t">Issues · ${esc(project)}</span><button class="x">${svg("x", 14)}</button></div>
        <div class="tabs"><button data-t="open">Open</button><button data-t="resolved">Resolved</button></div>
        <div class="rows"><div class="empty">Loading…</div></div>`;
      card.querySelector(".x").addEventListener("click", () => { state.inboxOpen = false; closeCards(); });
      const rowsBox = card.querySelector(".rows");
      const tabs = card.querySelectorAll(".tabs button");
      const showTab = async (tab) => {
        state.inboxTab = tab;
        tabs.forEach((b) => b.classList.toggle("on", b.dataset.t === tab));
        rowsBox.innerHTML = `<div class="empty">Loading…</div>`;
        const list = await adapter.listThreads({ project, status: tab });
        rowsBox.innerHTML = "";
        if (!list.length) {
          rowsBox.innerHTML = `<div class="empty">${tab === "open" ? "Nothing open - nice." : "Nothing resolved yet."}</div>`;
          return;
        }
        list.forEach((t) => {
          const d = t.data || {};
          const st = d.status || "open";
          const meta = getStatusMeta(st);
          const b = document.createElement("button");
          b.className = "rowitem";
          b.innerHTML = `<div class="rowhead"><span class="p">${esc(d.path || "/")}</span><span class="stbadge ${meta.class}"><span class="stdot"></span>${meta.label}</span></div>
            <div class="s">${esc(d.preview || "")}</div>
            <div class="m">${esc(d.createdBy?.name || "")} · ${d.messageCount || 1} comment${(d.messageCount || 1) > 1 ? "s" : ""} · ${esc(timeAgo(d.lastActivityAt?._ts || d.createdAt?._ts))}</div>`;
          b.addEventListener("click", () => {
            state.inboxOpen = false;
            if ((d.path || "/") === state.pathname) {
              closeCards();
              const p = anchorPoint(d.anchor);
              openThreadCard(t, p.x, p.y);
            } else {
              const sep = (d.query || "").length ? "&" : "?";
              location.href = (d.path || "/") + (d.query || "") + sep + "mdthread=" + t.id;
            }
          });
          rowsBox.appendChild(b);
        });
      };
      tabs.forEach((b) => b.addEventListener("click", () => showTab(b.dataset.t)));
      ui.layer.appendChild(card);
      makeCardDraggable(card);
      await showTab(state.inboxTab);
    }

    /* ── the bar ── */
    function renderBar() {
      ui.bar.innerHTML = "";
      if (state.hidden) {
        const dot = document.createElement("button");
        dot.className = "dot";
        dot.title = "Pinstage";
        dot.innerHTML = logo(17);
        dot.addEventListener("click", () => setHidden(false));
        ui.bar.appendChild(dot);
        return;
      }
      const bar = document.createElement("div");
      bar.className = "bar";
      bar.innerHTML = `<span class="brand" title="Pinstage">${logo(15)}<span class="env">${esc(cfg.environmentLabel || "Staging")}</span></span>`;

      const comment = document.createElement("button");
      comment.className = state.mode === "comment" ? "active" : "";
      comment.innerHTML = svg("comment", 14) + `<span>${state.mode === "comment" ? "Click the page…" : "Comment"}</span>`;
      comment.addEventListener("click", () => setMode(state.mode === "comment" ? "idle" : "comment"));
      bar.appendChild(comment);

      const inbox = document.createElement("button");
      inbox.innerHTML = svg("inbox", 14) + `<span>Issues</span>${state.threads.length ? `<span class="badge">${state.threads.length}</span>` : ""}`;
      inbox.title = "All reported issues";
      inbox.addEventListener("click", () => {
        state.inboxOpen = !state.inboxOpen;
        if (state.inboxOpen) renderInbox();
        else closeCards();
      });
      bar.appendChild(inbox);

      const hide = document.createElement("button");
      hide.innerHTML = svg("minus", 14);
      hide.title = "Hide toolbar";
      hide.addEventListener("click", () => setHidden(true));
      bar.appendChild(hide);

      ui.bar.appendChild(bar);
    }

    /* ── SPA navigation: reload pins when the host app changes routes ── */
    function onPathMaybeChanged() {
      if (location.pathname === state.pathname) return;
      state.pathname = location.pathname;
      closeCards();
      setMode("idle");
      loadThreadsForPage().catch((e) => console.debug("[pinstage]", e.message));
    }
    ["pushState", "replaceState"].forEach((fn) => {
      const orig = history[fn];
      history[fn] = function () {
        const r = orig.apply(this, arguments);
        setTimeout(onPathMaybeChanged, 0);
        return r;
      };
    });
    addEventListener("popstate", onPathMaybeChanged);

    /* ── deep link (?mdthread=<id>) ── */
    async function openDeepLink() {
      const id = new URLSearchParams(location.search).get("mdthread");
      if (!id) return;
      try {
        const t = await adapter.getThread(id);
        if (!t) return;
        const sel = t.data?.anchor?.selector;
        if (sel) {
          try { document.querySelector(sel)?.scrollIntoView({ block: "center" }); } catch { /* ignore */ }
        }
        setTimeout(() => {
          const p = anchorPoint(t.data?.anchor);
          openThreadCard(t, p.x, p.y);
        }, 350);
      } catch (e) {
        console.debug("[pinstage] deep link failed:", e.message);
      }
    }

    /* ── boot ── */
    (async () => {
      try {
        state.me = await adapter.getIdentity();
        if (!state.me) return; // not on the team - stay invisible
        state.team = await adapter.listTeam();
        document.body.appendChild(host);
        renderBar();
        await loadThreadsForPage();
        await openDeepLink();
        console.debug("[pinstage] ready as", state.me.name);
      } catch (e) {
        console.debug("[pinstage] dormant:", e.message);
      }
    })();
  }

  window.Pinstage = { init, supabaseAdapter };
})();
