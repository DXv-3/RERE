import type { ServerSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

/**
 * Whether a provider session should start with its own skill list hidden. Skills are only
 * attached per message while Auto is on; without it, hiding the list would leave the
 * session with no skills at all. Every provider asks this one question.
 */
export const hidesSkillListing = (
  settings: Pick<ServerSettings, "skillListing" | "routingMode">,
): boolean => settings.skillListing === "selected" && settings.routingMode === "automatic";

/** The same rule read from the settings service at the moment a session opens. */
export const hideSkillListingNow = <E>(settings: {
  readonly getSettings: Effect.Effect<Pick<ServerSettings, "skillListing" | "routingMode">, E>;
}): Effect.Effect<boolean> =>
  settings.getSettings.pipe(
    Effect.map(hidesSkillListing),
    Effect.orElseSucceed(() => false),
  );
