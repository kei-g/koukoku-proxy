import { isPromiseLike } from '../types'

export class PromiseList extends Array<unknown> implements AsyncDisposable {
  constructor() {
    super()
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await Promise.all(this.filter(isPromiseLike))
  }
}
