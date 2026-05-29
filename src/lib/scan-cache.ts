import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { ScanResult } from './pr-status.js'

const CACHE_TTL_MS = 60 * 1000
const DEFAULT_CACHE_DIR = join(homedir(), '.crosscheck')
const CACHE_FILE = 'scan-cache.json'

export type ScanCachePayload = Omit<ScanResult, 'cached'>

export interface ReadScanCacheOptions {
  cacheDir?: string
  nowMs: number
  staleAfterMs: number
  scopeHash?: string
}

function cachePath(cacheDir = DEFAULT_CACHE_DIR): string {
  return join(cacheDir, CACHE_FILE)
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

export function readScanCache(options: ReadScanCacheOptions): ScanCachePayload | null {
  const path = cachePath(options.cacheDir)
  if (!existsSync(path)) return null

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (!isScanCachePayload(parsed)) return null
    if (parsed.staleAfterMs !== options.staleAfterMs) return null
    if (options.scopeHash && parsed.scopeHash !== options.scopeHash) return null
    const scannedAtMs = Date.parse(parsed.scannedAt)
    if (!Number.isFinite(scannedAtMs)) return null
    if (options.nowMs - scannedAtMs > CACHE_TTL_MS) return null
    return parsed
  } catch {
    return null
  }
}

export function writeScanCache(payload: ScanCachePayload, cacheDir = DEFAULT_CACHE_DIR): void {
  mkdirSync(cacheDir, { recursive: true })
  writeFileSync(cachePath(cacheDir), JSON.stringify(payload, null, 2) + '\n')
}
