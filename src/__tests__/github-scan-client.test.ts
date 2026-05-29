import { afterEach, describe, expect, it, vi } from 'vitest'
import { listCheckRuns, listCommitStatuses, listIssueComments } from '../github/client.js'

afterEach(() => {
  vi.restoreAllMocks()
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('scan GitHub client helpers', () => {
  it('paginates check runs for a commit ref', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      name: `check-${index}`,
      status: 'completed',
      conclusion: 'success',
      completed_at: '2026-05-29T00:00:00.000Z',
      started_at: null,
    }))
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ check_runs: firstPage }))
      .mockResolvedValueOnce(jsonResponse({
        check_runs: [{
          name: 'check-100',
          status: 'completed',
          conclusion: 'success',
          completed_at: '2026-05-29T00:01:00.000Z',
          started_at: null,
        }],
      }))

    const runs = await listCheckRuns('acme', 'web', 'abc123', 'token')

    expect(runs).toHaveLength(101)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(String(fetchSpy.mock.calls[1][0])).toContain('page=2')
  })

  it('paginates commit statuses for a commit ref', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      context: `ci-${index}`,
      state: 'success',
      updated_at: '2026-05-29T00:00:00.000Z',
    }))
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(firstPage))
      .mockResolvedValueOnce(jsonResponse([{
        context: 'ci-100',
        state: 'pending',
        updated_at: '2026-05-29T00:01:00.000Z',
      }]))

    const statuses = await listCommitStatuses('acme', 'web', 'abc123', 'token')

    expect(statuses).toHaveLength(101)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/statuses?per_page=100&page=1')
  })

  it('throws for non-404 issue comment failures', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({ message: 'rate limited' }, 429))

    await expect(listIssueComments('acme', 'web', 7, 'token'))
      .rejects.toThrow('GitHub API request failed')
  })

  it('treats missing issue comments as empty activity', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({ message: 'not found' }, 404))

    await expect(listIssueComments('acme', 'web', 7, 'token')).resolves.toEqual([])
  })
})
