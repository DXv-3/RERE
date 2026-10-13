import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canManageModelShares,
  defaultModelShareMachineId,
  describeModelShareAddress,
  modelShareMachineOptionLabel,
  modelShareOrigin,
  type ModelShareMachine,
} from "./modelShareMachines";

const MAC_PAGE = { origin: "http://127.0.0.1:3773", hostname: "127.0.0.1" };

function machine(
  overrides: Partial<ModelShareMachine> & { readonly id: string },
): ModelShareMachine {
  const { id, ...rest } = overrides;
  return {
    environmentId: EnvironmentId.make(id),
    label: id,
    isPrimary: false,
    origin: null,
    canManage: true,
    ...rest,
  };
}

describe("modelShareOrigin", () => {
  it("uses a machine's own https address, whatever page the app is on", () => {
    expect(
      modelShareOrigin({ httpBaseUrl: "https://code.savagesolutions.io/base", page: null }),
    ).toBe("https://code.savagesolutions.io");
    expect(
      modelShareOrigin({ httpBaseUrl: "https://code.savagesolutions.io", page: MAC_PAGE }),
    ).toBe("https://code.savagesolutions.io");
  });

  it("counts a savagesolutions.io relay tunnel hostname as public", () => {
    expect(
      modelShareOrigin({ httpBaseUrl: "https://abc123.tunnel.savagesolutions.io", page: null }),
    ).toBe("https://abc123.tunnel.savagesolutions.io");
  });

  it("refuses loopback, private, tailnet and plain http addresses", () => {
    for (const httpBaseUrl of [
      "https://localhost:3773",
      "https://127.0.0.1",
      "https://[::1]",
      "https://10.0.0.5",
      "https://172.20.1.1",
      "https://192.168.1.20",
      "https://169.254.1.1",
      "https://100.101.102.103",
      "https://[fd12:3456::1]",
      "https://[fe80::1]",
      "https://mac",
      "https://mac.local",
      "https://box.tail1234.ts.net",
      "https://printer.lan",
      "http://code.savagesolutions.io",
      "not a url",
    ]) {
      expect(modelShareOrigin({ httpBaseUrl, page: null }), httpBaseUrl).toBe(null);
    }
  });

  it("does not mistake a public address that merely looks private", () => {
    expect(modelShareOrigin({ httpBaseUrl: "https://172.32.0.1", page: null })).toBe(
      "https://172.32.0.1",
    );
    expect(modelShareOrigin({ httpBaseUrl: "https://100.128.0.1", page: null })).toBe(
      "https://100.128.0.1",
    );
    expect(modelShareOrigin({ httpBaseUrl: "https://localhost.example.com", page: null })).toBe(
      "https://localhost.example.com",
    );
  });

  it("falls back to the page only when it was opened at a reachable address", () => {
    const browserAtServer = { origin: "https://code.example.com", hostname: "code.example.com" };
    expect(modelShareOrigin({ httpBaseUrl: "http://127.0.0.1:3773", page: browserAtServer })).toBe(
      "https://code.example.com",
    );
    expect(modelShareOrigin({ httpBaseUrl: "http://127.0.0.1:3773", page: MAC_PAGE })).toBe(null);
    expect(modelShareOrigin({ httpBaseUrl: null, page: null })).toBe(null);
  });
});

describe("canManageModelShares", () => {
  it("needs both access scopes", () => {
    expect(
      canManageModelShares({ authenticated: true, scopes: ["access:read", "access:write"] }),
    ).toBe(true);
    expect(canManageModelShares({ authenticated: true, scopes: ["access:read"] })).toBe(false);
    expect(
      canManageModelShares({ authenticated: true, scopes: ["orchestration:read", "relay:read"] }),
    ).toBe(false);
  });

  it("stays undecided until the session is known", () => {
    expect(canManageModelShares(null)).toBe(null);
    expect(canManageModelShares({ authenticated: false })).toBe(null);
    expect(canManageModelShares({ authenticated: true })).toBe(null);
  });
});

describe("defaultModelShareMachineId", () => {
  const mac = machine({ id: "mac", isPrimary: true, origin: null });
  const server = machine({ id: "server", origin: "https://code.savagesolutions.io" });

  it("picks the only machine with a public https address over the primary", () => {
    expect(defaultModelShareMachineId([mac, server], mac.environmentId)).toBe(server.environmentId);
  });

  it("picks the primary when no machine, or more than one, is public", () => {
    expect(defaultModelShareMachineId([mac], mac.environmentId)).toBe(mac.environmentId);
    expect(
      defaultModelShareMachineId([mac, machine({ id: "box", origin: null })], mac.environmentId),
    ).toBe(mac.environmentId);
    const other = machine({ id: "other", origin: "https://other.example.com" });
    expect(defaultModelShareMachineId([mac, server, other], mac.environmentId)).toBe(
      mac.environmentId,
    );
  });

  it("ignores a public address that is not https", () => {
    const http = machine({ id: "http", origin: "http://code.example.com" });
    expect(defaultModelShareMachineId([mac, http], mac.environmentId)).toBe(mac.environmentId);
  });

  it("falls back to the first machine, or none", () => {
    expect(defaultModelShareMachineId([server], null)).toBe(server.environmentId);
    expect(defaultModelShareMachineId([], null)).toBe(null);
  });
});

describe("machine wording", () => {
  it("says where a share will be reachable, or that it has no public address", () => {
    expect(
      describeModelShareAddress(machine({ id: "s", origin: "https://code.example.com" })),
    ).toBe("People will reach it at https://code.example.com");
    expect(describeModelShareAddress(machine({ id: "m", origin: null }))).toBe(
      "This machine has no public address; only invite-by-email or your own network can use it.",
    );
  });

  it("marks a machine this sign-in cannot manage", () => {
    expect(
      modelShareMachineOptionLabel(machine({ id: "a", label: "Server", canManage: false })),
    ).toBe("Server (cannot manage sharing)");
    expect(
      modelShareMachineOptionLabel(machine({ id: "b", label: "Server", canManage: null })),
    ).toBe("Server");
  });
});
