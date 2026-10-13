import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import * as RelayConfiguration from "../Config.ts";
import { buildModelShareInviteEmail } from "./modelShareInviteEmail.ts";
import { connectCloudflareSocket, type SmtpConnect, SmtpError, sendSmtpMail } from "./smtp.ts";

const SEND_TIMEOUT = "10 seconds";

/** How the mailer reaches the mail server. Tests supply a scripted one. */
export class SmtpConnector extends Context.Service<
  SmtpConnector,
  { readonly connect: SmtpConnect }
>()("t3code-relay/modelShares/ModelShareInviteMailer/SmtpConnector") {}

/** The real connection, made with `cloudflare:sockets` (only available inside a Worker). */
export const liveConnectorLayer = Layer.succeed(SmtpConnector, {
  connect: connectCloudflareSocket,
});

/**
 * Tells a person that a model was shared with them. Never fails and never takes longer than the
 * send timeout: the invite is already stored, and the email is a courtesy on top of it.
 */
export class ModelShareInviteMailer extends Context.Service<
  ModelShareInviteMailer,
  {
    /** False when the SMTP settings are not all present, so callers can skip related work. */
    readonly enabled: boolean;
    /** True only when the mail server accepted the message. */
    readonly send: (input: {
      readonly inviteId: string;
      /** The sharing account's own verified address, as learned from its identity token. */
      readonly senderEmail: string;
      readonly recipientEmail: string;
      /** The recipient's first name when they already have an account, otherwise null. */
      readonly recipientFirstName: string | null;
      readonly machine: string;
      readonly models: ReadonlyArray<string>;
    }) => Effect.Effect<boolean>;
  }
>()("t3code-relay/modelShares/ModelShareInviteMailer") {}

const make = Effect.gen(function* () {
  const config = yield* RelayConfiguration.RelayConfiguration;
  const connector = yield* SmtpConnector;
  const crypto = yield* Crypto.Crypto;
  const settings = config.modelShareEmail;

  return ModelShareInviteMailer.of({
    enabled: settings !== undefined,
    send: Effect.fn("relay.model_share_invites.send_email")(function* (input) {
      if (settings === undefined) return false;
      const email = buildModelShareInviteEmail({
        sender: input.senderEmail,
        firstName: input.recipientFirstName,
        machine: input.machine,
        models: input.models,
        recipient: input.recipientEmail,
      });
      const boundary = `cw-${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`;
      const date = DateTime.toDateUtc(yield* DateTime.now);
      // Nothing logged below carries an address, the password or anything of the share.
      return yield* Effect.tryPromise({
        try: (signal) =>
          sendSmtpMail({
            connect: connector.connect,
            host: settings.host,
            port: settings.port,
            user: settings.user,
            password: Redacted.value(settings.password),
            signal,
            message: {
              from: settings.from,
              to: input.recipientEmail,
              subject: email.subject,
              text: email.text,
              html: email.html,
              messageId: input.inviteId,
              date,
              boundary,
            },
          }),
        catch: (cause) => (cause instanceof SmtpError ? cause : new SmtpError("closed")),
      }).pipe(
        Effect.as(true),
        Effect.timeout(SEND_TIMEOUT),
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.interrupt
            : Effect.logWarning("Model share invite email could not be sent", {
                inviteId: input.inviteId,
                reason: describeFailure(cause),
              }).pipe(Effect.as(false)),
        ),
      );
    }),
  });
});

/** The stage and reply code of an SMTP failure, or "timeout"/"unknown". Never the details. */
function describeFailure(cause: Cause.Cause<unknown>): string {
  const error = Cause.findErrorOption(cause);
  if (error._tag === "Some" && error.value instanceof SmtpError) {
    return `${error.value.stage}${error.value.code === null ? "" : ` ${error.value.code}`}`;
  }
  return Cause.pretty(cause).includes("TimeoutError") ? "timeout" : "unknown";
}

export const layer = Layer.effect(ModelShareInviteMailer, make);
