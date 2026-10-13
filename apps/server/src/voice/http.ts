import {
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { requireEnvironmentScope } from "../auth/http.ts";
import * as VoiceConversation from "./VoiceConversation.ts";
export const voiceHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "voice",
  Effect.fnUntraced(function* (handlers) {
    const voice = yield* VoiceConversation.VoiceConversation;
    return handlers
      .handle("status", () =>
        requireEnvironmentScope(AuthOrchestrationReadScope).pipe(Effect.andThen(voice.status)),
      )
      .handle("configure", ({ payload }) =>
        requireEnvironmentScope(AuthAccessWriteScope).pipe(
          Effect.andThen(voice.configure(payload.apiKey, payload.provider)),
        ),
      )
      .handle("token", ({ payload }) =>
        requireEnvironmentScope(AuthOrchestrationOperateScope).pipe(
          Effect.andThen(voice.token(payload.purpose)),
        ),
      )
      .handle("create", ({ payload }) =>
        requireEnvironmentScope(AuthOrchestrationOperateScope).pipe(
          Effect.andThen(voice.create(payload)),
        ),
      );
  }),
);
