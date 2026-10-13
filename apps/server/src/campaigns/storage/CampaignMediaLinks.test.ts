// @effect-diagnostics nodeBuiltinImport:off - the links serve real files from a real folder.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/unstable/http";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as CampaignStore from "../CampaignStore.ts";
import * as CampaignThreadNotifier from "../CampaignThreadNotifier.ts";
import {
  CAMPAIGN_MEDIA_ROUTE_PREFIX,
  CampaignMediaLinks,
  isCountableAddress,
  MEDIA_PROXY_RATE_LIMIT,
  MEDIA_RATE_LIMIT,
  isServerMediaLink,
  layer as mediaLinksLayer,
} from "./CampaignMediaLinks.ts";
import { campaignMediaRouteLayer } from "./campaignMediaHttp.ts";

const agent = { kind: "agent", threadId: ThreadId.make("thread-agent") } as const;
const VIDEO = "0123456789abcdefghij";

let workspace = "";
let outside = "";
beforeAll(() => {
  workspace = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-links-")));
  outside = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-outside-")));
  NodeFS.writeFileSync(NodePath.join(outside, "secret.mp4"), "outside-secret");
});
afterAll(() => {
  NodeFS.rmSync(workspace, { recursive: true, force: true });
  NodeFS.rmSync(outside, { recursive: true, force: true });
});

/** The real store, links and route on an in-memory database, and a way to call the route like a client. */
const servicesFor = (mode: "server" | "off") => {
  const notifier = Layer.succeed(
    CampaignThreadNotifier.CampaignThreadNotifier,
    CampaignThreadNotifier.CampaignThreadNotifier.of({ tell: () => Effect.void }),
  );
  return mediaLinksLayer.pipe(
    Layer.provideMerge(ServerSettings.layerTest({ campaignStorage: mode })),
    Layer.provideMerge(
      CampaignStore.layer.pipe(
        Layer.provide(notifier),
        Layer.provideMerge(SqlitePersistenceMemory),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
};
type Services = Layer.Success<ReturnType<typeof servicesFor>>;

const fixture = (mode: "server" | "off" = "server") =>
  Effect.gen(function* () {
    const services = servicesFor(mode);
    const memoMap = yield* Layer.makeMemoMap;
    const scope = yield* Effect.scope;
    const context = yield* Layer.buildWithMemoMap(services, memoMap, scope);
    const { handler, dispose } = HttpRouter.toWebHandler(
      campaignMediaRouteLayer.pipe(Layer.provideMerge(services)),
      { memoMap, disableLogger: true },
    );
    yield* Effect.addFinalizer(() => Effect.promise(dispose));
    return {
      handler,
      run: <A, E>(effect: Effect.Effect<A, E, Services>) => Effect.provide(effect, context),
    };
  });
type Fixture = Effect.Success<ReturnType<typeof fixture>>;

let counter = 0;
/** A post that lists `name` from the workspace, with a link registered and recorded for it. */
const share = (
  { run }: Fixture,
  name: string,
  contents: string | null = VIDEO,
  options: { readonly contentType?: string } = {},
) => {
  if (contents !== null) NodeFS.writeFileSync(NodePath.join(workspace, name), contents);
  counter += 1;
  const realPath = NodePath.join(workspace, name);
  return run(
    Effect.gen(function* () {
      const store = yield* CampaignStore.CampaignStore;
      const links = yield* CampaignMediaLinks;
      const client = yield* store.upsertClient({
        name: `C${counter}`,
        brandNotes: "",
        doNotSay: [],
      });
      const campaign = yield* store.upsertCampaign({ clientId: client.id, name: "Reels" });
      const post = yield* store.savePost(agent, {
        campaignId: campaign.id,
        platforms: ["instagram"],
        captions: { default: "Words", byPlatform: {} },
        mediaPaths: [name],
        mediaUrls: [],
      });
      const token = yield* links.register({
        postId: post.id,
        relativePath: name,
        realPath,
        rootPath: workspace,
        contentType: options.contentType ?? "video/mp4",
        sizeBytes: VIDEO.length,
        fileName: name,
      });
      yield* store.recordUploadedMedia({
        postId: post.id,
        uploaded: { [name]: `https://files.test${CAMPAIGN_MEDIA_ROUTE_PREFIX}/${token}/${name}` },
      });
      return { postId: post.id, token };
    }),
  );
};

const call = ({ handler }: Fixture, url: string, init: RequestInit = {}) =>
  Effect.promise(() => handler(new Request(`http://t3.test${url}`, init)));
const get = (
  f: Fixture,
  token: string,
  init: { readonly method?: string; readonly headers?: Record<string, string> } = {},
  name = "clip.mp4",
) => call(f, `${CAMPAIGN_MEDIA_ROUTE_PREFIX}/${token}/${name}`, init);
const body = (response: Response) => Effect.promise(() => response.text());

const expectGone = (response: Response) =>
  Effect.gen(function* () {
    expect(response.status).toBe(404);
    expect(yield* body(response)).toBe("Not Found");
  });

describe("serving a shared file", () => {
  it.effect("answers with the file, its type and the headers a platform checks", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const { token } = yield* share(f, "clip.mp4");
      const response = yield* get(f, token);
      expect(response.status).toBe(200);
      expect(yield* body(response)).toBe(VIDEO);
      expect(response.headers.get("content-type")).toBe("video/mp4");
      expect(response.headers.get("content-length")).toBe(String(VIDEO.length));
      expect(response.headers.get("accept-ranges")).toBe("bytes");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
      expect(response.headers.get("content-disposition")).toBe('inline; filename="clip.mp4"');
    }),
  );

  it.effect("answers HEAD with the length and no body", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const { token } = yield* share(f, "clip.mp4");
      const response = yield* get(f, token, { method: "HEAD" });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-length")).toBe(String(VIDEO.length));
      expect(response.headers.get("accept-ranges")).toBe("bytes");
      expect(yield* body(response)).toBe("");
    }),
  );

  it.effect("answers byte ranges, and a range it cannot meet", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const { token } = yield* share(f, "clip.mp4");
      const middle = yield* get(f, token, { headers: { range: "bytes=2-5" } });
      expect(middle.status).toBe(206);
      expect(middle.headers.get("content-range")).toBe(`bytes 2-5/${VIDEO.length}`);
      expect(middle.headers.get("content-length")).toBe("4");
      expect(yield* body(middle)).toBe("2345");
      const tail = yield* get(f, token, { headers: { range: "bytes=-3" } });
      expect(tail.status).toBe(206);
      expect(yield* body(tail)).toBe("hij");
      const openEnded = yield* get(f, token, { headers: { range: "bytes=18-" } });
      expect(yield* body(openEnded)).toBe("ij");
      const past = yield* get(f, token, { headers: { range: "bytes=500-" } });
      expect(past.status).toBe(416);
      expect(past.headers.get("content-range")).toBe(`bytes */${VIDEO.length}`);
      yield* body(past);
      // A range that comes with If-Range cannot be checked, so it gets the whole file.
      const conditional = yield* get(f, token, {
        headers: { range: "bytes=2-5", "if-range": '"anything"' },
      });
      expect(conditional.status).toBe(200);
      expect(yield* body(conditional)).toBe(VIDEO);
    }),
  );

  it.effect("never uses the name in the address to find or open anything", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const { token } = yield* share(f, "clip.mp4");
      NodeFS.writeFileSync(NodePath.join(workspace, "other.mp4"), "other-file");
      for (const name of ["other.mp4", "..%2Fother.mp4", "x"]) {
        const response = yield* get(f, token, {}, name);
        expect(response.status).toBe(200);
        expect(yield* body(response)).toBe(VIDEO);
      }
      yield* expectGone(yield* call(f, `${CAMPAIGN_MEDIA_ROUTE_PREFIX}/${token}`));
      yield* expectGone(yield* call(f, `${CAMPAIGN_MEDIA_ROUTE_PREFIX}/${token}/a/clip.mp4`));
      yield* expectGone(yield* call(f, `${CAMPAIGN_MEDIA_ROUTE_PREFIX}/`));
    }),
  );

  it.effect("answers a plain 404 for a made-up or malformed secret", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const { token } = yield* share(f, "clip.mp4");
      const wrongSecret = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
      for (const bad of [wrongSecret, "x".repeat(43), "short", `${token}extra`, "a%00b"]) {
        yield* expectGone(yield* get(f, bad));
      }
      // The router may answer these itself, but never with a file.
      expect((yield* get(f, "%2e%2e")).status).toBe(404);
    }),
  );

  it.effect("keeps no readable secret in the database", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const { token } = yield* share(f, "clip.mp4");
      const rows = yield* f.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<Record<string, unknown>>`SELECT * FROM workbench_campaign_media_links`;
        }),
      );
      expect(rows).toHaveLength(1);
      expect(Object.values(rows[0] ?? {}).join(" ")).not.toContain(token);
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }),
  );
});

describe("when a link stops working", () => {
  it.effect("stops at once when the post's files are revoked, and when the post goes", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const revoked = yield* share(f, "clip.mp4");
      const deleted = yield* share(f, "clip2.mp4");
      const rejected = yield* share(f, "clip3.mp4");
      expect((yield* get(f, revoked.token)).status).toBe(200);

      yield* f.run(
        Effect.gen(function* () {
          const links = yield* CampaignMediaLinks;
          const store = yield* CampaignStore.CampaignStore;
          yield* links.revokePost(revoked.postId);
          yield* store.deletePost(deleted.postId);
          yield* store.submitPost({ kind: "person" }, rejected.postId);
          yield* store.rejectPost(rejected.postId);
        }),
      );
      for (const { token } of [revoked, deleted, rejected]) yield* expectGone(yield* get(f, token));
    }),
  );

  it.effect("stops when the post no longer lists the file under that link", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const { token, postId } = yield* share(f, "clip.mp4");
      const dropped = yield* f.run(
        Effect.gen(function* () {
          const store = yield* CampaignStore.CampaignStore;
          return yield* store.dropUploadedMedia({ postId, matches: isServerMediaLink });
        }),
      );
      expect(dropped.uploadedMedia).toEqual({});
      expect(dropped.mediaUrls).toEqual([]);
      yield* expectGone(yield* get(f, token));
    }),
  );

  it.effect("is a 404 while storage is not in server mode, and works again when it is", () =>
    Effect.gen(function* () {
      const f = yield* fixture("off");
      const { token } = yield* share(f, "clip.mp4");
      yield* expectGone(yield* get(f, token));
      yield* f.run(
        Effect.gen(function* () {
          const settings = yield* ServerSettings.ServerSettingsService;
          yield* settings.updateSettings({ campaignStorage: "s3" });
        }),
      );
      yield* expectGone(yield* get(f, token));
      yield* f.run(
        Effect.gen(function* () {
          const settings = yield* ServerSettings.ServerSettingsService;
          yield* settings.updateSettings({ campaignStorage: "server" });
        }),
      );
      expect((yield* get(f, token)).status).toBe(200);
    }),
  );

  it.effect("is a 404 once the file is gone or no longer a plain file", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const { token } = yield* share(f, "clip.mp4");
      NodeFS.rmSync(NodePath.join(workspace, "clip.mp4"));
      yield* expectGone(yield* get(f, token));
      NodeFS.mkdirSync(NodePath.join(workspace, "clip.mp4"));
      yield* expectGone(yield* get(f, token));
      NodeFS.rmdirSync(NodePath.join(workspace, "clip.mp4"));
    }),
  );

  it.effect.skipIf(!symlinksSupported)(
    "is a 404 when the file became a link to somewhere else",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const { token } = yield* share(f, "clip.mp4");
        expect((yield* get(f, token)).status).toBe(200);
        NodeFS.rmSync(NodePath.join(workspace, "clip.mp4"));
        NodeFS.symlinkSync(
          NodePath.join(outside, "secret.mp4"),
          NodePath.join(workspace, "clip.mp4"),
        );
        const response = yield* get(f, token);
        expect(response.status).toBe(404);
        expect(yield* body(response)).not.toContain("outside-secret");
      }),
  );

  it.effect.skipIf(!symlinksSupported)(
    "is a 404 when the folder it was in is swapped for a link elsewhere",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        NodeFS.mkdirSync(NodePath.join(workspace, "album"), { recursive: true });
        NodeFS.writeFileSync(NodePath.join(workspace, "album", "pic.png"), "png-bytes");
        const { token } = yield* share(f, "album/pic.png", null, { contentType: "image/png" });
        expect((yield* get(f, token, {}, "pic.png")).status).toBe(200);
        NodeFS.rmSync(NodePath.join(workspace, "album"), { recursive: true });
        NodeFS.mkdirSync(NodePath.join(outside, "album"), { recursive: true });
        NodeFS.writeFileSync(NodePath.join(outside, "album", "pic.png"), "outside-secret");
        NodeFS.symlinkSync(NodePath.join(outside, "album"), NodePath.join(workspace, "album"));
        yield* expectGone(yield* get(f, token, {}, "pic.png"));
        NodeFS.rmSync(NodePath.join(workspace, "album"));
      }),
  );

  it.effect(
    "is a 404 for a file that is not a picture, video or sound, whatever type was stored",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const document = yield* share(f, "notes.txt", "private notes", {
          contentType: "image/png",
        });
        yield* expectGone(yield* get(f, document.token));
        const env = yield* share(f, "config.env", "SECRET=1", { contentType: "text/plain" });
        yield* expectGone(yield* get(f, env.token));
        // The stored type has to agree with the extension too.
        const mismatch = yield* share(f, "clip4.mp4", VIDEO, { contentType: "image/png" });
        yield* expectGone(yield* get(f, mismatch.token));
      }),
  );
});

describe("registering", () => {
  it.effect("makes one link per file per post: a new one replaces the old", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const first = yield* share(f, "clip.mp4");
      const second = yield* f.run(
        Effect.gen(function* () {
          const links = yield* CampaignMediaLinks;
          return yield* links.register({
            postId: first.postId,
            relativePath: "clip.mp4",
            realPath: NodePath.join(workspace, "clip.mp4"),
            rootPath: workspace,
            contentType: "video/mp4",
            sizeBytes: VIDEO.length,
            fileName: "clip.mp4",
          });
        }),
      );
      expect(second).not.toBe(first.token);
      const count = yield* f.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return (yield* sql<{ readonly n: number }>`
          SELECT COUNT(*) AS n FROM workbench_campaign_media_links WHERE post_id = ${first.postId}`)[0]
            ?.n;
        }),
      );
      expect(count).toBe(1);
      yield* expectGone(yield* get(f, first.token));
    }),
  );

  it.effect("revokes everything and names the posts that had a link", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const a = yield* share(f, "clip.mp4");
      const b = yield* share(f, "clip2.mp4");
      const posts = yield* f.run(
        Effect.gen(function* () {
          return yield* (yield* CampaignMediaLinks).revokeAll;
        }),
      );
      expect([...posts].sort()).toEqual([a.postId, b.postId].sort());
      yield* expectGone(yield* get(f, a.token));
      yield* expectGone(yield* get(f, b.token));
    }),
  );
});

describe("rate limit", () => {
  it.effect("answers 429 after too many requests for one link", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const { token } = yield* share(f, "clip.mp4");
      let limited = 0;
      for (let index = 0; index < MEDIA_RATE_LIMIT + 5; index += 1) {
        const response = yield* get(f, token, { method: "HEAD" });
        if (response.status === 429) {
          limited += 1;
          expect(response.headers.get("retry-after")).toBe("60");
        }
      }
      // Every request counts against the link and against the address, so the cut-off is the same.
      expect(limited).toBe(5);
    }),
  );

  it.effect("answers 429 to one address guessing links, and keeps answering 404 before that", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const statuses = new Set<number>();
      // The test client has no remote address, which the server treats as a proxy.
      for (let index = 0; index < MEDIA_PROXY_RATE_LIMIT + 5; index += 1) {
        const response = yield* get(f, `${String(index).padStart(43, "g")}`);
        statuses.add(response.status);
        yield* body(response);
      }
      expect([...statuses].sort()).toEqual([404, 429]);
    }),
  );
});

describe("isCountableAddress", () => {
  it("counts real visitors and not the proxy in front of the server", () => {
    expect(isCountableAddress("203.0.113.9")).toBe(true);
    expect(isCountableAddress("2001:db8::1")).toBe(true);
    for (const proxy of [
      null,
      "127.0.0.1",
      "::1",
      "::ffff:127.0.0.1",
      "10.0.0.4",
      "192.168.1.2",
      "172.18.0.3",
      "fd00::1",
    ]) {
      expect(isCountableAddress(proxy)).toBe(false);
    }
  });
});
