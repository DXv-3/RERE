import { describe, expect, it } from "vite-plus/test";

import { cannotManageSharingMessage, describeModelShareFailure } from "./modelShareFailure";

describe("describeModelShareFailure", () => {
  it("explains sharing by email without a sign-in in plain words", () => {
    expect(describeModelShareFailure({ reason: "model_share_sign_in_required" })).toBe(
      "Sign in on this machine first to share by email. A share code still works.",
    );
  });

  it("covers the other email failures", () => {
    for (const reason of [
      "model_share_email_invalid",
      "model_share_email_limit",
      "model_share_email_unavailable",
    ]) {
      expect(describeModelShareFailure({ reason })).not.toContain("rejected the request");
    }
  });

  it("falls back to the error's own message, then to a generic one", () => {
    expect(describeModelShareFailure(new Error("Boom"))).toBe("Boom");
    expect(describeModelShareFailure(new Error("  "))).toBe(
      "The environment did not answer. Try again.",
    );
    expect(describeModelShareFailure("nope")).toBe("The environment did not answer. Try again.");
  });

  it("explains a refused sign-in the same way for a 403, a 401 and an undeclared status", () => {
    const named = cannotManageSharingMessage({
      label: "candid-server",
      origin: "https://code.savagesolutions.io",
    });
    const machine = { label: "candid-server", origin: "https://code.savagesolutions.io" };
    for (const cause of [
      { _tag: "EnvironmentScopeRequiredError", code: "insufficient_scope" },
      { _tag: "EnvironmentAuthInvalidError", code: "auth_invalid" },
      { _tag: "RemoteEnvironmentAuthUndeclaredStatusError", status: 403 },
      { _tag: "RemoteEnvironmentAuthUndeclaredStatusError", status: 401 },
    ]) {
      expect(describeModelShareFailure(cause, machine)).toBe(named);
    }
    expect(named).toContain("candid-server");
    expect(named).toContain("https://code.savagesolutions.io");
    expect(named).toContain("browser");
  });

  it("names no address when the machine has none, and works without a machine", () => {
    expect(cannotManageSharingMessage({ label: "Laptop", origin: null })).toContain(
      "that machine's web address",
    );
    expect(describeModelShareFailure({ _tag: "EnvironmentScopeRequiredError" })).toContain(
      "this machine",
    );
  });

  it("leaves other statuses to their own message", () => {
    expect(
      describeModelShareFailure({
        _tag: "RemoteEnvironmentAuthUndeclaredStatusError",
        status: 500,
      }),
    ).toBe("The environment did not answer. Try again.");
  });
});
