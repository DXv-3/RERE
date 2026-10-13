import {
  buildResizeFilter,
  type PlatformShape,
  type ResizeFit,
  MEDIA_EDIT_MAX_OUTPUT_BYTES,
} from "./MediaEditFfmpeg.ts";
import { INPUT_GUARD_ARGS } from "./mediaFfmpeg.ts";

/** Audio readers are separate from the image/video allowlist; playlists remain forbidden. */
export const STUDIO_AUDIO_INPUT_ARGS = [
  "-format_whitelist",
  "mp3,wav,flac,ogg,mov",
  "-protocol_whitelist",
  "file",
] as const;

export function buildStudioArgs(input: {
  readonly scenes: ReadonlyArray<{
    readonly filePath: string;
    readonly image: boolean;
    readonly start: number;
    readonly durationSeconds: number;
    readonly hasAudio: boolean;
  }>;
  readonly shape: PlatformShape;
  readonly fit: ResizeFit;
  readonly captions: boolean;
  readonly audioPath?: string;
  readonly outputPath: string;
}): string[] {
  const args = ["-nostdin", "-v", "error", "-n", "-filter_complex_threads", "1"];
  const filters: string[] = [];
  const labels: string[] = [];
  const withAudio = input.audioPath !== undefined || input.scenes.some((scene) => scene.hasAudio);
  const total = input.scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0);
  input.scenes.forEach((scene, i) => {
    args.push(
      ...(scene.image ? ["-stream_loop", "-1"] : ["-ss", scene.start.toFixed(3)]),
      ...INPUT_GUARD_ARGS,
      "-t",
      scene.durationSeconds.toFixed(3),
      "-i",
      scene.filePath,
    );
    filters.push(
      `[${i}:v]${buildResizeFilter(input.shape, input.fit).replaceAll("[a]", `[bgsrc${i}]`).replaceAll("[b]", `[fgsrc${i}]`).replaceAll("[bg]", `[bg${i}]`).replaceAll("[fg]", `[fg${i}]`)},fps=30,format=yuv420p,trim=duration=${scene.durationSeconds},setpts=PTS-STARTPTS[v${i}]`,
    );
    labels.push(`[v${i}]`);
    if (withAudio) {
      filters.push(
        scene.hasAudio
          ? `[${i}:a]aresample=48000,aformat=channel_layouts=stereo,apad,atrim=duration=${scene.durationSeconds},asetpts=PTS-STARTPTS[a${i}]`
          : `anullsrc=r=48000:cl=stereo,atrim=duration=${scene.durationSeconds},asetpts=PTS-STARTPTS[a${i}]`,
      );
      labels.push(`[a${i}]`);
    }
  });
  filters.push(
    `${labels.join("")}concat=n=${input.scenes.length}:v=1:a=${withAudio ? 1 : 0}[picture]${withAudio ? "[sound]" : ""}`,
  );
  if (input.captions) filters.push("[picture]subtitles=filename=captions.ass[captioned]");
  if (input.audioPath !== undefined) {
    args.push(...STUDIO_AUDIO_INPUT_ARGS, "-i", input.audioPath);
    filters.push(
      `[${input.scenes.length}:a]aresample=48000,aformat=channel_layouts=stereo,apad,atrim=duration=${total},asetpts=PTS-STARTPTS[narration]`,
    );
    filters.push(
      "[sound][narration]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95:level=0[mixed]",
    );
  }
  args.push(
    "-filter_complex",
    filters.join(";"),
    "-map",
    input.captions ? "[captioned]" : "[picture]",
  );
  if (withAudio) args.push("-map", input.audioPath ? "[mixed]" : "[sound]");
  return [
    ...args,
    "-t",
    total.toFixed(3),
    "-c:v",
    "libx264",
    "-threads",
    "2",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-movflags",
    "+faststart",
    "-fs",
    String(MEDIA_EDIT_MAX_OUTPUT_BYTES),
    input.outputPath,
  ];
}
