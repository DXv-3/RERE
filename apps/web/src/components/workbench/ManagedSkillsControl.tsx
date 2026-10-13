import { useEffect, useRef, useState } from "react";
import {
  type EnvironmentId,
  type ManagedSkillCandidate,
  type ManagedSkillSummary,
  type ManagedSkillLoad,
  type ManagedSkillStage,
} from "@t3tools/contracts";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";

/**
 * The managed skills that match the current draft, each loadable one stage at a
 * time. The catalog itself is managed in Settings, reached through `onManage`.
 */
export function ManagedSkillsControl({
  environmentId,
  cwd,
  candidates,
  available,
  onLoad,
  onManage,
}: {
  environmentId: EnvironmentId;
  cwd: string | null;
  candidates: readonly ManagedSkillCandidate[];
  available: boolean;
  onLoad?: ((skill: ManagedSkillLoad) => "added" | "already_present" | "limit") | undefined;
  onManage: () => void;
}) {
  const load = useAtomCommand(serverEnvironment.managedSkillsLoad, { reportFailure: false });
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const run = async (action: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setNotice(null);
    try {
      await action();
    } catch {
      if (mounted.current)
        setNotice("Could not reach the catalog. Reopen Routing to check the saved state.");
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const loadStage = (skill: ManagedSkillSummary, stage: ManagedSkillStage) =>
    run(async () => {
      const result = await load({
        environmentId,
        input: { id: skill.id, revision: skill.revision, stage, cwd },
      });
      if (!mounted.current) return;
      if (result._tag === "Failure") {
        setNotice(
          "This stage cannot be loaded. Refresh to check its revision, project scope and dependencies.",
        );
        return;
      }
      const status = onLoad?.(result.value);
      setNotice(
        status === "added"
          ? `Stage instructions: ${result.value.utf8Bytes.toLocaleString()} UTF-8 bytes. Added to the draft with source and permission notes. Actual model tokens have not been measured. Review before sending.`
          : status === "limit"
            ? "This draft already contains two skill stages. Remove one before adding another."
            : "This stage is already in the draft.",
      );
    });
  return (
    <section aria-label="Managed Skills">
      <h3>Managed Skills</h3>
      <p>
        Reviewed revisions stay on this server, outside provider autoload folders. Load one stage
        into your draft when needed; nothing is submitted automatically.
      </p>
      {!available && <p role="alert">The managed catalog is unavailable.</p>}
      {available && candidates.length === 0 && (
        <p>No managed skills match this draft and project.</p>
      )}
      {candidates.map((skill) => (
        <section key={`${skill.id}:${skill.revision}`} aria-label={skill.name}>
          <strong>{skill.name}</strong>
          <p>{skill.description}</p>
          <small>Revision {skill.revision.slice(0, 12)}</small>
          {skill.missingDependencies.length > 0 && (
            <p>Missing dependencies: {skill.missingDependencies.join(", ")}</p>
          )}
          {skill.stages.map((stage) => (
            <div key={stage.stage}>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy || !onLoad || skill.missingDependencies.length > 0}
                onClick={() => void loadStage(skill, stage.stage)}
              >
                Load {stage.stage} stage
              </Button>
              <small> {stage.utf8Bytes.toLocaleString()} UTF-8 bytes</small>
            </div>
          ))}
        </section>
      ))}
      <Button size="sm" variant="outline" onClick={onManage}>
        Manage Skills
      </Button>
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
