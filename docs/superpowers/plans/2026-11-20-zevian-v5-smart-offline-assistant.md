# ZEVIAN v5.0 Smart Offline Assistant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make offline relay requests auto-acknowledge and create useful reminders, while limiting proactive Messenger messages to explicitly wife-tagged contacts.

**Architecture:** Add a pure `assistant-engine.js` module for deterministic intent/date/policy logic, integrate it into the existing webhook and periodic scheduler, and store scheduling metadata in the already encrypted state snapshot.

**Tech Stack:** Node.js 18+, CommonJS, node:test, existing Express/Telegram/Gemini/PostgreSQL stack.

**Spec:** `docs/superpowers/specs/2026-11-20-zevian-v5-design.md`

## Global Constraints
- Use Asia/Dhaka for date interpretation and reminder display.
- Preserve existing webhook signature checks and Telegram owner authorization.
- Never send proactive messages to non-wife contacts.
- Never send Messenger messages outside the allowed 24-hour window.
- Never fabricate an exact time when only a date phrase is present.
- No new paid service or secret is required.

## Review Focus
- Banglish phrase spelling variations and typos must still detect relay intent.
- Ambiguous relative dates must not create a misleading exact timestamp.
- Duplicate webhook deliveries must not create duplicate tasks or acknowledgements.
- Telegram delivery failures must not mark reminders as delivered.
- Wife tag removal or newer inbound messages must cancel proactive sends.
- Old contact profile snapshots must remain backward compatible.

---

### Task 1: Deterministic assistant engine

**Files:**
- Create: `assistant-engine.js`
- Create: `tests/assistant-engine.test.js`

**Interfaces:**
- `classifyRelayIntent(text)` returns `{ isRelay, title, dueDate, dueAt, timeSpecified, priority }`.
- `buildRelayAcknowledgement(script, task)` returns a short language-matched acknowledgement.
- `canSendWifeProactive(profile, conversation, now)` returns a boolean.
- `makeProactiveSchedule(profile, conversation, message, now)` returns schedule metadata or null.

- [ ] Write tests for the exact sample Banglish phrase, Bengali/English relay variants, date-only parsing, no invented clock time, and wife-only policy.
- [ ] Run `npm test` and confirm new tests fail because the module does not exist.
- [ ] Implement the pure module.
- [ ] Run the focused tests and full `npm test`.
- [ ] Commit as `feat: add deterministic relay and proactive policy engine`.

### Task 2: Webhook integration and direct offline acknowledgements

**Files:**
- Modify: `server.js`
- Modify: `tests/assistant-engine.test.js` only if an observable pure behavior is missing.

**Interfaces:**
- Import the pure engine.
- Process relay intents before the personal-question approval gate.
- Create the existing task shape with new date/time metadata while preserving existing task commands.
- Reply directly using the sender's detected script.
- Notify Telegram owner with task ID, source sender, original message, due target, and priority.
- Do not call `escalate()` for a successfully handled relay intent.

- [ ] Add a regression test for the relay acknowledgement builder and due-target semantics.
- [ ] Verify the test fails before integration logic is added where possible.
- [ ] Integrate deterministic relay handling into the webhook.
- [ ] Run syntax checks and the complete test suite.
- [ ] Commit as `fix: acknowledge offline relay messages and create owner tasks`.

### Task 3: Durable due reminders

**Files:**
- Modify: `server.js`
- Modify: `tests/assistant-engine.test.js` if scheduling decision helpers need coverage.

**Interfaces:**
- Add a bounded periodic scheduler that scans open due tasks.
- Use a delivery state such as `reminderDelivery` with attempts, nextAttemptAt, and sentAt.
- Send through the authorized Telegram bot only.
- Mark delivered only after Telegram API success.
- Persist state using the existing encrypted snapshot mechanism.

- [ ] Test retry/eligibility policy in pure helper(s).
- [ ] Integrate due reminder delivery with duplicate protection and bounded retry.
- [ ] Run syntax checks and full tests.
- [ ] Commit as `feat: deliver due task reminders reliably`.

### Task 4: Wife-only proactive conversation

**Files:**
- Modify: `assistant-engine.js`
- Modify: `server.js`
- Modify: `tests/assistant-engine.test.js`

**Interfaces:**
- Restrict proactive sends to `relationship === 'wife' && affectionate === true`.
- Replace process-local timeout-only behavior with persisted pending schedule metadata.
- Enforce 24-hour inbound window, 6-hour cooldown, and cancel-on-new-inbound.
- Include recent conversation context in Gemini prompt for wife-tagged contacts.
- Keep proactive copy short, varied, and language/script/pronoun mirrored.
- Do not proactively message friends or untagged contacts.

- [ ] Add failing tests for friend denial, wife eligibility, cooldown, 24-hour cutoff, and newer-inbound cancellation.
- [ ] Implement persistent scheduling and safe eligibility checks.
- [ ] Run syntax checks and full tests.
- [ ] Commit as `feat: add wife-only context-aware proactive messaging`.

### Task 5: Operational documentation and release verification

**Files:**
- Modify: `README.md`
- Modify: `server.js` health/version only if justified by implementation.
- Existing CI workflow should execute the expanded test suite.

- [ ] Document behavior, commands, limits, and failure modes.
- [ ] Run `npm test` and verify GitHub Actions on the feature branch.
- [ ] Review the complete diff for privacy, policy, retry, and persistence defects.
- [ ] Open a pull request to `main`; do not merge or deploy without explicit approval.
