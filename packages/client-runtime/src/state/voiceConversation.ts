import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { Atom } from "effect/unstable/reactivity";
import type { HttpClient } from "effect/unstable/http";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";
import { createEnvironmentCommand } from "./runtime.ts";
import { EnvironmentHttpConnectionNotReadyError } from "./pullRequests.ts";

export function createVoiceConversationAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | HttpClient.HttpClient | R, E>,
) {
  const context = Effect.gen(function* () {
    const supervisor = yield* EnvironmentSupervisor;
    const prepared = yield* SubscriptionRef.get(supervisor.prepared);
    if (Option.isNone(prepared))
      return yield* new EnvironmentHttpConnectionNotReadyError({
        message: "Connect to this machine first.",
      });
    return {
      prepared: prepared.value,
      signer: yield* Effect.serviceOption(ManagedRelayDpopSigner),
      remoteAuthorization: yield* Effect.serviceOption(RemoteEnvironmentAuthorization),
    };
  });
  return {
    status: createEnvironmentCommand(runtime, {
      label: "voice:status",
      execute: (_input: Record<string, never>) =>
        Effect.gen(function* () {
          return yield* executeAuthenticatedEnvironmentHttpRequest({
            ...(yield* context),
            group: "voice",
            method: "GET",
            url: (base) => new URL("/api/voice", base).href,
            timeoutMs: 10000,
            request: ({ client, headers }) => client.status({ headers }),
          });
        }),
    }),
    configure: createEnvironmentCommand(runtime, {
      label: "voice:configure",
      execute: (input: { apiKey: string; provider?: "openai" | "elevenlabs" }) =>
        Effect.gen(function* () {
          return yield* executeAuthenticatedEnvironmentHttpRequest({
            ...(yield* context),
            group: "voice",
            method: "POST",
            url: (base) => new URL("/api/voice/configure", base).href,
            timeoutMs: 10000,
            request: ({ client, headers }) => client.configure({ headers, payload: input }),
          });
        }),
    }),
    token: createEnvironmentCommand(runtime, {
      label: "voice:elevenlabs-token",
      execute: (input: { purpose: "realtime_scribe" | "tts_websocket" }) =>
        Effect.gen(function* () {
          return yield* executeAuthenticatedEnvironmentHttpRequest({
            ...(yield* context),
            group: "voice",
            method: "POST",
            url: (base) => new URL("/api/voice/elevenlabs-token", base).href,
            timeoutMs: 20000,
            request: ({ client, headers }) => client.token({ headers, payload: input }),
          });
        }),
    }),
    create: createEnvironmentCommand(runtime, {
      label: "voice:create",
      execute: (input: { sdp: string; agentName: string }) =>
        Effect.gen(function* () {
          return yield* executeAuthenticatedEnvironmentHttpRequest({
            ...(yield* context),
            group: "voice",
            method: "POST",
            url: (base) => new URL("/api/voice/sessions", base).href,
            timeoutMs: 30000,
            request: ({ client, headers }) => client.create({ headers, payload: input }),
          });
        }),
    }),
  };
}
