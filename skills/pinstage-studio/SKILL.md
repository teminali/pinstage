---
name: pinstage-studio
description: Edit a Pinstage Studio screen recording — cut dead air, place zooms, write captions, cut to the webcam, set speed, and render. Studio itself only records and produces; all editing happens in the folder, here. Use whenever someone asks to edit, tighten, caption, trim, speed up, or render a screen recording, tutorial or bug repro made with Pinstage Studio, or mentions ~/Documents/pinstage/recordings.
---

# Editing a Pinstage Studio recording

Studio records in the browser and produces the finished video there. It has no
editor: pressing **Save everything to a folder** writes the recording and its
edit into `~/Documents/pinstage/recordings/<slug>/` (or `PINSTAGE_STUDIO_DIR`),
and that folder is where editing happens — by you, here.

Nothing you write takes effect until it is rendered. Either re-open the
recording in Studio and press **Produce** (it re-reads the folder first), or
render it yourself with the Remotion project.

## The contract, and why it matters

```
screen.webm     MASTER. The screen and only the screen.
camera.webm     MASTER. The webcam, at the film's shape and full resolution.
track.json      Pointer positions, clicks, keystroke times.
project.json    THE EDIT. The only file you change.
manifest.json   What each asset is, machine-readable.
export.webm     The last render. Disposable.
```

Nothing is baked into a master. No cursor, no zoom, no caption, no background —
every effect is applied at render time from the edit. That is what makes an edit
reversible: change a zoom, re-render, change it back, re-render, forever, with
no generation loss.

**Never** re-encode, trim or "clean up" a master. **Never** edit `export.webm`;
re-render instead. If you find yourself reaching for ffmpeg on `screen.webm`,
stop — whatever you want is expressible in `project.json`.

## Two clocks

Confusing them is the one bug that will make your edit nonsense.

- **Source time** — where a moment sits in the original recording. Clicks, zoom
  segments, captions, camera shots and the pointer track are *all* in source
  time, and stay correct no matter how you cut.
- **Output time** — where it lands in the finished film, after cuts and speed.

Everything you write in `project.json` is source time. `clips[]` additionally
decides what survives and in what order.

## The tools

| tool | use |
| --- | --- |
| `pinstage_studio_list` | start here — what exists, and the state of each edit |
| `pinstage_studio_get` | the full EDL plus the manifest |
| `pinstage_studio_patch` | merge a partial project; **arrays replace wholesale** |
| `pinstage_studio_cut_silence` | drop stretches with no pointer activity |

`patch` validates before writing. A refusal names the clip and the reason —
overlapping clips, a caption past the end, a zoom outside 1–4×. Read the
refusal; do not retry the same shape.

There is no live preview to check your work against. Render to see it.

## The edit

```jsonc
{
  "edit": {
    // What survives, in source order, laid end to end in the output.
    // One clip spanning the whole recording IS the un-cut case.
    "clips": [
      { "id": "c0", "srcStart": 0, "srcEnd": 8200, "speed": 1, "volume": 1 },
      { "id": "c1", "srcStart": 19400, "srcEnd": 31000, "speed": 1.5 }
    ],

    // Camera moves. `x`/`y` are 0–1 across the SOURCE frame.
    "segments": [
      { "id": "z1", "start": 2100, "end": 5200, "inMs": 900, "outMs": 700,
        "scale": 2, "x": 0.34, "y": 0.41 }
    ],

    // The webcam grows from its corner inset to fill the frame and back.
    "camShots": [{ "id": "f1", "start": 12000, "end": 18000, "mode": "full" }],

    // Captions. style: clean | bold | pop | neon | terminal
    "overlays": [
      { "id": "t1", "type": "caption", "start": 1500, "end": 4200,
        "text": "Open Settings, then Integrations", "style": "clean", "y": 0.86 }
    ],

    "style": {
      "background": { "kind": "gradient", "value": "dusk" },
      "padding": 0.06, "radius": 18, "shadow": 0.28,
      "zoom": { "enabled": true, "motionBlur": 0.85, "drift": 0.5 },
      "cursor": { "show": true, "size": 2.2, "smoothing": 0.67,
                  "motionBlur": 0.4, "clickBounce": 3.5, "bounceSpeedMs": 350 },
      "camera": { "show": true, "shape": "circle", "size": 0.22, "x": 0.98, "y": 0.98 }
    }
  },
  "output": { "preset": "1080p" }   // 720p | 1080p | 1440p | 2160p | source
}
```

## How to actually edit one

Work in this order. Each step assumes the one before it.

**1. Cut the dead air first.** It is the single highest-value edit on a screen
recording — dead air is what makes a tutorial feel long — and doing it first
means every later decision is made against the real pacing.

```
pinstage_studio_cut_silence { dryRun: true }
```

Read what it would remove. `minGapMs` defaults to 2500; drop it to ~1500 for a
brisk tutorial, raise it to ~4000 if the person is talking over a still screen
(the pointer track cannot hear narration, so long explanations look like
silence — this is the one place the tool is genuinely blind, and the reason for
`dryRun`).

**2. Then the zooms.** Studio has already planned them from the clicks. Look
before you rewrite: `segments` clustered around click bursts are usually right.
Add one only where the viewer needs to see something the clicks did not touch.
`scale` above about 2.5 on a 1080p export starts to show the source pixels.

**3. Then captions.** Short. One idea each. They sit above everything including
a full-frame webcam, and they never zoom with the picture, so they stay
readable at any camera position. Use `clean` unless there is a reason not to.

**4. Then the face.** A `camShots` entry where the person stops driving the UI
and just talks. If they are demonstrating, leave the webcam in its corner.

**5. Render.** Either is fine:

```
cd <pinstage>/remotion && node render.mjs <folder>     # MP4, full toolkit
```

or tell the user to press **Produce** in Studio, which re-reads the folder and
renders WebM in the browser.

## Render in the browser, or with Remotion?

Studio's own Produce is faster and needs nothing installed. Use Remotion when
you need something it cannot do:

- **Audio on a sped-up clip.** The browser exporter copies Opus packets through
  untouched — which is what keeps narration bit-identical — but that also means
  it cannot resample, so a clip at anything other than 1× loses its sound there.
  Remotion re-encodes and keeps it.
- **MP4** rather than WebM.
- Anything you want to compose *around* the recording: an intro, a lower third,
  a soundtrack, a transition Remotion already has.

The Remotion project imports `pinstage-studio.js` and calls the same
`renderFrame` Studio's own Produce uses, so the two renders cannot drift. Add to
the composition; do not reimplement the camera or the cursor.

## Things that will bite you

- **`patch` replaces arrays wholesale.** Sending `{"edit":{"overlays":[...]}}`
  with one caption deletes the others. Read with `get`, modify, send the whole
  array back.
- **Clips must be in source order and must not overlap.** They are ranges of one
  continuous recording, not a bin of footage to rearrange.
- **A window or screen recording has no pointer track.** `manifest.json` says
  so. There is no automatic zoom and no drawn cursor to work with, so
  `cut_silence` has nothing to judge and zooms must be placed by hand.
- **Times are milliseconds, not seconds, and not frames.**
- **Do not invent a duration.** `project.durationMs` is the recording's real
  length; a clip beyond it is refused.
