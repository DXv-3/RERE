import { useEffect, useMemo, useRef, useState } from "react";
import * as Schema from "effect/Schema";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  ManagedSkillManifest,
  type EnvironmentId,
  type ManagedSkillSummary,
  type RoutingPreview,
  type SkillPackSummary,
} from "@t3tools/contracts";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { RefreshIcon } from "../ui/refresh-icon";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import {
  GROUP_ORDER,
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
  type MergedSkill,
  type PackRow,
} from "./SkillsSettings.logic";

const parseManifest = Schema.decodeUnknownSync(Schema.fromJsonString(ManagedSkillManifest));

export interface SkillsMachine {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}
interface MachineState {
  readonly catalog: readonly ManagedSkillSummary[] | null;
  readonly routing: RoutingPreview | null;
  readonly packs: readonly SkillPackSummary[] | null;
}
const NOT_LOADED: MachineState = { catalog: null, routing: null, packs: null };
type Failure = { readonly cause: Parameters<typeof squashAtomCommandFailure>[0]["cause"] };
const failureText = (result: Failure) => describeSkillFailure(squashAtomCommandFailure(result));

/**
 * The skill catalogs of every connected machine as one list. Switches and Turn All apply to
 * each machine that has the skill; a machine that fails is named and the others carry on.
 */
export function SkillsSettings({ machines }: { machines: readonly SkillsMachine[] }) {
  const list = useAtomCommand(serverEnvironment.managedSkillsList, { reportFailure: false });
  const setEnabled = useAtomCommand(serverEnvironment.managedSkillsSetEnabled, {
    reportFailure: false,
  });
  const syncLibrary = useAtomCommand(serverEnvironment.managedSkillsSyncLibrary, {
    reportFailure: false,
  });
  const routingPreview = useAtomCommand(serverEnvironment.routingPreview, {
    reportFailure: false,
  });
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    reportFailure: false,
  });
  const admit = useAtomCommand(serverEnvironment.managedSkillsAdmit, { reportFailure: false });
  const runPacks = useAtomCommand(serverEnvironment.skillPacksRun, { reportFailure: false });
  const [states, setStates] = useState<Readonly<Record<string, MachineState>>>({});
  const [query, setQuery] = useState("");
  const [offOnly, setOffOnly] = useState(false);
  const [notice, setNotice] = useState<{ kind: "info" | "error"; lines: string[] } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [manifest, setManifest] = useState("");
  // The pack being installed or removed, and the last failure for each pack, shown on its row.
  const [packWork, setPackWork] = useState<{ id: string; verb: string } | null>(null);
  const [packErrors, setPackErrors] = useState<Readonly<Record<string, readonly string[]>>>({});
  const pending = useRef(false);
  const mounted = useRef(true);
  const machineKey = machines.map((machine) => machine.environmentId).join(",");

  const errorNotice = (lines: readonly string[]) =>
    setNotice(lines.length > 0 ? { kind: "error", lines: [...lines] } : null);
  // Runs one call per machine at the same time; a failing machine is reported by name.
  const onEachMachine = async (call: (machine: SkillsMachine) => Promise<string | null>) => {
    const errors = await Promise.all(
      machines.map(async (machine) => {
        try {
          const error = await call(machine);
          return error === null ? null : `${machine.label}: ${error}`;
        } catch {
          return `${machine.label}: ${describeSkillFailure(null)}`;
        }
      }),
    );
    return errors.filter((error): error is string => error !== null);
  };
  const patchState = (environmentId: EnvironmentId, change: Partial<MachineState>) =>
    setStates((current) => ({
      ...current,
      [environmentId]: { ...(current[environmentId] ?? NOT_LOADED), ...change },
    }));
  // The catalog and the routing setup are separate calls; the routing one only explains
  // how skills reach a message, so its failure leaves the list usable.
  const readMachine = async ({ environmentId }: SkillsMachine) => {
    const [catalog, routing, packs] = await Promise.all([
      list({ environmentId, input: {} }),
      routingPreview({ environmentId, input: { instanceId: null, cwd: null, task: "" } }),
      runPacks({ environmentId, input: { action: "list" } }),
    ]);
    if (!mounted.current) return null;
    patchState(environmentId, {
      ...(catalog._tag === "Success" ? { catalog: catalog.value } : {}),
      ...(routing._tag === "Success" ? { routing: routing.value } : {}),
      // A server without packs just has no Skill Packs section.
      ...(packs._tag === "Success" ? { packs: packs.value } : {}),
    });
    return catalog._tag === "Success" ? null : failureText(catalog);
  };
  useEffect(() => {
    mounted.current = true;
    void onEachMachine(readMachine).then((errors) => {
      if (mounted.current) errorNotice(errors);
    });
    return () => {
      mounted.current = false;
    };
    // The catalogs belong to the connected machines; the commands are stable per registry.
  }, [machineKey]);

  const run = async (label: string, action: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(label);
    setNotice(null);
    try {
      await action();
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(null);
    }
  };

  // Installs, updates or removes one pack on each machine in `targets`, then reads the machines
  // again so the row and the skill list show what is on disk. Failures stay on the pack's row.
  const changePack = (
    row: PackRow,
    verb: "Installing" | "Updating" | "Removing",
    targets: readonly EnvironmentId[],
  ) =>
    run(verb, async () => {
      setPackWork({ id: row.id, verb });
      setPackErrors((current) => ({ ...current, [row.id]: [] }));
      try {
        const errors = await onEachMachine(async ({ environmentId }) => {
          if (!targets.includes(environmentId)) return null;
          const result = await runPacks({
            environmentId,
            input: { packId: row.id, action: verb === "Removing" ? "remove" : "install" },
          });
          return result._tag === "Failure" ? failureText(result) : null;
        });
        if (!mounted.current) return;
        const readErrors = await onEachMachine(readMachine);
        if (!mounted.current) return;
        setPackErrors((current) => ({ ...current, [row.id]: errors }));
        if (readErrors.length > 0) errorNotice(readErrors);
      } finally {
        if (mounted.current) setPackWork(null);
      }
    });

  const setListing = (listing: "all" | "selected") =>
    run("Saving", async () => {
      const errors = await onEachMachine(async ({ environmentId }) => {
        const result = await updateSettings({
          environmentId,
          input: { patch: { skillListing: listing } },
        });
        return result._tag === "Failure" ? failureText(result) : null;
      });
      if (!mounted.current) return;
      errorNotice([...errors, ...(await onEachMachine(readMachine))]);
    });

  // Indexes each machine's library and turns on whatever is new, for someone who just
  // added a skill file and does not want to wait for the automatic pass.
  const refresh = () =>
    run("Refreshing", async () => {
      const skipped: string[] = [];
      const errors = await onEachMachine(async (machine) => {
        const result = await syncLibrary({
          environmentId: machine.environmentId,
          input: { enable: true },
        });
        if (result._tag === "Failure") return failureText(result);
        if (result.value.skipped > 0)
          skipped.push(
            `${machine.label}: ${result.value.skipped} skipped for a missing description.`,
          );
        return null;
      });
      if (!mounted.current) return;
      const readErrors = await onEachMachine(readMachine);
      if (!mounted.current) return;
      if (errors.length + readErrors.length > 0) errorNotice([...errors, ...readErrors]);
      else if (skipped.length > 0) setNotice({ kind: "info", lines: skipped });
    });

  const updateEntry = (
    environmentId: EnvironmentId,
    id: string,
    revision: string,
    enabled: boolean,
  ) =>
    setStates((current) => {
      const state = current[environmentId];
      if (!state?.catalog) return current;
      return {
        ...current,
        [environmentId]: {
          ...state,
          catalog: state.catalog.map((entry) =>
            entry.id !== id
              ? entry
              : entry.revision === revision
                ? { ...entry, enabled }
                : enabled
                  ? { ...entry, enabled: false }
                  : entry,
          ),
        },
      };
    });

  // Applies one switch position to the listed skills on each machine that has them. A
  // machine stops at its first refusal so a missing permission is reported once.
  const setMany = (skills: readonly MergedSkill[], enabled: boolean) =>
    run(enabled ? "Turning on" : "Turning off", async () => {
      const targets = toggleTargets(skills, enabled);
      const changed = new Set<string>();
      const errors = await onEachMachine(async ({ environmentId }) => {
        for (const target of targets.filter((entry) => entry.environmentId === environmentId)) {
          const result = await setEnabled({
            environmentId,
            input: { id: target.id, revision: target.revision, enabled },
          });
          if (!mounted.current) return null;
          if (result._tag === "Failure") return failureText(result);
          changed.add(target.id);
          updateEntry(environmentId, target.id, target.revision, enabled);
        }
        return null;
      });
      if (!mounted.current) return;
      if (errors.length > 0) errorNotice(errors);
      else if (changed.size > 1)
        setNotice({
          kind: "info",
          lines: [`Turned ${changed.size} skills ${enabled ? "on" : "off"}.`],
        });
    });

  const importManifest = () =>
    run("Saving", async () => {
      let parsed: ManagedSkillManifest;
      try {
        parsed = parseManifest(manifest);
      } catch {
        setNotice({
          kind: "error",
          lines: [
            "Enter a valid reviewed manifest with source, revision, permissions and bounded stages.",
          ],
        });
        return;
      }
      const errors = await onEachMachine(async ({ environmentId }) => {
        const result = await admit({ environmentId, input: parsed });
        return result._tag === "Failure" ? failureText(result) : null;
      });
      if (!mounted.current) return;
      if (errors.length === 0) setManifest("");
      errorNotice([...errors, ...(await onEachMachine(readMachine))]);
      if (errors.length === 0)
        setNotice({ kind: "info", lines: ["Revision saved turned off. Turn it on in the list."] });
    });

  const addStarters = () =>
    run("Adding", async () => {
      const errors = await onEachMachine(async ({ environmentId }) => {
        const result = await runPacks({ environmentId, input: { action: "admit-starters" } });
        return result._tag === "Failure" ? failureText(result) : null;
      });
      if (!mounted.current) return;
      const readErrors = await onEachMachine(readMachine);
      if (errors.length + readErrors.length > 0) errorNotice([...errors, ...readErrors]);
      else setNotice({ kind: "info", lines: ["Starter skills saved turned off."] });
    });

  const catalogs = useMemo(
    () =>
      machines.map((machine) => ({
        ...machine,
        catalog: states[machine.environmentId]?.catalog ?? null,
      })),
    [machines, states],
  );
  const skills = useMemo(() => mergeCatalogs(catalogs), [catalogs]);
  const packRows = useMemo(
    () =>
      mergePacks(
        machines.map((machine) => ({
          environmentId: machine.environmentId,
          packs: states[machine.environmentId]?.packs ?? null,
        })),
      ),
    [machines, states],
  );
  const loaded = catalogs.some((entry) => entry.catalog !== null);
  const shown = useMemo(() => filterSkills(skills, { query, offOnly }), [skills, query, offOnly]);
  const available = availableCount(skills);
  const loading = skillsLoading({
    machines: machines.map((machine) => ({
      label: machine.label,
      preview: states[machine.environmentId]?.routing ?? null,
    })),
    available,
  });
  const shownGroups = GROUP_ORDER.map((name) => ({
    name,
    skills: shown.filter((skill) => skillGroup(skill) === name),
  })).filter((entry) => entry.skills.length > 0);

  return (
    <SettingsPageContainer>
      {packRows.length > 0 && (
        <SettingsSection title="Skill Packs">
          {packRows.map((row) => {
            const working = packWork?.id === row.id;
            return (
              <SettingsRow
                key={row.id}
                title={row.title}
                description={row.description}
                status={
                  <span className="text-xs text-muted-foreground">
                    {row.skillCount !== null ? `${row.skillCount} skills · ` : ""}
                    {"From "}
                    {row.sources.map((source, index) => (
                      <span key={source.id}>
                        {index > 0 ? ", " : ""}
                        <a
                          className="underline underline-offset-2 hover:text-foreground"
                          href={source.repositoryUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {source.repositoryUrl.replace("https://github.com/", "")}
                        </a>
                        {` (${source.license})`}
                      </span>
                    ))}
                    {". Downloaded skills run with your agent's permissions."}
                  </span>
                }
                control={
                  <div className="flex items-center gap-2">
                    {working ? (
                      <span role="status" className="text-xs text-muted-foreground">
                        {packWork.verb}…
                      </span>
                    ) : (
                      row.state === "installed" && (
                        <span className="text-xs text-muted-foreground">Installed</span>
                      )
                    )}
                    {row.state !== "installed" && (
                      <Button
                        size="compact"
                        variant="outline"
                        disabled={busy !== null}
                        onClick={() =>
                          void changePack(
                            row,
                            row.state === "install" ? "Installing" : "Updating",
                            row.changeOn,
                          )
                        }
                      >
                        {row.state === "install" ? "Install" : "Update"}
                      </Button>
                    )}
                    {row.installedOn.length > 0 && (
                      <Button
                        size="compact"
                        variant="ghost-muted"
                        disabled={busy !== null}
                        onClick={() => void changePack(row, "Removing", row.installedOn)}
                      >
                        Remove
                      </Button>
                    )}
                  </div>
                }
              >
                {(packErrors[row.id] ?? []).length > 0 && (
                  <div role="alert" className="pt-2 text-sm text-destructive-foreground">
                    {(packErrors[row.id] ?? []).map((line) => (
                      <p key={line}>{line}</p>
                    ))}
                  </div>
                )}
              </SettingsRow>
            );
          })}
        </SettingsSection>
      )}

      {loading && (
        <SettingsSection title="How Skills Load">
          <SettingsRow
            title="Load Only The Skills Each Message Needs"
            description={loading.description}
            control={
              <Switch
                aria-label="Load Only The Skills Each Message Needs"
                checked={loading.checked}
                disabled={busy !== null}
                onCheckedChange={(checked) => void setListing(checked ? "selected" : "all")}
              />
            }
          />
        </SettingsSection>
      )}

      {machines.length > 1 && loaded && (
        <p className="px-3 text-xs text-muted-foreground sm:px-4">
          {machineCounts(catalogs).join("   ")}
        </p>
      )}

      {notice && (
        <div
          role={notice.kind === "error" ? "alert" : "status"}
          className={
            notice.kind === "error"
              ? "px-3 text-sm text-destructive-foreground sm:px-4"
              : "px-3 text-sm text-muted-foreground sm:px-4"
          }
        >
          {notice.lines.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      )}

      <SettingsSection
        title={loaded ? `Skills · ${available} available` : "Skills"}
        headerAction={
          <div className="flex items-center gap-2">
            {busy && <span className="text-xs text-muted-foreground">{busy}…</span>}
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label="Refresh"
                    disabled={busy !== null}
                    onClick={() => void refresh()}
                  >
                    <RefreshIcon size="sm" refreshing={busy === "Refreshing"} />
                  </Button>
                }
              />
              <TooltipPopup>Look for new skill files now</TooltipPopup>
            </Tooltip>
          </div>
        }
      >
        <div className="flex flex-wrap items-center gap-2 px-3 py-3 sm:px-4">
          <div className="min-w-40 flex-1">
            <Input
              size="sm"
              type="search"
              aria-label="Find a skill"
              placeholder="Find a skill"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          {showsOffFilter(skills.length) && (
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              Show Off Only
              <Switch
                aria-label="Show Off Only"
                checked={offOnly}
                onCheckedChange={(checked) => setOffOnly(checked)}
              />
            </label>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 px-3 pb-3 sm:px-4">
          <span className="text-xs text-muted-foreground">
            {loaded ? `Showing ${shown.length} of ${skills.length}` : "Loading skills…"}
          </span>
          <div className="flex gap-1">
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={busy !== null || toggleTargets(shown, true).length === 0}
              onClick={() => void setMany(shown, true)}
            >
              Turn All On
            </Button>
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={busy !== null || toggleTargets(shown, false).length === 0}
              onClick={() => void setMany(shown, false)}
            >
              Turn All Off
            </Button>
          </div>
        </div>
        {loaded && shown.length === 0 && (
          <p className="px-3 pb-4 text-sm text-muted-foreground sm:px-4">
            {skills.length === 0
              ? "No skills are indexed yet. Add a skill file, then press Refresh."
              : "No skills match."}
          </p>
        )}
      </SettingsSection>

      {shownGroups.map(({ name, skills: group }) => (
        <SettingsSection
          key={name}
          title={`${name} · ${group.length}`}
          headerAction={
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={busy !== null}
              onClick={() => void setMany(group, toggleTargets(group, true).length > 0)}
            >
              {toggleTargets(group, true).length > 0 ? "Turn Group On" : "Turn Group Off"}
            </Button>
          }
        >
          {group.map((skill) => {
            const origin = skillOrigin(skill);
            const note = partialNote(skill, machines.length);
            return (
              <SettingsRow
                key={skill.id}
                title={skill.name}
                description={skill.description}
                status={
                  <span className="text-xs text-muted-foreground">
                    {origin ? `${origin} · ` : ""}
                    {skill.id}
                    {note ? ` · ${note}` : ""}
                  </span>
                }
                control={
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    Available
                    <Switch
                      aria-label={`Available: ${skill.name}`}
                      checked={isAvailable(skill)}
                      disabled={busy !== null}
                      onCheckedChange={(enabled) => void setMany([skill], enabled)}
                    />
                  </label>
                }
              />
            );
          })}
        </SettingsSection>
      ))}

      <FoldedSettingsSection
        id="skills-reviewed-manifests"
        title="Reviewed Manifests"
        summary="Starter skills and hand-reviewed revisions"
      >
        <SettingsRow
          title="Starter Skills"
          description="Reel review, focused code changes, knowledge audits and campaign analytics. They are saved turned off."
          control={
            <Button
              size="compact"
              variant="outline"
              disabled={busy !== null}
              onClick={() => void addStarters()}
            >
              Add Starter Skills
            </Button>
          }
        />
        <SettingsRow
          title="Admit A Reviewed Revision"
          description="Paste a manifest with its source, revision, permissions and bounded stages."
        >
          <div className="flex flex-col items-end gap-2 pt-2">
            <Textarea
              aria-label="Reviewed skill manifest"
              value={manifest}
              maxLength={100_000}
              rows={6}
              disabled={busy !== null}
              onChange={(event) => setManifest(event.target.value)}
            />
            <Button
              size="compact"
              variant="outline"
              disabled={busy !== null || !manifest.trim()}
              onClick={() => void importManifest()}
            >
              Admit Revision
            </Button>
          </div>
        </SettingsRow>
      </FoldedSettingsSection>
    </SettingsPageContainer>
  );
}
