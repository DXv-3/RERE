import * as NodeCrypto from "node:crypto";
import {
  CampaignError,
  type StudioBudget,
  CampaignGenerationJob,
  CampaignGenerationOptions,
  CampaignPostCreatedBy,
  type CampaignGenerationStatus,
} from "@t3tools/contracts";
import { checkGenerationSpend } from "@t3tools/shared/campaignRules";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as CampaignStore from "../CampaignStore.ts";

interface JobRow {
  readonly id: string;
  readonly client_id: string;
  readonly campaign_id: string | null;
  readonly kind: string;
  readonly connector: string;
  readonly model: string;
  readonly prompt: string;
  readonly options: string;
  readonly status: string;
  readonly provider_job_id: string | null;
  readonly estimated_usd: number | null;
  readonly estimate_note: string;
  readonly reserved_usd: number | null;
  readonly allowance_usd: number | null;
  readonly request_key: string | null;
  readonly request_fingerprint: string | null;
  readonly submission_state: "not-submitted" | "submitted" | "uncertain";
  readonly result_paths: string;
  readonly error: string | null;
  readonly waiting_note: string | null;
  readonly waiting_since: string | null;
  readonly requested_by: string;
  readonly source_thread_id: string | null;
  readonly started_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/** A job as the loop sees it: the wire shape plus what only the server needs. */
export interface StoredGenerationJob {
  readonly job: CampaignGenerationJob;
  readonly providerJobId: string | null;
  readonly started: boolean;
  readonly requestFingerprint: string | null;
  /** When the job first had to wait for room or its night window; null if it never has. */
  readonly waitingSince: string | null;
}

const OptionsJson = Schema.fromJsonString(CampaignGenerationOptions);
const PathsJson = Schema.fromJsonString(Schema.Array(Schema.String));
const RequestedByJson = Schema.fromJsonString(CampaignPostCreatedBy);
const decodeJob = Schema.decodeUnknownSync(CampaignGenerationJob);
const readOptions = Schema.decodeUnknownSync(OptionsJson);
const readPaths = Schema.decodeUnknownSync(PathsJson);
const readRequestedBy = Schema.decodeUnknownSync(RequestedByJson);
const writeOptions = Schema.encodeSync(OptionsJson);
const writePaths = Schema.encodeSync(PathsJson);
const writeRequestedBy = Schema.encodeSync(RequestedByJson);

const fromRow = (row: JobRow): StoredGenerationJob => ({
  job: decodeJob({
    id: row.id,
    clientId: row.client_id,
    ...(row.campaign_id === null ? {} : { campaignId: row.campaign_id }),
    kind: row.kind,
    connector: row.connector,
    model: row.model,
    prompt: row.prompt,
    options: readOptions(row.options),
    status: row.status,
    estimatedUsd: row.estimated_usd,
    estimateNote: row.estimate_note,
    ...(row.reserved_usd === null ? {} : { reservedUsd: row.reserved_usd }),
    ...(row.allowance_usd === null ? {} : { allowanceUsd: row.allowance_usd }),
    ...(row.request_key === null ? {} : { requestKey: row.request_key }),
    submissionState: row.submission_state,
    resultPaths: readPaths(row.result_paths),
    ...(row.error === null ? {} : { error: row.error }),
    ...(row.status !== "queued" || row.waiting_note === null
      ? {}
      : { waitingNote: row.waiting_note }),
    requestedBy: readRequestedBy(row.requested_by),
    ...(row.source_thread_id === null ? {} : { sourceThreadId: row.source_thread_id }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }),
  providerJobId: row.provider_job_id,
  started: row.started_at !== null,
  requestFingerprint: row.request_fingerprint,
  waitingSince: row.waiting_since,
});

const isCampaignError = Schema.is(CampaignError);
const storage = (cause: unknown) =>
  isCampaignError(cause)
    ? cause
    : new CampaignError({
        reason: "storage",
        message: "The generation jobs could not be read or saved.",
      });

export interface NewGenerationJob {
  readonly clientId: string;
  readonly campaignId?: string | undefined;
  readonly kind: CampaignGenerationJob["kind"];
  readonly connector: CampaignGenerationJob["connector"];
  readonly model: string;
  readonly prompt: string;
  readonly options: CampaignGenerationOptions;
  readonly status: "queued" | "needs-approval";
  readonly estimatedUsd: number | null;
  readonly reservedUsd?: number;
  readonly allowanceUsd?: number | undefined;
  readonly requestKey?: string | undefined;
  readonly requestFingerprint?: string | undefined;
  readonly estimateNote: string;
  readonly requestedBy: CampaignGenerationJob["requestedBy"];
  readonly sourceThreadId?: string | undefined;
}

export interface ExternalExpenseInput {
  readonly clientId: string;
  readonly campaignId?: string | undefined;
  readonly requestKey: string;
  readonly allowanceUsd: number;
  readonly label: string;
}
export interface ExternalExpenseReservation {
  readonly id: string;
  readonly created: boolean;
  readonly allowanceUsd: number;
}

/**
 * The generation jobs table. Every transition is a compare-and-set on the status, so a person's
 * cancel, the loop's claim and a restart's recovery cannot overwrite one another.
 */
export class GenerationStore extends Context.Service<
  GenerationStore,
  {
    readonly create: (
      input: NewGenerationJob,
    ) => Effect.Effect<CampaignGenerationJob, CampaignError>;
    readonly findRequest: (
      key: string,
    ) => Effect.Effect<StoredGenerationJob | undefined, CampaignError>;
    readonly campaignBudget: (campaignId: string) => Effect.Effect<StudioBudget, CampaignError>;
    readonly usedUsd: (clientId: string) => Effect.Effect<number, CampaignError>;
    readonly reserveExternalExpense: (
      input: ExternalExpenseInput,
    ) => Effect.Effect<ExternalExpenseReservation, CampaignError>;
    readonly markUncertain: (id: string, reason: string) => Effect.Effect<void, CampaignError>;
    readonly get: (id: string) => Effect.Effect<StoredGenerationJob, CampaignError>;
    /** Newest first. */
    readonly listRecent: (input: {
      readonly clientId?: string | undefined;
      readonly limit: number;
    }) => Effect.Effect<ReadonlyArray<CampaignGenerationJob>, CampaignError>;
    readonly byStatus: (
      status: CampaignGenerationStatus,
    ) => Effect.Effect<ReadonlyArray<StoredGenerationJob>, CampaignError>;
    /** Moves a queued job to running. False when it is no longer queued. */
    readonly claim: (id: string) => Effect.Effect<boolean, CampaignError>;
    /**
     * Puts a queued or running job back in line with the reason it is waiting. False when it
     * is neither (a person cancelled it meanwhile).
     */
    readonly hold: (id: string, note: string) => Effect.Effect<boolean, CampaignError>;
    /** Moves a waiting job to queued. False when it was not waiting. */
    readonly approve: (id: string) => Effect.Effect<boolean, CampaignError>;
    readonly setProviderJobId: (
      id: string,
      providerJobId: string,
    ) => Effect.Effect<void, CampaignError>;
    /** Ends a running job. False when it was cancelled meanwhile; the result is then dropped. */
    readonly finish: (
      id: string,
      outcome:
        | { readonly status: "done"; readonly resultPaths: ReadonlyArray<string> }
        | { readonly status: "failed"; readonly error: string },
    ) => Effect.Effect<boolean, CampaignError>;
    /** Cancels a job that has not finished. False when it already had. */
    readonly cancel: (id: string) => Effect.Effect<boolean, CampaignError>;
  }
>()("t3/campaigns/generation/GenerationStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const campaigns = yield* CampaignStore.CampaignStore;
  const lock = yield* Semaphore.make(1);

  const db = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.mapError(storage));
  const now = Effect.map(Clock.currentTimeMillis, (ms) =>
    DateTime.formatIso(DateTime.makeUnsafe(ms)),
  );
  /** Runs one write under the lock and tells the board something changed. */
  const write = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    lock.withPermit(effect).pipe(Effect.tap(() => campaigns.touch));

  const select = (id: string) =>
    db(sql<JobRow>`SELECT * FROM workbench_campaign_generation_jobs WHERE id = ${id}`);

  const get: GenerationStore["Service"]["get"] = (id) =>
    Effect.gen(function* () {
      const row = (yield* select(id))[0];
      if (row === undefined) {
        return yield* new CampaignError({
          reason: "not_found",
          message: "That generation job was not found.",
        });
      }
      return yield* Effect.try({ try: () => fromRow(row), catch: storage });
    });

  const insert = (id: string, job: NewGenerationJob, at: string) =>
    db(sql`
      INSERT INTO workbench_campaign_generation_jobs (
        id, client_id, campaign_id, kind, connector, model, prompt, options, status,
        provider_job_id, estimated_usd, estimate_note, result_paths, error, requested_by,
        source_thread_id, started_at, created_at, updated_at, reserved_usd, allowance_usd, request_key, request_fingerprint
      ) VALUES (
        ${id}, ${job.clientId}, ${job.campaignId ?? null}, ${job.kind}, ${job.connector},
        ${job.model}, ${job.prompt}, ${writeOptions(job.options)}, ${job.status},
        NULL, ${job.estimatedUsd}, ${job.estimateNote}, '[]', NULL,
        ${writeRequestedBy(job.requestedBy)}, ${job.sourceThreadId ?? null},
        NULL, ${at}, ${at}, ${job.reservedUsd ?? job.estimatedUsd}, ${job.allowanceUsd ?? null}, ${job.requestKey ?? null}, ${job.requestFingerprint ?? null}
      )
    `);

  const findRequest: GenerationStore["Service"]["findRequest"] = (key) =>
    Effect.gen(function* () {
      const rows = yield* db(
        sql<JobRow>`SELECT * FROM workbench_campaign_generation_jobs WHERE request_key = ${key}`,
      );
      return rows[0] === undefined ? undefined : fromRow(rows[0]);
    });

  // Pending work keeps its reservation across month boundaries. Once submitted, even a failed
  // request can have been charged, so its reservation is never silently refunded.
  const usedUsd: GenerationStore["Service"]["usedUsd"] = (clientId) =>
    Effect.gen(function* () {
      const since = `${(yield* now).slice(0, 7)}-01T00:00:00.000Z`;
      const rows = yield* db(sql<{ total: number }>`
      SELECT COALESCE(SUM(amount), 0) AS total FROM (
        SELECT COALESCE(reserved_usd, estimated_usd, 0) AS amount
        FROM workbench_campaign_generation_jobs WHERE client_id = ${clientId}
          AND (status IN ('needs-approval', 'queued', 'running')
            OR (created_at >= ${since} AND (started_at IS NOT NULL OR status = 'done')))
        UNION ALL SELECT allowance_usd AS amount FROM workbench_campaign_external_expenses
          WHERE client_id = ${clientId} AND created_at >= ${since}
      )`);
      return rows[0]?.total ?? 0;
    });

  // Use the same all-time campaign reservation predicate as enforcement, never the paged UI jobs.
  const campaignBudget: GenerationStore["Service"]["campaignBudget"] = (campaignId) =>
    Effect.gen(function* () {
      yield* campaigns.getCampaign(campaignId);
      const rows = yield* db(sql<{ reserved: number; unreported: number; unresolved: number }>`
        SELECT COALESCE(SUM(amount), 0) AS reserved, COALESCE(SUM(unreported), 0) AS unreported,
          COALESCE(SUM(unresolved), 0) AS unresolved FROM (
          SELECT COALESCE(reserved_usd, estimated_usd, 0) AS amount,
            CASE WHEN started_at IS NOT NULL OR status = 'done' THEN 1 ELSE 0 END AS unreported,
            CASE WHEN submission_state = 'uncertain' THEN 1 ELSE 0 END AS unresolved
          FROM workbench_campaign_generation_jobs
          WHERE campaign_id = ${campaignId}
            AND (status IN ('needs-approval', 'queued', 'running', 'done') OR started_at IS NOT NULL)
          UNION ALL SELECT allowance_usd AS amount, 1 AS unreported,
            CASE WHEN EXISTS (
              SELECT 1 FROM workbench_content_studios s, json_each(s.document, '$.narrations') n
              WHERE s.campaign_id = ${campaignId}
                AND json_extract(n.value, '$.expenseId') = e.id
                AND json_extract(n.value, '$.status') = 'completed'
            ) THEN 0 ELSE 1 END AS unresolved
          FROM workbench_campaign_external_expenses e WHERE campaign_id = ${campaignId}
        )`);
      const budget =
        (yield* db(sql<{ budget: number | null }>`
        SELECT json_extract(document, '$.brief.budgetUsd') AS budget
        FROM workbench_content_studios WHERE campaign_id = ${campaignId}`))[0]?.budget ?? null;
      const totals = rows[0];
      const reservedUsd = totals?.reserved ?? 0;
      return {
        budgetUsd: budget,
        reservedUsd,
        availableUsd: budget === null ? null : Math.max(0, budget - reservedUsd),
        // Connectors currently return no provider billing evidence. Allowances and estimates are
        // deliberately excluded; null is different from an evidenced zero-dollar charge.
        confirmedUsd: null,
        unreportedCount: totals?.unreported ?? 0,
        unresolvedSubmissions: totals?.unresolved ?? 0,
      };
    });

  const checkCap = (clientId: string, amount: number, campaignId?: string) =>
    Effect.gen(function* () {
      const client = yield* campaigns.getClient(clientId);
      const decision = checkGenerationSpend({
        clientName: client.name,
        capUsd: client.monthlySpendCapUsd,
        usedUsd: yield* usedUsd(clientId),
        estimatedUsd: amount,
      });
      if (!decision.ok)
        return yield* new CampaignError({ reason: "not_allowed", message: decision.message });
      if (campaignId === undefined) return;
      const budget = (yield* db(sql<{
        budget: number | null;
      }>`SELECT json_extract(document, '$.brief.budgetUsd') AS budget
        FROM workbench_content_studios WHERE campaign_id = ${campaignId}`))[0]?.budget;
      if (budget === undefined || budget === null) return;
      if (typeof budget !== "number" || !Number.isFinite(budget) || budget < 0) {
        return yield* new CampaignError({
          reason: "storage",
          message: "The campaign budget is invalid.",
        });
      }
      const rows = yield* db(sql<{ total: number }>`SELECT COALESCE(SUM(amount), 0) AS total FROM (
        SELECT COALESCE(reserved_usd, estimated_usd, 0) AS amount FROM workbench_campaign_generation_jobs
          WHERE campaign_id = ${campaignId} AND (status IN ('needs-approval', 'queued', 'running', 'done') OR started_at IS NOT NULL)
        UNION ALL SELECT allowance_usd AS amount FROM workbench_campaign_external_expenses WHERE campaign_id = ${campaignId}
      )`);
      const used = rows[0]?.total ?? 0;
      if (used + amount > budget + 1e-9)
        return yield* new CampaignError({
          reason: "not_allowed",
          message: `This would pass the campaign's approved budget of $${budget.toFixed(2)} ($${used.toFixed(2)} reserved).`,
        });
    });

  const create: GenerationStore["Service"]["create"] = (input) =>
    write(
      db(
        sql.withTransaction(
          Effect.gen(function* () {
            if (input.requestKey !== undefined) {
              const existing = yield* findRequest(input.requestKey);
              if (existing !== undefined) {
                if (existing.requestFingerprint !== input.requestFingerprint) {
                  return yield* new CampaignError({
                    reason: "conflict",
                    message: "This request key already belongs to a different generation request.",
                  });
                }
                return existing.job;
              }
            }
            const amount = input.reservedUsd ?? input.estimatedUsd;
            if (
              amount === null ||
              !Number.isFinite(amount) ||
              amount < 0 ||
              (input.estimatedUsd === null && (amount <= 0 || input.allowanceUsd !== amount))
            ) {
              return yield* new CampaignError({
                reason: "invalid",
                message: "Unknown generation cost requires an explicit positive allowance.",
              });
            }
            yield* checkCap(input.clientId, amount, input.campaignId);
            const at = yield* now;
            const id = `gen_${NodeCrypto.randomUUID()}`;
            yield* insert(id, input, at);
            return (yield* get(id)).job;
          }),
        ),
      ),
    );

  const reserveExternalExpense: GenerationStore["Service"]["reserveExternalExpense"] = (input) =>
    write(
      db(
        sql.withTransaction(
          Effect.gen(function* () {
            if (
              !Number.isFinite(input.allowanceUsd) ||
              input.allowanceUsd <= 0 ||
              !input.requestKey.trim() ||
              input.requestKey.length > 200 ||
              !input.label.trim()
            ) {
              return yield* new CampaignError({
                reason: "invalid",
                message:
                  "An external expense needs a request key, label and positive dollar allowance.",
              });
            }
            const existing = (yield* sql<{
              id: string;
              client_id: string;
              campaign_id: string | null;
              allowance_usd: number;
              label: string;
            }>`
        SELECT * FROM workbench_campaign_external_expenses WHERE request_key = ${input.requestKey}`)[0];
            if (existing !== undefined) {
              if (
                existing.client_id !== input.clientId ||
                existing.campaign_id !== (input.campaignId ?? null) ||
                existing.allowance_usd !== input.allowanceUsd ||
                existing.label !== input.label
              ) {
                return yield* new CampaignError({
                  reason: "conflict",
                  message: "This expense key already belongs to a different request.",
                });
              }
              return { id: existing.id, created: false, allowanceUsd: existing.allowance_usd };
            }
            if (
              input.campaignId !== undefined &&
              (yield* campaigns.getCampaign(input.campaignId)).clientId !== input.clientId
            ) {
              return yield* new CampaignError({
                reason: "invalid",
                message: "That campaign belongs to a different client.",
              });
            }
            yield* checkCap(input.clientId, input.allowanceUsd, input.campaignId);
            const id = `expense_${NodeCrypto.randomUUID()}`;
            const at = yield* now;
            yield* sql`INSERT INTO workbench_campaign_external_expenses (id, client_id, campaign_id, request_key, allowance_usd, label, created_at)
        VALUES (${id}, ${input.clientId}, ${input.campaignId ?? null}, ${input.requestKey}, ${input.allowanceUsd}, ${input.label}, ${at})`;
            return { id, created: true, allowanceUsd: input.allowanceUsd };
          }),
        ),
      ),
    );

  const listRecent: GenerationStore["Service"]["listRecent"] = ({ clientId, limit }) =>
    Effect.gen(function* () {
      const rows = yield* db(
        clientId === undefined
          ? sql<JobRow>`SELECT * FROM workbench_campaign_generation_jobs ORDER BY created_at DESC, id DESC LIMIT ${limit}`
          : sql<JobRow>`SELECT * FROM workbench_campaign_generation_jobs WHERE client_id = ${clientId} ORDER BY created_at DESC, id DESC LIMIT ${limit}`,
      );
      return yield* Effect.try({ try: () => rows.map((row) => fromRow(row).job), catch: storage });
    });

  const byStatus: GenerationStore["Service"]["byStatus"] = (status) =>
    Effect.gen(function* () {
      const rows = yield* db(
        sql<JobRow>`SELECT * FROM workbench_campaign_generation_jobs WHERE status = ${status} ORDER BY created_at, id`,
      );
      return yield* Effect.try({ try: () => rows.map(fromRow), catch: storage });
    });

  /** Moves `id` from one of `from` to `to`. Returns whether a row moved. */
  const move = (
    id: string,
    from: ReadonlyArray<string>,
    to: string,
    extra: { readonly started?: boolean } = {},
  ) =>
    write(
      Effect.gen(function* () {
        const at = yield* now;
        const moved = yield* db(sql<{ readonly id: string }>`
          UPDATE workbench_campaign_generation_jobs
          SET status = ${to}, updated_at = ${at}, started_at = COALESCE(started_at, ${extra.started === true ? at : null})
          WHERE id = ${id} AND status IN ${sql.in(from)}
            AND (${to} != 'running' OR reserved_usd IS NOT NULL)
          RETURNING id
        `);
        return moved.length > 0;
      }),
    );

  const hold: GenerationStore["Service"]["hold"] = (id, note) =>
    write(
      Effect.gen(function* () {
        const at = yield* now;
        const moved = yield* db(sql<{ readonly id: string }>`
          UPDATE workbench_campaign_generation_jobs
          SET status = 'queued', updated_at = ${at}, waiting_note = ${note},
              waiting_since = COALESCE(waiting_since, ${at})
          WHERE id = ${id} AND status IN ('queued', 'running')
          RETURNING id
        `);
        return moved.length > 0;
      }),
    );

  const finish: GenerationStore["Service"]["finish"] = (id, outcome) =>
    write(
      Effect.gen(function* () {
        const at = yield* now;
        const moved = yield* db(sql<{ readonly id: string }>`
          UPDATE workbench_campaign_generation_jobs
          SET status = ${outcome.status}, updated_at = ${at},
              result_paths = ${outcome.status === "done" ? writePaths(outcome.resultPaths) : "[]"},
              error = ${outcome.status === "failed" ? outcome.error : null}
          WHERE id = ${id} AND status = 'running'
          RETURNING id
        `);
        return moved.length > 0;
      }),
    );

  return GenerationStore.of({
    create,
    findRequest,
    usedUsd,
    campaignBudget,
    reserveExternalExpense,
    markUncertain: (id, reason) =>
      write(
        db(sql`UPDATE workbench_campaign_generation_jobs
      SET submission_state = 'uncertain', error = ${reason} WHERE id = ${id} AND status = 'running'`),
      ).pipe(Effect.asVoid),
    get,
    listRecent,
    byStatus,
    claim: (id) => move(id, ["queued"], "running", { started: true }),
    hold,
    approve: (id) =>
      write(
        db(
          sql.withTransaction(
            Effect.gen(function* () {
              const stored = yield* get(id);
              if (stored.job.status !== "needs-approval") return false;
              if (stored.job.reservedUsd === undefined)
                return yield* new CampaignError({
                  reason: "not_allowed",
                  message:
                    "This legacy job has no cost reservation. Cancel it and create a new request with an allowance.",
                });
              yield* checkCap(stored.job.clientId, 0, stored.job.campaignId);
              const moved = yield* sql<{
                id: string;
              }>`UPDATE workbench_campaign_generation_jobs SET status = 'queued', updated_at = ${yield* now}
        WHERE id = ${id} AND status = 'needs-approval' RETURNING id`;
              return moved.length > 0;
            }),
          ),
        ),
      ),
    setProviderJobId: (id, providerJobId) =>
      write(
        db(
          sql`UPDATE workbench_campaign_generation_jobs SET provider_job_id = ${providerJobId}, submission_state = 'submitted', error = NULL WHERE id = ${id}`,
        ),
      ).pipe(Effect.asVoid),
    finish,
    cancel: (id) => move(id, ["needs-approval", "queued", "running"], "cancelled"),
  });
});

export const layer = Layer.effect(GenerationStore, make);
