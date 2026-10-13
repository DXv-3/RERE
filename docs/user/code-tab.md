# Code Tab

The Code tab runs coding CLIs side by side in real terminals, one grid per project folder. Sessions keep running when you switch tabs and reattach after a reload.

## Start A Session

Pick a workspace on the left, then choose Claude Code, Codex, Terminal, or one of your own CLIs from the toolbar. A workspace holds up to twelve terminals. Drag a pane by its handle to dock it beside another, or drop it on the middle of a pane to swap the two.

## Status

Each pane shows what its CLI is doing:

- **Working**: the agent is in a turn.
- **Needs You**: it is waiting on a permission prompt or a question.
- **Idle**: the turn ended and it is waiting for your next message.
- **Running**: a program is alive but does not report on itself.
- **Back At Shell**: the CLI exited. Relaunch starts it again.

Claude Code reports every change. Codex reports the end of a turn and approval requests, so it reads Running while it works. Claude Code's "do you trust this folder" screen also reads Running, because it appears before the agent starts.

Status is set up per launch. Your own CLI settings files are not changed.

## Dashboard

Dashboard lists every session in every workspace, with the ones waiting on you first. Choose a row to jump to that pane.

## Launch A Team

Launch Team starts up to six agents at once. Give each a role, write a task for everyone, and optionally give an agent its own task. You can also describe the team in a sentence, typed or dictated, such as "a builder and two reviewers on the login bug with separate worktrees"; it fills in the form and nothing starts until you press Launch.

Separate Worktree And Branch Per Agent gives each agent its own copy of the repository on its own branch, so agents cannot overwrite each other. It needs a git repository with at least one commit. Closing such a pane asks whether to keep or remove the worktree. A worktree with uncommitted changes is never removed, and its branch is always kept.

## Tasks

Tasks is a board per workspace with To Do, In Progress, Review and Done. Hand a card to a pane to send it as that agent's next message. The card moves to Review when the agent's turn ends; Done is yours to set. The board is saved on this device and only advances while the Code tab is open.

## Broadcast, Layouts And Notes

Broadcast sends one line to the panes you tick, and skips any that are waiting on you. Layouts saves the current arrangement to reopen later with fresh sessions. Notes is a scratchpad saved with the workspace.
