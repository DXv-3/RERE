import { captionFor } from "@t3tools/shared/campaignRules";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type { CampaignPost } from "@t3tools/contracts";

import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import type { PublishOutcome, PublishRequest, PublishingConnector } from "./PublishingConnector.ts";

const NO_FOLDER =
  "This post has no project folder to export into. Start it from a thread, or set an export folder.";

/** A name that is safe as one folder segment: lower case letters, digits and dashes. */
export function exportSlug(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug === "" ? "untitled" : slug;
}

/** `campaigns/<client>/<campaign>/export/<post-id>`, relative to the folder it is written in. */
export const exportFolderFor = (input: {
  readonly clientName: string;
  readonly campaignName: string;
  readonly postId: string;
}) =>
  `campaigns/${exportSlug(input.clientName)}/${exportSlug(input.campaignName)}/export/${exportSlug(input.postId)}`;

const encodeSummary = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const failure = (error: string): PublishOutcome => ({ success: false, error });

/**
 * The export connector for a person with no publishing service: an approved post becomes a
 * folder holding its media, a caption file per platform and a `post.json`, ready to post by hand.
 * It writes only inside the folder it is given, resolved the way the media service resolves a file.
 */
export const makeExportConnector = (deps: {
  /** The project folder of the post's source thread, or the configured export folder. */
  readonly folderFor: (post: CampaignPost) => Effect.Effect<string | null>;
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const workspacePaths = yield* WorkspacePaths.WorkspacePaths;

    /** The real path of `relativePath` under `realRoot`, or null when it escapes or is missing. */
    const resolveInside = (root: string, realRoot: string, relativePath: string) =>
      Effect.gen(function* () {
        const target = yield* workspacePaths.resolveRelativePathWithinRoot({
          workspaceRoot: root,
          relativePath,
        });
        const real = yield* fileSystem.realPath(target.absolutePath);
        const relative = path.relative(realRoot, real);
        if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
          return yield* Effect.fail("outside" as const);
        }
        return real;
      });

    const publish: PublishingConnector["publish"] = (request: PublishRequest) =>
      Effect.gen(function* () {
        const { post, platform, client, campaign } = request;
        const folder = yield* deps.folderFor(post);
        if (folder === null) return failure(NO_FOLDER);
        const root = yield* workspacePaths
          .normalizeWorkspaceRoot(folder)
          .pipe(Effect.mapError(() => "The export folder is not available."));
        const realRoot = yield* fileSystem
          .realPath(root)
          .pipe(Effect.mapError(() => "The export folder is not available."));

        const relativeOut = exportFolderFor({
          clientName: client.name,
          campaignName: campaign.name,
          postId: post.id,
        });
        const target = yield* workspacePaths
          .resolveRelativePathWithinRoot({ workspaceRoot: root, relativePath: relativeOut })
          .pipe(Effect.mapError(() => "The export folder is outside the project."));
        yield* fileSystem
          .makeDirectory(target.absolutePath, { recursive: true })
          .pipe(Effect.mapError(() => "Could not create the export folder."));
        // A symlinked `campaigns` folder must not lead the export out of the project.
        const realOut = yield* fileSystem
          .realPath(target.absolutePath)
          .pipe(Effect.mapError(() => "Could not create the export folder."));
        const outRelative = path.relative(realRoot, realOut);
        if (outRelative.startsWith("..") || path.isAbsolute(outRelative)) {
          return failure("The export folder is outside the project.");
        }

        const copied: string[] = [];
        for (const [index, mediaPath] of post.mediaPaths.entries()) {
          const source = yield* resolveInside(root, realRoot, mediaPath).pipe(
            Effect.mapError(() => `${mediaPath} was not found inside the project folder.`),
          );
          const info = yield* fileSystem
            .stat(source)
            .pipe(Effect.mapError(() => `${mediaPath} could not be read.`));
          if (info.type !== "File") return failure(`${mediaPath} is not a file.`);
          const name = `${String(index + 1).padStart(2, "0")}-${path.basename(source)}`;
          yield* fileSystem
            .copyFile(source, path.join(realOut, name))
            .pipe(Effect.mapError(() => `${mediaPath} could not be copied.`));
          copied.push(name);
        }

        const captions = Object.fromEntries(
          post.platforms.map((each) => [each, captionFor(post, each)]),
        );
        yield* fileSystem
          .writeFileString(
            path.join(realOut, `caption-${platform}.txt`),
            `${captionFor(post, platform)}\n`,
          )
          .pipe(Effect.mapError(() => "Could not write the caption."));
        const exportedAt = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
        const summary = {
          id: post.id,
          client: client.name,
          campaign: campaign.name,
          platforms: post.platforms,
          captions,
          title: post.title ?? null,
          destinationUrl: post.destinationUrl ?? null,
          scheduledAt: post.scheduledAt ?? null,
          mediaFiles: copied,
          mediaUrls: post.mediaUrls,
          exportedAt,
        };
        yield* fileSystem
          .writeFileString(path.join(realOut, "post.json"), `${encodeSummary(summary)}\n`)
          .pipe(Effect.mapError(() => "Could not write post.json."));
        return { success: true, link: realOut } satisfies PublishOutcome;
      }).pipe(Effect.catch((error: string) => Effect.succeed(failure(error))));

    const connector: PublishingConnector = {
      kind: "export",
      publish,
      // An export has no clock of its own: the folder is ready now and the person posts it.
      schedule: (request) => publish(request),
      autopostState: () => Effect.succeed({ kind: "known", paused: false, masterEnabled: true }),
      test: () => Effect.succeed({ ok: true }),
    };
    return connector;
  });
