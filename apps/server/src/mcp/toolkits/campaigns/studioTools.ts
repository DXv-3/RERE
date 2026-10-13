import { CampaignError, ContentStudio, StudioCommand } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";
import * as StudioService from "../../../campaigns/studio/StudioService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
const dependencies = [McpInvocationContext.McpInvocationContext, StudioService.StudioService];
export const StudioToolkit = Toolkit.make(
  Tool.make("campaign_studio_read", {
    description:
      "Read a campaign's shared Content Studio brief, storyboard scenes, media variants, render revisions and generation job links. Use campaign_list for campaign IDs. Always read revision before editing; the visual workspace shows these same records.",
    parameters: Schema.Struct({ campaignId: Schema.String }),
    success: ContentStudio,
    failure: CampaignError,
    dependencies,
  }),
  Tool.make("campaign_studio_edit", {
    description:
      "Edit the shared Content Studio through its saved commands. studio.save replaces brief/scenes with expectedRevision from read (preserve IDs and unrelated scenes); studio.import adds workspace media; studio.generate requests scene generation but ALWAYS waits for person approval; studio.render assembles selected variants without publishing. Use scene onScreenText/captions for readable text overlays, not generation prompts. You cannot approve spend, assets, renders, narration, or publication. Link only your own thread. Return to the user for approval after preparing work.",
    parameters: Schema.Struct({ action: StudioCommand }),
    success: ContentStudio,
    failure: CampaignError,
    dependencies,
  }),
);
const guard = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  if (!scope.capabilities.has("campaigns"))
    return yield* new CampaignError({
      reason: "not_allowed",
      message: "Campaign tools are disabled for this conversation.",
    });
  return scope;
});
export const StudioToolkitHandlersLive = StudioToolkit.toLayer({
  campaign_studio_read: (input) =>
    Effect.gen(function* () {
      yield* guard;
      const service = yield* StudioService.StudioService;
      return yield* service.get(input.campaignId);
    }),
  campaign_studio_edit: (input) =>
    Effect.gen(function* () {
      const scope = yield* guard;
      const service = yield* StudioService.StudioService;
      const result = yield* service.run({ kind: "agent", threadId: scope.threadId }, input.action);
      if (result.kind !== "studio")
        return yield* new CampaignError({
          reason: "not_allowed",
          message: "This operation requires a person.",
        });
      return result.studio;
    }),
});
