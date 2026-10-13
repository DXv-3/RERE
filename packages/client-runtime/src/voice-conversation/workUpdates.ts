interface VoiceWorkSnapshot {
  messages: readonly {
    id: string;
    runId: string | null;
    role: string;
    text: string;
    streaming: boolean;
  }[];
  runs: readonly { id: string; status: string }[];
  runtimeRequests: readonly { id: string; status: string }[];
}
const terminal = (status: string) =>
  ["completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(status);
/** Observe the existing thread stream; history loaded before the call is context, not new news. */
export function createVoiceWorkObserver(
  initial: VoiceWorkSnapshot,
  options: { speakProgress?: boolean } = {},
) {
  const seen = new Set(
    initial.messages.filter((message) => !message.streaming).map((message) => message.id),
  );
  const spoken = new Set(initial.runs.filter((run) => terminal(run.status)).map((run) => run.id));
  return (snapshot: VoiceWorkSnapshot) => {
    const updates: { text: string; speak: boolean }[] = [];
    for (const message of snapshot.messages) {
      if (
        message.role !== "assistant" ||
        message.streaming ||
        !message.text.trim() ||
        seen.has(message.id)
      )
        continue;
      seen.add(message.id);
      // The final reply is announced once below, even when it arrives in the same snapshot.
      if (
        options.speakProgress &&
        snapshot.runs.some((run) => run.id === message.runId && terminal(run.status))
      )
        continue;
      updates.push({
        text: `Agent progress: ${message.text.slice(0, 1800)}`,
        speak: options.speakProgress ?? false,
      });
    }
    for (const run of snapshot.runs) {
      if (!terminal(run.status) || spoken.has(run.id)) continue;
      let result: VoiceWorkSnapshot["messages"][number] | undefined;
      for (let index = snapshot.messages.length - 1; index >= 0; index--) {
        const message = snapshot.messages[index]!;
        if (message.runId === run.id && message.role === "assistant") {
          result = message;
          break;
        }
      }
      if (result?.streaming) continue;
      spoken.add(run.id);
      updates.push({
        text: `Agent run ${run.status}. ${result?.text.slice(0, 2400) ?? "No final reply is available; check the thread."}`,
        speak: true,
      });
    }
    for (const request of snapshot.runtimeRequests) {
      if (request.status !== "pending" || seen.has(request.id)) continue;
      seen.add(request.id);
      updates.push({
        text: "Your agent needs your attention. Open its conversation to answer the pending question or approval request.",
        speak: true,
      });
    }
    return updates;
  };
}
