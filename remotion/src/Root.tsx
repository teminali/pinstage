import React from "react";
import { Composition, staticFile } from "remotion";
import { StudioComposition } from "./StudioComposition";
import { studio, StudioProps } from "./core";

/**
 * The project to render is handed in as props (see render.mjs), so this file
 * never hardcodes a recording. Dimensions and length are derived from the edit
 * rather than declared, because the edit is the authority: cutting a clip out
 * shortens the film, and the composition must shorten with it.
 */
const FALLBACK: StudioProps = {
  project: {
    version: 4,
    id: "none",
    name: "No project supplied",
    durationMs: 4000,
    edit: {
      clips: [{ id: "c0", srcStart: 0, srcEnd: 4000, speed: 1 }],
      style: studio.STYLE_DEFAULTS,
      segments: [],
      camShots: [],
      overlays: [
        { id: "n", type: "caption", start: 0, end: 4000, text: "Pass a project with --props", style: "clean", y: 0.5 },
      ],
    },
    output: { preset: "1080p" },
  },
  track: { surface: { w: 1920, h: 1080 }, moves: [], clicks: [], keys: [] },
  screenSrc: "",
  cameraSrc: null,
  sourceWidth: 1920,
  sourceHeight: 1080,
};

export const RemotionRoot: React.FC = () => (
  <Composition
    id="PinstageStudio"
    component={StudioComposition}
    defaultProps={FALLBACK}
    calculateMetadata={({ props }) => {
      const p = props.project;
      const tl = studio.buildTimeline(p.edit.clips, p.durationMs);
      const out = studio.resolveOutput(
        (p.output && p.output.preset) || "1080p",
        props.sourceWidth,
        props.sourceHeight
      );
      const fps = 60;
      return {
        width: out.width,
        height: out.height,
        fps,
        durationInFrames: Math.max(1, Math.round((studio.timelineDuration(tl) / 1000) * fps)),
        props: {
          ...props,
          screenSrc: props.screenSrc ? staticFile(props.screenSrc) : "",
          cameraSrc: props.cameraSrc ? staticFile(props.cameraSrc) : null,
        },
      };
    }}
  />
);
