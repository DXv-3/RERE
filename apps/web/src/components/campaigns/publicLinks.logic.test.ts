import { describe, expect, it } from "vite-plus/test";

import { STORAGE_OFF_MESSAGE, fileLink, publicLinksState } from "./publicLinks.logic";

const post = (
  mediaPaths: string[],
  uploadedMedia: Record<string, string> = {},
  status: "draft" | "publishing" = "draft",
) => ({ mediaPaths, uploadedMedia, status }) as const;

describe("fileLink", () => {
  it("finds a link by the file's path", () => {
    expect(fileLink(post(["a.mp4"], { "a.mp4": "https://cdn/a.mp4" }), "a.mp4")).toEqual({
      state: "ready",
      url: "https://cdn/a.mp4",
    });
    expect(fileLink(post(["a.mp4"]), "a.mp4")).toEqual({ state: "missing" });
  });
});

describe("publicLinksState", () => {
  const on = { mode: "s3" } as const;
  const off = { mode: "off" } as const;

  it("says nothing when there are no folder files", () => {
    expect(publicLinksState({ post: post([]), storage: on, isAdministrator: true })).toEqual({
      ready: 0,
      total: 0,
      canGet: false,
      canStopSharing: false,
      message: null,
    });
  });

  it("says where to turn storage on", () => {
    const state = publicLinksState({ post: post(["a.png"]), storage: off, isAdministrator: true });
    expect(state.canGet).toBe(false);
    expect(state.message).toBe(STORAGE_OFF_MESSAGE);
    expect(STORAGE_OFF_MESSAGE).toContain("Settings, Connections");
  });

  it("keeps old links honest when storage is later switched off", () => {
    const state = publicLinksState({
      post: post(["a.png"], { "a.png": "https://x/a.png" }),
      storage: off,
      isAdministrator: false,
    });
    expect(state.ready).toBe(1);
    expect(state.message).toContain("Links made earlier still work");
  });

  it("offers links to an administrator while some are missing", () => {
    const state = publicLinksState({
      post: post(["a.png", "b.png"], { "a.png": "https://x/a.png" }),
      storage: on,
      isAdministrator: true,
    });
    expect(state).toMatchObject({ ready: 1, total: 2, canGet: true });
    expect(state.message).toContain("1 of 2");
  });

  it("stops offering once every file has one", () => {
    const state = publicLinksState({
      post: post(["a.png"], { "a.png": "https://x/a.png" }),
      storage: on,
      isAdministrator: true,
    });
    expect(state.canGet).toBe(false);
    expect(state.message).toContain("Every file");
  });

  it("tells others why they cannot, and does not offer while publishing", () => {
    expect(
      publicLinksState({ post: post(["a.png"]), storage: on, isAdministrator: false }),
    ).toMatchObject({ canGet: false, message: "Only an administrator can make public links." });
    expect(
      publicLinksState({
        post: post(["a.png"], {}, "publishing"),
        storage: on,
        isAdministrator: true,
      }).canGet,
    ).toBe(false);
  });

  describe("from this server", () => {
    const server = { mode: "server" } as const;
    const url = "https://code.example.com/api/campaign-media/abc/a.png";

    it("says the rest are shared from this server, not uploaded", () => {
      const state = publicLinksState({
        post: post(["a.png"]),
        storage: server,
        isAdministrator: true,
      });
      expect(state.canGet).toBe(true);
      expect(state.message).toContain("shares the rest from this server");
    });

    it("offers Stop Sharing only to an administrator, for links this server made", () => {
      const shared = post(["a.png", "b.png"], { "a.png": url, "b.png": "https://cdn/b.png" });
      expect(
        publicLinksState({ post: shared, storage: server, isAdministrator: true }),
      ).toMatchObject({
        canStopSharing: true,
      });
      expect(
        publicLinksState({ post: shared, storage: server, isAdministrator: false }),
      ).toMatchObject({
        canStopSharing: false,
      });
      expect(
        publicLinksState({
          post: post(["b.png"], { "b.png": "https://cdn/b.png" }),
          storage: server,
          isAdministrator: true,
        }).canStopSharing,
      ).toBe(false);
      expect(
        publicLinksState({
          post: post(["a.png"], { "a.png": url }, "publishing"),
          storage: server,
          isAdministrator: true,
        }).canStopSharing,
      ).toBe(false);
    });

    it("does not call this server's links working once sharing is off", () => {
      const state = publicLinksState({
        post: post(["a.png"], { "a.png": url }),
        storage: off,
        isAdministrator: true,
      });
      expect(state.message).toContain("do not work while sharing is off");
      expect(state.message).not.toContain("still work");
    });
  });
});
