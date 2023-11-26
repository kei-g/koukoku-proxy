const connect = ul => {
  const url = `wss://${document.location.host}`
  const client = new WebSocket(url)
  client.addEventListener('close', connect.bind(this, ul))
  client.addEventListener('error', ev => console.error({ error: ev }))
  client.addEventListener('message', prependItem.bind(this, ul) )
  client.addEventListener('open', ev => console.log({ open: ev }))
}

const createDivElementForBody = (document, item) => {
  const body = document.createElement('div')
  body.classList.add('body')
  for (const line of item.body.split(/\r?\n/)) {
    const last = {}
    for (const matched of line.matchAll(urlRE))
      qualifyURL(document, last, body, matched)
    const offset = last.offset ?? 0
    if (offset < line.length)
      body.appendChild(document.createTextNode(line.slice(offset)))
    const br = document.createElement('br')
    body.appendChild(br)
  }
  body.removeChild(body.lastElementChild)
  return body
}

const prependItem = async (ul, ev) => {
  for (const { id, item } of JSON.parse(await ev.data.text())) {
    const li = document.createElement('li')
    const { length } = item.time.split(':')
    li.classList.add(['invalid', 'invalid', 'speech', 'message'][length])
    li.setAttribute('id', id)
    const date = document.createElement('span')
    date.classList.add('date')
    date.appendChild(document.createTextNode(item.date))
    const time = document.createElement('span')
    time.classList.add('time')
    time.appendChild(document.createTextNode(item.time))
    const body = createDivElementForBody(document, item)
    const host = document.createElement('div')
    host.classList.add('host')
    host.appendChild(document.createTextNode(item.host))
    li.appendChild(date)
    li.appendChild(time)
    li.appendChild(body)
    li.appendChild(host)
    ul.prepend(li)
    const nodes = document.querySelectorAll('li.loading')
    for (let i = 0; i < nodes.length; i++)
      ul.removeChild(nodes.item(i))
  }
}

const qualifyURL = (document, last, elemnet, matched) => {
  if (last.offset !== matched.index) {
    const value = matched.input.slice(last.offset ?? 0, matched.index)
    const text = document.createTextNode(value)
    elemnet.appendChild(text)
  }
  const a = document.createElement('a')
  a.setAttribute('href', matched[0])
  a.setAttribute('target', '_blank')
  const text = document.createTextNode(matched[0])
  a.appendChild(text)
  elemnet.appendChild(a)
  last.offset = matched.index + matched[0].length
}

const say = async ev => {
  const button = ev.target
  const form = button.parentElement
  const elements = [0, 1].map(form.children.item.bind(form.children))
  const [token, body] = elements.map(e => e.value)
  if (token.length && body.length) {
    button.setAttribute('disabled', 'disabled')
    const response = await fetch(
      '/say',
      {
        body,
        cache: 'no-cache',
        credentials: 'same-origin',
        headers: {
          Authorization: `TOKEN ${token}`,
          'Content-Type': 'text/plain; charset=utf-8',
        },
        method: 'POST',
        mode: 'cors',
        redirect: 'follow',
        referrerPolicy: 'no-referrer',
      }
    )
    elements[1].value = ''
    const json = await response.json()
    button.removeAttribute('disabled')
    if ('message' in json)
      alert(json.message)
  }
}

const updateButtonDisabled = (button, message, token, _ev) => {
  message.value === '' || token.value === ''
    ? button.setAttribute('disabled', 'disabled')
    : button.removeAttribute('disabled')
}

const urlRE = /https?:\/\/[\w!?/+\-_~=;.,*&@#$%()'[\]]+/g

window.addEventListener(
  'DOMContentLoaded',
  () => {
    const ul = document.getElementById('messages')
    connect(ul)
    const message = document.getElementById('message')
    const token = document.getElementById('token')
    const button = message.nextElementSibling
    button.addEventListener('click', say)
    const update = updateButtonDisabled.bind(this, button, message, token)
    for (const name of ['change', 'copy', 'cut', 'input', 'paste']) {
      message.addEventListener(name, update)
      token.addEventListener(name, update)
    }
  }
)
