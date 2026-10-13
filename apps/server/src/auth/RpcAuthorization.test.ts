import {
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  RPC_REQUIRED_SCOPES,
  requiredScopeForRpcMethod,
  requiredScopeForDeviceList,
} from "./RpcAuthorization.ts";

describe("RPC authorization scopes", () => {
  it("keeps routing preview read-only", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.routingPreview)).toBe(AuthOrchestrationReadScope);
  });
  it("separates managed skill discovery/loading from administrator admission", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.managedSkillsList)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.managedSkillsLoad)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.managedSkillsAdmit)).toBe(AuthAccessWriteScope);
    expect(requiredScopeForRpcMethod(WS_METHODS.managedSkillsSetEnabled)).toBe(
      AuthAccessWriteScope,
    );
  });
  it("lets anyone who can read skills list packs, but only administrators install or remove them", () => {
    // Installing and removing are checked in the handler, where the action is known.
    expect(requiredScopeForRpcMethod(WS_METHODS.skillPacksRun)).toBe(AuthOrchestrationReadScope);
  });
  it("requires administrative access to change Jev credentials", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.routingConfigure)).toBe(AuthAccessWriteScope);
  });
  it("requires operate permission to hand a thread to another environment", () => {
    // Export returns the whole transcript to be written elsewhere, so it is not a plain read.
    expect(requiredScopeForRpcMethod(WS_METHODS.threadsExportTransfer)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.threadsImportTransfer)).toBe(
      AuthOrchestrationOperateScope,
    );
  });
  it("requires operate permission for paid Jev judgments", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.routingJudge)).toBe(AuthOrchestrationOperateScope);
    expect(requiredScopeForRpcMethod(WS_METHODS.threadsSuggestReply)).toBe(
      AuthOrchestrationOperateScope,
    );
  });
  it("lets readers see goal check-ins but needs operate permission to change goals or review", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.agentCheckInsList)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.agentCheckInsSubscribe)).toBe(
      AuthOrchestrationReadScope,
    );
    for (const method of [
      WS_METHODS.agentGoalsUpsert,
      WS_METHODS.agentGoalsSetStatus,
      WS_METHODS.agentGoalsDelete,
      WS_METHODS.agentCheckInsReview,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationOperateScope);
    }
  });
  it("lets readers see waiting secret requests but needs operate permission to answer or change secrets", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.agentSecretsList)).toBe(AuthOrchestrationReadScope);
    expect(requiredScopeForRpcMethod(WS_METHODS.agentSecretRequestsSubscribe)).toBe(
      AuthOrchestrationReadScope,
    );
    for (const method of [
      WS_METHODS.agentSecretsSet,
      WS_METHODS.agentSecretsDelete,
      WS_METHODS.agentSecretRequestsProvide,
      WS_METHODS.agentSecretRequestsDecline,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationOperateScope);
    }
  });
  it("declares exactly one scope for every RPC in the server group", () => {
    expect(new Set(Object.keys(RPC_REQUIRED_SCOPES))).toEqual(new Set(WsRpcGroup.requests.keys()));
  });

  it("authorizes background policy reporting and observation deliberately", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.serverReportClientActivity)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverReportHostPowerState)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverGetBackgroundPolicy)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.subscribeBackgroundPolicy)).toBe(
      AuthOrchestrationReadScope,
    );
  });

  it("allows relay status reads without granting relay installation access", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.cloudGetRelayClientStatus)).toBe(
      AuthRelayReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.cloudInstallRelayClient)).toBe(AuthRelayWriteScope);
  });

  it("requires permission to operate on a thread before uploading feedback", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.providerUploadFeedback)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("requires write access to import agent session history", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.agentSessionsScan)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.agentSessionsImport)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("separates ACP Registry discovery from provisioning", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.serverSearchAcpRegistry)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverPrepareAcpRegistryAgent)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverUninstallAcpRegistryManagedBinary)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverAcceptAcpRegistryUrlAuth)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverListAcpRegistrySessions)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverImportAcpRegistrySession)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverLogoutAcpRegistry)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("reads the reviewer menu under the same scope as the pull request it belongs to", () => {
    // The candidate list is a read like the detail beside it, and asking somebody for a review is
    // a write like every other pull request operation.
    expect(requiredScopeForRpcMethod(WS_METHODS.pullRequestsChecks)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.pullRequestsReviewerCandidates)).toBe(
      requiredScopeForRpcMethod(WS_METHODS.pullRequestsDetail),
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.pullRequestsRequestReviewers)).toBe(
      requiredScopeForRpcMethod(WS_METHODS.pullRequestsComment),
    );
  });

  it("rejects unknown RPC method names", () => {
    for (const method of ["server.notRegistered", "toString", "constructor"]) {
      expect(() => requiredScopeForRpcMethod(method)).toThrow(
        `RPC method ${method} has no declared authorization scope.`,
      );
    }
  });
});

it("requires operate permission for host retry while preserving read-only listing", () => {
  expect(requiredScopeForDeviceList({})).toBe(AuthOrchestrationReadScope);
  expect(requiredScopeForDeviceList({ retryHostId: "remote-host" })).toBe(
    AuthOrchestrationOperateScope,
  );
});

it("requires operate permission for tool updates even alongside a read-only check", () => {
  expect(requiredScopeForDeviceList({ updateTool: "agent", inspectOnly: true })).toBe(
    AuthOrchestrationOperateScope,
  );
  expect(requiredScopeForDeviceList({ updateTool: "hub" })).toBe(AuthOrchestrationOperateScope);
});
