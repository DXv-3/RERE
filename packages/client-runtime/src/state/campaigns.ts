import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/**
 * The campaigns board and everything a person does on it. `board` is a live stream: the first
 * value is the first read, and every change on the server sends a fresh board. `mutate` is the
 * single command call; the server decides per command which access scope it needs.
 */
export function createCampaignEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    board: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:campaigns:board",
      tag: WS_METHODS.campaignsSubscribe,
    }),
    mutate: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:campaigns:mutate",
      tag: WS_METHODS.campaignsMutate,
    }),
  };
}
