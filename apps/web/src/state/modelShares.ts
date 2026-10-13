import { createModelShareEnvironmentCommands } from "@t3tools/client-runtime/state/model-shares";

import { connectionAtomRuntime } from "../connection/runtime";

export const modelShareEnvironment = createModelShareEnvironmentCommands(connectionAtomRuntime);
