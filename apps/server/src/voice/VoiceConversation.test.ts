import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as VoiceConversation from "./VoiceConversation.ts";
function setup(status = 201, eleven = false) {
  const values = new Map<string, Uint8Array>();
  const urls: string[] = [];
  let calls = 0;
  const secrets = Layer.succeed(ServerSecretStore.ServerSecretStore, {
    get: (key) => Effect.sync(() => Option.fromNullishOr(values.get(key))),
    set: (key, value) =>
      Effect.sync(() => {
        values.set(key, value);
      }),
    remove: (key) =>
      Effect.sync(() => {
        values.delete(key);
      }),
    create: () => Effect.die("unexpected"),
    getOrCreateRandom: () => Effect.die("unexpected"),
  });
  const http = HttpClient.make((request) => {
    calls++;
    urls.push(request.url);
    if (eleven) {
      expect(request.url).toMatch(
        /^https:\/\/api\.elevenlabs\.io\/v1\/single-use-token\/(realtime_scribe|ttd_websocket)$/,
      );
      expect(request.headers["xi-api-key"]).toBe("eleven-secret");
      expect(request.headers.authorization).toBeUndefined();
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({ token: "single-use", secret: "never-return" }, { status }),
        ),
      );
    }
    expect(request.url).toBe("https://api.openai.com/v1/live/sessions");
    expect(request.headers.authorization).toBe("Bearer test-secret");
    if (request.body._tag === "Uint8Array") {
      const body = JSON.parse(new TextDecoder().decode(request.body.body));
      expect(body.session.model).toBe("gpt-live-1");
      expect(body.session.store).toBe(false);
      expect(body.session.delegation).toEqual({ type: "client" });
      expect(body.transport).toEqual({ type: "webrtc", sdp: "offer" });
    }
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        Response.json(
          {
            session: { id: "live_test" },
            transport: { sdp: "answer" },
            secret: "never-return",
          },
          { status },
        ),
      ),
    );
  });
  const layer = VoiceConversation.layer.pipe(
    Layer.provide(secrets),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
  );
  return { layer, calls: () => calls, urls };
}
describe("VoiceConversation", () => {
  it.effect("keeps provider keys separate and issues only single-use ElevenLabs tokens", () => {
    const s = setup(200, true);
    return Effect.gen(function* () {
      const voice = yield* VoiceConversation.VoiceConversation;
      expect((yield* voice.token("realtime_scribe").pipe(Effect.flip)).reason).toBe(
        "not_configured",
      );
      yield* voice.configure("test-secret");
      yield* voice.configure("eleven-secret", "elevenlabs");
      expect(yield* voice.status).toEqual({ configured: true, elevenLabsConfigured: true });
      expect(yield* voice.token("realtime_scribe")).toEqual({ token: "single-use" });
      expect(yield* voice.token("tts_websocket")).toEqual({ token: "single-use" });
      expect(s.urls).toEqual([
        "https://api.elevenlabs.io/v1/single-use-token/realtime_scribe",
        "https://api.elevenlabs.io/v1/single-use-token/ttd_websocket",
      ]);
      yield* voice.configure("", "elevenlabs");
      expect(yield* voice.status).toEqual({ configured: true, elevenLabsConfigured: false });
      expect((yield* voice.token("tts_websocket").pipe(Effect.flip)).reason).toBe("not_configured");
      expect(s.calls()).toBe(2);
    }).pipe(Effect.provide(s.layer));
  });
  it.effect("does not retry or expose ElevenLabs provider errors", () => {
    const s = setup(429, true);
    return Effect.gen(function* () {
      const voice = yield* VoiceConversation.VoiceConversation;
      yield* voice.configure("eleven-secret", "elevenlabs");
      const error = yield* voice.token("tts_websocket").pipe(Effect.flip);
      expect(error.reason).toBe("provider");
      expect(error.message).not.toContain("never-return");
      expect(s.calls()).toBe(1);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("requires a configured API key before billing", () => {
    const s = setup();
    return Effect.gen(function* () {
      const voice = yield* VoiceConversation.VoiceConversation;
      expect(yield* voice.status).toEqual({ configured: false, elevenLabsConfigured: false });
      expect(
        (yield* voice.create({ sdp: "offer", agentName: "Builder" }).pipe(Effect.flip)).reason,
      ).toBe("not_configured");
      expect(s.calls()).toBe(0);
    }).pipe(Effect.provide(s.layer));
  });
  it.effect("returns only the answer and can disconnect the stored key", () => {
    const s = setup();
    return Effect.gen(function* () {
      const voice = yield* VoiceConversation.VoiceConversation;
      yield* voice.configure("test-secret");
      expect(yield* voice.create({ sdp: "offer", agentName: "Builder" })).toEqual({
        sessionId: "live_test",
        sdp: "answer",
      });
      expect(yield* voice.configure("")).toEqual({
        configured: false,
        elevenLabsConfigured: false,
      });
      expect(s.calls()).toBe(1);
    }).pipe(Effect.provide(s.layer));
  });
  it.effect("does not retry provider errors or leak response data", () => {
    const s = setup(429);
    return Effect.gen(function* () {
      const voice = yield* VoiceConversation.VoiceConversation;
      yield* voice.configure("test-secret");
      const result = yield* voice.create({ sdp: "offer", agentName: "Builder" }).pipe(Effect.flip);
      expect(result.reason).toBe("provider");
      expect(result.message).not.toContain("never-return");
      expect(s.calls()).toBe(1);
    }).pipe(Effect.provide(s.layer));
  });
  it.effect("rejects invalid input before billing", () => {
    const s = setup();
    return Effect.gen(function* () {
      const voice = yield* VoiceConversation.VoiceConversation;
      yield* voice.configure("test-secret");
      expect(
        (yield* voice.create({ sdp: " ", agentName: "Builder" }).pipe(Effect.flip)).reason,
      ).toBe("invalid_input");
      expect(s.calls()).toBe(0);
    }).pipe(Effect.provide(s.layer));
  });
});
