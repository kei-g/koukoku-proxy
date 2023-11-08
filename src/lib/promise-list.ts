import { isPromiseLike } from '../types/index.js'

export class PromiseList extends Array<unknown> implements AsyncDisposable {
  constructor() {
    super()
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await Promise.all(this.filter(isPromiseLike))
  }
}
