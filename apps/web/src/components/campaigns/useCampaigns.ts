import {
  AuthAccessWriteScope,
  type CampaignBoard,
  type CampaignCommand,
  type CampaignCommandResult,
  type EnvironmentId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useCallback, useState } from "react";

import { campaignEnvironment } from "../../state/campaigns";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentSessionState } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { campaignFailureMessage } from "./campaigns.logic";

/**
 * The live board for one campaign (or just clients and campaigns when none is chosen). While a
 * newly chosen campaign loads, the last board stays up so the client list does not blink; its
 * posts are only trusted once the new board has arrived (`postsReady`).
 */
export function useCampaignBoard(
  environmentId: EnvironmentId | null,
  connected: boolean,
  campaignId: string | null,
) {
  const query = useEnvironmentQuery(
    environmentId && connected
      ? campaignEnvironment.board({
          environmentId,
          input: campaignId === null ? {} : { campaignId },
        })
      : null,
  );
  const [lastBoard, setLastBoard] = useState<CampaignBoard | null>(null);
  // Held in state, set while rendering, so it is never read from a ref during a render.
  if (query.data !== null && query.data !== lastBoard) setLastBoard(query.data);
  const board = query.data ?? lastBoard;
  return {
    board,
    /** The posts in `board` are for the chosen campaign, not the one before it. */
    postsReady: query.data !== null,
    loading: board === null && query.error === null && environmentId !== null && connected,
    error: query.error,
    refresh: query.refresh,
  };
}

export type CampaignCommandOutcome =
  | { readonly ok: true; readonly value: CampaignCommandResult }
  | { readonly ok: false; readonly message: string };

export type CampaignRun = (command: CampaignCommand) => Promise<CampaignCommandOutcome>;

/** Runs one campaign command and answers with the result or a sentence fit to show. */
export function useCampaignCommand(environmentId: EnvironmentId | null): CampaignRun {
  const mutate = useAtomCommand(campaignEnvironment.mutate, { reportFailure: false });
  return useCallback(
    async (command: CampaignCommand): Promise<CampaignCommandOutcome> => {
      if (environmentId === null) {
        return { ok: false, message: "Connect to your agent workspace first." };
      }
      const result = await mutate({ environmentId, input: command });
      if (result._tag === "Success") return { ok: true, value: result.value };
      // A call cancelled by leaving the screen has nothing to say.
      if (isAtomCommandInterrupted(result)) return { ok: false, message: "" };
      return { ok: false, message: campaignFailureMessage(squashAtomCommandFailure(result)) };
    },
    [environmentId, mutate],
  );
}

/**
 * Whether this person holds the owner's access scope on the environment, the scope the server
 * asks for before approving, publishing, deleting or changing a mode. The server still decides;
 * this only keeps the screen from offering what it would refuse.
 */
export function useIsCampaignAdministrator(environmentId: EnvironmentId): boolean {
  const session = useEnvironmentSessionState(environmentId).data;
  return (
    session?.authenticated === true && (session.scopes?.includes(AuthAccessWriteScope) ?? false)
  );
}
