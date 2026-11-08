const encoder = new TextEncoder();
const now = () => Date.now();
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }
});
const makeId = () => String(Date.now() * 1000 + Math.floor(Math.random() * 1000));
const b64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
const hex = bytes => [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, '0')).join('');
async function digest(value) { return hex(await crypto.subtle.digest('SHA-256', encoder.encode(value))); }
async function passwordHash(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  return b64(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64(salt), iterations }, key, 256));
}
async function readBody(req, maxBytes = 600000) {
  const declared = Number(req.headers.get('Content-Length') || 0);
  if (declared > maxBytes) throw new HttpError(413, 'Слишком большой запрос');
  const raw = await req.text();
  if (new TextEncoder().encode(raw).length > maxBytes) throw new HttpError(413, 'Слишком большой запрос');
  try { return raw ? JSON.parse(raw) : {}; } catch { throw new HttpError(400, 'Некорректный JSON'); }
}
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new HttpError(status, message); };
function text(v, max, label, allowEmpty = false) {
  if (typeof v !== 'string') fail(400, `${label}: некорректное значение`);
  const s = v.trim();
  if ((!allowEmpty && !s) || s.length > max) fail(400, `${label}: некорректное значение`);
  return s;
}
function parseJson(value, fallback = {}) { try { return JSON.parse(value || ''); } catch { return fallback; } }
function escapeHtmlAttribute(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
}
function publicUser(row) {
  return {
    id: row.id, username: row.username, originalUsername: row.original_username || row.username, role: row.role || '[Начинающий]',
    isSupernova: !!row.is_supernova, isTester: !!row.is_tester,
    isBanned: !!row.is_banned, banUntil: row.ban_until || null,
    reputation: Number(row.reputation ?? 6), awards: Number(row.awards || 0),
    likes: Number(row.likes_received || 0), projects: Number(row.projects_count || 0),
    avatarUrl: row.avatar_url || '', bio: row.bio || '', createdAt: row.created_at
  };
}
function mapProject(row, includePayload = false) {
  const payload = includePayload ? parseJson(row.payload_json, {}) : {};
  return {
    id: Number(row.id), author: row.author || row.username || '', name: row.name,
    category: row.category, description: row.description || '', published: !!row.published,
    coverUrl: row.cover_url || '', projectUrl: row.project_url || '',
    likes: Number(row.likes_count || 0), views: Number(row.views || 0),
    commentsCount: Number(row.comments_count || 0), comments: row.comments_data || [],
    likedBy: row.liked_by || [], date: Number(row.created_at),
    deletedAt: row.deleted_at ? Number(row.deleted_at) : null,
    data: payload.data ?? row.source_text ?? '', sb3Data: payload.sb3Data || '', sb3Url: payload.sb3Url || '',
    isDummy: !!payload.isDummy
  };
}
const PROJECT_RESOURCE_HOSTS = [
  'image2url.com','catbox.moe','imgbb.com','ibb.co','posty5.com','github.io',
  'raw.githubusercontent.com','vercel.app','lh3.googleusercontent.com','drive.google.com','docs.google.com','scratch.mit.edu',
  'pagedrop.io','boomurl.com','iimg.live','x02.me','roblox.com','res.cloudinary.com'
];
function isAllowedProjectResourceUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return true;
  if (/^\/?(?:cover|emptyprofile)\.(?:png|jpe?g|gif|webp|svg)$/i.test(raw)) return true;
  let parsed;
  try { parsed = new URL(raw); } catch { return false; }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) return false;
  const host = parsed.hostname.toLowerCase();
  return PROJECT_RESOURCE_HOSTS.some(domain => host === domain || host.endsWith('.' + domain));
}
function validateProjectResourceUrl(value, label) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw && !isAllowedProjectResourceUrl(raw)) {
    fail(400, label + ': разрешены только HTTPS-ссылки на утверждённые файлообменники и встроенные файлы StarAlgo.');
  }
  return raw.slice(0, 2048);
}
function mapComment(row) {
  // Keep timestamp-based IDs as strings to avoid precision loss in browsers.
  return { id: String(row.id), parentId: row.parent_id ? String(row.parent_id) : null,
    replyToUser: row.reply_to_user || null, author: row.username, text: row.body,
    date: Number(row.created_at) };
}
function mapNotification(row) {
  const p = parseJson(row.payload, {});
  return { id: Number(row.id), kind: row.kind || '', actor: row.actor || 'Система', text: row.text || '',
    linkType: p.linkType || '', targetUser: p.targetUser || '', targetAuthor: p.targetAuthor || '',
    targetStarId: p.targetStarId ? Number(p.targetStarId) : 0,
    date: Number(row.created_at), read: !!row.read_at, temporaryPassword: p.temporaryPassword || '' };
}
async function authUser(request, env) {
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  return env.DB.prepare(`SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?`)
    .bind(await digest(token), now()).first();
}
async function createSession(userId, env) {
  const bytes = crypto.getRandomValues(new Uint8Array(32)), token = b64(bytes);
  const expiresAt = now() + Math.max(1, Math.min(90, Number(env.SESSION_DAYS || 30))) * 86400000;
  await env.DB.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)')
    .bind(await digest(token), userId, expiresAt, now()).run();
  return { token, expiresAt };
}
const isStaff = user => !!user && ['[Сингулярность]', '[Администратор]', '[Модератор]'].includes(user.role);
const isAdmin = user => !!user && ['[Сингулярность]', '[Администратор]'].includes(user.role);
const isSingularity = user => !!user && user.role === '[Сингулярность]';
async function userByName(env, name) {
  return env.DB.prepare('SELECT * FROM users WHERE username_norm=?').bind(String(name).toLowerCase()).first();
}
async function projectRow(env, projectId) {
  return env.DB.prepare(`SELECT p.*,u.username author,
    (SELECT COUNT(*) FROM project_likes l WHERE l.project_id=p.id) likes_count,
    (SELECT COUNT(*) FROM comments c WHERE c.project_id=p.id) comments_count
    FROM projects p JOIN users u ON u.id=p.user_id WHERE p.id=?`).bind(String(projectId)).first();
}
async function projectDetail(env, row, user) {
  const mapped = mapProject({ ...row, comments_data: [], liked_by: [] }, true);
  mapped.commentsCount = Number(row.comments_count || 0);
  mapped.isLiked = !!user && !!(await env.DB.prepare('SELECT 1 AS liked FROM project_likes WHERE project_id=? AND user_id=?').bind(row.id,user.id).first());
  return mapped;
}
async function addNotification(env, recipientId, actorId, kind, message, payload = {}) {
  if (!recipientId || recipientId === actorId) return;
  await env.DB.prepare('INSERT INTO notifications(id,user_id,actor_id,kind,payload,created_at) VALUES(?,?,?,?,?,?)')
    .bind(makeId(), recipientId, actorId || null, kind, JSON.stringify({ ...payload, text: message }), now()).run();
}
async function refreshRank(env, userId) {
  const current = await env.DB.prepare('SELECT role FROM users WHERE id=?').bind(userId).first();
  if (!current || ['[Сингулярность]','[Администратор]','[Модератор]','[Сверхновая]'].includes(current.role)) return;
  const counts = await env.DB.prepare(`SELECT
    (SELECT COUNT(*) FROM projects WHERE user_id=? AND deleted_at IS NULL) projects_count,
    (SELECT COUNT(*) FROM project_likes l JOIN projects p ON p.id=l.project_id WHERE p.user_id=?) likes_count`).bind(userId,userId).first();
  const projects = Number(counts.projects_count || 0), likes = Number(counts.likes_count || 0);
  const role = projects >= 5 || likes >= 15 ? '[Понимающий]' : projects >= 2 || likes >= 5 ? '[Ознакомленный]' : '[Начинающий]';
  await env.DB.prepare('UPDATE users SET role=?,updated_at=? WHERE id=?').bind(role,now(),userId).run();
}
async function getProfile(env, profile, viewer) {
  const stats = await env.DB.prepare(`SELECT
    (SELECT COUNT(*) FROM projects WHERE user_id=? AND published=1 AND deleted_at IS NULL) projects,
    (SELECT COUNT(*) FROM follows WHERE followed_id=?) followers,
    (SELECT COUNT(*) FROM follows WHERE follower_id=?) following,
    (SELECT COUNT(*) FROM project_likes l JOIN projects p ON p.id=l.project_id WHERE p.user_id=?) likes_received`).bind(profile.id, profile.id, profile.id, profile.id).first();
  const followerRows = await env.DB.prepare('SELECT u.username FROM follows f JOIN users u ON u.id=f.follower_id WHERE f.followed_id=? ORDER BY u.username').bind(profile.id).all();
  const followingRows = await env.DB.prepare('SELECT u.username FROM follows f JOIN users u ON u.id=f.followed_id WHERE f.follower_id=? ORDER BY u.username').bind(profile.id).all();
  const own = !!viewer && viewer.id === profile.id;
  const projectRows = await env.DB.prepare(`SELECT ${own ? 'p.*' : 'p.id,p.user_id,p.name,p.category,p.description,p.published,p.cover_url,p.project_url,p.views,p.deleted_at,p.was_published,p.created_at,p.updated_at'},u.username author,
    (SELECT COUNT(*) FROM project_likes l WHERE l.project_id=p.id) likes_count,
    (SELECT COUNT(*) FROM comments c WHERE c.project_id=p.id) comments_count
    FROM projects p JOIN users u ON u.id=p.user_id
    WHERE p.user_id=? AND ${own ? '1=1' : 'p.published=1 AND p.deleted_at IS NULL'} ORDER BY p.updated_at DESC LIMIT 100`).bind(profile.id).all();
  const notifs = own ? await env.DB.prepare(`SELECT n.*,a.username actor,json_extract(n.payload,'$.text') text FROM notifications n LEFT JOIN users a ON a.id=n.actor_id WHERE n.user_id=? ORDER BY n.created_at DESC LIMIT 100`).bind(profile.id).all() : { results: [] };
  const base = publicUser({ ...profile, likes_received: stats.likes_received, projects_count: stats.projects });
  return {
    ...base, projectsList: projectRows.results.filter(p => !p.deleted_at).map(p => mapProject(p, own)),
    vacuumList: projectRows.results.filter(p => !!p.deleted_at).map(p => mapProject(p, own)),
    followersList: followerRows.results.map(x => x.username.toLowerCase()),
    followingList: followingRows.results.map(x => x.username.toLowerCase()),
    notifications: notifs.results.map(mapNotification)
  };
}
async function bootstrap(env, user) {
  const usersRows = await env.DB.prepare(`SELECT u.*,
    (SELECT COUNT(*) FROM projects p WHERE p.user_id=u.id AND p.published=1 AND p.deleted_at IS NULL) projects_count,
    (SELECT COUNT(*) FROM project_likes l JOIN projects p ON p.id=l.project_id WHERE p.user_id=u.id) likes_received
    FROM users u ORDER BY u.created_at LIMIT 250`).all();
  const projectsRows = await env.DB.prepare(`SELECT p.id,p.user_id,p.name,p.category,p.description,p.published,p.cover_url,p.project_url,p.views,p.deleted_at,p.was_published,p.created_at,p.updated_at,u.username author,
    (SELECT COUNT(*) FROM project_likes l WHERE l.project_id=p.id) likes_count,
    (SELECT COUNT(*) FROM comments c WHERE c.project_id=p.id) comments_count
    FROM projects p JOIN users u ON u.id=p.user_id WHERE p.published=1 AND p.deleted_at IS NULL
    ORDER BY p.updated_at DESC LIMIT 250`).all();
  const users = {};
  for (const row of usersRows.results) users[row.username.toLowerCase()] = {
    ...publicUser(row), avatarHtml: row.avatar_url ? `<img src="${escapeHtmlAttribute(row.avatar_url)}" alt="Avatar">` : '',
    projectsList: [], vacuumList: [], followersList: [], followingList: [], notifications: []
  };
  for (const row of projectsRows.results) {
    const key = row.author.toLowerCase();
    if (users[key]) users[key].projectsList.push(mapProject(row));
  }
  let current = null, dwarfs = [], reports = [];
  if (user) {
    current = await getProfile(env, user, user);
    current.avatarHtml = user.avatar_url ? `<img src="${escapeHtmlAttribute(user.avatar_url)}" alt="Avatar">` : '';
    users[user.username.toLowerCase()] = current;
    current.projectsList = current.projectsList.map(p => ({ ...p }));
    dwarfs = (await env.DB.prepare(`SELECT d.*,u.username author,(SELECT COUNT(*) FROM dwarf_likes l WHERE l.dwarf_id=d.id) likes_count,(SELECT COUNT(*) FROM dwarf_comments c WHERE c.dwarf_id=d.id) comments_count FROM yellow_dwarfs d JOIN users u ON u.id=d.author_id ORDER BY d.created_at DESC LIMIT 100`).all()).results.map(r => ({ id:Number(r.id), name:r.title, description:r.body, coverUrl:r.image_url || '', author:r.author, date:Number(r.created_at), likes:Number(r.likes_count), commentsCount:Number(r.comments_count), comments:[] }));
    if (isStaff(user)) reports = (await env.DB.prepare(`SELECT r.*,u.username reporter,coalesce(t.username,'') target_owner FROM reports r JOIN users u ON u.id=r.reporter_id LEFT JOIN users t ON t.id=r.target_user_id WHERE r.status='open' ORDER BY r.created_at DESC LIMIT 100`).all()).results.map(r => ({id:Number(r.id),type:r.target_type,targetId:String(r.target_id),targetName:r.target_name,targetOwner:r.target_owner,reporter:r.reporter,reason:r.reason,date:Number(r.created_at)}));
  } else {
    dwarfs = (await env.DB.prepare(`SELECT d.*,u.username author,(SELECT COUNT(*) FROM dwarf_likes l WHERE l.dwarf_id=d.id) likes_count,(SELECT COUNT(*) FROM dwarf_comments c WHERE c.dwarf_id=d.id) comments_count FROM yellow_dwarfs d JOIN users u ON u.id=d.author_id ORDER BY d.created_at DESC LIMIT 100`).all()).results.map(r => ({ id:Number(r.id), name:r.title, description:r.body, coverUrl:r.image_url || '', author:r.author, date:Number(r.created_at), likes:Number(r.likes_count), commentsCount:Number(r.comments_count), comments:[] }));
  }
  return { user: current, users, dwarfs, reports };
}
async function fetchDriveScratchProject(fileId) {
  // Stream large Scratch archives instead of buffering the whole file in Worker memory.
  const maxBytes = 500 * 1024 * 1024;
  const urls = [
    'https://drive.usercontent.google.com/download?id=' + encodeURIComponent(fileId) + '&export=download&confirm=t',
    'https://drive.google.com/uc?export=download&id=' + encodeURIComponent(fileId) + '&confirm=t'
  ];
  for (const upstreamUrl of urls) {
    let upstream;
    try {
      upstream = await fetch(upstreamUrl, { redirect: 'follow', headers: { 'User-Agent': 'StarAlgo-Scratch-Proxy/1.0' } });
    } catch (_) {
      continue;
    }
    if (!upstream.ok || !upstream.body) continue;
    const declaredLength = Number(upstream.headers.get('content-length') || 0);
    if (declaredLength > maxBytes) {
      try { await upstream.body.cancel(); } catch (_) {}
      return json({ error: 'Файл больше допустимого лимита прокси — 500 МБ.' }, 413);
    }
    const reader = upstream.body.getReader();
    const prefixChunks = [];
    let prefixLength = 0;
    try {
      while (prefixLength < 4) {
        const part = await reader.read();
        if (part.done) break;
        prefixChunks.push(part.value);
        prefixLength += part.value.byteLength;
      }
    } catch (_) {
      try { await reader.cancel(); } catch (_) {}
      continue;
    }
    const prefix = new Uint8Array(prefixLength);
    let prefixOffset = 0;
    for (const chunk of prefixChunks) {
      prefix.set(chunk, prefixOffset);
      prefixOffset += chunk.byteLength;
    }
    // Scratch .sb3 files are ZIP archives. Reject Drive's HTML login/confirmation pages.
    if (prefixLength < 4 || prefix[0] !== 0x50 || prefix[1] !== 0x4b ||
        !((prefix[2] === 0x03 && prefix[3] === 0x04) ||
          (prefix[2] === 0x05 && prefix[3] === 0x06) ||
          (prefix[2] === 0x07 && prefix[3] === 0x08))) {
      try { await reader.cancel(); } catch (_) {}
      continue;
    }
    let total = prefixLength;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(prefix);
      },
      async pull(controller) {
        try {
          const part = await reader.read();
          if (part.done) {
            controller.close();
            return;
          }
          total += part.value.byteLength;
          if (total > maxBytes) {
            try { await reader.cancel(); } catch (_) {}
            controller.error(new Error('Scratch archive exceeds 500 MB'));
            return;
          }
          controller.enqueue(part.value);
        } catch (error) {
          controller.error(error);
        }
      },
      cancel(reason) {
        return reader.cancel(reason);
      }
    });
    const headers = {
      'content-type': 'application/zip',
      'content-disposition': 'inline; filename="project.sb3"',
      'cache-control': 'public, max-age=60',
      'x-content-type-options': 'nosniff'
    };
    // Do not forward Google's Content-Length: Workers may transparently decode upstream bodies, making it stale and causing browsers to truncate the ZIP.
    return new Response(body, { status: 200, headers });
  }
  return json({ error: 'Google Drive не отдал открытый .sb3-файл. Проверьте доступ «Все, у кого есть ссылка» и что ссылка ведёт на файл .sb3.' }, 502);
}

async function ensureSupportSchema(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS support_tickets (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subject TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS support_messages (
    id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
    sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sender_role TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL
  )`).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS support_tickets_status_idx ON support_tickets(status,updated_at DESC)').run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS support_messages_ticket_idx ON support_messages(ticket_id,created_at)').run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS guest_support_tickets (
    id TEXT PRIMARY KEY, access_key TEXT NOT NULL, guest_name TEXT NOT NULL,
    subject TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS guest_support_messages (
    id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL REFERENCES guest_support_tickets(id) ON DELETE CASCADE,
    sender_name TEXT NOT NULL, sender_role TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL
  )`).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS guest_support_key_idx ON guest_support_tickets(access_key)').run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS guest_support_messages_idx ON guest_support_messages(ticket_id,created_at)').run();
}
async function ensureIdentityColumns(env) {
  const columns=await env.DB.prepare('PRAGMA table_info(users)').all();
  const names=new Set((columns.results||[]).map(x=>x.name));
  if(!names.has('original_username')) {
    await env.DB.prepare('ALTER TABLE users ADD COLUMN original_username TEXT').run();
    await env.DB.prepare("UPDATE users SET original_username=username WHERE original_username IS NULL OR original_username=''").run();
  }
}
async function handle(request, env) {
  const url = new URL(request.url), path = url.pathname.replace(/\/+$/, '') || '/', method = request.method;
  if (path.startsWith('/api/scratch/drive/') && method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'access-control-allow-methods': 'GET,HEAD,OPTIONS', 'access-control-allow-headers': 'Content-Type', 'access-control-max-age': '86400' } });
  if (path.startsWith('/api/scratch/drive/')) {
    if (method !== 'GET' && method !== 'HEAD') return json({ error: 'Метод не поддерживается' }, 405);
    const match = path.match(new RegExp("^/api/scratch/drive/([A-Za-z0-9_-]{10,100})$"));
    if (!match) return json({ error: 'Некорректный ID файла Google Drive' }, 400);
    const response = await fetchDriveScratchProject(match[1]);
    if (method === 'HEAD') return new Response(null, { status: response.status, headers: response.headers });
    return response;
  }
  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS', 'access-control-allow-headers': 'Content-Type,Authorization', 'access-control-max-age': '86400' } });
  if (path === '/api/health' && method === 'GET') return json({ ok: true, service: 'StarAlgo API', time: now() });
  // Safe deployment diagnostic: verifies the Pages D1 binding and required schema.
  if (path === '/api/health/db' && method === 'GET') {
    try {
      if (!env.DB) return json({ ok: false, dbBinding: false, error: 'D1 binding DB is missing' }, 503);
      const tableRows = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
      const tables = new Set((tableRows.results || []).map(row => row.name));
      const required = {
        users: ['id','username','username_norm','password_hash','password_salt','password_iterations'],
        sessions: ['token_hash','user_id','expires_at','created_at'],
        projects: ['id','user_id','name','category','published','created_at','updated_at']
      };
      const missing = {};
      for (const [table, columns] of Object.entries(required)) {
        if (!tables.has(table)) { missing[table] = columns; continue; }
        const info = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
        const actual = new Set((info.results || []).map(row => row.name));
        const absent = columns.filter(column => !actual.has(column));
        if (absent.length) missing[table] = absent;
      }
      return json({ ok: Object.keys(missing).length === 0, dbBinding: true, missing, checkedTables: Object.keys(required) });
    } catch (error) {
      console.error('[StarAlgo DB diagnostic]', error?.stack || error);
      return json({ ok: false, dbBinding: !!env.DB, error: 'D1 diagnostic query failed' }, 500);
    }
  }

  // Anonymous technical support: the random access key lets the visitor read replies without an account.
  if (path === '/api/support/guest' && method === 'POST') {
    await ensureSupportSchema(env);
    const body=await readBody(request);
    const guestName=text(body.name || 'Гость',60,'Имя');
    const subject=text(body.subject || 'Обращение в техподдержку',120,'Тема');
    const message=text(body.message,4000,'Сообщение');
    const id=makeId(), accessKey=b64(crypto.getRandomValues(new Uint8Array(24))).replace(/[^A-Za-z0-9]/g,'');
    const stamp=now();
    await env.DB.prepare("INSERT INTO guest_support_tickets(id,access_key,guest_name,subject,status,created_at,updated_at) VALUES(?,?,?,?,'open',?,?)").bind(id,accessKey,guestName,subject,stamp,stamp).run();
    await env.DB.prepare("INSERT INTO guest_support_messages(id,ticket_id,sender_name,sender_role,body,created_at) VALUES(?,?,?,'Гость',?,?)").bind(makeId(),id,guestName,message,stamp).run();
    return json({id,accessKey},201);
  }
  const guestConfirm=path.match(/^\/api\/support\/guest\/([\w-]+)\/confirm$/);
  if(guestConfirm && method==='POST'){
    await ensureSupportSchema(env);
    const body=await readBody(request), key=String(body.key||'');
    if(!/^[A-Za-z0-9]{20,80}$/.test(key)) fail(400,'Некорректный ключ обращения');
    const ticket=await env.DB.prepare('SELECT * FROM guest_support_tickets WHERE id=? AND access_key=?').bind(guestConfirm[1],key).first();
    if(!ticket) fail(404,'Обращение не найдено');
    if(ticket.status!=='waiting_user') fail(409,'Сначала дождитесь ответа техподдержки');
    const stamp=now();
    if(body.resolved===true){
      await env.DB.prepare("UPDATE guest_support_tickets SET status='resolved',updated_at=? WHERE id=?").bind(stamp,ticket.id).run();
      await env.DB.prepare("INSERT INTO guest_support_messages(id,ticket_id,sender_name,sender_role,body,created_at) VALUES(?,?,'Гость','Гость','Пользователь подтвердил: проблема решена.',?)").bind(makeId(),ticket.id,stamp).run();
    }else{
      const note=text(body.message||'Проблема не решена, прошу продолжить помощь.',1000,'Комментарий',true);
      await env.DB.prepare("UPDATE guest_support_tickets SET status='open',updated_at=? WHERE id=?").bind(stamp,ticket.id).run();
      await env.DB.prepare("INSERT INTO guest_support_messages(id,ticket_id,sender_name,sender_role,body,created_at) VALUES(?,?,'Гость','Гость',?,?)").bind(makeId(),ticket.id,note||'Проблема не решена, прошу продолжить помощь.',stamp).run();
    }
    return json({ok:true});
  }
  if (path === '/api/support/guest' && method === 'GET') {
    await ensureSupportSchema(env);
    const key=url.searchParams.get('key')||'';
    if(!/^[A-Za-z0-9]{20,80}$/.test(key)) fail(400,'Некорректный ключ обращения');
    const tickets=await env.DB.prepare('SELECT * FROM guest_support_tickets WHERE access_key=? ORDER BY updated_at DESC LIMIT 20').bind(key).all();
    const result=[];
    for(const t of tickets.results){
      const msgs=await env.DB.prepare('SELECT * FROM guest_support_messages WHERE ticket_id=? ORDER BY created_at').bind(t.id).all();
      result.push({id:t.id,subject:t.subject,status:t.status,username:t.guest_name,createdAt:Number(t.created_at),messages:msgs.results.map(m=>({username:m.sender_name,role:m.sender_role,body:m.body,date:Number(m.created_at)}))});
    }
    return json({tickets:result});
  }

  const user = await authUser(request, env);

  if (path === '/api/avatar/upload' && method === 'POST') {
    if (!user) fail(401, 'Войдите в аккаунт, чтобы загружать изображения');
    if (!env.CLOUDINARY_CLOUD_NAME || !env.CLOUDINARY_API_KEY || !env.CLOUDINARY_API_SECRET) {
      fail(503, 'Загрузка изображений ещё не настроена. Администратору нужно подключить Cloudinary');
    }
    const declared = Number(request.headers.get('Content-Length') || 0);
    const maxAvatarBytes = 10 * 1024 * 1024;
    if (declared > maxAvatarBytes + 65536) fail(413, 'Картинка слишком большая. Максимум — 10 МБ');
    let form;
    try { form = await request.formData(); } catch { fail(400, 'Не удалось прочитать файл изображения'); }
    const file = form.get('file');
    if (!(file instanceof File) || !file.size) fail(400, 'Выберите изображение');
    if (file.size > maxAvatarBytes) fail(413, 'Картинка слишком большая. Максимум — 10 МБ');
    const allowedTypes = new Set(['image/png','image/jpeg','image/webp','image/gif']);
    if (!allowedTypes.has(file.type)) fail(400, 'Поддерживаются PNG, JPG, WEBP и GIF');
    const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    const isPng = head.length >= 8 && [137,80,78,71,13,10,26,10].every((v,i)=>head[i]===v);
    const isJpeg = head.length >= 3 && head[0]===255 && head[1]===216 && head[2]===255;
    const isGif = head.length >= 6 && String.fromCharCode(...head.slice(0,6)).match(/^GIF8[79]a$/);
    const isWebp = head.length >= 12 && String.fromCharCode(...head.slice(0,4))==='RIFF' && String.fromCharCode(...head.slice(8,12))==='WEBP';
    if (!(isPng || isJpeg || isGif || isWebp)) fail(400, 'Файл не похож на PNG, JPG, WEBP или GIF');
    const timestamp = String(Math.floor(Date.now()/1000));
    const purpose = String(form.get('purpose') || 'avatar');
    if (!['avatar','panorama'].includes(purpose)) fail(400, 'Неизвестный тип изображения');
    const folder = purpose === 'panorama' ? 'staralgo/panoramas' : 'staralgo/avatars';
    const publicId = purpose === 'avatar' ? 'user-' + String(user.id).replace(/[^A-Za-z0-9_-]/g, '') : 'user-' + String(user.id).replace(/[^A-Za-z0-9_-]/g, '') + '-' + crypto.randomUUID();
    const params = { folder, overwrite: 'true', public_id: publicId, timestamp };
    const signatureBase = Object.keys(params).sort().map(key => key + '=' + params[key]).join('&') + env.CLOUDINARY_API_SECRET;
    const signature = hex(await crypto.subtle.digest('SHA-1', encoder.encode(signatureBase)));
    const uploadForm = new FormData();
    uploadForm.set('file', file, file.name || 'avatar');
    uploadForm.set('api_key', env.CLOUDINARY_API_KEY);
    uploadForm.set('timestamp', timestamp);
    uploadForm.set('folder', folder);
    uploadForm.set('public_id', publicId);
    uploadForm.set('overwrite', 'true');
    uploadForm.set('signature', signature);
    let cloudResponse, cloudData;
    try {
      cloudResponse = await fetch('https://api.cloudinary.com/v1_1/' + encodeURIComponent(env.CLOUDINARY_CLOUD_NAME) + '/image/upload', { method: 'POST', body: uploadForm });
      cloudData = await cloudResponse.json();
    } catch { fail(502, 'Сервис хранения изображений временно недоступен'); }
    if (!cloudResponse.ok || !cloudData?.secure_url) {
      console.error('[StarAlgo Cloudinary upload]', cloudResponse.status, cloudData?.error?.message || 'upload failed');
      fail(502, 'Не удалось загрузить изображение. Попробуйте ещё раз');
    }
    return json({ secure_url: cloudData.secure_url, format: cloudData.format || '', bytes: cloudData.bytes || file.size });
  }

  if (path === '/api/auth/register' && method === 'POST') {
    const body = await readBody(request);
    if (!env.TURNSTILE_SECRET_KEY) fail(503, 'Защита CAPTCHA ещё не настроена. Попробуйте позже');
    {
      const captchaToken = typeof body.captchaToken === 'string' ? body.captchaToken : '';
      if (!captchaToken) fail(400, 'Подтвердите, что вы не робот');
      const verification = new FormData();
      verification.set('secret', env.TURNSTILE_SECRET_KEY);
      verification.set('response', captchaToken);
      const remoteIp = request.headers.get('CF-Connecting-IP');
      if (remoteIp) verification.set('remoteip', remoteIp);
      let captchaResult;
      try {
        const captchaResponse = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: verification });
        captchaResult = await captchaResponse.json();
      } catch { fail(503, 'Не удалось проверить CAPTCHA. Попробуйте ещё раз'); }
      if (!captchaResult?.success || (captchaResult.hostname && captchaResult.hostname !== 'staralgo.vercel.app')) {
        fail(400, 'Проверка CAPTCHA не пройдена. Попробуйте ещё раз');
      }
    }
    const username = text(body.username, 24, 'Никнейм');
    const password = typeof body.password === 'string' ? body.password : '';
    if (!/^[\p{L}\p{N}_ .-]{3,24}$/u.test(username)) fail(400, 'Никнейм: 3–24 символа, буквы, цифры, пробел, _ . -');
    if (password.length < 8 || password.length > 256) fail(400, 'Пароль должен содержать от 8 до 256 символов');
    const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
    const iterations = 100000;
    const userId = crypto.randomUUID(), stamp = now();
    let stage = 'password_hash';
    try {
      const hash = await passwordHash(password, salt, iterations);
      stage = 'insert_user';
      try {
        await env.DB.prepare(`INSERT INTO users(id,username,username_norm,password_hash,password_salt,password_iterations,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`)
          .bind(userId, username, username.toLowerCase(), hash, salt, iterations, stamp, stamp).run();
      } catch (error) {
        const detail = String(error?.message || error || '');
        if (/unique constraint|unique failed|constraint failed.*username_norm/i.test(detail)) fail(409, 'Этот никнейм уже занят');
        throw error;
      }
      stage = 'read_user';
      const fresh = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(userId).first();
      if (!fresh) throw new Error('INSERT succeeded but SELECT did not return the new user');
      stage = 'create_session';
      const session = await createSession(userId, env);
      return json({ user: publicUser(fresh), ...session }, 201);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      const detail = String(error?.message || error || 'Unknown error').slice(0, 350);
      console.error('[StarAlgo register diagnostic]', { stage, name: error?.name, message: detail, stack: error?.stack });
      return json({ error: 'Внутренняя ошибка сервера' }, 500);
    }
  }
  if (path === '/api/auth/login' && method === 'POST') {
    const body = await readBody(request);
    if (typeof body.username !== 'string' || typeof body.password !== 'string') fail(400, 'Введите никнейм и пароль');
    const found = await userByName(env, body.username.trim());
    if (!found || await passwordHash(body.password, found.password_salt, found.password_iterations) !== found.password_hash) fail(401, 'Неверный никнейм или пароль');
    if (found.is_banned && (!found.ban_until || found.ban_until > now())) fail(403, 'Аккаунт заблокирован');
    return json({ user: publicUser(found), ...(await createSession(found.id, env)) });
  }
  if (path === '/api/auth/me' && method === 'GET') return user ? json({ user: publicUser(user) }) : json({ error:'Не авторизован' },401);
  if(path==='/api/account/username' && method==='POST'){
    if(!user) fail(401,'Войдите в аккаунт');
    const body=await readBody(request), next=text(body.username,24,'Ник');
    if(!/^[A-Za-z0-9_А-Яа-яЁё-]{3,24}$/.test(next)) fail(400,'Ник: 3–24 символа, буквы, цифры, _ или -');
    const existing=await userByName(env,next);
    if(existing && existing.id!==user.id) fail(409,'Этот ник уже занят');
    const old=user.username;
    await env.DB.prepare('UPDATE users SET username=?,username_norm=?,updated_at=? WHERE id=?').bind(next,next.toLowerCase(),now(),user.id).run();
    return json({ok:true,oldUsername:old,user:publicUser(await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(user.id).first())});
  }
  const adminReset=path.match(/^\/api\/admin\/users\/([^/]+)\/password$/);
  if(adminReset && method==='POST'){
    if(!isAdmin(user)) fail(403,'Недостаточно прав');
    const target=await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(adminReset[1]).first();
    if(!target) fail(404,'Пользователь не найден');
    if(isSingularity(target)) fail(403,'Пароль Сингулярности может менять только она сама');
    const generated='SA-'+Array.from(crypto.getRandomValues(new Uint8Array(18)),b=>(b%36).toString(36)).join('')+'!';
    const salt=b64(crypto.getRandomValues(new Uint8Array(16))),iterations=100000;
    const hash=await passwordHash(generated,salt,iterations);
    await env.DB.prepare('UPDATE users SET password_hash=?,password_salt=?,password_iterations=?,updated_at=? WHERE id=?').bind(hash,salt,iterations,now(),target.id).run();
    await env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(target.id).run();
    const encryptedForRecipient={temporaryPassword:generated,forcePasswordChange:true};
    await addNotification(env,target.id,user.id,'password_reset','Администратор сбросил пароль. Скопируйте временный пароль и сразу смените его в профиле.',encryptedForRecipient);
    return json({ok:true,notified:true});
  }
  const singularityPassword=path.match(/^\/api\/singularity\/users\/([^/]+)\/password$/);
  if(singularityPassword && method==='POST'){
    if(!isSingularity(user)) fail(403,'Только Сингулярность может выполнять это действие');
    const target=await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(singularityPassword[1]).first();
    if(!target) fail(404,'Пользователь не найден');
    const body=await readBody(request), chosen=text(body.password,256,'Пароль');
    if(chosen.length<8) fail(400,'Пароль должен содержать минимум 8 символов');
    const salt=b64(crypto.getRandomValues(new Uint8Array(16))),iterations=100000;
    const hash=await passwordHash(chosen,salt,iterations);
    await env.DB.prepare('UPDATE users SET password_hash=?,password_salt=?,password_iterations=?,updated_at=? WHERE id=?').bind(hash,salt,iterations,now(),target.id).run();
    await env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(target.id).run();
    await addNotification(env,target.id,user.id,'password_reset','Сингулярность изменила пароль вашего аккаунта. Если вы этого не ожидали, обратитесь в техподдержку.',{forcePasswordChange:true});
    return json({ok:true});
  }

  if (path === '/api/auth/change-password' && method === 'POST') {
    if(!user) fail(401,'Сначала войдите в аккаунт');
    const body=await readBody(request);
    if(typeof body.currentPassword!=='string'||typeof body.newPassword!=='string') fail(400,'Заполните оба поля');
    if(body.newPassword.length<8||body.newPassword.length>256) fail(400,'Новый пароль должен содержать от 8 до 256 символов');
    if(await passwordHash(body.currentPassword,user.password_salt,user.password_iterations)!==user.password_hash) fail(403,'Текущий пароль указан неверно');
    const salt=b64(crypto.getRandomValues(new Uint8Array(16))),iterations=100000;
    const hash=await passwordHash(body.newPassword,salt,iterations);
    await env.DB.prepare('UPDATE users SET password_hash=?,password_salt=?,password_iterations=?,updated_at=? WHERE id=?').bind(hash,salt,iterations,now(),user.id).run();
    const token=(request.headers.get('Authorization')||'').replace(/^Bearer\s+/i,'');
    const tokenHash=token?await digest(token):'';
    const revoked=await env.DB.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash!=?').bind(user.id,tokenHash).run();
    return json({ok:true,revoked:Number(revoked.meta.changes||0)});
  }

  if (path === '/api/auth/logout' && method === 'POST') {
    const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await digest(token)).run();
    return json({ ok:true });
  }
  if (path === '/api/bootstrap' && method === 'GET') return json(await bootstrap(env, user));
  if (path.startsWith('/api/') && !user && !(method === 'GET' && (path === '/api/feed' || path === '/api/projects' || path === '/api/dwarfs' || path.startsWith('/api/users/') || /^\/api\/projects\/[\w-]+$/.test(path) || /^\/api\/projects\/[\w-]+\/comments$/.test(path) || /^\/api\/dwarfs\/[\w-]+$/.test(path) || /^\/api\/dwarfs\/[\w-]+\/comments$/.test(path)))) fail(401, 'Необходима авторизация');
  if (user?.is_banned && (!user.ban_until || user.ban_until > now()) && !isSingularity(user)) fail(403, 'Аккаунт заблокирован');
  if (path === '/api/support' && method === 'POST') {
    await ensureSupportSchema(env);
    const body=await readBody(request);
    const subject=text(body.subject || 'Обращение в техподдержку',120,'Тема');
    const message=text(body.message,4000,'Сообщение');
    const id=makeId(), stamp=now();
    await env.DB.prepare('INSERT INTO support_tickets(id,user_id,subject,status,created_at,updated_at) VALUES(?,?,?,\'open\',?,?)').bind(id,user.id,subject,stamp,stamp).run();
    await env.DB.prepare('INSERT INTO support_messages(id,ticket_id,sender_id,sender_role,body,created_at) VALUES(?,?,?,?,?,?)').bind(makeId(),id,user.id,user.role,message,stamp).run();
    return json({id},201);
  }
  if (path === '/api/support' && method === 'GET') {
    await ensureSupportSchema(env);
    const rows=await env.DB.prepare(`SELECT t.*,u.username FROM support_tickets t JOIN users u ON u.id=t.user_id
      WHERE t.user_id=? ORDER BY t.updated_at DESC LIMIT 100`).bind(user.id).all();
    const tickets=[];
    for(const row of rows.results){
      const msgs=await env.DB.prepare(`SELECT m.*,u.username FROM support_messages m JOIN users u ON u.id=m.sender_id WHERE m.ticket_id=? ORDER BY m.created_at ASC`).bind(row.id).all();
      tickets.push({id:String(row.id),subject:row.subject,status:row.status,username:row.username,userId:row.user_id,createdAt:Number(row.created_at),updatedAt:Number(row.updated_at),messages:msgs.results.map(m=>({id:String(m.id),username:m.username,role:m.sender_role,body:m.body,date:Number(m.created_at)}))});
    }
    return json({tickets});
  }
  const supportReply=path.match(/^\/api\/support\/([\w-]+)\/reply$/);
  if(supportReply && method==='POST'){
    await ensureSupportSchema(env);
    if(!isStaff(user)) fail(403,'Отвечать на обращения может только команда модерации');
    const body=await readBody(request), message=text(body.message,4000,'Ответ');
    const rawId=supportReply[1], isGuest=rawId.startsWith('guest-'), ticketId=isGuest?rawId.slice(6):rawId;
    const stamp=now();
    if(isGuest){
      const ticket=await env.DB.prepare('SELECT * FROM guest_support_tickets WHERE id=?').bind(ticketId).first();
      if(!ticket) fail(404,'Обращение не найдено');
      await env.DB.prepare("INSERT INTO guest_support_messages(id,ticket_id,sender_name,sender_role,body,created_at) VALUES(?,?,?,'Техподдержка',?,?)").bind(makeId(),ticket.id,user.username,message,stamp).run();
      await env.DB.prepare("UPDATE guest_support_tickets SET status='waiting_user',updated_at=? WHERE id=?").bind(stamp,ticket.id).run();
      return json({ok:true});
    }
    const ticket=await env.DB.prepare('SELECT * FROM support_tickets WHERE id=?').bind(ticketId).first();
    if(!ticket) fail(404,'Обращение не найдено');
    await env.DB.prepare('INSERT INTO support_messages(id,ticket_id,sender_id,sender_role,body,created_at) VALUES(?,?,?,?,?,?)').bind(makeId(),ticket.id,user.id,user.role,message,stamp).run();
    await env.DB.prepare("UPDATE support_tickets SET status='waiting_user',updated_at=? WHERE id=?").bind(stamp,ticket.id).run();
    await addNotification(env,ticket.user_id,user.id,'support_reply','Техподдержка ответила на ваше обращение: '+ticket.subject,{linkType:'support',ticketId:ticket.id});
    return json({ok:true});
  }
  const supportConfirm=path.match(/^\/api\/support\/([\w-]+)\/confirm$/);
  if(supportConfirm && method==='POST'){
    await ensureSupportSchema(env);
    const body=await readBody(request);
    const ticket=await env.DB.prepare('SELECT * FROM support_tickets WHERE id=?').bind(supportConfirm[1]).first();
    if(!ticket || ticket.user_id!==user.id) fail(404,'Обращение не найдено');
    if(ticket.status!=='waiting_user') fail(409,'Сначала дождитесь ответа техподдержки');
    const stamp=now();
    if(body.resolved===true){
      await env.DB.prepare("UPDATE support_tickets SET status='resolved',updated_at=? WHERE id=?").bind(stamp,ticket.id).run();
      await env.DB.prepare('INSERT INTO support_messages(id,ticket_id,sender_id,sender_role,body,created_at) VALUES(?,?,?,?,?,?)').bind(makeId(),ticket.id,user.id,user.role,'Пользователь подтвердил: проблема решена.',stamp).run();
    } else {
      const note=text(body.message || 'Проблема не решена, прошу продолжить помощь.',1000,'Комментарий',true);
      await env.DB.prepare("UPDATE support_tickets SET status='open',updated_at=? WHERE id=?").bind(stamp,ticket.id).run();
      await env.DB.prepare('INSERT INTO support_messages(id,ticket_id,sender_id,sender_role,body,created_at) VALUES(?,?,?,?,?,?)').bind(makeId(),ticket.id,user.id,user.role,note || 'Проблема не решена, прошу продолжить помощь.',stamp).run();
    }
    return json({ok:true});
  }
  const revokeSessions=path.match(/^\/api\/admin\/users\/([\w-]+)\/revoke-sessions$/);
  if(revokeSessions && method==='POST'){
    if(!isAdmin(user)) fail(403,'Только администратор или Сингулярность могут завершать все сессии');
    const target=await env.DB.prepare('SELECT id,role,username FROM users WHERE id=?').bind(revokeSessions[1]).first();
    if(!target || target.role==='[Сингулярность]' && !isSingularity(user)) fail(403,'Недостаточно прав');
    if(target.id===user.id) fail(400,'Нельзя завершить собственную сессию этой кнопкой');
    const result=await env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(target.id).run();
    return json({ok:true,revoked:Number(result.meta.changes||0),username:target.username});
  }


  if (path === '/api/profile' && method === 'GET') return json({ user: await getProfile(env, user, user) });
  if (path === '/api/profile' && method === 'PATCH') {
    const body = await readBody(request);
    const bio = body.bio === undefined ? user.bio : text(body.bio,500,'Описание',true);
    const avatar = body.avatarUrl === undefined ? user.avatar_url : text(body.avatarUrl,350000,'Аватар',true);
    if (avatar && !/^(https:\/\/|data:image\/(png|jpeg|webp|gif);base64,)/i.test(avatar)) fail(400,'Недопустимый формат аватара');
    await env.DB.prepare('UPDATE users SET bio=?,avatar_url=?,updated_at=? WHERE id=?').bind(bio,avatar || null,now(),user.id).run();
    return json({ user: await getProfile(env, await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(user.id).first(), user) });
  }
  const userMatch = path.match(/^\/api\/users\/(.+)$/);
  if (userMatch && method === 'GET' && userMatch[1] !== 'search') {
    let name; try { name = decodeURIComponent(userMatch[1]); } catch { fail(400,'Некорректное имя'); }
    const profile = name.startsWith('id/')
      ? await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(name.slice(3)).first()
      : await userByName(env,name);
    if (!profile) fail(404,'Пользователь не найден');
    return json({ user: await getProfile(env,profile,user) });
  }
  if (path === '/api/users/search' && method === 'GET') {
    const q = (url.searchParams.get('q') || '').trim().slice(0,40).toLowerCase().replace(/[\\%_]/g,'');
    const rows = await env.DB.prepare('SELECT id,username,role,is_supernova,avatar_url,bio FROM users WHERE username_norm LIKE ? ORDER BY username_norm LIMIT 20').bind(`%${q}%`).all();
    return json({ users: rows.results });
  }
  if (path === '/api/projects' && method === 'GET') {
    const own = url.searchParams.get('own') === '1';
    if (own && !user) fail(401,'Необходима авторизация');
    const rows = own
      ? await env.DB.prepare(`SELECT p.*,u.username author,(SELECT COUNT(*) FROM project_likes l WHERE l.project_id=p.id) likes_count,(SELECT COUNT(*) FROM comments c WHERE c.project_id=p.id) comments_count FROM projects p JOIN users u ON u.id=p.user_id WHERE p.user_id=? AND p.deleted_at IS NULL ORDER BY p.updated_at DESC LIMIT 200`).bind(user.id).all()
      : await env.DB.prepare(`SELECT p.id,p.user_id,p.name,p.category,p.description,p.published,p.cover_url,p.project_url,p.views,p.deleted_at,p.was_published,p.created_at,p.updated_at,u.username author,(SELECT COUNT(*) FROM project_likes l WHERE l.project_id=p.id) likes_count,(SELECT COUNT(*) FROM comments c WHERE c.project_id=p.id) comments_count FROM projects p JOIN users u ON u.id=p.user_id WHERE p.published=1 AND p.deleted_at IS NULL ORDER BY p.updated_at DESC LIMIT 100`).all();
    return json({ projects: rows.results.map(r => mapProject(r)) });
  }
  if (path === '/api/projects' && method === 'POST') {
    const body = await readBody(request);
    const name = text(body.name,100,'Название'), category = text(body.category,60,'Категория');
    const description = typeof body.description === 'string' ? body.description.slice(0,4000) : '';
    const coverUrl = validateProjectResourceUrl(body.coverUrl || '', 'Обложка');
    const projectUrl = validateProjectResourceUrl(body.projectUrl || '', 'Ссылка проекта');
    const payload = { data: typeof body.data === 'string' ? body.data.slice(0,200000) : '', sb3Data: typeof body.sb3Data === 'string' ? body.sb3Data.slice(0,400000) : '', sb3Url: validateProjectResourceUrl(body.sb3Url || '', 'Scratch-файл'), isDummy: false };
    const pid = makeId(), stamp = now();
    await env.DB.prepare(`INSERT INTO projects(id,user_id,name,category,description,published,cover_url,project_url,source_text,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(pid,user.id,name,category,description,body.published ? 1 : 0,coverUrl,projectUrl,payload.data,JSON.stringify(payload),stamp,stamp).run();
    await refreshRank(env,user.id);
    const row = await projectRow(env,pid);
    return json({ project: mapProject(row,true) },201);
  }
  const projectMatch = path.match(/^\/api\/projects\/([\w-]+)$/);
  if (projectMatch && method === 'GET') {
    const row = await projectRow(env,projectMatch[1]);
    if (!row || row.deleted_at || (!row.published && (!user || row.user_id !== user.id))) fail(404,'Проект не найден');
    const editorView = url.searchParams.get('edit') === '1' && user && row.user_id === user.id;
    if (!editorView) {
      await env.DB.prepare('UPDATE projects SET views=views+1 WHERE id=?').bind(row.id).run();
      row.views = Number(row.views || 0) + 1;
    }
    return json({ project: await projectDetail(env,row,user) });
  }
  if (projectMatch && method === 'PATCH') {
    const body = await readBody(request), row = await projectRow(env,projectMatch[1]);
    if (!row || row.user_id !== user.id) fail(403,'Нет доступа к проекту');
    const name = body.name === undefined ? row.name : text(body.name,100,'Название');
    const category = body.category === undefined ? row.category : text(body.category,60,'Категория');
    const description = body.description === undefined ? row.description : String(body.description).slice(0,4000);
    const coverCandidate = body.coverUrl === undefined ? row.cover_url : String(body.coverUrl);
    const pUrlCandidate = body.projectUrl === undefined ? row.project_url : String(body.projectUrl);
    // Preserve legacy embedded images when unchanged; all new/changed resource links must use the allowlist.
    const cover = coverCandidate === row.cover_url ? row.cover_url : validateProjectResourceUrl(coverCandidate, 'Обложка');
    const pUrl = pUrlCandidate === row.project_url ? row.project_url : validateProjectResourceUrl(pUrlCandidate, 'Ссылка проекта');
    const payload = parseJson(row.payload_json,{});
    if (body.data !== undefined) payload.data = String(body.data).slice(0,200000);
    if (body.sb3Data !== undefined) payload.sb3Data = String(body.sb3Data).slice(0,400000);
    if (body.sb3Url !== undefined) payload.sb3Url = validateProjectResourceUrl(body.sb3Url, 'Scratch-файл');
    await env.DB.prepare(`UPDATE projects SET name=?,category=?,description=?,published=?,cover_url=?,project_url=?,source_text=?,payload_json=?,updated_at=? WHERE id=?`)
      .bind(name,category,description,body.published === undefined ? row.published : (body.published ? 1 : 0),cover,pUrl,payload.data || '',JSON.stringify(payload),now(),row.id).run();
    await refreshRank(env,user.id);
    return json({ project: mapProject(await projectRow(env,row.id),true) });
  }
  if (projectMatch && method === 'DELETE') {
    const row = await projectRow(env,projectMatch[1]);
    if (!row || row.user_id !== user.id) fail(403,'Нет доступа к проекту');
    await env.DB.prepare('UPDATE projects SET deleted_at=?,was_published=published,published=0,updated_at=? WHERE id=?').bind(now(),now(),row.id).run();
    await refreshRank(env,user.id);
    return json({ ok:true });
  }
  const permanentMatch = path.match(/^\/api\/projects\/([\w-]+)\/permanent$/);
  if (permanentMatch && method === 'DELETE') {
    const row = await projectRow(env,permanentMatch[1]);
    if (!row || row.user_id !== user.id || !row.deleted_at) fail(403,'Нет доступа к проекту');
    await env.DB.prepare('DELETE FROM projects WHERE id=?').bind(row.id).run();
    await refreshRank(env,user.id);
    return json({ok:true});
  }
  const adminProjectDelete = path.match(/^\/api\/admin\/projects\/([\w-]+)\/delete$/);
  if (adminProjectDelete && method === 'POST') {
    if (!isStaff(user)) fail(403,'Нет доступа');
    const row = await projectRow(env,adminProjectDelete[1]);
    if (!row) fail(404,'Проект не найден');
    await env.DB.prepare('UPDATE projects SET deleted_at=?,was_published=published,published=0,updated_at=? WHERE id=?').bind(now(),now(),row.id).run();
    await refreshRank(env,row.user_id);
    return json({ok:true});
  }
  const restoreMatch = path.match(/^\/api\/projects\/([\w-]+)\/restore$/);
  if (restoreMatch && method === 'POST') {
    const row = await projectRow(env,restoreMatch[1]);
    if (!row || row.user_id !== user.id) fail(403,'Нет доступа к проекту');
    await env.DB.prepare('UPDATE projects SET deleted_at=NULL,published=was_published,was_published=0,updated_at=? WHERE id=?').bind(now(),row.id).run();
    return json({ ok:true });
  }
  if (path === '/api/feed' && method === 'GET') {
    const rows = await env.DB.prepare(`SELECT p.id,p.user_id,p.name,p.category,p.description,p.published,p.cover_url,p.project_url,p.views,p.deleted_at,p.was_published,p.created_at,p.updated_at,u.username author,(SELECT COUNT(*) FROM project_likes l WHERE l.project_id=p.id) likes_count,(SELECT COUNT(*) FROM comments c WHERE c.project_id=p.id) comments_count FROM projects p JOIN users u ON u.id=p.user_id WHERE p.published=1 AND p.deleted_at IS NULL ORDER BY p.updated_at DESC LIMIT 100`).all();
    return json({ projects: rows.results.map(r => mapProject(r)) });
  }
  if (path === '/api/follows' && method === 'POST') {
    const body = await readBody(request);
    let target = body.userId ? await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(String(body.userId)).first() : await userByName(env,body.username);
    if (!target || target.id === user.id) fail(400,'Некорректная подписка');
    const existing = await env.DB.prepare('SELECT 1 FROM follows WHERE follower_id=? AND followed_id=?').bind(user.id,target.id).first();
    if (existing) {
      await env.DB.prepare('DELETE FROM follows WHERE follower_id=? AND followed_id=?').bind(user.id,target.id).run();
    } else {
      await env.DB.prepare('INSERT INTO follows(follower_id,followed_id,created_at) VALUES(?,?,?)').bind(user.id,target.id,now()).run();
      await addNotification(env,target.id,user.id,'follow','подписался на вас',{linkType:'profile',targetUser:user.username});
    }
    const counts=await env.DB.prepare('SELECT (SELECT COUNT(*) FROM follows WHERE followed_id=?) followers,(SELECT COUNT(*) FROM follows WHERE follower_id=?) following').bind(target.id,target.id).first();
    return json({following:!existing,userId:target.id,followers:Number(counts.followers||0),followingCount:Number(counts.following||0)});
  }
  const likeMatch = path.match(/^\/api\/projects\/([\w-]+)\/like$/);
  if (likeMatch && method === 'POST') {
    const row = await projectRow(env,likeMatch[1]); if (!row || !row.published || row.deleted_at) fail(404,'Проект не найден');
    const exists = await env.DB.prepare('SELECT 1 FROM project_likes WHERE project_id=? AND user_id=?').bind(row.id,user.id).first();
    if (exists) await env.DB.prepare('DELETE FROM project_likes WHERE project_id=? AND user_id=?').bind(row.id,user.id).run();
    else {
      await env.DB.prepare('INSERT INTO project_likes(project_id,user_id,created_at) VALUES(?,?,?)').bind(row.id,user.id,now()).run();
      await addNotification(env,row.user_id,user.id,'like',`поставил лайк на вашу звезду «${row.name}»`,{linkType:'star',targetAuthor:row.author,targetStarId:row.id});
    }
    const count = await env.DB.prepare('SELECT COUNT(*) n FROM project_likes WHERE project_id=?').bind(row.id).first();
    await refreshRank(env,row.user_id);
    return json({ liked:!exists, likes:count.n });
  }
  const commentsMatch = path.match(/^\/api\/projects\/([\w-]+)\/comments$/);
  if (commentsMatch && method === 'GET') {
    const parentProject = await env.DB.prepare('SELECT id,user_id,published,deleted_at FROM projects WHERE id=?').bind(commentsMatch[1]).first();
    if (!parentProject || parentProject.deleted_at || (!parentProject.published && (!user || parentProject.user_id !== user.id))) fail(404,'Проект не найден');
    const rows = await env.DB.prepare('SELECT c.*,u.username FROM comments c JOIN users u ON u.id=c.user_id WHERE c.project_id=? ORDER BY c.created_at').bind(commentsMatch[1]).all();
    return json({ comments:rows.results.map(mapComment) });
  }
  if (commentsMatch && method === 'POST') {
    const body = await readBody(request), row = await projectRow(env,commentsMatch[1]);
    if (!row || !row.published || row.deleted_at) fail(404,'Проект не найден');
    const value = text(body.body,2000,'Комментарий');
    const parentId = body.parentId ? String(body.parentId) : null;
    let replyTo = null;
    if (parentId) {
      const parent = await env.DB.prepare('SELECT c.*,u.username FROM comments c JOIN users u ON u.id=c.user_id WHERE c.id=? AND c.project_id=?').bind(parentId,row.id).first();
      if (!parent) fail(400,'Ответ на комментарий не найден');
      replyTo = parent.username;
    }
    const cid = makeId(), stamp = now();
    await env.DB.prepare('INSERT INTO comments(id,project_id,user_id,body,parent_id,reply_to_user,created_at) VALUES(?,?,?,?,?,?,?)').bind(cid,row.id,user.id,value,parentId,replyTo,stamp).run();
    await addNotification(env,row.user_id,user.id,'comment',`оставил комментарий в вашей звезде «${row.name}»`,{linkType:'star',targetAuthor:row.author,targetStarId:row.id});
    return json({ comment:{id:String(cid),parentId:parentId ? String(parentId):null,replyToUser:replyTo,author:user.username,text:value,date:stamp} },201);
  }
  const commentDelete = path.match(/^\/api\/comments\/([\w-]+)$/);
  if (commentDelete && method === 'DELETE') {
    const result = await env.DB.prepare(`DELETE FROM comments WHERE id=? AND (user_id=? OR ? IN (SELECT id FROM users WHERE role IN ('[Сингулярность]','[Администратор]','[Модератор]')))`)
      .bind(commentDelete[1],user.id,user.id).run();
    if (!result.meta.changes) fail(404,'Комментарий не найден или нет доступа');
    return json({ok:true});
  }
  if (path === '/api/notifications' && method === 'GET') {
    const rows = await env.DB.prepare(`SELECT n.*,a.username actor,json_extract(n.payload,'$.text') text FROM notifications n LEFT JOIN users a ON a.id=n.actor_id WHERE n.user_id=? ORDER BY n.created_at DESC LIMIT 100`).bind(user.id).all();
    return json({notifications:rows.results.map(mapNotification)});
  }
  if (path === '/api/notifications/read' && method === 'POST') {
    await env.DB.prepare('UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL').bind(now(),user.id).run();
    return json({ok:true});
  }
  if (path === '/api/dwarfs' && method === 'GET') {
    const rows = await env.DB.prepare(`SELECT d.*,u.username author,(SELECT COUNT(*) FROM dwarf_likes l WHERE l.dwarf_id=d.id) likes_count FROM yellow_dwarfs d JOIN users u ON u.id=d.author_id ORDER BY d.created_at DESC LIMIT 100`).all();
    return json({dwarfs:rows.results.map(r=>({id:Number(r.id),name:r.title,description:r.body,coverUrl:r.image_url||'',author:r.author,date:Number(r.created_at),likes:Number(r.likes_count),comments:[]}))});
  }
  if (path === '/api/dwarfs' && method === 'POST') {
    if (!isAdmin(user)) fail(403,'Создавать новости может только администратор');
    const body = await readBody(request), title = text(body.title,120,'Заголовок');
    const idValue = makeId(), stamp = now();
    await env.DB.prepare('INSERT INTO yellow_dwarfs(id,author_id,title,body,image_url,created_at) VALUES(?,?,?,?,?,?)').bind(idValue,user.id,title,String(body.body||'').slice(0,8000),String(body.imageUrl||'').slice(0,350000),stamp).run();
    return json({id:Number(idValue)},201);
  }
  const dwarfMatch = path.match(/^\/api\/dwarfs\/([\w-]+)$/);
  if (dwarfMatch && method === 'GET') {
    const row = await env.DB.prepare(`SELECT d.*,u.username author,(SELECT COUNT(*) FROM dwarf_likes l WHERE l.dwarf_id=d.id) likes_count FROM yellow_dwarfs d JOIN users u ON u.id=d.author_id WHERE d.id=?`).bind(dwarfMatch[1]).first();
    if (!row) fail(404,'Новость не найдена');
    const comments = await env.DB.prepare('SELECT c.*,u.username FROM dwarf_comments c JOIN users u ON u.id=c.user_id WHERE c.dwarf_id=? ORDER BY c.created_at').bind(row.id).all();
    const liked = !!user && !!await env.DB.prepare('SELECT 1 FROM dwarf_likes WHERE dwarf_id=? AND user_id=?').bind(row.id,user.id).first();
    return json({dwarf:{id:Number(row.id),name:row.title,description:row.body,coverUrl:row.image_url||'',author:row.author,date:Number(row.created_at),likes:Number(row.likes_count),liked,comments:comments.results.map(c=>({id:String(c.id),author:c.username,text:c.body,date:Number(c.created_at)}))}});
  }
  if (dwarfMatch && method === 'DELETE') {
    const result = await env.DB.prepare('DELETE FROM yellow_dwarfs WHERE id=? AND (author_id=? OR ? IN (SELECT id FROM users WHERE role IN (\'[Сингулярность]\',\'[Администратор]\',\'[Модератор]\')) )').bind(dwarfMatch[1],user.id,user.id).run();
    if (!result.meta.changes) fail(404,'Нет доступа или запись не найдена');
    return json({ok:true});
  }
  const dwarfLike = path.match(/^\/api\/dwarfs\/([\w-]+)\/like$/);
  if (dwarfLike && method === 'POST') {
    const dwarfExists = await env.DB.prepare('SELECT id FROM yellow_dwarfs WHERE id=?').bind(dwarfLike[1]).first();
    if (!dwarfExists) fail(404,'Новость не найдена');
    const exists = await env.DB.prepare('SELECT 1 FROM dwarf_likes WHERE dwarf_id=? AND user_id=?').bind(dwarfLike[1],user.id).first();
    if (exists) fail(409,'Вы уже оценили эту новость');
    await env.DB.prepare('INSERT INTO dwarf_likes(dwarf_id,user_id,created_at) VALUES(?,?,?)').bind(dwarfLike[1],user.id,now()).run();
    const row = await env.DB.prepare('SELECT COUNT(*) n FROM dwarf_likes WHERE dwarf_id=?').bind(dwarfLike[1]).first();
    return json({likes:row.n});
  }
  const dwarfComments = path.match(/^\/api\/dwarfs\/([\w-]+)\/comments$/);
  if (dwarfComments && method === 'GET') {
    const exists = await env.DB.prepare('SELECT id FROM yellow_dwarfs WHERE id=?').bind(dwarfComments[1]).first();
    if (!exists) fail(404,'Новость не найдена');
    const rows = await env.DB.prepare('SELECT c.*,u.username FROM dwarf_comments c JOIN users u ON u.id=c.user_id WHERE c.dwarf_id=? ORDER BY c.created_at').bind(dwarfComments[1]).all();
    return json({comments:rows.results.map(c=>({id:String(c.id),author:c.username,text:c.body,date:Number(c.created_at)}))});
  }
  if (dwarfComments && method === 'POST') {
    const exists = await env.DB.prepare('SELECT id FROM yellow_dwarfs WHERE id=?').bind(dwarfComments[1]).first();
    if (!exists) fail(404,'Новость не найдена');
    const body = await readBody(request), value = text(body.body,2000,'Комментарий'), cid=makeId(),stamp=now();
    await env.DB.prepare('INSERT INTO dwarf_comments(id,dwarf_id,user_id,body,created_at) VALUES(?,?,?,?,?)').bind(cid,dwarfComments[1],user.id,value,stamp).run();
    return json({comment:{id:String(cid),author:user.username,text:value,date:stamp}},201);
  }
  const dwarfCommentDelete = path.match(/^\/api\/dwarf-comments\/([\w-]+)$/);
  if (dwarfCommentDelete && method === 'DELETE') {
    const result = await env.DB.prepare('DELETE FROM dwarf_comments WHERE id=? AND (user_id=? OR ? IN (SELECT id FROM users WHERE role IN (\'[Сингулярность]\',\'[Администратор]\',\'[Модератор]\')) )').bind(dwarfCommentDelete[1],user.id,user.id).run();
    if (!result.meta.changes) fail(404,'Комментарий не найден или нет доступа');
    return json({ok:true});
  }
  if (path === '/api/reports' && method === 'POST') {
    const body = await readBody(request), type = text(body.type,24,'Тип жалобы'), reason = text(body.reason,2000,'Причина');
    if (!['project','user','comment'].includes(type)) fail(400,'Неизвестный тип жалобы');
    const targetId = String(body.targetId || '');
    let targetUserId = null, targetName = String(body.targetName||'').slice(0,120);
    if (type === 'project') {
      const p = await projectRow(env,targetId); if (!p || p.user_id===user.id) fail(404,'Объект для жалобы не найден');
      targetUserId=p.user_id; targetName=targetName||p.name;
    } else if (type === 'user') {
      const targetUsername=text(body.targetOwner,24,'Пользователь');
      const t=await userByName(env,targetUsername); if (!t || t.id===user.id || isSingularity(t)) fail(404,'Пользователь не найден');
      targetUserId=t.id; targetName=targetName||t.username;
    } else {
      let c=await env.DB.prepare('SELECT c.*,u.role AS comment_author_role FROM comments c JOIN users u ON u.id=c.user_id WHERE c.id=?').bind(targetId).first();
      if (!c) c=await env.DB.prepare('SELECT c.*,u.role AS comment_author_role FROM dwarf_comments c JOIN users u ON u.id=c.user_id WHERE c.id=?').bind(targetId).first();
      if (!c) fail(404,'Комментарий не найден');
      if (String(c.user_id) === String(user.id)) fail(400,'Нельзя пожаловаться на собственный комментарий');
      if (c.comment_author_role === '[Сингулярность]') fail(404,'Комментарий не найден');
      targetUserId=c.user_id;
      targetName=targetName||'Комментарий';
    }
    const rid=makeId();
    await env.DB.prepare('INSERT INTO reports(id,reporter_id,target_type,target_id,target_user_id,target_name,reason,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(rid,user.id,type,targetId,targetUserId,targetName,reason,now()).run();
    return json({id:String(rid)},201);
  }
  if (path === '/api/reports' && method === 'GET') {
    if (!isStaff(user)) fail(403,'Нет доступа');
    const rows = await env.DB.prepare(`SELECT r.*,u.username reporter,t.username target_owner,cpu.username AS comment_parent_owner,
      pc.project_id AS comment_project_id, dc.dwarf_id AS comment_dwarf_id, du.username AS du_username
      FROM reports r
      JOIN users u ON u.id=r.reporter_id
      LEFT JOIN users t ON t.id=r.target_user_id
      LEFT JOIN comments pc ON r.target_type='comment' AND pc.id=r.target_id
      LEFT JOIN projects cp ON cp.id=pc.project_id
      LEFT JOIN users cpu ON cpu.id=cp.user_id
      LEFT JOIN dwarf_comments dc ON r.target_type='comment' AND dc.id=r.target_id
      LEFT JOIN yellow_dwarfs yd ON yd.id=dc.dwarf_id
      LEFT JOIN users du ON du.id=yd.author_id
      WHERE r.status='open' ORDER BY r.created_at DESC LIMIT 100`).all();
    await ensureSupportSchema(env);
    const supportRows=await env.DB.prepare(`SELECT t.*,u.username FROM support_tickets t JOIN users u ON u.id=t.user_id WHERE t.status!='resolved' ORDER BY t.updated_at DESC LIMIT 100`).all();
    const guestRows=await env.DB.prepare("SELECT * FROM guest_support_tickets WHERE status!='resolved' ORDER BY updated_at DESC LIMIT 100").all();
    const supportItems=[];
    const supportMessagesByTicket=new Map();
    if(supportRows.results.length){
      const ids=supportRows.results.map(t=>t.id);
      const messages=await env.DB.prepare(`SELECT m.*,u.username FROM support_messages m JOIN users u ON u.id=m.sender_id WHERE m.ticket_id IN (${ids.map(()=>'?').join(',')}) ORDER BY m.ticket_id,m.created_at ASC`).bind(...ids).all();
      for(const m of messages.results){const key=String(m.ticket_id);if(!supportMessagesByTicket.has(key))supportMessagesByTicket.set(key,[]);supportMessagesByTicket.get(key).push(m);}
    }
    for(const t of supportRows.results){
      const messages=supportMessagesByTicket.get(String(t.id))||[];
      supportItems.push({id:String(t.id),type:'support',targetName:t.subject,targetId:String(t.id),reporter:t.username,reason:messages.map(m=>m.username+': '+m.body).join('\\n'),date:Number(t.created_at),status:t.status,messages:messages.map(m=>({username:m.username,body:m.body,date:Number(m.created_at)}))});
    }
    const guestMessagesByTicket=new Map();
    if(guestRows.results.length){
      const ids=guestRows.results.map(t=>t.id);
      const messages=await env.DB.prepare(`SELECT * FROM guest_support_messages WHERE ticket_id IN (${ids.map(()=>'?').join(',')}) ORDER BY ticket_id,created_at`).bind(...ids).all();
      for(const m of messages.results){const key=String(m.ticket_id);if(!guestMessagesByTicket.has(key))guestMessagesByTicket.set(key,[]);guestMessagesByTicket.get(key).push(m);}
    }
    for(const t of guestRows.results){
      const messages=guestMessagesByTicket.get(String(t.id))||[];
      supportItems.push({id:'guest-'+String(t.id),type:'support_guest',targetName:t.subject,targetId:String(t.id),reporter:t.guest_name,reason:messages.map(m=>m.sender_name+': '+m.body).join('\\n'),date:Number(t.created_at),status:t.status,messages:messages.map(m=>({username:m.sender_name,body:m.body,date:Number(m.created_at)}))});
    }
    const standard=rows.results.map(r=>({
      id:String(r.id),type:r.target_type,targetId:String(r.target_id),targetName:r.target_name,
      targetOwner:r.target_owner||'',targetParentType:r.comment_project_id?'project':r.comment_dwarf_id?'dwarf':'',
      targetParentId:String(r.comment_project_id||r.comment_dwarf_id||''),targetParentOwner:r.comment_parent_owner||(r.du_username||''),
      reporter:r.reporter,reason:r.reason,date:Number(r.created_at)
    }));
    return json({reports:[...supportItems,...standard]});
  }
  const reportMatch = path.match(/^\/api\/reports\/([\w-]+)$/);
  if (reportMatch && method === 'DELETE') {
    if (!isStaff(user)) fail(403,'Нет доступа');
    await env.DB.prepare("UPDATE reports SET status='dismissed' WHERE id=?").bind(reportMatch[1]).run();
    return json({ok:true});
  }
  if (path === '/api/admin/users' && method === 'PATCH') {
    const body=await readBody(request);
    if (!isAdmin(user)) fail(403,'Только администратор может менять роли');
    const target=await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(String(body.userId||'')).first();
    if (!target || target.id===user.id && isSingularity(target)) fail(404,'Пользователь не найден');
    if (target.role==='[Сингулярность]') fail(403,'Нельзя изменить владельца');
    const updates=[] , values=[];
    if (body.role !== undefined) { if (!['[Начинающий]','[Ознакомленный]','[Понимающий]','[Сверхновая]','[Модератор]','[Администратор]'].includes(body.role)) fail(400,'Недопустимая роль'); updates.push('role=?'); values.push(body.role); }
    if (body.isSupernova !== undefined) { updates.push('is_supernova=?'); values.push(body.isSupernova?1:0); }
    if (body.reputation !== undefined) { const rep=Number(body.reputation); if (!Number.isFinite(rep)||rep<0||rep>10) fail(400,'Недопустимая репутация'); updates.push('reputation=?'); values.push(rep); }
    if (body.awards !== undefined) { const awards=Number(body.awards); if (!Number.isInteger(awards)||awards<0||awards>100000) fail(400,'Недопустимое число наград'); updates.push('awards=?'); values.push(awards); }
    if (body.isBanned !== undefined) {
      if (!isAdmin(user) && !isSingularity(user)) fail(403,'Нет доступа');
      const until=body.isBanned ? Number(body.banUntil) : null;
      if (body.isBanned && (!Number.isFinite(until)||until<=now())) fail(400,'Укажите корректный срок блокировки');
      updates.push('is_banned=?','ban_until=?'); values.push(body.isBanned?1:0,until);
    }
    if (updates.length) await env.DB.prepare(`UPDATE users SET ${updates.join(',')},updated_at=? WHERE id=?`).bind(...values,now(),target.id).run();
    return json({user:publicUser(await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(target.id).first())});
  }
  if (path === '/api/mod/users/ban' && method === 'PATCH') {
    if (!isStaff(user)) fail(403,'Нет доступа');
    const body=await readBody(request);
    const target=await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(String(body.userId||'')).first();
    if (!target || target.role==='[Сингулярность]' || target.id===user.id) fail(403,'Нельзя заблокировать этого пользователя');
    if (['[Администратор]','[Модератор]'].includes(target.role) && !isSingularity(user)) fail(403,'Недостаточно прав');
    const until=body.isBanned ? Number(body.banUntil) : null;
    if (body.isBanned) {
      if (!Number.isFinite(until) || until<=now()) fail(400,'Некорректный срок блокировки');
      const duration=until-now();
      if (user.role==='[Модератор]' && duration>3*86400000) fail(403,'Модератор может блокировать максимум на 3 дня');
    }
    await env.DB.prepare('UPDATE users SET is_banned=?,ban_until=?,updated_at=? WHERE id=?').bind(body.isBanned?1:0,until,now(),target.id).run();
    return json({ok:true});
  }
  if (path === '/api/admin/users' && method === 'DELETE') {
    const body=await readBody(request); if (!isAdmin(user)) fail(403,'Нет доступа');
    const target=await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(String(body.userId||'')).first();
    if (!target || target.role==='[Сингулярность]') fail(403,'Нельзя удалить этого пользователя');
    await env.DB.prepare('DELETE FROM users WHERE id=?').bind(target.id).run();
    return json({ok:true});
  }
  if (path.startsWith('/api/admin/reports/') && method === 'POST') {
    if (!isStaff(user)) fail(403,'Нет доступа');
    const rid=path.split('/').pop(), body=await readBody(request);
    const report=await env.DB.prepare('SELECT * FROM reports WHERE id=?').bind(rid).first(); if (!report) fail(404,'Жалоба не найдена');
    if (body.action==='delete-project' && report.target_type==='project') {
      const p=await projectRow(env,report.target_id); if (!p) fail(404,'Проект не найден');
      await env.DB.prepare('UPDATE projects SET deleted_at=?,was_published=published,published=0,updated_at=? WHERE id=?').bind(now(),now(),p.id).run();
    } else if (body.action==='delete-comment' && report.target_type==='comment') {
      const projectComment=await env.DB.prepare('SELECT id,user_id FROM comments WHERE id=?').bind(report.target_id).first();
      if (projectComment) {
        const author=await env.DB.prepare('SELECT role FROM users WHERE id=?').bind(projectComment.user_id).first();
        if (author?.role==='[Сингулярность]') fail(403,'Нельзя удалить комментарий владельца');
        await env.DB.prepare('DELETE FROM comments WHERE id=?').bind(report.target_id).run();
      } else {
        const dwarfComment=await env.DB.prepare('SELECT id,user_id FROM dwarf_comments WHERE id=?').bind(report.target_id).first();
        if (!dwarfComment) fail(404,'Комментарий уже удалён');
        const author=await env.DB.prepare('SELECT role FROM users WHERE id=?').bind(dwarfComment.user_id).first();
        if (author?.role==='[Сингулярность]') fail(403,'Нельзя удалить комментарий владельца');
        await env.DB.prepare('DELETE FROM dwarf_comments WHERE id=?').bind(report.target_id).run();
      }
    } else if (body.action==='ban-user' && report.target_user_id && isAdmin(user)) {
      const until=Number(body.banUntil); if (!Number.isFinite(until)||until<=now()) fail(400,'Некорректный срок бана');
      await env.DB.prepare('UPDATE users SET is_banned=1,ban_until=?,updated_at=? WHERE id=? AND role<>\'[Сингулярность]\'').bind(until,now(),report.target_user_id).run();
    } else if (!(body.action==='resolve-user' && report.target_type==='user')) {
      fail(400,'Действие не поддерживается для этой жалобы');
    }
    await env.DB.prepare("UPDATE reports SET status='resolved' WHERE id=?").bind(rid).run();
    return json({ok:true});
  }
  return json({error:'Маршрут не найден'},404);
}
export default {
  async fetch(request, env) {
    const origin=request.headers.get('Origin')||'';
    const requestUrl = new URL(request.url);
    const publicScratchProxy = new RegExp("^/api/scratch/drive/[A-Za-z0-9_-]{10,100}$").test(requestUrl.pathname) && ['GET','HEAD','OPTIONS'].includes(request.method);
    const configuredOrigin = env.APP_ORIGIN || requestUrl.origin;
    const allowed=publicScratchProxy || (!!origin && (configuredOrigin==='*' || origin===configuredOrigin || (env.ALLOW_PAGES_PREVIEWS==='true' && /^https:\/\/[a-z0-9-]+\.pages\.dev$/i.test(origin))));
    if (origin && !allowed) return json({error:'Origin не разрешён'},403);
    const corsHeaders=publicScratchProxy?{'access-control-allow-origin':'*','access-control-allow-methods':'GET,HEAD,OPTIONS','access-control-allow-headers':'Content-Type','access-control-max-age':'86400'}:(allowed?{'access-control-allow-origin':origin,'vary':'Origin'}:{});
    try {
      const response=await handle(request,env);
      const out=new Response(response.body,response);
      for (const [k,v] of Object.entries(corsHeaders)) out.headers.set(k,v);
      return out;
    } catch(error) {
      if (!(error instanceof HttpError)) console.error('[StarAlgo API]', request.method, new URL(request.url).pathname, error?.stack || error);
      const status=error instanceof HttpError?error.status:500;
      const message=error instanceof HttpError?error.message:'Внутренняя ошибка сервера';
      return json({error:message},status,corsHeaders);
    }
  }
};
