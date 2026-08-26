import React, { useEffect, useMemo, useRef } from "react";
import {
  AbsoluteFill,
  Audio,
  Sequence,
  continueRender,
  delayRender,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { studio, StudioProps } from "./core";

/**
 * One Pinstage recording, rendered by Remotion.
 *
 * The picture is drawn by `renderFrame` — the very function the browser
 * preview uses — onto a canvas. Nothing about the look is reimplemented here:
 * the background, the frame, the edge-guarded zoom camera, the motion blur, the
 * synthetic cursor and the captions all come from the shared implementation, so
 * this render and the in-browser one cannot disagree.
 *
 * What Remotion adds is everything around the picture. Chiefly audio: the
 * browser exporter copies Opus packets through untouched, which keeps
 * narration bit-identical but makes it impossible to resample, so a clip at
 * anything other than 1x loses its sound there. Here each clip becomes a
 * Sequence with its own Audio at its own playbackRate, so a sped-up clip keeps
 * its narration. That is the reason to render here rather than in the browser.
 */
export const StudioComposition: React.FC<StudioProps> = ({
  project,
  track,
  screenSrc,
  cameraSrc,
  sourceWidth,
  sourceHeight,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const camRef = useRef<HTMLVideoElement>(null);

  const edit = project.edit;
  const tl = useMemo(
    () => studio.buildTimeline(edit.clips, project.durationMs),
    [edit.clips, project.durationMs]
  );
  const keys = useMemo(
    () => (edit.style.zoom?.enabled === false ? null : studio.buildCameraTrack(edit.segments || [])),
    [edit.segments, edit.style.zoom?.enabled]
  );

  // Output time for this frame, and the source moment that belongs there.
  const outMs = (frame / fps) * 1000;
  const hit = studio.outToSrc(tl, outMs);
  const srcMs = hit ? hit.src : 0;

  // A fresh handle per frame: the frame is not finished until the video has
  // actually seeked and the canvas has been painted. Remotion would otherwise
  // photograph whatever the <video> happened to be showing.
  const handle = useMemo(() => delayRender(`pinstage frame ${frame}`), [frame]);

  useEffect(() => {
    let cancelled = false;

    const seekTo = (el: HTMLVideoElement | null, seconds: number) =>
      new Promise<void>((resolve) => {
        if (!el) return resolve();
        if (Math.abs(el.currentTime - seconds) < 1 / (fps * 4)) return resolve();
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        el.addEventListener("seeked", done, { once: true });
        el.addEventListener("error", done, { once: true });
        // A seek that never reports back must not stall the whole render.
        setTimeout(done, 5000);
        el.currentTime = seconds;
      });

    (async () => {
      await seekTo(videoRef.current, srcMs / 1000);
      if (cameraSrc) await seekTo(camRef.current, srcMs / 1000);
      if (cancelled) return;

      const ctx = canvasRef.current?.getContext("2d");
      if (ctx) {
        studio.renderFrame(ctx, {
          W: width,
          H: height,
          src: videoRef.current,
          srcW: videoRef.current?.videoWidth || sourceWidth,
          srcH: videoRef.current?.videoHeight || sourceHeight,
          t: srcMs,
          style: edit.style,
          keys,
          track,
          cameraSrc: cameraSrc ? camRef.current : null,
          camShots: edit.camShots || [],
          overlays: edit.overlays || [],
        });
      }
      continueRender(handle);
    })();

    return () => {
      cancelled = true;
    };
  }, [handle, srcMs, width, height]);

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      <canvas ref={canvasRef} width={width} height={height} style={{ width, height }} />

      {/* The media elements exist only to be sampled; they are never seen. */}
      <video
        ref={videoRef}
        src={screenSrc}
        muted
        playsInline
        preload="auto"
        style={{ position: "absolute", opacity: 0, pointerEvents: "none", width: 1, height: 1 }}
      />
      {cameraSrc ? (
        <video
          ref={camRef}
          src={cameraSrc}
          muted
          playsInline
          preload="auto"
          style={{ position: "absolute", opacity: 0, pointerEvents: "none", width: 1, height: 1 }}
        />
      ) : null}

      {/* Sound. One Sequence per clip, so cuts and speed changes carry their
          own audio — including the sped-up clips the browser exporter has to
          drop, because Opus passthrough cannot be resampled. */}
      {tl.map((clip) => {
        const from = Math.round((clip.outStart / 1000) * fps);
        const durationInFrames = Math.max(1, Math.round((clip.outLen / 1000) * fps));
        return (
          <Sequence key={clip.id} from={from} durationInFrames={durationInFrames}>
            <Audio
              src={screenSrc}
              startFrom={Math.round((clip.srcStart / 1000) * fps)}
              endAt={Math.round((clip.srcEnd / 1000) * fps)}
              playbackRate={clip.speed || 1}
              volume={clip.volume == null ? 1 : clip.volume}
            />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
