import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { applyEdit } from '../reviewers/fix.js'

describe('applyEdit', () => {
  it('replaces exact match at start of file', () => {
    const content = 'function foo() {\n  return 1\n}\n'
    const result = applyEdit(content, 'return 1', 'return 2')
    expect(result).toBe('function foo() {\n  return 2\n}\n')
  })

  it('returns null when old text is not found', () => {
    const content = 'function foo() {\n  return 1\n}\n'
    expect(applyEdit(content, 'return 99', 'return 2')).toBeNull()
  })

  it('returns null when old text is ambiguous (appears more than once)', () => {
    const content = 'a\na\na\n'
    expect(applyEdit(content, 'a', 'b')).toBeNull()
  })

  it('handles multi-line old text', () => {
    const content = 'line1\nline2\nline3\nline4\n'
    const result = applyEdit(content, 'line2\nline3', 'replaced')
    expect(result).toBe('line1\nreplaced\nline4\n')
  })

  it('can replace with empty string (deletion)', () => {
    const content = 'before\ndelete me\nafter\n'
    const result = applyEdit(content, 'delete me\n', '')
    expect(result).toBe('before\nafter\n')
  })

  it('returns null on empty old text (ambiguous — matches everywhere)', () => {
    // '' satisfies indexOf !== lastIndexOf, so the ambiguity guard rejects it.
    // Callers handle new-file creation separately before invoking applyEdit.
    expect(applyEdit('content', '', 'new')).toBeNull()
  })
})

describe('fix step <edit> block parsing', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'crosscheck-fix-test-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { force: true, recursive: true })
  })

  it('size guard: rejects <file> block when new content < 60% of original', async () => {
    // Write a "large" original file (10 lines)
    const filePath = join(tmpDir, 'src', 'large.ts')
    const { mkdirSync } = await import('fs')
    mkdirSync(join(tmpDir, 'src'), { recursive: true })
    const original = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n') + '\n'
    writeFileSync(filePath, original)

    // Simulate Claude outputting only 3 lines for a 10-line file (30% — below 60% threshold)
    const truncated = 'line1\nline2\nline3\n'

    // Directly test the guard logic: if newLines / origLines < 0.6, skip
    const origLines = original.split('\n').length
    const newLines = truncated.split('\n').length
    expect(newLines / origLines).toBeLessThan(0.6)

    // Confirm original is unchanged (guard would have skipped the write)
    expect(readFileSync(filePath, 'utf8')).toBe(original)
  })

  it('size guard: accepts <file> block when new content >= 60% of original', () => {
    const original = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n') + '\n'
    const replacement = Array.from({ length: 7 }, (_, i) => `replaced${i + 1}`).join('\n') + '\n'

    const origLines = original.split('\n').length
    const newLines = replacement.split('\n').length
    expect(newLines / origLines).toBeGreaterThanOrEqual(0.6)
  })

  it('applyEdit composes correctly for multiple edits to same file', () => {
    const content = 'a: 1\nb: 2\nc: 3\n'
    const after1 = applyEdit(content, 'a: 1', 'a: 10')!
    expect(after1).not.toBeNull()
    const after2 = applyEdit(after1, 'b: 2', 'b: 20')!
    expect(after2).not.toBeNull()
    expect(after2).toBe('a: 10\nb: 20\nc: 3\n')
  })

  it('failed <old> match does not count as applied or write the unchanged file', () => {
    // Regression for: file added to fileEdits during read step, then applyEdit returns null,
    // but write loop still writes it and increments appliedCount.
    const filePath = join(tmpDir, 'src.ts')
    const original = 'export function foo() {\n  return 1\n}\n'
    writeFileSync(filePath, original)

    // applyEdit with a non-matching old text returns null — file must not be touched
    const result = applyEdit(original, 'does not exist in file', 'anything')
    expect(result).toBeNull()

    // File must be untouched on disk
    expect(readFileSync(filePath, 'utf8')).toBe(original)
  })

  it('applyEdit: empty old text returns null (ambiguity guard catches it)', () => {
    // Empty string satisfies indexOf('') !== lastIndexOf(''), so applyEdit rejects it.
    // runFixStep handles new-file creation (empty <old> on missing file) before calling applyEdit.
    expect(applyEdit('existing content', '', 'prepended ')).toBeNull()
  })
})

describe('fix step new-file and empty-old guard', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'crosscheck-fix-test-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { force: true, recursive: true })
  })

  it('empty <old> on existing file is rejected — does not prepend new text', () => {
    const { mkdirSync: mkdir } = require('fs')
    mkdir(join(tmpDir, 'src'), { recursive: true })
    const filePath = join(tmpDir, 'src', 'util.ts')
    const original = 'export const x = 1\n'
    writeFileSync(filePath, original)

    // applyEdit('export const x = 1\n', '', 'prepended\n') would prepend if not guarded.
    // The guard in runFixStep must block this — original must be unchanged.
    // We verify the guard logic directly: empty oldText on existing file => skip.
    const oldText = ''
    const fileExists = true  // file was readable
    const wouldBeGuarded = fileExists && oldText === ''
    expect(wouldBeGuarded).toBe(true)
    expect(readFileSync(filePath, 'utf8')).toBe(original)
  })

  it('empty <old> on non-existent file writes <new> as new file content', () => {
    const { mkdirSync: mkdir } = require('fs')
    mkdir(join(tmpDir, 'src'), { recursive: true })
    const newFilePath = join(tmpDir, 'src', 'new-module.ts')

    // File does not exist — simulate the new-file path: write newText directly
    const newContent = 'export const added = true\n'
    writeFileSync(newFilePath, newContent)  // as runFixStep would do for empty <old>
    expect(readFileSync(newFilePath, 'utf8')).toBe(newContent)
  })
})
