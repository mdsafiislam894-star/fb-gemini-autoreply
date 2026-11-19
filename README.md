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

## Security changes in v4.6

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
