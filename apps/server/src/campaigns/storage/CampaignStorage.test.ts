// @effect-diagnostics nodeBuiltinImport:off - the upload flow reads real files from a real folder.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterAll, assert, beforeAll, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import * as CampaignStore from "../CampaignStore.ts";
import * as CampaignThreadNotifier from "../CampaignThreadNotifier.ts";
import * as CampaignMediaLinks from "./CampaignMediaLinks.ts";
import { campaignMediaResponse } from "./campaignMediaHttp.ts";
import * as CampaignStorage from "./CampaignStorage.ts";

const threadId = ThreadId.make("thread-agent");
const agent = { kind: "agent", threadId } as const;

let workspace = "";
beforeAll(() => {
  workspace = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-storage-")),
  );
  NodeFS.writeFileSync(NodePath.join(workspace, "clip.mp4"), "video-bytes");
  NodeFS.writeFileSync(NodePath.join(workspace, "other.mp4"), "other-bytes");
  NodeFS.writeFileSync(NodePath.join(workspace, "poster.jpg"), "jpg-bytes");
  NodeFS.writeFileSync(NodePath.join(workspace, ".env"), "SECRET=1");
  NodeFS.mkdirSync(NodePath.join(workspace, "sub"));
  NodeFS.writeFileSync(NodePath.join(workspace, "sub", "clip.mp4"), "second-clip");
});
afterAll(() => NodeFS.rmSync(workspace, { recursive: true, force: true }));

interface Seen {
  readonly method: string;
  readonly url: string;
}

/** What the fake storage service answers: by method, and optionally by url fragment. */
interface World {
  readonly secrets: Map<string, Uint8Array>;
  readonly seen: Seen[];
  /** Status for a request, or undefined for the default (200 for PUT and GET, 204 for DELETE). */
  answer: (request: Seen) => number | undefined;
  /**
   * What answers requests to this server's own public address in `server` mode: the real route
   * (`route`), a connection that fails (`unreachable`), or some other computer (`other`).
   */
  own?: "route" | "unreachable" | "other";
}

const makeLayer = (world: World) => {
  const secretStore = Layer.succeed(
    ServerSecretStore.ServerSecretStore,
    ServerSecretStore.ServerSecretStore.of({
      get: (name) => Effect.sync(() => Option.fromNullishOr(world.secrets.get(name))),
      set: (name, value) => Effect.sync(() => void world.secrets.set(name, value)),
      create: () => Effect.die("unused"),
      getOrCreateRandom: () => Effect.die("unused"),
      remove: (name) => Effect.sync(() => void world.secrets.delete(name)),
    }),
  );
  const settings = ServerSettings.layerTest();
  const mediaLinks = CampaignMediaLinks.layer.pipe(Layer.provide(settings));
  // The fake storage service. This server's own address is answered by the real links and the
  // route's response builder, as the route would, unless the world says it is unreachable.
  const http = Layer.effect(
    HttpClient.HttpClient,
    Effect.gen(function* () {
      const links = yield* CampaignMediaLinks.CampaignMediaLinks;
      const ownAnswer = (request: HttpClientRequest.HttpClientRequest) =>
        Effect.scoped(
          Effect.gen(function* () {
            const token = new URL(request.url).pathname.split("/")[3] ?? "";
            const outcome = yield* links.open({ token, remoteAddress: null });
            if (outcome._tag !== "Ready") return new Response("Not Found", { status: 404 });
            const served = HttpServerResponse.toWeb(
              yield* campaignMediaResponse(outcome, {
                method: "GET",
                range: undefined,
                ifRange: undefined,
              }),
            );
            return new Response(yield* Effect.promise(() => served.arrayBuffer()), {
              status: served.status,
            });
          }),
        ).pipe(Effect.orDie);
      return HttpClient.make((request) => {
        const seen = { method: request.method, url: request.url };
        world.seen.push(seen);
        if (request.url.includes("/api/campaign-media/")) {
          if (world.own === "unreachable") return Effect.fail(new Error("connect failed") as never);
          if (world.own === "other") {
            return Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response("not ours", { status: 404 })),
            );
          }
          return ownAnswer(request).pipe(
            Effect.map((response) => HttpClientResponse.fromWeb(request, response)),
          );
        }
        const status = world.answer(seen) ?? (request.method === "DELETE" ? 204 : 200);
        return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status })));
      });
    }),
  ).pipe(Layer.provide(mediaLinks));
  const threads = Layer.mock(ThreadManagementService.ThreadManagementService)({
    getThreadShell: () =>
      Effect.succeed({ projectId: "project-1", worktreePath: workspace } as never),
  });
  const projects = Layer.mock(ProjectService.ProjectService)({
    getById: () => Effect.succeed(Option.some({ workspaceRoot: workspace } as never)),
  });
  const notifier = Layer.succeed(
    CampaignThreadNotifier.CampaignThreadNotifier,
    CampaignThreadNotifier.CampaignThreadNotifier.of({ tell: () => Effect.void }),
  );
  const store = CampaignStore.layer.pipe(
    Layer.provide(notifier),
    Layer.provideMerge(SqlitePersistenceMemory),
  );
  return CampaignStorage.layer.pipe(
    Layer.provide(secretStore),
    Layer.provide(settings),
    Layer.provide(http),
    Layer.provide(threads),
    Layer.provide(projects),
    Layer.provide(WorkspacePaths.layer),
    Layer.provideMerge(mediaLinks),
    Layer.provideMerge(store),
    Layer.provideMerge(NodeServices.layer),
  );
};

const newWorld = (): World => ({ secrets: new Map(), seen: [], answer: () => undefined });

const COMPLETE = {
  endpoint: "https://acct123.r2.cloudflarestorage.com/",
  bucket: "media",
  publicBaseUrl: "https://files.example.com/",
  accessKeyId: Redacted.make("AKID0000"),
  secretAccessKey: Redacted.make("the-secret-value"),
} as const;

const run = <A, E>(
  world: World,
  body: Effect.Effect<
    A,
    E,
    | CampaignStorage.CampaignStorage
    | CampaignStore.CampaignStore
    | CampaignMediaLinks.CampaignMediaLinks
  >,
) => body.pipe(Effect.provide(makeLayer(world)));

/** A post in a campaign with the given files, made by an agent in the test thread. */
const postWith = (mediaPaths: ReadonlyArray<string>, mediaUrls: ReadonlyArray<string> = []) =>
  Effect.gen(function* () {
    const store = yield* CampaignStore.CampaignStore;
    const client = yield* store.upsertClient({
      name: "Candid Studios",
      brandNotes: "",
      doNotSay: [],
    });
    const campaign = yield* store.upsertCampaign({ clientId: client.id, name: "Fall Reels" });
    return yield* store.savePost(agent, {
      campaignId: campaign.id,
      platforms: ["instagram"],
      captions: { default: "Words", byPlatform: {} },
      mediaPaths: [...mediaPaths],
      mediaUrls: [...mediaUrls],
    });
  });

const puts = (world: World) => world.seen.filter((entry) => entry.method === "PUT");

it.effect("is off by default and keeps the two keys write-only", () => {
  const world = newWorld();
  return run(
    world,
    Effect.gen(function* () {
      const storage = yield* CampaignStorage.CampaignStorage;
      assert.deepStrictEqual(yield* storage.get, {
        mode: "off",
        endpoint: "",
        region: "auto",
        bucket: "",
        publicBaseUrl: "",
        prefix: "campaigns/",
        hasCredentials: false,
      });
      const state = yield* storage.set({ ...COMPLETE, mode: "s3" });
      assert.deepStrictEqual(state, {
        mode: "s3",
        endpoint: "https://acct123.r2.cloudflarestorage.com",
        region: "auto",
        bucket: "media",
        publicBaseUrl: "https://files.example.com",
        prefix: "campaigns/",
        hasCredentials: true,
      });
      assert.notInclude(Object.values(state).join("\n"), "the-secret-value");
      assert.notInclude(Object.values(state).join("\n"), "AKID0000");
      assert.strictEqual(
        new TextDecoder().decode(
          world.secrets.get(CampaignStorage.CAMPAIGN_STORAGE_SECRET_KEY_SECRET),
        ),
        "the-secret-value",
      );
      assert.strictEqual(
        new TextDecoder().decode(
          world.secrets.get(CampaignStorage.CAMPAIGN_STORAGE_ACCESS_KEY_SECRET),
        ),
        "AKID0000",
      );
      // Removing a key leaves the rest of the settings and reports no credentials.
      const refusedWhileOn = yield* storage.set({ secretAccessKey: null }).pipe(Effect.flip);
      assert.include(refusedWhileOn.message, "the access key and secret");
      assert.isTrue(world.secrets.has(CampaignStorage.CAMPAIGN_STORAGE_SECRET_KEY_SECRET));
      const cleared = yield* storage.set({ mode: "off", secretAccessKey: null });
      assert.isFalse(cleared.hasCredentials);
      assert.isFalse(world.secrets.has(CampaignStorage.CAMPAIGN_STORAGE_SECRET_KEY_SECRET));
      assert.strictEqual(cleared.bucket, "media");
    }),
  );
});

it.effect(
  "will not switch on until everything it needs is there, and changes nothing when refused",
  () => {
    const world = newWorld();
    return run(
      world,
      Effect.gen(function* () {
        const storage = yield* CampaignStorage.CampaignStorage;
        const missing = yield* storage.set({ mode: "s3", bucket: "media" }).pipe(Effect.flip);
        assert.strictEqual(missing.reason, "invalid");
        assert.include(missing.message, "the storage address");
        assert.include(missing.message, "the access key and secret");
        assert.strictEqual((yield* storage.get).bucket, "");
        assert.strictEqual(world.secrets.size, 0);

        for (const bad of [
          { endpoint: "http://acct.r2.cloudflarestorage.com" },
          { endpoint: "https://u:p@x.test" },
          { publicBaseUrl: "http://files.example.com" },
          { bucket: "Bad Bucket!" },
          { prefix: "../up" },
          { region: "us east" },
          { accessKeyId: Redacted.make("has space") },
        ]) {
          const error = yield* storage.set(bad).pipe(Effect.flip);
          assert.strictEqual(error.reason, "invalid", Object.keys(bad).join(","));
        }
        assert.strictEqual(world.secrets.size, 0);
      }),
    );
  },
);

it.effect("tests by uploading, reading the public address, and deleting", () => {
  const world = newWorld();
  return run(
    world,
    Effect.gen(function* () {
      const storage = yield* CampaignStorage.CampaignStorage;
      const before = yield* storage.test;
      assert.isFalse(before.ok);
      assert.include(before.reason ?? "", "not set up");

      yield* storage.set(COMPLETE);
      assert.deepStrictEqual(yield* storage.test, { ok: true });
      assert.deepStrictEqual(
        world.seen.map((entry) => entry.method),
        ["PUT", "GET", "DELETE"],
      );
      const put = world.seen[0]!;
      const get = world.seen[1]!;
      assert.match(
        put.url,
        /^https:\/\/acct123\.r2\.cloudflarestorage\.com\/media\/campaigns\/\.codewrench-storage-test\/[\w-]+\.txt$/,
      );
      assert.strictEqual(
        get.url,
        put.url.replace(
          "https://acct123.r2.cloudflarestorage.com/media",
          "https://files.example.com",
        ),
      );
    }),
  );
});

it.effect("says what went wrong in the test, and still cleans up", () => {
  const world = newWorld();
  return run(
    world,
    Effect.gen(function* () {
      const storage = yield* CampaignStorage.CampaignStorage;
      yield* storage.set(COMPLETE);

      world.answer = (request) => (request.method === "PUT" ? 403 : undefined);
      const refused = yield* storage.test;
      assert.isFalse(refused.ok);
      assert.include(refused.reason ?? "", "refused the keys");

      world.seen.length = 0;
      world.answer = (request) => (request.method === "GET" ? 403 : undefined);
      const notPublic = yield* storage.test;
      assert.isFalse(notPublic.ok);
      assert.include(notPublic.reason ?? "", "public address answered HTTP 403");
      // The test file is deleted even though the public check failed.
      assert.deepStrictEqual(
        world.seen.map((entry) => entry.method),
        ["PUT", "GET", "DELETE"],
      );
    }),
  );
});

it.effect(
  "uploads a post's files once, records their public links, and never uploads them again",
  () => {
    const world = newWorld();
    return run(
      world,
      Effect.gen(function* () {
        const storage = yield* CampaignStorage.CampaignStorage;
        yield* storage.set({ ...COMPLETE, mode: "s3" });
        const post = yield* postWith(["clip.mp4", "poster.jpg"]);
        const done = yield* storage.uploadPostMedia(post.id);

        const base = `campaigns/candid-studios/fall-reels/${post.id}`;
        assert.deepStrictEqual(done.uploadedMedia, {
          "clip.mp4": `https://files.example.com/${base}/clip.mp4`,
          "poster.jpg": `https://files.example.com/${base}/poster.jpg`,
        });
        assert.deepStrictEqual(done.mediaUrls, Object.values(done.uploadedMedia));
        assert.deepStrictEqual(
          puts(world).map((entry) => entry.url),
          [
            `https://acct123.r2.cloudflarestorage.com/media/${base}/clip.mp4`,
            `https://acct123.r2.cloudflarestorage.com/media/${base}/poster.jpg`,
          ],
        );
        // The post keeps its local paths and its status.
        assert.deepStrictEqual(done.mediaPaths, ["clip.mp4", "poster.jpg"]);
        assert.strictEqual(done.status, "draft");

        const again = yield* storage.uploadPostMedia(post.id);
        assert.deepStrictEqual(again.uploadedMedia, done.uploadedMedia);
        assert.lengthOf(puts(world), 2);
        const ensured = yield* storage.ensurePublicMedia(
          yield* (yield* CampaignStore.CampaignStore).getPost(post.id),
        );
        assert.deepStrictEqual(ensured.mediaUrls, done.mediaUrls);
        assert.lengthOf(puts(world), 2);
      }),
    );
  },
);

it.effect(
  "keeps what was uploaded when a later file fails, and uploads only the rest on retry",
  () => {
    const world = newWorld();
    return run(
      world,
      Effect.gen(function* () {
        const storage = yield* CampaignStorage.CampaignStorage;
        const store = yield* CampaignStore.CampaignStore;
        yield* storage.set({ ...COMPLETE, mode: "s3" });
        const post = yield* postWith(["clip.mp4", "other.mp4"]);
        world.answer = (request) =>
          request.method === "PUT" && request.url.endsWith("/other.mp4") ? 500 : undefined;
        const error = yield* storage.ensurePublicMedia(post).pipe(Effect.flip);
        assert.include(error.message, "other.mp4 was not uploaded");
        assert.include(error.message, "had a problem");
        const partial = yield* store.getPost(post.id);
        assert.deepStrictEqual(Object.keys(partial.uploadedMedia), ["clip.mp4"]);

        world.seen.length = 0;
        world.answer = () => undefined;
        const done = yield* storage.ensurePublicMedia(partial);
        assert.lengthOf(puts(world), 1);
        assert.deepStrictEqual(Object.keys(done.uploadedMedia), ["clip.mp4", "other.mp4"]);
        assert.lengthOf(done.mediaUrls, 2);
      }),
    );
  },
);

it.effect("gives two files with the same name different names", () => {
  const world = newWorld();
  return run(
    world,
    Effect.gen(function* () {
      const storage = yield* CampaignStorage.CampaignStorage;
      yield* storage.set({ ...COMPLETE, mode: "s3" });
      const post = yield* postWith(["clip.mp4", "sub/clip.mp4"]);
      const done = yield* storage.uploadPostMedia(post.id);
      assert.strictEqual(new Set(Object.values(done.uploadedMedia)).size, 2);
      assert.isTrue(puts(world)[1]?.url.endsWith("/2-clip.mp4"));
    }),
  );
});

it.effect("uploads nothing while storage is off, and says so for a person's request", () => {
  const world = newWorld();
  return run(
    world,
    Effect.gen(function* () {
      const storage = yield* CampaignStorage.CampaignStorage;
      yield* storage.set(COMPLETE);
      const post = yield* postWith(["clip.mp4"]);
      assert.strictEqual((yield* storage.get).mode, "off");
      // The publisher's path leaves the post alone, so the engine's plain refusal stays.
      assert.deepStrictEqual(yield* storage.ensurePublicMedia(post), post);
      const refused = yield* storage.uploadPostMedia(post.id).pipe(Effect.flip);
      assert.include(refused.message, "Cloud storage is off");
      assert.include(refused.message, "public to anyone with the link");
      assert.lengthOf(world.seen, 0);
    }),
  );
});

it.effect("leaves a post that already has links alone", () => {
  const world = newWorld();
  return run(
    world,
    Effect.gen(function* () {
      const storage = yield* CampaignStorage.CampaignStorage;
      yield* storage.set({ ...COMPLETE, mode: "s3" });
      const post = yield* postWith(["clip.mp4"], ["https://cdn.example.com/clip.mp4"]);
      assert.deepStrictEqual(yield* storage.ensurePublicMedia(post), post);
      assert.lengthOf(world.seen, 0);
    }),
  );
});

it.effect(
  "never uploads a file that is not a picture, video or audio, or is outside the folder",
  () => {
    const world = newWorld();
    return run(
      world,
      Effect.gen(function* () {
        const storage = yield* CampaignStorage.CampaignStorage;
        const store = yield* CampaignStore.CampaignStore;
        yield* storage.set({ ...COMPLETE, mode: "s3" });
        const secret = yield* postWith([".env"]);
        const notMedia = yield* storage.uploadPostMedia(secret.id).pipe(Effect.flip);
        assert.include(notMedia.message, "not a picture, video or audio file");

        const missing = yield* postWith(["nope.mp4"]);
        assert.strictEqual(
          (yield* storage.uploadPostMedia(missing.id).pipe(Effect.flip)).reason,
          "not_found",
        );

        // The store already refuses a path that climbs out; a link that leaves the folder is caught here too.
        const outside = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-storage-out-"));
        NodeFS.writeFileSync(NodePath.join(outside, "secret.mp4"), "x");
        NodeFS.symlinkSync(
          NodePath.join(outside, "secret.mp4"),
          NodePath.join(workspace, "link.mp4"),
        );
        const linked = yield* postWith(["link.mp4"]);
        const escaped = yield* storage.uploadPostMedia(linked.id).pipe(Effect.flip);
        assert.strictEqual(escaped.reason, "invalid");
        NodeFS.rmSync(outside, { recursive: true, force: true });
        NodeFS.rmSync(NodePath.join(workspace, "link.mp4"), { force: true });

        const climbing = yield* store
          .savePost(agent, {
            campaignId: (yield* store.getPost(secret.id)).campaignId,
            platforms: ["instagram"],
            captions: { default: "x", byPlatform: {} },
            mediaPaths: ["../up.mp4"],
            mediaUrls: [],
          })
          .pipe(Effect.flip);
        assert.strictEqual(climbing.reason, "invalid");
        assert.lengthOf(world.seen, 0);
      }),
    );
  },
);

it.effect("drops an upload record when the file leaves the post", () => {
  const world = newWorld();
  return run(
    world,
    Effect.gen(function* () {
      const storage = yield* CampaignStorage.CampaignStorage;
      const store = yield* CampaignStore.CampaignStore;
      yield* storage.set({ ...COMPLETE, mode: "s3" });
      const post = yield* postWith(["clip.mp4", "poster.jpg"]);
      yield* storage.uploadPostMedia(post.id);
      const edited = yield* store.savePost(agent, {
        id: post.id,
        campaignId: post.campaignId,
        platforms: ["instagram"],
        captions: { default: "Words", byPlatform: {} },
        mediaPaths: ["clip.mp4"],
        mediaUrls: [],
      });
      assert.deepStrictEqual(Object.keys(edited.uploadedMedia), ["clip.mp4"]);
    }),
  );
});

const SERVER_ADDRESS = { publicBaseUrl: "https://code.example.com/" } as const;
const linkOf = (url: string) => /\/api\/campaign-media\/([A-Za-z0-9_-]{43})\/([^/]+)$/.exec(url);

it.effect("needs only a public address to share from this server", () => {
  const world = newWorld();
  return run(
    world,
    Effect.gen(function* () {
      const storage = yield* CampaignStorage.CampaignStorage;
      const refused = yield* storage.set({ mode: "server" }).pipe(Effect.flip);
      assert.strictEqual(refused.reason, "invalid");
      assert.include(refused.message, "the public address");
      assert.strictEqual((yield* storage.get).mode, "off");
      const http = yield* storage
        .set({ mode: "server", publicBaseUrl: "http://code.example.com" })
        .pipe(Effect.flip);
      assert.strictEqual(http.reason, "invalid");
      const state = yield* storage.set({ ...SERVER_ADDRESS, mode: "server" });
      assert.strictEqual(state.mode, "server");
      assert.strictEqual(state.publicBaseUrl, "https://code.example.com");
      assert.lengthOf(world.seen, 0);
    }),
  );
});

it.effect("gives each file one link on this server and records it as the bucket path does", () => {
  const world = newWorld();
  return run(
    world,
    Effect.gen(function* () {
      const storage = yield* CampaignStorage.CampaignStorage;
      const store = yield* CampaignStore.CampaignStore;
      yield* storage.set({ ...SERVER_ADDRESS, mode: "server" });
      const post = yield* postWith(["clip.mp4", "poster.jpg"]);
      const done = yield* storage.uploadPostMedia(post.id);
      const clip = linkOf(done.uploadedMedia["clip.mp4"] ?? "");
      const poster = linkOf(done.uploadedMedia["poster.jpg"] ?? "");
      assert.isNotNull(clip);
      assert.isNotNull(poster);
      assert.strictEqual(clip?.[2], "clip.mp4");
      assert.notStrictEqual(clip?.[1], poster?.[1]);
      assert.isTrue(
        (done.uploadedMedia["clip.mp4"] ?? "").startsWith(
          "https://code.example.com/api/campaign-media/",
        ),
      );
      assert.deepStrictEqual(done.mediaUrls, [
        done.uploadedMedia["clip.mp4"] ?? "",
        done.uploadedMedia["poster.jpg"] ?? "",
      ]);
      // Nothing went to a bucket.
      assert.lengthOf(world.seen, 0);

      // Asking again, and the publisher's step, keep the same links.
      const again = yield* storage.uploadPostMedia(post.id);
      assert.deepStrictEqual(again.uploadedMedia, done.uploadedMedia);
      const forEngine = yield* storage.ensurePublicMedia(yield* store.getPost(post.id));
      assert.deepStrictEqual(forEngine.mediaUrls, done.mediaUrls);

      // The publisher's step on a post with no links yet makes them before the engine is called.
      const fresh = yield* postWith(["clip.mp4"]);
      const prepared = yield* storage.ensurePublicMedia(fresh);
      assert.lengthOf(prepared.mediaUrls, 1);
      assert.isNotNull(linkOf(prepared.mediaUrls[0] ?? ""));
    }),
  );
});

it.effect("will not share a file outside the folder or that is not media", () => {
  const world = newWorld();
  return run(
    world,
    Effect.gen(function* () {
      const storage = yield* CampaignStorage.CampaignStorage;
      yield* storage.set({ ...SERVER_ADDRESS, mode: "server" });
      const secret = yield* postWith([".env"]);
      const refused = yield* storage.uploadPostMedia(secret.id).pipe(Effect.flip);
      assert.include(refused.message, "not a picture, video or audio file");
      assert.deepStrictEqual(
        (yield* storage.uploadPostMedia(secret.id).pipe(Effect.flip)).reason,
        "invalid",
      );
    }),
  );
});

it.effect("stops sharing a post's files on request, and shares them again when asked", () => {
  const world = newWorld();
  return run(
    world,
    Effect.gen(function* () {
      const storage = yield* CampaignStorage.CampaignStorage;
      yield* storage.set({ ...SERVER_ADDRESS, mode: "server" });
      const post = yield* postWith(["clip.mp4"], ["https://cdn.example.com/own.mp4"]);
      const shared = yield* storage.uploadPostMedia(post.id);
      const first = shared.uploadedMedia["clip.mp4"] ?? "";
      assert.lengthOf(shared.mediaUrls, 2);
      const stopped = yield* storage.revokePostMedia(post.id);
      assert.deepStrictEqual(stopped.uploadedMedia, {});
      // A link the person typed is theirs and stays.
      assert.deepStrictEqual(stopped.mediaUrls, ["https://cdn.example.com/own.mp4"]);
      const again = yield* storage.uploadPostMedia(post.id);
      assert.notStrictEqual(again.uploadedMedia["clip.mp4"], first);
    }),
  );
});

it.effect("takes every link back when the mode or the address changes", () => {
  const world = newWorld();
  return run(
    world,
    Effect.gen(function* () {
      const storage = yield* CampaignStorage.CampaignStorage;
      const store = yield* CampaignStore.CampaignStore;
      yield* storage.set({ ...SERVER_ADDRESS, mode: "server" });
      const one = yield* postWith(["clip.mp4"]);
      const two = yield* postWith(["poster.jpg"]);
      yield* storage.uploadPostMedia(one.id);
      yield* storage.uploadPostMedia(two.id);

      yield* storage.set({ publicBaseUrl: "https://other.example.com" });
      for (const id of [one.id, two.id]) {
        const after = yield* store.getPost(id);
        assert.deepStrictEqual(after.uploadedMedia, {});
        assert.deepStrictEqual(after.mediaUrls, []);
      }

      yield* storage.uploadPostMedia(one.id);
      yield* storage.set({ mode: "off" });
      assert.deepStrictEqual((yield* store.getPost(one.id)).uploadedMedia, {});
    }),
  );
});

it.effect("tests by fetching a tiny file back through its own public address", () => {
  const world: World = { ...newWorld(), own: "route" };
  return run(
    world,
    Effect.gen(function* () {
      const storage = yield* CampaignStorage.CampaignStorage;
      yield* storage.set({ ...SERVER_ADDRESS, mode: "server" });
      assert.deepStrictEqual(yield* storage.test, { ok: true });
      assert.lengthOf(world.seen, 1);
      assert.match(
        world.seen[0]!.url,
        /^https:\/\/code\.example\.com\/api\/campaign-media\/[A-Za-z0-9_-]{43}\/storage-test\.png$/,
      );
      // The test file's link is gone again.
      const token = linkOf(world.seen[0]!.url)![1]!;
      const links = yield* CampaignMediaLinks.CampaignMediaLinks;
      const outcome = yield* Effect.scoped(links.open({ token, remoteAddress: null }));
      assert.strictEqual(outcome._tag, "NotFound");
    }),
  );
});

it.effect("says plainly when this server cannot reach its own public address", () => {
  const world: World = { ...newWorld(), own: "unreachable" };
  return run(
    world,
    Effect.gen(function* () {
      const storage = yield* CampaignStorage.CampaignStorage;
      yield* storage.set({ ...SERVER_ADDRESS, mode: "server" });
      const result = yield* storage.test;
      assert.isFalse(result.ok);
      assert.include(result.reason ?? "", "could not reach itself at https://code.example.com");
      assert.include(result.reason ?? "", "reached from the internet");
    }),
  );
});

it.effect("says so when the public address answers but is another computer", () => {
  const world: World = { ...newWorld(), own: "other" };
  return run(
    world,
    Effect.gen(function* () {
      const storage = yield* CampaignStorage.CampaignStorage;
      yield* storage.set({ ...SERVER_ADDRESS, mode: "server" });
      const result = yield* storage.test;
      assert.isFalse(result.ok);
      assert.include(result.reason ?? "", "answered HTTP 404 instead of the test file");
    }),
  );
});
