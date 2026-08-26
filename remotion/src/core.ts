/**
 * The editing maths, borrowed rather than reimplemented.
 *
 * `pinstage-studio.js` is a zero-dependency IIFE that hangs its exports off
 * `window.PinstageStudio`. Remotion renders inside headless Chromium, so
 * importing it here for its side effect gives this project the EXACT camera,
 * cursor, clip and easing functions the browser preview uses.
 *
 * That is the whole point. Two renderers that each carry their own copy of the
 * easing curve, the edge guard and the clip mapping will drift apart within a
 * week, and the drift shows up as "the export does not look like the preview" —
 * which is the complaint that destroys trust in an editor. There is one
 * implementation, and both renderers call it.
 */
import "../../pinstage-studio.js";

type Cam = { scale: number; x: number; y: number };
type Clip = { id: string; srcStart: number; srcEnd: number; speed: number; volume?: number };
type Seg = { id: string; start: number; end: number; inMs: number; outMs: number; scale: number; x: number; y: number };

export type StudioApi = {
  version: string;
  buildTimeline: (clips: Clip[], durationMs: number) => (Clip & { outStart: number; outEnd: number; outLen: number })[];
  timelineDuration: (tl: any[]) => number;
  outToSrc: (tl: any[], outT: number) => { index: number; clip: any; src: number } | null;
  srcToOut: (tl: any[], srcT: number) => number | null;
  buildCameraTrack: (segs: Seg[]) => any[];
  cameraAt: (keys: any[], t: number) => Cam;
  cursorAt: (moves: any[], t: number, smoothing: number) => { x: number; y: number; vx: number; vy: number } | null;
  clickPhase: (clicks: any[], t: number, speedMs: number) => number | null;
  cameraLayoutAt: (shots: any[], t: number, W: number, H: number, st: any) => any;
  renderFrame: (ctx: any, opts: any) => void;
  framedRect: (W: number, H: number, sw: number, sh: number, pad: number) => any;
  resolveOutput: (preset: string, w: number, h: number) => { width: number; height: number; label: string; upscales: boolean };
  planZooms: (track: any, durationMs: number, opts?: any) => Seg[];
  STYLE_DEFAULTS: any;
  GRADIENTS: Record<string, string[]>;
  CAPTION_STYLES: Record<string, { label: string; hint: string }>;
  OUTPUT_PRESETS: { key: string; height: number; label: string }[];
};

export const studio = (globalThis as any).window?.PinstageStudio as StudioApi;

if (!studio) {
  throw new Error(
    "pinstage-studio.js did not register. It is imported for its side effect and must run before this module is used."
  );
}

/** The shape of the file this project renders. */
export type StudioProject = {
  version: number;
  id: string;
  name: string;
  durationMs: number;
  edit: {
    clips: Clip[];
    style: any;
    segments: Seg[];
    camShots: { id: string; start: number; end: number; inMs: number; outMs: number; mode: string }[];
    overlays: { id: string; type: string; start: number; end: number; text?: string; style?: string; y?: number }[];
  };
  output: { preset: string; quality?: number };
};

export type StudioProps = {
  project: StudioProject;
  track: any;
  /** Paths resolved through staticFile() by the caller. */
  screenSrc: string;
  cameraSrc: string | null;
  sourceWidth: number;
  sourceHeight: number;
};
