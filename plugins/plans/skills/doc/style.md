# The default look

A Document looks like a technical drawing or a revised standards page: a white ground, black ink, cool grays, a visible grid, hairline rules, and one orange accent for what changed. `look.css` sets most of it, so a page of plain semantic HTML already has the look. This guide says what the look is for, what to add on top, and what never to add. The look is a default, not a template. Change it when the content needs something else, and keep the principles.

## Follow the principles

- **Build hierarchy from weight, size and rules, never from color.** `look.css` puts a 2 px rule over each `h2` and a 1 px rule over each `h3`. A heading in accent color says "changed" when nothing did.
- **Use one accent, only for what changed or what needs the reader.** `--plans-accent` is for marks: bars, rules, strike lines and underlines. `--plans-accent-text` is for the rare text that must carry the accent. `--plans-chart-1` to `--plans-chart-6` are for multi-series data only, never for a change.
- **Show the grid, and prefer hairlines to boxes.** Put a `--plans-hair` or `--plans-rule` line between things instead of a box around them.
- **Set numbers in tabular figures.** Put `.num` on any number that lines up in a column or changes between revisions, so the digits stay in place.
- **Keep labels readable.** A label is sentence case, at body size or one step smaller, in `--plans-ink-2`. Tiny tracked capitals are not the default.
- **Design both color schemes.** The tokens switch with `prefers-color-scheme`. Take every color from a `--plans-*` token, never from a hex value, and look at the dark screenshots as closely as the light ones.

❌ `h2 { color: var(--plans-accent-text); }` on every section heading.
✅ Leave the heading in ink, and put the accent on the one changed row below it.

## Use the technical-drawing parts

- a section-number column beside the headings
- a title block that holds real revision facts and nothing invented
- margin callouts, each joined to its text by a hairline leader
- dimension lines, only for real quantities (`diagrams.md` shows how to draw them)
- square corners everywhere
- a gray panel only behind code

`look.css` sets body text at 16 to 17 px, a measure of about 66 characters, and headings no larger than 2 times the body. Keep page styles inside those limits.

Put page styles in a `<style>` element after the `<!-- plans:kit -->` line, so they build on the kit. Read only `--plans-*` tokens in them.

### A title block

`.title-block` is a `<dl>` whose children are `<div>` cells, each with one `<dt>` and one `<dd>`. Put only facts the reader can check in it.

```html
<dl class="title-block">
  <div><dt>Issue</dt><dd class="num">#40</dd></div>
  <div><dt>Date</dt><dd class="num">2026-10-26</dd></div>
  <div><dt>Base</dt><dd><code>d7d17d2</code></dd></div>
  <div><dt>Files changed</dt><dd class="num">14</dd></div>
</dl>
```

### Section numbers

Hang each `h2` number in a column of its own, so the heading text lines up with the body.

```html
<style>
  h2 { display: grid; grid-template-columns: 3ch 1fr; column-gap: .5rem; }
  h2 .num { color: var(--plans-ink-2); font-weight: 400; }
</style>
<h2><span class="num">2</span> What changes</h2>
```

### A margin callout

`.margin` sits in the outer column at 900 px and wider, with a hairline leader back to the text. Below 900 px it folds under its paragraph. Put it right before or inside the paragraph it annotates, and keep it to one or two sentences.

```html
<p>
  <span class="margin">Measured on fractal, 2026-10-26, Chromium 155.</span>
  The check runs four views in about 9 seconds.
</p>
```

### A ruled grid

`.grid-rules` rules the children of any element into hairline cells. Use it for a set of facts or measurements that the reader compares across.

```html
<div class="grid-rules">
  <p><strong>Before</strong><br><span class="num">3,412</span> lines</p>
  <p><strong>After</strong><br><span class="num">1,108</span> lines</p>
  <p><strong>Removed</strong><br><span class="num">2,304</span> lines</p>
</div>
```

### A changed row

Mark the one row that changed with an accent bar, and leave every other row in ink.

```html
<style>
  tr.changed > td:first-child { border-left: 3px solid var(--plans-accent); padding-left: .6rem; }
</style>
<table>
  <thead><tr><th>File</th><th class="num">Lines</th></tr></thead>
  <tbody>
    <tr><td><code>build.mjs</code></td><td class="num">412</td></tr>
    <tr class="changed"><td><code>kit/ask.js</code></td><td class="num">688</td></tr>
  </tbody>
</table>
```

## Never use these

- blueprint blue, paper or cream grounds, textures, gradients, shadows, and rounded cards
- purple and pastel SaaS accents
- stamps, tape, and crop or registration marks, beyond one small touch on a page
- fake drawing numbers, sheet numbers or revision letters that mean nothing
- serif body text and billboard type
- web fonts. `--plans-sans` and `--plans-mono` already name the system stacks.
- a CSS `url()` that points at a file. The viewer blocks the request, and the build check fails it.
