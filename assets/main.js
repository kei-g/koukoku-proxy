const connect = () => {
  const url = `wss://${document.location.host}`
  console.log({ url })
  const client = new WebSocket(url)
  client.addEventListener('close', connect.bind(this))
  client.addEventListener(
    'error',
    ev => {
      console.error({ error: ev })
    }
  )
  client.addEventListener(
    'message',
    ev => {
      console.log({ message: ev.data })
    }
  )
  client.addEventListener(
    'open',
    ev => {
      console.log({ open: ev })
    }
  )
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

window.addEventListener(
  'DOMContentLoaded',
  () => {
    connect()
    const message = document.getElementById('message')
    const button = message.nextElementSibling
    button.addEventListener('click', say)
  }
)
