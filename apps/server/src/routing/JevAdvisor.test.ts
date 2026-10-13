import { expect, it } from "@effect/vitest";
import { RoutingJudgmentError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Option from "effect/Option";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as SelectionBudgetStore from "./SelectionBudgetStore.ts";
import * as JevAdvisor from "./JevAdvisor.ts";
import {
  JEV_MAX_SKILLS,
  jevTransportForKey,
  makeJevRequest,
  readJevAdvice,
  readTypeSafeReceipt,
  relevantSkillIds,
  usdToMicroUsd,
} from "./jevProtocol.ts";

const metadata = {
  data: {
    id: "typesafe/jev-1.13",
    endpoints: [
      {
        name: "TypeSafe | typesafe/jev-1.13-20260917",
        context_length: 32000,
        pricing: { prompt: "0.000000042", completion: "0" },
      },
    ],
  },
};
const answer = (choice: string, keys: string[]) => ({
  type: "choice",
  choice,
  confidence: 1,
  probabilities: Object.fromEntries(keys.map((key) => [key, key === choice ? 1 : 0])),
});
const receipt = () => ({
  id: "gen-test",
  model: "typesafe/jev-1.13-20260917",
  usage: { cost: 0.000019992, input_tokens: 476, output_tokens: 52 },
  answers: {
    capability: answer("standard", ["basic", "standard", "advanced", "unknown"]),
    effort: answer("medium", ["low", "medium", "high"]),
    skill: answer("none", ["none"]),
  },
});
const input = {
  requestId: "test-request",
  task: "Fix a small parser bug and verify it",
  skills: [],
};
const secretLayer = (configured = true) => {
  const values = new Map<string, Uint8Array>();
  if (configured) values.set("workbench-jev-openrouter", new TextEncoder().encode("test-key"));
  values.set("coding-provider", new TextEncoder().encode("preserve-me"));
  return Layer.succeed(
    ServerSecretStore.ServerSecretStore,
    ServerSecretStore.ServerSecretStore.of({
      get: (name) => Effect.sync(() => Option.fromNullishOr(values.get(name))),
      set: (name, value) =>
        Effect.sync(() => {
          values.set(name, value);
        }),
      create: () => Effect.die("Unexpected secret write"),
      getOrCreateRandom: () => Effect.die("Unexpected secret write"),
      remove: (name) =>
        Effect.sync(() => {
          values.delete(name);
        }),
    }),
  );
};
const setup = (
  post: () => Effect.Effect<unknown, RoutingJudgmentError>,
  options: { configured?: boolean; price?: unknown } = {},
) => {
  let calls = 0;
  const http = HttpClient.make((request) => {
    if (request.method === "GET")
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, Response.json(options.price ?? metadata)),
      );
    calls++;
    expect(request.url).toBe("https://openrouter.ai/api/alpha/decisions");
    expect(request.body._tag).toBe("Uint8Array");
    if (request.body._tag === "Uint8Array") {
      const body = JSON.parse(new TextDecoder().decode(request.body.body));
      expect(body.provider).toEqual({
        only: ["typesafe"],
        allow_fallbacks: false,
        max_price: { prompt: "0.042", completion: "0", request: "0" },
      });
      expect(Object.keys(body.questions)).toHaveLength(3);
    }
    return post().pipe(
      Effect.map((value) => HttpClientResponse.fromWeb(request, Response.json(value))),
      Effect.catch(() =>
        Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 502 }))),
      ),
    );
  });
  const layer = JevAdvisor.layer.pipe(
    Layer.provideMerge(SelectionBudgetStore.layer.pipe(Layer.provide(SqlitePersistenceMemory))),
    Layer.provideMerge(secretLayer(options.configured)),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
  );
  return { layer, calls: () => calls };
};
it.effect("reconciles the bill and replays persisted advice without a second paid request", () => {
  const fixture = setup(() => Effect.succeed(receipt()));
  return Effect.gen(function* () {
    const advisor = yield* JevAdvisor.JevAdvisor;
    const first = yield* advisor.assess(input);
    expect(first).toMatchObject({
      capability: "standard",
      effort: "medium",
      skillName: null,
      costMicroUsd: 20,
    });
    expect(yield* advisor.assess(input)).toEqual(first);
    expect(fixture.calls()).toBe(1);
    expect(yield* (yield* SelectionBudgetStore.SelectionBudgetStore).snapshot).toMatchObject({
      heldMicroUsd: 0,
      spentMicroUsd: 20,
    });
  }).pipe(Effect.provide(fixture.layer));
});
it.effect("prevents simultaneous requests sharing an ID from sending twice", () => {
  const fixture = setup(() => Effect.succeed(receipt()));
  return Effect.gen(function* () {
    const advisor = yield* JevAdvisor.JevAdvisor;
    const results = yield* Effect.all(
      Array.from({ length: 4 }, () => Effect.result(advisor.assess(input))),
      { concurrency: "unbounded" },
    );
    expect(results.some((r) => r._tag === "Success")).toBe(true);
    expect(fixture.calls()).toBe(1);
  }).pipe(Effect.provide(fixture.layer));
});
it.effect("does not send when pricing changes or the key is missing", () =>
  Effect.gen(function* () {
    for (const options of [
      { configured: false },
      { price: { data: { id: "typesafe/jev-1.13", endpoints: [] } } },
    ]) {
      const fixture = setup(() => Effect.die("Should not send"), options);
      yield* Effect.gen(function* () {
        const error = yield* Effect.flip((yield* JevAdvisor.JevAdvisor).assess(input));
        expect(["not_configured", "price_unavailable"]).toContain(error.reason);
        expect(fixture.calls()).toBe(0);
        expect(yield* (yield* SelectionBudgetStore.SelectionBudgetStore).snapshot).toMatchObject({
          heldMicroUsd: 0,
        });
      }).pipe(Effect.provide(fixture.layer));
    }
  }),
);
it.effect("keeps an ambiguous request held and never retries it automatically", () => {
  const fixture = setup(() =>
    Effect.fail(new RoutingJudgmentError({ reason: "request_uncertain" })),
  );
  return Effect.gen(function* () {
    const advisor = yield* JevAdvisor.JevAdvisor;
    expect((yield* Effect.flip(advisor.assess(input))).reason).toBe("request_uncertain");
    expect((yield* Effect.flip(advisor.assess(input))).reason).toBe("already_requested");
    expect(fixture.calls()).toBe(1);
    expect(yield* (yield* SelectionBudgetStore.SelectionBudgetStore).snapshot).toMatchObject({
      heldMicroUsd: 4032,
      unresolvedRequests: 1,
    });
  }).pipe(Effect.provide(fixture.layer));
});
it.effect("retains the reservation on timeout after sending", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const fixture = setup(() =>
      Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
    );
    yield* Effect.gen(function* () {
      const advisor = yield* JevAdvisor.JevAdvisor;
      const running = yield* Effect.forkChild(Effect.result(advisor.assess(input)));
      yield* Deferred.await(started);
      yield* TestClock.adjust("21 seconds");
      const outcome = yield* Fiber.join(running);
      expect(outcome._tag).toBe("Failure");
      expect(yield* (yield* SelectionBudgetStore.SelectionBudgetStore).snapshot).toMatchObject({
        heldMicroUsd: 4032,
      });
      expect(fixture.calls()).toBe(1);
    }).pipe(Effect.provide(fixture.layer));
  }),
);
it.effect("reconciles a known charge even if the judgment is malformed", () => {
  const value = receipt();
  value.answers.capability.probabilities.standard = 0;
  const fixture = setup(() => Effect.succeed(value));
  return Effect.gen(function* () {
    expect((yield* Effect.flip((yield* JevAdvisor.JevAdvisor).assess(input))).reason).toBe(
      "invalid_response",
    );
    expect(yield* (yield* SelectionBudgetStore.SelectionBudgetStore).snapshot).toMatchObject({
      heldMicroUsd: 0,
      spentMicroUsd: 20,
    });
  }).pipe(Effect.provide(fixture.layer));
});
it.effect("halts on overrun and does not return an apparently usable judgment", () => {
  const value = receipt();
  value.usage.cost = 0.005;
  const fixture = setup(() => Effect.succeed(value));
  return Effect.gen(function* () {
    expect((yield* Effect.flip((yield* JevAdvisor.JevAdvisor).assess(input))).reason).toBe(
      "budget_blocked",
    );
    expect(yield* (yield* SelectionBudgetStore.SelectionBudgetStore).snapshot).toMatchObject({
      halted: true,
      spentMicroUsd: 5000,
    });
  }).pipe(Effect.provide(fixture.layer));
});
it.effect("keeps missing cost unknown and rejects unexpected choices and model versions", () => {
  const value = { ...receipt(), usage: { input_tokens: 400, output_tokens: 50 } };
  const fixture = setup(() => Effect.succeed(value));
  return Effect.gen(function* () {
    expect((yield* Effect.flip((yield* JevAdvisor.JevAdvisor).assess(input))).reason).toBe(
      "request_uncertain",
    );
    expect(yield* (yield* SelectionBudgetStore.SelectionBudgetStore).snapshot).toMatchObject({
      heldMicroUsd: 4032,
    });
    const request = makeJevRequest(input.task, []);
    expect(() =>
      readJevAdvice(input.requestId, request, { ...receipt(), model: "other" }),
    ).toThrow();
    const invalid = receipt();
    invalid.answers.skill.choice = "made-up";
    expect(() => readJevAdvice(input.requestId, request, invalid)).toThrow();
    expect(usdToMicroUsd(0.000000042)).toBe(1);
    expect(usdToMicroUsd(0.00002)).toBe(20);
    expect(() => usdToMicroUsd(Infinity)).toThrow();
  }).pipe(Effect.provide(fixture.layer));
});

it.effect("recovers a scoped request without client state or another paid call", () => {
  const fixture = setup(() => Effect.succeed(receipt()));
  return Effect.gen(function* () {
    const advisor = yield* JevAdvisor.JevAdvisor;
    const selection = {
      task: input.task,
      skills: [],
      scope: { instanceId: "one", cwd: "/project" },
    };
    const first = yield* advisor.recover(selection);
    expect(first.state).toBe("new");
    expect(fixture.calls()).toBe(0);
    const advice = yield* advisor.assess({ ...selection, requestId: first.requestId });
    expect(yield* advisor.recover(selection)).toEqual({
      requestId: first.requestId,
      state: "settled",
      advice,
    });
    for (const changed of [
      { ...selection, task: "A different task" },
      { ...selection, scope: { ...selection.scope, catalogRevision: "new-catalog" } },
      { ...selection, skills: [{ name: "review", description: "Review code" }] },
      { ...selection, scope: { ...selection.scope, instanceId: "two" } },
      { ...selection, scope: { ...selection.scope, cwd: "/other" } },
    ]) {
      expect((yield* advisor.recover(changed)).requestId).not.toBe(first.requestId);
      expect(
        (yield* Effect.flip(advisor.assess({ ...changed, requestId: first.requestId }))).reason,
      ).toBe("stale_preview");
    }
    expect(fixture.calls()).toBe(1);
  }).pipe(Effect.provide(fixture.layer));
});
it.effect("recovers an uncertain request and concurrent clients cannot send it again", () => {
  const fixture = setup(() =>
    Effect.fail(new RoutingJudgmentError({ reason: "request_uncertain" })),
  );
  return Effect.gen(function* () {
    const advisor = yield* JevAdvisor.JevAdvisor;
    const request = yield* advisor.recover(input);
    const concurrent = yield* advisor.recover(input);
    expect(concurrent.requestId).toBe(request.requestId);
    yield* Effect.all(
      [request, concurrent].map(({ requestId }) =>
        Effect.result(advisor.assess({ ...input, requestId })),
      ),
      { concurrency: "unbounded" },
    );
    expect(yield* advisor.recover(input)).toEqual({ ...request, state: "dispatched" });
    expect(
      (yield* Effect.flip(advisor.assess({ ...input, requestId: request.requestId }))).reason,
    ).toBe("already_requested");
    expect(fixture.calls()).toBe(1);
  }).pipe(Effect.provide(fixture.layer));
});

it.effect(
  "connects and disconnects without inference, erasing receipts, or changing provider credentials",
  () => {
    const fixture = setup(() => Effect.succeed(receipt()), { configured: false });
    return Effect.gen(function* () {
      const advisor = yield* JevAdvisor.JevAdvisor;
      expect(yield* advisor.configured).toBe(false);
      expect(
        (yield* Effect.flip(
          advisor.configure({ action: "connect", key: Redacted.make("bad key") }),
        )).reason,
      ).toBe("invalid_input");
      expect(yield* advisor.configured).toBe(false);
      expect(
        yield* advisor.configure({ action: "connect", key: Redacted.make("sk-or-test-key") }),
      ).toEqual({ configured: true });
      expect(fixture.calls()).toBe(0);
      const saved = yield* advisor.assess(input);
      expect(yield* advisor.configure({ action: "disconnect" })).toEqual({ configured: false });
      expect(yield* advisor.configured).toBe(false);
      expect(yield* advisor.assess(input)).toEqual(saved);
      expect((yield* Effect.flip(advisor.assess({ ...input, requestId: "another" }))).reason).toBe(
        "not_configured",
      );
      expect(fixture.calls()).toBe(1);
      expect(yield* (yield* ServerSecretStore.ServerSecretStore).get("coding-provider")).toEqual(
        Option.some(new TextEncoder().encode("preserve-me")),
      );
    }).pipe(Effect.provide(fixture.layer));
  },
);

it("offers Jev a whole catalog, each name folded into its description, and refuses an oversized one", () => {
  const skill = (index: number) => ({
    name: `managed:skill-${index}`,
    description: "d".repeat(300),
  });
  const few = makeJevRequest("Review this reel", [skill(0), skill(1)]);
  expect(few.body.state).toEqual({ task: "Review this reel" });
  expect(few.body.questions.skill.criteria.skill0).toBe(`managed:skill-0: ${"d".repeat(280)}`);
  expect(few.skillNames).toEqual({ skill0: "managed:skill-0", skill1: "managed:skill-1" });
  expect("skill2" in few.body.questions).toBe(false);
  const many = makeJevRequest(
    "Review this reel",
    Array.from({ length: 120 }, (_, index) => skill(index)),
  );
  expect(many.skillNames.skill119).toBe("managed:skill-119");
  expect(many.body.questions.skill.criteria.skill119).toBe(`managed:skill-119: ${"d".repeat(140)}`);
  // "none" plus one option per skill.
  expect(Object.keys(many.body.questions.skill.criteria)).toHaveLength(121);
  expect(() =>
    makeJevRequest(
      "Review this reel",
      Array.from({ length: JEV_MAX_SKILLS + 1 }, (_, index) => skill(index)),
    ),
  ).toThrow(RoutingJudgmentError);
});

it("splits a catalog over 254 skills into a second question", () => {
  const skills = Array.from({ length: 300 }, (_, index) => ({
    name: `managed:s-${index}`,
    description: "Does a thing",
  }));
  const { body, skillNames } = makeJevRequest("Review this reel", skills, "typesafe");
  const first = Object.keys(body.questions.skill.criteria);
  const second = Object.keys(
    (body.questions as Record<string, { criteria: object }>).skill2!.criteria,
  );
  // Each question holds `none` and stays inside the 255-option limit.
  expect(first).toHaveLength(255);
  expect(second).toHaveLength(47);
  expect(first).toContain("skill253");
  expect(second).toContain("skill254");
  expect(second).toContain("none");
  expect(Object.keys(skillNames)).toHaveLength(300);
});

it("tells a TypeSafe key from an OpenRouter key and shapes the request for each", () => {
  expect(jevTransportForKey("sk-or-v1-abc")).toBe("openrouter");
  expect(jevTransportForKey("ts_live_abc")).toBe("typesafe");
  const direct = makeJevRequest("Fix the parser", [], "typesafe");
  expect(direct.body.model).toBe("jev-latest");
  expect("provider" in direct.body).toBe(false);
  expect(makeJevRequest("Fix the parser", []).body.model).toBe("typesafe/jev-1.13");
});

it("works out a TypeSafe bill from tokens, rounding up", () => {
  const reply = { model: "jev-1.13.0", usage: { input_tokens: 457, output_tokens: 93 } };
  expect(readTypeSafeReceipt(reply, "req_123")).toEqual({
    receiptId: "req_123",
    model: "jev-1.13.0",
    costMicroUsd: 20,
    inputTokens: 457,
  });
  // A missing or odd request id never blocks the receipt.
  expect(readTypeSafeReceipt(reply, "").receiptId).toBe("typesafe");
  expect(
    readTypeSafeReceipt({ ...reply, usage: { input_tokens: 1, output_tokens: 0 } }, "x"),
  ).toMatchObject({ costMicroUsd: 1 });
});

it("attaches every skill with a real share of the vote, best first, and none when none wins", () => {
  expect(
    relevantSkillIds("skill2", { none: 0.05, skill0: 0.2, skill1: 0.1, skill2: 0.65 }),
  ).toEqual(["skill2", "skill0"]);
  expect(relevantSkillIds("none", { none: 0.6, skill0: 0.4 })).toEqual([]);
  expect(relevantSkillIds("a", { none: 0, a: 0.3, b: 0.2, c: 0.2, d: 0.2, e: 0.1 })).toHaveLength(
    3,
  );
});

it("reads a TypeSafe reply whose rounded shares do not sum to exactly one", () => {
  const skills = [
    { name: "managed:go", description: "Take a bug to a merged PR" },
    { name: "managed:pdf", description: "Work with PDF files" },
  ];
  const request = makeJevRequest("Fix the failing login test and open a PR", skills, "typesafe");
  const reply = {
    model: "jev-1.13.0",
    usage: { input_tokens: 457, output_tokens: 93 },
    answers: {
      capability: {
        type: "choice",
        choice: "standard",
        confidence: 0.65,
        probabilities: { basic: 0.01, standard: 0.73, advanced: 0.04, unknown: 0.21 },
      },
      effort: {
        type: "choice",
        choice: "medium",
        confidence: 0.7,
        probabilities: { low: 0.1, medium: 0.8, high: 0.1 },
      },
      skill: {
        type: "choice",
        choice: "skill0",
        confidence: 0.94,
        probabilities: { none: 0.04, skill0: 0.78, skill1: 0.18 },
      },
    },
  };
  const advice = readJevAdvice("r1", request, reply, readTypeSafeReceipt(reply, "req_1"));
  expect(advice).toMatchObject({
    capability: "standard",
    effort: "medium",
    skillName: "managed:go",
    skillNames: ["managed:go", "managed:pdf"],
    costMicroUsd: 20,
    receiptId: "req_1",
  });
  // The same reply through OpenRouter's stricter checks is refused: wrong model and no bill.
  expect(() => readJevAdvice("r1", request, reply)).toThrow();
});

it.effect("sends a TypeSafe key straight to TypeSafe without a price lookup", () => {
  const seen: string[] = [];
  const values = new Map<string, Uint8Array>([
    ["workbench-jev-typesafe", new TextEncoder().encode("ts-key")],
  ]);
  const secrets = Layer.succeed(
    ServerSecretStore.ServerSecretStore,
    ServerSecretStore.ServerSecretStore.of({
      get: (name) => Effect.sync(() => Option.fromNullishOr(values.get(name))),
      set: () => Effect.void,
      create: () => Effect.die("Unexpected secret write"),
      getOrCreateRandom: () => Effect.die("Unexpected secret write"),
      remove: () => Effect.void,
    }),
  );
  const http = HttpClient.make((request) => {
    seen.push(`${request.method} ${request.url}`);
    expect(request.headers.authorization).toBe("Bearer ts-key");
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        Response.json(
          {
            model: "jev-1.13.0",
            usage: { input_tokens: 500, output_tokens: 50 },
            answers: receipt().answers,
          },
          { headers: { "x-typesafe-request-id": "req_abc" } },
        ),
      ),
    );
  });
  return Effect.gen(function* () {
    const advisor = yield* JevAdvisor.JevAdvisor;
    expect(yield* advisor.configured).toBe(true);
    const advice = yield* advisor.assess(input);
    expect(advice).toMatchObject({
      capability: "standard",
      model: "jev-1.13.0",
      receiptId: "req_abc",
      costMicroUsd: 21,
    });
    expect(seen).toEqual(["POST https://api.typesafe.ai/v1/systemone"]);
  }).pipe(
    Effect.provide(
      JevAdvisor.layer.pipe(
        Layer.provideMerge(SelectionBudgetStore.layer.pipe(Layer.provide(SqlitePersistenceMemory))),
        Layer.provideMerge(secrets),
        Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
      ),
    ),
  );
});

it("merges two skill questions by probability and ignores one where none won", () => {
  const skills = Array.from({ length: 300 }, (_, index) => ({
    name: `managed:s-${index}`,
    description: "Does a thing",
  }));
  const request = makeJevRequest("Make a reel and review the captions", skills, "typesafe");
  const vote = (ids: Record<string, number>, choice: string, confidence: number) => ({
    type: "choice",
    choice,
    confidence,
    probabilities: ids,
  });
  const reply = (skill: ReturnType<typeof vote>, skill2: ReturnType<typeof vote>) => ({
    model: "jev-1.13.0",
    usage: { input_tokens: 9_000, output_tokens: 80 },
    answers: {
      ...receipt().answers,
      skill: skill,
      skill2: skill2,
    },
  });
  const firstOptions = Object.fromEntries(
    Object.keys(request.body.questions.skill.criteria).map((id) => [id, 0]),
  );
  const secondOptions = Object.fromEntries(
    Object.keys(
      (request.body.questions as Record<string, { criteria: object }>).skill2!.criteria,
    ).map((id) => [id, 0]),
  );
  const first = vote({ ...firstOptions, skill3: 0.6, skill4: 0.2, none: 0.2 }, "skill3", 0.8);
  const second = vote({ ...secondOptions, skill260: 0.75, none: 0.25 }, "skill260", 0.9);
  const both = reply(first, second);
  const advice = readJevAdvice("r", request, both, readTypeSafeReceipt(both, "req"));
  expect(advice.skillNames).toEqual(["managed:s-260", "managed:s-3", "managed:s-4"]);
  expect(advice.skillName).toBe("managed:s-260");
  expect(advice.confidence.skill).toBe(0.9);

  // `none` winning one question drops that question's skills but keeps the other's.
  const none = vote({ ...secondOptions, skill260: 0.3, none: 0.7 }, "none", 0.7);
  const half = reply(first, none);
  expect(readJevAdvice("r", request, half, readTypeSafeReceipt(half, "req")).skillNames).toEqual([
    "managed:s-3",
    "managed:s-4",
  ]);
  // A reply missing the second answer, or answering a question never asked, is refused.
  const missing = { ...both, answers: { ...both.answers, skill2: undefined } };
  expect(() => readJevAdvice("r", request, missing, readTypeSafeReceipt(missing, "req"))).toThrow();
  const small = makeJevRequest("Fix it", skills.slice(0, 5), "typesafe");
  expect(() => readJevAdvice("r", small, both, readTypeSafeReceipt(both, "req"))).toThrow();
});
