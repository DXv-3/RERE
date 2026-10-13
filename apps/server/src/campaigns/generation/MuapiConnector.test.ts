import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { describe } from "vite-plus/test";

import type { GenerationRequest } from "./GenerationConnector.ts";
import {
  DEFAULT_MUAPI_IMAGE_MODEL,
  DEFAULT_MUAPI_TEXT_VIDEO_MODEL,
  DEFAULT_MUAPI_VIDEO_MODEL,
  KNOWN_MUAPI_VIDEO_MODELS,
  makeMuapiConnector,
} from "./MuapiConnector.ts";

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

/** A client that answers each call from a script and records what it was sent, uploads included. */
const fakeHttp = (script: (request: HttpClientRequest.HttpClientRequest) => Response) => {
  const seen: Seen[] = [];
  const http = HttpClient.make((req) => {
    let body: unknown;
    if (req.body._tag === "Uint8Array") {
      body = JSON.parse(new TextDecoder().decode(req.body.body)) as unknown;
    } else if (req.body._tag === "FormData") {
      const file = req.body.formData.get("file");
      body =
        file instanceof File ? { file: { name: file.name, type: file.type, size: file.size } } : {};
    }
    seen.push({ method: req.method, url: req.url, headers: req.headers, body });
    return Effect.succeed(HttpClientResponse.fromWeb(req, script(req)));
  });
  return { http, seen };
};

const muapi = (http: HttpClient.HttpClient, key: string | null = "mu-key") =>
  makeMuapiConnector({ http, config: Effect.succeed(key === null ? null : { apiKey: key }) });

const video: GenerationRequest = {
  kind: "video",
  model: "veo3.1-image-to-video",
  prompt: "A cake being cut",
  options: { aspectRatio: "9:16", durationSeconds: 8, resolution: "720p" },
  firstFrameUrl: "https://cdn.test/first.png",
  name: "A cake being cut",
};

describe("MuAPI defaults", () => {
  it("names the documented slugs and the guessed defaults", () => {
    assert.strictEqual(DEFAULT_MUAPI_VIDEO_MODEL, "veo3.1-image-to-video");
    assert.strictEqual(DEFAULT_MUAPI_TEXT_VIDEO_MODEL, "veo3.1-text-to-video");
    assert.strictEqual(DEFAULT_MUAPI_IMAGE_MODEL, "flux-dev");
    assert.include(KNOWN_MUAPI_VIDEO_MODELS, "minimax-hailuo-02-pro-i2v");
  });
});

describe("MuAPI start", () => {
  it.effect("posts the model's body with the x-api-key header and returns the bare id", () => {
    const { http, seen } = fakeHttp(() =>
      Response.json({ request_id: "abc-1", status: "processing" }),
    );
    return Effect.gen(function* () {
      const started = yield* muapi(http).start(video);
      assert.deepStrictEqual(started, { kind: "async", providerJobId: "abc-1" });
      assert.strictEqual(seen[0]?.method, "POST");
      assert.strictEqual(seen[0]?.url, "https://api.muapi.ai/api/v1/veo3.1-image-to-video");
      assert.strictEqual(seen[0]?.headers["x-api-key"], "mu-key");
      assert.deepStrictEqual(seen[0]?.body, {
        prompt: "A cake being cut",
        image_url: "https://cdn.test/first.png",
        aspect_ratio: "9:16",
        duration: 8,
        resolution: "720p",
      });
    });
  });

  it.effect("sends only the fields that have values, for text video and for an image", () => {
    const { http, seen } = fakeHttp(() => Response.json({ request_id: "abc-2" }));
    return Effect.gen(function* () {
      yield* muapi(http).start({
        ...video,
        model: "veo3.1-text-to-video",
        firstFrameUrl: undefined,
        options: {},
      });
      assert.deepStrictEqual(seen[0]?.body, { prompt: "A cake being cut" });
      yield* muapi(http).start({
        kind: "image",
        model: "flux-dev",
        prompt: "A bouquet",
        options: { aspectRatio: "1:1" },
        name: "A bouquet",
      });
      assert.strictEqual(seen[1]?.url, "https://api.muapi.ai/api/v1/flux-dev");
      assert.deepStrictEqual(seen[1]?.body, {
        prompt: "A bouquet",
        width: 1024,
        height: 1024,
        num_images: 1,
      });
    });
  });

  it.effect("uploads a data address first and uses the link MuAPI returns", () => {
    const { http, seen } = fakeHttp((req) =>
      req.url.endsWith("/upload_file")
        ? Response.json({ data: { url: "https://cdn.muapi.test/up.png" } })
        : Response.json({ request_id: "abc-3" }),
    );
    const pixel = Buffer.from("not really a png").toString("base64");
    return Effect.gen(function* () {
      const started = yield* muapi(http).start({
        ...video,
        firstFrameUrl: `data:image/png;base64,${pixel}`,
      });
      assert.deepStrictEqual(started, { kind: "async", providerJobId: "abc-3" });
      assert.strictEqual(seen[0]?.url, "https://api.muapi.ai/api/v1/upload_file");
      assert.strictEqual(seen[0]?.headers["x-api-key"], "mu-key");
      assert.deepStrictEqual(seen[0]?.body, {
        file: { name: "first-frame.png", type: "image/png", size: 16 },
      });
      assert.strictEqual(
        (seen[1]?.body as Record<string, unknown>)["image_url"],
        "https://cdn.muapi.test/up.png",
      );
    });
  });

  it.effect("reads the uploaded link from url or file_url too", () => {
    const answers = [{ url: "https://cdn.test/1.png" }, { file_url: "https://cdn.test/2.png" }];
    let index = 0;
    const { http, seen } = fakeHttp((req) =>
      req.url.endsWith("/upload_file")
        ? Response.json(answers[index++])
        : Response.json({ request_id: "abc-4" }),
    );
    const frame = `data:image/jpeg;base64,${Buffer.from("x").toString("base64")}`;
    return Effect.gen(function* () {
      yield* muapi(http).start({ ...video, firstFrameUrl: frame });
      yield* muapi(http).start({ ...video, firstFrameUrl: frame });
      assert.strictEqual(
        (seen[1]?.body as Record<string, unknown>)["image_url"],
        "https://cdn.test/1.png",
      );
      assert.strictEqual(
        (seen[3]?.body as Record<string, unknown>)["image_url"],
        "https://cdn.test/2.png",
      );
    });
  });

  it.effect("a failed upload is a plain start error and nothing is submitted", () => {
    const { http, seen } = fakeHttp((req) =>
      req.url.endsWith("/upload_file")
        ? Response.json({ error: "file too large" }, { status: 413 })
        : Response.json({ request_id: "never" }),
    );
    const frame = `data:image/png;base64,${Buffer.from("x").toString("base64")}`;
    return Effect.gen(function* () {
      const reason = yield* Effect.flip(muapi(http).start({ ...video, firstFrameUrl: frame }));
      assert.include(reason, "could not take the starting image");
      assert.include(reason, "file too large");
      assert.strictEqual(seen.length, 1);
    });
  });

  it.effect("an upload answer with no link is a start error", () => {
    const { http } = fakeHttp(() => Response.json({ ok: true }));
    const frame = `data:image/png;base64,${Buffer.from("x").toString("base64")}`;
    return Effect.gen(function* () {
      const reason = yield* Effect.flip(muapi(http).start({ ...video, firstFrameUrl: frame }));
      assert.include(reason, "sent no link");
    });
  });

  it.effect(
    "tells the person to pick an image-to-video model when a first frame meets a text model",
    () => {
      const { http, seen } = fakeHttp(() => Response.json({ request_id: "never" }));
      return Effect.gen(function* () {
        const reason = yield* Effect.flip(
          muapi(http).start({ ...video, model: "veo3.1-text-to-video" }),
        );
        assert.include(reason, "does not accept a starting image");
        assert.strictEqual(seen.length, 0);
      });
    },
  );

  it.effect("says an image-to-video model needs a starting image", () => {
    const { http, seen } = fakeHttp(() => Response.json({ request_id: "never" }));
    return Effect.gen(function* () {
      for (const model of ["veo3.1-image-to-video", "minimax-hailuo-02-pro-i2v"]) {
        const reason = yield* Effect.flip(
          muapi(http).start({ ...video, model, firstFrameUrl: undefined }),
        );
        assert.include(reason, "needs a starting image");
      }
      assert.strictEqual(seen.length, 0);
    });
  });

  it.effect("refuses a model slug that could change the address", () => {
    const { http, seen } = fakeHttp(() => Response.json({ request_id: "never" }));
    return Effect.gen(function* () {
      for (const model of ["../account/balance", "a/b", "x?y=1", "a b"]) {
        const reason = yield* Effect.flip(muapi(http).start({ ...video, model }));
        assert.include(reason, "model name");
      }
      assert.strictEqual(seen.length, 0);
    });
  });

  it.effect("reports the provider's words when it refuses, and a reply with no usable id", () => {
    const answers = [
      Response.json({ error: "insufficient credits" }, { status: 402 }),
      Response.json({ request_id: "../x" }),
      Response.json({ status: "processing" }),
    ];
    let index = 0;
    const { http } = fakeHttp(() => answers[index++] as Response);
    return Effect.gen(function* () {
      assert.strictEqual(
        yield* Effect.flip(muapi(http).start(video)),
        "MuAPI said: insufficient credits",
      );
      {
        const result = yield* muapi(http).start(video);
        assert.strictEqual(result.kind, "uncertain");
        if (result.kind === "uncertain") assert.include(result.reason, "no usable job id");
      }
      {
        const result = yield* muapi(http).start(video);
        assert.strictEqual(result.kind, "uncertain");
        if (result.kind === "uncertain") assert.include(result.reason, "no usable job id");
      }
    });
  });

  it.effect("says so when there is no key, without calling anywhere", () => {
    const { http, seen } = fakeHttp(() => Response.json({}));
    return Effect.gen(function* () {
      assert.include(yield* Effect.flip(muapi(http, null).start(video)), "no key yet");
      assert.include(yield* Effect.flip(muapi(http, null).poll("abc")), "no key yet");
      assert.deepStrictEqual(yield* muapi(http, null).test(), {
        ok: false,
        reason: "MuAPI has no key yet. Add one in Settings, Connections, Campaign Publishing.",
      });
      assert.strictEqual(seen.length, 0);
    });
  });
});

describe("MuAPI poll", () => {
  it.effect("reads running, completed, failed and cancelled", () => {
    const answers = [
      { status: "queued" },
      { status: "pending" },
      { status: "processing" },
      { id: "abc", status: "completed", outputs: ["https://cdn.test/a.mp4", "https://x.test/b"] },
      { status: "failed", error: "content policy" },
      { status: "failed" },
      { status: "cancelled" },
    ];
    let index = 0;
    const { http, seen } = fakeHttp(() => Response.json(answers[index++]));
    const connector = muapi(http);
    const poll = () => connector.poll("abc");
    return Effect.gen(function* () {
      for (let i = 0; i < 3; i++) assert.deepStrictEqual(yield* poll(), { state: "running" });
      assert.deepStrictEqual(yield* poll(), { state: "done", urls: ["https://cdn.test/a.mp4"] });
      assert.deepStrictEqual(yield* poll(), {
        state: "failed",
        reason: "MuAPI said: content policy",
      });
      assert.deepStrictEqual(yield* poll(), {
        state: "failed",
        reason: "MuAPI reported the job as failed.",
      });
      assert.deepStrictEqual(yield* poll(), {
        state: "failed",
        reason: "MuAPI reported the job as cancelled.",
      });
      assert.strictEqual(seen[0]?.method, "GET");
      assert.strictEqual(seen[0]?.url, "https://api.muapi.ai/api/v1/predictions/abc/result");
      assert.strictEqual(seen[0]?.headers["x-api-key"], "mu-key");
    });
  });

  it.effect("completed with no outputs is failed", () => {
    const answers = [{ status: "completed" }, { status: "completed", outputs: [] }];
    let index = 0;
    const { http } = fakeHttp(() => Response.json(answers[index++]));
    return Effect.gen(function* () {
      for (let i = 0; i < 2; i++) {
        assert.deepStrictEqual(yield* muapi(http).poll("abc"), {
          state: "failed",
          reason: "MuAPI did not return a video link.",
        });
      }
    });
  });

  it.effect("a 401 ends the job, a 500 and 429 are retried later", () => {
    let code = 401;
    const { http } = fakeHttp(() => Response.json({ error: "bad key" }, { status: code }));
    const connector = muapi(http);
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* connector.poll("abc"), {
        state: "failed",
        reason: "MuAPI said: bad key",
      });
      code = 500;
      assert.include(yield* Effect.flip(connector.poll("abc")), "bad key");
      code = 429;
      assert.include(yield* Effect.flip(connector.poll("abc")), "bad key");
    });
  });

  it.effect("a status it cannot read is retried later", () => {
    const { http } = fakeHttp(() => Response.json({ nonsense: true }));
    return Effect.gen(function* () {
      assert.include(yield* Effect.flip(muapi(http).poll("abc")), "cannot read");
    });
  });

  it.effect("a bad job id never makes a request, so the key goes nowhere else", () => {
    const { http, seen } = fakeHttp(() => Response.json({ status: "completed" }));
    return Effect.gen(function* () {
      for (const id of ["", "../x", "a/b", "https://evil.test/x", "a?b=1", "x".repeat(201)]) {
        assert.strictEqual((yield* muapi(http).poll(id)).state, "failed");
      }
      assert.strictEqual(seen.length, 0);
    });
  });
});

describe("MuAPI test and estimate", () => {
  it.effect("test() checks the balance and notes a readable figure", () => {
    const answers = [
      Response.json({ balance: 12.5 }),
      Response.json({ data: { balance: 3 } }),
      Response.json({ balance: "lots" }),
      Response.json({ error: "bad key" }, { status: 401 }),
    ];
    let index = 0;
    const { http, seen } = fakeHttp(() => answers[index++] as Response);
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* muapi(http).test(), {
        ok: true,
        notes: "MuAPI reports a balance of 12.5.",
      });
      assert.deepStrictEqual(yield* muapi(http).test(), {
        ok: true,
        notes: "MuAPI reports a balance of 3.",
      });
      assert.deepStrictEqual(yield* muapi(http).test(), { ok: true });
      assert.deepStrictEqual(yield* muapi(http).test(), {
        ok: false,
        reason: "MuAPI said: bad key",
      });
      assert.strictEqual(seen[0]?.url, "https://api.muapi.ai/api/v1/account/balance");
      assert.strictEqual(seen[0]?.headers["x-api-key"], "mu-key");
    });
  });

  it("estimates an unknown cost", () => {
    const { http } = fakeHttp(() => Response.json({}));
    assert.deepStrictEqual(muapi(http).estimate(video), {
      usd: null,
      note: "MuAPI charges per video; see its pricing page for this model.",
    });
  });
});

it.effect(
  "MuAPI rejects both audio toggle values rather than claiming it can mute native audio",
  () => {
    const { http, seen } = fakeHttp(() => Response.json({ request_id: "unused" }));
    return Effect.gen(function* () {
      for (const generateAudio of [false, true]) {
        assert.include(
          yield* Effect.flip(
            muapi(http).start({ ...video, options: { ...video.options, generateAudio } }),
          ),
          "no audio toggle",
        );
      }
      assert.strictEqual(seen.length, 0);
    });
  },
);
