import { assert, describe, it, vi } from "@effect/vitest";
import { ProjectId, ProviderInstanceId, TextGenerationError, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ReplySuggestion from "./ReplySuggestionService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const projectId = ProjectId.make("project:reply-suggestion");
const threadId = ThreadId.make("thread:reply-suggestion");
const textGenerationModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-sonnet-4-6",
} as const;

type Message = { role: "user" | "assistant"; text: string; streaming?: boolean };

function makeHarness(input: {
  readonly messages: ReadonlyArray<Message>;
  readonly projectExists?: boolean;
  readonly worktreePath?: string | null;
  readonly generate?: TextGeneration.TextGeneration["Service"]["generateReplySuggestion"];
}) {
  const generateReplySuggestion = vi.fn(
    input.generate ?? (() => Effect.succeed({ reply: "Yes, add the tests." })),
  );
  const getThreadRecords = vi.fn(() =>
    Effect.succeed({
      thread: { projectId, worktreePath: input.worktreePath ?? null },
      messages: input.messages.map((message) => ({ streaming: false, ...message })),
    }),
  );
  const layer = ReplySuggestion.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadRecords: getThreadRecords as never,
        }),
        Layer.mock(ProjectStore.ProjectStoreV2)({
          get: () =>
            Effect.succeed(
              input.projectExists === false
                ? Option.none()
                : Option.some({ projectId, workspaceRoot: "/repo" } as never),
            ),
        }),
        Layer.mock(TextGeneration.TextGeneration)({ generateReplySuggestion }),
        ServerSettings.layerTest({ textGenerationModelSelection }),
      ),
    ),
  );
  return { layer, generateReplySuggestion, getThreadRecords };
}

const suggest = Effect.gen(function* () {
  const service = yield* ReplySuggestion.ReplySuggestionService;
  return yield* service.suggest({ threadId });
});

describe("ReplySuggestionService", () => {
  it.effect(
    "asks the configured text-generation model with the last exchange from the project cwd",
    () => {
      const harness = makeHarness({
        messages: [
          { role: "user", text: "Add the toggle" },
          { role: "assistant", text: "Done. Should I add tests?" },
        ],
      });
      return Effect.gen(function* () {
        const result = yield* suggest;
        assert.deepEqual(result, { reply: "Yes, add the tests." });
        const call = harness.generateReplySuggestion.mock.calls[0]?.[0];
        assert.equal(call?.cwd, "/repo");
        assert.equal(call?.lastUserMessage, "Add the toggle");
        assert.equal(call?.assistantTail, "Done. Should I add tests?");
        // Settings may add default options to the selection; the model itself is the setting's.
        assert.equal(call?.modelSelection.instanceId, textGenerationModelSelection.instanceId);
        assert.equal(call?.modelSelection.model, textGenerationModelSelection.model);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("runs in the thread's worktree when it has one", () => {
    const harness = makeHarness({
      worktreePath: "/repo/.worktrees/a",
      messages: [
        { role: "user", text: "go" },
        { role: "assistant", text: "Which approach?" },
      ],
    });
    return Effect.gen(function* () {
      yield* suggest;
      assert.equal(harness.generateReplySuggestion.mock.calls[0]?.[0].cwd, "/repo/.worktrees/a");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("does not spend a model call when the thread has no finished assistant turn", () => {
    const harness = makeHarness({
      messages: [
        { role: "user", text: "go" },
        { role: "assistant", text: "partial", streaming: true },
      ],
    });
    return Effect.gen(function* () {
      assert.deepEqual(yield* suggest, { reply: null });
      assert.equal(harness.generateReplySuggestion.mock.calls.length, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("returns no suggestion when the project is gone", () => {
    const harness = makeHarness({
      projectExists: false,
      messages: [
        { role: "user", text: "go" },
        { role: "assistant", text: "Which one?" },
      ],
    });
    return Effect.gen(function* () {
      assert.deepEqual(yield* suggest, { reply: null });
      assert.equal(harness.generateReplySuggestion.mock.calls.length, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("passes a model's empty answer through as no suggestion", () => {
    const harness = makeHarness({
      generate: () => Effect.succeed({ reply: null }),
      messages: [
        { role: "user", text: "go" },
        { role: "assistant", text: "All done." },
      ],
    });
    return Effect.gen(function* () {
      assert.deepEqual(yield* suggest, { reply: null });
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("surfaces a text-generation failure as a typed error", () => {
    const harness = makeHarness({
      generate: () =>
        Effect.fail(new TextGenerationError({ operation: "generateReplySuggestion", detail: "x" })),
      messages: [
        { role: "user", text: "go" },
        { role: "assistant", text: "Which one?" },
      ],
    });
    return Effect.gen(function* () {
      const error = yield* Effect.flip(suggest);
      assert.equal(error._tag, "TextGenerationError");
    }).pipe(Effect.provide(harness.layer));
  });
});
