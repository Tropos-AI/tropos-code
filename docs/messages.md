# Texts on your Mac

On a Mac, Tropos can read your texts (iMessage and SMS in the Messages app) and send them for you: "who texted me
today?", "what did Nikos say about the invoice?", "tell Maria I'm 10 minutes late". It is off until you turn it on, it
only works on macOS, and every text it sends shows you the recipient and the exact words first.

Texts stay on your computer, except what you send and what the model sees while it answers you. Everything it reads
is treated as data written by other people, never as instructions.

## Turn it on

Texts are off by default. Turn them on in any one of these ways:

- **Dashboard:** Settings → Channels & devices → the **Texts** card.
- **Setup:** `tcode onboard` has a "Texts" step (macOS only).
- **Ask the agent:** "let yourself read my texts". Like every setup change, it asks first.
- **By hand:** set `"messages": true` in `~/.tropos/settings.json`.

Only your own settings can switch it on. A repository's `.tropos/settings.json` can't, so a cloned project can't
reach your texts.

## Set up macOS

Reading and sending need two permissions from macOS. Tropos creates a small helper app for them, called **Tropos
Messages Helper**, on your Mac the first time you turn texts on. macOS gives permissions to that helper instead of to
`tcode`, so you don't have to grant them again after each Tropos update.

1. **Create the helper.** Turning texts on does this. Nothing to do.
2. **Full Disk Access.** Open System Settings → Privacy & Security → Full Disk Access and switch on **Tropos Messages
   Helper**. The dashboard and setup have a button that opens the pane, and move on by themselves once it is on. This
   lets the helper read your Messages history. If the helper isn't listed, see
   [Troubleshooting](#troubleshooting).
3. **Control Messages.** macOS asks "Tropos Messages Helper wants to control Messages" the first time a text is sent.
   To see the question now rather than in the middle of a task, use **Test Messages access** on the Texts card.
   Choose Allow.

Messages must be signed in to iMessage on this Mac. You don't need to keep it open. **Test Messages access** also
checks that Messages is signed in, and Tropos remembers the answer, so the dashboard and `tcode doctor` show it
later too.

The helper keeps its permissions across Tropos updates. On the rare release that ships a new helper version, Tropos
rebuilds it and you switch Full Disk Access on again. If you delete the helper or move it to the Trash, Tropos
creates it again the next time it is used, and you repeat the steps.

`tcode doctor` has a "Texts (Messages)" check that shows which step is missing.

## What you can ask

The agent has a `Messages` tool for reading and a `SendIMessage` tool for sending.

| You ask | It does |
|---|---|
| "Who texted me today?" | Lists the chats with new messages, who wrote last and the start of what they wrote |
| "What did Nikos say about the invoice?" | Searches your texts, then reads around the match |
| "Show me the last 20 messages with the plumber" | Reads one conversation |
| "Find Maria's number" | Looks her up in your Contacts |
| "What picture did Anna send?" | Looks at an image attachment |
| "Tell Maria I'm 10 minutes late" | Finds her number and asks you before sending |

Names come from the chat itself and from your Contacts. If Contacts can't be read, it still works with numbers.
Long results are cut off with a hint to ask for the next page. It reads through a read-only copy of the Messages
database, so Messages itself is never changed. Copies sit outside what Full Disk Access protects, so none is kept
longer than needed: a copy of the database is deleted 30 seconds after it was made (or when the read using it ends, if later), and a copied attachment as
soon as it has been looked at. Attachments that the database already says aren't images are described without
copying them.

## Sending

Every text asks first, in the terminal, the dashboard or Telegram. The prompt shows who it goes to and the exact text.

- **Allow** sends this one text.
- **Always allow** saves a rule for that one person, such as `SendIMessage(+306912345678)`. It is listed with your
  other rules and you can remove it there. The same person written differently (`+30 691 234 5678`, `6912345678`)
  matches the same rule, and email addresses match whatever their case.
- **Autonomy levels never send on their own.** Ask, Balanced and Autonomous all still ask. Only your click or a rule
  for that recipient lets a text through.
- **Bypass mode, and a bare `SendIMessage` or `SendIMessage(*)` allow rule, send without asking** in your own
  sessions, to anyone. Only the burst guard's hard limit still applies. Prefer one rule per person.
- **Plan mode blocks sending.**
- **Telegram shows at most 1500 characters of a text in its prompt.** A longer text can't be approved there, since
  you couldn't see all of it; it is denied, and you approve it in the terminal or the dashboard instead.

The text is passed to Messages as it is, so quotes, line breaks, emoji and Greek arrive unchanged. It goes by iMessage,
or by SMS when that person's chat with you is an SMS chat or iMessage can't reach them.

### Did it arrive?

After sending, Tropos checks the Messages database and the agent tells you which of these it saw:

- **Sent to Maria: delivered.**
- **Sent to Maria; Messages shows it as not delivered yet.** Messages has it but hasn't confirmed delivery.
- **Messages hasn't recorded the text yet, so it may not have gone.** Check Messages yourself before trying again.
- If Tropos stopped waiting for Messages, it says so and does not send the text again.

### The burst guard

A rule can't turn into a flood. Even with "always allow", Tropos asks you again after 5 texts to one person in 10
minutes, or 20 texts in an hour. It refuses outright at 10 to one person in 10 minutes, or 40 in an hour, and tells
the agent to wait a while. The counts are kept by each running Tropos process (the terminal and the gateway count
separately) and start again when it restarts.

## Who can use it

| Who | Read texts | Send texts |
|---|---|---|
| You: terminal, dashboard, your private Telegram chat | yes | yes, with approval |
| Guests (anyone else you approved on Telegram) | never | never |
| Specialists and subagents | no; the agent you talk to can pass along what they need | no |
| Scheduled jobs | only if the job lists `Messages` | only if the job lists `SendIMessage(<number or email>)` |
| The heartbeat | no | no |

A scheduled job has nobody to approve anything, so it is opt-in per job. The job lists what it may do in
`allowCommands`: `Messages` to read, and `SendIMessage(+306912345678)` or `SendIMessage(maria@example.com)` to send to
that one exact recipient. A pattern with `*` names nobody and never counts. A send the burst guard would ask about
again is denied. See [Scheduling and the heartbeat](scheduling-and-heartbeat.md).

### Where your texts go

- They are shown to the model you chose, so it can answer you. Like anything else you ask about, that goes to your
  provider.
- Turns that read texts are not learned from. Once a conversation has read or sent a text, the background learning
  review skips it, so other people's messages don't end up in your notes, skills or journal, not even quoted in the
  agent's own replies or in a compacted summary. (Should a review ever see such a conversation, every Messages result
  in it is withheld as well.)
- They are never written to the session search index.
- They stay in your own session history, so a conversation can continue. That folder is private to you.

## What this does not protect

- **Other programs running as you.** The helper listens for requests in a private folder,
  `~/.local/share/tropos/helpers/run/messages-helper` (beside the helper app), and any
  program that runs as your user could ask it for your texts or ask it to send one. This is the same exposure as giving
  Full Disk Access to your Terminal. A per-install key stops programs that guess blindly; it does not stop one written
  to target Tropos.
- **Hooks.** A `PreToolUse` hook you write that answers "allow" overrides the ask for a scheduled job's text. Hooks are
  your own code, so they are trusted.

To stop all of it: set `"messages": false`, or switch **Tropos Messages Helper** off in Full Disk Access.

## Troubleshooting

The agent shows these messages as they are. Run `tcode doctor` first; it shows the step that is missing.

| Message | What it means and what to do |
|---|---|
| Messages access is switched off. Ask the user to turn it on in Tropos settings. | Texts are off. [Turn them on](#turn-it-on). |
| Tropos doesn't have Full Disk Access yet, so it can't read Messages. To grant it: open System Settings, go to Privacy & Security, then Full Disk Access, and switch on "Tropos Messages Helper". | The helper isn't switched on there. After a new helper version, switch it on again. Then ask again. |
| macOS hasn't allowed Tropos to control Messages. To allow it: open System Settings, go to Privacy & Security, then Automation, and switch on Messages under "Tropos Messages Helper". | You chose Don't Allow at the macOS question. Switch it on in Automation, or use **Test Messages access** on the Texts card to be asked again. |
| Messages isn't signed in to iMessage on this Mac. Ask the user to open Messages and sign in. | Open Messages and sign in with your Apple Account. **Test Messages access** on the Texts card checks it again. |
| Messages has no history on this Mac yet. Ask the user to open Messages and sign in. | Messages was never used on this Mac, so there is nothing to read. Open Messages and sign in. |
| The Messages helper didn't answer in time. Messages may be busy or not running; try once more shortly. | Open Messages once and try again. A send that times out is not repeated automatically. |
| No such chat; use Messages action chats to find it. | The chat id or number isn't in your Messages history. Ask the agent to look the person up. |
| The Messages helper failed: … | The helper reported a problem; the detail follows the colon. Run `tcode doctor`, which can rebuild the helper if it is missing or out of date. |

The errors that say "Don't retry until the user says it's fixed" stop the agent from trying again by itself. Once you
have fixed the step, tell it.

If the helper does not appear in the Full Disk Access list, add it yourself. It lives in a hidden folder:

```
~/.local/share/tropos/helpers/Tropos Messages Helper.app
```

Click **+** under the list, press ⌘⇧G, paste that path and choose Open. Or use **Show helper in Finder** on the Texts
card and drag the app into the list. `tcode onboard` prints the path too. If the app isn't there at all, turn texts
off and on again so Tropos creates it.
