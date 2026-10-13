import { createCampaignEnvironmentAtoms } from "@t3tools/client-runtime/state/campaigns";

import { connectionAtomRuntime } from "../connection/runtime";

export const campaignEnvironment = createCampaignEnvironmentAtoms(connectionAtomRuntime);
