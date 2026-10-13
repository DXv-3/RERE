/**
 * The email a person gets when someone shares an AI model with them.
 *
 * WORDING APPROVED by the owner on 2026-10-09. Changing it needs his OK. Everything the recipient
 * reads is in this one file.
 *
 * The email never carries the share token, the sealed token or the share address. It only tells
 * the person to open CodeWrench and sign in.
 */

// The newest Mac build on Savage Digital Solutions' own download address. The approved wording
// says "Download it for Mac", so this is the Mac installer itself, not the download page that
// APP_DOWNLOAD_URL in apps/web/src/branding.ts points at.
const DOWNLOAD_URL = "https://downloads.savagesolutions.io/codewrench/mac/CodeWrench-mac-arm64.zip";

const MAX_MACHINE_LENGTH = 100;

interface ModelShareInviteEmailInput {
  /** The sharing account's own verified address, learned by the relay from its sign-in token. */
  readonly sender: string;
  /** The recipient's first name when the relay knows it (they have an account), otherwise null. */
  readonly firstName: string | null;
  /** The sharing machine's label. Typed by a person, so it is cleaned and escaped. */
  readonly machine: string;
  readonly models: ReadonlyArray<string>;
  /** The address the invite was made for, which the person must sign in with. */
  readonly recipient: string;
}

interface ModelShareInviteEmail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

/** One line, no control characters, so a label cannot break the layout or smuggle in headers. */
function oneLine(value: string, maxLength: number): string {
  // oxlint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\x00-\x1F\x7F\s]+/g, " ").trim();
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 1).trimEnd()}…` : cleaned;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function buildModelShareInviteEmail(
  input: ModelShareInviteEmailInput,
): ModelShareInviteEmail {
  const sender = oneLine(input.sender, 254);
  const machine = oneLine(input.machine, MAX_MACHINE_LENGTH);
  const models = input.models.map((model) => oneLine(model, 200)).join(", ");
  const recipient = oneLine(input.recipient, 254);

  const firstName = input.firstName === null ? null : oneLine(input.firstName, 60);
  const greeting = firstName === null || firstName === "" ? "Hi," : `Hi ${firstName},`;

  const subject = `${sender} shared an AI model with you on CodeWrench`;

  const text = [
    greeting,
    "",
    `${sender} shared an AI model with you on CodeWrench.`,
    "",
    `Shared from: ${machine}`,
    `Models: ${models}`,
    "",
    `To use it, open CodeWrench and sign in with this email address (${recipient}). The model is added by itself and appears in your model list.`,
    "",
    `Do not have CodeWrench yet? Download it for Mac: ${DOWNLOAD_URL}`,
    "",
    "If you were not expecting this, you can ignore this email. Nothing is added unless you sign in.",
  ].join("\n");

  const paragraph = (content: string) =>
    `<p style="margin:0 0 16px 0;font-size:16px;line-height:24px;">${content}</p>`;
  const html = [
    '<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;color:#111111;max-width:560px;">',
    paragraph(escapeHtml(greeting)),
    paragraph(`${escapeHtml(sender)} shared an AI model with you on CodeWrench.`),
    paragraph(`Shared from: ${escapeHtml(machine)}<br>Models: ${escapeHtml(models)}`),
    paragraph(
      `To use it, open CodeWrench and sign in with this email address (${escapeHtml(recipient)}). The model is added by itself and appears in your model list.`,
    ),
    paragraph(
      `Do not have CodeWrench yet? Download it for Mac: <a href="${escapeHtml(DOWNLOAD_URL)}">${escapeHtml(DOWNLOAD_URL)}</a>`,
    ),
    paragraph(
      "If you were not expecting this, you can ignore this email. Nothing is added unless you sign in.",
    ),
    "</div>",
  ].join("\n");

  return { subject, text, html };
}
