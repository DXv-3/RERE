// @vitest-environment jsdom
import { EnvironmentId, ThreadId, type ContentStudio, type StudioAsset } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

vi.mock("./CampaignPostMedia", () => ({
  CampaignMediaThumb: () => null,
  useOpenPostMedia: () => vi.fn(),
}));
vi.mock("../../assets/assetUrls", () => ({
  useAssetUrlState: (_env: unknown, resource: { threadId: string; path: string }) => ({
    _tag: "Success",
    url: `/signed/${resource.threadId}/${resource.path}`,
  }),
}));
import { CampaignStudioLibrary } from "./CampaignStudioLibrary";
import { StudioStoryboardTemplates } from "./StudioStoryboardTemplates";
import { StudioVariantComparison } from "./StudioVariantComparison";

const environmentId = EnvironmentId.make("env");
const asset: StudioAsset = {
  id: "asset",
  sceneId: null,
  kind: "audio",
  file: "voice.mp3",
  sourceThreadId: ThreadId.make("original-thread"),
  jobId: null,
  prompt: "",
  connector: "",
  model: "",
  createdAt: "2026-10-08T12:00:00Z",
  approved: true,
};
const studio: ContentStudio = {
  campaignId: "destination",
  revision: 1,
  brief: {
    offer: "Saved offer",
    audience: "Makers",
    objective: "Launch",
    durationSeconds: 15,
    platforms: [],
    references: [],
    sourceThreadId: ThreadId.make("destination-thread"),
  },
  assets: [asset],
  scenes: [],
  renders: [],
  generationLinks: [],
};
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
async function click(text: string) {
  const button = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === text,
  );
  if (!button) throw new Error(`Missing ${text}`);
  await act(async () => button.click());
}
async function drop(files: File[]) {
  const zone = container.querySelector('input[type="file"]')!.parentElement!;
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { files } });
  await act(async () => zone.dispatchEvent(event));
}

it("uploads browser File objects, rejects unsupported files, and prevents duplicate in-flight drops", async () => {
  let finish!: () => void;
  const onUploadFiles = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const run = vi.fn();
  await act(async () =>
    root.render(
      <CampaignStudioLibrary
        studio={studio}
        environmentId={environmentId}
        isAdministrator
        busy={false}
        canUseSaved
        act={run}
        onUploadFiles={onUploadFiles}
      />,
    ),
  );
  await drop([new File(["x"], "untrusted.exe", { type: "image/png" })]);
  expect(onUploadFiles).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Not uploaded: untrusted.exe");
  const file = new File(["bytes"], "clip.mp4");
  await drop([file]);
  await drop([file]);
  expect(onUploadFiles).toHaveBeenCalledTimes(1);
  expect(onUploadFiles.mock.calls[0]).toEqual([[file]]);
  expect(run).not.toHaveBeenCalled();
  await act(async () => finish());
  expect(container.textContent).toContain("Files added to the library.");
});

it("keeps audio playback in the original thread and excludes unapproved or stale campaign assets", async () => {
  const onReuseAsset = vi.fn(async () => true);
  await act(async () =>
    root.render(
      <CampaignStudioLibrary
        studio={studio}
        environmentId={environmentId}
        isAdministrator
        busy={false}
        canUseSaved
        act={vi.fn()}
        reuseCampaignId="source"
        reuseCampaigns={[
          { id: "source", name: "Source" },
          { id: "destination", name: "Destination" },
        ]}
        onReuseCampaignChange={vi.fn()}
        onReuseAsset={onReuseAsset}
        reusableAssets={[
          { campaignId: "source", campaignName: "Source", asset },
          {
            campaignId: "source",
            campaignName: "Source",
            asset: { ...asset, id: "unapproved", approved: false },
          },
          { campaignId: "stale", campaignName: "Stale", asset },
        ]}
      />,
    ),
  );
  expect(container.querySelector("audio")?.getAttribute("src")).toBe(
    "/signed/original-thread/voice.mp3",
  );
  expect(
    [...container.querySelectorAll("button")].filter(
      (item) => item.textContent === "Reuse in this campaign",
    ),
  ).toHaveLength(1);
  await click("Reuse in this campaign");
  expect(onReuseAsset).toHaveBeenCalledWith("source", "asset");
  expect(container.textContent).toContain(
    "Asset copied to this campaign. Review and approve the new copy.",
  );
});

it("previews templates before appending and preserves existing scenes", async () => {
  const onChange = vi.fn();
  const existing = {
    id: "existing",
    title: "Existing",
    durationSeconds: 5,
    prompt: "Keep this",
    narration: "",
    onScreenText: "",
    referenceImage: null,
    selectedAssetId: null,
    connector: "",
    model: "",
    resolution: "720p",
    allowanceUsd: null,
    generateAudio: false,
  };
  await act(async () =>
    root.render(
      <StudioStoryboardTemplates
        savedBrief={studio.brief}
        brandNotes="Warm tone"
        scenes={[existing]}
        onChange={onChange}
      />,
    ),
  );
  await click("Preview proposal");
  expect(onChange).not.toHaveBeenCalled();
  await click("Append to draft");
  const scenes = onChange.mock.calls[0]![0];
  expect(scenes[0]).toBe(existing);
  expect(scenes).toHaveLength(5);
  expect(scenes[1].prompt).toContain("Saved offer");
  expect(scenes[1].prompt).toContain("Warm tone");
  expect(container.textContent).toContain("Template scenes added to your editable draft.");
});

it("plays distinct variants side by side and changes the draft selection", async () => {
  const onSelect = vi.fn();
  const first = { ...asset, kind: "video" as const, id: "a", file: "a.mp4" };
  const second = { ...first, id: "b", file: "b.mp4" };
  await act(async () =>
    root.render(
      <StudioVariantComparison
        environmentId={environmentId}
        assets={[first, second]}
        selectedAssetId="a"
        onSelect={onSelect}
      />,
    ),
  );
  expect(
    [...container.querySelectorAll("video")].map((video) => video.getAttribute("src")),
  ).toEqual(["/signed/original-thread/a.mp4", "/signed/original-thread/b.mp4"]);
  await click("Use variant B");
  expect(onSelect).toHaveBeenCalledWith("b");
});
