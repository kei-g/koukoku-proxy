type DayOfWeek = '日' | '月' | '火' | '水' | '木' | '金' | '土'

export type Item = {
  body: string
  date: string
  dow: DayOfWeek
  forgery?: '※ 贋作 DNS 逆引の疑い'
  host: string
  self?: '〈＊あなた様＊〉'
  time: string
  timestamp: number
}

export const isItem = (value: unknown): value is Item => {
  const item = value as Item
  return typeof value === 'object' && keys.every((key: keyof Item) => typeof item[key] === 'string')
}

const keys = ['body', 'date', 'dow', 'host', 'time'] as const
