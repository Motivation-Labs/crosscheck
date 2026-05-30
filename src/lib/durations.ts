const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

export function parseDurationMs(value: string): number {
  const match = value.trim().match(/^([1-9]\d*)([mhd])$/)
  if (!match) {
    throw new Error(`Invalid duration "${value}". Use formats like 30m, 2h, or 1d.`)
  }

  const amount = Number(match[1])
  const unit = match[2]
  if (unit === 'm') return amount * MINUTE_MS
  if (unit === 'h') return amount * HOUR_MS
  return amount * DAY_MS
}

export function formatElapsed(timestamp: string, now: number = Date.now()): string {
  const then = new Date(timestamp).getTime()
  if (Number.isNaN(then)) return '--'

  const elapsed = Math.max(0, now - then)
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)}m ago`
  if (elapsed < 48 * HOUR_MS) return `${Math.floor(elapsed / HOUR_MS)}h ago`
  return `${Math.floor(elapsed / DAY_MS)}d ago`
}
