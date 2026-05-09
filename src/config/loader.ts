import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { execSync } from 'child_process'
import { createInterface } from 'readline'
import { resolve, join } from 'path'
import { homedir } from 'os'
import { randomBytes } from 'crypto'
import yaml from 'js-yaml'
import { ConfigSchema, type Config } from './schema.js'
import { listUserOrgs } from '../github/client.js'

const CONFIG_FILENAME = 'crosscheck.config.yml'

function findConfigFile(): string | null {
  const candidates = [
    resolve(process.cwd(), CONFIG_FILENAME),
    resolve(process.cwd(), '.crosscheck.yml'),
    join(homedir(), '.crosscheck', 'config.yml'),
  ]
  return candidates.find(existsSync) ?? null
}

export function resolveConfigPath(explicitPath?: string): string | null {
  return explicitPath ?? findConfigFile()
}

export function loadConfig(explicitPath?: string): Config {
  const configPath = resolveConfigPath(explicitPath)
  if (!configPath) return ConfigSchema.parse({})

  const raw = yaml.load(readFileSync(configPath, 'utf8'))
  return ConfigSchema.parse(raw)
}

// Shared by getGithubToken() and status.ts so both resolve through identical logic.
export function getGithubTokenSource(): { token: string; source: 'gh-keyring' | 'env' } | null {
  // Strip GITHUB_TOKEN / GH_TOKEN from the subprocess env before calling
  // `gh auth token`. When those vars are present (even invalid/expired), gh
  // treats them as the active credential and echoes them back — bypassing the
  // keyring entirely.
  try {
    const t = execSync('gh auth token 2>/dev/null', {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_TOKEN: undefined, GH_TOKEN: undefined },
    }).trim()
    if (t) return { token: t, source: 'gh-keyring' }
  } catch { /* gh not available or no keyring session */ }

  // Fall back to env var — useful in CI where gh is not set up
  const env = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  if (env) return { token: env, source: 'env' }

  return null
}

export function getGithubToken(): string {
  const result = getGithubTokenSource()
  if (result) return result.token
  throw new Error(
    'No GitHub token found.\n' +
    '  Option 1: run: gh auth login\n' +
    '  Option 2: set GITHUB_TOKEN in your shell profile or .env file'
  )
}

const SECRET_FILE = join(homedir(), '.crosscheck', 'webhook-secret')

export function getWebhookSecret(): string {
  // Env var takes precedence
  const fromEnv = process.env.CROSSCHECK_WEBHOOK_SECRET ?? process.env.GITHUB_WEBHOOK_SECRET
  if (fromEnv) return fromEnv

  // Persist and reuse an auto-generated secret
  if (existsSync(SECRET_FILE)) {
    return readFileSync(SECRET_FILE, 'utf8').trim()
  }

  const generated = randomBytes(32).toString('hex')
  mkdirSync(join(homedir(), '.crosscheck'), { recursive: true })
  writeFileSync(SECRET_FILE, generated, { mode: 0o600 })
  return generated
}

export function getWebhookSecretPath(): string {
  return SECRET_FILE
}

export function detectGitHubLogin(): string | null {
  const envVariants = [
    { ...process.env, GITHUB_TOKEN: undefined, GH_TOKEN: undefined }, // keyring first
    process.env,                                                         // env token fallback
  ]
  for (const env of envVariants) {
    try {
      const login = execSync("gh api user --jq '.login' 2>/dev/null", { encoding: 'utf8', env }).trim()
      if (login && !login.includes('\n')) return login
    } catch { /* try next */ }
  }
  return null
}

export function patchAllowedAuthors(configPath: string, login: string): boolean {
  let content = readFileSync(configPath, 'utf8')

  // Guard: if allowed_authors already has real (non-comment) entries, nothing to do.
  // Entries appear as `    - value` lines after the key, optionally preceded by comment lines.
  if (/  allowed_authors:\s*\n(?:  #[^\n]*\n)*    - /.test(content)) return false

  // Case 1: commented-out placeholder block from the example config
  const uncommented = content.replace(
    /  # allowed_authors:\n(  #[^\n]*\n)+/,
    `  allowed_authors:\n    - ${login}  # auto-detected from gh auth\n`,
  )
  if (uncommented !== content) {
    writeFileSync(configPath, uncommented)
    return true
  }

  // Case 2: key exists but list is empty (no entries under it, only optional comment lines)
  const filledEmpty = content.replace(
    /(  allowed_authors:\s*\n)((?:  #[^\n]*\n)*)/,
    `  allowed_authors:\n    - ${login}  # auto-detected from gh auth\n`,
  )
  if (filledEmpty !== content) {
    writeFileSync(configPath, filledEmpty)
    return true
  }

  // Case 3: key exists as inline empty array — `allowed_authors: []` or `allowed_authors: [ ]`
  const filledInlineEmpty = content.replace(
    /( {2}allowed_authors:\s*\[\s*\]\s*\n)/,
    `  allowed_authors:\n    - ${login}  # auto-detected from gh auth\n`,
  )
  if (filledInlineEmpty !== content) {
    writeFileSync(configPath, filledInlineEmpty)
    return true
  }

  // Case 4: routing: section exists but allowed_authors is absent — append after routing:
  const appended = content.replace(
    /(routing:\s*\n)/,
    `$1  allowed_authors:\n    - ${login}  # auto-detected from gh auth\n`,
  )
  if (appended !== content) {
    writeFileSync(configPath, appended)
    return true
  }

  // Case 5: no routing: section at all — append a new routing block
  if (!/^routing:/m.test(content)) {
    const block = `\nrouting:\n  allowed_authors:\n    - ${login}  # auto-detected from gh auth\n`
    writeFileSync(configPath, content.trimEnd() + '\n' + block)
    return true
  }

  return false
}

// Writes routing.author_routes: { [login]: 'claude' } to an existing config file
// using text-based patching to preserve comments and formatting.
// No-op if author_routes already has entries (never overwrites user-set routes).
export function patchAuthorRoutes(configPath: string, login: string): boolean {
  const content = readFileSync(configPath, 'utf8')

  // Use yaml.load only to check current state — text patching does the write.
  const raw = (yaml.load(content) ?? {}) as Record<string, unknown>
  const routing = typeof raw.routing === 'object' && raw.routing !== null
    ? raw.routing as Record<string, unknown>
    : {}
  const current = typeof routing.author_routes === 'object' && routing.author_routes !== null
    ? routing.author_routes as Record<string, unknown>
    : {}
  if (Object.keys(current).length > 0) return false

  const entry = `  author_routes:\n    ${login}: claude  # auto-detected from gh auth\n`

  // Case 1: commented-out placeholder block from the example config
  const uncommented = content.replace(
    /  # author_routes:\n(  #[^\n]*\n)*/,
    entry,
  )
  if (uncommented !== content) { writeFileSync(configPath, uncommented); return true }

  // Case 2: inline empty map — `author_routes: {}` or `author_routes: { }`
  const filledInline = content.replace(/( {2}author_routes:\s*\{\s*\}\s*\n)/, entry)
  if (filledInline !== content) { writeFileSync(configPath, filledInline); return true }

  // Case 3: key exists but map is empty (no entries, only optional comment lines)
  const filledEmpty = content.replace(/(  author_routes:\s*\n)((?:  #[^\n]*\n)*)/, entry)
  if (filledEmpty !== content) { writeFileSync(configPath, filledEmpty); return true }

  // Case 4: routing: section exists but author_routes is absent — insert after routing:
  const appended = content.replace(/(routing:\s*\n)/, `$1${entry}`)
  if (appended !== content) { writeFileSync(configPath, appended); return true }

  // Case 5: no routing: section at all — append a new block
  if (!/^routing:/m.test(content)) {
    writeFileSync(configPath, content.trimEnd() + `\nrouting:\n${entry}`)
    return true
  }

  return false
}

// ── Deployment mode ──────────────────────────────────────────────────────────

export async function promptDeploymentMode(
  current?: 'personal' | 'team',
): Promise<'personal' | 'team'> {
  if (!process.stdin.isTTY) return 'personal'

  return new Promise<'personal' | 'team'>(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    console.log('\nHow are you using crosscheck?\n')
    console.log('  [1] personal  — monitor all your repos and orgs; review only PRs you author')
    console.log('  [2] team      — monitor org repos only; review all PRs from any author')
    if (current) console.log(`\n  Current: ${current}`)
    console.log()
    rl.question('  Choice [1]: ', (answer) => {
      rl.close()
      resolve(answer.trim() === '2' ? 'team' : 'personal')
    })
  })
}

export async function detectScopesForDeployment(
  deployment: 'personal' | 'team',
  token: string,
): Promise<{ login: string; users: string[]; orgs: string[] }> {
  const login = detectGitHubLogin() ?? ''
  const orgs = await listUserOrgs(token)
  return {
    login,
    users: deployment === 'personal' && login ? [login] : [],
    orgs,
  }
}

// Writes deployment, orgs, users, and allowed_authors to the config file.
// If force=false, skips silently when deployment is already set.
// Uses yaml.load/dump so all non-deployment values (quality, budget, etc.) are preserved.
export function patchDeploymentConfig(
  configPath: string,
  deployment: 'personal' | 'team',
  login: string,
  orgs: string[],
  force = false,
): boolean {
  if (!existsSync(configPath)) {
    const obj: Record<string, unknown> = { deployment, orgs }
    if (deployment === 'personal' && login) {
      obj.users = [login]
      obj.routing = { allowed_authors: [login], author_routes: { [login]: 'claude' } }
    }
    writeFileSync(configPath, yaml.dump(obj, { lineWidth: -1, noRefs: true }))
    return true
  }

  const raw = (yaml.load(readFileSync(configPath, 'utf8')) ?? {}) as Record<string, unknown>
  if (raw.deployment && !force) return false

  raw.deployment = deployment

  // Update orgs unless user has already set non-example values
  const EXAMPLE_ORGS = new Set(['motivation-labs', 'codatta'])
  const currentOrgs = Array.isArray(raw.orgs) ? (raw.orgs as string[]) : []
  const hasCustomOrgs = currentOrgs.length > 0 && currentOrgs.some(o => !EXAMPLE_ORGS.has(o))
  if (force || !hasCustomOrgs) raw.orgs = orgs

  // Update users
  const currentUsers = Array.isArray(raw.users) ? (raw.users as string[]) : []
  if (deployment === 'personal' && login && (force || currentUsers.length === 0)) {
    raw.users = [login]
  } else if (deployment === 'team' && force) {
    delete raw.users
  }

  // Update routing.allowed_authors and author_routes
  if (!raw.routing || typeof raw.routing !== 'object') raw.routing = {}
  const routing = raw.routing as Record<string, unknown>
  const currentAuthors = Array.isArray(routing.allowed_authors) ? (routing.allowed_authors as string[]) : []
  if (deployment === 'personal' && login && (force || currentAuthors.length === 0)) {
    routing.allowed_authors = [login]
  } else if (deployment === 'team' && force) {
    routing.allowed_authors = []
  }

  // author_routes: in personal mode, map the owner's login → 'claude' as a fallback
  // when no attribution footer or commit trailer is present on their PRs.
  const currentRoutes = typeof routing.author_routes === 'object' && routing.author_routes !== null
    ? routing.author_routes as Record<string, string>
    : {}
  if (deployment === 'personal' && login && (force || Object.keys(currentRoutes).length === 0)) {
    routing.author_routes = { [login]: 'claude' }
  } else if (deployment === 'team' && force) {
    delete routing.author_routes
  }

  writeFileSync(configPath, yaml.dump(raw, { lineWidth: -1, noRefs: true }))
  return true
}
