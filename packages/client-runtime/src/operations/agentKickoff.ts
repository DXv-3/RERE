/**
 * The first message a newly created agent receives, so it starts on its purpose without waiting
 * to be spoken to. The server adds the agent's own instructions and memory to every message, so
 * this only has to say "begin" and ask for a report. Null when the agent has no instructions yet:
 * there is nothing for it to start on.
 */
export function agentKickoffMessage(profile: { readonly instructions: string }): string | null {
  return profile.instructions.trim() === ""
    ? null
    : "You have just been set up. Start on your purpose now, following your instructions. When you finish this first pass, report what you did, what you found, and what you need from me.";
}
