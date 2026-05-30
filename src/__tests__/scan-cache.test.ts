import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { buildScanCacheKey, readScanCache, writeScanCache } from '../lib/scan-cache.js'

let tmpDir: string
let cachePath: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'crosscheck-scan-cache-'))
  cachePath = join(tmpDir, 'scan.json')
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('scan cache', () => {
  const key = buildScanCacheKey({
    configPath: '/repo/crosscheck.config.yml',
    monitorScopeHash: 'scope',
    githubLogin: 'alice',
    staleAfterMs: 24 * 60 * 60 * 1000,
    packageVersion: '0.9.0',
  })

  it('hits within the 60 second TTL', () => {
    writeScanCache(key, { rows: [1] }, { cachePath, now: 1_000 })

    expect(readScanCache<{ rows: number[] }>(key, { cachePath, now: 60_000 })).toEqual({ rows: [1] })
  })

  it('misses after the TTL', () => {
    writeScanCache(key, { rows: [1] }, { cachePath, now: 1_000 })

    expect(readScanCache(key, { cachePath, now: 62_000 })).toBeNull()
  })

  it('misses when force bypass is requested', () => {
    writeScanCache(key, { rows: [1] }, { cachePath, now: 1_000 })

    expect(readScanCache(key, { cachePath, now: 2_000, force: true })).toBeNull()
  })

  it('does not overwrite a prior successful cache on partial failure', () => {
    writeScanCache(key, { rows: ['old'] }, { cachePath, now: 1_000 })
    const before = readFileSync(cachePath, 'utf8')

    const wrote = writeScanCache(key, { rows: ['new'] }, { cachePath, now: 2_000, partialFailure: true })

    expect(wrote).toBe(false)
    expect(readFileSync(cachePath, 'utf8')).toBe(before)
    expect(readScanCache<{ rows: string[] }>(key, { cachePath, now: 3_000 })).toEqual({ rows: ['old'] })
  })

  it('creates cache directories with owner-only permissions', () => {
    const nestedCachePath = join(tmpDir, 'nested', 'cache', 'scan.json')

    writeScanCache(key, { rows: [1] }, { cachePath: nestedCachePath, now: 1_000 })

    expect(statSync(join(tmpDir, 'nested', 'cache')).mode & 0o777).toBe(0o700)
  })
})
