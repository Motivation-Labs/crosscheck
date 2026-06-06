import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  clonePRForReviewWithDeps,
  isTransientGitTransportError,
  redactGitOutput,
} from '../lib/clone.js'
import type { Config } from '../config/schema.js'

const GIT_CONFIG: Config['git'] = {
  clone_attempts: 2,
  retry_base_delay_ms: 0,
  https_version: 'auto',
}

describe('git clone reliability helpers', () => {
  it('classifies GitHub transport failures as transient', () => {
    expect(isTransientGitTransportError('curl 92 HTTP/2 stream 7 was not closed cleanly: CANCEL')).toBe(true)
    expect(isTransientGitTransportError('fatal: early EOF\nfatal: fetch-pack: invalid index-pack output')).toBe(true)
    expect(isTransientGitTransportError('curl 56 Recv failure: Operation timed out')).toBe(true)
    expect(isTransientGitTransportError('Authentication failed for github.com')).toBe(false)
  })

  it('redacts embedded GitHub tokens from error output', () => {
    const output = 'git clone https://x-access-token:gho_secret123@github.com/acme/repo.git'
    expect(redactGitOutput(output)).toBe('git clone https://x-access-token:REDACTED@github.com/acme/repo.git')
  })

  it('retries transient clone failures and forces HTTP/1.1 after HTTP/2 errors', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'crosscheck-clone-test-'))
    const calls: string[][] = []
    const retries: string[] = []

    try {
      clonePRForReviewWithDeps({
        owner: 'acme',
        repo: 'repo',
        prNumber: 7,
        baseRef: 'main',
        tmpDir,
        token: 'gho_secret123',
        protocol: 'https',
        git: GIT_CONFIG,
        onRetry: (event) => {
          if (event.mitigation) retries.push(event.mitigation)
        },
      }, {
        runGit: (args) => {
          calls.push(args)
          if (calls.length === 1) {
            const err = new Error('git failed') as Error & { stderr: string }
            err.stderr = 'RPC failed; curl 92 HTTP/2 stream 7 was not closed cleanly: CANCEL'
            throw err
          }
        },
        sleep: () => undefined,
      })
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }

    expect(calls[0].slice(0, 2)).toEqual(['clone', '--depth=50'])
    expect(calls[1].slice(0, 3)).toEqual(['-c', 'http.version=HTTP/1.1', 'clone'])
    expect(calls.some(args => args.includes('pull/7/head:pr-7'))).toBe(true)
    expect(retries).toEqual(['forcing Git HTTPS transport to HTTP/1.1 for the next attempt'])
  })
})
