import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { LogsConfig } from '../config/schema.js'

export interface LogEntry {
  level: 'info' | 'warn' | 'error'
  event: string
  [key: string]: unknown
}

const LOG_DIR = join(homedir(), '.crosscheck', 'logs')

let _enabled = false
let _logFile = ''

export function initLogger(config: LogsConfig): void {
  _enabled = config.enabled
  if (!_enabled) return

  mkdirSync(LOG_DIR, { recursive: true })

  // Retention cleanup — delete files older than retention_days
  const cutoffMs = Date.now() - config.retention_days * 24 * 60 * 60 * 1000
  try {
    for (const name of readdirSync(LOG_DIR)) {
      if (!name.endsWith('.ndjson')) continue
      const filePath = join(LOG_DIR, name)
      const mtime = statSync(filePath).mtimeMs
      if (mtime < cutoffMs) rmSync(filePath)
    }
  } catch { /* best-effort */ }

  const today = new Date().toISOString().slice(0, 10)
  _logFile = join(LOG_DIR, `${today}.ndjson`)
}

export function log(entry: LogEntry): void {
  if (!_enabled || !_logFile) return
  try {
    appendFileSync(_logFile, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n')
  } catch { /* best-effort — never crash the main process */ }
}

export function getLogDir(): string {
  return LOG_DIR
}

export function getTodayLogPath(): string {
  const today = new Date().toISOString().slice(0, 10)
  return join(LOG_DIR, `${today}.ndjson`)
}
