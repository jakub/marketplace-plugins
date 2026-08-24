---
description: Design-harden an issue OR a free-text idea/spike into ready-for-agent. Nothing enters the issue tracker except through here; use this command when either you or the user wants to create a new issue or revise an existing issue.
argument-hint: <issue-number | free-text idea>
allowed-tools: Bash(gh:*), Bash(git:*), Bash(ls:*), Bash(rg:*), Read, Edit, Write, Skill, AskUserQuestion, Agent
---

# /flow:prep - the front door for the prep → issue → land workflow

/flow:prep is the entry point for all new development work. The argument is either an issue number - well-defined or a bare placeholder - or free text: an idea, a spike, a mid-development deviation.

/flow:issue is a hands-off autonomous implementation, so the issue we hand it needs to be precise, well designed, well scoped, and complete with acceptance criteria. We need to examine the codebase and produce a solid proposal that contains everything a cold implementer in a new session would need.

Prep is the only lane where a new issue may be born: the `no-backlog-guard.mjs` hook blocks `gh issue create` everywhere else, so creating one at finalize means `FLOW_SANCTION=prep gh issue create ...`. That sanction names the lane you're in; don't sprinkle it on other commands.

## Core principles

1) The issue is both the spec and the implementation record. The body is a living document, edited in place. Everything you find along the way goes in as a journal comment, because a human reviews this run by reading those comments back in order.
2) Bias toward correctness. On a design fork recommend the correct answer over the easy or quick one, and actually pick one - say what you would do and why, never a menu of neutral options. The human overrides you if they disagree.
3) When a loose end turns up, turn it into an acceptance criterion or an ADR line and fold it into this issue. Never open a second issue for it. We are trying to shrink the backlog.
4) Don't resurrect closed work. Closed issues are good background and you should read them, but a proposal already litigated as `wontfix` or `deferred` stays buried: surface what you found and stop, unless the human explicitly overrides.
5) Prep itself never writes code and never creates a worktree - it edits the issue, context.md, and ADRs, and nothing else. The one exception is the triviality gate in §3: when the work is small enough to skip the tracker entirely, prep hands off to a normal quick fix and exits.

## 1. Entry

**Issue mode**: `gh issue view <N> --json number,title,body,labels,state,url,comments`
1) Abort if closed or `wontfix`. 
2) If already `ready-for-agent`, ask whether to re-prep.

**Free-text mode**:
1) Dedupe - `gh issue list --search "<terms>" --state all` (open AND closed) plus `gh pr list --search`. If an existing open match is found, inform the user and change your focus to that issue instead.
2) If a closed or `wontfix` match is found, surface it and stop unless the human overrides. 

No issue is created yet - that happens at finalize, after the design survives the gates.

## 2. Scout

Delegate codebase reviews to scoped agents - `Explore` for the repo sweep, spawned on Sonnet because searching needs eyes rather than judgment, plus a Codex delegation for an outside perspective.

Tell every subagent to keep what it sends back tight: paths, and the seams that matter. A whole grill runs in this session afterwards, so your remaining context is the budget - conclusions come home, file dumps don't.

The subagents should return:

1) **Domain docs**: Start at the repo's `AGENTS.md` - its `## Contexts` section is the map, and it tells you which context.md slices exist. Read those for terminology, then the 1-3 existing ADRs this work touches.
2) **Code seams**: Select 3-6 keywords from the ask, grep likely modules, and read the key seams.
3) **Prior art**: Related, duplicate, or closed work. Read it for what it teaches and for anything worth reusing or refactoring - but never re-propose something already buried.
4) **Design-readiness assessment**: What's clear, what's ambiguous, and the OPEN QUESTIONS a cold implementer would trip on. Present it to the user.

## 3. Triviality gate

If the issue is fully specified and small (clear AC, no open questions, no design forks): 
- Issue mode: recommend skipping straight to `/flow:issue <N>`.
- Free-text mode: **recommend doing it right now** - no ticket theater for little fixes. On agreement, implement it directly (normal quick-fix rules), commit to main, and stop; the tracker never hears of it.

If the issue is too big for one PR, recommend splitting it into slices that each run end to end - a thin path through the whole system rather than one horizontal layer of it. Each slice gets its own prep pass. Don't auto-spawn tickets.

Otherwise, continue to the dialectic.

## 4. Design dialectic - where ADRs are minted 

Issues that survive the triviality gate get a cross-model dialectic BEFORE the grill: if we're minting an ADR, it deserves a thorough discussion.

1) **Blind proposals**, parallel, neither sees the other: Spawn both a Claude leg (architecture from the scout's seams) and a Sol leg on the codex transport - which ALSO hunts spec gaps (what has the human NOT said that an implementer would decide silently). Both work at the product/architecture level: shape, boundaries, protocol surfaces, trust models. Code-level joinery (placement, signatures) belongs to the run's design pass, not here - those things must be decided against the HEAD being implemented on, and prep-time design goes stale.
2) **Mutual critique**: Each leg reads the rival and returns the strongest version of the disagreement. No averaging - the synthesizer is the human, in the grill.
3) **The argument becomes grill material**: Agreements arrive as recommended answers; disagreements become grill questions, adjudicated one at a time. Trust-model forks (who may reach what, what an unattended tool will read or publish, security concerns) are ALWAYS presented for human decision, never auto-resolved - runs are forbidden from guessing these, so prep is where they get settled cheaply.

## 5. Grill

If a `grill-with-docs` skill is available, run it seeded with the dialectic's argument and the open questions.

Otherwise run the grill inline, same discipline: one question at a time, each with a recommended answer (weight correctness over minimal-change); challenge terms against the glossary; stress-test boundaries with concrete scenarios; cross-reference the code; update context.md / write ADRs inline as decisions crystallize.

Resolve each branch of the design tree before moving to the next.

**Seed the skill with this repo's doc-stack conventions** - the upstream grill-with-docs and grilling skills assume different conventions and will otherwise write to the wrong places:

- The glossary file is `context.md`, **lowercase**. Never create or read `CONTEXT.md` - on a case-sensitive filesystem that is a second, competing file.
- The `## Contexts` section of the root `AGENTS.md` IS the context map - read it to find the slices. There is never a `context-map.md`: do not create one, and do not infer "single context" from the absence of a map file.
- Crate-local vocabulary belongs in `crates/<x>/context.md`; the root `context.md` keeps cross-cutting ontology only. When a new slice appears, add its line to `## Contexts` in `AGENTS.md`.
- ADRs stay in the repo-root `docs/adr/`, sequentially numbered. Do not nest per-context `docs/adr/` directories - the drift audit only scans the root one.

## 6. Acceptance criteria - testable by construction

Draft `## Acceptance Criteria` - spelled exactly that way, because the run snapshots the section by exact string and a lowercase `c` matches nothing - where EVERY criterion **names its own evidence**: the test, command, transcript, or capture that will prove it (the run's AC check and evidence ledger key off this).

Reject criteria that can't be validated - "works well" and unqualified "fast" don't pass the front door. Bound the whole set to ONE PR.

Evidence has to survive the trip to a browser. Someone reviewing the PR should be able to check every criterion from the GitHub page without cloning anything, so name evidence that resolves to a link: a test CI will run, a file:line in the diff, a capture that gets committed or published. "Verified manually" is a promise, not evidence.

Write each criterion as a task-list item with its evidence on a sub-bullet:

```markdown
- [ ] Malformed frames are rejected without panicking.
  - evidence: `cargo test parser::rejects_malformed_frame`
```

Add `surface:` when the landing spot isn't obvious from the evidence text - `ci` for something CI runs, `code` for a permalink into the diff, `commit` for a capture committed to the evidence branch, `artifact` for a plans-hosted page, recording, or oversized image set.

Artifact evidence publishes to the tailnet-private plans host, always - there is no public-publish path from a run, and no per-criterion visibility field to fill in.

## 7. Finalize

1) **Persist doc artifacts to main**: On up-to-date main, stage ONLY the `context.md` or ADR changes the grill produced, one `docs(...)` commit, then push. Anything staged/dirty that isn't a documentation change: STOP and flag it.
2) **Issue body → hardened spec** (edit in place): Restate the goal/why, context, agreed approach, key decisions (ADR links), and the acceptance criteria. For free-text mode, create the issue now - `FLOW_SANCTION=prep gh issue create …` to pass the hook.
3) **Journal comment**: The synthesized design and decisions trail.
4) **Labels**: Validate the ready-for-agent contract (`flow` skill, `label-contract.md`), apply `ready-for-agent`, and clear `needs-triage`/`agent-found`/`needs-info` tags.
5) **Blocked on info only the human/externals can supply**: tag as `needs-info`, comment the questions, and stop.

## 8. Hand-off

One line: `#N design-hardened → ready-for-agent → /flow:issue N` (or: done-now / split / needs-info). State decisions made and any ADR touched.
