import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
export interface VoiceTarget {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  name: string;
}
export const OPEN_VOICE_CONVERSATION = "workbench:open-voice-conversation";
export function openVoiceConversation(target: VoiceTarget) {
  window.dispatchEvent(new CustomEvent(OPEN_VOICE_CONVERSATION, { detail: target }));
}
