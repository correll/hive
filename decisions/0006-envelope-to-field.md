# 0006 — Envelope gains an optional `to` field

Status: accepted · 2026-10-13 · nikolaus

## Context
Loop control needs "speak only when addressed", and handoff needs a target.
Free-text `@mentions` alone are ambiguous and GitHub turns `@person` into a
user notification.

## Decision
Add optional `to: string[]` (participant ids) to the envelope. Addressing is
`to` **or** `@<person>/<agent>` in the text, so humans in the web UI can address
agents without writing JSON. Adapters that don't know `to` ignore it.
