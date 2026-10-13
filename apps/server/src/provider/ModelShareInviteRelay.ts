import {
  RelayApi,
  type RelayModelShareInviteCreateRequest,
  type RelayModelShareInviteStatusRecord,
} from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  CLOUD_LINKED_USER_ID,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_URL_SECRET,
} from "../cloud/config.ts";

const RELAY_REQUEST_TIMEOUT = Duration.seconds(10);

const FAILURE_MESSAGES = {
  sign_in_required: "Sign in on this machine first to share by email. A share code still works.",
  email_invalid: "That email address does not look right. Check it and try again.",
  limit_reached:
    "Too many email invitations are waiting to be accepted. Revoke one first, or use a share code.",
  unreachable:
    "Inviting by email is not available yet, or CodeWrench could not be reached. Leave the email empty and send a share code instead.",
} as const;

export type ModelShareInviteFailureReason = keyof typeof FAILURE_MESSAGES;

/** Why an email invitation could not be made or taken back, in words fit to show the owner. */
export class ModelShareInviteFailedError extends Schema.TaggedError<ModelShareInviteFailedError>()(
  "ModelShareInviteFailedError",
  {
    reason: Schema.Literals(["sign_in_required", "email_invalid", "limit_reached", "unreachable"]),
  },
) {
  override get message(): string {
    return FAILURE_MESSAGES[this.reason];
  }
}

/**
 * This machine's channel to the relay for share invitations. It speaks as the linked environment
 * (the same credential the relay already issued it for activity publishing), so the relay knows
 * which account's machine is inviting and nobody else can create or revoke these invitations.
 */
export class ModelShareInviteRelay extends Context.Service<
  ModelShareInviteRelay,
  {
    /**
     * Offers a share to an email address. Resolves with the relay's id for the invitation and
     * whether the relay emailed the recipient (false from a relay that does not say).
     */
    readonly create: (
      input: Omit<RelayModelShareInviteCreateRequest, "ownerUserId">,
    ) => Effect.Effect<
      { readonly inviteId: string; readonly emailed: boolean },
      ModelShareInviteFailedError
    >;
    readonly revoke: (inviteId: string) => Effect.Effect<void, ModelShareInviteFailedError>;
    /** Where this machine's invitations stand. Fails rather than guess when the relay is away. */
    readonly statuses: Effect.Effect<
      ReadonlyArray<RelayModelShareInviteStatusRecord>,
      ModelShareInviteFailedError
    >;
  }
>()("t3/provider/ModelShareInviteRelay") {}

function failureTag(error: unknown): unknown {
  return typeof error === "object" && error !== null && "_tag" in error
    ? (error as { readonly _tag: unknown })._tag
    : undefined;
}

function failureReason(error: unknown): ModelShareInviteFailureReason {
  const tag = failureTag(error);
  if (tag === "RelayModelShareInviteInvalidError") {
    const reason = (error as { readonly reason?: unknown }).reason;
    if (reason === "invalid_email") return "email_invalid";
    // Not linked or not reachable at a secure address: the machine cannot invite anyone yet.
    return "sign_in_required";
  }
  if (tag === "RelayModelShareInviteLimitExceededError") return "limit_reached";
  return "unreachable";
}

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const readSecret = (name: string) =>
    secrets.get(name).pipe(
      Effect.map((bytes) =>
        Option.isSome(bytes) ? new TextDecoder().decode(bytes.value).trim() : null,
      ),
      Effect.orElseSucceed(() => null),
    );

  // Everything needed to speak to the relay, or a plain "sign in first".
  const relay = Effect.gen(function* () {
    const [url, credential, ownerUserId] = yield* Effect.all([
      readSecret(RELAY_URL_SECRET),
      readSecret(RELAY_ENVIRONMENT_CREDENTIAL_SECRET),
      readSecret(CLOUD_LINKED_USER_ID),
    ]);
    if (!url || !credential || !ownerUserId) {
      return yield* new ModelShareInviteFailedError({ reason: "sign_in_required" });
    }
    const client = yield* HttpApiClient.make(RelayApi, {
      baseUrl: url,
      transformClient: HttpClient.mapRequest(
        HttpClientRequest.setHeader("authorization", `Bearer ${credential}`),
      ),
    }).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.mapError(() => new ModelShareInviteFailedError({ reason: "unreachable" })),
    );
    return { client, ownerUserId };
  });

  const call = <A, E>(use: (connected: Effect.Success<typeof relay>) => Effect.Effect<A, E>) =>
    relay.pipe(
      Effect.flatMap((connected) =>
        use(connected).pipe(
          Effect.timeout(RELAY_REQUEST_TIMEOUT),
          // The relay's error bodies never carry the token, but nothing here logs them either.
          Effect.mapError(
            (error) => new ModelShareInviteFailedError({ reason: failureReason(error) }),
          ),
        ),
      ),
    );

  return ModelShareInviteRelay.of({
    create: Effect.fn("ModelShareInviteRelay.create")(function* (input) {
      const response = yield* call(({ client, ownerUserId }) =>
        client.modelShareInviteServer.createModelShareInvite({
          payload: { ...input, ownerUserId },
        }),
      );
      return { inviteId: response.inviteId, emailed: response.emailed === true };
    }),
    revoke: Effect.fn("ModelShareInviteRelay.revoke")(function* (inviteId) {
      yield* call(({ client }) =>
        client.modelShareInviteServer.revokeModelShareInvite({ params: { inviteId } }).pipe(
          // Already gone on the relay is the outcome the owner asked for.
          Effect.catchIf(
            (error) => failureTag(error) === "RelayModelShareInviteNotFoundError",
            () => Effect.void,
          ),
        ),
      );
    }),
    statuses: call(({ client }) => client.modelShareInviteServer.listModelShareInvites()).pipe(
      Effect.map((response) => response.invites),
    ),
  });
});

export const layer = Layer.effect(ModelShareInviteRelay, make);
