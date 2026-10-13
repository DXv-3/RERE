import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import type { RelayModelShareInviteOffer } from "@t3tools/contracts/relay";
import { useCallback, useEffect, useRef, useState } from "react";

import { useAccountSession } from "../../cloud/accountSessionContext";
import { acceptModelShareInvite, fetchModelShareInvites } from "../../cloud/modelShareInvites";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { toastManager } from "../ui/toast";
import { describeCollectedSharedModels, planSharedModelInvites } from "./modelShareInvites";
import { useAddSharedModel } from "./useAddSharedModel";

export interface CollectedSharedModel {
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string;
  /** Who it is from: the label of the sharer's machine. */
  readonly label: string;
  readonly models: ReadonlyArray<string>;
}

// The app root and the Connections page can both ask at once; one request at a time is enough.
let collectInFlight: Promise<ReadonlyArray<CollectedSharedModel>> | null = null;

/**
 * The recipient's side of sharing by email. When signed in, the relay lists the models other
 * people offered to this account's verified email; each is added through the same path as a pasted
 * share code and then marked accepted, so it is never offered again. Nothing here surfaces a
 * failure: no relay, no offers, or a flaky network all look like "nothing was shared with you".
 */
export function useSharedModelInvites(environmentId: EnvironmentId) {
  const { getToken, isSignedIn } = useAccountSession();
  const addSharedModel = useAddSharedModel(environmentId);
  const settings = useEnvironmentSettings(environmentId);
  // Read at call time, so a collect that starts late sees the providers that exist by then.
  const latest = useRef({ addSharedModel, providerInstances: settings.providerInstances });
  const account = useRef({ getToken, isSignedIn });
  useEffect(() => {
    latest.current = { addSharedModel, providerInstances: settings.providerInstances };
    account.current = { getToken, isSignedIn };
  });
  const [pending, setPending] = useState<ReadonlyArray<RelayModelShareInviteOffer>>([]);

  const readInvites = useCallback(async () => {
    if (!account.current.isSignedIn) return null;
    const token = await account.current.getToken();
    if (!token) return null;
    return { token, invites: await fetchModelShareInvites(token) };
  }, []);

  /** Looks without adding anything, for a screen that offers it first. */
  const refresh = useCallback(async () => {
    try {
      const read = await readInvites();
      const plan = planSharedModelInvites({
        invites: read?.invites ?? [],
        existingInstances: latest.current.providerInstances,
      });
      setPending(plan.add.map((entry) => entry.invite));
    } catch {
      setPending([]);
    }
  }, [readInvites]);

  const collect = useCallback(
    (options?: { readonly notify?: boolean }): Promise<ReadonlyArray<CollectedSharedModel>> => {
      if (collectInFlight) return collectInFlight;
      const run = async (): Promise<ReadonlyArray<CollectedSharedModel>> => {
        const collected: Array<CollectedSharedModel> = [];
        try {
          const read = await readInvites();
          if (!read) return collected;
          const plan = planSharedModelInvites({
            invites: read.invites,
            existingInstances: latest.current.providerInstances,
          });
          for (const { invite, code } of plan.add) {
            const outcome = await latest.current.addSharedModel(code);
            // Left waiting when it did not take, so the next sign-in tries again.
            if (!outcome.ok) continue;
            collected.push({
              instanceId: outcome.instanceId,
              displayName: outcome.displayName,
              label: invite.label,
              models: outcome.models,
            });
            await acceptModelShareInvite(read.token, invite.inviteId).catch(() => undefined);
          }
          // This computer already has these; telling the relay stops them coming back.
          for (const invite of plan.alreadyHave) {
            await acceptModelShareInvite(read.token, invite.inviteId).catch(() => undefined);
          }
        } catch {
          // Quiet by design; see above.
        }
        const notice = describeCollectedSharedModels(collected);
        if (notice && options?.notify !== false) {
          toastManager.add({ type: "success", title: "Shared model added", description: notice });
        }
        setPending([]);
        return collected;
      };
      const running = run().finally(() => {
        collectInFlight = null;
      });
      collectInFlight = running;
      return running;
    },
    [readInvites],
  );

  return { pending, refresh, collect };
}

/**
 * Collects shared models when the app opens signed in, when someone signs in, and wherever this is
 * mounted (Settings > Connections mounts it so opening the page also checks).
 */
export function useCollectSharedModelsOnMount(environmentId: EnvironmentId): void {
  const { isLoaded, isSignedIn } = useAccountSession();
  const { collect } = useSharedModelInvites(environmentId);
  useEffect(() => {
    if (isLoaded && isSignedIn) void collect();
  }, [collect, isLoaded, isSignedIn]);
}
