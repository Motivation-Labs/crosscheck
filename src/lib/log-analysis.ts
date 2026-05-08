import { readdirSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { classifyError } from '../commands/diagnose.js'

const DEFAULT_LOG_DIR = join(homedir(), '.crosscheck', 'logs')

export interface RawLogEntry {
  ts: string
  level: string
  event: string
  message?: string
  repo?: string
  pr?: number
  reviewer?: string
  [key: string]: unknown
}

export function sanitizeEntry(entry: RawLogEntry): RawLogEntry {
  const out: RawLogEntry = { ...entry }
  // Sanitize repo field first (explicit replacement, not text pattern)
  if (out.repo) out.repo = '[repo]'
  // Sanitize every string-valued field — covers message, stack, stderr, command,
  // branch, url, and any future fields added by logError
  for (const key of Object.keys(out)) {
    if (key === 'repo') continue
    if (typeof out[key] === 'string') out[key] = sanitizeText(out[key] as string)
  }
  return out
}

export function sanitizeDraftContent(title: string, body: string): { title: string; body: string } {
  return { title: sanitizeText(title), body: sanitizeText(body) }
}

function sanitizeText(s: string): string {
  return s
    .replace(/https?:\/\/github\.com\/[^\s"']*/g, '[github-url]')
    // File paths before owner/repo to prevent double-replacement of path segments
    .replace(/(?:\/[a-zA-Z0-9_.-]+){2,}\.[a-zA-Z]{2,5}/g, '[file-path]')
    .replace(/\b[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+\b/g, '[repo]')
    .replace(/@[a-zA-Z0-9][a-zA-Z0-9_-]*/g, '[username]')
}

function collectFiles(since?: string, logDir = DEFAULT_LOG_DIR): string[] {
  if (!existsSync(logDir)) return []
  return readdirSync(logDir)
    .filter(f => f.endsWith('.ndjson'))
    .filter(f => !since || f.replace('.ndjson', '') >= since)
    .sort()
    .map(f => join(logDir, f))
}

function parseFile(filePath: string): RawLogEntry[] {
  const out: RawLogEntry[] = []
  for (const line of readFileSync(filePath, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line) as RawLogEntry) } catch { /* skip malformed */ }
  }
  return out
}

export function loadErrorEntriesForPattern(
  pattern: string,
  command?: string,
  since?: string,
  logDir?: string,
): RawLogEntry[] {
  const files = collectFiles(since, logDir)
  const matches: RawLogEntry[] = []
  for (const file of files) {
    for (const entry of parseFile(file)) {
      if (entry.event !== 'error' || entry.level !== 'error') continue
      if (!entry.message) continue
      const { pattern: p, command: cmd } = classifyError(entry.message)
      if (p !== pattern) continue
      if (pattern === 'command_not_found' && command && cmd !== command) continue
      matches.push(entry)
    }
  }
  return matches.slice(0, 5)
}
