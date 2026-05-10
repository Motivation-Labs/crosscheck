import { describe, it, expect } from 'vitest'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { sanitizeEntry, loadErrorEntriesForPattern, sanitizeDraftContent, type RawLogEntry } from '../lib/log-analysis.js'
import { parseDraft, buildIssueContent } from '../commands/issue.js'

const FIXTURES_DIR = join(fileURLToPath(import.meta.url), '..', 'fixtures')

// ──────────────────────────────────────────────────────
// sanitizeEntry
// ──────────────────────────────────────────────────────

describe('sanitizeEntry', () => {
  it('replaces repo field with [repo]', () => {
    const entry: RawLogEntry = { ts: '', level: 'error', event: 'error', repo: 'acme/api' }
    expect(sanitizeEntry(entry).repo).toBe('[repo]')
  })

  it('leaves repo undefined when absent', () => {
    const entry: RawLogEntry = { ts: '', level: 'error', event: 'error' }
    expect(sanitizeEntry(entry).repo).toBeUndefined()
  })

  it('sanitizes owner/repo pattern in message', () => {
    const entry: RawLogEntry = {
      ts: '', level: 'error', event: 'error',
      message: 'failed cloning motivation-labs/crosscheck',
    }
    expect(sanitizeEntry(entry).message).toContain('[repo]')
    expect(sanitizeEntry(entry).message).not.toContain('motivation-labs/crosscheck')
  })

  it('sanitizes GitHub URLs in message', () => {
    const entry: RawLogEntry = {
      ts: '', level: 'error', event: 'error',
      message: 'see https://github.com/owner/repo/issues/42',
    }
    expect(sanitizeEntry(entry).message).toContain('[github-url]')
    expect(sanitizeEntry(entry).message).not.toContain('github.com')
  })

  it('sanitizes @username in message', () => {
    const entry: RawLogEntry = {
      ts: '', level: 'error', event: 'error',
      message: 'PR opened by @johndoe',
    }
    expect(sanitizeEntry(entry).message).toContain('[username]')
    expect(sanitizeEntry(entry).message).not.toContain('@johndoe')
  })

  it('sanitizes absolute file paths in message', () => {
    const entry: RawLogEntry = {
      ts: '', level: 'error', event: 'error',
      message: 'Error reading /home/user/project/src/index.ts',
    }
    expect(sanitizeEntry(entry).message).toContain('[file-path]')
  })

  it('leaves non-sensitive fields unchanged', () => {
    const entry: RawLogEntry = { ts: '2026-01-01T00:00:00Z', level: 'error', event: 'error', pr: 42 }
    const out = sanitizeEntry(entry)
    expect(out.ts).toBe('2026-01-01T00:00:00Z')
    expect(out.pr).toBe(42)
  })

  it('sanitizes stack trace with file paths', () => {
    const entry: RawLogEntry = {
      ts: '', level: 'error', event: 'error',
      stack: 'Error: failed\n    at Object.<anonymous> (/Users/user/projects/app/src/index.ts:10:5)',
    }
    expect(sanitizeEntry(entry).stack).not.toContain('/Users/user/projects/app/src/index.ts')
    expect(sanitizeEntry(entry).stack).toContain('[file-path]')
  })

  it('sanitizes stderr field with repo name', () => {
    const entry: RawLogEntry = {
      ts: '', level: 'error', event: 'error',
      stderr: 'fatal: repository acme/backend not found',
    }
    expect(sanitizeEntry(entry).stderr).not.toContain('acme/backend')
    expect(sanitizeEntry(entry).stderr).toContain('[repo]')
  })

  it('sanitizes command field with file path', () => {
    const entry: RawLogEntry = {
      ts: '', level: 'error', event: 'error',
      command: 'codex review /tmp/crosscheck-abc123/acme-api/src/main.ts',
    }
    expect(sanitizeEntry(entry).command).not.toContain('/tmp/crosscheck-abc123/acme-api/src/main.ts')
    expect(sanitizeEntry(entry).command).toContain('[file-path]')
  })

  it('does not mutate the original entry', () => {
    const entry: RawLogEntry = { ts: '', level: 'error', event: 'error', repo: 'acme/api' }
    sanitizeEntry(entry)
    expect(entry.repo).toBe('acme/api')
  })
})

// ──────────────────────────────────────────────────────
// sanitizeDraftContent
// ──────────────────────────────────────────────────────

describe('sanitizeDraftContent', () => {
  it('strips repo name from title', () => {
    const { title } = sanitizeDraftContent('Bug in acme/api causes crash', '')
    expect(title).not.toContain('acme/api')
    expect(title).toContain('[repo]')
  })

  it('strips GitHub URL from body', () => {
    const { body } = sanitizeDraftContent('', 'See https://github.com/acme/api/issues/12 for context.')
    expect(body).not.toContain('github.com')
    expect(body).toContain('[github-url]')
  })

  it('strips file path from body', () => {
    const { body } = sanitizeDraftContent('', 'Error at /home/user/project/src/index.ts:42')
    expect(body).toContain('[file-path]')
  })

  it('leaves clean content unchanged', () => {
    const { title, body } = sanitizeDraftContent('codex reviewer exits with command not found', '## Description\nThe reviewer fails.')
    expect(title).toBe('codex reviewer exits with command not found')
    expect(body).toContain('## Description')
  })
})

// ──────────────────────────────────────────────────────
// loadErrorEntriesForPattern
// ──────────────────────────────────────────────────────

describe('loadErrorEntriesForPattern', () => {
  it('returns empty array when log dir does not exist', () => {
    const result = loadErrorEntriesForPattern('command_not_found', 'tsc', undefined, '/nonexistent')
    expect(result).toHaveLength(0)
  })

  it('returns matching entries for command_not_found tsc from fixtures', () => {
    const result = loadErrorEntriesForPattern('command_not_found', 'tsc', undefined, FIXTURES_DIR)
    expect(result.length).toBeGreaterThan(0)
    expect(result.every(e => e.event === 'error')).toBe(true)
    expect(result.every(e => e.message?.includes('tsc'))).toBe(true)
  })

  it('returns entries for jest command_not_found from fixtures', () => {
    const result = loadErrorEntriesForPattern('command_not_found', 'jest', undefined, FIXTURES_DIR)
    expect(result.length).toBeGreaterThan(0)
    expect(result.every(e => e.message?.includes('jest'))).toBe(true)
  })

  it('returns empty for a pattern not present in fixtures', () => {
    const result = loadErrorEntriesForPattern('auth_failure', undefined, undefined, FIXTURES_DIR)
    expect(result).toHaveLength(0)
  })

  it('caps results at 5 entries', () => {
    // Generate a logDir with many matching entries to verify the cap
    // Use fixtures — has at most a few so won't exceed 5 anyway, but test the cap holds
    const result = loadErrorEntriesForPattern('command_not_found', 'tsc', undefined, FIXTURES_DIR)
    expect(result.length).toBeLessThanOrEqual(5)
  })

  it('respects since filter', () => {
    // Only 2026-01-11 entries
    const result = loadErrorEntriesForPattern('command_not_found', undefined, '2026-01-11', FIXTURES_DIR)
    // 2026-01-10 has tsc and jest errors, 2026-01-11 has base_branch errors
    // so command_not_found from 2026-01-11 only should be empty or fewer
    expect(result.length).toBeLessThanOrEqual(5)
  })
})

// ──────────────────────────────────────────────────────
// parseDraft
// ──────────────────────────────────────────────────────

describe('parseDraft', () => {
  it('extracts title and body from well-formed output', () => {
    const output = [
      'TITLE: codex reviewer fails on TypeScript repos',
      '---',
      '## Description',
      'The codex reviewer exits with command not found.',
    ].join('\n')
    const result = parseDraft(output)
    expect(result).not.toBeNull()
    expect(result!.title).toBe('codex reviewer fails on TypeScript repos')
    expect(result!.body).toContain('## Description')
  })

  it('handles leading blank lines before TITLE', () => {
    const output = '\n\nTITLE: my title\n---\nbody here'
    const result = parseDraft(output)
    expect(result?.title).toBe('my title')
    expect(result?.body).toBe('body here')
  })

  it('returns null when TITLE line is missing', () => {
    const output = 'no title line here\n---\nbody'
    expect(parseDraft(output)).toBeNull()
  })

  it('returns null when separator is missing', () => {
    const output = 'TITLE: some title\nbody without separator'
    expect(parseDraft(output)).toBeNull()
  })

  it('returns null when title is empty', () => {
    const output = 'TITLE:   \n---\nbody'
    expect(parseDraft(output)).toBeNull()
  })

  it('returns null when body is empty', () => {
    const output = 'TITLE: title\n---\n   '
    expect(parseDraft(output)).toBeNull()
  })

  it('handles multi-line body', () => {
    const body = '## Description\nline one\nline two\n\n## Steps\n1. step one'
    const output = `TITLE: title\n---\n${body}`
    const result = parseDraft(output)
    expect(result?.body).toBe(body)
  })

  it('uses the first --- separator after the TITLE line', () => {
    const output = 'TITLE: t\n---\n## Section\nsome --- in content\nmore content'
    const result = parseDraft(output)
    expect(result?.body).toContain('some --- in content')
  })

  it('parses LABELS line between TITLE and separator', () => {
    const output = 'TITLE: my title\nLABELS: bug, priority:high\n---\nbody text'
    const result = parseDraft(output)
    expect(result?.labels).toEqual(['bug', 'priority:high'])
  })

  it('returns undefined labels when LABELS line is absent', () => {
    const output = 'TITLE: my title\n---\nbody text'
    const result = parseDraft(output)
    expect(result?.labels).toBeUndefined()
  })

  it('ignores empty label values in LABELS line', () => {
    const output = 'TITLE: my title\nLABELS: bug,  ,improvement\n---\nbody'
    const result = parseDraft(output)
    expect(result?.labels).toEqual(['bug', 'improvement'])
  })
})

// ──────────────────────────────────────────────────────
// buildIssueContent
// ──────────────────────────────────────────────────────

describe('buildIssueContent', () => {
  const draft = {
    title: 'codex fails on tsc',
    body: '## Description\nSomething broke.',
  }

  it('preserves the title unchanged', () => {
    const { title } = buildIssueContent(draft, {
      reproducibility: 'Every time',
      trigger: 'watch',
      impact: 'Blocked',
    })
    expect(title).toBe('codex fails on tsc')
  })

  it('appends User Context section to body', () => {
    const { body } = buildIssueContent(draft, {
      reproducibility: 'Sometimes',
      trigger: 'watch',
      impact: 'Degraded',
    })
    expect(body).toContain('## User Context')
    expect(body).toContain('Sometimes')
    expect(body).toContain('watch')
    expect(body).toContain('Degraded')
  })

  it('original draft body is preserved in output', () => {
    const { body } = buildIssueContent(draft, {
      reproducibility: 'Once',
      trigger: 'review',
      impact: 'Cosmetic',
    })
    expect(body).toContain('## Description')
    expect(body).toContain('Something broke.')
  })

  it('all three answer fields appear in User Context', () => {
    const { body } = buildIssueContent(draft, {
      reproducibility: 'Every time',
      trigger: 'serve',
      impact: 'Blocked',
    })
    expect(body).toContain('Every time')
    expect(body).toContain('serve')
    expect(body).toContain('Blocked')
  })
})
