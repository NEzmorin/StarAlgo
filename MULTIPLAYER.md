# StarAlgo Network (multiplayer)

StarAlgo Network is a message relay for published HTML and Pyodide-based Python projects. StarAlgo does not create a lobby browser or decide who should play whom: the game chooses channel names and implements matchmaking, player state, rules, and synchronization itself.

## Enable access

Open a project's **Публикация** settings. In **Сеть / Мультиплеер**, enable the checkbox and save it. Publish the project so other players can connect. Only the project owner can change this permission. Unpublishing the project or disabling the permission prevents new connections.

## JavaScript (HTML projects)

The sandbox exposes `StarAlgo.multiplayer` only when the project owner enabled it and the project is published:

```js
const network = await StarAlgo.multiplayer.connect("match-42");

network.onMessage((raw, peerId) => {
  const packet = JSON.parse(raw);
  console.log("From", peerId, packet);
});

network.onPeerJoin(peerId => console.log("Joined:", peerId));
network.onPeerLeave(peerId => console.log("Left:", peerId));
network.send({ type: "player-ready", name: "Player 1" });
network.close();
```

## Python (Pyodide, Pygame, Pygame Zero)

The Pyodide iframe exposes the same JavaScript SDK through `js`:

```python
import asyncio
import json
from js import StarAlgo

async def start_multiplayer():
    network = await StarAlgo.multiplayer.connect("match-42")
    network.onMessage(lambda raw, peer_id: print("From", peer_id, raw))
    network.send(json.dumps({"type": "player-ready", "name": "Player 1"}))

asyncio.ensure_future(start_multiplayer())
```

Messages arrive as JSON text. The sender receives a local echo through the same `onMessage` callback (the optional third argument is `{ local: true }`); messages received from other players have `{ local: false }`. Use `json.loads(raw)` in Python or `JSON.parse(raw)` in JavaScript to decode them. A channel name is an isolated game session: your game can create a private channel per match and share its name with invited players.

## Limits and security

- 32 simultaneous players per channel.
- 30 outgoing messages per second per connected player.
- 14 KB maximum application message; text-only JSON packets.
- Connection tickets expire after 60 seconds and can be used once.
- Ticket creation is rate-limited per project and IP address.
- The game iframe can connect only to the StarAlgo relay, not arbitrary Internet hosts.
- The legacy Turtle/Brython runner does not expose this API yet; use Pyodide for Python multiplayer.

The relay forwards messages to the other connected players. It is not an authoritative game server: clients should not trust other players' scores, inventory, or other important state without validating it in game logic.
