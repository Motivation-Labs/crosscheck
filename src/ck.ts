#!/usr/bin/env node
// Forces argv[1] to 'ck' before cli.ts reads it for program.name().
// This guarantees the correct name on platforms where npm uses command shims
// instead of symlinks (e.g. Windows), where argv[1] would be 'cli.js'.
process.argv[1] = 'ck'
await import('./cli.js')
