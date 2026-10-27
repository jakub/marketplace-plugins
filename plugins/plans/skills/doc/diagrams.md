# Diagrams

Draw a figure when the reader would otherwise build a picture in their head from prose: a topology, a sequence across components, a structure before and after a change, or a size that matters. Don't draw a list. A figure of five boxes in a row that says nothing a five-item list wouldn't say costs the reader more than the list.

Every figure is inline SVG in the page, in the same technical-drawing look as the text. The recipes below are worked defaults, not a grammar. Use as many elements as the figure needs, and change a recipe when the content asks for it.

## Build every figure the same way

- Write an inline `<svg viewBox="…">` at `width: 100%`, with `role="img"` and a `<title>` as its first child.
- Prefix every id in a figure with the figure's own prefix, such as `f2-`, markers and the title included. Two figures on one page must never share an id.
- Draw 1 px strokes that don't scale, in `currentColor` or a `--plans-*` token.
- Set text at 11 CSS px or more as rendered at 390 px wide, and aim for 13 to 14 px.
- Place every coordinate on an 8-unit grid. Route connectors orthogonally, and put labels outside shapes and beside lines, never across a stroke.
- Use the accent only on the part that changed.
- For narrow screens, draw a tall variant or a simpler figure.

Never use any of these, because the viewer or the build check rejects them:

- an `href` that is external or relative. Only `#id` references inside the page work.
- `<image>` with a file path. Put a picture in an HTML `<img>` beside the figure.
- `<foreignObject>` for layout. Lay the HTML out in HTML instead.
- web fonts. Use `--plans-sans` and `--plans-mono`.
- filters, and the shadows and blurs made with them.

## Set up the figure styles

Put these rules once in the page's `<style>`, after the `<!-- plans:kit -->` line. Every recipe below uses them. Inside an SVG, a CSS `font-size` in px counts viewBox units, so the figure's scale decides what the reader sees.

```html
<style>
  .fig { display: block; width: 100%; max-width: 26rem; height: auto; color: var(--plans-ink); }
  .fig text { font-family: var(--plans-sans); font-size: 14px; fill: currentColor; font-variant-numeric: tabular-nums; }
  .fig .mono { font-family: var(--plans-mono); }
  .fig .soft { fill: var(--plans-ink-2); }
  .fig line, .fig path, .fig rect, .fig circle, .fig polyline { vector-effect: non-scaling-stroke; }
  .fig .ln { fill: none; stroke: currentColor; stroke-width: 1; }
  .fig .hair { fill: none; stroke: var(--plans-rule); stroke-width: 1; }
  .fig .dot { fill: currentColor; }
  .fig .chg { stroke: var(--plans-accent); }
  .fig .dot.chg { fill: var(--plans-accent); }
  .fig text.chg { fill: var(--plans-accent-text); stroke: none; }
</style>
```

## Size the text for a phone

The rendered text size is the `font-size` times the rendered figure width, divided by the viewBox width. At 390 px wide, the Document column is about 354 CSS px. At 1440 px wide, it is about 620, and the `max-width: 26rem` above holds a figure to 416.

| viewBox width | `font-size` | text at 390 | text at 1440, capped | text at 1440, uncapped |
|---|---|---|---|---|
| 360 | 14 | 13.8 px | 16 px | 24 px |
| 640 | 14 | 7.7 px, under the floor | | 13.6 px |

So draw for the phone first, at a viewBox width of about 360, and keep the cap. A figure that needs more width than that gets two variants, as in the last recipe.

## Route connectors on the grid

Boxes sit on the 8-unit grid, and connectors leave from the middle of an edge and turn only at right angles. Each label sits above its box or beside its line. The new part, the queue, is the only accent.

```html
<figure>
  <svg class="fig" viewBox="0 0 368 216" role="img" aria-labelledby="f1-title">
    <title id="f1-title">The client sends to a new queue, the queue delivers to the worker, and the worker sends retries back to the client.</title>
    <defs>
      <marker id="f1-arrow" viewBox="0 0 8 8" refX="8" refY="4" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
        <path d="M0 0L8 4L0 8Z" fill="currentColor"/>
      </marker>
    </defs>
    <text x="8" y="24">client</text>
    <rect class="ln" x="8" y="32" width="112" height="48"/>
    <text class="chg" x="248" y="24">queue (new)</text>
    <rect class="ln chg" x="248" y="32" width="112" height="48"/>
    <text x="248" y="208">worker</text>
    <rect class="ln" x="248" y="136" width="112" height="48"/>
    <path class="ln" d="M120 56H248" marker-end="url(#f1-arrow)"/>
    <text class="soft" x="184" y="48" text-anchor="middle">send</text>
    <path class="ln" d="M304 80V136" marker-end="url(#f1-arrow)"/>
    <text class="soft" x="312" y="112">deliver</text>
    <path class="ln" d="M248 160H64V80" marker-end="url(#f1-arrow)"/>
    <text class="soft" x="156" y="152" text-anchor="middle">retry</text>
  </svg>
  <figcaption>Retries move from the client into the queue.</figcaption>
</figure>
```

The marker is part of the figure, so its id carries the prefix too, and `url(#f1-arrow)` points inside the page. A marker with `markerUnits="userSpaceOnUse"` keeps its size whatever the stroke width.

## Name parts with leader callouts

A leader callout is a dot on the part, a thin line at 45 degrees, and a short horizontal shoulder with the text at its end. Use it instead of text inside a shape, and keep each callout's text to a few words.

```html
<figure>
  <svg class="fig" viewBox="0 0 360 160" role="img" aria-labelledby="f2-title">
    <title id="f2-title">The deliveries table has an unchanged id column and a new retry_at column.</title>
    <text x="8" y="24">deliveries</text>
    <rect class="ln" x="8" y="40" width="176" height="96"/>
    <line class="ln" x1="8" y1="64" x2="184" y2="64"/>
    <line class="hair" x1="8" y1="88" x2="184" y2="88"/>
    <line class="hair" x1="8" y1="112" x2="184" y2="112"/>
    <circle class="dot" cx="168" cy="76" r="2"/>
    <path class="ln" d="M168 76L192 52H208"/>
    <text x="214" y="57">id, unchanged</text>
    <circle class="dot chg" cx="168" cy="124" r="2"/>
    <path class="ln chg" d="M168 124L192 148H208"/>
    <text class="chg mono" x="214" y="153">retry_at, new</text>
  </svg>
  <figcaption>One column is added. No column is renamed.</figcaption>
</figure>
```

## Show a real quantity with a dimension line

A dimension line marks a measured size. It has an extension line at each end of the measured part, a 45-degree tick where the two lines cross, and its value in a gap in the line, in tabular figures. It has no arrowheads, so the reader never confuses it with a flow arrow. Draw one only for a quantity you measured or computed.

```html
<figure>
  <svg class="fig" viewBox="0 0 376 136" role="img" aria-labelledby="f3-title">
    <title id="f3-title">One send takes 360 ms: 120 ms waiting in the queue and 240 ms sending.</title>
    <text x="68" y="56" text-anchor="middle">wait</text>
    <text x="248" y="56" text-anchor="middle">send</text>
    <rect class="ln" x="8" y="64" width="120" height="24"/>
    <rect class="ln" x="128" y="64" width="240" height="24"/>
    <!-- overall: extension lines, dimension line with a gap, ticks -->
    <path class="hair" d="M8 60V16M368 60V16"/>
    <path class="ln" d="M8 24H156M220 24H368"/>
    <path class="ln" d="M4 28L12 20M364 28L372 20"/>
    <text x="188" y="29" text-anchor="middle">360 ms</text>
    <!-- chain: one dimension per segment -->
    <path class="hair" d="M8 92V120M128 92V120M368 92V120"/>
    <path class="ln" d="M8 112H42M94 112H220M276 112H368"/>
    <path class="ln" d="M4 116L12 108M124 116L132 108M364 116L372 108"/>
    <text x="68" y="117" text-anchor="middle">120 ms</text>
    <text x="248" y="117" text-anchor="middle">240 ms</text>
  </svg>
  <figcaption>Median of 50 sends on fractal, 2026-10-26.</figcaption>
</figure>
```

The line from 94 to 220 crosses the tick at 128 without a break, because the two segments share that end. Scale the parts to the quantity, here 1 unit for 1 ms, so the drawing is true as well as labelled.

## Draw a tall variant for narrow screens

A process with four steps in a row needs a viewBox about 640 units wide, and its text falls under the floor on a phone. Draw the same steps twice: a wide figure for wide screens and a tall one below 600 px. Each variant has its own id prefix and its own `<title>`. The hidden one has `display: none`, so a screen reader reads only the one shown.

```html
<style>
  .fig.fig-wide { max-width: none; }
  .fig.fig-tall { display: none; }
  @media (max-width: 600px) { .fig.fig-wide { display: none; } .fig.fig-tall { display: block; } }
</style>
<figure>
  <svg class="fig fig-wide" viewBox="0 0 648 96" role="img" aria-labelledby="f4w-title">
    <title id="f4w-title">The source page goes through build.mjs and a Chromium check, and comes out as the built page.</title>
    <defs>
      <marker id="f4w-arrow" viewBox="0 0 8 8" refX="8" refY="4" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
        <path d="M0 0L8 4L0 8Z" fill="currentColor"/>
      </marker>
    </defs>
    <text class="mono" x="8" y="32">page.html</text>
    <rect class="ln" x="8" y="40" width="128" height="40"/>
    <text class="mono" x="176" y="32">build.mjs</text>
    <rect class="ln" x="176" y="40" width="128" height="40"/>
    <text x="344" y="32">Chromium check</text>
    <rect class="ln" x="344" y="40" width="128" height="40"/>
    <text class="mono" x="512" y="32">page.built.html</text>
    <rect class="ln" x="512" y="40" width="128" height="40"/>
    <path class="ln" d="M136 60H176" marker-end="url(#f4w-arrow)"/>
    <path class="ln" d="M304 60H344" marker-end="url(#f4w-arrow)"/>
    <path class="ln" d="M472 60H512" marker-end="url(#f4w-arrow)"/>
  </svg>
  <svg class="fig fig-tall" viewBox="0 0 360 312" role="img" aria-labelledby="f4t-title">
    <title id="f4t-title">The source page goes through build.mjs and a Chromium check, and comes out as the built page.</title>
    <defs>
      <marker id="f4t-arrow" viewBox="0 0 8 8" refX="8" refY="4" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
        <path d="M0 0L8 4L0 8Z" fill="currentColor"/>
      </marker>
    </defs>
    <rect class="ln" x="8" y="24" width="160" height="40"/>
    <text class="mono" x="184" y="49">page.html</text>
    <rect class="ln" x="8" y="104" width="160" height="40"/>
    <text class="mono" x="184" y="129">build.mjs</text>
    <rect class="ln" x="8" y="184" width="160" height="40"/>
    <text x="184" y="209">Chromium check</text>
    <rect class="ln" x="8" y="264" width="160" height="40"/>
    <text class="mono" x="184" y="289">page.built.html</text>
    <path class="ln" d="M88 64V104" marker-end="url(#f4t-arrow)"/>
    <path class="ln" d="M88 144V184" marker-end="url(#f4t-arrow)"/>
    <path class="ln" d="M88 224V264" marker-end="url(#f4t-arrow)"/>
  </svg>
</figure>
```

Give each arrow its own `<path>`. A `marker-end` on one path with several subpaths draws only at the end of the last one.
