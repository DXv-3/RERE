import * as NodeCrypto from "node:crypto";
import {
  AGENT_TOOL_GROUPS,
  AgentWorkspaceError,
  AgentArchive,
  type AgentToolGroup,
  WorkspaceAgent,
  AgentImportInput,
  AgentImportReceipt,
  type AgentSaveInput,
  type AgentContinuationInput,
  type AgentContinuation,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { grokBotAvatar } from "@t3tools/shared/agentAvatar";
import { prepareAgentContinuation } from "./continuation.ts";

type ImportInput = typeof AgentImportInput.Type;
type SaveInput = typeof AgentSaveInput.Type;
type Receipt = typeof AgentImportReceipt.Type;
export class AgentWorkspace extends Context.Service<
  AgentWorkspace,
  {
    readonly enrichMessage: (input: {
      commandId: string;
      threadId: string;
      text: string;
      scheduled: boolean;
      acceptedReplay?: boolean;
    }) => Effect.Effect<string, AgentWorkspaceError>;
    readonly list: Effect.Effect<readonly WorkspaceAgent[], AgentWorkspaceError>;
    /**
     * The tool groups switched off for the agent that owns `threadId` (its primary thread, else
     * one of its threads); empty when the thread belongs to no agent. Asked on every tool call
     * of the built-in MCP server, so it reads only the setting and never decodes whole agents.
     */
    readonly blockedToolGroups: (
      threadId: string,
    ) => Effect.Effect<ReadonlyArray<AgentToolGroup>, AgentWorkspaceError>;
    /**
     * Which agent owns `threadId` (its primary thread, else one of its threads): just its id and
     * whether it is archived, or null when the thread belongs to no agent. Same JSON lookup as
     * `blockedToolGroups`, so asking on every browser tool call never decodes whole agents.
     */
    readonly threadAgent: (
      threadId: string,
    ) => Effect.Effect<
      { readonly agentId: string; readonly archived: boolean } | null,
      AgentWorkspaceError
    >;
    readonly read: (id: string) => Effect.Effect<WorkspaceAgent, AgentWorkspaceError>;
    /**
     * The client write path (`agents.save`). Goals are server-local state: this never changes
     * them. A stored agent keeps its goals whatever the input carries, and a new one starts with none.
     */
    readonly save: (input: SaveInput) => Effect.Effect<WorkspaceAgent, AgentWorkspaceError>;
    /** The same optimistic write as `save`, but the agent's goals are taken from the input. */
    readonly saveGoals: (input: SaveInput) => Effect.Effect<WorkspaceAgent, AgentWorkspaceError>;
    readonly importAgents: (input: ImportInput) => Effect.Effect<Receipt, AgentWorkspaceError>;
    readonly prepare: (
      input: typeof AgentContinuationInput.Type,
    ) => Effect.Effect<AgentContinuation, AgentWorkspaceError>;
  }
>()("t3/agents/AgentWorkspace") {}
const failure = (reason: AgentWorkspaceError["reason"]) => new AgentWorkspaceError({ reason });
const decodeAgent = Schema.decodeUnknownEffect(WorkspaceAgent);
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkspaceAgent));
const encodeAgent = Schema.encodeSync(Schema.fromJsonString(WorkspaceAgent));
const encodeArchive = Schema.encodeSync(Schema.fromJsonString(Schema.NullOr(AgentArchive)));
const encodeReceipt = Schema.encodeSync(Schema.fromJsonString(AgentImportReceipt));
const decodeReceipt = Schema.decodeUnknownEffect(Schema.fromJsonString(AgentImportReceipt));
const encodeImport = Schema.encodeSync(Schema.fromJsonString(AgentImportInput));
const decodeBlockedGroups = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.Unknown)),
);
const isToolGroup = (value: unknown): value is AgentToolGroup =>
  AGENT_TOOL_GROUPS.some((group) => group === value);
const timestamp = Effect.map(Clock.currentTimeMillis, (ms) =>
  DateTime.formatIso(DateTime.makeUnsafe(ms)),
);
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Assets are immutable and content-addressed. Keep old assets for recoverable resets.
  // Hydration preserves the existing web/mobile image contract while documents store references.
  const hydrateAvatar = Effect.fn("AgentWorkspace.hydrateAvatar")(function* (
    agent: WorkspaceAgent,
  ) {
    const avatar = agent.profile.avatar;
    if (!avatar) {
      // Imports made before avatars were carried over kept Grok Bot's shape and color
      // only in the archive, so those agents fell back to initials.
      const fromSource = agent.archive ? grokBotAvatar(agent.archive.sourceSettings) : null;
      return fromSource ? { ...agent, profile: { ...agent.profile, avatar: fromSource } } : agent;
    }
    if (!avatar.imageRef || avatar.image) return agent;
    const rows = yield* sql<{
      data: string;
    }>`SELECT data FROM workbench_agent_assets WHERE id=${avatar.imageRef}`.pipe(
      Effect.mapError(() => failure("storage")),
    );
    if (!rows[0]) return yield* failure("storage");
    return { ...agent, profile: { ...agent.profile, avatar: { ...avatar, image: rows[0].data } } };
  });
  const persistAvatar = Effect.fn("AgentWorkspace.persistAvatar")(function* (
    agent: WorkspaceAgent,
  ) {
    const avatar = agent.profile.avatar;
    if (!avatar) return agent;
    if (avatar.image) {
      const imageRef = NodeCrypto.createHash("sha256").update(avatar.image).digest("hex");
      yield* sql`INSERT INTO workbench_agent_assets (id,data) VALUES (${imageRef},${avatar.image}) ON CONFLICT(id) DO NOTHING`;
      return {
        ...agent,
        profile: { ...agent.profile, avatar: { ...avatar, imageRef, image: null } },
      };
    }
    if (avatar.imageRef) {
      const found = yield* sql<{
        id: string;
      }>`SELECT id FROM workbench_agent_assets WHERE id=${avatar.imageRef}`;
      if (!found.length) return yield* failure("invalid_import");
    }
    return agent;
  });
  const read = Effect.fn("AgentWorkspace.read")(function* (id: string) {
    const rows = yield* sql<{
      document: string;
    }>`SELECT document FROM workbench_agents WHERE id=${id}`.pipe(
      Effect.mapError(() => failure("storage")),
    );
    if (!rows[0]) return yield* failure("not_found");
    return yield* decode(rows[0].document).pipe(
      Effect.mapError(() => failure("storage")),
      Effect.flatMap(hydrateAvatar),
    );
  });
  const list = Effect.gen(function* () {
    const rows = yield* sql<{
      document: string;
    }>`SELECT document FROM workbench_agents ORDER BY rowid`.pipe(
      Effect.mapError(() => failure("storage")),
    );
    return yield* Effect.forEach(rows, (r) =>
      decode(r.document).pipe(
        Effect.mapError(() => failure("storage")),
        Effect.flatMap(hydrateAvatar),
      ),
    );
  });
  const blockedToolGroups = Effect.fn("AgentWorkspace.blockedToolGroups")(function* (
    threadId: string,
  ) {
    // The thread-to-agent link lives inside the JSON document, so this scans the (small) agents
    // table with SQLite's JSON functions instead of decoding every document, archive included.
    // Measured cost is dominated by reading the stored documents, so it grows with archive size.
    const rows = yield* sql<{
      blocked: string | null;
    }>`SELECT json_extract(document, '$.profile.blockedToolGroups') AS blocked
      FROM workbench_agents
      WHERE json_valid(document) AND (
        json_extract(document, '$.primaryThreadId') = ${threadId}
        OR EXISTS (SELECT 1 FROM json_each(document, '$.threadIds') WHERE value = ${threadId})
      )
      ORDER BY json_extract(document, '$.primaryThreadId') = ${threadId} DESC
      LIMIT 1`.pipe(Effect.mapError(() => failure("storage")));
    const stored = rows[0]?.blocked;
    if (stored === null || stored === undefined) return [];
    const parsed = decodeBlockedGroups(stored);
    return parsed._tag === "Some" ? parsed.value.filter(isToolGroup) : [];
  });
  const threadAgent = Effect.fn("AgentWorkspace.threadAgent")(function* (threadId: string) {
    const rows = yield* sql<{
      id: string | null;
      archived_at: string | null;
    }>`SELECT json_extract(document, '$.profile.id') AS id,
        json_extract(document, '$.archivedAt') AS archived_at
      FROM workbench_agents
      WHERE json_valid(document) AND (
        json_extract(document, '$.primaryThreadId') = ${threadId}
        OR EXISTS (SELECT 1 FROM json_each(document, '$.threadIds') WHERE value = ${threadId})
      )
      ORDER BY json_extract(document, '$.primaryThreadId') = ${threadId} DESC
      LIMIT 1`.pipe(Effect.mapError(() => failure("storage")));
    const found = rows[0];
    if (found === undefined || found.id === null) return null;
    return { agentId: found.id, archived: found.archived_at !== null && found.archived_at !== "" };
  });
  const write = Effect.fn("AgentWorkspace.write")(function* (
    input: SaveInput,
    goalsFrom: "stored" | "input",
  ) {
    const { goals: inputGoals, ...valid } = yield* decodeAgent(input.agent).pipe(
      Effect.mapError(() => failure("invalid_import")),
    );
    let goals = inputGoals;
    let profile = valid.profile;
    if (valid.archive && valid.archive.id !== valid.profile.id)
      return yield* failure("invalid_import");
    if (
      (valid.archive || valid.profile.id.startsWith("grok-bot:")) &&
      valid.recovery.disposition === "ready" &&
      (!valid.recovery.verifiedAt ||
        !valid.recovery.evidence.length ||
        valid.recovery.blockers.length)
    )
      return yield* failure("recovery_required");
    if (input.expectedRevision > 0) {
      const previous = yield* read(valid.profile.id);
      if (previous.revision !== input.expectedRevision) return yield* failure("conflict");
      if (encodeArchive(previous.archive) !== encodeArchive(valid.archive))
        return yield* failure("invalid_import");
      if (goalsFrom === "stored") goals = previous.goals;
      // A client that predates tool access decodes the profile without the field and sends it
      // back without it. Only an explicit list, even an empty one, changes what is stored.
      if (profile.blockedToolGroups === undefined && previous.profile.blockedToolGroups) {
        profile = { ...profile, blockedToolGroups: previous.profile.blockedToolGroups };
      }
    } else if (goalsFrom === "stored") {
      goals = undefined;
    }
    const next: WorkspaceAgent = {
      ...valid,
      profile,
      ...(goals === undefined ? {} : { goals }),
      revision: input.expectedRevision + 1,
      updatedAt: yield* timestamp,
    };
    const saved = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const others = yield* list;
          const bindings = new Set([
            ...(next.threadIds ?? []),
            ...(next.primaryThreadId ? [next.primaryThreadId] : []),
          ]);
          if (
            others.some(
              (a) =>
                a.profile.id !== next.profile.id &&
                [a.primaryThreadId, ...(a.threadIds ?? [])].some((id) => id && bindings.has(id)),
            )
          )
            return yield* failure("conflict");
          const stored = yield* persistAvatar(next);
          const rows =
            input.expectedRevision === 0
              ? yield* sql`INSERT INTO workbench_agents (id,revision,document) VALUES (${stored.profile.id},${stored.revision},${encodeAgent(stored)}) ON CONFLICT(id) DO NOTHING RETURNING id`
              : yield* sql`UPDATE workbench_agents SET revision=${stored.revision}, document=${encodeAgent(stored)} WHERE id=${stored.profile.id} AND revision=${input.expectedRevision} RETURNING id`;
          if (rows.length !== 1) return yield* failure("conflict");
          return stored;
        }),
      )
      .pipe(Effect.catchTag("SqlError", () => Effect.fail(failure("storage"))));
    return yield* hydrateAvatar(saved);
  });
  const save = (input: SaveInput) => write(input, "stored");
  const saveGoals = (input: SaveInput) => write(input, "input");
  const importAgents = Effect.fn("AgentWorkspace.import")(function* (input: ImportInput) {
    const importPayload = encodeImport(input);
    if (Buffer.byteLength(importPayload, "utf8") > 10 * 1024 * 1024)
      return yield* failure("invalid_import");
    const fingerprint = NodeCrypto.createHash("sha256").update(importPayload).digest("hex");
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const existing = yield* sql<{
            fingerprint: string;
            receipt: string;
          }>`SELECT fingerprint,receipt FROM workbench_agent_imports WHERE id=${input.receiptId}`;
          if (existing[0]) {
            if (existing[0].fingerprint !== fingerprint) return yield* failure("conflict");
            return yield* decodeReceipt(existing[0].receipt).pipe(
              Effect.mapError(() => failure("storage")),
            );
          }
          if (new Set(input.agents.map((a) => a.profile.id)).size !== input.agents.length)
            return yield* failure("invalid_import");
          let added = 0,
            enriched = 0;
          for (const incoming of input.agents) {
            if (incoming.archive && incoming.archive.id !== incoming.profile.id)
              return yield* failure("invalid_import");
            const rows = yield* sql<{
              document: string;
            }>`SELECT document FROM workbench_agents WHERE id=${incoming.profile.id}`;
            const previous = rows[0]
              ? yield* decode(rows[0].document).pipe(Effect.mapError(() => failure("storage")))
              : null;
            const bindings = incoming.threadIds ?? [];
            const allAgents = yield* list;
            if (
              allAgents.some(
                (a) =>
                  a.profile.id !== incoming.profile.id &&
                  [a.primaryThreadId, ...(a.threadIds ?? [])].some(
                    (id) => id && bindings.includes(id),
                  ),
              )
            )
              return yield* failure("conflict");
            const archive = incoming.archive
              ? {
                  ...incoming.archive,
                  messages: [
                    ...new Map(
                      [...(previous?.archive?.messages ?? []), ...incoming.archive.messages].map(
                        (m) => [m.id, m],
                      ),
                    ).values(),
                  ].sort((a, b) => (a.timestampMs ?? 0) - (b.timestampMs ?? 0)),
                }
              : (previous?.archive ?? null);
            if (archive && archive.messages.length > 5000) return yield* failure("invalid_import");
            const hasNewHistory =
              previous &&
              archive &&
              archive.messages.some(
                (m) =>
                  !(previous.archive?.messages ?? []).some(
                    (old) =>
                      old.id === m.id &&
                      old.text === m.text &&
                      old.role === m.role &&
                      old.timestampMs === m.timestampMs,
                  ),
              );
            const recovery = hasNewHistory
              ? {
                  ...previous.recovery,
                  disposition: "blocked" as const,
                  verifiedAt: null,
                  blockers: [
                    ...previous.recovery.blockers
                      .filter(
                        (b) =>
                          b !==
                          "New source history was recovered. Reconcile it with current work before continuing.",
                      )
                      .slice(0, 99),
                    "New source history was recovered. Reconcile it with current work before continuing.",
                  ],
                }
              : previous?.recovery;
            const agent: WorkspaceAgent = {
              profile: previous
                ? {
                    ...previous.profile,
                    ...(!previous.profile.avatar && incoming.profile.avatar
                      ? { avatar: incoming.profile.avatar }
                      : {}),
                  }
                : incoming.profile,
              archive,
              revision: (previous?.revision ?? 0) + 1,
              recovery: recovery ?? {
                disposition:
                  archive || incoming.profile.id.startsWith("grok-bot:") ? "blocked" : "ready",
                summary:
                  archive || incoming.profile.id.startsWith("grok-bot:")
                    ? (incoming.recoveryDraft?.summary ??
                      "Imported local cache. Active work has not been verified.")
                    : "New Workbench agent.",
                blockers:
                  archive || incoming.profile.id.startsWith("grok-bot:")
                    ? [
                        ...(incoming.recoveryDraft?.blockers ?? []),
                        "Verify latest source conversation, files, tools, and running routines before resuming.",
                      ]
                    : [],
                verifiedAt: null,
                evidence: incoming.recoveryDraft?.evidence ?? [],
              },
              memories: previous?.memories ?? [],
              // Goals are server-local: an import neither brings goals in nor drops this server's.
              ...(previous?.goals === undefined ? {} : { goals: previous.goals }),
              threadIds: [
                ...new Set([...(previous?.threadIds ?? []), ...(incoming.threadIds ?? [])]),
              ],
              routineOwnershipVerified: hasNewHistory
                ? false
                : (previous?.routineOwnershipVerified ?? false),
              archivedAt: previous?.archivedAt ?? null,
              primaryThreadId: previous?.primaryThreadId ?? incoming.threadIds?.[0] ?? null,
              updatedAt: yield* timestamp,
            };
            const stored = yield* persistAvatar(agent);
            yield* sql`INSERT INTO workbench_agents (id,revision,document) VALUES (${stored.profile.id},${stored.revision},${encodeAgent(stored)}) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,document=excluded.document`;
            if (previous) enriched++;
            else added++;
          }
          const receipt = {
            receiptId: input.receiptId,
            added,
            enriched,
            importedAt: yield* timestamp,
          };
          yield* sql`INSERT INTO workbench_agent_imports (id,fingerprint,payload,receipt) VALUES (${input.receiptId},${fingerprint},${encodeImport(input)},${encodeReceipt(receipt)})`;
          return receipt;
        }),
      )
      .pipe(Effect.catchTag("SqlError", () => Effect.fail(failure("storage"))));
  });
  const prepare = Effect.fn("AgentWorkspace.prepare")(function* (
    input: typeof AgentContinuationInput.Type,
  ) {
    return prepareAgentContinuation(yield* read(input.id), input.maxCharacters);
  });
  const enrichMessage = Effect.fn("AgentWorkspace.enrichMessage")(function* (input: {
    commandId: string;
    threadId: string;
    text: string;
    scheduled: boolean;
    acceptedReplay?: boolean;
  }) {
    const fingerprint = NodeCrypto.createHash("sha256")
      .update(input.threadId + "\n" + input.text + "\n" + String(input.scheduled))
      .digest("hex");
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const prior = yield* sql<{
            fingerprint: string;
            text: string;
          }>`SELECT fingerprint,text FROM workbench_agent_contexts WHERE command_id=${input.commandId}`;
          if (prior[0]) {
            if (prior[0].fingerprint !== fingerprint) return yield* failure("conflict");
            // Only the orchestrator may attest that this command already has an accepted receipt.
            if (input.acceptedReplay) return prior[0].text;
          }
          const candidates = yield* list;
          const agent = candidates.find(
            (a) => a.primaryThreadId === input.threadId || a.threadIds?.includes(input.threadId),
          );
          if (!agent) {
            if (prior[0]) return yield* failure("recovery_required");
            return input.text;
          }
          if (agent.archivedAt) return yield* failure("recovery_required");
          if (
            (agent.archive || agent.profile.id.startsWith("grok-bot:")) &&
            (agent.recovery.disposition !== "ready" || agent.recovery.blockers.length)
          )
            return yield* failure("recovery_required");
          if (
            input.scheduled &&
            (agent.archive || agent.profile.id.startsWith("grok-bot:")) &&
            !agent.routineOwnershipVerified
          )
            return yield* failure("recovery_required");
          // An interrupted attempt may have context but no accepted command. Current
          // recovery and ownership must still authorize that pending retry.
          if (prior[0]) return prior[0].text;
          const context = prepareAgentContinuation(agent, 24000);
          const request = input.text.replace(
            /^<workbench-agent>[\s\S]*?<\/workbench-agent>\s*/,
            "",
          );
          const text = `<workbench-agent>\n${context.context}\n</workbench-agent>\n\n${request}`;
          yield* sql`INSERT INTO workbench_agent_contexts (command_id,fingerprint,text) VALUES (${input.commandId},${fingerprint},${text})`;
          return text;
        }),
      )
      .pipe(Effect.catchTag("SqlError", () => Effect.fail(failure("storage"))));
  });
  return AgentWorkspace.of({
    list,
    blockedToolGroups,
    threadAgent,
    read,
    save,
    saveGoals,
    importAgents,
    prepare,
    enrichMessage,
  });
});
export const layer = Layer.effect(AgentWorkspace, make);
