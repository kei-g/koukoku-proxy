import { Action } from '../types'
import { KoukokuParser } from '.'
import { TLSSocket, connect as connectSecure } from 'tls'

type Chat = {
  isSpeech: boolean
  message: string
  resolve: Action<object>
  timestamp: number
}

export class KoukokuClient implements AsyncDisposable {
  readonly #host: string
  readonly #parser = new KoukokuParser()
  readonly #port: number
  readonly #queue = [] as Chat[]
  readonly #sent = [] as Chat[]
  #socket: TLSSocket
  readonly #timeouts = new Set<NodeJS.Timeout>()

  #catch(error: Error): void {
    process.stdout.write(`[telnet] ${error.message}\n`)
  }

  #connect(): TLSSocket {
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
    return socket
  }

  #connected(): void {
    process.stdout.write(`[telnet] connected to ${this.#socket.remoteAddress}\n`)
    this.#socket.write('nobody\r\n')
    this.#timeouts.add(setInterval(() => this.#socket.write('ping\r\n'), 15000))
  }

  #disconnected(hadError: boolean): void {
    process.stdout.write(`[telnet] disconnected with${['out', ''][+hadError]} error\n`)
    this.#socket.removeAllListeners()
    this.#socket = this.#connect()
  }

  async #dequeueAsync(): Promise<void> {
    const item = this.#queue.shift()
    if (item) {
      const timestamp = new Date(item.timestamp).toLocaleString('ja')
      process.stdout.cork()
      process.stdout.write(`[client] \x1b[32m${item.message}\x1b[m is dequeued\n`)
      process.stdout.write(`[client] this item has been enqueued at ${timestamp}\n`)
      process.stdout.uncork()
      const result = await this.#writeAsync(item.message)
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
      process.stdout.cork()
      process.stdout.write(`[client] there are ${this.#queue.length} items in queue\n`)
      process.stdout.write(`[client] there is ${this.#sent.length} item in waiting response\n`)
      process.stdout.uncork()
      this.#dequeueLater(3000)
    }
  }

  #dequeueLater(milliseconds: number = 992): void {
    const timeout = setTimeout(
      async () => {
        this.#timeouts.delete(timeout)
        await this.#dequeueAsync()
      },
      milliseconds
    )
    this.#timeouts.add(timeout)
  }

  #read(data: Buffer): void {
    if (70 <= data.byteLength) {
      process.stdout.write(`[telnet] ${data.byteLength} bytes received from ${this.#socket.remoteAddress}\n`)
      process.stdout.write(data)
      this.#parser.write(data)
    }
  }

  #unbind(text: string): void {
    process.stdout.write(`[client] unbind("\x1b[32m${text}\x1b[m")\n`)
    const trimmed = text.replaceAll(/\s+/g, '')
    const index = this.#sent.findIndex(
      (chat: Chat) => chat.message.replaceAll(/\s+/g, '') === trimmed
    )
    process.stdout.write(`[client] unbinding "\x1b[32m${trimmed}\x1b[m", found at index of ${index}\n`)
    if (0 <= index) {
      const rhs = this.#sent.splice(index)
      const items = rhs.splice(0)
      if (rhs.length)
        this.#sent.push(...rhs)
      for (const item of items) {
        const obj = {
          isSpeech: item.isSpeech,
          message: item.message,
          timestamp: new Date(item.timestamp).toLocaleString('ja'),
        }
        process.stdout.write(`[client] resolve(${JSON.stringify(obj)})\n`)
        item.resolve({ result: true })
      }
    }
  }

  #writeAsync(text: string): Promise<Error | true> {
    return new Promise(
      (resolve: Action<Error | true>) => this.#socket.write(
        text + '\r\n',
        (error?: Error) => resolve(error ?? true)
      )
    )
  }

  constructor(host: string = 'koukoku.shadan.open.ad.jp', port: number = 992) {
    this.#host = host
    this.#parser.on('self', this.#unbind.bind(this))
    this.#port = port
    this.#socket = this.#connect()
  }

  sendAsync(text: string): Promise<object> {
    return new Promise(
      (resolve: Action<object>) => {
        const item = {
          isSpeech: /^https?:\/\/[.-/\w]+$/.test(text),
          message: text,
          resolve,
          timestamp: Date.now(),
        } as Chat
        this.#queue.push(item)
        process.stdout.write(`[client] ${text} is enqueued\n`)
        this.#dequeueLater(0)
      }
    )
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.#socket.removeAllListeners()
    const task = new Promise(
      (resolve: Action<void>) => this.#socket.end(resolve)
    )
    this.#parser[Symbol.dispose]()
    const notifyShutdown = (item: Chat) => item.resolve({ error: { message: 'server shutdown' } })
    this.#queue.splice(0).forEach(notifyShutdown)
    this.#sent.splice(0).forEach(notifyShutdown)
    this.#timeouts.forEach((timeout: NodeJS.Timeout) => clearTimeout(timeout))
    await task
  }
}
