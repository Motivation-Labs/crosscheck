import { describe, it, expect } from 'vitest'
import { inferVerdictFromCodexOutput } from '../reviewers/codex.js'

const CODEX_FOOTER = '\n\n---\n_Reviewed with [OpenAI Codex](https://openai.com/codex)_'

describe('inferVerdictFromCodexOutput', () => {
  it('returns BLOCK when P1 is present', () => {
    const text = `Critical issue found.\n\n- [P1] Broken auth — src/auth.ts:12\n  Fix this.${CODEX_FOOTER}`
    expect(inferVerdictFromCodexOutput(text)).toBe('BLOCK')
  })

  it('returns BLOCK when P1 present alongside P2/P3', () => {
    const text = `Issues found.\n\n- [P1] Security issue\n- [P2] Minor issue\n- [P3] Nit${CODEX_FOOTER}`
    expect(inferVerdictFromCodexOutput(text)).toBe('BLOCK')
  })

  it('returns NEEDS WORK when only P2 is present', () => {
    const text = `Issues found.\n\n- [P2] Missing validation — src/api.ts:45\n  Add this.${CODEX_FOOTER}`
    expect(inferVerdictFromCodexOutput(text)).toBe('NEEDS WORK')
  })

  it('returns NEEDS WORK when only P3 is present', () => {
    const text = `Minor issue.\n\n- [P3] Rename variable — src/util.ts:10${CODEX_FOOTER}`
    expect(inferVerdictFromCodexOutput(text)).toBe('NEEDS WORK')
  })

  it('returns NEEDS WORK when P2 and P3 present, no P1', () => {
    const text = `Issues.\n\n- [P2] Fix bug\n- [P3] Nit${CODEX_FOOTER}`
    expect(inferVerdictFromCodexOutput(text)).toBe('NEEDS WORK')
  })

  it('returns APPROVE when no priority markers present', () => {
    const text = `The changes look correct and complete.${CODEX_FOOTER}`
    expect(inferVerdictFromCodexOutput(text)).toBe('APPROVE')
  })

  it('does not double-append when VERDICT already present', () => {
    // The caller guards against re-appending — verify inference is case-insensitive
    expect(inferVerdictFromCodexOutput('[p1] issue')).toBe('BLOCK')
    expect(inferVerdictFromCodexOutput('[P2] issue')).toBe('NEEDS WORK')
  })

  it('infers correctly from real Codex output shape (motivation-form PR #90)', () => {
    const realOutput = `The added guidance contains copy-paste survey templates that default to form mode.

Full review comments:

- [P2] Keep survey examples in survey mode — /tmp/repo/agent-guide.mdx:431-433
  Add \`type: survey\` near the top of each template.

- [P3] Move detached media-url row back into table — /tmp/repo/agent-guide.mdx:686-686
  This row renders as a stray paragraph.

---
_Reviewed with [OpenAI Codex](https://openai.com/codex)_`
    expect(inferVerdictFromCodexOutput(realOutput)).toBe('NEEDS WORK')
  })
})
