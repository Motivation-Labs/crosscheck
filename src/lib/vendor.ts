export type Vendor = 'claude' | 'codex'

const CLAUDE_ALIASES = new Set(['claude', 'claude-code', 'claudecode', 'cc', 'anthropic'])
const CODEX_ALIASES = new Set(['codex', 'openai'])

export function normalizeVendor(value: string | undefined): Vendor | null {
  if (!value) return null
  const normalized = value.toLowerCase().replace(/[_\s]/g, '-')
  if (CLAUDE_ALIASES.has(normalized)) return 'claude'
  if (CODEX_ALIASES.has(normalized)) return 'codex'
  return null
}

export const VENDOR_ALIAS_HINT = 'claude (aliases: claude-code, cc, anthropic) | codex (aliases: openai)'
