import { Action } from '../types'
import { AsyncWriter, KoukokuClient, PromiseList } from '.'
import { IncomingMessage, Server, ServerResponse, createServer } from 'http'

export class KoukokuProxy implements AsyncDisposable {
  readonly #client = new KoukokuClient()
  readonly #web: Server

  async #handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    {
      await using writer = new AsyncWriter()
      dumpRequest(request, writer)
      if (request.headers.authorization?.startsWith('TOKEN'))
        this.#handleRequestWithToken(request, response, writer)
      else if (request.url?.startsWith('/health')) {
        response.setHeader('Content-Type', 'text/plain')
        response.statusCode = 200
        writer.write('\n', response)
      }
      else if (request.url === '/ping') {
        const headers = createMapFromRawHeaders(request)
        response.setHeader('Content-Type', 'application/json')
        response.statusCode = 200
        writer.write(JSON.stringify({ pong: headers.get('X-Request-Start') }), response)
      }
      else
        response.statusCode = 204
    }
    await new Promise(response.end.bind(response))
  }

  async #handleRequestWithToken(request: IncomingMessage, response: ServerResponse, writer: AsyncWriter): Promise<void> {
    response.setHeader('Content-Type', 'application/json')
    if (request.headers.authorization?.split(' ').slice(1).join(' ') === process.env.TOKEN) {
      const list = [] as Buffer[]
      request.on('data', list.push.bind(list))
      const data = await new Promise(request.on.bind(request, 'end')).then(Buffer.concat.bind(this, list) as Action<void, Buffer>)
      const text = data.toString()
      writer.write(`[proxy] ${text}\n`)
      const { CI, PERMIT_SEND } = process.env
      const result = CI && PERMIT_SEND?.toLowerCase() !== 'yes' ? { result: true } : await this.#client.send(text)
      response.statusCode = 200
      writer.write(JSON.stringify(result), response)
    }
    else {
      response.statusCode = 403
      writer.write(JSON.stringify({ message: 'Forbidden' }), response)
    }
  }

  constructor(port: number) {
    this.#web = createServer()
    this.#web.on('request', this.#handleRequest.bind(this))
    this.#web.listen(port)
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await using list = new PromiseList()
    list.push(this.#client[Symbol.asyncDispose]())
    list.push(new Promise(this.#web.close.bind(this.#web)))
  }
}

const createMapFromRawHeaders = (request: IncomingMessage): Map<string, string> => {
  const map = new Map<string, string>()
  for (const pair of tuple(request.rawHeaders))
    map.set(pair[0], pair[1])
  return map
}

const dumpRequest = (request: IncomingMessage, to: AsyncWriter): void => {
  const { httpVersion, method, rawHeaders, socket, url } = request
  if (!url?.startsWith('/health') && url !== '/ping') {
    to.write(`[http] ${method} ${url} HTTP/${httpVersion} from ${socket.remoteAddress}\n`)
    for (const pair of tuple(rawHeaders))
      to.write(`| ${pair[0]}: ${pair[1]}\n`)
  }
}

function* tuple<T>(list: T[]): Iterable<[T, T]> {
  for (let i = 0; i < list.length; i += 2)
    yield [list[i], list[i + 1]]
}
