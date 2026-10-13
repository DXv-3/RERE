import { describe, expect, it } from "@effect/vitest";
import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ServerSettings from "../serverSettings.ts";
import { crossProjectReach, reachProjectId } from "./agentThreadReach.ts";

const callerProject = ProjectId.make("project-caller");
const otherProject = ProjectId.make("project-other");
const otherThread = ThreadId.make("thread-other");

/** Only `projectId` is read, so the rest of the shell is left out. */
const shells = (threads: Record<string, ProjectId>) => (threadId: ThreadId) =>
  Effect.succeed(
    threadId in threads
      ? ({ id: threadId, projectId: threads[threadId] } as OrchestrationV2ThreadShell)
      : null,
  );

const withReach = (enabled: boolean) =>
  Effect.provide(ServerSettings.layerTest({ enableAgentCrossProjectAccess: enabled }));

describe("agent thread reach", () => {
  it.effect("looks a thread up in the caller's project when cross-project access is off", () =>
    Effect.gen(function* () {
      expect(
        yield* reachProjectId(callerProject, otherThread, shells({ [otherThread]: otherProject })),
      ).toBe(callerProject);
    }).pipe(withReach(false)),
  );

  it.effect("looks a thread up in its own project when cross-project access is on", () =>
    Effect.gen(function* () {
      expect(yield* crossProjectReach).toBe(true);
      expect(
        yield* reachProjectId(callerProject, otherThread, shells({ [otherThread]: otherProject })),
      ).toBe(otherProject);
    }).pipe(withReach(true)),
  );

  it.effect("falls back to the caller's project for a thread that does not exist", () =>
    Effect.gen(function* () {
      // The lookup that follows then reports the thread as not found, as it always has.
      expect(yield* reachProjectId(callerProject, otherThread, shells({}))).toBe(callerProject);
      expect(
        yield* reachProjectId(callerProject, otherThread, () => Effect.fail("store unavailable")),
      ).toBe(callerProject);
    }).pipe(withReach(true)),
  );

  it.effect("is on by default", () =>
    Effect.gen(function* () {
      expect(yield* crossProjectReach).toBe(true);
    }).pipe(Effect.provide(ServerSettings.layerTest())),
  );
});
