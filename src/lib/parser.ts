import { Action, BufferWithTimestamp } from '../types'
import { AsyncWriter } from '.'
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
  readonly #messages = [] as BufferWithTimestamp[]
  readonly #speeches = [] as BufferWithTimestamp[]

  #countByteLength(text: string, stdout: AsyncWriter): number {
    const last = { offset: Number.NaN } as { offset: number }
    for (const matched of text.matchAll(MessageRE)) {
      dumpMatched(matched, stdout)
      this.#emitIfSelf('self', matched)
      last.offset = (matched.index ?? Number.NaN) + matched[0].length
    }
    return isNaN(last.offset) ? 0 : Buffer.from(text.slice(0, last.offset)).byteLength
  }

  #emitIfSelf(eventName: 'self', matched: RegExpMatchArray): void {
    const { groups } = matched
    if (groups) {
      const { body, self } = groups
      if (self)
        this.#emitter.emit(eventName, body)
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

  on(eventName: 'self', listener: Action<string>): this {
    this.#emitter.on(eventName, listener)
    return this
  }

  write(data: Buffer, stdout: AsyncWriter): void {
    const obj = Buffer.of(...data) as BufferWithTimestamp
    obj.timestamp = Date.now()
    const arrays = [this.#messages, this.#speeches]
    const index = +(data.byteLength < 70)
    arrays[index].push(obj)
    dumpBuffer(data, stdout)
    if (index === 0)
      this.#parse(stdout)
  }

  [Symbol.dispose](): void {
    this.#emitter.removeAllListeners()
    this.#messages.splice(0)
    this.#speeches.splice(0)
  }
}

const MessageRE = />>\s「\s(?<body>[^」]+)\s」\(チャット放話\s-\s(?<date>\d\d\/\d\d)\s\((?<dow>[日月火水木金土])\)\s(?<time>\d\d:\d\d:\d\d)\sby\s(?<host>[^\s]+)(\s\((?<forgery>※\s贋作\sDNS\s逆引の疑い)\))?\s君(\s(?<self>〈＊あなた様＊〉))?\)\s<</g

const byteToHex = (value: number): string => ('0' + value.toString(16)).slice(-2)

const dumpBuffer = (data: Buffer, to: AsyncWriter) => to.write(`[parser] ${[...data].map(byteToHex).join(' ')}\n`)

const dumpMatched = (matched: RegExpMatchArray, to: AsyncWriter): void => {
  const { groups } = matched
  const list = [] as string[]
  for (const name in groups)
    list.push(`${name}: ${groups[name]}`)
  to.write(`[parser] ${list.join(', ')}\n`)
}
