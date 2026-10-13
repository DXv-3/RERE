import { useAtomValue } from "@effect/atom-react";
import { EnvironmentId, type AuthSessionState } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/unstable/reactivity";
import { useMemo } from "react";

import { environmentSession } from "../../state/session";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import {
  canManageModelShares,
  modelShareOrigin,
  type ModelShareMachine,
} from "./modelShareMachines";

interface MachineFacts {
  readonly environmentId: EnvironmentId;
  readonly httpBaseUrl: string | null;
  readonly session: AuthSessionState | null;
}

/**
 * What the panel needs to know about each machine, read in one derived atom because the list of
 * machines changes length and React cannot subscribe to a changing number of atoms. The primary
 * machine's session is not read: the panel is only shown once the primary has managing access.
 */
const machineFactsFamily = Atom.family((key: string) =>
  Atom.make((get): ReadonlyArray<MachineFacts> => {
    const targets = JSON.parse(key) as ReadonlyArray<readonly [EnvironmentId, boolean]>;
    return targets.map(([environmentId, isPrimary]) => ({
      environmentId,
      httpBaseUrl: Option.match(
        get(environmentSession.preparedConnectionValueAtom(environmentId)),
        {
          onNone: () => null,
          onSome: (prepared) => prepared.httpBaseUrl,
        },
      ),
      session: isPrimary ? null : get(environmentSession.sessionStateValueAtom(environmentId)),
    }));
  }).pipe(Atom.withLabel(`web-model-share-machines:${key}`)),
);

const PRIMARY_FALLBACK_MACHINE: ModelShareMachine = {
  environmentId: EnvironmentId.make("primary-environment"),
  label: "This machine",
  isPrimary: true,
  origin: modelShareOrigin({
    httpBaseUrl: null,
    page:
      typeof window !== "undefined" && window.desktopBridge === undefined ? window.location : null,
  }),
  canManage: true,
};

/**
 * Every machine the Shared models panel can act on: this app's own primary machine, then each
 * other environment that is connected right now.
 */
export function useModelShareMachines(): {
  readonly machines: ReadonlyArray<ModelShareMachine>;
  readonly primaryEnvironmentId: EnvironmentId | null;
} {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const listed = useMemo(
    () =>
      environments.filter(
        (environment) =>
          environment.environmentId === primaryEnvironmentId ||
          environment.connection.phase === "connected",
      ),
    [environments, primaryEnvironmentId],
  );
  const key = JSON.stringify(
    listed.map((environment) => [
      environment.environmentId,
      environment.environmentId === primaryEnvironmentId,
    ]),
  );
  const facts = useAtomValue(machineFactsFamily(key));

  const machines = useMemo(() => {
    const found = listed.map((environment): ModelShareMachine => {
      const isPrimary = environment.environmentId === primaryEnvironmentId;
      const known = facts.find(
        (candidate) => candidate.environmentId === environment.environmentId,
      );
      return {
        environmentId: environment.environmentId,
        label: environment.label,
        isPrimary,
        // The page was opened at the primary machine's address in a browser, never in the
        // desktop app, where the page is the app itself.
        origin: modelShareOrigin({
          httpBaseUrl: known?.httpBaseUrl ?? null,
          page: isPrimary && window.desktopBridge === undefined ? window.location : null,
        }),
        canManage: isPrimary ? true : canManageModelShares(known?.session ?? null),
      };
    });
    // Before this app has listed its own machine the panel still works on it, as it always has.
    return found.length > 0 ? found : [PRIMARY_FALLBACK_MACHINE];
  }, [facts, listed, primaryEnvironmentId]);
  return { machines, primaryEnvironmentId };
}
