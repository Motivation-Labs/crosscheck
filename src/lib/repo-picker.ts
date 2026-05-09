// Interactive arrow-key + space multi-select picker for CLI prompts.
// Uses raw-mode TTY input — degrades gracefully when stdin is not a TTY.

const HIDE_CURSOR = '\x1b[?25l'
const SHOW_CURSOR = '\x1b[?25h'
const ERASE_LINE = '\x1b[2K\r'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const RESET = '\x1b[0m'

const PAGE_SIZE = 15

export interface PickerOptions {
  title?: string
  initialSelected?: string[]
}

// Returns selected items. Returns [] when stdin is not a TTY.
export async function promptRepoPicker(
  items: string[],
  opts: PickerOptions = {},
): Promise<string[]> {
  if (!process.stdin.isTTY) return []
  if (items.length === 0) return []

  return new Promise<string[]>((resolve, reject) => {
    let cursor = 0
    const selected = new Set<number>(
      opts.initialSelected
        ? opts.initialSelected.map(s => items.indexOf(s)).filter(i => i !== -1)
        : [],
    )
    let showAll = false

    function visibleItems(): { item: string; index: number }[] {
      if (showAll || items.length <= PAGE_SIZE) {
        return items.map((item, index) => ({ item, index }))
      }
      return items.slice(0, PAGE_SIZE).map((item, index) => ({ item, index }))
    }

    const visible = () => visibleItems()
    const hasMore = () => !showAll && items.length > PAGE_SIZE

    function render(firstRender = false) {
      const vis = visible()

      if (!firstRender) {
        // Move cursor up to the first rendered line and clear downward
        const lineCount = (opts.title ? 1 : 0) + vis.length + (hasMore() ? 1 : 0) + 1
        process.stdout.write(`\x1b[${lineCount}A`)
      }

      if (opts.title) {
        process.stdout.write(`${ERASE_LINE}${BOLD}${opts.title}${RESET}\n`)
      }

      for (const { item, index } of vis) {
        const isSelected = selected.has(index)
        const isFocused = cursor === index
        const check = isSelected ? '[x]' : '[ ]'
        const line = isFocused
          ? `${BOLD}  ${check} ${item}${RESET}`
          : `  ${check} ${DIM}${item}${RESET}`
        process.stdout.write(`${ERASE_LINE}${line}\n`)
      }

      if (hasMore()) {
        process.stdout.write(`${ERASE_LINE}${DIM}  ... ${items.length - PAGE_SIZE} more — press m to show all${RESET}\n`)
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
        if (selected.size === items.length) {
          selected.clear()
        } else {
          for (let i = 0; i < items.length; i++) selected.add(i)
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
