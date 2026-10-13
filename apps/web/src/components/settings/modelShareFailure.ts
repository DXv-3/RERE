const REASON_MESSAGES: Readonly<Record<string, string>> = {
  model_share_sign_in_required:
    "Sign in on this machine first to share by email. A share code still works.",
  model_share_email_invalid: "That email address does not look right. Check it and try again.",
  model_share_email_limit:
    "Too many email invitations are waiting to be accepted. Revoke one first, or use a share code.",
  model_share_email_unavailable:
    "Inviting by email is not available yet, or CodeWrench could not be reached. Leave the email empty and send a share code instead.",
};

/** The machine a failed request was made to, so the words can name it. */
export interface ModelShareFailureMachine {
  readonly label: string;
  readonly origin: string | null;
}

/**
 * Said when a machine refuses this sign-in for sharing. Pairing a remote machine from this app
 * does not grant the access scopes unless the pairing link was an administrator one, so the
 * dependable way in is that machine's own web address.
 */
export function cannotManageSharingMessage(machine?: ModelShareFailureMachine): string {
  const where = machine?.origin ?? "that machine's web address";
  const who = machine ? machine.label : "this machine";
  return `This sign-in cannot manage sharing on ${who}. Open ${where} in a browser, sign in there as its owner, and create the share in Settings > Connections > Shared models.`;
}

function field(cause: unknown, name: string): unknown {
  return typeof cause === "object" && cause !== null && name in cause
    ? (cause as Record<string, unknown>)[name]
    : undefined;
}

/** A 401 or 403 from the environment, in any of the shapes the client reports one. */
function isSignInRefused(cause: unknown): boolean {
  const tag = field(cause, "_tag");
  if (tag === "EnvironmentScopeRequiredError" || tag === "EnvironmentAuthInvalidError") return true;
  const status = field(cause, "status");
  return tag === "RemoteEnvironmentAuthUndeclaredStatusError" && (status === 401 || status === 403);
}

/** Words for the owner when creating, listing or revoking a share fails. */
export function describeModelShareFailure(
  cause: unknown,
  machine?: ModelShareFailureMachine,
): string {
  if (isSignInRefused(cause)) return cannotManageSharingMessage(machine);
  const reason = field(cause, "reason");
  const known = typeof reason === "string" ? REASON_MESSAGES[reason] : undefined;
  if (known) return known;
  return cause instanceof Error && cause.message.trim().length > 0
    ? cause.message
    : "The environment did not answer. Try again.";
}
