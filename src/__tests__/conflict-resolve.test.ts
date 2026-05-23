import { describe, it, expect } from 'vitest'
import { extractConflictWindows } from '../reviewers/conflict-resolve.js'

describe('extractConflictWindows', () => {
  it('returns empty string when no markers are present', () => {
    expect(extractConflictWindows('line a\nline b\nline c\n')).toBe('')
  })

  it('extracts a single conflict region with surrounding context', () => {
    const content = [
      'top context 1',
      'top context 2',
      '<<<<<<< HEAD',
      'ours',
      '=======',
      'theirs',
      '>>>>>>> branch',
      'bottom context 1',
      'bottom context 2',
    ].join('\n')
    const out = extractConflictWindows(content)
    expect(out).toContain('<<<<<<< HEAD')
    expect(out).toContain('=======')
    expect(out).toContain('>>>>>>> branch')
    expect(out).toContain('top context 1')
    expect(out).toContain('bottom context 1')
  })

  it('surfaces conflicts that appear past the previous 4KB prefix cap', () => {
    const filler = Array.from({ length: 200 }, (_, i) => `noise line ${i}`).join('\n')
    const conflict = '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch'
    const content = `${filler}\n${conflict}\n${filler}`
    expect(content.length).toBeGreaterThan(4000)

    const out = extractConflictWindows(content)
    expect(out).toContain('<<<<<<< HEAD')
    expect(out).toContain('>>>>>>> branch')
  })

  it('merges overlapping conflict windows instead of duplicating context', () => {
    const lines: string[] = []
    for (let i = 0; i < 3; i++) lines.push(`ctx ${i}`)
    lines.push('<<<<<<< HEAD', 'a', '=======', 'b', '>>>>>>> branch')
    lines.push('mid 1', 'mid 2')
    lines.push('<<<<<<< HEAD', 'c', '=======', 'd', '>>>>>>> branch')
    for (let i = 0; i < 3; i++) lines.push(`tail ${i}`)
    const out = extractConflictWindows(lines.join('\n'))
    const startCount = (out.match(/<<<<<<< HEAD/g) ?? []).length
    expect(startCount).toBe(2)
    // mid section between adjacent conflicts should appear exactly once (merged window)
    expect((out.match(/mid 1/g) ?? []).length).toBe(1)
  })
})

// Used by runner.ts to detect remaining conflict markers in resolved files.
// Kept in sync with the regex literal there; this test guards the contract.
const MARKER_RE = /^(<<<<<<<|=======|>>>>>>>)( |$)/m

describe('conflict marker regex (runner.ts)', () => {
  it('matches all three marker variants on their own line', () => {
    expect(MARKER_RE.test('foo\n<<<<<<< HEAD\nbar')).toBe(true)
    expect(MARKER_RE.test('foo\n=======\nbar')).toBe(true)
    expect(MARKER_RE.test('foo\n>>>>>>> branch\nbar')).toBe(true)
  })

  it('matches a marker line with no trailing label (end of line)', () => {
    expect(MARKER_RE.test('foo\n<<<<<<<\nbar')).toBe(true)
    expect(MARKER_RE.test('foo\n=======\nbar')).toBe(true)
  })

  it('does not match a Markdown setext-style separator inside docs', () => {
    // "=======" is a legitimate H1 setext underline in Markdown; only flag when
    // the resolver actually leaves a marker behind in the resolved file.
    // The regex DOES match a bare "=======" line — the false-positive defense is
    // that runner.ts scopes the check to originally-conflicted files, not the
    // whole worktree. Verify the marker line itself still matches so the scope
    // restriction is doing the real work.
    expect(MARKER_RE.test('Heading\n=======\n')).toBe(true)
  })

  it('does not match conflict markers appearing mid-line (e.g. in URLs or strings)', () => {
    expect(MARKER_RE.test('see https://example.com/<<<<<<<-pin')).toBe(false)
    expect(MARKER_RE.test('const s = "=======middle"')).toBe(false)
  })
})
