export function isCrosscheckCommitMessage(message: string): boolean {
  return message.startsWith('[crosscheck]')
}
