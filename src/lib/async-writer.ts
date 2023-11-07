import { Action } from '../types'
import { PromiseList } from '.'

export class AsyncWriter extends PromiseList {
  readonly #destination: NodeJS.WritableStream
  readonly #end: boolean

  constructor(destination: NodeJS.WritableStream = process.stdout, end: boolean = false) {
    super()
    this.#destination = destination
    this.#end = end
  }

  write(data: Uint8Array | string, destination?: NodeJS.WritableStream): void {
    const job = new Promise(
      (resolve: Action<Error | null | undefined>) => (destination ?? this.#destination).write(
        data,
        resolve
      )
    )
    this.push(job)
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await super[Symbol.asyncDispose]()
    if (this.#destination && this.#end)
      await new Promise<void>(this.#destination.end.bind(this.#destination))
  }
}
