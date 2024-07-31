export const coalesceAssign = <K extends number | string | symbol, V>(target: Record<K, V>, key: K, value: V) => {
  target[key] ??= value
}
