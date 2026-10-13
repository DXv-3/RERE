import type { ModelSelection, RouteQualification } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import * as Settings from "../serverSettings.ts";
import * as Store from "./RouteQualificationStore.ts";
import { inspectQualification, qualificationBinding } from "./qualificationPolicy.ts";
export class RouteQualificationService extends Context.Service<
  RouteQualificationService,
  {
    readonly inspect: (selection: ModelSelection) => Effect.Effect<RouteQualification>;
  }
>()("t3/routing/RouteQualificationService") {}
const make = Effect.gen(function* () {
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const settings = yield* Settings.ServerSettingsService;
  const store = yield* Store.RouteQualificationStore;
  const inspect = Effect.fn("RouteQualificationService.inspect")(function* (
    selection: ModelSelection,
  ) {
    const now = yield* Clock.currentTimeMillis;
    return yield* Effect.gen(function* () {
      const snapshots = yield* providers.getProviders;
      const currentSettings = yield* settings.getSettings;
      const provider = snapshots.find((p) => p.instanceId === selection.instanceId);
      const configuration = {
        instance: currentSettings.providerInstances[selection.instanceId] ?? null,
        // Built-in providers can also use legacy settings. Include both, conservatively.
        providers: currentSettings.providers,
      };
      const binding = provider ? qualificationBinding(provider, selection, configuration) : null;
      return inspectQualification({
        providers: snapshots,
        selection,
        binding,
        stored: yield* store.read(selection),
        now,
      });
    }).pipe(
      Effect.catch(() =>
        Effect.succeed({
          instanceId: selection.instanceId,
          model: selection.model,
          state: "blocked" as const,
          reasons: ["storage_unavailable" as const],
          checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
          evidenceCheckedAt: null,
          contextTokens: null,
          billing: "unknown" as const,
          automaticExecution: false as const,
        }),
      ),
    );
  });
  return RouteQualificationService.of({ inspect });
});
export const layer = Layer.effect(RouteQualificationService, make);
