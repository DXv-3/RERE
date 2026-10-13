#!/usr/bin/env node
// Scores the wording Jev is asked (src/routing/jevProtocol.ts) against known messages, live.
// Run before changing that wording or the confidence bar, and compare the totals:
//   TYPESAFE_API_KEY=... node scripts/evaluate-jev-routing.ts
// About 30 requests at roughly $0.00002 each without a skill list.
// @effect-diagnostics globalFetch:off globalConsole:off preferSchemaOverJson:off - a plain command-line check that prints its own report.
import {
  makeJevRequest,
  readJevAdvice,
  readTypeSafeReceipt,
  TYPESAFE_ENDPOINT,
} from "../src/routing/jevProtocol.ts";
import { jevRoutingEvaluationCases } from "./jevRoutingEvaluationCases.ts";

// The bar below which the router keeps whatever the message arrived with.
const SURE = 0.6;
const key = process.env.TYPESAFE_API_KEY?.trim();
if (!key) {
  console.error("Set TYPESAFE_API_KEY to a key from console.typesafe.ai.");
  process.exit(2);
}

let right = 0;
let wrong = 0;
let unsure = 0;
for (const item of jevRoutingEvaluationCases) {
  const built = makeJevRequest(item.task, [], "typesafe");
  const response = await fetch(TYPESAFE_ENDPOINT, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(built.body),
  });
  if (response.status !== 200) {
    console.error(`TypeSafe answered ${response.status}; stopping.`);
    process.exit(1);
  }
  const value: unknown = await response.json();
  const advice = readJevAdvice(
    "evaluation",
    built,
    value,
    readTypeSafeReceipt(value, response.headers.get("x-typesafe-request-id") ?? ""),
  );
  const confidence = advice.confidence.capability;
  // A sure wrong answer moves a model the wrong way. An unsure one moves nothing.
  const verdict =
    advice.capability === item.capability
      ? confidence >= SURE || item.capability === "unknown"
        ? "right"
        : "unsure"
      : confidence >= SURE
        ? "WRONG"
        : "unsure";
  if (verdict === "right") right++;
  else if (verdict === "WRONG") wrong++;
  else unsure++;
  console.log(
    `${verdict.padEnd(6)} wanted ${item.capability.padEnd(8)} got ${advice.capability.padEnd(8)} ${confidence.toFixed(2)}  effort ${advice.effort.padEnd(6)} ${advice.confidence.effort.toFixed(2)}  ${item.task.replace(/\s+/g, " ").slice(0, 70)}`,
  );
}
console.log(
  `\n${right} right, ${unsure} unsure (nothing moves), ${wrong} sure and wrong, of ${jevRoutingEvaluationCases.length}`,
);
process.exit(wrong > 0 ? 1 : 0);
