import type { AgentCheckIn, AgentCheckInFilter, EnvironmentId } from "@t3tools/contracts";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";

const NONE: ReadonlyArray<AgentCheckIn> = [];
const PENDING: AgentCheckInFilter = { status: "pending" };
const EVERYTHING: AgentCheckInFilter = {};

/**
 * One live list of check-ins: the first page the server sends, replaced after every change.
 * Pass `enabled: false` to hold no subscription (the result then has no data and no error).
 * Streams with the same filter on the same environment share one subscription.
 */
function useCheckInStream(
  environmentId: EnvironmentId | null,
  connected: boolean,
  filter: AgentCheckInFilter,
  enabled: boolean,
) {
  const query = useEnvironmentQuery(
    environmentId && connected && enabled
      ? serverEnvironment.agentCheckInsLive({ environmentId, input: filter })
      : null,
  );
  return {
    checkIns: query.data?.checkIns ?? NONE,
    /** More exist than the first page holds. */
    hasMore: query.data?.nextCursor != null,
    loaded: query.data !== null,
    loading: enabled && connected && query.data === null && query.error === null,
    error: query.error,
    /** Changes with every list the server sends. */
    updatedAt: query.dataUpdatedAt,
    refresh: query.refresh,
  };
}

/** Check-ins waiting for the owner, in the environment the Agent tab works against. */
export function usePendingCheckIns(environmentId: EnvironmentId | null, connected: boolean) {
  return useCheckInStream(environmentId, connected, PENDING, true);
}

/** Every check-in, reviewed or not. Only subscribes while `enabled`. */
export function useAllCheckIns(
  environmentId: EnvironmentId | null,
  connected: boolean,
  enabled: boolean,
) {
  return useCheckInStream(environmentId, connected, EVERYTHING, enabled);
}
