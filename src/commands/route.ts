import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { homedir } from 'os'
import chalk from 'chalk'
import yaml from 'js-yaml'
import { detectGitHubLogin, resolveConfigPath } from '../config/loader.js'
import type { Config } from '../config/schema.js'

type AuthorRouteVendor = 'claude' | 'codex' | 'both'
type FallbackReviewerInput = 'auto' | 'claude' | 'codex' | 'skip'

function getConfigPath(explicitPath?: string): string {
  return resolveConfigPath(explicitPath) ?? join(homedir(), '.crosscheck', 'config.yml')
}

function readRawConfig(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) return {}
  return (yaml.load(readFileSync(configPath, 'utf8')) ?? {}) as Record<string, unknown>
}

function writeRawConfig(configPath: string, raw: Record<string, unknown>): void {
  mkdirSync(dirname(configPath), { recursive: true })
  writeFileSync(configPath, yaml.dump(raw, { lineWidth: -1, noRefs: true }))
}

export function resolveRouteLogin(config: Config): string {
  const detected = detectGitHubLogin()
  if (detected) return detected

  const fromConfig = config.users.find(user => user.trim().length > 0)
  if (fromConfig) return fromConfig

  throw new Error('Unable to detect your GitHub login. Run `gh auth login` or set `users:` in config.')
}

function ensureRouting(raw: Record<string, unknown>): Record<string, unknown> {
  if (typeof raw.routing !== 'object' || raw.routing === null) raw.routing = {}
  return raw.routing as Record<string, unknown>
}

export function parseFallbackReviewer(input: FallbackReviewerInput): 'auto' | 'claude' | 'codex' | null {
  if (input === 'skip') return null
  return input
}

function parseAuthorRouteVendor(input: string): AuthorRouteVendor {
  if (input === 'claude' || input === 'codex' || input === 'both') return input
  throw new Error('Invalid vendor. Use: claude | codex | both')
}

function parseFallbackReviewerInput(input: string): FallbackReviewerInput {
  if (input === 'auto' || input === 'claude' || input === 'codex' || input === 'skip') return input
  throw new Error('Invalid fallback reviewer. Use: auto | claude | codex | skip')
}

export function runRouteShow(config: Config, explicitPath?: string): void {
  try {
    const login = resolveRouteLogin(config)
    const route = config.routing.author_routes[login]
    const fallback = config.routing.fallback_reviewer ?? 'skip'

    console.log(chalk.bold('\ncrosscheck route\n'))
    console.log(`  login              ${chalk.cyan(login)}`)
    console.log(`  primary author AI  ${chalk.cyan(route ?? 'both (no per-author override)')}`)
    console.log(`  fallback reviewer  ${chalk.cyan(fallback ?? 'skip')}`)

    const entries = Object.entries(config.routing.author_routes)
    if (entries.length > 0) {
      console.log('\n  author_routes:')
      for (const [author, vendor] of entries) {
        console.log(`    ${author}: ${vendor}`)
      }
    }
    console.log(`\n  config             ${chalk.dim(getConfigPath(explicitPath))}\n`)
  } catch (err) {
    console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`))
    process.exit(1)
  }
}

export function runRouteSet(config: Config, vendorInput: string, explicitPath?: string): void {
  try {
    const vendor = parseAuthorRouteVendor(vendorInput)
    const login = resolveRouteLogin(config)
    const configPath = getConfigPath(explicitPath)
    const raw = readRawConfig(configPath)
    const routing = ensureRouting(raw)
    const currentRoutes = routing.author_routes != null && typeof routing.author_routes === 'object'
      ? { ...(routing.author_routes as Record<string, 'claude' | 'codex'>) }
      : {}

    if (vendor === 'both') delete currentRoutes[login]
    else currentRoutes[login] = vendor

    if (Object.keys(currentRoutes).length === 0) delete routing.author_routes
    else routing.author_routes = currentRoutes

    if (routing.fallback_reviewer === undefined) routing.fallback_reviewer = 'auto'

    writeRawConfig(configPath, raw)
    const detail = vendor === 'both' ? 'removed per-author override' : `set ${login} → ${vendor}`
    console.log(chalk.green(`✓ ${detail}`))
  } catch (err) {
    console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`))
    process.exit(1)
  }
}

export function runRouteFallback(_config: Config, reviewerInput: string, explicitPath?: string): void {
  try {
    const configPath = getConfigPath(explicitPath)
    const raw = readRawConfig(configPath)
    const routing = ensureRouting(raw)

    const reviewer = parseFallbackReviewerInput(reviewerInput)
    const parsed = parseFallbackReviewer(reviewer)
    routing.fallback_reviewer = parsed

    writeRawConfig(configPath, raw)

    const detail = parsed ?? 'skip'
    console.log(chalk.green(`✓ fallback reviewer set to ${detail}`))
  } catch (err) {
    console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`))
    process.exit(1)
  }
}
