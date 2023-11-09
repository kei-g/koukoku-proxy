export type Item = {
  body: string
  date: string
  dow: string
  forgery?: string
  host: string
  self?: string
  time: string
  timestamp: number
}

export const isItem = (value: unknown): value is Item => {
  const item = value as Item
  return typeof value === 'object' && keys.every((key: keyof Item) => typeof item[key] === 'string')
}

const keys = ['body', 'date', 'dow', 'host', 'time'] as const
