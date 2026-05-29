import { afterEach, describe, expect, it, vi } from 'vitest'
import { listIssueCommentsForScan, listOpenPRsForScan, listUserReposForScan } from '../github/client.js'

function jsonResponse(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status: init.status ?? 200,
    statusText: init.statusText,
    headers: { 'Content-Type': 'application/json' },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('scan GitHub client helpers', () => {
  it('handles open PRs with a null author', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse([
      {
        number: 12,
        title: 'orphaned PR',
        user: null,
        head: { sha: 'abcdef123456', ref: 'feature', repo: null },
        base: { ref: 'main' },
        body: null,
        created_at: '2026-05-29T10:00:00Z',
        updated_at: '2026-05-29T11:00:00Z',
        html_url: 'https://github.com/acme/api/pull/12',
      },
    ]))
    vi.stubGlobal('fetch', fetchMock)

    const prs = await listOpenPRsForScan('acme', 'api', 'token')

    expect(prs[0]?.author).toBe('unknown')
  })

  it('requests issue comments in explicit created-at order', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse([]))
    vi.stubGlobal('fetch', fetchMock)

    await listIssueCommentsForScan('acme', 'api', 12, 'token')

    const url = String(fetchMock.mock.calls[0]?.[0])
    expect(url).toContain('sort=created')
    expect(url).toContain('direction=asc')
  })

  it('filters user repos by owner case-insensitively', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse([
      { name: 'api', owner: { login: 'BeingZY' }, archived: false },
      { name: 'fork', owner: { login: 'someone-else' }, archived: false },
    ]))
    vi.stubGlobal('fetch', fetchMock)

    const repos = await listUserReposForScan('beingzy', 'token', false)

    expect(repos).toEqual([{ owner: 'BeingZY', name: 'api' }])
  })

  it('surfaces GitHub rate limit responses distinctly', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(
      { message: 'API rate limit exceeded' },
      { status: 403, statusText: 'Forbidden' },
    ))
    vi.stubGlobal('fetch', fetchMock)

    await expect(listIssueCommentsForScan('acme', 'api', 12, 'token'))
      .rejects.toThrow('GitHub rate limit or secondary rate limit')
  })
})
