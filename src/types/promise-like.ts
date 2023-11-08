export const isPromiseLike = (value: unknown): value is PromiseLike<unknown> => {
  const maybePromise = value as PromiseLike<unknown>
  return typeof value === 'object' && typeof maybePromise.then === 'function'
}
