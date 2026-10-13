import { MODEL_SHARE_ROUTE_PREFIX, type ModelShareCreateResult } from "@t3tools/contracts";

import { formatModelShareCode } from "./modelShareCode";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The address a share's holder reaches this environment at, when this window knows one: the page
 * itself, unless it was opened on the machine (loopback) or inside the desktop app.
 */
export function publicEnvironmentOrigin(location: Pick<Location, "origin" | "hostname">) {
  return /^https?:\/\//.test(location.origin) && !LOOPBACK_HOSTNAMES.has(location.hostname)
    ? location.origin
    : null;
}

/**
 * Said in place of setup steps when this window knows no address other people can reach. A code
 * made here cannot work for someone elsewhere, and a placeholder address sent on to them only
 * hides that: the first such share reached a friend as "https://<this server's address>".
 */
export const UNREACHABLE_SHARE_NOTICE = [
  "This share cannot be used from outside this machine's network yet: CodeWrench does not know an address other people can reach it at, so there is nothing complete to send.",
  "",
  "To share with someone elsewhere, do one of these:",
  "1. Type their email above instead of sending a code. Their CodeWrench finds the model by itself.",
  "2. Create the share on a server with a public address: open that server's web address in a browser, sign in, and create the share there.",
  "",
  "This share was still created. Revoke it below if you do not need it.",
].join("\n");

/** What to send the person a share was made for, ready to paste into a message. */
export function modelShareInstructions(input: {
  readonly created: ModelShareCreateResult;
  readonly origin: string | null;
}): string {
  if (input.origin === null) return UNREACHABLE_SHARE_NOTICE;
  const baseUrl = `${input.origin}${MODEL_SHARE_ROUTE_PREFIX}`;
  return [
    "In CodeWrench, open Settings > Connections > Add a shared model and paste this code:",
    formatModelShareCode({
      baseUrl,
      token: input.created.token,
      models: input.created.share.models,
    }),
    "",
    "Or set it up by hand:",
    "In CodeWrench, open Settings > Providers, add a Claude provider, and give it these environment variables:",
    `ANTHROPIC_BASE_URL=${baseUrl}`,
    `ANTHROPIC_AUTH_TOKEN=${input.created.token}`,
    `Then add these custom models: ${input.created.share.models.join(", ")}`,
  ].join("\n");
}

/** What the owner is told after sharing by email: whether the person was also emailed. */
export function modelShareInviteNotice(input: {
  readonly recipientEmail: string;
  readonly emailed: boolean | undefined;
}): string {
  return input.emailed === true
    ? `Shared with ${input.recipientEmail}. We emailed them, and it appears in their CodeWrench when they sign in.`
    : `Shared with ${input.recipientEmail}. It appears in their CodeWrench when they sign in.`;
}
