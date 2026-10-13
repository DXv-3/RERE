import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AgentWorkspaceError,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type WorkbenchAgentProfile,
  type WorkspaceAgent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServer } from "effect/unstable/http";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import * as NetAddress from "effect/unstable/net/NetAddress";

import * as AgentWorkspace from "../agents/AgentWorkspace.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Layers/Sqlite.ts";
import * as AgentToolAccess from "./AgentToolAccess.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";

const scopeWith = (capabilities: ReadonlyArray<McpInvocationContext.McpCapability>) =>
  ({
    environmentId: EnvironmentId.make("environment:access"),
    threadId: ThreadId.make("thread:access"),
    providerSessionId: "provider-session:access",
    providerInstanceId: ProviderInstanceId.make("codex"),
    capabilities: new Set(capabilities),
    issuedAt: 1,
  }) satisfies McpInvocationContext.McpInvocationScope;

it("removes only the blocked groups the credential holds", () => {
  const scope = scopeWith(["preview", "orchestration", "worktree"]);
  const restricted = AgentToolAccess.restrictScope(scope, ["preview", "device"]);
  expect([...restricted.capabilities].toSorted()).toEqual(["orchestration", "worktree"]);
  // Device was never granted, so it stays an ordinary missing capability.
  expect([...(restricted.blockedGroups ?? [])]).toEqual(["preview"]);
  expect(McpInvocationContext.isSwitchedOff(restricted, "preview")).toBe(true);
  expect(McpInvocationContext.isSwitchedOff(restricted, "device")).toBe(false);
});

it("hands back the same scope when nothing applies", () => {
  const scope = scopeWith(["preview"]);
  expect(AgentToolAccess.restrictScope(scope, [])).toBe(scope);
  expect(AgentToolAccess.restrictScope(scope, ["worktree"])).toBe(scope);
});

it("keeps the grant visible when Other Conversations is switched off", () => {
  const restricted = AgentToolAccess.restrictScope(scopeWith(["orchestration"]), ["orchestration"]);
  expect(restricted.capabilities.has("orchestration")).toBe(false);
  expect(McpInvocationContext.holdsOrchestration(restricted)).toBe(true);
  expect(McpInvocationContext.holdsOrchestration(scopeWith([]))).toBe(false);
});

it("refuses every group when the owner's switches cannot be read", () =>
  Effect.gen(function* () {
    const scope = scopeWith(["preview", "orchestration", "worktree", "device", "pull-requests"]);
    const restricted = yield* AgentToolAccess.applyAgentToolAccess(
      { blockedToolGroups: () => Effect.fail(new AgentWorkspaceError({ reason: "storage" })) },
      scope,
    );
    expect(restricted.capabilities.size).toBe(0);
    expect(restricted.blockedGroups?.size).toBe(5);
  }).pipe(Effect.runSync));

const environmentId = EnvironmentId.make("environment:access-registry");
const httpServer = HttpServer.HttpServer.of({
  address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43124),
  serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
});
const serverEnvironment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(environmentId),
  getDescriptor: Effect.die("unused"),
});
const profile = (id: string, blocked?: WorkbenchAgentProfile["blockedToolGroups"]) => ({
  id,
  name: id,
  description: "",
  instructions: "",
  color: "#22c55e",
  pinned: false,
  projectKey: "",
  runtimeMode: "inherit" as const,
  modelSelection: null,
  ...(blocked === undefined ? {} : { blockedToolGroups: blocked }),
});
const newAgent = (id: string, threadId: string): WorkspaceAgent => ({
  profile: profile(id),
  revision: 0,
  archive: null,
  recovery: {
    disposition: "ready",
    summary: "New Workbench agent.",
    blockers: [],
    verifiedAt: null,
    evidence: [],
  },
  memories: [],
  primaryThreadId: threadId,
  threadIds: [threadId],
  updatedAt: "2026-10-05T00:00:00.000Z",
});

const layer = AgentWorkspace.layer.pipe(Layer.provide(SqlitePersistence.SqlitePersistenceMemory));

const harness = Effect.gen(function* () {
  const agents = yield* AgentWorkspace.AgentWorkspace;
  const registry = yield* McpSessionRegistry.__testing
    .make()
    .pipe(
      Effect.provideService(HttpServer.HttpServer, httpServer),
      Effect.provideService(ServerEnvironment.ServerEnvironment, serverEnvironment),
      Effect.provide(NodeServices.layer),
    );
  const authenticate = yield* McpHttpServer.makeMcpAuthMiddleware.pipe(
    Effect.provideService(McpSessionRegistry.McpSessionRegistry, registry),
    Effect.provideService(AgentWorkspace.AgentWorkspace, agents),
  );
  const issue = (threadId: string) =>
    registry
      .issue({
        threadId: ThreadId.make(threadId),
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: new Set(["preview", "device"]),
      })
      .pipe(Effect.map((issued) => issued.config.authorizationHeader));
  /** One request through the production middleware: the status and the scope a tool call sees. */
  const request = (authorization: string) =>
    Effect.gen(function* () {
      let seen: McpInvocationContext.McpInvocationScope | undefined;
      const response = yield* authenticate(
        McpInvocationContext.McpInvocationContext.pipe(
          Effect.tap((scope) => Effect.sync(() => (seen = scope))),
          Effect.as(HttpServerResponse.empty()),
        ),
      ).pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(
            new Request("http://127.0.0.1/mcp", { headers: { authorization } }),
          ),
        ),
      );
      return { status: response.status, scope: seen };
    });
  return { agents, issue, request };
});

it.effect("applies an agent's switches to the next call on a credential that already exists", () =>
  Effect.gen(function* () {
    const { agents, issue, request } = yield* harness;
    const saved = yield* agents.save({
      agent: newAgent("agent-1", "thread-agent"),
      expectedRevision: 0,
    });
    const agentToken = yield* issue("thread-agent");
    const plainToken = yield* issue("thread-plain");

    const before = yield* request(agentToken);
    expect(before.scope?.capabilities.has("preview")).toBe(true);
    expect(before.scope?.blockedGroups).toBeUndefined();

    // The owner switches Browser off while the session keeps running on the same credential.
    const blocked = yield* agents.save({
      agent: { ...saved, profile: profile("agent-1", ["preview"]) },
      expectedRevision: saved.revision,
    });
    const during = yield* request(agentToken);
    expect(during.scope?.capabilities.has("preview")).toBe(false);
    expect(during.scope?.capabilities.has("device")).toBe(true);
    expect(McpInvocationContext.isSwitchedOff(during.scope!, "preview")).toBe(true);

    // A thread that belongs to no agent is untouched by that agent's switch.
    const plain = yield* request(plainToken);
    expect(plain.scope?.capabilities.has("preview")).toBe(true);
    expect(plain.scope?.blockedGroups).toBeUndefined();

    // Switching it back on applies to the very next call as well.
    yield* agents.save({
      agent: { ...blocked, profile: profile("agent-1", []) },
      expectedRevision: blocked.revision,
    });
    const after = yield* request(agentToken);
    expect(after.scope?.capabilities.has("preview")).toBe(true);
    expect(after.scope?.blockedGroups).toBeUndefined();
  }).pipe(Effect.provide(layer)),
);

it.effect("still answers 401 for a token the registry does not know", () =>
  Effect.gen(function* () {
    const { request } = yield* harness;
    expect(yield* request("Bearer not-a-real-token")).toEqual({ status: 401, scope: undefined });
  }).pipe(Effect.provide(layer)),
);
