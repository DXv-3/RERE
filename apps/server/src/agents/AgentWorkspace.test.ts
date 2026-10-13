import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { type WorkbenchAgentGoal, type WorkbenchAgentProfile } from "@t3tools/contracts";
import * as SqlitePersistence from "../persistence/Layers/Sqlite.ts";
import * as AgentWorkspace from "./AgentWorkspace.ts";
import { prepareAgentContinuation } from "./continuation.ts";
const layer = AgentWorkspace.layer.pipe(Layer.provide(SqlitePersistence.SqlitePersistenceMemory));
const profile: WorkbenchAgentProfile = {
  id: "grok-bot:1",
  name: "Operations",
  description: "",
  instructions: "Keep working carefully",
  color: "#f97316",
  pinned: true,
  projectKey: "",
  runtimeMode: "approval-required",
  modelSelection: null,
};
const incoming = {
  receiptId: "first",
  agents: [
    {
      profile,
      archive: {
        id: profile.id,
        sourceId: "1",
        name: "Operations",
        importedAt: "2026-10-03",
        exportedAt: "2026-10-02",
        sourceSettings: {},
        messages: [{ id: "m1", role: "user" as const, text: "An old request", timestampMs: 1 }],
      },
    },
  ],
};
it.effect("imports atomically, replays receipts, and preserves user edits on enrichment", () =>
  Effect.gen(function* () {
    const service = yield* AgentWorkspace.AgentWorkspace;
    expect(yield* service.importAgents(incoming)).toMatchObject({ added: 1, enriched: 0 });
    expect(yield* service.importAgents(incoming)).toMatchObject({ added: 1, enriched: 0 });
    const first = yield* service.read(profile.id);
    expect(first.recovery.disposition).toBe("blocked");
    yield* service.save({
      agent: { ...first, profile: { ...first.profile, name: "My Operations" } },
      expectedRevision: first.revision,
    });
    yield* service.importAgents({
      ...incoming,
      receiptId: "second",
      agents: [
        {
          ...incoming.agents[0]!,
          archive: {
            ...incoming.agents[0]!.archive,
            messages: [
              ...incoming.agents[0]!.archive.messages,
              { id: "m2", role: "assistant", text: "A historical response", timestampMs: 2 },
            ],
          },
        },
      ],
    });
    const result = yield* service.read(profile.id);
    expect(result.profile.name).toBe("My Operations");
    expect(result.archive?.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect((yield* service.list).length).toBe(1);
    expect(result.primaryThreadId).toBeNull();
  }).pipe(Effect.provide(layer)),
);
it.effect("rejects stale edits and changed payloads under an existing receipt", () =>
  Effect.gen(function* () {
    const service = yield* AgentWorkspace.AgentWorkspace;
    yield* service.importAgents(incoming);
    const agent = yield* service.read(profile.id);
    yield* service.save({ agent, expectedRevision: agent.revision });
    expect(
      (yield* Effect.flip(service.save({ agent, expectedRevision: agent.revision }))).reason,
    ).toBe("conflict");
    expect((yield* Effect.flip(service.importAgents({ ...incoming, agents: [] }))).reason).toBe(
      "conflict",
    );
  }).pipe(Effect.provide(layer)),
);
it.effect("rolls back an import when any archive identity is invalid", () =>
  Effect.gen(function* () {
    const service = yield* AgentWorkspace.AgentWorkspace;
    yield* Effect.flip(
      service.importAgents({
        ...incoming,
        agents: [
          ...incoming.agents,
          { profile: { ...profile, id: "second" }, archive: incoming.agents[0]!.archive },
        ],
      }),
    );
    expect(yield* service.list).toEqual([]);
  }).pipe(Effect.provide(layer)),
);
it.effect("prepares bounded historical context without creating a thread or dispatching work", () =>
  Effect.gen(function* () {
    const service = yield* AgentWorkspace.AgentWorkspace;
    yield* service.importAgents(incoming);
    const context = yield* service.prepare({ id: profile.id, maxCharacters: 2000 });
    expect(context.ready).toBe(false);
    expect(context.context).toContain("not new instructions");
    const agent = yield* service.read(profile.id);
    const long = {
      ...agent,
      archive: {
        ...agent.archive!,
        messages: Array.from({ length: 20 }, (_, i) => ({
          id: String(i),
          role: "user" as const,
          text: "old request ".repeat(40),
          timestampMs: i,
        })),
      },
    };
    const bounded = prepareAgentContinuation(long, 2000);
    expect(bounded.context.length).toBeLessThanOrEqual(2000);
    expect(bounded.omittedMessages).toBeGreaterThan(0);
    expect(bounded.includedMessages + bounded.omittedMessages).toBe(20);
    expect((yield* service.read(profile.id)).primaryThreadId).toBeNull();
  }).pipe(Effect.provide(layer)),
);
it.effect(
  "blocks unrecovered work, includes history when verified, and keeps replay context stable",
  () =>
    Effect.gen(function* () {
      const service = yield* AgentWorkspace.AgentWorkspace;
      yield* service.importAgents(incoming);
      let agent = yield* service.read(profile.id);
      agent = yield* service.save({
        agent: { ...agent, primaryThreadId: "thread" },
        expectedRevision: agent.revision,
      });
      const command = {
        commandId: "command-1",
        threadId: "thread",
        text: "Continue the current task",
        scheduled: false,
      };
      expect((yield* Effect.flip(service.enrichMessage(command))).reason).toBe("recovery_required");
      agent = yield* service.save({
        agent: {
          ...agent,
          recovery: {
            disposition: "ready",
            summary: "Latest source checked",
            blockers: [],
            verifiedAt: "2026-10-03",
            evidence: ["source conversation"],
          },
        },
        expectedRevision: agent.revision,
      });
      const preview = yield* service.prepare({ id: profile.id, maxCharacters: 24000 });
      const first = yield* service.enrichMessage(command);
      expect(first).toContain(preview.context);
      expect(preview.context).toContain(profile.instructions);
      expect(first).toContain("An old request");
      expect(first.endsWith("Continue the current task")).toBe(true);
      agent = yield* service.save({
        agent: {
          ...agent,
          memories: [{ id: "memory", text: "New memory", origin: "user", sources: [] }],
        },
        expectedRevision: agent.revision,
      });
      expect(yield* service.enrichMessage(command)).toBe(first);
      expect(
        (yield* Effect.flip(service.enrichMessage({ ...command, text: "Changed request" }))).reason,
      ).toBe("conflict");
      expect(
        (yield* Effect.flip(
          service.enrichMessage({ ...command, commandId: "scheduled", scheduled: true }),
        )).reason,
      ).toBe("recovery_required");
      expect(
        yield* service.enrichMessage({ ...command, commandId: "unbound", threadId: "different" }),
      ).toBe(command.text);
    }).pipe(Effect.provide(layer)),
);
it.effect(
  "retains avatar, memory, bindings and recoverable archive state while preventing thread ownership conflicts",
  () =>
    Effect.gen(function* () {
      const service = yield* AgentWorkspace.AgentWorkspace;
      yield* service.importAgents(incoming);
      let agent = yield* service.read(profile.id);
      agent = yield* service.save({
        agent: {
          ...agent,
          profile: {
            ...agent.profile,
            avatar: {
              kind: "image",
              shape: "cloud",
              color: "#ff0000",
              icon: "bot",
              image: "data:image/png;base64,AAAA",
            },
          },
          primaryThreadId: "owned",
          archivedAt: "2026-10-03",
          memories: [{ id: "note", text: "User memory", origin: "user", sources: ["message:m1"] }],
        },
        expectedRevision: agent.revision,
      });
      yield* service.importAgents({ ...incoming, receiptId: "refresh" });
      const refreshed = yield* service.read(profile.id);
      expect(refreshed.profile.avatar).toEqual(agent.profile.avatar);
      expect(refreshed.archivedAt).toBe("2026-10-03");
      expect(refreshed.memories).toEqual(agent.memories);
      expect(
        yield* Effect.isFailure(
          service.save({
            agent: {
              ...agent,
              profile: { ...agent.profile, id: "other" },
              archive: null,
              revision: 0,
            },
            expectedRevision: 0,
          }),
        ),
      ).toBe(true);
      expect(
        yield* Effect.isFailure(
          service.save({
            agent: {
              ...refreshed,
              recovery: { ...refreshed.recovery, disposition: "ready", blockers: [] },
            },
            expectedRevision: refreshed.revision,
          }),
        ),
      ).toBe(true);
      expect(
        (yield* service.save({
          agent: { ...refreshed, archivedAt: null },
          expectedRevision: refreshed.revision,
        })).archivedAt,
      ).toBeNull();
    }).pipe(Effect.provide(layer)),
);
it.effect("newly recovered history invalidates an earlier continuation and routine approval", () =>
  Effect.gen(function* () {
    const service = yield* AgentWorkspace.AgentWorkspace;
    yield* service.importAgents(incoming);
    const agent = yield* service.read(profile.id);
    yield* service.save({
      agent: {
        ...agent,
        recovery: {
          disposition: "ready",
          summary: "Checked",
          evidence: ["source"],
          blockers: [],
          verifiedAt: "2026-10-03",
        },
        routineOwnershipVerified: true,
      },
      expectedRevision: agent.revision,
    });
    yield* service.importAgents({
      ...incoming,
      receiptId: "newer",
      agents: [
        {
          ...incoming.agents[0]!,
          archive: {
            ...incoming.agents[0]!.archive,
            messages: [
              { id: "new", role: "user", text: "A newer unresolved request", timestampMs: 5 },
            ],
          },
        },
      ],
    });
    const recovered = yield* service.read(profile.id);
    expect(recovered.recovery.disposition).toBe("blocked");
    expect(recovered.routineOwnershipVerified).toBe(false);
    expect(recovered.archive?.messages).toHaveLength(2);
  }).pipe(Effect.provide(layer)),
);
it.effect("missing imported history is not treated as a fresh ready agent", () =>
  Effect.gen(function* () {
    const service = yield* AgentWorkspace.AgentWorkspace;
    yield* service.importAgents({
      receiptId: "missing-history",
      agents: [{ profile, archive: null }],
    });
    let agent = yield* service.read(profile.id);
    expect(agent.recovery.disposition).toBe("blocked");
    agent = yield* service.save({
      agent: { ...agent, primaryThreadId: "missing-history-thread" },
      expectedRevision: agent.revision,
    });
    expect(
      yield* Effect.isFailure(
        service.enrichMessage({
          commandId: "missing-send",
          threadId: "missing-history-thread",
          text: "Continue",
          scheduled: false,
        }),
      ),
    ).toBe(true);
  }).pipe(Effect.provide(layer)),
);

it.effect.each(["archived", "ownership-revoked", "new-history"] as const)(
  "a cached but unaccepted continuation cannot bypass %s",
  (change) =>
    Effect.gen(function* () {
      const service = yield* AgentWorkspace.AgentWorkspace;
      yield* service.importAgents(incoming);
      let agent = yield* service.read(profile.id);
      agent = yield* service.save({
        agent: {
          ...agent,
          primaryThreadId: "pending-thread",
          routineOwnershipVerified: true,
          recovery: {
            disposition: "ready",
            summary: "Reviewed",
            evidence: ["original checked"],
            blockers: [],
            verifiedAt: "2026-10-03",
          },
        },
        expectedRevision: agent.revision,
      });
      const command = {
        commandId: "pending-command",
        threadId: "pending-thread",
        text: "New request",
        scheduled: true,
      };
      const prepared = yield* service.enrichMessage(command);
      expect(prepared).toContain("An old request");
      if (change === "new-history") {
        yield* service.importAgents({
          ...incoming,
          receiptId: "later-source",
          agents: [
            {
              ...incoming.agents[0]!,
              archive: {
                ...incoming.agents[0]!.archive,
                messages: [{ id: "new", role: "user", text: "Changed task", timestampMs: 3 }],
              },
            },
          ],
        });
      } else {
        yield* service.save({
          agent: {
            ...agent,
            ...(change === "archived"
              ? { archivedAt: "2026-10-03" }
              : { routineOwnershipVerified: false }),
          },
          expectedRevision: agent.revision,
        });
      }
      expect((yield* Effect.flip(service.enrichMessage(command))).reason).toBe("recovery_required");
    }).pipe(Effect.provide(layer)),
);

it.effect("first recovered history invalidates a previously reviewed missing-history agent", () =>
  Effect.gen(function* () {
    const service = yield* AgentWorkspace.AgentWorkspace;
    yield* service.importAgents({
      receiptId: "profile-only",
      agents: [{ profile, archive: null }],
    });
    const agent = yield* service.read(profile.id);
    yield* service.save({
      agent: {
        ...agent,
        routineOwnershipVerified: true,
        recovery: {
          disposition: "ready",
          summary: "Reviewed without history",
          blockers: [],
          evidence: ["source"],
          verifiedAt: "2026-10-03",
        },
      },
      expectedRevision: agent.revision,
    });
    yield* service.importAgents(incoming);
    const enriched = yield* service.read(profile.id);
    expect(enriched.recovery.disposition).toBe("blocked");
    expect(enriched.routineOwnershipVerified).toBe(false);
  }).pipe(Effect.provide(layer)),
);

it.effect("instructions and large memory share the same bounded, reviewable continuation", () =>
  Effect.gen(function* () {
    const service = yield* AgentWorkspace.AgentWorkspace;
    yield* service.importAgents(incoming);
    const agent = yield* service.read(profile.id);
    const instructions = "Preserve instructions. ".repeat(650);
    const saved = yield* service.save({
      agent: {
        ...agent,
        profile: { ...agent.profile, instructions },
        primaryThreadId: "bounded-thread",
        recovery: {
          disposition: "ready",
          summary: "Reviewed source",
          blockers: [],
          evidence: ["source"],
          verifiedAt: "2026-10-03",
        },
        memories: Array.from({ length: 12 }, (_, i) => ({
          id: `memory-${i}`,
          text: "Long memory ".repeat(500),
          origin: "user" as const,
          sources: ["source"],
        })),
      },
      expectedRevision: agent.revision,
    });
    const preview = yield* service.prepare({ id: saved.profile.id, maxCharacters: 24000 });
    const sent = yield* service.enrichMessage({
      commandId: "bounded-send",
      threadId: "bounded-thread",
      text: "My next task",
      scheduled: false,
    });
    const tooSmall = yield* service.prepare({ id: saved.profile.id, maxCharacters: 2000 });
    expect(tooSmall.ready).toBe(false);
    expect(tooSmall.blockers.join(" ")).toContain("Saved instructions exceed");
    expect(tooSmall.context.length).toBeLessThanOrEqual(2000);
    expect(preview.context.length).toBeLessThanOrEqual(24000);
    expect(preview.context).toContain(instructions);
    expect(preview.context).toContain("shortened");
    expect(sent.length).toBeLessThan(24100);
    expect(sent).toContain(preview.context);
    expect((yield* service.read(profile.id)).memories).toHaveLength(12);
  }).pipe(Effect.provide(layer)),
);
const goal = (id: string): WorkbenchAgentGoal => ({
  id,
  title: `Goal ${id}`,
  outcome: "Keep it done.",
  schedule: { type: "interval", everyMs: 86_400_000 } as WorkbenchAgentGoal["schedule"],
  autonomy: "propose",
  status: "active",
  scheduledTaskId: null,
  createdAt: "2026-10-04T00:00:00.000Z",
  updatedAt: "2026-10-04T00:00:00.000Z",
});
it.effect("a client save never changes goals, but saveGoals does", () =>
  Effect.gen(function* () {
    const service = yield* AgentWorkspace.AgentWorkspace;
    yield* service.importAgents(incoming);
    const imported = yield* service.read(profile.id);
    const withGoals = yield* service.saveGoals({
      agent: { ...imported, goals: [goal("g1")] },
      expectedRevision: imported.revision,
    });
    expect(withGoals.goals?.map((g) => g.id)).toEqual(["g1"]);

    // A record copied from another machine carries no goals, or different ones.
    const omitted = yield* service.save({
      agent: { ...withGoals, goals: undefined, profile: { ...withGoals.profile, name: "Renamed" } },
      expectedRevision: withGoals.revision,
    });
    expect(omitted.profile.name).toBe("Renamed");
    expect(omitted.goals?.map((g) => g.id)).toEqual(["g1"]);
    const different = yield* service.save({
      agent: { ...omitted, goals: [goal("foreign")] },
      expectedRevision: omitted.revision,
    });
    expect(different.goals?.map((g) => g.id)).toEqual(["g1"]);
    expect((yield* service.read(profile.id)).goals?.map((g) => g.id)).toEqual(["g1"]);

    // An import enriches the agent without bringing goals in or dropping this server's.
    yield* service.importAgents({ ...incoming, receiptId: "again" });
    expect((yield* service.read(profile.id)).goals?.map((g) => g.id)).toEqual(["g1"]);
  }).pipe(Effect.provide(layer)),
);
it.effect("a first save stores no goals, even when the input carries some", () =>
  Effect.gen(function* () {
    const service = yield* AgentWorkspace.AgentWorkspace;
    const saved = yield* service.save({
      agent: {
        profile: { ...profile, id: "fresh-agent" },
        revision: 0,
        archive: null,
        recovery: {
          disposition: "ready",
          summary: "",
          blockers: [],
          verifiedAt: null,
          evidence: [],
        },
        memories: [],
        primaryThreadId: null,
        goals: [goal("foreign")],
        updatedAt: "2026-10-04T00:00:00.000Z",
      },
      expectedRevision: 0,
    });
    expect(saved.goals).toBeUndefined();
    expect((yield* service.read("fresh-agent")).goals).toBeUndefined();
  }).pipe(Effect.provide(layer)),
);

const plainAgent = (id: string, threadIds: ReadonlyArray<string>, primary: string | null) => ({
  profile: { ...profile, id },
  revision: 0,
  archive: null,
  recovery: {
    disposition: "ready" as const,
    summary: "New Workbench agent.",
    blockers: [],
    verifiedAt: null,
    evidence: [],
  },
  memories: [],
  primaryThreadId: primary,
  threadIds,
  updatedAt: "2026-10-05T00:00:00.000Z",
});
it.effect("reports the tool groups switched off for the agent that owns a thread", () =>
  Effect.gen(function* () {
    const service = yield* AgentWorkspace.AgentWorkspace;
    const base = plainAgent("a1", ["t-primary", "t-extra"], "t-primary");
    const blocking = yield* service.save({
      agent: { ...base, profile: { ...base.profile, blockedToolGroups: ["preview", "device"] } },
      expectedRevision: 0,
    });
    yield* service.save({ agent: plainAgent("a2", ["t-open"], "t-open"), expectedRevision: 0 });
    expect(yield* service.blockedToolGroups("t-primary")).toEqual(["preview", "device"]);
    // Any thread the agent owns is covered, not only its primary one.
    expect(yield* service.blockedToolGroups("t-extra")).toEqual(["preview", "device"]);
    expect(yield* service.blockedToolGroups("t-open")).toEqual([]);
    expect(yield* service.blockedToolGroups("not-an-agent-thread")).toEqual([]);
    // The next read sees an edit; nothing is kept between calls.
    yield* service.save({
      agent: { ...blocking, profile: { ...blocking.profile, blockedToolGroups: [] } },
      expectedRevision: blocking.revision,
    });
    expect(yield* service.blockedToolGroups("t-primary")).toEqual([]);
  }).pipe(Effect.provide(layer)),
);
it.effect("keeps the stored tool groups when a client that predates them saves the agent", () =>
  Effect.gen(function* () {
    const service = yield* AgentWorkspace.AgentWorkspace;
    const base = plainAgent("a1", ["t1"], "t1");
    const saved = yield* service.save({
      agent: { ...base, profile: { ...base.profile, blockedToolGroups: ["worktree"] } },
      expectedRevision: 0,
    });
    // An older client decodes the profile without the field and sends it back without it.
    const { blockedToolGroups: _dropped, ...withoutField } = saved.profile;
    const afterOldClient = yield* service.save({
      agent: { ...saved, profile: { ...withoutField, name: "Renamed" } },
      expectedRevision: saved.revision,
    });
    expect(afterOldClient.profile.name).toBe("Renamed");
    expect(afterOldClient.profile.blockedToolGroups).toEqual(["worktree"]);
    expect(yield* service.blockedToolGroups("t1")).toEqual(["worktree"]);
    // An explicit empty list is how an owner switches everything back on.
    yield* service.save({
      agent: { ...afterOldClient, profile: { ...afterOldClient.profile, blockedToolGroups: [] } },
      expectedRevision: afterOldClient.revision,
    });
    expect(yield* service.blockedToolGroups("t1")).toEqual([]);
  }).pipe(Effect.provide(layer)),
);
