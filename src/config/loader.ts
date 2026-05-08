import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { execSync } from 'child_process'
import { resolve, join } from 'path'
import { homedir } from 'os'
import { randomBytes } from 'crypto'
import yaml from 'js-yaml'
import { ConfigSchema, type Config } from './schema.js'

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

  // Case 1: commented-out placeholder block from the example config
  const uncommented = content.replace(
    /  # allowed_authors:\n(  #[^\n]*\n)+/,
    `  allowed_authors:\n    - ${login}  # auto-detected from gh auth\n`,
  )
  if (uncommented !== content) {
    writeFileSync(configPath, uncommented)
    return true
  }

  // Case 2: key exists but list is empty (no entries under it)
  const filledEmpty = content.replace(
    /(  allowed_authors:\s*\n)((?:  #[^\n]*\n)*)/,
    `  allowed_authors:\n    - ${login}  # auto-detected from gh auth\n`,
  )
  if (filledEmpty !== content) {
    writeFileSync(configPath, filledEmpty)
    return true
  }

  // Case 3: routing: section exists but allowed_authors is absent — append after routing:
  const appended = content.replace(
    /(routing:\s*\n)/,
    `$1  allowed_authors:\n    - ${login}  # auto-detected from gh auth\n`,
  )
  if (appended !== content) {
    writeFileSync(configPath, appended)
    return true
  }

  return false
}
