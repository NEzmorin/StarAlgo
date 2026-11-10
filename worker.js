import { DurableObject } from "cloudflare:workers";
import apiWorker from './functions/api/_handler.js';

const encoder = new TextEncoder();
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});
const randomHex = (length = 12) => [...crypto.getRandomValues(new Uint8Array(length))]
  .map(value => value.toString(16).padStart(2, "0")).join("");
async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
}

export class MultiplayerRoom extends DurableObject {
  async fetch(request) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: "Для подключения нужен WebSocket" }, 426);
    }
    const protocols = (request.headers.get("Sec-WebSocket-Protocol") || "")
      .split(",").map(value => value.trim()).filter(Boolean);
    if (!protocols.includes("staralgo.v1")) {
      return json({ error: "Не поддерживается протокол StarAlgo Network" }, 400);
    }
    const existing = this.ctx.getWebSockets();
    if (existing.length >= 32) return json({ error: "В этом канале уже 32 игрока" }, 503);
    const peerId = randomHex(12);
    const peers = existing.map(socket => {
      try { return socket.deserializeAttachment()?.peerId || ""; } catch (_) { return ""; }
    }).filter(Boolean);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ peerId, joinedAt: Date.now(), rateWindowStart: Date.now(), rateCount: 0 });
    try { server.send(JSON.stringify({ type: "ready", peerId, peers })); } catch (_) {}
    const joined = JSON.stringify({ type: "peer_joined", peerId });
    for (const socket of existing) { try { socket.send(joined); } catch (_) {} }
    return new Response(null, {
      status: 101, webSocket: client,
      headers: { "Sec-WebSocket-Protocol": "staralgo.v1" }
    });
  }

  async webSocketMessage(socket, message) {
    let raw;
    if (typeof message === "string") raw = message;
    else if (message instanceof ArrayBuffer) raw = new TextDecoder().decode(message);
    else { try { socket.close(1003, "Only text messages are supported"); } catch (_) {} return; }
    if (encoder.encode(raw).byteLength > 16000) {
      try { socket.close(1009, "Message too large"); } catch (_) {}
      return;
    }
    let packet;
    try { packet = JSON.parse(raw); } catch (_) {
      try { socket.send(JSON.stringify({ type: "error", error: "Сообщение должно быть JSON" })); } catch (_) {}
      return;
    }
    if (packet?.type === "ping") {
      try { socket.send(JSON.stringify({ type: "pong", time: Date.now() })); } catch (_) {}
      return;
    }
    if (packet?.type !== "message" || typeof packet.data !== "string" ||
        encoder.encode(packet.data).byteLength > 14000) {
      try { socket.send(JSON.stringify({ type: "error", error: "Некорректный пакет или превышен лимит 14 КБ" })); } catch (_) {}
      return;
    }
    const attachment = socket.deserializeAttachment() || {};
    const currentTime = Date.now();
    const resetWindow = currentTime - Number(attachment.rateWindowStart || 0) >= 1000;
    const rateWindowStart = resetWindow ? currentTime : Number(attachment.rateWindowStart || currentTime);
    const rateCount = resetWindow ? 1 : Number(attachment.rateCount || 0) + 1;
    if (rateCount > 30) {
      try { socket.close(1013, "Rate limit: 30 messages per second"); } catch (_) {}
      return;
    }
    socket.serializeAttachment({ ...attachment, rateWindowStart, rateCount });
    const outgoing = JSON.stringify({ type: "message", peerId: String(attachment.peerId || ""), data: packet.data });
    for (const recipient of this.ctx.getWebSockets()) {
      if (recipient === socket) continue;
      try { recipient.send(outgoing); } catch (_) {}
    }
  }

  async webSocketClose(socket, code, reason) {
    const attachment = socket.deserializeAttachment() || {};
    const peerId = String(attachment.peerId || "");
    if (peerId) {
      const outgoing = JSON.stringify({ type: "peer_left", peerId });
      for (const recipient of this.ctx.getWebSockets()) {
        if (recipient === socket) continue;
        try { recipient.send(outgoing); } catch (_) {}
      }
    }
    try { socket.close(code, reason); } catch (_) {}
  }
}

async function handleMultiplayerUpgrade(request, env) {
  if (!env.DB || !env.MULTIPLAYER) return json({ error: "Мультиплеер ещё не настроен на Cloudflare Worker" }, 503);
  if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return json({ error: "Для этого адреса требуется WebSocket" }, 426);
  }
  const origin = request.headers.get("Origin") || "";
  const configuredOrigin = env.APP_ORIGIN || new URL(request.url).origin;
  const allowedPreview = env.ALLOW_PAGES_PREVIEWS === "true" &&
    /^https:\/\/[a-z0-9-]+\.pages\.dev$/i.test(origin);
  if (origin && origin !== "null" && origin !== configuredOrigin && !allowedPreview) {
    return json({ error: "Origin не разрешён" }, 403);
  }
  const protocols = (request.headers.get("Sec-WebSocket-Protocol") || "")
    .split(",").map(value => value.trim()).filter(Boolean);
  const ticketProtocol = protocols.find(value => value.startsWith("staralgo-ticket."));
  const ticket = ticketProtocol ? ticketProtocol.slice("staralgo-ticket.".length) : "";
  if (!/^[a-f0-9]{64}$/.test(ticket) || !protocols.includes("staralgo.v1")) {
    return json({ error: "Билет подключения отсутствует или некорректен" }, 401);
  }
  const ticketRow = await env.DB.prepare(`DELETE FROM multiplayer_tickets
    WHERE token_hash=? AND expires_at>?
    RETURNING project_id,channel,player_id`).bind(await sha256Hex(ticket), Date.now()).first();
  if (!ticketRow) return json({ error: "Билет уже использован или истёк. Подключитесь заново." }, 401);
  const project = await env.DB.prepare(
    "SELECT category,published,deleted_at,payload_json FROM projects WHERE id=?"
  ).bind(ticketRow.project_id).first();
  let settings = {};
  try { settings = JSON.parse(project?.payload_json || "{}"); } catch (_) {}
  if (!project || project.deleted_at || !project.published || settings.multiplayerEnabled !== true ||
      !["HTML","Python"].includes(project.category)) {
    return json({ error: "Мультиплеер этого проекта выключен или проект снят с публикации" }, 403);
  }
  const roomId = env.MULTIPLAYER.idFromName(String(ticketRow.project_id) + ":" + String(ticketRow.channel));
  const room = env.MULTIPLAYER.get(roomId);
  const headers = new Headers(request.headers);
  headers.set("Sec-WebSocket-Protocol", "staralgo.v1");
  headers.set("X-StarAlgo-Peer-ID", String(ticketRow.player_id));
  return room.fetch(new Request(request, { headers }));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/multiplayer/connect") {
      try { return await handleMultiplayerUpgrade(request, env); }
      catch (error) {
        console.error("[StarAlgo Multiplayer]", error?.stack || error);
        return json({ error: "Не удалось открыть соединение мультиплеера" }, 500);
      }
    }
    return apiWorker.fetch(request, env, ctx);
  }
};

export async function scheduled(controller, env, ctx) {
  ctx.waitUntil(
    env.DB.prepare('DELETE FROM projects WHERE deleted_at IS NOT NULL AND deleted_at < ?')
      .bind(Date.now() - 180 * 86400000)
      .run()
  );
}
