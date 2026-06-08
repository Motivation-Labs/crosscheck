import { describe, expect, it } from 'vitest'
import { redactCloneSecrets } from '../lib/clone.js'

describe('redactCloneSecrets', () => {
  it('redacts GitHub x-access-token clone URLs', () => {
    const message = 'Command failed: git clone https://x-access-token:gho_secret123@github.com/humanbased-ai/crosscheck-proof-fixture.git /tmp/repo'

    expect(redactCloneSecrets(message)).toBe(
      'Command failed: git clone https://x-access-token:[REDACTED]@github.com/humanbased-ai/crosscheck-proof-fixture.git /tmp/repo',
    )
  })
})
