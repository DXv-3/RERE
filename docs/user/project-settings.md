# Settings and project overrides

On web and desktop, the "Applying settings for …" sentence at the top of Settings pages picks
the project and environment a change applies to. Pages that only hold device preferences, such as
Appearance, don't show it. They start at **All projects** and **All environments**
and stay selected as you move between categories or search for a setting.

Preferences saved on this device, such as appearance, confirmations and browser profiles, always
show and ignore the selection. Everything else is stored on a server. Choose one environment to
edit its settings, or leave **All environments** to edit every connected environment at once.
Offline environments keep their current values; this is a bulk edit, not a synced global default.

Choose a project to override settings for it on the selected environments. A layers icon beside
each server row's title shows where the value comes from: the built-in default, the environment,
or a project override. Click it to see that chain on every selected environment. An override can
be reset to inherit again. Settings that cannot be overridden by a project are shown read-only
while a project is selected.

When the selected environments disagree, the control shows **Mixed** in place of a value and the
layers icon turns amber. Picking a value applies it to every selected environment.

Changing an environment value never touches a project's own override. When projects override the
setting you are editing, the layers icon counts them and the chain lists each one with its value:
click a project to jump to it, or **Reset all** to make those projects follow the environment
again.

Providers and diagnostics are per machine: they show one environment at a time, the primary
one until you pick another. Every other setting fans out to the selection.

On mobile, open **Settings** and use the filter in its header to choose connected environments
and a project. The filter stays available in server-setting pages. With **All projects** selected,
the **Server settings** categories and auto-settle controls in **Thread behavior** edit the
selected environments' defaults. Choosing a project edits its overrides on the selected
environments. Use **Use defaults** in a page to remove that page's project overrides.
Open **Settings → Projects & threads → Overview** to rename the project across its selected
connected checkouts and see where those checkouts live.
Settings that are environment-wide stay read-only while a project is selected. When selected
targets disagree, a control shows **Mixed** until you choose one value. Appearance, keyboard,
and other phone-only settings ignore the filter.

## Worktree branch names

In **Settings → Source Control → Worktree branch naming**, choose a static prefix,
a model-selected semantic prefix such as `feat/` or `fix/`, or custom instructions
for the complete name. The static prefix defaults to `t3code/`; a trailing slash is
optional, and an empty prefix adds nothing. Invalid characters in a static prefix
are replaced with hyphens. Custom instructions are appended to
the naming prompt and can specify issue IDs, namespaces, and casing.

These settings apply to automatically named new worktree branches. Select a project
to override its environment defaults. Worktree directories keep their original names.
If generation fails, or a custom name is invalid or already taken, the temporary
branch name remains.

## Scheduled tasks on mobile

Open **Settings → Scheduled tasks** to create recurring tasks or manage existing
ones across your connected environments. Use the settings filter to narrow the
list by environment or project. Each task runs on the environment you choose,
using its project, model, and workspace settings. Fixed-time schedules use that
environment's time zone, which may differ from your phone's.

You can edit, pause, resume, run immediately, or delete a task from the list.
Leaving an edited form asks before discarding unsaved changes.

## Defaults and inheritance

General contains the model and workspace for new threads. Integrations controls agent browser
access. Source Control contains automatic pull, the default pull request merge method and text
generation. The same rows edit environment defaults or project overrides depending on the
project crumb.

The Project category, shown while a project is selected, holds the project's name, icon, actions,
checkouts and removal. Actions belong to a project: editing them creates the project's own list
on each selected environment, and reset returns to the environment's shared list. A project's
`t3.json` actions can be imported there.

Settings a repository can also declare in `t3.json`, such as the workspace for new threads,
resolve in one order: a project override, then the environment setting, then `t3.json`, then the
built-in default. Leave a setting on **Inherit** to let the next tier decide.
Browser access changes apply when an agent session next starts.

New worktrees initialize git submodules recursively. If that step is slow because the repository
declares many nested submodules, set **Submodules** in **Settings → General** (with the project
selected to override it there) to **Top level only** to stop at the ones the repository declares
itself, or **Skip** to leave them for a setup script. It resolves in the same order as the
workspace default: a `"worktreeSubmodules"` value in the `t3.json` of the branch being checked out
applies when the project and environment are both on **Inherit**.

## Storage cleanup

Open **Settings → Storage** to enable automatic cleanup on one machine or all connected
environments. Policies are off by default and run on the server at startup, when changed, and
hourly. Offline machines keep their existing policies.

Select a project to set **Automatic worktree cleanup** to **Inherit**, **Off**, or **Custom**.
Inherit follows each machine's rules; Off keeps that project's worktrees until you remove them
manually. Custom applies separate worktree rules to the selected project or checkout. Browser
captures and log retention remain machine-wide.

Worktrees can be removed after a chosen number of inactive days, after merging, or when they
have no commits beyond the default branch. Only CodeWrench-managed worktrees are eligible. Active
sessions, shared worktrees, uncommitted changes, and ignored files other than `node_modules`
prevent removal. Branches and thread history stay; starting another turn recreates the checkout.
Merge cleanup requires the commits to be included in the remote default branch, so squash merges
may need the inactivity rule instead.

Enable **Delete worktrees with deleted threads** to remove safe worktrees after their last
thread is deleted, including archived threads and worktrees left by earlier deletions. The
server waits for sessions and terminals to stop and retries skipped worktrees after restart.
Existing prompts for deleting a worktree manually remain available when this policy is off.

Browser captures and rotated logs have separate retention periods. Expired capture links stop
working. Current logs, message attachments, and browser profiles are kept.

## Goal, instructions and memory

A project can carry standing context that every new thread in it starts with. Set it under
**Settings > Projects**, in **Standing Context**:

- **Goal**: one line of what the project is trying to get done, up to 200 characters.
- **Instructions**: rules for how threads should work, up to 16,000 characters. Good things to put
  here are which branch to target, how a thread checks its own work, and what needs your go-ahead.
  Rules about one repository still belong in that repository's `AGENTS.md` or `CLAUDE.md`.

The agent receives the goal and instructions with the first message of a thread, ahead of what you
typed. They are not stored in the conversation, so they do not appear in the transcript, in copied
messages or in search. A change reaches new threads; a thread already running keeps what it started
with. A first message that is a slash command is sent as it is, without the project's context.
When a project is grouped across several machines, the goal and instructions are saved to each of
them.

Agents can also keep **project memory**: notes shared by every thread in the project, such as a
decision or a pitfall. Ask an agent to "remember this for the project" or to forget something. The
notes are plain files in a folder the server owns, outside your checkout, with `MEMORY.md` as the
index every new thread is shown. A thread in a restricted permission mode may not be able to write
there. Memory is offered to threads once the project has a goal, instructions or an existing
memory index.

Agents can read and change the goal and instructions through the `t3_project_update` tool when you
ask them to.

## The project coordinator

A project can have one **coordinator**: a single conversation you send all of the project's work
to. Open it with **Open Coordinator** under **Settings > Projects > Standing Context**. The first
time, CodeWrench creates the conversation; after that the same button returns to it.

Paste a task, a bug report or a list of tasks. The coordinator answers quick questions itself and
turns each piece of work into its own thread, in its own worktree on its own branch, with a
message that stands alone. A follow-up to work a thread already has goes to that thread.

- **It proposes before it starts.** By default the coordinator lists the threads it would start
  and waits for your go-ahead. Tell it "start without asking" and it records that in project
  memory and stops asking.
- **It hears back.** When a thread the coordinator started or messaged finishes its run, the
  result is delivered to the coordinator, which tells you the outcome. A thread you steer directly
  afterwards reports only to you.
- **Threads are ordinary threads.** They appear in the sidebar, you can open and steer them, and
  they notify you when they need you. They start on the project's default model, or the
  coordinator's when the project has none.
- **It does not do the work itself.** The coordinator runs in the project's main checkout and is
  told not to edit files there.
- **Tune it by telling it.** "Run at most two threads at a time", "only post when something
  finishes or is blocked", "don't open a pull request until I've seen the plan". These are
  preferences the coordinator follows and remembers, not enforced limits.

The coordinator is created with full access, which it needs to start threads. Each thread it
starts is a full agent session, so a project with many running threads uses your provider limits
faster than one conversation does. If you archive the coordinator, **Open Coordinator** starts a
new one; the project's memory carries over.

## The project overview

The overview is one page for a project: its goal, the way into its coordinator, and every thread
sorted by what it needs. Open it from the command palette (**Project overview**) or with **Open
Overview** under **Settings > Projects > Standing Context**.

| Group                | What is in it                                                                                    |
| :------------------- | :----------------------------------------------------------------------------------------------- |
| **Waiting On You**   | Threads with an approval or a question pending, a plan to review, a failed run, or a usage limit |
| **Ready For Review** | Idle threads with an open pull request that is not a draft                                       |
| **Working**          | Threads that are running or have background work open                                            |
| **Landing**          | Idle threads whose pull request is approved                                                      |
| **Idle**             | Threads that finished and are not waiting on anything                                            |
| **Resolved**         | Threads you settled, or that settled on their own when their pull request merged                 |

What you must act on comes first: a running thread stays in Working whatever its pull request says,
and a thread you settled is Resolved even while its pull request is open. Archived threads and the
coordinator itself are not listed. Click a row to open the thread. The **Pull Requests** list shows
each thread's open pull request with its review and check state, as last synced.

The overview is on web and desktop. It lists scheduled tasks only as a link to Settings, and it
does not yet show the project's memory files.

## Pause a project

**Pause** on the project overview stops a project in one move. Running threads, the coordinator
included, are interrupted, and until you press **Resume**:

- no thread in the project accepts a message, from you, from an agent or from a worker reporting
  back. You see "This project is paused" and your draft is kept.
- no new thread starts with work in it. An empty conversation can still be opened.
- scheduled tasks for the project do not run. Each attempt is recorded as failed with the reason.

Resuming does not restart anything by itself. Send a thread a message to continue it. A worker's
report that arrived while the project was paused is delivered to the coordinator after you resume.

An agent can pause or resume a project through `t3_project_update`. That closes the project to new
work but does not interrupt threads already running; use the overview to stop those too.

## Project icons

Select the project and open Project to choose an icon, emoji, monogram, or image. The choice applies to
every checkout in the project group and appears on connected clients. Choose **Automatic** to let
CodeWrench detect an icon again.

Choose **Monogram** in the icon picker to set one or two letters or numbers and a color.

When no image is found, web and desktop show a two-character monogram with a color
from the icon palette, derived from the saved project name. For example, `Nebula` becomes `NA`,
`Silver Orchard` becomes `SO`, and `M7 Forge` becomes `M7`.

## Keep the default branch current

In Source Control, enable **Automatically pull** to keep the default-branch checkout up to date
with its configured upstream. Choose an environment to set the default or a project to override it.
On mobile, use **Settings → Source control** to change selected environment defaults or project overrides.

CodeWrench only pulls when it can fast-forward and the checkout has no changed files, untracked files,
or local commits. It skips checkouts on another branch or without an upstream. If a checkout has
local work, resolve it yourself before automatic pulls can resume.
