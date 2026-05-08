import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import type { Config } from '../config/schema.js'
import { verifyWebhookSignature } from './client.js'

export interface PREvent {
  action: string
  number: number
  pull_request: {
    title: string
    body: string
    head: { ref: string; sha: string }
    base: { ref: string }
    html_url: string
    user: { login: string }
  }
  repository: {
    name: string
    owner: { login: string }
    clone_url: string
  }
}

export interface WebhookFileLogEntry {
  level: 'info' | 'warn' | 'error'
  event: string
  [key: string]: unknown
}

export function createWebhookServer(
  config: Config,
  webhookSecret: string,
  onPR: (event: PREvent) => void,
  onLog: (msg: string) => void,
  onFileLog?: (entry: WebhookFileLogEntry) => void,
) {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const { pathname } = new URL(req.url ?? '/', `http://localhost`)

    if (pathname !== config.server.webhook_path) {
      res.writeHead(404).end()
      return
    }

    if (req.method !== 'POST') {
      res.writeHead(405).end()
      return
    }

    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const rawBody = Buffer.concat(chunks).toString('utf8')

    const signature = req.headers['x-hub-signature-256'] as string ?? ''
    if (!verifyWebhookSignature(rawBody, signature, webhookSecret)) {
      onLog('⚠  Rejected request with invalid webhook signature')
      onFileLog?.({ level: 'warn', event: 'webhook_sig_invalid', ip: req.socket.remoteAddress })
      res.writeHead(401).end()
      return
    }

    const event = req.headers['x-github-event'] as string
    if (event !== 'pull_request') {
      res.writeHead(200).end('ok')
      return
    }

    let body: PREvent
    try {
      body = JSON.parse(rawBody) as PREvent
    } catch {
      onFileLog?.({ level: 'error', event: 'webhook_parse_error', ip: req.socket.remoteAddress })
      res.writeHead(400).end()
      return
    }

    if (body.action === 'opened' || body.action === 'synchronize') {
      res.writeHead(200).end('ok')
      // async — don't block the webhook response
      setImmediate(() => onPR(body))
    } else {
      res.writeHead(200).end('ok')
    }
  })

  return server
}
