import * as NodeCrypto from "node:crypto";

import {
  CAMPAIGN_MEDIA_ROUTE_PREFIX,
  CampaignError,
  isCampaignServerMediaLink,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { openMediaFile, type OpenMediaFile } from "../../assets/MediaFile.ts";
import * as ServerSettingsModule from "../../serverSettings.ts";
import * as CampaignStore from "../CampaignStore.ts";
import { contentTypeFor } from "./S3Uploader.ts";

/** The post id of the tiny file `storage.test` serves to itself. It has no post to look up. */
export const STORAGE_TEST_POST_ID = "storage-test";
/** The secret part of a link: 32 random bytes, URL-safe base64. */
const MEDIA_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const MEDIA_RATE_LIMIT = 120;
/** Requests a minute for everyone arriving through a proxy or tunnel, counted together. */
export const MEDIA_PROXY_RATE_LIMIT = 1_200;

/** A loopback or private address is a proxy in front of the server, not a visitor. */
export function isCountableAddress(address: string | null): address is string {
  if (address === null) return false;
  const host = address.replace(/^::ffff:/, "");
  return !(
    host === "::1" ||
    host.startsWith("127.") ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^f[cd]/i.test(host) ||
    /^fe80:/i.test(host)
  );
}
const RATE_WINDOW_MS = 60_000;
const RATE_TABLE_LIMIT = 5_000;

export { CAMPAIGN_MEDIA_ROUTE_PREFIX, isCampaignServerMediaLink as isServerMediaLink };

const hashToken = (token: string) => NodeCrypto.createHash("sha256").update(token).digest("hex");

const fail = (message: string) => new CampaignError({ reason: "storage", message });

export interface RegisterMediaLink {
  readonly postId: string;
  /** The file's path as the post lists it, relative to the thread's folder. */
  readonly relativePath: string;
  readonly realPath: string;
  /** The thread's folder, as it was when the file was registered. */
  readonly rootPath: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  /** Only for show: it is in the address and in `Content-Disposition`, and never opens anything. */
  readonly fileName: string;
}

export type MediaLinkOutcome =
  | { readonly _tag: "NotFound" }
  | { readonly _tag: "Limited" }
  | {
      readonly _tag: "Ready";
      readonly file: OpenMediaFile;
      readonly path: string;
      readonly contentType: string;
      readonly fileName: string;
    };

interface LinkRow {
  readonly token_hash: string;
  readonly post_id: string;
  readonly relative_path: string;
  readonly real_path: string;
  readonly root_path: string;
  readonly content_type: string;
  readonly file_name: string;
}

/**
 * The links this server serves files at. A link is a random secret kept only as a hash; a request
 * is answered only while storage is in `server` mode, the post still lists the file with that
 * link, and the file is still the same plain media file inside the folder it was registered under.
 */
export class CampaignMediaLinks extends Context.Service<
  CampaignMediaLinks,
  {
    /** Makes the one link for this file of this post, replacing an earlier one, and returns its secret. */
    readonly register: (input: RegisterMediaLink) => Effect.Effect<string, CampaignError>;
    /** Deletes every link of a post. */
    readonly revokePost: (postId: string) => Effect.Effect<void, CampaignError>;
    /** Deletes every link there is and returns the ids of the posts that had one. */
    readonly revokeAll: Effect.Effect<ReadonlyArray<string>, CampaignError>;
    /**
     * Opens the file behind a link for one request, or says why not. Everything that is wrong, from
     * a made-up secret to a swapped file, is the same `NotFound`; `Limited` is a request over the rate limit.
     */
    readonly open: (input: {
      readonly token: string;
      readonly remoteAddress: string | null;
    }) => Effect.Effect<MediaLinkOutcome, never, Scope.Scope>;
  }
>()("t3/campaigns/storage/CampaignMediaLinks") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const settings = yield* ServerSettingsModule.ServerSettingsService;
  const store = yield* CampaignStore.CampaignStore;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const db = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.mapError(() => fail("The shared file links could not be read or saved.")));

  const register: CampaignMediaLinks["Service"]["register"] = (input) =>
    Effect.gen(function* () {
      const token = NodeCrypto.randomBytes(32).toString("base64url");
      const at = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
      yield* db(
        sql`INSERT INTO workbench_campaign_media_links
          (token_hash, post_id, relative_path, real_path, root_path, content_type, size_bytes, file_name, created_at)
          VALUES (${hashToken(token)}, ${input.postId}, ${input.relativePath}, ${input.realPath}, ${input.rootPath},
            ${input.contentType}, ${input.sizeBytes}, ${input.fileName}, ${at})
          ON CONFLICT (post_id, relative_path) DO UPDATE SET
            token_hash = excluded.token_hash, real_path = excluded.real_path, root_path = excluded.root_path,
            content_type = excluded.content_type, size_bytes = excluded.size_bytes,
            file_name = excluded.file_name, created_at = excluded.created_at`,
      );
      return token;
    });

  const revokePost: CampaignMediaLinks["Service"]["revokePost"] = (postId) =>
    db(sql`DELETE FROM workbench_campaign_media_links WHERE post_id = ${postId}`).pipe(
      Effect.asVoid,
    );

  const revokeAll: CampaignMediaLinks["Service"]["revokeAll"] = Effect.gen(function* () {
    const rows = yield* db(
      sql<{
        readonly post_id: string;
      }>`SELECT DISTINCT post_id FROM workbench_campaign_media_links`,
    );
    yield* db(sql`DELETE FROM workbench_campaign_media_links`);
    return rows.map((row) => row.post_id).filter((id) => id !== STORAGE_TEST_POST_ID);
  });

  // Requests in the last minute, per address and per link. Memory only: a restart forgets them.
  const windows = new Map<string, { start: number; count: number }>();
  const admit = (key: string, at: number, limit = MEDIA_RATE_LIMIT) => {
    if (windows.size > RATE_TABLE_LIMIT) {
      for (const [name, entry] of windows) {
        if (at - entry.start >= RATE_WINDOW_MS) windows.delete(name);
      }
    }
    const entry = windows.get(key);
    if (entry === undefined || at - entry.start >= RATE_WINDOW_MS) {
      windows.set(key, { start: at, count: 1 });
      return true;
    }
    entry.count += 1;
    return entry.count <= limit;
  };

  const notFound = { _tag: "NotFound" } as const;

  /** The row for this secret if the post still lists the file under exactly this link. */
  const liveRow = (token: string) =>
    Effect.gen(function* () {
      const mode = (yield* settings.getSettings).campaignStorage;
      if (mode !== "server") return null;
      const row = (yield* sql<LinkRow>`
        SELECT * FROM workbench_campaign_media_links WHERE token_hash = ${hashToken(token)}`)[0];
      if (row === undefined) return null;
      if (row.post_id === STORAGE_TEST_POST_ID) return row;
      const post = yield* store.getPost(row.post_id).pipe(Effect.orElseSucceed(() => null));
      if (post === null) {
        yield* sql`DELETE FROM workbench_campaign_media_links WHERE post_id = ${row.post_id}`;
        return null;
      }
      const listed = post.uploadedMedia[row.relative_path];
      return post.status !== "rejected" &&
        post.mediaPaths.includes(row.relative_path) &&
        listed?.includes(`${CAMPAIGN_MEDIA_ROUTE_PREFIX}/${token}/`) === true
        ? row
        : null;
    });

  const open: CampaignMediaLinks["Service"]["open"] = ({ token, remoteAddress }) =>
    Effect.gen(function* () {
      const at = yield* Clock.currentTimeMillis;
      // Behind a tunnel or reverse proxy every visitor arrives from the proxy's own address, so
      // that address gets a far higher allowance than a single real visitor does.
      const addressAdmitted = isCountableAddress(remoteAddress)
        ? admit(`address:${remoteAddress}`, at)
        : admit("address:proxy", at, MEDIA_PROXY_RATE_LIMIT);
      if (!addressAdmitted) return { _tag: "Limited" } as const;
      if (!MEDIA_TOKEN_PATTERN.test(token)) return notFound;
      if (!admit(`link:${hashToken(token)}`, at)) return { _tag: "Limited" } as const;
      const row = yield* liveRow(token);
      if (row === null) return notFound;

      // Checked on every request, not only when the link was made: the file may have been moved,
      // replaced by a link to somewhere else, or the folder may have been swapped since.
      const contentType = contentTypeFor(path.extname(row.real_path));
      if (
        contentType === null ||
        contentType === "text/plain" ||
        contentType !== row.content_type
      ) {
        return notFound;
      }
      const realRoot = yield* fileSystem.realPath(row.root_path);
      const realFile = yield* fileSystem.realPath(row.real_path);
      const relative = path.relative(realRoot, realFile);
      if (
        realFile !== row.real_path ||
        relative === "" ||
        relative.startsWith("..") ||
        path.isAbsolute(relative)
      ) {
        return notFound;
      }
      const file = yield* openMediaFile(realFile);
      if (file === null) return notFound;
      return {
        _tag: "Ready",
        file,
        path: realFile,
        contentType,
        fileName: row.file_name,
      } as const;
    }).pipe(Effect.orElseSucceed(() => notFound));

  return CampaignMediaLinks.of({ register, revokePost, revokeAll, open });
});

export const layer = Layer.effect(CampaignMediaLinks, make);
