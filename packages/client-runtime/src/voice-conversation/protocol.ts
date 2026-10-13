/** Live transcripts are fragments, not complete turns. Only a delegation submits work. */
export function createVoiceConversationProtocol(onDelegate: (id: string, context: string) => void) {
  let history: { role: string; text: string }[] = [];
  let pendingSpeech = "";
  let userRevision = 0;
  let delegatedRevision = 0;
  const seen = new Set<string>();
  const delegations = new Set<string>();
  return {
    transcript: () => history.map((item) => `${item.role}: ${item.text}`).join("\n"),
    receive(value: unknown) {
      if (!value || typeof value !== "object" || !("type" in value)) return;
      const event = value as Record<string, unknown>;
      if (typeof event.event_id === "string") {
        if (seen.has(event.event_id)) return;
        seen.add(event.event_id);
        if (seen.size > 4000) seen.delete(seen.values().next().value!);
      }
      if (
        (event.type === "session.input_transcript.delta" ||
          event.type === "session.output_transcript.delta") &&
        typeof event.delta === "string"
      ) {
        const role = event.type === "session.input_transcript.delta" ? "User" : "Voice";
        const last = history.at(-1);
        if (last?.role === role) last.text = (last.text + event.delta).slice(-12000);
        else history.push({ role, text: event.delta.slice(-12000) });
        history = history.slice(-30);
        let excess = history.reduce((length, item) => length + item.text.length, 0) - 12000;
        while (excess > 0 && history.length) {
          const first = history[0]!;
          if (first.text.length <= excess) {
            excess -= first.text.length;
            history.shift();
          } else {
            first.text = first.text.slice(excess);
            excess = 0;
          }
        }
        if (role === "User") {
          pendingSpeech = (pendingSpeech + event.delta).slice(-4000);
          if (event.delta.trim()) userRevision++;
        }
      }
      if (event.type !== "session.delegation.created") return;
      const delegation = event.delegation;
      if (
        !delegation ||
        typeof delegation !== "object" ||
        !("id" in delegation) ||
        typeof delegation.id !== "string" ||
        !("target" in delegation) ||
        delegation.target !== "client"
      )
        return;
      if (delegations.has(delegation.id)) return;
      delegations.add(delegation.id);
      if (delegations.size > 4000) delegations.delete(delegations.values().next().value!);
      // Repeated delegation with no new speech must not repeat an action.
      if (userRevision === delegatedRevision) return;
      delegatedRevision = userRevision;
      const context = history
        .map((item) => `${item.role}: ${item.text}`)
        .join("\n")
        .slice(-7000);
      onDelegate(
        delegation.id,
        `New user speech since the last request:\n${pendingSpeech}\n\nRecent conversation (context only):\n${context}`,
      );
      pendingSpeech = "";
    },
  };
}

/** Each Live append is capped at 500 tokens. 400 UTF-8 bytes is a conservative bound. */
export function voiceUpdateChunks(text: string): string[] {
  const chunks: string[] = [];
  let chunk = "";
  let bytes = 0;
  for (const character of text.slice(0, 6000)) {
    const size = new TextEncoder().encode(character).length;
    if (bytes + size > 400) {
      chunks.push(chunk);
      chunk = "";
      bytes = 0;
    }
    chunk += character;
    bytes += size;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}
