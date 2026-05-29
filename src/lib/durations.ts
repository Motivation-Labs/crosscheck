const DURATION_RE = /^([1-9]\d*)([mhd])$/

export function parseDuration(input: string): number {
  const match = input.trim().match(DURATION_RE)
  if (!match) {
    throw new Error('Invalid duration. Use a positive duration like 30m, 2h, or 1d.')
  }

  const value = Number(match[1])
  const unit = match[2]
  if (unit === 'm') return value * 60 * 1000
  if (unit === 'h') return value * 60 * 60 * 1000
  return value * 24 * 60 * 60 * 1000
}

export function formatDuration(ms: number): string {
  const dayMs = 24 * 60 * 60 * 1000
  const hourMs = 60 * 60 * 1000
  const minuteMs = 60 * 1000
  if (ms % dayMs === 0) return `${ms / dayMs}d`
  if (ms % hourMs === 0) return `${ms / hourMs}h`
  return `${Math.max(1, Math.round(ms / minuteMs))}m`
}
