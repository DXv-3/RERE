import type {
  CampaignGenerationJob,
  CampaignGenerationSettings,
  CampaignGenerationSpend,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  costPreview,
  folderChoices,
  latestPostThread,
  emptyGenerationForm,
  formForKind,
  formFromImageJob,
  formToOptions,
  generationFormProblems,
  generationRow,
  generatorFor,
  generatorLine,
  isLocalVideo,
  jobsForClient,
  localVideoLimits,
  promptExcerpt,
  spendSummary,
  waitingForApprovalCount,
} from "./generation.logic";

const job = (patch: Partial<CampaignGenerationJob> = {}): CampaignGenerationJob =>
  ({
    id: "job-1",
    clientId: "client-1",
    kind: "image",
    connector: "openrouter",
    model: "m",
    prompt: "A sunlit studio",
    options: {},
    status: "queued",
    estimatedUsd: null,
    estimateNote: "Cost unknown: no price is published for this model here.",
    resultPaths: [],
    requestedBy: { kind: "person" },
    createdAt: "2026-10-03T10:00:00.000Z",
    updatedAt: "2026-10-03T10:00:00.000Z",
    ...patch,
  }) as CampaignGenerationJob;

const settings = (patch: Partial<CampaignGenerationSettings> = {}): CampaignGenerationSettings => ({
  imageGenerator: "openrouter",
  videoGenerator: "none",
  hasOpenRouterKey: true,
  hasMuapiKey: false,
  hasFalKey: false,
  localBaseUrl: "",
  localGpu: {
    python: "",
    model: "",
    videoModel: "",
    modelsDir: "",
    whenBusy: "fallback",
    windowStart: "",
    windowEnd: "",
  },
  models: { image: "img-model", video: "", local: "local-model" },
  ...patch,
});

const actionsOf = (row: ReturnType<typeof generationRow>) => row.actions.map((a) => a.action);

describe("generationRow", () => {
  it("offers Approve and Cancel for a job waiting for approval, off for non-administrators", () => {
    const waiting = job({ status: "needs-approval" });
    const admin = generationRow(waiting, { isAdministrator: true });
    expect(actionsOf(admin)).toEqual(["approve", "cancel"]);
    expect(admin.actions.every((a) => a.enabled)).toBe(true);
    const other = generationRow(waiting, { isAdministrator: false });
    expect(actionsOf(other)).toEqual(["approve", "cancel"]);
    expect(other.actions.every((a) => !a.enabled && a.reason !== undefined)).toBe(true);
    expect(admin.statusLabel).toBe("Waiting For Approval");
  });

  it("offers only Cancel while queued or running", () => {
    for (const status of ["queued", "running"] as const) {
      expect(actionsOf(generationRow(job({ status }), { isAdministrator: true }))).toEqual([
        "cancel",
      ]);
    }
  });

  it("offers nothing for failed or cancelled jobs, and shows the failure reason", () => {
    const failed = generationRow(job({ status: "failed", error: "Out of credit." }), {
      isAdministrator: true,
    });
    expect(failed.actions).toEqual([]);
    expect(failed.failure).toBe("Out of credit.");
    expect(generationRow(job({ status: "failed" }), { isAdministrator: true }).failure).toContain(
      "no reason",
    );
    expect(generationRow(job({ status: "cancelled" }), { isAdministrator: true }).actions).toEqual(
      [],
    );
    expect(generationRow(job({ status: "queued" }), { isAdministrator: true }).failure).toBeNull();
  });

  it("shows why a queued job is waiting, and only while it is queued", () => {
    const note = "Waiting for the graphics card: 3.3 GB free, this model needs 6.5 GB.";
    const waiting = generationRow(job({ status: "queued", waitingNote: note }), {
      isAdministrator: true,
    });
    expect(waiting.waitingNote).toBe(note);
    expect(actionsOf(waiting)).toEqual(["cancel"]);
    expect(
      generationRow(job({ status: "queued" }), { isAdministrator: true }).waitingNote,
    ).toBeNull();
    expect(
      generationRow(job({ status: "running", waitingNote: note }), { isAdministrator: true })
        .waitingNote,
    ).toBeNull();
  });

  it("lets anyone add a finished job to a post, and open it only when it has a thread", () => {
    const done = job({
      status: "done",
      resultPaths: ["campaigns/a/generated/job-1.png"],
      sourceThreadId: "thread-1" as never,
    });
    const row = generationRow(done, { isAdministrator: false });
    expect(actionsOf(row)).toEqual(["addToPost", "open"]);
    expect(row.actions.every((a) => a.enabled)).toBe(true);
    expect(row.resultPath).toBe("campaigns/a/generated/job-1.png");
    const noThread = generationRow(
      { ...done, sourceThreadId: undefined },
      { isAdministrator: true },
    );
    const open = noThread.actions.find((a) => a.action === "open");
    expect(open?.enabled).toBe(false);
    expect(open?.reason).toContain("export folder");
  });

  it("leaves Add To A New Post out where there is no campaign", () => {
    const done = job({
      status: "done",
      resultPaths: ["a.png"],
      sourceThreadId: "t" as never,
    });
    expect(actionsOf(generationRow(done, { isAdministrator: true, canAddToPost: false }))).toEqual([
      "open",
    ]);
  });

  it("offers nothing to add for a done job with no files", () => {
    expect(generationRow(job({ status: "done" }), { isAdministrator: true }).actions).toEqual([]);
  });

  it("names who asked and never invents a cost", () => {
    expect(generationRow(job(), { isAdministrator: true }).requester).toBe("Asked by a person");
    expect(
      generationRow(job({ requestedBy: { kind: "agent", threadId: "t" as never } }), {
        isAdministrator: true,
      }).requester,
    ).toBe("Asked by an agent");
    expect(generationRow(job(), { isAdministrator: true }).costNote).toContain("Cost unknown");
    expect(
      generationRow(job({ estimateNote: " ", estimatedUsd: null }), { isAdministrator: true })
        .costNote,
    ).toBe("Cost unknown.");
  });
});

describe("lists", () => {
  it("keeps one client's jobs, newest first", () => {
    const list = jobsForClient(
      [
        job({ id: "a", createdAt: "2026-10-01T00:00:00.000Z" }),
        job({ id: "b", clientId: "other" }),
        job({ id: "c", createdAt: "2026-10-05T00:00:00.000Z" }),
      ],
      "client-1",
    );
    expect(list.map((j) => j.id)).toEqual(["c", "a"]);
  });

  it("counts jobs waiting", () => {
    expect(
      waitingForApprovalCount([job({ status: "needs-approval" }), job(), job({ status: "done" })]),
    ).toBe(1);
  });

  it("shortens long prompts on one line", () => {
    expect(promptExcerpt("a\n  b")).toBe("a b");
    expect(promptExcerpt("x".repeat(300)).length).toBe(140);
  });
});

describe("spendSummary", () => {
  const now = "2026-10-06T12:00:00.000Z";
  const spend = (patch: Partial<CampaignGenerationSpend> = {}): CampaignGenerationSpend => ({
    clientId: "client-1",
    capUsd: 50,
    usedUsd: 12.5,
    ...patch,
  });
  it("says used against the limit", () => {
    expect(spendSummary(spend(), [], now)).toBe(
      "$12.50 of a $50.00 monthly limit estimated this month.",
    );
  });
  it("says there is no limit", () => {
    expect(spendSummary(spend({ capUsd: null }), [], now)).toBe(
      "$12.50 estimated this month. No monthly limit is set.",
    );
  });
  it("mentions unknown costs only when one counts this month", () => {
    expect(spendSummary(spend(), [job({ status: "done" })], now)).toContain(
      "Unknown-price jobs reserve their approved allowances",
    );
    expect(spendSummary(spend(), [job({ status: "failed" })], now)).not.toContain("unknown");
    expect(
      spendSummary(spend(), [job({ status: "done", createdAt: "2026-09-30T00:00:00.000Z" })], now),
    ).not.toContain("unknown");
  });
  it("handles no record", () => {
    expect(spendSummary(undefined, [], now)).toContain("No spending");
  });
});

describe("generator choice", () => {
  it("is none when the setting is none", () => {
    expect(generatorFor(settings(), "video")).toEqual({ kind: "none" });
    expect(generatorLine({ kind: "none" })).toBe("No generator is set for this.");
  });
  it("names the service and model", () => {
    const choice = generatorFor(settings(), "image");
    expect(choice).toEqual({ kind: "ready", generator: "openrouter", model: "img-model" });
    expect(generatorLine(choice)).toBe("Made by OpenRouter (img-model).");
    expect(generatorFor(settings({ imageGenerator: "local" }), "image")).toEqual({
      kind: "ready",
      generator: "local",
      model: "local-model",
    });
  });
  it("names this computer's GPU and falls back to the small preset", () => {
    const choice = generatorFor(settings({ imageGenerator: "local-gpu" }), "image");
    expect(choice).toEqual({ kind: "ready", generator: "local-gpu", model: "lcm-dreamshaper-v7" });
    expect(generatorLine(choice)).toBe("Made by This Computer's GPU (lcm-dreamshaper-v7).");
  });
});

describe("form", () => {
  it("needs a prompt, and for video a whole number of seconds in range", () => {
    expect(generationFormProblems(emptyGenerationForm)).toEqual(["Write what to make."]);
    const video = { ...emptyGenerationForm, kind: "video" as const, prompt: "x" };
    expect(generationFormProblems(video)).toEqual([]);
    expect(generationFormProblems({ ...video, durationSeconds: "0" })).toHaveLength(1);
    expect(generationFormProblems({ ...video, durationSeconds: "31" })).toHaveLength(1);
    expect(generationFormProblems({ ...video, durationSeconds: "2.5" })).toHaveLength(1);
    expect(generationFormProblems({ ...video, durationSeconds: "" })).toHaveLength(1);
    expect(
      generationFormProblems({ ...emptyGenerationForm, prompt: "y".repeat(4001) }),
    ).toHaveLength(1);
  });
  it("leaves video fields off an image", () => {
    expect(formToOptions({ ...emptyGenerationForm, prompt: "x" })).toEqual({ aspectRatio: "1:1" });
    expect(formToOptions({ ...emptyGenerationForm, kind: "video", generateAudio: true })).toEqual({
      aspectRatio: "1:1",
      durationSeconds: 6,
      resolution: "720p",
      generateAudio: true,
    });
  });
});

describe("costPreview", () => {
  const base = {
    clientName: "Candid Studios",
    jobs: [],
    nowIso: "2026-10-06T12:00:00.000Z",
    form: { ...emptyGenerationForm, prompt: "x" },
  };
  it("says plainly when the cost is unknown", () => {
    const preview = costPreview({
      ...base,
      spend: { clientId: "c", capUsd: 10, usedUsd: 2 },
      choice: { kind: "ready", generator: "openrouter", model: "m" },
    });
    expect(preview.costUnknown).toBe(true);
    expect(preview.costLine).toContain("Cost unknown");
    expect(preview.refusal).toContain("positive dollar allowance");
    expect(preview.spendLine).toContain("$2.00 of a $10.00");
  });
  it("knows a local server costs nothing from a provider", () => {
    const preview = costPreview({
      ...base,
      spend: undefined,
      choice: { kind: "ready", generator: "local", model: "m" },
    });
    expect(preview.costUnknown).toBe(false);
    expect(preview.costLine).toContain("no charge");
  });
  it("reports a refusal when the limit is already passed", () => {
    const preview = costPreview({
      ...base,
      spend: { clientId: "c", capUsd: 5, usedUsd: 6 },
      choice: { kind: "ready", generator: "local", model: "m" },
    });
    expect(preview.refusal).toContain("Candid Studios");
  });
});

describe("save folder", () => {
  const thread = (id: string, updatedAt: string, extra: Record<string, unknown> = {}) => ({
    id,
    title: id,
    environmentId: "e1",
    archivedAt: null,
    updatedAt,
    ...extra,
  });
  it("lists live threads of this environment newest first, the preferred one first of all", () => {
    const list = folderChoices(
      [
        thread("old", "2026-10-01T00:00:00Z"),
        thread("new", "2026-10-05T00:00:00Z"),
        thread("gone", "2026-10-06T00:00:00Z", { archivedAt: "x" }),
        thread("elsewhere", "2026-10-06T00:00:00Z", { environmentId: "e2" }),
      ],
      "e1",
      "old",
    );
    expect(list.map((t) => t.id)).toEqual(["old", "new"]);
  });
  it("ignores a preferred thread that no longer exists", () => {
    expect(
      folderChoices([thread("a", "2026-10-01T00:00:00Z")], "e1", "missing").map((t) => t.id),
    ).toEqual(["a"]);
  });
  it("finds the thread of the latest post that has one", () => {
    expect(
      latestPostThread([
        { sourceThreadId: "t1", updatedAt: "2026-10-01T00:00:00Z" },
        { sourceThreadId: undefined, updatedAt: "2026-10-09T00:00:00Z" },
        { sourceThreadId: "t2", updatedAt: "2026-10-03T00:00:00Z" },
      ]),
    ).toBe("t2");
    expect(latestPostThread([])).toBeUndefined();
  });
});

describe("video from a still on this computer", () => {
  const gpu = settings({ imageGenerator: "local-gpu", videoGenerator: "local-gpu" });
  const choice = generatorFor(gpu, "video");
  const done = job({
    id: "img-1",
    status: "done",
    resultPaths: ["campaigns/a/unsorted/generated/img-1.png"],
    sourceThreadId: "thread-1" as never,
  });

  it("names the video model, which is the default when none is set", () => {
    expect(choice).toEqual({ kind: "ready", generator: "local-gpu", model: "wan22-ti2v-5b" });
    expect(generatorLine(choice)).toBe("Made by This Computer's GPU (wan22-ti2v-5b).");
    expect(
      generatorFor(
        settings({
          videoGenerator: "local-gpu",
          localGpu: { ...gpu.localGpu, videoModel: "other", model: "sdxl-base-1.0" },
        }),
        "video",
      ),
    ).toEqual({ kind: "ready", generator: "local-gpu", model: "other" });
    // The image model is unaffected.
    expect(generatorFor(gpu, "image")).toEqual({
      kind: "ready",
      generator: "local-gpu",
      model: "lcm-dreamshaper-v7",
    });
    expect(isLocalVideo("video", choice)).toBe(true);
    expect(isLocalVideo("image", choice)).toBe(false);
    expect(
      isLocalVideo("video", generatorFor(settings({ videoGenerator: "openrouter" }), "video")),
    ).toBe(false);
  });

  it("offers Make A Video From This on a finished image, for administrators with a thread", () => {
    const admin = generationRow(done, { isAdministrator: true, canMakeVideo: true });
    expect(actionsOf(admin)).toEqual(["addToPost", "open", "makeVideo"]);
    const make = admin.actions.find((a) => a.action === "makeVideo");
    expect(make).toMatchObject({ label: "Make A Video From This", enabled: true });

    const other = generationRow(done, { isAdministrator: false, canMakeVideo: true });
    const off = other.actions.find((a) => a.action === "makeVideo");
    expect(off?.enabled).toBe(false);
    expect(off?.reason).toBe("Only an administrator can do this.");

    const noThread = generationRow(
      { ...done, sourceThreadId: undefined },
      { isAdministrator: true, canMakeVideo: true },
    );
    const stuck = noThread.actions.find((a) => a.action === "makeVideo");
    expect(stuck?.enabled).toBe(false);
    expect(stuck?.reason).toContain("export folder");
  });

  it("leaves it off a video, an unfinished image, and screens with no Generate form", () => {
    const video = job({ ...done, id: "vid-1", kind: "video", resultPaths: ["x/vid-1.mp4"] });
    expect(actionsOf(generationRow(video, { isAdministrator: true, canMakeVideo: true }))).toEqual([
      "addToPost",
      "open",
    ]);
    const running = job({ id: "img-2", status: "running" });
    expect(
      actionsOf(generationRow(running, { isAdministrator: true, canMakeVideo: true })),
    ).toEqual(["cancel"]);
    expect(actionsOf(generationRow(done, { isAdministrator: true }))).toEqual([
      "addToPost",
      "open",
    ]);
  });

  it("opens the form as a 9:16 video, 5 seconds, 480p, from that picture", () => {
    const form = formFromImageJob(done, choice);
    expect(form).toMatchObject({
      kind: "video",
      aspectRatio: "9:16",
      durationSeconds: "5",
      resolution: "480p",
      generateAudio: false,
      firstFrame: "campaigns/a/unsorted/generated/img-1.png",
      firstFrameJobId: "img-1",
    });
    expect(formToOptions({ ...form, prompt: "x" })).toEqual({
      aspectRatio: "9:16",
      durationSeconds: 5,
      resolution: "480p",
      generateAudio: false,
      firstFrameJobId: "img-1",
    });
  });

  it("names a hand-chosen picture by its path, and needs one", () => {
    const base = { ...formForKind(emptyGenerationForm, "video", choice), prompt: "x" };
    expect(generationFormProblems(base, choice)).toEqual([
      "This computer makes video from a still image. Choose an image to start from.",
    ]);
    const chosen = { ...base, firstFrame: "pics/cake.png" };
    expect(generationFormProblems(chosen, choice)).toEqual([]);
    expect(formToOptions(chosen)).toMatchObject({ firstFrame: "pics/cake.png" });
    expect(formToOptions(chosen)).not.toHaveProperty("firstFrameJobId");
  });

  it("holds the length to what the model makes, but not for other generators", () => {
    const base = {
      ...formForKind(emptyGenerationForm, "video", choice),
      prompt: "x",
      firstFrame: "a.png",
    };
    expect(localVideoLimits("wan22-ti2v-5b")).toEqual({ min: 3, max: 5, resolutions: ["480p"] });
    for (const seconds of ["2", "6", "10"]) {
      expect(generationFormProblems({ ...base, durationSeconds: seconds }, choice)).toEqual([
        "Length must be a whole number of seconds from 3 to 5.",
      ]);
    }
    for (const seconds of ["3", "4", "5"]) {
      expect(generationFormProblems({ ...base, durationSeconds: seconds }, choice)).toEqual([]);
    }
    const hosted = generatorFor(settings({ videoGenerator: "openrouter" }), "video");
    expect(
      generationFormProblems({ ...emptyGenerationForm, kind: "video", prompt: "x" }, hosted),
    ).toEqual([]);
    expect(formForKind(emptyGenerationForm, "video", hosted)).toMatchObject({
      aspectRatio: "9:16",
      durationSeconds: "6",
      resolution: "720p",
    });
    expect(formForKind(emptyGenerationForm, "image", choice)).toMatchObject({
      kind: "image",
      aspectRatio: "1:1",
    });
  });
});

describe("verified hosted model controls", () => {
  const choice = (generator: "fal" | "muapi", model: string) => ({
    kind: "ready" as const,
    generator,
    model,
  });
  const video = {
    ...emptyGenerationForm,
    kind: "video" as const,
    prompt: "A scene",
    firstFrame: "product.png",
  };
  it("uses supported MuAPI defaults and never sends its provider-controlled audio flag", () => {
    const provider = choice("muapi", "veo3.1-image-to-video");
    const form = formForKind(video, "video", provider);
    expect(form.durationSeconds).toBe("8");
    expect(formToOptions({ ...form, generateAudio: true }, provider)).not.toHaveProperty(
      "generateAudio",
    );
    expect(generationFormProblems(form, provider)).toEqual([]);
  });
  it("omits Kling shape and resolution controls and keeps fal audio support", () => {
    const provider = choice("fal", "fal-ai/kling-video/v3/pro/image-to-video");
    const options = formToOptions(formForKind(video, "video", provider), provider);
    expect(options).toMatchObject({
      durationSeconds: 5,
      firstFrame: "product.png",
      generateAudio: false,
    });
    expect(options).not.toHaveProperty("aspectRatio");
    expect(options).not.toHaveProperty("resolution");
  });
  it("requires a reference image and validates Runway's duration-resolution combination", () => {
    const provider = choice("muapi", "runway-image-to-video");
    expect(
      generationFormProblems(
        { ...video, durationSeconds: "8", resolution: "1080p" },
        provider,
      ).join(" "),
    ).toContain("720p");
    expect(
      generationFormProblems({ ...video, durationSeconds: "5", firstFrame: "" }, provider).join(
        " ",
      ),
    ).toContain("starting image");
  });
  it("resolves an empty MuAPI image model to supported flux-dev", () => {
    const provider = choice("muapi", "");
    expect(
      generationFormProblems({ ...emptyGenerationForm, prompt: "An image" }, provider),
    ).toEqual([]);
    expect(formToOptions({ ...emptyGenerationForm, prompt: "An image" }, provider)).toEqual({
      aspectRatio: "1:1",
    });
  });
  it("checks unknown-price allowances against the monthly cap", () => {
    const base = {
      clientName: "Brand",
      jobs: [],
      nowIso: "2026-10-08T12:00:00Z",
      form: video,
      choice: choice("muapi", "veo3.1-image-to-video"),
      spend: { clientId: "client", capUsd: 5, usedUsd: 4 },
    };
    expect(costPreview({ ...base, allowanceUsd: 0 }).refusal).toContain(
      "positive dollar allowance",
    );
    expect(costPreview({ ...base, allowanceUsd: 2 }).refusal).toContain("monthly limit");
    expect(costPreview({ ...base, allowanceUsd: 1 }).refusal).toBeNull();
  });
});
