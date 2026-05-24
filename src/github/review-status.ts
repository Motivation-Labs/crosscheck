import type { Octokit } from 'octokit'

const CONTEXT = 'crosscheck/review'
const STALE_MS = 15 * 60 * 1000
// Heartbeat keeps the pending status fresh so long-running reviews (codex
// thorough + fix can exceed 20 min) are not mistaken as abandoned.
const HEARTBEAT_INTERVAL_MS = 10 * 60 * 1000

export async function checkRemoteLock(
  octokit: Octokit,
  owner: string,
  repo: string,
  sha: string,
): Promise<boolean> {
  try {
    const { data } = await octokit.rest.repos.getCombinedStatusForRef({ owner, repo, ref: sha })
    const status = data.statuses.find(s => s.context === CONTEXT)
    if (!status || status.state !== 'pending') return false
    const age = Date.now() - new Date(status.updated_at).getTime()
    return age < STALE_MS
  } catch {
    return false
  }
}

export async function acquireRemoteLock(
  octokit: Octokit,
  owner: string,
  repo: string,
  sha: string,
): Promise<void> {
  await octokit.rest.repos.createCommitStatus({
    owner, repo, sha,
    state: 'pending',
    context: CONTEXT,
    description: `Review started at ${new Date().toISOString()}`,
  })
}

// Starts a repeating interval that refreshes the pending status timestamp so
// checkRemoteLock never treats an active review as stale. Returns a stop
// function that must be called in the finally block after the review completes.
export function startRemoteLockHeartbeat(
  octokit: Octokit,
  owner: string,
  repo: string,
  sha: string,
): () => void {
  const id = setInterval(() => {
    octokit.rest.repos.createCommitStatus({
      owner, repo, sha,
      state: 'pending',
      context: CONTEXT,
      description: `Review active at ${new Date().toISOString()}`,
    }).catch(() => { /* best-effort */ })
  }, HEARTBEAT_INTERVAL_MS)
  return () => clearInterval(id)
}

export async function releaseRemoteLock(
  octokit: Octokit,
  owner: string,
  repo: string,
  sha: string,
  outcome: 'success' | 'failure',
): Promise<void> {
  try {
    await octokit.rest.repos.createCommitStatus({
      owner, repo, sha, state: outcome, context: CONTEXT,
    })
  } catch { /* best-effort */ }
}
