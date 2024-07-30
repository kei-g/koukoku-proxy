import { Action, ItemWithId } from '../types/index.js'
import { AsyncWriter, KoukokuClient, PromiseList, fnv1 } from './index.js'
import { IncomingMessage, Server, ServerResponse, createServer } from 'http'
import { WebSocket, WebSocketServer } from 'ws'
import { createHash } from 'crypto'
import { join as joinPath } from 'path'
import { readFile, readdir } from 'fs/promises'

interface Asset {
  data: Buffer
  etag: string
  expiresAt?: Date
  mimeType: string
}

export class KoukokuProxy implements AsyncDisposable {
  readonly #assets = new Map<string, Asset>()
  readonly #client: KoukokuClient
  readonly #commit: string | undefined
  readonly #mimeTypes = new Map<string, string>()
  readonly #web: Server
  readonly #webClients = new Set<WebSocket>()
  readonly #webSocket: WebSocketServer

  async #connected(client: WebSocket, request: IncomingMessage): Promise<void> {
    await using stdout = new AsyncWriter()
    stdout.write('[ws] connected\n\x1b[34m')
    dumpRequest(request, stdout)
    stdout.write('\x1b[m----\n')
    client.on('close', this.#disconnected.bind(this, client))
    this.#webClients.add(client)
    queueMicrotask(
      async () => client.send(
        Buffer.from(JSON.stringify(await this.#client.query()))
      )
    )
  }

  async #disconnected(client: WebSocket, code: number, reason: Buffer): Promise<void> {
    await using stdout = new AsyncWriter()
    stdout.write(`[ws] disconnected, { code: \x1b[33m${code}\x1b[m, reason: '\x1b[32m${reason.toString()}\x1b[m' }\n`)
    this.#webClients.delete(client)
  }

  async #dispatch(item: ItemWithId): Promise<void> {
    const data = Buffer.from(JSON.stringify([item]))
    await using list = new PromiseList()
    for (const client of this.#webClients)
      list.push(new Promise((resolve: Action<Error | undefined>) => client.send(data, resolve)))
  }

  async #handleAuthorizedRequest(request: IncomingMessage, response: ServerResponse, writer: AsyncWriter): Promise<void> {
    const handlers = new Map(
      [
        [undefined, undefined],
        ['POST', this.#handlePostRequest],
        ['PUT', this.#handlePutRequest],
      ]
    )
    const { method } = request
    const handler = handlers.get(method)?.bind(this)
    if (handler)
      await handler(request, response, writer)
    else {
      response.statusCode = 405
      writer.write(JSON.stringify({ commit: this.#commit, message: 'Method not allowed', method }), response)
    }
  }

  async #handleChat(request: IncomingMessage, response: ServerResponse, writer: AsyncWriter): Promise<void> {
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

  #handleHealth(_request: IncomingMessage, response: ServerResponse, writer: AsyncWriter): void {
    response.setHeader('Content-Type', 'text/plain')
    response.statusCode = 200
    writer.write('\n', response)
  }

  #handleHistogram(_request: IncomingMessage, response: ServerResponse, writer: AsyncWriter): void {
    response.setHeader('content-type', 'image/svg+xml')
    response.statusCode = 200
    writer.push(this.#client.writeHistogramTo(response))
  }

  #handlePing(request: IncomingMessage, response: ServerResponse, writer: AsyncWriter): void {
    const headers = createMapFromRawHeaders(request)
    response.setHeader('Content-Type', 'application/json')
    response.statusCode = 200
    const time = Number(headers.get('X-Request-Start'))
    writer.write(JSON.stringify({ pong: { commit: this.#commit, time } }), response)
  }

  async #handlePostRequest(request: IncomingMessage, response: ServerResponse, writer: AsyncWriter): Promise<void> {
    const { url } = request
    const handlers = {
      '/say': this.#handleChat,
      '/speech': this.#handleSpeech,
    }
    await handlers[url as keyof typeof handlers]?.bind(this)?.(request, response, writer)
  }

  async #handlePutRequest(_request: IncomingMessage, _response: ServerResponse, _writer: AsyncWriter): Promise<void> {
  }

  async #handleSpeech(request: IncomingMessage, response: ServerResponse, writer: AsyncWriter): Promise<void> {
    const list = [] as Buffer[]
    request.on('data', list.push.bind(list))
    const requestData = await new Promise(request.on.bind(request, 'end')).then(Buffer.concat.bind(this, list) as Action<void, Buffer>)
    const { content, maxLength, remark } = JSON.parse(requestData.toString()) as { content: string, maxLength: number, remark: boolean }
    const data = Buffer.from(content)
    const now = new Date()
    const salt = Buffer.from(now.toISOString(), 'ascii')
    const sha256 = createHash('sha256')
    sha256.update(salt)
    sha256.update(data)
    const hash = sha256.digest().toString('hex').slice(0, maxLength)
    const { byteLength } = data
    const { checksum, etag } = computeETag(data)
    const expiresAt = new Date(Date.now() + 3e6)
    const asset = {
      data,
      etag,
      expiresAt,
      mimeType: 'text/plain',
    }
    const name = `/speeches/${hash}.txt`
    const e = expiresAt.toLocaleString('ja')
    writer.write(`[\x1b[32m${name}\x1b[m] \x1b[33m${byteLength}\x1b[m, ${etag}, expiresAt ${e}\n`)
    this.#assets.set(name, asset)
    const hostname = process.env.RENDER_EXTERNAL_HOSTNAME as string
    const url = `https://${hostname}${name}`
    const result = remark ? await this.#client.send(url) : { status: 'accepted' }
    writer.write(
      JSON.stringify(
        {
          checksum,
          byteLength,
          etag,
          expiresAt: e,
          name,
          result,
          url,
        }
      ),
      response
    )
    setTimeout(this.#assets.delete.bind(this.#assets, name), expiresAt.getTime() - Date.now())
  }

  #handleStatus(_request: IncomingMessage, response: ServerResponse, writer: AsyncWriter): void {
    const report = process.report?.getReport() as Record<string, unknown> | undefined
    delete report?.environmentVariables
    delete report?.javascriptStack
    delete report?.libuv
    delete report?.nativeStack
    delete report?.sharedObjects
    delete report?.workers
    const status = {
      constrainedMemory: process.constrainedMemory(),
      memoryUsage: process.memoryUsage(),
      report,
      resource: process.resourceUsage(),
    }
    response.setHeader('content-type', 'application/json')
    response.statusCode = 200
    writer.write(JSON.stringify(status, undefined, 2), response)
  }

  #handleRequest(request: IncomingMessage, response: ServerResponse, writer: AsyncWriter): void {
    const { method, url } = request
    const handlers = new Map(
      [
        [undefined, undefined],
        ['/health', this.#handleHealth],
        ['/histogram.svg', this.#handleHistogram],
        ['/ping', this.#handlePing],
        ['/say', this.#handleUnauthorized],
        ['/speech', this.#handleUnauthorized],
        ['/status', this.#handleStatus],
      ]
    )
    const handler = handlers.get(url)?.bind(this)
    if (handler)
      handler(request, response, writer)
    else if (['GET', 'HEAD'].includes(method as string))
      this.#handleRequestForAsset(request.headers['if-none-match'], method, response, url, writer)
    else
      response.statusCode = 405
  }

  #handleRequestForAsset(ifNoneMatch: string | undefined, method: string | undefined, response: ServerResponse, url: string | undefined, writer: AsyncWriter): void {
    const asset = this.#assets.get(url as string)
    if (asset) {
      const { data, etag, expiresAt, mimeType } = asset
      const { byteLength } = data
      const oneIfNotModified = +(etag == ifNoneMatch)
      const statusCode = [200, 304][oneIfNotModified]
      writer.write(`${method} \x1b[32m${url} \x1b[33m${statusCode}\x1b[m\n`)
      writer.write(`| Content-length: \x1b[33m${byteLength}\x1b[m\n`)
      response.setHeader('Content-length', byteLength)
      setHeaderIfPresent(response, 'Content-type', mimeType, writer)
      writer.write(`| ETag: \x1b[32m'${etag}'\x1b[m\n`)
      response.setHeader('ETag', etag)
      const utc = expiresAt?.toUTCString()
      setHeaderIfPresent(response, 'Expires', utc, writer)
      response.statusCode = statusCode
      const oneIfContentNecessary = oneIfNotModified * 2 + +(method === 'GET')
      if (oneIfContentNecessary === 1)
        writer.write(data, response)
    }
    else {
      writer.write(`\x1b[31m${method} ${url} 404\x1b[m\n`)
      response.statusCode = 404
    }
  }

  async #handleRequestWithToken(request: IncomingMessage, response: ServerResponse, writer: AsyncWriter): Promise<void> {
    const { TOKEN } = process.env
    response.setHeader('Content-Type', 'application/json')
    if (request.headers.authorization?.split(' ').slice(1).join(' ') === TOKEN)
      await this.#handleAuthorizedRequest(request, response, writer)
    else {
      response.statusCode = 403
      writer.write(JSON.stringify({ commit: this.#commit, message: 'Forbidden' }), response)
    }
  }

  #handleUnauthorized(_request: IncomingMessage, response: ServerResponse, writer: AsyncWriter): void {
    response.setHeader('content-type', 'application/json')
    response.statusCode = 403
    writer.write(JSON.stringify({ commit: this.#commit, message: 'Forbidden' }), response)
  }

  async #loadAssets(): Promise<void> {
    const hostname = process.env.RENDER_EXTERNAL_HOSTNAME as string
    const dir = 'assets'
    await using stdout = new AsyncWriter()
    stdout.write('loading assets...\n')
    for (const entry of await readdir(dir, { recursive: true, withFileTypes: true }))
      if (entry.isFile()) {
        const { name } = entry
        const path = joinPath(dir, name)
        const source = await readFile(path)
        const ext = name.split('.').at(-1)
        const mimeType = this.#mimeTypes.get(ext as string)
        const data = isText(mimeType)
          ? Buffer.from(source.toString().replaceAll(/\$\{host\}/g, hostname))
          : source
        const { byteLength } = data
        const { checksum, etag } = computeETag(data)
        const asset = { data, etag, mimeType } as Asset
        stdout.write(`${name}: { \x1b[32m'${mimeType}'\x1b[m, \x1b[33m${byteLength}\x1b[m, \x1b[3m${checksum.toString(16)}\x1b[m, \x1b[32m'${etag}'\x1b[m }\n`)
        this.#assets.set(`/${name}`, asset)
      }
    stdout.write('----\n')
    const main = this.#assets.get('/main.html')
    this.#assets.set('/', main as Asset)
  }

  async #loadMimeTypes(): Promise<void> {
    const data = await readFile('conf/mime-types.json')
    const mimeTypes = JSON.parse(data.toString()) as Record<string, string>
    await using stdout = new AsyncWriter()
    stdout.write('mimeTypes: {\n')
    for (const name in mimeTypes) {
      const value = mimeTypes[name]
      stdout.write(`  ${name}: \x1b[32m'${value}'\x1b[m\n`)
      this.#mimeTypes.set(name, value)
    }
    stdout.write('}\n')
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
    const client = new KoukokuClient(commit)
    client.on('message', this.#dispatch.bind(this))
    client.on('speech', this.#dispatch.bind(this))
    this.#client = client
    this.#commit = commit
    const server = createServer()
    this.#web = server
    server.on('request', this.#request.bind(this))
    server.listen(port)
    const socket = new WebSocketServer({ server })
    socket.on('connection', this.#connected.bind(this))
    this.#webSocket = socket
  }

  async start(): Promise<void> {
    await this.#loadMimeTypes()
    await this.#loadAssets()
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await using list = new PromiseList()
    list.push(this.#client[Symbol.asyncDispose]())
    list.push(new Promise(this.#webSocket.close.bind(this.#webSocket)))
    list.push(new Promise(this.#web.close.bind(this.#web)))
  }
}

const computeETag = (data: Buffer) => {
  const { byteLength } = data
  const checksum = fnv1[32](data)
  const temp = Buffer.alloc(6)
  temp.writeUInt32BE(checksum, 0)
  temp.writeUInt16BE(byteLength & 65535, 4)
  const etag = temp.toString('base64url')
  return {
    checksum,
    etag,
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

const isText = (mimeType: string | undefined) => mimeType?.endsWith('json') || mimeType?.startsWith('text/')

const setHeaderIfPresent = (response: ServerResponse, name: string, value: string | undefined, writer: AsyncWriter) => {
  if (value) {
    writer.write(`| ${name}: \x1b[32m'${value}'\x1b[m\n`)
    response.setHeader(name, value)
  }
}

function* tuple<T>(list: T[]): Iterable<[T, T]> {
  for (let i = 0; i < list.length; i += 2)
    yield [list[i], list[i + 1]]
}
