/**
 * How a Code pane's CLI is started in its terminal. Shared by the desktop Code
 * tab and the phone, so a pane launched from either reports its status the same way.
 */
const codePaneKinds = ["claude", "codex", "shell", "custom"] as const;
export type CodePaneKind = (typeof codePaneKinds)[number];

/** Terminals of the Code tab hang off this synthetic thread id, one per project. */
export const CODE_THREAD_PREFIX = "workbench-code:";

const base: Record<CodePaneKind, string | null> = {
  claude: "claude",
  codex: "codex",
  shell: null,
  custom: null,
};
const modelFlag: Partial<Record<CodePaneKind, string>> = { claude: "--model", codex: "-m" };

const STATUS_SETTINGS_ENV = "WORKBENCH_CLAUDE_STATUS_SETTINGS";
// A hook has no terminal of its own, so it writes to the one its parent CLI is on.
// The server reads `OSC 9001 ; <state>` out of the pane's output.
const report = (state: "working" | "needs-you" | "idle") => [
  {
    type: "command",
    command: `t=$(ps -o tty= -p $PPID | tr -d ' '); [ -n "$t" ] && [ -w "/dev/$t" ] && printf '\\033]9001;${state}\\007' > "/dev/$t"; true`,
  },
];
const claudeStatusSettings = JSON.stringify({
  hooks: {
    SessionStart: [{ hooks: report("idle") }],
    UserPromptSubmit: [{ hooks: report("working") }],
    // A finished tool means any question that held it up has been answered.
    PostToolUse: [{ hooks: report("working") }],
    PreToolUse: [{ matcher: "AskUserQuestion|ExitPlanMode", hooks: report("needs-you") }],
    Notification: [
      { matcher: "permission_prompt|elicitation_dialog", hooks: report("needs-you") },
      // An interrupted turn fires no Stop; this catches it a minute later.
      { matcher: "idle_prompt", hooks: report("idle") },
    ],
    Stop: [{ hooks: report("idle") }],
  },
});
/**
 * Per-launch flags that make a CLI report Working / Needs You / Idle. They add to
 * the user's own settings for that one run and change no file. Claude Code reports
 * through hooks; Codex through its terminal notification, which only covers the end
 * of a turn and approval requests.
 */
const statusFlags: Partial<Record<CodePaneKind, string>> = {
  claude: `--settings "$${STATUS_SETTINGS_ENV}"`,
  codex:
    "-c tui.notifications=true -c 'tui.notification_method=\"osc9\"' -c 'tui.notification_condition=\"always\"'",
};

/** Environment a pane's terminal is opened with, read by its launch command. */
export function paneEnvironment(kind: CodePaneKind): Record<string, string> | undefined {
  return kind === "claude" ? { [STATUS_SETTINGS_ENV]: claudeStatusSettings } : undefined;
}

/**
 * An opening prompt as one shell word. Control characters would act as keystrokes
 * in the terminal, and a leading dash would read as a flag, so neither survives.
 */
function promptArgument(prompt: string): string {
  // oxlint-disable-next-line no-control-regex
  const line = prompt.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  if (!line) return "";
  return ` '${line.startsWith("-") ? " " : ""}${line.replaceAll("'", "'\\''")}'`;
}

/**
 * The line typed into a new pane's shell. A model slug that cannot be quoted
 * safely is dropped, so the CLI starts on its own default rather than not at all.
 * `prompt` is the CLI's first message; custom commands and shells take none.
 */
export function launchCommand(
  kind: CodePaneKind,
  model?: string,
  custom?: string,
  prompt = "",
): string | null {
  // A custom command is the user's own line; it runs in their shell as typed.
  if (kind === "custom") return custom && !/[\r\n]/.test(custom) ? custom : null;
  if (!base[kind]) return null;
  const command = [base[kind], statusFlags[kind]].filter(Boolean).join(" ");
  const flag = modelFlag[kind];
  if (!flag || !model || !/^[\w.:/@[\]-]{1,200}$/.test(model))
    return command + promptArgument(prompt);
  return `${command} ${flag} '${model}'${promptArgument(prompt)}`;
}

export type PaneActivity =
  | "starting"
  | "shell"
  | "running"
  | "working"
  | "needs-you"
  | "idle"
  | "ended";

/** What a pane is doing, from the terminal summary the server streams. */
export function paneActivity(
  session:
    | {
        readonly status: string;
        readonly hasRunningSubprocess: boolean;
        readonly agentState?: "working" | "needs-you" | "idle" | null | undefined;
      }
    | undefined,
): PaneActivity {
  if (!session || session.status === "starting") return "starting";
  if (session.status !== "running") return "ended";
  if (!session.hasRunningSubprocess) return "shell";
  return session.agentState ?? "running";
}
