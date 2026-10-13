import {
  describeModelShareCodeError,
  parseModelShareCode,
} from "../components/settings/modelShareCode";

/**
 * The first screen of setup ("How do you want to start?") and its share-code path. Signing in and
 * "set up my own" simply leave the screen, so only the share-code path has state:
 *
 *   choice --openShare--> paste --submit--> adding --succeeded--> added
 *                           ^                  |
 *                           +------failed------+   (back from paste returns to choice)
 */
export type StartPhase = "choice" | "paste" | "adding" | "added";

export interface StartState {
  readonly phase: StartPhase;
  readonly code: string;
  /** Words for the person pasting; shown until the code changes. */
  readonly error: string | null;
  /** Names of the models the code added, once it has. */
  readonly addedModels: ReadonlyArray<string>;
}

export type StartEvent =
  | { readonly type: "openShare" }
  | { readonly type: "back" }
  | { readonly type: "edit"; readonly code: string }
  | { readonly type: "submit" }
  | { readonly type: "failed"; readonly message: string }
  | { readonly type: "succeeded"; readonly models: ReadonlyArray<string> };

export const INITIAL_START_STATE: StartState = {
  phase: "choice",
  code: "",
  error: null,
  addedModels: [],
};

/** What a pasted code names, for showing under the field before anything is saved. */
export function inspectShareCode(
  code: string,
): { readonly models: ReadonlyArray<string> } | { readonly error: string } | null {
  if (code.trim().length === 0) return null;
  const parsed = parseModelShareCode(code);
  return parsed.ok
    ? { models: parsed.access.models }
    : { error: describeModelShareCodeError(parsed.error) };
}

export function startReducer(state: StartState, event: StartEvent): StartState {
  switch (event.type) {
    case "openShare":
      return state.phase === "choice" ? { ...state, phase: "paste", error: null } : state;
    case "back":
      // The code holds an access token, so it is dropped on the way out.
      return state.phase === "paste" ? INITIAL_START_STATE : state;
    case "edit":
      return state.phase === "paste" ? { ...state, code: event.code, error: null } : state;
    case "submit": {
      if (state.phase !== "paste") return state;
      const inspected = inspectShareCode(state.code);
      if (inspected === null) return { ...state, error: describeModelShareCodeError("empty") };
      if ("error" in inspected) return { ...state, error: inspected.error };
      return { ...state, phase: "adding", error: null };
    }
    case "failed":
      return state.phase === "adding" ? { ...state, phase: "paste", error: event.message } : state;
    case "succeeded":
      // Added: the token has been saved on the server, so it no longer needs to sit here.
      return state.phase === "adding"
        ? { phase: "added", code: "", error: null, addedModels: event.models }
        : state;
  }
}
