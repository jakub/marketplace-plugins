/* plans-kit:shell.js */
/* The page shell for <body data-base-shell> (parts.md). Each DOM write costs ask.js one
   validation, so it writes on a state change only, never per scroll frame. */
(() => {
  'use strict'

  const d = document
  const STATUS = ['supported', 'partial', 'unknown', 'refuted', 'proposed', 'changed', 'unchanged']
  const logged = new Set()
  const fault = (part, what) => {
    const line = 'plans-part: ' + part + ': ' + what
    if (!logged.has(line)) console.error(line)
    logged.add(line)
  }
  const make = (tag, text = '') => Object.assign(d.createElement(tag), { textContent: text })
  const button = (text) => Object.assign(make('button', text), { type: 'button' })
  // However a dialog closes, focus goes back to what opened it.
  const dialog = (opener) => {
    const g = make('dialog')
    g.addEventListener('close', () => opener().focus({ preventScroll: true }))
    return g
  }

  // Light is the kit sheet's first :root rule, dark its dark-scheme rule, which names the fallbacks.
  function theme (mast) {
    let light, dark
    for (const r of d.querySelector('style[data-plans-kit]')?.sheet?.cssRules || []) {
      if (!light && r.selectorText === ':root') light = r.style
      if (!dark && /prefers-color-scheme:\s*dark/.test(r.media?.mediaText)) {
        for (const k of r.cssRules) if (k.selectorText === ':root') dark = k.style
      }
    }
    if (!light || !dark) return fault('theme', 'the kit sheet has no :root rule or no dark-scheme rule')
    const names = Array.from(dark).filter((n) => n.startsWith('--plans-fb-'))
    const rule = (s, from) => ':root[data-plans-theme="' + s + '"]{color-scheme:' + s + ';' + names.map((n) => n + ':' + from.getPropertyValue(n).trim()).join(';') + '}'
    const css = make('style', rule('light', light) + rule('dark', dark))
    css.setAttribute('data-plans-theme-rules', '')
    d.head.append(css)
    const MODES = ['auto', 'light', 'dark']
    const root = d.documentElement
    let mode = 0
    const b = button('Theme: auto')
    b.className = 'plans-theme'
    b.addEventListener('click', () => {
      mode = (mode + 1) % 3
      if (mode) root.setAttribute('data-plans-theme', MODES[mode])
      else root.removeAttribute('data-plans-theme')
      b.textContent = 'Theme: ' + MODES[mode]
    })
    mast.append(b)
  }

  // Heading text, less a leading .num hung in a number column.
  const titleOf = (h) => {
    let t = ''
    for (const n of h.childNodes) if (!(n.nodeType === 1 && !t.trim() && n.matches('.num'))) t += n.textContent
    return t.replace(/\s+/g, ' ').trim()
  }

  function contents (mast) {
    const nav = d.querySelector('[data-base-contents]')
    const rows = []
    for (const s of d.querySelectorAll('main > section[id]')) {
      const h = s.firstElementChild
      if (!s.id || !h || h.localName !== 'h2') continue
      const st = s.getAttribute('data-base-status')
      const ok = STATUS.includes(st)
      if (!ok) fault('contents', 'section "' + s.id + '" needs a data-base-status of ' + STATUS.join(' '))
      rows.push({ s, title: titleOf(h) || s.id, st: ok && st, asks: Array.from(s.querySelectorAll('fieldset[data-ask]')) })
    }
    const asks = Array.from(d.querySelectorAll('fieldset[data-ask]'))

    // Each count keeps its text, so an answer writes only the counts it moved.
    const counts = []
    const unanswered = (f) => !['changed', 'kept'].includes(f.getAttribute('data-plans-state'))
    const tally = () => {
      for (const c of counts) {
        const n = c.mine.filter(unanswered).length
        const text = n ? n + ' open' : 'answered'
        if (text === c.text) continue
        c.text = text
        c.span.textContent = text
        c.span.classList.toggle('plans-open', n > 0)
      }
    }
    const list = () => {
      const ol = make('ol')
      ol.className = 'plans-rows'
      for (const r of rows) {
        const a = make('a')
        a.className = 'plans-row'
        a.setAttribute('href', '#' + r.s.id)
        const t = make('span', r.title)
        t.className = 'plans-row-title'
        a.append(t)
        if (r.st) {
          const chip = make('span', r.st)
          chip.className = 'plans-chip'
          chip.setAttribute('data-plans-status', r.st)
          a.append(chip)
        }
        if (r.asks.length) {
          const k = make('span')
          k.className = 'plans-row-count'
          a.append(k)
          counts.push({ span: k, mine: r.asks })
        }
        ol.append(make('li'))
        ol.lastChild.append(a)
      }
      return ol
    }

    if (nav && (nav.children.length || nav.textContent.trim())) fault('contents', 'the nav is not empty; the shell fills it')
    else if (nav && !rows.length) fault('contents', 'no main > section[id] opens with an h2')
    else if (nav) nav.append(list())
    if (!rows.length) return

    const dock = make('div')
    dock.className = 'plans-dock'
    dock.hidden = true
    const where = make('span')
    where.className = 'plans-dock-where'
    dock.append(where)
    if (asks.length) {
      const k = make('span')
      k.className = 'plans-dock-count'
      dock.append(k)
      counts.push({ span: k, mine: asks })
    }
    const go = button('Sections')
    go.className = 'plans-dock-sections'
    dock.append(go)
    const sheet = dialog(() => go)
    sheet.className = 'plans-sheet'
    sheet.setAttribute('aria-label', 'Sections')
    const close = button('Close')
    close.className = 'plans-sheet-close'
    const links = list()
    sheet.append(close, links)
    d.body.append(dock, sheet)

    let now = -1
    const here = (i) => {
      if (i !== now) where.textContent = i + 1 + '/' + rows.length + ' ' + rows[(now = i)].title
    }
    here(0)
    go.addEventListener('click', () => {
      const as = links.querySelectorAll('a')
      as.forEach((a, i) => { if (i === now) a.setAttribute('aria-current', 'location'); else a.removeAttribute('aria-current') })
      sheet.showModal()
      as[now].focus()
    })
    close.addEventListener('click', () => sheet.close())
    // A row closes the sheet, then its link jumps. A press outside the sheet closes it too.
    sheet.addEventListener('click', (e) => {
      const r = sheet.getBoundingClientRect()
      if (e.target.closest('a') || e.clientY < r.top || e.clientX < r.left || e.clientX > r.right) sheet.close()
    })

    // The section in view is the first one that reaches below a line 35% down the viewport.
    const below = new Set()
    const io = new IntersectionObserver((es) => {
      for (const e of es) below[e.isIntersecting ? 'add' : 'delete'](rows.findIndex((r) => r.s === e.target))
      if (below.size) here(Math.min(...below))
    }, { rootMargin: '-35% 0px 0px 0px' })
    for (const r of rows) io.observe(r.s)
    // The dock shows once the contents, else the masthead, sit above the view.
    new IntersectionObserver((es) => {
      const e = es[es.length - 1]
      const show = !e.isIntersecting && e.boundingClientRect.bottom <= 0
      if (dock.hidden === show) dock.hidden = !show
    }).observe(nav || mast || rows[0].s)

    tally()
    const mo = new MutationObserver(tally)
    for (const f of asks) mo.observe(f, { attributes: true, attributeFilter: ['data-plans-state'] })
  }

  // Actual size is the natural width over data-base-dpr, else over naturalWidth / width, else 1.
  function zoom () {
    let box, img, size, from, ratio
    const build = () => {
      box = dialog(() => from)
      box.className = 'plans-zoom'
      size = button()
      size.className = 'plans-zoom-size'
      const close = button('Close')
      close.className = 'plans-zoom-close'
      img = make('img')
      img.className = 'plans-zoom-img'
      box.append(size, close, img)
      d.body.append(box)
      close.addEventListener('click', () => box.close())
      size.addEventListener('click', () => {
        if (size.textContent === 'Fit') {
          img.style.inlineSize = ''
          size.textContent = 'Actual size'
        } else {
          img.decode().then(() => {
            img.style.inlineSize = img.naturalWidth / ratio() + 'px'
            size.textContent = 'Fit'
          }, () => {})
        }
      })
    }
    d.querySelectorAll('figure.pb-figure[data-base-zoom] img').forEach((pic, n) => {
      const name = 'zoomable image ' + (n + 1)
      if (pic.closest('fieldset[data-ask]')) return fault('zoom', name + ' is inside a question; the shell never writes there')
      const raw = pic.getAttribute('data-base-dpr')
      const dpr = raw === null ? 0 : /^(\d+\.?\d*|\.\d+)$/.test(raw) ? Number(raw) : -1
      if (raw !== null && !(dpr > 0)) return fault('zoom', 'data-base-dpr="' + raw + '" on ' + name + ' is not a number over 0')
      const label = 'Zoom: ' + (pic.alt.trim() || name)
      const b = button()
      b.className = 'plans-zoom-open'
      b.setAttribute('aria-label', label)
      pic.replaceWith(b)
      b.append(pic)
      b.addEventListener('click', () => {
        if (!box) build()
        from = b
        const w = parseInt(pic.getAttribute('width'), 10)
        ratio = () => dpr || (w > 0 ? img.naturalWidth / w : 1)
        img.src = pic.currentSrc || pic.src
        img.alt = pic.alt
        img.style.inlineSize = ''
        size.textContent = 'Actual size'
        box.setAttribute('aria-label', label)
        box.showModal()
      })
    })
  }

  function start () {
    if (!d.body || !d.body.hasAttribute('data-base-shell')) return
    const mast = d.querySelector('header.pb-mast')
    if (mast) theme(mast)
    else fault('theme', 'the page has no header.pb-mast to hold the switch')
    contents(mast)
    zoom()
  }

  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', start, { once: true })
  else start()
})()
