import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const CROSSCHECK_DIR = join(homedir(), '.crosscheck')
const USER_INSTRUCTIONS_PATH = join(CROSSCHECK_DIR, 'instructions.md')

// Shipped default — conservative constraints that apply to almost every repo.
// `crosscheck optimize` will refine this over time based on observed failures.
const DEFAULT_INSTRUCTIONS = `\
## Constraints

- Do not run tsc, ts-node, or tsx.
- Do not run npm, npx, yarn, or pnpm.
- Do not run jest, vitest, mocha, or other test runners.
- Do not run any build, compile, or install commands.
- Base your review solely on reading source files and the diff.

## Focus

Review for correctness, security, and maintainability. Flag issues that would cause
bugs in production, expose sensitive data, or make the code significantly harder to
maintain. Nits and style preferences should be NEEDS WORK, not BLOCK.

## Verdict format

On the very last line of your response, write exactly one of:

VERDICT: APPROVE
VERDICT: NEEDS WORK
VERDICT: BLOCK

Use APPROVE for no issues or trivial nits only.
Use NEEDS WORK for addressable issues that are not blocking.
Use BLOCK for security risks, data loss, broken API contracts, or correctness bugs.
`

export function readInstructions(repoDir?: string): string {
  // Project-level override takes precedence
  if (repoDir) {
    const projectLevel = join(repoDir, '.crosscheck', 'instructions.md')
    if (existsSync(projectLevel)) {
      return readFileSync(projectLevel, 'utf8').trim()
    }
  }

  if (existsSync(USER_INSTRUCTIONS_PATH)) {
    return readFileSync(USER_INSTRUCTIONS_PATH, 'utf8').trim()
  }

  // Seed default on first use so the user can inspect and edit it
  mkdirSync(CROSSCHECK_DIR, { recursive: true })
  writeFileSync(USER_INSTRUCTIONS_PATH, DEFAULT_INSTRUCTIONS, { mode: 0o644 })
  return DEFAULT_INSTRUCTIONS.trim()
}

export function writeInstructions(content: string): void {
  mkdirSync(CROSSCHECK_DIR, { recursive: true })
  writeFileSync(USER_INSTRUCTIONS_PATH, content, { mode: 0o644 })
}

export function getInstructionsPath(): string {
  return USER_INSTRUCTIONS_PATH
}

export function instructionsExist(): boolean {
  return existsSync(USER_INSTRUCTIONS_PATH)
}
