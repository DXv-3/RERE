// @vitest-environment jsdom
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act, useImperativeHandle } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import {
  ComposerHandleContext,
  useComposerHandleContext,
  type ComposerHandleRef,
} from "../../composerHandleContext";
import type { ChatComposerHandle } from "../chat/ChatComposer";

vi.mock("../../state/entities", () => ({ useThreadShells: () => [] }));
vi.mock("../../composerDraftStore", () => ({
  useComposerDraftStore: { getState: () => ({ getComposerDraft: () => null, setPrompt: vi.fn() }) },
}));
vi.mock("../ChatView", () => ({
  default: function ChatHandleProbe() {
    const ref = useComposerHandleContext();
    useImperativeHandle(
      ref,
      () => ({ focusAtEnd: () => undefined }) as unknown as ChatComposerHandle,
    );
    return <p>Linked chat mounted</p>;
  },
}));
import { CampaignStudioThread } from "./CampaignStudioThread";

it("mounts and unmounts the Studio composer without replacing the hidden route's handle", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const original = { focusAtEnd: vi.fn() } as unknown as ChatComposerHandle;
  const routeRef: ComposerHandleRef = { current: original };
  try {
    await act(async () =>
      root.render(
        <ComposerHandleContext value={routeRef}>
          <CampaignStudioThread
            environmentId={EnvironmentId.make("env")}
            campaignId="campaign"
            campaignName="Launch"
            savedBrief={{
              offer: "",
              audience: "",
              objective: "",
              durationSeconds: 15,
              references: [],
              platforms: [],
              sourceThreadId: ThreadId.make("linked"),
            }}
            sourceThreadId={ThreadId.make("linked")}
            linkedThreadId={ThreadId.make("linked")}
            onChange={vi.fn()}
          />
        </ComposerHandleContext>,
      ),
    );
    expect(container.textContent).toContain("Linked chat mounted");
    expect(routeRef.current).toBe(original);
    await act(async () => root.render(null));
    expect(routeRef.current).toBe(original);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
