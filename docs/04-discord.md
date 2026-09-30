# Discord

teapilot is available in Discord!

- Ping `@teapilot`, use `/prompt`, or summon to a message from the context menu.
- Use `discord.play` to create playable games using Discord emojis and Components, with support for multiplayer and user collaboration.

```sh
teapilot discord setup    # interactive setup, saves to your profile's .env
teapilot discord start    # runs in this terminal until Ctrl+C
teapilot discord status   # shows your settings
teapilot discord remove   # deletes the Discord settings from the profile
```


## How it works

teapilot only runs while `teapilot discord start` is open. It connects outbound to Discord, so there is no public URL, tunnel or webhook to set up, and the terminal logs each task, approval and result.

- Each DM is one session.
- In the channels you configure, @mentioning the bot starts a thread, and that thread is one session. Follow-ups in the thread don't need a mention.
- One task runs at a time. Other conversations wait and are told they are queued.

Messages, answers, file paths, approval details and tool progress pass through Discord's servers. Models run wherever your profile sends them.

## Who can use it

teapilot ignores bots and anyone you have not let in.

| Role | Can |
| --- | --- |
| Operators | Everything, including approving actions. Set during setup. |
| Users | Inference, web search and `discord.play`. |

Operators add users and grant extra access by asking teapilot, for example "let <@id> in" or "give <@id> code access for 2 hours". Each change needs an operator's approval, and timed access expires on its own.

## Access and approvals

Access works as in the CLI. Sessions start in `ask` mode at the configured repository root, `/mode code` asks for repository access, and shell commands and large overwrites always ask.

Approvals are **Approve** / **Deny** buttons that only operators can click. There is no auto-approve. Unanswered approvals are denied after 10 minutes, or when teapilot stops.

## Setup

`teapilot discord setup` walks through these steps. Run `teapilot setup` first; it needs an existing profile.

1. At <https://discord.com/developers/applications>, create an application. Open **Bot**, click **Reset Token**, and copy the token.
2. On the same page, enable **Message Content Intent**.
3. Paste the token. teapilot asks before contacting Discord to check it.
4. Enter the operators' Discord user IDs. To copy one, enable Developer Mode (Settings → Advanced), right-click the user, and choose **Copy User ID**.
5. Optionally, add channel IDs where @mentions should work. With none, teapilot answers DMs only.
6. Choose the repository root. It defaults to `--cwd`.
7. Open the printed invite link to add the bot to a server. Discord only delivers DMs from people who share a server with the bot.

Settings are stored as `DISCORD_*` values in the profile's private `.env`. The token is redacted from logs and messages.

## In a conversation

All the [session commands](02-commands.md#interactive-use) work, except:

- `/stop` cancels the running turn. Edits already made remain on disk.
- `/convo clear` clears the conversation. If the workspace has files, a button offers to clear them too. `/new` clears both.
- `/convo grants` posts the conversation's access as buttons: green is granted, grey is not. Press one to revoke it or ask for it; anyone other than an operator needs an operator's approval.
- `/cd` is unavailable. Change the root with `teapilot discord setup`.
- `/btw` at the start of a message asks a side question. The answer is public in a message, and only visible to you through `/prompt` or `/reply`, with a menu to post it as is, compactly behind a button, or summarised.
- `/plan` at the start of a message asks for an implementation plan, and `/rfc` for a design proposal. Nothing is changed until you say "go ahead". A plan arrives as an embed with buttons to approve it, assign juniors, or request a change; the embed updates as the plan is refined.

Messages sent during a turn are queued as your next message. Long answers are split across messages.

Files you attach to a message (up to 5, 10 MB each) stay in the conversation's workspace. There teapilot runs sandboxed commands (ffmpeg, ImageMagick, pandoc, yt-dlp, Python with Pillow and numpy, Node) to convert or edit them, can run an attached app, and sends files back as attachments. Installing a package asks an operator first. `teapilot doctor` shows whether the sandbox is ready and offers to install pandoc and the Python packages. Files on messages answered through the Reply menu are ignored.

## Interactive apps

Ask for a game, poll or quiz and teapilot posts one message with buttons, menus and forms that it updates in place. Anyone in the channel can use it unless you say who it is for. Apps survive restarts and end after a day without activity.

## Outside DMs and configured channels

Operators and users can reach teapilot from any channel:

| Use | For |
| --- | --- |
| `/prompt` | Ask something, optionally choosing the `mode` and `reasoning`, attaching up to four files, or setting `yolo` to approve every action it asks for (operators only) |
| `/reply` | Ask something |
| `/collab join` | Send your `/prompt` and `/reply` to a conversation everyone in the channel shares. `/collab leave` goes back to your own, and `/collab fork` leaves with a copy of it |
| Right-click a message → **Apps → Reply** | Have teapilot respond to that message |

With the Reply menu, only the answer and approvals are posted; progress and results go to the terminal.

Where the bot can post, it starts a thread, and that thread is one session. Otherwise it answers through the interaction, which has limits:

- There are no threads. Run the command again to continue; teapilot remembers your conversation in that channel until you `/convo clear` it.
- It stops after 15 minutes, when Discord expires the interaction. Pending approvals are denied.
- There is no typing indicator.

To use teapilot in servers without the bot, enable **Installation → User Install** in the Developer Portal, then install the app to your account from its install link.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "Discord refused the Message Content intent", or messages arrive empty | Enable Message Content Intent (step 2). |
| "Discord rejected the bot token" | Reset the token and rerun `teapilot discord setup`. |
| DMs get no reply | Check that you are an operator or have been let in, and that you share a server with the bot. |
| Mentions in a channel get no reply | Add the channel in `teapilot discord setup`. The bot needs View Channel, Send Messages, Create Public Threads and Send Messages in Threads. |

To keep teapilot always on, run `teapilot discord start` under your own service manager.

[Back to README](../README.md)
