import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { readScanCache, writeScanCache, type ScanCachePayload } from '../lib/scan-cache.js'

let tempDir: string | undefined

function makeTempDir(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'crosscheck-scan-cache-test-'))
  return tempDir
}

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true })
  tempDir = undefined
})

describe('scan cache', () => {
  const payload: ScanCachePayload = {
    scannedAt: '2026-05-29T00:00:00.000Z',
    staleAfterMs: 60_000,
    scopeHash: 'scope-a',
    summary: { total: 0, stale: 0, not_stale: 0, actionable: 0 },
    prs: [],
  }

  it('returns a fresh cache entry for a matching stale window', () => {
    const dir = makeTempDir()
    writeScanCache(payload, dir)

    expect(readScanCache({
      cacheDir: dir,
      nowMs: Date.parse('2026-05-29T00:00:30.000Z'),
      staleAfterMs: 60_000,
      scopeHash: 'scope-a',
    })).toEqual(payload)
  })

  it('ignores stale cache entries, stale-after mismatches, and scope mismatches', () => {
    const dir = makeTempDir()
    writeScanCache(payload, dir)

    expect(readScanCache({
      cacheDir: dir,
      nowMs: Date.parse('2026-05-29T00:02:00.000Z'),
      staleAfterMs: 60_000,
    })).toBeNull()
    expect(readScanCache({
      cacheDir: dir,
      nowMs: Date.parse('2026-05-29T00:00:30.000Z'),
      staleAfterMs: 120_000,
    })).toBeNull()
    expect(readScanCache({
      cacheDir: dir,
      nowMs: Date.parse('2026-05-29T00:00:30.000Z'),
      staleAfterMs: 60_000,
      scopeHash: 'scope-b',
    })).toBeNull()
  })

  it('ignores malformed cache files', () => {
    const dir = makeTempDir()
    expect(readScanCache({ cacheDir: dir, nowMs: Date.now(), staleAfterMs: 60_000 })).toBeNull()
  })
})
