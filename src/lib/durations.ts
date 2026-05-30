const DURATION_RE = /^([1-9]\d*)([mhd])$/
const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

export function parseDuration(input: string): number {
  const match = input.trim().match(DURATION_RE)
  if (!match) {
    throw new Error('Invalid duration. Use a positive duration like 30m, 2h, or 1d.')
  }

  const value = Number(match[1])
  const unit = match[2]
  if (unit === 'm') return value * MINUTE_MS
  if (unit === 'h') return value * HOUR_MS
  return value * DAY_MS
}

export function parseDurationMs(value: string): number {
  return parseDuration(value)
}

export function formatDuration(ms: number): string {
  if (ms % DAY_MS === 0) return `${ms / DAY_MS}d`
  if (ms % HOUR_MS === 0) return `${ms / HOUR_MS}h`
  return `${Math.max(1, Math.round(ms / MINUTE_MS))}m`
}

export function formatElapsed(timestamp: string, now: number = Date.now()): string {
  const then = new Date(timestamp).getTime()
  if (Number.isNaN(then)) return '--'

  const elapsed = Math.max(0, now - then)
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)}m ago`
  if (elapsed < 48 * HOUR_MS) return `${Math.floor(elapsed / HOUR_MS)}h ago`
  return `${Math.floor(elapsed / DAY_MS)}d ago`
}
