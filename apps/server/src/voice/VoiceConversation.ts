import {
  VoiceConversationError,
  VoiceTokenAnswer,
  type VoiceTokenPurpose,
  type VoiceConversationStatus,
  type VoiceConversationCreate,
  type VoiceConversationAnswer,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

const SECRET = "workbench-voice-openai";
const ELEVEN_SECRET = "workbench-voice-elevenlabs";
const decodeVoiceToken = Schema.decodeUnknownEffect(VoiceTokenAnswer);
const answer = Schema.Struct({
  session: Schema.Struct({ id: Schema.String }),
  transport: Schema.Struct({ sdp: Schema.String }),
});
export class VoiceConversation extends Context.Service<
  VoiceConversation,
  {
    readonly status: Effect.Effect<typeof VoiceConversationStatus.Type, VoiceConversationError>;
    readonly configure: (
      key: string,
      provider?: "openai" | "elevenlabs",
    ) => Effect.Effect<typeof VoiceConversationStatus.Type, VoiceConversationError>;
    readonly token: (
      purpose: typeof VoiceTokenPurpose.Type,
    ) => Effect.Effect<typeof VoiceTokenAnswer.Type, VoiceConversationError>;
    readonly create: (
      input: typeof VoiceConversationCreate.Type,
    ) => Effect.Effect<typeof VoiceConversationAnswer.Type, VoiceConversationError>;
  }
>()("t3/voice/VoiceConversation") {}
const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const client = yield* HttpClient.HttpClient;
  const read = secrets
    .get(SECRET)
    .pipe(Effect.mapError(() => new VoiceConversationError({ reason: "storage" })));
  const elevenRead = secrets
    .get(ELEVEN_SECRET)
    .pipe(Effect.mapError(() => new VoiceConversationError({ reason: "storage" })));
  const status = Effect.gen(function* () {
    return {
      configured: Option.isSome(yield* read),
      elevenLabsConfigured: Option.isSome(yield* elevenRead),
    };
  });
  return VoiceConversation.of({
    status,
    configure: Effect.fn(function* (input, provider = "openai") {
      const key = input.trim();
      if (key && (/\s/.test(key) || key.length > 1024))
        return yield* new VoiceConversationError({ reason: "invalid_input" });
      const secretName = provider === "elevenlabs" ? ELEVEN_SECRET : SECRET;
      yield* (
        key ? secrets.set(secretName, new TextEncoder().encode(key)) : secrets.remove(secretName)
      ).pipe(Effect.mapError(() => new VoiceConversationError({ reason: "storage" })));
      return yield* status;
    }),
    token: Effect.fn(function* (purpose) {
      if (purpose !== "realtime_scribe" && purpose !== "tts_websocket")
        return yield* new VoiceConversationError({ reason: "invalid_input" });
      const key = yield* elevenRead;
      if (Option.isNone(key))
        return yield* new VoiceConversationError({ reason: "not_configured" });
      // Keep the existing client purpose compatible, but dialogue sockets require
      // their own token type; ElevenLabs rejects TTS tokens with invalid_token_type.
      const tokenType = purpose === "tts_websocket" ? "ttd_websocket" : purpose;
      return yield* Effect.gen(function* () {
        const response = yield* client.execute(
          HttpClientRequest.post(`https://api.elevenlabs.io/v1/single-use-token/${tokenType}`).pipe(
            HttpClientRequest.setHeader("xi-api-key", new TextDecoder().decode(key.value)),
          ),
        );
        if (response.status !== 200)
          return yield* new VoiceConversationError({ reason: "provider" });
        return yield* decodeVoiceToken(yield* response.json);
      }).pipe(
        Effect.timeout("15 seconds"),
        Effect.mapError(() => new VoiceConversationError({ reason: "provider" })),
      );
    }),
    create: Effect.fn(function* (input) {
      if (
        !input.sdp.trim() ||
        input.sdp.length > 65536 ||
        !input.agentName.trim() ||
        input.agentName.length > 200
      )
        return yield* new VoiceConversationError({ reason: "invalid_input" });
      const key = yield* read;
      if (Option.isNone(key))
        return yield* new VoiceConversationError({ reason: "not_configured" });
      // Creating sessions bills duration. Never retry a creation whose outcome is unknown.
      return yield* Effect.gen(function* () {
        const request = yield* HttpClientRequest.post(
          "https://api.openai.com/v1/live/sessions",
        ).pipe(
          HttpClientRequest.bearerToken(Redacted.make(new TextDecoder().decode(key.value))),
          HttpClientRequest.bodyJson({
            session: {
              model: "gpt-live-1",
              store: false,
              delegation: { type: "client" },
              client: {
                data_channel: {
                  allowed_client_events: [
                    "session.close",
                    "session.commentary.append",
                    "session.thinking.append",
                  ],
                },
              },
              instructions: `You are the conversational voice of the CodeWrench agent named ${input.agentName.replace(/[\r\n]/g, " ")}. Speak naturally and briefly. Delegate project questions, requests to do work, and corrections to the backend agent. Keep talking while it works. Never claim work succeeded or was cancelled until backend confirmation. Interrupting speech does not cancel work. Existing permissions and approval requests remain in CodeWrench. Ask when a transcript is ambiguous.`,
            },
            transport: { type: "webrtc", sdp: input.sdp },
          }),
        );
        const response = yield* client.execute(request);
        if (response.status !== 201)
          return yield* new VoiceConversationError({ reason: "provider" });
        const result = yield* Schema.decodeUnknownEffect(answer)(yield* response.json);
        return { sessionId: result.session.id, sdp: result.transport.sdp };
      }).pipe(
        Effect.timeout("25 seconds"),
        Effect.mapError(() => new VoiceConversationError({ reason: "provider" })),
      );
    }),
  });
});
export const layer = Layer.effect(VoiceConversation, make);
