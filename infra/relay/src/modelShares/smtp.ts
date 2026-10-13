/**
 * A small SMTP client for sending one message over an implicit-TLS connection (port 465). It
 * speaks to a connection through a tiny interface so tests can script the server; the live
 * connection is made with `cloudflare:sockets` in `connectCloudflareSocket`.
 *
 * Nothing here logs. Errors carry the stage and the server's reply code only, never the
 * password, the encoded credentials or any address.
 */

/** The only port supported: implicit TLS from the first byte, so there is no STARTTLS to get wrong. */
export const SMTP_IMPLICIT_TLS_PORT = 465;

const EHLO_NAME = "relay.savagesolutions.io";
const MESSAGE_ID_DOMAIN = "relay.savagesolutions.io";
// A server that never ends a reply must not make us buffer without limit.
const MAX_REPLY_BYTES = 64 * 1024;

export interface SmtpConnection {
  /** The next chunk from the server, or null once the connection is closed. */
  readonly read: () => Promise<Uint8Array | null>;
  readonly write: (data: Uint8Array) => Promise<void>;
  /** Closes the connection. Also ends a read that is waiting. Safe to call twice. */
  readonly close: () => Promise<void>;
}

export type SmtpConnect = (input: {
  readonly host: string;
  readonly port: number;
}) => Promise<SmtpConnection>;

export type SmtpFailureStage =
  | "invalid_input"
  | "connect"
  | "greeting"
  | "ehlo"
  | "auth"
  | "mail_from"
  | "rcpt_to"
  | "data"
  | "message"
  | "closed"
  | "aborted";

export class SmtpError extends Error {
  readonly stage: SmtpFailureStage;
  /** The server's reply code when it gave one. */
  readonly code: number | null;

  constructor(stage: SmtpFailureStage, code: number | null = null) {
    super(`SMTP ${stage} failed${code === null ? "" : ` (${code})`}`);
    this.name = "SmtpError";
    this.stage = stage;
    this.code = code;
  }
}

export interface SmtpMessage {
  /** The From header value, for example `CodeWrench <support@example.com>`. */
  readonly from: string;
  /** One bare address. */
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  /** Becomes `<messageId@relay.savagesolutions.io>`. */
  readonly messageId: string;
  readonly date: Date;
  /** The multipart boundary: letters, digits and hyphens, unlikely to appear in the text. */
  readonly boundary: string;
}

export interface SmtpSendInput {
  readonly connect: SmtpConnect;
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly message: SmtpMessage;
  /** Aborting closes the connection and ends the send. */
  readonly signal?: AbortSignal;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function hasLineBreak(value: string): boolean {
  return /[\r\n]/.test(value);
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function base64OfText(value: string): string {
  return toBase64(encoder.encode(value));
}

/** Base64 in 76-character lines, CRLF between them. */
function wrapBase64(value: string): string {
  return (value.match(/.{1,76}/g) ?? []).join("\r\n");
}

function isAscii(value: string): boolean {
  // oxlint-disable-next-line no-control-regex
  return /^[\x00-\x7F]*$/.test(value);
}

/** RFC 2047: non-ASCII text as encoded words that each fit a header line. */
export function encodeHeaderText(value: string): string {
  if (isAscii(value)) return value;
  const words: Array<string> = [];
  let current: Array<string> = [];
  let currentBytes = 0;
  const flush = () => {
    if (current.length > 0) {
      words.push(`=?UTF-8?B?${base64OfText(current.join(""))}?=`);
      current = [];
      currentBytes = 0;
    }
  };
  for (const character of value) {
    const size = encoder.encode(character).length;
    // 45 bytes encode to 60 characters, which keeps each word under 75 with its wrapper.
    if (currentBytes + size > 45) flush();
    current.push(character);
    currentBytes += size;
  }
  flush();
  return words.join("\r\n ");
}

/** The address inside `Name <address>`, or the whole value when it has no angle brackets. */
export function addressOf(mailbox: string): string {
  const match = /<([^<>]*)>\s*$/.exec(mailbox);
  return (match?.[1] ?? mailbox).trim();
}

function isEnvelopeAddress(value: string): boolean {
  // One ASCII address, no whitespace, brackets, quotes or commas.
  // oxlint-disable-next-line no-control-regex
  return /^[^\s<>",;:\\\x00-\x1F\x7F-￿@]+@[^\s<>",;:\\\x00-\x1F\x7F-￿@]+$/.test(value);
}

/** The From header: an address as is, or a display name (encoded when needed) and the address. */
function fromHeader(mailbox: string): string {
  const match = /^(.*)<([^<>]*)>\s*$/.exec(mailbox);
  if (!match) return mailbox.trim();
  const name = (match[1] ?? "").trim();
  const address = (match[2] ?? "").trim();
  if (name === "") return `<${address}>`;
  if (isAscii(name)) return `${name} <${address}>`;
  return `${encodeHeaderText(name)} <${address}>`;
}

/** Rejects anything that could add a header or a command. */
function assertSafeMessage(message: SmtpMessage): void {
  if (
    hasLineBreak(message.from) ||
    hasLineBreak(message.to) ||
    hasLineBreak(message.subject) ||
    hasLineBreak(message.messageId)
  ) {
    throw new SmtpError("invalid_input");
  }
  if (!isEnvelopeAddress(addressOf(message.from)) || !isEnvelopeAddress(message.to)) {
    throw new SmtpError("invalid_input");
  }
  if (!/^[A-Za-z0-9._-]+$/.test(message.messageId)) throw new SmtpError("invalid_input");
  if (!/^[A-Za-z0-9-]{8,70}$/.test(message.boundary)) throw new SmtpError("invalid_input");
}

/** Dot-stuffs lines that start with a dot. The parts are base64, so this is only a safeguard. */
function dotStuff(value: string): string {
  return value.replace(/(^|\r\n)\./g, "$1..");
}

/** The full message, CRLF throughout, ready to follow `DATA`. Exported for tests. */
export function buildMimeMessage(message: SmtpMessage): string {
  assertSafeMessage(message);
  const { boundary } = message;
  const date = message.date.toUTCString().replace(/ GMT$/, " +0000");
  const part = (type: string, body: string) =>
    [
      `--${boundary}`,
      `Content-Type: ${type}; charset=UTF-8`,
      "Content-Transfer-Encoding: base64",
      "",
      wrapBase64(base64OfText(body)),
      "",
    ].join("\r\n");
  return [
    `From: ${fromHeader(message.from)}`,
    `To: ${message.to}`,
    `Subject: ${encodeHeaderText(message.subject)}`,
    `Date: ${date}`,
    `Message-ID: <${message.messageId}@${MESSAGE_ID_DOMAIN}>`,
    "MIME-Version: 1.0",
    "Auto-Submitted: auto-generated",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    part("text/plain", message.text) + part("text/html", message.html) + `--${boundary}--`,
    "",
  ].join("\r\n");
}

interface SmtpReply {
  readonly code: number;
  readonly lines: ReadonlyArray<string>;
}

/** Reads replies off a connection, one complete (possibly multi-line) reply at a time. */
function makeReplyReader(connection: SmtpConnection) {
  let buffer = "";
  const nextLine = async (): Promise<string> => {
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end >= 0) {
        const line = buffer.slice(0, end).replace(/\r$/, "");
        buffer = buffer.slice(end + 1);
        return line;
      }
      if (buffer.length > MAX_REPLY_BYTES) throw new SmtpError("closed");
      const chunk = await connection.read();
      if (chunk === null) throw new SmtpError("closed");
      buffer += decoder.decode(chunk, { stream: true });
    }
  };
  return async function readReply(stage: SmtpFailureStage): Promise<SmtpReply> {
    const lines: Array<string> = [];
    for (;;) {
      const line = await nextLine();
      const match = /^(\d{3})([ -]?)(.*)$/.exec(line);
      if (!match) throw new SmtpError(stage);
      lines.push(match[3] ?? "");
      // "250-text" continues the reply; "250 text" (or a bare "250") ends it.
      if (match[2] !== "-") return { code: Number(match[1]), lines };
    }
  };
}

/** Which AUTH mechanisms the EHLO reply advertised, upper-cased. */
function advertisedAuth(lines: ReadonlyArray<string>): ReadonlySet<string> {
  const mechanisms = new Set<string>();
  for (const line of lines) {
    const match = /^AUTH[ =](.*)$/i.exec(line.trim());
    if (match) for (const word of (match[1] ?? "").split(/\s+/)) mechanisms.add(word.toUpperCase());
  }
  return mechanisms;
}

async function converse(connection: SmtpConnection, input: SmtpSendInput): Promise<void> {
  const readReply = makeReplyReader(connection);
  const send = (line: string) => connection.write(encoder.encode(`${line}\r\n`));
  const expect = async (stage: SmtpFailureStage, accepted: ReadonlyArray<number>) => {
    const reply = await readReply(stage);
    // Any 4xx or 5xx, and anything unexpected, ends the send.
    if (!accepted.includes(reply.code)) throw new SmtpError(stage, reply.code);
    return reply;
  };

  const { message } = input;
  // Built first, so a bad header is refused before anything is sent.
  const body = dotStuff(buildMimeMessage(message));
  const sender = addressOf(message.from);

  await expect("greeting", [220]);
  await send(`EHLO ${EHLO_NAME}`);
  const ehlo = await expect("ehlo", [250]);

  const mechanisms = advertisedAuth(ehlo.lines);
  if (mechanisms.has("PLAIN") || !mechanisms.has("LOGIN")) {
    // PLAIN is the default; a server that advertises neither will refuse it.
    await send(`AUTH PLAIN ${base64OfText(`\u0000${input.user}\u0000${input.password}`)}`);
    await expect("auth", [235]);
  } else {
    await send("AUTH LOGIN");
    await expect("auth", [334]);
    await send(base64OfText(input.user));
    await expect("auth", [334]);
    await send(base64OfText(input.password));
    await expect("auth", [235]);
  }

  await send(`MAIL FROM:<${sender}>`);
  await expect("mail_from", [250]);
  await send(`RCPT TO:<${message.to}>`);
  await expect("rcpt_to", [250, 251]);
  await send("DATA");
  await expect("data", [354]);
  await connection.write(encoder.encode(`${body}.\r\n`));
  await expect("message", [250]);
  // Best effort: the message is already accepted.
  await send("QUIT").catch(() => undefined);
}

/**
 * Sends one message. Resolves once the server accepted it; rejects with an `SmtpError` otherwise.
 * The connection is always closed, including when `signal` aborts mid-conversation.
 */
export async function sendSmtpMail(input: SmtpSendInput): Promise<void> {
  if (input.port !== SMTP_IMPLICIT_TLS_PORT) throw new SmtpError("invalid_input");
  // Refuse a bad message before opening a connection or sending credentials.
  assertSafeMessage(input.message);
  if (hasLineBreak(input.user) || input.user === "") throw new SmtpError("invalid_input");
  if (input.signal?.aborted) throw new SmtpError("aborted");

  let connection: SmtpConnection;
  try {
    connection = await input.connect({ host: input.host, port: input.port });
  } catch {
    throw new SmtpError("connect");
  }
  const abort = input.signal;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      void connection.close().catch(() => undefined);
      reject(new SmtpError("aborted"));
    };
    if (abort?.aborted) onAbort();
    else abort?.addEventListener("abort", onAbort, { once: true });
  });
  // The race can end first; the loser's rejection must not go unhandled.
  aborted.catch(() => undefined);
  try {
    await Promise.race([converse(connection, input), aborted]);
  } catch (error) {
    if (error instanceof SmtpError) throw error;
    throw new SmtpError("closed");
  } finally {
    if (onAbort) abort?.removeEventListener("abort", onAbort);
    await connection.close().catch(() => undefined);
  }
}

/**
 * The live connection: implicit TLS from the first byte through Cloudflare's sockets API. The
 * module only exists inside a Worker, so it is loaded here and nowhere else.
 */
export const connectCloudflareSocket: SmtpConnect = async ({ host, port }) => {
  const { connect } = await import("cloudflare:sockets");
  const socket = connect({ hostname: host, port }, { secureTransport: "on", allowHalfOpen: false });
  const reader = socket.readable.getReader();
  const writer = socket.writable.getWriter();
  return {
    read: async () => {
      const result = await reader.read();
      return result.done ? null : result.value;
    },
    write: (data) => writer.write(data),
    close: async () => {
      await reader.cancel().catch(() => undefined);
      await writer.close().catch(() => undefined);
      await socket.close().catch(() => undefined);
    },
  };
};
