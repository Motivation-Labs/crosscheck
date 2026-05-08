import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { patchAllowedAuthors } from '../config/loader.js'

let tmpDir: string

beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'crosscheck-loader-test-')) })
afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }) })

function write(name: string, content: string): string {
  const p = join(tmpDir, name)
  writeFileSync(p, content)
  return p
}

function read(p: string): string {
  return readFileSync(p, 'utf8')
}

describe('patchAllowedAuthors', () => {
  // ── Case 1: commented-out placeholder ───────────────────────────────────

  it('case 1 — uncomments placeholder block', () => {
    const p = write('c1.yml', [
      'mode: cross-vendor',
      'routing:',
      '  # allowed_authors:',
      '  #   - beingzy',
      '',
    ].join('\n'))
    expect(patchAllowedAuthors(p, 'alice')).toBe(true)
    const out = read(p)
    expect(out).toContain('  allowed_authors:\n    - alice')
    expect(out).not.toContain('# allowed_authors')
  })

  // ── Case 2: multi-line empty (key present, no entries) ──────────────────

  it('case 2 — fills multi-line empty allowed_authors', () => {
    const p = write('c2.yml', [
      'routing:',
      '  allowed_authors:',
      '  codex_reviews_patterns: []',
      '',
    ].join('\n'))
    expect(patchAllowedAuthors(p, 'alice')).toBe(true)
    expect(read(p)).toContain('    - alice')
  })

  it('case 2 — fills allowed_authors that has only comment lines', () => {
    const p = write('c2b.yml', [
      'routing:',
      '  allowed_authors:',
      '  # - somebot',
      '',
    ].join('\n'))
    expect(patchAllowedAuthors(p, 'alice')).toBe(true)
    expect(read(p)).toContain('    - alice')
  })

  // ── Case 3: inline empty array ──────────────────────────────────────────

  it('case 3 — fills allowed_authors: []', () => {
    const p = write('c3a.yml', [
      'routing:',
      '  allowed_authors: []',
      '',
    ].join('\n'))
    expect(patchAllowedAuthors(p, 'alice')).toBe(true)
    const out = read(p)
    expect(out).toContain('  allowed_authors:\n    - alice')
    expect(out).not.toContain('[]')
  })

  it('case 3 — fills allowed_authors: [ ] (with space)', () => {
    const p = write('c3b.yml', [
      'routing:',
      '  allowed_authors: [ ]',
      '',
    ].join('\n'))
    expect(patchAllowedAuthors(p, 'alice')).toBe(true)
    expect(read(p)).toContain('    - alice')
  })

  // ── Case 4: routing: exists but no allowed_authors key ──────────────────

  it('case 4 — appends allowed_authors after routing: when key is absent', () => {
    const p = write('c4.yml', [
      'mode: cross-vendor',
      'routing:',
      '  codex_reviews_patterns: []',
      '',
    ].join('\n'))
    expect(patchAllowedAuthors(p, 'alice')).toBe(true)
    const out = read(p)
    expect(out).toContain('  allowed_authors:\n    - alice')
  })

  // ── Case 5 (new): no routing: section at all ────────────────────────────

  it('case 5 — appends routing block when no routing: section exists', () => {
    const p = write('c5.yml', 'mode: cross-vendor\n')
    expect(patchAllowedAuthors(p, 'alice')).toBe(true)
    const out = read(p)
    expect(out).toContain('routing:')
    expect(out).toContain('  allowed_authors:')
    expect(out).toContain('    - alice')
  })

  it('case 5 — works for completely minimal config (no trailing newline)', () => {
    const p = write('c5b.yml', 'mode: cross-vendor')
    expect(patchAllowedAuthors(p, 'bob')).toBe(true)
    const out = read(p)
    expect(out).toContain('routing:')
    expect(out).toContain('    - bob')
  })

  it('case 5 — added routing block is valid YAML structure', () => {
    const p = write('c5c.yml', 'mode: cross-vendor\n')
    patchAllowedAuthors(p, 'alice')
    const out = read(p)
    // routing: must be a top-level key (no leading spaces)
    expect(out).toMatch(/^routing:/m)
    // allowed_authors must be indented under routing
    expect(out).toMatch(/^  allowed_authors:/m)
    // entry must be indented under allowed_authors
    expect(out).toMatch(/^    - alice/m)
  })

  // ── Already-populated: should not modify ────────────────────────────────

  it('returns false when allowed_authors already has entries', () => {
    const p = write('populated.yml', [
      'routing:',
      '  allowed_authors:',
      '    - existingbot',
      '',
    ].join('\n'))
    expect(patchAllowedAuthors(p, 'alice')).toBe(false)
    expect(read(p)).not.toContain('alice')
  })

  // ── Login value ──────────────────────────────────────────────────────────

  it('uses the provided login in the written entry', () => {
    const p = write('login.yml', 'mode: cross-vendor\n')
    patchAllowedAuthors(p, 'mybot')
    expect(read(p)).toContain('    - mybot')
  })
})
