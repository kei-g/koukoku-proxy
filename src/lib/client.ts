import { Action } from '../types'
import { AsyncWriter, KoukokuParser } from '.'
import { TLSSocket, connect as connectSecure } from 'tls'

type Chat = {
  isSpeech: boolean
  message: string
  resolve: Action<object>
  timestamp: number
}

export class KoukokuClient implements AsyncDisposable {
  readonly #commit: string | undefined
  readonly #host: string
  readonly #parser = new KoukokuParser()
  readonly #port: number
  readonly #queue = [] as Chat[]
  readonly #sent = [] as Chat[]
  readonly #socket = new WeakMap<this, TLSSocket>()
  readonly #timeouts = new Set<NodeJS.Timeout>()

  async #catch(error: Error): Promise<void> {
    await using stdout = new AsyncWriter()
    stdout.write(`[telnet] ${error.message}\n`)
  }

  #connect(): void {
    const opts = {
      host: this.#host,
      port: this.#port,
      rejectUnauthorized: true
    }
    const socket = connectSecure(opts, this.#connected.bind(this))
    socket.on('close', this.#disconnected.bind(this))
    socket.on('data', this.#read.bind(this))
    socket.on('error', this.#catch.bind(this))
    socket.setNoDelay(true)
    socket.setKeepAlive(true, 15000)
    this.#socket.set(this, socket)
  }

  async #connected(): Promise<void> {
    const socket = this.#socket.get(this)
    await using writer = new AsyncWriter()
    writer.write(`[telnet] connected to ${socket?.remoteAddress}\n`)
    writer.write('nobody\r\n', socket)
    this.#timeouts.add(setInterval(() => this.#socket.get(this)?.write('ping\r\n'), 15000))
  }

  async #disconnected(hadError: boolean): Promise<void> {
    await using stdout = new AsyncWriter()
    stdout.write(`[telnet] disconnected with${['out', ''][+hadError]} error\n`)
    const socket = this.#socket.get(this)
    socket?.removeAllListeners()
    this.#connect()
  }

  async #dequeue(): Promise<void> {
    const item = this.#queue.shift()
    await using stdout = new AsyncWriter()
    if (item) {
      const timestamp = new Date(item.timestamp).toLocaleString('ja', { day: '2-digit', hour: '2-digit', minute: '2-digit', month: '2-digit', second: '2-digit', year: 'numeric' })
      stdout.write(`[client] \x1b[32m${item.message}\x1b[m is dequeued\n[client] this item has been enqueued at ${timestamp}\n`)
      const result = await this.#write(item.message)
      const template = [
        this.#queue.unshift.bind(this.#queue, item),
        this.#sent.push.bind(this.#sent, item),
        item.resolve.bind(globalThis, { error: result.toString(), result: false }),
        item.resolve.bind(globalThis, { result }),
      ]
      const index = +item.isSpeech * 2 + +(result === true)
      template[index]()
      if (this.#queue.length)
        this.#dequeueLater()
    }
    else {
      stdout.write(`[client] there are ${this.#queue.length} items in queue\n[client] there is ${this.#sent.length} item in waiting response\n`)
      this.#dequeueLater(3000)
    }
  }

  #dequeueLater(milliseconds: number = 992): void {
    const timeout = setTimeout(
      async () => {
        this.#timeouts.delete(timeout)
        await this.#dequeue()
      },
      milliseconds
    )
    this.#timeouts.add(timeout)
  }

  async #read(data: Buffer): Promise<void> {
    await using stdout = new AsyncWriter()
    if (70 <= data.byteLength) {
      const socket = this.#socket.get(this)
      stdout.write(`[telnet] ${data.byteLength} bytes received from ${socket?.remoteAddress}\n`)
    }
    this.#parser.write(data, stdout)
  }

  async #unbind(text: string): Promise<void> {
    await using stdout = new AsyncWriter()
    stdout.write(`[client] unbind("\x1b[32m${text}\x1b[m")\n`)
    const trimmed = text.replaceAll(/\s+/g, '')
    const index = this.#sent.findIndex(
      (chat: Chat) => chat.message.replaceAll(/\s+/g, '') === trimmed
    )
    stdout.write(`[client] unbinding "\x1b[32m${trimmed}\x1b[m", found at index of ${index}\n`)
    if (0 <= index) {
      const rhs = this.#sent.splice(index)
      const items = rhs.splice(0)
      if (rhs.length)
        this.#sent.push(...rhs)
      for (const item of items) {
        const obj = {
          isSpeech: item.isSpeech,
          message: item.message,
          timestamp: new Date(item.timestamp).toLocaleString('ja', { day: '2-digit', hour: '2-digit', minute: '2-digit', month: '2-digit', second: '2-digit', year: 'numeric' }),
        }
        stdout.write(`[client] resolve(${JSON.stringify(obj)})\n`)
        item.resolve({ commit: this.#commit, result: true })
      }
    }
  }

  async #write(text: string): Promise<Error | true> {
    const socket = this.#socket.get(this)
    const maybeError = await new Promise(
      (resolve: Action<Error | null | undefined>) => socket?.write(`${text}\r\n`, resolve) ?? resolve(undefined)
    )
    return maybeError instanceof Error ? maybeError : true
  }

  constructor(commit: string | undefined, host: string = 'koukoku.shadan.open.ad.jp', port: number = 992) {
    this.#commit = commit
    this.#host = host
    this.#parser.on('self', this.#unbind.bind(this))
    this.#port = port
    this.#connect()
  }

  on(_eventName: 'message' | 'speech', _listener: unknown): this {
    return this
  }

  send(text: string): Promise<object> {
    return new Promise(
      (resolve: Action<object>) => {
        const item = {
          isSpeech: /^https?:\/\/[.-/\w]+$/.test(text),
          message: text,
          resolve,
          timestamp: Date.now(),
        } as Chat
        this.#queue.push(item)
        process.stdout.write(`[client] \x1b[32m${text}\x1b[m is enqueued\n`)
        this.#dequeueLater(0)
      }
    )
  }

  async [Symbol.asyncDispose](): Promise<void> {
    const socket = this.#socket.get(this)
    this.#socket.delete(this)
    socket?.removeAllListeners()
    await using _socket = new AsyncWriter(socket, true)
    this.#parser[Symbol.dispose]()
    const notifyShutdown = (item: Chat) => item.resolve({ error: { message: 'server shutdown' } })
    this.#queue.splice(0).forEach(notifyShutdown)
    this.#sent.splice(0).forEach(notifyShutdown)
    this.#timeouts.forEach((timeout: NodeJS.Timeout) => clearTimeout(timeout))
  }
}
