/* StarAlgo Multiplayer bridge for sandboxed HTML and Pyodide projects. */
(() => {
  'use strict';
  const API_ROOT = String(window.STARALGO_API_BASE || '').replace(/\/+$/, '');
  const MESSAGE_TYPE = 'staralgo-multiplayer';

  function randomToken() {
    const bytes = new Uint8Array(16);
    if (window.crypto && typeof window.crypto.getRandomValues === 'function') window.crypto.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
  }
  function websocketOrigin() {
    const base = new URL(API_ROOT || window.location.origin, window.location.href);
    base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
    return base.origin;
  }
  async function issueTicket(projectId, channel) {
    if (!API_ROOT) throw new Error('API StarAlgo не настроен.');
    const response = await fetch(API_ROOT + '/api/multiplayer/ticket', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: String(projectId), channel }),
      cache: 'no-store', mode: 'cors'
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'Не удалось получить билет подключения.');
    const socketUrl = new URL('/api/multiplayer/connect', API_ROOT);
    socketUrl.protocol = socketUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    return { ticket: payload.ticket, url: socketUrl.href };
  }
  function buildFrameScript(token) {
    const tokenLiteral = JSON.stringify(String(token));
    return '<script>(function(){' +
      'const TOKEN=' + tokenLiteral + ';const TYPE=' + JSON.stringify(MESSAGE_TYPE) + ';const pending=new Map();let requestNumber=0;' +
      'function emit(list,args){for(const fn of (list||[]).slice()){try{fn.apply(null,args)}catch(error){console.error("StarAlgo multiplayer callback",error)}}}' +
      'class Connection{' +
        'constructor(socket){this.socket=socket;this.peerId="";this.peers=[];this.listeners=new Map();this._resolveReady=null;this._rejectReady=null;this.readyPromise=new Promise((resolve,reject)=>{this._resolveReady=resolve;this._rejectReady=reject});' +
          'socket.addEventListener("message",event=>{let packet;try{packet=JSON.parse(event.data)}catch(_){return}' +
            'if(packet.type==="ready"){this.peerId=packet.peerId||"";this.peers=Array.isArray(packet.peers)?packet.peers:[];this._resolveReady(this);emit(this.listeners.get("ready"),[packet]);return}' +
            'if(packet.type==="message"){emit(this.listeners.get("message"),[packet.data,packet.peerId]);return}' +
            'if(packet.type==="peer_joined"){this.peers.push(packet.peerId);emit(this.listeners.get("peer_joined"),[packet.peerId]);return}' +
            'if(packet.type==="peer_left"){this.peers=this.peers.filter(id=>id!==packet.peerId);emit(this.listeners.get("peer_left"),[packet.peerId]);return}' +
            'if(packet.type==="error"){emit(this.listeners.get("error"),[new Error(packet.error||"Network error")])}' +
          '});' +
          'socket.addEventListener("error",()=>{const error=new Error("Ошибка соединения StarAlgo Network");this._rejectReady(error);emit(this.listeners.get("error"),[error])});' +
          'socket.addEventListener("close",event=>{this._rejectReady(new Error("Соединение закрыто до готовности ("+event.code+")"));emit(this.listeners.get("close"),[event])});' +
        '}' +
        'on(name,callback){if(typeof callback!=="function")throw new TypeError("callback must be a function");const list=this.listeners.get(name)||[];list.push(callback);this.listeners.set(name,list);return()=>{const current=this.listeners.get(name)||[];this.listeners.set(name,current.filter(fn=>fn!==callback))}}' +
        'onMessage(callback){return this.on("message",callback)}onPeerJoin(callback){return this.on("peer_joined",callback)}onPeerLeave(callback){return this.on("peer_left",callback)}' +
        'send(data){if(this.socket.readyState!==WebSocket.OPEN)throw new Error("StarAlgo Network is not connected");const raw=typeof data==="string"?data:JSON.stringify(data);if(new TextEncoder().encode(raw).byteLength>14000)throw new Error("Сообщение больше 14 КБ");this.socket.send(JSON.stringify({type:"message",data:raw}))}' +
        'close(){try{this.socket.close()}catch(_){}}' +
      '}' +
      'window.addEventListener("message",event=>{if(event.source!==parent)return;const packet=event.data;if(!packet||packet.type!==TYPE||packet.kind!=="ticket_response"||packet.token!==TOKEN)return;const entry=pending.get(packet.requestId);if(!entry)return;pending.delete(packet.requestId);if(!packet.ok){entry.reject(new Error(packet.error||"Не удалось подключиться"));return}let socket;try{socket=new WebSocket(packet.url,["staralgo.v1","staralgo-ticket."+packet.ticket])}catch(error){entry.reject(error);return}const client=new Connection(socket);client.readyPromise.then(entry.resolve,entry.reject)});' +
      'function connect(channel){const value=String(channel||"");if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value))return Promise.reject(new Error("Канал: 1–64 символа, латиница, цифры, дефис или подчёркивание"));const requestId=String(++requestNumber)+"-"+Math.random().toString(36).slice(2);return new Promise((resolve,reject)=>{pending.set(requestId,{resolve,reject});parent.postMessage({type:TYPE,kind:"ticket_request",token:TOKEN,requestId,channel:value},"*");setTimeout(()=>{const entry=pending.get(requestId);if(entry){pending.delete(requestId);entry.reject(new Error("Сервер не ответил на запрос подключения"))}},12000)})}' +
      'window.StarAlgo=window.StarAlgo||{};window.StarAlgo.multiplayer={connect};window.StarAlgoNetwork=window.StarAlgo.multiplayer;' +
    '})();<' + '/script>';
  }
  function attach(frame, project, token) {
    if (!frame || !project || !token || !['HTML','Python'].includes(project.category)) return () => {};
    const handler = async event => {
      if (event.source !== frame.contentWindow) return;
      const packet = event.data;
      if (!packet || packet.type !== MESSAGE_TYPE || packet.kind !== 'ticket_request' || packet.token !== token) return;
      const requestId = String(packet.requestId || '').slice(0, 80);
      const channel = String(packet.channel || '');
      try {
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(channel)) throw new Error('Некорректное имя канала');
        const result = await issueTicket(project.id, channel);
        frame.contentWindow.postMessage({type:MESSAGE_TYPE,kind:'ticket_response',token,requestId,ok:true,url:result.url,ticket:result.ticket}, '*');
      } catch (error) {
        frame.contentWindow.postMessage({type:MESSAGE_TYPE,kind:'ticket_response',token,requestId,ok:false,error:String(error && error.message || 'Ошибка подключения')}, '*');
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }
  window.StarAlgoMultiplayerHost = { randomToken, websocketOrigin, buildFrameScript, attach };
})();
