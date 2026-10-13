import type {
  ModelSelection,
  ServerSettings,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import * as Settings from "../serverSettings.ts";
import { qualificationBinding } from "./qualificationPolicy.ts";

type Input = {
  readonly attemptId: RunAttemptId;
  readonly runId: RunId;
  readonly threadId: ThreadId;
  readonly selection: ModelSelection;
};

// Passive provenance only. A cached provider snapshot is not a fresh authentication
// handshake, resolved-model receipt, tool-loop proof or permission to dispatch.
export class RunAttemptObserver extends Context.Reference<{
  readonly capture: (input: Input) => Effect.Effect<void>;
}>("t3/routing/RunAttemptObserver", {
  defaultValue: () => ({ capture: () => Effect.void }),
}) {}

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const configuration = (settings: ServerSettings, input: Input) => ({
  instance: settings.providerInstances[input.selection.instanceId] ?? null,
  providers: settings.providers,
});

export const observerLive = Layer.effect(
  RunAttemptObserver,
  Effect.gen(function* () {
    const providers = yield* ProviderRegistry.ProviderRegistry;
    const settings = yield* Settings.ServerSettingsService;
    const sql = yield* SqlClient.SqlClient;
    const capture = Effect.fn("RunAttemptObserver.capture")(function* (input: Input) {
      if (input.selection.model.length > 256 || (input.selection.options?.length ?? 0) > 16) return;
      const selection = encode({
        ...input.selection,
        options: [...(input.selection.options ?? [])].sort((a, b) => a.id.localeCompare(b.id)),
      });
      if (selection.length > 8192) return;
      const before = yield* settings.getSettings;
      const snapshots = yield* providers.getProviders;
      const after = yield* settings.getSettings;
      const now = yield* Clock.currentTimeMillis;
      const provider = snapshots.find((p) => p.instanceId === input.selection.instanceId);
      const age = now - Date.parse(provider?.checkedAt ?? "");
      const config = configuration(before, input);
      const changed = encode(config) !== encode(configuration(after, input));
      const fresh = Number.isFinite(age) && age >= 0 && age <= 300_000;
      const binding =
        provider && fresh && !changed
          ? qualificationBinding(provider, input.selection, config)
          : null;
      const state = changed
        ? "configuration_changed"
        : !fresh
          ? "snapshot_stale"
          : binding === null
            ? "identity_unverified"
            : "snapshot_only";
      // Never replace the first observation when an attempt is replayed. A changed
      // binding poisons that attempt instead of rewriting its historical identity.
      yield* sql`INSERT INTO workbench_run_observations
        (attempt_id,run_id,thread_id,instance_id,selection_json,observed_at,snapshot_checked_at,binding,state,conflicted)
        SELECT ${input.attemptId},${input.runId},${input.threadId},${input.selection.instanceId},${selection},${now},${provider?.checkedAt ?? null},${binding},${state},0
        WHERE (SELECT count(*) FROM workbench_run_observations) < 100000
          OR EXISTS (SELECT 1 FROM workbench_run_observations WHERE attempt_id=${input.attemptId})
        ON CONFLICT(attempt_id) DO UPDATE SET conflicted=CASE
          WHEN workbench_run_observations.run_id != excluded.run_id
            OR workbench_run_observations.thread_id != excluded.thread_id
            OR workbench_run_observations.selection_json != excluded.selection_json
            OR workbench_run_observations.binding IS NOT excluded.binding
            OR workbench_run_observations.state != excluded.state
          THEN 1 ELSE workbench_run_observations.conflicted END`;
    });
    return {
      capture: (input: Input) =>
        capture(input).pipe(
          Effect.timeout("1 second"),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.logWarning(
                  "Run provenance could not be recorded; automatic qualification remains unavailable",
                ),
          ),
        ),
    };
  }),
);
