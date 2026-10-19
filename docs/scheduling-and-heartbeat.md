# Scheduling and the heartbeat

Tropos can work while you're away. **Scheduled jobs** run a prompt on a schedule ("every weekday at 9, summarise the
open PRs in my-app") and send you the result. The **heartbeat** looks over your journal, your scheduled runs and your
heartbeat list now and then, and messages you on Telegram only when something needs you today. Both run in the
background service, so it has to be running (`tcode status`).

## Scheduled jobs

### Creating a job

The easiest way is to ask, in a session, the dashboard or Telegram:

> Every weekday at 9, summarise the open pull requests in my-app and send them to me.

The agent shows the job (name, schedule, project, where the result goes) and asks you to approve it. A job made in a
chat delivers to that chat by default.

Or in the dashboard, **Schedule** → create a job. Or on the command line:

```bash
tcode cron add --name "PR summary" --schedule "every weekday at 09:00" \
  --prompt "Summarise the open pull requests" --project my-app --deliver telegram:<chat id>
```

### Schedules

| You write | Means |
|---|---|
| `every 30m`, `every 2h`, `every hour`, `every minute` | A fixed interval (at least one minute) |
| `every day at 09:00` | Every day at that time |
| `every weekday at 9:30`, `every weekend at 10am` | Monday to Friday, or Saturday and Sunday |
| `every monday at 8:00` | That day of the week |
| `in 20m` | Once, 20 minutes from now |
| `at 2026-10-20T10:00` | Once, at that date and time |
| `0 9 * * 1-5` | A 5-field cron expression (minute, hour, day of month, month, day of week) |

Times without a zone are in this computer's time zone, or the one given with `--tz` (for example `--tz Europe/Athens`).

### How a job runs

- Each run is a fresh session in the job's project, at that project's [autonomy level](autonomy-and-sandbox.md),
  confined like a chat.
- A run has nobody to ask, so whatever would still ask is denied, unless the job lists a rule for it:
  `--allow "Bash(npm test:*)"` (repeatable; shell command rules only). A job made in a guest's chat gets no such
  rules: its prompts are the guest's words.
- A run may take up to 15 minutes. At most two jobs run at the same time.
- The result is delivered to the job's chat as `<name>: <result>` (or `<name>: failed (<reason>)`), or nowhere when
  `deliver` is `none`. The first 500 characters are kept with the run's record.
- A run that was due more than 6 hours ago (for example while the computer was off) is recorded as **missed**
  instead of being run late; a more recent one runs when the gateway is back.
- Run statuses: `ok`, `error`, `timeout`, `skipped`, `missed`.

Scheduled runs act with their own role, `scheduled`: they don't see your notes or journal, aren't learned from, and
never get the owner's rights. Without a sandbox on this machine they need Docker. See [Security](security.md#roles).

### Managing jobs

```bash
tcode cron list                   # all jobs (--json for scripts)
tcode cron status                 # whether the gateway runs, and when each job fires next
tcode cron runs <id> -n 20        # a job's recent runs
tcode cron run <id>               # make it due now; the gateway runs it at its next tick
tcode cron disable <id>           # turn it off (enable to turn it on again)
tcode cron rm <id>                # delete it
```

Ids can be shortened to any unique prefix. The dashboard's Schedule page does all of this, including editing a job.
Jobs are stored in `~/.tropos/gateway/cron/jobs.json`.

## The heartbeat

The heartbeat is a short, read-only check the gateway runs now and then in your default workspace. It reads:

- today's and yesterday's journal entries, from every project;
- the recent results of your scheduled jobs;
- your **heartbeat list**: the items under `## Heartbeat` in `~/.tropos/workspace/AGENTS.md`.

If something deserves your attention today, it sends you one message on Telegram; otherwise it stays silent. It only
ever messages the owner, never acts on anything, and runs with the `scheduled` role.

### When it runs

| Setting | Default | Range |
|---|---|---|
| On or off | On while Telegram is connected | |
| Active hours | 09:00 to 21:00 (nothing is sent outside them) | Any `HH:MM` to `HH:MM`; a start after the end crosses midnight |
| Check every | 4 hours | 1 to 24 hours |
| At most per day | 1 message | 0 to 3 |

Change these in the dashboard (Settings → Suggestions: "Message me on Telegram when something needs me", Active
hours, Check every, At most per day), by asking ("only message me between 10 and 18", "stop messaging me"), or in
`~/.tropos/gateway.json` under `proactive`:

```json
{ "proactive": { "enabled": true, "activeHours": { "start": "09:00", "end": "21:00" }, "everyHours": 4, "maxPerDay": 1 } }
```

### The heartbeat list

Tell the agent what to keep an eye on, and it adds it to the list:

> Keep an eye on whether the nightly backup job fails.

> Remind me if a PR on my-app has been waiting for my review for more than two days.

Or edit the `## Heartbeat` section of `~/.tropos/workspace/AGENTS.md` yourself, one `- item` per line. The list is
kept short (about 2,200 characters).

## Troubleshooting

- **A job didn't run.** `tcode cron status` shows whether the gateway runs and when the job is due next;
  `tcode cron runs <id>` shows `missed`, `error` or `timeout` with the reason. Start the service with
  `tcode gateway start` (or install it with `tcode gateway install`).
- **"can't read schedule …".** Use one of the forms in the table above, or a 5-field cron expression.
- **A run ended with a denied command.** Runs can't ask you. Add a rule for that command to the job (`--allow`, or
  edit the job in the dashboard), or raise the project's autonomy level.
- **I get no heartbeat messages.** Check that Telegram is connected and has an owner, that the current time is within
  the active hours, and that the daily limit isn't 0. It only writes when something needs you.
- **Too many messages.** Lower "At most per day", narrow the active hours, or say "stop messaging me".
