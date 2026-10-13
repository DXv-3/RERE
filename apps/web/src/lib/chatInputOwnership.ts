const CHAT_ROOT = "[data-wb-chat]";

function isAvailable(root: HTMLElement): boolean {
  return (
    root.isConnected &&
    root.closest("[hidden], [inert]") === null &&
    (typeof root.checkVisibility !== "function" ||
      root.checkVisibility({ visibilityProperty: true }))
  );
}

/** Hidden route views stay mounted behind Studio. Only the event's visible chat may consume
 * global input; body/portal events fall back to the focused chat, then the sole visible chat.
 */
export function chatGlobalInputOwner(
  target: EventTarget | null = document.activeElement,
): HTMLElement | null {
  const targetRoot = target instanceof Element ? target.closest<HTMLElement>(CHAT_ROOT) : null;
  if (targetRoot) return isAvailable(targetRoot) ? targetRoot : null;
  const focusedRoot = document.activeElement?.closest<HTMLElement>(CHAT_ROOT);
  if (focusedRoot && isAvailable(focusedRoot)) return focusedRoot;
  const visible = [...document.querySelectorAll<HTMLElement>(CHAT_ROOT)].filter(isAvailable);
  return visible.length === 1 ? visible[0]! : null;
}

export function ownsChatGlobalInput(
  element: HTMLElement | null,
  target: EventTarget | null = document.activeElement,
): boolean {
  const root = element?.closest<HTMLElement>(CHAT_ROOT);
  return root != null && isAvailable(root) && chatGlobalInputOwner(target) === root;
}

/** Route-global actions retain their empty-screen behavior, but may not act on a hidden thread. */
export function routeOwnsChatGlobalInput(
  thread: { readonly environmentId: string; readonly threadId: string } | null,
  target: EventTarget | null,
): boolean {
  const owner = chatGlobalInputOwner(target);
  if (!owner) return document.querySelector(CHAT_ROOT) === null;
  return (
    thread !== null &&
    owner.dataset.chatEnvironmentId === thread.environmentId &&
    owner.dataset.chatThreadId === thread.threadId
  );
}
