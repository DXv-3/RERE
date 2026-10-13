import { CommandId, MessageId, type ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

/**
 * Puts a message into the thread of the agent that made a post: what a person asked to change,
 * or what went out. Best effort by design. The post's own record is the truth, so a thread that
 * is gone or archived is a warning in the log and never fails the action that caused the message.
 */
export class CampaignThreadNotifier extends Context.Service<
  CampaignThreadNotifier,
  {
    /**
     * Queues `text` in the thread under an id derived from `key`, so telling the same thing twice
     * delivers it once.
     */
    readonly tell: (input: {
      readonly threadId: ThreadId;
      readonly key: string;
      readonly text: string;
    }) => Effect.Effect<void>;
  }
>()("t3/campaigns/CampaignThreadNotifier") {}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;

  const tell: CampaignThreadNotifier["Service"]["tell"] = (input) =>
    Effect.gen(function* () {
      const shell = yield* threads.getThreadShell(input.threadId);
      if (shell === null || shell.archivedAt !== null) return;
      yield* threads.sendToThread({
        projectId: shell.projectId,
        commandId: CommandId.make(`campaign:${input.key}`),
        threadId: input.threadId,
        messageId: MessageId.make(`campaign-message:${input.key}`),
        text: input.text,
        attachments: [],
        mode: "queue",
        createdBy: "user",
        creationSource: "server",
      });
    }).pipe(
      Effect.orDie,
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("could not tell an agent about its campaign post", {
              threadId: input.threadId,
              cause: Cause.pretty(cause),
            }),
      ),
    );

  return CampaignThreadNotifier.of({ tell });
});

export const layer = Layer.effect(CampaignThreadNotifier, make);
