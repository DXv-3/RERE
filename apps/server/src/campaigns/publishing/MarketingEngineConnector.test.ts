import { assert, it } from "@effect/vitest";
import type { Campaign, CampaignClient, CampaignPost } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import {
  makeMarketingEngineConnector,
  NO_PUBLIC_MEDIA,
  type EngineConfig,
} from "./MarketingEngineConnector.ts";

const CONFIG: EngineConfig = { baseUrl: "https://engine.test/", apiKey: "key-123" };
const AT = "2026-10-06T12:00:00.000Z";

const client: CampaignClient = {
  id: "client-1",
  name: "Candid Studios",
  brandNotes: "",
  doNotSay: [],
  publishingClientId: "candid",
  approvalMode: "auto-publish",
  createdAt: AT,
  updatedAt: AT,
};
const campaign: Campaign = {
  id: "campaign-1",
  clientId: "client-1",
  name: "Reels",
  createdAt: AT,
  updatedAt: AT,
};
const post = (overrides: Partial<CampaignPost> = {}): CampaignPost => ({
  id: "post-1",
  campaignId: "campaign-1",
  status: "publishing",
  platforms: ["instagram"],
  captions: { default: "Default words", byPlatform: { instagram: "Instagram words" } },
  mediaPaths: [],
  mediaUrls: ["https://cdn.test/clip.mp4"],
  uploadedMedia: {},
  createdBy: { kind: "person" },
  approval: { by: "person", at: AT },
  publishResults: {},
  createdAt: AT,
  updatedAt: AT,
  ...overrides,
});
const request = (overrides: Partial<CampaignPost> = {}) => ({
  post: post(overrides),
  platform: "instagram" as const,
  client,
  campaign,
});

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly key: string | undefined;
  readonly body: unknown;
}
type Reply = Response | "network-error";

/** A client that answers each call from a script and records what it was sent. */
const fakeHttp = (script: (request: HttpClientRequest.HttpClientRequest) => Reply) => {
  const seen: Seen[] = [];
  const http = HttpClient.make((req) => {
    seen.push({
      method: req.method,
      url: req.url,
      key: req.headers["x-api-key"],
      body:
        req.body._tag === "Uint8Array"
          ? (JSON.parse(new TextDecoder().decode(req.body.body)) as unknown)
          : undefined,
    });
    const reply = script(req);
    return reply === "network-error"
      ? Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request: req }),
          }),
        )
      : Effect.succeed(HttpClientResponse.fromWeb(req, reply));
  });
  return { http, seen };
};

const connector = (http: HttpClient.HttpClient, config: EngineConfig | null = CONFIG) =>
  makeMarketingEngineConnector({ http, config: Effect.succeed(config) });

const open = () =>
  Response.json({ clientId: "candid", autopostPaused: false, masterEnabled: true });

it.effect("checks the engine's switches, then posts with the key and the engine's body", () => {
  const { http, seen } = fakeHttp((req) =>
    req.url.includes("/api/autopost/")
      ? open()
      : Response.json({ platform: "instagram", success: true, postId: "ig-9" }),
  );
  return Effect.gen(function* () {
    const outcome = yield* connector(http).publish(request());
    assert.deepStrictEqual(outcome, { success: true, postId: "ig-9" });
    assert.deepStrictEqual(
      seen.map((entry) => `${entry.method} ${entry.url}`),
      [
        "GET https://engine.test/api/autopost/candid",
        "POST https://engine.test/api/social/publish",
      ],
    );
    assert.deepStrictEqual(
      seen.map((entry) => entry.key),
      ["key-123", "key-123"],
    );
    assert.deepStrictEqual(seen[1]?.body, {
      clientId: "candid",
      platform: "instagram",
      type: "reel",
      caption: "Instagram words",
      mediaUrls: ["https://cdn.test/clip.mp4"],
      hashtags: [],
    });
  });
});

it.effect("refuses to post when the engine is paused, switched off, or cannot be read", () =>
  Effect.gen(function* () {
    const cases: ReadonlyArray<readonly [() => Reply, string]> = [
      [() => Response.json({ autopostPaused: true, masterEnabled: true }), "paused"],
      [() => Response.json({ autopostPaused: false, masterEnabled: false }), "master switch"],
      [() => new Response("nope", { status: 500 }), "Could not read"],
      [() => "network-error", "Could not reach"],
    ];
    for (const [reply, expected] of cases) {
      const { http, seen } = fakeHttp(reply);
      const outcome = yield* connector(http).publish(request());
      assert.isFalse(outcome.success);
      assert.include(outcome.error ?? "", expected);
      assert.isTrue(
        seen.every((entry) => entry.method === "GET"),
        "nothing was posted",
      );
    }
  }),
);

it.effect("says plainly when media only exists as a local file", () => {
  const { http, seen } = fakeHttp(() => open());
  return Effect.gen(function* () {
    const outcome = yield* connector(http).publish(
      request({ mediaPaths: ["campaigns/a/reel.mp4"], mediaUrls: [] }),
    );
    assert.deepStrictEqual(outcome, { success: false, error: NO_PUBLIC_MEDIA });
    assert.strictEqual(seen.length, 0);
  });
});

it.effect("fails without sending when the engine is not set up or the client has no id", () => {
  const { http, seen } = fakeHttp(() => open());
  return Effect.gen(function* () {
    const unconfigured = yield* connector(http, null).publish(request());
    assert.include(unconfigured.error ?? "", "not set up");
    const noId = yield* connector(http).publish({
      ...request(),
      client: { ...client, publishingClientId: undefined },
    });
    assert.include(noId.error ?? "", "no publishing id");
    assert.strictEqual(seen.length, 0);
  });
});

it.effect(
  "reports the engine's own reason, and never sends a post that got an answer again",
  () => {
    const { http, seen } = fakeHttp((req) =>
      req.url.includes("/api/autopost/")
        ? open()
        : Response.json(
            { platform: "instagram", success: false, error: "Token expired" },
            { status: 502 },
          ),
    );
    return Effect.gen(function* () {
      const outcome = yield* connector(http).publish(request());
      assert.deepStrictEqual(outcome, { success: false, error: "Token expired" });
      assert.strictEqual(seen.filter((entry) => entry.method === "POST").length, 1);
    });
  },
);

it.effect("retries once when the network fails, and says so when it fails again", () => {
  let posts = 0;
  const { http, seen } = fakeHttp((req) => {
    if (req.url.includes("/api/autopost/")) return open();
    posts += 1;
    return "network-error";
  });
  return Effect.gen(function* () {
    const outcome = yield* connector(http).publish(request());
    assert.isFalse(outcome.success);
    assert.include(outcome.error ?? "", "Could not reach");
    assert.strictEqual(posts, 2);
    assert.strictEqual(seen.filter((entry) => entry.method === "POST").length, 2);
  });
});

it.effect("recovers when the first attempt fails on the network and the second answers", () => {
  let attempts = 0;
  const { http } = fakeHttp((req) => {
    if (req.url.includes("/api/autopost/")) return open();
    attempts += 1;
    return attempts === 1
      ? "network-error"
      : Response.json({ platform: "instagram", success: true, postId: "ig-2" });
  });
  return Effect.gen(function* () {
    assert.deepStrictEqual(yield* connector(http).publish(request()), {
      success: true,
      postId: "ig-2",
    });
  });
});

it.effect("schedules with the time in the body and reads the engine's health", () => {
  const { http, seen } = fakeHttp((req) => {
    if (req.url.includes("/api/autopost/")) return open();
    if (req.url.endsWith("/health")) return Response.json({ ok: true });
    return Response.json({ status: "scheduled", scheduledAt: "2026-10-07T09:00:00.000Z" });
  });
  return Effect.gen(function* () {
    const engine = connector(http);
    assert.deepStrictEqual(
      yield* engine.schedule({ ...request(), scheduledAt: "2026-10-07T09:00:00.000Z" }),
      { success: true },
    );
    const scheduled = seen.find((entry) => entry.url.endsWith("/api/social/schedule"));
    assert.strictEqual(
      (scheduled?.body as { scheduledAt?: string } | undefined)?.scheduledAt,
      "2026-10-07T09:00:00.000Z",
    );
    assert.deepStrictEqual(yield* engine.test(), { ok: true });
    assert.deepStrictEqual(yield* engine.autopostState("candid"), {
      kind: "known",
      paused: false,
      masterEnabled: true,
    });
  });
});

it.effect("reports a failing health check as a reason", () => {
  const { http } = fakeHttp(() => new Response("down", { status: 503 }));
  return Effect.gen(function* () {
    const result = yield* connector(http).test();
    assert.isFalse(result.ok);
    assert.include(result.ok ? "" : result.reason, "503");
    assert.deepStrictEqual(yield* connector(http, null).test(), {
      ok: false,
      reason: "The marketing engine is not set up. Add its address and key first.",
    });
  });
});
