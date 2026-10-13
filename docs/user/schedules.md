# Schedules

Schedules is one list of everything on this machine that runs by itself. Open it from the Agents tab, under Schedules, beside Team Board, Check-Ins and Campaigns.

## What Is Listed

- **Scheduled tasks**: the recurring jobs made in Settings, under Scheduled Tasks, or by an agent that was asked to do something on a schedule.
- **Agent goals**: each agent's standing goals, which take a turn on their own schedule and end it with a check-in. A goal runs through a scheduled task that CodeWrench keeps in step with it, so the two show as one row.

Each row shows:

- what it does, in one line, and its name;
- who it belongs to: the agent whose conversation it runs in, or "A thread", or "No thread";
- how often it runs, such as Weekdays At 9:00 AM;
- its state: On, Running Now, Paused or Done, as words with an icon;
- **Next Run** and **Last Ran** in plain words, such as "Tomorrow at 9:00 AM" or "12 minutes ago". A run that is overdue says "Due now". A paused one says it will not run while it is paused;
- **Last Result**: Succeeded, Failed with the reason, Running now, or Has not run yet.

Rows that are running come first, then the ones that run soonest, then paused, then done.

## What You Can Do

- **Pause** and **Resume** stop and restart a row. A goal is paused through the goal, so its status in the agent's goals stays true. A goal that CodeWrench paused itself because too many check-ins are waiting says so, and resuming it works once you have reviewed them.
- **Run Now** starts the run at once without waiting for its time. The result shows in the row when the run finishes.
- **Open Thread** goes to the conversation the row runs in. A goal opens its agent.

Failures show in the row, where you pressed the button.

## What You Cannot Do Here

This list only uses what already exists, so some things stay where they were.

- Creating, editing and deleting a scheduled task is in Settings, under Scheduled Tasks. Goals are edited in the agent's own goals.
- A done goal is shown but not run. Reopen it in the agent's goals.
- A row for a goal's task that has no matching goal is listed and can be run, but cannot be paused here, because CodeWrench would switch it back on the next time the goal changes.
- An archived agent's goals are listed without actions.

## Starting One

An empty list says how: ask an agent to do it. For example: "Every weekday at 9 AM, please check on my campaigns and tell me what needs my attention. Set it up as a scheduled task." The empty list has a button that copies that request. Paste it into a thread with an agent, change the job to what you want, and the schedule appears here.

## Limits

Only this machine's schedules are listed, the ones in the environment the Agents tab is connected to. Times are shown in your own time zone.
