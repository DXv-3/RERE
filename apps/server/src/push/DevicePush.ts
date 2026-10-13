import {
  DevicePushError,
  DevicePushRegistration,
  type DevicePushStatus,
  type DevicePushUnregisterInput,
  type EnvironmentId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  type Project,
  type ThreadId,
} from "@t3tools/contracts";
import type {
  RelayAgentActivityState,
  RelayAgentAwarenessPhase,
  RelayAgentAwarenessPreferences,
} from "@t3tools/contracts/relay";
import { projectThreadAwarenessV2 } from "@t3tools/shared/agentAwareness";
import { countThreadsNeedingYou } from "@t3tools/shared/threadBadge";
import { decideThreadNotification } from "@t3tools/shared/threadNotificationPolicy";
import {
  assistantTextFromLatestMessage,
  notificationSubtitle,
} from "@t3tools/shared/threadNotificationText";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import {
  makeAgentAwarenessPublishWorker,
  shouldPublishAgentAwarenessEvent,
} from "../relay/AgentAwarenessRelay.ts";
import { forkParked } from "../serverActivation.ts";
import {
  isDeadApnsToken,
  makeApnsProviderToken,
  sendApnsAlert,
  type ApnsCredentials,
} from "./apns.ts";

/**
 * Sends agent notifications from this environment straight to the phones
 * registered with it. It is the pairing-only counterpart of the hosted relay:
 * no account, no relay link, and each environment notifies on its own.
 */
export class DevicePush extends Context.Service<
  DevicePush,
  {
    readonly status: Effect.Effect<DevicePushStatus>;
    readonly register: (input: DevicePushRegistration) => Effect.Effect<void, DevicePushError>;
    readonly unregister: (input: DevicePushUnregisterInput) => Effect.Effect<void, DevicePushError>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/push/DevicePush") {}

const ApnsEnvConfig = Config.all({
  teamId: Config.String("CODEWRENCH_APNS_TEAM_ID"),
  keyId: Config.String("CODEWRENCH_APNS_KEY_ID"),
  keyFile: Config.String("CODEWRENCH_APNS_KEY_FILE"),
}).pipe(Config.option);

// APNs rejects provider tokens older than an hour and throttles ones minted too often.
const PROVIDER_TOKEN_LIFETIME_MS = 45 * 60 * 1_000;
const MAX_TEXT_LENGTH = 120;

const decodeDevice = Schema.decodeUnknownEffect(Schema.fromJsonString(DevicePushRegistration));
const encodeDevice = Schema.encodeSync(Schema.fromJsonString(DevicePushRegistration));
const storageFailure = () => new DevicePushError({ reason: "storage" });

const isAttentionPhase = (phase: RelayAgentAwarenessPhase) =>
  phase === "waiting_for_approval" || phase === "waiting_for_input";
const isTerminalPhase = (phase: RelayAgentAwarenessPhase) =>
  phase === "completed" || phase === "failed";

/**
 * Whether a thread moving from `previous` to `next` should buzz a phone. A
 * thread seen for the first time is a replay of old state, never a transition.
 */
export function shouldNotifyPhaseChange(
  previous: RelayAgentAwarenessPhase | undefined,
  next: RelayAgentAwarenessPhase,
): boolean {
  if (previous === undefined || previous === next) return false;
  if (isAttentionPhase(next)) return true;
  return isTerminalPhase(next) && !isTerminalPhase(previous);
}

/**
 * Whether this device wants the event: its per-event switches first, then the
 * shared policy, so a short finished run stays silent below `minRunSeconds`
 * (60 when an older phone build does not send one). An unknown run length
 * counts as long.
 */
export function notificationAllowed(
  preferences: RelayAgentAwarenessPreferences,
  phase: RelayAgentAwarenessPhase,
  runDurationSeconds: number | null = null,
): boolean {
  if (!preferences.notificationsEnabled) return false;
  switch (phase) {
    case "waiting_for_approval":
      if (!preferences.notifyOnApproval) return false;
      break;
    case "waiting_for_input":
      if (!preferences.notifyOnInput) return false;
      break;
    case "completed":
      if (!preferences.notifyOnCompletion) return false;
      break;
    case "failed":
      if (!preferences.notifyOnFailure) return false;
      break;
    default:
      return false;
  }
  return decideThreadNotification({
    kind: phase,
    runDurationSeconds,
    ...(preferences.minRunSeconds === undefined
      ? {}
      : { minRunSeconds: preferences.minRunSeconds }),
  }).notify;
}

const truncate = (value: string) =>
  value.length <= MAX_TEXT_LENGTH ? value : `${value.slice(0, MAX_TEXT_LENGTH - 3).trimEnd()}...`;

/**
 * The APNs body for one thread's state: the thread title, a subtitle naming
 * what happened (and the project when it adds anything), and the agent's own
 * words as the body. expo-notifications on iOS hands the app only the
 * top-level `body` object as notification data, so the keys a tap needs to open
 * the thread go there.
 */
export function apnsPayloadForState(state: RelayAgentActivityState, badge?: number) {
  return {
    aps: {
      // The app icon's number: every thread that needs the person, not just this one.
      ...(badge === undefined ? {} : { badge }),
      alert: {
        title: truncate(state.threadTitle),
        subtitle: truncate(
          notificationSubtitle(state.headline, state.projectTitle, state.threadTitle),
        ),
        body: truncate(state.detail ?? state.headline),
      },
      sound: "default",
      // Notification Center stacks alerts by thread.
      "thread-id": `${state.environmentId}/${state.threadId}`,
    },
    body: {
      environmentId: state.environmentId,
      threadId: state.threadId,
      deepLink: state.deepLink,
    },
  };
}

const epochMillisOrNull = (value: DateTime.Utc | null | undefined) =>
  value == null ? null : DateTime.toEpochMillis(value);

/** How many of the server's threads need the person, counted as the phone counts them. */
export function badgeCountForShells(
  shells: ReadonlyArray<OrchestrationV2ThreadShell>,
  nowMs: number,
): number {
  return countThreadsNeedingYou(
    shells.map((shell) => ({
      archived: shell.archivedAt !== null,
      subagent: shell.lineage.relationshipToParent === "subagent",
      putAway:
        shell.settledOverride === "settled" ||
        (shell.snoozedUntil != null && DateTime.toEpochMillis(shell.snoozedUntil) > nowMs),
      waitingOnYou: shell.pendingRuntimeRequest !== null,
      failed: shell.status === "failed",
      completedAtMs: epochMillisOrNull(shell.latestRunCompletedAt),
      lastVisitedAtMs: epochMillisOrNull(shell.lastVisitedAt),
    })),
  );
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const managedFolders = yield* ManagedProjectFolders.ManagedProjectFolders;

  const apnsEnv = yield* ApnsEnvConfig.pipe(Effect.orElseSucceed(() => Option.none()));
  const credentials: ApnsCredentials | null = Option.isNone(apnsEnv)
    ? null
    : yield* fileSystem.readFileString(apnsEnv.value.keyFile).pipe(
        Effect.map((privateKeyPem) => ({
          teamId: apnsEnv.value.teamId,
          keyId: apnsEnv.value.keyId,
          privateKeyPem,
        })),
        Effect.catch((cause) =>
          Effect.logWarning("device push disabled; the APNs key file could not be read", {
            cause: String(cause),
          }).pipe(Effect.as(null)),
        ),
      );

  let providerToken: { readonly value: string; readonly issuedAtMs: number } | undefined;
  const currentProviderToken = (apns: ApnsCredentials, nowMs: number) => {
    if (!providerToken || nowMs - providerToken.issuedAtMs > PROVIDER_TOKEN_LIFETIME_MS) {
      providerToken = {
        value: makeApnsProviderToken(apns, Math.floor(nowMs / 1_000)),
        issuedAtMs: nowMs,
      };
    }
    return providerToken.value;
  };

  const listDevices = sql<{ readonly document: string }>`
    SELECT document FROM workbench_push_devices
  `.pipe(
    Effect.flatMap((rows) =>
      Effect.forEach(rows, (row) => decodeDevice(row.document).pipe(Effect.option)),
    ),
    Effect.map((devices) => devices.flatMap((device) => Option.toArray(device))),
  );

  const forget = (deviceId: string) =>
    sql`DELETE FROM workbench_push_devices WHERE device_id=${deviceId}`.pipe(Effect.asVoid);

  const register: DevicePush["Service"]["register"] = Effect.fn("DevicePush.register")(
    function* (input) {
      if (input.platform === "ios" && credentials === null) {
        return yield* new DevicePushError({ reason: "not_configured" });
      }
      if (input.platform === "android") {
        return yield* new DevicePushError({ reason: "not_configured" });
      }
      const updatedAt = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        INSERT INTO workbench_push_devices (device_id, document, updated_at)
        VALUES (${input.deviceId}, ${encodeDevice(input)}, ${updatedAt})
        ON CONFLICT(device_id) DO UPDATE SET document=excluded.document, updated_at=excluded.updated_at
      `.pipe(Effect.mapError(storageFailure));
    },
  );

  const unregister: DevicePush["Service"]["unregister"] = (input) =>
    forget(input.deviceId).pipe(Effect.mapError(storageFailure));

  const deliver = Effect.fn("DevicePush.deliver")(function* (state: RelayAgentActivityState) {
    if (credentials === null) return;
    const devices = yield* listDevices;
    const targets = devices.filter(
      (device) =>
        device.platform === "ios" &&
        notificationAllowed(device.preferences, state.phase, state.runDurationSeconds ?? null),
    );
    if (targets.length === 0) return;
    const nowMs = (yield* DateTime.now).epochMilliseconds;
    const jwt = currentProviderToken(credentials, nowMs);
    // A count that cannot be read leaves the icon as it is rather than failing the alert.
    const badge = yield* threads.getShellSnapshot().pipe(
      Effect.map((snapshot) => badgeCountForShells(snapshot.threads, nowMs)),
      Effect.orElseSucceed(() => undefined),
    );
    const payload = apnsPayloadForState(state, badge);
    yield* Effect.forEach(
      targets,
      (device) =>
        Effect.tryPromise(() =>
          sendApnsAlert({
            environment: device.apsEnvironment,
            deviceToken: device.pushToken,
            topic: device.bundleId,
            providerToken: jwt,
            collapseId: state.threadId,
            payload,
          }),
        ).pipe(
          Effect.flatMap((result) => {
            if (result.ok) return Effect.void;
            const log = Effect.logWarning("device push was rejected", {
              deviceId: device.deviceId,
              status: result.status,
              reason: result.reason,
            });
            return isDeadApnsToken(result)
              ? log.pipe(Effect.andThen(forget(device.deviceId)))
              : log;
          }),
          Effect.catchCause((cause) =>
            Effect.logWarning("device push failed", {
              deviceId: device.deviceId,
              cause: Cause.pretty(cause),
            }),
          ),
        ),
      { discard: true, concurrency: 4 },
    );
  });

  const lastPhaseByThread = new Map<ThreadId, RelayAgentAwarenessPhase>();

  const readThread = Effect.fn("DevicePush.readThread")(function* (threadId: ThreadId) {
    const shell = yield* threads.getThreadShell(threadId);
    if (shell === null || shell.archivedAt !== null) return null;
    const project = yield* projects.getById(shell.projectId);
    if (Option.isNone(project)) return null;
    const projectIsScratch = yield* managedFolders.isScratchWorkspace(project.value.workspaceRoot);
    return { shell, project: project.value, projectIsScratch };
  });

  const projectState = (
    environmentId: EnvironmentId,
    thread: {
      readonly shell: OrchestrationV2ThreadShell;
      readonly project: Project;
      readonly projectIsScratch: boolean;
    },
    assistantText?: string | null,
  ) =>
    projectThreadAwarenessV2({
      environmentId,
      project: thread.project,
      thread: thread.shell,
      projectIsScratch: thread.projectIsScratch,
      ...(assistantText === undefined ? {} : { assistantText }),
    });

  const observeThread = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const thread = yield* readThread(threadId);
      // A missing projection is usually the projector mid-write; keep the baseline.
      if (thread === null) return;
      const environmentId = yield* serverEnvironment.getEnvironmentId;
      const state = projectState(environmentId, thread);
      if (state === null) return;
      const previous = lastPhaseByThread.get(threadId);
      lastPhaseByThread.set(threadId, state.phase);
      if (!shouldNotifyPhaseChange(previous, state.phase)) return;
      // The shell carries a bounded excerpt of the agent's last message once the run settles.
      const notified = projectState(
        environmentId,
        thread,
        assistantTextFromLatestMessage(thread.shell.latestVisibleMessage),
      );
      if (notified !== null) yield* deliver(notified);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("device push could not read a thread", {
          threadId,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  const start: DevicePush["Service"]["start"] = Effect.fn("DevicePush.start")(function* () {
    if (credentials === null) {
      yield* Effect.logInfo("device push standby; no APNs credentials configured");
      return;
    }
    const worker = yield* makeAgentAwarenessPublishWorker(observeThread);
    // Seed the baseline so work already running when the server starts can still notify.
    const seed = threads.getShellSnapshot().pipe(
      Effect.flatMap((snapshot) =>
        Effect.forEach(snapshot.threads, (thread) => worker.enqueue(thread.id), { discard: true }),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("device push could not seed thread state", {
          cause: Cause.pretty(cause),
        }),
      ),
    );
    yield* forkParked(
      seed.pipe(
        Effect.andThen(
          Stream.runForEach(threads.streamDomainEvents, (event: OrchestrationV2DomainEvent) =>
            shouldPublishAgentAwarenessEvent(event) ? worker.enqueue(event.threadId) : Effect.void,
          ),
        ),
      ),
    );
    yield* Effect.logInfo("device push enabled");
  });

  return DevicePush.of({
    status: Effect.succeed({ ios: credentials !== null, android: false }),
    register,
    unregister,
    start,
  });
});

export const layer = Layer.effect(DevicePush, make);
