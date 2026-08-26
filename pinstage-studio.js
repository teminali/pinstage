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

  /* ── disk sync ────────────────────────────────────────────────────────────
   * The agent that edits these recordings runs on the SAME machine as the
   * browser that made them. Routing gigabytes of video up to storage and back
   * down again to bridge a gap of zero millimetres would be absurd, so Studio
   * writes into a real folder instead — by default the one the user is told to
   * pick, ~/Documents/pinstage/recordings — and the agent simply reads it.
   *
   * The browser cannot choose that folder on its own; the user grants it once
   * through the directory picker. The handle is kept in IndexedDB (a directory
   * handle is a live object, not something JSON can hold) so the grant survives
   * reloads and never has to be given twice.
   *
   * What lands on disk per recording:
   *
   *   <slug>/screen.webm      the master, no cursor, no webcam, no effects
   *   <slug>/camera.webm      the webcam master, if there was one
   *   <slug>/track.json       pointer, clicks, keystroke times
   *   <slug>/project.json     THE EDIT — the only file an agent should change
   *   <slug>/manifest.json    what each asset is and when to use it
   *   <slug>/export.webm      the last render, disposable
   */

  const DISK_DB = "pinstage-studio";
  const DISK_STORE = "handles";
  const DISK_KEY = "recordings-dir";

  function idb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DISK_DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(DISK_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbGet(key) {
    const db = await idb();
    return new Promise((resolve) => {
      const tx = db.transaction(DISK_STORE, "readonly").objectStore(DISK_STORE).get(key);
      tx.onsuccess = () => resolve(tx.result || null);
      tx.onerror = () => resolve(null);
    });
  }

  async function idbPut(key, value) {
    const db = await idb();
    return new Promise((resolve) => {
      const tx = db.transaction(DISK_STORE, "readwrite").objectStore(DISK_STORE).put(value, key);
      tx.onsuccess = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  }

  const disk = {
    supported: typeof window !== "undefined" && !!window.showDirectoryPicker,

    /** The folder the user granted, if the grant is still good. */
    async handle(promptIfNeeded) {
      if (!this.supported) return null;
      let h = await idbGet(DISK_KEY);
      if (h) {
        // A grant can lapse — the browser restarted, the folder moved. Asking
        // is cheap; failing silently on write is not.
        const perm = await h.queryPermission({ mode: "readwrite" }).catch(() => "denied");
        if (perm === "granted") return h;
        if (promptIfNeeded) {
          const asked = await h.requestPermission({ mode: "readwrite" }).catch(() => "denied");
          if (asked === "granted") return h;
        }
        return null;
      }
      if (!promptIfNeeded) return null;
      h = await window.showDirectoryPicker({ id: "pinstage-recordings", mode: "readwrite", startIn: "documents" });
      if (!h) return null;
      await idbPut(DISK_KEY, h);
      return h;
    },

    async forget() {
      await idbPut(DISK_KEY, null);
    },

    /** A folder name a human can read and a shell will not fight. */
    slug(project) {
      const base = (project.name || "recording")
        .toLowerCase()
        .replace(/[^\w\s-]+/g, "")
        .trim()
        .replace(/\s+/g, "-")
        .slice(0, 48) || "recording";
      return base + "-" + String(project.id).slice(0, 8);
    },

    async writeFile(dir, name, blobOrText) {
      const fh = await dir.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(blobOrText instanceof Blob ? blobOrText : new Blob([blobOrText]));
      await w.close();
    },

    /**
     * Put a recording and its edit on disk. Media is only copied when it is
     * missing or has changed size — a three gigabyte master should not be
     * rewritten because someone nudged a slider.
     */
    async sync(rec, project, onStep) {
      const root = await this.handle(true);
      if (!root) throw new Error("No folder chosen, so there is nowhere to write.");
      const dir = await root.getDirectoryHandle(this.slug(project), { create: true });

      const copyIfNeeded = async (name, file) => {
        if (!file) return false;
        try {
          const existing = await (await dir.getFileHandle(name)).getFile();
          if (existing.size === file.size) return false;
        } catch (e) {
          /* not there yet */
        }
        if (onStep) onStep("Copying " + name + " (" + formatBytes(file.size) + ")");
        await this.writeFile(dir, name, file);
        return true;
      };

      await copyIfNeeded("screen.webm", rec.files.screen);
      await copyIfNeeded("camera.webm", rec.files.camera);

      if (onStep) onStep("Writing the edit");
      await this.writeFile(dir, "track.json", JSON.stringify(rec.track));
      await this.writeFile(dir, "manifest.json", JSON.stringify(buildManifest(rec.meta), null, 2));
      await this.writeFile(dir, "project.json", JSON.stringify(project, null, 2));
      // A plain-language pointer, so the folder explains itself to whoever
      // opens it next — human or agent.
      await this.writeFile(dir, "README.md", readmeFor(project, rec.meta, this.slug(project)));

      project.disk = { folder: this.slug(project), syncedAt: Date.now() };
      await saveProject(project);
      if (onStep) onStep("Synced");
      return this.slug(project);
    },

    /** Copy a finished render next to its sources. */
    async putExport(project, file) {
      const root = await this.handle(false);
      if (!root || !project.disk) return null;
      const dir = await root.getDirectoryHandle(project.disk.folder, { create: true });
      await this.writeFile(dir, "export.webm", file);
      return project.disk.folder;
    },

    /**
     * Read back the edit an agent may have rewritten. Compared by content
     * rather than by modification time, because a filesystem timestamp is a
     * poor witness across a browser sandbox.
     */
    async readProject(project) {
      const root = await this.handle(false);
      if (!root || !project.disk) return null;
      try {
        const dir = await root.getDirectoryHandle(project.disk.folder);
        const f = await (await dir.getFileHandle("project.json")).getFile();
        return JSON.parse(await f.text());
      } catch (e) {
        return null;
      }
    },
  };

  function readmeFor(project, meta, slug) {
    return `# ${project.name}

Recorded with Pinstage Studio on ${new Date(meta.startedAt).toLocaleString()}.
${formatDuration(meta.durationMs)} · ${meta.width}×${meta.height} · ${Math.round(meta.fps)}fps

## The files

| file | what it is |
| --- | --- |
| \`screen.webm\` | **Master.** The screen and only the screen — no cursor, no webcam, no zoom, no captions, no background. Every effect is applied at render time, so editing never compounds onto an already-processed picture. |
${meta.hasCamera ? "| `camera.webm` | **Master.** The webcam, recorded at the film's shape and full resolution so it holds up filling the frame. |\n" : ""}| \`track.json\` | Pointer positions, clicks and keystroke times. Drives the drawn cursor and the automatic zoom plan. |
| \`project.json\` | **The edit.** Trim, clips, zooms, camera shots, captions, output settings. This is the only file to change. |
| \`manifest.json\` | What each asset is and when to use it, in machine-readable form. |
| \`export.webm\` | The last render. Baked and disposable — never edit it, re-render instead. |

## Editing this

Change \`project.json\` and re-render. Nothing else should be touched: the
masters are the only copies, and they are what makes an edit reversible.

Times inside \`project.json\` are **source** milliseconds — where a moment sits
in the original recording — for everything except \`clips[].srcStart/srcEnd\`,
which are also source times but define what survives into the finished film and
in what order.

The Pinstage MCP server exposes this folder as tools; \`pinstage_studio_*\` will
list, read, patch and render it. The Remotion project in the pinstage repo
renders the same \`project.json\` if you want the full compositing toolkit.

Folder: \`${slug}\`
`;
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

    /* ── produce ── */
    .sheet h4.grp { margin: 13px 0 6px; font-size: 9.5px; letter-spacing: .09em; text-transform: uppercase; color: #6a6d76; }
    .swatches { display: grid; grid-template-columns: repeat(4,1fr); gap: 5px; }
    .swatches button { height: 30px; border-radius: 7px; border: 2px solid transparent; }
    .swatches button.on { border-color: #f59e0b; }
    .pick.wide { width: 100%; max-width: none; }
    .bar2 { height: 4px; background: #1c1e24; border-radius: 999px; overflow: hidden; margin-top: 12px; }
    .bar2 i { display: block; height: 100%; width: 0; background: #f59e0b; transition: width .2s; }
    .result { display: flex; align-items: center; gap: 10px; padding: 9px 10px; border-radius: 10px;
      background: #15171c; border: 1px solid #22242b; margin-top: 6px; }
    .result .rgrow { flex: 1; min-width: 0; }
    .result .rname { font-size: 12.5px; font-weight: 600; color: #e7e8ea; }
    .result .rmeta { font-size: 10.5px; color: #7a7d86; margin-top: 2px; line-height: 1.4; }
    .result .dl { flex: none; height: 27px; padding: 0 11px; font-size: 11.5px; font-weight: 700;
      background: #f59e0b; color: #16130a; border-radius: 7px; }
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
              // If this recording has been synced to a folder, the file on
              // disk is the newer authority: that is where an agent edits it.
              // Without this, a patch made through MCP would never reach the
              // render, which is the entire point of syncing.
              let stored = r.project;
              if (stored && stored.disk) {
                const fromDisk = await disk.readProject(stored).catch(() => null);
                if (fromDisk && (fromDisk.updatedAt || 0) >= (stored.updatedAt || 0)) {
                  stored = fromDisk;
                  await saveProject(stored).catch(() => {});
                }
              }
              produce(rec, migrateProject(stored, rec));
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
      produce(result, project);
    }

    /* ── 4. produce ───────────────────────────────────────────────────────────
     * Recording is the product. Editing is not.
     *
     * There was an editor here — timeline, clips, inspector, the lot — and it
     * was the wrong shape for what this tool is. Anyone who wants to cut a
     * tutorial properly already has an editor they know, and a half-editor
     * embedded in a feedback toolbar competes with those on their terms and
     * loses. So this ends where the useful part ends: press stop, get files.
     *
     * What comes out:
     *
     *   production   the finished thing — background, framing, click-driven
     *                zooms, the drawn cursor, the webcam inset. Ready to post.
     *   screen       the master. Screen only, nothing burned in.
     *   camera       the webcam master, full resolution, its own file.
     *   assets       track.json / project.json / manifest.json, so the edit can
     *                be redone anywhere without re-recording.
     *
     * The three separate files are the point. A single flattened export is a
     * dead end; these are what someone opens in Premiere, or hands to an agent,
     * or re-renders with Remotion a month later.
     */
    function produce(rec, project) {
      ui.layer.innerHTML = "";
      const style = project.edit.style;
      const results = [];
      let producing = false;

      const clicks = (rec.track.clicks || []).filter((c) => c.kind === "down").length;

      const summary = h("p", { class: "sub" }, [
        `${formatDuration(rec.meta.durationMs)} · ${rec.meta.width}×${rec.meta.height}` +
          (rec.meta.hasCursorTrack ? ` · ${clicks} click${clicks === 1 ? "" : "s"}` : " · no pointer data") +
          (rec.meta.hasCamera ? " · webcam" : ""),
      ]);

      const el = sheet([]);
      const rebuild = () => {
        el.innerHTML = "";
        el.appendChild(h("h2", {}, [producing ? "Producing…" : "Recording finished"]));
        el.appendChild(summary);

        if (!producing && !results.length) {
          // Two choices, because those are the two that change the file people
          // actually receive. Everything else has a sane default and does not
          // need to become a decision.
          el.appendChild(h("h4", { class: "grp" }, ["Look"]));
          const sw = h("div", { class: "swatches" });
          const mark = (b) => { [...sw.children].forEach((c) => c.classList.remove("on")); b.classList.add("on"); };
          Object.keys(GRADIENTS).forEach((k) => {
            const b = h("button", { style: `background:linear-gradient(135deg,${GRADIENTS[k].join(",")})` });
            if (style.background.kind === "gradient" && k === style.background.value) b.classList.add("on");
            b.addEventListener("click", () => { style.background = { kind: "gradient", value: k }; mark(b); saveProject(project); });
            sw.appendChild(b);
          });
          const plain = h("button", { style: "background:#0b0c0f", title: "No background" });
          if (style.background.kind === "color") plain.classList.add("on");
          plain.addEventListener("click", () => { style.background = { kind: "color", value: "#0b0c0f" }; mark(plain); saveProject(project); });
          sw.appendChild(plain);
          el.appendChild(sw);

          el.appendChild(h("h4", { class: "grp" }, ["Size"]));
          const pick = h("select", { class: "pick wide" });
          OUTPUT_PRESETS.forEach((pr) => {
            const r = resolveOutput(pr.key, rec.meta.width, rec.meta.height);
            pick.appendChild(h("option", { value: pr.key }, [
              `${r.label} · ${r.width}×${r.height}${r.upscales ? " (upscaled)" : ""}`,
            ]));
          });
          pick.value = project.output.preset;
          pick.addEventListener("change", () => { project.output.preset = pick.value; saveProject(project); });
          el.appendChild(pick);

          if (rec.meta.hasCursorTrack) {
            el.appendChild(h("div", { class: "note" }, [
              `${project.edit.segments.length} zoom${project.edit.segments.length === 1 ? "" : "s"} planned from your clicks. The cursor is drawn from the pointer track, so it stays sharp at any zoom.`,
            ]));
          } else {
            el.appendChild(h("div", { class: "note" }, [
              "This was a window or screen capture, so there is no pointer data: the system cursor is already in the picture and there is nothing to zoom from.",
            ]));
          }
        }

        if (producing) {
          el.appendChild(progressBar);
          el.appendChild(h("p", { class: "sub", style: "margin-top:8px" }, [stepLine]));
        }

        results.forEach((r) => el.appendChild(r.node));

        if (!producing) {
          const go = h("button", { class: "cta" }, [
            results.length ? "Produce again" : o.onAttach ? "Produce and attach" : "Produce the video",
          ]);
          go.addEventListener("click", run);
          el.appendChild(go);

          if (results.length && disk.supported && !o.onAttach) {
            const save = h("button", { class: "cta ghost" }, [
              project.disk ? "Saved in " + project.disk.folder : "Save everything to a folder",
            ]);
            save.addEventListener("click", async () => {
              save.disabled = true;
              try {
                const folder = await disk.sync(rec, project, (m) => (save.textContent = m));
                if (produced) await disk.putExport(project, produced);
                save.textContent = "Saved in " + folder;
              } catch (e) {
                save.textContent = String((e && e.message) || e);
              } finally {
                save.disabled = false;
              }
            });
            el.appendChild(save);
          }

          el.appendChild(h("button", { class: "cta ghost", onclick: () => preflight() }, ["Recordings"]));
          el.appendChild(h("button", { class: "cta ghost", onclick: teardown }, ["Done"]));
        }
      };

      const progressBar = h("div", { class: "bar2" }, [h("i")]);
      let stepLine = "Rendering…";
      let produced = null;

      /** A downloadable result line. */
      const addResult = (label, hint, file, filename) => {
        const btn = h("button", { class: "dl" }, ["Download"]);
        btn.addEventListener("click", () => {
          const a = document.createElement("a");
          a.href = URL.createObjectURL(file);
          a.download = filename;
          a.click();
        });
        const node = h("div", { class: "result" }, [
          h("div", { class: "rgrow" }, [
            h("div", { class: "rname" }, [label]),
            h("div", { class: "rmeta" }, [hint + " · " + formatBytes(file.size)]),
          ]),
          btn,
        ]);
        results.push({ node });
      };

      const slug = (project.name || "recording")
        .toLowerCase().replace(/[^\w\s-]+/g, "").trim().replace(/\s+/g, "-").slice(0, 40) || "recording";

      async function run() {
        // Re-read the edit before rendering: an agent may have rewritten it
        // between the sheet opening and this click.
        if (project.disk) {
          const fromDisk = await disk.readProject(project).catch(() => null);
          if (fromDisk && (fromDisk.updatedAt || 0) > (project.updatedAt || 0)) {
            const m = migrateProject(fromDisk, rec);
            project.edit = m.edit;
            project.output = m.output || project.output;
            project.updatedAt = fromDisk.updatedAt;
            Object.assign(style, m.edit.style);
            await saveProject(project).catch(() => {});
          }
        }
        producing = true;
        results.length = 0;
        rebuild();
        const bar = progressBar.querySelector("i");
        try {
          const out = await exportRecording({
            screenFile: rec.files.screen,
            cameraFile: rec.files.camera,
            meta: rec.meta,
            track: rec.track,
            style,
            segments: project.edit.segments,
            camShots: project.edit.camShots,
            overlays: project.edit.overlays,
            clips: project.edit.clips,
            preset: project.output.preset,
            quality: project.output.quality,
            onProgress: (p) => {
              bar.style.width = (p.ratio * 100).toFixed(1) + "%";
              stepLine =
                p.phase === "done"
                  ? "Finishing…"
                  : `${Math.round(p.ratio * 100)}%` +
                    (p.speed ? ` · ${p.speed.toFixed(1)}× realtime` : "") +
                    (p.eta ? ` · ${formatDuration(p.eta * 1000)} left` : "");
              const line = el.querySelector(".sub:last-of-type");
              if (line) line.textContent = stepLine;
            },
          });
          if (!out) return teardown();

          produced = out.file;
          project.exports.unshift({
            at: Date.now(), bytes: out.meta.bytes, width: out.meta.width,
            height: out.meta.height, frames: out.meta.frames,
          });
          await saveProject(project);

          producing = false;
          addResult(
            "Production video",
            `${out.meta.width}×${out.meta.height} · zooms, cursor and framing baked in`,
            out.file, slug + ".webm"
          );
          addResult(
            "Screen recording",
            "the master — screen only, nothing burned in",
            rec.files.screen, slug + "-screen.webm"
          );
          if (rec.files.camera) {
            addResult(
              "Webcam recording",
              `${rec.meta.cameraWidth || "?"}×${rec.meta.cameraHeight || "?"} · its own file, full resolution`,
              rec.files.camera, slug + "-camera.webm"
            );
          }
          addResult(
            "Edit data",
            "pointer track, zoom plan and manifest — to redo the edit elsewhere",
            new Blob(
              [JSON.stringify({ project, track: rec.track, manifest: buildManifest(rec.meta) }, null, 2)],
              { type: "application/json" }
            ),
            slug + "-assets.json"
          );
          rebuild();

          if (o.onAttach) {
            await o.onAttach(out.file, out.meta);
            teardown();
          }
        } catch (e) {
          producing = false;
          results.length = 0;
          rebuild();
          el.appendChild(h("div", { class: "note err" }, ["Could not produce the video: " + ((e && e.message) || e)]));
        }
      }

      rebuild();
      // A repro attached to an issue should not need a decision at all.
      if (o.onAttach) run();
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
    disk,
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
