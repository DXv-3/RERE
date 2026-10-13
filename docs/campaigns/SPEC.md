# Campaigns: video, social content and schedules inside CodeWrench

Status: draft for Ryan's approval (2026-10-06). Nothing here is built.

## Objective

Let a person and their agents plan a social campaign, generate and revise the videos and images for it, get each post approved, and publish it on a schedule, without leaving CodeWrench. It is for anyone who uses CodeWrench, on their own machine or a server, for their own brand or for several clients.

Success looks like: "Make three reels for Candid Studios from last week's galleries, every Monday" is one sentence to an agent; the drafts appear as cards; Ryan circles a part of a video, types "tighten this cut", and the agent fixes that part; he approves; the posts go out at their times.

## Decisions already made (Ryan, 2026-10-06)

- Approved posts may publish on a schedule or immediately on approval.
- How much a person is in the loop is the user's choice, per client or per campaign (Ryan, 2026-10-06, second round): **Ask Me First** (every post waits for approval; the default), **Report When Done** (the agent publishes and reports what it posted), or **Auto Publish** (posts go out on schedule with no report beyond the log). Only a person can change the mode; an agent cannot.
- No third-party publishing service. Publishing goes through Savage Digital Solutions' own publishing engine, which already posts to Instagram, Facebook, LinkedIn, TikTok, YouTube, Google Business Profile and Pinterest with the API access already granted.
- Generation runs on what the user already has: an OpenRouter key, a subscription, or a local model server. No provider is required.
- Assets can live in the project folder, in cloud storage, or both. The user chooses.
- Multi-client from the start: Candid Studios, Savage Digital Solutions, and clients of Savage Digital Solutions.
- Agents should be able to see a video, not only its file name, and act on annotations made on it.
- Annotating a video should feel like picking an element in the built-in browser: select the part, type the change.
- It must work for other CodeWrench users on their own machines, not only on Ryan's server.

## How the pieces connect

1. **Publishing connector.** CodeWrench talks to a publishing service over HTTP through one interface (schedule, publish now, approve, reject, queue, history, pause and resume autopost).
   - First connector: the Savage Digital Solutions marketing engine (`apps/marketing-engine` in `savage-platform`: `/api/social/schedule`, `/api/social/publish`, `/api/social/approve/:clientId/:postId`, `/api/autopost/:clientId`, `/api/history/:clientId`). It is already multi-client, so Candid Studios, Savage Digital Solutions and its clients work from day one. The engine keeps its own kill switches (`SOCIAL_AUTOPOST_ENABLED`, per-client pause); CodeWrench shows their state and never overrides them.
   - Second connector: **Export**. For a user with no publishing service, an approved post becomes a folder with the media and the caption per platform, ready to post by hand.
   - Later: other CodeWrench users connect their own social accounts to a hosted version of the same engine. That needs each platform to allow posting for third-party accounts (Meta app review, TikTok audit, Pinterest standard access, LinkedIn's marketing programme). What is granted today covers the accounts already connected; the tier each app holds must be checked before this is offered.
2. **Generation connector.** One interface (image, video, status, cost estimate).
   - Captions, scripts and prompts are written by the agent itself, on whichever model the thread runs (subscription, OpenRouter or local).
   - Images and video need a model that makes them. Connectors: OpenRouter (image and video models, the user's own key), the marketing engine's video router (Kling, Runway, Minimax, OpenRouter video, Gemini images; `POST /api/campaigns/video`), and a local server that speaks the OpenAI images API. A chat subscription alone cannot make video, and the page says so where a user would hit it.
   - Code-made video (Hyperframes, Remotion) counts as video: an agent changes it by editing code and re-rendering. Generated footage is changed by regenerating a scene or by ffmpeg edits.
3. **Storage.** Files in the project folder (`campaigns/<client>/<campaign>/`) by default, so the coding tools, git and agents can all work on them. Optional S3-compatible storage (the existing R2 bucket for Ryan's businesses) for sharing and for platforms that need a public URL. With both on, the folder is the working copy and the bucket holds published files.

## What gets built, in four slices

Each slice is useful by itself and ships separately.

### Slice 1: see and annotate media in a thread

- A media viewer in the right panel for video and image files in the thread's folder: play, scrub, frame step, a timeline with scene markers.
- Annotate: drag a box on the frame, drag a range on the timeline, or both, and type a comment. Each annotation becomes a chip in the composer (the same mechanism as a picked browser element: `apps/web/src/lib/elementContext.ts`, composer context), carrying file, time range, box, and comment.
- What the agent receives: the comment, the time range, the box as percentages, and the frames at the start, middle and end of the range with the box drawn on them, extracted with ffmpeg. That is how the agent sees the part that was circled.
- A tool for agents to look at any video themselves: `media_inspect(file, at[])` returns frames and, when there is speech, a transcript with timestamps.
- Annotations are saved beside the file so a campaign keeps its review history.

### Slice 2: generate

- Tools: `media_generate_image`, `media_generate_video` (text or image to video, provider, model, duration, aspect), `media_edit` (trim, join, captions, resize per platform, via ffmpeg), `media_status`.
- The generation connectors above. Cost shown before a job starts, and a per-client monthly cap that refuses jobs past it.
- Jobs run in the background and survive a restart; results land as files and as cards in the thread.
- A Generate form for people who do not want to type it as a message.

### Slice 3: clients and the campaign board

- Clients: name, brand kit (logo, colours, fonts, voice notes, do-not-say list), connected social accounts, approver.
- A Campaigns view in the Agents tab: campaigns per client, each a board of posts moving through Draft, Needs approval, Approved, Scheduled, Posted, Failed.
- A post is media, caption per platform, platforms, proposed time, and its source thread. Opening a post opens the viewer from slice 1, so revising is the same action everywhere.
- Approve and Request changes on the card. Request changes sends the annotations and comment back to the agent that made it.
- Agents get tools to create and update posts. In Ask Me First they can never approve one. In the other two modes a post an agent finishes is approved by the mode the person set, and the card records that.

### Slice 4: schedule and publish

- The publishing connector posts Approved items at their time, or at once when approved with "post now". Result and link recorded on the card; failures are shown with the platform's reason and can be retried.
- Loops: one screen for every scheduled task and agent goal (the server already has `scheduled_tasks` and agent goals), showing what it does, when it runs next, what it produced, with pause and run-now.
- Templates: weekly reel batch, turn a blog post into five posts, monthly campaign calendar, repurpose a long video into shorts.
- The three modes (Ask Me First, Report When Done, Auto Publish), set per client and overridable per campaign.

## Boundaries

- Always: every publish is logged with the mode it went out under and, where a person approved it, who; costs are shown before spending; the publishing service's own kill switches win.
- Ask first: connecting a new social account; raising a client's spend cap; changing a client's mode to Report When Done or Auto Publish.
- Never: an agent changing the mode; posting to an account that is not connected; putting one client's assets in another client's campaign.

## What this changes in Ryan's own rules

- His standing note says social autopost is paused and that work is draft-only. He has now said publishing may be automatic where the user sets it so. The note needs his own update; until he changes it, agents on his machines keep to drafts.
- Agents on the server cannot reach the marketing engine today; that is the deliberate lockdown of the agents account, and no production key may be stored there. The engine connector therefore works from Ryan's Mac, or from the server only after he opens that port and adds the key himself.

## Open questions

1. Which access tier does each platform app hold (own accounts only, or third-party accounts)? Decides when other users can connect their own accounts.
2. Does the local server have an image or video model, or only the text model?
3. Does a client ever log in to approve their own posts, or does Ryan's team approve on their behalf?

## How it will be verified

- Unit tests for annotation maths, the job state machine, the board's state transitions, the spend cap, and the approval rule (an agent call can never move a post to Approved).
- Connector tests against recorded responses; one real generation and one real post to a test account, done by Ryan.
- The viewer, annotation and board need Ryan's eyes on a Mac build: this seat cannot open the app.

## Order and size

Slice 1 is built. Then 3 (clients, board, modes), 4 (publishing connectors), 2 (generation connectors): the board and publishing use what already exists, so they come before new generation work. Each is about one working session to build and one Mac build to review.
