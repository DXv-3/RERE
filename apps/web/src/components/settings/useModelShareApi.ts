import type {
  EnvironmentId,
  ModelShareCreateInput,
  ModelShareCreateResult,
  ModelShareSnapshot,
} from "@t3tools/contracts";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { useMemo } from "react";

import {
  createModelShare,
  fetchModelShares,
  revokeModelShare,
} from "../../environments/primary/modelShares";
import { modelShareEnvironment } from "../../state/modelShares";
import { useAtomCommand } from "../../state/use-atom-command";

/** The three share calls against one machine; failures reject with the environment's own error. */
export interface ModelShareApi {
  readonly list: () => Promise<ModelShareSnapshot>;
  readonly create: (input: ModelShareCreateInput) => Promise<ModelShareCreateResult>;
  readonly revoke: (id: string) => Promise<void>;
}

function unwrap<A, E>(result: AtomCommandResult<A, E>): A {
  if (result._tag === "Success") return result.value;
  throw squashAtomCommandFailure(result);
}

/**
 * The primary machine keeps its own HTTP client, which carries this window's sign-in as it always
 * has. Any other machine is called through its prepared connection, with that machine's own
 * credential.
 */
export function useModelShareApi(environmentId: EnvironmentId, isPrimary: boolean): ModelShareApi {
  const list = useAtomCommand(modelShareEnvironment.list, { reportFailure: false });
  const create = useAtomCommand(modelShareEnvironment.create, { reportFailure: false });
  const revoke = useAtomCommand(modelShareEnvironment.revoke, { reportFailure: false });
  return useMemo(
    () =>
      isPrimary
        ? { list: fetchModelShares, create: createModelShare, revoke: revokeModelShare }
        : {
            list: async () => unwrap(await list({ environmentId, input: null })),
            create: async (input) => unwrap(await create({ environmentId, input })),
            revoke: async (id) => {
              unwrap(await revoke({ environmentId, input: id }));
            },
          },
    [create, environmentId, isPrimary, list, revoke],
  );
}
