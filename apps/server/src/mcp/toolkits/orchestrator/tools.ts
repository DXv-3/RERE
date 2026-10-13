import {
  AgentTeamListResult,
  AgentTeamCreateInput,
  AgentTeamCreateResult,
  AgentTeamSendInput,
  AgentTeamSendResult,
  AgentSecretMcpFileInput,
  AgentSecretMcpFileResult,
  AgentSecretMcpListResult,
  AgentSecretMcpRequestInput,
  AgentSecretMcpRequestResult,
  AgentGoalMcpListResult,
  AgentGoalMcpReportCheckInInput,
  AgentGoalMcpReportCheckInResult,
  AgentGoalMcpResult,
  AgentGoalMcpSetInput,
  AgentGoalMcpSetStatusInput,
  OrchestratorMcpCapabilitiesResult,
  OrchestratorMcpCreateThreadsInput,
  OrchestratorMcpCreateThreadsResult,
  OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpDeleteScheduledTaskInput,
  OrchestratorMcpDeleteScheduledTaskResult,
  OrchestratorMcpFailure,
  OrchestratorMcpListScheduledTasksResult,
  OrchestratorMcpScheduleTaskInput,
  OrchestratorMcpScheduleTaskResult,
  OrchestratorMcpTaskCancelInput,
  OrchestratorMcpTaskCancelResult,
  OrchestratorMcpUpdateScheduledTaskInput,
  OrchestratorMcpTaskStatusInput,
  OrchestratorMcpThreadInterruptInput,
  OrchestratorMcpThreadInterruptResult,
  OrchestratorMcpThreadListInput,
  OrchestratorMcpThreadListResult,
  OrchestratorMcpThreadReadInput,
  OrchestratorMcpThreadReadResult,
  OrchestratorMcpThreadSendInput,
  OrchestratorMcpThreadSendResult,
  OrchestratorMcpThreadWaitInput,
  OrchestratorMcpThreadWaitResult,
  ThreadMetadataMcpUpdateInput,
  ThreadMetadataMcpUpdateResult,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as AgentGoalsMcpService from "../../AgentGoalsMcpService.ts";
import * as AgentSecretsMcpService from "../../AgentSecretsMcpService.ts";
import * as AgentTeamMcpService from "../../AgentTeamMcpService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import * as ThreadMetadataMcpService from "../../ThreadMetadataMcpService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  OrchestratorMcpService.OrchestratorMcpService,
];
const threadMetadataDependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadMetadataMcpService.ThreadMetadataMcpService,
];

const agentGoalDependencies = [
  McpInvocationContext.McpInvocationContext,
  AgentGoalsMcpService.AgentGoalsMcpService,
];

const agentTeamDependencies = [
  McpInvocationContext.McpInvocationContext,
  AgentTeamMcpService.AgentTeamMcpService,
];

const agentSecretDependencies = [
  McpInvocationContext.McpInvocationContext,
  AgentSecretsMcpService.AgentSecretsMcpService,
];

const OrchestratorCapabilitiesTool = Tool.make("orchestrator_capabilities", {
  description:
    "List the V2 provider instances and their current models from the same live catalog as the composer, including configured custom models, inherited runtime settings, and app-owned orchestration features available to this CodeWrench thread. For a separate top-level thread in a new or existing worktree, use t3_thread_launch with workspaceStrategy.",
  success: OrchestratorMcpCapabilitiesResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Get orchestration capabilities")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const DelegateTaskTool = Tool.make("delegate_task", {
  description:
    "Delegate one task to a CodeWrench-owned child agent/subagent of THIS thread and run it with only the supplied task prompt, without copying parent conversation history. Choose providers and models from orchestrator_capabilities, which uses the same live catalog as the composer. Prefer native subagent tools for same-provider work only when they support the chosen model. Use this for any model missing from the native tool, including same-provider work, for cross-provider work, or for explicitly CodeWrench-owned child tasks. The childThreadId is backing storage, not an ordinary top-level thread. Provider, model, model options (see orchestrator_capabilities), runtime mode, and interaction mode inherit unless target overrides them. Prefer mode='async' for long work; mode='wait' blocks until completion or timeout. timeoutMs on mode=wait is only the parent's wait budget and does not cancel the child. waitTimedOut on that wait call means the timeout fired; keep that taskId and read status on later task_status. An async child's completion wakes this thread through a notification, steered into active turns where supported or queued otherwise, so end the turn instead of polling or spawning watchers; use task_status only when the result is needed mid-turn.",
  parameters: OrchestratorMcpDelegateTaskInput,
  success: OrchestratorMcpDelegateTaskResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Delegate a child task")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const TaskStatusTool = Tool.make("task_status", {
  description:
    "Read a CodeWrench-owned delegated task created by this parent thread. childRunId identifies the original delegated run. workState distinguishes working, waiting_for_children, and result_available; a completed turn with live nested work is not a completed task. summary is the final task result, including provider errors on failure, and remains stable after publication. hasPendingChildRuns reports later queued or executing turns; latestTerminal* provides later non-monitor turn results. Reading a terminal result acknowledges its automatic parent delivery.",
  parameters: OrchestratorMcpTaskStatusInput,
  success: OrchestratorMcpDelegateTaskResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Get delegated task status")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const TaskCancelTool = Tool.make("task_cancel", {
  description:
    "Request interruption of an active CodeWrench-owned delegated task and dispose its automatic parent delivery. Completed task results remain available.",
  parameters: OrchestratorMcpTaskCancelInput,
  success: OrchestratorMcpTaskCancelResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Cancel delegated task")
  .annotate(Tool.Destructive, true);

export const ScheduleTaskTool = Tool.make("schedule_task", {
  description:
    "Create persistent recurring work in the app scheduler, which runs even when no turn is active. Pass schedule as a STRUCTURED OBJECT, never JSON text: {type:'interval', everyMs:3600000} means hourly; {type:'fixed_time', timeOfDay:'09:00', weekdays:[1,2,3,4,5]} means weekday mornings. By default (bindToCurrentThread=true) each run posts into THIS thread; use false only when the user wants a fresh top-level thread per run. Provider, model, and runtime settings inherit from this thread. Report the returned schedule and nextRunAt after success.",
  parameters: OrchestratorMcpScheduleTaskInput,
  success: OrchestratorMcpScheduleTaskResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Schedule a recurring task")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const ListScheduledTasksTool = Tool.make("list_scheduled_tasks", {
  description:
    "List the recurring scheduled tasks in the calling thread's project, including their id, schedule, prompt, enabled state, bound thread, next run time, and last run status. Use the returned scheduledTaskId with update_scheduled_task or delete_scheduled_task.",
  success: OrchestratorMcpListScheduledTasksResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List scheduled tasks")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const UpdateScheduledTaskTool = Tool.make("update_scheduled_task", {
  description:
    "Update an existing scheduled task by scheduledTaskId (from list_scheduled_tasks). Only the provided fields change; omit a field to leave it as-is. Use enabled=false to pause a task without deleting it. Set bindToCurrentThread to move the task between posting into this thread and launching a fresh thread per run.",
  parameters: OrchestratorMcpUpdateScheduledTaskInput,
  success: OrchestratorMcpScheduleTaskResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Update a scheduled task")
  .annotate(Tool.Destructive, true);

const DeleteScheduledTaskTool = Tool.make("delete_scheduled_task", {
  description:
    "Permanently delete a scheduled task by scheduledTaskId (from list_scheduled_tasks). The task stops running immediately. To keep it but stop runs, use update_scheduled_task with enabled=false instead.",
  parameters: OrchestratorMcpDeleteScheduledTaskInput,
  success: OrchestratorMcpDeleteScheduledTaskResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Delete a scheduled task")
  .annotate(Tool.Destructive, true);

export const CreateThreadsTool = Tool.make("create_threads", {
  description:
    "Create one or more ORDINARY TOP-LEVEL CodeWrench conversations. This is not delegation and does not create child agents/subagents. For delegated work, choose models from orchestrator_capabilities. Prefer native subagents only when they support the chosen model; otherwise call delegate_task, including for same-provider work. Use create_threads for a batch of separate top-level threads sharing this checkout. Prefer t3_thread_launch for a single thread. Both require the user to request separate/new/top-level threads or conversations. Each entry may override provider, model, options, runtime mode, and interaction mode; omitted settings inherit. Project, branch, and worktree always inherit and cannot be overridden here. For independent implementation or a PR stack in its own worktree, use t3_thread_launch with workspaceStrategy instead of asking the agent to create a worktree in its prompt.",
  parameters: OrchestratorMcpCreateThreadsInput,
  success: OrchestratorMcpCreateThreadsResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Create CodeWrench threads")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const ThreadListTool = Tool.make("t3_thread_list", {
  description:
    "List CodeWrench threads in the calling thread's project, newest first. Filter by durable run status, title, or settled state (settled=true lists threads the user or auto-settlement moved out of the active list) and paginate with the returned cursor. Threads from other projects are never exposed. With cross-project access on (the server default), pass projectId from t3_project_list to list another project's threads.",
  parameters: OrchestratorMcpThreadListInput,
  success: OrchestratorMcpThreadListResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List CodeWrench threads")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const ThreadReadTool = Tool.make("t3_thread_read", {
  description:
    "Read durable state and a paginated timeline from a CodeWrench thread in the calling project, or from a thread the user attached to this conversation as context. To see where a thread left off, pass latest=true: it returns only the newest few items, shortened, in one call. Never page through a long thread from the start to find its end, and do not read the same thread again when nothing has changed. The default messages view returns user messages, assistant messages, and proposed plans; activity returns all summarized timeline items. Reading an untruncated terminal assistant result from this parent thread's direct app-owned child acknowledges that child's automatic completion delivery. Continue with afterPosition=nextPosition. Recover long item text with itemId and textOffset=nextTextOffset until nextTextOffset is null; offsets count UTF-16 code units. With cross-project access on (the server default), any thread on this server can be read by id, whatever its project.",
  parameters: OrchestratorMcpThreadReadInput,
  success: OrchestratorMcpThreadReadResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Read a CodeWrench thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ThreadUpdateTool = Tool.make("t3_thread_update", {
  description:
    "Update metadata for a thread in the calling project. Omit threadId to update this thread. Use action='rename' with title, action='regenerate_title' with no extra field, action='link_pull_request' with pullRequest, or action='unlink_pull_request'. Workspace and branch changes are intentionally not supported. clientRequestId makes retries idempotent.",
  parameters: ThreadMetadataMcpUpdateInput,
  success: ThreadMetadataMcpUpdateResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: threadMetadataDependencies,
})
  .annotate(Tool.Title, "Update CodeWrench thread metadata")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false);

const ThreadSendTool = Tool.make("t3_thread_send", {
  description:
    "Send a message to another CodeWrench thread in the calling project; the calling thread itself is refused. mode='auto' starts an idle thread, steers a fully active turn, or queues behind a turn that is not yet steerable. Use queue for a separate follow-up turn, steer for an in-flight update, or restart to interrupt-and-restart the active turn. clientRequestId makes retries idempotent. With cross-project access on (the server default), the target may be any thread on this server, in any project and with any permission mode.",
  parameters: OrchestratorMcpThreadSendInput,
  success: OrchestratorMcpThreadSendResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Send to a CodeWrench thread")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const ThreadWaitTool = Tool.make("t3_thread_wait", {
  description:
    "Wait for a CodeWrench thread run to reach a terminal durable state. Without runId, the latest run at call time is selected; an idle thread returns immediately. Timeout does not interrupt work, so call again or use t3_thread_read/list after timedOut=true. Waiting reports status only and does not acknowledge a delegated result.",
  parameters: OrchestratorMcpThreadWaitInput,
  success: OrchestratorMcpThreadWaitResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Wait for a CodeWrench thread")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const ThreadInterruptTool = Tool.make("t3_thread_interrupt", {
  description:
    "Request interruption of a running turn in a CodeWrench thread in the calling project. Without runId, the newest interruptible run is selected. Terminal runs and threads without an active turn return without another side effect. clientRequestId makes retries idempotent.",
  parameters: OrchestratorMcpThreadInterruptInput,
  success: OrchestratorMcpThreadInterruptResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Interrupt a CodeWrench thread")
  .annotate(Tool.Destructive, true);

export const AgentListTool = Tool.make("agent_list", {
  description:
    "List the agents on this server: id, name, a one-line role, status (idle, working, needs_input, failed, or not_started when it has no conversation yet), its current active goal title if any, and isYou for your own entry. Archived agents are left out and instructions are never returned beyond a short excerpt. Use a name or agentId from here with agent_send.",
  success: AgentTeamListResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: agentTeamDependencies,
})
  .annotate(Tool.Title, "List agents")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const AgentSendTool = Tool.make("agent_send", {
  description:
    'Assign work, give feedback, or redirect another agent by name or id (see agent_list). Its first assignment automatically prepares its own conversation and personal workspace; an idle agent starts, a working one is queued or steered. Include the task, relevant context, and completion criteria. By default (awaitReply true) its final message comes back automatically as "Reply from agent <name>" and wakes you; failures also report back. Pass awaitReply false for a message that needs no answer. Use mode="steer" to redirect active work. You cannot message yourself, and a chain of agent messages is cut off after 3 hops. An unknown or ambiguous name is refused with the closest matches. clientRequestId makes retries idempotent.',
  parameters: AgentTeamSendInput,
  success: AgentTeamSendResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: agentTeamDependencies,
})
  .annotate(Tool.Title, "Message an agent")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const AgentCreateTool = Tool.make("agent_create", {
  description:
    "Create a persistent teammate with its own visible agent profile, instructions, personal workspace, and conversation, and start its first assignment. Use this when the user asks to create another bot/agent; use delegate_task for a temporary child task. Choose a suitable modelSelection from orchestrator_capabilities or inherit the caller's model. Supply the work remaining, relevant evidence, and completion criteria in message; historical approvals do not become new permission. The final result returns automatically to you. Keep the returned agentId/threadId for agent_send, t3_thread_read, and t3_thread_interrupt. Reuse clientRequestId on retries: one creation key creates one agent and one initial assignment. No recurring schedule is created.",
  parameters: AgentTeamCreateInput,
  success: AgentTeamCreateResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: agentTeamDependencies,
})
  .annotate(Tool.Title, "Create and start an agent")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true)
  .annotate(Tool.Idempotent, true);

const GoalListTool = Tool.make("goal_list", {
  description:
    "List the standing goals of this thread's agent: id, title, outcome, schedule, autonomy, and status (active, paused or done). Use the returned goalId with goal_set, goal_set_status and report_checkin.",
  success: AgentGoalMcpListResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: agentGoalDependencies,
})
  .annotate(Tool.Title, "List standing goals")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const GoalSetTool = Tool.make("goal_set", {
  description:
    "Create or edit a standing goal. The agent gets a turn on the schedule and must finish it with report_checkin. Leave out goalId to create a goal; pass a goalId from goal_list to edit it. Give a short title, the outcome in plain words, and a schedule as a STRUCTURED OBJECT such as {type:'interval', everyMs:86400000} (daily) or {type:'fixed_time', timeOfDay:'09:00'}. autonomy is propose (default, plan and report only), act_and_report, or act_freely. Report the returned goal id and status.",
  parameters: AgentGoalMcpSetInput,
  success: AgentGoalMcpResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: agentGoalDependencies,
})
  .annotate(Tool.Title, "Create or edit a goal")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const GoalSetStatusTool = Tool.make("goal_set_status", {
  description:
    "Change a standing goal's status by goalId (from goal_list). paused stops its scheduled turns until it is resumed with active; done ends the goal. Use report_checkin with done=true when you finish a goal yourself.",
  parameters: AgentGoalMcpSetStatusInput,
  success: AgentGoalMcpResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: agentGoalDependencies,
})
  .annotate(Tool.Title, "Change a goal's status")
  .annotate(Tool.Destructive, true);

const ReportCheckInTool = Tool.make("report_checkin", {
  description:
    "File your check-in for a standing goal. Call this once at the end of every goal turn, with the goalId from the turn's instructions. summary: what you did and what you found, in a few plain sentences. needsFromOwner: only if you need a decision or input from the owner. done: true only if the goal's outcome is fully achieved. The owner then approves, redirects or dismisses it. Calling again for the same turn replaces your earlier check-in while the owner has not reviewed it.",
  parameters: AgentGoalMcpReportCheckInInput,
  success: AgentGoalMcpReportCheckInResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: agentGoalDependencies,
})
  .annotate(Tool.Title, "File a goal check-in")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const SecretRequestTool = Tool.make("secret_request", {
  description:
    "Ask the owner for a secret you need, such as an API key or a password. The owner sees a prompt and types the value; it is kept out of this conversation. This returns at once with status 'requested': finish your turn now, because you will be told in a later message when the owner answers (or declines). If a secret with this name already exists the status is 'available' and you can use it straight away; pass replace=true to ask again, for example because the stored one stopped working. name is an ENV_VAR style name such as STRIPE_API_KEY. suggestedOrigin may name the site the secret is for; the owner decides whether to limit the secret to it. If the owner declines, do not ask for the same secret again for 10 minutes. Do not ask for a secret in chat instead.",
  parameters: AgentSecretMcpRequestInput,
  success: AgentSecretMcpRequestResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: agentSecretDependencies,
})
  .annotate(Tool.Title, "Ask the owner for a secret")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const SecretListTool = Tool.make("secret_list", {
  description:
    "List the secrets the owner gave this agent: name, label, kind and the sites the owner limited each to (empty means any site). The list does not include the values. Use a name with secret_file or with preview_type's secretName.",
  success: AgentSecretMcpListResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: agentSecretDependencies,
})
  .annotate(Tool.Title, "List secrets")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const SecretFileTool = Tool.make("secret_file", {
  description:
    'Write one of your secrets to a file and return its absolute path. The file is readable only by the user the server runs as, which is the user your own commands run as, so it is private from other accounts but not from you. It does not return the value. Reference the file from commands, for example API_KEY="$(cat <path>)" some-command, so the shell reads the value and you do not. Do not print, echo, log, commit, paste or write the value anywhere, and do not copy the file into the project. Calling it again returns the same path.',
  parameters: AgentSecretMcpFileInput,
  success: AgentSecretMcpFileResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: agentSecretDependencies,
})
  .annotate(Tool.Title, "Get a secret's file")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const OrchestratorToolkit = Toolkit.make(
  OrchestratorCapabilitiesTool,
  DelegateTaskTool,
  TaskStatusTool,
  TaskCancelTool,
  ScheduleTaskTool,
  ListScheduledTasksTool,
  UpdateScheduledTaskTool,
  DeleteScheduledTaskTool,
  CreateThreadsTool,
  ThreadListTool,
  ThreadReadTool,
  ThreadUpdateTool,
  ThreadSendTool,
  ThreadWaitTool,
  ThreadInterruptTool,
  AgentListTool,
  AgentSendTool,
  AgentCreateTool,
  GoalListTool,
  GoalSetTool,
  GoalSetStatusTool,
  ReportCheckInTool,
  SecretRequestTool,
  SecretListTool,
  SecretFileTool,
);
