import { afterEach, describe, expect, it, vi } from 'vitest'
import { listIssueCommentsForScan } from '../github/client.js'

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
  it('requests issue comments in explicit created-at order with encoded path segments', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse([]))
    vi.stubGlobal('fetch', fetchMock)

    await listIssueCommentsForScan('acme org', 'api/repo', 12, 'token')

    const url = String(fetchMock.mock.calls[0]?.[0])
    expect(url).toContain('/repos/acme%20org/api%2Frepo/issues/12/comments')
    expect(url).toContain('sort=created')
    expect(url).toContain('direction=asc')
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
