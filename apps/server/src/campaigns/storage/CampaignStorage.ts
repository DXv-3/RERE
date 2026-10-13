import {
  CampaignError,
  type CampaignConnectionTestResult,
  type CampaignPost,
  type CampaignStorageSetInput,
  type CampaignStorageState,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ServerSettingsModule from "../../serverSettings.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import * as CampaignStore from "../CampaignStore.ts";
import {
  CAMPAIGN_MEDIA_ROUTE_PREFIX,
  CampaignMediaLinks,
  isServerMediaLink,
  STORAGE_TEST_POST_ID,
} from "./CampaignMediaLinks.ts";
import {
  contentTypeFor,
  makeS3Uploader,
  normalizeHttpsOrigin,
  normalizePublicBaseUrl,
  objectKey,
  publicUrlFor,
  safeFileName,
  slugify,
  STORAGE_MAX_FILE_BYTES,
  type StorageCredentials,
  type StorageFailure,
  type StorageTarget,
} from "./S3Uploader.ts";

/** The two keys. Never in settings.json, never in a log, never sent to a client. */
export const CAMPAIGN_STORAGE_ACCESS_KEY_SECRET = "workbench-campaign-storage-access-key";
export const CAMPAIGN_STORAGE_SECRET_KEY_SECRET = "workbench-campaign-storage-secret-key";
const KEY_MAX_LENGTH = 512;
const TEST_PREFIX_DIRECTORY = ".codewrench-storage-test";
/** A 1 by 1 PNG: what the server serves to itself to prove its public address works. */
const TEST_PICTURE = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
  ),
  (character) => character.charCodeAt(0),
);

const fail = (reason: CampaignError["reason"], message: string) =>
  new CampaignError({ reason, message });

/** The prefix as stored: no leading slash, no climbing, and a trailing slash when not empty. */
function normalizePrefix(value: string): string | null {
  const trimmed = value.trim().replace(/^\/+/, "");
  if (trimmed === "") return "";
  if (trimmed.length > 200 || !/^[A-Za-z0-9._/-]+$/.test(trimmed)) return null;
  if (trimmed.split("/").includes("..")) return null;
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

/**
 * Public file links, in one of two ways. In `s3` mode files are uploaded to a bucket: the settings
 * (address, bucket, public address) live in server settings and the two keys in the secret store,
 * write-only. In `server` mode this server hands the files out itself at its own public address
 * (`CampaignMediaLinks`). Nothing is uploaded or shared unless the owner has switched a mode on.
 */
export class CampaignStorage extends Context.Service<
  CampaignStorage,
  {
    readonly get: Effect.Effect<CampaignStorageState, CampaignError>;
    readonly set: (
      input: CampaignStorageSetInput,
    ) => Effect.Effect<CampaignStorageState, CampaignError>;
    /**
     * Uploads a tiny file, checks its public address, and deletes it. Works while the mode is off.
     * In `server` mode it serves a tiny file to itself through the public address instead.
     */
    readonly test: Effect.Effect<CampaignConnectionTestResult>;
    /**
     * A person's request: upload every file of the post that has no public address yet, then say
     * so on the post. Fails with a plain reason when storage is off or an upload fails.
     */
    readonly uploadPostMedia: (postId: string) => Effect.Effect<CampaignPost, CampaignError>;
    /**
     * For the publisher: with storage on and local files that have no link, uploads them and
     * returns the post with its links. With storage off, or nothing missing, returns the post as it is.
     */
    readonly ensurePublicMedia: (post: CampaignPost) => Effect.Effect<CampaignPost, CampaignError>;
    /**
     * Stops this server sharing a post's files: their links stop working at once and are taken off
     * the post, so sending it later makes new ones.
     */
    readonly revokePostMedia: (postId: string) => Effect.Effect<CampaignPost, CampaignError>;
  }
>()("t3/campaigns/storage/CampaignStorage") {}

const make = Effect.gen(function* () {
  const settings = yield* ServerSettingsModule.ServerSettingsService;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const http = yield* HttpClient.HttpClient;
  const store = yield* CampaignStore.CampaignStore;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const links = yield* CampaignMediaLinks;
  const uploader = makeS3Uploader({ http, fileSystem });

  const readSettings = settings.getSettings.pipe(
    Effect.mapError(() => fail("storage", "The server settings could not be read.")),
  );

  const readSecret = (name: string) =>
    secrets.get(name).pipe(
      Effect.map((value) => {
        if (Option.isNone(value)) return null;
        const text = new TextDecoder().decode(value.value).trim();
        return text === "" ? null : text;
      }),
      Effect.orElseSucceed(() => null),
    );

  const readCredentials = Effect.gen(function* () {
    const accessKeyId = yield* readSecret(CAMPAIGN_STORAGE_ACCESS_KEY_SECRET);
    const secretAccessKey = yield* readSecret(CAMPAIGN_STORAGE_SECRET_KEY_SECRET);
    return accessKeyId === null || secretAccessKey === null
      ? null
      : ({ accessKeyId, secretAccessKey } satisfies StorageCredentials);
  });

  const get: CampaignStorage["Service"]["get"] = Effect.gen(function* () {
    const current = yield* readSettings;
    return {
      mode: current.campaignStorage,
      endpoint: current.campaignStorageEndpoint,
      region: current.campaignStorageRegion,
      bucket: current.campaignStorageBucket,
      publicBaseUrl: current.campaignStoragePublicBaseUrl,
      prefix: current.campaignStoragePrefix,
      hasCredentials: (yield* readCredentials) !== null,
    } satisfies CampaignStorageState;
  });

  /** What an upload needs, or the reason it cannot go ahead. */
  const configured = (state: CampaignStorageState, credentials: StorageCredentials | null) => {
    const missing = [
      state.endpoint === "" ? "the storage address" : null,
      state.bucket === "" ? "the bucket name" : null,
      state.publicBaseUrl === "" ? "the public address" : null,
      credentials === null ? "the access key and secret" : null,
    ].filter((item): item is string => item !== null);
    if (missing.length > 0 || credentials === null) {
      return { error: `Cloud storage is not set up yet. Missing: ${missing.join(", ")}.` } as const;
    }
    const target: StorageTarget = {
      endpoint: state.endpoint,
      region: state.region === "" ? "auto" : state.region,
      bucket: state.bucket,
      publicBaseUrl: state.publicBaseUrl,
      prefix: state.prefix,
    };
    return { target, credentials } as const;
  };

  /** Every link this server made, gone, and taken off the posts that listed them. */
  const revokeEverything = Effect.gen(function* () {
    const postIds = yield* links.revokeAll;
    for (const postId of postIds) {
      yield* store
        .dropUploadedMedia({ postId, matches: isServerMediaLink })
        .pipe(Effect.catchTag("CampaignError", () => Effect.void));
    }
  });

  const set: CampaignStorage["Service"]["set"] = (input) =>
    Effect.gen(function* () {
      const current = yield* get;
      const endpoint =
        input.endpoint === undefined
          ? current.endpoint
          : input.endpoint.trim() === ""
            ? ""
            : normalizeHttpsOrigin(input.endpoint);
      if (endpoint === null) {
        return yield* fail(
          "invalid",
          "The storage address must be an https address with nothing after it, like https://<account>.r2.cloudflarestorage.com.",
        );
      }
      const publicBaseUrl =
        input.publicBaseUrl === undefined
          ? current.publicBaseUrl
          : input.publicBaseUrl.trim() === ""
            ? ""
            : normalizePublicBaseUrl(input.publicBaseUrl);
      if (publicBaseUrl === null) {
        return yield* fail(
          "invalid",
          "The public address must be an https address with no login or query.",
        );
      }
      const prefix = input.prefix === undefined ? current.prefix : normalizePrefix(input.prefix);
      if (prefix === null) {
        return yield* fail(
          "invalid",
          "The folder prefix can only use letters, digits, dots, dashes, underscores and slashes.",
        );
      }
      const region = input.region === undefined ? current.region : input.region.trim();
      if (!/^[A-Za-z0-9-]{0,32}$/.test(region)) {
        return yield* fail("invalid", "The region can only use letters, digits and dashes.");
      }
      const bucket = input.bucket === undefined ? current.bucket : input.bucket.trim();
      if (bucket !== "" && !/^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/.test(bucket)) {
        return yield* fail(
          "invalid",
          "The bucket name is 3 to 63 lower-case letters, digits, dots, dashes or underscores.",
        );
      }
      for (const [label, value] of [
        ["access key", input.accessKeyId],
        ["secret", input.secretAccessKey],
      ] as const) {
        if (value !== undefined && value !== null) {
          const text = Redacted.value(value).trim();
          if (text === "" || text.length > KEY_MAX_LENGTH || /\s/.test(text)) {
            return yield* fail(
              "invalid",
              `The ${label} is empty, has spaces in it, or is too long.`,
            );
          }
        }
      }

      const mode = input.mode ?? current.mode;
      if (mode === "server" && publicBaseUrl === "") {
        return yield* fail(
          "invalid",
          "Sharing from this server cannot be switched on yet. Missing: the public address.",
        );
      }
      if (mode === "s3") {
        const accessAfter =
          input.accessKeyId === undefined
            ? (yield* readSecret(CAMPAIGN_STORAGE_ACCESS_KEY_SECRET)) !== null
            : input.accessKeyId !== null;
        const secretAfter =
          input.secretAccessKey === undefined
            ? (yield* readSecret(CAMPAIGN_STORAGE_SECRET_KEY_SECRET)) !== null
            : input.secretAccessKey !== null;
        const hasKeys = accessAfter && secretAfter;
        const missing = [
          endpoint === "" ? "the storage address" : null,
          bucket === "" ? "the bucket name" : null,
          publicBaseUrl === "" ? "the public address" : null,
          hasKeys ? null : "the access key and secret",
        ].filter((item): item is string => item !== null);
        if (missing.length > 0) {
          return yield* fail(
            "invalid",
            `Cloud storage cannot be switched on yet. Missing: ${missing.join(", ")}.`,
          );
        }
      }

      for (const [name, value] of [
        [CAMPAIGN_STORAGE_ACCESS_KEY_SECRET, input.accessKeyId],
        [CAMPAIGN_STORAGE_SECRET_KEY_SECRET, input.secretAccessKey],
      ] as const) {
        if (value === undefined) continue;
        yield* (
          value === null
            ? secrets.remove(name)
            : secrets.set(name, new TextEncoder().encode(Redacted.value(value).trim()))
        ).pipe(Effect.mapError(() => fail("storage", "The storage key could not be saved.")));
      }
      yield* settings
        .updateSettings({
          campaignStorage: mode,
          campaignStorageEndpoint: endpoint,
          campaignStorageRegion: region === "" ? "auto" : region,
          campaignStorageBucket: bucket,
          campaignStoragePublicBaseUrl: publicBaseUrl,
          campaignStoragePrefix: prefix,
        })
        .pipe(Effect.mapError(() => fail("storage", "The settings could not be saved.")));
      // Links made by this server are tied to the address and the mode they were made under.
      if (
        current.mode === "server" &&
        (mode !== "server" || publicBaseUrl !== current.publicBaseUrl)
      ) {
        yield* revokeEverything;
      }
      return yield* get;
    });

  /** Serves a tiny picture from this server to itself, through the public address. */
  const testServer = (state: CampaignStorageState) =>
    Effect.gen(function* () {
      const folder = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-storage-test-" });
      const realFolder = yield* fileSystem.realPath(folder);
      const fileName = "storage-test.png";
      const filePath = path.join(realFolder, fileName);
      yield* fileSystem.writeFile(filePath, TEST_PICTURE);
      const token = yield* Effect.acquireRelease(
        links.register({
          postId: STORAGE_TEST_POST_ID,
          relativePath: fileName,
          realPath: filePath,
          rootPath: realFolder,
          contentType: "image/png",
          sizeBytes: TEST_PICTURE.byteLength,
          fileName,
        }),
        () => links.revokePost(STORAGE_TEST_POST_ID).pipe(Effect.ignore),
      );
      const url = `${state.publicBaseUrl}${CAMPAIGN_MEDIA_ROUTE_PREFIX}/${token}/${fileName}`;
      const answer = yield* http.execute(HttpClientRequest.get(url)).pipe(
        Effect.timeout(Duration.seconds(15)),
        Effect.flatMap((response) =>
          Effect.map(response.arrayBuffer, (body) => ({
            status: response.status,
            body: new Uint8Array(body),
          })),
        ),
        Effect.result,
      );
      if (answer._tag === "Failure") {
        return {
          ok: false,
          reason: `This server could not reach itself at ${state.publicBaseUrl}. Check that the address is right and that this computer can be reached from the internet at it. A platform fetching a file would not be able to reach it either.`,
        } as CampaignConnectionTestResult;
      }
      if (answer.success.status !== 200) {
        return {
          ok: false,
          reason: `The public address answered HTTP ${answer.success.status} instead of the test file. It may point at a different computer, or this server's own address may not be passed through to it.`,
        } as CampaignConnectionTestResult;
      }
      const same =
        answer.success.body.byteLength === TEST_PICTURE.byteLength &&
        answer.success.body.every((byte, index) => byte === TEST_PICTURE[index]);
      return same
        ? ({ ok: true } as CampaignConnectionTestResult)
        : ({
            ok: false,
            reason:
              "The public address answered, but the file that came back was not the test file. Check that the address points at this computer.",
          } as CampaignConnectionTestResult);
    }).pipe(
      Effect.scoped,
      Effect.catch(() =>
        Effect.succeed({
          ok: false,
          reason: "The test file could not be made on this computer.",
        } as CampaignConnectionTestResult),
      ),
    );

  const test: CampaignStorage["Service"]["test"] = Effect.gen(function* () {
    const state = yield* get.pipe(Effect.orDie);
    if (state.mode === "server") return yield* testServer(state);
    const ready = configured(state, yield* readCredentials);
    if ("error" in ready) return { ok: false, reason: ready.error } as CampaignConnectionTestResult;
    const token = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    const key = `${state.prefix}${TEST_PREFIX_DIRECTORY}/${token}.txt`;
    const uploaded = yield* uploader
      .putBytes({
        ...ready,
        key,
        bytes: new TextEncoder().encode("Storage test from CodeWrench. You can delete this file."),
        contentType: "text/plain",
      })
      .pipe(Effect.result);
    if (uploaded._tag === "Failure") {
      return { ok: false, reason: uploaded.failure.message } as CampaignConnectionTestResult;
    }
    const status = yield* uploader
      .publicStatus(publicUrlFor(ready.target, key))
      .pipe(Effect.result);
    const removed = yield* uploader.remove({ ...ready, key }).pipe(Effect.result);
    if (status._tag === "Failure") {
      return { ok: false, reason: status.failure.message } as CampaignConnectionTestResult;
    }
    if (status.success !== 200) {
      return {
        ok: false,
        reason: `Uploading works, but the public address answered HTTP ${status.success} for the test file. Check the public address and that the bucket's public access is turned on.`,
      } as CampaignConnectionTestResult;
    }
    return removed._tag === "Failure"
      ? ({
          ok: true,
          reason: `Uploading and the public address work. The test file could not be deleted: ${removed.failure.message}`,
        } as CampaignConnectionTestResult)
      : ({ ok: true } as CampaignConnectionTestResult);
  });

  /** The folder a post's relative file paths are in: its source thread's folder. */
  const folderOf = (post: CampaignPost) =>
    Effect.gen(function* () {
      if (post.sourceThreadId === undefined) return null;
      const shell = yield* threads.getThreadShell(post.sourceThreadId as ThreadId);
      if (shell === null) return null;
      const project = yield* projects.getById(shell.projectId);
      return Option.isSome(project) ? (shell.worktreePath ?? project.value.workspaceRoot) : null;
    }).pipe(Effect.orElseSucceed(() => null));

  /** A file that is inside the folder, a type we upload, and not too big; or why it is not. */
  const resolveUpload = (root: string, relativePath: string) =>
    Effect.gen(function* () {
      const outside = `${relativePath} is not inside the thread's folder.`;
      const normalizedRoot = yield* workspacePaths
        .normalizeWorkspaceRoot(root)
        .pipe(Effect.mapError(() => fail("unavailable", "The thread's folder is not available.")));
      const target = yield* workspacePaths
        .resolveRelativePathWithinRoot({ workspaceRoot: normalizedRoot, relativePath })
        .pipe(Effect.mapError(() => fail("invalid", outside)));
      const realRoot = yield* fileSystem
        .realPath(normalizedRoot)
        .pipe(Effect.mapError(() => fail("unavailable", "The thread's folder is not available.")));
      const realPath = yield* fileSystem
        .realPath(target.absolutePath)
        .pipe(Effect.mapError(() => fail("not_found", `${relativePath} was not found.`)));
      const relative = path.relative(realRoot, realPath);
      if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
        return yield* fail("invalid", outside);
      }
      const contentType = contentTypeFor(path.extname(realPath));
      // Only pictures, video and sound. A file anyone can open by its link must not be a document.
      if (contentType === null || contentType === "text/plain") {
        return yield* fail(
          "invalid",
          `${relativePath} is not a picture, video or audio file, so it is not uploaded.`,
        );
      }
      const info = yield* fileSystem
        .stat(realPath)
        .pipe(Effect.mapError(() => fail("not_found", `${relativePath} was not found.`)));
      if (info.type !== "File") return yield* fail("not_found", `${relativePath} is not a file.`);
      if (Number(info.size) > STORAGE_MAX_FILE_BYTES) {
        return yield* fail(
          "invalid",
          `${relativePath} is over 2 GB, which is more than will be uploaded.`,
        );
      }
      return { realPath, realRoot, contentType, sizeBytes: Number(info.size) };
    });

  /** File names for the post's files, in order, made different from each other. */
  const namesFor = (paths: ReadonlyArray<string>) => {
    const used = new Set<string>();
    return paths.map((filePath, index) => {
      let name = safeFileName(path.basename(filePath));
      if (used.has(name)) name = `${index + 1}-${name}`;
      used.add(name);
      return name;
    });
  };

  const upload = (post: CampaignPost, onlyWhenMissingLinks: boolean) =>
    Effect.gen(function* () {
      const state = yield* get;
      if (state.mode === "off") {
        return onlyWhenMissingLinks
          ? post
          : yield* fail(
              "unavailable",
              "Cloud storage is off. Switch it on in the campaign settings first; files uploaded there are public to anyone with the link.",
            );
      }
      if (post.mediaPaths.length === 0) return post;
      if (onlyWhenMissingLinks && post.mediaUrls.length >= post.mediaPaths.length) return post;
      const ready = state.mode === "s3" ? configured(state, yield* readCredentials) : null;
      if (ready !== null && "error" in ready) return yield* fail("unavailable", ready.error);
      if (state.mode === "server" && state.publicBaseUrl === "") {
        return yield* fail("unavailable", "Sharing from this server needs a public address first.");
      }

      const names = namesFor(post.mediaPaths);
      const root = yield* folderOf(post);
      const { client, campaign } = yield* store.contextOf(post);
      const clientSlug = slugify(client.name, client.id);
      const campaignSlug = slugify(campaign.name, campaign.id);

      let latest = post;
      let recorded = false;
      for (const [index, relativePath] of post.mediaPaths.entries()) {
        const already = post.uploadedMedia[relativePath];
        if (already !== undefined) continue;
        if (root === null) {
          return yield* fail(
            "unavailable",
            "This post has no thread folder to read its files from, so they cannot be shared. Add a public link instead.",
          );
        }
        const file = yield* resolveUpload(root, relativePath);
        const fileName = names[index] ?? "file";
        let url: string;
        if (ready === null) {
          const token = yield* links.register({
            postId: post.id,
            relativePath,
            realPath: file.realPath,
            rootPath: file.realRoot,
            contentType: file.contentType,
            sizeBytes: file.sizeBytes,
            fileName,
          });
          url = `${state.publicBaseUrl}${CAMPAIGN_MEDIA_ROUTE_PREFIX}/${token}/${fileName}`;
        } else {
          const key = objectKey({
            prefix: ready.target.prefix,
            clientSlug,
            campaignSlug,
            postId: post.id,
            fileName,
          });
          yield* uploader
            .putFile({
              ...ready,
              key,
              filePath: file.realPath,
              contentType: file.contentType,
            })
            .pipe(
              Effect.mapError((error: StorageFailure) =>
                fail("unavailable", `${relativePath} was not uploaded: ${error.message}`),
              ),
            );
          url = publicUrlFor(ready.target, key);
        }
        // Recorded one file at a time, so a later failure never makes this one upload twice.
        latest = yield* store.recordUploadedMedia({
          postId: post.id,
          uploaded: { [relativePath]: url },
        });
        recorded = true;
      }
      if (!recorded && Object.keys(post.uploadedMedia).length > 0) {
        // Everything was uploaded before; make sure its links are on the post.
        latest = yield* store.recordUploadedMedia({
          postId: post.id,
          uploaded: post.uploadedMedia,
        });
      }
      return latest;
    });

  const uploadPostMedia: CampaignStorage["Service"]["uploadPostMedia"] = (postId) =>
    Effect.gen(function* () {
      const post = yield* store.getPost(postId);
      if (post.status === "publishing") {
        return yield* fail("conflict", "This post is being published right now.");
      }
      if (post.mediaPaths.length === 0) {
        return yield* fail("invalid", "This post has no files to upload.");
      }
      return yield* upload(post, false);
    });

  const ensurePublicMedia: CampaignStorage["Service"]["ensurePublicMedia"] = (post) =>
    upload(post, true);

  const revokePostMedia: CampaignStorage["Service"]["revokePostMedia"] = (postId) =>
    Effect.gen(function* () {
      const post = yield* store.getPost(postId);
      if (post.status === "publishing") {
        return yield* fail("conflict", "This post is being published right now.");
      }
      yield* links.revokePost(postId);
      return yield* store.dropUploadedMedia({ postId, matches: isServerMediaLink });
    });

  return CampaignStorage.of({
    get,
    set,
    test,
    uploadPostMedia,
    ensurePublicMedia,
    revokePostMedia,
  });
});

export const layer = Layer.effect(CampaignStorage, make);
