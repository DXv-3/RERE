import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { buildMimeMessage, SmtpError, sendSmtpMail, type SmtpMessage } from "./smtp.ts";
import { makeScriptedSmtpServer } from "./smtpTestServer.ts";

const PASSWORD = "p@ss/w0rd+secret";
const message: SmtpMessage = {
  from: "CodeWrench <support@savagesolutions.io>",
  to: "sam@example.com",
  subject: "ryan@candidstudios.net shared an AI model with you on CodeWrench",
  text: "Hi Sam,\n\nryan@candidstudios.net shared an AI model with you on CodeWrench.\n\n.leading dot line\n",
  html: '<p style="margin:0">Hi Sam,</p>\n<p>café — done</p>',
  messageId: "invite-123",
  date: DateTime.toDateUtc(DateTime.makeUnsafe("2026-10-09T20:15:30.000Z")),
  boundary: "cw-test-boundary-0001",
};
const base = { host: "mail.example.test", port: 465, user: "support@savagesolutions.io" };

const send = (
  server: ReturnType<typeof makeScriptedSmtpServer>,
  overrides: Partial<Parameters<typeof sendSmtpMail>[0]> = {},
) =>
  sendSmtpMail({
    ...base,
    connect: server.connect,
    password: PASSWORD,
    message,
    ...overrides,
  });

const failure = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SmtpError) return error;
    throw error;
  }
  throw new Error("expected the send to fail");
};

/** The decoded body of each part of a multipart message. */
function decodeParts(raw: string): Array<{ type: string; text: string }> {
  const boundary = /boundary="([^"]+)"/.exec(raw)?.[1] ?? "";
  return raw
    .split(`--${boundary}`)
    .slice(1, -1)
    .map((part) => {
      const [head = "", ...rest] = part.replace(/^\r\n/, "").split("\r\n\r\n");
      const encoded = rest.join("\r\n\r\n").replace(/\r\n/g, "");
      return {
        type: /Content-Type: ([^;]+)/.exec(head)?.[1] ?? "",
        text: Buffer.from(encoded, "base64").toString("utf8"),
      };
    });
}

describe("sendSmtpMail", () => {
  it("talks to the server in order, authenticates with PLAIN and sends the message", async () => {
    const server = makeScriptedSmtpServer();
    await send(server);

    expect(server.connects).toEqual([{ host: "mail.example.test", port: 465 }]);
    const [ehlo, auth, mailFrom, rcptTo, data, ...rest] = server.commands;
    expect(ehlo).toBe("EHLO relay.savagesolutions.io");
    expect(auth?.startsWith("AUTH PLAIN ")).toBe(true);
    expect(Buffer.from(auth?.slice("AUTH PLAIN ".length) ?? "", "base64").toString()).toBe(
      `\u0000support@savagesolutions.io\u0000${PASSWORD}`,
    );
    expect(mailFrom).toBe("MAIL FROM:<support@savagesolutions.io>");
    expect(rcptTo).toBe("RCPT TO:<sam@example.com>");
    expect(data).toBe("DATA");
    expect(rest).toEqual(["QUIT"]);
    expect(server.messages).toHaveLength(1);
    expect(server.state.closed).toBe(true);
  });

  it("reads a multi-line reply as one reply and picks PLAIN from the advertised list", async () => {
    const server = makeScriptedSmtpServer({
      ehlo: ["250-first", "250-AUTH LOGIN PLAIN", "250 last"],
    });
    await send(server);
    expect(server.commands[1]?.startsWith("AUTH PLAIN ")).toBe(true);
  });

  it("falls back to AUTH LOGIN when PLAIN is not advertised", async () => {
    const server = makeScriptedSmtpServer({ ehlo: ["250-mail.example.test", "250 AUTH LOGIN"] });
    await send(server);
    expect(server.commands.slice(1, 4)).toEqual([
      "AUTH LOGIN",
      Buffer.from("support@savagesolutions.io").toString("base64"),
      Buffer.from(PASSWORD).toString("base64"),
    ]);
    expect(server.commands[4]).toBe("MAIL FROM:<support@savagesolutions.io>");
  });

  it("stops at a refused login without sending the message, and never repeats the password", async () => {
    const server = makeScriptedSmtpServer({
      replies: { "AUTH PLAIN": "535 5.7.8 Bad credentials" },
    });
    const error = await failure(send(server));
    expect(error).toMatchObject({ stage: "auth", code: 535 });
    expect(error.message).not.toContain(PASSWORD);
    expect(error.message).not.toContain(Buffer.from(PASSWORD).toString("base64"));
    expect(server.commands.some((command) => command.startsWith("MAIL FROM"))).toBe(false);
    expect(server.state.closed).toBe(true);
  });

  it("stops when the recipient is refused", async () => {
    const server = makeScriptedSmtpServer({ replies: { "RCPT TO": "550 5.1.1 No such user" } });
    const error = await failure(send(server));
    expect(error).toMatchObject({ stage: "rcpt_to", code: 550 });
    expect(error.message).not.toContain("sam@example.com");
    expect(server.commands).not.toContain("DATA");
    expect(server.messages).toHaveLength(0);
  });

  it("treats a temporary failure as a failure too", async () => {
    const server = makeScriptedSmtpServer({ replies: { END: "451 4.3.0 Try later" } });
    expect(await failure(send(server))).toMatchObject({ stage: "message", code: 451 });
  });

  it("fails when the server drops the connection mid-conversation", async () => {
    const server = makeScriptedSmtpServer({ closeOn: "MAIL FROM" });
    expect(await failure(send(server))).toMatchObject({ stage: "closed" });
    expect(server.state.closeCalls).toBeGreaterThan(0);
  });

  it("fails when the connection cannot be made", async () => {
    const error = await failure(
      send(makeScriptedSmtpServer(), { connect: () => Promise.reject(new Error("refused")) }),
    );
    expect(error.stage).toBe("connect");
  });

  it("closes the connection when aborted while the server says nothing", async () => {
    const server = makeScriptedSmtpServer({ silentOn: "RCPT TO" });
    const controller = new AbortController();
    const sending = failure(send(server, { signal: controller.signal }));
    // Let the conversation reach the silent step.
    await server.waitFor("RCPT TO");
    controller.abort();
    expect(await sending).toMatchObject({ stage: "aborted" });
    expect(server.state.closed).toBe(true);
  });

  it("supports port 465 only and says so before connecting", async () => {
    for (const port of [25, 587, 2525]) {
      const server = makeScriptedSmtpServer();
      expect(await failure(send(server, { port }))).toMatchObject({ stage: "invalid_input" });
      expect(server.connects).toEqual([]);
    }
  });

  it("refuses a line break in the from, to or subject before connecting", async () => {
    const attempts: Array<Partial<SmtpMessage>> = [
      { from: "CodeWrench <support@savagesolutions.io>\r\nBcc: x@example.com" },
      { from: "CodeWrench\n<support@savagesolutions.io>" },
      { to: "sam@example.com\r\nRCPT TO:<x@example.com>" },
      { to: "sam@example.com\n" },
      { subject: "Hello\r\nBcc: x@example.com" },
      { subject: "Hello\rWorld" },
    ];
    for (const attempt of attempts) {
      const server = makeScriptedSmtpServer();
      const error = await failure(send(server, { message: { ...message, ...attempt } }));
      expect(error.stage).toBe("invalid_input");
      expect(server.connects).toEqual([]);
    }
  });

  it("refuses a recipient that is not one plain address", async () => {
    for (const to of [
      "a@b.com, c@d.com",
      "<a@b.com>",
      "a b@c.com",
      "no-at-sign",
      "é@example.com",
    ]) {
      const server = makeScriptedSmtpServer();
      const error = await failure(send(server, { message: { ...message, to } }));
      expect(error.stage).toBe("invalid_input");
    }
  });
});

describe("buildMimeMessage", () => {
  const raw = buildMimeMessage(message);

  it("carries the required headers and uses CRLF only", () => {
    const head = raw.split("\r\n\r\n")[0] ?? "";
    expect(head.split("\r\n")).toEqual([
      "From: CodeWrench <support@savagesolutions.io>",
      "To: sam@example.com",
      `Subject: ${message.subject}`,
      "Date: Fri, 09 Oct 2026 20:15:30 +0000",
      "Message-ID: <invite-123@relay.savagesolutions.io>",
      "MIME-Version: 1.0",
      "Auto-Submitted: auto-generated",
      'Content-Type: multipart/alternative; boundary="cw-test-boundary-0001"',
    ]);
    expect(raw).not.toMatch(/(?<!\r)\n/);
    expect(raw).not.toMatch(/\r(?!\n)/);
    expect(raw.endsWith("--cw-test-boundary-0001--\r\n")).toBe(true);
  });

  it("encodes both parts as base64 in lines of at most 76 characters that decode to the exact text", () => {
    const parts = decodeParts(raw);
    expect(parts).toEqual([
      { type: "text/plain", text: message.text },
      { type: "text/html", text: message.html },
    ]);
    expect(raw).toContain("Content-Transfer-Encoding: base64");
    expect(raw).toContain("charset=UTF-8");
    for (const line of raw.split("\r\n")) expect(line.length).toBeLessThanOrEqual(76);
  });

  it("encodes a non-ASCII subject and display name as RFC 2047 words", () => {
    const encoded = buildMimeMessage({
      ...message,
      from: "Café CodeWrench <support@savagesolutions.io>",
      subject: "Sam é shared an AI model with you on CodeWrench — hello",
    });
    const subject = /Subject: ([\s\S]*?)\r\nDate:/.exec(encoded)?.[1] ?? "";
    expect(subject).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=/);
    const decoded = subject
      .split("\r\n ")
      .map((word) => Buffer.from(/=\?UTF-8\?B\?(.*)\?=/.exec(word)?.[1] ?? "", "base64").toString())
      .join("");
    expect(decoded).toBe("Sam é shared an AI model with you on CodeWrench — hello");
    for (const word of subject.split("\r\n ")) expect(word.length).toBeLessThanOrEqual(75);
    expect(encoded).toMatch(/From: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <support@savagesolutions\.io>/);
  });

  it("never starts a line of the DATA with a lone dot", async () => {
    const server = makeScriptedSmtpServer();
    await send(server);
    for (const line of (server.messages[0] ?? "").split("\r\n")) {
      expect(line === "." || !line.startsWith(".")).toBe(true);
    }
    expect(server.messages[0]?.endsWith("\r\n")).toBe(true);
  });
});
