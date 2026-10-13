import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  AGENT_TOOL_GROUPS,
  AgentAvatar,
  type AgentToolGroup,
  ModelSelection,
  RuntimeMode,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";

export interface AgentProfile {
  id: string;
  name: string;
  description: string;
  instructions: string;
  color: string;
  avatar?: AgentAvatar | undefined;
  pinned: boolean;
  projectKey: string;
  runtimeMode: RuntimeMode | "inherit";
  modelSelection: ModelSelection | null;
  /** Tool groups switched off for this agent; absent means everything is on. */
  blockedToolGroups?: ReadonlyArray<AgentToolGroup> | undefined;
}
export interface SessionPurpose {
  text: string;
  capturedAt: string;
}
export const sessionKey = (environmentId: string, threadId: string) =>
  JSON.stringify([environmentId, threadId]);
export const projectKey = (environmentId: string, projectId: string) =>
  JSON.stringify([environmentId, projectId]);
export const AGENT_COLORS = ["#22c55e", "#3b82f6", "#ec4899", "#a78bfa", "#f97316", "#14b8a6"];
const isAvatar = Schema.is(AgentAvatar);
const isModel = Schema.is(ModelSelection);
const isRuntime = Schema.is(RuntimeMode);
export function parseAgent(value: unknown): AgentProfile | null {
  if (!value || typeof value !== "object") return null;
  const p = value as Partial<AgentProfile>;
  if (typeof p.id !== "string" || !p.id || typeof p.name !== "string" || !p.name.trim())
    return null;
  return {
    id: p.id,
    name: p.name.slice(0, 80),
    description: typeof p.description === "string" ? p.description.slice(0, 240) : "",
    instructions: typeof p.instructions === "string" ? p.instructions.slice(0, 16000) : "",
    color: /^#[0-9a-f]{6}$/i.test(p.color ?? "") ? p.color! : AGENT_COLORS[0]!,
    ...(p.avatar && isAvatar(p.avatar) ? { avatar: p.avatar } : {}),
    pinned: p.pinned === true,
    projectKey: typeof p.projectKey === "string" ? p.projectKey : "",
    runtimeMode: p.runtimeMode && isRuntime(p.runtimeMode) ? p.runtimeMode : "inherit",
    modelSelection: p.modelSelection && isModel(p.modelSelection) ? p.modelSelection : null,
    ...(Array.isArray(p.blockedToolGroups)
      ? {
          blockedToolGroups: AGENT_TOOL_GROUPS.filter((group) =>
            p.blockedToolGroups?.includes(group),
          ),
        }
      : {}),
  };
}
export function originalSessionRequest(input: {
  imported: boolean;
  hasMoreHistory: boolean;
  messages: ReadonlyArray<
    Pick<OrchestrationV2ThreadProjection["messages"][number], "id" | "role" | "text" | "createdAt">
  >;
  runs: ReadonlyArray<
    Pick<OrchestrationV2ThreadProjection["runs"][number], "ordinal" | "userMessageId">
  >;
}): string | null {
  const firstRun = !input.imported ? input.runs.find((run) => run.ordinal === 1) : undefined;
  const eligible = input.messages.filter(
    (m) => m.role === "user" && m.text.trim() && !m.text.trimStart().startsWith("/"),
  );
  const message = input.hasMoreHistory
    ? eligible.find((m) => m.id === firstRun?.userMessageId)
    : eligible.sort(
        (a, b) => DateTime.toEpochMillis(a.createdAt) - DateTime.toEpochMillis(b.createdAt),
      )[0];
  return message?.text ?? null;
}

export function summarizePurpose(text: string, limit = 420): string {
  const plain = text
    .replace(/<workbench-agent>[\s\S]*?<\/workbench-agent>\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= limit) return plain;
  const prefix = plain.slice(0, limit - 1);
  const boundary = prefix.lastIndexOf(" ");
  return `${prefix.slice(0, boundary > limit * 0.7 ? boundary : undefined)}…`;
}
export { splitAgentMessage, splitSkillBlocks } from "@t3tools/shared/agentMessage";
export function applyAgentInstructions(text: string, agent: AgentProfile | undefined): string {
  if (!agent?.instructions.trim() || text.trimStart().startsWith("/")) return text;
  // Keep profile context separate from the request, and refresh it on each new turn.
  const request = text.replace(/^<workbench-agent>[\s\S]*?<\/workbench-agent>\s*/, "");
  return `<workbench-agent>\nAgent: ${agent.name}\n${agent.instructions.trim()}\n</workbench-agent>\n\n${request}`;
}
interface Preferences {
  agents: AgentProfile[];
  selectedAgentId: string | null;
  /** Environment the Agents tab works against; null means the primary environment. */
  agentEnvironmentId: string | null;
  /**
   * Which environment agents are kept in sync with: an environment id, "off", or "auto" for
   * the only other saved environment.
   */
  agentSyncTarget: string;
  assignments: Record<string, string>;
  /** The conversation each agent was last showing, keyed like `sessionKey(environmentId, agentId)`. */
  lastConversations: Record<string, string>;
  purposes: Record<string, SessionPurpose>;
  dismissedAttention: Record<string, string>;
  storageError: string | null;
  saveAgent: (agent: AgentProfile) => void;
  removeAgent: (id: string) => void;
  selectAgent: (id: string | null) => void;
  selectAgentEnvironment: (id: string | null) => void;
  setAgentSyncTarget: (target: string) => void;
  assign: (key: string, id: string) => void;
  rememberConversation: (agentKey: string, threadId: string) => void;
  rememberPurpose: (key: string, text: string) => void;
  dismissAttention: (key: string, signature: string) => void;
}
export const useWorkbenchPreferences = create<Preferences>()(
  persist(
    (set) => ({
      agents: [],
      selectedAgentId: null,
      agentEnvironmentId: null,
      agentSyncTarget: "auto",
      assignments: {},
      lastConversations: {},
      purposes: {},
      dismissedAttention: {},
      storageError: null,
      saveAgent: (agent) => {
        const valid = parseAgent(agent);
        if (!valid) return;
        set((s) => ({
          agents: s.agents.some((a) => a.id === valid.id)
            ? s.agents.map((a) => (a.id === valid.id ? valid : a))
            : [...s.agents, valid],
          selectedAgentId: valid.id,
        }));
      },
      removeAgent: (id) =>
        set((s) => ({
          agents: s.agents.filter((a) => a.id !== id),
          selectedAgentId: s.selectedAgentId === id ? null : s.selectedAgentId,
          assignments: Object.fromEntries(
            Object.entries(s.assignments).filter(([, value]) => value !== id),
          ),
        })),
      selectAgent: (id) => set({ selectedAgentId: id }),
      selectAgentEnvironment: (id) => set({ agentEnvironmentId: id }),
      setAgentSyncTarget: (target) => set({ agentSyncTarget: target }),
      assign: (key, id) => set((s) => ({ assignments: { ...s.assignments, [key]: id } })),
      rememberConversation: (agentKey, threadId) =>
        set((s) =>
          s.lastConversations[agentKey] === threadId
            ? s
            : { lastConversations: { ...s.lastConversations, [agentKey]: threadId } },
        ),
      rememberPurpose: (key, text) =>
        set((s) =>
          s.purposes[key] || !text.trim() || text.trimStart().startsWith("/")
            ? s
            : {
                purposes: {
                  ...s.purposes,
                  [key]: {
                    text: summarizePurpose(text, 4000),
                    capturedAt: new Date().toISOString(),
                  },
                },
              },
        ),
      dismissAttention: (key, signature) =>
        set((s) => ({ dismissedAttention: { ...s.dismissedAttention, [key]: signature } })),
    }),
    {
      name: "workbench:profiles:v1",
      storage: createJSONStorage(() => ({
        getItem: (key) => {
          try {
            return localStorage.getItem(key);
          } catch {
            return null;
          }
        },
        setItem: (key, value) => {
          try {
            localStorage.setItem(key, value);
          } catch {
            queueMicrotask(() => {
              if (useWorkbenchPreferences.getState().storageError) return;
              useWorkbenchPreferences.setState({
                storageError:
                  "Your device could not save these changes. Keep this window open and free some storage before restarting.",
              });
            });
          }
        },
        removeItem: (key) => localStorage.removeItem(key),
      })),
      partialize: ({
        agents,
        selectedAgentId,
        agentEnvironmentId,
        agentSyncTarget,
        assignments,
        lastConversations,
        purposes,
        dismissedAttention,
      }) => ({
        agents,
        selectedAgentId,
        agentEnvironmentId,
        agentSyncTarget,
        assignments,
        lastConversations,
        purposes,
        dismissedAttention,
      }),
      merge: (value, current) => {
        if (!value || typeof value !== "object") return current;
        const p = value as Partial<Preferences>;
        const strings = (v: unknown): Record<string, string> =>
          v && typeof v === "object"
            ? Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === "string"))
            : {};
        return {
          ...current,
          agents: Array.isArray(p.agents)
            ? p.agents.flatMap((a) => {
                const valid = parseAgent(a);
                return valid ? [valid] : [];
              })
            : [],
          selectedAgentId: typeof p.selectedAgentId === "string" ? p.selectedAgentId : null,
          agentEnvironmentId:
            typeof p.agentEnvironmentId === "string" ? p.agentEnvironmentId : null,
          agentSyncTarget: typeof p.agentSyncTarget === "string" ? p.agentSyncTarget : "auto",
          assignments: strings(p.assignments),
          lastConversations: strings(p.lastConversations),
          dismissedAttention: strings(p.dismissedAttention),
          purposes:
            p.purposes && typeof p.purposes === "object"
              ? Object.fromEntries(
                  Object.entries(p.purposes).filter(
                    ([, v]) => v && typeof v.text === "string" && typeof v.capturedAt === "string",
                  ),
                )
              : {},
        };
      },
    },
  ),
);
