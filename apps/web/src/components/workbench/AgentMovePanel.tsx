import {
  describeAgentMoveFailure,
  planAgentMoves,
  type AgentMovePlan,
} from "@t3tools/client-runtime/operations/agent-move";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, WorkspaceAgent } from "@t3tools/contracts";
import { useState } from "react";

import { useServerConfigs, useProjects } from "../../state/entities";
import { useConnectedEnvironmentIds, useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

type Scope = "one" | "all";
type Review =
  | { readonly state: "loading"; readonly scope: Scope }
  | { readonly state: "error"; readonly scope: Scope; readonly message: string }
  | {
      readonly state: "ready";
      readonly scope: Scope;
      readonly plans: ReadonlyArray<AgentMovePlan>;
      readonly sourceAgents: ReadonlyArray<WorkspaceAgent>;
      readonly targetId: EnvironmentId;
    };
interface MoveResult {
  readonly agentId: string;
  readonly name: string;
  readonly tone: "ok" | "warn" | "error";
  readonly message: string;
}

/**
 * Moves agents between environments: save on the target, then archive the source copy.
 * Nothing is deleted, and a failed target save leaves the source copy untouched.
 */
export function AgentMovePanel({
  sourceEnvironmentId,
  selectedAgentId,
  onMoved,
}: {
  sourceEnvironmentId: EnvironmentId;
  selectedAgentId: string | null;
  onMoved: () => void;
}) {
  const { environments } = useEnvironments();
  const connectedIds = useConnectedEnvironmentIds();
  const configs = useServerConfigs();
  const projects = useProjects();
  const list = useAtomCommand(serverEnvironment.agentsList, { reportFailure: false });
  const save = useAtomCommand(serverEnvironment.agentsSave, { reportFailure: false });
  const [chosenTarget, setChosenTarget] = useState<EnvironmentId | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [included, setIncluded] = useState<ReadonlySet<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<ReadonlyArray<MoveResult> | null>(null);

  const targets = environments.filter((e) => e.environmentId !== sourceEnvironmentId);
  const target = targets.find((e) => e.environmentId === chosenTarget) ?? targets[0] ?? null;
  if (!target) return null;
  const labelOf = (id: EnvironmentId) =>
    environments.find((e) => e.environmentId === id)?.label ?? "that environment";
  const sourceLabel = labelOf(sourceEnvironmentId);
  const targetId = target.environmentId;
  const online = (id: EnvironmentId) => connectedIds.includes(id) && configs.has(id);
  const canMove = online(sourceEnvironmentId) && online(targetId);

  const start = async (scope: Scope) => {
    setResults(null);
    setReview({ state: "loading", scope });
    // Read both sides fresh: the saves below depend on current revisions.
    const [sourceList, targetList] = await Promise.all([
      list({ environmentId: sourceEnvironmentId, input: {} }),
      list({ environmentId: targetId, input: {} }),
    ]);
    if (sourceList._tag === "Failure" || targetList._tag === "Failure") {
      setReview({
        state: "error",
        scope,
        message: `Could not read the agents on ${sourceList._tag === "Failure" ? sourceLabel : target.label}. Nothing was changed.`,
      });
      return;
    }
    const sourceAgents = sourceList.value.filter(
      (a) => !a.archivedAt && (scope === "all" || a.profile.id === selectedAgentId),
    );
    const plans = planAgentMoves({
      sourceAgents,
      targetAgents: targetList.value,
      sourceProjects: projects.filter((p) => p.environmentId === sourceEnvironmentId),
      targetProjects: projects.filter((p) => p.environmentId === targetId),
      targetProviders: configs.get(targetId)?.providers ?? [],
    });
    setIncluded(
      new Set(
        plans
          .filter((p) => !p.verdict.blocked && !p.verdict.stayByDefault)
          .map((p) => p.verdict.agentId),
      ),
    );
    setReview({ state: "ready", scope, plans, sourceAgents, targetId });
  };

  const confirm = async () => {
    if (review?.state !== "ready") return;
    const { plans, sourceAgents } = review;
    const targetName = labelOf(review.targetId);
    setRunning(true);
    const done: MoveResult[] = [];
    for (const plan of plans) {
      const { agentId, name } = plan.verdict;
      if (!included.has(agentId) || !plan.record) continue;
      const saved = await save({
        environmentId: review.targetId,
        input: { agent: plan.record, expectedRevision: plan.expectedRevision },
      });
      if (saved._tag === "Failure") {
        done.push({
          agentId,
          name,
          tone: "error",
          message: `Not moved. ${describeAgentMoveFailure(squashAtomCommandFailure(saved))} ${sourceLabel} was not changed.`,
        });
        continue;
      }
      const source = sourceAgents.find((a) => a.profile.id === agentId);
      const archived = source
        ? await save({
            environmentId: sourceEnvironmentId,
            input: {
              agent: { ...source, archivedAt: new Date().toISOString() },
              expectedRevision: source.revision,
            },
          })
        : null;
      done.push(
        archived?._tag === "Success"
          ? {
              agentId,
              name,
              tone: "ok",
              message: `Moved to ${targetName}. The copy on ${sourceLabel} is archived.`,
            }
          : {
              agentId,
              name,
              tone: "warn",
              message: `Saved on ${targetName}, but the copy on ${sourceLabel} could not be archived${
                archived ? `. ${describeAgentMoveFailure(squashAtomCommandFailure(archived))}` : ""
              }. Both copies exist; running the move again is safe.`,
            },
      );
    }
    setResults(done);
    setReview(null);
    setRunning(false);
    onMoved();
  };

  return (
    <section data-wb-agent-move="" aria-label="Move Agents">
      <h3>Move Agents</h3>
      <p>
        Agents belong to one environment. Moving saves a copy on the other one, then archives this
        one. Nothing is deleted.
      </p>
      <label>
        Move To
        <select
          value={targetId}
          disabled={running || targets.length < 2}
          onChange={(e) => {
            setChosenTarget(e.target.value as EnvironmentId);
            setReview(null);
            setResults(null);
          }}
        >
          {targets.map((e) => (
            <option key={e.environmentId} value={e.environmentId}>
              {e.label}
              {online(e.environmentId) ? "" : " (Offline)"}
            </option>
          ))}
        </select>
      </label>
      <div data-wb-actions="">
        <button
          disabled={!canMove || running || !selectedAgentId || review?.state === "loading"}
          onClick={() => void start("one")}
        >
          Move To {target.label}
        </button>
        <button
          disabled={!canMove || running || review?.state === "loading"}
          onClick={() => void start("all")}
        >
          Move All Agents
        </button>
      </div>
      {!canMove && (
        <p role="status">
          Connect both {sourceLabel} and {target.label} to move agents.
        </p>
      )}
      {review?.state === "loading" && <p role="status">Checking {target.label}…</p>}
      {review?.state === "error" && <p role="alert">{review.message}</p>}
      {review?.state === "ready" && (
        <div data-wb-move-review="">
          {review.plans.length === 0 && <p>There are no active agents to move.</p>}
          <ul>
            {review.plans.map((plan) => {
              const { verdict } = plan;
              return (
                <li key={verdict.agentId}>
                  <label data-wb-checkbox="">
                    <input
                      type="checkbox"
                      checked={included.has(verdict.agentId)}
                      disabled={verdict.blocked || running}
                      onChange={(e) =>
                        setIncluded((current) => {
                          const next = new Set(current);
                          if (e.target.checked) next.add(verdict.agentId);
                          else next.delete(verdict.agentId);
                          return next;
                        })
                      }
                    />
                    <strong>{verdict.name}</strong>
                    {verdict.mode === "merge" && <small> · Already On {target.label}</small>}
                  </label>
                  <ul>
                    {verdict.messages.map((m) => (
                      <li key={m}>{m}</li>
                    ))}
                  </ul>
                </li>
              );
            })}
          </ul>
          <div data-wb-actions="">
            <button
              data-wb-primary=""
              disabled={running || included.size === 0}
              onClick={() => void confirm()}
            >
              {running
                ? "Moving…"
                : `Confirm Move Of ${included.size} ${included.size === 1 ? "Agent" : "Agents"}`}
            </button>
            <button disabled={running} onClick={() => setReview(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {results && (
        <ul data-wb-move-results="" role="status">
          {results.map((r) => (
            <li key={r.agentId} data-tone={r.tone}>
              <strong>{r.name}</strong> · {r.message}
            </li>
          ))}
          {results.length === 0 && <li>Nothing was selected to move.</li>}
        </ul>
      )}
    </section>
  );
}
