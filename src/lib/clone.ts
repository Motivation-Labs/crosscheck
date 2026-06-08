import { execFileSync } from 'child_process'
import type { Config } from '../config/schema.js'

// Bypass `gh repo clone` so gh's keyring auth (which may bridge to VS Code's
// GitHub extension) is never invoked. HTTPS embeds the token in the URL.
function buildCloneUrl(owner: string, repo: string, token: string, protocol: Config['clone_protocol']): string {
  return protocol === 'https'
    ? `https://x-access-token:${token}@github.com/${owner}/${repo}.git`
    : `git@github.com:${owner}/${repo}.git`
}

export function redactCloneSecrets(value: string): string {
  return value.replace(/https:\/\/x-access-token:[^@\s]+@github\.com\//g, 'https://x-access-token:[REDACTED]@github.com/')
}

function runGit(args: string[], cwd?: string): void {
  try {
    execFileSync('git', args, { cwd, stdio: 'pipe' })
  } catch (err) {
    if (!(err instanceof Error)) throw err
    const redacted = redactCloneSecrets(err.message)
    const wrapped = new Error(redacted)
    wrapped.stack = err.stack ? redactCloneSecrets(err.stack) : undefined
    throw wrapped
  }
}

// Clone the repo, fetch & checkout the PR head, and fetch the base ref into
// refs/remotes/origin/<base>. onBaseFetchFailed lets callers log a warning;
// other failures bubble up.
export function clonePRForReview(params: {
  owner: string
  repo: string
  prNumber: number
  baseRef: string
  tmpDir: string
  token: string
  protocol: Config['clone_protocol']
  onBaseFetchFailed?: () => void
}): void {
  const { owner, repo, prNumber, baseRef, tmpDir, token, protocol, onBaseFetchFailed } = params
  const cloneUrl = buildCloneUrl(owner, repo, token, protocol)
  runGit(['clone', '--depth=50', '--quiet', cloneUrl, tmpDir])
  runGit(['fetch', 'origin', `pull/${prNumber}/head:pr-${prNumber}`], tmpDir)
  runGit(['checkout', `pr-${prNumber}`], tmpDir)
  // Fetch base after PR checkout so we are never on the base branch during the fetch
  // (git refuses to update a checked-out ref). Explicit refs/remotes/origin/<base>
  // target so the remote-tracking ref is always created — `git fetch origin <branch>`
  // alone only writes FETCH_HEAD in shallow clones when the branch is absent from
  // the default refspec mapping.
  try {
    runGit(['fetch', 'origin', `${baseRef}:refs/remotes/origin/${baseRef}`], tmpDir)
  } catch {
    onBaseFetchFailed?.()
  }
}
