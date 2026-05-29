import { describe, it, expect } from 'vitest'
import { modelDisplayName, resolveClaudeModel, resolveCodexModel } from '../lib/review-models.js'
import type { CodexVendorConfig, QualityConfig } from '../config/schema.js'

const quality = (tier: QualityConfig['tier']): QualityConfig => ({
  tier,
  focus: [],
})

const codexVendor = (auth: CodexVendorConfig['auth'], model: string | null = null): CodexVendorConfig => ({
  enabled: true,
  auth,
  model,
  effort: 'medium',
  quality: 'medium',
})

describe('review model resolution', () => {
  it('resolves Claude models by tier', () => {
    expect(resolveClaudeModel(quality('fast'))).toBe('claude-haiku-4-5')
    expect(resolveClaudeModel(quality('balanced'))).toBe('claude-sonnet-4-6')
    expect(resolveClaudeModel(quality('thorough'))).toBe('claude-opus-4-7')
  })

  it('resolves Codex API-key models by tier and configured override', () => {
    expect(resolveCodexModel(quality('fast'), codexVendor('api-key'))).toBe('gpt-4o-mini')
    expect(resolveCodexModel(quality('balanced'), codexVendor('api-key'))).toBe('o4-mini')
    expect(resolveCodexModel(quality('thorough'), codexVendor('api-key'))).toBe('o3')
    expect(resolveCodexModel(quality('thorough'), codexVendor('api-key', 'custom-model'))).toBe('custom-model')
  })

  it('uses default for Codex subscription auth', () => {
    expect(resolveCodexModel(quality('thorough'), codexVendor('subscription'))).toBe('default')
    expect(modelDisplayName('default')).toBeNull()
  })

  it('formats known model display names', () => {
    expect(modelDisplayName('claude-opus-4-7')).toBe('Opus 4.7')
    expect(modelDisplayName('claude-sonnet-4-6')).toBe('Sonnet 4.6')
    expect(modelDisplayName('claude-haiku-4-5')).toBe('Haiku 4.5')
    expect(modelDisplayName('o4-mini')).toBe('o4-mini')
    expect(modelDisplayName('o3')).toBe('o3')
    expect(modelDisplayName('gpt-4o-mini')).toBe('gpt-4o-mini')
  })
})
