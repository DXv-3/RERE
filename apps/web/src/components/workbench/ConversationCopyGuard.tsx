import { decideCopySend } from "@t3tools/client-runtime/operations/agent-conversation-sync";
import { ThreadId, type EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { CopyIcon } from "lucide-react";
import { useCallback, useMemo, useState, type ReactNode } from "react";

import { buildThreadRouteParams } from "../../threadRoutes";
import type { ComposerBannerStackItem } from "../chat/ComposerBannerStack";
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { useConversationCopy } from "./useAgentSync";
import { sessionKey, useWorkbenchPreferences } from "./workbenchPreferences";
import { useWorkbenchStore } from "./workbenchStore";

/** Conversations where the user already chose "Send Here Anyway" this session. */
const confirmedCopies = new Set<string>();

export interface ConversationCopyGuard {
  /** Null unless the open thread is the copy side of an agent's conversation. */
  readonly copy: ReturnType<typeof useConversationCopy>;
  readonly bannerItem: ComposerBannerStackItem | null;
  /** True when a message typed now must wait for the user's answer. Reads live state. */
  readonly needsConfirmation: () => boolean;
  readonly dialogOpen: boolean;
  readonly setDialogOpen: (open: boolean) => void;
  readonly openLive: () => void;
  /** Remembers the choice for this conversation. */
  readonly confirmSendHere: () => void;
}

/** Everything the chat view needs to keep a user from typing into an agent's copy by accident. */
export function useConversationCopyGuard(
  environmentId: EnvironmentId | null | undefined,
  threadId: string | null | undefined,
): ConversationCopyGuard {
  const copy = useConversationCopy(environmentId, threadId);
  const navigate = useNavigate();
  const [dialogOpen, setDialogOpen] = useState(false);
  const key = environmentId && threadId ? sessionKey(environmentId, threadId) : null;

  const openLive = useCallback(() => {
    if (!copy) return;
    setDialogOpen(false);
    useWorkbenchPreferences
      .getState()
      .assign(sessionKey(copy.live.environmentId, copy.live.threadId), copy.agentId);
    useWorkbenchStore.getState().setAgentView("conversation");
    useWorkbenchStore.getState().setMode("agent");
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams({
        environmentId: copy.live.environmentId,
        threadId: ThreadId.make(copy.live.threadId),
      }),
    });
  }, [copy, navigate]);

  const needsConfirmation = useCallback(
    () =>
      decideCopySend({
        isCopy: copy !== null,
        liveReachable: copy?.liveReachable ?? false,
        confirmed: key !== null && confirmedCopies.has(key),
      }) === "confirm",
    [copy, key],
  );

  const confirmSendHere = useCallback(() => {
    if (key !== null) confirmedCopies.add(key);
    setDialogOpen(false);
  }, [key]);

  const bannerItem = useMemo<ComposerBannerStackItem | null>(() => {
    if (!copy) return null;
    return {
      id: `agent-copy:${threadId}`,
      variant: "info",
      priority: "urgent",
      icon: <CopyIcon />,
      title: "This Is A Copy",
      description: `The live conversation is on ${copy.liveLabel}. Messages sent here run on this machine instead.`,
      actions: (
        <Button size="xs" variant="outline" onClick={openLive}>
          Open The Live Conversation
        </Button>
      ),
    };
  }, [copy, openLive, threadId]);

  return {
    copy,
    bannerItem,
    needsConfirmation,
    dialogOpen,
    setDialogOpen,
    openLive,
    confirmSendHere,
  };
}

/** Asks before the first message typed into a copy, since sending makes the copy the live one. */
export function ConversationCopySendDialog({
  guard,
  onSendHere,
}: {
  guard: ConversationCopyGuard;
  onSendHere: () => void;
}): ReactNode {
  return (
    <AlertDialog open={guard.dialogOpen} onOpenChange={guard.setDialogOpen}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Send To A Copy?</AlertDialogTitle>
          <AlertDialogDescription>
            This conversation is a copy. The live one is on{" "}
            {guard.copy?.liveLabel ?? "another machine"}, where the agent has the full history. A
            message sent here runs on this machine instead, and this copy then replaces the live
            conversation.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button variant="outline" onClick={onSendHere}>
            Send Here Anyway
          </Button>
          <Button variant="default" onClick={guard.openLive}>
            Open The Live Conversation
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
