# whatsappBot

A WhatsApp bot that runs on a cloud VM and **automatically replies to birthday wishes** on your personal WhatsApp.

It links to the WhatsApp app on your phone (iPhone or Android) as a **Linked Device**, just like WhatsApp Web. Your phone keeps working normally, and the VM watches incoming messages and thanks people who wish you.

## Features

- Detects birthday wishes in many forms: "Happy Birthday", "HBD", "happy bday", "Many happy returns", "Janamdin mubarak", "जन्मदिन…", "Feliz cumpleaños", 🎂🥳 emoji-only messages, and your own extra keywords.
- Replies with a random template that uses the sender's name (`{name}`), after a human-like delay with a "typing…" indicator.
- Optional ❤️ reaction and read receipt on each wish.
- Replies **at most once per person per day**.
- Personal chats only by default. If you turn on group replies, it only replies when the wish is for **you**: you're @mentioned, your message is quoted, or one of `myNames` appears. If someone else in the group has a birthday, the bot stays quiet.
- Optional birthday window, so it only replies around your birthday.
- Web dashboard to link WhatsApp (QR code or pairing code), edit the config, and see recent replies.
- Config changes apply live, with no restart.

## Deploy to a VM

You need a small Linux VM (Ubuntu/Debian; 1 vCPU / 1 GB RAM is plenty), e.g. AWS Lightsail/EC2, GCP e2-micro, Azure B1s, DigitalOcean or Hetzner.

**Option A: from your computer** (needs SSH access to the VM):

```bash
git clone https://github.com/varunpra97/whatsappbot.git
cd whatsappbot
./deploy/deploy.sh ubuntu@YOUR_VM_IP            # add e.g. -i ~/.ssh/key.pem if needed
```

**Option B: on the VM itself:**

```bash
git clone https://github.com/varunpra97/whatsappbot.git
cd whatsappbot
sudo bash deploy/install.sh
```

The installer sets up Node.js 22 and copies the app to `/opt/whatsapp-bot`. It creates `config.json` with a random dashboard password (printed once; it's also in the file) and starts the `whatsapp-bot` systemd service. The service restarts on crash and on reboot. To update later, run the same command again: your config, WhatsApp session and history are kept.

## Link your WhatsApp

On your phone, open **WhatsApp → Settings → Linked Devices → Link a Device**, then use one of these:

1. **QR in the terminal:** `sudo journalctl -u whatsapp-bot -f` on the VM, then scan the QR.
2. **QR in the dashboard:** from your computer run `ssh -L 3000:127.0.0.1:3000 ubuntu@YOUR_VM_IP`, open <http://localhost:3000>, log in with any username and the dashboard password, then scan.
3. **Pairing code (no camera needed):** set `"pairingPhoneNumber": "919876543210"` (country code + number, digits only) in the config and restart (`sudo systemctl restart whatsapp-bot`). An 8-character code appears in the logs/dashboard. On the phone, tap **Link with phone number instead** and enter it.

Once linked, the session is saved in `/opt/whatsapp-bot/auth/`, so you won't need to link again. If you unlink the device from your phone, the bot clears the session and shows a new QR.

> Your phone must come online at least once every ~14 days or WhatsApp will unlink all linked devices.

## Configure

Edit the config in the dashboard, or with `sudo nano /opt/whatsapp-bot/config.json`. Changes apply on the next message.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master on/off switch. |
| `myNames` | `[]` | Your names/nicknames; a group wish containing one counts as addressed to you. |
| `birthday` | `""` | Your birthday as `"MM-DD"`. Empty means reply to wishes on any day. |
| `activeWindowDays` | `2` | Reply only within ± this many days of `birthday`. |
| `timezone` | `"UTC"` | IANA timezone, e.g. `"Asia/Kolkata"`, used for the birthday window and once-per-day. |
| `replyInPrivate` | `true` | Reply to wishes in personal (1-to-1) chats. |
| `replyInGroups` | `false` | Reply to wishes in group chats. |
| `groupRequireMention` | `true` | In groups, only reply to wishes addressed to you (see above). |
| `oncePerChatPerDay` | `true` | One reply per person per day. |
| `replyDelaySeconds` | `[5, 30]` | Random delay range before replying. |
| `maxMessageAgeHours` | `24` | Ignore older messages (e.g. backlog delivered after downtime). |
| `onlyTodaysWishes` | `false` | Only answer wishes sent today (calendar day in `timezone`), including ones caught up from history. |
| `markAsRead` | `true` | Send blue ticks for wishes. |
| `reaction` | `"❤️"` | Emoji reaction on each wish (`""` to disable). |
| `emojiOnlyCounts` | `true` | Treat messages like "🎂🎉" as wishes. |
| `extraKeywords` | `[]` | Extra phrases that count as wishes, e.g. `"pirandhanaal vazhthukkal"`. |
| `ignoreNumbers` | `[]` | Never reply to these numbers (country code + number). |
| `onlyNumbers` | `[]` | If non-empty, reply only to these numbers. |
| `replies` | 3 templates | Private-chat replies; `{name}` = sender's first name, `{fullName}` = their WhatsApp name. |
| `groupReplies` | 1 template | Group replies (sent as a quoted reply). |
| `replyImage` | `""` | Image to send in 1:1 chats, with the chosen reply as its caption, e.g. `"media/thank-you.jpg"` (relative to the bot folder) or an absolute path. Falls back to text if the file is missing. |
| `catchUp.enabled` | `false` | Also answer older wishes you haven't replied to (see below). |
| `catchUp.lookbackHours` | `72` | How far back catch-up looks. |
| `catchUp.maxReplies` | `30` | Most old wishes answered per run, so a backlog doesn't go out all at once. |
| `pairingPhoneNumber` | `""` | Link by pairing code instead of QR. |
| `web.enabled` / `web.port` | `true` / `3000` | Dashboard. Disabled until `web.password` is set. |
| `web.host` | `"127.0.0.1"` | Keep this, and reach the dashboard via an SSH tunnel. Use `"0.0.0.0"` only behind HTTPS (the dashboard uses Basic auth). |

## Replying with an image

Put the image in a `media` folder inside the bot folder (it's git-ignored) and point the config at it:

```bash
mkdir -p media && cp ~/Downloads/thank-you.jpg media/
```
```json
"replyImage": "media/thank-you.jpg",
```

1:1 chats then get the image with one of your `replies` as the caption. To send the image with no text, use `"replies": [""]`. Group replies stay text-only.

## Answering older wishes (catch-up)

With `"catchUp": { "enabled": true }` the bot also answers wishes from the last `lookbackHours` that nobody replied to:

- **Wishes that arrived while the bot was off** are delivered when it reconnects and get answered.
- **Chat history from before the bot was linked:** WhatsApp sends recent history only once, at the moment you link. To scan it, enable catch-up first and then link (or re-link: stop the bot, `rm -rf auth`, start it and scan again).

The bot also saves the last 48 hours of incoming 1:1 text messages in `data/recent-messages.json` and re-checks them every time it starts, so after an update or config change you only need to restart (not re-link) to pick up wishes it missed before. Each history scan prints the wishes it did not answer and why.

A wish is skipped if you have already sent anything in that chat after it, so wishes you answered by hand don't get a second reply. Old wishes are answered one at a time, with the normal `replyDelaySeconds` gap between them; new wishes go first.

## Useful commands

```bash
sudo systemctl status whatsapp-bot      # is it running?
sudo journalctl -u whatsapp-bot -f      # live logs (QR, wishes, replies)
sudo systemctl restart whatsapp-bot     # restart
sudo systemctl stop whatsapp-bot        # pause the bot
```

WhatsApp library logs are hidden by default. To see them when debugging, start with `BAILEYS_LOG_LEVEL=warn npm start`. Occasional `failed to decrypt message` / `Bad MAC` entries there are normal: the library asks the phone to resend and recovers.

## Docker (alternative)

```bash
docker build -t whatsapp-bot .
mkdir -p state && cp config.example.json state/config.json   # set "web.host": "0.0.0.0" inside Docker
docker run -d --name whatsapp-bot --restart unless-stopped -v "$PWD/state:/app/state" -p 127.0.0.1:3000:3000 whatsapp-bot
docker logs -f whatsapp-bot   # scan the QR
```

## Local development

```bash
npm install
cp config.example.json config.json
npm start      # prints a QR in the terminal
npm test       # birthday-detection tests
```

## Notes

- This uses [Baileys](https://github.com/WhiskeySockets/Baileys), an unofficial WhatsApp Web client. Automating a personal account is against WhatsApp's Terms of Service, and accounts can be restricted. Keep the volume low and human-like (the default delays and once-per-day limit help), and use it at your own risk.
- WhatsApp's official Business API can't read your personal chats, which is why this bot uses the Linked Devices approach.
- iOS doesn't let third-party apps read or send WhatsApp messages on the phone, which is why the bot runs on a VM.
