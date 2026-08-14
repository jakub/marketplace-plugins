---
description: The single front door — design-harden an issue OR a free-text idea/spike into ready-for-agent (or do it now, or split it). Nothing enters the tracker except through here.
argument-hint: <issue-number | free-text idea>
allowed-tools: Bash(gh:*), Bash(git:*), Bash(ls:*), Bash(rg:*), Read, Edit, Write, Skill, AskUserQuestion, Task, Agent
---

# /flow:prep — the front door

Front of the loop **prep → issue → land** (doctrine: the `flow` skill, `framework.md` §1).
`/flow:issue` runs a cold implementer hands-off; the PR is only as good as the spec it
measures against. Prep is where the design gets stress-tested — and the ONLY lane where a
new issue may be created (`FLOW_SANCTION=prep`).

Argument: `$ARGUMENTS` — a positive integer (existing issue) or free text (an idea, a
spike, a mid-development deviation).

## Core principles

- **The issue is the spec AND the record.** Body = living spec, edited in place. Post
  stage findings as journal comments — a human reviews the run by reading them.
- **Recommend the CORRECT answer, not the minimal one.** Weight correctness/robustness on
  design forks; give your pick; the human overrides.
- **Fold decisions in — don't spawn issues.** Loose ends become acceptance criteria or ADR
  lines. Remove issues, don't create more.
- **Don't resurrect closed work.** Prior art informs; `wontfix`/`deferred` stay buried.
- **No code, no worktree.** Prep touches the issue, context.md, and ADRs only.

## 1. Entry

**Issue mode** (integer): `gh issue view <N> --json number,title,body,labels,state,url,comments`.
Abort if closed or `wontfix`. If already `ready-for-agent`, ask whether to re-prep.

**Free-text mode**: FIRST dedupe — `gh issue list --search "<terms>" --state all` (open AND
closed) plus `gh pr list --search`. An existing open match → switch to issue mode on it.
A closed/`wontfix` match → surface it and stop unless the human overrides. No issue is
created yet — that happens at finalise, after the design survives the gates.

## 2. Scout

Delegate breadth to scoped agents (Explore for the repo sweep; a codex-delegate pass when
an outside read helps); keep returned findings tight — paths + the seams that matter.

1. **Domain docs**: repo AGENTS.md → the context.md slices it discloses → the 1-3 ADRs this
   work touches.
2. **Code seams**: 3-6 keywords from the ask; grep likely modules; read the key seam.
3. **Prior art**: related/duplicate/closed work — note, never re-propose.
4. **Design-readiness assessment** (present it): what's clear, what's ambiguous, and the
   OPEN QUESTIONS a cold implementer would trip on.

## 3. Triviality gate

Fully specified and small (clear AC, no open questions, no design forks) →
- issue mode: recommend skipping straight to `/flow:issue <N>`.
- free-text mode: **recommend doing it right now** — no ticket theater. On agreement,
  implement it directly (normal quick-fix rules) and stop; the tracker never hears of it.

Too big for one PR → recommend splitting into tracer-bullet vertical slices (each slice
gets its own prep pass); don't auto-spawn tickets.

Otherwise → dialectic, then grill.

## 4. Design dialectic — where ADRs are minted

Issues that survive the triviality gate get a cross-model dialectic BEFORE the grill: if
we're minting an ADR, it deserves a thorough discussion. The do-it-now and split paths
never see this stage.

1. **Blind proposals**, parallel, neither sees the other: a claude leg (architecture from
   the scout's seams) and a sol leg on the codex transport — which ALSO hunts spec gaps
   (what has the human NOT said that an implementer would decide silently). Both work at
   the product/architecture level: shape, boundaries, protocol surfaces, trust models.
   Code-level joinery (placement, signatures) belongs to the run's design pass, not here —
   it must be drawn against the HEAD being implemented on, and prep-time design goes stale.
2. **Mutual critique**: each leg reads the rival and returns the strongest version of the
   disagreement. No averaging — the synthesizer is the human, in the grill.
3. **The argument becomes grill material**: agreements arrive as recommended answers;
   disagreements become grill questions, adjudicated one at a time. Trust-model forks
   (who may reach what, what an unattended tool will read or publish) are ALWAYS presented
   for human decision, never auto-resolved — runs are forbidden from guessing these, so
   prep is where they get settled cheaply.

## 5. Grill

If a `grill-with-docs` skill is available, run it seeded with the dialectic's argument and
the open questions.
Otherwise run the grill inline, same discipline: one question at a time, each with a
recommended answer (weight correctness over minimal-change); challenge terms against the
glossary; stress-test boundaries with concrete scenarios; cross-reference the code; update
context.md / write ADRs inline as decisions crystallise. Resolve each branch of the design
tree before moving to the next.

**Seed the skill with this repo's doc-stack conventions** — the upstream skill assumes
different ones and will otherwise write to the wrong places:

- The glossary file is `context.md`, **lowercase**. Never create or read `CONTEXT.md`;
  on a case-sensitive filesystem that is a second, competing file.
- This repo is **multi-context without a `context-map.md`**. The `## Contexts` section of
  the root `AGENTS.md` IS the map — read it to find the slices. Do not infer "single
  context" from the absence of a map file, and never create one.
- Crate-local vocabulary belongs in `crates/<x>/context.md`; the root `context.md` keeps
  cross-cutting ontology only. When a new slice appears, add its line to `## Contexts`.
- ADRs stay in the repo-root `docs/adr/`, sequentially numbered. Do not nest per-context
  `docs/adr/` directories — the drift audit only scans the root one.

## 6. Acceptance criteria — testable by construction

Draft `## Acceptance Criteria` where EVERY criterion **names its own evidence**: the test,
command, transcript, or screenshot that will prove it (the run's AC check and evidence
ledger key off this). Reject criteria that can't be validated — "works well" and
numberless "fast" don't pass the front door. Bound the whole set to ONE PR.

## 7. Finalise

1. **Persist doc artifacts to main**: on up-to-date main, stage ONLY the context.md /
   docs/adr/ changes the grill produced, one `docs(...)` commit, push. Anything non-doc
   staged/dirty → STOP and flag it.
2. **Issue body → hardened spec** (edit in place): restated goal/why, agreed approach +
   key decisions (ADR links), the acceptance criteria. Free-text mode: create the issue
   now — `FLOW_SANCTION=prep gh issue create …` (the no-backlog hook requires the sanction).
3. **Journal comment**: the synthesised design + decisions trail.
4. **Labels**: validate the ready-for-agent contract (`flow` skill, `label-contract.md`);
   apply `ready-for-agent`, clear `needs-triage`/`agent-found`/`needs-info`.
5. **Blocked on info only the human/externals can supply** → `needs-info` + comment the
   questions + stop.

## 8. Hand-off

One line: `#N design-hardened → ready-for-agent → /flow:issue N` (or: done-now / split /
needs-info). State decisions made and any ADR touched.
