---
name: show
description: Decide where a visual goes before you make it, whenever a visual, chart, table, diagram, mockup, screenshot set or any HTML output is in play. Picks one of three tiers by seven ordered rules, among a Sketch in chat, an Inline HTML render in the T3 thread and a published Document, says when to ask through the host question tool instead of a page, and covers the fallbacks when render tools, the plans CLI, Node or Chromium are missing. Use it before plans:doc, before plans:publish, and before any html_render call.
---

# show: pick the tier for a visual

A visual goes to one of three tiers:

- **Sketch.** Text in the chat reply: a markdown table, a fenced text diagram, or the shape of some code.
- **Inline.** A hand-written HTML page, up to 2,000 px tall, that `html_render` shows in the T3 thread, above your reply.
- **Document.** A full HTML page that you write with `plans:doc` and publish with `plans:publish`.

Inside T3 Code, Inline is the usual tier. A render can hold a figure, a table, a prose diff and a small script that switches between states, and the reader sees it without opening a link. Reach for a Document when the content needs to leave the thread or outgrows the budget.

Publication, retention, and where a URL may go follow the `Delivery policy` section of `plans:publish`. Read that section there. This skill does not repeat it.

## Route the visual

Apply these rules in order. The first rule that matches wins.

1. An explicit user constraint on format or delivery: do what the user said.
2. PR evidence: Document, published with `--keep`.
3. Requested sharing or retention: Document.
4. Choices the reader must answer before you act, when they need a note per item, a question with more than 4 options, more than 8 questions, or a reader outside this thread: Document. Ask every other choice with the host question tool, after any visual, and route the visual by the rules below.
5. Over the Inline budget: Document.
6. Fits the Inline budget, and the render tools are in the tool list: Inline.
7. Otherwise: Sketch.

Decisions that are already made and only recorded are not choices. Write them in the visual or the reply.

## Ask with the host question tool

Ask after the visual, so the reader sees what each option means before they pick. Put the recommendation first, and say in the option text what it costs.

- **In T3 Code**, ask the way your provider asks, by the two bullets below. T3 shows `AskUserQuestion` as tappable options, and a reader can miss the reply text above them, so put what they need to choose inside the question and option text.
- **In Claude Code**, use `AskUserQuestion`: up to 4 questions per call, with 2 to 4 options each.
- **In Codex**, write the questions as numbered options in the reply, then end the turn.

Never ask through the page. An Inline render carries no question kit, and the reader's answer has to reach you in this thread.

## Measure the Inline budget

The Inline budget is at most 2,000 CSS px of `contentHeight` at both 728 and 360 px wide. The T3 reply column is about 728 px wide on a desktop and about 360 px wide on a phone. The frame grows to fit its content, but `html_render` takes a `height` from 80 to 2,000 px, and on a phone, content past that height scrolls inside the frame.

- Measure after fonts and media settle.
- Measure every interaction state the reader needs, such as an open row or a selected tab. Each state must fit inside the budget.
- Collapsed content does not hide length. Measure it open.
- Inline HTML stays under 500,000 UTF-8 bytes.
- If you cannot measure eligibility, use a Sketch.

To measure, call `html_preview` at width 728 and again at width 360. Each call returns `contentHeight`, a PNG and the console output. Both heights must be 2,000 or less. `html_preview` renders dark by default, so run one of the calls with `appearance: "light"` and look at both PNGs.

## Find the render tools

Detect `html_render` and `html_preview` by presence in your tool list. Never assume they exist. The prefix depends on the host:

- `mcp__t3-code__html_render` and `mcp__t3-code__html_preview` on Claude Code
- `mcp__t3_code__html_render` and `mcp__t3_code__html_preview` on Codex

Look under both prefixes. A tool that the host lists as deferred is present. Load its schema before you call it.

## Write an Inline render

Inline output is hand-written HTML on `tokens.css`, the stylesheet in this skill's directory. It sits in the reply column on the thread's own background, so it paints no page of its own.

1. Read `tokens.css` from the directory of this SKILL.md. On Claude Code that is `${CLAUDE_SKILL_DIR}/tokens.css`. If that variable arrives unexpanded, as it does on Codex, resolve `tokens.css` relative to this SKILL.md.
2. Write one self-contained document. Paste the whole of `tokens.css` at the top of its inline `<style>`.
3. Take every colour from the `--plans-*` custom properties that `tokens.css` declares. They read the theme variables that T3 injects and fall back to fixed values outside T3. Never declare a bare T3 name such as `--background`.
4. Never put the question kit or `look.css` in Inline output. The kit's questions belong to the host question tool, and `look.css` paints a page ground and a frame that the reply column must not have.
5. Follow T3's painting rules:
   - Give `html`, `body` and the outer element no background, outer card, border, banner title or side padding.
   - Give a box that needs its own fill 16 px of padding and `var(--plans-radius)` corners.
   - Never use `vh` units, and never set `height:100%` on `html` or `body`. T3 rejects both or loops on them. Let the content set the height, and give charts fixed pixel heights.
6. To show a local image, write its absolute path in `src`. `html_preview` inlines it.
7. Draw figures as inline SVG, following `diagrams.md` in the `plans:doc` skill's directory.
8. Scripts run, so a small script can switch tabs or open rows. Keep each one small, and measure every state it produces.
9. To show a prose rewrite, give the page its own directory as `plans:doc` describes. Write the page with a `<!-- plans:kit -->` line in `<head>` instead of the pasted `tokens.css`, and add a diff placeholder as `plans:doc` describes. Build it with `build.mjs --inline`. The builder sits in the `plans:doc` skill's directory: `${CLAUDE_SKILL_DIR}/../doc/build.mjs` on Claude Code, or `../doc/build.mjs` relative to this SKILL.md when the variable arrives unexpanded. It inlines the palette and the change marks, checks the page at 360 and 728 in light and dark, and writes `<stem>.inline.html`. Render that file. The builder's check never replaces `html_preview`.
10. Measure the page as described in "Measure the Inline budget". A page over the budget matches rule 5, so it becomes a Document.
11. Call `html_render` with the larger of the two `contentHeight` values as `height`.

An Inline render lives only in the thread. It never counts as evidence.

## Use the fallbacks

- **No render tools.** An Inline visual becomes a Sketch. If the visual needs real HTML, it becomes a Document published with `--ttl 12h`, but only when publishing is authorized.
- **Plans missing or not configured.** Follow the stop in the prerequisites of `plans:publish`. Do not install the client, and do not guess an endpoint. Keep the saved source file. Ask two or more decisions as numbered questions in chat. Mark PR evidence "not evidenced (unknown)". An Inline render never counts as evidence.
- **Node or Chromium missing, or a build exit 3.** Without Node, `build.mjs` cannot run. Publish a Document as hand-written HTML on `tokens.css` with no questions, ask the decisions with the host question tool, and report that the page was not built or checked. An Inline prose diff becomes a Sketch. Without Chromium, `build.mjs` exits 3, and the browser result is unknown. Show a Document built with exit 3 only after the live render check in `plans:publish` passes. Show an Inline render built with exit 3 only after its `html_preview` PNGs and console output at both widths show no fault.
