import chalk from 'chalk'

export type Verdict = 'APPROVE' | 'NEEDS WORK' | 'BLOCK'

// Primary: strict line match.
// Handles: heading prefix (## VERDICT:), bold label (**VERDICT:**), bold value (VERDICT: **APPROVE**),
// NEEDS_WORK / NEEDS  WORK spelling variants, trailing period.
const PRIMARY_RE = /^(?:#{1,6}\s*)?(?:\*{1,2})?VERDICT:(?:\*{1,2})?\s*(?:\*{1,2})?(APPROVE|NEEDS[\s_]+WORK|BLOCK)(?:\*{1,2})?\.?\s*$/im
// Fallback: VERDICT: token anywhere in the text (inline prose, blockquote, bold value)
const FALLBACK_RE = /VERDICT:\s*(?:\*{1,2})?(APPROVE|NEEDS[\s_]+WORK|BLOCK)(?:\*{1,2})?/gi

function normalizeVerdict(raw: string): Verdict {
  return raw.toUpperCase().replace(/[\s_]+/, ' ').trim() as Verdict
}

export function parseVerdict(text: string): { verdict: Verdict | null; clean: string } {
  // Primary: look for a clean VERDICT: line (last match wins in case of duplicates)
  const primaryMatches = [...text.matchAll(new RegExp(PRIMARY_RE.source, 'gim'))]
  if (primaryMatches.length > 0) {
    const last = primaryMatches[primaryMatches.length - 1]
    const verdict = normalizeVerdict(last[1])
    const clean = text.replace(new RegExp(PRIMARY_RE.source, 'gim'), '').replace(/\n{3,}/g, '\n\n').trim()
    return { verdict, clean }
  }

  // Fallback: VERDICT: anywhere — last occurrence wins
  const fallbackMatches = [...text.matchAll(FALLBACK_RE)]
  if (fallbackMatches.length > 0) {
    const last = fallbackMatches[fallbackMatches.length - 1]
    const verdict = normalizeVerdict(last[1])
    const idx = last.index ?? 0
    const rawClean = text.slice(0, idx) + text.slice(idx + last[0].length)
    return { verdict, clean: rawClean.replace(/\n{3,}/g, '\n\n').trim() }
  }

  return { verdict: null, clean: text }
}

export const NULL_VERDICT_WARNING =
  '> ⚠️ crosscheck could not extract a verdict from this review.'

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
