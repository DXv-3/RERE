import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { WorkbenchAgentProfile } from "@t3tools/contracts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as Agents from "./AgentWorkspace.ts";
const layer = Agents.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory));
const image =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=";
const profile: WorkbenchAgentProfile = {
  id: "image-agent",
  name: "Image Agent",
  description: "",
  instructions: "",
  color: "#123456",
  pinned: true,
  projectKey: "",
  runtimeMode: "approval-required",
  modelSelection: null,
  avatar: { kind: "image", image, color: "#123456", shape: "circle", icon: "bot" },
};
it.effect(
  "deduplicates avatar bytes, hydrates references, and preserves recoverability after reset",
  () =>
    Effect.gen(function* () {
      const service = yield* Agents.AgentWorkspace;
      const sql = yield* SqlClient.SqlClient;
      yield* service.importAgents({
        receiptId: "images",
        agents: [
          { profile, archive: null },
          { profile: { ...profile, id: "second" }, archive: null },
        ],
      });
      const agents = yield* service.list;
      expect(agents[0]?.profile.avatar?.image).toBe(image);
      expect(agents[0]?.profile.avatar?.imageRef).toMatch(/^[a-f0-9]{64}$/);
      expect(agents[1]?.profile.avatar?.imageRef).toBe(agents[0]?.profile.avatar?.imageRef);
      expect(yield* sql`SELECT id FROM workbench_agent_assets`).toHaveLength(1);
      const documents = yield* sql<{
        image: string | null;
        ref: string;
      }>`SELECT json_extract(document,'$.profile.avatar.image') AS image,json_extract(document,'$.profile.avatar.imageRef') AS ref FROM workbench_agents`;
      expect(
        documents.every((d) => d.image === null && d.ref === agents[0]?.profile.avatar?.imageRef),
      ).toBe(true);
      const first = agents[0]!;
      const reset = yield* service.save({
        agent: {
          ...first,
          profile: {
            ...first.profile,
            avatar: { ...first.profile.avatar!, kind: "bot", image: null, imageRef: null },
          },
        },
        expectedRevision: first.revision,
      });
      expect(reset.profile.avatar?.image).toBeNull();
      expect((yield* service.read(first.profile.id)).profile.avatar?.imageRef).toBeNull();
      expect((yield* service.read("second")).profile.avatar?.image).toBe(image);
      expect(yield* sql`SELECT id FROM workbench_agent_assets`).toHaveLength(1);
    }).pipe(Effect.provide(layer)),
);
it.effect(
  "unknown references fail atomically and missing stored assets report storage failure",
  () =>
    Effect.gen(function* () {
      const service = yield* Agents.AgentWorkspace;
      const sql = yield* SqlClient.SqlClient;
      const result = yield* Effect.flip(
        service.importAgents({
          receiptId: "bad-image",
          agents: [
            { profile, archive: null },
            {
              profile: {
                ...profile,
                id: "missing",
                avatar: { ...profile.avatar!, image: null, imageRef: "a".repeat(64) },
              },
              archive: null,
            },
          ],
        }),
      );
      expect(result.reason).toBe("invalid_import");
      expect(yield* service.list).toHaveLength(0);
      expect(yield* sql`SELECT id FROM workbench_agent_assets`).toHaveLength(0);
      yield* service.importAgents({
        receiptId: "good-image",
        agents: [{ profile, archive: null }],
      });
      yield* sql`DELETE FROM workbench_agent_assets`;
      expect((yield* Effect.flip(service.read(profile.id))).reason).toBe("storage");
    }).pipe(Effect.provide(layer)),
);
