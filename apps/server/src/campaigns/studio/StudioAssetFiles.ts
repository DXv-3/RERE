import { CampaignError, type StudioAsset } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../../config.ts";
import {
  parseThreadSegmentFromAttachmentId,
  PENDING_ATTACHMENT_THREAD_SEGMENT,
  resolveAttachmentPathById,
} from "../../attachmentStore.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";

const isCampaignError = Schema.is(CampaignError);
const failure = (message: string) => new CampaignError({ reason: "invalid", message });
const extensions = {
  image: new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif"]),
  video: new Set([".mp4", ".mov", ".webm", ".mkv", ".m4v"]),
  audio: new Set([".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"]),
};
type CopyInput = {
  readonly cwd: string;
  readonly kind: StudioAsset["kind"];
  readonly source:
    | { readonly attachmentId: string }
    | { readonly cwd: string; readonly file: string };
};
export class StudioAssetFiles extends Context.Service<
  StudioAssetFiles,
  {
    readonly copy: (input: CopyInput) => Effect.Effect<
      {
        readonly file: string;
        readonly discard: Effect.Effect<void>;
      },
      CampaignError
    >;
  }
>()("t3/campaigns/studio/StudioAssetFiles") {}
const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const paths = yield* WorkspacePaths.WorkspacePaths;
  const config = yield* ServerConfig.ServerConfig;
  const copy: StudioAssetFiles["Service"]["copy"] = (input) =>
    Effect.gen(function* () {
      const root = yield* fs.realPath(yield* paths.normalizeWorkspaceRoot(input.cwd));
      let source: string;
      let sourceRoot: string;
      if ("attachmentId" in input.source) {
        if (
          parseThreadSegmentFromAttachmentId(input.source.attachmentId) !==
          PENDING_ATTACHMENT_THREAD_SEGMENT
        )
          return yield* failure("Choose a newly uploaded attachment.");
        const resolved = resolveAttachmentPathById({
          attachmentsDir: config.attachmentsDir,
          attachmentId: input.source.attachmentId,
        });
        if (!resolved)
          return yield* failure("This upload is unavailable or expired. Upload the file again.");
        sourceRoot = yield* fs.realPath(config.attachmentsDir);
        source = yield* fs.realPath(resolved);
      } else {
        sourceRoot = yield* fs.realPath(yield* paths.normalizeWorkspaceRoot(input.source.cwd));
        const resolved = yield* paths.resolveRelativePathWithinRoot({
          workspaceRoot: sourceRoot,
          relativePath: input.source.file,
        });
        source = yield* fs.realPath(resolved.absolutePath);
      }
      const relative = path.relative(sourceRoot, source);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
        return yield* failure("The source asset must stay inside its workspace.");
      const stat = yield* fs.stat(source);
      if (stat.type !== "File" || stat.size <= 0n || stat.size > 100n * 1024n * 1024n)
        return yield* failure("Choose a media file up to 100 MB.");
      const extension = path.extname(source).toLowerCase();
      if (!extensions[input.kind].has(extension))
        return yield* failure("The file extension does not match the selected media type.");
      const directory = yield* fs.makeTempDirectory({ directory: root, prefix: "studio-import-" });
      const discard = fs.remove(directory, { recursive: true }).pipe(Effect.ignore);
      const target = path.join(directory, `asset${extension}`);
      yield* fs.copyFile(source, target).pipe(Effect.onError(() => discard));
      return { file: path.relative(root, target), discard };
    }).pipe(
      Effect.mapError((error) =>
        isCampaignError(error)
          ? error
          : new CampaignError({
              reason: "storage",
              message: "Could not copy this asset. Check the upload and workspace access.",
            }),
      ),
    );
  return StudioAssetFiles.of({ copy });
});
export const layer = Layer.effect(StudioAssetFiles, make);
