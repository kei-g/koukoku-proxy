import { Action, BufferWithTimestamp } from '../types'
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
  #messages = [] as BufferWithTimestamp[]
  #speeches = [] as BufferWithTimestamp[]

  #parse(): void {
    const text = Buffer.concat(this.#messages).toString().replaceAll(/\r?\n/g, '')
    process.stdout.write(`[parser] '${text}'\n`)
    const last = {} as { offset?: number }
    for (const matched of text.matchAll(MessageRE)) {
      dumpMatched(matched, process.stdout)
      const { groups, index } = matched
      if (groups) {
        const { msg, self } = groups
        if (self)
          this.#emitter.emit('self', msg)
        last.offset = (index ?? Number.NaN) + matched[0].length
      }
    }
    const { byteLength } = Buffer.from(text.slice(0, last.offset ?? 0))
    const ctx = { count: 0, offset: 0 } as FindTailContext
    for (const data of this.#messages) {
      const next = ctx.offset + data.byteLength
      if (byteLength < next) {
        ctx.pos = byteLength - ctx.offset
        break
      }
      ctx.count++
      ctx.offset = next
    }
    if (ctx.count)
      this.#messages = this.#messages.splice(ctx.count)
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

  write(data: Buffer): void {
    const obj = Buffer.of(...data) as BufferWithTimestamp
    obj.timestamp = Date.now()
    if (data.byteLength < 70)
      this.#speeches.push(obj)
    else
      this.#messages.push(obj)
    dumpBuffer(data, process.stdout)
    this.#parse()
  }

  [Symbol.dispose](): void {
    this.#emitter.removeAllListeners()
    this.#messages.splice(0)
    this.#speeches.splice(0)
  }
}

const MessageRE = />>\s「\s(?<msg>[^」]+)\s」\(チャット放話\s-\s(?<date>\d\d\/\d\d\s\([^)]+\))\s(?<time>\d\d:\d\d:\d\d)\sby\s(?<host>[^\s]+)\s君(\s(?<self>〈＊あなた様＊〉))?\)\s<</g

const dumpBuffer = (data: Buffer, to: NodeJS.WriteStream): void => {
  const list = [] as string[]
  for (const c of data)
    list.push(('0' + c.toString(16)).slice(-2))
  to.write(list.join(' ') + '\n')
}

const dumpMatched = (matched: RegExpMatchArray, to: NodeJS.WriteStream): void => {
  const { groups } = matched
  const list = [] as string[]
  for (const name in groups)
    list.push(`${name}: ${groups[name]}`)
  to.write(`[parser] ${list.join(', ')}\n`)
}
