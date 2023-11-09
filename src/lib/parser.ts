import { Action, BufferWithTimestamp, Item } from '../types/index.js'
import { AsyncWriter } from './index.js'
import { EventEmitter } from 'events'

type FindTailContext = FindTailResult & {
  offset: number
}

type FindTailResult = {
  count: number
  pos?: number
}

export class KoukokuParser implements Disposable {
  readonly #emitter = new EventEmitter()
  readonly #idleTimeout = new WeakMap<this, NodeJS.Timeout>()
  readonly #messages = [] as BufferWithTimestamp[]
  readonly #speeches = [] as BufferWithTimestamp[]

  #countByteLength(text: string, stdout: AsyncWriter): number {
    const last = { offset: Number.NaN } as { offset: number }
    for (const matched of text.matchAll(MessageRE)) {
      dumpMatched(matched, stdout)
      const { groups, index } = matched
      const { byteLength } = Buffer.from(text.slice(0, index))
      const data = findByByteOffset(this.#messages, byteLength)
      const { body, date, dow, forgery, host, self, time } = groups as unknown as Item
      this.#dispatch('message', { body, date, dow, forgery, host, self, time, timestamp: data?.timestamp })
      this.#emitIfSelf('self', matched)
      last.offset = (index ?? Number.NaN) + matched[0].length
    }
    return isNaN(last.offset) ? 0 : Buffer.from(text.slice(0, last.offset)).byteLength
  }

  #dispatch(eventName: string, ...args: unknown[]): void {
    queueMicrotask(this.#emitter.emit.bind(this.#emitter, eventName, ...args))
  }

  #emitIfSelf(eventName: 'self', matched: RegExpMatchArray): void {
    const { groups } = matched
    if (groups) {
      const { body, self } = groups
      if (self)
        this.#dispatch(eventName, body)
    }
  }

  #findTail(ctx: FindTailContext, byteLength: number): void {
    for (const data of this.#messages) {
      const next = ctx.offset + data.byteLength
      if (byteLength < next) {
        const pos = byteLength - ctx.offset
        const index = data.subarray(pos).indexOf('>> 「 ')
        ctx.pos = index < 0 ? pos : index
        break
      }
      ctx.count++
      ctx.offset = next
    }
  }

  async #idle(): Promise<void> {
    const concatenated = Buffer.concat(this.#speeches)
    const text = concatenated.toString()
    const last = { offset: Number.NaN } as { offset: number }
    await using stdout = new AsyncWriter()
    for (const matched of text.matchAll(SpeechRE)) {
      dumpMatched(matched, stdout)
      const { groups, index } = matched
      const { byteLength } = Buffer.from(text.slice(0, index as number))
      const data = findByByteOffset(this.#speeches, byteLength)
      const { body, date, dow, host, time } = groups as unknown as Item
      this.#dispatch('speech', { body, date, dow, host, time, timestamp: data?.timestamp })
      last.offset = (index as number) + matched[0].length
    }
    if (!Number.isNaN(last.offset)) {
      const speeches = this.#speeches.splice(0)
      const { byteLength } = Buffer.from(text.slice(0, last.offset))
      const data = concatenated.subarray(byteLength) as BufferWithTimestamp
      data.timestamp = speeches[0].timestamp
      this.#speeches.push(data)
    }
  }

  #parse(stdout: AsyncWriter): void {
    const text = Buffer.concat(this.#messages).toString().replaceAll(/\r?\n/g, '')
    stdout.write(`[parser] '${text.replaceAll('\x1b', '\\x1b')}'\n`)
    const byteLength = this.#countByteLength(text, stdout)
    const ctx = { count: 0, offset: 0 } as FindTailContext
    this.#findTail(ctx, byteLength)
    if (ctx.count)
      this.#messages.splice(ctx.count)
    if (this.#messages.length && ctx.pos) {
      const head = this.#messages[0].subarray(ctx.pos) as BufferWithTimestamp
      head.timestamp = this.#messages[0].timestamp
      this.#messages[0] = head
    }
  }

  on(eventName: 'message' | 'speech', listener: Action<Item>): this
  on(eventName: 'self', listener: Action<string>): this
  on(eventName: 'message' | 'self' | 'speech', listener: Action<Item> | Action<string>): this {
    this.#emitter.on(eventName, listener)
    return this
  }

  write(data: Buffer, stdout: AsyncWriter, timestamp: number): void {
    const index = +(data.byteLength < 70)
    if (index === 0)
      data = Buffer.from(data.toString().replaceAll(/\r?\n/g, ''))
    const obj = Buffer.of(...data) as BufferWithTimestamp
    obj.timestamp = timestamp
    clearTimeout(this.#idleTimeout.get(this))
    const arrays = [this.#messages, this.#speeches]
    arrays[index].push(obj)
    dumpBuffer(data, stdout)
    if (index === 0)
      this.#parse(stdout)
    this.#idleTimeout.set(this, setTimeout(this.#idle.bind(this), 125))
  }

  [Symbol.dispose](): void {
    clearTimeout(this.#idleTimeout.get(this))
    this.#emitter.removeAllListeners()
    this.#messages.splice(0)
    this.#speeches.splice(0)
  }
}

const MessageRE = />>\s「\s(?<body>[^」]+)\s」\(チャット放話\s-\s(?<date>\d\d\/\d\d)\s\((?<dow>[日月火水木金土])\)\s(?<time>\d\d:\d\d:\d\d)\sby\s(?<host>[^\s]+)(\s\((?<forgery>※\s贋作\sDNS\s逆引の疑い)\))?\s君(\s(?<self>〈＊あなた様＊〉))?\)\s<</g

const SpeechRE = /\s+(★☆){2}\s臨時ニユース\s緊急放送\s(☆★){2}\s(?<date>\p{scx=Han}+\s\d+\s年\s\d+\s月\s\d+\s日)\s(?<dow>[日月火水木金土])曜\s(?<time>\d{2}:\d{2})\s+★\sたった今、(?<host>[^\s]+)\s君より[\S\s]+★\s+＝{3}\s大演説の開闢\s＝{3}(\r\n){2}(?<body>[\S\s]+(?=(\r\n){2}))\s+＝{3}\s大演説の終焉\s＝{3}\s+/gu

const byteToHex = (value: number): string => ('0' + value.toString(16)).slice(-2)

const dumpBuffer = (data: Buffer, to: AsyncWriter) => to.write(`[parser] ${[...data].map(byteToHex).join(' ')}\n`)

const dumpMatched = (matched: RegExpMatchArray, to: AsyncWriter): void => {
  const { groups } = matched
  const list = [] as string[]
  for (const name in groups)
    list.push(`${name}: ${groups[name]}`)
  to.write(`[parser] ${list.join(', ')}\n`)
}

const findByByteOffset = (array: BufferWithTimestamp[], offset: number) => {
  const ctx = { position: 0 }
  return array.find(
    (value: BufferWithTimestamp) => {
      const { position } = ctx
      ctx.position += value.byteLength
      return position <= offset && offset < ctx.position
    }
  )
}
