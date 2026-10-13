import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { create } from "zustand";

/**
 * Which secret requests the owner closed the prompt on without answering. Only request ids live
 * here alongside the mounted conversation host, and only for this page load: a request stays waiting on the server, and the agent's
 * Secrets list offers to answer it again. No value is ever kept in a store.
 */
interface SecretPromptState {
  readonly host: {
    environmentId: EnvironmentId;
    threadId: ThreadId;
    element: HTMLDivElement;
  } | null;
  readonly setHost: (host: NonNullable<SecretPromptState["host"]>) => void;
  readonly clearHost: (element: HTMLDivElement) => void;
  readonly dismissed: ReadonlySet<string>;
  readonly dismiss: (key: string) => void;
  readonly reopen: (keys: ReadonlyArray<string>) => void;
}

export const secretRequestKey = (environmentId: string, requestId: string) =>
  `${environmentId}:${requestId}`;

export const useSecretPromptStore = create<SecretPromptState>((set) => ({
  host: null,
  setHost: (host) => set({ host }),
  clearHost: (element) =>
    set((state) => (state.host?.element === element ? { host: null } : state)),
  dismissed: new Set(),
  dismiss: (key) => set((state) => ({ dismissed: new Set([...state.dismissed, key]) })),
  reopen: (keys) =>
    set((state) => ({
      dismissed: new Set([...state.dismissed].filter((key) => !keys.includes(key))),
    })),
}));

interface WaitingSecretRequest {
  readonly environmentId: string;
  readonly request: { readonly id: string; readonly threadId: string };
}

/**
 * Which waiting request to show, and where. With a conversation on screen the request is answered
 * there, in place, whichever agent asked: a teammate working for the conversation in view asks from
 * its own thread, and covering the window for it interrupts more than the question deserves. The
 * conversation's own request goes first. The dialog is only for views with no conversation.
 */
export function pickSecretRequest<Entry extends WaitingSecretRequest>(
  open: ReadonlyArray<Entry>,
  host: { readonly environmentId: string; readonly threadId: string } | null,
): { readonly current: Entry; readonly inline: boolean; readonly elsewhere: boolean } | null {
  const own = open.find(
    (entry) =>
      entry.environmentId === host?.environmentId && entry.request.threadId === host.threadId,
  );
  const current = own ?? open[0];
  if (current === undefined) return null;
  return { current, inline: host !== null, elsewhere: host !== null && own === undefined };
}
