import * as Schema from "effect/Schema";

import { ThreadId } from "./baseSchemas.ts";

/** Asks for a ghost-text reply to the thread's latest finished assistant turn. */
export const ReplySuggestionInput = Schema.Struct({ threadId: ThreadId });
export type ReplySuggestionInput = typeof ReplySuggestionInput.Type;

/** `reply` is null when the thread invites no obvious next message. */
export const ReplySuggestion = Schema.Struct({ reply: Schema.NullOr(Schema.String) });
export type ReplySuggestion = typeof ReplySuggestion.Type;

export class ReplySuggestionError extends Schema.TaggedError<ReplySuggestionError>()(
  "ReplySuggestionError",
  { cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return "Could not suggest a reply.";
  }
}
