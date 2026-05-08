export function isAuthorAllowed(allowedAuthors: string[], author: string): boolean {
  return allowedAuthors.length === 0 || allowedAuthors.includes(author)
}
