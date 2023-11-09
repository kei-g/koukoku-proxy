import { AsyncWriter, KoukokuProxy } from './lib/index.js'

const main = async () => {
  const { env, pid } = process
  const port = parseIntOr(env.PORT, 80)
  {
    await using stdout = new AsyncWriter()
    stdout.write(`process is running on pid \x1b[33m${pid}\x1b[m\n\n`)
    const array = [] as [string, string | undefined][]
    for (const name in env)
      array.push([name, env[name]?.replaceAll('\x1b', '\\x1b')])
    array.sort((lhs: [string, unknown], rhs: [string, unknown]) => lhs[0] < rhs[0] ? -1 : 1)
    stdout.write('----\n')
    for (const [name, value] of array)
      stdout.write(`${name}=${value}\n`)
    stdout.write('----\n')
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
