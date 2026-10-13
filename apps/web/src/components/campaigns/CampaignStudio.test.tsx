// @vitest-environment jsdom
import {
  EnvironmentId,
  ThreadId,
  type ContentStudio,
  type CampaignBoard,
} from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { CampaignRun } from "./useCampaigns";

const upload = vi.hoisted(() => ({ file: vi.fn(), release: vi.fn() }));
vi.mock("./studioUpload", () => ({ uploadStudioFile: upload.file }));
vi.mock("./CampaignStudioThread", () => ({
  CampaignStudioThread: () => <aside>Real thread host boundary</aside>,
}));
vi.mock("./CampaignPostMedia", () => ({
  CampaignMediaThumb: () => null,
  useOpenPostMedia: () => vi.fn(),
}));
vi.mock("../../assets/assetUrls", () => ({ useAssetUrlState: () => ({ _tag: "Loading" }) }));
import { CampaignStudio } from "./CampaignStudio";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const initial: ContentStudio = {
  campaignId: "campaign",
  revision: 0,
  brief: {
    offer: "Original offer",
    audience: "Makers",
    objective: "Launch",
    platforms: ["instagram"],
    durationSeconds: 15,
    references: [],
    sourceThreadId: ThreadId.make("thread"),
  },
  scenes: [],
  assets: [],
  renders: [],
  generationLinks: [],
};
const generation: CampaignBoard["generation"] = {
  jobs: [],
  spend: [],
  settings: {
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
      whenBusy: "wait",
      windowStart: "",
      windowEnd: "",
    },
  },
};
async function render(studio: ContentStudio, run: CampaignRun, boardGeneration = generation) {
  await act(async () =>
    root.render(
      <CampaignStudio
        studio={studio}
        campaignName="Launch"
        environmentId={EnvironmentId.make("env")}
        generation={boardGeneration}
        posts={[]}
        isAdministrator
        run={run}
        onOpenPost={vi.fn()}
        onNewPost={vi.fn()}
        refresh={vi.fn()}
      />,
    ),
  );
}
function button(text: string) {
  const found = [...container.querySelectorAll("button")].find((node) => node.textContent === text);
  if (!found) throw new Error(`Button missing: ${text}`);
  return found;
}
async function click(text: string) {
  await act(async () => button(text).click());
}
function field(label: string) {
  const labelNode = [...container.querySelectorAll("label")].find(
    (node) => node.textContent === label,
  );
  const element = labelNode ? document.getElementById(labelNode.htmlFor) : null;
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement))
    throw new Error(`Field missing: ${label}`);
  return element;
}
async function fill(label: string, value: string) {
  const element = field(label);
  await act(async () => {
    const prototype =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
describe("Content Studio interactions", () => {
  it("preserves unsaved brief edits on a newer revision and requires explicit conflict resolution", async () => {
    const run = vi.fn<CampaignRun>().mockImplementation(async (command) =>
      command.command === "studio.save"
        ? {
            ok: true,
            value: {
              kind: "studio",
              studio: { ...initial, revision: 2, brief: command.brief, scenes: command.scenes },
            },
          }
        : { ok: false, message: "Unexpected command" },
    );
    await render(initial, run);
    await fill("Offer / product", "My local offer");
    await render(
      { ...initial, revision: 1, brief: { ...initial.brief, offer: "Agent revision" } },
      run,
    );
    expect(field("Offer / product").value).toBe("My local offer");
    expect(button("Save changes").disabled).toBe(true);
    expect(container.textContent).toContain("A newer revision arrived");
    await click("Keep my edits on latest revision");
    await click("Save changes");
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      command: "studio.save",
      expectedRevision: 1,
      brief: { offer: "My local offer" },
    });
    expect(button("Save brief")).toBeDefined();
  });
  it("edits, duplicates and deletes scenes, then saves the visible storyboard", async () => {
    const run = vi.fn<CampaignRun>().mockImplementation(async (command) =>
      command.command === "studio.save"
        ? {
            ok: true,
            value: {
              kind: "studio",
              studio: { ...initial, revision: 1, brief: command.brief, scenes: command.scenes },
            },
          }
        : { ok: false, message: "Unexpected" },
    );
    await render(initial, run);
    await click("Add scene");
    await fill("Title", "Opening reveal");
    await click("Duplicate");
    expect(container.querySelectorAll('section[aria-label="Storyboard"] li')).toHaveLength(2);
    await click("Delete");
    await click("Save changes");
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      command: "studio.save",
      scenes: [{ title: "Opening reveal copy", selectedAssetId: null }],
    });
  });
  it("creates proposals without approving jobs or spending, and uses saved revision", async () => {
    const studio = {
      ...initial,
      revision: 3,
      scenes: [
        {
          id: "scene",
          title: "Hook",
          durationSeconds: 5,
          prompt: "Reveal",
          referenceImage: null,
          narration: "",
          onScreenText: "",
          selectedAssetId: null,
          connector: "fal",
          model: "fal-ai/veo3.1",
          resolution: "720p",
          generateAudio: false,
          allowanceUsd: 1,
        },
      ],
    };
    const run = vi.fn<CampaignRun>().mockResolvedValue({
      ok: true,
      value: { kind: "studio", studio: { ...studio, revision: 4 } },
    });
    await render(studio, run);
    await click("Prepare generation review");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toEqual({
      command: "studio.generate",
      campaignId: "campaign",
      expectedRevision: 3,
      sceneIds: ["scene"],
    });
    expect(container.textContent).toContain("Review each provider, model and cost");
  });
  it("requires renewed narration consent after changing the allowance", async () => {
    const studio = {
      ...initial,
      scenes: [
        {
          id: "scene",
          title: "Hook",
          durationSeconds: 5,
          prompt: "Reveal",
          referenceImage: null,
          narration: "Meet the product",
          onScreenText: "",
          selectedAssetId: null,
          connector: "fal",
          model: "fal-ai/veo3.1",
          resolution: "720p",
          generateAudio: false,
          allowanceUsd: 1,
        },
      ],
    };
    const run = vi
      .fn<CampaignRun>()
      .mockResolvedValue({ ok: true, value: { kind: "studio", studio } });
    await render(studio, run);
    await fill("Narration allowance (USD)", "1");
    expect(button("Approve spend and create narration").disabled).toBe(true);
    const consent = [...container.querySelectorAll("label")]
      .find((node) => node.textContent?.includes("I approve creating"))!
      .querySelector("input")!;
    await act(async () => consent.click());
    expect(button("Approve spend and create narration").disabled).toBe(false);
    await fill("Narration allowance (USD)", "2");
    expect(button("Approve spend and create narration").disabled).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });
  it("prepares only explicitly selected scenes", async () => {
    const scene = {
      id: "one",
      title: "Opening",
      durationSeconds: 5,
      prompt: "Reveal",
      referenceImage: null,
      narration: "",
      onScreenText: "",
      selectedAssetId: null,
      connector: "fal",
      model: "fal-ai/veo3.1",
      resolution: "720p",
      generateAudio: false,
      allowanceUsd: 1,
    };
    const studio = { ...initial, scenes: [scene, { ...scene, id: "two", title: "Closing" }] };
    const run = vi
      .fn<CampaignRun>()
      .mockResolvedValue({ ok: true, value: { kind: "studio", studio } });
    await render(studio, run);
    const selection = [...container.querySelectorAll("label")]
      .find((label) => label.textContent?.includes("2. Closing"))!
      .querySelector("input")!;
    await act(async () => selection.click());
    await click("Prepare selected scenes");
    expect(run.mock.calls[0]?.[0]).toMatchObject({ command: "studio.generate", sceneIds: ["two"] });
  });
  it("approves reviewed jobs once, reports partial failure, and keeps unknown allowances visible", async () => {
    const job: CampaignBoard["generation"]["jobs"][number] = {
      id: "job-one",
      campaignId: "campaign",
      clientId: "client",
      kind: "video",
      connector: "fal",
      model: "Model One",
      prompt: "Reveal",
      options: { durationSeconds: 5 },
      status: "needs-approval",
      estimatedUsd: 0.4,
      estimateNote: "Estimate",
      resultPaths: [],
      requestedBy: { kind: "person" },
      createdAt: "2026-10-08T12:00:00Z",
      updatedAt: "2026-10-08T12:00:00Z",
    };
    const jobs = [
      job,
      { ...job, id: "job-two", model: "Model Two", estimatedUsd: null, allowanceUsd: 2 },
    ];
    const studio = {
      ...initial,
      generationLinks: jobs.map((value) => ({ sceneId: "scene", jobId: value.id })),
    };
    const run = vi
      .fn<CampaignRun>()
      .mockImplementation(async (command) =>
        command.command === "generation.approve" && command.jobId === "job-one"
          ? { ok: true, value: { kind: "generationJob", job: { ...job, status: "queued" } } }
          : { ok: false, message: "Budget changed" },
      );
    await render(studio, run, { ...generation, jobs });
    for (const label of [...container.querySelectorAll("label")].filter((node) =>
      node.textContent?.includes("in approval batch"),
    )) {
      await act(async () => label.querySelector("input")!.click());
    }
    expect(container.textContent).toContain("Combined reservation: $2.40");
    await click("Approve selected jobs and spend");
    expect(run.mock.calls.map(([command]) => command)).toEqual([
      { command: "generation.approve", jobId: "job-one" },
      { command: "generation.approve", jobId: "job-two" },
    ]);
    expect(container.textContent).toContain("1 of 2 reviewed jobs approved");
    expect(container.textContent).toContain("Budget changed");
    expect(button("Approve selected jobs and spend").disabled).toBe(true);
  });
  it("recovers uncertain submission by receipt without creating a new generation", async () => {
    const job: CampaignBoard["generation"]["jobs"][number] = {
      id: "uncertain",
      campaignId: "campaign",
      clientId: "client",
      kind: "video",
      connector: "fal",
      model: "Veo",
      prompt: "Reveal",
      options: {},
      status: "failed",
      submissionState: "uncertain",
      estimatedUsd: null,
      estimateNote: "Unknown",
      allowanceUsd: 2,
      resultPaths: [],
      requestedBy: { kind: "person" },
      createdAt: "2026-10-08T12:00:00Z",
      updatedAt: "2026-10-08T12:00:00Z",
    };
    const studio = { ...initial, generationLinks: [{ sceneId: "scene", jobId: job.id }] };
    const run = vi
      .fn<CampaignRun>()
      .mockResolvedValue({ ok: true, value: { kind: "generationJob", job } });
    await render(studio, run, { ...generation, jobs: [job] });
    await fill("Provider job receipt", "provider-existing-job");
    await click("Resume polling");
    expect(run.mock.calls.map(([command]) => command)).toEqual([
      {
        command: "generation.reconcile",
        jobId: "uncertain",
        providerJobId: "provider-existing-job",
      },
    ]);
  });
  it("preserves unsaved render caption and audio settings across Library and Calendar", async () => {
    const run = vi
      .fn<CampaignRun>()
      .mockResolvedValue({ ok: true, value: { kind: "studio", studio: initial } });
    await render(initial, run);
    await fill("Caption for exported post", "Keep this unsaved caption");
    const ratioLabel = [...container.querySelectorAll("label")].find(
      (node) => node.textContent === "Format",
    )!;
    const ratio = document.getElementById(ratioLabel.htmlFor) as HTMLSelectElement;
    await act(async () => {
      ratio.value = "1:1";
      ratio.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const sound = [...container.querySelectorAll("label")]
      .find((node) => node.textContent?.includes("Retain source sound"))!
      .querySelector("input")!;
    await act(async () => sound.click());
    await click("Library");
    expect(field("Caption for exported post").closest("[hidden][inert]")).not.toBeNull();
    await click("Calendar");
    await click("Create");
    expect(field("Caption for exported post").value).toBe("Keep this unsaved caption");
    expect(ratio.value).toBe("1:1");
    expect(sound.checked).toBe(true);
    expect(field("Caption for exported post").closest("[hidden]")).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });
  it("requires an explicit crop or pad choice for square and landscape renders", async () => {
    const scene = {
      id: "scene",
      title: "Hook",
      durationSeconds: 15,
      prompt: "Reveal",
      referenceImage: null,
      narration: "",
      onScreenText: "",
      selectedAssetId: "asset",
      connector: "fal",
      model: "fal-ai/veo3.1",
      resolution: "720p",
      generateAudio: false,
      allowanceUsd: 1,
    };
    const studio = { ...initial, scenes: [scene] };
    const run = vi
      .fn<CampaignRun>()
      .mockResolvedValue({ ok: true, value: { kind: "studio", studio } });
    await render(studio, run);
    const select = async (label: string, value: string) => {
      const labelNode = [...container.querySelectorAll("label")].find(
        (node) => node.textContent === label,
      )!;
      const element = document.getElementById(labelNode.htmlFor) as HTMLSelectElement;
      await act(async () => {
        element.value = value;
        element.dispatchEvent(new Event("change", { bubbles: true }));
      });
    };
    expect(button("Render selected variants").disabled).toBe(false);
    await select("Format", "1:1");
    expect(button("Render selected variants").disabled).toBe(true);
    await select("Fit", "pad");
    await click("Render selected variants");
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      command: "studio.render",
      aspectRatio: "1:1",
      fit: "pad",
    });
    await select("Format", "16:9");
    expect(button("Render selected variants").disabled).toBe(true);
    await select("Fit", "crop");
    expect(button("Render selected variants").disabled).toBe(false);
    await select("Format", "9:16");
    expect(button("Render selected variants").disabled).toBe(false);
  });
});

it("imports a batch with each acknowledged revision and reports partial failure", async () => {
  upload.file.mockReset();
  upload.release.mockReset();
  upload.file.mockResolvedValue({
    attachmentId: "pending-upload",
    kind: "audio",
    release: upload.release,
  });
  const run = vi
    .fn<CampaignRun>()
    .mockResolvedValueOnce({
      ok: true,
      value: { kind: "studio", studio: { ...initial, revision: 1 } },
    })
    .mockResolvedValueOnce({ ok: false, message: "The campaign changed. Refresh." });
  await render(initial, run);
  await click("Library");
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", {
    value: [new File(["one"], "one.mp3"), new File(["two"], "two.mp3")],
  });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(run.mock.calls.map(([command]) => command)).toEqual([
    expect.objectContaining({ command: "studio.importUploaded", expectedRevision: 0 }),
    expect.objectContaining({ command: "studio.importUploaded", expectedRevision: 1 }),
  ]);
  expect(upload.release).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain("1 of 2 files imported");
  expect(container.textContent).toContain("The campaign changed");
});
