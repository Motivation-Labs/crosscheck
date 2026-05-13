import { execSync } from 'child_process'
import type { Config } from '../config/schema.js'

// Bypass `gh repo clone` so gh's keyring auth (which may bridge to VS Code's
// GitHub extension) is never invoked. HTTPS embeds the token in the URL.
function buildCloneUrl(owner: string, repo: string, token: string, protocol: Config['clone_protocol']): string {
  return protocol === 'https'
    ? `https://x-access-token:${token}@github.com/${owner}/${repo}.git`
    : `git@github.com:${owner}/${repo}.git`
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
  execSync(`git clone --depth=50 --quiet ${cloneUrl} ${tmpDir}`, { stdio: 'pipe' })
  execSync(`git fetch origin pull/${prNumber}/head:pr-${prNumber}`, { cwd: tmpDir, stdio: 'pipe' })
  execSync(`git checkout pr-${prNumber}`, { cwd: tmpDir, stdio: 'pipe' })
  // Fetch base after PR checkout so we are never on the base branch during the fetch
  // (git refuses to update a checked-out ref). Explicit refs/remotes/origin/<base>
  // target so the remote-tracking ref is always created — `git fetch origin <branch>`
  // alone only writes FETCH_HEAD in shallow clones when the branch is absent from
  // the default refspec mapping.
  try {
    execSync(`git fetch origin ${baseRef}:refs/remotes/origin/${baseRef}`, { cwd: tmpDir, stdio: 'pipe' })
  } catch {
    onBaseFetchFailed?.()
  }
}
