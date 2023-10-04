import { Action } from './types'
import { KoukokuProxy } from './lib'

const main = async () => {
  const port = parseIntOr(process.env.PORT, 80)
  process.stdout.write(`process is running on pid:\x1b[33m${process.pid}\x1b[m\n\n`)
  await using _proxy = new KoukokuProxy(port)
  await Promise.race(
    [
      waitForSignalAsync('SIGABRT'),
      waitForSignalAsync('SIGHUP'),
      waitForSignalAsync('SIGINT'),
      waitForSignalAsync('SIGQUIT'),
      waitForSignalAsync('SIGTERM'),
    ]
  )
}

const parseIntOr = (text: string | undefined, alternateValue: number) => {
  const value = parseInt(text as string)
  return [value, alternateValue][+isNaN(value)]
}

const waitForSignalAsync = (signal: NodeJS.Signals) => new Promise(
  (resolve: Action<NodeJS.Signals>) => process.on(signal, resolve)
)

main()
  .then(() => process.exit(0))
  .catch(
    (reason: unknown) => {
      process.stdout.write(`[uncaught error] ${reason instanceof Error ? reason.message : reason}\n`)
      process.exit(1)
    }
  )
