# ZEVIAN v5.0 — Smart Offline Assistant Design

## Intent
Make ZEVIAN reliably understand message-relay requests, reply directly while the owner is offline, create durable owner reminders, and use a distinct conversational style for the explicitly owner-tagged wife/partner contact.

## Goals
- Recognize Bangla, Banglish, and English requests to pass information to Safi.
- Acknowledge the sender directly without owner approval when the request is a clear relay/task.
- Create one task per unique inbound message, preserve its source, due time, and priority.
- Avoid inventing an exact clock time when the sender only says today/tomorrow.
- Send due reminders to the authorized Telegram owner chat and retry safely without duplicate notifications.
- Keep proactive Messenger messages restricted to contacts explicitly tagged with `/tag PSID wife`.
- Proactive messages must be natural, context-aware, cooldown-limited, inbound-window-limited, and canceled by a newer inbound message.
- Improve wife-specific tone using conversation context and script/pronoun mirroring.
- Preserve Meta webhook signature verification, Telegram owner authorization, PostgreSQL encrypted snapshots, and existing commands.

## Non-goals
- Automating personal Facebook profile inboxes.
- Sending Messenger messages outside Meta's allowed messaging window.
- Impersonating the owner or fabricating the owner's location, plans, meals, or decisions.
- Proactive messages to friends or other contacts.
- Guaranteeing 24/7 availability on free hosting.

## Approaches considered
1. Keep task detection in scattered regular expressions and add more patterns. Fast but fragile and hard to test.
2. Add a small pure assistant-engine module for deterministic task intent, date interpretation, relay acknowledgements, and proactive eligibility; integrate it into the existing webhook and scheduler. Recommended because the boundaries are testable and it preserves the current Node/Express/Gemini architecture.
3. Replace the whole server with a workflow/agent framework. Higher operational complexity and unnecessary migration risk for this focused upgrade.

## Selected approach
Use approach 2. Keep Gemini for ordinary conversational replies; use deterministic logic for explicit message-relay requests and safety-critical routing. Keep all state in the existing encrypted PostgreSQL snapshot. Store proactive scheduling state in contact profiles so it survives restarts.

## Key behavior
- Clear relay intent wins before the personal-question escalation gate: create a task, send a concise language-matched acknowledgement, and notify the owner in Telegram.
- If no exact time is stated, record a date-only due target/window and label the reminder as time-unspecified; do not silently invent a time.
- A due reminder is delivered to Telegram once; failures remain retryable.
- Only `relationship === 'wife'` AND `affectionate === true` permits proactive Messenger scheduling.
- Proactive eligibility requires a recent inbound message inside the standard 24-hour window, a per-contact cooldown, no newer inbound message after scheduling, and no previous send for that inbound event.
- A newer inbound message cancels the pending proactive item.
- No periodic unsolicited messages when there is no recent inbound conversation.

## Constraints and security
- Time interpretation uses Asia/Dhaka.
- No new paid service or secret is required.
- Database persistence remains dependent on user-configured PostgreSQL and encryption key.
- Do not expose PSIDs or private owner notes in user-facing replies.
- Preserve webhook HMAC verification and fail-closed Telegram owner controls.

## Acceptance criteria
1. The sample phrase “Safire Bole Dibi J Kalke Sir College a Jaite Bolche” is classified as a relay/task intent.
2. The sender receives a direct acknowledgement and does not receive an owner-approval hold message for that relay.
3. The task is persisted with source text, sender, and a non-invented due target.
4. A due task produces a Telegram reminder once; failed Telegram delivery can retry.
5. A friend-tagged contact never becomes eligible for proactive Messenger messages.
6. A wife-tagged contact can receive a proactive follow-up only within the inbound window and cooldown.
7. A new inbound message invalidates a previously queued proactive follow-up.
8. Tests cover Bengali, Banglish, English, ambiguous dates, duplicates, and policy boundaries.
