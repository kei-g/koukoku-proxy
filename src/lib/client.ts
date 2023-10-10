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
  readonly #parser = new KoukokuParser()
  readonly #queue = [] as Chat[]
  readonly #sent = [] as Chat[]
  readonly #socket: TLSSocket
  readonly #timeouts = new Set<NodeJS.Timeout>()

  #catch(error: Error): void {
    process.stdout.write(`[telnet] ${error.message}\n`)
  }

  #connected(): void {
    process.stdout.write(`[telnet] connected to ${this.#socket.remoteAddress}\n`)
    this.#socket.write('nobody\r\n')
    this.#timeouts.add(setInterval(() => this.#socket.write('ping\r\n'), 15000))
  }

  #dequeue(): void {
    const item = this.#queue.shift()
    if (item) {
      const timestamp = new Date(item.timestamp).toLocaleString('ja')
      process.stdout.cork()
      process.stdout.write(`[client] \x1b[32m${item.message}\x1b[m is dequeued\n`)
      process.stdout.write(`[client] this item has been enqueued at ${timestamp}\n`)
      process.stdout.uncork()
      if (item.isSpeech) {
        this.#socket.write(item.message + '\r\n')
        item.resolve({ result: true })
      }
      else {
        this.#sent.push(item)
        this.#socket.write(item.message + '\r\n')
      }
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
      () => {
        this.#timeouts.delete(timeout)
        this.#dequeue()
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

  #reconnect(hadError: boolean): void {
    process.stdout.write(`[telnet] disconnected with${['out', ''][+hadError]} error\n`)
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

  constructor(host: string = 'koukoku.shadan.open.ad.jp', port: number = 992) {
    this.#parser.on('self', this.#unbind.bind(this))
    const opts = { host, port, rejectUnauthorized: true, servername: host }
    this.#socket = connectSecure(opts, this.#connected.bind(this))
    this.#socket.on('close', this.#reconnect.bind(this))
    this.#socket.on('data', this.#read.bind(this))
    this.#socket.on('error', this.#catch.bind(this))
    this.#socket.setKeepAlive(true, 15000)
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
