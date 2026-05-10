import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { applyOnboardConfig, type OnboardDecisions } from '../commands/onboard.js'

const BASE_DECISIONS: OnboardDecisions = {
  deployment: 'personal',
  login: 'alice',
  selectedRepos: ['alice/myapp'],
  selectedOrgs: [],
  vendorConfig: { mode: 'cross-vendor', claudeEnabled: true, codexEnabled: true },
  qualityTier: 'balanced',
  pipelinePreset: 'review-only',
  tunnelBackend: 'localhost.run',
  smeeChannel: '',
}

let tmpDir: string
let configPath: string
let workflowDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'crosscheck-test-'))
  configPath = join(tmpDir, 'config.yml')
  workflowDir = join(tmpDir, 'workflow-dir')
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

function readConfig(): Record<string, unknown> {
  return (yaml.load(readFileSync(configPath, 'utf8')) ?? {}) as Record<string, unknown>
}

describe('applyOnboardConfig — first run', () => {
  it('creates config with routing defaults when no file exists', () => {
    applyOnboardConfig(configPath, BASE_DECISIONS, workflowDir)

    const cfg = readConfig()
    expect(cfg.deployment).toBe('personal')
    const routing = cfg.routing as Record<string, unknown>
    expect(routing.allowed_authors).toEqual(['alice'])
    expect(routing.fallback_reviewer).toBe('auto')
  })

  it('sets quality.tier but does not set vendors.claude.model', () => {
    applyOnboardConfig(configPath, { ...BASE_DECISIONS, qualityTier: 'thorough' }, workflowDir)

    const cfg = readConfig()
    const quality = cfg.quality as Record<string, unknown>
    expect(quality.tier).toBe('thorough')
    const vendors = cfg.vendors as Record<string, Record<string, unknown>>
    expect(vendors.claude.model).toBeUndefined()
    expect(vendors.claude.effort).toBe('max')
    expect(vendors.codex.model).toBe('o3')
  })

  it('writes workflow.yml when preset is review-fix-recheck', () => {
    applyOnboardConfig(configPath, { ...BASE_DECISIONS, pipelinePreset: 'review-fix-recheck' }, workflowDir)

    expect(existsSync(join(workflowDir, 'workflow.yml'))).toBe(true)
  })

  it('does not write workflow.yml for review-only or review-fix', () => {
    applyOnboardConfig(configPath, BASE_DECISIONS, workflowDir)
    expect(existsSync(join(workflowDir, 'workflow.yml'))).toBe(false)

    applyOnboardConfig(configPath, { ...BASE_DECISIONS, pipelinePreset: 'review-fix' }, workflowDir)
    expect(existsSync(join(workflowDir, 'workflow.yml'))).toBe(false)
  })
})

describe('applyOnboardConfig — re-run preservation', () => {
  it('preserves quality.focus and quality.custom_prompt', () => {
    // Seed config with custom quality settings
    writeFileSync(configPath, yaml.dump({
      deployment: 'personal',
      quality: {
        tier: 'fast',
        focus: ['security', 'performance'],
        custom_prompt: 'Be concise.',
      },
    }))

    applyOnboardConfig(configPath, { ...BASE_DECISIONS, qualityTier: 'balanced' }, workflowDir)

    const cfg = readConfig()
    const quality = cfg.quality as Record<string, unknown>
    expect(quality.tier).toBe('balanced')              // updated
    expect(quality.focus).toEqual(['security', 'performance'])  // preserved
    expect(quality.custom_prompt).toBe('Be concise.')  // preserved
  })

  it('preserves budget fields', () => {
    writeFileSync(configPath, yaml.dump({
      deployment: 'personal',
      budget: { codex_monthly_usd: 50, per_review_usd: 3.00 },
    }))

    applyOnboardConfig(configPath, BASE_DECISIONS, workflowDir)

    const cfg = readConfig()
    const budget = cfg.budget as Record<string, unknown>
    expect(budget.per_review_usd).toBe(3.00)
    expect(budget.codex_monthly_usd).toBe(50)
  })

  it('preserves routing.allowed_authors on re-run', () => {
    writeFileSync(configPath, yaml.dump({
      deployment: 'personal',
      routing: {
        allowed_authors: ['alice', 'my-bot'],
        fallback_reviewer: 'claude',
      },
    }))

    applyOnboardConfig(configPath, BASE_DECISIONS, workflowDir)

    const cfg = readConfig()
    const routing = cfg.routing as Record<string, unknown>
    expect(routing.allowed_authors).toEqual(['alice', 'my-bot'])  // custom list preserved
    expect(routing.fallback_reviewer).toBe('claude')              // custom value preserved
  })

  it('preserves routing.author_routes on re-run', () => {
    writeFileSync(configPath, yaml.dump({
      deployment: 'personal',
      routing: {
        allowed_authors: ['alice'],
        author_routes: { alice: 'claude', 'my-agent': 'codex' },
        fallback_reviewer: 'auto',
      },
    }))

    applyOnboardConfig(configPath, BASE_DECISIONS, workflowDir)

    const cfg = readConfig()
    const routing = cfg.routing as Record<string, unknown>
    expect(routing.author_routes).toEqual({ alice: 'claude', 'my-agent': 'codex' })
  })

  it('preserves branding and server fields', () => {
    writeFileSync(configPath, yaml.dump({
      deployment: 'personal',
      brand: { service_name: 'mycheck' },
      server: { port: 9000 },
      logs: { retention_days: 14 },
    }))

    applyOnboardConfig(configPath, BASE_DECISIONS, workflowDir)

    const cfg = readConfig()
    expect((cfg.brand as Record<string, unknown>).service_name).toBe('mycheck')
    expect((cfg.server as Record<string, unknown>).port).toBe(9000)
    expect((cfg.logs as Record<string, unknown>).retention_days).toBe(14)
  })
})

describe('applyOnboardConfig — users / routing edge cases', () => {
  it('clears users when switching to team mode with no scope selected', () => {
    writeFileSync(configPath, yaml.dump({
      deployment: 'personal',
      users: ['alice'],
      routing: { allowed_authors: ['alice'], fallback_reviewer: 'auto' },
    }))

    applyOnboardConfig(configPath, {
      ...BASE_DECISIONS,
      deployment: 'team',
      selectedRepos: [],
      selectedOrgs: [],
    }, workflowDir)

    const cfg = readConfig()
    expect(cfg.users).toBeUndefined()
  })

  it('initialises allowed_authors when routing exists but allowed_authors is empty', () => {
    // Simulate an unpatched example config: routing block present but no allowed_authors
    writeFileSync(configPath, yaml.dump({
      deployment: 'personal',
      routing: { fallback_reviewer: 'auto' },
    }))

    applyOnboardConfig(configPath, BASE_DECISIONS, workflowDir)

    const cfg = readConfig()
    const routing = cfg.routing as Record<string, unknown>
    expect(routing.allowed_authors).toEqual(['alice'])
  })

  it('preserves non-empty allowed_authors even if partial routing exists', () => {
    writeFileSync(configPath, yaml.dump({
      deployment: 'personal',
      routing: { allowed_authors: ['alice', 'bot'], fallback_reviewer: 'claude' },
    }))

    applyOnboardConfig(configPath, BASE_DECISIONS, workflowDir)

    const cfg = readConfig()
    const routing = cfg.routing as Record<string, unknown>
    expect(routing.allowed_authors).toEqual(['alice', 'bot'])
    expect(routing.fallback_reviewer).toBe('claude')
  })
})

describe('applyOnboardConfig — workflow.yml lifecycle', () => {
  it('switches from recheck to review-only: deletes workflow.yml', () => {
    // First run: recheck
    applyOnboardConfig(configPath, { ...BASE_DECISIONS, pipelinePreset: 'review-fix-recheck' }, workflowDir)
    expect(existsSync(join(workflowDir, 'workflow.yml'))).toBe(true)

    // Re-run: review-only
    applyOnboardConfig(configPath, { ...BASE_DECISIONS, pipelinePreset: 'review-only' }, workflowDir)
    expect(existsSync(join(workflowDir, 'workflow.yml'))).toBe(false)
  })

  it('keeps recheck: does not overwrite a user-customized workflow.yml', () => {
    const workflowPath = join(workflowDir, 'workflow.yml')

    // First run: recheck writes template
    applyOnboardConfig(configPath, { ...BASE_DECISIONS, pipelinePreset: 'review-fix-recheck' }, workflowDir)
    const templateContent = readFileSync(workflowPath, 'utf8')

    // User customizes the file
    const customContent = templateContent + '\n# my custom step\n'
    writeFileSync(workflowPath, customContent)

    // Re-run with same preset
    applyOnboardConfig(configPath, { ...BASE_DECISIONS, pipelinePreset: 'review-fix-recheck' }, workflowDir)

    // Custom content is untouched
    expect(readFileSync(workflowPath, 'utf8')).toBe(customContent)
  })
})
