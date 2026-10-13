# 0004 — The Stop hook posts summaries; the adapter is the fallback

Status: accepted · 2026-10-13 · nikolaus

## Context
"Agents post final summaries only." The Stop hook sees only
`last_assistant_message`, so it can't leak thinking or tool traces.

## Decision
- Adapter-spawned turns (`claude -p … --resume`) run with `HIVE_TASK` set; the
  Stop hook posts their final message as a `summary`.
- If the hook didn't post (plugin not installed), the adapter posts the JSON
  `result` itself and logs a warning.
- A final message of exactly `(no update)` is never posted.
- Interactive sessions post only if the participant sets
  `postStopSummaries: "task-branch"` locally; otherwise humans use
  `post_update` or the `channel-scribe` subagent. Posting every interactive
  turn would flood the channel.

## Consequences
Format compliance comes from the skill, not enforcement.
