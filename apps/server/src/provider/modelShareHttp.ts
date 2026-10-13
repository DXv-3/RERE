import { AuthAccessReadScope, AuthAccessWriteScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as ModelShares from "./ModelShares.ts";

const failModelShares = (error: ModelShares.ModelShareStorageError) =>
  failEnvironmentInternal("model_shares_failed", error);

/** Managing shares is managing who has access, so it takes the same scopes as pairing links. */
export const modelSharesHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "modelShares",
  Effect.fnUntraced(function* (handlers) {
    const shares = yield* ModelShares.ModelShares;

    return handlers
      .handle(
        "snapshot",
        Effect.fn("environment.modelShares.snapshot")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            yield* requireEnvironmentScope(AuthAccessReadScope);
            return yield* Effect.all({
              shares: shares.list,
              providers: shares.shareableProviders,
            });
          },
          Effect.catchTag("ModelShareStorageError", failModelShares),
        ),
      )
      .handle(
        "create",
        Effect.fn("environment.modelShares.create")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            yield* requireEnvironmentScope(AuthAccessWriteScope);
            return yield* shares.create(args.payload);
          },
          Effect.catchTags({
            ModelShareRefusedError: () => failEnvironmentInvalidRequest("provider_not_shareable"),
            ModelShareInviteFailedError: (error) =>
              failEnvironmentInvalidRequest(
                error.reason === "email_invalid"
                  ? "model_share_email_invalid"
                  : error.reason === "sign_in_required"
                    ? "model_share_sign_in_required"
                    : error.reason === "limit_reached"
                      ? "model_share_email_limit"
                      : "model_share_email_unavailable",
              ),
            ModelShareStorageError: failModelShares,
          }),
        ),
      )
      .handle(
        "revoke",
        Effect.fn("environment.modelShares.revoke")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            yield* requireEnvironmentScope(AuthAccessWriteScope);
            return { revoked: yield* shares.revoke(args.payload.id) };
          },
          Effect.catchTag("ModelShareStorageError", failModelShares),
        ),
      );
  }),
);
