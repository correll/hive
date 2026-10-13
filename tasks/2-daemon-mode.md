---
id: 2
title: Daemon mode via Agent SDK streaming input
paths: [adapter/src/daemon/]
status: open
---
Deployment mode 2. Hold an Agent SDK streaming-input session open and yield a
user message when a Discussion event arrives. Target: headless participants on
cluster nodes. Reuse `protocol/loop.ts` gating unchanged. Must not use `--bare`
for subscription participants.
