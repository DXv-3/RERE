import { EnvironmentId, type ServerConfig } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  continueOnTargetIds,
  resolveContinueOnAvailability,
  type ContinueOnEnvironmentFacts,
} from "./continueOn.logic";

const mac = EnvironmentId.make("mac");
const home = EnvironmentId.make("home");
const old = EnvironmentId.make("old");

const facts = (
  environmentId: EnvironmentId,
  options: { readonly connected?: boolean; readonly supported?: boolean } = {},
): ContinueOnEnvironmentFacts => ({
  environmentId,
  connected: options.connected ?? true,
  serverConfig: {
    environment: { capabilities: options.supported === false ? {} : { threadTransfer: true } },
  } as unknown as Pick<ServerConfig, "environment">,
});

describe("continueOnTargetIds", () => {
  it("lists only other connected environments that advertise the capability", () => {
    expect(
      continueOnTargetIds(mac, [
        facts(mac),
        facts(home),
        facts(old, { supported: false }),
        facts(EnvironmentId.make("asleep"), { connected: false }),
      ]),
    ).toEqual([home]);
  });
});

describe("resolveContinueOnAvailability", () => {
  const both = [facts(mac), facts(home)];

  it("is available for a quiet thread with somewhere to go", () => {
    expect(
      resolveContinueOnAvailability({
        sourceEnvironmentId: mac,
        environments: both,
        isBusy: false,
      }),
    ).toEqual({ kind: "available" });
  });

  it("is disabled with a reason while a run is in progress", () => {
    expect(
      resolveContinueOnAvailability({ sourceEnvironmentId: mac, environments: both, isBusy: true }),
    ).toEqual({ kind: "busy", reason: "Wait for the current run to finish" });
  });

  it("is hidden when the source cannot export or no other environment can import", () => {
    expect(
      resolveContinueOnAvailability({
        sourceEnvironmentId: mac,
        environments: [facts(mac, { supported: false }), facts(home)],
        isBusy: false,
      }),
    ).toEqual({ kind: "hidden" });
    expect(
      resolveContinueOnAvailability({
        sourceEnvironmentId: mac,
        environments: [facts(mac), facts(home, { connected: false })],
        isBusy: false,
      }),
    ).toEqual({ kind: "hidden" });
    expect(
      resolveContinueOnAvailability({
        sourceEnvironmentId: mac,
        environments: [facts(mac)],
        isBusy: false,
      }),
    ).toEqual({ kind: "hidden" });
  });
});
