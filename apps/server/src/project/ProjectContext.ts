import type { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";

/** The index file every thread reads; other memory files are opened on demand. */
const PROJECT_MEMORY_INDEX_FILE = "MEMORY.md";
const MEMORY_INDEX_MAX_CHARS = 4_000;

/** Where a project's memory files live. Server-owned, outside any checkout. */
export function projectMemoryDir(stateDir: string, projectId: ProjectId): string {
  return `${stateDir}/project-memory/${projectId.replaceAll(/[^A-Za-z0-9._-]/g, "_")}`;
}

/** The memory index, or null when the project has none yet. Unreadable counts as none. */
export const readProjectMemoryIndex = (fileSystem: FileSystem.FileSystem, memoryDir: string) =>
  fileSystem.readFileString(`${memoryDir}/${PROJECT_MEMORY_INDEX_FILE}`).pipe(
    Effect.map((text) => (text.trim().length === 0 ? null : text.trim())),
    Effect.orElseSucceed(() => null),
  );

/**
 * How the project's one coordinating conversation works. The user sends it everything; it
 * hands the work to threads and reports what comes back.
 */
const PROJECT_COORDINATOR_INSTRUCTIONS = `You are this project's coordinator. The user sends all of the project's work to this one conversation. Your job is to route that work and report on it, not to do it yourself.

- A quick question you can answer from what you know or by reading files: answer it here.
- A piece of work: give it to a worker thread. Start one with t3_thread_launch, with a short title, workspaceStrategy {"type":"worktree","baseRef":<the branch the project instructions name, otherwise the repository's default branch>,"branch":<a new, descriptive branch name>,"startFromOrigin":true}, and the whole task in message. Leave projectId and modelSelection out. A worker starts with this project's goal, instructions and memory but with nothing from this conversation, so the message must stand on its own: what to do, where, how to check it, and to open a pull request and link it when the work calls for one. If the project folder is not a git repository, use workspaceStrategy {"type":"root"} and run one worker at a time.
- A follow-up to work a thread already has: send it to that thread with t3_thread_send instead of starting another.
- Several unrelated tasks in one message become separate threads.
- Unless project memory records that the user wants threads started without asking, first list the threads you propose, one line each, and wait for their go-ahead. When they tell you to start without asking, record that in project memory.
- Do not edit files, run builds or commit in this conversation. It runs in the project's main checkout, which workers branch from.
- After starting or messaging a thread, say which thread got what, then end your turn. Do not wait or poll. When a worker's run ends you receive a message that begins "Reply from agent" followed by the thread's title; it is the worker's report, not the user. Tell the user the outcome in a line or two: what was done, the pull request if there is one, and anything waiting on them.
- When asked for status, use t3_thread_list and t3_thread_read rather than answering from memory.
- When the user states a preference about how to run the project, such as how many threads at once, when to open pull requests, or shorter updates, follow it and record it in project memory so it holds in later conversations.
- Keep your replies short.`;

/**
 * The standing context a thread starts with: the project's goal, instructions and memory.
 * Empty when the project has set none of them, so projects that do not use the feature send
 * nothing extra. It goes to the provider ahead of the user's message and is never stored in
 * the conversation.
 */
export function renderProjectContext(input: {
  readonly title: string;
  readonly goal: string | null;
  readonly instructions: string | null;
  /** Null when memory is unavailable on this server. */
  readonly memoryDir: string | null;
  readonly memoryIndex: string | null;
  /** The thread is the project's coordinating conversation, which always gets its role. */
  readonly coordinator?: boolean;
}): string {
  const goal = input.goal?.trim() ?? "";
  const instructions = input.instructions?.trim() ?? "";
  const memoryIndex = input.memoryIndex?.trim() ?? "";
  const coordinator = input.coordinator === true;
  if (goal === "" && instructions === "" && memoryIndex === "" && !coordinator) return "";

  const sections = [
    `This thread belongs to the CodeWrench project "${input.title}". The text in this block is the project's standing context, set by the user ahead of time. It is not part of their message.`,
  ];
  if (goal !== "") sections.push(`Project goal: ${goal}`);
  if (instructions !== "") sections.push(`Project instructions:\n${instructions}`);
  if (input.memoryDir !== null) {
    const index =
      memoryIndex === ""
        ? "(empty)"
        : memoryIndex.length <= MEMORY_INDEX_MAX_CHARS
          ? memoryIndex
          : `${memoryIndex.slice(0, MEMORY_INDEX_MAX_CHARS)}\n[Index truncated; read the file for the rest.]`;
    sections.push(
      `Project memory: notes shared by every thread in this project are files in ${input.memoryDir}. ${PROJECT_MEMORY_INDEX_FILE} there is the index:\n${index}\nOpen the other files in that folder when they are relevant. When the user asks you to remember or forget something for the project, edit those files and keep ${PROJECT_MEMORY_INDEX_FILE} as an index with one line per file.`,
    );
  }
  if (coordinator) sections.push(PROJECT_COORDINATOR_INSTRUCTIONS);
  return `<project_context>\n${sections.join("\n\n")}\n</project_context>`;
}
