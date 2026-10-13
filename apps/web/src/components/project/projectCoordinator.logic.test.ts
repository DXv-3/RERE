import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { coordinatorThreadTitle, findLiveCoordinatorThreadId } from "./projectCoordinator.logic";

const environmentId = EnvironmentId.make("env-a");
const coordinatorThreadId = ThreadId.make("coordinator");
const project = { environmentId, coordinatorThreadId };
const thread = (overrides: { environmentId?: EnvironmentId; archivedAt?: string | null } = {}) => ({
  environmentId: overrides.environmentId ?? environmentId,
  id: coordinatorThreadId,
  archivedAt: overrides.archivedAt ?? null,
});

describe("findLiveCoordinatorThreadId", () => {
  it("finds the recorded coordinator thread", () => {
    expect(findLiveCoordinatorThreadId(project, [thread()])).toBe(coordinatorThreadId);
  });

  it("treats a project that never had a coordinator as having none", () => {
    expect(findLiveCoordinatorThreadId({ environmentId }, [thread()])).toBeNull();
    expect(
      findLiveCoordinatorThreadId({ environmentId, coordinatorThreadId: null }, [thread()]),
    ).toBeNull();
  });

  it("treats an archived or deleted coordinator as gone", () => {
    expect(
      findLiveCoordinatorThreadId(project, [thread({ archivedAt: "2026-10-10T00:00:00.000Z" })]),
    ).toBeNull();
    expect(findLiveCoordinatorThreadId(project, [])).toBeNull();
  });

  it("does not match a thread with the same id on another machine", () => {
    expect(
      findLiveCoordinatorThreadId(project, [
        thread({ environmentId: EnvironmentId.make("env-b") }),
      ]),
    ).toBeNull();
  });
});

describe("coordinatorThreadTitle", () => {
  it("names the conversation after the project", () => {
    expect(coordinatorThreadTitle("Payments API")).toBe("Payments API Coordinator");
  });
});
