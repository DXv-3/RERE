import { ManagedRelay } from "@t3tools/client-runtime/relay";
import type { RelayModelShareInviteOffer } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";

import { runtime } from "../lib/runtime";

/**
 * Model shares other people offered to the signed-in account's verified email. The relay only
 * answers for the email in the token, so an account sees its own invites and nothing else. The
 * result carries share tokens: hand it straight to the add path and do not keep or log it.
 */
export function fetchModelShareInvites(
  clerkToken: string,
): Promise<ReadonlyArray<RelayModelShareInviteOffer>> {
  return runtime.runPromise(
    ManagedRelay.ManagedRelayClient.pipe(
      Effect.flatMap((relay) => relay.listModelShareInvites({ clerkToken })),
    ),
  );
}

/** Tells the relay this account has the share, so it is not offered again. */
export async function acceptModelShareInvite(clerkToken: string, inviteId: string): Promise<void> {
  await runtime.runPromise(
    ManagedRelay.ManagedRelayClient.pipe(
      Effect.flatMap((relay) => relay.acceptModelShareInvite({ clerkToken, inviteId })),
    ),
  );
}
