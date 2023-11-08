import { AsyncWriter, KoukokuProxy } from './lib'

const main = async () => {
  const port = parseIntOr(process.env.PORT, 80)
  {
    await using stdout = new AsyncWriter()
    stdout.write(`process is running on pid:\x1b[33m${process.pid}\x1b[m\n\n`)
  }
  await using _proxy = new KoukokuProxy(port)
  await waitForSignals('SIGABRT', 'SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGTERM')
}

const parseIntOr = (text: string | undefined, alternateValue: number) => {
  const value = parseInt(text as string)
  return [value, alternateValue][+isNaN(value)]
}

const waitForSignals = (...signals: NodeJS.Signals[]) => Promise.race(
  signals.map(
    (signal: NodeJS.Signals) => new Promise(process.on.bind(process, signal))
  )
)

main()
  .then(
    process.exit.bind(process, 0)
  )
  .catch(
    (reason: unknown) => process.stdout.write(`[uncaught error] ${reason instanceof Error ? reason.message : reason}\n`)
  ).finally(
    process.exit.bind(process, 1)
  )
