# The parts and the shell

Read this when a page needs a part: a status chip, headline numbers, a framed screenshot, a before-and-after pair, a chart, or a page that has to work on a phone and a wide screen at once. The base gives you parts to build with, so you stop inventing them. It never gives you a page. You still decide what the page says and in what order.

`build.mjs` always inlines the base. The parts work on any page, in a Document and in an Inline render. The shell works only in a Document, under `<body data-base-shell>`. A page with no base markup renders as it did before the base existed.

Every part shows its content before script runs. Script adds controls, tracks and counts on top of markup that already reads correctly, so a reader whose script fails still gets the whole page.

## Write only base names

- You write `pb-` classes and `data-base-*` attributes. Script makes the `plans-` classes and the `data-plans-*` attributes. Never write those yourself. The check reports a script-made name in your markup as `part-error` with the detail `markup: <tag> carries <name>`.
- `look.css` keeps its own names: `.title-block`, `.margin`, `.grid-rules` and `.num`.
- Script never sets an `id`, never writes `document.title`, never writes inside a `fieldset[data-ask]`, and never adds a kit hook. It moves no element you wrote, except to wrap a zoomable `img` in a button.
- Script writes the page only when something changes: a section comes into view, a question changes state, the reader acts, or a chart's box changes width. It never writes on each scroll frame, because on a page with questions each write costs the kit one full validation.
- A part with a markup error logs `plans-part: <part>: <what is wrong>` to the console once and leaves your markup as you wrote it. The check reports that line as the fault `part-error`, so the build exits 1.
- A kit hook inside a switch pane, a compare side or a chart is a `part-error`. A question that a pane can hide is a question the reader may never see.

Parts size themselves from their own box, with container queries, not from the viewport. A part in a narrow grid cell at 1100 px behaves as it does on a phone.

## Mark status from one vocabulary

A status is your claim about a thing. It is not a check result. The set is closed:

| `data-base-status` | Glyph | Use it for |
|---|---|---|
| `supported` | ✓ | a claim the evidence backs |
| `partial` | ◐ | a claim the evidence backs in part |
| `unknown` | ? | a fact nobody has measured yet |
| `refuted` | ✕ | a claim the evidence contradicts |
| `proposed` | ○ | a change you suggest and nobody has made |
| `changed` | ◆ | what this work changed |
| `unchanged` | – | what this work leaves as it was |

Only `changed` takes the accent. The others stay in ink, so the glyph and the word carry the meaning, never a colour.

## Use the parts

Each entry says what you write, what script adds, and what shows before script runs.

### Status chip

```html
<span class="pb-chip" data-base-status="partial">Retry budget</span>
```

Script adds nothing. The chip shows its glyph and label from CSS alone.

### Callout

```html
<aside class="pb-callout" data-base-kind="decided"><b>Decided.</b> The queue owns retries.</aside>
```

`data-base-kind` is `note`, `warning` or `decided`. Start the text with a bold label, so the kind reads without the styling. Script adds nothing.

### Tiles

Three to six headline numbers, each with a short label.

```html
<ul class="pb-tiles">
  <li><b class="num">3</b> <span>files changed</span></li>
  <li><b class="num">410 ms</b> <span>cold start, from 840</span></li>
  <li><b class="num">0</b> <span>public API changes</span></li>
</ul>
```

Script adds nothing. Put only numbers you measured or counted in a tile.

Three tiles always share one line. Four share a line when the list is at least 30rem wide, and five or six when it is at least 45rem wide. In a narrower list they split into two even lines: 2 and 2, 3 and 2, or 3 and 3. No tile ever sits alone on a line.

### Figure

```html
<figure class="pb-figure" data-base-frame="browser" data-base-zoom>
  <span class="pb-address">fractal.local/settings</span>
  <img src="settings-after.png" width="720" alt="The settings page with the new retry field">
  <figcaption>Settings at 1440×900 after the change, at <code>3b19d35</code>.</figcaption>
</figure>
```

- A figure holds an `img` or an inline SVG, and a `figcaption`.
- `data-base-frame="browser"` draws a browser frame, and its `.pb-address` text is the address line. `data-base-frame="phone"` draws a phone frame. Leave the attribute off for no frame.
- Under the shell, `data-base-zoom` on the figure makes script wrap each `img` in a button with a **Zoom** badge. The button opens a native dialog that shows the image fitted, and the dialog's **Actual size** button shows it at actual size. Actual size is the natural width divided by the pixel ratio. The ratio is `data-base-dpr` on the `img` when you set it, else the natural width divided by the `width` attribute, else 1. `data-base-dpr` is a number greater than 0, or it is a `part-error`. A zoomable image inside a question is a `part-error` too.
- Under the shell, a caption sits beside its figure when the figure's own box is 640 px or wider, and below it when narrower.

Before script runs, the image shows at its laid-out size and nothing opens.

### Compare

A before-and-after pair of one thing.

```html
<figure class="pb-compare">
  <div class="pb-side" data-base-side="before">
    <h3>Before</h3>
    <img src="dock-before.png" width="390" alt="The page with no dock">
  </div>
  <div class="pb-side" data-base-side="after">
    <h3>After</h3>
    <img src="dock-after.png" width="390" alt="The page with the dock at the bottom">
  </div>
  <figcaption>390×844, light, at <code>3b19d35</code>.</figcaption>
</figure>
```

Give each side a visible heading. The two sides and the `figcaption` are direct children of the figure. At 640 px of box width and wider, both sides show side by side. Script adds a two-button switch above the sides, labelled with the sides' headings. The switch shows only when the box is under 640 px, and it starts on `after`. Before script runs, both sides show: side by side at 640 px and wider, one above the other below that.

A `.pb-compare` that isn't a `figure`, lacks the `figcaption` or a headed side, or holds a question is a `part-error`.

### Switch

A box of panes that the reader picks between with one or two groups of buttons.

```html
<div data-base-switch>
  <p data-base-key="host">
    <button type="button" value="claude" aria-pressed="true" disabled>Claude Code</button>
    <button type="button" value="codex" disabled>Codex</button>
  </p>
  <p data-base-key="run">
    <button type="button" value="cold" aria-pressed="true" disabled>Cold</button>
    <button type="button" value="warm" disabled>Warm</button>
  </p>
  <div data-base-when="host=claude run=cold">…</div>
  <div data-base-when="host=claude run=warm">…</div>
  <div data-base-when="host=codex">…</div>
</div>
```

- Write every button with `disabled`, and mark exactly one button per key with `aria-pressed="true"`. Script enables the buttons only after it has checked the box and bound them, so a reader never presses a dead button.
- `data-base-when` is one or more `key=value` terms, separated by single spaces. A pane shows when every term holds. A pane may leave a key out, as the `codex` pane above does.
- Keys are unique in a box. Values are unique in a key, and each key has at least two. Both match `^[a-z][a-z0-9-]*$`.
- Two panes may match one combination, and a combination may match no pane.
- Never set `hidden` on a pane. Before script runs, every pane shows, so the page still holds everything.
- A break of any rule above is a `part-error`. So are a pane with no term, a term with an unknown key or value, one key twice in a pane, a key inside a pane, a pane or a key outside any switch, and a switch inside a switch or a question. A switch with an error stays as written: its buttons stay disabled and every pane shows.
- Arrow keys, Home and End move to another button in the same group and press it. They wrap at both ends.

The check visits every combination of each switch's keys, at most 16 per switch and 64 per page. Over either limit is the fault `base-state-budget`.

### Table

```html
<div class="pb-table">
  <table>
    <caption>Files that change</caption>
    …
  </table>
</div>
```

Give the table a `caption`. The `.pb-table` box holds that one table and nothing else. A box without a captioned table, with a second child, or inside a question is a `part-error`. When the table is wider than its box, script makes the box a focusable scroll region named by the caption, so a keyboard reader can scroll it. There's no height cap. A sticky header is fine only where the box itself scrolls.

### Notes

```html
<p>The worker frees its slot first.<sup class="pb-fn"><a href="#n1">1</a></sup></p>
…
<ol class="pb-notes"><li id="n1">Measured on fractal, 2026-11-10.</li></ol>
```

Script adds nothing. The link is a fragment link, so it works on a page with questions.

### Steps

```html
<ol class="pb-steps">
  <li><b>Claim the slot.</b> The worker takes one slot from the pool.</li>
  <li><b>Send.</b> A failure returns the slot and queues a retry.</li>
</ol>
```

The numbers are the list's own. Script adds nothing.

### Code

```html
<figure class="pb-code">
  <figcaption><code>kit/parts.js</code> lines 40-44 at <code>3b19d35</code></figcaption>
  <pre><code><span class="pb-dim">function bars(table) {</span>
<span class="pb-del">  const max = Math.max(...values)</span>
<span class="pb-add">  const [lo, hi] = scale(values, table)</span>
<span class="pb-hl">  draw(table, lo, hi)</span>
<span class="pb-dim">}</span></code></pre>
</figure>
```

`.pb-add` and `.pb-del` mark added and removed lines, `.pb-hl` marks the line the text is about, and `.pb-dim` sets context back. Paste the excerpt from `git show <sha>:<path>`, and name the path, the lines and the full SHA in the caption. Script adds nothing.

## Draw charts from raw values

A chart is an HTML table or list that holds the values. Script reads the values and draws the marks. You never write a fraction, a width or a coordinate. Put a chart in a `figure` with a `figcaption` that says what was measured, where and when.

The table or list stays the readable text, and the drawn track is `aria-hidden`. Before script runs, and on a chart with a markup error, the chart reads as a plain table or list.

`data-base-chart="bars"` goes on a `table`, and `data-base-chart="timeline"` on an `ol`. Any other pairing is a `part-error`. So are a chart inside a chart, and a chart that holds a question or sits in one.

### Bars

```html
<figure>
  <table data-base-chart="bars" data-base-unit="ms">
    <thead><tr><th>Measure</th><th>Before</th><th>After</th></tr></thead>
    <tbody>
      <tr><th>Cold start</th><td><data value="840">840</data></td><td><data value="410">410</data></td></tr>
      <tr data-base-status="changed"><th>First paint</th><td><data value="1210">1.2 s</data></td><td><data value="620">620</data></td></tr>
      <tr><th>Rebuild</th><td><data value="96">96</data></td><td><data value="94">94</data></td></tr>
    </tbody>
  </table>
  <figcaption>Start times on fractal, 2026-11-10, median of 20 runs.</figcaption>
</figure>
```

- Each body row has a `th` label and one to six `td` cells. Each cell holds one `<data value>`. Every row has the same number of cells. With two or more value columns, the `thead` row has one cell over the labels and one over each column.
- A value matches `^-?\d+(\.\d+)?$`: an optional `-`, digits, then an optional `.` and digits. An exponent, `Infinity`, a trailing `.` and an empty value are `part-error`s. The display text inside `<data>` is yours, so `1.2 s` can stand for `1210`.
- Columns draw side by side by default. Add `data-base-stack` to the table to stack them. A stacked chart refuses a negative value.
- In a side-by-side chart, each value gets its own bar, with its display text beside it. When the scale includes 0, each track draws a zero line at 0, and a bar runs from that line to its value, so a negative value draws left of the line. With a `data-base-min` above 0, a bar starts at that bound.
- A stacked chart draws each row as one bar of segments, end to end from 0 with no gap, and prints the row's values under its label.
- The scale runs from the smaller of 0 and the lowest value to the larger of 0 and the highest value. A stacked chart scales to its largest row sum. An all-zero chart uses 0 to 1.
- `data-base-min` and `data-base-max` on the table set the bounds, each a decimal in the value form. A bound that leaves out a value, or a row sum in a stacked chart, is a `part-error`. So is a stacked chart with a `data-base-min` other than 0.
- One value column draws in ink, and a row with `data-base-status="changed"` takes the accent. Two to six columns draw in `--plans-chart-1` to `--plans-chart-6`, and the `thead` cells are the legend, each with a colour swatch. There, a changed row keeps its series colours, and only its label takes the accent ◆.

**Shared scales.** Charts in one `[data-base-switch]` box that have the same `data-base-unit` share one scale across the panes, so a bar keeps its length when the reader switches panes. A chart with no unit, or a different unit, keeps its own scale. In a share group, every chart that states `data-base-min` or `data-base-max` states the same value as the others that state it, or it is a `part-error`. Charts that state no bound take the group's.

A value over time is a bars chart with one row per period. There's no line-plot part.

### Timeline

```html
<figure>
  <ol data-base-chart="timeline">
    <li data-base-lane="Design"><time datetime="2026-11-03">3 Nov</time> to <time datetime="2026-11-10">10 Nov</time> Three candidate bases</li>
    <li data-base-lane="Design"><time datetime="2026-11-11">11 Nov</time> Picks made</li>
    <li data-base-lane="Build" data-base-status="changed"><time datetime="2026-11-11">11 Nov</time> to <time datetime="2026-11-14">14 Nov</time> Kit, check and docs</li>
    <li data-base-lane="Build"><time datetime="2026-11-14T16:00:00Z">14 Nov, 16:00 UTC</time> Premise runs</li>
  </ol>
  <figcaption>Issue 54, from survey to premise runs.</figcaption>
</figure>
```

- Each `li` has a `data-base-lane` and one or two `time[datetime]`: one for a point, two for a span.
- A `datetime` is `YYYY-MM-DD`, read as UTC midnight, or `YYYY-MM-DDTHH:mm:ssZ`. A date that doesn't exist, such as `2026-02-30`, a time without `Z`, and an end before its start are `part-error`s.
- `data-base-from` and `data-base-to` on the `ol` set the bounds, in the same forms. Without them the chart runs from the earliest start to the latest end. If those are the same instant, every mark sits in the middle. An item outside the bounds is a `part-error`.
- Script draws a track above the list, with one labelled band per lane, in order of first use. The lane's name labels the band, beside it when the chart's box is 480 px or wider and above it when narrower.
- A point draws as a diamond centred on its time, and a span as a bar from its start to its end. Marks keep their true positions in time. Marks in one lane that would overlap take extra rows in that band, in order of start and then source order, and the track grows as tall as it needs.
- Lanes have no colours. Marks draw in ink, and a `li` with `data-base-status="changed"` takes the accent.
- The track has no date axis, so the `time` texts in the list carry the dates. CSS prints each item's lane before its text, so don't repeat the lane name in the text.

## Lay a Document out with the shell

The shell is a phone-first frame for a Document. Under `<body data-base-shell>`, the page reads as a masthead, a brief and then the sections, in one column, below 1100 px. At 1100 px and wider, rows lay out on a 12-column grid.

```html
<body data-base-shell>
  <header class="pb-mast">
    <h1>Retries move into the queue</h1>
    <p class="pb-lede">The queue retries a failed send after the worker frees its slot.</p>
    <dl class="title-block"><div><dt>Files changed</dt><dd class="num">3</dd></div></dl>
  </header>
  <div class="pb-brief">
    <ul class="pb-tiles"><li><b class="num">1</b> <span>retry owner</span></li></ul>
    <nav data-base-contents aria-label="Sections"></nav>
  </div>
  <main>
    <section id="owner" data-base-status="changed">
      <h2>The queue owns retries</h2>
      …
    </section>
  </main>
</body>
```

Keep the masthead and the brief short. On a phone, the first screen should hold the lede, the tiles and the whole section list.

### Contents

Write `nav[data-base-contents]` empty. Script fills it with one row for each `main > section[id]` whose first element child is an `h2`. A row holds the heading text, less a leading `.num`, and a chip with the section's status word. A section that holds questions also shows a live count: `N open`, or `answered`.

- Give every listed section a `data-base-status` from the vocabulary. A listed section without one, or with a value outside the set, is a `part-error`, and its row shows no chip.
- A nav that you filled yourself is a `part-error`, and so is a nav with no section to list.
- A question counts as answered when the kit has marked it changed or kept. `kit.md` says when that happens.

Before script runs, the nav is empty and every section reads as it is.

### Dock and sheet

When the contents list scrolls above the top of the screen, script shows a bar fixed to the bottom of the screen at every width. It shows the section in view as `3/7 Title`, the open count on a page with questions, and a **Sections** button. The button opens a sheet with the same rows. A row closes the sheet and jumps to its section. **Close**, Escape and a press outside the sheet close it, and focus goes back to the button. On a page without a contents list, the bar shows once the masthead scrolls away. The page leaves room for the bar at its end, so no control sits under it.

### Theme switch

Script adds one button to the masthead that cycles **auto**, **light** and **dark**. Under the shell, a page without a `header.pb-mast` is a `part-error`, because the button has nowhere to go. Nothing is stored, so a reload starts at auto. The colours come from the kit's own tokens, so page CSS under the shell never queries `prefers-color-scheme`. `style.md` has that rule.

### Rows

A `.pb-row` is a 12-column grid at 1100 px and wider. Its direct children carry `.pb-span-1` to `.pb-span-12`, and the spans in one row total 12. Below 1100 px a row stacks its children in source order.

```html
<div class="pb-row">
  <div class="pb-span-5">
    <p>The queue owns retries, so the backoff lives in one place.</p>
  </div>
  <figure class="pb-span-7 pb-figure">
    <img src="queue.png" width="720" alt="The queue table with a retry_at column">
    <figcaption>The new column, at <code>3b19d35</code>.</figcaption>
  </figure>
</div>
```

- Source order is reading order. Put the claim before its evidence.
- A block outside a row keeps the 66-character measure of `look.css`.
- There's no sticky sidebar and no sticky top bar. The right edge holds content, and the dock carries the navigation.
- Under the shell, `.margin` notes and diff notes fold into their cell instead of floating in an outer column.
- A question may sit in a row beside its evidence. `kit.md` has the rules for where a question may sit.

A cell at 1100 px can be narrower than a phone column: a `.pb-span-4` there gets a third of the row, less the gaps. Size figures for the cell, not the window. The check holds SVG text and chart text to the 11 px floor at every Document view, and chart text under it is the fault `chart-text-small`.

A page without `data-base-shell` keeps the plain `look.css` layout. Its parts still work.
