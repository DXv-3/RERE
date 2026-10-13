import type {
  ModelShareCreateInput,
  ModelShareCreateResult,
  ModelShareSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { runPrimaryHttp } from "../../lib/runtime";
import { PrimaryEnvironmentHttpClient } from "./httpClient";

/** Model shares on the primary environment, and the providers it could share. */
export function fetchModelShares(): Promise<ModelShareSnapshot> {
  return runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) => client.modelShares.snapshot({ headers: {} })),
    ),
  );
}

/** The result carries the token, which the environment never returns again. */
export function createModelShare(input: ModelShareCreateInput): Promise<ModelShareCreateResult> {
  return runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) => client.modelShares.create({ headers: {}, payload: input })),
    ),
  );
}

export async function revokeModelShare(id: string): Promise<void> {
  await runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) => client.modelShares.revoke({ headers: {}, payload: { id } })),
    ),
  );
}
