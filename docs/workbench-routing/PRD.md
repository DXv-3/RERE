# Workbench Adaptive Routing

Status: Ryan authorized the reviewed build on October 3, 2026. A local advisory preview is packaged in v7; Jev judgments and automatic execution remain unimplemented. Read BUILD_EXECUTION.md beside the canonical handoff for the current delivery sequence.

## The Intended Experience

Workbench chooses a suitable model and account for each new turn, preserves your original goal when changing providers, and shows why it chose that route. Routine work can use free inference or available subscriptions; difficult work gets an appropriate model. You can pin a model at any time. Remaining subscription allowance, context capacity, and API spending are shown separately.

## Problem And Evidence

Ryan has multiple subscriptions, including two Grok accounts, and wants to stop choosing models manually while avoiding unnecessary API charges. Workbench has two Grok instances. The second now has an isolated credential directory and still requires Ryan's second-account sign-in; two rows do not establish two verified identities. CheaperInference exposed only eight built-in Codex models until its streaming text catalog was registered. Real GPT-6-Luna and Claude Haiku 4.5 turns have passed; the whole catalog has not been benchmarked. OpenRouter's direct free Responses request completed with reported cost zero. Its installed-app coding turn subsequently ran node --test with six passing tests; that app receipt's actual cost and resolved model were not separately audited.

The router must consider model suitability, supported tools, account identity, quota freshness, provider continuity, latency, and actual cost. A percentage remaining at one provider is not a comparable token balance at another.

## Current Decisions And Remaining Preferences

- Manual selection remains available and authoritative. New routing starts in recommendation-only mode.
- Prefer existing subscription capacity for demanding coding. The current advisory preview uses a 10% headroom threshold and executes nothing. The earlier proposed 15% automatic reserve remains a policy preference to settle before automatic activation; do not infer an execution policy from the advisory threshold.
- Free inference is eligible only after the relevant task and tool workflow passes evaluation. Free availability is not a quality guarantee.
- Ryan selected $0.10/day for Jev model/skill judgments. Enforce durable admission and cost reconciliation before live judgments. Paid automatic task execution and paid background learning remain disabled. Existing manually selected providers remain available under their existing configuration.
- Reconsider routes between completed turns. Keep the route fixed during tool execution; preserve approvals and explicit user instructions.
- A stale or unsupported quota is labeled unknown. It cannot be treated as an unlimited subscription.

## Success And Stop Criteria

Targets are proposals, measured against a fixed manual baseline on comparable tasks, not promises of savings.

| Measure                                                   | First 30 Days                                            | First 90 Days                |
| --------------------------------------------------------- | -------------------------------------------------------- | ---------------------------- |
| Evaluated representative tasks                            | At least 50                                              | At least 200                 |
| Accepted task completion                                  | Within 2 percentage points of manual baseline            | At least baseline            |
| API cost per accepted task, including routing and retries | At least 15% below paid manual baseline where one exists | At least 25% below baseline  |
| Routing overhead                                          | p95 under 2 seconds, measured                            | p95 under 1 second, measured |
| Duplicate writes caused by switching                      | 0                                                        | 0                            |
| Disallowed-account or budget violations                   | 0                                                        | 0                            |
| Decisions with account, quota age, reason, and receipt    | 100%                                                     | 100%                         |

Immediately disable automatic dispatch on a duplicated side effect, policy bypass, false account identity, or incorrect budget admission. Return to recommendations if quality falls outside the agreed tolerance or measured savings do not cover routing overhead. Small evaluation sets do not establish statistical superiority.

## Scope

Account isolation and deduplication; model capability catalogs; typed Jev judgments; deterministic eligibility and budget enforcement; subscription-aware ranking; visible manual overrides; durable route receipts; safe provider handoffs; evaluation before activation. Backend enforcement applies to desktop, web, remote clients, scheduled turns, and agent-triggered turns. Older/mobile clients remain manual until they understand the new contract.

Out of scope: training or self-hosting Jev, silently changing global CLI configuration, subscription limit evasion, automatic purchases/top-ups, mid-tool migration, calling/SMS, and installing a browser agent as part of model routing.

## Why Jev, And Which Jev

Jev returns typed judgments suitable for assessing task requirements. Workbench still owns authorization, account selection, quota policy, and execution. Its effectiveness must be compared with a deterministic baseline on our tasks. The installed TypeSafe skill guides development; it does not install a running router.

OpenRouter offers three different relevant mechanisms:

- `openrouter/free` chooses randomly among compatible free models. It is a free execution option, not our quality-ranking policy.
- `typesafe/jev-router` chooses a model and reasoning effort from OpenRouter's pool. It does not directly operate local Grok, Cursor, Claude, or Codex subscription sessions. Its include list can be ignored when it matches no model, so it is unsuitable as the sole spending or allowlist boundary.
- Jev's structured decision API lets Workbench interpret a task, then select among its own eligible subscriptions and API candidates. This is the recommended integration.

`browser-use/jev-ultrafast` is an MIT browser-action agent that calls hosted TypeSafe inference plus a text-generation API. It contains useful browser automation patterns, but installing it on our server does not self-host Jev or solve subscription routing. Evaluate separately if browser automation becomes an accepted feature.

## Sources And Constraints

- [TypeSafe Skill](https://github.com/typesafe-ai/skills/blob/main/skills/typesafe-ai/SKILL.md), [API](https://docs.typesafe.ai/api), [Choice](https://docs.typesafe.ai/primitives/choice), [Function Calling Pattern](https://docs.typesafe.ai/cookbooks/function_calling).
- [Jev Through OpenRouter](https://openrouter.ai/docs/guides/community/jev), [Hosted Jev Router](https://openrouter.ai/docs/guides/routing/routers/jev-router), [Free Router](https://openrouter.ai/docs/guides/routing/routers/free-router).
- [Jev Ultrafast README](https://github.com/browser-use/jev-ultrafast), [Hosted API Call In Source](https://github.com/browser-use/jev-ultrafast/blob/main/jev_ultrafast/model.py).

Use existing server-side credentials `OPENROUTER_API_KEY` and `CHEAPERINFERENCE_API_KEY`; no key enters a client, prompt, audit log, or repository. No new account or paid service purchase is assumed. Observe provider-supported account access and limits. Live metadata, account identity, pricing, and API contracts must be revalidated at implementation time.

## Decisions Log

- October 3: Ryan authorized implementation of the reviewed plan. Workbench owns policy; Jev is an optional judgment service. Selection budget: $0.10/day. Paid automatic execution remains off. Hosted browser automation stays separate. HighLevel is retired; future social scheduling integrates the existing custom stack.
