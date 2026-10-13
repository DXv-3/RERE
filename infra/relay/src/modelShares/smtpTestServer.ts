import type { SmtpConnect, SmtpConnection } from "./smtp.ts";

/** What a scripted mail server does. Anything not listed behaves like a normal server. */
export interface ScriptedSmtpServerOptions {
  /** The EHLO reply lines, each with its `250-` or `250 ` prefix. */
  readonly ehlo?: ReadonlyArray<string>;
  /** Replaces the reply to the first command that starts with the key. */
  readonly replies?: Readonly<Record<string, string>>;
  /** Says nothing in answer to the first command that starts with this (or the greeting: ""). */
  readonly silentOn?: string;
  /** Drops the connection when the first command that starts with this arrives. */
  readonly closeOn?: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** An in-memory SMTP server speaking the real protocol, so tests drive the real client. */
export function makeScriptedSmtpServer(options: ScriptedSmtpServerOptions = {}) {
  const ehlo = options.ehlo ?? [
    "250-mail.example.test greets you",
    "250-SIZE 35882577",
    "250-AUTH PLAIN LOGIN",
    "250 8BITMIME",
  ];
  const commands: Array<string> = [];
  const messages: Array<string> = [];
  const connects: Array<{ host: string; port: number }> = [];
  const state = { closed: false, closeCalls: 0 };
  const watchers: Array<{ prefix: string; resolve: () => void }> = [];
  /** Resolves once a command starting with `prefix` has arrived (now or later). */
  const waitFor = (prefix: string) =>
    commands.some((command) => command.startsWith(prefix))
      ? Promise.resolve()
      : new Promise<void>((resolve) => void watchers.push({ prefix, resolve }));

  const connect: SmtpConnect = async (target) => {
    connects.push(target);
    const queue: Array<Uint8Array | null> = [];
    let waiting: ((chunk: Uint8Array | null) => void) | undefined;
    const push = (chunk: Uint8Array | null) => {
      if (waiting) {
        const resolve = waiting;
        waiting = undefined;
        resolve(chunk);
      } else queue.push(chunk);
    };
    const reply = (text: string) => push(encoder.encode(`${text}\r\n`));
    let closed = false;
    state.closed = false;
    const shut = () => {
      closed = true;
      state.closed = true;
      push(null);
    };

    let incoming = "";
    let inData = false;
    let loginStep = 0;
    const used = new Set<string>();

    const answer = (line: string) => {
      const key = [options.silentOn, options.closeOn, ...Object.keys(options.replies ?? {})].find(
        (candidate) => candidate !== undefined && candidate !== "" && line.startsWith(candidate),
      );
      if (key !== undefined && !used.has(key)) {
        used.add(key);
        if (key === options.closeOn) return shut();
        if (key === options.silentOn) return;
        return reply(options.replies?.[key] ?? "250 OK");
      }
      if (loginStep === 1) {
        loginStep = 2;
        return reply("334 UGFzc3dvcmQ6");
      }
      if (loginStep === 2) {
        loginStep = 0;
        return reply("235 2.7.0 Accepted");
      }
      if (line.startsWith("EHLO ")) return ehlo.forEach(reply);
      if (line === "AUTH LOGIN") {
        loginStep = 1;
        return reply("334 VXNlcm5hbWU6");
      }
      if (line.startsWith("AUTH PLAIN ")) return reply("235 2.7.0 Accepted");
      if (line === "DATA") {
        inData = true;
        return reply("354 End data with <CR><LF>.<CR><LF>");
      }
      if (line === "QUIT") return reply("221 Bye");
      return reply("250 OK");
    };

    if (options.silentOn !== "") reply("220 mail.example.test ESMTP ready");

    return {
      read: () =>
        new Promise<Uint8Array | null>((resolve) => {
          const next = queue.shift();
          if (next !== undefined) resolve(next);
          else if (closed) resolve(null);
          else waiting = resolve;
        }),
      write: async (data) => {
        if (closed) throw new Error("connection closed");
        incoming += decoder.decode(data);
        if (inData) {
          const end = incoming.indexOf("\r\n.\r\n");
          if (end >= 0) {
            messages.push(incoming.slice(0, end + 2));
            incoming = incoming.slice(end + 5);
            inData = false;
            answer("END-OF-DATA");
          }
          return;
        }
        for (;;) {
          const end = incoming.indexOf("\r\n");
          if (end < 0 || inData) break;
          const line = incoming.slice(0, end);
          incoming = incoming.slice(end + 2);
          commands.push(line);
          for (const watcher of watchers) if (line.startsWith(watcher.prefix)) watcher.resolve();
          answer(line);
        }
      },
      close: async () => {
        state.closeCalls += 1;
        shut();
      },
    } satisfies SmtpConnection;
  };

  return { connect, commands, messages, connects, state, waitFor };
}
