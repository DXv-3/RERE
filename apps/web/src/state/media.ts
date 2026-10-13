import { createMediaEnvironmentAtoms } from "@t3tools/client-runtime/state/media";

import { connectionAtomRuntime } from "../connection/runtime";

export const mediaEnvironment = createMediaEnvironmentAtoms(connectionAtomRuntime);
