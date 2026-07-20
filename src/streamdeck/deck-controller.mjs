import { listStreamDecks, openStreamDeck } from '@elgato-stream-deck/node'

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

export async function runDeckLoop({
  config,
  renderer,
  handleAction,
  listDevices = listStreamDecks,
  openDevice = openStreamDeck,
  retryMilliseconds = 3000,
  logger = console,
}) {
  let deck = null
  const dispatch = (action) => {
    Promise.resolve(handleAction(action)).catch((error) => logger.error('action failed', error))
  }

  while (true) {
    try {
      const devices = await listDevices()
      if (devices.length === 0) {
        await sleep(retryMilliseconds)
        continue
      }

      deck = await openDevice(devices[0].path)
      renderer.setDeck(deck)
      logger.log(`opened ${deck.PRODUCT_NAME}`)
      await deck.setBrightness(config.brightness)
      await renderer.render()

      const disconnected = new Promise((resolve) => deck.once('error', resolve))
      deck.on('down', (controlDefinition) => {
        if (controlDefinition.type === 'button') {
          dispatch(config.keys[controlDefinition.index]?.action)
        } else if (controlDefinition.type === 'encoder') {
          dispatch(config.dials[controlDefinition.index]?.press)
        }
      })
      deck.on('rotate', (controlDefinition, amount) => {
        const dial = config.dials[controlDefinition.index]
        const selected = amount < 0 ? dial?.left : dial?.right
        for (let count = 0; count < Math.min(10, Math.abs(amount)); count += 1) dispatch(selected)
      })
      deck.on('lcdShortPress', (_controlDefinition, position) => {
        dispatch(config.dials[Math.min(3, Math.floor(position.x / 200))]?.press)
      })
      await disconnected
    } catch (error) {
      logger.error('Stream Deck unavailable', error)
    } finally {
      renderer.clearDeck(deck)
      try { await deck?.close() } catch {}
      deck = null
    }
    await sleep(retryMilliseconds)
  }
}
