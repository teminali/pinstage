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

    async read(id, name) {
      if (!this.supported) return null;
      const dir = await this.dir();
      const sub = await dir.getDirectoryHandle(id);
      const handle = await sub.getFileHandle(name);
      return handle.getFile();
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
          /* a recording still being written, or a half-removed one */
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

    let segs = clusters.map((k) => ({
      id: uuid(),
      start: Math.max(0, k.first - o.leadInMs),
      end: Math.min(durationMs, k.last + o.holdAfterMs),
      inMs: o.inMs,
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
      { source: "tab", mic: true, systemAudio: false, camera: false, fps: 30 },
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
    if (o.camera) {
      try {
        camera = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
          audio: false,
        });
      } catch (e) {
        camera = null; // a refused webcam must not lose the whole recording
      }
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
  async function recordToDisk(stream, recordingId, filename, mime) {
    const writer = await store.writer(recordingId, filename);
    const rec = new MediaRecorder(stream, {
      mimeType: mime || undefined,
      videoBitsPerSecond: 8_000_000,
      audioBitsPerSecond: 128_000,
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
      async finish() {
        if (rec.state !== "inactive") {
          await new Promise((res) => {
            rec.addEventListener("stop", res, { once: true });
            rec.stop();
          });
        }
        await queue;
        await writer.close();
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

    const screen = await recordToDisk(cap.screenStream, id, "screen.webm", mime);
    const cameraRec = cap.cameraStream
      ? await recordToDisk(cap.cameraStream, id, "camera.webm", mime)
      : null;

    // The pointer track only exists when the capture is this tab; anywhere else
    // there is nothing truthful to record into it.
    const track = cap.canDrawCursor ? PointerTrack(origin) : null;

    let paused = false;
    let pausedAt = 0;
    let pausedTotal = 0;
    const markers = [];

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
      async stop() {
        if (paused) session.resume();
        if (track) track.stop();
        const durationMs = elapsed();
        const files = { screen: await screen.finish() };
        if (cameraRec) files.camera = await cameraRec.finish();
        cap.stop();
        dispatchEvent(new CustomEvent("pinstage:recording", { detail: { active: false } }));

        const data = track ? track.data : { moves: [], clicks: [], keys: [], scrolls: [], surface: { w: cap.width, h: cap.height, dpr: 1 } };
        data.markers = markers;

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
          hasAudio: cap.hasAudio,
          bytes: session.bytes,
          droppedChunks: screen.dropped + (cameraRec ? cameraRec.dropped : 0),
        };
        await store.writeJson(id, "track.json", data);
        await store.writeJson(id, "meta.json", meta);
        return { meta, track: data, files };
      },
    };

    cap.onSurfaceEnded(() => h.onSurfaceEnded && h.onSurfaceEnded(session));
    return session;
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
    zoom: { enabled: true },
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
    const rr = Math.min(r, w / 2, h / 2);
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

  /**
   * The whole frame. `src` is anything drawImage accepts — a <video> while
   * scrubbing, a VideoFrame while exporting.
   */
  function renderFrame(ctx, opts) {
    const { W, H, src, srcW, srcH, t, style, keys, track, cameraSrc } = opts;
    const st = style;

    paintBackground(ctx, W, H, st.background);

    const base = framedRect(W, H, srcW, srcH, st.padding);
    const cam = st.zoom.enabled && keys ? cameraAt(keys, t) : { scale: 1, x: 0.5, y: 0.5 };

    // The camera scales about the point of interest, expressed in the SOURCE's
    // normalised space, so a zoom target stays on the same pixel regardless of
    // how the frame happens to be letterboxed.
    const fx = base.x + base.w * cam.x;
    const fy = base.y + base.h * cam.y;
    const cx = W / 2, cy = H / 2;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(cam.scale, cam.scale);
    ctx.translate(-fx, -fy);

    // Shadow under the frame, drawn once, not per element.
    if (st.shadow > 0) {
      ctx.save();
      ctx.shadowColor = `rgba(0,0,0,${st.shadow})`;
      ctx.shadowBlur = (Math.min(W, H) * 0.045) / cam.scale;
      ctx.shadowOffsetY = (Math.min(W, H) * 0.018) / cam.scale;
      ctx.fillStyle = "#000";
      roundRectPath(ctx, base.x, base.y, base.w, base.h, st.radius);
      ctx.fill();
      ctx.restore();
    }

    ctx.save();
    roundRectPath(ctx, base.x, base.y, base.w, base.h, st.radius);
    ctx.clip();
    if (src) ctx.drawImage(src, base.x, base.y, base.w, base.h);

    // The cursor lives INSIDE the clip and inside the camera transform, so it
    // scales with the picture exactly as a real cursor on a zoomed screen would.
    if (st.cursor.show && track && track.moves && track.moves.length) {
      const c = cursorAt(track.moves, t, st.cursor.smoothing);
      if (c) {
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

        // Motion blur is the trail the eye expects behind something moving
        // fast. Sampled backwards along the real path, so it curves.
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
      }
    }
    ctx.restore(); // clip
    ctx.restore(); // camera

    // The webcam sits OUTSIDE the camera transform: a picture-in-picture that
    // zoomed with the screen would be unwatchable.
    if (cameraSrc && st.camera.show && cameraSrc.videoWidth !== 0) {
      const d = Math.min(W, H) * st.camera.size;
      const margin = Math.min(W, H) * 0.03;
      const cxp = margin + (W - d - margin * 2) * st.camera.x;
      const cyp = margin + (H - d - margin * 2) * st.camera.y;
      ctx.save();
      ctx.shadowColor = "rgba(0,0,0,0.35)";
      ctx.shadowBlur = d * 0.12;
      ctx.shadowOffsetY = d * 0.04;
      if (st.camera.shape === "circle") {
        ctx.beginPath();
        ctx.arc(cxp + d / 2, cyp + d / 2, d / 2, 0, Math.PI * 2);
      } else {
        roundRectPath(ctx, cxp, cyp, d, d * 0.66, d * 0.09);
      }
      ctx.fillStyle = "#000";
      ctx.fill();
      ctx.shadowColor = "transparent";
      ctx.clip();
      const vw = cameraSrc.videoWidth, vh = cameraSrc.videoHeight;
      const boxH = st.camera.shape === "circle" ? d : d * 0.66;
      const s = Math.max(d / vw, boxH / vh);
      const w = vw * s, hgt = vh * s;
      if (st.camera.mirror) {
        ctx.translate(cxp + d / 2, 0);
        ctx.scale(-1, 1);
        ctx.translate(-(cxp + d / 2), 0);
      }
      ctx.drawImage(cameraSrc, cxp + (d - w) / 2, cyp + (boxH - hgt) / 2, w, hgt);
      ctx.restore();
    }
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
  async function demuxWebM(file, onPacket, onProgress) {
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

    demuxWebM(file, async (p) => {
      if (filter && !filter(p)) return;
      // The packet's bytes are a view into the reader's buffer, which is about
      // to be reused — copy before it is handed across the queue.
      await push({ kind: p.kind, timeMs: p.timeMs, keyframe: p.keyframe, data: p.data.slice() });
    })
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
    // Even dimensions, because encoders insist. Height follows the source's
    // aspect unless it is given explicitly — defaulting it to 1080 would squash
    // every recording that is not already 16:9.
    const outW = (opts.width || Math.min(1920, meta.width) || 1920) & ~1;
    const outH =
      (opts.height || Math.round((outW * meta.height) / Math.max(1, meta.width))) & ~1;
    const fps = opts.fps || Math.min(60, Math.round(meta.fps || 30));
    const bitrate = opts.bitrate || Math.round(outW * outH * fps * 0.11);

    const picked = await pickVideoCodec(outW, outH, bitrate, fps);
    if (!picked) throw new Error("No supported video encoder for " + outW + "×" + outH + ".");

    const keys = st.zoom.enabled ? buildCameraTrack(segments || []) : null;
    const canvas = new OffscreenCanvas(outW, outH);
    const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });

    const camera = cameraFile ? await CameraFeeder(cameraFile).catch(() => null) : null;

    const writerId = meta.id;
    const sink = await store.writer(writerId, "export.webm");

    let muxer = null;
    let audioReady = false;
    const pendingAudio = [];

    const encoder = new VideoEncoder({
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
          });
          // A keyframe every two seconds keeps the file seekable without
          // paying for one on every frame.
          const forceKey = t - lastKeyMs >= 2000;
          if (forceKey) lastKeyMs = t;
          const out = new VideoFrame(canvas, { timestamp: frame.timestamp, duration: 1e6 / fps });
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

    while (true) {
      if (shouldCancel && shouldCancel()) {
        cancelled = true;
        break;
      }
      const p = await stream.next();
      if (!p) break;

      if (p.kind === "audio") {
        // Straight through, never re-encoded.
        if (muxer && audioReady) muxer.addAudio(p.timeMs - (firstVideoMs || 0), p.data);
        else pendingAudio.push(p);
        continue;
      }
      if (p.kind !== "video") continue;

      if (!configured) {
        const vt = stream.info && stream.info.videoTrack;
        const at = stream.info && stream.info.audioTrack;
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
      // Timestamps are rebased so the output starts at zero even when the
      // recording's first packet does not.
      const tsUs = Math.round((p.timeMs - firstVideoMs) * 1000);
      decoder.decode(
        new EncodedVideoChunk({
          type: p.keyframe ? "key" : "delta",
          timestamp: tsUs,
          data: p.data,
        })
      );

      if (pendingAudio.length && audioReady) {
        pendingAudio.splice(0).forEach((a) => muxer.addAudio(a.timeMs - firstVideoMs, a.data));
      }

      // Backpressure: let the decoder and encoder catch up rather than queueing
      // the whole file into them.
      while (decoder.decodeQueueSize > 12 || encoder.encodeQueueSize > 12) {
        await new Promise((r) => setTimeout(r, 4));
      }
      await flushSink();

      if (onProgress && framesIn % 15 === 0) {
        const ratio = clamp(
          meta.durationMs ? (p.timeMs - firstVideoMs) / meta.durationMs : 0,
          0,
          0.999
        );
        const secs = (performance.now() - started) / 1000;
        onProgress({
          phase: "render",
          ratio,
          fps: framesOut / Math.max(0.001, secs),
          speed: ratio * (meta.durationMs / 1000) / Math.max(0.001, secs),
          eta: ratio > 0.01 ? (secs / ratio) * (1 - ratio) : null,
        });
      }
    }

    await decoder.flush().catch(() => {});
    await encoder.flush().catch(() => {});
    decoder.close();
    encoder.close();
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
        durationMs: meta.durationMs,
        bytes: file.size,
        codec: picked.id,
        tookMs: performance.now() - started,
      },
    };
  }

  /* ── UI ──────────────────────────────────────────────────────────────────
   * Everything lives in one shadow root so the host application's CSS cannot
   * reach it and it cannot reach the host's. That matters more here than in the
   * rest of the toolbar: this panel is open on top of whatever app is being
   * recorded, and a leaked `* { box-sizing }` from either direction would show
   * up in the finished video.
   */

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif; }
    .layer { position: fixed; inset: 0; z-index: 2147483646; pointer-events: none; }
    .layer > * { pointer-events: auto; }
    button { font: inherit; border: 0; background: none; color: inherit; cursor: pointer; display: inline-flex;
      align-items: center; gap: 6px; border-radius: 999px; }
    .scrim { position: fixed; inset: 0; background: rgba(6,7,10,.62); backdrop-filter: blur(3px); }
    .sheet { position: fixed; left: 50%; top: 50%; transform: translate(-50%,-50%); width: 420px; max-width: 92vw;
      background: #0e0f13; color: #e7e8ea; border: 1px solid #2a2c33; border-radius: 18px; padding: 18px;
      box-shadow: 0 24px 70px rgba(0,0,0,.55); }
    .sheet h2 { margin: 0 0 2px; font-size: 15px; font-weight: 700; }
    .sheet p.sub { margin: 0 0 14px; font-size: 12px; color: #9a9da6; line-height: 1.45; }
    .seg { display: grid; grid-template-columns: repeat(3,1fr); gap: 6px; background: #16181e; padding: 4px;
      border-radius: 12px; margin-bottom: 12px; }
    .seg button { justify-content: center; padding: 9px 6px; border-radius: 9px; font-size: 12.5px; font-weight: 600;
      color: #b6b8bf; flex-direction: column; gap: 3px; }
    .seg button.on { background: #f59e0b; color: #16130a; }
    .seg button small { font-size: 9.5px; font-weight: 600; opacity: .8; }
    .row { display: flex; align-items: center; justify-content: space-between; padding: 9px 2px; font-size: 13px;
      border-top: 1px solid #1c1e24; }
    .row:first-of-type { border-top: 0; }
    .row .lbl small { display: block; font-size: 11px; color: #82858e; margin-top: 1px; }
    .sw { width: 40px; height: 23px; border-radius: 999px; background: #2a2c33; position: relative; flex: none; transition: background .15s; }
    .sw i { position: absolute; top: 3px; left: 3px; width: 17px; height: 17px; border-radius: 999px; background: #fff;
      transition: transform .15s; }
    .sw.on { background: #f59e0b; }
    .sw.on i { transform: translateX(17px); }
    .sw.off { opacity: .45; }
    .cta { width: 100%; justify-content: center; margin-top: 14px; padding: 11px; background: #f59e0b; color: #16130a;
      font-weight: 800; font-size: 13.5px; border-radius: 12px; }
    .cta.ghost { background: #1c1e24; color: #d8dae0; font-weight: 600; margin-top: 8px; }
    .cta[disabled] { opacity: .5; cursor: default; }
    .note { margin-top: 10px; font-size: 11.5px; line-height: 1.5; color: #9a9da6; background: #14161b;
      border: 1px solid #22242b; border-radius: 10px; padding: 9px 11px; }
    .note b { color: #d8dae0; font-weight: 700; }

    .count { position: fixed; inset: 0; display: grid; place-items: center; background: rgba(6,7,10,.5); }
    .count span { font-size: 128px; font-weight: 800; color: #fff; text-shadow: 0 8px 40px rgba(0,0,0,.6); }

    .hud { position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%); display: flex; align-items: center;
      gap: 4px; background: #0e0f13; border: 1px solid #2a2c33; border-radius: 999px; padding: 5px;
      box-shadow: 0 8px 30px rgba(0,0,0,.45); color: #e7e8ea; }
    .hud .rec { display: inline-flex; align-items: center; gap: 7px; padding: 0 12px 0 11px; height: 32px;
      font-size: 12.5px; font-weight: 700; font-variant-numeric: tabular-nums; }
    .hud .dot { width: 9px; height: 9px; border-radius: 999px; background: #ef4444; animation: ps-blink 1.3s infinite; }
    .hud.paused .dot { animation: none; background: #9a9da6; }
    @keyframes ps-blink { 50% { opacity: .25; } }
    .hud button { height: 32px; padding: 0 12px; font-size: 12.5px; font-weight: 600; color: #b6b8bf; }
    .hud button:hover { background: #1c1e24; color: #fff; }
    .hud button.stop { background: #ef4444; color: #fff; font-weight: 700; }
    .hud .meta { font-size: 10.5px; color: #82858e; padding: 0 8px; font-variant-numeric: tabular-nums; }
    /* When the capture IS this tab, the HUD is part of the picture. It cannot
       be excluded from the frame, so it removes itself instead: away after a
       few seconds, back when the pointer comes looking for it. */
    .hud { transition: transform .34s cubic-bezier(.4,0,.2,1), opacity .26s ease; }
    .hud.tuck { transform: translateX(-50%) translateY(calc(100% + 24px)); opacity: 0; }
    .hud .tip { font-size: 10.5px; color: #6f727a; padding: 0 8px 0 2px; }

    .studio { position: fixed; inset: 3vh 3vw; background: #0b0c0f; border: 1px solid #24262d; border-radius: 18px;
      display: grid; grid-template-columns: 1fr 268px; grid-template-rows: 46px 1fr 132px; overflow: hidden;
      box-shadow: 0 30px 90px rgba(0,0,0,.6); color: #e7e8ea; }
    .studio .top { grid-column: 1/-1; display: flex; align-items: center; gap: 10px; padding: 0 12px;
      border-bottom: 1px solid #1c1e24; font-size: 13px; font-weight: 700; }
    .studio .top .grow { flex: 1; }
    .studio .top button { height: 30px; padding: 0 13px; font-size: 12.5px; font-weight: 700; background: #1c1e24; color: #d8dae0; }
    .studio .top button.primary { background: #f59e0b; color: #16130a; }
    .studio .top button[disabled] { opacity: .5; cursor: default; }
    .stage { background: #08090b; display: grid; place-items: center; overflow: hidden; position: relative; }
    .stage canvas { max-width: 100%; max-height: 100%; border-radius: 6px; }
    .side { border-left: 1px solid #1c1e24; overflow-y: auto; padding: 12px; }
    .side h3 { margin: 14px 0 7px; font-size: 10.5px; letter-spacing: .09em; text-transform: uppercase; color: #7e818a; }
    .side h3:first-child { margin-top: 0; }
    .ctl { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 12px; padding: 5px 0; }
    .ctl input[type=range] { flex: 1; accent-color: #f59e0b; height: 3px; }
    .ctl .v { font-size: 10.5px; color: #8b8e97; width: 40px; text-align: right; font-variant-numeric: tabular-nums; }
    .swatches { display: grid; grid-template-columns: repeat(4,1fr); gap: 6px; }
    .swatches button { height: 30px; border-radius: 8px; border: 2px solid transparent; }
    .swatches button.on { border-color: #f59e0b; }
    .transport { grid-column: 1/-1; border-top: 1px solid #1c1e24; padding: 8px 12px; display: flex;
      flex-direction: column; gap: 7px; }
    .transport .bar { display: flex; align-items: center; gap: 10px; font-size: 12px; }
    .transport .bar button { width: 32px; height: 32px; justify-content: center; background: #1c1e24; }
    .time { font-variant-numeric: tabular-nums; font-size: 11.5px; color: #9a9da6; }
    .track { position: relative; height: 46px; background: #101216; border: 1px solid #1e2027; border-radius: 8px;
      overflow: hidden; cursor: pointer; }
    .track .seg-block { position: absolute; top: 6px; bottom: 6px; background: linear-gradient(180deg,#a855f7,#7c3aed);
      border-radius: 6px; opacity: .9; display: flex; align-items: center; padding: 0 6px; font-size: 10px;
      font-weight: 700; color: #fff; overflow: hidden; }
    .track .seg-block .x { margin-left: auto; opacity: .75; font-size: 12px; }
    .track .clickmark { position: absolute; bottom: 2px; width: 2px; height: 8px; background: #38bdf8; border-radius: 2px; }
    .track .play { position: absolute; top: 0; bottom: 0; width: 2px; background: #f59e0b; pointer-events: none; }
    .progress { grid-column: 1/-1; height: 3px; background: #1c1e24; }
    .progress i { display: block; height: 100%; background: #f59e0b; width: 0; transition: width .2s; }
    .empty { color: #7e818a; font-size: 12px; text-align: center; padding: 20px; }
  `;

  const h = (tag, attrs, kids) => {
    const n = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === "class") n.className = attrs[k];
      else if (k === "html") n.innerHTML = attrs[k];
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), attrs[k]);
      else n.setAttribute(k, attrs[k]);
    }
    (kids || []).forEach((c) => n.appendChild(typeof c === "string" ? document.createTextNode(c) : c));
    return n;
  };

  function mount() {
    const host = document.createElement("div");
    host.setAttribute("data-pinstage-studio", "");
    const root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = CSS;
    root.appendChild(style);
    const layer = h("div", { class: "layer" });
    root.appendChild(layer);
    document.body.appendChild(host);
    return { host, layer, destroy: () => host.remove() };
  }

  const toggleRow = (label, hint, initial, onChange, disabled) => {
    const sw = h("div", { class: "sw" + (initial ? " on" : "") + (disabled ? " off" : "") }, [h("i")]);
    const row = h("div", { class: "row" }, [
      h("div", { class: "lbl", html: label + (hint ? "<small>" + hint + "</small>" : "") }),
      sw,
    ]);
    let on = initial;
    if (!disabled)
      row.addEventListener("click", () => {
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

  /**
   * @param {object} opts
   *   onAttach  — when present, the editor's primary action hands the finished
   *               file back instead of downloading it. This is what turns the
   *               tutorial recorder into "attach a video to this issue".
   */
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

    /* ── 1. what to record ── */
    function preflight() {
      ui.layer.innerHTML = "";
      const cfg = { source: "tab", mic: true, camera: false, systemAudio: false };
      const scrim = h("div", { class: "scrim", onclick: teardown });
      const sheet = h("div", { class: "sheet" });

      const sources = [
        ["tab", "This tab", "full effects"],
        ["window", "A window", "plain capture"],
        ["screen", "Whole screen", "plain capture"],
      ];
      const seg = h("div", { class: "seg" });
      const note = h("div", { class: "note" });
      const paint = () => {
        [...seg.children].forEach((b, i) => b.classList.toggle("on", sources[i][0] === cfg.source));
        note.innerHTML =
          cfg.source === "tab"
            ? "Recording this tab captures the pointer as data, so Studio can draw a <b>smooth cursor with motion blur</b> and <b>zoom in on every click</b> automatically."
            : "A browser can only read the pointer inside its own page, so a window or screen recording gets the <b>operating system cursor baked in and no automatic zoom</b>. You can still add zooms by hand on the timeline.";
      };
      sources.forEach(([key, label, hint]) => {
        seg.appendChild(
          h("button", { onclick: () => { cfg.source = key; paint(); } }, [
            h("span", {}, [label]),
            h("small", {}, [hint]),
          ])
        );
      });
      paint();

      sheet.appendChild(h("h2", {}, ["Record"]));
      sheet.appendChild(h("p", { class: "sub" }, ["Screen, voice and webcam. Clicks become zooms."]));
      sheet.appendChild(seg);
      sheet.appendChild(toggleRow("Microphone", "your narration", cfg.mic, (v) => (cfg.mic = v)));
      sheet.appendChild(toggleRow("Webcam", "recorded separately, movable later", cfg.camera, (v) => (cfg.camera = v)));
      sheet.appendChild(toggleRow("System audio", "sound from the page itself", cfg.systemAudio, (v) => (cfg.systemAudio = v)));
      sheet.appendChild(note);

      if (!store.supported) {
        sheet.appendChild(
          h("div", { class: "note", html: "<b>Heads up:</b> this browser has no origin private file system, so the recording is held in memory. Keep it short — a long one will exhaust the tab." })
        );
      }

      const go = h("button", { class: "cta" }, ["Choose what to share →"]);
      go.addEventListener("click", async () => {
        go.disabled = true;
        go.textContent = "Waiting for the picker…";
        try {
          await countdownThenRecord(cfg);
        } catch (e) {
          go.disabled = false;
          go.textContent = "Choose what to share →";
          const msg = /denied|not allowed|Permission/i.test(String(e && e.message))
            ? "Screen sharing was declined."
            : String((e && e.message) || e);
          let n = sheet.querySelector(".note.err");
          if (!n) { n = h("div", { class: "note err" }); sheet.appendChild(n); }
          n.innerHTML = "<b>Could not start:</b> " + msg;
        }
      });
      sheet.appendChild(go);
      sheet.appendChild(h("button", { class: "cta ghost", onclick: teardown }, ["Cancel"]));

      ui.layer.appendChild(scrim);
      ui.layer.appendChild(sheet);
    }

    /* ── 2. countdown, then the HUD ── */
    async function countdownThenRecord(cfg) {
      // The picker must open straight from the click or the browser rejects it
      // as an untrusted gesture — so the capture is acquired first and the
      // countdown runs in the gap before recording actually starts. Doing it
      // the other way round puts the picker's fade-out and a giant "3 2 1" at
      // the head of every recording.
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
            await new Promise((r) => setTimeout(r, 620));
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
      const rec = h("div", { class: "rec" }, [h("span", { class: "dot" }), time]);
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
        setTimeout(() => (mark.textContent = "Zoom here"), 1200);
      });
      stop.addEventListener("click", finish);

      bar.appendChild(rec);
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
      // hiding it would just be annoying.
      if (session.capture.isThisTab) {
        bar.appendChild(h("span", { class: "tip" }, ["hides itself · move to the bottom edge"]));
        let hideTimer = 0;
        const tuck = () => bar.classList.add("tuck");
        const peek = () => {
          bar.classList.remove("tuck");
          clearTimeout(hideTimer);
          hideTimer = setTimeout(tuck, 2600);
        };
        peek();
        const onMove = (e) => {
          if (e.clientY > innerHeight - 90) peek();
        };
        addEventListener("pointermove", onMove, { passive: true });
        const stopWatching = setInterval(() => {
          if (!closed && session) return;
          clearInterval(stopWatching);
          clearTimeout(hideTimer);
          removeEventListener("pointermove", onMove);
        }, 500);
      }
    }

    /* ── 3. stop and edit ── */
    async function finish() {
      if (!session) return teardown();
      const s = session;
      session = null;
      ui.layer.innerHTML = "";
      ui.layer.appendChild(h("div", { class: "scrim" }));
      ui.layer.appendChild(h("div", { class: "sheet" }, [h("h2", {}, ["Finishing the recording…"]), h("p", { class: "sub" }, ["Flushing the last chunks to disk."])]));
      const result = await s.stop();
      if (result.meta.durationMs < 700) {
        ui.layer.innerHTML = "";
        ui.layer.appendChild(h("div", { class: "scrim", onclick: teardown }));
        ui.layer.appendChild(
          h("div", { class: "sheet" }, [
            h("h2", {}, ["That was too short"]),
            h("p", { class: "sub" }, ["Nothing was saved. Try again and give it a couple of seconds."]),
            h("button", { class: "cta", onclick: teardown }, ["Close"]),
          ])
        );
        await store.remove(result.meta.id).catch(() => {});
        return;
      }
      editor(result);
    }

    function editor(rec) {
      ui.layer.innerHTML = "";
      const style = JSON.parse(JSON.stringify(STYLE_DEFAULTS));
      style.camera.show = rec.meta.hasCamera;
      style.cursor.show = rec.meta.hasCursorTrack;

      let segments = rec.meta.hasCursorTrack
        ? planZooms(rec.track, rec.meta.durationMs)
        : [];
      // A manual "zoom here" during recording is a click the planner never saw.
      (rec.track.markers || []).forEach((m) => {
        segments.push({
          id: uuid(), start: Math.max(0, m.t - 400), end: Math.min(rec.meta.durationMs, m.t + 2600),
          inMs: 800, outMs: 700, scale: 1.8, x: 0.5, y: 0.5, auto: false, clicks: 1,
        });
      });
      segments.sort((a, b) => a.start - b.start);
      let keys = buildCameraTrack(segments);

      const wrap = h("div", { class: "studio" });
      const stage = h("div", { class: "stage" });
      const canvas = h("canvas");
      const outW = 1600, outH = Math.round((outW * rec.meta.height) / rec.meta.width / 2) * 2;
      canvas.width = outW; canvas.height = outH;
      const ctx = canvas.getContext("2d", { alpha: false });
      stage.appendChild(canvas);

      const video = document.createElement("video");
      video.muted = true; video.playsInline = true; video.preload = "auto";
      video.src = URL.createObjectURL(rec.files.screen);
      const camVideo = rec.files.camera ? document.createElement("video") : null;
      if (camVideo) { camVideo.muted = true; camVideo.playsInline = true; camVideo.src = URL.createObjectURL(rec.files.camera); }

      const side = h("div", { class: "side" });
      const transport = h("div", { class: "transport" });
      const progress = h("div", { class: "progress" }, [h("i")]);
      const top = h("div", { class: "top" });

      /* preview */
      let raf = 0;
      const draw = () => {
        const t = video.currentTime * 1000;
        renderFrame(ctx, {
          W: outW, H: outH, src: video, srcW: rec.meta.width, srcH: rec.meta.height,
          t, style, keys, track: rec.track, cameraSrc: camVideo,
        });
        playhead.style.left = (t / rec.meta.durationMs) * 100 + "%";
        cur.textContent = formatDuration(t);
        raf = requestAnimationFrame(draw);
      };

      /* transport */
      const play = h("button", { html: "▶" });
      const cur = h("span", { class: "time" }, ["0:00"]);
      const total = h("span", { class: "time" }, [formatDuration(rec.meta.durationMs)]);
      const track = h("div", { class: "track" });
      const playhead = h("div", { class: "play" });
      play.addEventListener("click", () => {
        if (video.paused) { video.play(); if (camVideo) { camVideo.currentTime = video.currentTime; camVideo.play(); } play.innerHTML = "❚❚"; }
        else { video.pause(); if (camVideo) camVideo.pause(); play.innerHTML = "▶"; }
      });
      video.addEventListener("ended", () => (play.innerHTML = "▶"));
      track.addEventListener("click", (e) => {
        if (e.target.classList.contains("x")) return;
        const r = track.getBoundingClientRect();
        const t = ((e.clientX - r.left) / r.width) * rec.meta.durationMs;
        video.currentTime = t / 1000;
        if (camVideo) camVideo.currentTime = t / 1000;
      });

      const paintTrack = () => {
        track.querySelectorAll(".seg-block,.clickmark").forEach((n) => n.remove());
        (rec.track.clicks || []).filter((c) => c.kind === "down").forEach((c) => {
          track.appendChild(h("div", { class: "clickmark", style: `left:${(c.t / rec.meta.durationMs) * 100}%` }));
        });
        segments.forEach((s, i) => {
          const b = h("div", {
            class: "seg-block",
            style: `left:${(s.start / rec.meta.durationMs) * 100}%;width:${((s.end + s.outMs - s.start) / rec.meta.durationMs) * 100}%`,
            title: `${s.scale.toFixed(1)}× · ${formatDuration(s.start)} → ${formatDuration(s.end)}`,
          }, [h("span", {}, [s.scale.toFixed(1) + "×"]), h("span", { class: "x", title: "Remove this zoom" }, ["×"])]);
          b.querySelector(".x").addEventListener("click", (e) => {
            e.stopPropagation();
            segments.splice(i, 1);
            keys = buildCameraTrack(segments);
            paintTrack();
          });
          track.appendChild(b);
        });
      };

      transport.appendChild(h("div", { class: "bar" }, [play, cur, h("span", { class: "time" }, ["/"]), total,
        h("span", { style: "flex:1" }),
        h("span", { class: "time" }, [segments.length + " zooms · " + (rec.meta.hasCursorTrack ? "cursor tracked" : "no cursor data")])]));
      track.appendChild(playhead);
      transport.appendChild(track);

      /* controls */
      side.appendChild(h("h3", {}, ["Background"]));
      const sw = h("div", { class: "swatches" });
      Object.keys(GRADIENTS).forEach((k) => {
        const b = h("button", { style: `background:linear-gradient(135deg,${GRADIENTS[k].join(",")})` });
        b.addEventListener("click", () => {
          style.background = { kind: "gradient", value: k };
          [...sw.children].forEach((c) => c.classList.remove("on"));
          b.classList.add("on");
        });
        if (k === style.background.value) b.classList.add("on");
        sw.appendChild(b);
      });
      const none = h("button", { style: "background:#16181e;font-size:10px;color:#8b8e97", title: "No background" }, ["none"]);
      none.addEventListener("click", () => {
        style.background = { kind: "color", value: "#000000" };
        [...sw.children].forEach((c) => c.classList.remove("on"));
        none.classList.add("on");
      });
      sw.appendChild(none);
      side.appendChild(sw);

      side.appendChild(h("h3", {}, ["Frame"]));
      side.appendChild(slider("Padding", 0, 0.18, 0.005, style.padding, (v) => Math.round(v * 100) + "%", (v) => (style.padding = v)));
      side.appendChild(slider("Radius", 0, 48, 1, style.radius, (v) => v + "px", (v) => (style.radius = v)));
      side.appendChild(slider("Shadow", 0, 0.6, 0.02, style.shadow, (v) => Math.round((v / 0.6) * 100) + "%", (v) => (style.shadow = v)));

      side.appendChild(h("h3", {}, ["Zoom"]));
      side.appendChild(toggleRow("Automatic zoom", segments.length + " planned", style.zoom.enabled, (v) => { style.zoom.enabled = v; }));
      side.appendChild(slider("Strength", 1.2, 3.2, 0.1, ZOOM_DEFAULTS.scale, (v) => v.toFixed(1) + "×", (v) => {
        segments.forEach((s) => (s.scale = v));
        keys = buildCameraTrack(segments);
        paintTrack();
      }));
      side.appendChild(slider("Move speed", 400, 1600, 50, ZOOM_DEFAULTS.inMs, (v) => (v / 1000).toFixed(2) + "s", (v) => {
        segments.forEach((s) => { s.inMs = v; s.outMs = Math.round(v * 0.78); });
        keys = buildCameraTrack(segments);
        paintTrack();
      }));

      if (rec.meta.hasCursorTrack) {
        side.appendChild(h("h3", {}, ["Cursor"]));
        side.appendChild(toggleRow("Show cursor", "", style.cursor.show, (v) => (style.cursor.show = v)));
        side.appendChild(slider("Size", 1, 4, 0.1, style.cursor.size, (v) => v.toFixed(2) + "×", (v) => (style.cursor.size = v)));
        side.appendChild(slider("Smoothing", 0, 1, 0.01, style.cursor.smoothing, (v) => v.toFixed(2), (v) => (style.cursor.smoothing = v)));
        side.appendChild(slider("Motion blur", 0, 1.2, 0.05, style.cursor.motionBlur, (v) => v.toFixed(2) + "×", (v) => (style.cursor.motionBlur = v)));
        side.appendChild(slider("Click bounce", 0, 8, 0.1, style.cursor.clickBounce, (v) => v.toFixed(1) + "×", (v) => (style.cursor.clickBounce = v)));
        side.appendChild(slider("Bounce speed", 120, 700, 10, style.cursor.bounceSpeedMs, (v) => v + "ms", (v) => (style.cursor.bounceSpeedMs = v)));
      }

      if (rec.meta.hasCamera) {
        side.appendChild(h("h3", {}, ["Webcam"]));
        side.appendChild(toggleRow("Show webcam", "", style.camera.show, (v) => (style.camera.show = v)));
        side.appendChild(slider("Size", 0.1, 0.4, 0.01, style.camera.size, (v) => Math.round(v * 100) + "%", (v) => (style.camera.size = v)));
        side.appendChild(slider("Position X", 0, 1, 0.01, style.camera.x, (v) => Math.round(v * 100) + "%", (v) => (style.camera.x = v)));
        side.appendChild(slider("Position Y", 0, 1, 0.01, style.camera.y, (v) => Math.round(v * 100) + "%", (v) => (style.camera.y = v)));
        side.appendChild(toggleRow("Mirror", "", style.camera.mirror, (v) => (style.camera.mirror = v)));
      }

      /* export */
      const status = h("span", { class: "time" }, [
        formatDuration(rec.meta.durationMs) + " · " + formatBytes(rec.meta.bytes) +
        (rec.meta.droppedChunks ? " · " + rec.meta.droppedChunks + " chunks lost" : ""),
      ]);
      const primary = h("button", { class: "primary" }, [o.onAttach ? "Attach to the issue" : "Save video"]);
      const discard = h("button", {}, ["Discard"]);
      let cancelling = false;

      discard.addEventListener("click", async () => {
        cancelAnimationFrame(raf);
        await store.remove(rec.meta.id).catch(() => {});
        teardown();
      });

      primary.addEventListener("click", async () => {
        primary.disabled = true;
        discard.disabled = true;
        video.pause();
        const bar = progress.querySelector("i");
        const t0 = performance.now();
        try {
          const out = await exportRecording({
            screenFile: rec.files.screen,
            cameraFile: rec.files.camera,
            meta: rec.meta,
            track: rec.track,
            style,
            segments,
            width: opts && opts.width ? opts.width : Math.min(1920, rec.meta.width),
            height: opts && opts.height ? opts.height : undefined,
            shouldCancel: () => cancelling,
            onProgress: (p) => {
              bar.style.width = (p.ratio * 100).toFixed(1) + "%";
              status.textContent =
                p.phase === "done"
                  ? "Finishing…"
                  : `Rendering ${Math.round(p.ratio * 100)}% · ${p.speed ? p.speed.toFixed(1) + "× realtime" : ""}` +
                    (p.eta ? " · " + formatDuration(p.eta * 1000) + " left" : "");
            },
          });
          if (!out) return teardown();
          status.textContent =
            formatBytes(out.meta.bytes) + " · " + out.meta.frames + " frames · rendered in " +
            formatDuration(out.meta.tookMs) + " (" + (rec.meta.durationMs / Math.max(1, out.meta.tookMs)).toFixed(1) + "× realtime)";
          cancelAnimationFrame(raf);
          if (o.onAttach) {
            await o.onAttach(out.file, out.meta);
            teardown();
          } else {
            const a = document.createElement("a");
            a.href = URL.createObjectURL(out.file);
            a.download = "tutorial-" + new Date(rec.meta.startedAt).toISOString().slice(0, 16).replace(/[:T]/g, "-") + ".webm";
            a.click();
            primary.disabled = false;
            primary.textContent = "Save again";
            discard.disabled = false;
          }
        } catch (e) {
          status.textContent = "Export failed: " + ((e && e.message) || e);
          primary.disabled = false;
          discard.disabled = false;
        }
      });

      top.appendChild(h("span", {}, ["Studio"]));
      top.appendChild(status);
      top.appendChild(h("span", { class: "grow" }));
      top.appendChild(discard);
      top.appendChild(primary);

      wrap.appendChild(top);
      wrap.appendChild(stage);
      wrap.appendChild(side);
      wrap.appendChild(transport);
      wrap.appendChild(progress);
      ui.layer.appendChild(h("div", { class: "scrim" }));
      ui.layer.appendChild(wrap);

      paintTrack();
      video.addEventListener("loadeddata", () => { video.currentTime = 0; draw(); }, { once: true });
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
    renderFrame,
    framedRect,
    paintBackground,
    drawCursor,
    pickMime,
    WebMWriter,
    demuxWebM,
    packetStream,
    exportRecording,
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
