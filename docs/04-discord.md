# Discord (optional)

Chat with teapilot on your computer from Discord: in DMs, or by @mentioning the bot in one channel. Discord is opt-in and separate from `teapilot setup`; nothing is configured, installed or contacted unless you run the commands below.

For a source checkout, replace `teapilot` with `npm start --`.

```sh
teapilot discord setup    # guided, opt-in; saves to your profile's private .env
teapilot discord start    # runs in this terminal until Ctrl+C
teapilot discord status   # shows settings (never the token); optional token check
teapilot discord remove   # deletes the Discord settings from the profile
```

## How it works

- **teapilot only runs while `teapilot discord start` is open.** It connects outbound to Discord's Gateway: no public URL, tunnel, webhook or local server. The terminal logs each incoming task, approval and result.
- **Only people you have let in can use it.** Messages from anyone else, and from bots, are ignored without a reply.
  - **Operators** (the IDs from setup) have every permission and can approve actions.
  - **Users** get inference and web search. Operators add users, and give them extra permissions for a limited time (for example "let <@id> in", or "give <@id> code access for 2 hours"), just by asking teapilot in Discord. Each change needs an operator's Approve click, and grants expire on their own.
- **Where it listens:**
  - Each DM is one session.
  - If you configured a channel, @mentioning the bot there starts a thread, and that thread is one session. Follow-ups in the thread don't need a mention.
- **Access is the same as in the CLI.** Sessions start in `ask` mode at the configured repository root.
  - `/mode code` asks for repository access.
  - Shell commands and large overwrites always ask.
  - Approvals are **Approve / Deny** buttons that only operators can click. Unanswered approvals are denied after 10 minutes, and when teapilot stops.
  - There is no auto-approve.
- **One task runs at a time.** A second conversation waits and is told it is queued. Each conversation keeps its own history and access.
- **Messages go through Discord's servers,** and so do answers, file paths, commands shown in approvals and tool progress. Model execution stays wherever your profile sends it.

## Setup

`teapilot discord setup` walks through these steps. It needs an existing profile, so run `teapilot setup` first.

1. At <https://discord.com/developers/applications>, create an application. Open **Bot**, then **Reset Token**, and copy the token.
2. On the same page, enable **Message Content Intent** under Privileged Gateway Intents.
3. Paste the token. It is hidden while you type. teapilot asks before contacting discord.com to check it, and warns if the intent is off.
4. Enter the Discord user IDs of the operators. To copy one, enable Developer Mode (Settings → Advanced), right-click the user, and choose **Copy User ID**.
5. Optionally, enter a channel ID for @mentions. Press Enter for DMs only.
6. Choose the repository root. It defaults to `--cwd`.
7. Confirm, then open the printed invite link to add the bot to a server you share with the people who will use it. Discord only delivers DMs from people who share a server with the bot.

Settings are stored as `DISCORD_*` values in the profile's private `.env`, which has the same file protection as your other credentials. The token is redacted from logs and messages.

## In a conversation

All the [session commands](02-commands.md#interactive-use) work, with these differences:

- `/stop` cancels the running turn. Edits already made remain on disk.
- `/exit` ends the conversation. Your next message starts a new session.
- `/cd` is unavailable, because the root is fixed. Change it with `teapilot discord setup`.
- Messages sent while a turn runs are queued as your next message.

Long answers are split across several messages. Only text is read; attachments are ignored.

## `/reply` and the Reply menu

Allowlisted users can also talk to teapilot outside DMs and the configured channel:

- `/reply message:<text>` asks teapilot something in the current channel.
- Right-click a message → **Apps → Reply** makes teapilot respond to it. teapilot receives the text prefixed with the author's username (`Message from @name:`).

With the Reply menu, only teapilot's answer and any approval buttons go to Discord; progress, queue notices and result lines go to the terminal running `teapilot discord start`.

Where the bot can post, it starts a thread on your prompt or on the selected message, and that thread is one session. Where it can't (no Send Messages permission, or the bot is not in the server at all), it answers through the interaction itself. That needs no channel permission, but it has limits:

- **Each use is a one-shot conversation.** There are no threads and no follow-ups; run `/reply` again for the next question.
- **It stops after 15 minutes,** when Discord expires the interaction. Pending approvals are denied.
- **There is no typing indicator.**

For servers where the bot is not installed, enable **Installation → User Install** in the Developer Portal (and keep the *applications.commands* scope), then install the app to your account from its install link. Without it, `teapilot discord start` logs a registration warning and registers server-install commands only.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "Discord refused the Message Content intent" on start | Enable Message Content Intent (step 2) and retry. |
| The bot gets messages but they arrive empty | Same as above. |
| DMs get no reply | Check that you are an operator (`teapilot discord status`) or that an operator has let you in and that you share a server with the bot. |
| Mentions in a channel get no reply | Check the configured channel ID. The bot also needs View Channel, Send Messages, Create Public Threads and Send Messages in Threads there. |
| "Discord rejected the bot token" | Reset the token and rerun `teapilot discord setup`. |

Keeping it running: `teapilot discord start` is a normal foreground process. If you want it always on, run it under your own service manager.

[Back to README](../README.md)
