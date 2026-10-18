// owner: U4 (core runtime; bedrock-protocol patch holds the resource pack response)
// Upstream: mineflayer 4.39.0 lib/plugins/resource_pack.js
// Surface: bot.acceptResourcePack(), bot.denyResourcePack()
// Events: 'resourcePack' (url, hash, uuid) — once per pack the server offers
// Bedrock: the server offers its packs in resource_packs_info during login (before start_game); the client
//   answers resource_pack_client_response. bedrock-protocol answers 'completed' at once; the bedboo patch
//   (patches/bedrock-protocol@3.60.1.patch) lets this plugin hold the answer:
//     client.holdResourcePacks = (packet) => boolean   // true: wait for client.respondToResourcePacks(response)
//   Like mineflayer, packs are accepted automatically when nobody listens to 'resourcePack'; with a listener
//   the bot waits for acceptResourcePack() / denyResourcePack() (mineflayer leaves an unanswered pack pending
//   too). The bot never downloads pack contents (nothing would use them).
//   - acceptResourcePack(): 'completed' → the join continues.
//   - denyResourcePack(): Java sends DECLINED and the server decides; on Bedrock an optional pack
//     (must_accept false) is declined with 'have_all_packs' (join without it, as the vanilla client's
//     "join without packs"), a required one with 'refused' → BDS disconnects (kicked 'missing_client', loggedIn
//     false), like a Java server kicking a client that declines its required pack.
//   Event arguments: `url` = the pack's CDN url ('' when the server sends the pack itself), `hash` = the Bedrock
//   pack id `<uuid>_<version>`, `uuid` = the pack uuid (docs/differences/U4.md#resource-packs).
'use strict'

module.exports = inject

function packsOf (packet) {
  return packet?.texture_packs ?? []
}

const STATUS_NAMES = { completed: 'resourcepackstackfinished', have_all_packs: 'downloadingfinished', refused: 'cancel' }

function inject (bot) {
  const client = bot._client
  let answered = false
  let offer = null // the resource_packs_info being answered

  // bedboo bedrock-protocol patch hook: hold the answer while someone listens to 'resourcePack'
  client.holdResourcePacks = (packet) => packsOf(packet).length > 0 && bot.listenerCount('resourcePack') > 0

  client.on('resource_packs_info', (packet) => {
    offer = packet
    for (const pack of packsOf(packet)) {
      bot.emit('resourcePack', pack.cdn_url ?? '', `${pack.uuid}_${pack.version}`, pack.uuid)
    }
  })

  function respond (response) {
    if (answered || !offer) return // nothing offered (yet), or already answered: like an unanswered Java pack
    if (typeof client.respondToResourcePacks === 'function') {
      answered = !!client.respondToResourcePacks(response) || answered
      return
    }
    // a client without the patch (or a test fake): answer directly
    answered = true
    client.write('resource_pack_client_response', { response_status: response, response_status_name: STATUS_NAMES[response], resourcepackids: [] })
    if (response === 'have_all_packs') {
      client.once('resource_pack_stack', () => client.write('resource_pack_client_response', { response_status: 'completed', response_status_name: STATUS_NAMES.completed, resourcepackids: [] }))
    }
  }

  bot.acceptResourcePack = () => respond('completed')
  bot.denyResourcePack = () => respond(offer?.must_accept ? 'refused' : 'have_all_packs')
}
