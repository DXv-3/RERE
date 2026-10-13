import { expect, it } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthSessionId,
  EnvironmentHttpApi,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpPlatform, Etag } from "effect/unstable/http";
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi";
import * as VoiceConversation from "./VoiceConversation.ts";
import { voiceHttpApiLayer } from "./http.ts";
class Api extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.voice) {}
it("requires operate for calls and access:write for changing credentials", async () => {
  let creations = 0;
  let changes = 0;
  const scopes = new Set<AuthEnvironmentScope>(["orchestration:read"]);
  const app = HttpApiBuilder.layer(Api).pipe(
    Layer.provide(voiceHttpApiLayer),
    Layer.provide(
      Layer.succeed(VoiceConversation.VoiceConversation, {
        status: Effect.succeed({ configured: true, elevenLabsConfigured: true }),
        configure: () =>
          Effect.sync(() => {
            changes++;
            return { configured: true, elevenLabsConfigured: true };
          }),
        token: () =>
          Effect.sync(() => {
            creations++;
            return { token: "single-use" };
          }),
        create: () =>
          Effect.sync(() => {
            creations++;
            return { sessionId: "live", sdp: "answer" };
          }),
      }),
    ),
    Layer.provide(
      Layer.succeed(EnvironmentAuthenticatedAuth, (effect) =>
        effect.pipe(
          Effect.provideService(EnvironmentAuthenticatedPrincipal, {
            sessionId: AuthSessionId.make("test"),
            subject: "owner",
            method: "browser-session-cookie",
            scopes,
          }),
        ),
      ),
    ),
    Layer.provide(
      HttpPlatform.layer.pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(Etag.layerWeak),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(app, { disableLogger: true });
  const request = (path: string, body: string) =>
    handler(
      new Request(`http://localhost${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
    );
  try {
    expect(
      (await request("/api/voice/sessions", '{"sdp":"offer","agentName":"Builder"}')).status,
    ).toBe(403);
    expect((await request("/api/voice/configure", '{"apiKey":"secret"}')).status).toBe(403);
    expect(
      (await request("/api/voice/elevenlabs-token", '{"purpose":"tts_websocket"}')).status,
    ).toBe(403);
    expect(creations).toBe(0);
    expect(changes).toBe(0);
    scopes.add("orchestration:operate");
    expect(
      (await request("/api/voice/sessions", '{"sdp":"offer","agentName":"Builder"}')).status,
    ).toBe(200);
    expect(creations).toBe(1);
    expect(
      (await request("/api/voice/elevenlabs-token", '{"purpose":"realtime_scribe"}')).status,
    ).toBe(200);
    expect(creations).toBe(2);
    expect((await request("/api/voice/configure", '{"apiKey":"secret"}')).status).toBe(403);
    scopes.add("access:write");
    expect((await request("/api/voice/configure", '{"apiKey":"secret"}')).status).toBe(200);
    expect(changes).toBe(1);
  } finally {
    await dispose();
  }
});
