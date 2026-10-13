import { describe, expect, it } from "vite-plus/test";

import { EnvironmentId, type SkillPackSummary } from "@t3tools/contracts";

import {
  DOWNLOADED_GROUP,
  MY_SKILLS_GROUP,
  PLUGIN_GROUP,
  REVIEWED_GROUP,
  availableCount,
  describeSkillFailure,
  filterSkills,
  isAvailable,
  machineCounts,
  mergeCatalogs,
  mergePacks,
  partialNote,
  showsOffFilter,
  skillGroup,
  skillOrigin,
  skillsLoading,
  toggleTargets,
} from "./SkillsSettings.logic";

const skill = (
  id: string,
  path: string | null,
  enabled = false,
  source = `local-library:${id}/SKILL.md`,
) => ({
  id,
  name: id,
  description: `Does ${id} things`,
  enabled,
  revision: `rev-${id}`,
  source,
  dependencies: path ? [{ path, executable: false }] : [],
});
const mine = skill("ship-it", "~/.claude/skills/ship-it/SKILL.md", true);
const ads = skill("ads-angles", "~/.codewrench/skill-library/ads/angles/SKILL.md");
const stripe = skill("stripe-pay", "/srv/data/skill-library/stripe/pay/SKILL.md", true);
const reviewed = skill("reel-review", null, false, "workbench-starter");
const plugin = skill(
  "plugin-gcloud-tools-setup",
  "~/.claude/plugins/cache/m/gcloud-tools/2.0.4/skills/setup/SKILL.md",
  true,
  "plugin-library:gcloud-tools/setup/SKILL.md",
);
const catalog = [stripe, reviewed, ads, mine, plugin];

describe("skill groups", () => {
  it("separates the user's own, plugin, downloaded and reviewed skills", () => {
    expect(skillGroup(mine)).toBe(MY_SKILLS_GROUP);
    expect(skillGroup(plugin)).toBe(PLUGIN_GROUP);
    expect(skillGroup(ads)).toBe(DOWNLOADED_GROUP);
    expect(skillGroup(stripe)).toBe(DOWNLOADED_GROUP);
    expect(skillGroup(reviewed)).toBe(REVIEWED_GROUP);
  });

  it("names the plugin or download a skill came from", () => {
    expect(skillOrigin(plugin)).toBe("gcloud-tools");
    expect(skillOrigin(ads)).toBe("ads");
    expect(skillOrigin(mine)).toBeNull();
  });
});

const mac = EnvironmentId.make("mac");
const server = EnvironmentId.make("server");
const machines = [
  { environmentId: mac, label: "MacBook Air", catalog: [mine, ads, plugin] },
  { environmentId: server, label: "candid-server", catalog: [{ ...mine, enabled: false }, stripe] },
];

describe("mergeCatalogs", () => {
  it("joins the machines by skill id and keeps each machine's own revision and switch", () => {
    const merged = mergeCatalogs(machines);
    expect(merged.map((entry) => entry.id)).toEqual([
      "ads-angles",
      "plugin-gcloud-tools-setup",
      "ship-it",
      "stripe-pay",
    ]);
    const shared = merged.find((entry) => entry.id === "ship-it")!;
    expect(shared.machines.map(({ label, enabled }) => [label, enabled])).toEqual([
      ["MacBook Air", true],
      ["candid-server", false],
    ]);
    expect(merged.find((entry) => entry.id === "stripe-pay")!.machines).toHaveLength(1);
  });

  it("shows one revision per machine, preferring the enabled one", () => {
    const old = { ...mine, revision: "old", enabled: false };
    const [entry] = mergeCatalogs([
      { environmentId: mac, label: "Mac", catalog: [old, mine, { ...old, revision: "older" }] },
    ]);
    expect(entry!.machines).toEqual([
      { environmentId: mac, label: "Mac", revision: mine.revision, enabled: true },
    ]);
  });

  it("leaves out a machine that has not answered", () => {
    expect(mergeCatalogs([{ environmentId: mac, label: "Mac", catalog: null }])).toEqual([]);
  });
});

describe("counts and notes", () => {
  const merged = mergeCatalogs(machines);
  it("lists each machine with its own count, and says when one is unavailable", () => {
    expect(machineCounts(machines)).toEqual([
      "MacBook Air · 2 available",
      "candid-server · 1 available",
    ]);
    expect(machineCounts([{ environmentId: mac, label: "Mac", catalog: null }])).toEqual([
      "Mac · unavailable",
    ]);
  });

  it("counts a skill as available when it is on anywhere", () => {
    expect(availableCount(merged)).toBe(3);
  });

  it("notes a skill that is on for only some machines", () => {
    const byId = (id: string) => merged.find((entry) => entry.id === id)!;
    expect(partialNote(byId("ship-it"), 2)).toBe("on 1 of 2 machines");
    expect(partialNote(byId("stripe-pay"), 2)).toBe("on 1 of 2 machines");
    expect(partialNote(byId("ads-angles"), 2)).toBeNull();
    expect(partialNote(byId("ship-it"), 1)).toBeNull();
    expect(isAvailable(byId("ship-it"))).toBe(false);
    expect(isAvailable(byId("stripe-pay"))).toBe(true);
  });
});

describe("toggleTargets", () => {
  const merged = mergeCatalogs(machines);
  it("applies to every machine that has the skill and is not already there", () => {
    const targets = toggleTargets(
      merged.filter((entry) => entry.id === "ship-it"),
      true,
    );
    expect(targets).toEqual([
      { environmentId: server, label: "candid-server", id: "ship-it", revision: mine.revision },
    ]);
    expect(
      toggleTargets(
        merged.filter((entry) => entry.id === "stripe-pay"),
        true,
      ),
    ).toEqual([]);
  });

  it("turns a search result off on each machine that holds it", () => {
    const targets = toggleTargets(merged, false);
    expect(targets.map(({ label, id }) => `${label}:${id}`)).toEqual([
      "MacBook Air:plugin-gcloud-tools-setup",
      "MacBook Air:ship-it",
      "candid-server:stripe-pay",
    ]);
  });
});

describe("filterSkills", () => {
  const merged = mergeCatalogs(machines);
  const ids = (filter: Parameters<typeof filterSkills>[1]) =>
    filterSkills(merged, filter).map((entry) => entry.id);

  it("matches every search word against the id, name and description", () => {
    expect(ids({ query: "", offOnly: false })).toHaveLength(4);
    expect(ids({ query: "does PAY", offOnly: false })).toEqual(["stripe-pay"]);
    expect(ids({ query: "nothing here", offOnly: false })).toEqual([]);
  });

  it("can show only what is not on everywhere", () => {
    expect(ids({ query: "", offOnly: true })).toEqual(["ads-angles", "ship-it"]);
  });

  it("offers Show Off Only only for a long list", () => {
    expect(showsOffFilter(50)).toBe(false);
    expect(showsOffFilter(51)).toBe(true);
  });
});

describe("describeSkillFailure", () => {
  it("tells a missing administrator right apart from catalog problems", () => {
    expect(describeSkillFailure({ _tag: "EnvironmentAuthorizationError" })).toContain(
      "administrator access",
    );
    expect(
      describeSkillFailure({ _tag: "ManagedSkillError", reason: "library_missing" }),
    ).toContain("~/.claude/skills");
    expect(describeSkillFailure(new Error("socket closed"))).toContain("Could not reach");
  });
});

describe("skill packs", () => {
  const source = {
    id: "gsap",
    repositoryUrl: "https://github.com/greensock/gsap-skills",
    commit: "a".repeat(40),
    license: "MIT",
    installedCommit: null,
  };
  const pack = (change: Partial<SkillPackSummary> = {}): SkillPackSummary => ({
    id: "video-and-motion",
    title: "Video and Motion",
    description: "Make videos.",
    sources: [source],
    installed: false,
    skillCount: 8,
    updateAvailable: false,
    ...change,
  });
  const a = EnvironmentId.make("a");
  const b = EnvironmentId.make("b");

  it("offers Install while any machine lacks the pack, and changes only those machines", () => {
    const [row] = mergePacks([
      { environmentId: a, packs: [pack({ installed: true })] },
      { environmentId: b, packs: [pack()] },
    ]);
    expect(row).toMatchObject({ state: "install", changeOn: [b], installedOn: [a] });
  });

  it("offers Update when installed copies are behind the pinned commits, else shows Installed", () => {
    expect(
      mergePacks([
        { environmentId: a, packs: [pack({ installed: true, updateAvailable: true })] },
      ])[0],
    ).toMatchObject({ state: "update", changeOn: [a], installedOn: [a] });
    expect(mergePacks([{ environmentId: a, packs: [pack({ installed: true })] }])[0]).toMatchObject(
      { state: "installed", changeOn: [], installedOn: [a] },
    );
  });

  it("skips machines that did not answer", () => {
    expect(mergePacks([{ environmentId: a, packs: null }])).toEqual([]);
  });

  it("says what went wrong in plain words", () => {
    expect(describeSkillFailure({ _tag: "SkillPackError", reason: "git_missing" })).toContain(
      "Git",
    );
    expect(describeSkillFailure({ _tag: "SkillPackError", reason: "download_failed" })).toContain(
      "internet",
    );
    expect(describeSkillFailure({ _tag: "SkillPackError", reason: "too_large" })).toContain(
      "limit",
    );
  });
});

describe("skillsLoading", () => {
  const budget = {
    status: "ready" as const,
    timeZone: "America/New_York",
    day: "2026-10-06",
    capMicroUsd: 1_000_000,
    spentMicroUsd: 0,
    heldMicroUsd: 0,
    availableMicroUsd: 1_000_000,
    unresolvedRequests: 0,
    halted: false,
  };
  const on = {
    skillListing: "selected" as const,
    mode: "automatic" as const,
    jevConfigured: true,
    selectionBudget: budget,
  };
  const one = (preview: Parameters<typeof skillsLoading>[0]["machines"][number]["preview"]) =>
    skillsLoading({ machines: [{ label: "Mac", preview }], available: 141 });

  it("says nothing until a machine has answered", () => {
    expect(one(null)).toBeNull();
    expect(skillsLoading({ machines: [], available: 0 })).toBeNull();
  });

  it("explains each way skills reach a message", () => {
    expect(one(on)).toEqual({
      checked: true,
      description:
        "Jev picks from your 141 skills for each message. None of them cost tokens until one is used.",
    });
    expect(one({ ...on, skillListing: "all" })).toEqual({
      checked: false,
      description:
        "Every provider lists all of its own skills in every session, which costs tokens whether or not a skill is used.",
    });
    expect(one({ ...on, mode: "advisory" })?.description).toContain(
      "providers still list their own skills",
    );
    expect(
      skillsLoading({ machines: [{ label: "Mac", preview: on }], available: 1 })?.description,
    ).toContain("1 skill for");
  });

  it("says what happens when Jev is not connected or its budget is gone", () => {
    const named = "only skills you name with $ or /name are attached";
    expect(one({ ...on, jevConfigured: false })?.description).toContain(named);
    expect(
      one({ ...on, selectionBudget: { ...budget, availableMicroUsd: 100 } })?.description,
    ).toContain("budget is spent");
    expect(one({ ...on, selectionBudget: { ...budget, halted: true } })?.description).toContain(
      named,
    );
    expect(one({ ...on, selectionBudget: { status: "unavailable" } })?.description).toContain(
      "could not be read",
    );
    expect(one({ ...on, jevConfigured: false })?.checked).toBe(true);
  });

  it("is off, and names who is on, when the machines disagree", () => {
    const result = skillsLoading({
      machines: [
        { label: "Mac", preview: on },
        { label: "candid-server", preview: { ...on, skillListing: "all" } },
      ],
      available: 5,
    });
    expect(result?.checked).toBe(false);
    expect(result?.description).toContain("Only Mac loads just the skills each message needs");
  });

  it("names the machine that has a problem when several are on", () => {
    const result = skillsLoading({
      machines: [
        { label: "Mac", preview: on },
        { label: "candid-server", preview: { ...on, jevConfigured: false } },
      ],
      available: 5,
    });
    expect(result?.checked).toBe(true);
    expect(result?.description).toMatch(/^candid-server: Jev is not connected/);
  });
});
