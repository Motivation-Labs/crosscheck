import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { LogsConfig } from '../config/schema.js'

export interface LogEntry {
  level: 'info' | 'warn' | 'error'
  event: string
  [key: string]: unknown
}

export type ErrorCategory =
  | 'auth'        // bad credentials, token missing, not logged in
  | 'permission'  // insufficient scope, forbidden
  | 'rate_limit'  // GitHub API rate limit
  | 'timeout'     // subprocess or network timeout
  | 'network'     // connection refused, DNS failure
  | 'subprocess'  // CLI exited non-zero
  | 'unknown'

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

function classifyError(message: string): ErrorCategory {
  const m = message.toLowerCase()
  if (/bad credentials|401|not logged in|not authenticated|github_token|authentication required|token/.test(m)) return 'auth'
  if (/admin:org|admin:repo|forbidden|403|insufficient scope|requires.*scope|write:org/.test(m)) return 'permission'
  if (/rate limit|secondary rate|429/.test(m)) return 'rate_limit'
  if (/timeout|timed out|etimedout|deadline/.test(m)) return 'timeout'
  if (/econnrefused|enotfound|network|socket hang|socket timeout/.test(m)) return 'network'
  if (/exited with code|exit code [^0]|subprocess|command failed/.test(m)) return 'subprocess'
  return 'unknown'
}

// Extracts structured fields from an unknown thrown value, including execa subprocess errors.
function extractErrorFields(err: unknown): Record<string, unknown> {
  if (err == null) return { message: String(err) }

  const rawMessage = err instanceof Error ? err.message : String(err)
  const message = rawMessage.length > 2000 ? rawMessage.slice(0, 2000) + ' …[truncated]' : rawMessage
  const stack = err instanceof Error ? err.stack?.slice(0, 1000) : undefined
  const category = classifyError(rawMessage)

  // Duck-type execa errors — they carry exitCode, timedOut, stderr, command
  const maybeExeca = err as Record<string, unknown>
  const exitCode = typeof maybeExeca.exitCode === 'number' ? maybeExeca.exitCode : undefined
  const timedOut = maybeExeca.timedOut === true ? true : undefined
  const stderr = typeof maybeExeca.stderr === 'string' && maybeExeca.stderr.trim()
    ? maybeExeca.stderr.trim().slice(0, 500)  // cap to avoid bloat
    : undefined
  const command = typeof maybeExeca.command === 'string' ? maybeExeca.command : undefined

  return { message, stack, category, exitCode, timedOut, stderr, command }
}

export function logError(context: Record<string, unknown>, err: unknown): void {
  log({ level: 'error', event: 'error', ...extractErrorFields(err), ...context })
}

export function getLogDir(): string {
  return LOG_DIR
}

export function getTodayLogPath(): string {
  const today = new Date().toISOString().slice(0, 10)
  return join(LOG_DIR, `${today}.ndjson`)
}

// Exported so commands can register it with process error events
export function logUncaught(source: 'uncaughtException' | 'unhandledRejection', err: unknown): void {
  log({ level: 'error', event: 'process_error', source, ...extractErrorFields(err) })
}
