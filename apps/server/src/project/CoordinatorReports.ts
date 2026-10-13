import type { MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as AgentReplies from "../agents/AgentReplies.ts";
import * as ProjectService from "./ProjectService.ts";

/**
 * When the caller is its project's coordinator, has the result of the run that handles
 * `sourceMessageId` carried back to it. That is how a coordinator hears that a thread it started
 * or messaged has finished: the same durable delivery `agent_send` uses for agent replies. A
 * no-op for every other caller, and it never fails the send it follows. True when a report is due.
 */
export const expectCoordinatorReport = Effect.fn("expectCoordinatorReport")(function* (input: {
  readonly callerThreadId: ThreadId;
  readonly callerProjectId: ProjectId;
  readonly sourceMessageId: MessageId;
  readonly recipientThreadId: ThreadId;
  readonly recipientName: string;
}) {
  const projects = yield* Effect.serviceOption(ProjectService.ProjectService);
  if (Option.isNone(projects)) return false;
  const project = yield* projects.value
    .getById(input.callerProjectId)
    .pipe(Effect.catchCause(() => Effect.succeed(Option.none())));
  if (Option.isNone(project) || project.value.coordinatorThreadId !== input.callerThreadId) {
    return false;
  }
  const replies = yield* Effect.serviceOption(AgentReplies.AgentReplies);
  if (Option.isNone(replies)) {
    yield* Effect.logWarning("a coordinator's thread will not report back: no reply service", {
      coordinatorThreadId: input.callerThreadId,
      recipientThreadId: input.recipientThreadId,
    });
    return false;
  }
  const expected = yield* replies.value.request({
    sourceMessageId: input.sourceMessageId,
    recipientThreadId: input.recipientThreadId,
    recipientName: input.recipientName,
    askerThreadId: input.callerThreadId,
    hops: 1,
  });
  // A run that settled before the row was written has already sent its event.
  if (expected) yield* replies.value.settleRecipient(input.recipientThreadId);
  return expected;
});
