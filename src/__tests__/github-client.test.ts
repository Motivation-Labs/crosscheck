import { afterEach, describe, expect, it, vi } from 'vitest'
import { listOpenPRs, listOrgRepos } from '../github/client.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('github client listing failures', () => {
  it('throws when listOpenPRs receives a non-OK response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: 'server error' }), {
        status: 500,
        statusText: 'Internal Server Error',
      }),
    ))

    await expect(listOpenPRs('acme', 'api', 'token')).rejects.toThrow(
      'Failed to list open PRs for acme/api page 1 [500]: server error',
    )
  })

  it('throws when listOrgRepos receives a non-OK response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: 'rate limited' }), {
        status: 403,
        statusText: 'Forbidden',
      }),
    ))

    await expect(listOrgRepos('acme', 'token')).rejects.toThrow(
      'Failed to list org repos [403]: Forbidden',
    )
  })
})
