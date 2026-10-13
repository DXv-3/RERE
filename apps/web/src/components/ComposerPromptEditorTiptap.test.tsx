// @vitest-environment jsdom
import { act, Activity, createRef, Suspense, use } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  ComposerPromptEditorTiptap,
  type ComposerPromptEditorHandle,
} from "./ComposerPromptEditorTiptap";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("preserves the controlled draft when linked chat suspends before mounting", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const editorRef = createRef<ComposerPromptEditorHandle>();
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  function PendingChat() {
    use(ready);
    return null;
  }
  const render = (value: string) => (
    <Suspense fallback={<p>Loading linked chat</p>}>
      <ComposerPromptEditorTiptap
        value={value}
        cursor={value.length}
        contextRecords={new Map()}
        skills={[]}
        disabled={false}
        placeholder="Draft"
        onChange={vi.fn()}
        onPaste={vi.fn()}
        editorRef={editorRef}
      />
      <PendingChat />
    </Suspense>
  );
  try {
    await act(async () => root.render(render("Saved storyboard request")));
    expect(container.textContent).toBe("Loading linked chat");
    // Tiptap disposes editors constructed during an abandoned render after one tick.
    await act(async () => vi.advanceTimersByTimeAsync(10));
    await act(async () => {
      release();
      await ready;
    });
    expect(container.querySelector('[data-testid="composer-editor"]')?.textContent).toBe(
      "Saved storyboard request",
    );
    expect(editorRef.current?.readSnapshot().value).toBe("Saved storyboard request");
    await act(async () =>
      root.render(<Activity mode="hidden">{render("Saved storyboard request")}</Activity>),
    );
    await act(async () => vi.advanceTimersByTimeAsync(10));
    await act(async () =>
      root.render(<Activity mode="visible">{render("Revised storyboard request")}</Activity>),
    );
    expect(editorRef.current?.readSnapshot().value).toBe("Revised storyboard request");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
