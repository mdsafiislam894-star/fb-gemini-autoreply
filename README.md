# ZEVIAN — Facebook Page AI Assistant

ZEVIAN is a Node.js webhook service for a Facebook **Page** Messenger integration. It uses Gemini for ordinary replies and Telegram for owner review and control.

## Current deployment

- Runtime: Node.js 18+
- Start: `npm start`
- Health: `/health`
- Facebook webhook: `/webhook`
- Dashboard: `/` (read-only live status; owner actions remain in Telegram)
- Render blueprint: `render.yaml`

## Required Render environment variables

Set these in Render → service → Environment. Never commit secret values to GitHub or share them in chat.

| Variable | Purpose |
|---|---|
| `FB_PAGE_ACCESS_TOKEN` | Facebook Page access token used for Graph API calls |
| `FB_APP_SECRET` | Meta App Secret used to verify `X-Hub-Signature-256` |
| `FB_VERIFY_TOKEN` | Private string used during webhook subscription verification |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token |
| `TELEGRAM_ADMIN_CHAT_ID` | Only Telegram chat allowed to use owner commands |
| `GEMINI_API_KEY` | Google Gemini API key |
| `GEMINI_MODEL` | Preferred Gemini model; defaults to `gemini-3.5-flash-lite` if blank |
| `PORT` | Supplied by Render; local fallback is 3000 |

The Render blueprint declares secret values with `sync: false`; it does not contain credentials. Confirm all required values exist in the Render dashboard before deployment. Existing dashboard values should be preserved.

## Meta webhook setup

1. Configure the Meta app's Messenger product for the Facebook Page.
2. Set callback URL to `https://YOUR-RENDER-SERVICE.onrender.com/webhook`.
3. Use the exact value stored in `FB_VERIFY_TOKEN` as the webhook verify token.
4. Subscribe the Page to the required messaging events.
5. Keep `FB_APP_SECRET` set. The service now rejects POST webhook requests if the App Secret is missing, the signature header is malformed, or the HMAC signature does not match.
6. Use only supported Page messaging permissions and comply with Meta's messaging window and app review requirements.

## Telegram owner security

Owner commands fail closed: if `TELEGRAM_ADMIN_CHAT_ID` is blank, no Telegram chat is authorized. Set it to the numeric chat ID of the owner. Do not use a username as a substitute.

## Current limitations / operational notes

- Conversation history, pending replies, owner statuses, FAQ entries, block list, and counters are currently held in process memory. A restart or redeploy clears them. This repository does **not** yet implement durable database storage.
- The included dashboard is read-only and polls `/health`; Telegram remains the control surface.
- The current webhook code handles Page messaging and selected feed-comment events. Verify all Page permissions and event subscriptions in Meta before relying on production traffic.
- Free hosting plans can sleep or restart and may have usage limits. Do not treat this service as guaranteed 24/7.
- The service must not be used to automate a personal Facebook profile inbox.

## Local development

```bash
npm install
cp .env.example .env
# Fill the required values in .env locally; never commit .env
npm start
```

A safe `.env.example` template is included. Replace the blank values locally and keep the real `.env` file untracked.

## Security and reliability changes through v4.7

- Removed the insecure fallback webhook verify token.
- Enforced fail-closed Meta webhook signature verification.
- Enforced fail-closed Telegram owner authorization.
- Added startup warnings for missing security configuration.
- Migrates restricted `gemini-2.5-*` configuration to `gemini-3.5-flash-lite`, then falls back to `gemini-3.1-flash-lite` and `gemini-3.6-flash`.
- Uses a timeout, structured JSON validation, and API-key request headers for Gemini calls.
- Adds a deterministic personal-question privacy gate before Gemini to prevent an AI reply from following an owner-escalation acknowledgement.
- Enforces at least one context-appropriate emoji on user-facing page, owner-approved, fallback, and comment replies.
- Improves Romanized Bengali detection, pronoun mirroring, and script-aware owner fallback suggestions.
- Runs `node --check server.js` before the service starts.


## Health endpoint diagnostics

The `/health` response reports `geminiStatus` as `not_tested`, `ready`, or `error`. A fresh process starts as `not_tested`; this is not the same as a failed Gemini request. Run `/testgemini` in the authorized Telegram owner chat to test the live API key and model chain.


## ZEVIAN v4.8 — Presence, reminders and relationship profiles

### Owner presence
- `/online`: set the owner presence to online. Personal questions without a directly relevant approved status are routed to the owner for approval in Telegram.
- `/offline`: set the owner presence to offline. Personal questions receive a transparent, language-matched offline response rather than being left unanswered.
- Presence defaults to offline after a process restart; explicitly send `/online` when available.

### Owner reminders
- ZEVIAN recognizes explicit requests to pass along a message, ask the owner to call someone, or remind the owner about a schedule/important message.
- It creates a task with a unique ID (for example `TK-201`) and source sender/message.
- `/tasks` lists open reminders; `/done TK-201` marks one complete.
- `/online` surfaces open reminders to the owner.

### Contact relationship profiles
- `/tag PSID wife` (or `bou`, `বউ`, `partner`) marks a contact as an owner-designated wife/partner profile.
- The assistant uses a warm, affectionate, natural style for that contact and may send at most one optional follow-up after a reply, with a six-hour per-contact cooldown and only inside Meta's standard 24-hour messaging window.
- `/tag PSID friend` or another label sets a custom label; `/untag PSID` removes it; `/tags` lists tagged contacts.
- Relationship tone does not authorize ZEVIAN to invent the owner's location, plans, food, or decisions, or to impersonate the owner.

### Important persistence limitation
Presence, reminders, relationship tags, conversations, and pending replies are currently in process memory. They are lost on a Render restart/redeploy. Durable storage is a separate required upgrade before relying on reminders as the only copy of important information.


## ZEVIAN v4.9 — Encrypted persistent memory

### What is persisted
When PostgreSQL is configured, ZEVIAN stores the complete application state snapshot, including owner presence, reminders/tasks, contact relationship profiles, active statuses, pending replies, conversations, FAQ/knowledge base, block list, and counters. State is restored before Telegram polling and the HTTP server start.

### Required environment variables for durable mode
- `DATABASE_URL`: PostgreSQL connection URL.
- `STATE_ENCRYPTION_KEY`: a long random secret used to derive the AES-256-GCM encryption key.
- `DATABASE_SSL`: set to `true` only if the database provider requires TLS.

Generate the encryption secret locally with `openssl rand -base64 48`. Put both values in Render → ZEVIAN service → Environment. Never send them in chat or commit them to GitHub. Back up the encryption key securely: losing it makes existing encrypted snapshots unreadable.

The application creates `zevian_state` automatically. The matching SQL migration is in `migrations/001_encrypted_state.sql`. State snapshots are encrypted before they are written to PostgreSQL. The service flushes changes periodically and again during graceful shutdown.

### Persistence health
`GET /health` now includes a `persistence` object with enabled/connected/encrypted/lastSavedAt/error fields. If `DATABASE_URL` or `STATE_ENCRYPTION_KEY` is missing, the service explicitly remains in memory-only mode; do not rely on reminders or saved profiles until `enabled=true` and `connected=true`.

### Database cost and retention warning
Do not use a temporary database for important personal reminders. Render's Free Postgres database expires 30 days after creation, has no backups, and is intended for testing rather than production. Use a durable PostgreSQL plan/provider and keep independent backups. See [Render free instance limitations](https://render.com/docs/free).

### Reminder upgrades
- Tasks capture source sender/message, priority, inferred due time for common Bangla/Banglish/English date phrases, and completion/snooze/archive metadata.
- `/snooze TK-201 1h`, `/snooze TK-201 1d` postpone reminders.
- `/delete_task TK-201` archives a task without deleting its audit context.
- `/done TK-201` marks a task complete.


## ZEVIAN v5.0 — Smart Offline Assistant

### Direct offline message relay
- Clear requests such as “Safire Bole Dibi J Kalke Sir College a Jaite Bolche”, “সাফিকে বলে দিও কাল স্যার কলেজে যেতে বলেছেন”, or “Please tell Safi to call me tomorrow” are handled deterministically before the personal-question approval gate.
- ZEVIAN acknowledges the sender directly, creates a task, and sends the owner a Telegram task notification. It does not ask the sender to wait for Owner approval for a clear relay request.
- Tasks retain sender, original message, priority, due date, and reminder delivery state.
- If a date is stated but no clock time is given, ZEVIAN uses a clearly disclosed default reminder time of 9:00 AM Asia/Dhaka. If no date is stated, it does not invent one; the task remains visible in `/tasks` without a scheduled due notification.
- Explicit clock times are interpreted in Asia/Dhaka. For example, “kalke 10:30 e” means 10:30 AM on the next local calendar day.
- Due reminders are delivered to the authorized Telegram owner chat. Failed sends retry with bounded backoff. A crash between Telegram accepting a message and ZEVIAN persisting its delivery status can still cause a duplicate reminder; Telegram's send API does not provide an idempotency key for this flow.

### Wife-only proactive Messenger messages
- Proactive Messenger messages are allowed only for a contact explicitly marked with `/tag PSID wife` (which sets both `relationship=wife` and `affectionate=true`).
- Friends, untagged contacts, and other relationship labels are never eligible for proactive Messenger messages.
- The AI may schedule one natural follow-up 10 minutes after a reply when the conversation context makes it useful. The schedule is persisted in the encrypted state snapshot, canceled by a newer inbound message, and subject to a six-hour per-contact cooldown.
- A proactive message is sent only while the most recent inbound message is still inside Meta's standard 24-hour messaging window. ZEVIAN does not send periodic messages to a contact with no recent inbound conversation.
- If the relationship tag is removed or changed, pending proactive sends are canceled.
- The wife-specific prompt mirrors her recent chat style, including Banglish/Bengali script, pronouns, concise replies, and natural affectionate tone. It avoids repeated elongated filler and does not impersonate the Owner or fabricate his private facts.

### Operational controls and limits
- `/tasks`, `/done TK-201`, `/snooze TK-201 1h`, and `/delete_task TK-201` remain available.
- The due-task scheduler and wife-only proactive queue run in the web process and are persisted through the existing PostgreSQL encrypted snapshot. If PostgreSQL is not configured, process restarts can lose pending state.
- Render Free services may sleep; scheduled work runs only while the service process is active. Free hosting is not a guaranteed always-on scheduler.
- Meta messaging-window and permission requirements remain authoritative. No feature bypasses them.


## ZEVIAN v5.1.2 — Natural single-reply conversations

- Every incoming Messenger message receives at most one outgoing reply. The model's output is normalized to one message and the send layer independently enforces the same limit.
- Common greetings such as `Oiii`, `হ্যালো`, and `Hello` receive one short, natural greeting in the matching script.
- Casual assistant-directed messages such as `Ki koris?` and `Koi achis?` are answered as ZEVIAN, not mistaken for questions about the Owner.
- Questions explicitly about Safi / Owner / Sir remain on the separate Owner privacy and approval/offline path.
- Other messages are handled by Gemini with Bengali, Banglish, English, and mixed-language mirroring, contextual concise replies, and clarification when needed.
- Low-value reactions or repeated content may receive no reply where silence is more natural.
- Delayed proactive Messenger messages remain restricted to explicitly tagged wife/partner contacts and stay subject to the existing cooldown and Meta messaging-window restrictions.
- These changes do not bypass Meta permissions, messaging windows, or app review requirements.
