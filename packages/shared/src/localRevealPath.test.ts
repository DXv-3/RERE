import { describe, expect, it } from "vite-plus/test";

import { localRevealCandidates } from "./localRevealPath.ts";

const HOME = "/Users/ryan";

describe("localRevealCandidates", () => {
  it("expands a home-relative path under the local home", () => {
    expect(localRevealCandidates("~/Documents/installers", HOME)).toEqual([
      "/Users/ryan/Documents/installers",
    ]);
    expect(localRevealCandidates("~", HOME)).toEqual([HOME]);
  });

  it("also tries another machine's home path under the local home", () => {
    expect(localRevealCandidates("/home/agents/Documents/Codex/installers/", HOME)).toEqual([
      "/home/agents/Documents/Codex/installers/",
      "/Users/ryan/Documents/Codex/installers",
    ]);
  });

  it("keeps a path that is already under the local home as the only candidate", () => {
    expect(localRevealCandidates("/Users/ryan/Desktop/a.zip", HOME)).toEqual([
      "/Users/ryan/Desktop/a.zip",
    ]);
  });

  it("leaves paths outside any home alone", () => {
    expect(localRevealCandidates("/tmp/report.txt", HOME)).toEqual(["/tmp/report.txt"]);
  });

  it("maps onto a Windows home", () => {
    expect(localRevealCandidates("/home/agents/Documents/a", "C:\\Users\\Ryan")).toEqual([
      "/home/agents/Documents/a",
      "C:\\Users\\Ryan\\Documents\\a",
    ]);
  });

  it("refuses relative paths and paths that climb", () => {
    expect(localRevealCandidates("src/index.ts", HOME)).toEqual([]);
    expect(localRevealCandidates("~/../other/secret", HOME)).toEqual([]);
    expect(localRevealCandidates("/home/agents/../../etc", HOME)).toEqual([]);
    expect(localRevealCandidates("  ", HOME)).toEqual([]);
  });
});
