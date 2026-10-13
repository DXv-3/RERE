// @effect-diagnostics preferSchemaOverJson:off - a test double reads the JSON it was sent.
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ServerSettings } from "@t3tools/contracts";
import type { DeepPartial } from "@t3tools/shared/Struct";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as ProcessRunner from "../../processRunner.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ServerSettingsModule from "../../serverSettings.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import * as CampaignStore from "../CampaignStore.ts";
import * as CampaignThreadNotifier from "../CampaignThreadNotifier.ts";
import * as GenerationService from "./GenerationService.ts";
import * as GenerationStore from "./GenerationStore.ts";

/** What a test sees of the outside world: every HTTP call, every message to an agent, the secrets. */
export interface GenerationWorld {
  readonly calls: Ref.Ref<
    ReadonlyArray<{ readonly method: string; readonly url: string; readonly body: unknown }>
  >;
  readonly told: Ref.Ref<
    ReadonlyArray<{ readonly threadId: string; readonly key: string; readonly text: string }>
  >;
  readonly secrets: Map<string, Uint8Array>;
  /** Every program the local graphics card connector started: what was run and with which arguments. */
  readonly processes: Ref.Ref<ReadonlyArray<ProcessRunner.ProcessRunInput>>;
  /** Answers every started program. Replace `current` to change what it prints next. */
  readonly program: {
    current: (
      input: ProcessRunner.ProcessRunInput,
    ) => Effect.Effect<ProcessRunner.ProcessRunOutput, ProcessRunner.ProcessRunError>;
  };
  /** Answers every HTTP call. Replace `current` to change what the provider says next. */
  readonly provider: { current: (request: HttpClientRequest.HttpClientRequest) => Response };
}

export const makeWorld = Effect.gen(function* () {
  return {
    calls: yield* Ref.make<GenerationWorld["calls"] extends Ref.Ref<infer A> ? A : never>([]),
    told: yield* Ref.make<GenerationWorld["told"] extends Ref.Ref<infer A> ? A : never>([]),
    processes: yield* Ref.make<ReadonlyArray<ProcessRunner.ProcessRunInput>>([]),
    program: {
      current: (
        input: ProcessRunner.ProcessRunInput,
      ): Effect.Effect<ProcessRunner.ProcessRunOutput, ProcessRunner.ProcessRunError> =>
        Effect.fail(
          new ProcessRunner.ProcessSpawnError({
            command: input.command,
            argumentCount: input.args.length,
            cause: new Error("unscripted"),
          }),
        ),
    },
    secrets: new Map<string, Uint8Array>(),
    provider: {
      current: (_request: HttpClientRequest.HttpClientRequest) =>
        new Response("unscripted", { status: 500 }),
    },
  } satisfies GenerationWorld;
});

/**
 * The generation service on a real in-memory store and a real temp folder, with the network, the
 * threads and the settings faked. `root` is the project folder every thread resolves to.
 */
export const makeHarnessLayer = (input: {
  readonly world: GenerationWorld;
  readonly root: string | null;
  readonly settings?: DeepPartial<ServerSettings>;
  readonly estimate?: GenerationService.GenerationServiceOptions["estimate"];
}) => {
  const { world } = input;
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.gen(function* () {
        const body =
          request.body._tag === "Uint8Array"
            ? (JSON.parse(new TextDecoder().decode(request.body.body)) as unknown)
            : undefined;
        yield* Ref.update(world.calls, (all) => [
          ...all,
          { method: request.method, url: request.url, body },
        ]);
        return HttpClientResponse.fromWeb(request, world.provider.current(request));
      }),
    ),
  );
  const runner = Layer.succeed(
    ProcessRunner.ProcessRunner,
    ProcessRunner.ProcessRunner.of({
      run: (run) =>
        Ref.update(world.processes, (all) => [...all, run]).pipe(
          Effect.flatMap(() => world.program.current(run)),
        ),
    }),
  );
  const secrets = Layer.succeed(
    ServerSecretStore.ServerSecretStore,
    ServerSecretStore.ServerSecretStore.of({
      get: (name) => Effect.sync(() => Option.fromNullishOr(world.secrets.get(name))),
      set: (name, value) => Effect.sync(() => void world.secrets.set(name, value)),
      create: () => Effect.die("unused"),
      getOrCreateRandom: () => Effect.die("unused"),
      remove: (name) => Effect.sync(() => void world.secrets.delete(name)),
    }),
  );
  const notifier = Layer.succeed(
    CampaignThreadNotifier.CampaignThreadNotifier,
    CampaignThreadNotifier.CampaignThreadNotifier.of({
      tell: (message) => Ref.update(world.told, (all) => [...all, message]),
    }),
  );
  const threads = Layer.mock(ThreadManagementService.ThreadManagementService)({
    getThreadShell: () =>
      Effect.succeed(
        input.root === null
          ? null
          : ({ projectId: "project-1", worktreePath: null, archivedAt: null } as never),
      ),
  });
  const projects = Layer.mock(ProjectService.ProjectService)({
    getById: () =>
      Effect.succeed(
        input.root === null ? Option.none() : Option.some({ workspaceRoot: input.root } as never),
      ),
  });
  const campaignStore = CampaignStore.layer.pipe(
    Layer.provide(notifier),
    Layer.provideMerge(SqlitePersistenceMemory),
  );
  const generationStore = GenerationStore.layer.pipe(Layer.provideMerge(campaignStore));
  return GenerationService.layerWith(
    input.estimate === undefined ? {} : { estimate: input.estimate },
  ).pipe(
    Layer.provideMerge(generationStore),
    Layer.provide(http),
    Layer.provide(runner),
    Layer.provide(secrets),
    Layer.provide(notifier),
    Layer.provide(threads),
    Layer.provide(projects),
    Layer.provide(ServerSettingsModule.layerTest(input.settings ?? {})),
    Layer.provide(WorkspacePaths.layer),
    Layer.provideMerge(NodeServices.layer),
  );
};
