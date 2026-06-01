import type { Octokit } from 'octokit'

const CONTEXT = 'crosscheck/review'
// Lock is stale when the process hasn't heartbeated within this window.
// Shorter = faster self-heal after a crash; must exceed HEARTBEAT_INTERVAL_MS
// by enough margin to survive a slow GitHub API round-trip.
const STALE_MS = 5 * 60 * 1000
// Heartbeat keeps the pending status fresh so long-running reviews don't look
// abandoned. Must be well under STALE_MS so a live review never goes stale.
const HEARTBEAT_INTERVAL_MS = 2 * 60 * 1000

export async function checkRemoteLock(
  octokit: Octokit,
  owner: string,
  repo: string,
  sha: string,
): Promise<boolean> {
  try {
    const { data } = await octokit.rest.repos.getCombinedStatusForRef({ owner, repo, ref: sha })
    const status = data.statuses
      .filter(s => s.context === CONTEXT)
      .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())[0]
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
