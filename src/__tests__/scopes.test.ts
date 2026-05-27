import { describe, it, expect } from 'vitest'
import { dedupScopes, type Scope } from '../lib/scopes.js'

describe('dedupScopes', () => {
  it('drops repo scope when its owner is in orgs', () => {
    const input: Scope[] = [
      { org: 'codatta' },
      { owner: 'codatta', repo: 'humanbased-monorepo' },
    ]
    const { scopes, dropped, fallbackRepos } = dedupScopes(input)
    expect(scopes).toEqual([{ org: 'codatta' }])
    expect(dropped.get('codatta')).toEqual(['humanbased-monorepo'])
    expect(fallbackRepos.get('codatta')).toEqual([
      { owner: 'codatta', repo: 'humanbased-monorepo' },
    ])
  })

  it('keeps repo scope when its owner is not in orgs', () => {
    const input: Scope[] = [
      { org: 'codatta' },
      { owner: 'beingzy', repo: 'founder-dashboard' },
    ]
    const { scopes, dropped, fallbackRepos } = dedupScopes(input)
    expect(scopes).toEqual(input)
    expect(dropped.size).toBe(0)
    expect(fallbackRepos.size).toBe(0)
  })

  it('matches org and owner names case-insensitively while preserving display values', () => {
    const input: Scope[] = [
      { org: 'motivation-labs' },
      { owner: 'Motivation-Labs', repo: 'crosscheck' },
    ]
    const { scopes, dropped, fallbackRepos } = dedupScopes(input)
    expect(scopes).toEqual([{ org: 'motivation-labs' }])
    expect([...dropped.entries()]).toEqual([
      ['motivation-labs', ['crosscheck']],
    ])
    expect(fallbackRepos.get('motivation-labs')).toEqual([
      { owner: 'Motivation-Labs', repo: 'crosscheck' },
    ])
  })

  it('preserves order: orgs first, then surviving repos in original order', () => {
    const input: Scope[] = [
      { org: 'Motivation-Labs' },
      { owner: 'beingzy', repo: 'a' },
      { owner: 'Motivation-Labs', repo: 'monorepo' },
      { owner: 'beingzy', repo: 'b' },
      { org: 'codatta' },
      { owner: 'codatta', repo: 'symphony' },
    ]
    const { scopes, dropped, fallbackRepos } = dedupScopes(input)
    expect(scopes).toEqual([
      { org: 'Motivation-Labs' },
      { owner: 'beingzy', repo: 'a' },
      { owner: 'beingzy', repo: 'b' },
      { org: 'codatta' },
    ])
    expect([...dropped.entries()]).toEqual([
      ['Motivation-Labs', ['monorepo']],
      ['codatta', ['symphony']],
    ])
    expect([...fallbackRepos.entries()]).toEqual([
      ['Motivation-Labs', [{ owner: 'Motivation-Labs', repo: 'monorepo' }]],
      ['codatta', [{ owner: 'codatta', repo: 'symphony' }]],
    ])
  })

  it('aggregates multiple drops per org', () => {
    const input: Scope[] = [
      { org: 'codatta' },
      { owner: 'codatta', repo: 'a' },
      { owner: 'codatta', repo: 'b' },
      { owner: 'codatta', repo: 'c' },
    ]
    const { scopes, dropped } = dedupScopes(input)
    expect(scopes).toEqual([{ org: 'codatta' }])
    expect(dropped.get('codatta')).toEqual(['a', 'b', 'c'])
  })

  it('returns empty dropped map and unchanged scopes when no orgs configured', () => {
    const input: Scope[] = [
      { owner: 'a', repo: 'x' },
      { owner: 'b', repo: 'y' },
    ]
    const { scopes, dropped } = dedupScopes(input)
    expect(scopes).toEqual(input)
    expect(dropped.size).toBe(0)
  })

  it('handles empty input', () => {
    const { scopes, dropped } = dedupScopes([])
    expect(scopes).toEqual([])
    expect(dropped.size).toBe(0)
  })

  it('does not drop org scopes themselves even when duplicated (no-op for duplicate orgs)', () => {
    const input: Scope[] = [
      { org: 'codatta' },
      { org: 'codatta' },
    ]
    const { scopes, dropped } = dedupScopes(input)
    // duplicate org scopes are out of dedupScopes' contract; only repo-vs-org collapse is in scope
    expect(scopes).toEqual(input)
    expect(dropped.size).toBe(0)
  })
})
