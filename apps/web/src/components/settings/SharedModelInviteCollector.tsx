import type { EnvironmentId } from "@t3tools/contracts";

import { usePrimaryEnvironmentId } from "../../state/environments";
import { useCollectSharedModelsOnMount } from "./useSharedModelInvites";

/** Renders nothing. Adds models other people shared with this account's email, then says so once. */
export function SharedModelInviteCollector({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  useCollectSharedModelsOnMount(environmentId);
  return null;
}

/** The app-level mount: collects into this computer's own environment once it is known. */
export function PrimaryEnvironmentSharedModelCollector() {
  const environmentId = usePrimaryEnvironmentId();
  return environmentId ? <SharedModelInviteCollector environmentId={environmentId} /> : null;
}
