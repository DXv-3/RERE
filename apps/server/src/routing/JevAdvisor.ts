import * as NodeCrypto from "node:crypto";
import {
  type JevAdvice,
  type JevRequest,
  type JevConnectionInput,
  type JevConnectionState,
  RoutingJudgmentError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SelectionBudgetStore from "./SelectionBudgetStore.ts";
import {
  JEV_RESERVATION_MICRO_USD,
  jevTransportForKey,
  makeJevRequest,
  readJevAdvice,
  readJevReceipt,
  readTypeSafeReceipt,
  TYPESAFE_ENDPOINT,
  validateJevPrice,
} from "./jevProtocol.ts";

// A key from console.typesafe.ai is preferred; an OpenRouter key is the older way in.
const TYPESAFE_SECRET = "workbench-jev-typesafe";
const OPENROUTER_SECRET = "workbench-jev-openrouter";

interface SelectionInput {
  task: string;
  skills: readonly { name: string; description: string }[];
  scope?: { instanceId: string | null; cwd: string | null; catalogRevision?: string };
}

export class JevAdvisor extends Context.Service<
  JevAdvisor,
  {
    readonly configure: (
      input: JevConnectionInput,
    ) => Effect.Effect<JevConnectionState, RoutingJudgmentError>;
    readonly configured: Effect.Effect<boolean>;
    readonly recover: (input: SelectionInput) => Effect.Effect<JevRequest, RoutingJudgmentError>;
    readonly assess: (
      input: SelectionInput & { requestId: string },
    ) => Effect.Effect<JevAdvice, RoutingJudgmentError>;
  }
>()("t3/routing/JevAdvisor") {}
const encodeRequest = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const budget = yield* SelectionBudgetStore.SelectionBudgetStore;
  const client = yield* HttpClient.HttpClient;
  const readKey = (name: string) =>
    secrets.get(name).pipe(
      Effect.map((secret) => {
        if (Option.isNone(secret)) return null;
        const key = new TextDecoder().decode(secret.value).trim();
        return !key || key.length > 512 || /\s/.test(key) ? null : key;
      }),
      Effect.catch(() => Effect.succeed(null)),
    );
  const connection = Effect.gen(function* () {
    const typesafe = yield* readKey(TYPESAFE_SECRET);
    if (typesafe) return { transport: "typesafe" as const, key: typesafe };
    const openrouter = yield* readKey(OPENROUTER_SECRET);
    return openrouter ? { transport: "openrouter" as const, key: openrouter } : null;
  });
  const identify = Effect.fn("JevAdvisor.identify")(function* (input: SelectionInput) {
    const transport = (yield* connection)?.transport ?? "openrouter";
    const request = yield* Effect.try({
      try: () => makeJevRequest(input.task, input.skills, transport),
      catch: () => new RoutingJudgmentError({ reason: "invalid_input" }),
    });
    const encoded = yield* encodeRequest(request.body).pipe(
      Effect.mapError(() => new RoutingJudgmentError({ reason: "invalid_input" })),
    );
    const fingerprint = NodeCrypto.createHash("sha256").update(encoded).digest("hex");
    const identity = yield* encodeRequest([
      "jev-recovery-v1",
      fingerprint,
      input.scope?.instanceId ?? null,
      input.scope?.cwd ?? null,
      ...(input.scope?.catalogRevision ? [input.scope.catalogRevision] : []),
    ]).pipe(Effect.mapError(() => new RoutingJudgmentError({ reason: "invalid_input" })));
    const requestId = `jev1_${NodeCrypto.createHash("sha256").update(identity).digest("hex")}`;
    return { request, fingerprint, requestId };
  });
  const recover = Effect.fn("JevAdvisor.recover")(function* (input: SelectionInput) {
    const identity = yield* identify(input);
    return yield* budget
      .inspect(identity.requestId, identity.fingerprint)
      .pipe(Effect.mapError(() => new RoutingJudgmentError({ reason: "storage" })));
  });
  const assess = Effect.fn("JevAdvisor.assess")(function* (
    input: SelectionInput & { requestId: string },
  ) {
    const { request, fingerprint, requestId } = yield* identify(input);
    // Legacy clients retain exact-ID replay. Recoverable clients cannot submit stale candidates.
    if (input.requestId.startsWith("jev1_") && input.requestId !== requestId)
      return yield* new RoutingJudgmentError({ reason: "stale_preview" });
    const previous = yield* budget
      .inspect(input.requestId, fingerprint)
      .pipe(Effect.mapError(() => new RoutingJudgmentError({ reason: "storage" })));
    if (previous.advice) return previous.advice;
    if (previous.state !== "new")
      return yield* new RoutingJudgmentError({ reason: "already_requested" });
    const connected = yield* connection;
    if (!connected) return yield* new RoutingJudgmentError({ reason: "not_configured" });
    const { key, transport } = connected;
    // OpenRouter can route to another provider or price; TypeSafe's own API has one of each.
    if (transport === "openrouter")
      yield* Effect.gen(function* () {
        const metadata = yield* client.get(
          "https://openrouter.ai/api/v1/models/typesafe/jev-1.13/endpoints",
        );
        if (metadata.status !== 200)
          return yield* new RoutingJudgmentError({ reason: "price_unavailable" });
        const value = yield* metadata.json;
        yield* Effect.try(() => validateJevPrice(value));
      }).pipe(
        Effect.timeout("10 seconds"),
        Effect.mapError(() => new RoutingJudgmentError({ reason: "price_unavailable" })),
      );
    const httpRequest = yield* HttpClientRequest.post(
      transport === "typesafe" ? TYPESAFE_ENDPOINT : "https://openrouter.ai/api/alpha/decisions",
    ).pipe(
      HttpClientRequest.bearerToken(Redacted.make(key)),
      HttpClientRequest.bodyJson(request.body),
      Effect.mapError(() => new RoutingJudgmentError({ reason: "invalid_input" })),
    );
    // A cancellation cannot strand a known-unsent reservation between admission and claim.
    // Once claimed, ambiguity is retained even if the caller disconnects before receiving a reply.
    yield* Effect.gen(function* () {
      const reservation = yield* budget
        .reserve({
          requestId: input.requestId,
          fingerprint,
          maxCostMicroUsd: JEV_RESERVATION_MICRO_USD,
        })
        .pipe(Effect.mapError(() => new RoutingJudgmentError({ reason: "budget_blocked" })));
      if (!reservation.created)
        return yield* new RoutingJudgmentError({ reason: "already_requested" });
      const claimed = yield* budget.beginDispatch(input.requestId).pipe(
        Effect.onError(() => budget.releaseUnsent(input.requestId).pipe(Effect.ignore)),
        Effect.mapError(() => new RoutingJudgmentError({ reason: "storage" })),
      );
      if (!claimed) {
        yield* budget.releaseUnsent(input.requestId).pipe(Effect.ignore);
        return yield* new RoutingJudgmentError({ reason: "budget_blocked" });
      }
    }).pipe(Effect.uninterruptible);
    // No retry or refund after the send claim. A timeout may still have incurred a charge.
    const { value, replyId } = yield* Effect.gen(function* () {
      const response = yield* client.execute(httpRequest);
      if (response.status !== 200)
        return yield* new RoutingJudgmentError({ reason: "request_uncertain" });
      return {
        value: yield* response.json,
        replyId: response.headers["x-typesafe-request-id"] ?? "",
      };
    }).pipe(
      Effect.timeout("20 seconds"),
      Effect.mapError(() => new RoutingJudgmentError({ reason: "request_uncertain" })),
    );
    const receipt = yield* Effect.try({
      try: () =>
        transport === "typesafe" ? readTypeSafeReceipt(value, replyId) : readJevReceipt(value),
      catch: () => new RoutingJudgmentError({ reason: "request_uncertain" }),
    });
    const parsed = yield* Effect.result(
      Effect.try({
        try: () =>
          readJevAdvice(
            input.requestId,
            request,
            value,
            transport === "typesafe" ? receipt : undefined,
          ),
        catch: () => new RoutingJudgmentError({ reason: "invalid_response" }),
      }),
    );
    // A malformed judgment can still have a valid bill. Reconcile its known cost first.
    yield* budget
      .settle({
        requestId: input.requestId,
        receiptId: receipt.receiptId,
        actualMicroUsd: receipt.costMicroUsd,
        ...(parsed._tag === "Success" && receipt.costMicroUsd <= JEV_RESERVATION_MICRO_USD
          ? { advice: parsed.success }
          : {}),
      })
      .pipe(Effect.mapError(() => new RoutingJudgmentError({ reason: "storage" })));
    if (receipt.costMicroUsd > JEV_RESERVATION_MICRO_USD)
      return yield* new RoutingJudgmentError({ reason: "budget_blocked" });
    if (parsed._tag === "Failure") return yield* parsed.failure;
    return parsed.success;
  });
  const configure = Effect.fn("JevAdvisor.configure")(function* (input: JevConnectionInput) {
    const failed = () => new RoutingJudgmentError({ reason: "storage" });
    if (input.action === "disconnect") {
      yield* secrets.remove(TYPESAFE_SECRET).pipe(Effect.mapError(failed));
      yield* secrets.remove(OPENROUTER_SECRET).pipe(Effect.mapError(failed));
      return { configured: false };
    }
    const key = Redacted.value(input.key).trim();
    if (!key || key.length > 512 || /\s/.test(key))
      return yield* new RoutingJudgmentError({ reason: "invalid_input" });
    const typesafe = jevTransportForKey(key) === "typesafe";
    yield* secrets
      .set(typesafe ? TYPESAFE_SECRET : OPENROUTER_SECRET, new TextEncoder().encode(key))
      .pipe(Effect.mapError(failed));
    // One connection at a time, so the key just entered is the one that gets used.
    yield* secrets
      .remove(typesafe ? OPENROUTER_SECRET : TYPESAFE_SECRET)
      .pipe(Effect.mapError(failed));
    return { configured: true };
  });
  return JevAdvisor.of({
    assess,
    configure,
    recover,
    configured: connection.pipe(Effect.map((connected) => connected !== null)),
  });
});
export const layer = Layer.effect(JevAdvisor, make);
