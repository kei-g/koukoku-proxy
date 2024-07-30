import { Action, BufferWithTimestamp, Item, ItemWithId } from '../types/index.js'
import { AsyncWriter } from './index.js'
import { EventEmitter } from 'events'
import { RedisClientType, RedisFunctions, RedisModules, RedisScripts, createClient } from '@redis/client'
import { Writable } from 'stream'
import { createHash } from 'crypto'

interface FindTailContext extends FindTailResult {
  offset: number
}

interface FindTailResult {
  count: number
  pos?: number
}

export class KoukokuParser implements Disposable {
  readonly #emitter = new EventEmitter()
  readonly #idleTimeout = new WeakMap<this, NodeJS.Timeout>()
  readonly #logKey: string
  readonly #messages = [] as BufferWithTimestamp[]
  readonly #speeches = [] as BufferWithTimestamp[]
  readonly #timestampKey: string
  readonly #url: string

  // eslint-disable-next-line complexity
  async #countByteLength(text: string, stdout: AsyncWriter): Promise<number> {
    const timestamp = Date.now()
    const onDemand = {} as { db: RedisClientType<RedisModules, RedisFunctions, RedisScripts> }
    const last = { offset: Number.NaN } as { offset: number }
    for (const matched of text.matchAll(MessageRE)) {
      dumpMatched(matched, stdout)
      const { groups, index } = matched
      const { byteLength } = Buffer.from(text.slice(0, index))
      const data = findByByteOffset(this.#messages, byteLength)
      const { body, date, dow, forgery, host, self, time } = groups as unknown as Item
      const item = { body, date, dow, forgery, host, self, time } as Item
      deleteUndefinedFields(item)
      onDemand.db ??= await createClient({ url: this.#url }).connect()
      const id = await onDemand.db.xAdd(this.#logKey, '*', item as unknown as Record<string, string>)
      await onDemand.db.zAdd(this.#timestampKey, { score: timestamp, value: id })
      item.timestamp = data?.timestamp as number
      this.#dispatch('message', { id, item })
      this.#emitIfSelf('self', matched)
      last.offset = (index ?? Number.NaN) + matched[0].length
    }
    await onDemand.db?.disconnect()
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

  async #idle(timestamp: number): Promise<void> {
    const onDemand = {} as { db: RedisClientType<RedisModules, RedisFunctions, RedisScripts> }
    const concatenated = Buffer.concat(this.#speeches)
    const text = concatenated.toString()
    const last = { offset: Number.NaN } as { offset: number }
    await using stdout = new AsyncWriter()
    for (const matched of text.matchAll(SpeechRE)) {
      dumpMatched(matched, stdout)
      const { groups, index } = matched
      const { byteLength } = Buffer.from(text.slice(0, index as number))
      const data = findByByteOffset(this.#speeches, byteLength)
      const score = data?.timestamp as number
      const { body, date, dow, host, time } = groups as unknown as Item
      const item = { body, date, dow, host, time } as Item & { hash: string }
      deleteUndefinedFields(item)
      item.finished = `${timestamp}`
      const sha256 = createHash('sha256')
      sha256.update(matched[0])
      item.hash = sha256.digest().toString('hex')
      onDemand.db ??= await createClient({ url: this.#url }).connect()
      const id = await onDemand.db.xAdd(this.#logKey, '*', item as unknown as Record<string, string>)
      await onDemand.db.zAdd(this.#timestampKey, { score, value: id })
      item.timestamp = score
      this.#dispatch('speech', { id, item })
      last.offset = (index as number) + matched[0].length
    }
    await onDemand.db?.disconnect()
    if (!Number.isNaN(last.offset)) {
      const speeches = this.#speeches.splice(0)
      const { byteLength } = Buffer.from(text.slice(0, last.offset))
      const data = concatenated.subarray(byteLength) as BufferWithTimestamp
      data.timestamp = speeches[0].timestamp
      this.#speeches.push(data)
    }
  }

  async #parse(stdout: AsyncWriter): Promise<void> {
    const text = Buffer.concat(this.#messages).toString().replaceAll(/\r?\n/g, '')
    stdout.write(`[parser] '${text.replaceAll('\x1b', '\\x1b')}'\n`)
    const byteLength = await this.#countByteLength(text, stdout)
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

  constructor() {
    const { REDIS_LOG_KEY, REDIS_TIMESTAMP_KEY, REDIS_URL } = process.env
    this.#logKey = REDIS_LOG_KEY ?? 'koukoku:log'
    this.#timestampKey = REDIS_TIMESTAMP_KEY ?? 'koukoku:timestamp'
    this.#url = REDIS_URL as string
  }

  on(eventName: 'message' | 'speech', listener: Action<ItemWithId>): this
  on(eventName: 'self', listener: Action<string>): this
  on(eventName: 'message' | 'self' | 'speech', listener: Action<ItemWithId> | Action<string>): this {
    this.#emitter.on(eventName, listener)
    return this
  }

  async query(): Promise<ItemWithId[]> {
    const db = createClient({ url: this.#url })
    await db.connect()
    const z = await db.zRangeWithScores(this.#timestampKey, -100, -1)
    z.sort(ascendingByKey('value'))
    const start = z.at(0)?.value
    const end = z.at(-1)?.value
    const items = await db.xRange(this.#logKey, start ?? '-', end ?? '+')
    await db.disconnect()
    const map = new Map(z.map(item => [item.value, item.score]))
    return items.map(
      element => {
        const { id, message } = element
        const item = message as unknown as Item
        item.timestamp = map.get(id) ?? Number.NaN
        return { id, item }
      }
    )
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
    this.#idleTimeout.set(this, setTimeout(this.#idle.bind(this, timestamp), 125))
  }

  async writeHistogramTo(destination: Writable): Promise<void> {
    const db = createClient({ url: this.#url })
    await db.connect()
    const items = await db.xRange(this.#logKey, '-', '+')
    await db.disconnect()
    const analyzed = items.map(analyze)
    const sorted = analyzed.sort(ascendingByKey('at'))
    const first = sorted.at(0) as { at: number }
    const last = sorted.at(-1) as { at: number }
    const range = (last.at - first.at) / 36e5
    const map = new Map<number, { all: number, bot: number, chat: number, speech: number, time: number }>()
    const max = { value: 0 }
    for (const item of sorted) {
      const { at: k } = item
      const q = Math.trunc((k - first.at) / 36e5)
      const v = map.get(q) ?? { all: 0, bot: 0, chat: 0, speech: 0, time: 0 }
      v.all++
      visit(item, v, 'bot', 'chat', 'speech', 'time')
      map.set(q, v)
      max.value = Math.max(v.all, max.value)
    }
    destination.write('<svg height="768" viewBox="0 0 8192 768" width="8192" xmlns="http://www.w3.org/2000/svg">')
    destination.write('<g fill="black" font-family="monospace" font-size="22" stroke-width="0">')
    destination.write(`<text x="7800" y="24">Since: ${formatDate(first.at)}</text>`)
    destination.write(`<text x="7800" y="48">Until: ${formatDate(last.at)}</text>`)
    destination.write('<text x="7800" y="72">Period: 1 hour</text>')
    destination.write('<text x="7800" y="96">Bot</text>')
    destination.write('<text x="7800" y="120">Speech</text>')
    destination.write('</g>')
    destination.write('<line fill="red" stroke="red" x1="7900" y1="88" x2="8168" y2="88" />')
    destination.write('<line fill="blue" stroke="blue" x1="7900" y1="112" x2="8168" y2="112" />')
    polyline(map, max.value, range, selectAll, 'black', destination)
    polyline(map, max.value, range, selectBot, 'red', destination)
    polyline(map, max.value, range, selectSpeech, 'blue', destination)
    destination.write('</svg>')
  }

  [Symbol.dispose](): void {
    clearTimeout(this.#idleTimeout.get(this))
    this.#emitter.removeAllListeners()
    this.#messages.splice(0)
    this.#speeches.splice(0)
  }
}

const MessageRE = />>\s「\s(?<body>[^」]+(?=\s」))\s」\(チャット放話\s-\s(?<date>\d\d\/\d\d)\s\((?<dow>[日月火水木金土])\)\s(?<time>\d\d:\d\d:\d\d)\sby\s(?<host>[^\s]+)(\s\((?<forgery>※\s贋作\sDNS\s逆引の疑い)\))?\s君(\s(?<self>〈＊あなた様＊〉))?\)\s<</g

const SpeechRE = /\s+(★☆){2}\s臨時ニユース\s緊急放送\s(☆★){2}\s(?<date>\p{scx=Han}+\s\d+\s年\s\d+\s月\s\d+\s日)\s(?<dow>[日月火水木金土])曜\s(?<time>\d{2}:\d{2})\s+★\sたった今、(?<host>[^\s]+)\s君より[\S\s]+★\s+＝{3}\s大演説の開闢\s＝{3}(\r\n){2}(?<body>[\S\s]+(?=(\r\n){2}))\s+＝{3}\s大演説の終焉\s＝{3}\s+/gu

const analyze = (item: { id: string, message: Record<string, string> }) => {
  const { id, message } = item
  const chat = 'log' in message
  return {
    at: Math.trunc(parseInt(id.split('-')[0])),
    bot: (chat && /^>> 「 \[Bot/.test(message.log)) || message.body?.startsWith('[Bot'),
    chat,
    speech: 'hash' in message,
    time: chat && /^>> 「 \[時報\] /.test(message.log),
  }
}

const ascendingByKey = <K extends string | symbol, T extends Record<K, unknown>>(key: K) => (lhs: T, rhs: T) => lhs[key] < rhs[key] ? -1 : 1

const byteToHex = (value: number): string => ('0' + value.toString(16)).slice(-2)

const deleteUndefinedFields = (item: Record<string, unknown>) => {
  for (const key in item)
    if (item[key] === undefined)
      delete item[key]
}

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

const formatDate = (value: number) => new Date(value).toLocaleString('ja').replaceAll(/(?<=[ /:])\d(?=[^\d])/g, matched => `0${matched}`)

const polyline = <V>(map: Map<number, V>, max: number, range: number, selector: (value: V) => number, color: string, destination: NodeJS.WritableStream) => {
  destination.write('  <polyline fill="white" points="0,768')
  for (const [q, item] of map) {
    const x = 1 + q * 8192 / range
    const y = 1 + 766 * (max - selector(item)) / max
    destination.write(` ${x},${y}`)
  }
  destination.write(`" stroke="${color}" />`)
}

const selectAll = (item: Record<string, number>) => item.all

const selectBot = (item: Record<string, number>) => item.bot

const selectSpeech = (item: Record<string, number>) => item.speech

const visit = <K extends string, U extends Record<K, boolean>, V extends Record<K, number>>(item: U, v: V, ...keys: K[]) => {
  for (const key of keys)
    if (item[key])
      v[key]++
}
