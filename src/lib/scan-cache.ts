import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import type { ScanResult } from './pr-status.js'

export const SCAN_CACHE_TTL_MS = 60 * 1000
const CACHE_TTL_MS = SCAN_CACHE_TTL_MS
const DEFAULT_CACHE_DIR = join(homedir(), '.crosscheck')
const CACHE_FILE = 'scan-cache.json'

export type ScanCachePayload = Omit<ScanResult, 'cached'>

export interface ReadScanCacheOptions {
  cacheDir?: string
  nowMs: number
  staleAfterMs: number
  scopeHash?: string
}

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

interface GenericScanCacheOptions {
  cachePath?: string
  force?: boolean
  now?: number
  partialFailure?: boolean
}

function cachePath(cacheDir = DEFAULT_CACHE_DIR): string {
  return join(cacheDir, CACHE_FILE)
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

function isScanCachePayload(value: unknown): value is ScanCachePayload {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  const summary = record.summary
  return typeof record.scannedAt === 'string'
    && typeof record.staleAfterMs === 'number'
    && (record.scopeHash === undefined || typeof record.scopeHash === 'string')
    && Array.isArray(record.prs)
    && typeof summary === 'object'
    && summary !== null
}

export function readScanCache(options: ReadScanCacheOptions): ScanCachePayload | null
export function readScanCache<T>(key: string, options?: GenericScanCacheOptions): T | null
export function readScanCache<T>(
  keyOrOptions: string | ReadScanCacheOptions,
  options: GenericScanCacheOptions = {},
): ScanCachePayload | T | null {
  if (typeof keyOrOptions === 'string') {
    if (options.force === true) return null
    const path = options.cachePath ?? getScanCachePath()
    if (!existsSync(path)) return null

    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as ScanCacheEnvelope<T>
      if (!parsed || parsed.key !== keyOrOptions || typeof parsed.createdAt !== 'string') return null

      const createdAt = new Date(parsed.createdAt).getTime()
      if (Number.isNaN(createdAt)) return null
      if ((options.now ?? Date.now()) - createdAt >= SCAN_CACHE_TTL_MS) return null

      return parsed.data
    } catch {
      return null
    }
  }

  const optionsForPayload = keyOrOptions
  const path = cachePath(optionsForPayload.cacheDir)
  if (!existsSync(path)) return null

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (!isScanCachePayload(parsed)) return null
    if (parsed.staleAfterMs !== optionsForPayload.staleAfterMs) return null
    if (optionsForPayload.scopeHash && parsed.scopeHash !== optionsForPayload.scopeHash) return null
    const scannedAtMs = Date.parse(parsed.scannedAt)
    if (!Number.isFinite(scannedAtMs)) return null
    if (optionsForPayload.nowMs - scannedAtMs > CACHE_TTL_MS) return null
    return parsed
  } catch {
    return null
  }
}

export function writeScanCache(payload: ScanCachePayload, cacheDir?: string): void
export function writeScanCache<T>(key: string, data: T, options?: GenericScanCacheOptions): boolean
export function writeScanCache<T>(
  keyOrPayload: string | ScanCachePayload,
  dataOrCacheDir?: T | string,
  options: GenericScanCacheOptions = {},
): void | boolean {
  if (typeof keyOrPayload === 'string') {
    if (options.partialFailure === true) return false

    const path = options.cachePath ?? getScanCachePath()
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const envelope: ScanCacheEnvelope<T> = {
      key: keyOrPayload,
      createdAt: new Date(options.now ?? Date.now()).toISOString(),
      data: dataOrCacheDir as T,
    }
    writeFileSync(path, JSON.stringify(envelope, null, 2) + '\n', { mode: 0o600 })
    return true
  }

  const payload = keyOrPayload
  const cacheDir = typeof dataOrCacheDir === 'string' ? dataOrCacheDir : DEFAULT_CACHE_DIR
  mkdirSync(cacheDir, { recursive: true })
  const path = cachePath(cacheDir)
  const tempPath = `${path}.${process.pid}.tmp`
  writeFileSync(tempPath, JSON.stringify(payload, null, 2) + '\n')
  renameSync(tempPath, path)
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
