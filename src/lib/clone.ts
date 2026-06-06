import { execFileSync } from 'child_process'
import { mkdirSync, rmSync } from 'fs'
import type { Config } from '../config/schema.js'

type ClonePhase = 'clone' | 'pr-fetch' | 'checkout' | 'base-fetch'

export interface GitCloneRetryEvent {
  attempt: number
  maxAttempts: number
  nextAttempt: number
  phase: ClonePhase
  reason: string
  delayMs: number
  mitigation?: string
}

interface GitCommandFailure {
  phase: ClonePhase
  message: string
}

interface CloneDeps {
  runGit: (args: string[], options?: { cwd?: string }) => void
  sleep: (ms: number) => void
}

const DEFAULT_GIT_CONFIG: Config['git'] = {
  clone_attempts: 4,
  retry_base_delay_ms: 2_000,
  https_version: 'auto',
}

// Bypass `gh repo clone` so gh's keyring auth (which may bridge to VS Code's
// GitHub extension) is never invoked. HTTPS embeds the token in the URL.
function buildCloneUrl(owner: string, repo: string, token: string, protocol: Config['clone_protocol']): string {
  return protocol === 'https'
    ? `https://x-access-token:${token}@github.com/${owner}/${repo}.git`
    : `git@github.com:${owner}/${repo}.git`
}

export function redactGitOutput(value: string): string {
  return value
    .replace(/https:\/\/x-access-token:[^@\s]+@github\.com/g, 'https://x-access-token:REDACTED@github.com')
    .replace(/gh[opsu]_[A-Za-z0-9_]+/g, 'gh_REDACTED')
}

export function isTransientGitTransportError(message: string): boolean {
  const m = message.toLowerCase()
  return /rpc failed|http\/2|http2|framing layer|stream \d+ was not closed|cancel \(err|early eof|invalid index-pack|unexpected disconnect|fetch-pack|recv failure|operation timed out|failed to connect|couldn't connect|connection reset|connection refused|connection timed out|tls|ssl|curl (?:28|35|56|92)\b/.test(m)
}

function isHttp2TransportError(message: string): boolean {
  return /http\/2|http2|framing layer|curl 92|stream \d+ was not closed/i.test(message)
}

function summarizeGitFailure(message: string): string {
  const redacted = redactGitOutput(message)
  const lines = redacted.split('\n').map(line => line.trim()).filter(Boolean)
  const interesting = lines.find(line =>
    /rpc failed|http\/2|http2|framing layer|early eof|invalid index-pack|unexpected disconnect|recv failure|operation timed out|failed to connect|couldn't connect|connection reset|connection refused|curl \d+/i.test(line)
  )
  return (interesting ?? lines[0] ?? 'git transport failure').slice(0, 240)
}

function gitFailureMessage(phase: ClonePhase, err: unknown): GitCommandFailure {
  const maybe = err as Record<string, unknown>
  const stderr = typeof maybe.stderr === 'string' ? maybe.stderr : ''
  const stdout = typeof maybe.stdout === 'string' ? maybe.stdout : ''
  const rawMessage = err instanceof Error ? err.message : String(err)
  const details = [stderr, stdout, rawMessage].filter(Boolean).join('\n').trim()
  return { phase, message: redactGitOutput(details || rawMessage) }
}

function httpVersionArgs(
  protocol: Config['clone_protocol'],
  git: Config['git'],
  forceHttp11: boolean,
): string[] {
  if (protocol !== 'https') return []
  if (git.https_version === 'HTTP/1.1' || forceHttp11) return ['-c', 'http.version=HTTP/1.1']
  if (git.https_version === 'HTTP/2') return ['-c', 'http.version=HTTP/2']
  return []
}

function retryDelayMs(git: Config['git'], attempt: number): number {
  const base = git.retry_base_delay_ms
  if (base <= 0) return 0
  return Math.min(base * 2 ** (attempt - 1), 30_000)
}

function sleepSync(ms: number): void {
  if (ms <= 0) return
  const buffer = new SharedArrayBuffer(4)
  const view = new Int32Array(buffer)
  Atomics.wait(view, 0, 0, ms)
}

function resetCloneDir(tmpDir: string): void {
  rmSync(tmpDir, { recursive: true, force: true })
  mkdirSync(tmpDir, { recursive: true })
}

function runGit(deps: CloneDeps, phase: ClonePhase, args: string[], cwd?: string): GitCommandFailure | null {
  try {
    deps.runGit(args, cwd ? { cwd } : undefined)
    return null
  } catch (err: unknown) {
    return gitFailureMessage(phase, err)
  }
}

function buildFinalCloneError(owner: string, repo: string, lastFailure: GitCommandFailure): Error {
  const summary = summarizeGitFailure(lastFailure.message)
  const guidance = isHttp2TransportError(lastFailure.message)
    ? 'Set git.https_version: HTTP/1.1 in crosscheck.config.yml or reduce kickass concurrency if the network is saturated.'
    : 'Check GitHub connectivity and consider lowering kickass concurrency or increasing git.clone_attempts.'
  return new Error(
    `Git ${lastFailure.phase} failed for ${owner}/${repo}: ${summary}\n` +
    `  ${guidance}`
  )
}

// Clone the repo, fetch & checkout the PR head, and fetch the base ref into
// refs/remotes/origin/<base>. onBaseFetchFailed lets callers log a warning;
// other failures bubble up after transient Git transport retries are exhausted.
export function clonePRForReview(params: {
  owner: string
  repo: string
  prNumber: number
  baseRef: string
  tmpDir: string
  token: string
  protocol: Config['clone_protocol']
  git?: Config['git']
  onBaseFetchFailed?: () => void
  onRetry?: (event: GitCloneRetryEvent) => void
}): void {
  clonePRForReviewWithDeps(params, {
    runGit: (args, options) => {
      execFileSync('git', args, {
        cwd: options?.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
      })
    },
    sleep: sleepSync,
  })
}

export function clonePRForReviewWithDeps(
  params: {
    owner: string
    repo: string
    prNumber: number
    baseRef: string
    tmpDir: string
    token: string
    protocol: Config['clone_protocol']
    git?: Config['git']
    onBaseFetchFailed?: () => void
    onRetry?: (event: GitCloneRetryEvent) => void
  },
  deps: CloneDeps,
): void {
  const { owner, repo, prNumber, baseRef, tmpDir, token, protocol, onBaseFetchFailed } = params
  const git = { ...DEFAULT_GIT_CONFIG, ...(params.git ?? {}) }
  const maxAttempts = git.clone_attempts
  const cloneUrl = buildCloneUrl(owner, repo, token, protocol)
  let lastFailure: GitCommandFailure | null = null
  let forceHttp11 = false

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    resetCloneDir(tmpDir)
    const prefix = httpVersionArgs(protocol, git, forceHttp11)
    const cloneFailure = runGit(deps, 'clone', [...prefix, 'clone', '--depth=50', '--quiet', cloneUrl, tmpDir])
    if (cloneFailure) {
      lastFailure = cloneFailure
    } else {
      const fetchFailure = runGit(deps, 'pr-fetch', [...prefix, 'fetch', 'origin', `pull/${prNumber}/head:pr-${prNumber}`], tmpDir)
      if (fetchFailure) {
        lastFailure = fetchFailure
      } else {
        const checkoutFailure = runGit(deps, 'checkout', ['checkout', `pr-${prNumber}`], tmpDir)
        if (checkoutFailure) {
          throw buildFinalCloneError(owner, repo, checkoutFailure)
        }

        // Fetch base after PR checkout so we are never on the base branch during the fetch
        // (git refuses to update a checked-out ref). Explicit refs/remotes/origin/<base>
        // target so the remote-tracking ref is always created — `git fetch origin <branch>`
        // alone only writes FETCH_HEAD in shallow clones when the branch is absent from
        // the default refspec mapping.
        const baseFailure = runGit(deps, 'base-fetch', [...prefix, 'fetch', 'origin', `${baseRef}:refs/remotes/origin/${baseRef}`], tmpDir)
        if (baseFailure) onBaseFetchFailed?.()
        return
      }
    }

    const transient = isTransientGitTransportError(lastFailure.message)
    if (!transient || attempt === maxAttempts) break

    let mitigation: string | undefined
    if (git.https_version === 'auto' && protocol === 'https' && isHttp2TransportError(lastFailure.message)) {
      forceHttp11 = true
      mitigation = 'forcing Git HTTPS transport to HTTP/1.1 for the next attempt'
    }

    const delayMs = retryDelayMs(git, attempt)
    params.onRetry?.({
      attempt,
      maxAttempts,
      nextAttempt: attempt + 1,
      phase: lastFailure.phase,
      reason: summarizeGitFailure(lastFailure.message),
      delayMs,
      ...(mitigation && { mitigation }),
    })
    deps.sleep(delayMs)
  }

  throw buildFinalCloneError(owner, repo, lastFailure ?? { phase: 'clone', message: 'unknown git failure' })
}
