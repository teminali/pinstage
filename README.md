# Pinstage

Visual feedback and autonomous bug-fixing toolbar for web applications. Drop pins directly on live UI elements, capture technical DOM context and console diagnostics, and let AI agents resolve issues autonomously.

## Core Features

- **Live Element Pins**: Pin feedback to buttons, inputs, and components with automatic detection of CSS selectors, component names, and source files.
- **Multi-Image Paste & Upload**: Paste multiple screenshots from clipboard simultaneously, select multiple files, or drag-and-drop assets directly into the composer.
- **Persistent Draft Caching**: Unposted comments, mentions, and annotated screenshots are continuously cached locally (localStorage) and auto-restored on reload or navigation.
- **Synchronized Paired Drag**: Pins remain stable click targets when closed, and move in lockstep with the comment box when opened.
- **Single-Permission Screen Capture**: Built-in screenshot and drawing tool captures tab frames without repeatedly asking for browser permissions.
- **Studio, a screen recorder with click-driven zoom**: Record a tutorial or a bug repro from the toolbar — screen, microphone and webcam — then press Produce. Out comes the finished video with click-driven zooms and a drawn cursor, plus the screen master, the webcam master and the edit data, so the cut can be redone in a real editor without re-recording. Loaded on demand, so it costs nothing until used. See [Studio](#studio).
- **Honest elapsed timers**: The active-count badge carries a progress ring and an elapsed counter (`44s`, `2m 56s`, `1h 04m`), with the same live ticker on every in-progress row. Elapsed is anchored to the moment work actually started and is measured against the server's clock, so a reply never resets it and a skewed laptop clock never distorts it; the ring fills against the median of runs that really finished, and shows an indeterminate sweep rather than a fabricated percentage when there is nothing to measure against yet.
- **Autonomous Multi-Agent Collaboration**: AI agents detect claimed issues and automatically avoid modifying the same source files concurrently to prevent merge conflicts.
- **Automatic Page Refresh**: Web pages automatically refresh when an issue is marked resolved.

## Quick Start

### 1. Load Pinstage via CDN

Add this script tag to your HTML or root layout:

```html
<script src="https://pinstage-eta.vercel.app/pinstage.js" async></script>
```

*(Or via jsDelivr CDN: `https://cdn.jsdelivr.net/gh/teminali/pinstage@master/pinstage.js`)*

### 2. Initialize in Your Application

```js
window.addEventListener("DOMContentLoaded", () => {
  if (window.Pinstage) {
    Pinstage.init({
      project: "my-web-app",
      environmentLabel: "Staging", // or "DEV"
      backend: {
        type: "supabase",
        url: "https://your-project.supabase.co",
        anonKey: "your-anon-key",
      },
    });
  }
});
```

### 3. Next.js Component Example

```tsx
"use client";

import Script from "next/script";

export function PinstageToolbar() {
  if (process.env.NODE_ENV === "production" && !process.env.NEXT_PUBLIC_ENABLE_PINSTAGE) {
    return null;
  }

  return (
    <Script
      src="https://pinstage-eta.vercel.app/pinstage.js"
      strategy="afterInteractive"
      onLoad={() => {
        if (window.Pinstage) {
          window.Pinstage.init({
            project: "my-web-app",
            environmentLabel: process.env.NODE_ENV === "development" ? "DEV" : "Staging",
            backend: {
              type: "supabase",
              url: process.env.NEXT_PUBLIC_SUPABASE_URL!,
              anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
            },
          });
        }
      }}
    />
  );
}
```

## AI Agent Integration (MCP Server)

Pinstage includes a zero-dependency Model Context Protocol (MCP) server so AI assistants (Claude Code, Antigravity, Codex) can fetch context, fix code, and resolve issues autonomously.

### Connect Claude Code

Add to `~/.claude.json` or run:

```bash
claude mcp add pinstage -- node /path/to/pinstage/mcp/pinstage-mcp.mjs --env-file /path/to/app/.env.local
```

### Connect Antigravity / Gemini

Add to `~/.gemini/config/mcp_config.json`:

```json
{
  "mcpServers": {
    "pinstage": {
      "command": "node",
      "args": [
        "/path/to/pinstage/mcp/pinstage-mcp.mjs",
        "--env-file",
        "/path/to/app/.env.local"
      ]
    }
  }
}
```

### Connect Codex

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.pinstage]
command = "node"
args = ["/path/to/pinstage/mcp/pinstage-mcp.mjs", "--env-file", "/path/to/app/.env.local"]
```

## Agent Workflow & Operating Modes

When connecting to Pinstage, agents support 3 standard operating modes:

1. **Auto Dev Mode (Infinite Loop)**: Continuously polls for new issues, sets status to `in_progress` (triggering live pulse on user screen), fixes the issue, deploys if on staging (`deploying`), and marks `resolved`.
2. **Fix Existing Issues & Stop**: Sequentially processes all open issues in the queue and exits.
3. **Fix Specific Issue(s)**: Displays open issues and lets the developer pick which one to address.

### Major Staging Issue Guard
For issues reported from Staging environments, agents evaluate whether changes are Major (database migrations, security/RLS changes, or billing alterations). If major, the agent flags the issue and awaits developer confirmation before modifying code.

## Studio

A screen recorder built into the toolbar. `Record` in the pill records a
tutorial; the camera button in any comment composer records a bug repro and
attaches the finished video to that issue.

```
pinstage.js          the toolbar          ~120 KB
pinstage-studio.js   the recorder         fetched the first time Record is clicked
```

Studio is never on the critical path — it is loaded from beside `pinstage.js`
the first time someone asks for it, so pages that never record never pay for it.
Point `studioUrl` at it in `Pinstage.init({...})` if the two files are served
from different places.

### Record, then produce

There is no editor here, on purpose. Anyone who wants to cut a tutorial properly
already has an editor they know, and a half-editor embedded in a feedback
toolbar competes with those on their terms and loses. Studio ends where the
useful part ends: press stop, get files.

| out | what it is |
| --- | --- |
| **Production video** | the finished thing — background, framing, click-driven zooms, drawn cursor, webcam inset. Ready to post. |
| **Screen recording** | the master. Screen only, nothing burned in. |
| **Webcam recording** | its own file, at the film's shape and full resolution. |
| **Edit data** | pointer track, zoom plan and manifest, so the edit can be redone anywhere without re-recording. |

The separate files are the point. A single flattened export is a dead end; these
are what someone opens in Premiere, hands to an agent, or re-renders with
Remotion a month later.

### What makes the zoom work

The screen is captured **without a cursor**, and the pointer is recorded
separately as a track of timestamped coordinates and clicks. That track is what
drives the effects, and it is why they beat anything derived from the pixels:

- **Zoom follows the work.** Clicks cluster in time *and* space into single held
  shots. Two clicks in the same place are one zoom, not two punches. Two clicks
  far apart that overlap in time become a **pan** — the camera glides from one
  to the other and never dips back out to wide, which is the most nauseating
  thing an auto-zoom does. Moves are timed to how far they travel.
- **The camera never reveals its own edges.** Zooming near an edge would slide
  the frame off the canvas and expose the background behind it; the focus point
  is clamped so it cannot.
- **Real motion blur, only while moving.** The camera is sampled across a
  shutter interval and averaged, so a push-in smears the way footage does. A
  held shot costs one draw and stays razor sharp.
- **The cursor is drawn, not filmed.** Vector, so it stays crisp at any zoom;
  smoothed through the real path; motion-blurred along it; and it bounces on the
  exact frame of the press.
- **The webcam is its own file**, so it stays a separate asset instead of being
  burned into the screen track forever.

### Recording anything other than this tab

A browser can only observe the pointer inside its own page. Recording **this
tab** gives an exact pointer track and every effect above. Recording a **window
or the whole screen** gives no pointer data, so the operating system's cursor is
composited in by the capture and there is nothing to zoom from. Studio says
which mode is live in the picker rather than quietly producing a worse video.

### Long recordings

Nothing is held in memory. `MediaRecorder` chunks stream into an OPFS file as
they arrive (through an ordered write queue — an out-of-order WebM is an
unplayable WebM), so a three-hour capture costs the same RAM as a three-minute
one. Recordings survive a reload, and one whose sidecar files never got written
is reconstructed from the video itself rather than lost.

Producing is the same story in reverse, and is why the container is handled by
hand rather than by recording a canvas in real time:

```
screen.webm ─► demux ─► VideoDecoder ─► composite ─► VideoEncoder ─► mux ─► out.webm
                 └────────── audio packets copied straight through ──────────┘
```

- **Faster than real time** — bounded by the encoder, not by the clock.
- **Frame exact** — every frame is decoded. Nothing is "presented" and dropped.
- **The audio is never touched.** Its Opus packets are copied from the source
  into the destination byte for byte, so narration comes out bit-identical and
  no audio encoder is involved anywhere.

Output is WebM (VP9 + Opus) at 720p, 1080p, 2K, 4K or the source size. Presets
key on height with the width derived from the source's aspect, because a screen
recording is rarely 16:9 — a 16:10 laptop trimmed to "1920 wide" is 1920×1200,
not 1080p. A preset above the source is offered but marked, because upscaling is
not resolution.

### Editing it somewhere else

Press **Save everything to a folder** and Studio writes the recording and its
edit into a real directory — `~/Documents/pinstage/recordings/<slug>/` — because
whatever edits it next runs on the same machine. The folder explains itself: a
README, a manifest, the masters, and `project.json`, which is an edit decision
list rather than a rendered file.

Four MCP tools work that folder, so an agent can cut dead air, place zooms and
write captions without ever touching a master: `pinstage_studio_list`,
`pinstage_studio_get`, `pinstage_studio_patch`, `pinstage_studio_cut_silence`.
Re-open the recording in Studio and Produce again to render what it wrote.

`remotion/` renders the same `project.json` with Remotion, importing
`pinstage-studio.js` so the picture comes from the same code and the two cannot
drift. Use it when you need MP4, audio on a sped-up clip, or anything composed
around the recording.

### Requirements

Chrome or Edge 94+ (WebCodecs, OPFS, `getDisplayMedia`). Without OPFS the
recording is held in memory and Studio says so up front. Without WebCodecs it
records but cannot produce a file.

## License

MIT (c) Teminali
