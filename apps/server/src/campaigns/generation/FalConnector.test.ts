import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { describe } from "vite-plus/test";

import {
  DEFAULT_FAL_IMAGE_MODEL,
  DEFAULT_FAL_TEXT_VIDEO_MODEL,
  DEFAULT_FAL_VIDEO_MODEL,
  KNOWN_FAL_VIDEO_MODELS,
  makeFalConnector,
} from "./FalConnector.ts";
import type { GenerationRequest } from "./GenerationConnector.ts";

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

/** A client that answers each call from a script and records what it was sent. */
const fakeHttp = (script: (request: HttpClientRequest.HttpClientRequest) => Response) => {
  const seen: Seen[] = [];
  const http = HttpClient.make((req) => {
    let body: unknown;
    if (req.body._tag === "Uint8Array") {
      body = JSON.parse(new TextDecoder().decode(req.body.body)) as unknown;
    }
    seen.push({ method: req.method, url: req.url, headers: req.headers, body });
    return Effect.succeed(HttpClientResponse.fromWeb(req, script(req)));
  });
  return { http, seen };
};

const fal = (http: HttpClient.HttpClient, key: string | null = "fal-key") =>
  makeFalConnector({ http, config: Effect.succeed(key === null ? null : { apiKey: key }) });

const RESPONSE = "https://queue.fal.run/fal-ai/veo3.1/requests/req-1";

const submitted = {
  request_id: "req-1",
  status_url: `${RESPONSE}/status`,
  response_url: RESPONSE,
};

const video: GenerationRequest = {
  kind: "video",
  model: "fal-ai/veo3.1/image-to-video",
  prompt: "A cake being cut",
  options: { aspectRatio: "9:16", durationSeconds: 8, resolution: "720p", generateAudio: false },
  firstFrameUrl: "https://cdn.test/first.png",
  name: "A cake being cut",
};

describe("fal.ai defaults", () => {
  it("names the catalog ids", () => {
    assert.strictEqual(DEFAULT_FAL_VIDEO_MODEL, "fal-ai/veo3.1/image-to-video");
    assert.strictEqual(DEFAULT_FAL_TEXT_VIDEO_MODEL, "fal-ai/veo3.1");
    assert.strictEqual(DEFAULT_FAL_IMAGE_MODEL, "fal-ai/flux/dev");
    assert.include(KNOWN_FAL_VIDEO_MODELS, "bytedance/seedance-2.0/image-to-video");
    assert.strictEqual(KNOWN_FAL_VIDEO_MODELS.length, 7);
  });
});

describe("fal.ai start", () => {
  it.effect("posts to the queue with the Key header and stores the response address", () => {
    const { http, seen } = fakeHttp(() => Response.json(submitted));
    return Effect.gen(function* () {
      const started = yield* fal(http).start(video);
      assert.deepStrictEqual(started, { kind: "async", providerJobId: RESPONSE });
      assert.strictEqual(seen[0]?.method, "POST");
      assert.strictEqual(seen[0]?.url, "https://queue.fal.run/fal-ai/veo3.1/image-to-video");
      assert.strictEqual(seen[0]?.headers["authorization"], "Key fal-key");
      assert.deepStrictEqual(seen[0]?.body, {
        prompt: "A cake being cut",
        image_url: "https://cdn.test/first.png",
        aspect_ratio: "9:16",
        duration: "8s",
        resolution: "720p",
        generate_audio: false,
      });
    });
  });

  it.effect("sends duration as 8s for Veo and a numeric string for Seedance and Kling", () => {
    const { http, seen } = fakeHttp(() => Response.json(submitted));
    return Effect.gen(function* () {
      yield* fal(http).start(video);
      yield* fal(http).start({ ...video, model: "bytedance/seedance-2.0/image-to-video" });
      yield* fal(http).start({
        ...video,
        model: "fal-ai/kling-video/v3/pro/image-to-video",
        options: { durationSeconds: 5 },
      });
      assert.strictEqual((seen[0]?.body as Record<string, unknown>)["duration"], "8s");
      assert.strictEqual((seen[1]?.body as Record<string, unknown>)["duration"], "8");
      assert.strictEqual((seen[2]?.body as Record<string, unknown>)["duration"], "5");
      assert.strictEqual(
        seen[1]?.url,
        "https://queue.fal.run/bytedance/seedance-2.0/image-to-video",
      );
    });
  });

  it.effect(
    "uses Kling V3's required starting frame field and omits unsupported size fields",
    () => {
      const { http, seen } = fakeHttp(() => Response.json(submitted));
      return Effect.gen(function* () {
        for (const tier of ["pro", "standard"]) {
          yield* fal(http).start({
            ...video,
            model: `fal-ai/kling-video/v3/${tier}/image-to-video`,
            options: { durationSeconds: 8, generateAudio: false },
          });
        }
        assert.strictEqual(seen.length, 2);
        for (const request of seen) {
          assert.deepStrictEqual(request.body, {
            prompt: video.prompt,
            start_image_url: video.firstFrameUrl,
            duration: "8",
            generate_audio: false,
          });
        }
      });
    },
  );

  it.effect("sends only the fields that have values, for text video and for an image", () => {
    const { http, seen } = fakeHttp(() => Response.json(submitted));
    return Effect.gen(function* () {
      yield* fal(http).start({
        ...video,
        model: "fal-ai/veo3.1",
        firstFrameUrl: undefined,
        options: {},
      });
      assert.deepStrictEqual(seen[0]?.body, { prompt: "A cake being cut" });
      yield* fal(http).start({
        kind: "image",
        model: "fal-ai/flux/dev",
        prompt: "A bouquet",
        options: { aspectRatio: "1:1" },
        name: "A bouquet",
      });
      assert.strictEqual(seen[1]?.url, "https://queue.fal.run/fal-ai/flux/dev");
      assert.deepStrictEqual(seen[1]?.body, {
        prompt: "A bouquet",
        image_size: { width: 1024, height: 1024 },
        num_images: 1,
      });
    });
  });

  it.effect("passes a data address first frame through as it is", () => {
    const { http, seen } = fakeHttp(() => Response.json(submitted));
    const frame = `data:image/png;base64,${Buffer.from("x").toString("base64")}`;
    return Effect.gen(function* () {
      yield* fal(http).start({ ...video, firstFrameUrl: frame });
      assert.strictEqual(seen.length, 1);
      assert.strictEqual((seen[0]?.body as Record<string, unknown>)["image_url"], frame);
    });
  });

  it.effect("refuses a first frame on a text-to-video model and none on image-to-video", () => {
    const { http, seen } = fakeHttp(() => Response.json(submitted));
    return Effect.gen(function* () {
      const text = yield* Effect.flip(fal(http).start({ ...video, model: "fal-ai/veo3.1" }));
      assert.include(text, "does not accept a starting image");
      const image = yield* Effect.flip(fal(http).start({ ...video, firstFrameUrl: undefined }));
      assert.include(image, "needs a starting image");
      assert.strictEqual(seen.length, 0);
      yield* fal(http).start({ ...video, model: "fal-ai/veo3.1", firstFrameUrl: undefined });
      yield* Effect.flip(fal(http).start({ ...video, model: "fal-ai/veo3.1" }));
      assert.strictEqual(seen.length, 1);
    });
  });

  it.effect("refuses an endpoint id that could change the address", () => {
    const { http, seen } = fakeHttp(() => Response.json(submitted));
    return Effect.gen(function* () {
      for (const model of ["veo3.1", "../account", "fal-ai//x", "a/b?x=1", "a b/c", "/a/b", ""]) {
        const reason = yield* Effect.flip(fal(http).start({ ...video, model }));
        assert.include(reason, "model name");
      }
      assert.strictEqual(seen.length, 0);
    });
  });

  it.effect("reports the provider's words, and a reply with no usable response address", () => {
    const answers = [
      Response.json({ error: "insufficient credits" }, { status: 402 }),
      Response.json({ request_id: "x" }),
      Response.json({ response_url: "https://evil.test/requests/1" }),
      Response.json({ response_url: "http://queue.fal.run/fal-ai/x/requests/1" }),
    ];
    let index = 0;
    const { http } = fakeHttp(() => answers[index++] as Response);
    return Effect.gen(function* () {
      assert.strictEqual(
        yield* Effect.flip(fal(http).start(video)),
        "fal.ai said: insufficient credits",
      );
      for (let i = 0; i < 3; i++) {
        const result = yield* fal(http).start(video);
        assert.strictEqual(result.kind, "uncertain");
        if (result.kind === "uncertain") assert.include(result.reason, "no usable result address");
      }
    });
  });

  it.effect("says so when there is no key, without calling anywhere", () => {
    const { http, seen } = fakeHttp(() => Response.json({}));
    const reason = "fal.ai has no key yet. Add one in Settings, Connections, Campaign Publishing.";
    return Effect.gen(function* () {
      assert.strictEqual(yield* Effect.flip(fal(http, null).start(video)), reason);
      assert.strictEqual(yield* Effect.flip(fal(http, null).poll(RESPONSE)), reason);
      assert.deepStrictEqual(yield* fal(http, null).test(), { ok: false, reason });
      assert.strictEqual(seen.length, 0);
    });
  });
});

describe("fal.ai poll", () => {
  it.effect("IN_QUEUE and IN_PROGRESS are running, and the status address is derived", () => {
    const answers = [{ status: "IN_QUEUE" }, { status: "IN_PROGRESS" }];
    let index = 0;
    const { http, seen } = fakeHttp(() => Response.json(answers[index++]));
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* fal(http).poll(RESPONSE), { state: "running" });
      assert.deepStrictEqual(yield* fal(http).poll(RESPONSE), { state: "running" });
      assert.strictEqual(seen[0]?.method, "GET");
      assert.strictEqual(seen[0]?.url, `${RESPONSE}/status`);
      assert.strictEqual(seen[0]?.headers["authorization"], "Key fal-key");
      assert.strictEqual(seen.length, 2);
    });
  });

  it.effect("COMPLETED then a video url is done", () => {
    const { http, seen } = fakeHttp((req) =>
      req.url.endsWith("/status")
        ? Response.json({ status: "COMPLETED" })
        : Response.json({ video: { url: "https://v3.fal.media/a.mp4" } }),
    );
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* fal(http).poll(RESPONSE), {
        state: "done",
        urls: ["https://v3.fal.media/a.mp4"],
      });
      assert.strictEqual(seen[1]?.url, RESPONSE);
      assert.strictEqual(seen[1]?.headers["authorization"], "Key fal-key");
    });
  });

  it.effect("COMPLETED then images is done with the first image", () => {
    const { http } = fakeHttp((req) =>
      req.url.endsWith("/status")
        ? Response.json({ status: "COMPLETED" })
        : Response.json({
            images: [{ url: "https://v3.fal.media/1.png" }, { url: "https://v3.fal.media/2.png" }],
          }),
    );
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* fal(http).poll(RESPONSE), {
        state: "done",
        urls: ["https://v3.fal.media/1.png"],
      });
    });
  });

  it.effect("COMPLETED with no link in the result is failed", () => {
    const { http } = fakeHttp((req) =>
      req.url.endsWith("/status") ? Response.json({ status: "COMPLETED" }) : Response.json({}),
    );
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* fal(http).poll(RESPONSE), {
        state: "failed",
        reason: "fal.ai did not return a link to the result.",
      });
    });
  });

  it.effect("COMPLETED then 422 or 500 with detail is failed with that sentence", () => {
    const answers = [
      { code: 422, body: { detail: "The prompt was blocked by the content policy." } },
      { code: 422, body: { detail: [{ msg: "image_url is not valid", type: "x" }] } },
      { code: 500, body: { detail: "Internal error" } },
      { code: 500, body: {} },
    ];
    let index = 0;
    const { http } = fakeHttp((req) => {
      if (req.url.endsWith("/status")) return Response.json({ status: "COMPLETED" });
      const answer = answers[index++];
      return Response.json(answer?.body, { status: answer?.code ?? 500 });
    });
    return Effect.gen(function* () {
      const reasons = [
        "fal.ai said: The prompt was blocked by the content policy.",
        "fal.ai said: image_url is not valid",
        "fal.ai said: Internal error",
        "fal.ai answered with HTTP 500.",
      ];
      for (const reason of reasons) {
        assert.deepStrictEqual(yield* fal(http).poll(RESPONSE), { state: "failed", reason });
      }
    });
  });

  it.effect("a 401 on status ends the job, a 500 and 429 are retried later", () => {
    let code = 401;
    const { http } = fakeHttp(() => Response.json({ error: "bad key" }, { status: code }));
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* fal(http).poll(RESPONSE), {
        state: "failed",
        reason: "fal.ai said: bad key",
      });
      code = 500;
      assert.include(yield* Effect.flip(fal(http).poll(RESPONSE)), "bad key");
      code = 429;
      assert.include(yield* Effect.flip(fal(http).poll(RESPONSE)), "bad key");
    });
  });

  it.effect("a status it cannot read is retried later", () => {
    const { http } = fakeHttp(() => Response.json({ nonsense: true }));
    return Effect.gen(function* () {
      assert.include(yield* Effect.flip(fal(http).poll(RESPONSE)), "cannot read");
    });
  });

  it.effect("a stored address not on queue.fal.run never makes a request", () => {
    const { http, seen } = fakeHttp(() => Response.json({ status: "COMPLETED" }));
    return Effect.gen(function* () {
      for (const stored of [
        "",
        "abc",
        "http://queue.fal.run/fal-ai/x/requests/1",
        "https://evil.test/fal-ai/x/requests/1",
        "https://queue.fal.run.evil.test/x/requests/1",
        "https://queue.fal.run@evil.test/x/requests/1",
        "https://user:pw@queue.fal.run/x/requests/1",
        "https://queue.fal.run:8443/x/requests/1",
        "https://queue.fal.run/x/requests/1?next=https://evil.test",
      ]) {
        assert.strictEqual((yield* fal(http).poll(stored)).state, "failed");
      }
      assert.strictEqual(seen.length, 0);
    });
  });
});

describe("fal.ai test and estimate", () => {
  it.effect("test() succeeds with a note when a key exists, calling nothing", () => {
    const { http, seen } = fakeHttp(() => Response.json({}));
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* fal(http).test(), {
        ok: true,
        notes:
          "The key is saved. fal.ai has no way to check a key without running a model, so the first video is the real test.",
      });
      assert.strictEqual(seen.length, 0);
    });
  });

  it("estimates an unknown cost", () => {
    const { http } = fakeHttp(() => Response.json({}));
    assert.deepStrictEqual(fal(http).estimate(video), {
      usd: null,
      note: "fal.ai charges per second of video; see the model's page for its rate.",
    });
  });
});

it.effect("fal rejects unsupported discrete duration and Fast resolution before submitting", () => {
  const { http, seen } = fakeHttp(() => Response.json(submitted));
  return Effect.gen(function* () {
    assert.include(
      yield* Effect.flip(
        fal(http).start({ ...video, options: { ...video.options, durationSeconds: 5 } }),
      ),
      "durations",
    );
    assert.include(
      yield* Effect.flip(
        fal(http).start({
          ...video,
          model: "bytedance/seedance-2.0/fast/image-to-video",
          options: { ...video.options, resolution: "1080p" },
        }),
      ),
      "resolution",
    );
    assert.strictEqual(seen.length, 0);
  });
});
