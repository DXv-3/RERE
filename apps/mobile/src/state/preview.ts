import { createPreviewEnvironmentAtoms } from "@t3tools/client-runtime/state/preview";

import { connectionAtomRuntime } from "../connection/runtime";

/** The server's browser tabs and the agent browser channel, per environment. */
export const previewEnvironment = createPreviewEnvironmentAtoms(connectionAtomRuntime);
