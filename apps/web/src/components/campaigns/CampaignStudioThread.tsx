import { ComposerHandleContext, type ComposerHandleRef } from "../../composerHandleContext";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useComposerDraftStore } from "../../composerDraftStore";
import { Button } from "../ui/button";
import { studioAssistantPrompt } from "./studio.logic";
import { ThreadId, type EnvironmentId, type StudioBrief } from "@t3tools/contracts";
import { lazy, Suspense, useId, useRef } from "react";
import { useThreadShells } from "../../state/entities";
import { Label } from "../ui/label";
import { Spinner } from "../ui/spinner";

const ChatView = lazy(() => import("../ChatView"));

export function CampaignStudioThread({
  environmentId,
  campaignId,
  campaignName,
  savedBrief,
  sourceThreadId,
  linkedThreadId,
  onChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly campaignId: string;
  readonly campaignName: string;
  readonly savedBrief: StudioBrief;
  readonly sourceThreadId: ThreadId | null;
  readonly linkedThreadId: ThreadId | null;
  readonly onChange: (id: ThreadId | null) => void;
}) {
  const id = useId();
  // The hidden route chat keeps its own handle; mounting Studio must not replace it.
  const composerRef: ComposerHandleRef = useRef(null);
  const threads = useThreadShells().filter(
    (thread) => thread.environmentId === environmentId && !thread.archivedAt,
  );
  const addRequest = (revise: boolean) => {
    if (!linkedThreadId) return;
    const target = scopeThreadRef(environmentId, linkedThreadId);
    const store = useComposerDraftStore.getState();
    const current = store.getComposerDraft(target)?.prompt ?? "";
    const context = studioAssistantPrompt(campaignId, campaignName, savedBrief, revise);
    store.setPrompt(
      target,
      current.includes(context) ? current : [current, context].filter(Boolean).join("\n\n"),
    );
  };
  return (
    <aside
      aria-label="Campaign AI"
      className="min-w-0 space-y-3 rounded-lg border border-border p-3"
    >
      <h3 className="text-sm font-semibold">Campaign AI · {campaignName}</h3>
      <p className="break-all text-xs text-muted-foreground">Campaign ID: {campaignId}</p>
      <div className="space-y-1">
        <Label htmlFor={id}>Linked workspace conversation</Label>
        <select
          id={id}
          className="w-full rounded-md border border-input bg-background p-2 text-sm"
          value={sourceThreadId ?? ""}
          onChange={(event) =>
            onChange(event.currentTarget.value ? ThreadId.make(event.currentTarget.value) : null)
          }
        >
          <option value="">Choose an existing conversation</option>
          {sourceThreadId && !threads.some((thread) => thread.id === sourceThreadId) && (
            <option value={sourceThreadId}>Linked conversation</option>
          )}
          {threads.map((thread) => (
            <option key={thread.id} value={thread.id}>
              {thread.title || "Untitled conversation"}
            </option>
          ))}
        </select>
      </div>
      <p className="text-xs text-muted-foreground">
        Save the brief to link this conversation. Ask the agent to read this campaign’s Studio,
        suggest a storyboard and models, or revise a scene. Generation costs wait for your review.
      </p>
      {linkedThreadId && (
        <Button size="sm" variant="outline" onClick={() => addRequest(false)}>
          Draft storyboard with AI
        </Button>
      )}
      {linkedThreadId && (
        <Button size="sm" variant="outline" onClick={() => addRequest(true)}>
          Revise storyboard with AI
        </Button>
      )}
      {linkedThreadId ? (
        <div className="relative flex h-[650px] min-h-0 flex-col overflow-hidden rounded-md border border-border">
          <Suspense
            fallback={
              <p role="status" className="flex items-center gap-2 p-3 text-sm">
                <Spinner size="sm" />
                Loading conversation…
              </p>
            }
          >
            <ComposerHandleContext value={composerRef}>
              <ChatView
                key={linkedThreadId}
                environmentId={environmentId}
                threadId={linkedThreadId}
                routeKind="server"
                reserveTitleBarControlInset={false}
              />
            </ComposerHandleContext>
          </Suspense>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Choose a conversation above, or create one with New Chat, then save the brief.
        </p>
      )}
    </aside>
  );
}
