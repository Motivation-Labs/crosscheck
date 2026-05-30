import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { homedir } from 'os'

export const SCAN_CACHE_TTL_MS = 60 * 1000

export interface ScanCacheKeyInput {
  configPath: string | null
  monitorScopeHash: string
  githubLogin: string | null
  staleAfterMs: number
  packageVersion: string
}

interface ScanCacheEnvelope<T> {
  key: string
  createdAt: string
  data: T
}

interface ScanCacheOptions {
  cachePath?: string
  force?: boolean
  now?: number
  partialFailure?: boolean
}

export function getScanCachePath(): string {
  return join(homedir(), '.crosscheck', 'cache', 'scan.json')
}

export function buildMonitorScopeHash(scope: unknown): string {
  return sha256(stableStringify(scope))
}

export function buildScanCacheKey(input: ScanCacheKeyInput): string {
  return sha256(stableStringify(input))
}

export function readScanCache<T>(key: string, options: ScanCacheOptions = {}): T | null {
  if (options.force === true) return null

  const path = options.cachePath ?? getScanCachePath()
  if (!existsSync(path)) return null

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as ScanCacheEnvelope<T>
    if (!parsed || parsed.key !== key || typeof parsed.createdAt !== 'string') return null

    const createdAt = new Date(parsed.createdAt).getTime()
    if (Number.isNaN(createdAt)) return null
    if ((options.now ?? Date.now()) - createdAt >= SCAN_CACHE_TTL_MS) return null

    return parsed.data
  } catch {
    return null
  }
}

export function writeScanCache<T>(key: string, data: T, options: ScanCacheOptions = {}): boolean {
  if (options.partialFailure === true) return false

  const path = options.cachePath ?? getScanCachePath()
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const envelope: ScanCacheEnvelope<T> = {
    key,
    createdAt: new Date(options.now ?? Date.now()).toISOString(),
    data,
  }
  writeFileSync(path, JSON.stringify(envelope, null, 2) + '\n', { mode: 0o600 })
  return true
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}
