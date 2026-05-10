// Interactive arrow-key picker for CLI prompts.
// Uses raw-mode TTY input — degrades gracefully when stdin is not a TTY.

const HIDE_CURSOR = '\x1b[?25l'
const SHOW_CURSOR = '\x1b[?25h'
const ERASE_LINE = '\x1b[2K\r'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const CYAN = '\x1b[36m'
const RESET = '\x1b[0m'

const DEFAULT_PAGE_SIZE = 5

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
  opts: { title?: string; defaultIndex?: number } = {},
): Promise<number> {
  if (!process.stdin.isTTY || items.length === 0) return opts.defaultIndex ?? 0

  return new Promise<number>((resolve, reject) => {
    let cursor = opts.defaultIndex ?? 0
    let lastLineCount = 0

    function render(firstRender = false) {
      if (!firstRender) {
        process.stdout.write(`\x1b[${lastLineCount}A`)
      }

      const hint = items[cursor]?.hint ?? ''
      // title + items + hint line (always reserved) + footer
      lastLineCount = (opts.title ? 1 : 0) + items.length + 1 + 1

      if (opts.title) {
        process.stdout.write(`${ERASE_LINE}${BOLD}${opts.title}${RESET}\n`)
      }

      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        const isFocused = cursor === i
        const arrow = isFocused ? `${CYAN}❯${RESET}` : ' '
        const descStr = item.description ? `  ${DIM}${item.description}${RESET}` : ''
        const labelStr = isFocused ? `${BOLD}${item.label}${RESET}` : `${DIM}${item.label}${RESET}`
        process.stdout.write(`${ERASE_LINE}  ${arrow} ${labelStr}${descStr}\n`)
      }

      // Hint line: always one line so the line count stays constant between renders
      process.stdout.write(`${ERASE_LINE}${hint ? `${DIM}  💡 ${hint}${RESET}` : ''}\n`)
      process.stdout.write(`${ERASE_LINE}${DIM}  ↑↓ move · enter confirm${RESET}\n`)
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

// Arrow-key + space multi-select. Returns selected items.
// Returns [] when stdin is not a TTY.
export async function promptRepoPicker(
  items: string[],
  opts: PickerOptions = {},
): Promise<string[]> {
  if (!process.stdin.isTTY) return []
  if (items.length === 0) return []

  const effectivePageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE

  return new Promise<string[]>((resolve, reject) => {
    let cursor = 0
    const selected = new Set<number>(
      opts.initialSelected
        ? opts.initialSelected.map(s => items.indexOf(s)).filter(i => i !== -1)
        : [],
    )
    let showAll = false
    // Track how many lines the last render printed so the next re-render moves
    // the cursor by the right amount even when showAll changes between renders.
    let lastLineCount = 0

    function visibleItems(): { item: string; index: number }[] {
      if (showAll || items.length <= effectivePageSize) {
        return items.map((item, index) => ({ item, index }))
      }
      return items.slice(0, effectivePageSize).map((item, index) => ({ item, index }))
    }

    const visible = () => visibleItems()
    const hasMore = () => !showAll && items.length > effectivePageSize

    function render(firstRender = false) {
      const vis = visible()

      if (!firstRender) {
        process.stdout.write(`\x1b[${lastLineCount}A`)
      }
      lastLineCount = (opts.title ? 1 : 0) + vis.length + (hasMore() ? 1 : 0) + 1

      if (opts.title) {
        process.stdout.write(`${ERASE_LINE}${BOLD}${opts.title}${RESET}\n`)
      }

      for (const { item, index } of vis) {
        const isSelected = selected.has(index)
        const isFocused = cursor === index
        const checkStr = isSelected ? `${CYAN}[x]${RESET}` : '[ ]'
        const desc = opts.getDescription ? opts.getDescription(item) : ''
        const descStr = desc ? `  ${DIM}${desc}${RESET}` : ''
        if (isFocused) {
          process.stdout.write(`${ERASE_LINE}  ${checkStr} ${BOLD}${item}${RESET}${descStr}\n`)
        } else {
          process.stdout.write(`${ERASE_LINE}  ${checkStr} ${DIM}${item}${RESET}${descStr}\n`)
        }
      }

      if (hasMore()) {
        process.stdout.write(`${ERASE_LINE}${DIM}  ... ${items.length - effectivePageSize} more — press m to show all${RESET}\n`)
      }

      process.stdout.write(`${ERASE_LINE}${DIM}  ↑↓ move · space select · a all · enter confirm${hasMore() ? ' · m more' : ''}${RESET}\n`)
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
        // Ctrl+C
        process.removeListener('SIGINT', handleSigint)
        cleanup([])
        process.exit(130)
      }

      const vis = visible()
      const visIndices = vis.map(v => v.index)
      const posInVis = visIndices.indexOf(cursor)

      if (key === '\x1b[A') {
        // up arrow
        if (posInVis > 0) {
          cursor = visIndices[posInVis - 1]
        } else {
          cursor = visIndices[visIndices.length - 1]
        }
        render()
      } else if (key === '\x1b[B') {
        // down arrow
        if (posInVis < vis.length - 1) {
          cursor = visIndices[posInVis + 1]
        } else {
          cursor = visIndices[0]
        }
        render()
      } else if (key === ' ') {
        if (selected.has(cursor)) {
          selected.delete(cursor)
        } else {
          selected.add(cursor)
        }
        render()
      } else if (key === 'a') {
        // Toggle only the currently visible set — hidden overflow items are never
        // touched until the user expands with `m`.
        const visIndicesAll = visible().map(v => v.index)
        const allVisSelected = visIndicesAll.every(i => selected.has(i))
        if (allVisSelected) {
          for (const i of visIndicesAll) selected.delete(i)
        } else {
          for (const i of visIndicesAll) selected.add(i)
        }
        render()
      } else if (key === 'm' && hasMore()) {
        showAll = true
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
