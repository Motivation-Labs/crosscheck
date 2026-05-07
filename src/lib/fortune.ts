const QUOTES = [
  'Code review is the only conversation where "looks good to me" can mean anything.',
  'The AI that wrote the code and the AI that reviews it walk into a bar. The bartender says: "No humans?"',
  'Shipping is a feature. Blocking is also a feature.',
  'A bug found in review costs 10x less than one found in production. An AI found it for free.',
  'The best PR is the one that ships — the second best is the one that never existed.',
  'Two AIs review each other\'s code. Neither has feelings to hurt.',
  'Cross-vendor review: because a second opinion is worth more when it has no idea what the first opinion was.',
  'Every diff is a short story. crosscheck reads them so you don\'t have to.',
  'Automated review doesn\'t get tired. It doesn\'t get bored. It does get wrong sometimes.',
  'The diff doesn\'t lie. The author might.',
  'Running code locally before pushing: underrated. Running crosscheck before merging: also underrated.',
  'Code review is empathy at compile time.',
  'A BLOCK today saves a rollback tomorrow.',
  'If it works on your machine, ship your machine. If crosscheck approves, ship the code.',
  'The reviewer who never ships ships nothing. The reviewer who never blocks ships bugs.',
  'Claude reviews Codex. Codex reviews Claude. Nobody\'s feelings are hurt.',
  'Not all review comments are created equal. BLOCK means block.',
  'The fastest review is the one that finds nothing. The most useful one finds the thing you missed.',
  'Code review is not a gate. It\'s a conversation. crosscheck just starts it.',
  'Your next outage is already in a PR. crosscheck is reading it.',
]

export function randomFortune(): string {
  return QUOTES[Math.floor(Math.random() * QUOTES.length)]
}
