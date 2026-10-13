import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { OrchestratorProjectionError } from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { restrictScope } from "./AgentToolAccess.ts";
import type * as McpInvocationContext from "./McpInvocationContext.ts";
import * as ThreadMetadataMcp from "./ThreadMetadataMcpService.ts";

const threadId = ThreadId.make("thread:metadata-caller");
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:metadata-test"),
  threadId,
  providerSessionId: "provider-session:metadata-test",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

function serviceLayer(
  getThreadShell: ThreadManagement.ThreadManagementService["Service"]["getThreadShell"],
) {
  return ThreadMetadataMcp.layer.pipe(
    Layer.provide(
      ServerSettings.layerTest({ enableAgentCrossProjectAccess: false }).pipe(Layer.orDie),
    ),
    Layer.provide(
      Layer.merge(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell,
          getThreadRecords: () => Effect.die("projection must not load after shell failure"),
        } satisfies Partial<ThreadManagement.ThreadManagementService["Service"]>),
        NodeCrypto.layer,
      ),
    ),
  );
}

const updateCallingThread = Effect.gen(function* () {
  const service = yield* ThreadMetadataMcp.ThreadMetadataMcpService;
  return yield* service.update(scope, {
    action: "rename",
    title: "Renamed thread",
    clientRequestId: "metadata-caller-classification",
  });
});

it.effect("reports an absent calling thread as thread_not_found", () =>
  Effect.gen(function* () {
    const error = yield* updateCallingThread.pipe(
      Effect.provide(serviceLayer(() => Effect.succeed(null))),
      Effect.flip,
    );

    expect(error.code).toBe("thread_not_found");
  }),
);

it.effect("keeps calling-thread storage failures as orchestration errors", () =>
  Effect.gen(function* () {
    const error = yield* updateCallingThread.pipe(
      Effect.provide(
        serviceLayer(() =>
          Effect.fail(
            new OrchestratorProjectionError({
              threadId,
              cause: new Error("storage unavailable"),
            }),
          ),
        ),
      ),
      Effect.flip,
    );

    expect(error.code).toBe("orchestration_error");
  }),
);

it.effect("keeps linking a pull request behind the Pull Requests switch", () =>
  Effect.gen(function* () {
    const service = yield* ThreadMetadataMcp.ThreadMetadataMcpService;
    const pullRequestsOff = restrictScope(
      { ...scope, capabilities: new Set(["orchestration", "pull-requests"]) },
      ["pull-requests"],
    );
    for (const action of ["link_pull_request", "unlink_pull_request"] as const) {
      const error = yield* Effect.flip(
        service.update(pullRequestsOff, {
          action,
          ...(action === "link_pull_request"
            ? { pullRequest: { url: "https://github.com/T3Tools/T3Code/pull/1" } }
            : {}),
        } as never),
      );
      expect(error).toMatchObject({
        code: "capability_denied",
        message: "This agent's Pull Requests access is switched off.",
      });
    }
    // Renaming the thread is not pull request work, so it reaches the thread lookup.
    const rename = yield* Effect.flip(
      service.update(pullRequestsOff, { action: "rename", title: "Renamed" }),
    );
    expect(rename.code).toBe("thread_not_found");
  }).pipe(Effect.provide(serviceLayer(() => Effect.succeed(null)))),
);

it.effect(
  "lets the agent rename its own thread but not another when Other Conversations is off",
  () =>
    Effect.gen(function* () {
      const service = yield* ThreadMetadataMcp.ThreadMetadataMcpService;
      const off = restrictScope(scope, ["orchestration"]);
      const own = yield* Effect.flip(service.update(off, { action: "rename", title: "Mine" }));
      expect(own.code).toBe("thread_not_found");
      const other = yield* Effect.flip(
        service.update(off, {
          action: "rename",
          title: "Theirs",
          threadId: ThreadId.make("thread:somebody-else"),
        }),
      );
      expect(other).toMatchObject({
        code: "capability_denied",
        message: "This agent's Other Conversations access is switched off.",
      });
    }).pipe(Effect.provide(serviceLayer(() => Effect.succeed(null)))),
);
