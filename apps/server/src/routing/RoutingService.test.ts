import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ManagedSkillCatalog from "../skills/ManagedSkillCatalog.ts";
import * as DateTime from "effect/DateTime";
import { it as effectIt } from "@effect/vitest";
import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ManagedSkillError,
  RoutingJudgmentError,
  RoutingPreview,
  RoutingPreviewInput,
  type ServerProvider,
  type ServerSettings as ContractServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import * as JevAdvisor from "./JevAdvisor.ts";
import * as RoutingService from "./RoutingService.ts";
import * as Qualification from "./RouteQualificationService.ts";
import * as SelectionBudgetStore from "./SelectionBudgetStore.ts";
import * as RoutingDecisionStore from "./RoutingDecisionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { previewRouting } from "./routingPolicy.ts";

const routingLayerWith = (
  options: {
    readonly settings?: Parameters<typeof ServerSettings.layerTest>[0];
    readonly advisor?: Partial<JevAdvisor.JevAdvisor["Service"]>;
    /** Replaces the catalog's library sync with one that records its inputs. */
    readonly syncs?: Array<{ readonly enable: boolean }>;
    readonly failSync?: boolean;
    /** Signals that the skill folders changed, as the folder watch would send. */
    readonly folderChanges?: Stream.Stream<void>;
    /** Settings changes delivered to the service, as the settings runtime would. */
    readonly changes?: Queue.Queue<ContractServerSettings>;
  } = {},
) =>
  RoutingService.layer.pipe(
    Layer.provide(
      Layer.succeed(
        Qualification.RouteQualificationService,
        Qualification.RouteQualificationService.of({
          inspect: () => Effect.die("Unexpected qualification request without a model selection"),
        }),
      ),
    ),
    Layer.provide(
      Layer.succeed(
        JevAdvisor.JevAdvisor,
        JevAdvisor.JevAdvisor.of({
          configure: () => Effect.die("Preview must not change credentials"),
          configured: Effect.succeed(false),
          recover: () => Effect.succeed({ requestId: "test", state: "new", advice: null }),
          assess: () => Effect.die("Preview must not call Jev"),
          ...options.advisor,
        }),
      ),
    ),
    Layer.provide(SelectionBudgetStore.layer),
    Layer.provideMerge(
      Layer.effect(
        ManagedSkillCatalog.ManagedSkillCatalog,
        Effect.map(ManagedSkillCatalog.ManagedSkillCatalog, (real) =>
          ManagedSkillCatalog.ManagedSkillCatalog.of({
            ...real,
            // The real watch would follow whatever happens in the developer's own home folder.
            libraryChanges: () => options.folderChanges ?? Stream.empty,
            ...(options.syncs
              ? {
                  syncLibrary: (input) => {
                    options.syncs!.push(input);
                    return options.failSync
                      ? Effect.fail(new ManagedSkillError({ reason: "storage" }))
                      : Effect.succeed({ found: 0, added: 0, skipped: 0, enabled: 0 });
                  },
                }
              : {}),
          }),
        ),
      ).pipe(Layer.provide(ManagedSkillCatalog.layer)),
    ),
    Layer.provideMerge(RoutingDecisionStore.layer),
    Layer.provideMerge(
      options.changes
        ? Layer.effect(
            ServerSettings.ServerSettingsService,
            Effect.map(ServerSettings.ServerSettingsService, (real) =>
              ServerSettings.ServerSettingsService.of({
                ...real,
                subscribeChanges: Effect.succeed(Stream.fromQueue(options.changes!)),
              }),
            ),
          ).pipe(Layer.provide(ServerSettings.layerTest(options.settings)))
        : ServerSettings.layerTest(options.settings),
    ),
    Layer.provide(NodeServices.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
  );
const routingLayer = routingLayerWith();

const isPreview = Schema.is(RoutingPreview);
const isPreviewInput = Schema.is(RoutingPreviewInput);
const now = Date.parse("2026-10-03T08:00:00Z");
const timestamp = DateTime.formatIso(DateTime.makeUnsafe(now));
const a = ProviderInstanceId.make("account-a");
const b = ProviderInstanceId.make("account-b");
const input: RoutingPreviewInput = { instanceId: a, task: "", cwd: null };
function provider(overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: a,
    driver: ProviderDriverKind.make("grok"),
    enabled: true,
    installed: true,
    status: "ready",
    version: "1",
    auth: { status: "authenticated", profileId: "profile-a" },
    checkedAt: timestamp,
    models: [{ slug: "model", name: "Model", isCustom: false, capabilities: null }],
    skills: [],
    slashCommands: [],
    usageLimits: {
      checkedAt: timestamp,
      windows: [{ id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 20 }],
    },
    ...overrides,
  };
}
const run = (providers: ServerProvider[], request = input) =>
  previewRouting(providers, request, now);
const mockRegistry = (providers: ServerProvider[]) => {
  const unexpected = () => Effect.die("Unexpected provider mutation");
  return ProviderRegistry.ProviderRegistry.of({
    getProviders: Effect.succeed(providers),
    refresh: unexpected,
    refreshInstance: unexpected,
    refreshWorkspaceSnapshot: unexpected,
    getProviderMaintenanceCapabilitiesForInstance: unexpected,
    setProviderMaintenanceActionState: unexpected,
    streamChanges: Stream.empty,
  });
};

describe("routing preview", () => {
  it("compares exact provider accounts without starting a turn", () => {
    const first = provider();
    const second = provider({
      instanceId: b,
      auth: { status: "authenticated", profileId: "profile-b" },
      usageLimits: {
        checkedAt: timestamp,
        windows: [{ id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 5 }],
      },
    });
    const result = run([first, second]);
    expect(result.recommendedInstanceId).toBe(b);
    expect(result.automaticExecution).toBe(false);
    expect(result.judge).toBe("local");
    expect(isPreview(result)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("profile-b");
  });
  it.each([
    ["missing quota", undefined, "quota_unknown"],
    [
      "failed refresh",
      { checkedAt: timestamp, windows: [], unavailable: { reason: "probeFailed" } },
      "quota_failed",
    ],
    [
      "old quota",
      {
        checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now - 301_000)),
        windows: [{ id: "w", kind: "weekly", label: "Weekly", usedPercent: 0 }],
      },
      "quota_stale",
    ],
    [
      "invalid time",
      {
        checkedAt: "invalid",
        windows: [{ id: "w", kind: "weekly", label: "Weekly", usedPercent: 0 }],
      },
      "quota_stale",
    ],
    [
      "future time",
      {
        checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now + 1_000)),
        windows: [{ id: "w", kind: "weekly", label: "Weekly", usedPercent: 0 }],
      },
      "quota_stale",
    ],
    [
      "passed reset",
      {
        checkedAt: timestamp,
        windows: [
          { id: "w", kind: "weekly", label: "Weekly", usedPercent: 0, resetsAt: timestamp },
        ],
      },
      "quota_stale",
    ],
  ] as const)("does not recommend an account with %s", (_name, limits, reason) => {
    const result = run([provider({ usageLimits: limits })]);
    expect(result.accounts[0]?.reason).toBe(reason);
    expect(result.recommendedInstanceId).toBeNull();
  });
  it("checks every window, including exhausted session allowance with spare weekly allowance", () => {
    const result = run([
      provider({
        usageLimits: {
          checkedAt: timestamp,
          windows: [
            { id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 10 },
            { id: "session", kind: "session", label: "Session", usedPercent: 100 },
          ],
        },
      }),
    ]);
    expect(result.accounts[0]).toMatchObject({ remainingPercent: 0, reason: "quota_reserved" });
    expect(result.recommendedInstanceId).toBeNull();
  });
  it("deduplicates accounts even when one alias has an extra identity field", () => {
    const result = run([
      provider(),
      provider({
        instanceId: b,
        auth: { status: "authenticated", profileId: "profile-a", email: "owner@example.test" },
      }),
    ]);
    expect(result.accounts.filter((account) => account.reason === "available")).toHaveLength(1);
    expect(result.accounts.find((account) => account.instanceId === b)?.reason).toBe(
      "shared_account",
    );
  });
  it("uses the most restrictive fresh allowance across aliases", () => {
    const result = run([
      provider(),
      provider({
        instanceId: b,
        usageLimits: {
          checkedAt: timestamp,
          windows: [{ id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 60 }],
        },
      }),
    ]);
    expect(result.accounts.find((account) => account.instanceId === a)?.remainingPercent).toBe(40);
  });
  it("does not recommend a code review skill for a reel review from one generic word", () => {
    const result = run(
      [
        provider({
          skills: [
            {
              name: "review",
              description: "Pre-landing PR review",
              path: "/review",
              enabled: true,
            },
          ],
        }),
      ],
      { ...input, task: "Review a video reel and improve captions" },
    );
    expect(result.skills).toEqual([]);
  });
  it("does not escape exhausted quota through a conflicting alias", () => {
    const result = run([
      provider(),
      provider({
        instanceId: b,
        usageLimits: {
          checkedAt: timestamp,
          windows: [{ id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 100 }],
        },
      }),
    ]);
    expect(result.recommendedInstanceId).toBeNull();
  });
  it("does not qualify an unsigned or unidentified second account", () => {
    expect(run([provider({ auth: { status: "unauthenticated" } })]).accounts[0]?.reason).toBe(
      "sign_in_required",
    );
    expect(run([provider({ auth: { status: "authenticated" } })]).accounts[0]?.reason).toBe(
      "identity_unknown",
    );
  });
  it("returns bounded skill metadata, excludes disabled and user-only skills", () => {
    const result = run(
      [
        provider({
          skills: [
            {
              name: "video-editing",
              path: "/skills/video",
              description: "Edit video reels and captions",
              enabled: true,
            },
            {
              name: "disabled",
              path: "/skills/disabled",
              description: "video reels captions",
              enabled: false,
            },
            {
              name: "user-only",
              path: "/skills/manual",
              description: "video reels captions",
              enabled: true,
              userInvocationOnly: true,
            },
          ],
        }),
      ],
      { ...input, task: "Edit video reels with captions" },
    );
    expect(result.skills.map((skill) => skill.name)).toEqual(["video-editing"]);
    expect(JSON.stringify(result.skills)).not.toContain("/skills/");
    expect(run([provider()], { ...input, task: "What is the weather?" }).skills).toEqual([]);
  });
  it("never borrows another project's skills when the requested snapshot is absent", () => {
    const p = provider({
      skills: [{ name: "reels", path: "/other", enabled: true }],
      workspaceSnapshots: [
        {
          cwd: "/other",
          checkedAt: timestamp,
          slashCommands: [],
          skills: [{ name: "reels", path: "/other", enabled: true }],
        },
      ],
    });
    const result = run([p], { ...input, cwd: "/current", task: "reels" });
    expect(result.skillCatalogAvailable).toBe(false);
    expect(result.skills).toEqual([]);
  });
  it("uses the exact requested project snapshot", () => {
    const result = run(
      [
        provider({
          workspaceSnapshots: [
            {
              cwd: "/current",
              checkedAt: timestamp,
              slashCommands: [],
              skills: [{ name: "reels", path: "/current/reels", enabled: true }],
            },
          ],
        }),
      ],
      { ...input, cwd: "/current", task: "reels" },
    );
    expect(result.skills.map((skill) => skill.name)).toEqual(["reels"]);
  });
  it("rejects oversized requests at the transport contract", () => {
    expect(isPreviewInput({ ...input, task: "x".repeat(4_001) })).toBe(false);
  });
  it("preserves explicit native choices including invocation-only skills and punctuation", () => {
    const skills = [
      { name: "chosen", path: "/chosen", enabled: true, userInvocationOnly: true },
      ...[1, 2, 3].map((i) => ({
        name: `review-${i}`,
        path: "/review",
        enabled: true,
        description: "Review code parser bugs and verification",
      })),
    ];
    const task = "Review code parser bugs and verification using ($chosen).";
    expect(run([provider({ skills })], { ...input, task }).skills[0]?.name).toBe("chosen");
    expect(
      run([provider({ skills })], { ...input, task: "Review code parser bugs" }).skills.map(
        (s) => s.name,
      ),
    ).not.toContain("chosen");
    expect(
      run([provider({ skills: [{ ...skills[0]!, enabled: false }] })], { ...input, task }).skills,
    ).toEqual([]);
  });
  effectIt.effect("keeps an explicit native choice when the managed shortlist is full", () =>
    Effect.gen(function* () {
      const service = yield* RoutingService.RoutingService;
      for (let index = 0; index < 3; index++) {
        const entry = yield* service.skillsAdmit({
          id: `reel-${index}`,
          name: `Reel ${index}`,
          description: "Review video reel captions",
          source: "fixture",
          sourceRevision: "1",
          sourceSha256: "a".repeat(64),
          reviewNote: "Fixture",
          permissions: [],
          projectRoots: [],
          dependencies: [],
          stages: [{ stage: "review", instructions: "Fixture stage" }],
        });
        yield* service.skillsSetEnabled({ ...entry, enabled: true });
      }
      const result = yield* service.preview({
        ...input,
        task: "Review video reel captions using $chosen.",
      });
      expect(result.managedSkills).toHaveLength(3);
      expect(result.skills).toHaveLength(3);
      expect(result.skills[0]?.name).toBe("chosen");
      expect(result.skills.some((s) => s.description.includes("Fixture stage"))).toBe(false);
    }).pipe(
      Effect.provide(routingLayer),
      Effect.provideService(
        ProviderRegistry.ProviderRegistry,
        mockRegistry([
          provider({
            skills: [{ name: "chosen", path: "/chosen", enabled: true, userInvocationOnly: true }],
          }),
        ]),
      ),
    ),
  );
  effectIt.effect(
    "runs the service against server snapshots without refreshing or invoking providers",
    () =>
      Effect.gen(function* () {
        const registry = mockRegistry([provider()]);
        const result = yield* Effect.gen(function* () {
          return yield* (yield* RoutingService.RoutingService).preview(input);
        }).pipe(
          Effect.provide(routingLayer),
          Effect.provideService(ProviderRegistry.ProviderRegistry, registry),
        );
        expect(result.selectionBudget).toMatchObject({
          status: "ready",
          availableMicroUsd: 1_000_000,
        });
        expect(result.accounts[0]?.instanceId).toBe(a);
        expect(result.automaticExecution).toBe(true);
        const unavailable = yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`DROP TABLE workbench_selection_charges`;
          return yield* (yield* RoutingService.RoutingService).preview(input);
        }).pipe(
          Effect.provide(routingLayer),
          Effect.provideService(ProviderRegistry.ProviderRegistry, registry),
        );
        expect(unavailable.selectionBudget).toEqual({ status: "unavailable" });
        expect(unavailable.accounts[0]?.instanceId).toBe(a);
      }),
  );
});

describe("automatic selection", () => {
  const effort = {
    id: "effort",
    label: "Effort",
    type: "select" as const,
    options: ["low", "medium", "high"].map((id) => ({ id, label: id })),
  };
  const claude = provider({
    driver: ProviderDriverKind.make("claudeAgent"),
    models: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-5"].map((slug) => ({
      slug,
      name: slug,
      isCustom: false,
      capabilities: { optionDescriptors: [effort] },
    })),
  });
  const current = { instanceId: a, model: "claude-sonnet-5" };
  const message = {
    commandId: "command-1",
    threadId: "thread-1",
    text: "Refactor the billing module and review the migration plan",
    attachmentCount: 0,
    current,
    pinned: false,
    newThread: true,
  };
  const select = (
    request: RoutingService.SelectInput,
    options: Parameters<typeof routingLayerWith>[0] = {},
    providers: ServerProvider[] = [claude],
  ) =>
    Effect.gen(function* () {
      const routing = yield* RoutingService.RoutingService;
      const decisions = yield* RoutingDecisionStore.RoutingDecisionStore;
      const { selection } = yield* routing.select(request);
      return {
        selection,
        last: yield* decisions.lastForThread(request.threadId),
        routing,
        decisions,
      };
    }).pipe(
      Effect.provide(routingLayerWith(options)),
      Effect.provideService(ProviderRegistry.ProviderRegistry, mockRegistry(providers)),
    );

  effectIt.effect("shadow mode records its pick without changing the model", () =>
    Effect.gen(function* () {
      const { selection, last } = yield* select(message, { settings: { routingMode: "shadow" } });
      expect(selection).toEqual(current);
      expect(last).toMatchObject({
        mode: "shadow",
        applied: false,
        judge: "local",
        fromModel: "claude-sonnet-5",
        toModel: "claude-opus-5",
        toEffort: "high",
      });
    }),
  );

  effectIt.effect("automatic mode moves model and effort within the provider", () =>
    Effect.gen(function* () {
      const { selection, last } = yield* select(message, {
        settings: { routingMode: "automatic" },
      });
      expect(selection).toEqual({
        instanceId: a,
        model: "claude-opus-5",
        options: [{ id: "effort", value: "high" }],
      });
      expect(last?.applied).toBe(true);
    }),
  );

  effectIt.effect("an unclear task keeps the arriving model and effort", () =>
    Effect.gen(function* () {
      const { selection, last } = yield* select(
        { ...message, text: "Add a loading state to the upload button" },
        { settings: { routingMode: "automatic" } },
      );
      expect(selection).toEqual(current);
      expect(last?.toModel).toBe("claude-sonnet-5");
    }),
  );

  effectIt.effect("a provider without a ladder adapts effort only", () =>
    Effect.gen(function* () {
      const grok = provider({
        models: [
          {
            slug: "model",
            name: "Model",
            isCustom: false,
            capabilities: { optionDescriptors: [effort] },
          },
        ],
      });
      const { selection } = yield* select(
        { ...message, current: { instanceId: a, model: "model" } },
        { settings: { routingMode: "automatic" } },
        [grok],
      );
      expect(selection).toEqual({
        instanceId: a,
        model: "model",
        options: [{ id: "effort", value: "high" }],
      });
    }),
  );

  effectIt.effect("a configured ladder overrides the seeded one", () =>
    Effect.gen(function* () {
      const { selection } = yield* select(message, {
        settings: {
          routingMode: "automatic",
          routingLadders: { [a]: { advanced: "claude-sonnet-5" } },
        },
      });
      expect(selection.model).toBe("claude-sonnet-5");
    }),
  );

  effectIt.effect("a thread that already ran keeps its model and effort", () =>
    Effect.gen(function* () {
      const settings = { routingMode: "automatic" as const };
      const started = yield* select(message, { settings });
      expect(started.selection.model).toBe("claude-opus-5");

      // The same task that moved a new thread to Opus must not move a running one.
      const running = { ...message, commandId: "command-2", newThread: false };
      const kept = yield* select(running, { settings });
      expect(kept.selection).toEqual(current);
      expect(kept.last).toMatchObject({
        applied: true,
        fromModel: "claude-sonnet-5",
        toModel: "claude-sonnet-5",
      });
      expect(kept.last?.reason).toContain("Kept this thread's model");

      const question = { ...running, commandId: "command-3", text: "What does this do?" };
      expect((yield* select(question, { settings })).selection).toEqual(current);
    }),
  );

  effectIt.effect("only a pick that changed something counts as overridden, however late", () =>
    Effect.gen(function* () {
      const routing = yield* RoutingService.RoutingService;
      const decisions = yield* RoutingDecisionStore.RoutingDecisionStore;
      const running = { ...message, newThread: false };
      // An unclear first message changes nothing, so a later hand pick overrides nothing.
      yield* routing.select({ ...message, text: "Add a loading state to the upload button" });
      const haiku = { instanceId: a, model: "claude-haiku-5" };
      yield* routing.select({ ...running, commandId: "command-2", current: haiku, pinned: true });
      expect(yield* decisions.scorecard).toMatchObject({ changed: 0, overridden: 0 });
      // The router moves a second thread to Opus; two messages later the person moves it back.
      const second = { ...message, threadId: "thread-2", commandId: "command-3" };
      const opus = {
        instanceId: a,
        model: "claude-opus-5",
        options: [{ id: "effort", value: "high" }],
      };
      yield* routing.select(second);
      yield* routing.select({ ...second, commandId: "command-4", newThread: false, current: opus });
      yield* routing.select({ ...second, commandId: "command-5", newThread: false, pinned: true });
      expect(yield* decisions.scorecard).toMatchObject({ changed: 1, overridden: 1 });
    }).pipe(
      Effect.provide(routingLayerWith({ settings: { routingMode: "automatic" } })),
      Effect.provideService(ProviderRegistry.ProviderRegistry, mockRegistry([claude])),
    ),
  );

  effectIt.effect("a pick that changed a model outlives the trimmed history and is counted", () =>
    Effect.gen(function* () {
      const routing = yield* RoutingService.RoutingService;
      const decisions = yield* RoutingDecisionStore.RoutingDecisionStore;
      yield* routing.select(message);
      const kept = yield* decisions.lastForThread("thread-1");
      // More than a full history of messages that changed nothing.
      for (let index = 0; index < 505; index++)
        yield* decisions.record({
          ...kept!,
          commandId: `quiet-${index}`,
          threadId: "thread-quiet",
          decidedAt: DateTime.formatIso(DateTime.makeUnsafe(now + 60_000 + index)),
          fromModel: "claude-opus-5",
          fromEffort: "high",
        });
      const { moves } = yield* decisions.movedThreads;
      expect(moves).toEqual([
        expect.objectContaining({ fromModel: "claude-sonnet-5", toModel: "claude-opus-5" }),
      ]);
      // No price table in this suite: the move is reported as unpriced, not as a saving.
      const preview = yield* routing.preview({ instanceId: a, task: "", cwd: null });
      expect(preview.scorecard?.savings).toMatchObject({
        unpricedThreads: 1,
        lighter: { threads: 0 },
      });
      // Moved back by hand, it is no longer counted at all.
      yield* decisions.markOverridden("command-1");
      expect((yield* decisions.movedThreads).moves).toEqual([]);
    }).pipe(
      Effect.provide(routingLayerWith({ settings: { routingMode: "automatic" } })),
      Effect.provideService(ProviderRegistry.ProviderRegistry, mockRegistry([claude])),
    ),
  );

  effectIt.effect("a hand-picked model is not rerouted and counts against the last pick", () =>
    Effect.gen(function* () {
      const routing = yield* RoutingService.RoutingService;
      const decisions = yield* RoutingDecisionStore.RoutingDecisionStore;
      yield* routing.select(message);
      const pinned = { instanceId: a, model: "claude-haiku-5" };
      expect(
        yield* routing.select({
          ...message,
          commandId: "command-2",
          current: pinned,
          pinned: true,
        }),
      ).toEqual({ selection: pinned, skill: null });
      expect(yield* decisions.scorecard).toMatchObject({ total: 1, changed: 1, overridden: 1 });
      // Keeping the router's model but choosing another effort is an override too.
      yield* routing.select({ ...message, commandId: "command-3" });
      yield* routing.select({
        ...message,
        commandId: "command-4",
        current: {
          instanceId: a,
          model: "claude-opus-5",
          options: [{ id: "effort", value: "low" }],
        },
        pinned: true,
      });
      expect(yield* decisions.scorecard).toMatchObject({ total: 2, overridden: 2 });
    }).pipe(
      Effect.provide(routingLayerWith({ settings: { routingMode: "automatic" } })),
      Effect.provideService(ProviderRegistry.ProviderRegistry, mockRegistry([claude])),
    ),
  );

  effectIt.effect("falls back to local rules when the selection budget blocks Jev", () =>
    Effect.gen(function* () {
      const { last } = yield* select(message, {
        advisor: {
          configured: Effect.succeed(true),
          assess: () => Effect.fail(new RoutingJudgmentError({ reason: "budget_blocked" })),
        },
      });
      expect(last).toMatchObject({ judge: "local", toModel: "claude-opus-5" });
    }),
  );

  effectIt.effect("uses Jev's judgment when it answers", () =>
    Effect.gen(function* () {
      const { last } = yield* select(message, {
        advisor: {
          configured: Effect.succeed(true),
          assess: () =>
            Effect.succeed({
              requestId: "test",
              receiptId: "receipt",
              model: "typesafe/jev-1.13",
              costMicroUsd: 10,
              inputTokens: 10,
              capability: "basic",
              effort: "low",
              skillName: null,
              confidence: { capability: 0.7, effort: 0.9, skill: 0 },
            }),
        },
      });
      expect(last).toMatchObject({ judge: "jev", toModel: "claude-haiku-5", toEffort: "low" });
    }),
  );

  const jevSays = (
    capability: "basic" | "standard" | "advanced" | "unknown",
    effort: "low" | "medium" | "high",
    confidence: number,
  ) => ({
    configured: Effect.succeed(true),
    assess: () =>
      Effect.succeed({
        requestId: "test",
        receiptId: "receipt",
        model: "typesafe/jev-1.13",
        costMicroUsd: 10,
        inputTokens: 10,
        capability,
        effort,
        skillName: null,
        confidence: { capability: confidence, effort: confidence, skill: 0 },
      }),
  });

  effectIt.effect("an unsure Jev moves nothing, whatever keywords the message holds", () =>
    Effect.gen(function* () {
      // "Refactor", "review" and "plan" would send this to Opus on keyword rules alone.
      const { selection, last } = yield* select(message, { advisor: jevSays("basic", "low", 0.4) });
      expect(selection).toEqual(current);
      expect(last).toMatchObject({ judge: "jev", toModel: "claude-sonnet-5" });
    }),
  );

  effectIt.effect("text that is no task on its own changes neither model nor effort", () =>
    Effect.gen(function* () {
      const { selection } = yield* select(
        { ...message, text: "try now" },
        { advisor: jevSays("unknown", "low", 0.95) },
      );
      expect(selection).toEqual(current);
    }),
  );

  effectIt.effect("a model chosen from outside the ladder is not moved down to its top rung", () =>
    Effect.gen(function* () {
      const withFable = {
        ...claude,
        models: [
          {
            slug: "claude-fable-5",
            name: "claude-fable-5",
            isCustom: false,
            capabilities: { optionDescriptors: [effort] },
          },
          ...claude.models.map((model) => ({
            ...model,
            isDefault: model.slug === "claude-opus-5",
          })),
        ],
      };
      const fable = { instanceId: a, model: "claude-fable-5" };
      const hard = yield* select(
        { ...message, current: fable },
        { advisor: jevSays("advanced", "high", 0.9) },
        [withFable],
      );
      expect(hard.last).toMatchObject({ toModel: "claude-fable-5", toEffort: "high" });
      expect(hard.last?.reason).toContain("outside Auto's three");
      // The account's default is where threads start, so it still moves.
      const fromDefault = yield* select(
        { ...message, current: { instanceId: a, model: "claude-opus-5" } },
        {
          advisor: jevSays("standard", "medium", 0.9),
          settings: { routingLadders: { [a]: { standard: "claude-sonnet-5" } } },
        },
        [withFable],
      );
      expect(fromDefault.last?.toModel).toBe("claude-sonnet-5");
    }),
  );

  effectIt.effect("effort goes up for any task and down only for a simple one", () =>
    Effect.gen(function* () {
      const onHigh = { ...current, options: [{ id: "effort", value: "high" }] };
      const onLow = { ...current, options: [{ id: "effort", value: "low" }] };
      const ordinary = yield* select(
        { ...message, current: onHigh },
        { advisor: jevSays("standard", "low", 0.9) },
      );
      expect(ordinary.last).toMatchObject({ toModel: "claude-sonnet-5", toEffort: "high" });
      expect(ordinary.last?.reason).toContain("only simple tasks are turned down");
      const simple = yield* select(
        { ...message, current: onHigh },
        { advisor: jevSays("basic", "low", 0.9) },
      );
      expect(simple.last).toMatchObject({ toModel: "claude-haiku-5", toEffort: "low" });
      const hard = yield* select(
        { ...message, current: onLow },
        { advisor: jevSays("advanced", "high", 0.9) },
      );
      expect(hard.last).toMatchObject({ toModel: "claude-opus-5", toEffort: "high" });
    }),
  );

  effectIt.effect("writing for a reader is never turned down, other simple tasks still are", () =>
    Effect.gen(function* () {
      const onHigh = { ...current, options: [{ id: "effort", value: "high" }] };
      const writing = yield* select(
        { ...message, text: "write the download page", current: onHigh },
        { advisor: jevSays("basic", "low", 0.9) },
      );
      expect(writing.last).toMatchObject({ toModel: "claude-sonnet-5", toEffort: "high" });
      expect(writing.last?.reason).toContain("writing for a reader is never turned down");
      const fresh = yield* select(
        { ...message, text: "update my résumé" },
        { advisor: jevSays("basic", "low", 0.9) },
      );
      expect(fresh.last).toMatchObject({ toModel: "claude-sonnet-5", toEffort: "medium" });
      const simple = yield* select(
        { ...message, text: "what does this function do?" },
        { advisor: jevSays("basic", "low", 0.9) },
      );
      expect(simple.last).toMatchObject({ toModel: "claude-haiku-5", toEffort: "low" });
      expect(simple.last?.reason).not.toContain("writing for a reader");
    }),
  );

  effectIt.effect("a short reply in a running thread is not sent to Jev; a real request is", () =>
    Effect.gen(function* () {
      const tasks: string[] = [];
      const advisor = {
        configured: Effect.succeed(true),
        assess: (request: { task: string }) => {
          tasks.push(request.task);
          return Effect.fail(new RoutingJudgmentError({ reason: "budget_blocked" }));
        },
      };
      const running = { ...message, newThread: false };
      yield* select({ ...running, text: "i ran it, try now" }, { advisor });
      expect(tasks).toEqual([]);
      yield* select(
        { ...running, text: "Now add the same check to the invoice export page" },
        {
          advisor,
        },
      );
      // The same few words opening a thread are all there is to judge, so they are sent.
      yield* select({ ...message, text: "try now" }, { advisor });
      expect(tasks).toEqual(["Now add the same check to the invoice export page", "try now"]);
    }),
  );

  effectIt.effect("saving usage never leaves hard work on the lowest effort", () =>
    Effect.gen(function* () {
      const { last } = yield* select(message, {
        advisor: jevSays("advanced", "medium", 0.9),
        settings: { routingPreference: "save" },
      });
      expect(last).toMatchObject({ toModel: "claude-opus-5", toEffort: "medium" });
    }),
  );

  effectIt.effect("attaches the skill Jev picked, unless the message already carries one", () =>
    Effect.gen(function* () {
      const routing = yield* RoutingService.RoutingService;
      const catalog = yield* ManagedSkillCatalog.ManagedSkillCatalog;
      const decisions = yield* RoutingDecisionStore.RoutingDecisionStore;
      const entry = yield* catalog.admit({
        id: "billing-review",
        name: "Billing Review",
        description: "Review billing migrations",
        source: "local:fixture",
        sourceRevision: "1",
        sourceSha256: "a".repeat(64),
        reviewNote: "Fixture",
        permissions: ["read the repository"],
        projectRoots: [],
        dependencies: [],
        stages: [{ stage: "implement", instructions: "Check every migration twice." }],
      });
      yield* catalog.setEnabled({ ...entry, enabled: true });
      const routed = yield* routing.select(message);
      expect(routed.skill).toContain(`[Workbench skill billing-review@${entry.revision}`);
      expect(routed.skill).toContain("Check every migration twice.");
      expect(yield* decisions.lastForThread("thread-1")).toMatchObject({
        skillName: "Billing Review",
      });
      const already = yield* routing.select({
        ...message,
        commandId: "command-2",
        text: `${message.text}\n\n${routed.skill}`,
      });
      expect(already.skill).toBeNull();
    }).pipe(
      Effect.provide(
        routingLayerWith({
          settings: { routingMode: "automatic" },
          advisor: {
            configured: Effect.succeed(true),
            assess: () =>
              Effect.succeed({
                requestId: "test",
                receiptId: "receipt",
                model: "typesafe/jev-1.13",
                costMicroUsd: 10,
                inputTokens: 10,
                capability: "advanced",
                effort: "high",
                skillName: "managed:billing-review",
                confidence: { capability: 0.9, effort: 0.9, skill: 0.9 },
              }),
          },
        }),
      ),
      Effect.provideService(ProviderRegistry.ProviderRegistry, mockRegistry([claude])),
    ),
  );

  effectIt.effect("attaches no skill to text Jev calls no task of its own", () =>
    Effect.gen(function* () {
      const routing = yield* RoutingService.RoutingService;
      const catalog = yield* ManagedSkillCatalog.ManagedSkillCatalog;
      const entry = yield* catalog.admit({
        id: "deploy-check",
        name: "Deploy Check",
        description: "Verify a deploy",
        source: "local:fixture",
        sourceRevision: "1",
        sourceSha256: "b".repeat(64),
        reviewNote: "Fixture",
        permissions: ["read the repository"],
        projectRoots: [],
        dependencies: [],
        stages: [{ stage: "implement", instructions: "Check the release." }],
      });
      yield* catalog.setEnabled({ ...entry, enabled: true });
      const routed = yield* routing.select({
        ...message,
        newThread: false,
        text: "finish everything first and THEN we will get to that other part",
      });
      expect(routed.skill).toBeNull();
    }).pipe(
      Effect.provide(
        routingLayerWith({
          settings: { routingMode: "automatic" },
          advisor: {
            configured: Effect.succeed(true),
            assess: () =>
              Effect.succeed({
                requestId: "test",
                receiptId: "receipt",
                model: "typesafe/jev-1.13",
                costMicroUsd: 10,
                inputTokens: 10,
                capability: "unknown",
                effort: "low",
                skillName: "managed:deploy-check",
                confidence: { capability: 0.9, effort: 0.9, skill: 0.9 },
              }),
          },
        }),
      ),
      Effect.provideService(ProviderRegistry.ProviderRegistry, mockRegistry([claude])),
    ),
  );

  effectIt.effect("attaches every skill Jev rated relevant, and a named skill without Jev", () =>
    Effect.gen(function* () {
      const routing = yield* RoutingService.RoutingService;
      const catalog = yield* ManagedSkillCatalog.ManagedSkillCatalog;
      const decisions = yield* RoutingDecisionStore.RoutingDecisionStore;
      const admit = (id: string, name: string) =>
        catalog
          .admit({
            id,
            name,
            description: `${name} description`,
            source: "local:fixture",
            sourceRevision: "1",
            sourceSha256: "a".repeat(64),
            reviewNote: "Fixture",
            permissions: [],
            projectRoots: [],
            dependencies: [],
            stages: [{ stage: "implement", instructions: `Follow ${name}.` }],
          })
          .pipe(Effect.tap((entry) => catalog.setEnabled({ ...entry, enabled: true })));
      yield* admit("billing-review", "Billing Review");
      yield* admit("migrations", "Migrations");
      yield* admit("premortem", "Premortem");
      const routed = yield* routing.select(message);
      expect(routed.skill).toContain("Follow Billing Review.");
      expect(routed.skill).toContain("Follow Migrations.");
      expect(routed.skill).not.toContain("Follow Premortem.");
      expect(yield* decisions.lastForThread("thread-1")).toMatchObject({
        skillName: "Billing Review",
        skillNames: ["Billing Review", "Migrations"],
      });
      // A skill named in the message is attached first, whatever Jev thought.
      const named = yield* routing.select({
        ...message,
        commandId: "command-2",
        text: `${message.text} Use $premortem first.`,
      });
      expect(named.skill?.indexOf("Follow Premortem.")).toBeLessThan(
        named.skill?.indexOf("Follow Billing Review.") ?? -1,
      );
    }).pipe(
      Effect.provide(
        routingLayerWith({
          settings: { routingMode: "automatic" },
          advisor: {
            configured: Effect.succeed(true),
            assess: () =>
              Effect.succeed({
                requestId: "test",
                receiptId: "receipt",
                model: "jev-1.13.0",
                costMicroUsd: 10,
                inputTokens: 10,
                capability: "advanced",
                effort: "high",
                skillName: "managed:billing-review",
                skillNames: ["managed:billing-review", "managed:migrations"],
                confidence: { capability: 0.9, effort: 0.9, skill: 0.9 },
              }),
          },
        }),
      ),
      Effect.provideService(ProviderRegistry.ProviderRegistry, mockRegistry([claude])),
    ),
  );

  const seen: string[][] = [];
  effectIt.effect("shows Jev one candidate for a skill that arrived twice", () =>
    Effect.gen(function* () {
      seen.length = 0;
      const routing = yield* RoutingService.RoutingService;
      const catalog = yield* ManagedSkillCatalog.ManagedSkillCatalog;
      const admit = (id: string, source: string, sha: string) =>
        catalog
          .admit({
            id,
            name: id,
            description: "Find the root cause of a bug.",
            source,
            sourceRevision: "1",
            sourceSha256: sha.repeat(64),
            reviewNote: "Fixture",
            permissions: [],
            projectRoots: [],
            dependencies: [],
            stages: [{ stage: "implement", instructions: `Follow ${id}.` }],
          })
          .pipe(Effect.tap((entry) => catalog.setEnabled({ ...entry, enabled: true })));
      yield* admit("plugin-superpowers-debugging", "plugin-library:superpowers/debugging", "b");
      yield* admit("debugging", "local-library:debugging/SKILL.md", "a");
      yield* routing.select({ ...message, text: "Add a loading state to the upload button" });
      expect(seen).toEqual([["managed:debugging"]]);
    }).pipe(
      Effect.provide(
        routingLayerWith({
          settings: { routingMode: "automatic" },
          advisor: {
            configured: Effect.succeed(true),
            assess: (request) => {
              seen.push(request.skills.map((skill) => skill.name));
              return Effect.die("stop here");
            },
          },
        }),
      ),
      Effect.provideService(ProviderRegistry.ProviderRegistry, mockRegistry([claude])),
    ),
  );

  effectIt.effect("a typed /name attaches that skill while the list is hidden, and only then", () =>
    Effect.gen(function* () {
      const routing = yield* RoutingService.RoutingService;
      const catalog = yield* ManagedSkillCatalog.ManagedSkillCatalog;
      const entry = yield* catalog.admit({
        id: "billing-review",
        name: "Billing Review",
        description: "Review billing migrations",
        source: "local:fixture",
        sourceRevision: "1",
        sourceSha256: "a".repeat(64),
        reviewNote: "Fixture",
        permissions: [],
        projectRoots: [],
        dependencies: [],
        stages: [{ stage: "implement", instructions: "Check every migration twice." }],
      });
      yield* catalog.setEnabled({ ...entry, enabled: true });
      const typed = yield* routing.select({
        ...message,
        text: "/billing-review the March invoices",
      });
      expect(typed.skill).toContain("Check every migration twice.");
      // The provider reads `$name`, which it leaves as prose; `/name` would be an unknown command.
      expect(typed.text).toBe("$billing-review the March invoices");
      // Uppercase and the skill's display name work too.
      expect((yield* routing.select({ ...message, text: "/Billing-Review go" })).text).toBe(
        "$Billing-Review go",
      );
      // A slash command that is not a skill, or a slash later in the message, is left alone.
      const command = yield* routing.select({ ...message, text: "/compact now" });
      expect(command.skill).toBeNull();
      expect(command.text).toBeUndefined();
      const later = yield* routing.select({ ...message, text: "please run /billing-review" });
      expect(later.text).toBeUndefined();
    }).pipe(
      Effect.provide(
        routingLayerWith({
          settings: { routingMode: "automatic", skillListing: "selected" },
          syncs: [],
        }),
      ),
      Effect.provideService(ProviderRegistry.ProviderRegistry, mockRegistry([claude])),
    ),
  );

  describe("an agent's message, with its history ahead of the request", () => {
    const history = `<workbench-agent>\n${"Earlier work on the billing module.\n".repeat(400)}\n</workbench-agent>\n\n`;
    const admit = (catalog: ManagedSkillCatalog.ManagedSkillCatalog["Service"]) =>
      catalog
        .admit({
          id: "billing-review",
          name: "Billing Review",
          description: "Review billing migrations",
          source: "local:fixture",
          sourceRevision: "1",
          sourceSha256: "a".repeat(64),
          reviewNote: "Fixture",
          permissions: [],
          projectRoots: [],
          dependencies: [],
          stages: [{ stage: "implement", instructions: "Check every migration twice." }],
        })
        .pipe(Effect.tap((entry) => catalog.setEnabled({ ...entry, enabled: true })));

    effectIt.effect("judges the request, not the history, even when the history is long", () =>
      Effect.gen(function* () {
        const tasks: string[] = [];
        const { selection, last } = yield* select(
          { ...message, text: `${history}whats the weather today?` },
          {
            settings: { routingMode: "automatic" },
            advisor: {
              configured: Effect.succeed(true),
              assess: (request) => {
                tasks.push(request.task);
                return Effect.fail(new RoutingJudgmentError({ reason: "budget_blocked" }));
              },
            },
          },
        );
        expect(history.length).toBeGreaterThan(10_000);
        expect(tasks).toEqual(["whats the weather today?"]);
        expect(last?.judge).toBe("local");
        expect(selection).toEqual({
          instanceId: a,
          model: "claude-haiku-5",
          options: [{ id: "effort", value: "low" }],
        });
      }),
    );

    effectIt.effect("sends Jev only the request", () =>
      Effect.gen(function* () {
        const tasks: string[] = [];
        yield* select(
          { ...message, text: `${history}Add a loading state to the upload button` },
          {
            settings: { routingMode: "automatic" },
            advisor: {
              configured: Effect.succeed(true),
              assess: (request) => {
                tasks.push(request.task);
                return Effect.die("stop here");
              },
            },
          },
        );
        expect(tasks).toEqual(["Add a loading state to the upload button"]);
      }),
    );

    effectIt.effect("a $name or /name in the request attaches, and /name keeps the history", () =>
      Effect.gen(function* () {
        const routing = yield* RoutingService.RoutingService;
        yield* admit(yield* ManagedSkillCatalog.ManagedSkillCatalog);
        const named = yield* routing.select({
          ...message,
          text: `${history}Use $billing-review on the March invoices`,
        });
        expect(named.skill).toContain("Check every migration twice.");
        const typed = yield* routing.select({
          ...message,
          commandId: "command-2",
          text: `${history}/billing-review the March invoices`,
        });
        expect(typed.skill).toContain("Check every migration twice.");
        expect(typed.text).toBe(`${history}$billing-review the March invoices`);
        // A skill named only in the history is not the person's request.
        const inHistory = yield* routing.select({
          ...message,
          commandId: "command-3",
          text: `<workbench-agent>\nUse $billing-review\n</workbench-agent>\n\nwhats the weather?`,
        });
        expect(inHistory.skill).toBeNull();
      }).pipe(
        Effect.provide(
          routingLayerWith({
            settings: { routingMode: "automatic", skillListing: "selected" },
            syncs: [],
          }),
        ),
        Effect.provideService(ProviderRegistry.ProviderRegistry, mockRegistry([claude])),
      ),
    );
  });

  effectIt.effect("a typed /name is not special while every provider lists its own skills", () =>
    Effect.gen(function* () {
      const routing = yield* RoutingService.RoutingService;
      const catalog = yield* ManagedSkillCatalog.ManagedSkillCatalog;
      const entry = yield* catalog.admit({
        id: "billing-review",
        name: "Billing Review",
        description: "Review billing migrations",
        source: "local:fixture",
        sourceRevision: "1",
        sourceSha256: "a".repeat(64),
        reviewNote: "Fixture",
        permissions: [],
        projectRoots: [],
        dependencies: [],
        stages: [{ stage: "implement", instructions: "Check every migration twice." }],
      });
      yield* catalog.setEnabled({ ...entry, enabled: true });
      const typed = yield* routing.select({
        ...message,
        text: "/billing-review the March invoices",
      });
      expect(typed.text).toBeUndefined();
      expect(typed.skill).toBeNull();
    }).pipe(
      Effect.provide(
        routingLayerWith({
          settings: { routingMode: "automatic", skillListing: "all" },
        }),
      ),
      Effect.provideService(ProviderRegistry.ProviderRegistry, mockRegistry([claude])),
    ),
  );

  effectIt.effect("a short follow-up reuses the thread's last judgment", () =>
    Effect.gen(function* () {
      const routing = yield* RoutingService.RoutingService;
      const decisions = yield* RoutingDecisionStore.RoutingDecisionStore;
      yield* routing.select(message);
      yield* routing.select({ ...message, commandId: "command-2", text: "continue" });
      expect(yield* decisions.lastForThread("thread-1")).toMatchObject({
        commandId: "command-2",
        judge: "reused",
        toModel: "claude-opus-5",
      });
    }).pipe(
      Effect.provide(routingLayerWith()),
      Effect.provideService(ProviderRegistry.ProviderRegistry, mockRegistry([claude])),
    ),
  );

  effectIt.effect("a plain question goes to the small model when Jev cannot answer", () =>
    Effect.gen(function* () {
      const { selection, last } = yield* select(
        { ...message, text: "whats the weather today?" },
        {
          advisor: {
            configured: Effect.succeed(true),
            assess: () => Effect.fail(new RoutingJudgmentError({ reason: "budget_blocked" })),
          },
        },
      );
      expect(selection).toEqual({
        instanceId: a,
        model: "claude-haiku-5",
        options: [{ id: "effort", value: "low" }],
      });
      expect(last?.judge).toBe("local");
    }),
  );

  effectIt.effect("the preference shifts effort without overriding the judgment", () =>
    Effect.gen(function* () {
      const save = yield* select(message, { settings: { routingPreference: "save" } });
      expect(save.last).toMatchObject({ toModel: "claude-opus-5", toEffort: "medium" });
      const quality = yield* select(
        { ...message, text: "whats the weather today?" },
        { settings: { routingPreference: "quality" } },
      );
      expect(quality.last).toMatchObject({ toModel: "claude-sonnet-5", toEffort: "medium" });
    }),
  );

  effectIt.effect("usage ahead of the week steps down, and hard work keeps its model", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now);
      // Three and a half days left of seven: half the week gone, 80% used.
      const resetsAt = DateTime.formatIso(DateTime.makeUnsafe(now + 3.5 * 24 * 3_600_000));
      const paced = {
        ...claude,
        usageLimits: {
          checkedAt: timestamp,
          windows: [
            { id: "weekly", kind: "weekly" as const, label: "Weekly", usedPercent: 80, resetsAt },
          ],
        },
      };
      const ordinary = yield* select(
        { ...message, text: "Add a loading state to the upload button" },
        { settings: { routingLadders: { [a]: { basic: "claude-haiku-5" } } } },
        [paced],
      );
      // "standard" at 50% confidence would normally hold; pacing only applies to a clear call.
      expect(ordinary.last?.reason).toContain(
        "ahead of weekly pace (80% used, 50% of the week gone)",
      );
      const hard = yield* select(message, {}, [paced]);
      expect(hard.last).toMatchObject({ toModel: "claude-opus-5", toEffort: "medium" });
      const off = yield* select(message, { settings: { routingPacing: false } }, [paced]);
      expect(off.last).toMatchObject({ toModel: "claude-opus-5", toEffort: "high" });
    }),
  );

  effectIt.effect("tiers are read from model names on any provider", () =>
    Effect.gen(function* () {
      const other = provider({
        models: ["gemini-3-pro", "gemini-3", "gemini-3-flash"].map((slug) => ({
          slug,
          name: slug,
          isCustom: false,
          isDefault: slug === "gemini-3",
          capabilities: null,
        })),
      });
      const question = yield* select(
        { ...message, text: "what is a monad?", current: { instanceId: a, model: "gemini-3" } },
        {},
        [other],
      );
      expect(question.last?.toModel).toBe("gemini-3-flash");
      const hard = yield* select(
        { ...message, current: { instanceId: a, model: "gemini-3" } },
        {},
        [other],
      );
      expect(hard.last?.toModel).toBe("gemini-3-pro");
    }),
  );

  effectIt.effect("manual mode decides nothing", () =>
    Effect.gen(function* () {
      const { selection, last } = yield* select(message, { settings: { routingMode: "manual" } });
      expect(selection).toEqual(current);
      expect(last).toBeNull();
    }),
  );

  effectIt.effect("a new thread starts on the recommended account when its own is signed out", () =>
    Effect.gen(function* () {
      // Allowance freshness is judged against the clock.
      yield* TestClock.setTime(now);
      const signedOut = { ...claude, auth: { status: "unauthenticated" as const } };
      const other = {
        ...claude,
        instanceId: b,
        auth: { status: "authenticated" as const, profileId: "profile-b" },
      };
      const { selection } = yield* select(
        { ...message, newThread: true },
        { settings: { routingMode: "automatic" } },
        [signedOut, other],
      );
      expect(selection.instanceId).toBe(b);
      expect(selection.model).toBe("claude-opus-5");
    }),
  );
});

describe("switching on the user's skills", () => {
  const settle = Effect.yieldNow.pipe(Effect.repeat({ times: 20 }));
  const withSyncs = <A, E, R = never>(
    options: Parameters<typeof routingLayerWith>[0],
    use: (routing: RoutingService.RoutingService["Service"]) => Effect.Effect<A, E, R>,
  ) =>
    Effect.gen(function* () {
      const routing = yield* RoutingService.RoutingService;
      yield* settle;
      return yield* use(routing);
    }).pipe(
      Effect.provide(routingLayerWith(options)),
      Effect.provideService(ProviderRegistry.ProviderRegistry, mockRegistry([provider()])),
    );

  effectIt.effect("syncs once on start when only the needed skills are loaded", () =>
    Effect.gen(function* () {
      const syncs: Array<{ enable: boolean }> = [];
      yield* withSyncs({ settings: { skillListing: "selected" }, syncs }, () => Effect.void);
      expect(syncs).toEqual([{ enable: true }]);
    }),
  );

  effectIt.effect("does nothing on start while every skill is listed", () =>
    Effect.gen(function* () {
      const syncs: Array<{ enable: boolean }> = [];
      yield* withSyncs({ settings: { skillListing: "all" }, syncs }, () => Effect.void);
      expect(syncs).toEqual([]);
    }),
  );

  effectIt.effect("syncs when the listing changes to selected, and not on other changes", () =>
    Effect.gen(function* () {
      const syncs: Array<{ enable: boolean }> = [];
      const changes = yield* Queue.unbounded<ContractServerSettings>();
      yield* withSyncs({ settings: { skillListing: "all" }, syncs, changes }, () =>
        Effect.gen(function* () {
          const store = yield* ServerSettings.ServerSettingsService;
          const selected = yield* store.updateSettings({ skillListing: "selected" });
          yield* Queue.offer(changes, selected);
          yield* settle;
          expect(syncs).toHaveLength(1);
          // Another setting changing while the listing stays selected is not a reason to sync.
          const other = yield* store.updateSettings({ routingPacing: false });
          yield* Queue.offer(changes, other);
          yield* settle;
          expect(syncs).toHaveLength(1);
        }),
      );
    }),
  );

  effectIt.effect("connecting Jev syncs while selected, and a failed sync does not fail it", () =>
    Effect.gen(function* () {
      const syncs: Array<{ enable: boolean }> = [];
      const connected = yield* withSyncs(
        {
          settings: { skillListing: "selected" },
          syncs,
          failSync: true,
          advisor: { configure: () => Effect.succeed({ configured: true }) },
        },
        (routing) => routing.configure({ action: "connect", key: Redacted.make("test-key") }),
      );
      expect(connected).toEqual({ configured: true });
      // One on start and one for the connection, both failing without effect.
      expect(syncs).toHaveLength(2);

      // While every provider lists its own skills, a Jev that is not yet connected has no
      // catalog to read, so the connection alone is not a reason to sync.
      const quiet: Array<{ enable: boolean }> = [];
      yield* withSyncs(
        {
          settings: { skillListing: "all" },
          syncs: quiet,
          advisor: { configure: () => Effect.succeed({ configured: true }) },
        },
        (routing) => routing.configure({ action: "connect", key: Redacted.make("test-key") }),
      );
      expect(quiet).toEqual([]);
    }),
  );

  effectIt.effect(
    "a connected Jev has the skills switched on even while providers list theirs",
    () =>
      Effect.gen(function* () {
        const syncs: Array<{ enable: boolean }> = [];
        yield* withSyncs(
          {
            settings: { skillListing: "all" },
            syncs,
            advisor: { configured: Effect.succeed(true) },
          },
          () => Effect.void,
        );
        expect(syncs).toEqual([{ enable: true }]);
      }),
  );

  effectIt.effect("a change in the skill folders syncs again, and only when skills matter", () =>
    Effect.gen(function* () {
      const folder = yield* Queue.unbounded<void>();
      const syncs: Array<{ enable: boolean }> = [];
      yield* withSyncs(
        {
          settings: { skillListing: "selected" },
          syncs,
          folderChanges: Stream.fromQueue(folder),
        },
        () =>
          Effect.gen(function* () {
            expect(syncs).toHaveLength(1);
            yield* Queue.offer(folder, undefined);
            yield* settle;
            expect(syncs).toHaveLength(2);
            yield* Queue.offer(folder, undefined);
            yield* settle;
            expect(syncs).toHaveLength(3);
          }),
      );

      const idle = yield* Queue.unbounded<void>();
      const unused: Array<{ enable: boolean }> = [];
      yield* withSyncs(
        { settings: { skillListing: "all" }, syncs: unused, folderChanges: Stream.fromQueue(idle) },
        () =>
          Effect.gen(function* () {
            yield* Queue.offer(idle, undefined);
            yield* settle;
            expect(unused).toEqual([]);
          }),
      );
    }),
  );

  effectIt.effect("a message re-syncs at most once every ten minutes", () =>
    Effect.gen(function* () {
      const syncs: Array<{ enable: boolean }> = [];
      yield* withSyncs({ settings: { skillListing: "selected" }, syncs }, (routing) =>
        Effect.gen(function* () {
          yield* routing.preview({ ...input, task: "write a report" });
          expect(syncs).toHaveLength(1);
          yield* TestClock.adjust("11 minutes");
          yield* routing.preview({ ...input, task: "write a report" });
          yield* routing.preview({ ...input, task: "write a report" });
          expect(syncs).toHaveLength(2);
        }),
      );
    }),
  );

  effectIt.effect("predicts a new thread's pick only while Auto is on and never for a thread", () =>
    Effect.gen(function* () {
      const routing = yield* RoutingService.RoutingService;
      // A null account skips the qualification lookup, which these tests do not stub.
      const request = {
        ...input,
        instanceId: null,
        task: "What does this function do?",
        modelSelection: { instanceId: a, model: "model" },
      };
      expect((yield* routing.preview(request)).predicted).toMatchObject({
        instanceId: a,
        model: "model",
        basis: "local",
      });
      expect((yield* routing.preview({ ...request, threadId: "thread-1" })).predicted).toBe(
        undefined,
      );
      expect((yield* routing.preview({ ...input, task: "hi" })).predicted).toBe(undefined);
    }).pipe(
      Effect.provide(routingLayerWith({ settings: { routingMode: "automatic" } })),
      Effect.provideService(ProviderRegistry.ProviderRegistry, mockRegistry([provider()])),
    ),
  );
  effectIt.effect("makes no prediction when Auto is off", () =>
    Effect.gen(function* () {
      const routing = yield* RoutingService.RoutingService;
      const result = yield* routing.preview({
        ...input,
        instanceId: null,
        task: "What does this function do?",
        modelSelection: { instanceId: a, model: "model" },
      });
      expect(result.predicted).toBe(undefined);
    }).pipe(
      Effect.provide(routingLayerWith({ settings: { routingMode: "manual" } })),
      Effect.provideService(ProviderRegistry.ProviderRegistry, mockRegistry([provider()])),
    ),
  );
});
