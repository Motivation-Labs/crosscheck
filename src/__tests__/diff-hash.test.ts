import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { computeDiffHash, PersistentDiffHashMap } from '../lib/diff-hash.js'

function git(args: string, cwd: string): string {
  return execSync(`git ${args}`, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })
}

function setupRepo(): { dir: string; baseRef: string } {
  const dir = mkdtempSync(join(tmpdir(), 'crosscheck-diff-test-'))
  git('init --quiet -b main', dir)
  git('config user.email test@test.local', dir)
  git('config user.name Test', dir)
  writeFileSync(join(dir, 'file.txt'), 'base content\n')
  git('add .', dir)
  git('commit --quiet -m base', dir)
  // Create the "origin/main" remote-tracking ref that computeDiffHash expects
  git('update-ref refs/remotes/origin/main HEAD', dir)
  return { dir, baseRef: 'main' }
}

describe('computeDiffHash', () => {
  let dir: string
  let baseRef: string

  beforeEach(() => {
    ;({ dir, baseRef } = setupRepo())
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns a stable hex digest for a given patch', () => {
    writeFileSync(join(dir, 'file.txt'), 'modified content\n')
    git('commit --quiet -am edit', dir)
    const h1 = computeDiffHash(dir, baseRef)
    const h2 = computeDiffHash(dir, baseRef)
    expect(h1).toBe(h2)
    expect(h1).toMatch(/^[0-9a-f]{64}$/)
  })

  it('returns identical hash when an amend produces the same patch under a new SHA', () => {
    writeFileSync(join(dir, 'file.txt'), 'modified content\n')
    git('commit --quiet -am edit', dir)
    const shaBefore = git('rev-parse HEAD', dir).trim()
    const hashBefore = computeDiffHash(dir, baseRef)

    // Amend the commit message only — same tree, new SHA
    git('commit --quiet --amend -m "edit (reworded)"', dir)
    const shaAfter = git('rev-parse HEAD', dir).trim()
    const hashAfter = computeDiffHash(dir, baseRef)

    expect(shaAfter).not.toBe(shaBefore)
    expect(hashAfter).toBe(hashBefore)
  })

  it('returns different hash when the diff content changes', () => {
    writeFileSync(join(dir, 'file.txt'), 'first change\n')
    git('commit --quiet -am one', dir)
    const h1 = computeDiffHash(dir, baseRef)
    writeFileSync(join(dir, 'file.txt'), 'second change\n')
    git('commit --quiet -am two', dir)
    const h2 = computeDiffHash(dir, baseRef)
    expect(h1).not.toBe(h2)
  })

  it('returns the empty-diff hash when HEAD equals base', () => {
    const h = computeDiffHash(dir, baseRef)
    expect(h).toMatch(/^[0-9a-f]{64}$/)
    // Hash of empty string sha256 — stable sentinel
    expect(h).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })
})

describe('PersistentDiffHashMap', () => {
  let cacheFile: string

  beforeEach(() => {
    cacheFile = join(mkdtempSync(join(tmpdir(), 'crosscheck-dhm-')), 'diff-hashes.json')
  })

  afterEach(() => {
    if (existsSync(cacheFile)) rmSync(cacheFile)
  })

  it('upserts and reads back an entry', () => {
    const m = new PersistentDiffHashMap(cacheFile)
    m.upsert('owner/repo#1', { sha: 'abc123', hash: 'h1' })
    expect(m.get('owner/repo#1')).toEqual({ sha: 'abc123', hash: 'h1' })
  })

  it('overwrites an existing entry for the same key', () => {
    const m = new PersistentDiffHashMap(cacheFile)
    m.upsert('owner/repo#1', { sha: 'abc', hash: 'h1' })
    m.upsert('owner/repo#1', { sha: 'def', hash: 'h2' })
    expect(m.get('owner/repo#1')).toEqual({ sha: 'def', hash: 'h2' })
  })

  it('persists across instances backed by the same file', () => {
    const a = new PersistentDiffHashMap(cacheFile)
    a.upsert('owner/repo#42', { sha: 'aaa', hash: 'hash-x' })
    const b = new PersistentDiffHashMap(cacheFile)
    expect(b.get('owner/repo#42')).toEqual({ sha: 'aaa', hash: 'hash-x' })
  })

  it('returns undefined for missing keys', () => {
    const m = new PersistentDiffHashMap(cacheFile)
    expect(m.get('nope')).toBeUndefined()
  })

  it('evicts oldest entries when exceeding the cap (FIFO)', () => {
    const m = new PersistentDiffHashMap(cacheFile, /*maxEntries*/ 3)
    m.upsert('a', { sha: '1', hash: 'h1' })
    m.upsert('b', { sha: '2', hash: 'h2' })
    m.upsert('c', { sha: '3', hash: 'h3' })
    m.upsert('d', { sha: '4', hash: 'h4' })  // evicts 'a'
    expect(m.get('a')).toBeUndefined()
    expect(m.get('b')).toEqual({ sha: '2', hash: 'h2' })
    expect(m.get('d')).toEqual({ sha: '4', hash: 'h4' })
  })

  it('upsert that overwrites does not count toward the cap', () => {
    const m = new PersistentDiffHashMap(cacheFile, 2)
    m.upsert('a', { sha: '1', hash: 'h1' })
    m.upsert('b', { sha: '2', hash: 'h2' })
    m.upsert('a', { sha: '1b', hash: 'h1b' })  // overwrite, not insert
    expect(m.get('a')).toEqual({ sha: '1b', hash: 'h1b' })
    expect(m.get('b')).toEqual({ sha: '2', hash: 'h2' })
  })

  it('tolerates a missing or malformed cache file', () => {
    writeFileSync(cacheFile, 'not json')
    const m = new PersistentDiffHashMap(cacheFile)
    expect(m.get('any')).toBeUndefined()
    m.upsert('x', { sha: '9', hash: 'h9' })
    // Should have rewritten the file to valid JSON
    const parsed = JSON.parse(readFileSync(cacheFile, 'utf8')) as Record<string, unknown>
    expect(parsed['x']).toEqual({ sha: '9', hash: 'h9' })
  })
})
