import chalk from 'chalk'

export type Verdict = 'APPROVE' | 'NEEDS WORK' | 'BLOCK'

const VERDICT_RE = /^VERDICT:\s*(APPROVE|NEEDS WORK|BLOCK)\s*$/im

export function parseVerdict(text: string): { verdict: Verdict | null; clean: string } {
  const match = text.match(VERDICT_RE)
  if (!match) return { verdict: null, clean: text }
  const verdict = match[1].toUpperCase() as Verdict
  const clean = text.replace(VERDICT_RE, '').replace(/\n{3,}/g, '\n\n').trim()
  return { verdict, clean }
}

export function formatVerdict(verdict: Verdict | null): string {
  if (!verdict) return chalk.dim('verdict  —')
  if (verdict === 'APPROVE')    return `verdict  ${chalk.green('✅ APPROVE')}`
  if (verdict === 'NEEDS WORK') return `verdict  ${chalk.yellow('⚠  NEEDS WORK')}`
  if (verdict === 'BLOCK')      return `verdict  ${chalk.red('🚫 BLOCK')}`
  return chalk.dim('verdict  —')
}

// Prepend a bold verdict badge to the review comment posted to GitHub
export function prependVerdictToComment(text: string, verdict: Verdict | null): string {
  if (!verdict) return text
  const badge =
    verdict === 'APPROVE'    ? '✅ **APPROVE**' :
    verdict === 'NEEDS WORK' ? '⚠️ **NEEDS WORK**' :
                               '🚫 **BLOCK**'
  return `${badge}\n\n${text}`
}
