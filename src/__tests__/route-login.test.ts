import { describe, expect, it, vi } from 'vitest'
import { ConfigSchema } from '../config/schema.js'

vi.mock('../config/loader.js', () => ({
  detectGitHubLogin: () => null,
  resolveConfigPath: () => null,
}))

import { resolveRouteLogin } from '../commands/route.js'

describe('resolveRouteLogin', () => {
  it('falls back to first configured user when gh login is unavailable', () => {
    const config = ConfigSchema.parse({ users: ['alice'] })
    expect(resolveRouteLogin(config)).toBe('alice')
  })
})
