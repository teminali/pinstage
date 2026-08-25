# Pinstage

Visual feedback and autonomous bug-fixing toolbar for web applications. Drop pins directly on live UI elements, capture technical DOM context and console diagnostics, and let AI agents resolve issues autonomously.

## Core Features

- **Live Element Pins**: Pin feedback to buttons, inputs, and components with automatic detection of CSS selectors, component names, and source files.
- **Multi-Image Paste & Upload**: Paste multiple screenshots from clipboard simultaneously, select multiple files, or drag-and-drop assets directly into the composer.
- **Persistent Draft Caching**: Unposted comments, mentions, and annotated screenshots are continuously cached locally (localStorage) and auto-restored on reload or navigation.
- **Synchronized Paired Drag**: Pins remain stable click targets when closed, and move in lockstep with the comment box when opened.
- **Single-Permission Screen Capture**: Built-in screenshot and drawing tool captures tab frames without repeatedly asking for browser permissions.
- **Studio, a screen recorder with click-driven zoom**: Record a tutorial or a bug repro from the toolbar — screen, microphone and webcam — and Studio zooms in on what you clicked, draws a smooth synthetic cursor with motion blur and a click bounce, and renders a finished file. Attach it to an issue in one step, or save it. Loaded on demand, so it costs nothing until used. See [Studio](#studio).
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

A screen recorder built into the toolbar. `Record` in the pill starts a tutorial;
the camera button in any comment composer records a bug repro and attaches the
finished video to that issue.

```
pinstage.js          the toolbar          ~110 KB
pinstage-studio.js   the recorder         fetched the first time Record is clicked
```

Studio is never on the critical path — it is loaded from beside `pinstage.js` the
first time someone actually asks for it, so pages that never record never pay for
it. Point `studioUrl` at it in `Pinstage.init({...})` if the two files are served
from different places.

### What makes the zoom work

The screen is captured **without a cursor**, and the pointer is recorded
separately as a track of timestamped coordinates and clicks. That track is what
drives the effects, and it is why they are better than anything derived from the
pixels:

- **Zoom follows the work.** Clicks are clustered in time *and* space into single
  held shots. Two clicks in the same place are one zoom, not two punches. Two
  clicks far apart that overlap in time become a **pan** — the camera glides
  from one to the other and never dips back out to wide, which is the single
  most nauseating thing an auto-zoom does.
- **The camera is one continuous keyframe track**, not a stack of independent
  zooms, so it is continuous by construction — verified by test, not by eye.
- **The cursor is drawn, not filmed.** Vector, so it stays sharp at any zoom;
  smoothed through a Catmull-Rom path; motion-blurred along its real trajectory;
  and it bounces on the exact frame of the press.
- **The webcam is recorded to its own file**, so it stays movable, resizable and
  removable in the edit instead of being burned into the screen track forever.

### Recording anything other than this tab

A browser can only observe the pointer inside its own page. Recording **this
tab** gives an exact pointer track and every effect above. Recording a **window
or the whole screen** gives no pointer data, so the operating system's cursor is
composited in by the capture and zooms have to be placed by hand. Studio says
which mode is live in the picker rather than quietly producing a worse video.

### Long recordings

Nothing is held in memory. `MediaRecorder` chunks stream into an OPFS file as
they arrive (through an ordered write queue — an out-of-order WebM is an
unplayable WebM), so a three-hour capture costs the same RAM as a three-minute
one.

Export is the same story in reverse, and is why the container is handled by hand
rather than by recording a canvas in real time:

```
screen.webm ─► demux ─► VideoDecoder ─► composite ─► VideoEncoder ─► mux ─► export.webm
                 └────────── audio packets copied straight through ──────────┘
```

- **Faster than real time** — bounded by the encoder, not by the clock. A canvas
  captured through `MediaRecorder` renders a fifty-minute tutorial in fifty
  minutes; this does not.
- **Frame exact** — every frame is decoded. Nothing is "presented" and dropped.
- **The audio is never touched.** Its Opus packets are copied from the source
  file into the destination byte for byte, so narration comes out bit-identical
  and no audio encoder is involved anywhere.

Output is WebM (VP9 + Opus).

### Requirements

Chrome or Edge 94+ (WebCodecs, OPFS, `getDisplayMedia`). Without OPFS the
recording is held in memory and Studio says so up front. Without WebCodecs it
records but cannot render a file.

## License

MIT (c) Teminali
