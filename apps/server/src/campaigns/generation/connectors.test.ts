import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it as plainIt } from "vite-plus/test";

import type { GenerationRequest } from "./GenerationConnector.ts";
import { localImageSize, makeLocalImageConnector } from "./LocalImageConnector.ts";
import { engineVideoUrl, makeMarketingEngineGenerator } from "./MarketingEngineGenerator.ts";
import { makeOpenRouterConnector } from "./OpenRouterConnector.ts";

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}
type Reply = Response | "network-error" | "hang";

/** A client that answers each call from a script and records what it was sent. */
const fakeHttp = (script: (request: HttpClientRequest.HttpClientRequest) => Reply) => {
  const seen: Seen[] = [];
  const http = HttpClient.make((req) => {
    seen.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
      body:
        req.body._tag === "Uint8Array"
          ? (JSON.parse(new TextDecoder().decode(req.body.body)) as unknown)
          : undefined,
    });
    const reply = script(req);
    if (reply === "hang") return Effect.never;
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

const video: GenerationRequest = {
  kind: "video",
  model: "bytedance/seedance-2.0-fast",
  prompt: "A cake being cut",
  options: {
    aspectRatio: "9:16",
    durationSeconds: 6,
    resolution: "720p",
    generateAudio: false,
  },
  name: "A cake being cut",
};
const image: GenerationRequest = {
  kind: "image",
  model: "google/gemini-2.5-flash-image",
  prompt: "A bouquet",
  options: { aspectRatio: "1:1" },
  name: "A bouquet",
};

const openRouter = (http: HttpClient.HttpClient, key: string | null = "or-key") =>
  makeOpenRouterConnector({
    http,
    config: Effect.succeed(key === null ? null : { apiKey: key }),
  });

describe("OpenRouter video", () => {
  it.effect(
    "submits the documented body with the bearer key and returns the polling address",
    () => {
      const { http, seen } = fakeHttp(() =>
        Response.json(
          { id: "job-1", polling_url: "https://openrouter.ai/api/v1/videos/job-1" },
          { status: 202 },
        ),
      );
      return Effect.gen(function* () {
        const started = yield* openRouter(http).start({
          ...video,
          firstFrameUrl: "https://cdn.test/first.png",
        });
        assert.deepStrictEqual(started, {
          kind: "async",
          providerJobId: "https://openrouter.ai/api/v1/videos/job-1",
        });
        assert.strictEqual(seen[0]?.method, "POST");
        assert.strictEqual(seen[0]?.url, "https://openrouter.ai/api/v1/videos");
        assert.strictEqual(seen[0]?.headers["authorization"], "Bearer or-key");
        assert.deepStrictEqual(seen[0]?.body, {
          model: "bytedance/seedance-2.0-fast",
          prompt: "A cake being cut",
          aspect_ratio: "9:16",
          duration: 6,
          resolution: "720p",
          generate_audio: false,
          frame_images: [{ url: "https://cdn.test/first.png", frame_type: "first" }],
        });
      });
    },
  );

  it.effect("refuses a polling address that is not on openrouter.ai", () => {
    const { http } = fakeHttp(() =>
      Response.json({ id: "job-1", polling_url: "https://evil.test/steal" }, { status: 202 }),
    );
    return Effect.gen(function* () {
      const error = yield* Effect.flip(openRouter(http).start(video));
      assert.include(error, "not on openrouter.ai");
    });
  });

  it.effect("reports the provider's own words when it refuses, and never echoes the key", () => {
    const { http } = fakeHttp(() =>
      Response.json({ error: { message: "duration out of range" } }, { status: 400 }),
    );
    return Effect.gen(function* () {
      const error = yield* Effect.flip(openRouter(http).start(video));
      assert.strictEqual(error, "OpenRouter said: duration out of range");
      assert.notInclude(error, "or-key");
    });
  });

  it.effect("says so when there is no key, without calling anywhere", () => {
    const { http, seen } = fakeHttp(() => Response.json({}));
    return Effect.gen(function* () {
      const error = yield* Effect.flip(openRouter(http, null).start(video));
      assert.include(error, "no key");
      assert.strictEqual(seen.length, 0);
    });
  });

  it.effect("gives up on a request that never answers, and warns that it may have run", () => {
    const { http } = fakeHttp(() => "hang");
    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(Effect.flip(openRouter(http).start(video)));
      yield* TestClock.adjust("20 seconds");
      const error = yield* Fiber.join(fiber);
      assert.include(error, "did not answer in time");
      assert.include(error, "may still have run");
    });
  });

  it.effect("reports a network failure plainly", () => {
    const { http } = fakeHttp(() => "network-error");
    return Effect.gen(function* () {
      assert.strictEqual(
        yield* Effect.flip(openRouter(http).start(video)),
        "Could not reach OpenRouter.",
      );
    });
  });

  it.effect("polls: running, completed with the first link, failed, and unreadable", () => {
    const answers = [
      { status: "in_progress" },
      { status: "completed", unsigned_urls: ["https://cdn.test/a.mp4", "https://cdn.test/b.mp4"] },
      { status: "completed", unsigned_urls: [] },
      { status: "failed", error: "content policy" },
      { status: "expired" },
      { nonsense: true },
    ];
    let index = 0;
    const { http, seen } = fakeHttp(() => Response.json(answers[index++]));
    const connector = openRouter(http);
    const poll = () => connector.poll("https://openrouter.ai/api/v1/videos/job-1");
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* poll(), { state: "running" });
      assert.deepStrictEqual(yield* poll(), { state: "done", urls: ["https://cdn.test/a.mp4"] });
      assert.deepStrictEqual(yield* poll(), {
        state: "failed",
        reason: "OpenRouter did not return a video link.",
      });
      assert.deepStrictEqual(yield* poll(), {
        state: "failed",
        reason: "OpenRouter said: content policy",
      });
      assert.deepStrictEqual(yield* poll(), {
        state: "failed",
        reason: "OpenRouter reported the job as expired.",
      });
      // A reply this app cannot read is "try again later", not a verdict.
      assert.include(yield* Effect.flip(poll()), "cannot read");
      assert.strictEqual(seen[0]?.method, "GET");
      assert.strictEqual(seen[0]?.headers["authorization"], "Bearer or-key");
    });
  });

  it.effect("never sends the key to a polling address elsewhere", () => {
    const { http, seen } = fakeHttp(() => Response.json({ status: "completed" }));
    return Effect.gen(function* () {
      const result = yield* openRouter(http).poll("https://evil.test/x");
      assert.strictEqual(result.state, "failed");
      assert.strictEqual(seen.length, 0);
    });
  });

  it.effect("a 5xx while polling is retried later, a 404 ends the job", () => {
    let code = 503;
    const { http } = fakeHttp(() => new Response("down", { status: code }));
    const connector = openRouter(http);
    const url = "https://openrouter.ai/api/v1/videos/job-1";
    return Effect.gen(function* () {
      assert.include(yield* Effect.flip(connector.poll(url)), "HTTP 503");
      code = 404;
      assert.strictEqual((yield* connector.poll(url)).state, "failed");
    });
  });
});

describe("OpenRouter image", () => {
  it.effect("asks the chat endpoint for an image and reads the data address", () => {
    const { http, seen } = fakeHttp(() =>
      Response.json({
        choices: [{ message: { images: [{ image_url: { url: "data:image/png;base64,AAAA" } }] } }],
      }),
    );
    return Effect.gen(function* () {
      const started = yield* openRouter(http).start(image);
      assert.deepStrictEqual(started, { kind: "finished", urls: ["data:image/png;base64,AAAA"] });
      assert.strictEqual(seen[0]?.url, "https://openrouter.ai/api/v1/chat/completions");
      assert.deepStrictEqual(seen[0]?.body, {
        model: "google/gemini-2.5-flash-image",
        messages: [{ role: "user", content: "A bouquet" }],
        modalities: ["image", "text"],
        image_config: { aspect_ratio: "1:1" },
      });
    });
  });

  it.effect("fails with a plain message when the model sends no image or a broken reply", () => {
    const replies: Reply[] = [
      Response.json({ choices: [{ message: { content: "sorry" } }] }),
      new Response("<html>", { status: 200 }),
    ];
    let index = 0;
    const { http } = fakeHttp(() => replies[index++] as Reply);
    return Effect.gen(function* () {
      assert.include(yield* Effect.flip(openRouter(http).start(image)), "returned no image");
      assert.include(yield* Effect.flip(openRouter(http).start(image)), "returned no image");
    });
  });

  it.effect("test() reads the key's own record", () => {
    const { http, seen } = fakeHttp(() => Response.json({ data: {} }));
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* openRouter(http).test(), { ok: true });
      assert.strictEqual(seen[0]?.url, "https://openrouter.ai/api/v1/key");
    });
  });
});

describe("local images server", () => {
  const local = (http: HttpClient.HttpClient) =>
    makeLocalImageConnector({
      http,
      config: Effect.succeed({ baseUrl: "http://localhost:8080", model: "sdxl" }),
    });

  it.effect("posts the OpenAI images body with no key and returns the base64 image", () => {
    const { http, seen } = fakeHttp(() => Response.json({ data: [{ b64_json: "QUJD" }] }));
    return Effect.gen(function* () {
      const started = yield* local(http).start({
        ...image,
        model: "sdxl",
        options: { aspectRatio: "16:9" },
      });
      assert.deepStrictEqual(started, { kind: "finished", urls: ["data:image/png;base64,QUJD"] });
      assert.strictEqual(seen[0]?.url, "http://localhost:8080/v1/images/generations");
      assert.isUndefined(seen[0]?.headers["authorization"]);
      assert.deepStrictEqual(seen[0]?.body, {
        model: "sdxl",
        prompt: "A bouquet",
        size: "1792x1024",
        n: 1,
        response_format: "b64_json",
      });
    });
  });

  it.effect("refuses video in plain words without calling", () => {
    const { http, seen } = fakeHttp(() => Response.json({}));
    return Effect.gen(function* () {
      assert.include(yield* Effect.flip(local(http).start(video)), "images only");
      assert.strictEqual(seen.length, 0);
    });
  });

  it.effect("fails on a provider error and on an answer with no image", () => {
    const replies: Reply[] = [
      Response.json({ error: { message: "model not loaded" } }, { status: 500 }),
      Response.json({ data: [] }),
    ];
    let index = 0;
    const { http } = fakeHttp(() => replies[index++] as Reply);
    return Effect.gen(function* () {
      assert.include(yield* Effect.flip(local(http).start(image)), "model not loaded");
      assert.include(yield* Effect.flip(local(http).start(image)), "sent no image");
    });
  });

  plainIt("picks the nearest of the three standard sizes", () => {
    expect(localImageSize("9:16")).toBe("1024x1792");
    expect(localImageSize("1:1")).toBe("1024x1024");
    expect(localImageSize(undefined)).toBe("1024x1024");
  });
});

describe("marketing engine video", () => {
  const engine = (http: HttpClient.HttpClient) =>
    makeMarketingEngineGenerator({
      http,
      config: Effect.succeed({ baseUrl: "https://engine.test/", apiKey: "engine-key" }),
    });

  it.effect("posts the campaign body with x-api-key and finds the video link", () => {
    const { http, seen } = fakeHttp(() =>
      Response.json({ result: { videoUrl: "https://cdn.test/v.mp4" } }),
    );
    return Effect.gen(function* () {
      const started = yield* engine(http).start({ ...video, engineClientId: "candid" });
      assert.deepStrictEqual(started, { kind: "finished", urls: ["https://cdn.test/v.mp4"] });
      assert.strictEqual(seen[0]?.url, "https://engine.test/api/campaigns/video");
      assert.strictEqual(seen[0]?.headers["x-api-key"], "engine-key");
      const body = seen[0]?.body as Record<string, unknown>;
      assert.strictEqual(body["clientId"], "candid");
      assert.strictEqual(body["topic"], "A cake being cut");
      assert.strictEqual(body["useImageToVideo"], false);
      assert.deepStrictEqual(Object.keys(body).toSorted(), [
        "clientId",
        "industry",
        "name",
        "pillar",
        "pipeline",
        "platforms",
        "provider",
        "quality",
        "topic",
        "useImageToVideo",
        "videoType",
      ]);
    });
  });

  it.effect("says the engine returned no link when none of the fields has one", () => {
    const { http } = fakeHttp(() => Response.json({ success: true, result: {} }));
    return Effect.gen(function* () {
      assert.strictEqual(
        yield* Effect.flip(engine(http).start({ ...video, engineClientId: "candid" })),
        "The engine did not return a video link.",
      );
    });
  });

  it.effect("needs a publishing id, refuses images, and reports the engine's error", () => {
    const { http } = fakeHttp(() => Response.json({ error: "quota" }, { status: 429 }));
    return Effect.gen(function* () {
      assert.include(yield* Effect.flip(engine(http).start(video)), "no publishing id");
      assert.include(yield* Effect.flip(engine(http).start(image)), "is used for video");
      assert.include(
        yield* Effect.flip(engine(http).start({ ...video, engineClientId: "candid" })),
        "quota",
      );
    });
  });

  plainIt("looks for the link in videoUrl, result.videoUrl and video.url, https only", () => {
    expect(engineVideoUrl({ videoUrl: "https://a.test/1.mp4" })).toBe("https://a.test/1.mp4");
    expect(engineVideoUrl({ video: { url: "https://a.test/2.mp4" } })).toBe("https://a.test/2.mp4");
    expect(engineVideoUrl({ videoUrl: "http://a.test/3.mp4" })).toBeNull();
    expect(engineVideoUrl(null)).toBeNull();
  });
});
