import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { ProviderInstanceId, type EnvironmentId } from "@t3tools/contracts";
import { useCallback, useRef } from "react";

import {
  useEnvironmentSettings,
  usePersistEnvironmentProviderInstanceMutation,
} from "../../hooks/useSettings";
import {
  buildSharedModelInstance,
  describeModelShareCodeError,
  nameSharedModelInstance,
  parseModelShareCode,
} from "./modelShareCode";

export type AddSharedModelOutcome =
  | {
      readonly ok: true;
      readonly instanceId: ProviderInstanceId;
      readonly displayName: string;
      readonly models: ReadonlyArray<string>;
    }
  | { readonly ok: false; readonly message: string };

/**
 * Turns a pasted share code into a provider on this environment: the one code path behind both
 * Settings > Connections > "Add a shared model" and the first-run wizard. The caller never sees
 * the token; a failure comes back as words for the person pasting.
 */
export function useAddSharedModel(
  environmentId: EnvironmentId,
): (code: string) => Promise<AddSharedModelOutcome> {
  const settings = useEnvironmentSettings(environmentId);
  const persistProviderInstance = usePersistEnvironmentProviderInstanceMutation(environmentId);
  const existing = Object.keys(settings.providerInstances ?? {});
  const existingKey = existing.join("\u0000");
  // Several shares can be added before settings come back with the earlier ones, so the ids this
  // hook has already used are remembered too and no two shares are given the same provider id.
  const addedIdsRef = useRef(new Set<string>());
  return useCallback(
    async (code) => {
      const parsed = parseModelShareCode(code);
      if (!parsed.ok) return { ok: false, message: describeModelShareCodeError(parsed.error) };
      const existingIds = new Set(["codex", "claudeAgent", ...existing, ...addedIdsRef.current]);
      const { instanceId, displayName } = nameSharedModelInstance(parsed.access, existingIds);
      const id = ProviderInstanceId.make(instanceId);
      const result = await persistProviderInstance({
        operation: "create",
        instanceId: id,
        instance: buildSharedModelInstance(parsed.access, displayName),
      });
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result);
        return {
          ok: false,
          message:
            error instanceof Error && error.message.trim().length > 0
              ? error.message
              : "The settings update failed. Try again.",
        };
      }
      addedIdsRef.current.add(instanceId);
      return { ok: true, instanceId: id, displayName, models: parsed.access.models };
    },
    // `existing` is rebuilt every render; its contents are what matter.
    [existingKey, persistProviderInstance],
  );
}
