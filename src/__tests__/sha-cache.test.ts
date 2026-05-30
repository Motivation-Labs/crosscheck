import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { PersistentShaSet } from '../lib/sha-cache.js'

describe('PersistentShaSet', () => {
  let cacheFile: string

  beforeEach(() => {
    cacheFile = join(mkdtempSync(join(tmpdir(), 'crosscheck-sha-cache-')), 'pushed-shas.json')
  })

  afterEach(() => {
    if (existsSync(dirname(cacheFile))) rmSync(dirname(cacheFile), { recursive: true, force: true })
  })

  it('persists added SHAs across instances backed by the same file', () => {
    const a = new PersistentShaSet(cacheFile)
    a.add('abc123')

    const b = new PersistentShaSet(cacheFile)
    expect(b.has('abc123')).toBe(true)
  })

  it('caps persisted SHAs to the most recent entries', () => {
    const shas = new PersistentShaSet(cacheFile, 2)
    shas.add('one')
    shas.add('two')
    shas.add('three')

    expect(JSON.parse(readFileSync(cacheFile, 'utf8'))).toEqual(['two', 'three'])
    const reloaded = new PersistentShaSet(cacheFile, 2)
    expect(reloaded.has('one')).toBe(false)
    expect(reloaded.has('two')).toBe(true)
    expect(reloaded.has('three')).toBe(true)
  })

  it('tolerates a missing or malformed cache file', () => {
    writeFileSync(cacheFile, 'not json')
    const shas = new PersistentShaSet(cacheFile)
    expect(shas.size).toBe(0)

    shas.add('fixed')
    expect(JSON.parse(readFileSync(cacheFile, 'utf8'))).toEqual(['fixed'])
  })
})
