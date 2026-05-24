import { describe, it, expect, vi } from 'vitest'
import { detectOriginFromBody, detectOriginFromBranch, detectOriginFull, assignReviewer } from '../github/detector.js'
import { ConfigSchema, type Config } from '../config/schema.js'

function buildConfig(overrides: Record<string, unknown> = {}): Config {
  return ConfigSchema.parse({
    mode: 'cross-vendor',
    vendors: { claude: { enabled: true }, codex: { enabled: true } },
    ...overrides,
  })
}

vi.mock('../github/client.js', () => ({
  getPRCommits: vi.fn(async () => []),
}))

describe('detectOriginFromBody', () => {
  it('detects claude origin from PR body footer', () => {
    expect(detectOriginFromBody('Generated with [Claude Code]', buildConfig())).toBe('claude')
  })

  it('detects codex origin from PR body footer', () => {
    expect(detectOriginFromBody('Generated with [OpenAI Codex]', buildConfig())).toBe('codex')
  })

  it('returns null when no pattern matches', () => {
    expect(detectOriginFromBody('just a normal PR body', buildConfig())).toBeNull()
  })
})

describe('detectOriginFromBranch', () => {
  it('detects claude origin from claude/ branch prefix', () => {
    expect(detectOriginFromBranch('claude/feat-foo', buildConfig())).toBe('claude')
  })

  it('detects codex origin from codex/ branch prefix', () => {
    expect(detectOriginFromBranch('codex/feat-foo', buildConfig())).toBe('codex')
  })

  it('returns null when no prefix matches', () => {
    expect(detectOriginFromBranch('feature/foo', buildConfig())).toBeNull()
  })
})

describe('detectOriginFull — author_routes behavior', () => {
  it('cross-vendor mode with both vendors enabled: bypasses author_routes', async () => {
    const cfg = buildConfig({
      mode: 'cross-vendor',
      vendors: { claude: { enabled: true }, codex: { enabled: true } },
      routing: { author_routes: { beingzy: 'claude' } },
    })
    const result = await detectOriginFull('', 'feature/foo', 'owner', 'repo', 1, cfg, 'token', 'beingzy')
    expect(result.origin).toBe('human')
    expect(result.method).toBe('author_routes_bypassed')
  })

  it('single-vendor mode: applies author_routes normally', async () => {
    const cfg = buildConfig({
      mode: 'single-vendor',
      vendors: { claude: { enabled: true }, codex: { enabled: false } },
      routing: { author_routes: { beingzy: 'claude' } },
    })
    const result = await detectOriginFull('', 'feature/foo', 'owner', 'repo', 1, cfg, 'token', 'beingzy')
    expect(result.origin).toBe('claude')
    expect(result.method).toBe('author_routes')
  })

  it('cross-vendor with only one vendor enabled: applies author_routes normally', async () => {
    const cfg = buildConfig({
      mode: 'cross-vendor',
      vendors: { claude: { enabled: true }, codex: { enabled: false } },
      routing: { author_routes: { beingzy: 'claude' } },
    })
    const result = await detectOriginFull('', 'feature/foo', 'owner', 'repo', 1, cfg, 'token', 'beingzy')
    expect(result.origin).toBe('claude')
    expect(result.method).toBe('author_routes')
  })

  it('cross-vendor with both enabled: attribution signals still win over author_routes', async () => {
    const cfg = buildConfig({
      mode: 'cross-vendor',
      vendors: { claude: { enabled: true }, codex: { enabled: true } },
      routing: { author_routes: { beingzy: 'claude' } },
    })
    const result = await detectOriginFull('', 'codex/feat', 'owner', 'repo', 1, cfg, 'token', 'beingzy')
    expect(result.origin).toBe('codex')
    expect(result.method).toBe('branch')
  })

  it('cross-vendor without author_routes: falls through to human', async () => {
    const cfg = buildConfig({
      mode: 'cross-vendor',
      vendors: { claude: { enabled: true }, codex: { enabled: true } },
      routing: { author_routes: {} },
    })
    const result = await detectOriginFull('', 'feature/foo', 'owner', 'repo', 1, cfg, 'token', 'beingzy')
    expect(result.origin).toBe('human')
    expect(result.method).toBe('none')
  })
})

describe('assignReviewer', () => {
  it('cross-vendor: claude origin → codex reviewer', async () => {
    expect(await assignReviewer('claude', buildConfig())).toBe('codex')
  })

  it('cross-vendor: codex origin → claude reviewer', async () => {
    expect(await assignReviewer('codex', buildConfig())).toBe('claude')
  })

  it('cross-vendor: explicit fallback_reviewer is honored for human origin', async () => {
    const cfg = buildConfig({
      routing: { fallback_reviewer: 'claude' },
    })
    expect(await assignReviewer('human', cfg)).toBe('claude')
  })

  it('cross-vendor: fallback_reviewer=null skips human-origin PRs', async () => {
    const cfg = buildConfig({
      routing: { fallback_reviewer: null },
    })
    expect(await assignReviewer('human', cfg)).toBeNull()
  })
})
