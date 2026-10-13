import { useSyncExternalStore } from "react";

export type AccountPageId = "t3-connect" | "mobile-clients";

interface AccountDialogState {
  readonly open: boolean;
  readonly page: AccountPageId;
}

let state: AccountDialogState = { open: false, page: "t3-connect" };
const listeners = new Set<() => void>();

function setState(next: AccountDialogState) {
  state = next;
  for (const listener of listeners) listener();
}

/** Opens the account dialog from anywhere; it is mounted by the account session provider. */
export function openAccountDialog(page: AccountPageId = "t3-connect") {
  setState({ open: true, page });
}

export function closeAccountDialog() {
  setState({ ...state, open: false });
}

export function selectAccountDialogPage(page: AccountPageId) {
  setState({ ...state, page });
}

export function useAccountDialogState(): AccountDialogState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}
