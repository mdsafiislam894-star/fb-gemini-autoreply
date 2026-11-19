# ZEVIAN v5.1 — Multi-message conversational behavior

## User intent
All Page conversations should feel natural and adaptive, not like a fixed FAQ bot. The system may send a short first message, then a separate second message containing a relevant question or continuation, e.g.:
- Incoming: `ki koris?`
- Message 1: `Aito bose aci 🙂`
- Message 2: `Tui ki koris?`

## Required behavior
- A response plan is an ordered array of 1–3 separate Messenger messages, not one concatenated paragraph.
- A second message is optional and must be useful in context; never append a generic question to every response.
- The AI may choose NO_REPLY for acknowledgements, reactions, duplicate content, spam, low-value messages, or when silence is more natural.
- Ask a clarification question when meaning is genuinely unclear.
- Match language, script, spelling, pronoun, tone, and concise chat rhythm.
- Never send an empty message or more than 3 messages for one inbound event.
- Keep a per-inbound idempotency marker so duplicate webhook deliveries do not send the sequence twice.
- Delay between separate message bubbles is short and bounded (roughly 0.8–1.5 seconds); send messages in order.
- Each message is sent as a separate Graph API request and logged separately.
- If one message fails, stop the sequence rather than sending later fragments out of context.
- The first message may be a short acknowledgement; the second may ask a relevant reciprocal question. The example is illustrative, not a fixed template.
- General multi-message conversational style applies to all contacts.
- Delayed proactive follow-up remains restricted to the explicitly tagged `/tag PSID wife` contact only. The general second message is part of the current response sequence, not an unsolicited later message.

## Output schema
Gemini returns:
`reply_policy`: `SEND` or `NO_REPLY`
`reply_parts`: ordered array of 1–3 strings
`suggested_reply`: legacy compatibility field, first part or empty
`follow_up`: only used for wife-only delayed proactive feature

## Acceptance criteria
1. `ki koris?` can produce two separate bubbles such as `Aito bose aci 🙂` then `Tui ki koris?`.
2. A simple `ok`, thumbs-up, or repetitive acknowledgement can produce NO_REPLY.
3. A meaningful question can produce one concise message or two contextual messages.
4. No more than three messages are sent for one inbound event.
5. If the first part fails, later parts are not sent.
6. Duplicate inbound message IDs do not trigger duplicate reply sequences.
7. Friend and untagged contacts can receive contextual second messages, but never delayed proactive messages.
8. Existing wife-only delayed proactive constraints remain unchanged.
