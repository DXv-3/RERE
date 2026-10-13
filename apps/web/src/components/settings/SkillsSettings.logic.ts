import type {
  EnvironmentId,
  ManagedSkillSummary,
  SelectionBudgetSnapshot,
  SkillPackSourceSummary,
  SkillPackSummary,
} from "@t3tools/contracts";

export const MY_SKILLS_GROUP = "My Skills";
export const PLUGIN_GROUP = "Plugin Skills";
export const DOWNLOADED_GROUP = "Downloaded";
export const REVIEWED_GROUP = "Reviewed";
/** The order the Skills page lists its groups in. */
export const GROUP_ORDER = [MY_SKILLS_GROUP, PLUGIN_GROUP, DOWNLOADED_GROUP, REVIEWED_GROUP];
/** Up to this many skills the page is a search box and a list; beyond it, Show Off Only helps. */
const OFF_FILTER_THRESHOLD = 50;

type GroupedSkill = Pick<ManagedSkillSummary, "source" | "dependencies">;

const downloadedSource = (skill: GroupedSkill) =>
  /\/skill-library\/([^/]+)\//.exec(skill.dependencies[0]?.path ?? "")?.[1];

/**
 * Where a catalog entry came from: the user's own skill folder, an installed Claude plugin,
 * a skill downloaded from elsewhere into the server's skill-library folder, or a reviewed manifest.
 */
export function skillGroup(skill: GroupedSkill): string {
  if (skill.source.startsWith("plugin-library:")) return PLUGIN_GROUP;
  if (!skill.source.startsWith("local-library:")) return REVIEWED_GROUP;
  return downloadedSource(skill) ? DOWNLOADED_GROUP : MY_SKILLS_GROUP;
}

/** The plugin or download source a skill belongs to, shown beside it; null for the user's own. */
export function skillOrigin(skill: GroupedSkill): string | null {
  if (skill.source.startsWith("plugin-library:"))
    return skill.source.slice("plugin-library:".length).split("/")[0] ?? null;
  return downloadedSource(skill) ?? null;
}

type CatalogEntry = Pick<
  ManagedSkillSummary,
  "id" | "revision" | "name" | "description" | "source" | "dependencies" | "enabled"
>;
export interface MachineCatalog {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** Null until this machine has answered, or when it could not be read. */
  readonly catalog: readonly CatalogEntry[] | null;
}
export interface SkillOnMachine {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly revision: string;
  readonly enabled: boolean;
}
/** One skill as the page shows it: the same id on several machines is one entry. */
export interface MergedSkill extends Pick<
  CatalogEntry,
  "id" | "name" | "description" | "source" | "dependencies"
> {
  readonly machines: readonly SkillOnMachine[];
}

/**
 * Joins the machines' catalogs by skill id. A machine may hold old revisions of a skill
 * beside the current one; only one is shown per machine, the enabled one if there is one.
 */
export function mergeCatalogs(machines: readonly MachineCatalog[]): MergedSkill[] {
  const merged = new Map<string, { skill: CatalogEntry; machines: SkillOnMachine[] }>();
  for (const { environmentId, label, catalog } of machines) {
    const picked = new Map<string, CatalogEntry>();
    for (const entry of catalog ?? []) {
      const held = picked.get(entry.id);
      if (!held || entry.enabled || !held.enabled) picked.set(entry.id, entry);
    }
    for (const entry of picked.values()) {
      const slot = merged.get(entry.id) ?? { skill: entry, machines: [] };
      slot.machines.push({
        environmentId,
        label,
        revision: entry.revision,
        enabled: entry.enabled,
      });
      merged.set(entry.id, slot);
    }
  }
  return [...merged.values()]
    .map(({ skill, machines: on }) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      source: skill.source,
      dependencies: skill.dependencies,
      machines: on,
    }))
    .toSorted((a, b) => a.id.localeCompare(b.id));
}

/** True when the skill is on for every machine that has it. */
export const isAvailable = (skill: Pick<MergedSkill, "machines">) =>
  skill.machines.length > 0 && skill.machines.every((machine) => machine.enabled);

/** Skills that are on somewhere; what "available" counts. */
export const availableCount = (skills: readonly Pick<MergedSkill, "machines">[]) =>
  skills.filter((skill) => skill.machines.some((machine) => machine.enabled)).length;

/** "on 1 of 2 machines" when a skill is on for only some of the connected machines. */
export function partialNote(
  skill: Pick<MergedSkill, "machines">,
  machineCount: number,
): string | null {
  const on = skill.machines.filter((machine) => machine.enabled).length;
  return machineCount > 1 && on > 0 && on < machineCount
    ? `on ${on} of ${machineCount} machines`
    : null;
}

/**
 * What a switch or Turn All press changes: every machine that has the skill and is not
 * already in the wanted position, matched by skill id.
 */
export function toggleTargets(skills: readonly MergedSkill[], enabled: boolean) {
  return skills.flatMap((skill) =>
    skill.machines
      .filter((machine) => machine.enabled !== enabled)
      .map((machine) => ({
        environmentId: machine.environmentId,
        label: machine.label,
        id: skill.id,
        revision: machine.revision,
      })),
  );
}

/** One entry per connected machine for the "MacBook Air · 405 available" line. */
export function machineCounts(machines: readonly MachineCatalog[]): string[] {
  return machines.map(({ label, catalog }) =>
    catalog === null
      ? `${label} · unavailable`
      : `${label} · ${new Set(catalog.filter((entry) => entry.enabled).map((entry) => entry.id)).size} available`,
  );
}

/** Whether the list is long enough to want Show Off Only beside the search box. */
export const showsOffFilter = (skillCount: number) => skillCount > OFF_FILTER_THRESHOLD;

export function filterSkills<Skill extends MergedSkill>(
  catalog: readonly Skill[],
  filter: { query: string; offOnly: boolean },
): Skill[] {
  const terms = filter.query.toLowerCase().split(/\s+/).filter(Boolean);
  return catalog.filter((skill) => {
    if (filter.offOnly && isAvailable(skill)) return false;
    const text = `${skill.id} ${skill.name} ${skill.description}`.toLowerCase();
    return terms.every((term) => text.includes(term));
  });
}

export type Mode = {
  skillListing?: "all" | "selected" | undefined;
  mode?: "advisory" | "shadow" | "automatic" | undefined;
  jevConfigured?: boolean | undefined;
  selectionBudget?: SelectionBudgetSnapshot | undefined;
};
/** A single Jev request reserves this much; with less left, Jev is not asked. */
const JEV_REQUEST_MICRO_USD = 4_032;

/** What stops Jev from picking skills on one machine, or null when it can. */
export function loadingProblem(preview: Mode): string | null {
  if (preview.mode !== "automatic")
    return "Auto is not applying picks, so providers still list their own skills. Turn Auto on in Routing, not as a trial run, for this to apply.";
  if (!preview.jevConfigured)
    return "Jev is not connected, so only skills you name with $ or /name are attached.";
  const budget = preview.selectionBudget;
  if (budget?.status !== "ready")
    return "Jev's budget could not be read, so only skills you name with $ or /name are attached.";
  if (budget.halted || budget.availableMicroUsd < JEV_REQUEST_MICRO_USD)
    return `Today's Jev budget is spent, so only skills you name with $ or /name are attached until it resets at midnight ${budget.timeZone}.`;
  return null;
}

/**
 * The state of the one mode switch across every machine that has answered, and the
 * sentence beside it. Null until some machine has said how it is set up. The switch is on
 * only when every machine loads per message.
 */
export function skillsLoading(input: {
  machines: readonly { label: string; preview: Mode | null }[];
  available: number;
}): { checked: boolean; description: string } | null {
  const ready = input.machines.flatMap(({ label, preview }) =>
    preview ? [{ label, preview }] : [],
  );
  if (ready.length === 0) return null;
  const selected = ready.filter(({ preview }) => preview.skillListing === "selected");
  if (selected.length === 0)
    return {
      checked: false,
      description:
        "Every provider lists all of its own skills in every session, which costs tokens whether or not a skill is used.",
    };
  if (selected.length < ready.length)
    return {
      checked: false,
      description: `Only ${selected.map(({ label }) => label).join(" and ")} ${selected.length === 1 ? "loads" : "load"} just the skills each message needs. Turn this on to do the same on every machine.`,
    };
  const stuck = ready.flatMap(({ label, preview }) => {
    const problem = loadingProblem(preview);
    return problem ? [{ label, problem }] : [];
  })[0];
  if (stuck)
    return {
      checked: true,
      description: ready.length > 1 ? `${stuck.label}: ${stuck.problem}` : stuck.problem,
    };
  return {
    checked: true,
    description: `Jev picks from your ${input.available} skill${input.available === 1 ? "" : "s"} for each message. None of them cost tokens until one is used.`,
  };
}

const field = (value: unknown, key: string) =>
  typeof value === "object" && value !== null && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;

/** One sentence the user can act on for a failed catalog call. */
export function describeSkillFailure(error: unknown): string {
  const tag = field(error, "_tag");
  if (tag === "EnvironmentAuthorizationError") {
    return "This device does not have administrator access to this server. Pair it again with an administrator link, or make the change from a device that has it.";
  }
  if (tag === "SkillPackError") {
    switch (field(error, "reason")) {
      case "git_missing":
        return "Git is not installed on this machine. Install Git, then try again.";
      case "download_failed":
        return "Could not download the skills from GitHub. Check this machine's internet connection and try again.";
      case "too_large":
        return "The download was larger than the limit, so nothing was installed.";
      case "no_skills":
        return "The download held no skills, so nothing was installed.";
      case "unknown_pack":
        return "This server does not offer that pack.";
      case "index_failed":
        return "The skills were downloaded but could not be indexed. Press Refresh.";
      default:
        return "Could not write to the skill library folder on this machine.";
    }
  }
  if (tag === "ManagedSkillError") {
    switch (field(error, "reason")) {
      case "library_missing":
        return "This machine has no ~/.claude/skills folder to read.";
      case "catalog_full":
        return "The catalog is full. Remove unused revisions before adding more.";
      case "invalid_manifest":
        return "The server rejected this manifest.";
      case "not_found":
        return "That revision is no longer in the catalog. Refresh to read it again.";
      case "source_changed":
        return "The skill's file has changed since it was indexed. Refresh to read it again.";
      default:
        return "The server could not save the catalog. Try again.";
    }
  }
  return "Could not reach this server's skill catalog.";
}

export interface MachinePacks {
  readonly environmentId: EnvironmentId;
  /** Null until this machine has answered, or when it could not be read. */
  readonly packs: readonly SkillPackSummary[] | null;
}
/** One pack as the page shows it: a button state across every machine that offers it. */
export interface PackRow {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly sources: readonly SkillPackSourceSummary[];
  readonly skillCount: number | null;
  /** Install when any machine lacks it, else Update when any is behind this build, else Installed. */
  readonly state: "install" | "update" | "installed";
  /** Machines Install or Update would change. */
  readonly changeOn: readonly EnvironmentId[];
  /** Machines Remove would change. */
  readonly installedOn: readonly EnvironmentId[];
}

/** Joins the machines' pack lists by pack id, in the order the first machine lists them. */
export function mergePacks(machines: readonly MachinePacks[]): PackRow[] {
  const rows = new Map<
    string,
    { first: SkillPackSummary; on: Map<EnvironmentId, SkillPackSummary> }
  >();
  for (const { environmentId, packs } of machines)
    for (const pack of packs ?? []) {
      const row = rows.get(pack.id) ?? { first: pack, on: new Map() };
      row.on.set(environmentId, pack);
      rows.set(pack.id, row);
    }
  return [...rows.values()].map(({ first, on }) => {
    const all = [...on.entries()];
    const missing = all.filter(([, pack]) => !pack.installed);
    const behind = all.filter(([, pack]) => pack.installed && pack.updateAvailable);
    return {
      id: first.id,
      title: first.title,
      description: first.description,
      sources: first.sources,
      skillCount: first.skillCount,
      state: missing.length > 0 ? "install" : behind.length > 0 ? "update" : "installed",
      changeOn: (missing.length > 0 ? missing : behind).map(([environmentId]) => environmentId),
      installedOn: all.filter(([, pack]) => pack.installed).map(([environmentId]) => environmentId),
    };
  });
}
