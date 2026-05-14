// Interactive arrow-key picker for CLI prompts.
// Uses raw-mode TTY input — degrades gracefully when stdin is not a TTY.

const HIDE_CURSOR = '\x1b[?25l'
const SHOW_CURSOR = '\x1b[?25h'
const ERASE_LINE = '\x1b[2K\r'
// Clears from the cursor to the bottom of the screen. Used before re-rendering
// so leftover content from a taller previous render doesn't linger when the new
// render is shorter (e.g. after a filter narrows the list).
const ERASE_DOWN = '\x1b[0J'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const CYAN = '\x1b[36m'
const RESET = '\x1b[0m'

const DEFAULT_PAGE_SIZE = 12
// Chrome rows beyond the item viewport: title (≤1) + filter (1) + status (1) + footer (1) + safety (1).
const VIEWPORT_OVERHEAD = 6

// ── Pure helpers (unit-tested) ───────────────────────────────────────────────

// Indices into `items` whose lowercase label includes the lowercased query.
// Empty query returns every index in order.
export function filterIndices(items: string[], query: string): number[] {
  if (!query) return items.map((_, i) => i)
  const q = query.toLowerCase()
  const out: number[] = []
  for (let i = 0; i < items.length; i++) {
    if (items[i].toLowerCase().includes(q)) out.push(i)
  }
  return out
}

// Shift the viewport so the cursor is inside [windowStart, windowStart + viewport).
// Pure: returns the new windowStart. Clamps so the viewport never extends past the list.
export function adjustWindowStart(
  windowStart: number,
  cursorPos: number,
  viewport: number,
  total: number,
): number {
  let ws = windowStart
  if (cursorPos < ws) ws = cursorPos
  else if (cursorPos >= ws + viewport) ws = cursorPos - viewport + 1
  if (ws + viewport > total) ws = Math.max(0, total - viewport)
  if (ws < 0) ws = 0
  return ws
}

// Resolve the actual viewport row count given a caller hint and the live terminal height.
export function resolveViewport(hint: number | undefined, termRows: number | undefined): number {
  const rows = termRows && termRows > 0 ? termRows : 24
  const ceiling = Math.max(3, rows - VIEWPORT_OVERHEAD)
  const requested = hint && hint > 0 ? hint : DEFAULT_PAGE_SIZE
  return Math.max(3, Math.min(requested, ceiling))
}

// ── Single-select picker ─────────────────────────────────────────────────────

export interface PickerItem {
  label: string
  description?: string  // shown dim next to label
  hint?: string         // tip shown at the bottom when this item is focused
}

// Arrow-key single-select. Returns the index of the chosen item.
// Returns defaultIndex when stdin is not a TTY.
export async function promptSinglePicker(
  items: PickerItem[],
  opts: { title?: string; defaultIndex?: number; pageSize?: number } = {},
): Promise<number> {
  if (!process.stdin.isTTY || items.length === 0) return opts.defaultIndex ?? 0

  return new Promise<number>((resolve, reject) => {
    let cursor = opts.defaultIndex ?? 0
    let windowStart = 0
    let lastLineCount = 0

    const viewport = () => Math.min(resolveViewport(opts.pageSize, process.stdout.rows), items.length)

    function render(firstRender = false) {
      const vp = viewport()
      windowStart = adjustWindowStart(windowStart, cursor, vp, items.length)

      if (!firstRender) {
        process.stdout.write(`\x1b[${lastLineCount}A`)
      }

      const hint = items[cursor]?.hint ?? ''
      const showStatus = items.length > vp
      // title + items + hint + status (only when overflow) + footer
      lastLineCount = (opts.title ? 1 : 0) + vp + 1 + (showStatus ? 1 : 0) + 1

      if (opts.title) {
        process.stdout.write(`${ERASE_LINE}${BOLD}${opts.title}${RESET}\n`)
      }

      for (let i = 0; i < vp; i++) {
        const idx = windowStart + i
        if (idx >= items.length) {
          process.stdout.write(`${ERASE_LINE}\n`)
          continue
        }
        const item = items[idx]
        const isFocused = cursor === idx
        const arrow = isFocused ? `${CYAN}❯${RESET}` : ' '
        const descStr = item.description ? `  ${DIM}${item.description}${RESET}` : ''
        const labelStr = isFocused ? `${BOLD}${item.label}${RESET}` : `${DIM}${item.label}${RESET}`
        process.stdout.write(`${ERASE_LINE}  ${arrow} ${labelStr}${descStr}\n`)
      }

      process.stdout.write(`${ERASE_LINE}${hint ? `${DIM}  💡 ${hint}${RESET}` : ''}\n`)
      if (showStatus) {
        process.stdout.write(`${ERASE_LINE}${DIM}  ${cursor + 1}/${items.length}${RESET}\n`)
      }
      const navHint = showStatus ? '↑↓ PgUp/PgDn move' : '↑↓ move'
      process.stdout.write(`${ERASE_LINE}${DIM}  ${navHint} · enter confirm${RESET}\n`)
    }

    function cleanup(index: number) {
      try { process.stdin.setRawMode(false) } catch { /* not raw */ }
      process.stdin.removeAllListeners('data')
      process.stdout.write(SHOW_CURSOR)
      resolve(index)
    }

    function handleSigint() {
      cleanup(opts.defaultIndex ?? 0)
      process.exit(130)
    }

    process.stdout.write(HIDE_CURSOR)
    render(true)

    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.setEncoding('utf8')
    process.once('SIGINT', handleSigint)

    process.stdin.on('data', (key: string) => {
      if (key === '\x03') {
        process.removeListener('SIGINT', handleSigint)
        cleanup(opts.defaultIndex ?? 0)
        process.exit(130)
      }
      if (key === '\x1b[A') {
        cursor = cursor > 0 ? cursor - 1 : items.length - 1
        render()
      } else if (key === '\x1b[B') {
        cursor = cursor < items.length - 1 ? cursor + 1 : 0
        render()
      } else if (key === '\x1b[5~') {
        // PageUp — jump one viewport, clamp at top (no wrap)
        cursor = Math.max(0, cursor - viewport())
        render()
      } else if (key === '\x1b[6~') {
        // PageDown — jump one viewport, clamp at bottom (no wrap)
        cursor = Math.min(items.length - 1, cursor + viewport())
        render()
      } else if (key === '\r' || key === '\n') {
        process.removeListener('SIGINT', handleSigint)
        cleanup(cursor)
      }
    })

    process.stdin.on('error', (err) => {
      process.removeListener('SIGINT', handleSigint)
      process.stdout.write(SHOW_CURSOR)
      reject(err)
    })
  })
}

// ── Multi-select picker ──────────────────────────────────────────────────────

export interface PickerOptions {
  title?: string
  initialSelected?: string[]
  pageSize?: number
  // Optional: return dim metadata shown after each item label
  getDescription?: (item: string) => string
}

// Arrow-key + space multi-select with a fixed-height viewport and `/` filter.
// Returns selected items. Returns [] when stdin is not a TTY.
//
// The viewport is capped by `pageSize` *and* the terminal height — we never emit
// more rows than fit on screen, so cursor-up offsets stay accurate. Press `/` to
// enter filter mode; typing narrows the visible list, Esc clears the filter,
// Enter exits filter mode and returns to selection.
export async function promptRepoPicker(
  items: string[],
  opts: PickerOptions = {},
): Promise<string[]> {
  if (!process.stdin.isTTY) return []
  if (items.length === 0) return []

  return new Promise<string[]>((resolve, reject) => {
    const selected = new Set<number>(
      opts.initialSelected
        ? opts.initialSelected.map(s => items.indexOf(s)).filter(i => i !== -1)
        : [],
    )

    let filterText = ''
    let filterMode = false
    let filtered: number[] = filterIndices(items, '')
    let cursorPos = 0       // index into `filtered`
    let windowStart = 0     // index into `filtered`
    let lastLineCount = 0

    const viewport = () => resolveViewport(opts.pageSize, process.stdout.rows)

    function recomputeFiltered() {
      filtered = filterIndices(items, filterText)
      if (cursorPos >= filtered.length) cursorPos = Math.max(0, filtered.length - 1)
      windowStart = adjustWindowStart(windowStart, cursorPos, viewport(), filtered.length)
    }

    function render(firstRender = false) {
      const vp = viewport()
      windowStart = adjustWindowStart(windowStart, cursorPos, vp, filtered.length)

      if (!firstRender) {
        process.stdout.write(`\x1b[${lastLineCount}A`)
        // Erase leftover content from the previous (possibly taller) render so a
        // shrinking filter doesn't leave stale rows hanging below the new output.
        process.stdout.write(ERASE_DOWN)
      }

      // Render exactly as many item rows as we have items, capped at the
      // viewport. Empty filter result → one "(no matches)" hint row instead.
      const visibleRows = Math.min(vp, filtered.length)
      const emptyHint = filtered.length === 0
      const itemRows = emptyHint ? 1 : visibleRows

      lastLineCount = (opts.title ? 1 : 0) + 1 + itemRows + 1 + 1

      if (opts.title) {
        process.stdout.write(`${ERASE_LINE}${BOLD}${opts.title}${RESET}\n`)
      }

      if (filterMode || filterText) {
        const caret = filterMode ? '█' : ''
        process.stdout.write(`${ERASE_LINE}  ${CYAN}/${RESET} ${filterText}${caret}\n`)
      } else {
        process.stdout.write(`${ERASE_LINE}\n`)
      }

      if (emptyHint) {
        process.stdout.write(`${ERASE_LINE}  ${DIM}(no matches)${RESET}\n`)
      } else {
        for (let row = 0; row < visibleRows; row++) {
          const fi = windowStart + row
          const origIdx = filtered[fi]
          const item = items[origIdx]
          const isSelected = selected.has(origIdx)
          const isFocused = cursorPos === fi
          const checkStr = isSelected ? `${CYAN}[x]${RESET}` : '[ ]'
          const desc = opts.getDescription ? opts.getDescription(item) : ''
          const descStr = desc ? `  ${DIM}${desc}${RESET}` : ''
          const labelStr = isFocused ? `${BOLD}${item}${RESET}` : `${DIM}${item}${RESET}`
          process.stdout.write(`${ERASE_LINE}  ${checkStr} ${labelStr}${descStr}\n`)
        }
      }

      const total = filtered.length
      const pos = total === 0 ? 0 : cursorPos + 1
      const selCount = selected.size
      const filterNote = filterText ? ` · filter: "${filterText}"` : ''
      const selNote = selCount > 0 ? ` · ${selCount} selected` : ''
      process.stdout.write(`${ERASE_LINE}${DIM}  ${pos}/${total}${filterNote}${selNote}${RESET}\n`)

      // PgUp/PgDn only when the *current* visible list overflows the viewport.
      // After a filter narrows the list, the hint shrinks accordingly.
      const navHint = filtered.length > vp ? '↑↓ PgUp/PgDn move' : '↑↓ move'
      if (filterMode) {
        process.stdout.write(`${ERASE_LINE}${DIM}  ${navHint} · type to filter · backspace · esc clear · enter done${RESET}\n`)
      } else {
        process.stdout.write(`${ERASE_LINE}${DIM}  ${navHint} · space select · a all · / filter · enter confirm${RESET}\n`)
      }
    }

    function cleanup(result: string[]) {
      try {
        process.stdin.setRawMode(false)
      } catch { /* not a raw TTY */ }
      process.stdin.removeAllListeners('data')
      process.stdout.write(SHOW_CURSOR)
      resolve(result)
    }

    function handleSigint() {
      cleanup([])
      process.exit(130)
    }

    process.stdout.write(HIDE_CURSOR)
    render(true)

    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.setEncoding('utf8')
    process.once('SIGINT', handleSigint)

    process.stdin.on('data', (key: string) => {
      if (key === '\x03') {
        process.removeListener('SIGINT', handleSigint)
        cleanup([])
        process.exit(130)
      }

      // Navigation keys work in both modes — let the user scroll while filtering.
      if (key === '\x1b[A') {
        if (filtered.length === 0) return
        cursorPos = cursorPos > 0 ? cursorPos - 1 : filtered.length - 1
        render()
        return
      }
      if (key === '\x1b[B') {
        if (filtered.length === 0) return
        cursorPos = cursorPos < filtered.length - 1 ? cursorPos + 1 : 0
        render()
        return
      }
      if (key === '\x1b[5~') {
        // PageUp — one viewport, clamp at top (no wrap)
        if (filtered.length === 0) return
        cursorPos = Math.max(0, cursorPos - viewport())
        render()
        return
      }
      if (key === '\x1b[6~') {
        // PageDown — one viewport, clamp at bottom (no wrap)
        if (filtered.length === 0) return
        cursorPos = Math.min(filtered.length - 1, cursorPos + viewport())
        render()
        return
      }

      if (filterMode) {
        if (key === '\x1b') {
          // Esc — clear filter and exit filter mode
          filterMode = false
          filterText = ''
          recomputeFiltered()
          render()
          return
        }
        if (key === '\r' || key === '\n') {
          // Enter — exit filter mode, keep filter applied
          filterMode = false
          render()
          return
        }
        if (key === '\x7f' || key === '\b') {
          // Backspace
          filterText = filterText.slice(0, -1)
          recomputeFiltered()
          render()
          return
        }
        // Printable characters extend the filter. Reject control sequences and
        // anything multi-byte we don't recognize.
        if (key.length === 1 && key >= ' ' && key <= '~') {
          filterText += key
          recomputeFiltered()
          render()
          return
        }
        return
      }

      // Non-filter mode
      if (key === '/') {
        filterMode = true
        render()
      } else if (key === ' ') {
        if (filtered.length === 0) return
        const origIdx = filtered[cursorPos]
        if (selected.has(origIdx)) selected.delete(origIdx)
        else selected.add(origIdx)
        render()
      } else if (key === 'a') {
        // Toggle every item in the current filtered view.
        const allOn = filtered.every(i => selected.has(i))
        if (allOn) for (const i of filtered) selected.delete(i)
        else for (const i of filtered) selected.add(i)
        render()
      } else if (key === '\r' || key === '\n') {
        process.removeListener('SIGINT', handleSigint)
        cleanup(Array.from(selected).sort((a, b) => a - b).map(i => items[i]))
      }
    })

    process.stdin.on('error', (err) => {
      process.removeListener('SIGINT', handleSigint)
      process.stdout.write(SHOW_CURSOR)
      reject(err)
    })
  })
}
