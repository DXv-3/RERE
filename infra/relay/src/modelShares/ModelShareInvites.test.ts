import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import {
  RelayApi,
  RelayClientAuth,
  RelayClientPrincipal,
  RelayEnvironmentAuth,
  RelayEnvironmentPrincipal,
  type RelayClientEnvironmentRecord,
} from "@t3tools/contracts/relay";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Fiber from "effect/Fiber";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import * as RelayConfiguration from "../Config.ts";
import * as EnvironmentLinks from "../environments/EnvironmentLinks.ts";
import { modelShareInviteClientApi, modelShareInviteServerApi } from "../http/Api.ts";
import * as AccountEmails from "./AccountEmails.ts";
import * as Mailer from "./ModelShareInviteMailer.ts";
import { makeScriptedSmtpServer, type ScriptedSmtpServerOptions } from "./smtpTestServer.ts";
import * as Store from "./ModelShareInviteStore.ts";
import * as ModelShareInvites from "./ModelShareInvites.ts";

const settings: RelayConfiguration.RelayConfiguration["Service"] = {
  relayIssuer: "https://relay.example.test",
  apns: null,
  oidcIssuer: "https://login.example.test/realms/codewrench",
  oidcAudience: "codewrench-relay",
  apnsDeliveryJobSigningSecret: Redacted.make("unused"),
  modelShareSealingKey: Redacted.make("test-sealing-key"),
  cloudMintPrivateKey: Redacted.make("unused"),
  cloudMintPublicKey: "unused",
  managedEndpointBaseDomain: undefined,
  managedEndpointNamespace: undefined,
};

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const TOKEN = "cwm_super-secret-share-token";

/** Rows as the database would hold them, so a test can look at what is stored at rest. */
function makeMemoryStore() {
  const rows = new Map<
    string,
    Store.ModelShareInviteRow & { revokedAt: string | null; ownerUserId: string }
  >();
  const store = Store.ModelShareInviteStore.of({
    insert: (row) =>
      Effect.sync(() => {
        rows.set(row.inviteId, { ...row, revokedAt: null });
      }),
    countOpenForOwner: ({ ownerUserId, limit }) =>
      Effect.sync(() =>
        Math.min(
          limit,
          [...rows.values()].filter(
            (row) =>
              row.ownerUserId === ownerUserId && row.revokedAt === null && row.acceptedAt === null,
          ).length,
        ),
      ),
    recentRecipientsForOwner: ({ ownerUserId, since, limit }) =>
      Effect.sync(() =>
        [...rows.values()]
          .filter((row) => row.ownerUserId === ownerUserId && row.createdAt >= since)
          .slice(0, limit)
          .map((row) => row.recipientEmail),
      ),
    listForEnvironment: ({ environmentId }) =>
      Effect.sync(() =>
        [...rows.values()].filter(
          (row) => row.environmentId === environmentId && row.revokedAt === null,
        ),
      ),
    revokeForEnvironment: ({ environmentId, inviteId, now }) =>
      Effect.sync(() => {
        const row = rows.get(inviteId);
        if (!row || row.environmentId !== environmentId || row.revokedAt !== null) return false;
        rows.set(inviteId, { ...row, revokedAt: now, sealedToken: "" });
        return true;
      }),
    listOpenForEmail: ({ email }) =>
      Effect.sync(() =>
        [...rows.values()].filter(
          (row) =>
            row.recipientEmail === email && row.revokedAt === null && row.acceptedAt === null,
        ),
      ),
    markAccepted: ({ inviteId, email, now }) =>
      Effect.sync(() => {
        const row = rows.get(inviteId);
        if (!row || row.recipientEmail !== email || row.revokedAt !== null || row.acceptedAt) {
          return false;
        }
        rows.set(inviteId, { ...row, acceptedAt: now, sealedToken: "" });
        return true;
      }),
  });
  return { rows, store };
}

function linkRecord(
  httpBaseUrl: string,
  environmentPublicKey = "env-key-1",
): EnvironmentLinks.RelayLinkedEnvironmentRecord {
  return {
    environmentId: "env-1" as RelayClientEnvironmentRecord["environmentId"],
    label: "Ryan's MacBook",
    endpoint: {
      httpBaseUrl,
      wsBaseUrl: httpBaseUrl.replace("https", "wss"),
      providerKind: "cloudflare_tunnel",
    },
    linkedAt: "2026-10-06T00:00:00.000Z",
    environmentPublicKey,
  };
}

const SMTP_PASSWORD = "smtp-fake-password";
const mailSettings = {
  ...settings,
  modelShareEmail: {
    host: "mail.example.test",
    port: 465,
    user: "support@example.test",
    password: Redacted.make(SMTP_PASSWORD),
    from: "CodeWrench <support@example.test>",
  },
};

interface SentMail {
  readonly raw: string;
  readonly to: string;
  readonly from: string;
  readonly body: { readonly subject: string; readonly text: string; readonly html: string };
}

function parseSent(raw: string): SentMail {
  const header = (name: string) => new RegExp(`^${name}: (.*)$`, "m").exec(raw)?.[1] ?? "";
  const boundary = /boundary="([^"]+)"/.exec(raw)?.[1] ?? "";
  const [text = "", html = ""] = raw
    .split(`--${boundary}`)
    .slice(1, -1)
    .map((part) =>
      Buffer.from(
        (part.replace(/^\r\n/, "").split("\r\n\r\n")[1] ?? "").replace(/\r\n/g, ""),
        "base64",
      ).toString("utf8"),
    );
  return {
    raw,
    to: header("To"),
    from: header("From"),
    body: { subject: header("Subject"), text, html },
  };
}

/** A scripted mail server, and the messages it accepted. */
function makeMailRecorder(options?: ScriptedSmtpServerOptions) {
  const server = makeScriptedSmtpServer(options);
  return {
    server,
    get requests(): ReadonlyArray<SentMail> {
      return server.messages.map(parseSent);
    },
  };
}
type MailRecorder = ReturnType<typeof makeMailRecorder>;

const OWNER_EMAIL = "ryan@candidstudios.test";

/** The remembered account addresses as the database would hold them, and how often it was written. */
function makeMemoryAccountEmails(seed: string | null) {
  const rows = new Map<string, string>(seed === null ? [] : [["owner-1", seed]]);
  const firstNames = new Map<string, string>();
  const writes: Array<{ userId: string; email: string; firstName: string | null }> = [];
  const store = AccountEmails.AccountEmailStore.of({
    upsertIfChanged: ({ userId, email, firstName }) =>
      Effect.sync(() => {
        if (
          rows.get(userId) === email &&
          (firstName === null || firstNames.get(userId) === firstName)
        ) {
          return;
        }
        rows.set(userId, email);
        if (firstName !== null) firstNames.set(userId, firstName);
        writes.push({ userId, email, firstName });
      }),
    find: ({ userId }) => Effect.sync(() => rows.get(userId) ?? null),
    findFirstName: ({ email }) =>
      Effect.sync(() => {
        for (const [userId, stored] of rows) {
          if (stored === email && firstNames.has(userId)) return firstNames.get(userId) ?? null;
        }
        return null;
      }),
  });
  return { rows, firstNames, writes, store };
}

function setup(options?: {
  /** The address the relay already knows for owner-1. Null: it has not seen one. */
  readonly ownerEmail?: string | null;
  readonly httpBaseUrl?: string;
  readonly config?: RelayConfiguration.RelayConfiguration["Service"];
  readonly mail?: MailRecorder;
}) {
  const memory = makeMemoryStore();
  const accounts = makeMemoryAccountEmails(
    options?.ownerEmail === undefined ? null : options.ownerEmail,
  );
  const mail = options?.mail ?? makeMailRecorder();
  const config = options?.config ?? settings;
  const links = Layer.mock(EnvironmentLinks.EnvironmentLinks, {
    getForUser: ({ userId, environmentId }) =>
      Effect.succeed(
        userId === "owner-1" && environmentId === "env-1"
          ? linkRecord(options?.httpBaseUrl ?? "https://home.example.test")
          : null,
      ),
  });
  const configLayer = Layer.succeed(RelayConfiguration.RelayConfiguration, config);
  const layer = ModelShareInvites.layer.pipe(
    Layer.provide(Layer.succeed(Store.ModelShareInviteStore, memory.store)),
    Layer.provide(links),
    Layer.provide(configLayer),
    Layer.provide(
      Mailer.layer.pipe(
        Layer.provide(configLayer),
        Layer.provide(Layer.succeed(Mailer.SmtpConnector, { connect: mail.server.connect })),
        Layer.provide(NodeCryptoLayer.layer),
      ),
    ),
    Layer.provide(NodeCryptoLayer.layer),
    Layer.provideMerge(
      AccountEmails.layerWithStore.pipe(
        Layer.provide(Layer.succeed(AccountEmails.AccountEmailStore, accounts.store)),
      ),
    ),
  );
  return { memory, layer, mail, accounts };
}

const createRequest = {
  ownerUserId: "owner-1",
  shareId: "share-1",
  recipientEmail: "Sam@Example.com",
  models: ["claude-opus"],
  token: TOKEN,
};
const asEnvironment = { environmentId: "env-1", environmentPublicKey: "env-key-1" };
const verifiedSam = { email: "sam@example.com", emailVerified: true } as const;

describe("ModelShareInvites", () => {
  it.effect(
    "offers an invite to the verified recipient and never stores the token in the clear",
    () => {
      const { memory, layer } = setup();
      return Effect.gen(function* () {
        const invites = yield* ModelShareInvites.ModelShareInvites;
        const { inviteId } = yield* invites.create({ ...asEnvironment, request: createRequest });

        const stored = memory.rows.get(inviteId);
        expect(stored?.recipientEmail).toBe("sam@example.com");
        expect(
          Object.values(stored ?? {})
            .map(String)
            .join("\n"),
        ).not.toContain(TOKEN);
        // The address and sender label come from the account's link, with the share route appended.
        expect(stored?.shareBaseUrl).toBe("https://home.example.test/api/model-share");
        expect(stored?.label).toBe("Ryan's MacBook");

        const offers = yield* invites.offersForRecipient(verifiedSam);
        expect(offers).toEqual([
          {
            inviteId,
            label: "Ryan's MacBook",
            models: ["claude-opus"],
            baseUrl: "https://home.example.test/api/model-share",
            token: TOKEN,
            createdAt: stored?.createdAt,
          },
        ]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("offers nothing unless the email is verified and matches exactly", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const invites = yield* ModelShareInvites.ModelShareInvites;
      yield* invites.create({ ...asEnvironment, request: createRequest });
      for (const caller of [
        { email: "sam@example.com", emailVerified: false },
        { email: "sam@example.com", emailVerified: undefined },
        { email: undefined, emailVerified: true },
        { email: "sam@example.org", emailVerified: true },
        { email: "sam+1@example.com", emailVerified: true },
        { email: "other-sam@example.com", emailVerified: true },
      ]) {
        expect(yield* invites.offersForRecipient(caller)).toEqual([]);
      }
      expect(
        yield* invites.offersForRecipient({ email: "SAM@example.COM", emailVerified: true }),
      ).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "does not offer an invite that was accepted, and accept is only for the recipient",
    () => {
      const { memory, layer } = setup();
      return Effect.gen(function* () {
        const invites = yield* ModelShareInvites.ModelShareInvites;
        const { inviteId } = yield* invites.create({ ...asEnvironment, request: createRequest });

        for (const caller of [
          { email: "sam@example.com", emailVerified: false },
          { email: "mallory@example.com", emailVerified: true },
        ]) {
          const error = yield* Effect.flip(invites.accept({ inviteId, ...caller }));
          expect(error._tag).toBe("ModelShareInviteNotFound");
        }
        yield* invites.accept({ inviteId, ...verifiedSam });
        expect(yield* invites.offersForRecipient(verifiedSam)).toEqual([]);
        // Collected: the relay no longer holds the credential, and a second accept finds nothing.
        expect(memory.rows.get(inviteId)?.sealedToken).toBe("");
        expect((yield* Effect.flip(invites.accept({ inviteId, ...verifiedSam })))._tag).toBe(
          "ModelShareInviteNotFound",
        );
        const listed = yield* invites.listForEnvironment({ environmentId: "env-1" });
        expect(listed).toHaveLength(1);
        expect(listed[0]?.acceptedAt).not.toBeNull();
        expect(
          Object.values(listed[0] ?? {})
            .map(String)
            .join("\n"),
        ).not.toContain(TOKEN);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "revokes only for the owning environment, wipes the token, and answers 404 otherwise",
    () => {
      const { memory, layer } = setup();
      return Effect.gen(function* () {
        const invites = yield* ModelShareInvites.ModelShareInvites;
        const { inviteId } = yield* invites.create({ ...asEnvironment, request: createRequest });
        const stranger = yield* Effect.flip(invites.revoke({ environmentId: "env-2", inviteId }));
        expect(stranger._tag).toBe("ModelShareInviteNotFound");
        const unknown = yield* Effect.flip(
          invites.revoke({ environmentId: "env-1", inviteId: "nope" }),
        );
        expect(unknown._tag).toBe("ModelShareInviteNotFound");

        yield* invites.revoke({ environmentId: "env-1", inviteId });
        expect(memory.rows.get(inviteId)?.sealedToken).toBe("");
        expect(yield* invites.offersForRecipient(verifiedSam)).toEqual([]);
        expect(yield* invites.listForEnvironment({ environmentId: "env-1" })).toEqual([]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("validates the email, models, token and the sharer's address", () => {
    const { layer } = setup();
    const secure = setup({ httpBaseUrl: "http://192.168.1.4:3773" });
    return Effect.gen(function* () {
      const invites = yield* ModelShareInvites.ModelShareInvites;
      const reasonFor = (patch: Partial<typeof createRequest>, env = asEnvironment) =>
        invites.create({ ...env, request: { ...createRequest, ...patch } }).pipe(
          Effect.flip,
          Effect.map((error) =>
            error._tag === "ModelShareInviteInvalid" ? error.reason : error._tag,
          ),
        );
      expect(yield* reasonFor({ recipientEmail: "not an email" })).toBe("invalid_email");
      expect(yield* reasonFor({ recipientEmail: "a@b" })).toBe("invalid_email");
      expect(yield* reasonFor({ recipientEmail: "a@b.com, c@d.com" })).toBe("invalid_email");
      expect(yield* reasonFor({ models: [] })).toBe("invalid_models");
      expect(yield* reasonFor({ models: ["a", "a"] })).toBe("invalid_models");
      expect(yield* reasonFor({ models: ["a,b"] })).toBe("invalid_models");
      expect(yield* reasonFor({ models: Array.from({ length: 33 }, (_, i) => `m${i}`) })).toBe(
        "invalid_models",
      );
      expect(yield* reasonFor({ token: "has space" })).toBe("invalid_token");
      // Not linked to the account the caller names, or linked under another key.
      expect(yield* reasonFor({ ownerUserId: "someone-else" })).toBe("not_linked");
      expect(yield* reasonFor({}, { ...asEnvironment, environmentPublicKey: "other-key" })).toBe(
        "not_linked",
      );
      expect(
        yield* reasonFor({}, { environmentId: "env-9", environmentPublicKey: "env-key-1" }),
      ).toBe("not_linked");
    }).pipe(
      Effect.provide(layer),
      Effect.andThen(
        Effect.gen(function* () {
          const invites = yield* ModelShareInvites.ModelShareInvites;
          const error = yield* Effect.flip(
            invites.create({ ...asEnvironment, request: createRequest }),
          );
          expect(error).toMatchObject({
            _tag: "ModelShareInviteInvalid",
            reason: "address_not_https",
          });
        }).pipe(Effect.provide(secure.layer)),
      ),
    );
  });

  it.effect("caps the invites an owner can leave waiting, and frees a slot on revoke", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const invites = yield* ModelShareInvites.ModelShareInvites;
      const ids: Array<string> = [];
      for (let index = 0; index < 50; index += 1) {
        const { inviteId } = yield* invites.create({
          ...asEnvironment,
          request: {
            ...createRequest,
            shareId: `share-${index}`,
            recipientEmail: `p${index}@example.com`,
          },
        });
        ids.push(inviteId);
      }
      const error = yield* Effect.flip(
        invites.create({ ...asEnvironment, request: { ...createRequest, shareId: "share-51" } }),
      );
      expect(error).toMatchObject({ _tag: "ModelShareInviteLimitReached", maxOpenInvites: 50 });
      yield* invites.revoke({ environmentId: "env-1", inviteId: ids[0] ?? "" });
      yield* invites.create({
        ...asEnvironment,
        request: { ...createRequest, shareId: "share-52" },
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails closed without a sealing key instead of storing the token in the clear", () => {
    const { modelShareSealingKey: _omitted, ...withoutKey } = settings;
    const { memory, layer } = setup({ config: withoutKey });
    return Effect.gen(function* () {
      const invites = yield* ModelShareInvites.ModelShareInvites;
      const error = yield* Effect.flip(
        invites.create({ ...asEnvironment, request: createRequest }),
      );
      expect(error._tag).toBe("ModelShareInviteUnavailable");
      expect(memory.rows.size).toBe(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("skips a sealed value that was moved onto another invite", () => {
    const { memory, layer } = setup();
    return Effect.gen(function* () {
      const invites = yield* ModelShareInvites.ModelShareInvites;
      const first = yield* invites.create({ ...asEnvironment, request: createRequest });
      const second = yield* invites.create({
        ...asEnvironment,
        request: { ...createRequest, shareId: "share-2" },
      });
      const firstRow = memory.rows.get(first.inviteId);
      const secondRow = memory.rows.get(second.inviteId);
      if (!firstRow || !secondRow) throw new Error("rows missing");
      memory.rows.set(second.inviteId, { ...secondRow, sealedToken: firstRow.sealedToken });
      const offers = yield* invites.offersForRecipient(verifiedSam);
      expect(offers.map((offer) => offer.inviteId)).toEqual([first.inviteId]);
    }).pipe(Effect.provide(layer));
  });
});

describe("ModelShareInvites email", () => {
  const withMail = (mail = makeMailRecorder(), ownerEmail: string | null = OWNER_EMAIL) =>
    setup({ config: mailSettings, mail, ownerEmail });
  const inviteTo = (recipientEmail: string, shareId = "share-1") => ({
    ...asEnvironment,
    request: { ...createRequest, shareId, recipientEmail },
  });

  it.effect(
    "sends one email over SMTP when the settings and the sender's address are known",
    () => {
      const { layer, mail, memory } = withMail();
      return Effect.gen(function* () {
        const invites = yield* ModelShareInvites.ModelShareInvites;
        const created = yield* invites.create({ ...asEnvironment, request: createRequest });
        expect(created.emailed).toBe(true);

        expect(mail.server.connects).toEqual([{ host: "mail.example.test", port: 465 }]);
        expect(mail.server.commands).toContain("MAIL FROM:<support@example.test>");
        expect(mail.server.commands).toContain("RCPT TO:<sam@example.com>");
        expect(mail.requests).toHaveLength(1);
        const sent = mail.requests[0];
        expect(sent?.to).toBe("sam@example.com");
        expect(sent?.from).toBe("CodeWrench <support@example.test>");
        expect(sent?.raw).toContain(`Message-ID: <${created.inviteId}@relay.savagesolutions.io>`);
        expect(sent?.body.subject).toBe(`${OWNER_EMAIL} shared an AI model with you on CodeWrench`);
        const body = sent?.body;
        expect(body?.text).toContain("Shared from: Ryan's MacBook");
        expect(body?.text).toContain("Models: claude-opus");
        expect(body?.text).toContain("sign in with this email address (sam@example.com)");

        // Nothing that could redeem the share, and no password, is in what was sent.
        const stored = memory.rows.get(created.inviteId);
        const everything = `${mail.server.messages.join("")}${body?.text}${body?.html}`;
        expect(everything).not.toContain(TOKEN);
        expect(everything).not.toContain(stored?.sealedToken ?? "unreachable");
        expect(everything).not.toContain("home.example.test");
        expect(everything).not.toContain("model-share");
        expect(everything).not.toContain(SMTP_PASSWORD);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("sends nothing and says so when the SMTP settings are not all present", () => {
    const { modelShareEmail: _omitted, ...withoutMail } = mailSettings;
    const off = setup({ config: withoutMail, ownerEmail: OWNER_EMAIL });
    return Effect.gen(function* () {
      const invites = yield* ModelShareInvites.ModelShareInvites;
      const created = yield* invites.create({ ...asEnvironment, request: createRequest });
      expect(created.emailed).toBe(false);
      expect(off.mail.server.connects).toEqual([]);
      expect(yield* invites.offersForRecipient(verifiedSam)).toHaveLength(1);
    }).pipe(Effect.provide(off.layer));
  });

  it.effect("names the sharing account by the verified address the relay has stored", () => {
    const { layer, mail } = withMail();
    return Effect.gen(function* () {
      const invites = yield* ModelShareInvites.ModelShareInvites;
      yield* invites.create({ ...asEnvironment, request: createRequest });
      const body = mail.requests[0]?.body as { subject: string; text: string; html: string };
      expect(body.subject).toBe(`${OWNER_EMAIL} shared an AI model with you on CodeWrench`);
      expect(body.text).toContain(`${OWNER_EMAIL} shared an AI model with you on CodeWrench.`);
      expect(body.html).toContain(`${OWNER_EMAIL} shared an AI model with you on CodeWrench.`);
      expect(body.text).not.toContain("Someone");
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "sends nothing, and keeps the invite, when the relay has no address for the sharer",
    () => {
      const { layer, mail, memory } = withMail(makeMailRecorder(), null);
      return Effect.gen(function* () {
        const invites = yield* ModelShareInvites.ModelShareInvites;
        const created = yield* invites.create({ ...asEnvironment, request: createRequest });
        expect(created.emailed).toBe(false);
        expect(mail.requests).toHaveLength(0);
        expect(memory.rows.has(created.inviteId)).toBe(true);
        expect(yield* invites.offersForRecipient(verifiedSam)).toHaveLength(1);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "learns the address only from a verified token, and follows a change of address",
    () => {
      const { layer, mail, accounts } = withMail(makeMailRecorder(), null);
      return Effect.gen(function* () {
        const invites = yield* ModelShareInvites.ModelShareInvites;
        const known = yield* AccountEmails.AccountEmails;
        const create = (recipientEmail: string) =>
          invites.create(inviteTo(recipientEmail, `share-${recipientEmail}`));

        // Unverified, or no address at all: nothing is remembered and nothing is sent.
        yield* known.record({
          userId: "owner-1",
          email: OWNER_EMAIL,
          emailVerified: false,
          firstName: null,
        });
        yield* known.record({
          userId: "owner-1",
          email: OWNER_EMAIL,
          emailVerified: undefined,
          firstName: null,
        });
        yield* known.record({
          userId: "owner-1",
          email: undefined,
          emailVerified: true,
          firstName: null,
        });
        expect(accounts.writes).toEqual([]);
        expect((yield* create("a@example.com")).emailed).toBe(false);

        // A verified address, in any letter case, is stored lower-cased and written once.
        yield* known.record({
          userId: "owner-1",
          email: "Ryan@CandidStudios.test",
          emailVerified: true,
          firstName: null,
        });
        yield* known.record({
          userId: "owner-1",
          email: OWNER_EMAIL,
          emailVerified: true,
          firstName: null,
        });
        yield* known.record({
          userId: "owner-1",
          email: OWNER_EMAIL,
          emailVerified: true,
          firstName: null,
        });
        expect(accounts.writes).toEqual([
          { userId: "owner-1", email: OWNER_EMAIL, firstName: null },
        ]);
        expect((yield* create("b@example.com")).emailed).toBe(true);

        // The account changes its address: the next email names the new one.
        yield* known.record({
          userId: "owner-1",
          email: "ryan@new.test",
          emailVerified: true,
          firstName: null,
        });
        expect(accounts.writes.map((write) => write.email)).toEqual([OWNER_EMAIL, "ryan@new.test"]);
        // An unverified token does not take the stored address back.
        yield* known.record({
          userId: "owner-1",
          email: "attacker@evil.test",
          emailVerified: false,
          firstName: null,
        });
        expect((yield* create("c@example.com")).emailed).toBe(true);

        const subjects = mail.requests.map((sent) => (sent.body as { subject: string }).subject);
        expect(subjects).toEqual([
          `${OWNER_EMAIL} shared an AI model with you on CodeWrench`,
          "ryan@new.test shared an AI model with you on CodeWrench",
        ]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "keeps the first name from the same verified token, and a token without one keeps it",
    () => {
      const { layer, accounts } = withMail(makeMailRecorder(), null);
      return Effect.gen(function* () {
        const known = yield* AccountEmails.AccountEmails;
        const token = { userId: "owner-1", email: OWNER_EMAIL, emailVerified: true as const };
        yield* known.record({ ...token, firstName: "Ryan" });
        yield* known.record({ ...token, firstName: "Ryan" });
        yield* known.record({ ...token, firstName: null });
        expect(accounts.writes).toEqual([
          { userId: "owner-1", email: OWNER_EMAIL, firstName: "Ryan" },
        ]);
        expect(yield* known.lookupFirstName({ email: OWNER_EMAIL })).toBe("Ryan");
        // A changed name is written; an unverified token teaches nothing, name included.
        yield* known.record({ ...token, firstName: "Ryan M" });
        yield* known.record({ ...token, emailVerified: false as never, firstName: "Mallory" });
        expect(accounts.writes.map((write) => write.firstName)).toEqual(["Ryan", "Ryan M"]);
        expect(yield* known.lookupFirstName({ email: "nobody@example.com" })).toBeNull();
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("cannot be made to name anyone but the sharing account", () => {
    const { layer, mail, accounts } = withMail();
    accounts.rows.set("owner-2", "victim@example.com");
    return Effect.gen(function* () {
      const invites = yield* ModelShareInvites.ModelShareInvites;
      // Fields smuggled into the create request body are not read.
      const forged = {
        ...createRequest,
        senderEmail: "ceo@example.com",
        sender: "ceo@example.com",
        from: "ceo@example.com",
        ownerEmail: "ceo@example.com",
      };
      yield* invites.create({ ...asEnvironment, request: forged });
      // Naming another account as the owner fails the link check before anything is sent.
      const error = yield* Effect.flip(
        invites.create({
          ...asEnvironment,
          request: { ...createRequest, shareId: "share-2", ownerUserId: "owner-2" },
        }),
      );
      expect(error).toMatchObject({ _tag: "ModelShareInviteInvalid", reason: "not_linked" });
      expect(mail.requests).toHaveLength(1);
      const body = mail.requests[0]?.body as { subject: string; text: string; html: string };
      expect(body.subject).toBe(`${OWNER_EMAIL} shared an AI model with you on CodeWrench`);
      expect(encodeJson(mail.requests[0]?.body)).not.toContain("ceo@example.com");
      expect(encodeJson(mail.requests[0]?.body)).not.toContain("victim@example.com");
    }).pipe(Effect.provide(layer));
  });

  it.effect("does not email on list, revoke or when the recipient collects the invite", () => {
    const { layer, mail } = withMail();
    return Effect.gen(function* () {
      const invites = yield* ModelShareInvites.ModelShareInvites;
      const { inviteId } = yield* invites.create({ ...asEnvironment, request: createRequest });
      yield* invites.listForEnvironment({ environmentId: "env-1" });
      yield* invites.offersForRecipient(verifiedSam);
      yield* invites.accept({ inviteId, ...verifiedSam });
      yield* invites.revoke({ environmentId: "env-1", inviteId }).pipe(Effect.ignore);
      expect(mail.requests).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect.each([
    {
      name: "refuses the login",
      options: { replies: { "AUTH PLAIN": "535 5.7.8 Bad credentials" } },
    },
    {
      name: "refuses the recipient",
      options: { replies: { "RCPT TO": "550 5.1.1 No such user" } },
    },
    { name: "drops the connection", options: { closeOn: "MAIL FROM" } },
  ] as const)("keeps the invite when the mail server $name", ({ options }) => {
    const mail = makeMailRecorder(options);
    const { layer, memory } = withMail(mail);
    return Effect.gen(function* () {
      const invites = yield* ModelShareInvites.ModelShareInvites;
      const created = yield* invites.create({ ...asEnvironment, request: createRequest });
      expect(created.emailed).toBe(false);
      expect(memory.rows.has(created.inviteId)).toBe(true);
      expect(mail.server.state.closed).toBe(true);
      expect(yield* invites.offersForRecipient(verifiedSam)).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "gives up on a mail server that stalls after 10 seconds and closes the connection",
    () => {
      const mail = makeMailRecorder({ silentOn: "RCPT TO" });
      const { layer, memory } = withMail(mail);
      return Effect.gen(function* () {
        const invites = yield* ModelShareInvites.ModelShareInvites;
        const creating = yield* invites
          .create({ ...asEnvironment, request: createRequest })
          .pipe(Effect.forkChild);
        // Wait, in real time, until the server has been asked and is not answering.
        yield* Effect.promise(() => mail.server.waitFor("RCPT TO"));
        yield* TestClock.adjust("9 seconds");
        expect(creating.pollUnsafe()).toBeUndefined();
        yield* TestClock.adjust("1 second");
        const created = yield* Fiber.join(creating);
        expect(created.emailed).toBe(false);
        expect(memory.rows.has(created.inviteId)).toBe(true);
        expect(mail.server.state.closed).toBe(true);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "greets the recipient by first name when the relay knows it, otherwise just Hi,",
    () => {
      const { layer, mail, accounts } = withMail();
      accounts.rows.set("user-sam", "sam@example.com");
      accounts.firstNames.set("user-sam", "Samantha");
      return Effect.gen(function* () {
        const invites = yield* ModelShareInvites.ModelShareInvites;
        yield* invites.create(inviteTo("sam@example.com", "share-1"));
        yield* invites.create(inviteTo("stranger@example.com", "share-2"));
        const [known, unknown] = mail.requests;
        expect(known?.body.text.startsWith("Hi Samantha,\n\n")).toBe(true);
        expect(known?.body.html).toContain(">Hi Samantha,</p>");
        expect(unknown?.body.text.startsWith("Hi,\n\n")).toBe(true);
        expect(unknown?.body.html).toContain(">Hi,</p>");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("emails an address once a day per account, even after a revoke", () => {
    const { layer, mail } = withMail();
    return Effect.gen(function* () {
      const invites = yield* ModelShareInvites.ModelShareInvites;
      const first = yield* invites.create(inviteTo("sam@example.com", "share-1"));
      // Same address again while the first is open, and again after revoking it.
      const second = yield* invites.create(inviteTo("Sam@Example.com", "share-2"));
      yield* invites.revoke({ environmentId: "env-1", inviteId: first.inviteId });
      const third = yield* invites.create(inviteTo("sam@example.com", "share-3"));
      expect([first.emailed, second.emailed, third.emailed]).toEqual([true, false, false]);
      expect(mail.requests).toHaveLength(1);
      // The invites themselves still work.
      expect(yield* invites.offersForRecipient(verifiedSam)).toHaveLength(2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("caps how many invitations one account can turn into email in a day", () => {
    const { layer, mail } = withMail();
    return Effect.gen(function* () {
      const invites = yield* ModelShareInvites.ModelShareInvites;
      const emailed: Array<boolean> = [];
      for (let index = 0; index < 30; index += 1) {
        const created = yield* invites.create(inviteTo(`p${index}@example.com`, `share-${index}`));
        emailed.push(created.emailed);
        // Revoking frees the open-invite slot but must not free an email.
        yield* invites.revoke({ environmentId: "env-1", inviteId: created.inviteId });
      }
      expect(emailed.filter(Boolean)).toHaveLength(20);
      expect(emailed.slice(0, 20).every(Boolean)).toBe(true);
      expect(mail.requests).toHaveLength(20);
    }).pipe(Effect.provide(layer));
  });
});

describe("model share invite HTTP API", () => {
  const principalFor = (authorization: string | undefined) => {
    switch (authorization) {
      case "Bearer sam-verified":
        return { userId: "user-sam", token: "t", email: "sam@example.com", emailVerified: true };
      case "Bearer sam-unverified":
        return { userId: "user-sam", token: "t", email: "sam@example.com", emailVerified: false };
      case "Bearer mallory":
        return {
          userId: "user-mallory",
          token: "t",
          email: "mallory@example.com",
          emailVerified: true,
        };
      default:
        return { userId: "user-none", token: "t" };
    }
  };

  it.effect("creates, offers, accepts and revokes through the real handlers", () => {
    const { layer } = setup();
    const handlers = Layer.mergeAll(modelShareInviteClientApi, modelShareInviteServerApi).pipe(
      Layer.provide(layer),
      Layer.provideMerge(
        Layer.mergeAll(
          Layer.succeed(RelayClientAuth, {
            clientBearer: (effect, { credential }) =>
              Effect.provideService(
                effect,
                RelayClientPrincipal,
                principalFor(`Bearer ${Redacted.value(credential).trim()}`),
              ),
          }),
          Layer.succeed(RelayEnvironmentAuth, {
            environmentBearer: (effect, { credential }) =>
              Effect.provideService(effect, RelayEnvironmentPrincipal, {
                environmentId: Redacted.value(credential).trim() === "env-2" ? "env-2" : "env-1",
                environmentPublicKey: "env-key-1",
              }),
          }),
        ),
      ),
    );
    return Effect.gen(function* () {
      const app = yield* Effect.acquireRelease(
        Effect.sync(() =>
          HttpRouter.toWebHandler(
            HttpApiBuilder.layer(
              HttpApi.make("RelayApi").add(
                RelayApi.groups.modelShareInviteClient,
                RelayApi.groups.modelShareInviteServer,
              ),
            ).pipe(Layer.provide(handlers), Layer.provide(HttpServer.layerServices)),
            { disableLogger: true },
          ),
        ),
        (app) => Effect.promise(() => app.dispose()),
      );
      const call = (method: string, path: string, bearer: string, body?: unknown) =>
        Effect.promise(() =>
          app.handler(
            new Request(`https://relay.example.test${path}`, {
              method,
              headers: {
                authorization: `Bearer ${bearer}`,
                ...(body === undefined ? {} : { "content-type": "application/json" }),
              },
              ...(body === undefined ? {} : { body: encodeJson(body) }),
            }),
          ),
        );

      const created = yield* call("POST", "/v1/model-share-invites", "env-1", createRequest);
      expect(created.status).toBe(200);
      const { inviteId, emailed } = (yield* Effect.promise(() => created.json())) as {
        inviteId: string;
        emailed: boolean;
      };
      expect(emailed).toBe(false);

      const bad = yield* call("POST", "/v1/model-share-invites", "env-1", {
        ...createRequest,
        recipientEmail: "nope",
      });
      expect(bad.status).toBe(400);

      // Not verified, or someone else: an empty list, never an error that hints an invite exists.
      for (const bearer of ["sam-unverified", "mallory", "anonymous"]) {
        const response = yield* call("GET", "/v1/model-share-invites/mine", bearer);
        expect(response.status).toBe(200);
        expect(yield* Effect.promise(() => response.json())).toEqual({ invites: [] });
      }
      const mine = yield* call("GET", "/v1/model-share-invites/mine", "sam-verified");
      expect(mine.status).toBe(200);
      expect(mine.headers.get("cache-control")).toBe("no-store");
      const body = (yield* Effect.promise(() => mine.json())) as {
        invites: Array<{ inviteId: string; token: string }>;
      };
      expect(body.invites.map((offer) => [offer.inviteId, offer.token])).toEqual([
        [inviteId, TOKEN],
      ]);

      // Other accounts get 404 for this id, the same as for an id that never existed.
      for (const bearer of ["sam-unverified", "mallory"]) {
        expect(
          (yield* call("POST", `/v1/model-share-invites/${inviteId}/accepted`, bearer)).status,
        ).toBe(404);
      }
      expect(
        (yield* call("POST", "/v1/model-share-invites/unknown/accepted", "mallory")).status,
      ).toBe(404);
      expect((yield* call("DELETE", `/v1/model-share-invites/${inviteId}`, "env-2")).status).toBe(
        404,
      );

      expect(
        (yield* call("POST", `/v1/model-share-invites/${inviteId}/accepted`, "sam-verified"))
          .status,
      ).toBe(200);
      const after = yield* call("GET", "/v1/model-share-invites/mine", "sam-verified");
      expect(yield* Effect.promise(() => after.json())).toEqual({ invites: [] });

      const listed = yield* call("GET", "/v1/model-share-invites", "env-1");
      const listedText = yield* Effect.promise(() => listed.clone().text());
      expect(listedText).not.toContain(TOKEN);
      const listedBody = (yield* Effect.promise(() => listed.json())) as {
        invites: Array<{ inviteId: string; acceptedAt: string | null }>;
      };
      expect(listedBody.invites).toHaveLength(1);
      expect(listedBody.invites[0]?.acceptedAt).not.toBeNull();
      expect((yield* call("DELETE", `/v1/model-share-invites/${inviteId}`, "env-1")).status).toBe(
        200,
      );
      expect((yield* call("DELETE", `/v1/model-share-invites/${inviteId}`, "env-1")).status).toBe(
        404,
      );
    }).pipe(Effect.scoped);
  });
});
