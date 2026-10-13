import type { EnvironmentId } from "@t3tools/contracts";

import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { keepAgentSyncSide, useAgentSyncStatus, useAgentSyncTarget } from "./useAgentSync";
import { useWorkbenchPreferences } from "./workbenchPreferences";

const FIELD_LABELS: Record<string, string> = {
  name: "name",
  description: "description",
  instructions: "instructions",
  color: "color",
  pinned: "pinned",
  runtimeMode: "access mode",
  avatar: "avatar",
  blockedToolGroups: "tool access",
};

/** Where agents sync to, how the last background pass went, and any copies that need a choice. */
export function AgentSyncPanel() {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const preference = useWorkbenchPreferences((state) => state.agentSyncTarget);
  const setPreference = useWorkbenchPreferences((state) => state.setAgentSyncTarget);
  const targetId = useAgentSyncTarget();
  const status = useAgentSyncStatus();
  const others = environments.filter((e) => e.environmentId !== primaryEnvironmentId);
  if (others.length === 0) return null;
  const labelOf = (id: EnvironmentId | null) =>
    environments.find((e) => e.environmentId === id)?.label ?? "the other environment";
  const localLabel = labelOf(primaryEnvironmentId);
  const targetLabel = labelOf(targetId);

  return (
    <section data-wb-agent-move="" aria-label="Agent Sync">
      <h3>Agent Sync</h3>
      <label>
        Keep Agents In Sync With
        <select value={preference} onChange={(e) => setPreference(e.target.value)}>
          <option value="auto">
            {others.length === 1 ? `${others[0]!.label} (Automatic)` : "Choose An Environment"}
          </option>
          {others.length > 1 &&
            others.map((e) => (
              <option key={e.environmentId} value={e.environmentId}>
                {e.label}
              </option>
            ))}
          <option value="off">Off</option>
        </select>
      </label>
      <p role="status">
        {targetId === null
          ? preference === "off"
            ? "Sync is off. Agents stay on the environment they were made on."
            : "Choose which environment to keep agents in sync with."
          : status.state === "error"
            ? `Could not reach ${targetLabel}. Sync resumes when both are connected.`
            : status.syncedAt === null
              ? `Waiting for ${localLabel} and ${targetLabel} to connect.`
              : `In sync with ${targetLabel}. Last checked ${new Date(status.syncedAt).toLocaleTimeString()}.`}
      </p>
      {targetId !== null && status.failed.length > 0 && (
        <p role="status">Not saved this time, will retry: {status.failed.join(", ")}.</p>
      )}
      {targetId !== null && status.conversationsFailed.length > 0 && (
        <p role="status">
          Conversation not copied to the other side yet, will retry:{" "}
          {status.conversationsFailed.join(", ")}.
        </p>
      )}
      {targetId !== null && status.unresolved.length > 0 && (
        <ul data-wb-move-results="">
          {status.unresolved.map((item) => (
            <li key={item.agentId} data-tone="warn">
              <strong>{item.name}</strong> · The{" "}
              {item.fields.map((field) => FIELD_LABELS[field] ?? field).join(", ")}{" "}
              {item.fields.length === 1 ? "differs" : "differ"} between {localLabel} and{" "}
              {targetLabel}. Nothing was overwritten.
              <div data-wb-actions="">
                <button onClick={() => keepAgentSyncSide(item.agentId, "local")}>
                  Keep {localLabel}
                </button>
                <button onClick={() => keepAgentSyncSide(item.agentId, "remote")}>
                  Keep {targetLabel}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
