import type { AgentSecretRequest, AgentSecretSummary, EnvironmentId } from "@t3tools/contracts";
import { useEffect, useEffectEvent } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";

const NO_REQUESTS: ReadonlyArray<AgentSecretRequest> = [];
const NO_SECRETS: ReadonlyArray<AgentSecretSummary> = [];

/**
 * Secret requests waiting for the owner in one environment: the list the server sends on
 * subscribe, replaced after every change. Pass a null environment to hold no subscription.
 * Requests carry names and the agent's reason, never a value.
 */
export function usePendingSecretRequests(environmentId: EnvironmentId | null, connected: boolean) {
  const query = useEnvironmentQuery(
    environmentId && connected
      ? serverEnvironment.agentSecretRequestsLive({ environmentId, input: {} })
      : null,
  );
  return {
    requests: query.data?.requests ?? NO_REQUESTS,
    /** Changes with every list the server sends. */
    updatedAt: query.dataUpdatedAt,
    error: query.error,
  };
}

/**
 * One agent's secrets (metadata only). It reloads when `changeToken` changes, for example when the
 * request stream sends a new list because an answered request added a secret; `reload` is for the
 * caller's own changes.
 */
export function useAgentSecretList(
  environmentId: EnvironmentId,
  agentId: string,
  connected: boolean,
  changeToken: number,
) {
  const query = useEnvironmentQuery(
    connected ? serverEnvironment.agentSecretsQuery({ environmentId, input: { agentId } }) : null,
  );
  const refresh = useEffectEvent(() => query.refresh());
  useEffect(() => {
    if (changeToken > 0) refresh();
  }, [changeToken]);
  return {
    secrets: query.data?.secrets ?? NO_SECRETS,
    loaded: query.data !== null,
    failed: query.error !== null,
    reload: query.refresh,
  };
}
