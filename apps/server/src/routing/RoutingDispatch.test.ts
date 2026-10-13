import { expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import type { ProviderAdapterV2Shape } from "../orchestration-v2/ProviderAdapter.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as RoutingService from "./RoutingService.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("This test must not execute a provider"),
} as ProviderAdapterV2Shape;
const seen: RoutingService.SelectInput[] = [];
const unexpected = () => Effect.die("Dispatch only selects");
const routing = Layer.succeed(
  RoutingService.RoutingService,
  RoutingService.RoutingService.of({
    select: (input) =>
      Effect.sync(() => {
        seen.push(input);
        return {
          selection: input.pinned ? input.current : { instanceId, model: "routed-model" },
          skill: null,
        };
      }),
    preview: unexpected,
    judge: unexpected,
    configure: unexpected,
    skillsAdmit: unexpected,
    skillsAdmitStarters: Effect.die("Dispatch only selects"),
    skillsSyncLibrary: unexpected,
    skillsSetEnabled: unexpected,
    skillsList: Effect.die("Dispatch only selects"),
    skillsLoad: unexpected,
  }),
);
const runtime = makeOrchestratorV2ReplayLayerWithRegistry(
  { name: "routing-dispatch" },
  ProviderAdapterRegistry.makeLayer([adapter]),
  { databaseLayer: SqlitePersistenceMemory, runEffectWorker: false },
).pipe(Layer.provideMerge(routing));

it.effect("a sent message runs on the router's pick; pinned and scheduled sends do not", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("routed");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create"),
      threadId,
      projectId: ProjectId.make("project"),
      title: "Routed",
      modelSelection: { instanceId, model: "thread-model" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    const send = (id: string, extra: object = {}) =>
      orchestrator.dispatch({
        type: "message.dispatch" as const,
        commandId: CommandId.make(id),
        threadId,
        messageId: MessageId.make(id),
        text: "Do the work",
        attachments: [],
        dispatchMode: { type: "start_immediately" as const },
        createdBy: "user" as const,
        creationSource: "web" as const,
        ...extra,
      });
    const models = Effect.map(orchestrator.getThreadProjection(threadId), (projection) =>
      projection.runs.map((run) => run.modelSelection.model),
    );
    yield* send("first");
    expect(seen.at(-1)).toMatchObject({ pinned: false, newThread: true });
    expect(yield* models).toEqual(["routed-model"]);

    // The picker moved since the thread's last selection: the user chose this model.
    yield* send("second", { modelSelection: { instanceId, model: "hand-picked" } });
    expect(seen.at(-1)).toMatchObject({ pinned: true, newThread: false });
    expect((yield* models).at(-1)).toBe("hand-picked");

    const routedSends = seen.length;
    yield* send("third", { scheduledTaskId: ScheduledTaskId.make("schedule") });
    expect(seen).toHaveLength(routedSends);

    // A notice the agent posts to its own thread is not something a person typed.
    yield* send("fourth", {
      text: "Background command completed (exit code 0): wait for checks",
      createdBy: "agent",
      creationSource: "provider",
    });
    expect(seen).toHaveLength(routedSends);
  }).pipe(Effect.provide(runtime)),
);
