import { createInterface } from 'readline/promises'
import { stdin as input, stdout as output } from 'process'
import chalk from 'chalk'
import type { PRStatus } from './pr-status.js'

export async function pickPRs(prs: PRStatus[]): Promise<PRStatus[]> {
  if (prs.length === 0) return []
  if (!process.stdin.isTTY) {
    throw new Error('kickass requires an interactive terminal to select PRs. Use --dry-run to inspect the queue.')
  }

  console.log()
  prs.forEach((pr, index) => {
    const next = pr.nextAction ? `next=${pr.nextAction}` : 'terminal'
    console.log(`  [${index + 1}] #${pr.number} ${pr.owner}/${pr.repo} ${chalk.yellow(pr.reviewState)} ${chalk.dim(next)}  ${pr.title}`)
  })
  console.log()

  const rl = createInterface({ input, output })
  try {
    const answer = await rl.question('Select PRs to advance (comma list, "all", or blank to cancel): ')
    return parseSelection(answer, prs)
  } finally {
    rl.close()
  }
}

export function parseSelection(answer: string, prs: PRStatus[]): PRStatus[] {
  const trimmed = answer.trim().toLowerCase()
  if (!trimmed) return []
  if (trimmed === 'all' || trimmed === 'a') return prs

  const selectedIndexes = new Set<number>()
  for (const part of trimmed.split(',')) {
    const value = Number(part.trim())
    if (!Number.isInteger(value) || value < 1 || value > prs.length) {
      throw new Error(`Invalid selection "${part.trim()}". Choose numbers from 1 to ${prs.length}, or "all".`)
    }
    selectedIndexes.add(value - 1)
  }

  return [...selectedIndexes].sort((a, b) => a - b).map(index => prs[index])
}
