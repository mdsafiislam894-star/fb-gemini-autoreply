# ZEVIAN v5.1 implementation plan

- [ ] Add a pure reply-plan normalizer enforcing SEND/NO_REPLY and 1–3 non-empty parts.
- [ ] Add tests for single/dual/triple message plans, no-reply, invalid/empty parts, and legacy compatibility.
- [ ] Update Gemini prompt and JSON parsing to request a reply plan, including explicit NO_REPLY decisions.
- [ ] Integrate sequential Graph API sends with bounded 0.8–1.5s delay, stopping on first failure.
- [ ] Ensure duplicate inbound IDs are recorded before processing and no sequence is replayed.
- [ ] Keep delayed follow-up function restricted to relationship=wife and affectionate=true.
- [ ] Document examples and policy.
- [ ] Run local tests, syntax checks, full CI; review diff; update PR #6 only after checks.
- [ ] Do not merge/deploy until all verification passes.
