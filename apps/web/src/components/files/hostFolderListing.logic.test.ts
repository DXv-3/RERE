import { describe, expect, it } from "vite-plus/test";

import { hostFolderRows } from "./hostFolderListing.logic";

describe("hostFolderRows", () => {
  it("lists the folder's own children with absolute paths, folders first", () => {
    expect(
      hostFolderRows("/home/agents/samples/", [
        { path: "flux-b.png", kind: "file" },
        { path: "flux-a.png", kind: "file" },
        { path: "raw", kind: "directory" },
        { path: "raw/one.png", kind: "file" },
        { path: "nested/deep/two.png", kind: "file" },
      ]),
    ).toEqual([
      { name: "nested", path: "/home/agents/samples/nested", kind: "directory" },
      { name: "raw", path: "/home/agents/samples/raw", kind: "directory" },
      { name: "flux-a.png", path: "/home/agents/samples/flux-a.png", kind: "file" },
      { name: "flux-b.png", path: "/home/agents/samples/flux-b.png", kind: "file" },
    ]);
  });

  it("returns nothing for an empty folder", () => {
    expect(hostFolderRows("/tmp/empty", [])).toEqual([]);
  });
});
