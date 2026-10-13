import * as NodeCrypto from "node:crypto";
import {
  CAMPAIGN_PLATFORMS,
  Campaign,
  CampaignClient,
  CampaignError,
  CampaignPost,
  CampaignPostApproval,
  CampaignPostCaptions,
  CampaignPostCreatedBy,
  DEFAULT_CAMPAIGN_APPROVAL_MODE,
  type CampaignApprovalMode,
  type CampaignClientUpsertInput,
  type CampaignPlatform,
  type CampaignPostContentInput,
  type CampaignPostStatus,
  type CampaignPublishLogEntry,
  type CampaignPublishResult,
  type CampaignSummary,
  type CampaignUpsertInput,
  type ThreadId,
} from "@t3tools/contracts";
import {
  approvedByLabel,
  canTransition,
  duePosts,
  effectiveMode,
  nextStatusAfterSubmit,
  statusAfterEdit,
  statusAfterPersonApproval,
  validateCampaignPost,
} from "@t3tools/shared/campaignRules";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as CampaignThreadNotifier from "./CampaignThreadNotifier.ts";

interface ClientRow {
  readonly id: string;
  readonly name: string;
  readonly brand_notes: string;
  readonly do_not_say: string;
  readonly publishing_client_id: string | null;
  readonly approval_mode: string;
  readonly monthly_spend_cap_usd: number | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface CampaignRow {
  readonly id: string;
  readonly client_id: string;
  readonly name: string;
  readonly approval_mode: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface PostRow {
  readonly id: string;
  readonly campaign_id: string;
  readonly status: string;
  readonly platforms: string;
  readonly captions: string;
  readonly media_paths: string;
  readonly media_urls: string;
  readonly uploaded_media: string;
  readonly title: string | null;
  readonly destination_url: string | null;
  readonly scheduled_at: string | null;
  readonly source_thread_id: string | null;
  readonly created_by: string;
  readonly approval: string | null;
  readonly publish_results: string;
  readonly change_request: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface LogRow {
  readonly id: number;
  readonly post_id: string;
  readonly platform: string;
  readonly mode: string;
  readonly approved_by: string;
  readonly result: string;
  readonly link: string | null;
  readonly error: string | null;
  readonly at: string;
}

export const INTERRUPTED_BY_RESTART =
  "Interrupted by a restart. Check the account before retrying.";

const isCampaignError = Schema.is(CampaignError);
const fail = (reason: CampaignError["reason"], message: string) =>
  new CampaignError({ reason, message });
const notFound = (what: string) => fail("not_found", `That ${what} was not found.`);

const StringListJson = Schema.fromJsonString(Schema.Array(Schema.String));
const PlatformsJson = Schema.fromJsonString(CampaignPost.fields.platforms);
const CaptionsJson = Schema.fromJsonString(CampaignPostCaptions);
const CreatedByJson = Schema.fromJsonString(CampaignPostCreatedBy);
const ApprovalJson = Schema.fromJsonString(CampaignPostApproval);
const ResultsJson = Schema.fromJsonString(CampaignPost.fields.publishResults);
const UploadedMediaJson = Schema.fromJsonString(CampaignPost.fields.uploadedMedia);
const readStringList = Schema.decodeUnknownSync(StringListJson);
const readPlatforms = Schema.decodeUnknownSync(PlatformsJson);
const readCaptions = Schema.decodeUnknownSync(CaptionsJson);
const readCreatedBy = Schema.decodeUnknownSync(CreatedByJson);
const readApproval = Schema.decodeUnknownSync(ApprovalJson);
const readResults = Schema.decodeUnknownSync(ResultsJson);
const readUploadedMedia = Schema.decodeUnknownSync(UploadedMediaJson);
const writeStringList = Schema.encodeSync(StringListJson);
const writePlatforms = Schema.encodeSync(PlatformsJson);
const writeCaptions = Schema.encodeSync(CaptionsJson);
const writeCreatedBy = Schema.encodeSync(CreatedByJson);
const writeApproval = Schema.encodeSync(ApprovalJson);
const writeResults = Schema.encodeSync(ResultsJson);
const writeUploadedMedia = Schema.encodeSync(UploadedMediaJson);

const decodeClient = Schema.decodeUnknownSync(CampaignClient);
const decodeCampaign = Schema.decodeUnknownSync(Campaign);
const decodePost = Schema.decodeUnknownSync(CampaignPost);

const clientFromRow = (row: ClientRow): CampaignClient =>
  decodeClient({
    id: row.id,
    name: row.name,
    brandNotes: row.brand_notes,
    doNotSay: readStringList(row.do_not_say),
    ...(row.publishing_client_id === null ? {} : { publishingClientId: row.publishing_client_id }),
    approvalMode: row.approval_mode,
    ...(row.monthly_spend_cap_usd === null
      ? {}
      : { monthlySpendCapUsd: row.monthly_spend_cap_usd }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

const campaignFromRow = (row: CampaignRow): Campaign =>
  decodeCampaign({
    id: row.id,
    clientId: row.client_id,
    name: row.name,
    ...(row.approval_mode === null ? {} : { approvalMode: row.approval_mode }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

const postFromRow = (row: PostRow): CampaignPost =>
  decodePost({
    id: row.id,
    campaignId: row.campaign_id,
    status: row.status,
    platforms: readPlatforms(row.platforms),
    captions: readCaptions(row.captions),
    mediaPaths: readStringList(row.media_paths),
    mediaUrls: readStringList(row.media_urls),
    uploadedMedia: readUploadedMedia(row.uploaded_media),
    ...(row.title === null ? {} : { title: row.title }),
    ...(row.destination_url === null ? {} : { destinationUrl: row.destination_url }),
    ...(row.scheduled_at === null ? {} : { scheduledAt: row.scheduled_at }),
    ...(row.source_thread_id === null ? {} : { sourceThreadId: row.source_thread_id }),
    createdBy: readCreatedBy(row.created_by),
    approval: row.approval === null ? null : readApproval(row.approval),
    publishResults: readResults(row.publish_results),
    ...(row.change_request === null ? {} : { changeRequest: row.change_request }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

const logFromRow = (row: LogRow): CampaignPublishLogEntry => ({
  id: row.id,
  postId: row.post_id,
  platform: row.platform as CampaignPlatform,
  mode: row.mode as CampaignApprovalMode,
  approvedBy: row.approved_by,
  result: row.result === "success" ? "success" : "failure",
  ...(row.link === null ? {} : { link: row.link }),
  ...(row.error === null ? {} : { error: row.error }),
  at: row.at,
});

const KNOWN_PLATFORMS: ReadonlySet<string> = new Set(CAMPAIGN_PLATFORMS);

/** A path inside the thread's folder: relative, no climbing out. The export re-checks on disk. */
const isRelativeInside = (value: string): boolean =>
  value.trim() !== "" &&
  !value.startsWith("/") &&
  !value.startsWith("\\") &&
  !/^[A-Za-z]:/.test(value) &&
  !value.split(/[\\/]/).includes("..");

const isWebUrl = (value: string): boolean => {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
};

const toIso = (value: string): string | null =>
  Option.match(DateTime.make(value), {
    onNone: () => null,
    onSome: DateTime.formatIso,
  });

export interface PublishRecord {
  readonly postId: string;
  readonly platform: CampaignPlatform;
  readonly result: Omit<CampaignPublishResult, "at">;
}

export class CampaignStore extends Context.Service<
  CampaignStore,
  {
    readonly listClients: Effect.Effect<ReadonlyArray<CampaignClient>, CampaignError>;
    readonly getClient: (id: string) => Effect.Effect<CampaignClient, CampaignError>;
    readonly upsertClient: (
      input: CampaignClientUpsertInput,
    ) => Effect.Effect<CampaignClient, CampaignError>;
    /** Removes the client with its campaigns and posts. The publish log is kept. */
    readonly deleteClient: (id: string) => Effect.Effect<void, CampaignError>;
    readonly listCampaigns: (
      clientId?: string,
    ) => Effect.Effect<ReadonlyArray<CampaignSummary>, CampaignError>;
    readonly getCampaign: (id: string) => Effect.Effect<Campaign, CampaignError>;
    readonly upsertCampaign: (input: CampaignUpsertInput) => Effect.Effect<Campaign, CampaignError>;
    readonly deleteCampaign: (id: string) => Effect.Effect<void, CampaignError>;
    readonly listPosts: (
      campaignId: string,
    ) => Effect.Effect<ReadonlyArray<CampaignPost>, CampaignError>;
    /** The campaign's posts with every publish attempt for them. */
    readonly listPostsWithLog: (campaignId: string) => Effect.Effect<
      {
        readonly posts: ReadonlyArray<CampaignPost>;
        readonly log: ReadonlyArray<CampaignPublishLogEntry>;
      },
      CampaignError
    >;
    /** Tells subscribers something the board shows has changed outside the store. */
    readonly touch: Effect.Effect<void>;
    readonly getPost: (id: string) => Effect.Effect<CampaignPost, CampaignError>;
    /** The client and campaign a post belongs to, for the mode and the do-not-say list. */
    readonly contextOf: (
      post: CampaignPost,
    ) => Effect.Effect<
      { readonly client: CampaignClient; readonly campaign: Campaign },
      CampaignError
    >;
    /**
     * Creates a post, or edits one. An edit always returns the post to a draft and drops its
     * approval. An agent may only touch drafts and posts waiting for approval.
     */
    readonly savePost: (
      actor: CampaignPostCreatedBy,
      input: CampaignPostContentInput & {
        readonly id?: string | undefined;
        readonly campaignId: string;
      },
    ) => Effect.Effect<CampaignPost, CampaignError>;
    readonly deletePost: (id: string) => Effect.Effect<void, CampaignError>;
    /**
     * "This post is ready." Under ask-first it waits for a person; in the other modes the
     * person's setting approves it. The result says which.
     */
    readonly submitPost: (
      actor: CampaignPostCreatedBy,
      id: string,
    ) => Effect.Effect<CampaignPost, CampaignError>;
    /** Person only. A future time schedules the post; otherwise it is due at once. */
    readonly approvePost: (input: {
      readonly postId: string;
      readonly scheduledAt?: string | null | undefined;
    }) => Effect.Effect<CampaignPost, CampaignError>;
    readonly requestChanges: (input: {
      readonly postId: string;
      readonly text: string;
    }) => Effect.Effect<CampaignPost, CampaignError>;
    readonly rejectPost: (id: string) => Effect.Effect<CampaignPost, CampaignError>;
    /** Approves a post and makes it due at once. */
    readonly publishNow: (id: string) => Effect.Effect<CampaignPost, CampaignError>;
    /** Puts a failed post back in line; only the platforms that did not succeed are tried again. */
    readonly retryPost: (id: string) => Effect.Effect<CampaignPost, CampaignError>;
    /** Approved and scheduled posts whose time has come. */
    readonly listDue: (now: string) => Effect.Effect<ReadonlyArray<CampaignPost>, CampaignError>;
    /** Claims a due post for publishing. False when it is no longer approved or scheduled. */
    readonly beginPublishing: (id: string) => Effect.Effect<boolean, CampaignError>;
    /**
     * Notes files uploaded to cloud storage: path to public address. The addresses are also added to
     * the post's `mediaUrls`. Changes no status and drops no approval: the post's files are the same.
     */
    readonly recordUploadedMedia: (input: {
      readonly postId: string;
      readonly uploaded: Readonly<Record<string, string>>;
    }) => Effect.Effect<CampaignPost, CampaignError>;
    /**
     * Takes the uploaded files whose address `matches` off the post, from `uploadedMedia` and from
     * `mediaUrls`, so they are uploaded again if the post is sent. Nothing else changes.
     */
    readonly dropUploadedMedia: (input: {
      readonly postId: string;
      readonly matches: (url: string) => boolean;
    }) => Effect.Effect<CampaignPost, CampaignError>;
    /** Records one platform's outcome on the post and in the publish log. */
    readonly recordPublishResult: (
      input: PublishRecord,
    ) => Effect.Effect<CampaignPost, CampaignError>;
    /** Ends publishing: posted when every platform succeeded, failed otherwise. */
    readonly finishPublishing: (id: string) => Effect.Effect<CampaignPost, CampaignError>;
    /**
     * Fails every post found mid-publish. A platform with no result may have gone out, so it is
     * never retried on its own. Returns the posts it failed.
     */
    readonly recoverInterrupted: Effect.Effect<ReadonlyArray<CampaignPost>, CampaignError>;
    readonly publishLog: (
      postId: string,
    ) => Effect.Effect<ReadonlyArray<CampaignPublishLogEntry>, CampaignError>;
    /** Emits a revision on subscribe and after every change. */
    readonly subscribeChanges: Stream.Stream<number>;
  }
>()("t3/campaigns/CampaignStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const notifier = yield* CampaignThreadNotifier.CampaignThreadNotifier;
  // Writes are read-modify-write on one post; one at a time keeps a person's click and the
  // publisher from overwriting each other.
  const lock = yield* Semaphore.make(1);
  const revision = yield* Ref.make(0);
  const changes = yield* PubSub.sliding<void>(1);

  const storage = (cause: unknown) =>
    isCampaignError(cause)
      ? cause
      : fail("storage", "The campaign data could not be read or saved.");
  const db = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, CampaignError, R> =>
    effect.pipe(Effect.mapError(storage));
  const parsed = <A>(read: () => A) => Effect.try({ try: read, catch: storage });

  const now = Effect.map(Clock.currentTimeMillis, (ms) =>
    DateTime.formatIso(DateTime.makeUnsafe(ms)),
  );
  const notifyChanged = Effect.andThen(
    Ref.update(revision, (value) => value + 1),
    PubSub.publish(changes, undefined),
  ).pipe(Effect.asVoid);
  /** Runs one write under the lock and tells subscribers when it succeeded. */
  const write = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    lock.withPermit(db(effect)).pipe(Effect.tap(() => notifyChanged));

  const newId = (prefix: string) => `${prefix}_${NodeCrypto.randomUUID()}`;

  const selectClient = (id: string) =>
    db(sql<ClientRow>`SELECT * FROM workbench_campaign_clients WHERE id = ${id}`);
  const selectCampaign = (id: string) =>
    db(sql<CampaignRow>`SELECT * FROM workbench_campaigns WHERE id = ${id}`);
  const selectPost = (id: string) =>
    db(sql<PostRow>`SELECT * FROM workbench_campaign_posts WHERE id = ${id}`);

  const getClient: CampaignStore["Service"]["getClient"] = (id) =>
    Effect.gen(function* () {
      const row = (yield* selectClient(id))[0];
      if (row === undefined) return yield* notFound("client");
      return yield* parsed(() => clientFromRow(row));
    });
  const getCampaign: CampaignStore["Service"]["getCampaign"] = (id) =>
    Effect.gen(function* () {
      const row = (yield* selectCampaign(id))[0];
      if (row === undefined) return yield* notFound("campaign");
      return yield* parsed(() => campaignFromRow(row));
    });
  const getPost: CampaignStore["Service"]["getPost"] = (id) =>
    Effect.gen(function* () {
      const row = (yield* selectPost(id))[0];
      if (row === undefined) return yield* notFound("post");
      return yield* parsed(() => postFromRow(row));
    });

  const contextOf: CampaignStore["Service"]["contextOf"] = (post) =>
    Effect.gen(function* () {
      const campaign = yield* getCampaign(post.campaignId);
      const client = yield* getClient(campaign.clientId);
      return { client, campaign };
    });

  const listClients: CampaignStore["Service"]["listClients"] = Effect.gen(function* () {
    const rows = yield* db(
      sql<ClientRow>`SELECT * FROM workbench_campaign_clients ORDER BY name COLLATE NOCASE, id`,
    );
    return yield* parsed(() => rows.map(clientFromRow));
  });

  const upsertClient: CampaignStore["Service"]["upsertClient"] = (input) =>
    write(
      Effect.gen(function* () {
        const at = yield* now;
        const doNotSay = [
          ...new Set(
            input.doNotSay.map((phrase) => phrase.trim()).filter((phrase) => phrase !== ""),
          ),
        ];
        const existing = input.id === undefined ? undefined : (yield* selectClient(input.id))[0];
        if (input.id !== undefined && existing === undefined) return yield* notFound("client");
        const publishingClientId =
          input.publishingClientId === undefined
            ? (existing?.publishing_client_id ?? null)
            : input.publishingClientId;
        const cap =
          input.monthlySpendCapUsd === undefined
            ? (existing?.monthly_spend_cap_usd ?? null)
            : input.monthlySpendCapUsd;
        const mode =
          input.approvalMode ?? existing?.approval_mode ?? DEFAULT_CAMPAIGN_APPROVAL_MODE;
        const id = existing?.id ?? newId("client");
        if (existing === undefined) {
          yield* sql`
            INSERT INTO workbench_campaign_clients
              (id, name, brand_notes, do_not_say, publishing_client_id, approval_mode, monthly_spend_cap_usd, created_at, updated_at)
            VALUES
              (${id}, ${input.name}, ${input.brandNotes}, ${writeStringList(doNotSay)}, ${publishingClientId},
               ${mode}, ${cap}, ${at}, ${at})
          `;
        } else {
          yield* sql`
            UPDATE workbench_campaign_clients
            SET name = ${input.name}, brand_notes = ${input.brandNotes}, do_not_say = ${writeStringList(doNotSay)},
                publishing_client_id = ${publishingClientId}, approval_mode = ${mode},
                monthly_spend_cap_usd = ${cap}, updated_at = ${at}
            WHERE id = ${id}
          `;
        }
        return yield* getClient(id);
      }),
    );

  const publishingCount = (where: "client" | "campaign", id: string) =>
    db(
      where === "client"
        ? sql<{ readonly n: number }>`
            SELECT COUNT(*) AS n FROM workbench_campaign_posts
            WHERE status = 'publishing'
              AND campaign_id IN (SELECT id FROM workbench_campaigns WHERE client_id = ${id})`
        : sql<{ readonly n: number }>`
            SELECT COUNT(*) AS n FROM workbench_campaign_posts
            WHERE status = 'publishing' AND campaign_id = ${id}`,
    ).pipe(Effect.map((rows) => rows[0]?.n ?? 0));

  const deleteClient: CampaignStore["Service"]["deleteClient"] = (id) =>
    write(
      Effect.gen(function* () {
        yield* getClient(id);
        if ((yield* publishingCount("client", id)) > 0) {
          return yield* fail(
            "conflict",
            "A post for this client is being published right now. Try again in a minute.",
          );
        }
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`DELETE FROM workbench_campaign_posts WHERE campaign_id IN (SELECT id FROM workbench_campaigns WHERE client_id = ${id})`;
            yield* sql`DELETE FROM workbench_campaigns WHERE client_id = ${id}`;
            yield* sql`DELETE FROM workbench_campaign_clients WHERE id = ${id}`;
          }),
        );
      }),
    );

  const listCampaigns: CampaignStore["Service"]["listCampaigns"] = (clientId) =>
    Effect.gen(function* () {
      const rows = yield* db(
        clientId === undefined
          ? sql<CampaignRow>`SELECT * FROM workbench_campaigns ORDER BY name COLLATE NOCASE, id`
          : sql<CampaignRow>`SELECT * FROM workbench_campaigns WHERE client_id = ${clientId} ORDER BY name COLLATE NOCASE, id`,
      );
      const counts = yield* db(sql<{
        readonly campaign_id: string;
        readonly status: string;
        readonly n: number;
      }>`
        SELECT campaign_id, status, COUNT(*) AS n FROM workbench_campaign_posts GROUP BY campaign_id, status`);
      const byCampaign = new Map<string, Record<string, number>>();
      for (const row of counts) {
        const entry = byCampaign.get(row.campaign_id) ?? {};
        entry[row.status] = row.n;
        byCampaign.set(row.campaign_id, entry);
      }
      return yield* parsed(() =>
        rows.map((row) => ({ ...campaignFromRow(row), postCounts: byCampaign.get(row.id) ?? {} })),
      );
    });

  const upsertCampaign: CampaignStore["Service"]["upsertCampaign"] = (input) =>
    write(
      Effect.gen(function* () {
        const at = yield* now;
        yield* getClient(input.clientId);
        const existing = input.id === undefined ? undefined : (yield* selectCampaign(input.id))[0];
        if (input.id !== undefined && existing === undefined) return yield* notFound("campaign");
        if (existing !== undefined && existing.client_id !== input.clientId) {
          return yield* fail("invalid", "A campaign cannot move to another client.");
        }
        const mode =
          input.approvalMode === undefined ? (existing?.approval_mode ?? null) : input.approvalMode;
        const id = existing?.id ?? newId("campaign");
        if (existing === undefined) {
          yield* sql`
            INSERT INTO workbench_campaigns (id, client_id, name, approval_mode, created_at, updated_at)
            VALUES (${id}, ${input.clientId}, ${input.name}, ${mode}, ${at}, ${at})
          `;
        } else {
          yield* sql`
            UPDATE workbench_campaigns SET name = ${input.name}, approval_mode = ${mode}, updated_at = ${at}
            WHERE id = ${id}
          `;
        }
        return yield* getCampaign(id);
      }),
    );

  const deleteCampaign: CampaignStore["Service"]["deleteCampaign"] = (id) =>
    write(
      Effect.gen(function* () {
        yield* getCampaign(id);
        if ((yield* publishingCount("campaign", id)) > 0) {
          return yield* fail(
            "conflict",
            "A post in this campaign is being published right now. Try again in a minute.",
          );
        }
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`DELETE FROM workbench_campaign_posts WHERE campaign_id = ${id}`;
            yield* sql`DELETE FROM workbench_campaigns WHERE id = ${id}`;
          }),
        );
      }),
    );

  const listPosts: CampaignStore["Service"]["listPosts"] = (campaignId) =>
    Effect.gen(function* () {
      const rows = yield* db(
        sql<PostRow>`SELECT * FROM workbench_campaign_posts WHERE campaign_id = ${campaignId} ORDER BY created_at, id`,
      );
      return yield* parsed(() => rows.map(postFromRow));
    });

  /** Writes a whole post back. Callers have already checked the transition. */
  const storePost = (post: CampaignPost) =>
    sql`
      UPDATE workbench_campaign_posts SET
        status = ${post.status}, platforms = ${writePlatforms(post.platforms)},
        captions = ${writeCaptions(post.captions)}, media_paths = ${writeStringList(post.mediaPaths)},
        media_urls = ${writeStringList(post.mediaUrls)},
        uploaded_media = ${writeUploadedMedia(post.uploadedMedia)}, title = ${post.title ?? null},
        destination_url = ${post.destinationUrl ?? null}, scheduled_at = ${post.scheduledAt ?? null},
        source_thread_id = ${post.sourceThreadId ?? null}, approval = ${post.approval === null ? null : writeApproval(post.approval)},
        publish_results = ${writeResults(post.publishResults)}, change_request = ${post.changeRequest ?? null},
        updated_at = ${post.updatedAt}
      WHERE id = ${post.id}
    `;

  const savePost: CampaignStore["Service"]["savePost"] = (actor, input) =>
    write(
      Effect.gen(function* () {
        const at = yield* now;
        yield* getCampaign(input.campaignId);

        for (const path of input.mediaPaths) {
          if (!isRelativeInside(path)) {
            return yield* fail("invalid", `"${path}" is not a path inside the project folder.`);
          }
        }
        for (const url of input.mediaUrls) {
          if (!isWebUrl(url)) return yield* fail("invalid", `"${url}" is not a web address.`);
        }
        if (
          input.destinationUrl !== undefined &&
          input.destinationUrl !== null &&
          input.destinationUrl.trim() !== "" &&
          !isWebUrl(input.destinationUrl)
        ) {
          return yield* fail("invalid", "The destination link is not a web address.");
        }
        let scheduledAt: string | null | undefined;
        if (input.scheduledAt !== undefined && input.scheduledAt !== null) {
          scheduledAt = toIso(input.scheduledAt);
          if (scheduledAt === null)
            return yield* fail("invalid", "The proposed time is not a valid date and time.");
        } else {
          scheduledAt = input.scheduledAt;
        }

        const existingRow = input.id === undefined ? undefined : (yield* selectPost(input.id))[0];
        if (input.id !== undefined && existingRow === undefined) return yield* notFound("post");
        const existing =
          existingRow === undefined ? undefined : yield* parsed(() => postFromRow(existingRow));
        if (existing !== undefined && existing.campaignId !== input.campaignId) {
          return yield* fail("invalid", "A post cannot move to another campaign.");
        }
        const status =
          existing === undefined ? "draft" : statusAfterEdit(existing.status, actor.kind);
        if (status === null) {
          return yield* fail(
            "not_allowed",
            actor.kind === "agent"
              ? "This post has already been approved or sent. Only a person can change it now."
              : "This post is being published or has been posted, so it can no longer be edited.",
          );
        }

        const platforms = [...new Set(input.platforms)];
        const byPlatform = Object.fromEntries(
          Object.entries(input.captions.byPlatform).filter(([platform]) =>
            KNOWN_PLATFORMS.has(platform),
          ),
        );
        const title = input.title === undefined ? existing?.title : (input.title ?? undefined);
        const destinationUrl =
          input.destinationUrl === undefined
            ? existing?.destinationUrl
            : (input.destinationUrl ?? undefined);
        const schedule =
          scheduledAt === undefined ? existing?.scheduledAt : (scheduledAt ?? undefined);
        const sourceThreadId =
          input.sourceThreadId ??
          existing?.sourceThreadId ??
          (actor.kind === "agent" ? actor.threadId : undefined);

        const base = {
          id: existing?.id ?? newId("post"),
          campaignId: input.campaignId,
          status,
          platforms,
          captions: { default: input.captions.default, byPlatform },
          mediaPaths: input.mediaPaths,
          mediaUrls: input.mediaUrls,
          // An upload belongs to the file it was made from; a file taken off the post loses its entry.
          uploadedMedia: Object.fromEntries(
            Object.entries(existing?.uploadedMedia ?? {}).filter(([path]) =>
              input.mediaPaths.includes(path),
            ),
          ),
          createdBy: existing?.createdBy ?? actor,
          // An edit drops any approval, and the results of a failed attempt belong to the old text.
          approval: null,
          publishResults: existing?.status === "failed" ? {} : (existing?.publishResults ?? {}),
          createdAt: existing?.createdAt ?? at,
          updatedAt: at,
        } satisfies CampaignPost;
        const post: CampaignPost = {
          ...base,
          ...(title === undefined || title === "" ? {} : { title }),
          ...(destinationUrl === undefined || destinationUrl === "" ? {} : { destinationUrl }),
          ...(schedule === undefined ? {} : { scheduledAt: schedule }),
          ...(sourceThreadId === undefined ? {} : { sourceThreadId }),
          ...(existing?.changeRequest === undefined
            ? {}
            : { changeRequest: existing.changeRequest }),
        };
        if (existing === undefined) {
          yield* sql`
            INSERT INTO workbench_campaign_posts
              (id, campaign_id, status, platforms, captions, media_paths, media_urls, created_by, publish_results, created_at, updated_at)
            VALUES
              (${post.id}, ${post.campaignId}, ${post.status}, '[]', '{}', '[]', '[]', ${writeCreatedBy(post.createdBy)}, '{}', ${at}, ${at})
          `;
        }
        yield* storePost(post);
        return post;
      }),
    );

  const deletePost: CampaignStore["Service"]["deletePost"] = (id) =>
    write(
      Effect.gen(function* () {
        const post = yield* getPost(id);
        if (post.status === "publishing") {
          return yield* fail("conflict", "This post is being published right now.");
        }
        yield* sql`DELETE FROM workbench_campaign_posts WHERE id = ${id}`;
      }),
    );

  /** Moves a post to a status the rules allow, or says why not. */
  const moveTo = (
    post: CampaignPost,
    to: CampaignPostStatus,
    actor: "person" | "agent" | "system",
    refusal: string,
  ) =>
    canTransition(post.status, to, actor) ? Effect.void : Effect.fail(fail("not_allowed", refusal));

  const contentIssues = (post: CampaignPost, client: CampaignClient) =>
    validateCampaignPost(post, { doNotSay: client.doNotSay });
  const invalid = (issues: ReadonlyArray<string>) =>
    fail("invalid", `This post is not ready: ${issues.join(" ")}`);

  const submitPost: CampaignStore["Service"]["submitPost"] = (actor, id) =>
    write(
      Effect.gen(function* () {
        const at = yield* now;
        const post = yield* getPost(id);
        yield* moveTo(post, "needs-approval", actor.kind, "Only a draft can be submitted.");
        const { client, campaign } = yield* contextOf(post);
        const issues = contentIssues(post, client);
        if (issues.length > 0) return yield* invalid(issues);
        // The mode says how far an agent's finished post may go without a person. A person who
        // submits has not approved anything: approving is a separate, administrator-only step.
        const mode = actor.kind === "agent" ? effectiveMode(client, campaign) : "ask-first";
        const outcome = nextStatusAfterSubmit(mode, {
          scheduledAt: post.scheduledAt,
          now: at,
        });
        const { changeRequest: _answered, ...rest } = post;
        const next: CampaignPost = {
          ...rest,
          status: outcome.status,
          approval: outcome.approval,
          updatedAt: at,
        };
        yield* storePost(next);
        return next;
      }),
    );

  /** The shared shape of every person decision that approves a post. */
  const approveAs = (
    id: string,
    scheduledAt: string | null | undefined,
    immediate: boolean,
    from: ReadonlyArray<CampaignPostStatus>,
  ) =>
    write(
      Effect.gen(function* () {
        const at = yield* now;
        const post = yield* getPost(id);
        if (!from.includes(post.status)) {
          return yield* fail("not_allowed", "This post cannot be approved from where it is.");
        }
        const proposed =
          immediate || scheduledAt === null
            ? undefined
            : scheduledAt === undefined
              ? post.scheduledAt
              : (toIso(scheduledAt) ?? undefined);
        if (
          !immediate &&
          scheduledAt !== undefined &&
          scheduledAt !== null &&
          proposed === undefined
        ) {
          return yield* fail("invalid", "The time is not a valid date and time.");
        }
        const status = immediate
          ? "approved"
          : statusAfterPersonApproval({ scheduledAt: proposed, now: at });
        yield* moveTo(post, status, "person", "This post cannot be approved from where it is.");
        const { client } = yield* contextOf(post);
        const issues = contentIssues(
          { ...post, ...(proposed === undefined ? {} : { scheduledAt: proposed }) },
          client,
        );
        if (issues.length > 0) return yield* invalid(issues);
        const { changeRequest: _answered, scheduledAt: _old, ...rest } = post;
        const next: CampaignPost = {
          ...rest,
          ...(proposed === undefined ? {} : { scheduledAt: proposed }),
          status,
          approval: { by: "person", at },
          updatedAt: at,
        };
        yield* storePost(next);
        return next;
      }),
    );

  const approvePost: CampaignStore["Service"]["approvePost"] = (input) =>
    approveAs(input.postId, input.scheduledAt, false, [
      "draft",
      "needs-approval",
      "approved",
      "scheduled",
    ]);

  const publishNow: CampaignStore["Service"]["publishNow"] = (id) =>
    approveAs(id, null, true, ["draft", "needs-approval", "approved", "scheduled"]);

  const retryPost: CampaignStore["Service"]["retryPost"] = (id) =>
    write(
      Effect.gen(function* () {
        const at = yield* now;
        const post = yield* getPost(id);
        if (post.status !== "failed") {
          return yield* fail("not_allowed", "Only a post that failed can be retried.");
        }
        yield* moveTo(post, "approved", "person", "This post cannot be retried.");
        const { scheduledAt: _old, ...rest } = post;
        const next: CampaignPost = {
          ...rest,
          status: "approved",
          approval: { by: "person", at },
          updatedAt: at,
        };
        yield* storePost(next);
        return next;
      }),
    );

  const requestChanges: CampaignStore["Service"]["requestChanges"] = (input) =>
    Effect.gen(function* () {
      const next = yield* write(
        Effect.gen(function* () {
          const at = yield* now;
          const post = yield* getPost(input.postId);
          // A rejected post is reopened by editing it; asking an agent for changes is for live ones.
          if (post.status === "draft" || post.status === "rejected") {
            return yield* fail("not_allowed", "This post cannot be sent back for changes.");
          }
          yield* moveTo(post, "draft", "person", "This post cannot be sent back for changes.");
          const next: CampaignPost = {
            ...post,
            status: "draft",
            approval: null,
            changeRequest: input.text,
            updatedAt: at,
          };
          yield* storePost(next);
          return next;
        }),
      );
      if (next.sourceThreadId !== undefined) {
        yield* notifier.tell({
          threadId: next.sourceThreadId as ThreadId,
          key: `changes:${next.id}:${next.updatedAt}`,
          text: `A person asked for changes to your campaign post ${next.id}:\n\n${input.text}\n\nRead it with campaign_post_read, fix it with campaign_post_save, then send it back with campaign_post_submit.`,
        });
      }
      return next;
    });

  const rejectPost: CampaignStore["Service"]["rejectPost"] = (id) =>
    write(
      Effect.gen(function* () {
        const at = yield* now;
        const post = yield* getPost(id);
        yield* moveTo(post, "rejected", "person", "This post cannot be rejected from where it is.");
        const next: CampaignPost = { ...post, status: "rejected", approval: null, updatedAt: at };
        yield* storePost(next);
        return next;
      }),
    );

  const listDue: CampaignStore["Service"]["listDue"] = (at) =>
    Effect.gen(function* () {
      const rows = yield* db(
        sql<PostRow>`SELECT * FROM workbench_campaign_posts WHERE status IN ('approved', 'scheduled') ORDER BY COALESCE(scheduled_at, created_at), id`,
      );
      return duePosts(yield* parsed(() => rows.map(postFromRow)), at);
    });

  const beginPublishing: CampaignStore["Service"]["beginPublishing"] = (id) =>
    write(
      Effect.gen(function* () {
        const at = yield* now;
        const claimed = yield* sql<{ readonly id: string }>`
          UPDATE workbench_campaign_posts SET status = 'publishing', updated_at = ${at}
          WHERE id = ${id} AND status IN ('approved', 'scheduled')
          RETURNING id
        `;
        return claimed.length > 0;
      }),
    );

  const recordUploadedMedia: CampaignStore["Service"]["recordUploadedMedia"] = (input) =>
    write(
      Effect.gen(function* () {
        const at = yield* now;
        const post = yield* getPost(input.postId);
        const urls = [...post.mediaUrls];
        for (const url of Object.values(input.uploaded)) {
          if (!urls.includes(url)) urls.push(url);
        }
        const next: CampaignPost = {
          ...post,
          mediaUrls: urls,
          uploadedMedia: { ...post.uploadedMedia, ...input.uploaded },
          updatedAt: at,
        };
        yield* storePost(next);
        return next;
      }),
    );

  const dropUploadedMedia: CampaignStore["Service"]["dropUploadedMedia"] = (input) =>
    write(
      Effect.gen(function* () {
        const at = yield* now;
        const post = yield* getPost(input.postId);
        const dropped = Object.values(post.uploadedMedia).filter(input.matches);
        if (dropped.length === 0 && !post.mediaUrls.some(input.matches)) return post;
        const next: CampaignPost = {
          ...post,
          mediaUrls: post.mediaUrls.filter((url) => !input.matches(url)),
          uploadedMedia: Object.fromEntries(
            Object.entries(post.uploadedMedia).filter(([, url]) => !input.matches(url)),
          ),
          updatedAt: at,
        };
        yield* storePost(next);
        return next;
      }),
    );

  const logRow = (input: {
    readonly postId: string;
    readonly platform: CampaignPlatform;
    readonly mode: CampaignApprovalMode;
    readonly approvedBy: string;
    readonly result: Omit<CampaignPublishResult, "at">;
    readonly at: string;
  }) => sql`
    INSERT INTO workbench_campaign_publish_log (post_id, platform, mode, approved_by, result, link, error, at)
    VALUES (${input.postId}, ${input.platform}, ${input.mode}, ${input.approvedBy},
            ${input.result.success ? "success" : "failure"}, ${input.result.link ?? null}, ${input.result.error ?? null}, ${input.at})
  `;

  const recordPublishResult: CampaignStore["Service"]["recordPublishResult"] = (input) =>
    write(
      Effect.gen(function* () {
        const at = yield* now;
        const post = yield* getPost(input.postId);
        if (post.status !== "publishing") {
          return yield* fail("conflict", "This post is not being published.");
        }
        const { client, campaign } = yield* contextOf(post);
        const result: CampaignPublishResult = { ...input.result, at };
        const next: CampaignPost = {
          ...post,
          publishResults: { ...post.publishResults, [input.platform]: result },
          updatedAt: at,
        };
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* storePost(next);
            yield* logRow({
              postId: post.id,
              platform: input.platform,
              mode: effectiveMode(client, campaign),
              approvedBy: approvedByLabel(post.approval),
              result: input.result,
              at,
            });
          }),
        );
        return next;
      }),
    );

  const finishPublishing: CampaignStore["Service"]["finishPublishing"] = (id) =>
    write(
      Effect.gen(function* () {
        const at = yield* now;
        const post = yield* getPost(id);
        const succeeded = post.platforms.every(
          (platform) => post.publishResults[platform]?.success === true,
        );
        const status = succeeded ? "posted" : "failed";
        yield* moveTo(post, status, "system", "This post is not being published.");
        const next: CampaignPost = { ...post, status, updatedAt: at };
        yield* storePost(next);
        return next;
      }),
    );

  const recoverInterrupted: CampaignStore["Service"]["recoverInterrupted"] = write(
    Effect.gen(function* () {
      const at = yield* now;
      const rows =
        yield* sql<PostRow>`SELECT * FROM workbench_campaign_posts WHERE status = 'publishing'`;
      const recovered: CampaignPost[] = [];
      for (const row of rows) {
        const post = yield* parsed(() => postFromRow(row));
        const context = yield* contextOf(post).pipe(Effect.option);
        const results: Record<string, CampaignPublishResult> = { ...post.publishResults };
        yield* sql.withTransaction(
          Effect.gen(function* () {
            for (const platform of post.platforms) {
              if (results[platform] !== undefined) continue;
              results[platform] = { success: false, error: INTERRUPTED_BY_RESTART, at };
              yield* logRow({
                postId: post.id,
                platform,
                mode:
                  context._tag === "Some"
                    ? effectiveMode(context.value.client, context.value.campaign)
                    : DEFAULT_CAMPAIGN_APPROVAL_MODE,
                approvedBy: approvedByLabel(post.approval),
                result: { success: false, error: INTERRUPTED_BY_RESTART },
                at,
              });
            }
            // Every platform that did finish succeeded only if all did; the rest is a failure.
            const next: CampaignPost = {
              ...post,
              status: "failed",
              publishResults: results,
              updatedAt: at,
            };
            yield* storePost(next);
            recovered.push(next);
          }),
        );
      }
      return recovered;
    }),
  );

  const listPostsWithLog: CampaignStore["Service"]["listPostsWithLog"] = (campaignId) =>
    Effect.gen(function* () {
      const posts = yield* listPosts(campaignId);
      const rows = yield* db(
        sql<LogRow>`
          SELECT * FROM workbench_campaign_publish_log
          WHERE post_id IN (SELECT id FROM workbench_campaign_posts WHERE campaign_id = ${campaignId})
          ORDER BY id`,
      );
      return { posts, log: rows.map(logFromRow) };
    });

  const publishLog: CampaignStore["Service"]["publishLog"] = (postId) =>
    Effect.gen(function* () {
      const rows = yield* db(
        sql<LogRow>`SELECT * FROM workbench_campaign_publish_log WHERE post_id = ${postId} ORDER BY id`,
      );
      return rows.map(logFromRow);
    });

  const subscribeChanges: CampaignStore["Service"]["subscribeChanges"] = Stream.unwrap(
    Effect.gen(function* () {
      // Subscribe before the first reading so a change landing between the two is not missed.
      const subscription = yield* PubSub.subscribe(changes);
      return Stream.concat(
        Stream.fromEffect(Ref.get(revision)),
        Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => Ref.get(revision))),
      );
    }),
  );

  return CampaignStore.of({
    listClients,
    getClient,
    upsertClient,
    deleteClient,
    listCampaigns,
    getCampaign,
    upsertCampaign,
    deleteCampaign,
    listPosts,
    getPost,
    listPostsWithLog,
    touch: notifyChanged,
    contextOf,
    savePost,
    deletePost,
    submitPost,
    approvePost,
    requestChanges,
    rejectPost,
    publishNow,
    retryPost,
    listDue,
    beginPublishing,
    recordUploadedMedia,
    dropUploadedMedia,
    recordPublishResult,
    finishPublishing,
    recoverInterrupted,
    publishLog,
    subscribeChanges,
  });
});

export const layer = Layer.effect(CampaignStore, make);
