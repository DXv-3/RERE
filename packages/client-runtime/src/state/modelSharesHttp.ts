import type { ModelShareCreateInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import type { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { makeEnvironmentHttpApiUrlBuilder } from "../rpc/http.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";

const DEFAULT_MODEL_SHARES_TIMEOUT_MS = 15_000;

interface ModelSharesRequestInput {
  readonly prepared: PreparedConnection;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly remoteAuthorization?: Option.Option<RemoteEnvironmentAuthorization["Service"]>;
  readonly timeoutMs?: number;
}

/**
 * The model shares one environment holds, and the providers it could share, over that
 * environment's own authenticated HTTP API. Needs the `access:read` scope there.
 */
export const fetchEnvironmentModelShares = Effect.fn(
  "clientRuntime.state.fetchEnvironmentModelShares",
)(function* (input: ModelSharesRequestInput) {
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    ...input,
    group: "modelShares",
    method: "GET",
    url: (httpBaseUrl) => makeEnvironmentHttpApiUrlBuilder(httpBaseUrl).modelShares.snapshot(),
    timeoutMs: input.timeoutMs ?? DEFAULT_MODEL_SHARES_TIMEOUT_MS,
    request: ({ client, headers }) => client.snapshot({ headers }),
  });
});

/** Creates a share on that environment. The result carries the token, shown only once. */
export const createEnvironmentModelShare = Effect.fn(
  "clientRuntime.state.createEnvironmentModelShare",
)(function* (input: ModelSharesRequestInput & { readonly share: ModelShareCreateInput }) {
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    ...input,
    group: "modelShares",
    method: "POST",
    url: (httpBaseUrl) => makeEnvironmentHttpApiUrlBuilder(httpBaseUrl).modelShares.create(),
    timeoutMs: input.timeoutMs ?? DEFAULT_MODEL_SHARES_TIMEOUT_MS,
    request: ({ client, headers }) => client.create({ headers, payload: input.share }),
  });
});

/** Revokes one share on that environment, ending the holder's access. */
export const revokeEnvironmentModelShare = Effect.fn(
  "clientRuntime.state.revokeEnvironmentModelShare",
)(function* (input: ModelSharesRequestInput & { readonly shareId: string }) {
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    ...input,
    group: "modelShares",
    method: "POST",
    url: (httpBaseUrl) => makeEnvironmentHttpApiUrlBuilder(httpBaseUrl).modelShares.revoke(),
    timeoutMs: input.timeoutMs ?? DEFAULT_MODEL_SHARES_TIMEOUT_MS,
    request: ({ client, headers }) => client.revoke({ headers, payload: { id: input.shareId } }),
  });
});
