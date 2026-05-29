import { describe, it, expect, vi } from 'vitest'
import { checkRemoteLock, acquireRemoteLock, releaseRemoteLock, startRemoteLockHeartbeat } from '../github/review-status.js'

function makeOctokit(state: string | null, updatedAt: string = new Date().toISOString()) {
  return {
    rest: {
      repos: {
        getCombinedStatusForRef: vi.fn().mockResolvedValue({
          data: {
            statuses: state
              ? [{ context: 'crosscheck/review', state, updated_at: updatedAt }]
              : [],
          },
        }),
        createCommitStatus: vi.fn().mockResolvedValue({}),
      },
    },
  }
}

describe('checkRemoteLock', () => {
  it('returns false when no status exists', async () => {
    const octokit = makeOctokit(null)
    expect(await checkRemoteLock(octokit as never, 'o', 'r', 'sha')).toBe(false)
  })

  it('returns true for a fresh pending status', async () => {
    const octokit = makeOctokit('pending', new Date().toISOString())
    expect(await checkRemoteLock(octokit as never, 'o', 'r', 'sha')).toBe(true)
  })

  it('returns false for a pending status older than 15 minutes', async () => {
    const staleDate = new Date(Date.now() - 16 * 60 * 1000).toISOString()
    const octokit = makeOctokit('pending', staleDate)
    expect(await checkRemoteLock(octokit as never, 'o', 'r', 'sha')).toBe(false)
  })

  it('returns false when status is success', async () => {
    const octokit = makeOctokit('success', new Date().toISOString())
    expect(await checkRemoteLock(octokit as never, 'o', 'r', 'sha')).toBe(false)
  })

  it('uses the newest crosscheck status when multiple statuses exist for the context', async () => {
    const now = new Date().toISOString()
    const older = new Date(Date.now() - 60_000).toISOString()
    const octokit = {
      rest: {
        repos: {
          getCombinedStatusForRef: vi.fn().mockResolvedValue({
            data: {
              statuses: [
                { context: 'crosscheck/review', state: 'pending', updated_at: older },
                { context: 'crosscheck/review', state: 'success', updated_at: now },
              ],
            },
          }),
        },
      },
    }

    expect(await checkRemoteLock(octokit as never, 'o', 'r', 'sha')).toBe(false)
  })

  it('returns false when status is failure', async () => {
    const octokit = makeOctokit('failure', new Date().toISOString())
    expect(await checkRemoteLock(octokit as never, 'o', 'r', 'sha')).toBe(false)
  })

  it('returns false when the API throws', async () => {
    const octokit = {
      rest: { repos: { getCombinedStatusForRef: vi.fn().mockRejectedValue(new Error('network')) } },
    }
    expect(await checkRemoteLock(octokit as never, 'o', 'r', 'sha')).toBe(false)
  })
})

describe('acquireRemoteLock', () => {
  it('calls createCommitStatus with pending state', async () => {
    const octokit = makeOctokit(null)
    await acquireRemoteLock(octokit as never, 'o', 'r', 'sha')
    expect(octokit.rest.repos.createCommitStatus).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'pending', context: 'crosscheck/review' }),
    )
  })
})

describe('startRemoteLockHeartbeat', () => {
  it('returns a stop function that clears the interval', () => {
    const octokit = makeOctokit(null)
    const stop = startRemoteLockHeartbeat(octokit as never, 'o', 'r', 'sha')
    expect(typeof stop).toBe('function')
    expect(() => stop()).not.toThrow()
  })
})

describe('releaseRemoteLock', () => {
  it('sets status to success', async () => {
    const octokit = makeOctokit(null)
    await releaseRemoteLock(octokit as never, 'o', 'r', 'sha', 'success')
    expect(octokit.rest.repos.createCommitStatus).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'success' }),
    )
  })

  it('does not throw when API call fails', async () => {
    const octokit = {
      rest: { repos: { createCommitStatus: vi.fn().mockRejectedValue(new Error('network')) } },
    }
    await expect(releaseRemoteLock(octokit as never, 'o', 'r', 'sha', 'failure')).resolves.not.toThrow()
  })
})
