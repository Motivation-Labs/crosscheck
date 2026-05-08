import { existsSync } from 'fs'
import { join } from 'path'

// File-presence indicators → language identifiers used throughout crosscheck.
// This is the canonical source of language ids. diagnose.ts imports INDICATORS
// to derive its constraint map keys, keeping both in sync automatically.
export const INDICATORS: [string, string][] = [
  ['tsconfig.json', 'typescript'],
  ['package.json', 'nodejs'],
  ['requirements.txt', 'python'],
  ['pyproject.toml', 'python'],
  ['Cargo.toml', 'rust'],
  ['go.mod', 'golang'],
  ['pom.xml', 'java'],
  ['build.gradle', 'java'],
  ['build.gradle.kts', 'java'],
  ['Gemfile', 'ruby'],
]

export function detectLanguages(repoDir: string): string[] {
  const seen = new Set<string>()
  for (const [file, lang] of INDICATORS) {
    if (existsSync(join(repoDir, file))) seen.add(lang)
  }
  return [...seen]
}
