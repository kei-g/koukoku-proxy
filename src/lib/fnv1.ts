export const fnv1 = {
  32: (data: Buffer) => {
    const { byteLength } = data
    const ctx = { hash: 0x811c9dc5 }
    for (let i = 0; i + 4 < byteLength; i += 4) {
      ctx.hash ^= data.readUint32BE(i)
      ctx.hash = multiplyPrime32(ctx.hash)
    }
    if (byteLength & 3) {
      let value = 0
      for (let i = byteLength & ~3; i < byteLength; i++) {
        value <<= 8
        value |= data.readUint8(i)
      }
      ctx.hash ^= value
      ctx.hash = multiplyPrime32(ctx.hash)
    }
    return ctx.hash
  },
  64: (data: Buffer) => {
    const { byteLength } = data
    const ctx = { hash: 14695981039346656037n }
    for (let i = 0; i + 8 < byteLength; i += 8) {
      ctx.hash ^= data.readBigUInt64BE(i)
      ctx.hash = multiplyPrime64(ctx.hash)
    }
    if (byteLength & 7) {
      let value = 0n
      for (let i = byteLength & ~7; i < byteLength; i++) {
        value <<= 8n
        value |= BigInt(data.readUint8(i))
      }
      ctx.hash ^= value
      ctx.hash = multiplyPrime64(ctx.hash)
    }
    return ctx.hash
  },
}

const multiplyPrime32 = (value: number) => Number((BigInt(value) * 16777619n) & 4294967295n)

const multiplyPrime64 = (value: bigint) => (value * 1099511628211n) & 18446744073709551615n
