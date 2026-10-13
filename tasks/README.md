# Tasks

One claimable work unit per file: `tasks/<id>-<slug>.md`.

```
---
id: 7
title: Short imperative title
paths: [sections/stability.tex, figures/]
status: open        # open | done
---
What "done" means, links, constraints.
```

`paths` is what `claim_task` leases by default. The task's channel is the
Discussion titled `task/<id>: <title>` — `hive task open <id>` creates it.
Add or close tasks by PR.
