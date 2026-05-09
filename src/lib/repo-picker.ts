import { createInterface } from 'readline'
import chalk from 'chalk'
import type { RepoActivity } from '../github/client.js'

function daysSince(d: Date): number {
  return Math.floor((Date.now() - d.getTime()) / 86400000)
}

function ageLabel(r: RepoActivity): string {
  if (r.tier === 1) {
    const d = daysSince(r.createdAt)
    return chalk.green(`new · created ${d === 0 ? 'today' : `${d}d ago`}`)
  }
  const d = daysSince(r.pushedAt)
  return chalk.dim(`active · pushed ${d === 0 ? 'today' : `${d}d ago`}`)
}

function printRepoList(
  visible: RepoActivity[],
  selected: Set<string>,
  overflowCount: number,
  showingMore: boolean,
): void {
  process.stdout.write(chalk.bold('\nWhich personal repos should crosscheck monitor?\n'))
  process.stdout.write(chalk.dim('  Numbers to toggle · m = expand list · Enter to confirm\n\n'))
  for (let i = 0; i < visible.length; i++) {
    const r = visible[i]
    const num = chalk.dim(`${i + 1}`.padStart(3))
    const box = selected.has(r.fullName) ? chalk.green('[x]') : chalk.dim('[ ]')
    const name = r.fullName.padEnd(40)
    process.stdout.write(`  ${num} ${box} ${name}${ageLabel(r)}\n`)
  }
  if (!showingMore && overflowCount > 0) {
    process.stdout.write(chalk.dim(`\n       ${'─'.repeat(54)}\n`))
    process.stdout.write(
      chalk.dim(`     m  [ ] Show more  (${overflowCount} inactive repos — or add to config.yml manually)\n`),
    )
  }
  process.stdout.write('\n')
}

// Interactive repo picker with 3-tier display:
// Tier 1 (< 7d old) shown first and pre-selected — signals active new work
// Tier 2 (pushed < 90d) shown next, sorted by recency
// Tier 3 (inactive) hidden behind "m" expansion
export async function promptRepoPicker(repos: RepoActivity[], defaults?: string[]): Promise<string[]> {
  if (repos.length === 0) return []

  const tier1 = repos.filter(r => r.tier === 1)
  const tier2 = repos.filter(r => r.tier === 2)
  const tier3 = repos.filter(r => r.tier === 3)

  const CAP = 8
  const primary: RepoActivity[] = [...tier1, ...tier2.slice(0, Math.max(0, CAP - tier1.length))]
  const overflow: RepoActivity[] = [...tier2.slice(Math.max(0, CAP - tier1.length)), ...tier3]

  if (!process.stdin.isTTY) {
    return defaults ?? [...tier1, ...tier2.slice(0, 3)].map(r => r.fullName)
  }

  // Default selection: all Tier 1 + first 3 Tier 2 (or caller-provided defaults)
  const selected = new Set<string>(
    defaults ?? [...tier1, ...tier2.slice(0, 3)].map(r => r.fullName),
  )

  let visible: RepoActivity[] = [...primary]
  let showingMore = false

  printRepoList(visible, selected, overflow.length, showingMore)

  return new Promise<string[]>(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })

    const loop = (): void => {
      const mHint = !showingMore && overflow.length > 0 ? ', m' : ''
      rl.question(chalk.dim(`  Toggle (1-${visible.length}${mHint}) or Enter to confirm: `), ans => {
        const t = ans.trim().toLowerCase()

        if (t === '') {
          rl.close()
          resolve([...selected])
          return
        }

        if (t === 'm' && !showingMore && overflow.length > 0) {
          showingMore = true
          visible = [...primary, ...overflow]
          printRepoList(visible, selected, 0, true)
          loop()
          return
        }

        let changed = false
        for (const tok of t.split(/[\s,]+/).filter(Boolean)) {
          const n = parseInt(tok, 10)
          if (n >= 1 && n <= visible.length) {
            const repo = visible[n - 1].fullName
            selected.has(repo) ? selected.delete(repo) : selected.add(repo)
            changed = true
          }
        }
        if (changed) printRepoList(visible, selected, showingMore ? 0 : overflow.length, showingMore)
        loop()
      })
    }

    loop()
  })
}

function printOrgList(orgs: string[], selected: Set<string>): void {
  process.stdout.write(chalk.bold('\nWhich orgs should crosscheck monitor?\n'))
  process.stdout.write(chalk.dim('  Numbers to toggle · Enter to confirm\n\n'))
  for (let i = 0; i < orgs.length; i++) {
    const num = chalk.dim(`${i + 1}`.padStart(3))
    const box = selected.has(orgs[i]) ? chalk.green('[x]') : chalk.dim('[ ]')
    process.stdout.write(`  ${num} ${box} ${orgs[i]}\n`)
  }
  process.stdout.write('\n')
}

// All orgs pre-selected by default; user toggles to deselect.
export async function promptOrgPicker(orgs: string[], defaults?: string[]): Promise<string[]> {
  if (orgs.length === 0) return []
  if (!process.stdin.isTTY) return defaults ?? [...orgs]

  const selected = new Set<string>(defaults ?? orgs)
  printOrgList(orgs, selected)

  return new Promise<string[]>(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })

    const loop = (): void => {
      rl.question(chalk.dim(`  Toggle (1-${orgs.length}) or Enter to confirm: `), ans => {
        const t = ans.trim()
        if (t === '') { rl.close(); resolve([...selected]); return }

        let changed = false
        for (const tok of t.split(/[\s,]+/).filter(Boolean)) {
          const n = parseInt(tok, 10)
          if (n >= 1 && n <= orgs.length) {
            const org = orgs[n - 1]
            selected.has(org) ? selected.delete(org) : selected.add(org)
            changed = true
          }
        }
        if (changed) printOrgList(orgs, selected)
        loop()
      })
    }

    loop()
  })
}
