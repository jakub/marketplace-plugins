---
name: show
description: Decide where a visual goes before you make it, whenever a visual, chart, table, diagram, mockup, screenshot set or any HTML output is in play. Picks one of three tiers by seven ordered rules, among a Sketch in chat, an Inline HTML render in the T3 thread and a published Document, and covers the fallbacks when render tools, the plans CLI or Node are missing. Use it before plans:doc, before plans:publish, and before any html_render call.
---

# show: pick the tier for a visual

A visual goes to one of three tiers:

- **Sketch.** Text in the chat reply: a markdown table, a fenced text diagram, or the shape of some code.
- **Inline.** A small, hand-written HTML page that `html_render` shows in the T3 thread, above your reply.
- **Document.** A full HTML page that you write with `plans:doc` and publish with `plans:publish`.

Publication, retention, and where a URL may go follow the `Delivery policy` section of `plans:publish`. Read that section there. This skill does not repeat it.

## Route the visual

Apply these rules in order. The first rule that matches wins.

1. An explicit user constraint on format or delivery: do what the user said.
2. PR evidence: Document, published with `--keep`.
3. Requested sharing or retention: Document.
4. Two or more choices the reader must answer before you act: Document. Decisions that are already made and only recorded do not count. Ask a single choice in chat.
5. Longer than one screen: Document.
6. Fits one screen, and the render tools are in the tool list: Inline.
7. Otherwise: Sketch.

## Measure one screen

One screen is at most 640 CSS px of rendered height at both 728 and 360 px wide. The T3 reply column is about 728 px wide on a desktop and about 360 px wide on a phone.

- Measure after fonts and media settle.
- Measure every interaction state the reader needs, such as an open row or a selected tab. Each state must fit inside the budget.
- Collapsed content does not hide length. Measure it open.
- Inline HTML stays under 500,000 UTF-8 bytes.
- If you cannot measure eligibility, use a Sketch.

To measure, call `html_preview` at width 728 and again at width 360. Each call returns `contentHeight`. Both values must be 640 or less.

## Find the render tools

Detect `html_render` and `html_preview` by presence in your tool list. Never assume they exist. The prefix depends on the host:

- `mcp__t3-code__html_render` and `mcp__t3-code__html_preview` on Claude Code
- `mcp__t3_code__html_render` and `mcp__t3_code__html_preview` on Codex

Look under both prefixes. A tool that the host lists as deferred is present. Load its schema before you call it.

## Write an Inline render

Inline output is small, hand-written HTML on `tokens.css`, the stylesheet in this skill's directory.

1. Read `tokens.css` from the directory of this SKILL.md. On Claude Code that is `${CLAUDE_SKILL_DIR}/tokens.css`. If that variable arrives unexpanded, as it does on Codex, resolve `tokens.css` relative to this SKILL.md.
2. Write one self-contained document. Paste the whole of `tokens.css` at the top of its inline `<style>`.
3. Take every colour from the `--plans-*` custom properties that `tokens.css` declares. They read the theme variables that T3 injects and fall back to fixed values outside T3. Never declare a bare T3 name such as `--background`.
4. Never use the html-plan runtime from `plans:doc` in Inline output. Its fixed bars and its window-scroll code assume a full browser window, and the Inline frame is part of a chat reply.
5. Measure the page as described in "Measure one screen". A page over the budget is longer than one screen, so rule 5 makes it a Document.
6. Call `html_render` with the larger of the two `contentHeight` values as `height`.

An Inline render lives only in the thread. It never counts as evidence.

## Use the fallbacks

- **No render tools.** An Inline visual becomes a Sketch. If the visual needs real HTML, it becomes a Document published with `--ttl 12h`, but only when publishing is authorized.
- **Plans missing or not configured.** Follow the stop in the prerequisites of `plans:publish`. Do not install the client, and do not guess an endpoint. Keep the saved source file. Ask two or more decisions as numbered questions in chat. Mark PR evidence "not evidenced (unknown)". An Inline render never counts as evidence.
- **Node missing.** `plans:doc` cannot pack a document. Publish hand-written HTML on `tokens.css` with no Respond, ask the decisions in chat, and report that the runtime was unavailable.
