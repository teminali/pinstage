/*!
 * Pinstage Studio — screen + webcam tutorial recorder with click-driven zoom.
 * v0.6.0 · MIT © Teminali
 *
 * Loaded on demand by pinstage.js (never on page load) so the base toolbar
 * stays small. Zero dependencies, one file, browser-only.
 *
 * ── Why it is built this way ────────────────────────────────────────────────
 *
 * The zoom effect that makes a tutorial readable does NOT come from analysing
 * the video. It comes from never baking the cursor in: the screen is captured
 * with `cursor: "never"`, and the pointer is recorded SEPARATELY as a track of
 * timestamped coordinates and clicks. That track then drives three things a
 * pixel-analysis approach could never do well — a synthetic cursor drawn at any
 * size with real motion blur, a click bounce that lands on the exact frame of
 * the press, and zoom segments planned around where the work actually happened.
 *
 * A browser can only observe pointer events inside its own page. So:
 *
 *   • Recording THIS TAB (the default) gives an exact pointer track and the
 *     full effect set.
 *   • Recording another window or screen gives no pointer data at all, so the
 *     OS cursor is composited in by the capture instead and zoom becomes
 *     manual keyframes. The UI says which mode is live rather than silently
 *     producing a worse video.
 *
 * ── Handling hours ─────────────────────────────────────────────────────────
 *
 * Nothing is held in memory. MediaRecorder chunks stream straight into an OPFS
 * file as they arrive, so a three-hour capture costs the same RAM as a
 * three-minute one and survives a reload. The pointer track is flushed to OPFS
 * on the same cadence. Export streams back out the same way.
 */
(function () {
  "use strict";

  if (window.PinstageStudio) return;

  /* ── small helpers ───────────────────────────────────────────────────── */

  const uuid = () =>
    crypto.randomUUID
      ? crypto.randomUUID()
      : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
          const r = (Math.random() * 16) | 0;
          return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
        });

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const lerp = (a, b, t) => a + (b - a) * t;

  /** Elapsed time for humans. Shared shape with the toolbar's timer. */
  const formatDuration = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(s / 60);
    if (m < 60) return m + ":" + String(s % 60).padStart(2, "0");
    const h = Math.floor(m / 60);
    return h + ":" + String(m % 60).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
  };

  const formatBytes = (b) => {
    if (b < 1024) return b + " B";
    if (b < 1048576) return (b / 1024).toFixed(0) + " KB";
    if (b < 1073741824) return (b / 1048576).toFixed(1) + " MB";
    return (b / 1073741824).toFixed(2) + " GB";
  };

  /* ── easing ──────────────────────────────────────────────────────────────
   * A zoom that moves on a linear or plain ease-in-out ramp reads as a slide
   * show. These are the two curves the whole feel rests on:
   *
   *   glide   — a heavily front-loaded ease that covers most of the distance
   *             early and then settles, so the eye arrives before the motion
   *             finishes and the destination feels held rather than reached.
   *   settle  — the same, plus a small critically-damped overshoot on the way
   *             in. That overshoot is the difference between "the frame
   *             scaled" and "a camera pushed in".
   */
  const ease = {
    glide: (t) => 1 - Math.pow(1 - t, 4),
    settle: (t) => {
      if (t >= 1) return 1;
      // Damped spring, normalised so f(0)=0 and f(1)=1.
      const w = 9.4, z = 0.62;
      const wd = w * Math.sqrt(1 - z * z);
      return 1 - Math.exp(-z * w * t) * (Math.cos(wd * t) + ((z * w) / wd) * Math.sin(wd * t));
    },
    // Symmetric, for the way back out — an overshoot on exit looks like a
    // mistake, so the release is plain.
    out: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  };

  /* ── OPFS store ──────────────────────────────────────────────────────────
   * Recordings live in the origin private file system, not in memory and not
   * in IndexedDB: writes are streamed, reads come back as a real File, and the
   * only ceiling is disk. Everything degrades to a plain in-memory buffer if
   * OPFS is missing, with the size cap made explicit rather than discovered as
   * a tab crash two hours in.
   */
  const store = {
    supported: !!(navigator.storage && navigator.storage.getDirectory),

    async dir() {
      const root = await navigator.storage.getDirectory();
      const ps = await root.getDirectoryHandle("pinstage", { create: true });
      return ps.getDirectoryHandle("recordings", { create: true });
    },

    /** A write stream for one file, plus the bytes written so far. */
    async writer(id, name) {
      if (!this.supported) {
        const parts = [];
        const patches = [];
        let bytes = 0;
        return {
          fallback: true,
          async write(chunk) {
            parts.push(chunk);
            bytes += chunk.size || chunk.byteLength || 0;
          },
          // Without OPFS there is no file to seek into, so patches are held and
          // applied when the blob is finally assembled.
          async writeAt(position, data) {
            patches.push({ position, data });
          },
          async close() {},
          get bytes() {
            return bytes;
          },
          blob(type) {
            const blob = new Blob(parts, { type });
            if (!patches.length) return blob;
            return blob.arrayBuffer().then((ab) => {
              const u = new Uint8Array(ab);
              patches.forEach((p) => u.set(p.data, p.position));
              return new Blob([u], { type });
            });
          },
        };
      }
      const dir = await this.dir();
      const sub = await dir.getDirectoryHandle(id, { create: true });
      const handle = await sub.getFileHandle(name, { create: true });
      const stream = await handle.createWritable({ keepExistingData: false });
      let bytes = 0;
      return {
        fallback: false,
        async write(chunk) {
          await stream.write(chunk);
          bytes += chunk.size || chunk.byteLength || 0;
        },
        /** Overwrite bytes already written — how the container's size and
         *  duration get filled in once they are finally known. */
        async writeAt(position, data) {
          await stream.write({ type: "write", position, data });
        },
        async close() {
          await stream.close();
        },
        get bytes() {
          return bytes;
        },
        async file() {
          return handle.getFile();
        },
      };
    },

    /** The file, or null when it is simply not there — a missing optional
     *  sidecar is an ordinary state, not an exception to propagate. */
    async read(id, name) {
      if (!this.supported) return null;
      try {
        const dir = await this.dir();
        const sub = await dir.getDirectoryHandle(id);
        const handle = await sub.getFileHandle(name);
        return await handle.getFile();
      } catch (e) {
        return null;
      }
    },

    async list() {
      if (!this.supported) return [];
      const dir = await this.dir();
      const out = [];
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind !== "directory") continue;
        try {
          const meta = await (await (await handle.getFileHandle("meta.json")).getFile()).text();
          out.push({ id: name, meta: JSON.parse(meta) });
        } catch (e) {
          // No meta.json means the recording never finished writing one. The
          // VIDEO is still there, though, and losing hours of capture because
          // a sidecar failed would be indefensible — so it is reconstructed
          // from what exists and flagged as recovered.
          try {
            const f = await (await handle.getFileHandle("screen.webm")).getFile();
            if (!f.size) continue;
            out.push({
              id: name,
              recovered: true,
              meta: {
                id: name,
                startedAt: f.lastModified || Date.now(),
                durationMs: 0,
                width: 0,
                height: 0,
                fps: 30,
                bytes: f.size,
                hasCursorTrack: false,
                hasCamera: false,
                hasAudio: false,
                recovered: true,
              },
            });
          } catch (e2) {
            /* genuinely empty, or half-removed */
          }
        }
      }
      return out.sort((a, b) => (b.meta.startedAt || 0) - (a.meta.startedAt || 0));
    },

    async remove(id) {
      if (!this.supported) return;
      const dir = await this.dir();
      await dir.removeEntry(id, { recursive: true });
    },

    async writeJson(id, name, value) {
      const w = await this.writer(id, name);
      await w.write(new Blob([JSON.stringify(value)]));
      await w.close();
    },

    /** Ask the browser not to evict an in-progress recording. */
    async persist() {
      try {
        if (navigator.storage && navigator.storage.persist) return navigator.storage.persist();
      } catch (e) {
        /* ignore */
      }
      return false;
    },

    async quota() {
      try {
        const e = await navigator.storage.estimate();
        return { usage: e.usage || 0, quota: e.quota || 0 };
      } catch (e) {
        return { usage: 0, quota: 0 };
      }
    },
  };

  /* ── pointer track ───────────────────────────────────────────────────────
   * The recording's second stream. Moves are sampled at most once per animation
   * frame — a raw pointermove firehose on a 120Hz trackpad is thousands of
   * points a minute that no cursor path can use — while clicks, keys and scrolls
   * are kept in full because each one is a beat the edit may want to land on.
   *
   * Timestamps are milliseconds from capture start, taken from the same
   * `performance.now()` origin as the first video frame, so the cursor cannot
   * drift away from the picture over an hour the way a wall-clock would.
   */
  function PointerTrack(originMs) {
    const moves = []; // {t, x, y} in CSS px of the captured surface
    const clicks = []; // {t, x, y, button, kind}
    const keys = []; // {t, key, mods}
    const scrolls = []; // {t, x, y, dx, dy}
    let pending = null;
    let rafId = 0;
    let last = null;

    const at = () => performance.now() - originMs;

    const flushMove = () => {
      rafId = 0;
      if (!pending) return;
      // Drop points that add nothing: a cursor resting still for four seconds
      // is four seconds of identical samples.
      if (!last || Math.abs(pending.x - last.x) > 0.5 || Math.abs(pending.y - last.y) > 0.5) {
        moves.push(pending);
        last = pending;
      }
      pending = null;
    };

    const onMove = (e) => {
      pending = { t: at(), x: e.clientX, y: e.clientY };
      if (!rafId) rafId = requestAnimationFrame(flushMove);
    };

    const onDown = (e) => {
      flushMove();
      const p = { t: at(), x: e.clientX, y: e.clientY, button: e.button, kind: "down" };
      clicks.push(p);
      moves.push({ t: p.t, x: p.x, y: p.y });
      last = p;
    };

    const onUp = (e) => {
      clicks.push({ t: at(), x: e.clientX, y: e.clientY, button: e.button, kind: "up" });
    };

    const onKey = (e) => {
      // The key itself, never the value: a tutorial recorded over a login form
      // must not carry the password in its sidecar file.
      const printable = e.key.length === 1;
      keys.push({
        t: at(),
        key: printable ? (e.ctrlKey || e.metaKey || e.altKey ? e.key : "·") : e.key,
        mods:
          (e.metaKey ? "⌘" : "") + (e.ctrlKey ? "⌃" : "") + (e.altKey ? "⌥" : "") + (e.shiftKey ? "⇧" : ""),
      });
    };

    const onScroll = () => {
      scrolls.push({ t: at(), x: scrollX, y: scrollY, dx: 0, dy: 0 });
    };

    const opts = { capture: true, passive: true };
    const bind = () => {
      addEventListener("pointermove", onMove, opts);
      addEventListener("pointerdown", onDown, opts);
      addEventListener("pointerup", onUp, opts);
      addEventListener("keydown", onKey, opts);
      addEventListener("scroll", onScroll, opts);
    };
    const unbind = () => {
      removeEventListener("pointermove", onMove, opts);
      removeEventListener("pointerdown", onDown, opts);
      removeEventListener("pointerup", onUp, opts);
      removeEventListener("keydown", onKey, opts);
      removeEventListener("scroll", onScroll, opts);
      if (rafId) cancelAnimationFrame(rafId);
      flushMove();
    };

    bind();
    return {
      stop: unbind,
      get data() {
        return {
          moves,
          clicks,
          keys,
          scrolls,
          surface: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio || 1 },
        };
      },
      get counts() {
        return { moves: moves.length, clicks: clicks.filter((c) => c.kind === "down").length };
      },
    };
  }

  /* ── zoom planner ────────────────────────────────────────────────────────
   * Turns the click track into camera moves. The rules are the ones a human
   * editor applies by hand:
   *
   *   • Clicks close together in TIME and SPACE are one piece of work, so they
   *     become one held zoom rather than a zoom per click. Nothing is more
   *     nauseating than a camera that punches in and out on every click.
   *   • A segment holds until the work stops, then releases — it does not
   *     release on a fixed timer.
   *   • Two segments that would leave less than a beat of wide shot between
   *     them are merged instead, so the camera never bounces out and straight
   *     back in.
   *   • The target is the centroid of the cluster, nudged so the framing never
   *     runs off the edge of the picture.
   */
  const ZOOM_DEFAULTS = {
    scale: 2.0,
    clusterGapMs: 2600, // clicks further apart than this start new work
    clusterRadius: 0.22, // ...or further apart than this (fraction of the diagonal)
    leadInMs: 620, // start moving before the click lands
    holdAfterMs: 1500, // stay after the last click of the cluster
    inMs: 900,
    outMs: 700,
    minGapMs: 1200, // less wide-shot than this between segments → merge
  };

  function planZooms(track, durationMs, opts) {
    const o = Object.assign({}, ZOOM_DEFAULTS, opts || {});
    const downs = (track.clicks || []).filter((c) => c.kind === "down");
    if (!downs.length) return [];

    const W = track.surface.w || 1, H = track.surface.h || 1;
    const diag = Math.hypot(W, H);

    const clusters = [];
    let cur = null;
    for (const c of downs) {
      if (
        cur &&
        c.t - cur.last <= o.clusterGapMs &&
        Math.hypot(c.x - cur.cx, c.y - cur.cy) <= o.clusterRadius * diag
      ) {
        cur.pts.push(c);
        cur.last = c.t;
        cur.cx = cur.pts.reduce((s, p) => s + p.x, 0) / cur.pts.length;
        cur.cy = cur.pts.reduce((s, p) => s + p.y, 0) / cur.pts.length;
      } else {
        cur = { pts: [c], first: c.t, last: c.t, cx: c.x, cy: c.y };
        clusters.push(cur);
      }
    }

    // How far the camera must travel to reach each target, as a fraction of
    // the frame. Giving a move across the whole screen the same 900ms as a
    // small nudge is what makes an automatic zoom feel mechanical — real
    // camera moves are timed to their distance.
    let prevX = 0.5, prevY = 0.5;
    const travel = clusters.map((k) => {
      const d = Math.hypot(k.cx / W - prevX, k.cy / H - prevY);
      prevX = k.cx / W;
      prevY = k.cy / H;
      return d;
    });

    let segs = clusters.map((k, i) => ({
      id: uuid(),
      start: Math.max(0, k.first - o.leadInMs),
      end: Math.min(durationMs, k.last + o.holdAfterMs),
      inMs: Math.round(o.inMs * (0.68 + Math.min(1, travel[i] / 0.5) * 0.66)),
      outMs: o.outMs,
      scale: o.scale,
      x: k.cx / W,
      y: k.cy / H,
      auto: true,
      clicks: k.pts.length,
    }));

    // Close in time AND in space is the same shot, so merge. Close in time but
    // far apart in space is NOT: averaging those two centres frames neither of
    // them, which is the classic auto-zoom failure. Those stay separate and
    // become a pan (see buildCameraTrack).
    const merged = [];
    for (const s of segs) {
      const prev = merged[merged.length - 1];
      const sameArea =
        prev && Math.hypot((s.x - prev.x) * W, (s.y - prev.y) * H) <= o.clusterRadius * diag;
      if (prev && sameArea && s.start - prev.end < o.minGapMs) {
        const wa = prev.clicks, wb = s.clicks;
        prev.end = Math.max(prev.end, s.end);
        prev.x = (prev.x * wa + s.x * wb) / (wa + wb);
        prev.y = (prev.y * wa + s.y * wb) / (wa + wb);
        prev.clicks = wa + wb;
      } else {
        merged.push(s);
      }
    }
    return merged;
  }

  /* ── camera track ────────────────────────────────────────────────────────
   * Segments become one continuous keyframe timeline rather than a stack of
   * independent zooms. The difference shows at the seams:
   *
   *   • Two segments far enough apart get a real release to wide between them.
   *   • Two that overlap get NO wide frame at all — the camera glides straight
   *     from one target to the next. A push-out to wide and an immediate
   *     push back in is the single most nauseating thing an auto-zoom does,
   *     and it is exactly what independent per-segment lerps produce.
   */
  function buildCameraTrack(segs) {
    const WIDE = { scale: 1, x: 0.5, y: 0.5 };
    const keys = [Object.assign({ t: -1e9, ease: "glide" }, WIDE)];

    segs.forEach((s, i) => {
      const prev = segs[i - 1];
      const next = segs[i + 1];
      // Is the previous segment still on screen when this one starts?
      const handoffIn = prev && s.start < prev.end + prev.outMs;
      const handoffOut = next && next.start < s.end + s.outMs;

      if (!handoffIn) keys.push(Object.assign({ t: s.start, ease: "settle" }, WIDE));
      keys.push({ t: s.start + s.inMs, scale: s.scale, x: s.x, y: s.y, ease: "glide" });
      keys.push({ t: s.end, scale: s.scale, x: s.x, y: s.y, ease: handoffOut ? "glide" : "out" });
      if (!handoffOut) keys.push(Object.assign({ t: s.end + s.outMs, ease: "glide" }, WIDE));
    });

    keys.push(Object.assign({ t: 1e9, ease: "glide" }, WIDE));
    // A handoff can put a target keyframe before the one it hands off from;
    // sorting keeps the timeline monotonic, and equal stamps collapse so a
    // zero-length span can never divide by zero.
    keys.sort((a, b) => a.t - b.t);
    return keys.filter((k, i) => i === 0 || k.t > keys[i - 1].t + 0.5);
  }

  /**
   * Keep the framed picture covering the canvas.
   *
   * Zooming about a point near an edge slides the frame off the canvas and
   * reveals the background behind it — a bright band down one side, in the
   * middle of a push-in. It is the most common tell of an automatic zoom.
   * This gives the range the focus point must stay inside for the scaled frame
   * to still cover the output.
   */
  function guardFocus(base, scale, W, H) {
    const halfW = W / (2 * scale);
    const halfH = H / (2 * scale);
    return {
      loX: base.x + halfW, hiX: base.x + base.w - halfW,
      loY: base.y + halfH, hiY: base.y + base.h - halfH,
    };
  }

  /**
   * The camera at time t, read off a keyframe track from buildCameraTrack.
   * Pure interpolation between two neighbours — so it is continuous by
   * construction, seekable, and identical whether the frame is being played,
   * scrubbed or exported.
   */
  function cameraAt(keys, t) {
    if (!keys || keys.length < 2) return { scale: 1, x: 0.5, y: 0.5 };
    let lo = 0, hi = keys.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (keys[mid].t <= t) lo = mid;
      else hi = mid;
    }
    const a = keys[lo], b = keys[hi];
    const span = b.t - a.t;
    const u = span <= 0 ? 1 : clamp((t - a.t) / span, 0, 1);
    const k = (ease[b.ease] || ease.glide)(u);
    return { scale: lerp(a.scale, b.scale, k), x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k) };
  }

  /* ── cursor path ─────────────────────────────────────────────────────────
   * The recorded points are where the pointer WAS; what the viewer should see
   * is where it was going. Sampling with a small lag and a Catmull-Rom pass
   * gives a line that curves through the samples instead of chaining straight
   * segments, and the leftover velocity is what the motion blur is drawn from.
   */
  function cursorAt(moves, t, smoothing) {
    if (!moves.length) return null;
    // Binary search the sample at or before t.
    let lo = 0, hi = moves.length - 1;
    if (t <= moves[0].t) return { x: moves[0].x, y: moves[0].y, vx: 0, vy: 0 };
    if (t >= moves[hi].t) return { x: moves[hi].x, y: moves[hi].y, vx: 0, vy: 0 };
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (moves[mid].t <= t) lo = mid;
      else hi = mid;
    }
    const p1 = moves[lo], p2 = moves[hi];
    const p0 = moves[Math.max(0, lo - 1)], p3 = moves[Math.min(moves.length - 1, hi + 1)];
    const span = p2.t - p1.t || 1;
    const u = clamp((t - p1.t) / span, 0, 1);
    // Catmull-Rom, tension from the smoothing control.
    const s = clamp(smoothing == null ? 0.67 : smoothing, 0, 1) * 0.5;
    const u2 = u * u, u3 = u2 * u;
    const h = (a, b, c, d) =>
      a * (-s * u3 + 2 * s * u2 - s * u) +
      b * ((2 - s) * u3 + (s - 3) * u2 + 1) +
      c * ((s - 2) * u3 + (3 - 2 * s) * u2 + s * u) +
      d * (s * u3 - s * u2);
    const x = h(p0.x, p1.x, p2.x, p3.x);
    const y = h(p0.y, p1.y, p2.y, p3.y);
    return { x, y, vx: ((p2.x - p1.x) / span) * 16.7, vy: ((p2.y - p1.y) / span) * 16.7 };
  }

  /** How far into a click the cursor is, for the press bounce. */
  function clickPhase(clicks, t, speedMs) {
    let best = null;
    for (const c of clicks) {
      if (c.kind !== "down") continue;
      const dt = t - c.t;
      if (dt >= 0 && dt < speedMs && (!best || dt < best)) best = dt;
    }
    return best == null ? null : best / speedMs;
  }

  /* ── capture ─────────────────────────────────────────────────────────────
   * Two independent recorders, never one merged stream:
   *
   *   screen.webm  — the display surface, no cursor baked in when we can help it
   *   camera.webm  — the webcam, on its own timeline
   *
   * Keeping the camera separate is what makes it movable, resizable and
   * removable in the edit. Burning it into the screen track at record time is
   * the one decision you can never take back, so it is not made here.
   *
   * Audio is mixed into the screen track (mic + optional system audio through a
   * single AudioContext) because nobody wants to re-sync two audio files.
   */

  /* ── cameras ─────────────────────────────────────────────────────────────
   * A Mac with an iPhone on the desk has at least three cameras, and the OS
   * picks the wrong one often enough that "use my phone" is a real request.
   * Device labels are hidden until camera permission has been granted at least
   * once, so the list is enumerated AFTER a permission probe rather than before
   * — otherwise every entry reads "camera" and the picker is useless.
   */
  function classifyCamera(label) {
    const l = (label || "").toLowerCase();
    if (/iphone|ipad|continuity/.test(l)) return "continuity";
    if (/obs|virtual|camo|snap|manycam|droidcam/.test(l)) return "virtual";
    if (/facetime|built-?in|integrated|internal/.test(l)) return "builtin";
    return "external";
  }

  const CAMERA_KIND_LABEL = {
    continuity: "iPhone",
    builtin: "Built in",
    external: "USB",
    virtual: "Virtual",
  };

  async function listCameras() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
    let devices = await navigator.mediaDevices.enumerateDevices();
    let cams = devices.filter((d) => d.kind === "videoinput");
    // Empty labels mean permission has never been granted. One throwaway
    // getUserMedia reveals them; it is stopped immediately.
    if (cams.length && cams.every((d) => !d.label)) {
      let probe = null;
      try {
        probe = await navigator.mediaDevices.getUserMedia({ video: true });
        devices = await navigator.mediaDevices.enumerateDevices();
        cams = devices.filter((d) => d.kind === "videoinput");
      } catch (e) {
        return cams.map((d, i) => ({
          id: d.deviceId,
          label: "Camera " + (i + 1),
          kind: "external",
          needsPermission: true,
        }));
      } finally {
        if (probe) probe.getTracks().forEach((t) => t.stop());
      }
    }
    return cams.map((d, i) => ({
      id: d.deviceId,
      label: d.label || "Camera " + (i + 1),
      kind: classifyCamera(d.label),
    }));
  }

  /** Fires when a camera appears or disappears — an iPhone waking up nearby. */
  function onCameraChange(fn) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.addEventListener) return () => {};
    navigator.mediaDevices.addEventListener("devicechange", fn);
    return () => navigator.mediaDevices.removeEventListener("devicechange", fn);
  }

  const CODECS = [
    'video/webm;codecs="vp9,opus"',
    'video/webm;codecs="vp8,opus"',
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ];

  function pickMime() {
    for (const m of CODECS) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
    }
    return "";
  }

  /** How often recorded bytes are handed to us — and therefore to disk. */
  const CHUNK_MS = 3000;

  async function startCapture(opts) {
    const o = Object.assign(
      { source: "tab", mic: true, systemAudio: false, camera: false, cameraDeviceId: null, fps: 60 },
      opts || {}
    );

    const wantsOwnCursor = o.source === "tab";

    // `preferCurrentTab` puts this tab at the top of the picker and, on the tab
    // surface, Chrome composites no cursor into the capture — which is exactly
    // what we want, because we are about to draw a better one. On a window or
    // screen surface the OS cursor IS burned in and there is no pointer data to
    // replace it with, so it is left alone.
    const display = await navigator.mediaDevices.getDisplayMedia({
      video: {
        // Asked for explicitly. Without a resolution constraint Chrome is free
        // to hand back a downscaled surface, and nothing downstream can ever
        // recover the detail it did not capture — a 2K export from a 1280-wide
        // recording is a stretched 1280-wide recording. `ideal` never upscales
        // past the real surface, so this asks for native and takes what exists.
        width: { ideal: 3840 },
        height: { ideal: 2160 },
        // 60 wherever the surface can do it. A camera move that jumps 40px
        // between frames at 30fps reads as a slideshow no easing can fix.
        frameRate: { ideal: o.fps, max: 60 },
        cursor: wantsOwnCursor ? "never" : "always",
      },
      audio: o.systemAudio
        ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
        : false,
      preferCurrentTab: o.source === "tab",
      selfBrowserSurface: o.source === "tab" ? "include" : "exclude",
      surfaceSwitching: "include",
      systemAudio: o.systemAudio ? "include" : "exclude",
    });

    const videoTrack = display.getVideoTracks()[0];
    const settings = videoTrack.getSettings();
    // What the user ACTUALLY picked, which may not be what was asked for — the
    // picker is theirs, not ours, and every downstream decision depends on it.
    const surface = settings.displaySurface || (o.source === "tab" ? "browser" : "monitor");
    const isThisTab = surface === "browser" && o.source === "tab";

    let camera = null;
    let cameraSettings = null;
    if (o.camera) {
      // The webcam is not a thumbnail. Cutting to it full screen while someone
      // talks for thirty seconds is the whole reason it is recorded separately,
      // and you cannot do that convincingly with a 1280x720 crop of a portrait
      // sensor letterboxed into a 4K landscape film. So it is asked for at the
      // FILM's shape and the highest resolution the device will give: 1080p
      // landscape for a wide recording, 1080x1920 for a vertical one.
      const portrait = (settings.height || innerHeight) > (settings.width || innerWidth);
      const want = portrait
        ? { width: { ideal: 1080 }, height: { ideal: 1920 }, aspectRatio: { ideal: 9 / 16 } }
        : { width: { ideal: 1920 }, height: { ideal: 1080 }, aspectRatio: { ideal: 16 / 9 } };
      if (o.cameraDeviceId) want.deviceId = { exact: o.cameraDeviceId };
      else want.facingMode = "user";
      try {
        camera = await navigator.mediaDevices.getUserMedia({ video: want, audio: false });
      } catch (e) {
        // Not every camera can do the asked-for shape. Drop the aspect and the
        // resolution before dropping the camera.
        try {
          const relaxed = { ...want };
          delete relaxed.aspectRatio;
          relaxed.width = { ideal: portrait ? 720 : 1280 };
          relaxed.height = { ideal: portrait ? 1280 : 720 };
          camera = await navigator.mediaDevices.getUserMedia({ video: relaxed, audio: false });
        } catch (e1) {
          camera = null;
        }
      }
      if (!camera) try {
        // The chosen camera can vanish between picking it and starting — an
        // iPhone that locked, a USB cam unplugged. Fall back to any camera
        // rather than lose the whole recording over the webcam.
        camera = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      } catch (e2) {
        camera = null;
      }
      if (camera) cameraSettings = camera.getVideoTracks()[0].getSettings();
    }

    let mic = null;
    if (o.mic) {
      try {
        mic = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      } catch (e) {
        mic = null;
      }
    }

    // One audio graph, so mic and system audio arrive as a single track.
    let audioCtx = null;
    let mixedAudio = null;
    const sources = [];
    if (mic) sources.push(mic);
    if (display.getAudioTracks().length) sources.push(new MediaStream(display.getAudioTracks()));
    if (sources.length === 1) {
      mixedAudio = sources[0].getAudioTracks()[0];
    } else if (sources.length > 1) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const dest = audioCtx.createMediaStreamDestination();
      sources.forEach((s) => audioCtx.createMediaStreamSource(s).connect(dest));
      mixedAudio = dest.stream.getAudioTracks()[0];
    }

    const screenStream = new MediaStream([videoTrack, ...(mixedAudio ? [mixedAudio] : [])]);

    return {
      id: uuid(),
      surface,
      isThisTab,
      canDrawCursor: isThisTab,
      hasAudio: !!mixedAudio,
      hasCamera: !!camera,
      cameraWidth: (cameraSettings && cameraSettings.width) || 0,
      cameraHeight: (cameraSettings && cameraSettings.height) || 0,
      width: settings.width || innerWidth,
      height: settings.height || innerHeight,
      fps: settings.frameRate || o.fps,
      screenStream,
      cameraStream: camera,
      stop() {
        [display, camera, mic].forEach((s) => s && s.getTracks().forEach((t) => t.stop()));
        if (audioCtx) audioCtx.close().catch(() => {});
      },
      /** Fires when the user ends the share from Chrome's own bar. */
      onSurfaceEnded(fn) {
        videoTrack.addEventListener("ended", fn, { once: true });
      },
    };
  }

  /**
   * Drives one MediaRecorder straight into an OPFS file. Chunks are written as
   * they arrive and never retained, so memory is flat whether this runs for two
   * minutes or three hours.
   */
  /**
   * Bitrate for a given picture. A flat number is the classic mistake here:
   * 8 Mbps is generous for 720p and visibly lossy on 2K screen content, where
   * the thing being compressed is small text on flat colour — exactly what
   * block artefacts ruin. Scaling with the pixel count keeps quality constant
   * across sizes instead of keeping the FILE constant.
   */
  function bitrateFor(w, h, fps, factor) {
    const bits = w * h * (fps || 30) * (factor || 0.13);
    return Math.round(clamp(bits, 3_000_000, 48_000_000));
  }

  async function recordToDisk(stream, recordingId, filename, mime, bitrate) {
    const writer = await store.writer(recordingId, filename);
    const rec = new MediaRecorder(stream, {
      mimeType: mime || undefined,
      videoBitsPerSecond: bitrate || 8_000_000,
      audioBitsPerSecond: 160_000,
    });

    // Chunks must reach disk IN ORDER. `ondataavailable` can fire again while
    // the previous await is still resolving, so writes are queued rather than
    // raced — an out-of-order WebM is an unplayable WebM.
    let queue = Promise.resolve();
    let dropped = 0;
    rec.ondataavailable = (e) => {
      if (!e.data || !e.data.size) return;
      queue = queue
        .then(() => writer.write(e.data))
        .catch(() => {
          dropped++;
        });
    };

    rec.start(CHUNK_MS);
    return {
      recorder: rec,
      get bytes() {
        return writer.bytes;
      },
      get dropped() {
        return dropped;
      },
      pause: () => rec.state === "recording" && rec.pause(),
      resume: () => rec.state === "paused" && rec.resume(),
      /**
       * Close the file, and refuse to hang doing it.
       *
       * `rec.stop()` throws InvalidStateError when the recorder has ALREADY
       * stopped — which happens routinely, because ending the share from
       * Chrome's own bar stops it for us. Thrown inside a Promise executor
       * that rejection had nowhere to go, so the UI sat on "Finishing the
       * recording…" for ever with the bytes safely on disk and no way to
       * reach them. Every step here is now guarded and time-boxed: a
       * recording is never lost to its own teardown.
       */
      async finish() {
        if (rec.state !== "inactive") {
          await new Promise((resolve) => {
            let done = false;
            const finishOnce = () => {
              if (done) return;
              done = true;
              resolve();
            };
            rec.addEventListener("stop", finishOnce, { once: true });
            rec.addEventListener("error", finishOnce, { once: true });
            // A 'stop' event that never arrives must not be fatal — the data
            // already written is still a valid recording.
            setTimeout(finishOnce, 8000);
            try {
              rec.stop();
            } catch (e) {
              finishOnce();
            }
          });
        }
        try {
          await queue;
        } catch (e) {
          /* a dropped chunk is already counted; the rest of the file stands */
        }
        try {
          await writer.close();
        } catch (e) {
          /* already closed, or the handle went away */
        }
        return writer.fallback ? writer.blob(mime) : writer.file();
      },
    };
  }

  /**
   * A whole recording session: capture + both recorders + the pointer track +
   * the metadata sidecar, with pause/resume that keeps every clock consistent.
   */
  async function startSession(opts, hooks) {
    const h = hooks || {};
    const cap = await startCapture(opts);
    await store.persist();

    // The page is now being captured, but nothing is being WRITTEN yet. Anything
    // the caller wants off the tape — a countdown, the toolbar getting out of
    // shot — happens here, in the gap.
    dispatchEvent(new CustomEvent("pinstage:recording", { detail: { active: true } }));
    if (h.beforeRecord) await h.beforeRecord(cap);

    const mime = pickMime();
    const id = cap.id;
    // t=0 is the first written byte, not the moment the picker was accepted.
    const origin = performance.now();

    // The source is recorded at the quality the capture can actually deliver;
    // every export afterwards is bounded by this number.
    const screenBitrate = bitrateFor(cap.width, cap.height, cap.fps, 0.13);
    const screen = await recordToDisk(cap.screenStream, id, "screen.webm", mime, screenBitrate);
    const cameraRec = cap.cameraStream
      ? await recordToDisk(
          cap.cameraStream, id, "camera.webm", mime,
          bitrateFor(cap.cameraWidth || 1280, cap.cameraHeight || 720, cap.fps, 0.11)
        )
      : null;

    // The pointer track only exists when the capture is this tab; anywhere else
    // there is nothing truthful to record into it.
    const track = cap.canDrawCursor ? PointerTrack(origin) : null;

    let paused = false;
    let pausedAt = 0;
    let pausedTotal = 0;
    const markers = [];
    // Every window in which our own recording HUD was on screen. It tucks
    // itself away after a couple of seconds, but reaching for Stop brings it
    // back — so the last moments of a recording reliably contain our toolbar.
    // Knowing exactly when lets the edit cut it off by default.
    const uiVisible = [];

    const elapsed = () => (paused ? pausedAt : performance.now()) - origin - pausedTotal;

    const session = {
      id,
      capture: cap,
      startedAt: Date.now(),
      get elapsedMs() {
        return elapsed();
      },
      get bytes() {
        return screen.bytes + (cameraRec ? cameraRec.bytes : 0);
      },
      get paused() {
        return paused;
      },
      get counts() {
        return track ? track.counts : { moves: 0, clicks: 0 };
      },
      /** Told by the UI whenever its own chrome becomes visible or hides. */
      noteUiVisible(shown) {
        const t = elapsed();
        if (shown) uiVisible.push({ from: t, to: null });
        else {
          const last = uiVisible[uiVisible.length - 1];
          if (last && last.to == null) last.to = t;
        }
      },
      /** A manual "zoom here" beat, for when the interesting thing was not a click. */
      mark() {
        markers.push({ t: elapsed(), x: innerWidth / 2, y: innerHeight / 2 });
        return markers.length;
      },
      pause() {
        if (paused) return;
        paused = true;
        pausedAt = performance.now();
        screen.pause();
        if (cameraRec) cameraRec.pause();
      },
      resume() {
        if (!paused) return;
        paused = false;
        pausedTotal += performance.now() - pausedAt;
        screen.resume();
        if (cameraRec) cameraRec.resume();
      },
      async stop(onStep) {
        const step = (m) => onStep && onStep(m);
        if (paused) session.resume();
        if (track) track.stop();
        const durationMs = elapsed();
        step("Closing the screen recording · " + formatBytes(screen.bytes));
        const files = { screen: await screen.finish() };
        if (cameraRec) {
          step("Closing the webcam recording");
          files.camera = await cameraRec.finish();
        }
        step("Releasing the capture");
        cap.stop();
        dispatchEvent(new CustomEvent("pinstage:recording", { detail: { active: false } }));

        const data = track ? track.data : { moves: [], clicks: [], keys: [], scrolls: [], surface: { w: cap.width, h: cap.height, dpr: 1 } };
        data.markers = markers;
        const openRun = uiVisible[uiVisible.length - 1];
        if (openRun && openRun.to == null) openRun.to = durationMs;
        data.uiVisible = uiVisible;

        const meta = {
          id,
          startedAt: session.startedAt,
          durationMs,
          mime,
          width: cap.width,
          height: cap.height,
          fps: cap.fps,
          surface: cap.surface,
          hasCursorTrack: !!track,
          hasCamera: !!cameraRec,
          cameraWidth: cap.cameraWidth,
          cameraHeight: cap.cameraHeight,
          hasAudio: cap.hasAudio,
          bytes: session.bytes,
          bitrate: screenBitrate,
          droppedChunks: screen.dropped + (cameraRec ? cameraRec.dropped : 0),
        };
        step("Writing the pointer track");
        await store.writeJson(id, "track.json", data);
        await store.writeJson(id, "meta.json", meta);
        await store.writeJson(id, "manifest.json", buildManifest(meta));
        step("Done");
        return { meta, track: data, files };
      },
    };

    cap.onSurfaceEnded(() => h.onSurfaceEnded && h.onSurfaceEnded(session));
    return session;
  }

  /* ── manifest ────────────────────────────────────────────────────────────
   * Nothing is ever burned into a source. The screen track holds the screen and
   * only the screen — no cursor (it is captured with cursor:"never" and drawn
   * from data), no webcam, no zoom, no caption, no background. The webcam is a
   * second file at full resolution. Every effect happens at render time, from
   * the edit.
   *
   * That is what makes an edit reversible: changing a zoom, moving the face
   * shot, or rewriting a caption re-renders from pristine sources rather than
   * compounding onto an already-processed picture. Render, adjust, render
   * again, forever, with no generation loss.
   *
   * This file states that contract explicitly so an agent reading the folder
   * knows which asset to reach for and which never to treat as final.
   */
  function buildManifest(meta) {
    return {
      manifestVersion: 1,
      recordingId: meta.id,
      durationMs: meta.durationMs,
      fps: meta.fps,
      assets: {
        screen: {
          file: "screen.webm",
          role: "master",
          width: meta.width,
          height: meta.height,
          clean: true,
          contains: ["screen"],
          excludes: ["cursor", "webcam", "zoom", "captions", "background", "frame"],
          use: "The only source of screen pixels. Re-render from this for any change to zoom, framing, background or transitions.",
        },
        camera: meta.hasCamera
          ? {
              file: "camera.webm",
              role: "master",
              width: meta.cameraWidth || null,
              height: meta.cameraHeight || null,
              clean: true,
              contains: ["webcam"],
              excludes: ["screen", "captions"],
              use: "Recorded at the film's shape and full resolution so it holds up filling the frame, not just as a corner inset.",
            }
          : null,
        pointer: {
          file: "track.json",
          role: "data",
          available: !!meta.hasCursorTrack,
          contains: ["pointer positions", "clicks", "keystroke times", "manual zoom marks"],
          use: "Drives the drawn cursor and the automatic zoom plan. Absent for window and screen recordings, where the system cursor is already in the picture.",
        },
        project: {
          file: "project.json",
          role: "edit",
          use: "The edit decision list: trim, style, zoom segments, camera shots, captions, output preset. This is the ONLY file to modify. Patch it and re-render.",
        },
        render: {
          file: "export.webm",
          role: "output",
          derived: true,
          use: "The last render. Baked and disposable — never edit or re-encode it, re-render from the masters instead.",
        },
      },
      audio: {
        inScreenTrack: !!meta.hasAudio,
        note: "Mic and system audio are mixed into screen.webm and passed through on export without re-encoding.",
      },
    };
  }

  /* ── compositor ──────────────────────────────────────────────────────────
   * One function draws one frame, and it is the ONLY place a frame is ever
   * drawn — preview, scrub and export all call it. That is deliberate: the
   * usual bug in this kind of tool is an export that looks subtly unlike the
   * preview, and it comes from having two renderers.
   *
   * It is pure with respect to time: given (t, style, track) it always produces
   * the same pixels, so seeking is exact and export can run at any speed.
   */

  const STYLE_DEFAULTS = {
    background: { kind: "gradient", value: "sunrise" },
    padding: 0.06, // fraction of the shorter output side
    radius: 18,
    shadow: 0.28,
    cursor: {
      show: true,
      size: 2.2,
      smoothing: 0.67,
      motionBlur: 0.4,
      clickBounce: 3.5,
      bounceSpeedMs: 350,
      sway: 0.13,
    },
    camera: { show: true, shape: "circle", size: 0.22, x: 0.98, y: 0.98, mirror: true },
    zoom: {
      enabled: true,
      // Sub-frame samples accumulated while the camera moves. Costs render
      // time only during moves; a held shot pays nothing and stays sharp.
      motionBlur: 0.85,
      // A held frame that is perfectly still reads as a screenshot with audio.
      drift: 0.5,
    },
  };

  const GRADIENTS = {
    sunrise: ["#ffd6a5", "#ff8fab", "#a06cd5"],
    dusk: ["#2b2d6e", "#7b3fa0", "#e46a8b"],
    mint: ["#c3f0ca", "#7ad7c1", "#3aa8a0"],
    slate: ["#2c3038", "#3f4550", "#585f6d"],
    ember: ["#ff9f1c", "#f4572c", "#8b1e3f"],
    ocean: ["#7ee8fa", "#3aa8f0", "#1f4fa0"],
  };

  function paintBackground(ctx, W, H, bg) {
    if (!bg || bg.kind === "none") {
      ctx.clearRect(0, 0, W, H);
      return;
    }
    if (bg.kind === "color") {
      ctx.fillStyle = bg.value;
      ctx.fillRect(0, 0, W, H);
      return;
    }
    if (bg.kind === "image" && bg.image && bg.image.width) {
      // Cover, never stretch.
      const s = Math.max(W / bg.image.width, H / bg.image.height);
      const w = bg.image.width * s, h = bg.image.height * s;
      ctx.drawImage(bg.image, (W - w) / 2, (H - h) / 2, w, h);
      return;
    }
    const stops = GRADIENTS[bg.value] || GRADIENTS.sunrise;
    const g = ctx.createLinearGradient(0, 0, W, H);
    stops.forEach((c, i) => g.addColorStop(i / (stops.length - 1), c));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  function roundRectPath(ctx, x, y, w, h, r) {
    // Never negative: canvas throws IndexSizeError rather than clamping, and
    // every caller that interpolates a radius can overshoot past its target.
    const rr = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  /**
   * Where the framed screen sits inside the output, before the camera move.
   * Contain, never crop — a tutorial that loses its own edges is worthless.
   */
  function framedRect(W, H, srcW, srcH, padding) {
    const pad = Math.min(W, H) * padding;
    const availW = W - pad * 2, availH = H - pad * 2;
    const s = Math.min(availW / srcW, availH / srcH);
    const w = srcW * s, h = srcH * s;
    return { x: (W - w) / 2, y: (H - h) / 2, w, h, scale: s };
  }

  /**
   * Draw a synthetic macOS-style arrow. Vector, not a bitmap, so it stays crisp
   * at any zoom and any cursor size — the thing a captured OS cursor can never
   * do once the frame is scaled 2x.
   */
  function drawCursor(ctx, x, y, size, opacity) {
    const s = size;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(s, s);
    ctx.globalAlpha *= opacity == null ? 1 : opacity;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, 16.5);
    ctx.lineTo(4.1, 12.9);
    ctx.lineTo(6.9, 19.2);
    ctx.lineTo(9.6, 18.0);
    ctx.lineTo(6.8, 11.8);
    ctx.lineTo(11.9, 11.4);
    ctx.closePath();
    ctx.lineJoin = "round";
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = "rgba(0,0,0,0.55)";
    ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.fill();
    ctx.restore();
  }

  /* ── camera shots ────────────────────────────────────────────────────────
   * The webcam spends most of a tutorial as a small circle in a corner. But
   * when someone stops driving the UI and just talks for half a minute, the
   * screen is dead weight and the face is the content — so the camera comes
   * forward and fills the frame.
   *
   * That is a MOVE, not a cut: the corner circle grows into the full frame and
   * shrinks back, on the same eased curves the zoom camera uses. Cutting hard
   * between the two reads as a mistake.
   */
  const CAMERA_SHOT_DEFAULTS = { inMs: 560, outMs: 480, mode: "full" };

  /** Where the webcam sits at time t, in output pixels. */
  function cameraLayoutAt(shots, t, W, H, st) {
    const d = Math.min(W, H) * st.camera.size;
    const boxH = st.camera.shape === "circle" ? d : d * 0.66;
    const margin = Math.min(W, H) * 0.03;
    const pip = {
      x: margin + (W - d - margin * 2) * st.camera.x,
      y: margin + (H - boxH - margin * 2) * st.camera.y,
      w: d,
      h: boxH,
      radius: st.camera.shape === "circle" ? d / 2 : d * 0.09,
      k: 0,
    };
    if (!shots || !shots.length) return pip;

    // The last shot that touches t wins, so hand-placed overlaps behave the
    // way the timeline shows them.
    let k = 0;
    for (const sh of shots) {
      const inMs = sh.inMs == null ? CAMERA_SHOT_DEFAULTS.inMs : sh.inMs;
      const outMs = sh.outMs == null ? CAMERA_SHOT_DEFAULTS.outMs : sh.outMs;
      if (t < sh.start || t > sh.end + outMs) continue;
      if (t < sh.start + inMs) k = ease.settle(clamp((t - sh.start) / inMs, 0, 1));
      else if (t <= sh.end) k = 1;
      else k = 1 - ease.out(clamp((t - sh.end) / outMs, 0, 1));
    }
    if (k <= 0) return pip;
    // `settle` deliberately overshoots past 1 — that overshoot is what makes
    // the face arrive rather than merely resize. The geometry can absorb it;
    // the radius cannot, so it is clamped rather than the curve being softened.
    return {
      x: lerp(pip.x, 0, k),
      y: lerp(pip.y, 0, k),
      w: lerp(pip.w, W, k),
      h: lerp(pip.h, H, k),
      radius: Math.max(0, lerp(pip.radius, 0, k)),
      k: clamp(k, 0, 1),
    };
  }

  /* ── captions ────────────────────────────────────────────────────────────
   * Drawn last and outside every transform, because a caption that zooms with
   * the picture is unreadable at exactly the moment it matters.
   *
   * Inter is asked for first and the platform UI face is the fallback. Canvas
   * cannot load a font on its own, so if the host page has Inter (most design
   * systems do) it is used; otherwise the stack lands on San Francisco or Segoe,
   * which are close enough that the layout does not move. Nothing is fetched
   * from a third party — this stays a zero-dependency file.
   */
  const CAPTION_FONT = '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif';
  const CAPTION_MONO = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';

  const CAPTION_STYLES = {
    clean: { label: "Clean", hint: "Inter, quiet scrim" },
    bold: { label: "Bold", hint: "heavy, outlined" },
    pop: { label: "Pop", hint: "word chips, accent" },
    neon: { label: "Neon", hint: "glow" },
    terminal: { label: "Terminal", hint: "mono on a bar" },
  };

  /** Greedy wrap against a real measured width — no character-count guessing. */
  function wrapText(ctx, text, maxWidth) {
    const words = String(text || "").split(/\s+/).filter(Boolean);
    const lines = [];
    let line = "";
    for (const w of words) {
      const next = line ? line + " " + w : w;
      if (ctx.measureText(next).width > maxWidth && line) {
        lines.push(line);
        line = w;
      } else line = next;
    }
    if (line) lines.push(line);
    return lines;
  }

  function drawCaption(ctx, W, H, cap, t) {
    const IN = 160, OUT = 200;
    let alpha = 1;
    if (t < cap.start + IN) alpha = clamp((t - cap.start) / IN, 0, 1);
    else if (t > cap.end - OUT) alpha = clamp((cap.end - t) / OUT, 0, 1);
    if (alpha <= 0) return;

    const kind = CAPTION_STYLES[cap.style] ? cap.style : "clean";
    const base = Math.min(W, H);
    const y = (cap.y == null ? 0.86 : cap.y) * H;
    const maxW = W * 0.82;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    if (kind === "terminal") {
      const size = base * 0.032;
      ctx.font = `600 ${size}px ${CAPTION_MONO}`;
      const lines = wrapText(ctx, cap.text, maxW);
      const lh = size * 1.5;
      const boxH = lines.length * lh + size * 0.7;
      ctx.fillStyle = "rgba(6,10,8,0.88)";
      roundRectPath(ctx, W * 0.09, y - boxH / 2, W * 0.82, boxH, size * 0.25);
      ctx.fill();
      ctx.fillStyle = "#4ade80";
      lines.forEach((l, i) => ctx.fillText(l, W / 2, y - ((lines.length - 1) * lh) / 2 + i * lh));
      ctx.restore();
      return;
    }

    if (kind === "pop") {
      const size = base * 0.048;
      ctx.font = `800 ${size}px ${CAPTION_FONT}`;
      const lines = wrapText(ctx, cap.text, maxW);
      const lh = size * 1.34;
      lines.forEach((l, i) => {
        const ly = y - ((lines.length - 1) * lh) / 2 + i * lh;
        const w = ctx.measureText(l).width;
        ctx.fillStyle = "#0b0c0f";
        roundRectPath(ctx, W / 2 - w / 2 - size * 0.42, ly - size * 0.66, w + size * 0.84, size * 1.32, size * 0.32);
        ctx.fill();
        ctx.fillStyle = "#fbbf24";
        ctx.fillText(l, W / 2, ly);
      });
      ctx.restore();
      return;
    }

    if (kind === "neon") {
      const size = base * 0.05;
      ctx.font = `800 ${size}px ${CAPTION_FONT}`;
      const lines = wrapText(ctx, cap.text, maxW);
      const lh = size * 1.3;
      lines.forEach((l, i) => {
        const ly = y - ((lines.length - 1) * lh) / 2 + i * lh;
        ctx.shadowColor = "rgba(56,189,248,0.9)";
        ctx.shadowBlur = size * 0.7;
        ctx.fillStyle = "#e0f2fe";
        // Two passes: the glow has to build up to read as light, not as blur.
        ctx.fillText(l, W / 2, ly);
        ctx.fillText(l, W / 2, ly);
        ctx.shadowBlur = 0;
        ctx.fillStyle = "#fff";
        ctx.fillText(l, W / 2, ly);
      });
      ctx.restore();
      return;
    }

    if (kind === "bold") {
      const size = base * 0.058;
      ctx.font = `800 ${size}px ${CAPTION_FONT}`;
      const lines = wrapText(ctx, String(cap.text || "").toUpperCase(), maxW);
      const lh = size * 1.22;
      ctx.lineJoin = "round";
      ctx.miterLimit = 2;
      lines.forEach((l, i) => {
        const ly = y - ((lines.length - 1) * lh) / 2 + i * lh;
        ctx.lineWidth = size * 0.19;
        ctx.strokeStyle = "#000";
        ctx.strokeText(l, W / 2, ly);
        ctx.fillStyle = "#fff";
        ctx.fillText(l, W / 2, ly);
      });
      ctx.restore();
      return;
    }

    // clean — the default, and the one that should look like nothing was done.
    const size = base * 0.038;
    ctx.font = `600 ${size}px ${CAPTION_FONT}`;
    const lines = wrapText(ctx, cap.text, maxW);
    const lh = size * 1.42;
    const boxH = lines.length * lh + size * 0.62;
    let boxW = 0;
    lines.forEach((l) => (boxW = Math.max(boxW, ctx.measureText(l).width)));
    boxW += size * 1.5;
    ctx.fillStyle = "rgba(8,9,12,0.66)";
    roundRectPath(ctx, W / 2 - boxW / 2, y - boxH / 2, boxW, boxH, size * 0.42);
    ctx.fill();
    ctx.fillStyle = "#fff";
    lines.forEach((l, i) => ctx.fillText(l, W / 2, y - ((lines.length - 1) * lh) / 2 + i * lh));
    ctx.restore();
  }

  /**
   * The whole frame. `src` is anything drawImage accepts — a <video> while
   * scrubbing, a VideoFrame while exporting.
   */
  function renderFrame(ctx, opts) {
    const { W, H, src, srcW, srcH, t, style, keys, track, cameraSrc } = opts;
    const st = style;

    paintBackground(ctx, W, H, st.background);

    // Screen recordings are mostly small text, and text is what cheap
    // resampling destroys the moment it is scaled.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";

    const base = framedRect(W, H, srcW, srcH, st.padding);
    const cam = st.zoom.enabled && keys ? cameraAt(keys, t) : { scale: 1, x: 0.5, y: 0.5 };

    // A perfectly still held frame reads as a screenshot with audio, so the
    // camera drifts — slowly and slightly enough never to be noticed and
    // always to be felt. It is a pure function of t, so seeking stays exact.

    // The camera scales about the point of interest, expressed in the SOURCE's
    // normalised space, so a zoom target stays on the same pixel regardless of
    // how the frame happens to be letterboxed.
    const cx = W / 2, cy = H / 2;

    const driftAt = (tt, scale) => {
      const a = (st.zoom.drift == null ? 0.5 : st.zoom.drift) * (scale > 1.02 ? 1 : 0);
      return { dx: Math.sin(tt / 4300) * 0.0016 * a, dy: Math.cos(tt / 5700) * 0.0013 * a };
    };

    const focusFor = (camS, tt) => {
      const gg = guardFocus(base, camS.scale, W, H);
      const d = driftAt(tt, camS.scale);
      return {
        fx: gg.loX > gg.hiX ? base.x + base.w / 2 : clamp(base.x + base.w * (camS.x + d.dx), gg.loX, gg.hiX),
        fy: gg.loY > gg.hiY ? base.y + base.h / 2 : clamp(base.y + base.h * (camS.y + d.dy), gg.loY, gg.hiY),
      };
    };

    const applyCam = (camS, f) => {
      ctx.translate(cx, cy);
      ctx.scale(camS.scale, camS.scale);
      ctx.translate(-f.fx, -f.fy);
    };

    /* Motion blur on the CAMERA, not just the cursor.
     *
     * A push-in rendered as a stack of perfectly sharp stills is the giveaway
     * of a cheap screen recording: real footage smears while it moves, and the
     * eye reads the absence of that smear as "this was faked in software".
     *
     * The camera is sampled several times across one shutter interval and the
     * results averaged. Averaging with source-over needs the alpha of the i-th
     * layer to be 1/(i+1) — that keeps a running mean, where a flat 1/N would
     * let the last sample dominate and simply look like a dimmer single frame.
     *
     * It only engages while the camera is actually moving, so a held shot
     * costs exactly one draw and stays razor sharp.
     */
    const blurAmt = st.zoom.motionBlur == null ? 0.85 : st.zoom.motionBlur;
    let samples = [{ cam, t }];
    if (blurAmt > 0 && keys && st.zoom.enabled) {
      const shutter = 17 * blurAmt;
      const prev = cameraAt(keys, t - shutter);
      // How far the picture actually travelled on screen, in output pixels —
      // the only measure that matters, since a scale change at 3x moves far
      // more of the frame than the same change at 1.1x.
      // A scale change does not move the centre of the frame at all and moves
      // its edges most, so it is weighted by the half-diagonal of the OUTPUT —
      // the furthest any pixel travels. Weighting it by the full frame width
      // over-reports, and over-reporting here costs real render time for blur
      // nobody can see.
      const moved =
        Math.hypot((prev.x - cam.x) * base.w * cam.scale, (prev.y - cam.y) * base.h * cam.scale) +
        (Math.abs(prev.scale - cam.scale) / Math.max(0.001, cam.scale)) * Math.hypot(W, H) * 0.5;
      if (moved > 3) {
        const n = clamp(Math.round(moved / 5), 2, 5);
        samples = [];
        for (let i = n - 1; i >= 0; i--) {
          const tt = t - (i / n) * shutter;
          samples.push({ cam: cameraAt(keys, tt), t: tt });
        }
      }
    }
    const primary = samples[samples.length - 1];
    const primaryFocus = focusFor(primary.cam, primary.t);

    // Shadow under the frame, at the primary position and drawn once — once per
    // sample would stack into a bruise.
    if (st.shadow > 0) {
      ctx.save();
      applyCam(primary.cam, primaryFocus);
      ctx.shadowColor = `rgba(0,0,0,${st.shadow})`;
      ctx.shadowBlur = (Math.min(W, H) * 0.045) / primary.cam.scale;
      ctx.shadowOffsetY = (Math.min(W, H) * 0.018) / primary.cam.scale;
      ctx.fillStyle = "#000";
      roundRectPath(ctx, base.x, base.y, base.w, base.h, st.radius);
      ctx.fill();
      ctx.restore();
    }

    samples.forEach((sm, i) => {
      ctx.save();
      ctx.globalAlpha = 1 / (i + 1);
      applyCam(sm.cam, focusFor(sm.cam, sm.t));
      roundRectPath(ctx, base.x, base.y, base.w, base.h, st.radius);
      ctx.clip();
      if (src) ctx.drawImage(src, base.x, base.y, base.w, base.h);
      ctx.restore();
    });

    // The cursor lives INSIDE the clip and inside the camera transform, so it
    // scales with the picture exactly as a real cursor on a zoomed screen
    // would — but it is drawn once, sharp, at the primary position. It carries
    // its own trail; smearing it twice would just make it mud.
    if (st.cursor.show && track && track.moves && track.moves.length) {
      const c = cursorAt(track.moves, t, st.cursor.smoothing);
      if (c) {
        ctx.save();
        applyCam(primary.cam, primaryFocus);
        roundRectPath(ctx, base.x, base.y, base.w, base.h, st.radius);
        ctx.clip();

        const sw = track.surface.w || srcW, sh = track.surface.h || srcH;
        const px = base.x + (c.x / sw) * base.w;
        const py = base.y + (c.y / sh) * base.h;
        const unit = (base.w / sw) * st.cursor.size * 1.6;

        const phase = clickPhase(track.clicks || [], t, st.cursor.bounceSpeedMs);
        // A click reads as a press, not a flash: the cursor dips and springs
        // back on the exact frame of the pointerdown.
        const bounce =
          phase == null ? 0 : Math.sin(phase * Math.PI) * (st.cursor.clickBounce / 100);
        const scale = unit * (1 - bounce);

        // The trail the eye expects behind something moving fast, sampled
        // backwards along the real path so it curves.
        const speed = Math.hypot(c.vx, c.vy);
        const trail = Math.min(6, Math.round(speed * st.cursor.motionBlur * 0.12));
        for (let i = trail; i > 0; i--) {
          const back = cursorAt(track.moves, t - i * 9, st.cursor.smoothing);
          if (!back) continue;
          drawCursor(
            ctx,
            base.x + (back.x / sw) * base.w,
            base.y + (back.y / sh) * base.h,
            scale,
            (0.16 * (trail - i + 1)) / trail
          );
        }

        if (phase != null) {
          // A ring that expands and fades from the press point.
          const r = unit * 10 * (0.35 + phase * 1.1);
          ctx.save();
          ctx.globalAlpha = 0.35 * (1 - phase);
          ctx.strokeStyle = "#fff";
          ctx.lineWidth = Math.max(1, unit * 1.4);
          ctx.beginPath();
          ctx.arc(px, py, r, 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
        }

        drawCursor(ctx, px, py, scale, 1);
        ctx.restore();
      }
    }

    // The webcam sits OUTSIDE the camera transform: a picture-in-picture that
    // zoomed with the screen would be unwatchable.
    const camReady = cameraSrc && (cameraSrc.videoWidth || cameraSrc.displayWidth);
    if (camReady && st.camera.show) {
      const L = cameraLayoutAt(opts.camShots, t, W, H, st);
      ctx.save();
      // The shadow belongs to a floating inset, not to a full-frame shot.
      if (L.k < 0.98) {
        ctx.shadowColor = `rgba(0,0,0,${0.35 * (1 - L.k)})`;
        ctx.shadowBlur = L.w * 0.12;
        ctx.shadowOffsetY = L.w * 0.04;
      }
      roundRectPath(ctx, L.x, L.y, L.w, L.h, L.radius);
      ctx.fillStyle = "#000";
      ctx.fill();
      ctx.shadowColor = "transparent";
      ctx.clip();
      const vw = cameraSrc.videoWidth || cameraSrc.displayWidth;
      const vh = cameraSrc.videoHeight || cameraSrc.displayHeight;
      const sc = Math.max(L.w / vw, L.h / vh);
      const w = vw * sc, hgt = vh * sc;
      if (st.camera.mirror) {
        ctx.translate(L.x + L.w / 2, 0);
        ctx.scale(-1, 1);
        ctx.translate(-(L.x + L.w / 2), 0);
      }
      ctx.drawImage(cameraSrc, L.x + (L.w - w) / 2, L.y + (L.h - hgt) / 2, w, hgt);
      ctx.restore();
    }

    // Captions go last of all, over the webcam as well as the screen.
    if (st.captionsHidden) return;
    (opts.overlays || []).forEach((ov) => {
      if (ov.type !== "caption" || !ov.text) return;
      if (t < ov.start || t > ov.end) return;
      drawCaption(ctx, W, H, ov, t);
    });
  }

  /* ── WebM, read and written by hand ──────────────────────────────────────
   * Export could have been done the easy way: play the recording into a canvas,
   * capture that canvas as a stream, hand it to MediaRecorder. That approach is
   * about forty lines and it is why most browser recorders cannot export a long
   * video — it runs in real time, so a fifty minute tutorial takes fifty
   * minutes, and any frame the compositor misses is silently gone.
   *
   * So the container is handled directly instead. Demux the recording into its
   * original encoded packets, decode only the video, composite, re-encode, and
   * write a new file. That buys three things:
   *
   *   • Faster than real time, bounded by the encoder rather than the clock.
   *   • Frame exact — every frame is decoded, none are "presented" and dropped.
   *   • The AUDIO IS NEVER TOUCHED. Its Opus packets are copied from the source
   *     file into the destination file byte for byte, so narration comes out
   *     bit-identical to what the microphone recorded and no audio encoder is
   *     needed anywhere in the pipeline.
   *
   * EBML is a tree of {id, size, payload}. Only the handful of elements below
   * matter here; everything else is skipped by size without being parsed.
   */

  const EL = {
    EBML: 0x1a45dfa3,
    Segment: 0x18538067,
    Info: 0x1549a966,
    TimecodeScale: 0x2ad7b1,
    Duration: 0x4489,
    MuxingApp: 0x4d80,
    WritingApp: 0x5741,
    Tracks: 0x1654ae6b,
    TrackEntry: 0xae,
    TrackNumber: 0xd7,
    TrackUID: 0x73c5,
    TrackType: 0x83,
    CodecID: 0x86,
    CodecPrivate: 0x63a2,
    DefaultDuration: 0x23e383,
    Video: 0xe0,
    PixelWidth: 0xb0,
    PixelHeight: 0xba,
    Audio: 0xe1,
    SamplingFrequency: 0xb5,
    Channels: 0x9f,
    Cluster: 0x1f43b675,
    Timecode: 0xe7,
    SimpleBlock: 0xa3,
    BlockGroup: 0xa0,
    Block: 0xa1,
    Cues: 0x1c53bb6b,
    CuePoint: 0xbb,
    CueTime: 0xb3,
    CueTrackPositions: 0xb7,
    CueTrack: 0xf7,
    CueClusterPosition: 0xf1,
  };

  /* ── EBML encoding ─────────────────────────────────────────────────────── */

  const idBytes = (id) => {
    const out = [];
    let n = id;
    while (n > 0) {
      out.unshift(n & 0xff);
      n = Math.floor(n / 256);
    }
    return out;
  };

  /** Size as a variable-length integer; `pad` forces a width so it can be patched later. */
  function sizeBytes(size, pad) {
    let len = pad || 1;
    if (!pad) while (size >= Math.pow(2, 7 * len) - 1 && len < 8) len++;
    const out = new Array(len).fill(0);
    let n = size;
    for (let i = len - 1; i >= 0; i--) {
      out[i] = n & 0xff;
      n = Math.floor(n / 256);
    }
    out[0] |= 1 << (8 - len); // the length marker
    return out;
  }

  const uintBytes = (n) => {
    const out = [];
    let v = Math.max(0, Math.round(n));
    do {
      out.unshift(v & 0xff);
      v = Math.floor(v / 256);
    } while (v > 0);
    return out;
  };

  const floatBytes = (n) => {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, n, false);
    return Array.from(b);
  };

  const strBytes = (s) => Array.from(new TextEncoder().encode(s));

  /** One complete element: id + size + payload. */
  const el = (id, payload) => [...idBytes(id), ...sizeBytes(payload.length), ...payload];
  const elUint = (id, n) => el(id, uintBytes(n));
  const elFloat = (id, n) => el(id, floatBytes(n));
  const elStr = (id, s) => el(id, strBytes(s));

  /**
   * Streaming WebM writer. Clusters are buffered (a cluster is a second or two
   * of video) and flushed as they close, so peak memory is one cluster no
   * matter how long the export runs. Segment size and Duration are unknown
   * until the end and are patched in place at finalize.
   */
  function WebMWriter(opts) {
    const TIMESCALE = 1e6; // one millisecond ticks
    const CLUSTER_MS = 2000;
    const VIDEO_TRACK = 1;
    const AUDIO_TRACK = 2;

    const chunks = []; // pending output, flushed by the caller's sink
    let position = 0;
    let segmentSizeOffset = -1;
    let segmentDataStart = 0;
    let durationOffset = -1;
    let maxTimeMs = 0;

    let cluster = null; // {timeMs, blocks: number[][] }
    const cues = [];

    const emit = (bytes) => {
      const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      chunks.push(u);
      position += u.length;
    };

    function header() {
      emit(
        el(EL.EBML, [
          ...elUint(0x4286, 1), // EBMLVersion
          ...elUint(0x42f7, 1), // EBMLReadVersion
          ...elUint(0x42f2, 4), // EBMLMaxIDLength
          ...elUint(0x42f3, 8), // EBMLMaxSizeLength
          ...elStr(0x4282, "webm"),
          ...elUint(0x4287, 2), // DocTypeVersion
          ...elUint(0x4285, 2), // DocTypeReadVersion
        ])
      );

      // Segment: size unknown now, so an 8-byte placeholder is reserved and
      // overwritten at the end. Writing an unknown-size segment instead would
      // work in some players and break seeking in others.
      emit([...idBytes(EL.Segment)]);
      segmentSizeOffset = position;
      emit(sizeBytes(0, 8));
      segmentDataStart = position;

      const infoPayload = [
        ...elUint(EL.TimecodeScale, TIMESCALE),
        ...elStr(EL.MuxingApp, "Pinstage Studio"),
        ...elStr(EL.WritingApp, "Pinstage Studio " + (window.PinstageStudio ? window.PinstageStudio.version : "")),
      ];
      const durIdSize = [...idBytes(EL.Duration), ...sizeBytes(8)];
      emit([...idBytes(EL.Info), ...sizeBytes(infoPayload.length + durIdSize.length + 8)]);
      emit(infoPayload);
      emit(durIdSize);
      durationOffset = position;
      emit(floatBytes(0));

      const trackEntries = [];
      trackEntries.push(
        ...el(EL.TrackEntry, [
          ...elUint(EL.TrackNumber, VIDEO_TRACK),
          ...elUint(EL.TrackUID, VIDEO_TRACK),
          ...elUint(EL.TrackType, 1),
          ...elStr(EL.CodecID, opts.videoCodecId || "V_VP9"),
          ...(opts.frameRate ? elUint(EL.DefaultDuration, Math.round(1e9 / opts.frameRate)) : []),
          ...el(EL.Video, [
            ...elUint(EL.PixelWidth, opts.width),
            ...elUint(EL.PixelHeight, opts.height),
          ]),
        ])
      );
      if (opts.audio) {
        trackEntries.push(
          ...el(EL.TrackEntry, [
            ...elUint(EL.TrackNumber, AUDIO_TRACK),
            ...elUint(EL.TrackUID, AUDIO_TRACK),
            ...elUint(EL.TrackType, 2),
            ...elStr(EL.CodecID, opts.audio.codecId || "A_OPUS"),
            ...(opts.audio.codecPrivate && opts.audio.codecPrivate.length
              ? el(EL.CodecPrivate, Array.from(opts.audio.codecPrivate))
              : []),
            ...el(EL.Audio, [
              ...elFloat(EL.SamplingFrequency, opts.audio.sampleRate || 48000),
              ...elUint(EL.Channels, opts.audio.channels || 2),
            ]),
          ])
        );
      }
      emit(el(EL.Tracks, trackEntries));
    }

    /** SimpleBlock: track vint, 16-bit signed offset from the cluster, flags. */
    function simpleBlock(track, relMs, keyframe, data) {
      const head = [
        ...sizeBytes(track),
        (relMs >> 8) & 0xff,
        relMs & 0xff,
        keyframe ? 0x80 : 0x00,
      ];
      return [...idBytes(EL.SimpleBlock), ...sizeBytes(head.length + data.length), ...head, ...data];
    }

    function closeCluster() {
      if (!cluster) return;
      const payload = [...elUint(EL.Timecode, cluster.timeMs), ...cluster.blocks];
      cues.push({ timeMs: cluster.timeMs, position: position - segmentDataStart });
      emit(el(EL.Cluster, payload));
      cluster = null;
    }

    function add(track, timeMs, keyframe, data) {
      // A cluster must start on a keyframe and a block's offset from its
      // cluster has to fit in a signed 16 bits, which is what bounds the length.
      const needNew =
        !cluster ||
        (track === VIDEO_TRACK && keyframe && timeMs - cluster.timeMs >= CLUSTER_MS) ||
        timeMs - cluster.timeMs > 32000;
      if (needNew) {
        closeCluster();
        cluster = { timeMs, blocks: [] };
      }
      const rel = clamp(timeMs - cluster.timeMs, -32768, 32767);
      cluster.blocks.push(...simpleBlock(track, rel, keyframe, data));
      if (timeMs > maxTimeMs) maxTimeMs = timeMs;
    }

    header();

    return {
      VIDEO_TRACK,
      AUDIO_TRACK,
      addVideo(timeMs, keyframe, data) {
        add(VIDEO_TRACK, Math.round(timeMs), keyframe, data);
      },
      addAudio(timeMs, data) {
        add(AUDIO_TRACK, Math.round(timeMs), true, data);
      },
      /** Hand over everything buffered so far; the caller streams it to disk. */
      drain() {
        const out = chunks.splice(0, chunks.length);
        return out;
      },
      finish() {
        closeCluster();
        const cuePayload = [];
        cues.forEach((c) => {
          cuePayload.push(
            ...el(EL.CuePoint, [
              ...elUint(EL.CueTime, c.timeMs),
              ...el(EL.CueTrackPositions, [
                ...elUint(EL.CueTrack, VIDEO_TRACK),
                ...elUint(EL.CueClusterPosition, c.position),
              ]),
            ])
          );
        });
        emit(el(EL.Cues, cuePayload));
        return {
          tail: chunks.splice(0, chunks.length),
          patches: [
            { position: segmentSizeOffset, data: new Uint8Array(sizeBytes(position - segmentDataStart, 8)) },
            { position: durationOffset, data: new Uint8Array(floatBytes(maxTimeMs)) },
          ],
        };
      },
    };
  }

  /* ── EBML reading ──────────────────────────────────────────────────────── */

  /**
   * Sequential reader over a File. Only the window being parsed is ever in
   * memory, so a four gigabyte recording is read the same way a four megabyte
   * one is.
   */
  function FileReader_(file, chunkSize) {
    const SIZE = chunkSize || 1 << 20;
    let buf = new Uint8Array(0);
    let bufStart = 0; // file offset of buf[0]
    let pos = 0; // absolute read cursor

    async function ensure(n) {
      const need = pos + n - (bufStart + buf.length);
      if (need <= 0) return true;
      const from = Math.min(pos, bufStart + buf.length);
      const to = Math.min(file.size, Math.max(pos + n, from + SIZE));
      if (from >= file.size) return false;
      const fresh = new Uint8Array(await file.slice(from, to).arrayBuffer());
      if (pos >= bufStart && pos < bufStart + buf.length) {
        const keep = buf.subarray(pos - bufStart);
        const merged = new Uint8Array(keep.length + fresh.length);
        merged.set(keep, 0);
        merged.set(fresh, keep.length);
        buf = merged;
      } else {
        buf = fresh;
      }
      bufStart = pos;
      return pos + n <= bufStart + buf.length;
    }

    return {
      get pos() {
        return pos;
      },
      set pos(v) {
        pos = v;
      },
      get eof() {
        return pos >= file.size;
      },
      size: file.size,
      async byte() {
        if (!(await ensure(1))) return -1;
        return buf[pos++ - bufStart];
      },
      async bytes(n) {
        if (!(await ensure(n))) return null;
        const out = buf.slice(pos - bufStart, pos - bufStart + n);
        pos += n;
        return out;
      },
      async peek(n) {
        if (!(await ensure(n))) return null;
        return buf.subarray(pos - bufStart, pos - bufStart + n);
      },
      skip(n) {
        pos += n;
      },
    };
  }

  /** Element id, read with its marker bits intact so it matches the EL table. */
  async function readId(r) {
    const first = await r.byte();
    if (first < 0) return -1;
    let len = 1;
    for (let i = 0; i < 4; i++) if (first & (0x80 >> i)) { len = i + 1; break; }
    let id = first;
    for (let i = 1; i < len; i++) id = id * 256 + (await r.byte());
    return id;
  }

  /** Element size; null means "unknown", which MediaRecorder emits routinely. */
  async function readSize(r) {
    const first = await r.byte();
    if (first < 0) return { size: null, len: 0 };
    let len = 1;
    for (let i = 0; i < 8; i++) if (first & (0x80 >> i)) { len = i + 1; break; }
    let value = first & (0xff >> len);
    let allOnes = value === (0xff >> len);
    for (let i = 1; i < len; i++) {
      const b = await r.byte();
      if (b !== 0xff) allOnes = false;
      value = value * 256 + b;
    }
    return { size: allOnes ? null : value, len };
  }

  const readUintFrom = (u8) => {
    let n = 0;
    for (let i = 0; i < u8.length; i++) n = n * 256 + u8[i];
    return n;
  };

  const readFloatFrom = (u8) => {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    return u8.length === 4 ? dv.getFloat32(0) : dv.getFloat64(0);
  };

  /** Elements that can only appear at segment level — the boundary that ends an unknown-size cluster. */
  const SEGMENT_LEVEL = new Set([
    EL.Cluster, EL.Info, EL.Tracks, EL.Cues, EL.Segment, EL.EBML,
    0x114d9b74 /* SeekHead */, 0x1254c367 /* Tags */, 0x1941a469 /* Attachments */, 0x1043a770 /* Chapters */,
  ]);

  /**
   * Walk a recorded WebM and hand back its tracks and every packet in order.
   * `onPacket` receives the ORIGINAL encoded bytes — video goes to a decoder,
   * audio goes straight into the output file untouched.
   */
  async function demuxWebM(file, onPacket, hooks) {
    const onProgress = hooks && hooks.onProgress;
    // Tracks are known a few hundred bytes in, but the return value only
    // arrives when the whole file has been walked. A caller that needs the
    // codec and the picture size BEFORE it starts decoding — which is every
    // caller — has to be told as soon as they are parsed.
    const onTracks = hooks && hooks.onTracks;
    const r = FileReader_(file);
    let timecodeScale = 1e6;
    let clusterTimeMs = 0;
    const tracks = {};
    let videoTrack = null, audioTrack = null;

    async function parseTracks(end) {
      while (r.pos < end) {
        const id = await readId(r);
        if (id < 0) return;
        const { size } = await readSize(r);
        if (id === EL.TrackEntry) {
          const stop = r.pos + size;
          const t = {};
          while (r.pos < stop) {
            const cid = await readId(r);
            if (cid < 0) break;
            const cs = await readSize(r);
            const body = await r.bytes(cs.size);
            if (!body) break;
            if (cid === EL.TrackNumber) t.number = readUintFrom(body);
            else if (cid === EL.TrackType) t.type = readUintFrom(body);
            else if (cid === EL.CodecID) t.codecId = new TextDecoder().decode(body);
            else if (cid === EL.CodecPrivate) t.codecPrivate = body;
            else if (cid === EL.Video || cid === EL.Audio) {
              // Nested; re-walk the copied bytes rather than seeking back.
              let p = 0;
              while (p < body.length) {
                let f = body[p], l = 1;
                for (let i = 0; i < 4; i++) if (f & (0x80 >> i)) { l = i + 1; break; }
                let nid = 0;
                for (let i = 0; i < l; i++) nid = nid * 256 + body[p + i];
                p += l;
                let sf = body[p], sl = 1;
                for (let i = 0; i < 8; i++) if (sf & (0x80 >> i)) { sl = i + 1; break; }
                let sv = sf & (0xff >> sl);
                for (let i = 1; i < sl; i++) sv = sv * 256 + body[p + i];
                p += sl;
                const val = body.subarray(p, p + sv);
                if (nid === EL.PixelWidth) t.width = readUintFrom(val);
                else if (nid === EL.PixelHeight) t.height = readUintFrom(val);
                else if (nid === EL.SamplingFrequency) t.sampleRate = readFloatFrom(val);
                else if (nid === EL.Channels) t.channels = readUintFrom(val);
                p += sv;
              }
            }
          }
          r.pos = stop;
          if (t.number != null) {
            tracks[t.number] = t;
            if (t.type === 1 && !videoTrack) videoTrack = t;
            if (t.type === 2 && !audioTrack) audioTrack = t;
          }
        } else {
          r.skip(size == null ? 0 : size);
        }
      }
    }

    async function readBlock(bytes, isSimple) {
      // track vint, then a signed 16-bit offset from the cluster timecode.
      let p = 0;
      const first = bytes[p];
      let len = 1;
      for (let i = 0; i < 8; i++) if (first & (0x80 >> i)) { len = i + 1; break; }
      let track = first & (0xff >> len);
      for (let i = 1; i < len; i++) track = track * 256 + bytes[p + i];
      p += len;
      const rel = ((bytes[p] << 8) | bytes[p + 1]) << 16 >> 16;
      p += 2;
      const flags = bytes[p];
      p += 1;
      const t = tracks[track];
      if (!t) return;
      const timeMs = (clusterTimeMs + rel) * (timecodeScale / 1e6);
      await onPacket({
        track: t,
        kind: t.type === 1 ? "video" : t.type === 2 ? "audio" : "other",
        timeMs,
        keyframe: isSimple ? !!(flags & 0x80) : true,
        data: bytes.subarray(p),
      });
    }

    // Top level.
    while (!r.eof) {
      const id = await readId(r);
      if (id < 0) break;
      const { size } = await readSize(r);

      if (id === EL.Segment) continue; // descend
      if (id === EL.Info) {
        const stop = r.pos + size;
        while (r.pos < stop) {
          const cid = await readId(r);
          if (cid < 0) break;
          const cs = await readSize(r);
          const body = await r.bytes(cs.size);
          if (!body) break;
          if (cid === EL.TimecodeScale) timecodeScale = readUintFrom(body);
        }
        r.pos = stop;
        continue;
      }
      if (id === EL.Tracks) {
        await parseTracks(r.pos + size);
        if (onTracks) onTracks({ tracks, videoTrack, audioTrack, timecodeScale });
        continue;
      }
      if (id === EL.Cluster) {
        const unknown = size == null;
        const stop = unknown ? Infinity : r.pos + size;
        while (r.pos < stop && !r.eof) {
          const save = r.pos;
          const cid = await readId(r);
          if (cid < 0) break;
          // An unknown-size cluster ends where the next segment-level element
          // starts; rewind so the outer loop sees it.
          if (unknown && SEGMENT_LEVEL.has(cid)) {
            r.pos = save;
            break;
          }
          const cs = await readSize(r);
          if (cid === EL.Timecode) {
            const body = await r.bytes(cs.size);
            clusterTimeMs = readUintFrom(body);
          } else if (cid === EL.SimpleBlock) {
            const body = await r.bytes(cs.size);
            if (!body) break;
            await readBlock(body, true);
          } else if (cid === EL.BlockGroup) {
            const gstop = r.pos + cs.size;
            while (r.pos < gstop) {
              const gid = await readId(r);
              if (gid < 0) break;
              const gs = await readSize(r);
              if (gid === EL.Block) {
                const body = await r.bytes(gs.size);
                if (!body) break;
                await readBlock(body, false);
              } else r.skip(gs.size == null ? 0 : gs.size);
            }
            r.pos = gstop;
          } else {
            r.skip(cs.size == null ? 0 : cs.size);
          }
          if (onProgress) onProgress(r.pos / r.size);
        }
        continue;
      }
      if (size == null) break;
      r.skip(size);
    }

    return { tracks, videoTrack, audioTrack, timecodeScale };
  }

  /* ── export ──────────────────────────────────────────────────────────────
   * demux → decode → composite → encode → mux, all streaming.
   *
   * The whole pipeline is bounded: at most a few dozen frames are in flight at
   * once, one cluster of output is buffered, and everything else is on disk. A
   * three hour recording exports with the same memory profile as a three minute
   * one — it just takes longer.
   */

  /** Turn the push-based demuxer into a pull-based stream with real backpressure. */
  function packetStream(file, filter, limit) {
    const MAX = limit || 24;
    const queue = [];
    let waitingReader = null;
    let waitingWriter = null;
    let done = false;
    let failure = null;
    let info = null;

    const push = (p) =>
      new Promise((resolve) => {
        queue.push(p);
        if (waitingReader) {
          const r = waitingReader;
          waitingReader = null;
          r();
        }
        if (queue.length < MAX) resolve();
        else waitingWriter = resolve;
      });

    demuxWebM(
      file,
      async (p) => {
        if (filter && !filter(p)) return;
        // The packet's bytes are a view into the reader's buffer, which is about
        // to be reused — copy before it is handed across the queue.
        await push({ kind: p.kind, timeMs: p.timeMs, keyframe: p.keyframe, data: p.data.slice() });
      },
      // Published the moment the Tracks element is parsed, which is well before
      // the first packet is consumed — so `info` is available to whoever
      // configures the decoder.
      { onTracks: (i) => (info = i) }
    )
      .then((i) => {
        info = i;
      })
      .catch((e) => {
        failure = e;
      })
      .finally(() => {
        done = true;
        if (waitingReader) waitingReader();
      });

    return {
      get info() {
        return info;
      },
      async next() {
        while (!queue.length && !done) {
          await new Promise((r) => (waitingReader = r));
        }
        if (failure) throw failure;
        if (!queue.length) return null;
        const p = queue.shift();
        if (waitingWriter && queue.length < MAX) {
          const w = waitingWriter;
          waitingWriter = null;
          w();
        }
        return p;
      },
    };
  }

  /**
   * Decodes the webcam recording just far enough ahead of the export cursor to
   * answer "what did the camera show at this moment". Frames are closed as soon
   * as they fall behind, so the queue never grows.
   */
  async function CameraFeeder(file) {
    if (!file) return null;
    let current = null;
    const ahead = [];
    let finished = false;

    const decoder = new VideoDecoder({
      output: (frame) => ahead.push(frame),
      error: () => {
        finished = true;
      },
    });

    const stream = packetStream(file, (p) => p.kind === "video", 12);
    let configured = false;

    async function pump() {
      while (ahead.length < 6 && !finished) {
        const p = await stream.next();
        if (!p) {
          finished = true;
          try {
            await decoder.flush();
          } catch (e) {
            /* nothing left to flush */
          }
          break;
        }
        if (!configured) {
          const t = stream.info && stream.info.videoTrack;
          decoder.configure({
            codec: (t && t.codecId) === "V_VP8" ? "vp8" : "vp09.00.10.08",
            codedWidth: (t && t.width) || 1280,
            codedHeight: (t && t.height) || 720,
          });
          configured = true;
        }
        decoder.decode(
          new EncodedVideoChunk({
            type: p.keyframe ? "key" : "delta",
            timestamp: Math.round(p.timeMs * 1000),
            data: p.data,
          })
        );
        if (decoder.decodeQueueSize > 8) await new Promise((r) => setTimeout(r, 0));
      }
    }

    return {
      /** The most recent camera frame at or before timeMs. */
      async at(timeMs) {
        const us = timeMs * 1000;
        await pump();
        while (ahead.length && ahead[0].timestamp <= us) {
          if (current) current.close();
          current = ahead.shift();
        }
        return current;
      },
      close() {
        if (current) current.close();
        ahead.forEach((f) => f.close());
        try {
          decoder.close();
        } catch (e) {
          /* already closed */
        }
      },
    };
  }

  async function pickVideoCodec(width, height, bitrate, fps) {
    const candidates = [
      { codec: "vp09.00.10.08", id: "V_VP9" },
      { codec: "vp8", id: "V_VP8" },
    ];
    for (const c of candidates) {
      try {
        const cfg = {
          codec: c.codec,
          width,
          height,
          bitrate,
          framerate: fps,
          latencyMode: "quality",
        };
        const s = await VideoEncoder.isConfigSupported(cfg);
        if (s && s.supported) return { ...c, config: cfg };
      } catch (e) {
        /* try the next one */
      }
    }
    return null;
  }

  /**
   * Render a recording to a finished file.
   *
   * Returns { file, meta }. `onProgress({phase, ratio, fps, eta})` is called
   * often enough to drive a progress bar and honestly enough to trust it.
   */
  async function exportRecording(opts) {
    const {
      screenFile,
      cameraFile,
      meta,
      track,
      style,
      segments,
      onProgress,
      shouldCancel,
    } = opts;

    if (typeof VideoEncoder === "undefined" || typeof VideoDecoder === "undefined") {
      throw new Error(
        "This browser has no WebCodecs, so Studio cannot render a file. Chrome or Edge 94+ can."
      );
    }

    const st = Object.assign({}, STYLE_DEFAULTS, style || {});
    const fps = opts.fps || Math.min(60, Math.round(meta.fps || 30));
    // The edit as a list of ranges. A plain trim is simply the one-clip case.
    const timeline = buildTimeline(
      opts.clips && opts.clips.length
        ? opts.clips
        : [{ srcStart: 0, srcEnd: meta.durationMs, speed: 1 }],
      meta.durationMs
    );
    if (!timeline.length) throw new Error("The edit has no clips left in it.");
    const srcIn = timeline[0].srcStart;
    const srcOut = timeline[timeline.length - 1].srcEnd;
    const trimmedMs = Math.max(1, timelineDuration(timeline));

    // Output dimensions are NOT settled here. `meta` came from getSettings() at
    // the instant the stream arrived — before a frame existed — and a tab
    // resized mid-recording moves it again. The container's own Tracks element
    // is the truth about the picture's shape, and it is read a few lines into
    // the demux, so the encoder is configured there instead of here. Guessing
    // now is what turns circles into ellipses.
    let outW = 0, outH = 0, picked = null, canvas = null, ctx = null, encoder = null;

    const keys = st.zoom.enabled ? buildCameraTrack(segments || []) : null;
    const camera = cameraFile ? await CameraFeeder(cameraFile).catch(() => null) : null;

    const writerId = meta.id;
    const sink = await store.writer(writerId, "export.webm");

    let muxer = null;
    let audioReady = false;
    const pendingAudio = [];

    /** Size the output from the real source shape, then build the encoder. */
    async function configureOutput(srcW, srcH) {
      const w = srcW || meta.width || 1920;
      const hgt = srcH || meta.height || 1080;
      if (opts.width || opts.height) {
        // Explicit pixels win — this is the path an agent or a test uses.
        outW = (opts.width || Math.round((opts.height * w) / Math.max(1, hgt))) & ~1;
        outH = (opts.height || Math.round((outW * hgt) / Math.max(1, w))) & ~1;
      } else {
        const r = resolveOutput(opts.preset || "1080p", w, hgt);
        outW = r.width;
        outH = r.height;
      }
      const bitrate = opts.bitrate || bitrateFor(outW, outH, fps, opts.quality || 0.13);
      picked = await pickVideoCodec(outW, outH, bitrate, fps);
      if (!picked) throw new Error("No supported video encoder for " + outW + "×" + outH + ".");
      canvas = new OffscreenCanvas(outW, outH);
      ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
      encoder = new VideoEncoder({
        output: (chunk) => {
          const buf = new Uint8Array(chunk.byteLength);
          chunk.copyTo(buf);
          muxer.addVideo(chunk.timestamp / 1000, chunk.type === "key", buf);
        },
        error: (e) => {
          throw e;
        },
      });
      encoder.configure(picked.config);
    }

    const started = performance.now();
    let framesIn = 0;
    let framesOut = 0;
    let lastKeyMs = -1e9;
    let cancelled = false;

    const flushSink = async () => {
      const parts = muxer.drain();
      for (const p of parts) await sink.write(new Blob([p]));
    };

    const stream = packetStream(screenFile, null, 24);
    const decoder = new VideoDecoder({
      output: async (frame) => {
        framesIn++;
        try {
          const t = frame.timestamp / 1000;
          // Where this source moment lands in the finished film, or nowhere if
          // it was cut out. Frames in a deleted stretch still had to be DECODED
          // — a cut rarely lands on a keyframe — but they are not in the film.
          const outT = srcToOut(timeline, t);
          if (outT == null) {
            frame.close();
            return;
          }
          // Speeding a clip up compresses its frames together; two must never
          // arrive on the same millisecond, or the container's block timestamps
          // stop increasing and the file will not seek.
          if (outT <= lastOutMs) {
            frame.close();
            return;
          }
          lastOutMs = outT;
          const camSrc = camera ? await camera.at(t) : null;
          renderFrame(ctx, {
            W: outW,
            H: outH,
            src: frame,
            srcW: frame.displayWidth || meta.width,
            srcH: frame.displayHeight || meta.height,
            t,
            style: st,
            keys,
            track,
            cameraSrc: camSrc,
            camShots: opts.camShots || [],
            overlays: opts.overlays || [],
          });
          // A keyframe every two seconds keeps the file seekable without
          // paying for one on every frame.
          const forceKey = outT - lastKeyMs >= 2000;
          if (forceKey) lastKeyMs = outT;
          // Rendered at SOURCE time — the camera track, the cursor and the
          // captions all live there — but stamped at OUTPUT time, which is
          // where the cuts and speed changes put it.
          const out = new VideoFrame(canvas, {
            timestamp: Math.round(outT * 1000),
            duration: 1e6 / fps,
          });
          encoder.encode(out, { keyFrame: forceKey });
          out.close();
          framesOut++;
        } finally {
          frame.close();
        }
      },
      error: (e) => {
        throw e;
      },
    });

    let configured = false;
    let firstVideoMs = null;
    let lastOutMs = -1;
    const leadIn = []; // packets from the last keyframe before the in point

    /**
     * Opus packets are copied through untouched, which is what keeps narration
     * bit-identical — but that also means they cannot be resampled. A clip
     * running at anything other than 1x therefore contributes no audio rather
     * than audio at the wrong pitch, and the UI says so.
     */
    const emitAudio = (srcMs, data) => {
      const hit = timeline.find((c) => srcMs >= c.srcStart && srcMs <= c.srcEnd);
      if (!hit || hit.speed !== 1) return;
      muxer.addAudio(hit.outStart + (srcMs - hit.srcStart), data);
    };

    while (true) {
      if (shouldCancel && shouldCancel()) {
        cancelled = true;
        break;
      }
      const p = await stream.next();
      if (!p) break;

      if (p.kind === "audio") {
        // Straight through, never re-encoded — but only the part that survives
        // the trim, rebased to the new zero.
        if (muxer && audioReady) emitAudio(p.timeMs - (firstVideoMs || 0), p.data);
        else pendingAudio.push(p);
        continue;
      }
      if (p.kind !== "video") continue;

      if (!configured) {
        const vt = stream.info && stream.info.videoTrack;
        const at = stream.info && stream.info.audioTrack;
        await configureOutput((vt && vt.width) || meta.width, (vt && vt.height) || meta.height);
        decoder.configure({
          codec: (vt && vt.codecId) === "V_VP8" ? "vp8" : "vp09.00.10.08",
          codedWidth: (vt && vt.width) || meta.width,
          codedHeight: (vt && vt.height) || meta.height,
        });
        muxer = WebMWriter({
          width: outW,
          height: outH,
          frameRate: fps,
          videoCodecId: picked.id,
          audio: at
            ? {
                codecId: at.codecId || "A_OPUS",
                codecPrivate: at.codecPrivate,
                sampleRate: at.sampleRate || 48000,
                channels: at.channels || 2,
              }
            : null,
        });
        audioReady = !!at;
        configured = true;
      }

      if (firstVideoMs == null) firstVideoMs = p.timeMs;
      const at = p.timeMs - firstVideoMs;
      // Past the last clip's end there is nothing left worth decoding.
      if (at > srcOut) break;

      const chunk = new EncodedVideoChunk({
        type: p.keyframe ? "key" : "delta",
        timestamp: Math.round(at * 1000),
        data: p.data,
      });

      if (at < srcIn) {
        // Before the in point. A cut almost never lands on a keyframe, so the
        // frames from the last keyframe onwards still have to be decoded for
        // the first kept frame to be whole — but nothing before that keyframe
        // is worth touching, which is what makes trimming an hour in cheap.
        if (p.keyframe) leadIn.length = 0;
        leadIn.push(chunk);
        continue;
      }
      if (leadIn.length) {
        leadIn.forEach((c) => decoder.decode(c));
        leadIn.length = 0;
      }
      decoder.decode(chunk);

      if (pendingAudio.length && audioReady) {
        pendingAudio.splice(0).forEach((a) => emitAudio(a.timeMs - firstVideoMs, a.data));
      }

      // Backpressure: let the decoder and encoder catch up rather than queueing
      // the whole file into them.
      while (decoder.decodeQueueSize > 12 || (encoder && encoder.encodeQueueSize > 12)) {
        await new Promise((r) => setTimeout(r, 4));
      }
      await flushSink();

      if (onProgress && framesIn % 15 === 0) {
        const ratio = clamp((at - srcIn) / Math.max(1, srcOut - srcIn), 0, 0.999);
        const secs = (performance.now() - started) / 1000;
        onProgress({
          phase: "render",
          ratio,
          fps: framesOut / Math.max(0.001, secs),
          speed: (ratio * (trimmedMs / 1000)) / Math.max(0.001, secs),
          eta: ratio > 0.01 ? (secs / ratio) * (1 - ratio) : null,
        });
      }
    }

    await decoder.flush().catch(() => {});
    if (encoder) await encoder.flush().catch(() => {});
    decoder.close();
    if (encoder) encoder.close();
    if (camera) camera.close();

    if (cancelled) {
      await sink.close().catch(() => {});
      return null;
    }

    if (!muxer) throw new Error("The recording contained no video.");

    await flushSink();
    const { tail, patches } = muxer.finish();
    for (const p of tail) await sink.write(new Blob([p]));
    for (const patch of patches) await sink.writeAt(patch.position, patch.data);
    await sink.close();

    if (onProgress) onProgress({ phase: "done", ratio: 1 });

    const file = sink.fallback ? sink.blob("video/webm") : await store.read(writerId, "export.webm");
    return {
      file,
      meta: {
        width: outW,
        height: outH,
        fps,
        frames: framesOut,
        durationMs: trimmedMs,
        bytes: file.size,
        codec: picked.id,
        tookMs: performance.now() - started,
      },
    };
  }

  /* ── projects ────────────────────────────────────────────────────────────
   * A recording and the edit made of it are separate things. The recording is
   * immovable — megabytes of encoded video in OPFS. The edit is a few kilobytes
   * of JSON describing what to do with it: where to trim, where the camera
   * moves, how the frame is dressed.
   *
   * Keeping them apart is what makes everything else possible. The edit can be
   * autosaved on every slider drag without touching the media, reopened weeks
   * later, rendered again at a different size, or — the point of the MCP bridge
   * — written by an agent that has never seen a single frame.
   */

  const PROJECT_VERSION = 4;

  /* ── clips ───────────────────────────────────────────────────────────────
   * A trim is one range. An edit is a LIST of ranges, and everything an editor
   * does beyond trimming — split, delete the boring middle, speed a stretch up
   * — is impossible to express with a single pair of numbers. So the edit holds
   * clips, and a trim is simply the case where there is one of them.
   *
   * Two clocks exist from here on and confusing them is the classic bug in this
   * kind of tool:
   *
   *   SOURCE time  where a frame sits in the recording. Clicks, zoom segments,
   *                captions and the pointer track are all authored here, and
   *                stay correct no matter how the clips are cut.
   *   OUTPUT time  where it lands in the finished film, after cuts and speed.
   *
   * Rendering happens at SOURCE time; stamping happens at OUTPUT time. Clips
   * stay in source order — this is one continuous recording being cut down, not
   * a bin of footage being reordered — which is what lets the exporter decode
   * the file once, straight through.
   */

  function normalizeClips(clips, durationMs) {
    const out = (clips || [])
      .map((c) => ({
        id: c.id || uuid(),
        srcStart: clamp(c.srcStart || 0, 0, durationMs),
        srcEnd: clamp(c.srcEnd == null ? durationMs : c.srcEnd, 0, durationMs),
        speed: clamp(c.speed || 1, 0.25, 4),
        volume: c.volume == null ? 1 : clamp(c.volume, 0, 2),
        transitionMs: clamp(c.transitionMs || 0, 0, 2000),
      }))
      .filter((c) => c.srcEnd - c.srcStart > 60)
      .sort((a, b) => a.srcStart - b.srcStart);
    // Overlaps would make one source frame land in two places at once.
    for (let i = 1; i < out.length; i++) {
      if (out[i].srcStart < out[i - 1].srcEnd) out[i].srcStart = out[i - 1].srcEnd;
    }
    return out.filter((c) => c.srcEnd - c.srcStart > 60);
  }

  /** Lay the clips end to end and record where each lands in the output. */
  function buildTimeline(clips, durationMs) {
    const cs = normalizeClips(clips, durationMs);
    let at = 0;
    return cs.map((c) => {
      const outLen = (c.srcEnd - c.srcStart) / c.speed;
      const seg = { ...c, outStart: at, outEnd: at + outLen, outLen };
      at += outLen;
      return seg;
    });
  }

  const timelineDuration = (tl) => (tl.length ? tl[tl.length - 1].outEnd : 0);

  /** Output time -> the source frame that belongs there. */
  function outToSrc(tl, outT) {
    for (let i = 0; i < tl.length; i++) {
      const c = tl[i];
      if (outT >= c.outStart && outT <= c.outEnd) {
        return { index: i, clip: c, src: c.srcStart + (outT - c.outStart) * c.speed };
      }
    }
    if (!tl.length) return null;
    const last = tl[tl.length - 1];
    return outT < tl[0].outStart
      ? { index: 0, clip: tl[0], src: tl[0].srcStart }
      : { index: tl.length - 1, clip: last, src: last.srcEnd };
  }

  /** Source time -> where it lands, or null when that moment was cut out. */
  function srcToOut(tl, srcT) {
    for (const c of tl) {
      if (srcT >= c.srcStart && srcT <= c.srcEnd) {
        return c.outStart + (srcT - c.srcStart) / c.speed;
      }
    }
    return null;
  }

  /** Cut the clip under the playhead in two. */
  function splitAt(clips, durationMs, outT) {
    const tl = buildTimeline(clips, durationMs);
    const hit = outToSrc(tl, outT);
    if (!hit) return clips;
    const c = hit.clip;
    // Refuse a split that would leave a sliver too short to see.
    if (hit.src - c.srcStart < 120 || c.srcEnd - hit.src < 120) return clips;
    const next = [];
    tl.forEach((seg) => {
      if (seg.id !== c.id) {
        next.push(seg);
        return;
      }
      next.push({ ...seg, id: uuid(), srcEnd: hit.src });
      next.push({ ...seg, id: uuid(), srcStart: hit.src });
    });
    return normalizeClips(next, durationMs);
  }

  /* ── output presets ──────────────────────────────────────────────────────
   * Keyed on HEIGHT, with the width derived from the source's aspect, because
   * a screen recording is rarely 16:9 — a 16:10 laptop trimmed to "1920 wide"
   * is not 1080p, it is 1920x1200. Matching the height is what makes "1080p"
   * mean the same thing here as everywhere else.
   *
   * `source` is the honest maximum. Anything above the source is offered but
   * marked, because upscaling is not resolution — a 2K export of a 1280-wide
   * capture is a stretched 1280-wide capture, at triple the file size.
   */
  const OUTPUT_PRESETS = [
    { key: "720p", height: 720, label: "720p", note: "small files" },
    { key: "1080p", height: 1080, label: "1080p", note: "the default" },
    { key: "1440p", height: 1440, label: "2K", note: "sharp text" },
    { key: "2160p", height: 2160, label: "4K", note: "large files" },
    { key: "source", height: 0, label: "Source", note: "no resampling" },
  ];

  /** The real pixels a preset produces for a given source, and whether it upscales. */
  function resolveOutput(presetKey, srcW, srcH) {
    const p = OUTPUT_PRESETS.find((x) => x.key === presetKey) || OUTPUT_PRESETS[1];
    const aspect = (srcW || 1920) / Math.max(1, srcH || 1080);
    let h = p.height || srcH || 1080;
    let w = Math.round(h * aspect);
    // Encoders want even dimensions and nothing enormous.
    w = clamp(w, 160, 7680) & ~1;
    h = clamp(h, 120, 4320) & ~1;
    return { key: p.key, label: p.label, width: w, height: h, upscales: !!srcH && h > srcH + 2 };
  }

  function newProject(rec) {
    return {
      version: PROJECT_VERSION,
      id: rec.meta.id,
      name: "Recording " + new Date(rec.meta.startedAt).toLocaleString(undefined, {
        month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
      }),
      createdAt: rec.meta.startedAt,
      updatedAt: Date.now(),
      durationMs: rec.meta.durationMs,
      // The whole edit, in one object an agent can read and patch.
      edit: {
        clips: [{ id: uuid(), srcStart: 0, srcEnd: rec.meta.durationMs, speed: 1, volume: 1, transitionMs: 0 }],
        style: JSON.parse(JSON.stringify(STYLE_DEFAULTS)),
        segments: [],
        camShots: [],
        overlays: [],
      },
      // Default to the largest preset the recording can serve honestly.
      output: {
        preset:
          (rec.meta.height || 0) >= 1400 ? "1440p" : (rec.meta.height || 0) >= 1040 ? "1080p" : "source",
        fps: 0,
        quality: 0.13,
      },
      exports: [],
    };
  }

  /** Bring a project forward without losing what the user already set. */
  function migrateProject(p, rec) {
    if (!p || typeof p !== "object") return newProject(rec);
    const fresh = newProject(rec);
    const e = p.edit || {};
    return {
      ...fresh,
      ...p,
      version: PROJECT_VERSION,
      edit: {
        // v3 and earlier stored a single trim; it becomes the first clip.
        clips: Array.isArray(e.clips) && e.clips.length
          ? normalizeClips(e.clips, rec.meta.durationMs)
          : [{
              id: uuid(),
              srcStart: (e.trim && e.trim.start) || 0,
              srcEnd: (e.trim && e.trim.end) || rec.meta.durationMs,
              speed: 1, volume: 1, transitionMs: 0,
            }],
        style: Object.assign({}, fresh.edit.style, e.style || {}),
        segments: Array.isArray(e.segments) ? e.segments : [],
        camShots: Array.isArray(e.camShots) ? e.camShots : [],
        overlays: Array.isArray(e.overlays) ? e.overlays : [],
      },
      // v2 stored a bare pixel width; presets replaced it.
      output: Object.assign({}, fresh.output, (p.output && p.output.preset) ? p.output : {}),
      exports: Array.isArray(p.exports) ? p.exports : [],
    };
  }

  async function saveProject(project) {
    project.updatedAt = Date.now();
    await store.writeJson(project.id, "project.json", project);
    // Anything watching — another tab, the MCP sync — hears about it here.
    dispatchEvent(new CustomEvent("pinstage:project-saved", { detail: { id: project.id } }));
    return project;
  }

  async function loadProject(id) {
    try {
      const f = await store.read(id, "project.json");
      return f ? JSON.parse(await f.text()) : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Every recording still on disk, newest first, with its edit and enough
   * metadata to show a row without opening the media.
   */
  async function listRecordings() {
    const rows = await store.list();
    const out = [];
    for (const r of rows) {
      const project = await loadProject(r.id);
      out.push({ id: r.id, meta: r.meta, project });
    }
    return out;
  }

  /** Reopen a recording from disk as if it had just been made. */
  /**
   * Ask the video itself what it is. Needed for a recording whose sidecar
   * files never got written — the picture is the authority anyway, and this is
   * how one recovers from a teardown that failed.
   */
  function probeVideo(file) {
    return new Promise((resolve) => {
      const v = document.createElement("video");
      v.preload = "metadata";
      v.muted = true;
      const url = URL.createObjectURL(file);
      let settled = false;
      const done = (r) => {
        if (settled) return;
        settled = true;
        URL.revokeObjectURL(url);
        resolve(r);
      };
      v.addEventListener("loadedmetadata", () =>
        done({
          width: v.videoWidth || 0,
          height: v.videoHeight || 0,
          durationMs: isFinite(v.duration) ? v.duration * 1000 : 0,
        })
      );
      v.addEventListener("error", () => done(null));
      setTimeout(() => done(null), 8000);
      v.src = url;
    });
  }

  async function openRecording(id) {
    const screenEarly = await store.read(id, "screen.webm");
    if (!screenEarly) throw new Error("That recording's video file is missing.");
    const metaFile = await store.read(id, "meta.json");
    let meta;
    if (metaFile) {
      meta = JSON.parse(await metaFile.text());
    } else {
      // Recovered: no sidecar, so the file is asked directly.
      const probed = await probeVideo(screenEarly);
      if (!probed || !probed.durationMs) throw new Error("That recording could not be read back.");
      meta = {
        id,
        startedAt: screenEarly.lastModified || Date.now(),
        durationMs: probed.durationMs,
        width: probed.width,
        height: probed.height,
        fps: 30,
        bytes: screenEarly.size,
        hasCursorTrack: false,
        hasCamera: false,
        hasAudio: true,
        recovered: true,
      };
      await store.writeJson(id, "meta.json", meta).catch(() => {});
    }
    // A duration of zero means the sidecar was written before the file closed.
    if (!meta.durationMs || !meta.width) {
      const probed = await probeVideo(screenEarly);
      if (probed && probed.durationMs) {
        meta.durationMs = meta.durationMs || probed.durationMs;
        meta.width = meta.width || probed.width;
        meta.height = meta.height || probed.height;
        await store.writeJson(id, "meta.json", meta).catch(() => {});
      }
    }
    const trackFile = await store.read(id, "track.json");
    const track = trackFile
      ? JSON.parse(await trackFile.text())
      : { moves: [], clicks: [], keys: [], scrolls: [], surface: { w: meta.width, h: meta.height, dpr: 1 } };
    const screen = screenEarly;
    let camera = null;
    try {
      camera = await store.read(id, "camera.webm");
    } catch (e) {
      /* no webcam on this one */
    }
    return { meta, track, files: { screen, camera } };
  }

  /* ── UI ──────────────────────────────────────────────────────────────────
   * One shadow root, so the host application's CSS cannot reach in and this
   * cannot reach out. That matters more here than anywhere else in the toolbar:
   * this panel is open on top of the very application being recorded.
   */

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif;
         -webkit-font-smoothing: antialiased; }
    .layer { position: fixed; inset: 0; z-index: 2147483646; pointer-events: none; }
    .layer > * { pointer-events: auto; }
    button { font: inherit; border: 0; background: none; color: inherit; cursor: pointer; display: inline-flex;
      align-items: center; justify-content: center; gap: 6px; border-radius: 8px; }
    button:disabled { opacity: .45; cursor: default; }
    .scrim { position: fixed; inset: 0; background: rgba(6,7,10,.66); backdrop-filter: blur(4px); }

    /* ── sheets ── */
    .sheet { position: fixed; left: 50%; top: 50%; transform: translate(-50%,-50%); width: 430px; max-width: 92vw;
      max-height: 88vh; overflow-y: auto; background: #0e0f13; color: #e7e8ea; border: 1px solid #24262d;
      border-radius: 16px; padding: 16px; box-shadow: 0 24px 70px rgba(0,0,0,.6); }
    .sheet h2 { margin: 0 0 2px; font-size: 14.5px; font-weight: 700; letter-spacing: -0.01em; }
    .sheet p.sub { margin: 0 0 13px; font-size: 12px; color: #92959e; line-height: 1.45; }
    .seg { display: grid; grid-template-columns: repeat(3,1fr); gap: 4px; background: #15171c; padding: 3px;
      border-radius: 10px; margin-bottom: 11px; }
    .seg button { flex-direction: column; gap: 2px; padding: 8px 4px; border-radius: 8px; font-size: 12px;
      font-weight: 600; color: #b0b3bb; }
    .seg button.on { background: #f59e0b; color: #16130a; }
    .seg button small { font-size: 9.5px; font-weight: 600; opacity: .82; }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 2px;
      font-size: 12.5px; border-top: 1px solid #1a1c22; }
    .row:first-of-type { border-top: 0; }
    .row .lbl small { display: block; font-size: 10.5px; color: #7e818a; margin-top: 1px; font-weight: 500; }
    .sw { width: 36px; height: 21px; border-radius: 999px; background: #2a2c33; position: relative; flex: none;
      transition: background .15s; cursor: pointer; }
    .sw i { position: absolute; top: 3px; left: 3px; width: 15px; height: 15px; border-radius: 999px; background: #fff;
      transition: transform .15s; }
    .sw.on { background: #f59e0b; }
    .sw.on i { transform: translateX(15px); }
    .pick { flex: none; background: #15171c; border: 1px solid #2e313a; color: #d5d7dd; font-size: 11.5px;
      font-weight: 600; border-radius: 7px; padding: 6px 8px; max-width: 200px; cursor: pointer; position: relative;
      z-index: 1; }
    .pick:hover { border-color: #3d414c; background: #191c22; }
    .pick:focus { outline: none; border-color: #f59e0b; }
    .cta { width: 100%; padding: 10px; background: #f59e0b; color: #16130a; font-weight: 800; font-size: 13px;
      border-radius: 10px; margin-top: 12px; }
    .cta.ghost { background: #191b21; color: #cdd0d6; font-weight: 600; margin-top: 7px; }
    .note { margin-top: 9px; font-size: 11.5px; line-height: 1.5; color: #92959e; background: #131519;
      border: 1px solid #202229; border-radius: 9px; padding: 8px 10px; }
    .note b { color: #d5d7dd; font-weight: 700; }
    .note.err { border-color: #4a2020; color: #f0a0a0; }

    /* ── library ── */
    .lib { margin-top: 12px; border-top: 1px solid #1a1c22; padding-top: 10px; }
    .lib h3 { margin: 0 0 7px; font-size: 10px; letter-spacing: .09em; text-transform: uppercase; color: #7a7d86; }
    .libitem { display: flex; align-items: center; gap: 9px; width: 100%; padding: 7px 8px; border-radius: 9px;
      text-align: left; font-size: 12px; color: #d5d7dd; }
    .libitem:hover { background: #17191f; }
    .libitem .thumb { width: 46px; height: 30px; border-radius: 5px; background: #000 center/cover; flex: none;
      border: 1px solid #24262d; }
    .libitem .grow { flex: 1; min-width: 0; }
    .libitem .nm { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .libitem .mt { font-size: 10.5px; color: #7a7d86; margin-top: 1px; }
    .libitem .del { flex: none; width: 24px; height: 24px; color: #6d707a; border-radius: 6px; }
    .libitem .del:hover { background: #2a1414; color: #f87171; }

    .count { position: fixed; inset: 0; display: grid; place-items: center; background: rgba(6,7,10,.55); }
    .count span { font-size: 120px; font-weight: 800; color: #fff; text-shadow: 0 8px 40px rgba(0,0,0,.6); }

    /* ── recording HUD ── */
    .hud { position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%); display: flex; align-items: center;
      gap: 3px; background: #0e0f13; border: 1px solid #2a2c33; border-radius: 999px; padding: 4px;
      box-shadow: 0 8px 30px rgba(0,0,0,.45); color: #e7e8ea;
      transition: transform .34s cubic-bezier(.4,0,.2,1), opacity .26s ease; }
    .hud.tuck { transform: translateX(-50%) translateY(calc(100% + 24px)); opacity: 0; }
    .hud .rec { display: inline-flex; align-items: center; gap: 6px; padding: 0 10px; height: 29px;
      font-size: 12px; font-weight: 700; font-variant-numeric: tabular-nums; }
    .hud .dot { width: 8px; height: 8px; border-radius: 999px; background: #ef4444; animation: ps-blink 1.3s infinite; }
    .hud.paused .dot { animation: none; background: #92959e; }
    @keyframes ps-blink { 50% { opacity: .25; } }
    .hud button { height: 29px; padding: 0 10px; font-size: 12px; font-weight: 600; color: #b0b3bb; border-radius: 999px; }
    .hud button:hover { background: #1c1e24; color: #fff; }
    .hud button.stop { background: #ef4444; color: #fff; font-weight: 700; }
    .hud .meta { font-size: 10px; color: #7a7d86; padding: 0 6px; font-variant-numeric: tabular-nums; }
    .hud .tip { font-size: 10px; color: #63666e; padding: 0 7px 0 1px; }

    /* ── the editor ──────────────────────────────────────────────────────
       Media left, playback centre, inspector right, multi-track timeline
       underneath, tools along the bottom. Laid out the way editors are laid
       out because that is what people already know. */
    .studio { position: fixed; inset: 0; background: #0a0b0e; color: #e7e8ea; display: grid;
      grid-template-columns: 166px minmax(0,1fr) 248px;
      grid-template-rows: 44px minmax(0,1fr) 236px 32px 3px; }

    .top { grid-column: 1/-1; display: flex; align-items: center; gap: 9px; padding: 0 11px;
      border-bottom: 1px solid #17191f; font-size: 12.5px; }
    .top .mark { font-weight: 700; letter-spacing: -0.01em; color: #cdd0d6; }
    .top .nm { background: none; border: 0; color: #e7e8ea; font-size: 12.5px; font-weight: 600;
      padding: 4px 7px; border-radius: 6px; min-width: 80px; max-width: 240px; }
    .top .nm:hover, .top .nm:focus { background: #17191f; outline: none; }
    .top .stat { font-size: 11px; color: #71747c; font-variant-numeric: tabular-nums; }
    .top .grow, .grow { flex: 1; }
    .top button.act { height: 28px; padding: 0 13px; font-size: 12px; font-weight: 700; border-radius: 8px;
      background: #f59e0b; color: #16130a; }
    .top button.act.ghost { background: #17191f; color: #b8bbc2; font-weight: 600; }
    .top button.act.ghost:hover { background: #1e2128; color: #fff; }

    .media { grid-row: 2; border-right: 1px solid #17191f; overflow-y: auto; padding: 9px; }
    .media .mhead { font-size: 10px; letter-spacing: .09em; text-transform: uppercase; color: #6d707a;
      margin-bottom: 8px; }
    .mitem { display: block; width: 100%; text-align: left; padding: 6px; border-radius: 9px; margin-bottom: 5px; }
    .mitem:hover { background: #15171c; }
    .mitem.on { background: #1a1d24; outline: 1px solid #2c3038; }
    .mthumb { width: 100%; aspect-ratio: 16/10; border-radius: 6px; background: #000 center/cover;
      border: 1px solid #22242b; margin-bottom: 5px; }
    .mname { font-size: 11px; font-weight: 600; color: #d5d7dd; white-space: nowrap; overflow: hidden;
      text-overflow: ellipsis; }
    .mmeta { font-size: 10px; color: #6d707a; margin-top: 1px; }

    .playback { grid-row: 2; display: flex; flex-direction: column; min-width: 0; }
    .phead { padding: 8px 12px 0; font-size: 10px; letter-spacing: .09em; text-transform: uppercase; color: #6d707a; }
    .stagewrap { flex: 1; display: grid; place-items: center; overflow: hidden; padding: 10px 12px;
      background: radial-gradient(ellipse at 50% 0%, #101219 0%, #08090b 70%); margin: 8px 12px;
      border-radius: 10px; border: 1px solid #16181e; }
    .stagewrap canvas { max-width: 100%; max-height: 100%; border-radius: 4px;
      box-shadow: 0 18px 50px rgba(0,0,0,.55); }
    .pbar { display: flex; align-items: center; gap: 9px; padding: 0 14px 10px; }
    .pbar .time, .time { font-size: 11px; color: #7e818a; font-variant-numeric: tabular-nums; }
    button.ic { width: 30px; height: 30px; border-radius: 8px; background: #17191f; color: #d5d7dd; font-size: 12px; }
    button.ic:hover { background: #21242b; color: #fff; }

    .side { grid-row: 2; border-left: 1px solid #17191f; display: flex; flex-direction: column; min-height: 0; }
    .tabs { display: flex; padding: 6px; gap: 2px; border-bottom: 1px solid #17191f; }
    .tabs button { flex: 1; height: 25px; font-size: 10.5px; font-weight: 600; color: #82858d; border-radius: 6px; }
    .tabs button.on { background: #1c1f26; color: #fff; }
    .pane { flex: 1; overflow-y: auto; padding: 9px 11px 16px; }
    .pane h4 { margin: 12px 0 6px; font-size: 9.5px; letter-spacing: .09em; text-transform: uppercase; color: #6a6d76; }
    .pane h4:first-child { margin-top: 2px; }
    .ctl { display: flex; align-items: center; gap: 8px; font-size: 11.5px; padding: 3px 0; color: #b8bbc2; }
    .ctl > span:first-child { width: 62px; flex: none; }
    .ctl input[type=range] { flex: 1; accent-color: #f59e0b; height: 2px; min-width: 0; }
    .ctl .v { font-size: 10px; color: #7a7d86; width: 40px; text-align: right; font-variant-numeric: tabular-nums; flex: none; }
    .ctl.tog { justify-content: space-between; }
    .btnrow { display: flex; gap: 5px; margin-bottom: 4px; }
    .btnrow.wrap { flex-wrap: wrap; }
    .swatches { display: grid; grid-template-columns: repeat(4,1fr); gap: 5px; }
    .swatches button { height: 26px; border-radius: 6px; border: 2px solid transparent; }
    .swatches button.on { border-color: #f59e0b; }
    .hint { font-size: 10.5px; color: #6a6d76; line-height: 1.5; margin-top: 8px; }
    .ta { width: 100%; background: #15171c; border: 1px solid #24262d; color: #e7e8ea; border-radius: 7px;
      padding: 6px 7px; font-size: 11.5px; resize: vertical; font-family: inherit; }

    button.tool { height: 25px; padding: 0 9px; font-size: 11px; font-weight: 600; background: #17191f;
      color: #b8bbc2; border-radius: 7px; }
    button.tool:hover { background: #21242b; color: #fff; }
    button.tool.on { background: #f59e0b; color: #16130a; }
    button.tool.danger:hover { background: #3a1a1a; color: #f87171; }

    .timeline { grid-column: 1/-1; border-top: 1px solid #17191f; display: flex; flex-direction: column; min-height: 0; }
    .ttools { display: flex; align-items: center; gap: 6px; padding: 7px 11px; border-bottom: 1px solid #14161b; }
    .ttools .tname { font-size: 11px; font-weight: 700; color: #9a9da5; margin-right: 4px; }
    .flash { font-size: 10.5px; color: #fbbf24; opacity: 0; transition: opacity .2s; }
    .flash.on { opacity: 1; }
    .tbody { flex: 1; display: flex; min-height: 0; overflow: hidden; }
    .heads { width: 116px; flex: none; border-right: 1px solid #14161b; padding-top: 20px; }
    .head { height: 38px; display: flex; align-items: center; gap: 6px; padding: 0 8px; font-size: 10.5px;
      color: #82858d; border-bottom: 1px solid #101217; }
    .head .hicon { width: 16px; text-align: center; color: #b8bbc2; font-size: 11px; }
    .head .hlabel { flex: 1; }
    .head .mini { width: 17px; height: 17px; font-size: 9px; color: #5f626a; border-radius: 4px; }
    .head .mini:hover { background: #1c1f26; color: #fff; }
    .head .mini.off { color: #3a3d44; }
    .lanewrap { flex: 1; position: relative; min-width: 0; overflow: hidden; }
    .ruler { position: relative; height: 20px; border-bottom: 1px solid #14161b; }
    .ruler .tick { position: absolute; top: 4px; font-size: 9px; color: #55585f; transform: translateX(2px);
      font-variant-numeric: tabular-nums; border-left: 1px solid #22252c; padding-left: 3px; }
    .lanes { position: relative; }
    .lane { position: relative; height: 38px; border-bottom: 1px solid #101217; }
    .playhead { position: absolute; top: -20px; bottom: 0; width: 1.5px; background: #fbbf24; pointer-events: none;
      z-index: 5; box-shadow: 0 0 8px rgba(251,191,36,.7); }
    .playhead::before { content: ""; position: absolute; top: 0; left: -4px; border: 5px solid transparent;
      border-top-color: #fbbf24; }

    .clip { position: absolute; top: 3px; height: 32px; border-radius: 5px; overflow: hidden; cursor: pointer;
      background: linear-gradient(180deg,#2b3240,#1d222c); border: 1px solid #39404e; }
    .clip.sel { border-color: #fbbf24; box-shadow: 0 0 0 1px rgba(251,191,36,.45); }
    .clip .clabel { position: absolute; left: 5px; top: 4px; font-size: 9px; font-weight: 700; color: #cfd3db;
      text-shadow: 0 1px 3px rgba(0,0,0,.8); z-index: 2; }
    .strip { position: absolute; inset: 3px 0 3px 0; display: flex; pointer-events: none; opacity: .85;
      border-radius: 5px; overflow: hidden; }
    .strip i { border-right: 1px solid rgba(0,0,0,.35); }
    .strip i { flex: 1; background: center/cover; }
    .chip { position: absolute; top: 6px; height: 26px; border-radius: 5px; display: flex; align-items: center;
      padding: 0 5px; font-size: 9px; font-weight: 700; overflow: hidden; cursor: pointer; z-index: 3; gap: 3px; }
    .chip .x { margin-left: auto; opacity: .75; font-size: 11px; }
    .chip.zoom { background: linear-gradient(180deg,#a855f7,#7c3aed); color: #fff; top: 8px; height: 22px; }
    .chip.cam { background: linear-gradient(180deg,#22d3ee,#0891b2); color: #04252c; }
    .chip.text { background: linear-gradient(180deg,#f8fafc,#cbd5e1); color: #0f172a; }
    .wave { position: absolute; inset: 8px 0; background:
      repeating-linear-gradient(90deg, #14532d 0 2px, transparent 2px 4px); opacity: .55; border-radius: 4px; }
    .clickmark { position: absolute; bottom: 3px; width: 2px; height: 9px; background: #38bdf8; border-radius: 2px; }

    .footer { grid-column: 1/-1; display: flex; align-items: center; gap: 6px; padding: 0 11px;
      border-top: 1px solid #17191f; }
    .footer .foothint { font-size: 10px; color: #55585f; }
    .progress { grid-column: 1/-1; background: #17191f; }
    .progress i { display: block; height: 100%; background: #f59e0b; width: 0; transition: width .2s; }
    .empty { color: #6d707a; font-size: 11.5px; text-align: center; padding: 16px; }
  `;

  const h = (tag, attrs, kids) => {
    const n = document.createElement(tag);
    if (attrs)
      for (const k in attrs) {
        if (k === "class") n.className = attrs[k];
        else if (k === "html") n.innerHTML = attrs[k];
        else if (k.startsWith("on")) n.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] != null) n.setAttribute(k, attrs[k]);
      }
    (kids || []).forEach((c) => c != null && n.appendChild(typeof c === "string" ? document.createTextNode(c) : c));
    return n;
  };

  function mount() {
    const host = document.createElement("div");
    host.setAttribute("data-pinstage-studio", "");
    const root = host.attachShadow({ mode: "open" });
    root.appendChild(h("style", { html: CSS }));
    const layer = h("div", { class: "layer" });
    root.appendChild(layer);
    document.body.appendChild(host);
    return { host, layer, destroy: () => host.remove() };
  }

  const toggleRow = (label, hint, initial, onChange) => {
    const sw = h("div", { class: "sw" + (initial ? " on" : "") }, [h("i")]);
    let on = initial;
    const row = h("div", { class: "row" }, [
      h("div", { class: "lbl", html: label + (hint ? "<small>" + hint + "</small>" : "") }),
      sw,
    ]);
    row.addEventListener("click", (e) => {
      // A row can carry its own control — the camera picker lives in one. A
      // click on that control is not a click on the switch, and letting it
      // bubble here meant opening the dropdown turned the webcam off.
      if (e.target.closest("select,input,button,textarea,a,option")) return;
      on = !on;
      sw.classList.toggle("on", on);
      onChange(on);
    });
    return row;
  };

  const toggleCtl = (label, initial, onChange) => {
    const sw = h("div", { class: "sw" + (initial ? " on" : "") }, [h("i")]);
    let on = initial;
    const row = h("div", { class: "ctl tog" }, [h("span", {}, [label]), sw]);
    row.addEventListener("click", (e) => {
      if (e.target.closest("select,input,button,textarea,a,option")) return;
      on = !on;
      sw.classList.toggle("on", on);
      onChange(on);
    });
    return row;
  };

  const slider = (label, min, max, step, value, fmt, onInput) => {
    const out = h("span", { class: "v" }, [fmt(value)]);
    const inp = h("input", { type: "range", min, max, step, value });
    inp.addEventListener("input", () => {
      const v = parseFloat(inp.value);
      out.textContent = fmt(v);
      onInput(v);
    });
    return h("div", { class: "ctl" }, [h("span", {}, [label]), inp, out]);
  };

  /* ── the flow ──────────────────────────────────────────────────────────── */

  function open(opts) {
    const o = opts || {};
    const ui = mount();
    let session = null;
    let closed = false;

    const teardown = () => {
      if (closed) return;
      closed = true;
      ui.destroy();
    };

    const sheet = (kids) => {
      ui.layer.innerHTML = "";
      ui.layer.appendChild(h("div", { class: "scrim", onclick: teardown }));
      const el = h("div", { class: "sheet" }, kids);
      ui.layer.appendChild(el);
      return el;
    };

    /* ── 1. what to record, and what has been recorded before ── */
    // Nobody wants to re-pick their microphone, their camera and their capture
    // source every single time. The choices are remembered per origin.
    const PREFS_KEY = "pinstage:studio:prefs";
    const loadPrefs = () => {
      try {
        return JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") || {};
      } catch (e) {
        return {};
      }
    };
    const savePrefs = (cfg) => {
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(cfg));
      } catch (e) {
        /* private mode — the defaults simply come back next time */
      }
    };

    async function preflight() {
      const cfg = Object.assign(
        { source: "tab", mic: true, camera: false, cameraDeviceId: null, systemAudio: false },
        loadPrefs()
      );

      const sources = [
        ["tab", "This tab", "full effects"],
        ["window", "A window", "plain capture"],
        ["screen", "Whole screen", "plain capture"],
      ];
      const seg = h("div", { class: "seg" });
      const note = h("div", { class: "note" });
      const paint = () => {
        savePrefs(cfg);
        [...seg.children].forEach((b, i) => b.classList.toggle("on", sources[i][0] === cfg.source));
        note.innerHTML =
          cfg.source === "tab"
            ? "Recording this tab captures the pointer as data, so Studio can draw a <b>smooth cursor with motion blur</b> and <b>zoom in on every click</b> automatically."
            : "A browser can only read the pointer inside its own page, so a window or screen recording gets the <b>operating system cursor baked in and no automatic zoom</b>. You can still place zooms by hand on the timeline.";
      };
      sources.forEach(([key, label, hint]) =>
        seg.appendChild(
          h("button", { onclick: () => { cfg.source = key; paint(); } }, [
            h("span", {}, [label]),
            h("small", {}, [hint]),
          ])
        )
      );
      paint();

      // Camera picker — populated lazily, because enumerating devices asks for
      // permission and nobody should be prompted for a camera they did not ask
      // to use.
      const camSelect = h("select", { class: "pick" }, [h("option", { value: "" }, ["Default camera"])]);
      camSelect.style.display = "none";
      camSelect.addEventListener("change", () => {
        cfg.cameraDeviceId = camSelect.value || null;
        savePrefs(cfg);
      });

      let stopWatchingCameras = null;
      const fillCameras = async () => {
        const cams = await listCameras().catch(() => []);
        const keep = camSelect.value;
        camSelect.innerHTML = "";
        if (!cams.length) {
          camSelect.appendChild(h("option", { value: "" }, ["No camera found"]));
          return;
        }
        cams.forEach((c) => {
          const tag = CAMERA_KIND_LABEL[c.kind];
          camSelect.appendChild(h("option", { value: c.id }, [`${c.label}${tag ? " · " + tag : ""}`]));
        });
        // An iPhone that just woke up is almost always the one they meant.
        // A remembered choice wins; otherwise an iPhone is almost always the
        // one they meant.
        const remembered = cams.find((c) => c.id === (keep || cfg.cameraDeviceId));
        const iphone = cams.find((c) => c.kind === "continuity");
        camSelect.value = (remembered || iphone || cams[0]).id;
        cfg.cameraDeviceId = camSelect.value;
        savePrefs(cfg);
      };

      const camRow = toggleRow("Webcam", "iPhone or webcam · recorded separately", cfg.camera, async (v) => {
        cfg.camera = v;
        savePrefs(cfg);
        camSelect.style.display = v ? "" : "none";
        if (v) {
          await fillCameras();
          // A phone appearing or disappearing mid-setup should show up here.
          if (!stopWatchingCameras) stopWatchingCameras = onCameraChange(fillCameras);
        }
      });
      camRow.insertBefore(camSelect, camRow.lastChild);

      const go = h("button", { class: "cta" }, ["Choose what to share →"]);
      const body = [
        h("h2", {}, ["Record"]),
        h("p", { class: "sub" }, ["Screen, voice and webcam. Clicks become zooms."]),
        seg,
        toggleRow("Microphone", "your narration", cfg.mic, (v) => { cfg.mic = v; savePrefs(cfg); }),
        camRow,
        toggleRow("System audio", "sound from the page itself", cfg.systemAudio, (v) => { cfg.systemAudio = v; savePrefs(cfg); }),
        note,
      ];
      if (!store.supported)
        body.push(h("div", { class: "note", html: "<b>Heads up:</b> this browser has no origin private file system, so the recording is held in memory and cannot be reopened later. Keep it short." }));
      body.push(go);
      body.push(h("button", { class: "cta ghost", onclick: teardown }, ["Cancel"]));

      const el = sheet(body);
      if (cfg.camera) {
        camSelect.style.display = "";
        fillCameras().then(() => {
          if (!stopWatchingCameras) stopWatchingCameras = onCameraChange(fillCameras);
        });
      }

      go.addEventListener("click", async () => {
        go.disabled = true;
        go.textContent = "Waiting for the picker…";
        try {
          if (stopWatchingCameras) stopWatchingCameras();
          await countdownThenRecord(cfg);
        } catch (e) {
          go.disabled = false;
          go.textContent = "Choose what to share →";
          const msg = /denied|not allowed|Permission/i.test(String(e && e.message))
            ? "Screen sharing was declined."
            : String((e && e.message) || e);
          let n = el.querySelector(".note.err");
          if (!n) { n = h("div", { class: "note err" }); el.insertBefore(n, go); }
          n.innerHTML = "<b>Could not start:</b> " + msg;
        }
      });

      // Past recordings, appended once the disk has been read.
      const saved = await listRecordings().catch(() => []);
      if (saved.length) {
        const lib = h("div", { class: "lib" }, [h("h3", {}, [saved.length + " saved on this device"])]);
        saved.slice(0, 6).forEach((r) => {
          const when = formatDuration(r.meta.durationMs || 0);
          const name = (r.project && r.project.name) || "Recording";
          const item = h("button", { class: "libitem" }, [
            h("div", { class: "thumb", style: r.project && r.project.poster ? `background-image:url(${r.project.poster})` : "" }),
            h("div", { class: "grow" }, [
              h("div", { class: "nm" }, [name]),
              h("div", { class: "mt" }, [
                when + " · " + formatBytes(r.meta.bytes || 0) +
                (r.meta.recovered ? " · recovered" : "") +
                (r.project && r.project.exports && r.project.exports.length ? " · saved" : ""),
              ]),
            ]),
            h("span", { class: "del", title: "Delete this recording", html: "&times;" }),
          ]);
          item.addEventListener("click", async (e) => {
            if (e.target.classList.contains("del")) {
              e.stopPropagation();
              await store.remove(r.id).catch(() => {});
              preflight();
              return;
            }
            try {
              const rec = await openRecording(r.id);
              editor(rec, migrateProject(r.project, rec));
            } catch (err) {
              alert(String((err && err.message) || err));
            }
          });
          lib.appendChild(item);
        });
        el.insertBefore(lib, el.querySelector(".cta"));
      }
    }

    /* ── 2. countdown, then the HUD ── */
    async function countdownThenRecord(cfg) {
      // The picker must open straight from the click or the browser rejects it
      // as an untrusted gesture — so the capture is acquired first and the
      // countdown runs in the gap before recording actually starts. The other
      // way round puts the picker's fade-out and a giant "3 2 1" on the tape.
      session = await startSession(cfg, {
        onSurfaceEnded: () => finish(),
        beforeRecord: async () => {
          ui.layer.innerHTML = "";
          const count = h("div", { class: "count" });
          const n = h("span", {}, ["3"]);
          count.appendChild(n);
          ui.layer.appendChild(count);
          for (const v of ["3", "2", "1"]) {
            n.textContent = v;
            await new Promise((r) => setTimeout(r, 600));
          }
          count.remove();
        },
      });
      hud();
    }

    function hud() {
      ui.layer.innerHTML = "";
      const bar = h("div", { class: "hud" });
      const time = h("span", {}, ["0:00"]);
      const meta = h("span", { class: "meta" }, [""]);
      const pause = h("button", {}, ["Pause"]);
      const mark = h("button", { title: "Mark this moment for a zoom" }, ["Zoom here"]);
      const stop = h("button", { class: "stop" }, ["Stop"]);

      pause.addEventListener("click", () => {
        if (session.paused) { session.resume(); pause.textContent = "Pause"; bar.classList.remove("paused"); }
        else { session.pause(); pause.textContent = "Resume"; bar.classList.add("paused"); }
      });
      mark.addEventListener("click", () => {
        const n = session.mark();
        mark.textContent = "Marked ×" + n;
        setTimeout(() => (mark.textContent = "Zoom here"), 1100);
      });
      stop.addEventListener("click", finish);

      bar.appendChild(h("div", { class: "rec" }, [h("span", { class: "dot" }), time]));
      bar.appendChild(meta);
      bar.appendChild(pause);
      if (session.capture.canDrawCursor) bar.appendChild(mark);
      bar.appendChild(stop);
      ui.layer.appendChild(bar);

      const tick = setInterval(() => {
        if (closed || !session) return clearInterval(tick);
        time.textContent = formatDuration(session.elapsedMs);
        meta.textContent =
          formatBytes(session.bytes) + (session.counts.clicks ? " · " + session.counts.clicks + " clicks" : "");
      }, 500);

      // Only hide when it would otherwise be filmed. On a window or screen
      // recording the HUD is on a surface that is not being captured, so
      // hiding it would just be irritating.
      if (session.capture.isThisTab) {
        bar.appendChild(h("span", { class: "tip" }, ["hides itself · move to the bottom edge"]));
        let hideTimer = 0;
        let shown = false;
        const tuck = () => {
          bar.classList.add("tuck");
          if (shown && session) { session.noteUiVisible(false); shown = false; }
        };
        const peek = () => {
          bar.classList.remove("tuck");
          if (!shown && session) { session.noteUiVisible(true); shown = true; }
          clearTimeout(hideTimer);
          hideTimer = setTimeout(tuck, 2600);
        };
        peek();
        const onMove = (e) => { if (e.clientY > innerHeight - 90) peek(); };
        addEventListener("pointermove", onMove, { passive: true });
        const watch = setInterval(() => {
          if (!closed && session) return;
          clearInterval(watch);
          clearTimeout(hideTimer);
          removeEventListener("pointermove", onMove);
        }, 500);
      }
    }

    /* ── 3. stop, then edit ── */
    let finishing = false;
    async function finish() {
      // Chrome's own "Stop sharing" bar and our Stop button can both land here,
      // and the first of them stops the tracks, which fires the other.
      if (finishing) return;
      if (!session) return teardown();
      finishing = true;
      const s = session;
      session = null;
      const line = h("p", { class: "sub" }, ["Closing the file."]);
      sheet([h("h2", {}, ["Finishing the recording…"]), line]);

      let result;
      try {
        result = await s.stop((msg) => (line.textContent = msg));
      } catch (e) {
        // The bytes are on disk even when the teardown failed, so offer them
        // rather than dropping the whole recording on the floor.
        finishing = false;
        sheet([
          h("h2", {}, ["The recording did not close cleanly"]),
          h("p", { class: "sub" }, [String((e && e.message) || e)]),
          h("p", { class: "sub" }, ["What was captured is still on disk and should open from the list."]),
          h("button", { class: "cta", onclick: () => preflight() }, ["Back to recordings"]),
          h("button", { class: "cta ghost", onclick: teardown }, ["Close"]),
        ]);
        return;
      }
      finishing = false;
      if (result.meta.durationMs < 700) {
        await store.remove(result.meta.id).catch(() => {});
        sheet([
          h("h2", {}, ["That was too short"]),
          h("p", { class: "sub" }, ["Nothing was kept. Try again and give it a couple of seconds."]),
          h("button", { class: "cta", onclick: teardown }, ["Close"]),
        ]);
        return;
      }
      const project = newProject(result);
      // The reach for Stop puts our toolbar back on screen for the last second
      // or two of nearly every recording. Rather than leave that for the user
      // to spot and trim, the out point defaults to just before it — still
      // draggable, so nothing is actually lost.
      const runs = result.track.uiVisible || [];
      const tail = runs[runs.length - 1];
      if (tail && tail.from > 800 && result.meta.durationMs - tail.from < 8000) {
        project.edit.trim.end = Math.max(800, tail.from - 180);
      }
      project.edit.style.camera.show = result.meta.hasCamera;
      project.edit.style.cursor.show = result.meta.hasCursorTrack;
      project.edit.segments = result.meta.hasCursorTrack ? planZooms(result.track, result.meta.durationMs) : [];
      (result.track.markers || []).forEach((m) =>
        project.edit.segments.push({
          id: uuid(), start: Math.max(0, m.t - 400), end: Math.min(result.meta.durationMs, m.t + 2600),
          inMs: 800, outMs: 700, scale: 1.8, x: 0.5, y: 0.5, auto: false, clicks: 1,
        })
      );
      project.edit.segments.sort((a, b) => a.start - b.start);
      await saveProject(project);
      editor(result, project);
    }

    /* ── 4. the editor ───────────────────────────────────────────────────────
     * Laid out the way editors are laid out, because that is what people
     * already know: media on the left, playback beside it, a multi-track
     * timeline underneath, tools along the bottom.
     *
     * Only the tools this footage actually needs are here. There is no colour
     * grading and no multicam, because a screen recording has one camera and
     * does not need grading; there IS split, delete, speed, volume, zoom,
     * captions and a face track, because that is what turns a raw capture into
     * something worth watching.
     */
    function editor(rec, project) {
      ui.layer.innerHTML = "";
      const edit = project.edit;
      const style = edit.style;
      const dur = rec.meta.durationMs;

      let tl = buildTimeline(edit.clips, dur);
      let keys = buildCameraTrack(edit.segments);
      let selectedClip = tl.length ? tl[0].id : null;
      let outT = 0;
      let playing = false;

      /* ── history ── */
      const past = [];
      const future = [];
      const snapshot = () => JSON.stringify({ clips: edit.clips, segments: edit.segments, camShots: edit.camShots, overlays: edit.overlays });
      const restore = (snap) => {
        const v = JSON.parse(snap);
        edit.clips = v.clips; edit.segments = v.segments; edit.camShots = v.camShots; edit.overlays = v.overlays;
        recompute();
      };
      const commit = () => {
        past.push(snapshot());
        if (past.length > 60) past.shift();
        future.length = 0;
        paintHistory();
      };
      const undo = () => {
        if (!past.length) return;
        future.push(snapshot());
        restore(past.pop());
        paintHistory();
      };
      const redo = () => {
        if (!future.length) return;
        past.push(snapshot());
        restore(future.pop());
        paintHistory();
      };

      /* ── autosave ── */
      let saveTimer = 0;
      const touch = () => {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => saveProject(project).catch(() => {}), 400);
      };
      const recompute = () => {
        tl = buildTimeline(edit.clips, dur);
        keys = buildCameraTrack(edit.segments);
        paintTracks();
        paintQuality();
        touch();
      };

      /* ── shell ── */
      const wrap = h("div", { class: "studio" });
      const canvas = h("canvas");
      let srcW = rec.meta.width, srcH = rec.meta.height;
      const outW = 1600;
      let outH = Math.round((outW * srcH) / Math.max(1, srcW) / 2) * 2;
      canvas.width = outW; canvas.height = outH;
      const ctx = canvas.getContext("2d", { alpha: false });

      const video = document.createElement("video");
      video.muted = true; video.playsInline = true; video.preload = "auto";
      video.addEventListener("loadedmetadata", () => {
        if (!video.videoWidth) return;
        srcW = video.videoWidth; srcH = video.videoHeight;
        outH = Math.round((outW * srcH) / srcW / 2) * 2;
        canvas.width = outW; canvas.height = outH;
        rec.meta.width = srcW; rec.meta.height = srcH;
        paintQuality();
      }, { once: true });
      video.src = URL.createObjectURL(rec.files.screen);
      const camVideo = rec.files.camera ? document.createElement("video") : null;
      if (camVideo) { camVideo.muted = true; camVideo.playsInline = true; camVideo.src = URL.createObjectURL(rec.files.camera); }

      /* ── playback ─────────────────────────────────────────────────────────
       * Driven by the video's own clock rather than a timer of ours, so audio
       * and picture cannot drift apart. Our job is only to jump the playhead
       * over the stretches that were cut out, and to set the rate for the clip
       * currently under it.
       */
      const seekOut = (t) => {
        outT = clamp(t, 0, timelineDuration(tl));
        const hit = outToSrc(tl, outT);
        if (!hit) return;
        video.currentTime = hit.src / 1000;
        video.playbackRate = hit.clip.speed;
        if (camVideo) camVideo.currentTime = hit.src / 1000;
      };

      let raf = 0;
      const frame = () => {
        const src = video.currentTime * 1000;
        const mapped = srcToOut(tl, src);
        if (mapped == null) {
          // The playhead has run into a deleted stretch: hop to the next clip.
          const next = tl.find((c) => c.srcStart > src);
          if (next) seekOut(next.outStart + 1);
          else { pause(); seekOut(timelineDuration(tl)); }
        } else {
          outT = mapped;
          const hit = outToSrc(tl, outT);
          if (hit && Math.abs(video.playbackRate - hit.clip.speed) > 0.001) video.playbackRate = hit.clip.speed;
        }
        renderFrame(ctx, {
          W: outW, H: outH, src: video, srcW, srcH,
          t: video.currentTime * 1000, style, keys,
          track: rec.track, cameraSrc: camVideo, camShots: edit.camShots, overlays: edit.overlays,
        });
        playhead.style.left = pct(outT);
        cur.textContent = formatDuration(outT);
        raf = requestAnimationFrame(frame);
      };

      const play = () => {
        if (outT >= timelineDuration(tl) - 40) seekOut(0);
        playing = true; video.play();
        if (camVideo) { camVideo.currentTime = video.currentTime; camVideo.play(); }
        playBtn.innerHTML = "❚❚";
      };
      const pause = () => {
        playing = false; video.pause();
        if (camVideo) camVideo.pause();
        playBtn.innerHTML = "▶";
      };
      const toggle = () => (playing ? pause() : play());
      video.addEventListener("ended", pause);

      /* ── timeline geometry ── */
      const total = () => Math.max(1, timelineDuration(tl));
      const pct = (t) => (clamp(t, 0, total()) / total()) * 100 + "%";
      const msAt = (clientX) => {
        const r = lanes.getBoundingClientRect();
        return ((clientX - r.left) / r.width) * total();
      };

      /* ── tools ── */
      const doSplit = () => {
        const before = edit.clips.length;
        const next = splitAt(edit.clips, dur, outT);
        if (next.length === before) return flash("Nothing to split here");
        commit();
        edit.clips = next;
        recompute();
      };
      const doDelete = () => {
        if (edit.clips.length < 2) return flash("The last clip cannot be removed");
        const idx = tl.findIndex((c) => c.id === selectedClip);
        if (idx < 0) return;
        commit();
        edit.clips = edit.clips.filter((c) => c.id !== selectedClip);
        recompute();
        selectedClip = (buildTimeline(edit.clips, dur)[Math.min(idx, edit.clips.length - 1)] || {}).id;
        paintTracks();
        seekOut(Math.min(outT, timelineDuration(tl)));
      };
      const setSpeed = (v) => {
        const c = edit.clips.find((x) => x.id === selectedClip);
        if (!c) return;
        commit();
        c.speed = v;
        recompute();
      };
      const setVolume = (v) => {
        const c = edit.clips.find((x) => x.id === selectedClip);
        if (!c) return;
        c.volume = v;
        touch();
      };

      let flashTimer = 0;
      const flashEl = h("span", { class: "flash" });
      const flash = (msg) => {
        flashEl.textContent = msg;
        flashEl.classList.add("on");
        clearTimeout(flashTimer);
        flashTimer = setTimeout(() => flashEl.classList.remove("on"), 1800);
      };

      const addZoomHere = () => {
        const hit = outToSrc(tl, outT);
        if (!hit) return;
        const c = cursorAt(rec.track.moves || [], hit.src, style.cursor.smoothing);
        commit();
        edit.segments.push({
          id: uuid(), start: Math.max(0, hit.src - 300), end: Math.min(dur, hit.src + 2400),
          inMs: 800, outMs: 700, scale: 2,
          x: c ? clamp(c.x / (rec.track.surface.w || srcW), 0, 1) : 0.5,
          y: c ? clamp(c.y / (rec.track.surface.h || srcH), 0, 1) : 0.5,
          auto: false, clicks: 1,
        });
        edit.segments.sort((a, b) => a.start - b.start);
        recompute();
      };
      const addCamShot = () => {
        const hit = outToSrc(tl, outT);
        if (!hit) return;
        commit();
        edit.camShots.push({
          id: uuid(), start: hit.src, end: Math.min(dur, hit.src + 6000),
          inMs: CAMERA_SHOT_DEFAULTS.inMs, outMs: CAMERA_SHOT_DEFAULTS.outMs, mode: "full",
        });
        edit.camShots.sort((a, b) => a.start - b.start);
        recompute();
      };
      const addCaption = () => {
        const hit = outToSrc(tl, outT);
        if (!hit) return;
        commit();
        edit.overlays.push({
          id: uuid(), type: "caption", start: hit.src, end: Math.min(dur, hit.src + 2600),
          text: "New caption", style: "clean", y: 0.86,
        });
        edit.overlays.sort((a, b) => a.start - b.start);
        recompute();
        setTab("Text");
      };

      /* ── the timeline ── */
      const lanes = h("div", { class: "lanes" });
      const ruler = h("div", { class: "ruler" });
      const playhead = h("div", { class: "playhead" });
      const laneRows = {};

      const LANES = [
        { key: "text", icon: "T", label: "Text" },
        { key: "screen", icon: "▣", label: "Screen" },
        { key: "camera", icon: "◉", label: "Camera" },
        { key: "audio", icon: "♪", label: "Audio" },
      ];
      const laneState = {};
      LANES.forEach((l) => (laneState[l.key] = { locked: false, visible: true }));

      const paintRuler = () => {
        ruler.innerHTML = "";
        const d = total();
        // A tick every 1/2/5/10/30s, whichever gives a readable spacing.
        const steps = [1000, 2000, 5000, 10000, 30000, 60000];
        const step = steps.find((x) => d / x <= 12) || 60000;
        for (let t = 0; t <= d; t += step) {
          ruler.appendChild(h("span", { class: "tick", style: `left:${pct(t)}` }, [formatDuration(t)]));
        }
      };

      /** Thumbnails along the screen track, the way a filmstrip reads. */
      const filmstrip = h("div", { class: "strip" });
      const buildStrip = async () => {
        if (!video.videoWidth) return;
        filmstrip.innerHTML = "";
        const count = 12;
        const tmp = document.createElement("canvas");
        tmp.width = 96; tmp.height = Math.max(1, Math.round((96 * srcH) / srcW));
        const tctx = tmp.getContext("2d");
        const probe = document.createElement("video");
        probe.muted = true; probe.src = video.src;
        await new Promise((r) => { probe.addEventListener("loadeddata", r, { once: true }); setTimeout(r, 4000); });
        for (let i = 0; i < count; i++) {
          const hit = outToSrc(tl, (i + 0.5) * (total() / count));
          if (!hit) continue;
          probe.currentTime = hit.src / 1000;
          await new Promise((r) => { probe.addEventListener("seeked", r, { once: true }); setTimeout(r, 900); });
          try {
            tctx.drawImage(probe, 0, 0, tmp.width, tmp.height);
            filmstrip.appendChild(h("i", { style: `background-image:url(${tmp.toDataURL("image/jpeg", 0.5)})` }));
          } catch (e) {
            break;
          }
        }
      };

      const paintTracks = () => {
        paintRuler();
        LANES.forEach((l) => {
          const row = laneRows[l.key];
          if (!row) return;
          row.innerHTML = "";
          row.style.opacity = laneState[l.key].visible ? "1" : "0.25";
        });

        // Screen: one block per clip, with the cuts visible between them.
        tl.forEach((c) => {
          const b = h("div", {
            class: "clip" + (c.id === selectedClip ? " sel" : ""),
            style: `left:${pct(c.outStart)};width:${(c.outLen / total()) * 100}%`,
            title: `${formatDuration(c.outLen)}${c.speed !== 1 ? " · " + c.speed + "×" : ""}`,
          }, [
            h("span", { class: "clabel" }, [c.speed !== 1 ? c.speed + "×" : formatDuration(c.outLen)]),
          ]);
          b.addEventListener("pointerdown", () => { selectedClip = c.id; paintTracks(); paintPane(); });
          laneRows.screen.appendChild(b);
        });
        laneRows.screen.appendChild(filmstrip);

        // Zoom segments ride over the screen track, in OUTPUT time.
        edit.segments.forEach((sg, i) => {
          const a = srcToOut(tl, sg.start), z = srcToOut(tl, Math.min(sg.end + sg.outMs, dur));
          if (a == null && z == null) return;
          const from = a == null ? 0 : a, to = z == null ? total() : z;
          const b = h("div", {
            class: "chip zoom", style: `left:${pct(from)};width:${((to - from) / total()) * 100}%`,
            title: `${sg.scale.toFixed(1)}× zoom`,
          }, [h("span", {}, [sg.scale.toFixed(1) + "×"]), h("span", { class: "x", html: "&times;" })]);
          b.querySelector(".x").addEventListener("click", (e) => {
            e.stopPropagation(); commit(); edit.segments.splice(i, 1); recompute();
          });
          laneRows.screen.appendChild(b);
        });

        edit.camShots.forEach((sh, i) => {
          const a = srcToOut(tl, sh.start), z = srcToOut(tl, sh.end);
          if (a == null && z == null) return;
          const from = a == null ? 0 : a, to = z == null ? total() : z;
          const b = h("div", {
            class: "chip cam", style: `left:${pct(from)};width:${((to - from) / total()) * 100}%`, title: "Webcam fills the frame",
          }, [h("span", {}, ["FACE"]), h("span", { class: "x", html: "&times;" })]);
          b.querySelector(".x").addEventListener("click", (e) => {
            e.stopPropagation(); commit(); edit.camShots.splice(i, 1); recompute();
          });
          laneRows.camera.appendChild(b);
        });

        edit.overlays.filter((o) => o.type === "caption").forEach((cap) => {
          const a = srcToOut(tl, cap.start), z = srcToOut(tl, cap.end);
          if (a == null && z == null) return;
          const from = a == null ? 0 : a, to = z == null ? total() : z;
          const b = h("div", {
            class: "chip text", style: `left:${pct(from)};width:${((to - from) / total()) * 100}%`, title: cap.text,
          }, [h("span", {}, [cap.text.slice(0, 22) || "…"]), h("span", { class: "x", html: "&times;" })]);
          b.querySelector(".x").addEventListener("click", (e) => {
            e.stopPropagation();
            commit();
            edit.overlays.splice(edit.overlays.indexOf(cap), 1);
            recompute(); paintPane();
          });
          laneRows.text.appendChild(b);
        });

        // Audio: the click track is the only waveform we can draw honestly
        // without decoding the audio, so it is labelled as what it is.
        if (rec.meta.hasAudio) {
          laneRows.audio.appendChild(h("div", { class: "wave" }));
        }
        (rec.track.clicks || []).filter((c) => c.kind === "down").forEach((c) => {
          const at = srcToOut(tl, c.t);
          if (at == null) return;
          laneRows.audio.appendChild(h("div", { class: "clickmark", style: `left:${pct(at)}` }));
        });
      };

      const paintHistory = () => {
        undoBtn.disabled = !past.length;
        redoBtn.disabled = !future.length;
      };

      /* ── inspector ── */
      const pane = h("div", { class: "pane" });
      const TABS = ["Cut", "Zoom", "Text", "Look", "Sound"];
      const tabs = h("div", { class: "tabs" });
      let activeTab = "Cut";
      const setTab = (t) => {
        activeTab = t;
        [...tabs.children].forEach((c) => c.classList.toggle("on", c.textContent === t));
        paintPane();
      };

      const paintPane = () => {
        pane.innerHTML = "";
        const clip = edit.clips.find((c) => c.id === selectedClip);

        if (activeTab === "Cut") {
          pane.appendChild(h("h4", {}, [edit.clips.length + (edit.clips.length === 1 ? " clip" : " clips")]));
          pane.appendChild(h("div", { class: "btnrow" }, [
            h("button", { class: "tool", onclick: doSplit, title: "Cut the clip under the playhead in two" }, ["Split"]),
            h("button", { class: "tool danger", onclick: doDelete, title: "Remove the selected clip" }, ["Delete"]),
          ]));
          if (clip) {
            pane.appendChild(h("h4", {}, ["Selected clip"]));
            pane.appendChild(slider("Speed", 0.25, 4, 0.05, clip.speed, (v) => v.toFixed(2) + "×", setSpeed));
            pane.appendChild(slider("Volume", 0, 2, 0.05, clip.volume == null ? 1 : clip.volume,
              (v) => Math.round(v * 100) + "%", setVolume));
            if (clip.speed !== 1) {
              pane.appendChild(h("div", { class: "hint" }, [
                "Audio is copied through without re-encoding, which keeps narration bit-identical — but it also means a clip at anything other than 1× carries no sound rather than sound at the wrong pitch.",
              ]));
            }
          }
          pane.appendChild(h("div", { class: "hint" }, [
            "Clips stay in recording order: this is one capture being cut down, not a bin of footage being rearranged.",
          ]));
        } else if (activeTab === "Zoom") {
          pane.appendChild(h("div", { class: "btnrow" }, [
            h("button", { class: "tool", onclick: addZoomHere }, ["Add zoom"]),
            h("button", { class: "tool", onclick: () => {
              commit();
              edit.segments = rec.meta.hasCursorTrack ? planZooms(rec.track, dur) : [];
              recompute();
            } }, ["Re-plan"]),
          ]));
          pane.appendChild(h("h4", {}, [edit.segments.length + " zooms"]));
          pane.appendChild(toggleCtl("Enabled", style.zoom.enabled, (v) => { style.zoom.enabled = v; touch(); }));
          pane.appendChild(slider("Strength", 1.2, 3.2, 0.1, edit.segments[0] ? edit.segments[0].scale : 2,
            (v) => v.toFixed(1) + "×", (v) => { edit.segments.forEach((sg) => (sg.scale = v)); recompute(); }));
          pane.appendChild(slider("Move", 400, 1600, 50, edit.segments[0] ? edit.segments[0].inMs : 900,
            (v) => (v / 1000).toFixed(2) + "s", (v) => {
              edit.segments.forEach((sg) => { sg.inMs = v; sg.outMs = Math.round(v * 0.78); }); recompute();
            }));
          pane.appendChild(h("h4", {}, ["Feel"]));
          pane.appendChild(slider("Motion blur", 0, 1.4, 0.05, style.zoom.motionBlur == null ? 0.85 : style.zoom.motionBlur,
            (v) => (v ? v.toFixed(2) + "×" : "off"), (v) => { style.zoom.motionBlur = v; touch(); }));
          pane.appendChild(slider("Drift", 0, 1.5, 0.05, style.zoom.drift == null ? 0.5 : style.zoom.drift,
            (v) => (v ? v.toFixed(2) + "×" : "off"), (v) => { style.zoom.drift = v; touch(); }));
          pane.appendChild(h("div", { class: "hint" }, [
            "Motion blur renders only while the camera moves — it roughly halves export speed on move-heavy footage and costs nothing on held shots.",
          ]));
        } else if (activeTab === "Text") {
          pane.appendChild(h("div", { class: "btnrow" }, [
            h("button", { class: "tool", onclick: addCaption }, ["Add caption"]),
          ]));
          const list = edit.overlays.filter((o) => o.type === "caption");
          if (!list.length) pane.appendChild(h("div", { class: "hint" }, [
            "Captions sit above everything, including a full-frame webcam, and never zoom with the picture.",
          ]));
          list.forEach((cap) => {
            pane.appendChild(h("h4", {}, [formatDuration(cap.start) + " → " + formatDuration(cap.end)]));
            const ta = h("textarea", { rows: 2, class: "ta" });
            ta.value = cap.text;
            ta.addEventListener("input", () => { cap.text = ta.value; paintTracks(); touch(); });
            pane.appendChild(ta);
            const styles = h("div", { class: "btnrow wrap" });
            Object.keys(CAPTION_STYLES).forEach((k) => {
              const b = h("button", { class: "tool" + (cap.style === k ? " on" : ""), title: CAPTION_STYLES[k].hint }, [CAPTION_STYLES[k].label]);
              b.addEventListener("click", () => { cap.style = k; touch(); paintPane(); });
              styles.appendChild(b);
            });
            pane.appendChild(styles);
            pane.appendChild(slider("Height", 0.1, 0.94, 0.01, cap.y == null ? 0.86 : cap.y,
              (v) => Math.round(v * 100) + "%", (v) => { cap.y = v; touch(); }));
          });
        } else if (activeTab === "Look") {
          pane.appendChild(h("h4", {}, ["Background"]));
          const sw = h("div", { class: "swatches" });
          const mark = (el) => { [...sw.children].forEach((c) => c.classList.remove("on")); el.classList.add("on"); };
          Object.keys(GRADIENTS).forEach((k) => {
            const b = h("button", { style: `background:linear-gradient(135deg,${GRADIENTS[k].join(",")})` });
            if (style.background.kind === "gradient" && k === style.background.value) b.classList.add("on");
            b.addEventListener("click", () => { style.background = { kind: "gradient", value: k }; mark(b); touch(); });
            sw.appendChild(b);
          });
          const dark = h("button", { style: "background:#0b0c0f", title: "Solid" });
          if (style.background.kind === "color") dark.classList.add("on");
          dark.addEventListener("click", () => { style.background = { kind: "color", value: "#0b0c0f" }; mark(dark); touch(); });
          sw.appendChild(dark);
          pane.appendChild(sw);
          pane.appendChild(h("h4", {}, ["Frame"]));
          pane.appendChild(slider("Padding", 0, 0.18, 0.005, style.padding, (v) => Math.round(v * 100) + "%", (v) => { style.padding = v; touch(); }));
          pane.appendChild(slider("Radius", 0, 48, 1, style.radius, (v) => v + "px", (v) => { style.radius = v; touch(); }));
          pane.appendChild(slider("Shadow", 0, 0.6, 0.02, style.shadow, (v) => Math.round((v / 0.6) * 100) + "%", (v) => { style.shadow = v; touch(); }));
          if (rec.meta.hasCursorTrack) {
            pane.appendChild(h("h4", {}, ["Cursor"]));
            pane.appendChild(toggleCtl("Show", style.cursor.show, (v) => { style.cursor.show = v; touch(); }));
            pane.appendChild(slider("Size", 1, 4, 0.1, style.cursor.size, (v) => v.toFixed(2) + "×", (v) => { style.cursor.size = v; touch(); }));
            pane.appendChild(slider("Smoothing", 0, 1, 0.01, style.cursor.smoothing, (v) => v.toFixed(2), (v) => { style.cursor.smoothing = v; touch(); }));
            pane.appendChild(slider("Blur", 0, 1.2, 0.05, style.cursor.motionBlur, (v) => v.toFixed(2) + "×", (v) => { style.cursor.motionBlur = v; touch(); }));
            pane.appendChild(slider("Bounce", 0, 8, 0.1, style.cursor.clickBounce, (v) => v.toFixed(1) + "×", (v) => { style.cursor.clickBounce = v; touch(); }));
          }
          if (rec.meta.hasCamera) {
            pane.appendChild(h("h4", {}, ["Webcam"]));
            pane.appendChild(h("div", { class: "btnrow" }, [
              h("button", { class: "tool", onclick: addCamShot }, ["Fill the frame here"]),
            ]));
            pane.appendChild(toggleCtl("Show", style.camera.show, (v) => { style.camera.show = v; touch(); }));
            pane.appendChild(toggleCtl("Mirror", style.camera.mirror, (v) => { style.camera.mirror = v; touch(); }));
            pane.appendChild(slider("Size", 0.1, 0.4, 0.01, style.camera.size, (v) => Math.round(v * 100) + "%", (v) => { style.camera.size = v; touch(); }));
            pane.appendChild(slider("X", 0, 1, 0.01, style.camera.x, (v) => Math.round(v * 100) + "%", (v) => { style.camera.x = v; touch(); }));
            pane.appendChild(slider("Y", 0, 1, 0.01, style.camera.y, (v) => Math.round(v * 100) + "%", (v) => { style.camera.y = v; touch(); }));
          }
        } else {
          if (!rec.meta.hasAudio) {
            pane.appendChild(h("div", { class: "empty" }, ["This recording has no audio track."]));
          } else {
            pane.appendChild(h("div", { class: "hint" }, [
              "Narration is copied from the recording into the export byte for byte — never re-encoded, so it comes out exactly as the microphone heard it.",
            ]));
            if (clip) pane.appendChild(slider("Clip volume", 0, 2, 0.05, clip.volume == null ? 1 : clip.volume,
              (v) => Math.round(v * 100) + "%", setVolume));
          }
        }
      };
      TABS.forEach((t) => {
        const b = h("button", { class: t === activeTab ? "on" : "" }, [t]);
        b.addEventListener("click", () => setTab(t));
        tabs.appendChild(b);
      });

      /* ── top bar ── */
      const nm = h("input", { class: "nm", value: project.name });
      nm.addEventListener("input", () => { project.name = nm.value; touch(); });
      const stat = h("span", { class: "stat" }, [""]);
      const quality = h("select", { class: "pick", title: "Export resolution" });
      const paintQuality = () => {
        const keep = project.output.preset;
        quality.innerHTML = "";
        OUTPUT_PRESETS.forEach((pr) => {
          const r = resolveOutput(pr.key, srcW, srcH);
          quality.appendChild(h("option", { value: pr.key }, [
            `${r.label} · ${r.width}×${r.height}${r.upscales ? " ↑" : ""} · ${rec.meta.fps >= 50 ? "60" : "30"}fps`,
          ]));
        });
        quality.value = keep;
        stat.textContent =
          formatDuration(timelineDuration(tl)) +
          " · " + edit.clips.length + (edit.clips.length === 1 ? " clip" : " clips");
      };
      quality.addEventListener("change", () => { project.output.preset = quality.value; touch(); paintQuality(); });

      const primary = h("button", { class: "act primary" }, [o.onAttach ? "Attach to issue" : "Export"]);
      const back = h("button", { class: "act ghost" }, ["← Back"]);
      const progress = h("div", { class: "progress" }, [h("i")]);

      back.addEventListener("click", async () => {
        cancelAnimationFrame(raf);
        clearTimeout(saveTimer);
        pause();
        await saveProject(project).catch(() => {});
        teardown();
      });

      primary.addEventListener("click", async () => {
        primary.disabled = true; back.disabled = true;
        pause();
        const bar = progress.querySelector("i");
        try {
          const out = await exportRecording({
            screenFile: rec.files.screen, cameraFile: rec.files.camera,
            meta: rec.meta, track: rec.track, style,
            segments: edit.segments, camShots: edit.camShots, overlays: edit.overlays,
            clips: edit.clips, preset: project.output.preset, quality: project.output.quality,
            onProgress: (p) => {
              bar.style.width = (p.ratio * 100).toFixed(1) + "%";
              stat.textContent = p.phase === "done" ? "Finishing…"
                : `Rendering ${Math.round(p.ratio * 100)}%` + (p.speed ? ` · ${p.speed.toFixed(1)}× realtime` : "");
            },
          });
          if (!out) return teardown();
          project.exports.unshift({ at: Date.now(), bytes: out.meta.bytes, width: out.meta.width, height: out.meta.height, frames: out.meta.frames });
          await saveProject(project);
          stat.textContent = formatBytes(out.meta.bytes) + " · " + out.meta.frames + " frames";
          if (o.onAttach) { await o.onAttach(out.file, out.meta); teardown(); }
          else {
            const a = document.createElement("a");
            a.href = URL.createObjectURL(out.file);
            a.download = project.name.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").toLowerCase() + ".webm";
            a.click();
            primary.disabled = false; primary.textContent = "Export again";
            back.disabled = false; bar.style.width = "0";
            frame();
          }
        } catch (e) {
          stat.textContent = "Export failed: " + ((e && e.message) || e);
          primary.disabled = false; back.disabled = false;
        }
      });

      /* ── media rail ── */
      const media = h("div", { class: "media" }, [h("div", { class: "mhead" }, ["Media"])]);
      listRecordings().then((rows) => {
        rows.forEach((r) => {
          const item = h("button", { class: "mitem" + (r.id === project.id ? " on" : "") }, [
            h("div", { class: "mthumb", style: r.project && r.project.poster ? `background-image:url(${r.project.poster})` : "" }),
            h("div", { class: "mname" }, [(r.project && r.project.name) || "Recording"]),
            h("div", { class: "mmeta" }, [formatDuration(r.meta.durationMs || 0)]),
          ]);
          item.addEventListener("click", async () => {
            if (r.id === project.id) return;
            cancelAnimationFrame(raf);
            pause();
            await saveProject(project).catch(() => {});
            const next = await openRecording(r.id);
            editor(next, migrateProject(r.project, next));
          });
          media.appendChild(item);
        });
      });

      /* ── assemble ── */
      const playBtn = h("button", { class: "ic", html: "▶" });
      playBtn.addEventListener("click", toggle);
      const cur = h("span", { class: "time" }, ["0:00"]);
      const undoBtn = h("button", { class: "ic", title: "Undo", html: "↺" });
      const redoBtn = h("button", { class: "ic", title: "Redo", html: "↻" });
      undoBtn.addEventListener("click", undo);
      redoBtn.addEventListener("click", redo);

      const laneHeads = h("div", { class: "heads" });
      LANES.forEach((l) => {
        const eye = h("button", { class: "mini", title: "Show or hide" , html: "◉" });
        const lock = h("button", { class: "mini", title: "Lock", html: "⌾" });
        eye.addEventListener("click", () => {
          laneState[l.key].visible = !laneState[l.key].visible;
          eye.classList.toggle("off", !laneState[l.key].visible);
          if (l.key === "text") { style.captionsHidden = !laneState[l.key].visible; }
          if (l.key === "camera") { style.camera.show = laneState[l.key].visible; }
          if (l.key === "screen") { style.zoom.enabled = laneState[l.key].visible; }
          touch(); paintTracks();
        });
        lock.addEventListener("click", () => {
          laneState[l.key].locked = !laneState[l.key].locked;
          lock.classList.toggle("off", laneState[l.key].locked);
        });
        laneHeads.appendChild(h("div", { class: "head" }, [
          h("span", { class: "hicon" }, [l.icon]), h("span", { class: "hlabel" }, [l.label]), lock, eye,
        ]));
        const row = h("div", { class: "lane" });
        laneRows[l.key] = row;
        lanes.appendChild(row);
      });

      lanes.appendChild(playhead);
      lanes.addEventListener("pointerdown", (e) => {
        if (e.target.closest(".chip") || e.target.closest(".x")) return;
        seekOut(msAt(e.clientX));
      });

      const toolbar = h("div", { class: "ttools" }, [
        h("span", { class: "tname" }, ["Timeline"]),
        h("button", { class: "tool", onclick: doSplit }, ["✂ Split"]),
        h("button", { class: "tool", onclick: addZoomHere }, ["⌖ Zoom"]),
        h("button", { class: "tool", onclick: addCaption }, ["T Text"]),
        h("button", { class: "tool", onclick: addCamShot }, ["◉ Face"]),
        flashEl,
        h("span", { class: "grow" }),
        h("button", { class: "tool danger", onclick: doDelete }, ["🗑 Delete"]),
      ]);

      wrap.appendChild(h("div", { class: "top" }, [
        back, h("span", { class: "mark" }, ["Studio"]), nm, stat,
        h("span", { class: "grow" }), quality, primary,
      ]));
      wrap.appendChild(media);
      wrap.appendChild(h("div", { class: "playback" }, [
        h("div", { class: "phead" }, ["Playback"]),
        h("div", { class: "stagewrap" }, [canvas]),
        h("div", { class: "pbar" }, [playBtn, cur, h("span", { class: "time" }, ["/"]),
          h("span", { class: "time", id: "tot" }, [formatDuration(timelineDuration(tl))]),
          h("span", { class: "grow" }),
          h("span", { class: "time" }, [rec.meta.hasCursorTrack ? "cursor tracked" : "no pointer data"])]),
      ]));
      wrap.appendChild(h("div", { class: "side" }, [tabs, pane]));
      wrap.appendChild(h("div", { class: "timeline" }, [
        toolbar,
        h("div", { class: "tbody" }, [laneHeads, h("div", { class: "lanewrap" }, [ruler, lanes])]),
      ]));
      wrap.appendChild(h("div", { class: "footer" }, [
        undoBtn, redoBtn, h("span", { class: "grow" }),
        h("span", { class: "foothint" }, ["Space to play · S to split · ⌘Z to undo"]),
      ]));
      wrap.appendChild(progress);
      ui.layer.appendChild(wrap);

      /* keyboard, the way an editor expects */
      const onKey = (e) => {
        if (e.target && /input|textarea|select/i.test(e.target.tagName || "")) return;
        if (e.key === " ") { e.preventDefault(); toggle(); }
        else if (e.key === "s" || e.key === "S") doSplit();
        else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); }
        else if (e.key === "ArrowLeft") seekOut(outT - (e.shiftKey ? 1000 : 100));
        else if (e.key === "ArrowRight") seekOut(outT + (e.shiftKey ? 1000 : 100));
      };
      addEventListener("keydown", onKey);

      setTab("Cut");
      paintTracks();
      paintQuality();
      paintHistory();
      video.addEventListener("loadeddata", () => {
        seekOut(0);
        frame();
        buildStrip().catch(() => {});
        if (!project.poster) setTimeout(() => {
          try {
            const th = document.createElement("canvas");
            th.width = 160; th.height = Math.round((160 * canvas.height) / canvas.width);
            th.getContext("2d").drawImage(canvas, 0, 0, th.width, th.height);
            project.poster = th.toDataURL("image/jpeg", 0.5);
            touch();
          } catch (e) { /* tainted canvas just means no thumbnail */ }
        }, 700);
      }, { once: true });

      // An agent editing the project through MCP lands here.
      addEventListener("pinstage:project-external", (e) => {
        if (!e.detail || e.detail.id !== project.id) return;
        loadProject(project.id).then((fresh) => {
          if (!fresh) return;
          const m = migrateProject(fresh, rec);
          project.edit = m.edit;
          project.name = m.name || project.name;
          nm.value = project.name;
          Object.assign(style, m.edit.style);
          edit.clips = m.edit.clips; edit.segments = m.edit.segments;
          edit.camShots = m.edit.camShots; edit.overlays = m.edit.overlays;
          recompute(); paintPane();
        });
      });
    }

    preflight();
    return { close: teardown };
  }

  window.PinstageStudio = {
    version: "0.6.0",
    store,
    PointerTrack,
    planZooms,
    buildCameraTrack,
    startCapture,
    startSession,
    listCameras,
    onCameraChange,
    buildManifest,
    classifyCamera,
    renderFrame,
    cameraLayoutAt,
    CAMERA_SHOT_DEFAULTS,
    drawCaption,
    CAPTION_STYLES,
    wrapText,
    framedRect,
    paintBackground,
    drawCursor,
    pickMime,
    WebMWriter,
    demuxWebM,
    packetStream,
    exportRecording,
    OUTPUT_PRESETS,
    resolveOutput,
    bitrateFor,
    normalizeClips,
    buildTimeline,
    timelineDuration,
    outToSrc,
    srcToOut,
    splitAt,
    newProject,
    migrateProject,
    saveProject,
    loadProject,
    listRecordings,
    openRecording,
    PROJECT_VERSION,
    open,
    pickVideoCodec,
    STYLE_DEFAULTS,
    GRADIENTS,
    cameraAt,
    cursorAt,
    clickPhase,
    ease,
    formatDuration,
    formatBytes,
    ZOOM_DEFAULTS,
  };
})();
