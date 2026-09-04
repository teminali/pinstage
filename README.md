# Pinstage

Visual feedback and autonomous bug-fixing toolbar for web applications. Drop pins directly on live UI elements, capture technical DOM context and console diagnostics, and let AI agents resolve issues autonomously.

## Core Features

- **Live Element Pins**: Pin feedback to buttons, inputs, and components with automatic detection of CSS selectors, component names, and source files.
- **Multi-Image Paste & Upload**: Paste multiple screenshots from clipboard simultaneously, select multiple files, or drag-and-drop assets directly into the composer.
- **Persistent Draft Caching**: Unposted comments, mentions, and annotated screenshots are continuously cached locally (localStorage) and auto-restored on reload or navigation.
- **Synchronized Paired Drag**: Pins remain stable click targets when closed, and move in lockstep with the comment box when opened.
- **Single-Permission Screen Capture**: Built-in screenshot and drawing tool captures tab frames without repeatedly asking for browser permissions.
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


## License

MIT (c) Teminali

## Support

If this saved you time, [a coffee's worth of crypto](DONATE.md) is a good way to say so. It stays free either way.
