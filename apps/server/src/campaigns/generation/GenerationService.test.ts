import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ThreadId,
  type CampaignApprovalMode,
  type CampaignGenerationJob,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import {
  CAMPAIGN_FAL_KEY_SECRET,
  CAMPAIGN_MUAPI_KEY_SECRET,
  CAMPAIGN_OPENROUTER_KEY_SECRET,
} from "./GenerationService.ts";
import * as CampaignStore from "../CampaignStore.ts";
import * as GenerationService from "./GenerationService.ts";
import * as GenerationStore from "./GenerationStore.ts";
import { makeHarnessLayer, makeWorld, type GenerationWorld } from "./generationTestHarness.ts";

const agentThread = ThreadId.make("thread-agent-1");
const PNG = Buffer.from("PNGBYTES").toString("base64");

const bytes = (text: string, type: string) =>
  new Response(Buffer.from(text), { headers: { "content-type": type } });

/** What OpenRouter and its CDN say, until a test changes `videoStatus`. */
const openRouterScript =
  (state: { videoStatus: string }) => (request: HttpClientRequest.HttpClientRequest) => {
    if (request.url.endsWith("/chat/completions")) {
      return Response.json({
        choices: [
          { message: { images: [{ image_url: { url: `data:image/png;base64,${PNG}` } }] } },
        ],
      });
    }
    if (request.method === "POST" && request.url.endsWith("/videos")) {
      return Response.json(
        { id: "vid-1", polling_url: "https://openrouter.ai/api/v1/videos/vid-1" },
        { status: 202 },
      );
    }
    if (request.url === "https://openrouter.ai/api/v1/videos/vid-1") {
      return Response.json(
        state.videoStatus === "completed"
          ? { status: "completed", unsigned_urls: ["https://cdn.test/vid-1.mp4"] }
          : { status: state.videoStatus },
      );
    }
    if (request.url === "https://cdn.test/vid-1.mp4") return bytes("MP4BYTES", "video/mp4");
    return new Response("unexpected", { status: 500 });
  };

interface Scene {
  readonly sql: SqlClient.SqlClient;
  readonly world: GenerationWorld;
  readonly root: string;
  readonly service: GenerationService.GenerationService["Service"];
  readonly jobs: GenerationStore.GenerationStore["Service"];
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly clientId: string;
  readonly campaignId: string;
  readonly calls: () => Effect.Effect<ReadonlyArray<string>>;
}

const scenario = <E>(
  options: {
    readonly mode?: CampaignApprovalMode;
    readonly capUsd?: number;
    readonly generators?: "openrouter" | "none";
    readonly estimate?: GenerationService.GenerationServiceOptions["estimate"];
    readonly noFolder?: boolean;
    /** Save into the export folder setting instead of a thread's project. */
    readonly exportFolder?: boolean;
  },
  body: (scene: Scene) => Effect.Effect<void, E, CampaignStore.CampaignStore>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped();
    const world = yield* makeWorld;
    const generator = options.generators ?? "openrouter";
    world.provider.current = openRouterScript({ videoStatus: "completed" });
    world.secrets.set(CAMPAIGN_OPENROUTER_KEY_SECRET, new TextEncoder().encode("or-key"));
    yield* Effect.gen(function* () {
      const store = yield* CampaignStore.CampaignStore;
      const client = yield* store.upsertClient({
        name: "Candid Studios",
        brandNotes: "",
        doNotSay: [],
        approvalMode: options.mode ?? "ask-first",
        ...(options.capUsd === undefined ? {} : { monthlySpendCapUsd: options.capUsd }),
      });
      const campaign = yield* store.upsertCampaign({ clientId: client.id, name: "October Reels" });
      yield* body({
        sql: yield* SqlClient.SqlClient,
        world,
        root,
        service: yield* GenerationService.GenerationService,
        jobs: yield* GenerationStore.GenerationStore,
        fileSystem,
        path,
        clientId: client.id,
        campaignId: campaign.id,
        calls: () =>
          Ref.get(world.calls).pipe(Effect.map((all) => all.map((c) => `${c.method} ${c.url}`))),
      });
    }).pipe(
      Effect.provide(
        makeHarnessLayer({
          world,
          root: options.noFolder === true || options.exportFolder === true ? null : root,
          settings: {
            campaignImageGenerator: generator,
            campaignVideoGenerator: generator,
            ...(options.exportFolder === true ? { campaignExportDirectory: root } : {}),
          },
          ...(options.estimate === undefined ? {} : { estimate: options.estimate }),
        }),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const person = { kind: "person" } as const;
const agent = { kind: "agent", threadId: agentThread } as const;

const statusOf = (scene: Scene, job: CampaignGenerationJob) =>
  scene.service.getJob(job.id).pipe(Effect.map((current) => current.status));

it.effect("with no generator set, it refuses in plain words and records nothing", () =>
  scenario({ generators: "none" }, (scene) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        scene.service.startJob({
          actor: person,
          allowanceUsd: 1,
          kind: "image",
          clientId: scene.clientId,
          prompt: "A bouquet",
          options: {},
        }),
      );
      assert.strictEqual(
        error.message,
        "No image generator is set up. Choose one in Settings, Connections, Campaign Publishing.",
      );
      const video = yield* Effect.flip(
        scene.service.startJob({
          actor: person,
          allowanceUsd: 1,
          kind: "video",
          clientId: scene.clientId,
          prompt: "A cake",
          options: {},
        }),
      );
      assert.include(video.message, "No video generator is set up");
      assert.deepStrictEqual(yield* scene.service.listJobs({ limit: 10 }), []);
      assert.deepStrictEqual(yield* scene.calls(), []);
    }),
  ),
);

it.effect(
  "a person's image goes queued, then done, and the file lands in the project's generated folder",
  () =>
    scenario({}, (scene) =>
      Effect.gen(function* () {
        const job = yield* scene.service.startJob({
          actor: person,
          allowanceUsd: 1,
          kind: "image",
          clientId: scene.clientId,
          campaignId: scene.campaignId,
          prompt: "A bouquet on a white table",
          options: { aspectRatio: "1:1" },
          sourceThreadId: agentThread,
        });
        assert.strictEqual(job.status, "queued");
        assert.strictEqual(job.model, "google/gemini-2.5-flash-image");
        assert.strictEqual(job.estimatedUsd, null);
        assert.include(job.estimateNote, "Cost unknown");
        assert.strictEqual(job.reservedUsd, 1);
        assert.include(job.estimateNote, "allowance");
        yield* scene.service.tick;
        const done = yield* scene.service.getJob(job.id);
        assert.strictEqual(done.status, "done", done.error);
        const relative = `campaigns/candid-studios/october-reels/generated/${job.id}.png`;
        assert.deepStrictEqual(done.resultPaths, [relative]);
        assert.strictEqual(
          yield* scene.fileSystem.readFileString(scene.path.join(scene.root, relative)),
          "PNGBYTES",
        );
        // A person asked, so no agent is told.
        assert.deepStrictEqual(yield* Ref.get(scene.world.told), []);
      }),
    ),
);

it.effect(
  "an agent under ask-first only creates a job that needs approval and spends nothing until a person approves",
  () =>
    scenario({ mode: "ask-first" }, (scene) =>
      Effect.gen(function* () {
        scene.world.provider.current = openRouterScript({ videoStatus: "completed" });
        const job = yield* scene.service.startJob({
          actor: agent,
          allowanceUsd: 1,
          kind: "image",
          clientId: scene.clientId,
          prompt: "A bouquet",
          options: {},
          sourceThreadId: agentThread,
        });
        assert.strictEqual(job.status, "needs-approval");
        yield* scene.service.tick;
        assert.strictEqual(yield* statusOf(scene, job), "needs-approval");
        assert.deepStrictEqual(yield* scene.calls(), []);

        const approved = yield* scene.service.approveJob(job.id);
        assert.strictEqual(approved.status, "queued");
        yield* scene.service.tick;
        const done = yield* scene.service.getJob(job.id);
        assert.strictEqual(done.status, "done");
        // The agent that asked is told where the file is.
        const told = yield* Ref.get(scene.world.told);
        assert.strictEqual(told.length, 1);
        assert.strictEqual(told[0]?.threadId, agentThread);
        assert.include(told[0]?.text ?? "", done.resultPaths[0] ?? "missing");
        assert.include(told[0]?.text ?? "", "media_inspect");
        // Approving twice is refused.
        assert.strictEqual(
          (yield* Effect.flip(scene.service.approveJob(job.id))).reason,
          "conflict",
        );
      }),
    ),
);

it.effect("an agent under report-when-done or auto-publish goes straight in line", () =>
  Effect.gen(function* () {
    for (const mode of ["report-when-done", "auto-publish"] as const) {
      yield* scenario({ mode }, (scene) =>
        Effect.gen(function* () {
          scene.world.provider.current = openRouterScript({ videoStatus: "completed" });
          const job = yield* scene.service.startJob({
            actor: agent,
            allowanceUsd: 1,
            kind: "image",
            clientId: scene.clientId,
            prompt: "A bouquet",
            options: {},
          });
          assert.strictEqual(job.status, "queued", mode);
        }),
      );
    }
  }),
);

it.effect("a campaign's own mode decides, over its client's", () =>
  scenario({ mode: "auto-publish" }, (scene) =>
    Effect.gen(function* () {
      const store = yield* CampaignStore.CampaignStore;
      yield* store.upsertCampaign({
        id: scene.campaignId,
        clientId: scene.clientId,
        name: "October Reels",
        approvalMode: "ask-first",
      });
      const job = yield* scene.service.startJob({
        actor: agent,
        allowanceUsd: 1,
        kind: "image",
        clientId: scene.clientId,
        campaignId: scene.campaignId,
        prompt: "A bouquet",
        options: {},
      });
      assert.strictEqual(job.status, "needs-approval");
    }),
  ),
);

it.effect(
  "refuses a job that would pass the client's monthly limit, and counts what is already used",
  () =>
    scenario({ capUsd: 5, estimate: () => ({ usd: 2, note: "About $2.00." }) }, (scene) =>
      Effect.gen(function* () {
        const start = () =>
          scene.service.startJob({
            actor: person,
            allowanceUsd: 1,
            kind: "image",
            clientId: scene.clientId,
            prompt: "A bouquet",
            options: {},
          });
        yield* start();
        yield* start();
        const refused = yield* Effect.flip(start());
        assert.strictEqual(
          refused.message,
          "This would pass Candid Studios's monthly limit of $5.00 ($4.00 used).",
        );
        assert.strictEqual(refused.reason, "not_allowed");
        assert.strictEqual((yield* scene.service.listJobs({ limit: 10 })).length, 2);
        const board = yield* scene.service.board(undefined);
        assert.deepStrictEqual(board.spend, [{ clientId: scene.clientId, capUsd: 5, usedUsd: 4 }]);
      }),
    ),
);

it.effect("pending approvals reserve the combined cap", () =>
  scenario(
    { mode: "ask-first", capUsd: 3, estimate: () => ({ usd: 2, note: "About $2.00." }) },
    (scene) =>
      Effect.gen(function* () {
        const ask = () =>
          scene.service.startJob({
            actor: agent,
            allowanceUsd: 1,
            kind: "image",
            clientId: scene.clientId,
            prompt: "A bouquet",
            options: {},
          });
        const first = yield* ask();
        const refused = yield* Effect.flip(ask());
        assert.strictEqual(first.status, "needs-approval");
        assert.include(refused.message, "monthly limit of $3.00 ($2.00 used)");
        yield* scene.service.approveJob(first.id);
      }),
  ),
);

it.effect("a video is submitted once, polled until done, then downloaded into the folder", () =>
  scenario({ mode: "auto-publish" }, (scene) =>
    Effect.gen(function* () {
      const state = { videoStatus: "in_progress" };
      scene.world.provider.current = openRouterScript(state);
      const job = yield* scene.service.startJob({
        actor: agent,
        allowanceUsd: 1,
        kind: "video",
        clientId: scene.clientId,
        campaignId: scene.campaignId,
        prompt: "A cake being cut",
        options: { aspectRatio: "9:16", durationSeconds: 6 },
      });
      assert.strictEqual(job.model, "bytedance/seedance-2.0-fast");
      yield* scene.service.tick;
      const running = yield* scene.jobs.get(job.id);
      assert.strictEqual(running.job.status, "running");
      assert.strictEqual(running.providerJobId, "https://openrouter.ai/api/v1/videos/vid-1");
      state.videoStatus = "completed";
      yield* scene.service.tick;
      const done = yield* scene.service.getJob(job.id);
      assert.strictEqual(done.status, "done");
      assert.match(
        done.resultPaths[0] ?? "",
        /^campaigns\/candid-studios\/october-reels\/generated\/gen_.*\.mp4$/,
      );
      const posts = (yield* scene.calls()).filter((call) => call.startsWith("POST"));
      assert.strictEqual(posts.length, 1);
    }),
  ),
);

it.effect(
  "after a restart a running job with a provider id is polled again and never submitted again",
  () =>
    scenario({ mode: "auto-publish" }, (scene) =>
      Effect.gen(function* () {
        const state = { videoStatus: "in_progress" };
        scene.world.provider.current = openRouterScript(state);
        const job = yield* scene.service.startJob({
          actor: person,
          allowanceUsd: 1,
          kind: "video",
          clientId: scene.clientId,
          prompt: "A cake",
          options: {},
          sourceThreadId: agentThread,
        });
        yield* scene.service.tick;
        const before = (yield* scene.calls()).filter((call) => call.startsWith("POST")).length;
        assert.strictEqual(before, 1);

        yield* scene.service.recover;
        assert.strictEqual(yield* statusOf(scene, job), "running");
        state.videoStatus = "completed";
        yield* scene.service.tick;
        const finished = yield* scene.service.getJob(job.id);
        assert.strictEqual(finished.status, "done", finished.error);
        const after = (yield* scene.calls()).filter((call) => call.startsWith("POST")).length;
        assert.strictEqual(after, 1);
      }),
    ),
);

it.effect("after a restart an unidentified paid job remains uncertain and is not resubmitted", () =>
  scenario({ mode: "auto-publish" }, (scene) =>
    Effect.gen(function* () {
      scene.world.provider.current = openRouterScript({ videoStatus: "completed" });
      const job = yield* scene.service.startJob({
        actor: agent,
        allowanceUsd: 1,
        kind: "video",
        clientId: scene.clientId,
        prompt: "A cake",
        options: {},
        sourceThreadId: agentThread,
      });
      // The server died after claiming the job and before the provider answered.
      assert.isTrue(yield* scene.jobs.claim(job.id));
      yield* scene.service.recover;
      const failed = yield* scene.service.getJob(job.id);
      assert.strictEqual(failed.status, "running");
      assert.strictEqual(failed.submissionState, "uncertain");
      assert.include(failed.error ?? "", "may have been charged");
      yield* scene.service.tick;
      assert.deepStrictEqual(yield* scene.calls(), []);
    }),
  ),
);

it.effect("an image job interrupted mid-call may have been charged, and says so", () =>
  scenario({}, (scene) =>
    Effect.gen(function* () {
      const job = yield* scene.service.startJob({
        actor: person,
        allowanceUsd: 1,
        kind: "image",
        clientId: scene.clientId,
        prompt: "A bouquet",
        options: {},
      });
      yield* scene.jobs.claim(job.id);
      yield* scene.service.recover;
      const failed = yield* scene.service.getJob(job.id);
      assert.strictEqual(failed.status, "running");
      assert.strictEqual(failed.submissionState, "uncertain");
      assert.include(failed.error ?? "", "may have been charged");
    }),
  ),
);

it.effect(
  "cancelling a queued job stops it before the provider is called; a finished job cannot be cancelled",
  () =>
    scenario({}, (scene) =>
      Effect.gen(function* () {
        scene.world.provider.current = openRouterScript({ videoStatus: "completed" });
        const job = yield* scene.service.startJob({
          actor: person,
          allowanceUsd: 1,
          kind: "image",
          clientId: scene.clientId,
          prompt: "A bouquet",
          options: {},
        });
        const cancelled = yield* scene.service.cancelJob(job.id);
        assert.strictEqual(cancelled.status, "cancelled");
        yield* scene.service.tick;
        assert.deepStrictEqual(yield* scene.calls(), []);
        assert.strictEqual(
          (yield* Effect.flip(scene.service.cancelJob(job.id))).reason,
          "conflict",
        );
        const board = yield* scene.service.board(undefined);
        // Cancelled before it started, so it never counted.
        assert.deepStrictEqual(board.spend[0]?.usedUsd, 0);
      }),
    ),
);

it.effect("cancelling a running video drops the result: nothing is downloaded or saved", () =>
  scenario({ mode: "auto-publish" }, (scene) =>
    Effect.gen(function* () {
      const state = { videoStatus: "in_progress" };
      scene.world.provider.current = openRouterScript(state);
      const job = yield* scene.service.startJob({
        actor: agent,
        allowanceUsd: 1,
        kind: "video",
        clientId: scene.clientId,
        prompt: "A cake",
        options: {},
        sourceThreadId: agentThread,
      });
      yield* scene.service.tick;
      yield* scene.service.cancelJob(job.id);
      state.videoStatus = "completed";
      yield* scene.service.tick;
      const after = yield* scene.service.getJob(job.id);
      assert.strictEqual(after.status, "cancelled");
      assert.deepStrictEqual(after.resultPaths, []);
      assert.isFalse((yield* scene.calls()).includes("GET https://cdn.test/vid-1.mp4"));
    }),
  ),
);

it.effect("a provider failure ends the job with its reason and tells the agent not to loop", () =>
  scenario({ mode: "auto-publish" }, (scene) =>
    Effect.gen(function* () {
      scene.world.provider.current = () =>
        Response.json({ error: { message: "insufficient credits" } }, { status: 402 });
      const job = yield* scene.service.startJob({
        actor: agent,
        allowanceUsd: 1,
        kind: "image",
        clientId: scene.clientId,
        prompt: "A bouquet",
        options: {},
      });
      yield* scene.service.tick;
      const failed = yield* scene.service.getJob(job.id);
      assert.strictEqual(failed.status, "failed");
      assert.strictEqual(failed.error, "OpenRouter said: insufficient credits");
      const told = yield* Ref.get(scene.world.told);
      assert.include(told[0]?.text ?? "", "insufficient credits");
      assert.include(told[0]?.text ?? "", "Do not start it again in a loop");
    }),
  ),
);

it.effect(
  "with no project folder and no export folder, a finished result fails with a plain message",
  () =>
    scenario({ noFolder: true }, (scene) =>
      Effect.gen(function* () {
        scene.world.provider.current = openRouterScript({ videoStatus: "completed" });
        const job = yield* scene.service.startJob({
          actor: person,
          allowanceUsd: 1,
          kind: "image",
          clientId: scene.clientId,
          prompt: "A bouquet",
          options: {},
        });
        yield* scene.service.tick;
        const failed = yield* scene.service.getJob(job.id);
        assert.strictEqual(failed.status, "failed");
        assert.include(failed.error ?? "", "no project folder to save into");
      }),
    ),
);

it.effect(
  "a first-frame file inside the folder is sent as the first frame; one outside is refused",
  () =>
    scenario({ mode: "auto-publish" }, (scene) =>
      Effect.gen(function* () {
        scene.world.provider.current = openRouterScript({ videoStatus: "in_progress" });
        yield* scene.fileSystem.writeFile(
          scene.path.join(scene.root, "frame.png"),
          new Uint8Array([1, 2, 3]),
        );
        const inside = yield* scene.service.startJob({
          actor: agent,
          allowanceUsd: 1,
          kind: "video",
          clientId: scene.clientId,
          prompt: "A cake",
          options: { firstFrame: "frame.png" },
          sourceThreadId: agentThread,
        });
        yield* scene.service.tick;
        const sent = (yield* Ref.get(scene.world.calls)).find((call) => call.method === "POST");
        const frames = (
          sent?.body as
            | { frame_images?: ReadonlyArray<{ url: string; frame_type: string }> }
            | undefined
        )?.frame_images;
        assert.strictEqual(frames?.[0]?.frame_type, "first");
        assert.strictEqual(frames?.[0]?.url, "data:image/png;base64,AQID");
        assert.strictEqual(yield* statusOf(scene, inside), "running");

        for (const bad of ["../secret.png", "/etc/passwd", "C:\\x.png"]) {
          const error = yield* Effect.flip(
            scene.service.startJob({
              actor: agent,
              allowanceUsd: 1,
              kind: "video",
              clientId: scene.clientId,
              prompt: "A cake",
              options: { firstFrame: bad },
              sourceThreadId: agentThread,
            }),
          );
          assert.strictEqual(error.reason, "invalid", bad);
        }
        // A file that is inside by name but missing is a failed job, not a crash.
        const missing = yield* scene.service.startJob({
          actor: agent,
          allowanceUsd: 1,
          kind: "video",
          clientId: scene.clientId,
          prompt: "A cake",
          options: { firstFrame: "nope.png" },
          sourceThreadId: agentThread,
        });
        yield* scene.service.tick;
        const failed = yield* scene.service.getJob(missing.id);
        assert.strictEqual(failed.status, "failed");
        assert.include(failed.error ?? "", "nope.png was not found");
      }),
    ),
);

it.effect("checks options the model is known to refuse before anything is created", () =>
  scenario({}, (scene) =>
    Effect.gen(function* () {
      const start = (options: Record<string, unknown>, kind: "image" | "video" = "video") =>
        Effect.flip(
          scene.service.startJob({
            actor: person,
            allowanceUsd: 1,
            kind,
            clientId: scene.clientId,
            prompt: "A cake",
            options,
          }),
        );
      assert.include((yield* start({ durationSeconds: 2 })).message, "4 to 15 second");
      assert.include((yield* start({ durationSeconds: 20 })).message, "4 to 15 second");
      assert.include((yield* start({ resolution: "1080p" })).message, "480p or 720p");
      assert.include((yield* start({ durationSeconds: 5 }, "image")).message, "video only");
      const other = yield* Effect.flip(
        scene.service.startJob({
          actor: person,
          allowanceUsd: 1,
          kind: "image",
          clientId: "no-such-client",
          prompt: "x",
          options: {},
        }),
      );
      assert.strictEqual(other.reason, "not_found");
      assert.deepStrictEqual(yield* scene.service.listJobs({ limit: 10 }), []);
    }),
  ),
);

it.effect(
  "settings: the key is write-only, a bad pairing is refused, and the board shows no secret",
  () =>
    scenario({ generators: "none" }, (scene) =>
      Effect.gen(function* () {
        scene.world.secrets.delete(CAMPAIGN_OPENROUTER_KEY_SECRET);
        const initial = yield* scene.service.settings;
        assert.deepStrictEqual(initial, {
          imageGenerator: "none",
          videoGenerator: "none",
          hasOpenRouterKey: false,
          hasMuapiKey: false,
          hasFalKey: false,
          localBaseUrl: "",
          models: { image: "", video: "", local: "" },
          localGpu: {
            python: "",
            model: "",
            videoModel: "",
            modelsDir: "",
            whenBusy: "fallback",
            windowStart: "",
            windowEnd: "",
          },
        });
        const set = yield* scene.service.setSettings({
          imageGenerator: "local",
          videoGenerator: "openrouter",
          localBaseUrl: "http://localhost:8080/",
          localModel: "sdxl",
          openRouterKey: Redacted.make("or-secret-1"),
        });
        assert.deepStrictEqual(set, {
          imageGenerator: "local",
          videoGenerator: "openrouter",
          hasOpenRouterKey: true,
          hasMuapiKey: false,
          hasFalKey: false,
          localBaseUrl: "http://localhost:8080",
          models: { image: "", video: "", local: "sdxl" },
          localGpu: {
            python: "",
            model: "",
            videoModel: "",
            modelsDir: "",
            whenBusy: "fallback",
            windowStart: "",
            windowEnd: "",
          },
        });
        assert.notInclude(
          Object.values((yield* scene.service.board(undefined)).settings).join(" "),
          "or-secret-1",
        );
        assert.strictEqual(
          new TextDecoder().decode(scene.world.secrets.get(CAMPAIGN_OPENROUTER_KEY_SECRET)),
          "or-secret-1",
        );
        assert.strictEqual(
          (yield* Effect.flip(scene.service.setSettings({ videoGenerator: "local" }))).reason,
          "invalid",
        );
        assert.strictEqual(
          (yield* Effect.flip(scene.service.setSettings({ imageGenerator: "marketing-engine" })))
            .reason,
          "invalid",
        );
        assert.strictEqual(
          (yield* Effect.flip(scene.service.setSettings({ localBaseUrl: "https://u:p@x.test" })))
            .reason,
          "invalid",
        );
        assert.strictEqual(
          (yield* Effect.flip(scene.service.setSettings({ videoModel: "bad model!" }))).reason,
          "invalid",
        );
        assert.strictEqual(
          (yield* Effect.flip(
            scene.service.setSettings({ openRouterKey: Redacted.make("has space") }),
          )).reason,
          "invalid",
        );
        const cleared = yield* scene.service.setSettings({ openRouterKey: null });
        assert.isFalse(cleared.hasOpenRouterKey);
        assert.isFalse(scene.world.secrets.has(CAMPAIGN_OPENROUTER_KEY_SECRET));
        const withMuapi = yield* scene.service.setSettings({
          videoGenerator: "muapi",
          muapiKey: Redacted.make("mu-secret-1"),
        });
        assert.isTrue(withMuapi.hasMuapiKey);
        assert.strictEqual(withMuapi.videoGenerator, "muapi");
        assert.strictEqual(
          new TextDecoder().decode(scene.world.secrets.get(CAMPAIGN_MUAPI_KEY_SECRET)),
          "mu-secret-1",
        );
        assert.notInclude(
          Object.values((yield* scene.service.board(undefined)).settings).join(" "),
          "mu-secret-1",
        );
        const clearedMuapi = yield* scene.service.setSettings({ muapiKey: null });
        assert.isFalse(clearedMuapi.hasMuapiKey);
        assert.isFalse(scene.world.secrets.has(CAMPAIGN_MUAPI_KEY_SECRET));
        const withFal = yield* scene.service.setSettings({
          videoGenerator: "fal",
          falKey: Redacted.make("fal-secret-1"),
        });
        assert.isTrue(withFal.hasFalKey);
        assert.strictEqual(withFal.videoGenerator, "fal");
        assert.strictEqual(
          new TextDecoder().decode(scene.world.secrets.get(CAMPAIGN_FAL_KEY_SECRET)),
          "fal-secret-1",
        );
        assert.notInclude(
          Object.values((yield* scene.service.board(undefined)).settings).join(" "),
          "fal-secret-1",
        );
        const clearedFal = yield* scene.service.setSettings({ falKey: null });
        assert.isFalse(clearedFal.hasFalKey);
        assert.isFalse(scene.world.secrets.has(CAMPAIGN_FAL_KEY_SECRET));
      }),
    ),
);

it.effect("MuAPI video picks its default by first frame and holds to its limits", () =>
  scenario({ generators: "none" }, (scene) =>
    Effect.gen(function* () {
      yield* scene.service.setSettings({ videoGenerator: "muapi" });
      const start = (options: Parameters<typeof scene.service.startJob>[0]["options"]) =>
        scene.service.startJob({
          actor: person,
          allowanceUsd: 1,
          kind: "video",
          clientId: scene.clientId,
          prompt: "A cake being cut",
          options,
        });
      const tooLong = yield* Effect.flip(start({ durationSeconds: 12 }));
      assert.include(tooLong.message, "veo3.1-text-to-video accepts durations of 8 seconds.");
      const withFrame = yield* Effect.flip(
        start({ durationSeconds: 12, firstFrame: "https://example.test/a.png" }),
      );
      assert.include(withFrame.message, "veo3.1-image-to-video accepts durations of 8 seconds.");
      const square = yield* Effect.flip(start({ aspectRatio: "1:1" }));
      assert.include(square.message, "does not accept that aspect ratio control");
      const sharp = yield* Effect.flip(start({ resolution: "480p" }));
      assert.include(sharp.message, "does not accept that resolution control");
    }),
  ),
);

it.effect(
  "fal.ai waits for approval before sending a local still and saves the completed video",
  () =>
    scenario({ generators: "none" }, (scene) =>
      Effect.gen(function* () {
        yield* scene.service.setSettings({
          videoGenerator: "fal",
          falKey: Redacted.make("test-fal-key"),
        });
        yield* scene.fileSystem.writeFile(
          scene.path.join(scene.root, "frame.png"),
          new Uint8Array([1, 2, 3]),
        );
        const responseUrl = "https://queue.fal.run/fal-ai/veo3.1/requests/test-video";
        scene.world.provider.current = (request) => {
          if (request.method === "POST") return Response.json({ response_url: responseUrl });
          if (request.url === `${responseUrl}/status`)
            return Response.json({ status: "COMPLETED" });
          if (request.url === responseUrl)
            return Response.json({ video: { url: "https://cdn.test/test-video.mp4" } });
          if (request.url === "https://cdn.test/test-video.mp4")
            return bytes("MP4BYTES", "video/mp4");
          return new Response("unexpected", { status: 500 });
        };
        const job = yield* scene.service.startJob({
          actor: agent,
          allowanceUsd: 1,
          kind: "video",
          clientId: scene.clientId,
          prompt: "The barista gently releases the cup. Static camera.",
          options: {
            firstFrame: "frame.png",
            durationSeconds: 4,
            resolution: "720p",
            aspectRatio: "9:16",
            generateAudio: false,
          },
          sourceThreadId: agentThread,
        });
        assert.strictEqual(job.status, "needs-approval");
        yield* scene.service.tick;
        assert.deepStrictEqual(yield* scene.calls(), []);
        yield* scene.service.approveJob(job.id);
        yield* scene.service.tick;
        yield* scene.service.tick;
        const sent = (yield* Ref.get(scene.world.calls)).find((call) => call.method === "POST");
        assert.deepStrictEqual(sent?.body, {
          prompt: job.prompt,
          image_url: "data:image/png;base64,AQID",
          duration: "4s",
          resolution: "720p",
          aspect_ratio: "9:16",
          generate_audio: false,
        });
        const done = yield* scene.service.getJob(job.id);
        assert.strictEqual(done.status, "done", done.error);
        assert.strictEqual(
          yield* scene.fileSystem.readFileString(scene.path.join(scene.root, done.resultPaths[0]!)),
          "MP4BYTES",
        );
      }),
    ),
);

it.effect("fal.ai video picks its default by first frame and holds to its limits", () =>
  scenario({ generators: "none" }, (scene) =>
    Effect.gen(function* () {
      yield* scene.service.setSettings({ videoGenerator: "fal" });
      const start = (options: Parameters<typeof scene.service.startJob>[0]["options"]) =>
        scene.service.startJob({
          actor: person,
          allowanceUsd: 1,
          kind: "video",
          clientId: scene.clientId,
          prompt: "A cake being cut",
          options,
        });
      const tooLong = yield* Effect.flip(start({ durationSeconds: 20 }));
      assert.include(tooLong.message, "fal-ai/veo3.1 accepts durations of 4, 6, 8 seconds.");
      const withFrame = yield* Effect.flip(
        start({ durationSeconds: 20, firstFrame: "https://example.test/a.png" }),
      );
      assert.include(
        withFrame.message,
        "fal-ai/veo3.1/image-to-video accepts durations of 4, 6, 8 seconds.",
      );
      const square = yield* Effect.flip(start({ aspectRatio: "1:1" }));
      assert.include(square.message, "does not accept that aspect ratio control");
      const sharp = yield* Effect.flip(start({ resolution: "480p" }));
      assert.include(sharp.message, "does not accept that resolution control");
    }),
  ),
);

it.effect("a job with no source thread saves into the export folder setting", () =>
  scenario({ exportFolder: true }, (scene) =>
    Effect.gen(function* () {
      const job = yield* scene.service.startJob({
        actor: person,
        allowanceUsd: 1,
        kind: "image",
        clientId: scene.clientId,
        prompt: "A bouquet",
        options: {},
      });
      yield* scene.service.tick;
      const done = yield* scene.service.getJob(job.id);
      assert.strictEqual(done.status, "done", done.error);
      // No campaign was chosen, so it goes under "unsorted".
      assert.deepStrictEqual(done.resultPaths, [
        `campaigns/candid-studios/unsorted/generated/${job.id}.png`,
      ]);
      assert.isTrue(
        yield* scene.fileSystem.exists(scene.path.join(scene.root, done.resultPaths[0] ?? "x")),
      );
    }),
  ),
);

it.effect("unknown pricing requires a finite positive allowance, even without a cap", () =>
  scenario({}, (scene) =>
    Effect.gen(function* () {
      const input = {
        actor: person,
        kind: "image" as const,
        clientId: scene.clientId,
        prompt: "A bouquet",
        options: {},
        forceApproval: true,
      };
      for (const allowanceUsd of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        const error = yield* Effect.flip(scene.service.startJob({ ...input, allowanceUsd }));
        assert.include(error.message, "allowance");
      }
      assert.deepStrictEqual(yield* scene.service.listJobs({ limit: 10 }), []);
      assert.deepStrictEqual(yield* scene.calls(), []);
    }),
  ),
);

it.effect(
  "per-job overrides and approval keep a stable immutable snapshot across settings changes",
  () =>
    scenario({ generators: "none", capUsd: 10 }, (scene) =>
      Effect.gen(function* () {
        const input = {
          actor: person,
          kind: "video" as const,
          clientId: scene.clientId,
          prompt: "A cake",
          options: { durationSeconds: 8 },
          connector: "muapi" as const,
          model: "veo3.1-text-to-video",
          forceApproval: true,
          allowanceUsd: 2,
          requestKey: "studio-scene-attempt-1",
        };
        const job = yield* scene.service.startJob(input);
        assert.strictEqual(job.status, "needs-approval");
        assert.strictEqual(job.estimatedUsd, null);
        assert.strictEqual(job.reservedUsd, 2);
        assert.strictEqual(job.options.generateAudio, undefined);
        assert.strictEqual((yield* scene.service.settings).videoGenerator, "none");
        yield* scene.service.setSettings({ videoGenerator: "fal", videoModel: "fal-ai/veo3.1" });
        assert.deepStrictEqual(yield* scene.service.startJob(input), job);
        assert.strictEqual(
          (yield* Effect.flip(scene.service.startJob({ ...input, prompt: "Different cake" })))
            .reason,
          "conflict",
        );
        assert.strictEqual((yield* scene.service.board(undefined)).spend[0]?.usedUsd, 2);
        assert.deepStrictEqual(yield* scene.calls(), []);
      }),
    ),
);

it.effect(
  "concurrent pending jobs and narration share one cap and expense retries cannot submit twice",
  () =>
    scenario({ capUsd: 3 }, (scene) =>
      Effect.gen(function* () {
        const expense = {
          clientId: scene.clientId,
          campaignId: scene.campaignId,
          requestKey: "narration-1",
          allowanceUsd: 2,
          label: "Narration",
        };
        const results = yield* Effect.all(
          [
            scene.service
              .startJob({
                actor: person,
                kind: "image",
                clientId: scene.clientId,
                prompt: "A bouquet",
                options: {},
                forceApproval: true,
                allowanceUsd: 2,
                requestKey: "scene-1",
              })
              .pipe(Effect.result),
            scene.service.reserveExternalExpense(expense).pipe(Effect.result),
          ],
          { concurrency: "unbounded" },
        );
        assert.strictEqual(results.filter((result) => result._tag === "Success").length, 1);
        assert.strictEqual((yield* scene.service.board(undefined)).spend[0]?.usedUsd, 2);
        for (const job of yield* scene.service.listJobs({ limit: 10 }))
          yield* scene.service.cancelJob(job.id);
        const retries = yield* Effect.all(
          [
            scene.service.reserveExternalExpense(expense),
            scene.service.reserveExternalExpense(expense),
          ],
          { concurrency: "unbounded" },
        );
        assert.strictEqual(retries[0].id, retries[1].id);
        assert.isFalse(retries[1].created);
        assert.strictEqual(
          (yield* Effect.flip(
            scene.service.reserveExternalExpense({ ...expense, allowanceUsd: 1 }),
          )).reason,
          "conflict",
        );
        assert.strictEqual((yield* scene.service.board(undefined)).spend[0]?.usedUsd, 2);
        assert.deepStrictEqual(yield* scene.calls(), []);
      }),
    ),
);

it.effect(
  "an ambiguous paid submission survives restart and reconciles a receipt without another POST",
  () =>
    scenario({ capUsd: 2 }, (scene) =>
      Effect.gen(function* () {
        scene.world.secrets.set(CAMPAIGN_MUAPI_KEY_SECRET, new TextEncoder().encode("test-key"));
        scene.world.provider.current = () => new Response("gateway disconnected", { status: 503 });
        const input = {
          actor: person,
          kind: "video" as const,
          clientId: scene.clientId,
          connector: "muapi" as const,
          model: "veo3.1-text-to-video",
          prompt: "A cake",
          options: {},
          allowanceUsd: 2,
          requestKey: "uncertain-attempt",
        };
        const job = yield* scene.service.startJob(input);
        yield* scene.service.tick;
        assert.strictEqual((yield* scene.service.getJob(job.id)).submissionState, "uncertain");
        yield* scene.service.recover;
        yield* scene.service.tick;
        assert.strictEqual((yield* scene.service.startJob(input)).id, job.id);
        assert.strictEqual(
          (yield* scene.calls()).filter((call) => call.startsWith("POST")).length,
          1,
        );
        assert.strictEqual((yield* scene.service.board(undefined)).spend[0]?.usedUsd, 2);
        assert.strictEqual(
          (yield* Effect.flip(scene.service.startJob({ ...input, requestKey: "another-attempt" })))
            .reason,
          "not_allowed",
        );
        scene.world.provider.current = () => Response.json({ status: "processing" });
        const reconciled = yield* scene.service.reconcileJob({
          jobId: job.id,
          providerJobId: "receipt-1",
        });
        assert.strictEqual(reconciled.submissionState, "submitted");
        yield* scene.service.recover;
        yield* scene.service.tick;
        assert.strictEqual(
          (yield* scene.calls()).filter((call) => call.startsWith("POST")).length,
          1,
        );
        assert.include((yield* scene.calls()).at(-1) ?? "", "/predictions/receipt-1/result");
      }),
    ),
);

it.effect(
  "invalid model controls and kind mismatches fail before any reservation or provider call",
  () =>
    scenario({}, (scene) =>
      Effect.gen(function* () {
        const base = {
          actor: person,
          kind: "video" as const,
          clientId: scene.clientId,
          prompt: "A cake",
          connector: "muapi" as const,
          model: "veo3.1-text-to-video",
          allowanceUsd: 2,
          forceApproval: true,
        };
        for (const options of [
          { durationSeconds: Number.NaN },
          { durationSeconds: 3.5 },
          { generateAudio: false },
          { generateAudio: true },
          { durationSeconds: 6 },
          { firstFrame: "https://cdn.test/frame.png" },
        ]) {
          yield* Effect.flip(scene.service.startJob({ ...base, options }));
        }
        yield* Effect.flip(
          scene.service.startJob({ ...base, options: {}, model: "custom-unknown" }),
        );
        yield* Effect.flip(scene.service.startJob({ ...base, options: {}, kind: "image" }));
        assert.deepStrictEqual(yield* scene.service.listJobs({ limit: 10 }), []);
        assert.deepStrictEqual(yield* scene.calls(), []);
      }),
    ),
);

it.effect("concurrent batch requests reserve their combined allowance before any approval", () =>
  scenario({ capUsd: 5 }, (scene) =>
    Effect.gen(function* () {
      const results = yield* Effect.forEach(
        Array.from({ length: 8 }, (_, index) => index),
        (index) =>
          scene.service
            .startJob({
              actor: person,
              clientId: scene.clientId,
              kind: "image",
              prompt: `Scene ${index}`,
              options: {},
              allowanceUsd: 2,
              forceApproval: true,
              requestKey: `batch-${index}`,
            })
            .pipe(Effect.result),
        { concurrency: "unbounded" },
      );
      assert.strictEqual(results.filter((result) => result._tag === "Success").length, 2);
      assert.strictEqual((yield* scene.service.board(undefined)).spend[0]?.usedUsd, 4);
      assert.deepStrictEqual(yield* scene.calls(), []);
    }),
  ),
);

it.effect(
  "approving preserves the original estimate and failures retain possibly charged spend",
  () => {
    let price = 2;
    return scenario(
      { capUsd: 3, estimate: () => ({ usd: price, note: `About $${price}` }) },
      (scene) =>
        Effect.gen(function* () {
          const job = yield* scene.service.startJob({
            actor: person,
            kind: "image",
            clientId: scene.clientId,
            prompt: "A bouquet",
            options: {},
            forceApproval: true,
          });
          price = 20;
          scene.world.provider.current = () =>
            Response.json({ error: "upstream failed" }, { status: 500 });
          const approved = yield* scene.service.approveJob(job.id);
          assert.strictEqual(approved.estimatedUsd, 2);
          assert.strictEqual(approved.reservedUsd, 2);
          yield* scene.service.tick;
          assert.strictEqual((yield* scene.service.board(undefined)).spend[0]?.usedUsd, 2);
        }),
    );
  },
);

it.effect("campaign plan budget combines generation and narration across months", () =>
  scenario({ capUsd: 100 }, (scene) =>
    Effect.gen(function* () {
      yield* scene.sql`INSERT INTO workbench_content_studios(campaign_id, revision, document)
      VALUES (${scene.campaignId}, 1, '{"brief":{"budgetUsd":3}}')`;
      const narration = {
        clientId: scene.clientId,
        campaignId: scene.campaignId,
        requestKey: "old-narration",
        allowanceUsd: 2,
        label: "Narration",
      };
      yield* scene.service.reserveExternalExpense(narration);
      // The monthly client cap resets; the approved campaign budget does not.
      yield* scene.sql`UPDATE workbench_campaign_external_expenses SET created_at = '2020-01-01T00:00:00.000Z'`;
      const job = yield* scene.service.startJob({
        actor: person,
        kind: "image",
        clientId: scene.clientId,
        campaignId: scene.campaignId,
        prompt: "A bouquet",
        options: {},
        allowanceUsd: 1,
        forceApproval: true,
      });
      assert.strictEqual(job.reservedUsd, 1);
      const refused = yield* Effect.flip(
        scene.service.reserveExternalExpense({
          ...narration,
          requestKey: "new-narration",
          allowanceUsd: 0.5,
        }),
      );
      assert.include(refused.message, "campaign's approved budget of $3.00 ($3.00 reserved)");
      yield* scene.service.cancelJob(job.id);
      yield* scene.service.reserveExternalExpense({
        ...narration,
        requestKey: "replacement-narration",
        allowanceUsd: 1,
      });
      assert.deepStrictEqual(yield* scene.calls(), []);
    }),
  ),
);

it.effect("concurrent campaign generation and narration cannot exceed the plan budget", () =>
  scenario({ capUsd: 100 }, (scene) =>
    Effect.gen(function* () {
      yield* scene.sql`INSERT INTO workbench_content_studios(campaign_id, revision, document)
      VALUES (${scene.campaignId}, 1, '{"brief":{"budgetUsd":3}}')`;
      const results = yield* Effect.all(
        [
          scene.service
            .startJob({
              actor: person,
              kind: "image",
              clientId: scene.clientId,
              campaignId: scene.campaignId,
              prompt: "A bouquet",
              options: {},
              allowanceUsd: 2,
              forceApproval: true,
            })
            .pipe(Effect.result),
          scene.service
            .reserveExternalExpense({
              clientId: scene.clientId,
              campaignId: scene.campaignId,
              requestKey: "concurrent-narration",
              allowanceUsd: 2,
              label: "Narration",
            })
            .pipe(Effect.result),
        ],
        { concurrency: "unbounded" },
      );
      assert.strictEqual(results.filter((result) => result._tag === "Success").length, 1);
      assert.strictEqual((yield* scene.service.board(undefined)).spend[0]?.usedUsd, 2);
    }),
  ),
);

it.effect("approval rechecks a lowered campaign budget without changing the reservation", () =>
  scenario({ capUsd: 100 }, (scene) =>
    Effect.gen(function* () {
      const job = yield* scene.service.startJob({
        actor: person,
        kind: "image",
        clientId: scene.clientId,
        campaignId: scene.campaignId,
        prompt: "A bouquet",
        options: {},
        allowanceUsd: 2,
        forceApproval: true,
      });
      yield* scene.sql`INSERT INTO workbench_content_studios(campaign_id, revision, document)
      VALUES (${scene.campaignId}, 1, '{"brief":{"budgetUsd":1}}')`;
      assert.include(
        (yield* Effect.flip(scene.service.approveJob(job.id))).message,
        "approved budget",
      );
      assert.strictEqual((yield* scene.service.getJob(job.id)).status, "needs-approval");
      yield* scene.sql`UPDATE workbench_content_studios SET document = '{"brief":{"budgetUsd":null}}'`;
      yield* scene.service.approveJob(job.id);
    }),
  ),
);

it.effect(
  "a receipt persistence failure keeps the accepted request uncertain across recovery",
  () =>
    scenario({}, (scene) =>
      Effect.gen(function* () {
        scene.world.secrets.set(CAMPAIGN_MUAPI_KEY_SECRET, new TextEncoder().encode("test-key"));
        scene.world.provider.current = () => Response.json({ request_id: "accepted-receipt" });
        yield* scene.sql`CREATE TRIGGER reject_receipt BEFORE UPDATE OF provider_job_id
      ON workbench_campaign_generation_jobs WHEN NEW.provider_job_id IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'simulated receipt persistence failure'); END`;
        const job = yield* scene.service.startJob({
          actor: person,
          kind: "video",
          clientId: scene.clientId,
          connector: "muapi",
          model: "veo3.1-text-to-video",
          prompt: "A cake",
          options: {},
          allowanceUsd: 2,
          requestKey: "receipt-write-failure",
        });
        yield* scene.service.tick;
        const uncertain = yield* scene.service.getJob(job.id);
        assert.strictEqual(uncertain.status, "running");
        assert.strictEqual(uncertain.submissionState, "uncertain");
        assert.include(uncertain.error ?? "", "receipt could not be saved");
        yield* scene.service.recover;
        yield* scene.service.tick;
        assert.strictEqual(
          (yield* scene.calls()).filter((call) => call.startsWith("POST")).length,
          1,
        );
        assert.strictEqual((yield* scene.service.board(undefined)).spend[0]?.usedUsd, 2);
      }),
    ),
);

it.effect(
  "campaign budget presents full all-time reservations separately from unreported charges",
  () =>
    scenario({ capUsd: 100 }, (scene) =>
      Effect.gen(function* () {
        yield* scene.sql`INSERT INTO workbench_content_studios(campaign_id, revision, document)
      VALUES (${scene.campaignId}, 1, '{"brief":{"budgetUsd":10}}')`;
        const expense = yield* scene.service.reserveExternalExpense({
          clientId: scene.clientId,
          campaignId: scene.campaignId,
          requestKey: "budget-narration",
          allowanceUsd: 2,
          label: "Narration",
        });
        yield* scene.sql`UPDATE workbench_campaign_external_expenses SET created_at = '2020-01-01T00:00:00.000Z'`;
        const job = yield* scene.service.startJob({
          actor: person,
          kind: "image",
          clientId: scene.clientId,
          campaignId: scene.campaignId,
          prompt: "Approved image",
          options: {},
          allowanceUsd: 3,
          forceApproval: true,
        });
        assert.deepStrictEqual(yield* scene.service.campaignBudget(scene.campaignId), {
          budgetUsd: 10,
          reservedUsd: 5,
          availableUsd: 5,
          confirmedUsd: null,
          unreportedCount: 1,
          unresolvedSubmissions: 1,
        });
        yield* scene.service.cancelJob(job.id);
        const cancelled = yield* scene.service.campaignBudget(scene.campaignId);
        assert.equal(cancelled.reservedUsd, 2);
        assert.equal(cancelled.availableUsd, 8);
        // Saved audio proves completion, not a billed dollar amount.
        yield* scene.sql`UPDATE workbench_content_studios SET document = json_set(document, '$.narrations', json_array(json_object('expenseId', ${expense.id}, 'status', 'completed')))
      WHERE campaign_id = ${scene.campaignId}`;
        const completed = yield* scene.service.campaignBudget(scene.campaignId);
        assert.equal(completed.unresolvedSubmissions, 0);
        assert.equal(completed.unreportedCount, 1);
        assert.equal(completed.confirmedUsd, null);
        assert.equal(completed.reservedUsd, 2);
        assert.deepStrictEqual(yield* scene.calls(), []);
      }),
    ),
);
