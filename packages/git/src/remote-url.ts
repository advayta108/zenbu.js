export type RemoteInfo = {
  host: string
  owner: string
  repo: string
  webUrl: string
  compareUrl: (base: string, head: string) => string
  prUrl: (base: string, head: string) => string
}

export function parseRemoteUrl(raw: string): RemoteInfo | null {
  const url = raw.trim()
  if (!url) return null

  let host = ""
  let owner = ""
  let repo = ""

  const sshMatch = url.match(/^[\w.-]+@([\w.-]+):([\w.-]+)\/([\w.-]+?)(?:\.git)?$/)
  if (sshMatch) {
    host = sshMatch[1]!
    owner = sshMatch[2]!
    repo = sshMatch[3]!
  } else {
    const httpsMatch = url.match(/^https?:\/\/([\w.-]+)\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/)
    if (!httpsMatch) return null
    host = httpsMatch[1]!
    owner = httpsMatch[2]!
    repo = httpsMatch[3]!
  }

  const webUrl = `https://${host}/${owner}/${repo}`
  return {
    host,
    owner,
    repo,
    webUrl,
    compareUrl: (base, head) =>
      `${webUrl}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
    prUrl: (base, head) =>
      `${webUrl}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?expand=1`,
  }
}
