import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type CampaignError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { McpSchema, McpServer } from "effect/unstable/ai";

import * as CampaignStore from "../../../campaigns/CampaignStore.ts";
import {
  makeHarnessLayer,
  makeWorld,
  type GenerationWorld,
} from "../../../campaigns/generation/generationTestHarness.ts";
import * as GenerationService from "../../../campaigns/generation/GenerationService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  MediaGenerationToolkitHandlersLive,
  NEEDS_APPROVAL_OUTCOME,
} from "./generationHandlers.ts";
import { MediaGenerationToolkit } from "./generationTools.ts";

const threadId = ThreadId.make("thread-agent-gen");
const otherThreadId = ThreadId.make("thread-agent-other");

const scopeWith = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
  thread: ThreadId = threadId,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-gen"),
  threadId: thread,
  providerSessionId: "provider-session-gen",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "generation", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "generation", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const PNG = Buffer.from("PNGBYTES").toString("base64");

/** One scene: a fresh world, a real store and service, the tools registered over them. */
const scene = <E>(
  options: {
    readonly generator?: "openrouter" | "none";
    readonly estimate?: GenerationService.GenerationServiceOptions["estimate"];
  },
  body: (input: {
    readonly world: GenerationWorld;
    readonly call: (
      scope: McpInvocationContext.McpInvocationScope,
      name: string,
      args?: Record<string, unknown>,
    ) => Effect.Effect<Record<string, unknown>, never, McpServer.McpServer>;
    readonly seed: (
      mode: "ask-first" | "report-when-done" | "auto-publish",
    ) => Effect.Effect<
      { readonly clientId: string; readonly campaignId: string },
      CampaignError,
      CampaignStore.CampaignStore
    >;
  }) => Effect.Effect<
    void,
    E,
    McpServer.McpServer | CampaignStore.CampaignStore | GenerationService.GenerationService
  >,
) =>
  Effect.gen(function* () {
    const world = yield* makeWorld;
    world.secrets.set("workbench-campaign-openrouter-key", new TextEncoder().encode("or-key"));
    world.provider.current = () =>
      Response.json({
        choices: [
          { message: { images: [{ image_url: { url: `data:image/png;base64,${PNG}` } }] } },
        ],
      });
    const generator = options.generator ?? "openrouter";
    const layer = McpServer.toolkit(MediaGenerationToolkit).pipe(
      Layer.provide(MediaGenerationToolkitHandlersLive),
      Layer.provideMerge(McpServer.McpServer.layer),
      Layer.provideMerge(
        makeHarnessLayer({
          world,
          ...(options.estimate === undefined ? {} : { estimate: options.estimate }),
          root: null,
          settings: { campaignImageGenerator: generator, campaignVideoGenerator: generator },
        }),
      ),
    );
    yield* body({
      world,
      call: (scope, name, args = {}) =>
        Effect.gen(function* () {
          const server = yield* McpServer.McpServer;
          const result = yield* server
            .callTool({ name, arguments: args })
            .pipe(
              Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
              Effect.provideService(McpSchema.McpServerClient, client),
            );
          return (result.structuredContent ?? {}) as Record<string, unknown>;
        }).pipe(Effect.orDie),
      seed: (mode) =>
        Effect.gen(function* () {
          const store = yield* CampaignStore.CampaignStore;
          const owner = yield* store.upsertClient({
            name: "Candid Studios",
            brandNotes: "",
            doNotSay: [],
            approvalMode: mode,
          });
          const campaign = yield* store.upsertCampaign({ clientId: owner.id, name: "October" });
          return { clientId: owner.id, campaignId: campaign.id };
        }),
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped);

it("pins the tool list, and none of the tools can approve, set a mode or reach a key", () => {
  const names = Object.keys(MediaGenerationToolkit.tools).toSorted();
  expect(names).toEqual([
    "media_generate_image",
    "media_generate_video",
    "media_generation_status",
  ]);
  for (const [name, tool] of Object.entries(MediaGenerationToolkit.tools)) {
    const fields = (
      tool.parametersSchema.ast as { propertySignatures?: ReadonlyArray<{ name: string }> }
    ).propertySignatures?.map((field) => field.name);
    for (const field of fields ?? []) {
      if (field === "allowanceUsd") continue;
      expect(field, name).not.toMatch(/approv|mode|key|status|connector|generator|model|cost|usd/i);
    }
  }
});

it("tells the agent to state the cost, never loop on a failure, and make one at a time", () => {
  for (const name of ["media_generate_image", "media_generate_video"] as const) {
    const description = MediaGenerationToolkit.tools[name].description ?? "";
    expect(description, name).toMatch(/cost estimate/);
    expect(description, name).toMatch(/do not start it again in a loop/);
    expect(description, name).toMatch(/at most one per request unless the person asked for more/);
    expect(description, name).toMatch(/ask-first/);
  }
  expect(MediaGenerationToolkit.tools.media_generate_video.description).toMatch(
    /chat subscription cannot make video/,
  );
});

it.effect(
  "under ask-first the tool only creates a job and says a person has to approve the spend",
  () =>
    scene({}, ({ world, call, seed }) =>
      Effect.gen(function* () {
        const { clientId, campaignId } = yield* seed("ask-first");
        const result = yield* call(scopeWith(["campaigns"]), "media_generate_image", {
          clientId,
          campaignId,
          prompt: "A bouquet on a white table",
          aspectRatio: "1:1",
          allowanceUsd: 1,
        });
        expect(result["status"]).toBe("needs-approval");
        expect(result["outcome"]).toBe(NEEDS_APPROVAL_OUTCOME);
        expect(String(result["outcome"])).toContain(
          "A person has to approve this spend on the campaign board",
        );
        const generation = yield* GenerationService.GenerationService;
        yield* generation.tick;
        expect(yield* Ref.get(world.calls)).toEqual([]);
      }),
    ),
);

it.effect("under report-when-done the job is queued and the agent hears when it is done", () =>
  scene({ estimate: () => ({ usd: 0.25, note: "About $0.25" }) }, ({ world, call, seed }) =>
    Effect.gen(function* () {
      const { clientId } = yield* seed("report-when-done");
      const result = yield* call(scopeWith(["campaigns"]), "media_generate_image", {
        clientId,
        prompt: "A bouquet",
      });
      expect(result["status"]).toBe("queued");
      expect(result["estimatedUsd"]).toBe(0.25);
      expect(String(result["estimateNote"])).toContain("About $0.25");
      const generation = yield* GenerationService.GenerationService;
      yield* generation.tick;
      const status = yield* call(scopeWith(["campaigns"]), "media_generation_status", {
        jobId: String(result["jobId"]),
      });
      const jobs = status["jobs"] as ReadonlyArray<Record<string, unknown>>;
      expect(jobs[0]?.["status"]).toBe("failed");
      // This scene has no project folder, so the result cannot be saved. The agent is told.
      const told = yield* Ref.get(world.told);
      expect(told[0]?.threadId).toBe(threadId);
    }),
  ),
);

it.effect("with no generator set the tool says so and creates nothing", () =>
  scene({ generator: "none" }, ({ call, seed }) =>
    Effect.gen(function* () {
      const { clientId } = yield* seed("auto-publish");
      const result = yield* call(scopeWith(["campaigns"]), "media_generate_video", {
        clientId,
        prompt: "A cake",
      });
      expect(result["message"]).toBe(
        "No video generator is set up. Choose one in Settings, Connections, Campaign Publishing.",
      );
      const generation = yield* GenerationService.GenerationService;
      expect(yield* generation.listJobs({ limit: 5 })).toEqual([]);
    }),
  ),
);

it.effect("refuses a credential without the campaigns group", () =>
  scene({}, ({ call, seed }) =>
    Effect.gen(function* () {
      const { clientId } = yield* seed("auto-publish");
      for (const [name, args] of [
        ["media_generate_image", { clientId, prompt: "x" }],
        ["media_generate_video", { clientId, prompt: "x" }],
        ["media_generation_status", {}],
      ] as const) {
        const result = yield* call(scopeWith(["media"]), name, args);
        expect(result["reason"], name).toBe("not_allowed");
      }
      const generation = yield* GenerationService.GenerationService;
      expect(yield* generation.listJobs({ limit: 5 })).toEqual([]);
    }),
  ),
);

it.effect("status shows an agent only its own jobs", () =>
  scene({}, ({ call, seed }) =>
    Effect.gen(function* () {
      const { clientId } = yield* seed("auto-publish");
      const mine = yield* call(scopeWith(["campaigns"]), "media_generate_image", {
        clientId,
        prompt: "mine",
        allowanceUsd: 1,
      });
      yield* call(scopeWith(["campaigns"], otherThreadId), "media_generate_image", {
        clientId,
        prompt: "theirs",
        allowanceUsd: 1,
      });
      const listed = (yield* call(scopeWith(["campaigns"]), "media_generation_status")) as {
        jobs: ReadonlyArray<{ jobId: string }>;
      };
      expect(listed.jobs.map((job) => job.jobId)).toEqual([String(mine["jobId"])]);
      const other = yield* call(scopeWith(["campaigns"], otherThreadId), "media_generation_status");
      expect((other["jobs"] as ReadonlyArray<unknown>).length).toBe(1);
      const peek = yield* call(scopeWith(["campaigns"], otherThreadId), "media_generation_status", {
        jobId: String(mine["jobId"]),
      });
      expect(peek["reason"]).toBe("not_found");
    }),
  ),
);

it("tells the agent a still is required with this computer's card, and how to get one", () => {
  const description = MediaGenerationToolkit.tools.media_generate_video.description ?? "";
  expect(description).toMatch(/still image is required/);
  expect(description).toMatch(/media_generate_image/);
  expect(description).toMatch(/media_inspect/);
  expect(description).toMatch(/fromJobId/);
  const fields = (
    MediaGenerationToolkit.tools.media_generate_video.parametersSchema.ast as {
      propertySignatures?: ReadonlyArray<{ name: string }>;
    }
  ).propertySignatures?.map((field) => field.name);
  expect(fields).toContain("fromJobId");
  expect(fields).toContain("firstFrame");
});

it.effect("fromJobId may only name a picture this same conversation asked for", () =>
  scene({}, ({ call, seed }) =>
    Effect.gen(function* () {
      const { clientId } = yield* seed("ask-first");
      const theirs = yield* call(scopeWith(["campaigns"], otherThreadId), "media_generate_image", {
        clientId,
        prompt: "Someone else's bouquet",
        allowanceUsd: 1,
      });
      const refused = yield* call(scopeWith(["campaigns"]), "media_generate_video", {
        clientId,
        prompt: "Animate it",
        fromJobId: String(theirs["jobId"]),
      });
      expect(refused["reason"]).toBe("not_found");
      expect(refused["message"]).toBe("That generation job was not found.");

      // Its own, but not finished: refused in plain words, nothing is made.
      const mine = yield* call(scopeWith(["campaigns"]), "media_generate_image", {
        clientId,
        prompt: "My bouquet",
        allowanceUsd: 1,
      });
      const early = yield* call(scopeWith(["campaigns"]), "media_generate_video", {
        clientId,
        prompt: "Animate it",
        fromJobId: String(mine["jobId"]),
      });
      expect(early["reason"]).toBe("invalid");
      expect(String(early["message"])).toContain("finished picture made for the same client");
    }),
  ),
);

it.effect("unknown pricing without an allowance stays refused and creates no paid job", () =>
  scene({}, ({ world, call, seed }) =>
    Effect.gen(function* () {
      const { clientId } = yield* seed("auto-publish");
      const result = yield* call(scopeWith(["campaigns"]), "media_generate_image", {
        clientId,
        prompt: "A bouquet",
      });
      expect(result["reason"]).toBe("not_allowed");
      expect(String(result["message"])).toContain("allowance");
      const generation = yield* GenerationService.GenerationService;
      expect(yield* generation.listJobs({ limit: 5 })).toEqual([]);
      expect(yield* Ref.get(world.calls)).toEqual([]);
    }),
  ),
);

it.effect(
  "agent allowances always require a person's approval for image and video, including automatic modes",
  () =>
    scene({}, ({ world, call, seed }) =>
      Effect.gen(function* () {
        const generation = yield* GenerationService.GenerationService;
        for (const mode of ["report-when-done", "auto-publish"] as const) {
          const { clientId } = yield* seed(mode);
          for (const name of ["media_generate_image", "media_generate_video"]) {
            const result = yield* call(scopeWith(["campaigns"]), name, {
              clientId,
              prompt: "A bouquet",
              allowanceUsd: 2,
              forceApproval: false,
            });
            expect(result["status"]).toBe("needs-approval");
            expect(result["outcome"]).toBe(NEEDS_APPROVAL_OUTCOME);
            expect(result["estimatedUsd"]).toBeNull();
            expect(result["allowanceUsd"]).toBe(2);
            expect(result["reservedUsd"]).toBe(2);
            expect(result["submissionState"]).toBe("not-submitted");
            yield* generation.tick;
            expect(yield* Ref.get(world.calls)).toEqual([]);
          }
        }
        const jobs = yield* generation.listJobs({ limit: 5 });
        const image = jobs.find((job) => job.kind === "image");
        expect(image).toBeDefined();
        // Approval is a person-only service/board action, not an agent tool.
        yield* generation.approveJob(image!.id);
        yield* generation.tick;
        expect((yield* Ref.get(world.calls)).length).toBe(1);
      }),
    ),
);

it.effect(
  "status tells the agent to reconcile uncertain submissions instead of claiming generation is progressing",
  () =>
    scene({}, ({ world, call, seed }) =>
      Effect.gen(function* () {
        const { clientId } = yield* seed("auto-publish");
        const generation = yield* GenerationService.GenerationService;
        yield* generation.setSettings({
          videoGenerator: "muapi",
          videoModel: "veo3.1-text-to-video",
        });
        world.secrets.set("workbench-campaign-muapi-key", new TextEncoder().encode("test-key"));
        world.provider.current = () => new Response("upstream unavailable", { status: 503 });
        const proposal = yield* call(scopeWith(["campaigns"]), "media_generate_video", {
          clientId,
          prompt: "A cake",
          allowanceUsd: 2,
        });
        yield* generation.approveJob(String(proposal["jobId"]));
        yield* generation.tick;
        const result = yield* call(scopeWith(["campaigns"]), "media_generation_status", {
          jobId: String(proposal["jobId"]),
        });
        const job = (result["jobs"] as ReadonlyArray<Record<string, unknown>>)[0];
        expect(job?.["submissionState"]).toBe("uncertain");
        expect(job?.["reservedUsd"]).toBe(2);
        expect(String(job?.["outcome"])).toContain("reconcile");
        expect(String(job?.["outcome"])).toContain("do not submit another job");
        yield* generation.recover;
        yield* generation.tick;
        expect(
          (yield* Ref.get(world.calls)).filter((request) => request.method === "POST").length,
        ).toBe(1);
      }),
    ),
);
