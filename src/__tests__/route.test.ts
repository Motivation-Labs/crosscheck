import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { loadConfig } from '../config/loader.js'
import { parseFallbackReviewer, runRouteFallback, runRouteSet } from '../commands/route.js'

let tmpDir: string
let configPath: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'crosscheck-route-'))
  configPath = join(tmpDir, 'config.yml')
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

function seedConfig(raw: Record<string, unknown>): void {
  writeFileSync(configPath, yaml.dump(raw))
}

function readRawConfig(): Record<string, unknown> {
  return (yaml.load(readFileSync(configPath, 'utf8')) ?? {}) as Record<string, unknown>
}

describe('route command helpers', () => {
  it('maps skip fallback to null', () => {
    expect(parseFallbackReviewer('skip')).toBeNull()
    expect(parseFallbackReviewer('auto')).toBe('auto')
  })
})

describe('runRouteSet', () => {
  it('sets current user route to codex and preserves other routes', () => {
    seedConfig({
      users: ['alice'],
      routing: { author_routes: { alice: 'claude', teammate: 'codex' }, fallback_reviewer: 'auto' },
    })

    runRouteSet(loadConfig(configPath), 'codex', configPath)

    const routing = (readRawConfig().routing ?? {}) as Record<string, unknown>
    expect(routing.author_routes).toEqual({ alice: 'codex', teammate: 'codex' })
  })

  it('removes current user route when set to both', () => {
    seedConfig({
      users: ['alice'],
      routing: { author_routes: { alice: 'claude' }, fallback_reviewer: 'auto' },
    })

    runRouteSet(loadConfig(configPath), 'both', configPath)

    const routing = (readRawConfig().routing ?? {}) as Record<string, unknown>
    expect(routing.author_routes).toBeUndefined()
    expect(routing.fallback_reviewer).toBe('auto')
  })
})

describe('runRouteFallback', () => {
  it('writes fallback reviewer skip as null', () => {
    seedConfig({
      users: ['alice'],
      routing: { author_routes: { alice: 'claude' }, fallback_reviewer: 'auto' },
    })

    runRouteFallback(loadConfig(configPath), 'skip', configPath)

    const routing = (readRawConfig().routing ?? {}) as Record<string, unknown>
    expect(routing.fallback_reviewer).toBeNull()
  })
})
