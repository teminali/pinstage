/* ═══════════════════════════════════════════════════════════════════════════
 * md-toolbar — an open-source staging toolbar for your own product
 * https://github.com/teminali/md-toolbar · MIT © Muhasibu Digital
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Figma/Vercel-style pinned comment threads for your STAGING environment:
 * your team clicks anywhere on a page, leaves a comment, @mentions teammates,
 * and every thread is equally readable by your admin dashboard, scripts, or
 * CI — because the toolbar owns no data store of its own.
 *
 * ARCHITECTURE — core + adapter:
 *   The UI core (this file's bulk) talks to a small ADAPTER interface. Ship
 *   the built-in Supabase adapter, or implement ~8 methods against any
 *   backend (REST, GraphQL, Firebase…) and the toolbar works unchanged. Your
 *   dashboard integrates by reading the same store the adapter writes.
 *
 *   adapter = {
 *     getIdentity():            Promise<{uid,name,email}|null>   // null → toolbar stays invisible
 *     listTeam():               Promise<[{uid,name,email,role}]> // @mention picker
 *     listThreads({project, path?, status}): Promise<[{id,data}]>
 *     getThread(id):            Promise<{id,data}|null>
 *     createThread({id,data}):  Promise<void>
 *     updateThreadData(id, data): Promise<void>                  // full data replace
 *     listComments(threadId):   Promise<[{id,data}]>
 *     addComment({id,data}):    Promise<void>
 *     notifyMentions?(payload): Promise<void>                    // optional
 *   }
 *
 * QUICK START (Supabase backend — see examples/schema.supabase.sql):
 *
 *   <script src="/toolbar/md-toolbar.js"></script>
 *   <script>
 *     MDToolbar.init({
 *       project: "my-web-app",
 *       adapter: MDToolbar.supabaseAdapter({
 *         url: "https://<ref>.supabase.co",
 *         anonKey: "<anon key>",
 *         getToken: async () => sessionAccessTokenOrNull,
 *       }),
 *     });
 *   </script>
 *
 * The HOST decides where this runs (load the script on staging only). All
 * writes go through your backend's row-level security with the user's own
 * token — the toolbar is UI, not a security boundary.
 *
 * Zero dependencies. All UI lives in a shadow root so host CSS and toolbar
 * CSS cannot touch each other.
 * ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  if (window.MDToolbar) return; // idempotent under double-injection

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
      const payload = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      return JSON.parse(decodeURIComponent(escape(atob(payload))));
    } catch {
      return null;
    }
  }

  /* Selector for the element under a click — stable-ish across renders:
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
  /* Built-in Supabase adapter (PostgREST + RLS)                              */
  /* ═══════════════════════════════════════════════════════════════════════ */

  /**
   * MDToolbar.supabaseAdapter(options)
   *
   * options:
   *   url, anonKey            — the Supabase project
   *   getToken()              — async, returns the signed-in user's JWT (or null)
   *   tables?                 — { team, threads, comments, notifications } name overrides
   *   uidFromClaims?(claims)  — where your app's uid lives in the JWT
   *                             (default: app_metadata.firebase_uid ?? sub)
   *   adminSelfRegister?      — { usersTable, roleSelect, nameSelect, adminRole }
   *                             lets platform admins auto-join the team roster
   *                             on first use. Off unless provided.
   *   mentionType?            — notification `type` value (default "md_toolbar_mention")
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
      const res = await fetch(opts.url.replace(/\/$/, "") + "/rest/v1/" + path, {
        ...(init_ || {}),
        headers: {
          apikey: opts.anonKey,
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
          ...((init_ && init_.headers) || {}),
        },
      });
      if (!res.ok) throw new Error("[md-toolbar] " + res.status + " " + (await res.text()));
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    }

    return {
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
            console.debug("[md-toolbar] admin self-register skipped:", e.message);
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
        let q = T.threads + "?select=id,data&data->>project=eq." + encodeURIComponent(project) +
          "&data->>status=eq." + encodeURIComponent(status) +
          "&order=data->lastActivityAt->_ts.desc.nullslast&limit=100";
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
      console.warn("[md-toolbar] init: an adapter is required");
      return;
    }
    if (init._booted) return;
    init._booted = true;

    const adapter = cfg.adapter;
    const project = cfg.project || "unknown";

    const state = {
      me: null,
      team: [],
      threads: [],
      mode: "idle",
      openThreadId: null,
      inboxOpen: false,
      inboxTab: "open",
      hidden: false,
      pathname: location.pathname,
    };

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
        await adapter.notifyMentions({ targets, actor: state.me, threadId, path: state.pathname, url, body, project });
      } catch (e) {
        console.debug("[md-toolbar] mention notify failed:", e.message);
      }
    }

    async function createThread(anchor, body, mentions) {
      const threadId = uuid();
      const thread = {
        id: threadId,
        data: {
          project,
          path: state.pathname,
          query: location.search || "",
          anchor,
          preview: body.slice(0, 140),
          status: "open",
          createdBy: { uid: state.me.uid, name: state.me.name, email: state.me.email },
          createdAt: now(),
          lastActivityAt: now(),
          messageCount: 1,
          appVersion: cfg.appVersion || null,
          viewport: window.innerWidth + "x" + window.innerHeight,
          userAgent: navigator.userAgent,
        },
      };
      await adapter.createThread(thread);
      await addComment(threadId, body, mentions, true);
      state.threads.push(thread);
      renderPins();
      return threadId;
    }

    async function addComment(threadId, body, mentions, isFirst) {
      await adapter.addComment({
        id: uuid(),
        data: { threadId, authorUid: state.me.uid, authorName: state.me.name, body, mentions, createdAt: now() },
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
      } else {
        delete data.resolvedBy;
        delete data.resolvedAt;
      }
      await adapter.updateThreadData(threadId, data);
      state.threads = state.threads.filter((t) => t.id !== threadId);
      if (status === "open") await loadThreadsForPage();
      renderPins();
      renderBar();
    }

    /* ── anchoring ── */
    function anchorFromClick(ev) {
      host.style.pointerEvents = "none"; // so elementFromPoint sees the page
      const el = document.elementFromPoint(ev.clientX, ev.clientY) || document.body;
      host.style.pointerEvents = "";
      const r = el.getBoundingClientRect();
      const de = document.documentElement;
      return {
        selector: cssPath(el),
        relX: r.width ? (ev.clientX - r.left) / r.width : 0.5,
        relY: r.height ? (ev.clientY - r.top) / r.height : 0.5,
        docXPct: ev.clientX / de.clientWidth,
        docYPct: (ev.clientY + window.scrollY) / Math.max(1, de.scrollHeight),
      };
    }

    function anchorPoint(a) {
      if (a && a.selector) {
        try {
          const el = document.querySelector(a.selector);
          if (el) {
            const r = el.getBoundingClientRect();
            if (r.width || r.height) return { x: r.left + r.width * (a.relX ?? 0.5), y: r.top + r.height * (a.relY ?? 0.5) };
          }
        } catch { /* bad selector — fall through */ }
      }
      const de = document.documentElement;
      return {
        x: (a?.docXPct ?? 0.5) * de.clientWidth,
        y: (a?.docYPct ?? 0.5) * Math.max(1, de.scrollHeight) - window.scrollY,
      };
    }

    /* ── shadow-DOM UI ── */
    const host = document.createElement("div");
    host.setAttribute("data-md-toolbar", "");
    Object.assign(host.style, { position: "fixed", inset: "0", zIndex: String(cfg.zIndex || 2147483000), pointerEvents: "none" });
    const root = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `
      * { box-sizing: border-box; margin: 0; padding: 0; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
      button { cursor: pointer; border: 0; background: none; color: inherit; font: inherit; }
      .bar { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%);
        display: flex; align-items: center; gap: 2px; padding: 4px;
        background: #0e0f13; color: #e7e8ea; border: 1px solid #2a2c33; border-radius: 999px;
        box-shadow: 0 8px 30px rgba(0,0,0,.35); pointer-events: auto; }
      .bar .env { font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase;
        color: #fbbf24; padding: 0 10px; border-right: 1px solid #2a2c33; }
      .bar button { display: flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px;
        border-radius: 999px; font-size: 12.5px; font-weight: 600; color: #b6b8bf; }
      .bar button:hover { background: #1c1e24; color: #fff; }
      .bar button.active { background: #f59e0b; color: #16130a; }
      .bar .badge { min-width: 16px; height: 16px; padding: 0 4px; border-radius: 999px; background: #f59e0b;
        color: #16130a; font-size: 10px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; }
      .dot { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); width: 34px; height: 34px;
        border-radius: 999px; background: #0e0f13; color: #fbbf24; border: 1px solid #2a2c33; pointer-events: auto;
        display: flex; align-items: center; justify-content: center; font-size: 15px; box-shadow: 0 8px 30px rgba(0,0,0,.35); }
      .overlay { position: fixed; inset: 0; cursor: crosshair; pointer-events: auto; }
      .overlay .hint { position: fixed; top: 14px; left: 50%; transform: translateX(-50%);
        background: #0e0f13; color: #e7e8ea; border: 1px solid #2a2c33; padding: 7px 14px; border-radius: 999px; font-size: 12.5px; }
      .pin { position: fixed; width: 28px; height: 28px; margin: -14px 0 0 -14px; border-radius: 999px 999px 999px 4px;
        background: #f59e0b; color: #16130a; font-size: 12px; font-weight: 800; display: flex; align-items: center;
        justify-content: center; pointer-events: auto; border: 2px solid #fff; box-shadow: 0 3px 10px rgba(0,0,0,.35);
        transition: transform .12s; }
      .pin:hover { transform: scale(1.12); }
      .card { position: fixed; width: 340px; max-width: calc(100vw - 24px); background: #0e0f13; color: #e7e8ea;
        border: 1px solid #2a2c33; border-radius: 14px; box-shadow: 0 16px 50px rgba(0,0,0,.5);
        pointer-events: auto; display: flex; flex-direction: column; overflow: hidden; }
      .card .head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #22242b; }
      .card .head .t { font-size: 12.5px; font-weight: 700; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .card .head button { color: #8b8e98; font-size: 12px; padding: 4px 8px; border-radius: 8px; }
      .card .head button:hover { background: #1c1e24; color: #fff; }
      .card .head button.res { color: #34d399; }
      .msgs { max-height: 260px; overflow-y: auto; padding: 10px 12px; display: flex; flex-direction: column; gap: 10px; }
      .msg { display: flex; gap: 8px; }
      .av { width: 24px; height: 24px; border-radius: 999px; background: #2a2c33; color: #e7e8ea; font-size: 10px;
        font-weight: 700; display: flex; align-items: center; justify-content: center; flex: none; }
      .msg .b { min-width: 0; }
      .msg .who { font-size: 11px; color: #8b8e98; margin-bottom: 2px; }
      .msg .who b { color: #e7e8ea; font-size: 11.5px; }
      .msg .txt { font-size: 13px; line-height: 1.45; white-space: pre-wrap; word-wrap: break-word; }
      .msg .txt .mn { color: #fbbf24; font-weight: 600; }
      .compose { position: relative; border-top: 1px solid #22242b; padding: 10px 12px; }
      .compose textarea { width: 100%; min-height: 60px; resize: none; background: #16181d; color: #e7e8ea;
        border: 1px solid #2a2c33; border-radius: 10px; padding: 8px 10px; font-size: 13px; line-height: 1.4; outline: none; }
      .compose textarea:focus { border-color: #f59e0b55; }
      .compose .row { display: flex; justify-content: space-between; align-items: center; margin-top: 8px; }
      .compose .send { background: #f59e0b; color: #16130a; font-size: 12.5px; font-weight: 700; padding: 6px 14px; border-radius: 999px; }
      .compose .send:disabled { opacity: .45; cursor: default; }
      .compose .hintline { font-size: 10.5px; color: #6b6e78; }
      .mentions { position: absolute; bottom: calc(100% - 4px); left: 12px; right: 12px; background: #16181d;
        border: 1px solid #2a2c33; border-radius: 10px; overflow: hidden; box-shadow: 0 10px 30px rgba(0,0,0,.5); }
      .mentions button { display: flex; width: 100%; align-items: center; gap: 8px; padding: 7px 10px; font-size: 12.5px; color: #e7e8ea; }
      .mentions button:hover { background: #22242b; }
      .inbox { position: fixed; right: 16px; bottom: 64px; width: 380px; max-width: calc(100vw - 24px);
        max-height: min(520px, calc(100vh - 96px)); }
      .tabs { display: flex; gap: 2px; padding: 8px 10px 0; }
      .tabs button { font-size: 12px; font-weight: 600; color: #8b8e98; padding: 6px 12px; border-radius: 8px 8px 0 0; }
      .tabs button.on { background: #16181d; color: #fff; }
      .rows { overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 6px; background: #16181d; flex: 1; }
      .rowitem { text-align: left; background: #0e0f13; border: 1px solid #22242b; border-radius: 10px; padding: 9px 11px; }
      .rowitem:hover { border-color: #f59e0b66; }
      .rowitem .p { font-size: 11px; color: #fbbf24; font-weight: 600; margin-bottom: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .rowitem .s { font-size: 12.5px; color: #e7e8ea; line-height: 1.35; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
      .rowitem .m { font-size: 10.5px; color: #6b6e78; margin-top: 4px; }
      .empty { padding: 26px 12px; text-align: center; font-size: 12.5px; color: #6b6e78; }
    `;
    root.appendChild(style);

    const ui = {
      bar: document.createElement("div"),
      pins: document.createElement("div"),
      layer: document.createElement("div"),
    };
    root.appendChild(ui.pins);
    root.appendChild(ui.layer);
    root.appendChild(ui.bar);

    /* ── mention-aware composer (shared by new-thread + reply) ── */
    function buildComposer(placeholder, onSubmit) {
      const wrap = document.createElement("div");
      wrap.className = "compose";
      wrap.innerHTML = `
        <textarea placeholder="${esc(placeholder)}"></textarea>
        <div class="row"><span class="hintline">@ to mention · Esc to close</span>
        <button class="send" disabled>Post</button></div>`;
      const ta = wrap.querySelector("textarea");
      const send = wrap.querySelector(".send");
      const picked = new Map(); // "@Name" token -> uid
      let dropdown = null;

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
            send.disabled = !ta.value.trim();
          });
          dropdown.appendChild(b);
        });
        wrap.appendChild(dropdown);
      }

      ta.addEventListener("input", () => {
        send.disabled = !ta.value.trim();
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
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && ta.value.trim()) send.click();
        e.stopPropagation();
      });
      send.addEventListener("click", async () => {
        const body = ta.value.trim();
        if (!body) return;
        const mentions = [...new Set([...picked.entries()].filter(([tok]) => body.includes(tok)).map(([, uid]) => uid))];
        send.disabled = true;
        send.textContent = "…";
        try {
          await onSubmit(body, mentions);
        } catch (e) {
          console.warn(e);
          send.textContent = "Post";
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

    function openNewThreadCard(anchor, x, y) {
      closeCards();
      const card = document.createElement("div");
      card.className = "card";
      card.innerHTML = `<div class="head"><span class="av">${esc(initials(state.me.name))}</span>
        <span class="t">New comment</span><button class="x">✕</button></div>`;
      card.querySelector(".x").addEventListener("click", closeCards);
      card.appendChild(
        buildComposer("Describe the issue or leave feedback…", async (body, mentions) => {
          await createThread(anchor, body, mentions);
          closeCards();
          setMode("idle");
        })
      );
      placeCard(card, x, y);
    }

    async function openThreadCard(thread, x, y) {
      closeCards();
      state.openThreadId = thread.id;
      const d = thread.data || {};
      const card = document.createElement("div");
      card.className = "card";
      const resolved = d.status === "resolved";
      card.innerHTML = `<div class="head">
          <span class="t">${esc(d.createdBy?.name || "Thread")} · ${esc(timeAgo(d.createdAt?._ts))}</span>
          <button class="res">${resolved ? "Reopen" : "Resolve ✓"}</button>
          <button class="x">✕</button>
        </div>
        <div class="msgs"><div class="empty">Loading…</div></div>`;
      card.querySelector(".x").addEventListener("click", closeCards);
      card.querySelector(".res").addEventListener("click", async () => {
        await setThreadStatus(thread.id, resolved ? "open" : "resolved");
        closeCards();
      });
      card.appendChild(
        buildComposer("Reply…", async (body, mentions) => {
          await addComment(thread.id, body, mentions, false);
          await fill();
          const ta = card.querySelector(".compose textarea");
          ta.value = "";
          const send = card.querySelector(".compose .send");
          send.textContent = "Post";
          send.disabled = true;
        })
      );
      placeCard(card, x, y);

      const fill = async () => {
        const comments = await adapter.listComments(thread.id);
        const box = card.querySelector(".msgs");
        box.innerHTML = comments.length
          ? comments
              .map(
                (c) => `<div class="msg"><span class="av">${esc(initials(c.data.authorName))}</span>
                  <div class="b"><div class="who"><b>${esc(c.data.authorName)}</b> · ${esc(timeAgo(c.data.createdAt?._ts))}</div>
                  <div class="txt">${renderBody(c.data.body, c.data.mentions)}</div></div></div>`
              )
              .join("")
          : `<div class="empty">No comments</div>`;
        box.scrollTop = box.scrollHeight;
      };
      await fill();
    }

    /* ── pins ── */
    function renderPins() {
      ui.pins.innerHTML = "";
      if (state.hidden) return;
      state.threads.forEach((t, i) => {
        const p = anchorPoint(t.data?.anchor);
        const pin = document.createElement("button");
        pin.className = "pin";
        pin.textContent = String(i + 1);
        pin.style.left = p.x + "px";
        pin.style.top = p.y + "px";
        pin.title = t.data?.preview || "";
        pin.addEventListener("click", () => openThreadCard(t, p.x, p.y));
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
          const anchor = anchorFromClick(ev);
          overlay.remove();
          state.mode = "idle";
          renderBar();
          openNewThreadCard(anchor, ev.clientX, ev.clientY);
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
      card.className = "card inbox";
      card.innerHTML = `<div class="head"><span class="t">Issues · ${esc(project)}</span><button class="x">✕</button></div>
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
          rowsBox.innerHTML = `<div class="empty">${tab === "open" ? "Nothing open — nice." : "Nothing resolved yet."}</div>`;
          return;
        }
        list.forEach((t) => {
          const d = t.data || {};
          const b = document.createElement("button");
          b.className = "rowitem";
          b.innerHTML = `<div class="p">${esc(d.path || "/")}</div>
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
      await showTab(state.inboxTab);
    }

    /* ── the bar ── */
    function renderBar() {
      ui.bar.innerHTML = "";
      if (state.hidden) {
        const dot = document.createElement("button");
        dot.className = "dot";
        dot.title = "md-toolbar";
        dot.textContent = "◍";
        dot.addEventListener("click", () => { state.hidden = false; renderBar(); renderPins(); });
        ui.bar.appendChild(dot);
        return;
      }
      const bar = document.createElement("div");
      bar.className = "bar";
      bar.innerHTML = `<span class="env">${esc(cfg.environmentLabel || "Staging")}</span>`;

      const comment = document.createElement("button");
      comment.className = state.mode === "comment" ? "active" : "";
      comment.textContent = state.mode === "comment" ? "Click the page…" : "💬 Comment";
      comment.addEventListener("click", () => setMode(state.mode === "comment" ? "idle" : "comment"));
      bar.appendChild(comment);

      const inbox = document.createElement("button");
      inbox.innerHTML = `Issues ${state.threads.length ? `<span class="badge">${state.threads.length}</span>` : ""}`;
      inbox.title = "All reported issues";
      inbox.addEventListener("click", () => {
        state.inboxOpen = !state.inboxOpen;
        if (state.inboxOpen) renderInbox();
        else closeCards();
      });
      bar.appendChild(inbox);

      const hide = document.createElement("button");
      hide.textContent = "–";
      hide.title = "Hide toolbar";
      hide.addEventListener("click", () => { state.hidden = true; closeCards(); setMode("idle"); renderBar(); renderPins(); });
      bar.appendChild(hide);

      ui.bar.appendChild(bar);
    }

    /* ── SPA navigation: reload pins when the host app changes routes ── */
    function onPathMaybeChanged() {
      if (location.pathname === state.pathname) return;
      state.pathname = location.pathname;
      closeCards();
      setMode("idle");
      loadThreadsForPage().catch((e) => console.debug("[md-toolbar]", e.message));
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
        console.debug("[md-toolbar] deep link failed:", e.message);
      }
    }

    /* ── boot ── */
    (async () => {
      try {
        state.me = await adapter.getIdentity();
        if (!state.me) return; // not on the team — stay invisible
        state.team = await adapter.listTeam();
        document.body.appendChild(host);
        renderBar();
        await loadThreadsForPage();
        await openDeepLink();
        console.debug("[md-toolbar] ready as", state.me.name);
      } catch (e) {
        console.debug("[md-toolbar] dormant:", e.message);
      }
    })();
  }

  window.MDToolbar = { init, supabaseAdapter };
})();
