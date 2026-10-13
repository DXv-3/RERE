import { WS_METHODS } from "@t3tools/contracts";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";
import type { Atom } from "effect/unstable/reactivity";

/**
 * Facts, still frames and timeline thumbnails for video and image files in an environment's
 * workspace. Commands rather than cached queries: frames are cached on the server, and the
 * viewer decides when it needs them.
 */
export function createMediaEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    probe: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:media:probe",
      tag: WS_METHODS.mediaProbe,
    }),
    frames: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:media:frames",
      tag: WS_METHODS.mediaFrames,
    }),
    thumbnails: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:media:thumbnails",
      tag: WS_METHODS.mediaThumbnails,
    }),
  };
}
