// @vitest-environment jsdom
import {
  EnvironmentId,
  ThreadId,
  type CampaignGenerationBoard,
  type CampaignGenerationJob,
} from "@t3tools/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import type { CampaignRun } from "./useCampaigns";

vi.mock("../../state/entities", () => ({ useThreadShells: () => [] }));
vi.mock("./FirstFramePicker", () => ({ FirstFramePicker: () => <p>Reference image picker</p> }));
import { CampaignGenerateDialog } from "./CampaignGenerateDialog";

afterEach(() => vi.unstubAllGlobals());

it("requires a positive allowance and submits a MuAPI image-to-video request without unsupported audio", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const now = "2026-10-08T12:00:00Z";
  const image: CampaignGenerationJob = {
    id: "image-job",
    clientId: "client",
    campaignId: "campaign",
    kind: "image",
    connector: "muapi",
    model: "flux-dev",
    prompt: "Product",
    options: {},
    status: "done",
    estimatedUsd: null,
    estimateNote: "Unknown",
    resultPaths: ["product.png"],
    requestedBy: { kind: "person" },
    sourceThreadId: ThreadId.make("thread"),
    createdAt: now,
    updatedAt: now,
  };
  const generation: CampaignGenerationBoard = {
    jobs: [],
    spend: [],
    settings: {
      imageGenerator: "muapi",
      videoGenerator: "muapi",
      hasMuapiKey: true,
      hasFalKey: false,
      hasOpenRouterKey: false,
      localBaseUrl: "",
      models: { image: "flux-dev", video: "veo3.1-image-to-video", local: "" },
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
  const run = vi
    .fn<CampaignRun>()
    .mockResolvedValue({ ok: true, value: { kind: "generationJob", job: image } });
  const onClose = vi.fn();
  const fill = async (label: string, value: string) => {
    const labelNode = [...document.querySelectorAll("label")].find(
      (node) => node.textContent === label,
    )!;
    const element = document.getElementById(labelNode.htmlFor)!;
    const prototype =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    await act(async () => {
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  try {
    await act(async () =>
      root.render(
        <CampaignGenerateDialog
          open
          environmentId={EnvironmentId.make("env")}
          generation={generation}
          campaign={{
            id: "campaign",
            clientId: "client",
            name: "Launch",
            createdAt: now,
            updatedAt: now,
          }}
          client={{
            id: "client",
            name: "Brand",
            brandNotes: "",
            doNotSay: [],
            approvalMode: "ask-first",
            createdAt: now,
            updatedAt: now,
          }}
          preferredThreadId="thread"
          startFrom={image}
          run={run}
          onClose={onClose}
        />,
      ),
    );
    const submit = () =>
      [...document.querySelectorAll("button")].find(
        (node) => node.textContent === "Approve Allowance And Generate",
      )!;
    await fill("Describe It", "Reveal the product");
    expect(submit().disabled).toBe(true);
    await fill("Unknown-price allowance (USD)", "0");
    expect(submit().disabled).toBe(true);
    await fill("Unknown-price allowance (USD)", "2");
    expect(submit().disabled).toBe(false);
    await act(async () => submit().click());
    expect(run).toHaveBeenCalledTimes(1);
    const command = run.mock.calls[0]?.[0];
    expect(command).toMatchObject({
      command: "generation.start",
      allowanceUsd: 2,
      options: { durationSeconds: 8, firstFrameJobId: "image-job" },
    });
    if (command?.command !== "generation.start") throw new Error("Wrong command");
    expect(command.options).not.toHaveProperty("generateAudio");
    expect(command.requestKey).toBeTruthy();
    expect(onClose).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
