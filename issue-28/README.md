# Issue #28 evidence

Captures for the acceptance criteria of issue #28 (`plans:show`, `plans:doc`, `plans:publish`).

- `acceptance/source/`: the acceptance document (plan kind) as written and as packed by `plugins/plans/skills/doc/runtime/pack.mjs`, with its two media files.
- `acceptance/live-run/`: `harness/capture.mjs` run against the published page on the private plans viewer. `capture.json` records every observed fact. Each PNG is one step, and `walkthrough.webm` shows answer, reload, anchor, quote link, Back and reset.
- `acceptance/harness/`: the capture harness, a local viewer imitation (`serve.mjs`, `run-local.mjs`) and the media builder.
- `transcripts/`: one session per host, each loading the branch's plugin and resolving `pack.mjs`.

Capability keys show as their first four characters plus `…redacted`, and the viewer host shows as `plans.<tailnet-host>`. The live page is tailnet-only.
