import { Action } from '../types'
import { IncomingMessage, Server, ServerResponse, createServer } from 'http'
import { KoukokuClient } from '.'

export class KoukokuProxy implements AsyncDisposable {
  readonly #client = new KoukokuClient()
  readonly #web: Server

  async #handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    dumpRequest(request, process.stdout)
    if (request.headers.authorization?.startsWith('TOKEN'))
      await this.#handleRequestWithToken(request, response)
    else if (request.url?.startsWith('/health')) {
      response.setHeader('Content-Type', 'text/plain')
      response.statusCode = 200
      response.write('\n')
    }
    else if (request.url === '/ping') {
      const headers = createMapFromRawHeaders(request)
      response.setHeader('Content-Type', 'application/json')
      response.statusCode = 200
      response.write(JSON.stringify({ pong: headers.get('X-Request-Start') }))
    }
    else
      response.statusCode = 204
    response.end()
  }

  async #handleRequestWithToken(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.headers.authorization?.split(' ').slice(1).join(' ') === process.env.TOKEN) {
      const data = await readRequestAsync(request)
      const text = data.toString()
      process.stdout.write(`[proxy] ${text}\n`)
      const { CI, PERMIT_SEND } = process.env
      const result = CI && PERMIT_SEND?.toLowerCase() !== 'yes' ? { result: true } : await this.#client.sendAsync(text)
      response.setHeader('Content-Type', 'application/json')
      response.statusCode = 200
      response.write(JSON.stringify(result))
    }
    else {
      response.setHeader('Content-Type', 'text/plain')
      response.statusCode = 504
      response.write('Bad token')
    }
  }

  constructor(port: number) {
    this.#web = createServer()
    this.#web.on('request', this.#handleRequest.bind(this))
    this.#web.listen(port)
  }

  async [Symbol.asyncDispose](): Promise<void> {
    const task = this.#client[Symbol.asyncDispose]()
    this.#web.close()
    await task
  }
}

const createMapFromRawHeaders = (request: IncomingMessage): Map<string, string> => {
  const map = new Map<string, string>()
  for (const pair of tuple(request.rawHeaders))
    map.set(pair[0], pair[1])
  return map
}

const dumpRequest = (request: IncomingMessage, to: NodeJS.WriteStream) => {
  if (!request.url?.startsWith('/health') && request.url !== '/ping') {
    to.cork()
    to.write(`[http] ${request.method} ${request.url} HTTP/${request.httpVersion} from ${request.socket.remoteAddress}\n`)
    for (const pair of tuple(request.rawHeaders))
      to.write(`| ${pair[0]}: ${pair[1]}\n`)
    to.uncork()
  }
}

const readRequestAsync = (request: IncomingMessage) => new Promise(
  (resolve: Action<Buffer>) => {
    const list = [] as Buffer[]
    request.on('data', (data: Buffer) => list.push(data))
    request.on('end', () => resolve(Buffer.concat(list)))
  }
)

function* tuple<T>(list: T[]): Iterable<[T, T]> {
  for (let i = 0; i < list.length; i += 2)
    yield [list[i], list[i + 1]]
}
