import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import * as Agents from "./AgentWorkspace.ts";
it.effect("recovers agents and import receipts after closing and reopening disk storage", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "workbench-agent-restart-" });
    const runtime = () =>
      Agents.layer.pipe(
        Layer.provide(makeSqlitePersistenceLive(path.join(directory, "agents.sqlite"))),
        Layer.provide(NodeServices.layer),
      );
    const input = {
      receiptId: "restart-test",
      agents: [
        {
          profile: {
            id: "test",
            name: "Recovery Pilot",
            description: "",
            instructions: "Inspect only",
            color: "#00ff00",
            pinned: true,
            projectKey: "",
            runtimeMode: "approval-required" as const,
            modelSelection: null,
            avatar: {
              kind: "image" as const,
              shape: "circle" as const,
              color: "#00ff00",
              icon: "bot",
              image: "data:image/png;base64,aGVsbG8=",
            },
          },
          archive: null,
        },
      ],
    };
    yield* Effect.gen(function* () {
      const service = yield* Agents.AgentWorkspace;
      yield* service.importAgents(input);
      const agent = yield* service.read("test");
      yield* service.save({
        agent: {
          ...agent,
          primaryThreadId: "persistent-thread",
          memories: [
            { id: "memory", text: "Retain this", origin: "user", sources: ["conversation:1"] },
          ],
        },
        expectedRevision: agent.revision,
      });
    }).pipe(Effect.provide(runtime()));
    yield* Effect.gen(function* () {
      const service = yield* Agents.AgentWorkspace;
      const receipt = yield* service.importAgents(input);
      expect(receipt.added).toBe(1);
      const agents = yield* service.list;
      expect(agents).toHaveLength(1);
      expect(agents[0]?.primaryThreadId).toBe("persistent-thread");
      expect(agents[0]?.memories[0]?.text).toBe("Retain this");
      expect(agents[0]?.profile.avatar?.imageRef).toMatch(/^[a-f0-9]{64}$/);
      expect(agents[0]?.profile.avatar?.image).toBe(input.agents[0]!.profile.avatar.image);
    }).pipe(Effect.provide(runtime()));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
