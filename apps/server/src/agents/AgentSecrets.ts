import * as NodeCrypto from "node:crypto";

import {
  AGENT_SECRET_DECLINE_COOLDOWN_MS,
  AGENT_SECRET_LABEL_MAX,
  AGENT_SECRET_MAX_PENDING_PER_AGENT,
  AGENT_SECRET_MAX_PER_AGENT,
  AGENT_SECRET_ORIGIN_MAX_LENGTH,
  AGENT_SECRET_ORIGINS_MAX,
  AGENT_SECRET_REASON_MAX,
  AGENT_SECRET_REQUEST_TTL_MS,
  AGENT_SECRET_VALUE_MAX_BYTES,
  AGENT_SECRET_VALUE_MIN_LENGTH,
  AgentSecretError,
  AgentSecretRequest,
  AgentSecretSummary,
  CommandId,
  MessageId,
  ThreadId,
  agentSecretDeclinedMessage,
  agentSecretProvidedMessage,
  normalizeAgentSecretOrigin,
  type AgentSecretDeleteInput,
  type AgentSecretDeleteResult,
  type AgentSecretList,
  type AgentSecretListInput,
  type AgentSecretMcpRequestResult,
  type AgentSecretRequestList,
  type AgentSecretSetInput,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { carryReplyToLastAsker } from "./AgentReplies.ts";
import * as AgentWorkspace from "./AgentWorkspace.ts";

/** Where `secret_file` puts values: one 0700 directory per agent below the server's state directory. */
export const AGENT_SECRET_FILES_DIRECTORY = "agent-secret-files";

interface AgentSecretRequestInput {
  readonly agentId: string;
  readonly threadId: ThreadId;
  readonly name: string;
  readonly label: string;
  readonly reason: string;
  readonly kind: AgentSecretSetInput["kind"];
  /** A site the agent suggests; untrusted, cleaned here, and only ever shown to the owner. */
  readonly suggestedOrigin?: string | undefined;
  /** Ask even though a secret with this name already exists. */
  readonly replace: boolean;
}

/**
 * Secrets an agent asked its owner for. The rules live here; the RPC handlers and the agent's MCP
 * tools both call these methods.
 *
 * A value is only ever a `Redacted<string>` in these signatures. It is written to the server secret
 * store, and it reaches a file (`useFile`) or the browser (`useForTyping`) only on request. By
 * default it is kept out of the database, logs, spans, queued messages and error text. An agent
 * that can run commands on this machine runs as the server's user and could still read the store.
 */
export class AgentSecrets extends Context.Service<
  AgentSecrets,
  {
    /** Metadata only. Without `agentId`, every agent's. */
    readonly list: (
      input: AgentSecretListInput,
    ) => Effect.Effect<AgentSecretList, AgentSecretError>;
    /** The owner adds a secret or replaces its value. */
    readonly set: (
      input: Omit<AgentSecretSetInput, "value"> & { readonly value: Redacted.Redacted<string> },
    ) => Effect.Effect<AgentSecretSummary, AgentSecretError>;
    /** Removes the value, its file and then its metadata. */
    readonly remove: (
      input: AgentSecretDeleteInput,
    ) => Effect.Effect<AgentSecretDeleteResult, AgentSecretError>;
    /** The agent's own thread asks the owner for a secret; the agent is not blocked. */
    readonly createRequest: (
      input: AgentSecretRequestInput,
    ) => Effect.Effect<AgentSecretMcpRequestResult, AgentSecretError>;
    /** The requests still waiting for the owner. Old ones read as expired and are left out. */
    readonly listRequests: Effect.Effect<AgentSecretRequestList, AgentSecretError>;
    /** Emits the waiting requests on subscribe and again after every change. */
    readonly subscribeRequests: Stream.Stream<AgentSecretRequestList, AgentSecretError>;
    /**
     * Claims the request, stores the value and tells the requesting thread (without it). The
     * request reads provided once the value is stored; a failure to tell the thread is only logged.
     */
    readonly provide: (input: {
      readonly requestId: string;
      readonly value: Redacted.Redacted<string>;
      readonly allowedOrigins?: ReadonlyArray<string> | undefined;
    }) => Effect.Effect<AgentSecretRequest, AgentSecretError>;
    readonly decline: (input: {
      readonly requestId: string;
    }) => Effect.Effect<AgentSecretRequest, AgentSecretError>;
    /**
     * The agent that owns a thread (its primary thread, else one of its threads), looked up
     * without decoding any agent document.
     */
    readonly agentForThread: (
      threadId: ThreadId,
    ) => Effect.Effect<{ readonly agentId: string; readonly archived: boolean }, AgentSecretError>;
    /** Writes the value to a file only the server's user can read and returns its path. */
    readonly useFile: (input: {
      readonly agentId: string;
      readonly name: string;
    }) => Effect.Effect<string, AgentSecretError>;
    /**
     * Every value the thread's agent holds, so browser results can be masked. Empty for a thread
     * that belongs to no agent or an agent with no secrets, without reading any file. It fails when
     * the values cannot be read, and the caller must then withhold what it was about to return.
     */
    readonly valuesForThread: (
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<Redacted.Redacted<string>>, AgentSecretError>;
    /** The value and the sites it may be typed on, for the one caller handing it to the browser. */
    readonly useForTyping: (input: {
      readonly agentId: string;
      readonly name: string;
    }) => Effect.Effect<
      { readonly value: Redacted.Redacted<string>; readonly allowedOrigins: ReadonlyArray<string> },
      AgentSecretError
    >;
  }
>()("t3/agents/AgentSecrets") {}

const failure = (reason: AgentSecretError["reason"]) => new AgentSecretError({ reason });
const storage = () => failure("storage");
const decodeSummary = Schema.decodeUnknownEffect(AgentSecretSummary);
const decodeRequest = Schema.decodeUnknownEffect(AgentSecretRequest);
const nowMillis = Effect.map(DateTime.now, DateTime.toEpochMillis);
const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

interface SecretRow {
  readonly id: string;
  readonly agent_id: string;
  readonly name: string;
  readonly label: string;
  readonly kind: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly last_used_at: string | null;
  readonly allowed_origins: string;
}

interface RequestRow {
  readonly id: string;
  readonly agent_id: string;
  readonly thread_id: string;
  readonly name: string;
  readonly label: string;
  readonly reason: string;
  readonly kind: string;
  readonly suggested_origin: string | null;
  readonly status: string;
  readonly created_at: string;
  readonly resolved_at: string | null;
}

const encodeOrigins = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const decodeOrigins = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);
const parseOrigins = (stored: string): ReadonlyArray<string> =>
  Option.getOrElse(decodeOrigins(stored), () => []);

/** What the owner's own words never contain: control characters and the ones that reorder text. */
// oxlint-disable-next-line no-control-regex
const HIDDEN_CHARACTERS = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g;

/** Text the agent wrote, made safe to show: one line, no control or bidi characters, bounded. */
const cleanAgentText = (text: string, max: number): string =>
  text
    .replace(/[\t\r\n]+/g, " ")
    .replace(HIDDEN_CHARACTERS, "")
    .trim()
    .slice(0, max)
    .trim();

const toSummary = (row: SecretRow) =>
  decodeSummary({
    id: row.id,
    agentId: row.agent_id,
    name: row.name,
    label: row.label,
    kind: row.kind,
    allowedOrigins: parseOrigins(row.allowed_origins),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
  }).pipe(Effect.mapError(storage));

/** A request nobody answered within the time to live reads as expired. */
const effectiveStatus = (row: RequestRow, now: number) =>
  row.status === "pending" && Date.parse(row.created_at) + AGENT_SECRET_REQUEST_TTL_MS <= now
    ? "expired"
    : row.status;

const toRequest = (row: RequestRow, now: number, replaces: boolean) =>
  decodeRequest({
    id: row.id,
    agentId: row.agent_id,
    threadId: row.thread_id,
    name: row.name,
    label: row.label,
    reason: row.reason,
    kind: row.kind,
    suggestedOrigin: row.suggested_origin,
    replaces,
    status: effectiveStatus(row, now),
    createdAt: row.created_at,
    expiresAt: iso(Date.parse(row.created_at) + AGENT_SECRET_REQUEST_TTL_MS),
    resolvedAt: row.resolved_at,
  }).pipe(Effect.mapError(storage));

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** One short, fixed-length directory name per agent, so no id can climb out of the directory. */
const agentDirectoryName = (agentId: string) =>
  NodeCrypto.createHash("sha256").update(agentId).digest("hex").slice(0, 32);

/** The name a value has in the server secret store: hashed agent id plus the validated secret name. */
const storeName = (agentId: string, name: string) =>
  `agent-secret-${agentDirectoryName(agentId)}-${name}`;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const store = yield* ServerSecretStore.ServerSecretStore;
  const agents = yield* AgentWorkspace.AgentWorkspace;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  // Sliding(1) coalesces the dirty signal: every notification re-lists anyway.
  const changes = yield* PubSub.sliding<void>(1);
  const notifyChanged = PubSub.publish(changes, undefined).pipe(Effect.asVoid);
  // Secret files are written one at a time, so cleaning up stale temporary files cannot remove
  // the temporary file of a write in progress.
  const fileWrites = yield* Semaphore.make(1);

  const randomId = (prefix: string) =>
    crypto.randomUUIDv4.pipe(
      Effect.map((uuid) => `${prefix}:${uuid}`),
      Effect.mapError(storage),
    );

  const readAgent = (agentId: string) =>
    agents
      .read(agentId)
      .pipe(
        Effect.mapError((error) =>
          error.reason === "not_found" ? failure("agent_not_found") : storage(),
        ),
      );

  /**
   * Leading and trailing whitespace is dropped, and what is left must be long enough to mask and
   * short enough to store. Sizes are measured here and a refusal never quotes the value.
   */
  const checkValue = (value: Redacted.Redacted<string>) => {
    const trimmed = Redacted.value(value).trim();
    if (trimmed.length === 0) return Effect.fail(failure("value_empty"));
    if (trimmed.length < AGENT_SECRET_VALUE_MIN_LENGTH)
      return Effect.fail(failure("value_too_short"));
    const bytes = textEncoder.encode(trimmed);
    if (bytes.length > AGENT_SECRET_VALUE_MAX_BYTES) return Effect.fail(failure("value_too_large"));
    return Effect.succeed(bytes);
  };

  /** Normalised, de-duplicated origins; any entry that is not an allowed origin refuses the lot. */
  const normalizeOrigins = (raw: ReadonlyArray<string> | undefined) => {
    if (raw === undefined) return Effect.succeed(undefined);
    const normalized: Array<string> = [];
    for (const entry of raw) {
      const origin = normalizeAgentSecretOrigin(entry);
      if (origin === null) return Effect.fail(failure("invalid_origin"));
      if (!normalized.includes(origin)) normalized.push(origin);
    }
    if (normalized.length > AGENT_SECRET_ORIGINS_MAX) return Effect.fail(failure("invalid_origin"));
    return Effect.succeed(normalized);
  };

  const selectSecret = (agentId: string, name: string) =>
    sql<SecretRow>`
      SELECT * FROM workbench_agent_secrets WHERE agent_id = ${agentId} AND name = ${name}
    `.pipe(Effect.mapError(storage));

  const secretCount = (agentId: string) =>
    sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM workbench_agent_secrets WHERE agent_id = ${agentId}
    `.pipe(
      Effect.map((rows) => rows[0]?.n ?? 0),
      Effect.mapError(storage),
    );

  const selectRequest = (id: string) =>
    sql<RequestRow>`SELECT * FROM workbench_agent_secret_requests WHERE id = ${id}`.pipe(
      Effect.mapError(storage),
    );

  const agentFilesDirectory = (agentId: string) =>
    path.join(config.stateDir, AGENT_SECRET_FILES_DIRECTORY, agentDirectoryName(agentId));

  const fileFailure = () => failure("file_failed");

  /** The directories are 0700, so a file inside is unreachable to other users even while it is written. */
  const ensureFilesDirectory = (agentId: string) =>
    Effect.gen(function* () {
      const root = path.join(config.stateDir, AGENT_SECRET_FILES_DIRECTORY);
      const directory = agentFilesDirectory(agentId);
      yield* fileSystem.makeDirectory(root, { recursive: true, mode: 0o700 });
      yield* fileSystem.chmod(root, 0o700);
      yield* fileSystem.makeDirectory(directory, { recursive: true, mode: 0o700 });
      yield* fileSystem.chmod(directory, 0o700);
      return directory;
    }).pipe(Effect.mapError(fileFailure));

  /**
   * Writes through a temporary file in the same private directory, so a reader never sees half a
   * value, and first removes temporary files an earlier crashed write left behind.
   */
  const writeSecretFile = (agentId: string, name: string, bytes: Uint8Array) =>
    fileWrites.withPermits(1)(
      Effect.gen(function* () {
        const directory = yield* ensureFilesDirectory(agentId);
        const entries = yield* fileSystem.readDirectory(directory);
        yield* Effect.forEach(
          entries.filter((entry) => entry.endsWith(".tmp")),
          (entry) => fileSystem.remove(path.join(directory, entry), { force: true }),
          { discard: true },
        );
        const target = path.join(directory, name);
        const current = yield* fileSystem.readFile(target).pipe(Effect.orElseSucceed(() => null));
        const unchanged =
          current !== null &&
          current.length === bytes.length &&
          current.every((byte, index) => byte === bytes[index]);
        if (!unchanged) {
          const uuid = yield* crypto.randomUUIDv4;
          const temporary = `${target}.${uuid}.tmp`;
          yield* Effect.gen(function* () {
            yield* fileSystem.writeFile(temporary, bytes, { mode: 0o600 });
            yield* fileSystem.chmod(temporary, 0o600);
            yield* fileSystem.rename(temporary, target);
          }).pipe(Effect.tapError(() => fileSystem.remove(temporary).pipe(Effect.ignore)));
        }
        yield* fileSystem.chmod(target, 0o600);
        return target;
      }).pipe(Effect.mapError(fileFailure)),
    );

  const removeSecretFile = (agentId: string, name: string) =>
    fileSystem
      .remove(path.join(agentFilesDirectory(agentId), name), { force: true })
      .pipe(Effect.mapError(fileFailure));

  /** A file an agent already holds the path to follows the secret when its value changes. */
  const refreshSecretFile = (agentId: string, name: string, bytes: Uint8Array) =>
    fileSystem.exists(path.join(agentFilesDirectory(agentId), name)).pipe(
      Effect.orElseSucceed(() => false),
      Effect.flatMap((exists) =>
        exists ? writeSecretFile(agentId, name, bytes).pipe(Effect.asVoid) : Effect.void,
      ),
    );

  /**
   * Stores the value and upserts the metadata row. Shared by the owner's direct add and by
   * answering a request. A new name counts against the per-agent cap. With `keepStored`, an
   * existing secret keeps its label, kind and sites whatever this call carries.
   */
  const storeSecret = Effect.fn("AgentSecrets.storeSecret")(function* (input: {
    readonly agentId: string;
    readonly name: string;
    readonly label: string;
    readonly kind: string;
    readonly value: Redacted.Redacted<string>;
    /** Normalised. Undefined keeps the stored sites, or means any site for a new secret. */
    readonly allowedOrigins: ReadonlyArray<string> | undefined;
    readonly keepStored: boolean;
  }) {
    const bytes = yield* checkValue(input.value);
    const existing = (yield* selectSecret(input.agentId, input.name))[0];
    if (
      existing === undefined &&
      (yield* secretCount(input.agentId)) >= AGENT_SECRET_MAX_PER_AGENT
    ) {
      return yield* failure("secret_limit");
    }
    const keep = input.keepStored && existing !== undefined;
    const label = keep ? existing.label : input.label;
    const kind = keep ? existing.kind : input.kind;
    const origins = keep
      ? parseOrigins(existing.allowed_origins)
      : (input.allowedOrigins ??
        (existing === undefined ? [] : parseOrigins(existing.allowed_origins)));
    yield* store.set(storeName(input.agentId, input.name), bytes).pipe(Effect.mapError(storage));
    const id = yield* randomId("secret");
    const timestamp = iso(yield* nowMillis);
    const rows = yield* sql<SecretRow>`
      INSERT INTO workbench_agent_secrets
        (id, agent_id, name, label, kind, allowed_origins, created_at, updated_at, last_used_at)
      VALUES (${id}, ${input.agentId}, ${input.name}, ${label}, ${kind}, ${encodeOrigins(origins)},
        ${timestamp}, ${timestamp}, NULL)
      ON CONFLICT (agent_id, name) DO UPDATE SET
        label = excluded.label,
        kind = excluded.kind,
        allowed_origins = excluded.allowed_origins,
        updated_at = excluded.updated_at
      RETURNING *
    `.pipe(Effect.mapError(storage));
    if (rows[0] === undefined) return yield* storage();
    yield* refreshSecretFile(input.agentId, input.name, bytes);
    return yield* toSummary(rows[0]);
  });

  const list: AgentSecrets["Service"]["list"] = Effect.fn("AgentSecrets.list")(function* (input) {
    const rows =
      input.agentId === undefined
        ? yield* sql<SecretRow>`
            SELECT * FROM workbench_agent_secrets ORDER BY agent_id, name
          `.pipe(Effect.mapError(storage))
        : yield* sql<SecretRow>`
            SELECT * FROM workbench_agent_secrets WHERE agent_id = ${input.agentId} ORDER BY name
          `.pipe(Effect.mapError(storage));
    return { secrets: yield* Effect.forEach(rows, toSummary) };
  });

  /** The value and its file go before the metadata row, so a failure cannot leave plaintext behind. */
  const remove: AgentSecrets["Service"]["remove"] = Effect.fn("AgentSecrets.remove")(
    function* (input) {
      const existing = yield* selectSecret(input.agentId, input.name);
      if (existing[0] === undefined) return yield* failure("secret_not_found");
      yield* store.remove(storeName(input.agentId, input.name)).pipe(Effect.mapError(storage));
      yield* removeSecretFile(input.agentId, input.name);
      yield* sql`
        DELETE FROM workbench_agent_secrets WHERE agent_id = ${input.agentId} AND name = ${input.name}
      `.pipe(Effect.mapError(storage));
      return { name: input.name };
    },
  );

  const createRequest: AgentSecrets["Service"]["createRequest"] = Effect.fn(
    "AgentSecrets.createRequest",
  )(function* (input) {
    const agent = yield* readAgent(input.agentId);
    if (agent.archivedAt) return yield* failure("agent_archived");
    const existing = yield* selectSecret(input.agentId, input.name);
    if (existing[0] !== undefined && !input.replace) {
      return { status: "available" as const, name: input.name };
    }
    if (
      existing[0] === undefined &&
      (yield* secretCount(input.agentId)) >= AGENT_SECRET_MAX_PER_AGENT
    ) {
      return yield* failure("secret_limit");
    }
    const now = yield* nowMillis;
    const cutoff = iso(now - AGENT_SECRET_REQUEST_TTL_MS);
    // A request nobody answered for a day no longer holds the one pending slot for its name.
    yield* sql`
      UPDATE workbench_agent_secret_requests
      SET status = 'expired', resolved_at = ${iso(now)}
      WHERE agent_id = ${input.agentId} AND name = ${input.name}
        AND status = 'pending' AND created_at <= ${cutoff}
    `.pipe(Effect.mapError(storage));
    const declined = yield* sql<{ readonly id: string }>`
      SELECT id FROM workbench_agent_secret_requests
      WHERE agent_id = ${input.agentId} AND name = ${input.name} AND status = 'declined'
        AND resolved_at > ${iso(now - AGENT_SECRET_DECLINE_COOLDOWN_MS)}
      LIMIT 1
    `.pipe(Effect.mapError(storage));
    if (declined[0] !== undefined) return yield* failure("request_declined_recently");

    // Everything the agent wrote is cleaned and bounded before it is stored or shown.
    const label =
      cleanAgentText(input.label, AGENT_SECRET_LABEL_MAX) ||
      cleanAgentText(input.name, AGENT_SECRET_LABEL_MAX);
    const reason = cleanAgentText(input.reason, AGENT_SECRET_REASON_MAX) || "No reason was given.";
    const suggestedOrigin =
      input.suggestedOrigin === undefined
        ? null
        : normalizeAgentSecretOrigin(
            cleanAgentText(input.suggestedOrigin, AGENT_SECRET_ORIGIN_MAX_LENGTH),
          );
    const id = yield* randomId("secretreq");
    // One statement decides everything: the unique index on (agent, name) while pending refuses a
    // second request for the same name, and the count in the WHERE keeps the agent under its cap,
    // so parallel calls cannot get past either limit.
    const inserted = yield* sql<{ readonly id: string }>`
      INSERT INTO workbench_agent_secret_requests
        (id, agent_id, thread_id, name, label, reason, kind, suggested_origin, status, created_at, resolved_at)
      SELECT ${id}, ${input.agentId}, ${input.threadId}, ${input.name}, ${label},
        ${reason}, ${input.kind}, ${suggestedOrigin}, 'pending', ${iso(now)}, NULL
      WHERE (
        SELECT COUNT(*) FROM workbench_agent_secret_requests
        WHERE agent_id = ${input.agentId} AND status = 'pending' AND created_at > ${cutoff}
      ) < ${AGENT_SECRET_MAX_PENDING_PER_AGENT}
      ON CONFLICT DO NOTHING
      RETURNING id
    `.pipe(Effect.mapError(storage));
    if (inserted[0] !== undefined) {
      yield* notifyChanged;
      return { status: "requested" as const, name: input.name, requestId: id };
    }
    // Refused: either this name already has a waiting request, which is the same request, or the cap.
    const same = yield* sql<{ readonly id: string }>`
      SELECT id FROM workbench_agent_secret_requests
      WHERE agent_id = ${input.agentId} AND name = ${input.name} AND status = 'pending'
    `.pipe(Effect.mapError(storage));
    if (same[0] !== undefined) {
      return { status: "requested" as const, name: input.name, requestId: same[0].id };
    }
    return yield* failure("request_limit");
  });

  /** Whether each (agent, name) of these rows already holds a saved secret. */
  const replacesFor = (rows: ReadonlyArray<RequestRow>) =>
    rows.length === 0
      ? Effect.succeed(new Set<string>())
      : sql<{ readonly agent_id: string; readonly name: string }>`
          SELECT agent_id, name FROM workbench_agent_secrets
        `.pipe(
          Effect.map((held) => new Set(held.map((row) => `${row.agent_id}\u0000${row.name}`))),
          Effect.mapError(storage),
        );
  const replaceKey = (row: RequestRow) => `${row.agent_id}\u0000${row.name}`;

  const listRequests: AgentSecrets["Service"]["listRequests"] = Effect.gen(function* () {
    const now = yield* nowMillis;
    const rows = yield* sql<RequestRow>`
      SELECT * FROM workbench_agent_secret_requests
      WHERE status = 'pending' AND created_at > ${iso(now - AGENT_SECRET_REQUEST_TTL_MS)}
      ORDER BY created_at, rowid
    `.pipe(Effect.mapError(storage));
    const held = yield* replacesFor(rows);
    return {
      requests: yield* Effect.forEach(rows, (row) =>
        toRequest(row, now, held.has(replaceKey(row))),
      ),
    };
  }).pipe(Effect.withSpan("AgentSecrets.listRequests"));

  const subscribeRequests: AgentSecrets["Service"]["subscribeRequests"] = Stream.unwrap(
    Effect.gen(function* () {
      // Subscribe before the snapshot so a change landing between the two is buffered.
      const subscription = yield* PubSub.subscribe(changes);
      return Stream.concat(
        Stream.fromEffect(listRequests),
        Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => listRequests)),
      );
    }),
  );

  /**
   * Tells the requesting thread what the owner decided. A thread that is gone cannot be told;
   * the answer is still recorded, and the agent finds a provided secret through `secret_list`.
   */
  const tellThread = Effect.fn("AgentSecrets.tellThread")(function* (
    row: RequestRow,
    kind: "provided" | "declined",
  ) {
    const threadId = ThreadId.make(row.thread_id);
    const shell = yield* threads.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));
    if (shell === null || shell.archivedAt !== null) return;
    const messageId = MessageId.make(`agent-secret-${kind}-message:${row.id}`);
    yield* threads
      .sendToThread({
        projectId: shell.projectId,
        // Deterministic ids: answering the same request twice queues the message once.
        commandId: CommandId.make(`agent-secret-${kind}:${row.id}`),
        threadId,
        messageId,
        text:
          kind === "provided"
            ? agentSecretProvidedMessage(row.name)
            : agentSecretDeclinedMessage(row.name),
        attachments: [],
        mode: "queue",
        createdBy: "user",
        creationSource: "server",
      })
      .pipe(Effect.mapError(() => failure("thread_unavailable")));
    // The agent that handed this one its work hears what it does next, so its own conversation
    // carries on without a person typing "continue". Failing to record that is not fatal.
    yield* Effect.gen(function* () {
      const { messages } = yield* threads.getThreadRecords(threadId, ["messages"], {
        messageRoles: ["user"],
      });
      // What the agent was working on: the newest message that is not one of these notices.
      const work = messages
        .filter((message) => !message.id.startsWith("agent-secret-"))
        .toSorted(
          (left, right) =>
            DateTime.toEpochMillis(left.createdAt) - DateTime.toEpochMillis(right.createdAt),
        )
        .at(-1);
      if (work === undefined) return;
      yield* carryReplyToLastAsker(sql, {
        recipientThreadId: threadId,
        sourceMessageId: messageId,
        workMessageId: work.id,
      });
    }).pipe(Effect.ignore);
  });

  /** The answer is already recorded, so a thread that cannot be told is a warning and not an error. */
  const tellThreadQuietly = (row: RequestRow, kind: "provided" | "declined") =>
    tellThread(row, kind).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("could not tell the agent how the owner answered a secret request", {
              requestId: row.id,
              answer: kind,
            }),
      ),
    );

  const openRequest = (requestId: string) =>
    Effect.gen(function* () {
      const rows = yield* selectRequest(requestId);
      const row = rows[0];
      if (row === undefined) return yield* failure("request_not_found");
      const status = effectiveStatus(row, yield* nowMillis);
      if (status === "expired") return yield* failure("request_expired");
      if (status !== "pending") return yield* failure("request_resolved");
      return row;
    });

  /**
   * Moves a pending request to its answer. Only one caller can win this update, which is what
   * keeps a provide and a decline racing each other from both going through.
   */
  const claim = (row: RequestRow, status: "provided" | "declined", replaces: boolean) =>
    Effect.gen(function* () {
      const now = yield* nowMillis;
      const updated = yield* sql<RequestRow>`
        UPDATE workbench_agent_secret_requests
        SET status = ${status}, resolved_at = ${iso(now)}
        WHERE id = ${row.id} AND status = 'pending'
        RETURNING *
      `.pipe(Effect.mapError(storage));
      if (updated[0] === undefined) return yield* failure("request_resolved");
      yield* notifyChanged;
      return yield* toRequest(updated[0], now, replaces);
    });

  /** Undoes a claim whose value could not be stored, so the request is waiting again. */
  const unclaim = (row: RequestRow) =>
    sql`
      UPDATE workbench_agent_secret_requests
      SET status = 'pending', resolved_at = NULL
      WHERE id = ${row.id} AND status = 'provided'
    `.pipe(Effect.andThen(notifyChanged), Effect.ignore);

  const provide: AgentSecrets["Service"]["provide"] = Effect.fn("AgentSecrets.provide")(
    function* (input) {
      const row = yield* openRequest(input.requestId);
      yield* readAgent(row.agent_id);
      // Everything that can be refused is checked before the request is claimed.
      yield* checkValue(input.value);
      const origins = yield* normalizeOrigins(input.allowedOrigins);
      const existing = (yield* selectSecret(row.agent_id, row.name))[0];
      if (
        existing === undefined &&
        (yield* secretCount(row.agent_id)) >= AGENT_SECRET_MAX_PER_AGENT
      ) {
        return yield* failure("secret_limit");
      }
      const replaces = existing !== undefined;
      // Claimed first, so the request and the stored value cannot disagree: if the value then
      // cannot be stored, the claim is undone and the request waits again.
      const answered = yield* claim(row, "provided", replaces);
      yield* storeSecret({
        agentId: row.agent_id,
        name: row.name,
        label: row.label,
        kind: row.kind,
        value: input.value,
        allowedOrigins: origins,
        // Replacing through an agent's request keeps what the owner saved earlier.
        keepStored: true,
      }).pipe(Effect.tapError(() => unclaim(row)));
      yield* tellThreadQuietly(row, "provided");
      return answered;
    },
  );

  const decline: AgentSecrets["Service"]["decline"] = Effect.fn("AgentSecrets.decline")(
    function* (input) {
      const row = yield* openRequest(input.requestId);
      const replaces = (yield* selectSecret(row.agent_id, row.name))[0] !== undefined;
      const answered = yield* claim(row, "declined", replaces);
      yield* tellThreadQuietly(row, "declined");
      return answered;
    },
  );

  const set: AgentSecrets["Service"]["set"] = Effect.fn("AgentSecrets.set")(function* (input) {
    yield* readAgent(input.agentId);
    const origins = yield* normalizeOrigins(input.allowedOrigins);
    const summary = yield* storeSecret({
      agentId: input.agentId,
      name: input.name,
      label: input.label,
      kind: input.kind,
      value: input.value,
      allowedOrigins: origins,
      keepStored: false,
    });
    // An owner who adds the secret by hand answers any request the agent has open for it.
    const now = yield* nowMillis;
    const waiting = yield* sql<RequestRow>`
      SELECT * FROM workbench_agent_secret_requests
      WHERE agent_id = ${input.agentId} AND name = ${input.name} AND status = 'pending'
        AND created_at > ${iso(now - AGENT_SECRET_REQUEST_TTL_MS)}
    `.pipe(Effect.mapError(storage));
    yield* Effect.forEach(
      waiting,
      (row) =>
        claim(row, "provided", true).pipe(
          Effect.andThen(tellThreadQuietly(row, "provided")),
          // The secret is stored; failing to close a stale request must not fail the owner's add.
          Effect.ignore,
        ),
      { discard: true },
    );
    return summary;
  });

  const agentForThread: AgentSecrets["Service"]["agentForThread"] = Effect.fn(
    "AgentSecrets.agentForThread",
  )(function* (threadId) {
    const own = yield* agents.threadAgent(threadId).pipe(Effect.mapError(storage));
    if (own === null) return yield* failure("not_an_agent_thread");
    return own;
  });

  /** The bytes of a usable secret: the agent must not be archived and must hold the secret. */
  const readUsable = (agentId: string, name: string) =>
    Effect.gen(function* () {
      const agent = yield* readAgent(agentId);
      if (agent.archivedAt) return yield* failure("agent_archived");
      const rows = yield* selectSecret(agentId, name);
      if (rows[0] === undefined) return yield* failure("secret_not_found");
      const bytes = yield* store.get(storeName(agentId, name)).pipe(Effect.mapError(storage));
      if (Option.isNone(bytes)) return yield* failure("secret_not_found");
      const usedAt = iso(yield* nowMillis);
      yield* sql`
        UPDATE workbench_agent_secrets SET last_used_at = ${usedAt}
        WHERE agent_id = ${agentId} AND name = ${name}
      `.pipe(Effect.mapError(storage));
      return { bytes: bytes.value, allowedOrigins: parseOrigins(rows[0].allowed_origins) };
    });

  const useFile: AgentSecrets["Service"]["useFile"] = Effect.fn("AgentSecrets.useFile")(
    function* (input) {
      const usable = yield* readUsable(input.agentId, input.name);
      return yield* writeSecretFile(input.agentId, input.name, usable.bytes);
    },
  );

  const useForTyping: AgentSecrets["Service"]["useForTyping"] = Effect.fn(
    "AgentSecrets.useForTyping",
  )(function* (input) {
    const usable = yield* readUsable(input.agentId, input.name);
    return {
      value: Redacted.make(textDecoder.decode(usable.bytes)),
      allowedOrigins: usable.allowedOrigins,
    };
  });

  const valuesForThread: AgentSecrets["Service"]["valuesForThread"] = Effect.fn(
    "AgentSecrets.valuesForThread",
  )(function* (threadId) {
    const owner = yield* agents.threadAgent(threadId).pipe(Effect.mapError(storage));
    if (owner === null) return [];
    // Metadata first: an agent with no secrets costs one small query and no file reads.
    const rows = yield* sql<{ readonly agent_id: string; readonly name: string }>`
      SELECT agent_id, name FROM workbench_agent_secrets WHERE agent_id = ${owner.agentId}
    `.pipe(Effect.mapError(storage));
    if (rows.length === 0) return [];
    const found = yield* Effect.forEach(rows, (row) =>
      store.get(storeName(row.agent_id, row.name)).pipe(Effect.mapError(storage)),
    );
    return found.flatMap((bytes) =>
      Option.isSome(bytes) ? [Redacted.make(textDecoder.decode(bytes.value))] : [],
    );
  });

  return AgentSecrets.of({
    list,
    set,
    remove,
    createRequest,
    listRequests,
    subscribeRequests,
    provide,
    decline,
    agentForThread,
    useFile,
    useForTyping,
    valuesForThread,
  });
});

export const layer = Layer.effect(AgentSecrets, make);
