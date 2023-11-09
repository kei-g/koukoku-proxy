import { Action } from '../types/index.js'
import { AsyncWriter, KoukokuClient, PromiseList } from './index.js'
import { IncomingMessage, Server, ServerResponse, createServer } from 'http'

export class KoukokuProxy implements AsyncDisposable {
  readonly #client: KoukokuClient
  readonly #commit: string | undefined
  readonly #web: Server

  async #handlePostRequest(request: IncomingMessage, response: ServerResponse, writer: AsyncWriter): Promise<void> {
    const { CI, PERMIT_SEND } = process.env
    const list = [] as Buffer[]
    request.on('data', list.push.bind(list))
    const data = await new Promise(request.on.bind(request, 'end')).then(Buffer.concat.bind(this, list) as Action<void, Buffer>)
    const text = data.toString()
    writer.write(`[proxy] ${text}\n`)
    const result = CI && PERMIT_SEND?.toLowerCase() !== 'yes' ? { commit: this.#commit, result: true } : await this.#client.send(text) as Record<string, unknown>
    response.statusCode = 200
    writer.write('[proxy] response: {\n')
    for (const key in result) {
      const value = result[key]
      writer.write(`  ${key}: ${value}\n`)
    }
    writer.write('}\n')
    writer.write(JSON.stringify(result), response)
  }

  #handleRequest(request: IncomingMessage, response: ServerResponse, writer: AsyncWriter): void {
    const { url } = request
    if (url?.startsWith('/health')) {
      response.setHeader('Content-Type', 'text/plain')
      response.statusCode = 200
      writer.write('\n', response)
    }
    else if (url === '/ping') {
      const headers = createMapFromRawHeaders(request)
      response.setHeader('Content-Type', 'application/json')
      response.statusCode = 200
      const time = Number(headers.get('X-Request-Start'))
      writer.write(JSON.stringify({ pong: { commit: this.#commit, time } }), response)
    }
    else
      response.statusCode = 204
  }

  async #handleRequestWithToken(request: IncomingMessage, response: ServerResponse, writer: AsyncWriter): Promise<void> {
    const { TOKEN } = process.env
    response.setHeader('Content-Type', 'application/json')
    const { headers, method } = request
    if (headers.authorization?.split(' ').slice(1).join(' ') === TOKEN) {
      if (method === 'POST')
        await this.#handlePostRequest(request, response, writer)
      else {
        response.statusCode = 405
        writer.write(JSON.stringify({ commit: this.#commit, message: 'Method not allowed', method }), response)
      }
    }
    else {
      response.statusCode = 403
      writer.write(JSON.stringify({ commit: this.#commit, message: 'Forbidden' }), response)
    }
  }

  async #request(request: IncomingMessage, response: ServerResponse): Promise<void> {
    {
      await using writer = new AsyncWriter()
      dumpRequest(request, writer)
      request.headers.authorization?.startsWith('TOKEN')
        ? await this.#handleRequestWithToken(request, response, writer)
        : this.#handleRequest(request, response, writer)
    }
    await new Promise(response.end.bind(response))
  }

  constructor(port: number) {
    const commit = process.env.RENDER_GIT_COMMIT?.slice(0, 7)
    this.#client = new KoukokuClient(commit)
    this.#commit = commit
    this.#web = createServer()
    this.#web.on('request', this.#request.bind(this))
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
