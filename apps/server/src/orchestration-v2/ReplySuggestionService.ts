import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  type ReplySuggestion,
  type ServerSettingsError,
  type TextGenerationError,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSettings from "../serverSettings.ts";
import { selectReplySuggestionContext } from "../textGeneration/ReplySuggestionContext.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import type { OrchestratorV2Error } from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

/**
 * Predicts the user's next message after an assistant turn, for the composer's ghost text.
 * It only ever returns text for the client to show; nothing here sends anything.
 */
export class ReplySuggestionService extends Context.Service<
  ReplySuggestionService,
  {
    readonly suggest: (input: {
      readonly threadId: ThreadId;
    }) => Effect.Effect<
      ReplySuggestion,
      | OrchestratorV2Error
      | ProjectStore.ProjectStoreV2Error
      | ServerSettingsError
      | TextGenerationError
    >;
  }
>()("t3/orchestration-v2/ReplySuggestionService") {}

const NO_SUGGESTION: ReplySuggestion = { reply: null };

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;

  const suggest: ReplySuggestionService["Service"]["suggest"] = Effect.fn(
    "ReplySuggestionService.suggest",
  )(function* (input) {
    const projection = yield* threads.getThreadRecords(input.threadId, ["messages"], {
      messageRoles: ["user", "assistant"],
    });
    const context = selectReplySuggestionContext(projection.messages);
    if (context === null) return NO_SUGGESTION;

    const project = yield* projects.get(projection.thread.projectId);
    if (Option.isNone(project)) return NO_SUGGESTION;

    const settings = resolveProjectSettings(
      yield* serverSettings.getSettings,
      projection.thread.projectId,
    ).settings;
    return yield* textGeneration.generateReplySuggestion({
      cwd: projection.thread.worktreePath ?? project.value.workspaceRoot,
      ...context,
      modelSelection: settings.textGenerationModelSelection,
    });
  });

  return ReplySuggestionService.of({ suggest });
});

export const layer = Layer.effect(ReplySuggestionService, make);
