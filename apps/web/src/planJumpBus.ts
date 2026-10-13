// Tiny event bus so the composer's plan banner can ask the timeline to scroll to a plan
// without sharing React state or refs with it.
const PLAN_JUMP_EVENT = "codewrench:jump-to-plan";

export function requestPlanJump(planId: string): void {
  window.dispatchEvent(new CustomEvent<string>(PLAN_JUMP_EVENT, { detail: planId }));
}

export function onPlanJumpRequested(listener: (planId: string) => void): () => void {
  const handler = (event: Event) => listener((event as CustomEvent<string>).detail);
  window.addEventListener(PLAN_JUMP_EVENT, handler);
  return () => window.removeEventListener(PLAN_JUMP_EVENT, handler);
}
