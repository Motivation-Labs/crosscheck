import { describe, it, expect, vi, beforeEach } from 'vitest'
import { scanUnreviewedPRs, buildScopesFromConfig, type BacktraceScope } from '../lib/backtrace.js'
import { ConfigSchema } from '../config/schema.js'

vi.mock('../github/client.js', () => ({
  listOpenPRs: vi.fn(),
  listOrgRepos: vi.fn(),
  listUserRepos: vi.fn(),
  prHasCrossCheckComment: vi.fn(),
}))

const { listOpenPRs, listOrgRepos, listUserRepos, prHasCrossCheckComment } =
  await import('../github/client.js')

const mockListOpenPRs = vi.mocked(listOpenPRs)
const mockListOrgRepos = vi.mocked(listOrgRepos)
const mockListUserRepos = vi.mocked(listUserRepos)
const mockPrHasCrossCheckComment = vi.mocked(prHasCrossCheckComment)

const defaultConfig = ConfigSchema.parse({})

function makePR(overrides: Partial<{
  number: number
  author: string
  createdAt: string
}> = {}) {
  return {
    number: overrides.number ?? 1,
    title: 'test PR',
    author: overrides.author ?? 'alice',
    headSha: 'abc123',
    headRef: 'feat/thing',
    headRepo: 'acme/api',
    baseRef: 'main',
    body: null,
    createdAt: overrides.createdAt ?? '2025-01-01T00:00:00Z',
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('scanUnreviewedPRs', () => {
  it('returns empty result for empty scopes without calling any API', async () => {
    const result = await scanUnreviewedPRs([], defaultConfig, 'token')
    expect(result).toEqual({ queued: [], alreadyReviewed: 0, skippedAuthor: 0 })
    expect(mockListOpenPRs).not.toHaveBeenCalled()
  })

  it('includes a PR with no [crosscheck] comment', async () => {
    const scopes: BacktraceScope[] = [{ owner: 'acme', repo: 'api' }]
    mockListOpenPRs.mockResolvedValue([makePR()])
    mockPrHasCrossCheckComment.mockResolvedValue(false)

    const result = await scanUnreviewedPRs(scopes, defaultConfig, 'token')

    expect(result.queued).toHaveLength(1)
    expect(result.queued[0].number).toBe(1)
    expect(result.alreadyReviewed).toBe(0)
    expect(result.skippedAuthor).toBe(0)
  })

  it('excludes a PR that already has a [crosscheck] comment', async () => {
    const scopes: BacktraceScope[] = [{ owner: 'acme', repo: 'api' }]
    mockListOpenPRs.mockResolvedValue([makePR()])
    mockPrHasCrossCheckComment.mockResolvedValue(true)

    const result = await scanUnreviewedPRs(scopes, defaultConfig, 'token')

    expect(result.queued).toHaveLength(0)
    expect(result.alreadyReviewed).toBe(1)
  })

  it('excludes a PR whose author is not in allowed_authors', async () => {
    const config = ConfigSchema.parse({ routing: { allowed_authors: ['bob'] } })
    const scopes: BacktraceScope[] = [{ owner: 'acme', repo: 'api' }]
    mockListOpenPRs.mockResolvedValue([makePR({ author: 'alice' })])

    const result = await scanUnreviewedPRs(scopes, config, 'token')

    expect(result.queued).toHaveLength(0)
    expect(result.skippedAuthor).toBe(1)
    expect(mockPrHasCrossCheckComment).not.toHaveBeenCalled()
  })

  it('includes all authors when allowed_authors is empty', async () => {
    const scopes: BacktraceScope[] = [{ owner: 'acme', repo: 'api' }]
    mockListOpenPRs.mockResolvedValue([makePR({ author: 'anyone' })])
    mockPrHasCrossCheckComment.mockResolvedValue(false)

    const result = await scanUnreviewedPRs(scopes, defaultConfig, 'token')

    expect(result.queued).toHaveLength(1)
  })

  it('sorts queued PRs oldest-first', async () => {
    const scopes: BacktraceScope[] = [{ owner: 'acme', repo: 'api' }]
    mockListOpenPRs.mockResolvedValue([
      makePR({ number: 3, createdAt: '2025-03-01T00:00:00Z' }),
      makePR({ number: 1, createdAt: '2025-01-01T00:00:00Z' }),
      makePR({ number: 2, createdAt: '2025-02-01T00:00:00Z' }),
    ])
    mockPrHasCrossCheckComment.mockResolvedValue(false)

    const result = await scanUnreviewedPRs(scopes, defaultConfig, 'token')

    expect(result.queued.map(p => p.number)).toEqual([1, 2, 3])
  })

  it('expands org scopes to individual repos', async () => {
    const scopes: BacktraceScope[] = [{ org: 'acme' }]
    mockListOrgRepos.mockResolvedValue([
      { owner: 'acme', name: 'api', pushedAt: null },
      { owner: 'acme', name: 'frontend', pushedAt: null },
    ])
    mockListOpenPRs.mockResolvedValue([])

    await scanUnreviewedPRs(scopes, defaultConfig, 'token')

    expect(mockListOrgRepos).toHaveBeenCalledWith('acme', 'token')
    expect(mockListOpenPRs).toHaveBeenCalledWith('acme', 'api', 'token')
    expect(mockListOpenPRs).toHaveBeenCalledWith('acme', 'frontend', 'token')
  })

  it('continues scan when listOpenPRs throws for one repo', async () => {
    const scopes: BacktraceScope[] = [
      { owner: 'acme', repo: 'broken' },
      { owner: 'acme', repo: 'working' },
    ]
    mockListOpenPRs
      .mockRejectedValueOnce(new Error('API error'))
      .mockResolvedValueOnce([makePR()])
    mockPrHasCrossCheckComment.mockResolvedValue(false)

    const result = await scanUnreviewedPRs(scopes, defaultConfig, 'token')

    expect(result.queued).toHaveLength(1)
  })

  it('skips a PR when prHasCrossCheckComment throws', async () => {
    const scopes: BacktraceScope[] = [{ owner: 'acme', repo: 'api' }]
    mockListOpenPRs.mockResolvedValue([makePR()])
    mockPrHasCrossCheckComment.mockRejectedValue(new Error('API error'))

    const result = await scanUnreviewedPRs(scopes, defaultConfig, 'token')

    expect(result.queued).toHaveLength(0)
    expect(result.alreadyReviewed).toBe(0)
  })

  it('handles mixed queued / already-reviewed / skipped in one scan', async () => {
    const config = ConfigSchema.parse({ routing: { allowed_authors: ['alice', 'bob'] } })
    const scopes: BacktraceScope[] = [{ owner: 'acme', repo: 'api' }]
    mockListOpenPRs.mockResolvedValue([
      makePR({ number: 1, author: 'alice' }),   // queued
      makePR({ number: 2, author: 'bob' }),     // already reviewed
      makePR({ number: 3, author: 'carol' }),   // skipped (author)
    ])
    mockPrHasCrossCheckComment
      .mockResolvedValueOnce(false)  // PR 1
      .mockResolvedValueOnce(true)   // PR 2

    const result = await scanUnreviewedPRs(scopes, config, 'token')

    expect(result.queued).toHaveLength(1)
    expect(result.queued[0].number).toBe(1)
    expect(result.alreadyReviewed).toBe(1)
    expect(result.skippedAuthor).toBe(1)
  })
})

describe('buildScopesFromConfig', () => {
  it('builds org and repo scopes from config', async () => {
    const config = ConfigSchema.parse({
      orgs: ['acme'],
      repos: [{ owner: 'bob', name: 'myrepo' }],
    })

    const scopes = await buildScopesFromConfig(config, 'token')

    expect(scopes).toContainEqual({ org: 'acme' })
    expect(scopes).toContainEqual({ owner: 'bob', repo: 'myrepo' })
  })

  it('expands users to repo scopes', async () => {
    const config = ConfigSchema.parse({ users: ['alice'] })
    mockListUserRepos.mockResolvedValue([{ owner: 'alice', name: 'proj' }])

    const scopes = await buildScopesFromConfig(config, 'token')

    expect(scopes).toContainEqual({ owner: 'alice', repo: 'proj' })
    expect(mockListUserRepos).toHaveBeenCalledWith('alice', 'token')
  })

  it('continues when listUserRepos throws', async () => {
    const config = ConfigSchema.parse({ users: ['alice'], orgs: ['acme'] })
    mockListUserRepos.mockRejectedValue(new Error('API error'))

    const scopes = await buildScopesFromConfig(config, 'token')

    expect(scopes).toContainEqual({ org: 'acme' })
    expect(scopes).not.toContainEqual(expect.objectContaining({ owner: 'alice' }))
  })
})
