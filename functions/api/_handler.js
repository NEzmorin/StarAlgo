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
function publicUser(row) {
  return {
    id: row.id, username: row.username, role: row.role || '[Начинающий]',
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
  'raw.githubusercontent.com','vercel.app','lh3.googleusercontent.com','docs.google.com',
  'pagedrop.io','boomurl.com','iimg.live','x02.me','roblox.com'
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
    date: Number(row.created_at), read: !!row.read_at };
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
  const comments = await env.DB.prepare(`SELECT c.*,u.username FROM comments c JOIN users u ON u.id=c.user_id WHERE c.project_id=? ORDER BY c.created_at ASC`).bind(row.id).all();
  const likes = await env.DB.prepare(`SELECT u.username FROM project_likes l JOIN users u ON u.id=l.user_id WHERE l.project_id=? ORDER BY l.created_at`).bind(row.id).all();
  const mapped = mapProject({ ...row, comments_data: comments.results.map(mapComment), liked_by: likes.results.map(x => x.username) }, true);
  mapped.isLiked = !!user && likes.results.some(x => x.username.toLowerCase() === user.username.toLowerCase());
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
  const projectRows = await env.DB.prepare(`SELECT p.*,u.username author,
    (SELECT COUNT(*) FROM project_likes l WHERE l.project_id=p.id) likes_count,
    (SELECT COUNT(*) FROM comments c WHERE c.project_id=p.id) comments_count
    FROM projects p JOIN users u ON u.id=p.user_id
    WHERE p.user_id=? AND ${own ? '1=1' : 'p.published=1 AND p.deleted_at IS NULL'} ORDER BY p.updated_at DESC LIMIT 100`).bind(profile.id).all();
  const notifs = own ? await env.DB.prepare(`SELECT n.*,a.username actor,json_extract(n.payload,'$.text') text FROM notifications n LEFT JOIN users a ON a.id=n.actor_id WHERE n.user_id=? ORDER BY n.created_at DESC LIMIT 100`).bind(profile.id).all() : { results: [] };
  const base = publicUser({ ...profile, likes_received: stats.likes_received, projects_count: stats.projects });
  return {
    ...base, projectsList: projectRows.results.filter(p => !p.deleted_at).map(p => mapProject(p)),
    vacuumList: projectRows.results.filter(p => !!p.deleted_at).map(p => mapProject(p)),
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
  const projectsRows = await env.DB.prepare(`SELECT p.*,u.username author,
    (SELECT COUNT(*) FROM project_likes l WHERE l.project_id=p.id) likes_count,
    (SELECT COUNT(*) FROM comments c WHERE c.project_id=p.id) comments_count
    FROM projects p JOIN users u ON u.id=p.user_id WHERE p.published=1 AND p.deleted_at IS NULL
    ORDER BY p.updated_at DESC LIMIT 250`).all();
  const users = {};
  for (const row of usersRows.results) users[row.username.toLowerCase()] = {
    ...publicUser(row), avatarHtml: row.avatar_url ? `<img src="${String(row.avatar_url).replace(/"/g, '&quot;')}" alt="Avatar">` : '',
    projectsList: [], vacuumList: [], followersList: [], followingList: [], notifications: []
  };
  for (const row of projectsRows.results) {
    const key = row.author.toLowerCase();
    if (users[key]) users[key].projectsList.push(mapProject(row));
  }
  let current = null, dwarfs = [], reports = [];
  if (user) {
    current = await getProfile(env, user, user);
    current.avatarHtml = user.avatar_url ? `<img src="${String(user.avatar_url).replace(/"/g, '&quot;')}" alt="Avatar">` : '';
    users[user.username.toLowerCase()] = current;
    const follows = await env.DB.prepare(`SELECT f.followed_id,u.username FROM follows f JOIN users u ON u.id=f.followed_id WHERE f.follower_id=?`).bind(user.id).all();
    const followers = await env.DB.prepare(`SELECT f.follower_id,u.username FROM follows f JOIN users u ON u.id=f.follower_id WHERE f.followed_id=?`).bind(user.id).all();
    current.followingList = follows.results.map(x => x.username.toLowerCase());
    current.followersList = followers.results.map(x => x.username.toLowerCase());
    const notifRows = await env.DB.prepare(`SELECT n.*,a.username actor,json_extract(n.payload,'$.text') text FROM notifications n LEFT JOIN users a ON a.id=n.actor_id WHERE n.user_id=? ORDER BY n.created_at DESC LIMIT 100`).bind(user.id).all();
    current.notifications = notifRows.results.map(mapNotification);
    current.projectsList = current.projectsList.map(p => ({ ...p }));
    dwarfs = (await env.DB.prepare(`SELECT d.*,u.username author,(SELECT COUNT(*) FROM dwarf_likes l WHERE l.dwarf_id=d.id) likes_count,(SELECT COUNT(*) FROM dwarf_comments c WHERE c.dwarf_id=d.id) comments_count FROM yellow_dwarfs d JOIN users u ON u.id=d.author_id ORDER BY d.created_at DESC LIMIT 100`).all()).results.map(r => ({ id:Number(r.id), name:r.title, description:r.body, coverUrl:r.image_url || '', author:r.author, date:Number(r.created_at), likes:Number(r.likes_count), commentsCount:Number(r.comments_count), comments:[] }));
    if (isStaff(user)) reports = (await env.DB.prepare(`SELECT r.*,u.username reporter,coalesce(t.username,'') target_owner FROM reports r JOIN users u ON u.id=r.reporter_id LEFT JOIN users t ON t.id=r.target_user_id WHERE r.status='open' ORDER BY r.created_at DESC LIMIT 100`).all()).results.map(r => ({id:Number(r.id),type:r.target_type,targetId:String(r.target_id),targetName:r.target_name,targetOwner:r.target_owner,reporter:r.reporter,reason:r.reason,date:Number(r.created_at)}));
  } else {
    dwarfs = (await env.DB.prepare(`SELECT d.*,u.username author,(SELECT COUNT(*) FROM dwarf_likes l WHERE l.dwarf_id=d.id) likes_count,(SELECT COUNT(*) FROM dwarf_comments c WHERE c.dwarf_id=d.id) comments_count FROM yellow_dwarfs d JOIN users u ON u.id=d.author_id ORDER BY d.created_at DESC LIMIT 100`).all()).results.map(r => ({ id:Number(r.id), name:r.title, description:r.body, coverUrl:r.image_url || '', author:r.author, date:Number(r.created_at), likes:Number(r.likes_count), commentsCount:Number(r.comments_count), comments:[] }));
  }
  return { user: current, users, dwarfs, reports };
}
async function handle(request, env) {
  const url = new URL(request.url), path = url.pathname.replace(/\/+$/, '') || '/', method = request.method;
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
  const user = await authUser(request, env);

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
  if (path === '/api/auth/logout' && method === 'POST') {
    const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await digest(token)).run();
    return json({ ok:true });
  }
  if (path === '/api/bootstrap' && method === 'GET') return json(await bootstrap(env, user));
  if (path.startsWith('/api/') && !user && !(method === 'GET' && (path === '/api/feed' || path === '/api/projects' || path === '/api/dwarfs' || path.startsWith('/api/users/') || /^\/api\/projects\/[\w-]+$/.test(path) || /^\/api\/projects\/[\w-]+\/comments$/.test(path) || /^\/api\/dwarfs\/[\w-]+$/.test(path) || /^\/api\/dwarfs\/[\w-]+\/comments$/.test(path)))) fail(401, 'Необходима авторизация');
  if (user?.is_banned && (!user.ban_until || user.ban_until > now()) && !isSingularity(user)) fail(403, 'Аккаунт заблокирован');

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
      : await env.DB.prepare(`SELECT p.*,u.username author,(SELECT COUNT(*) FROM project_likes l WHERE l.project_id=p.id) likes_count,(SELECT COUNT(*) FROM comments c WHERE c.project_id=p.id) comments_count FROM projects p JOIN users u ON u.id=p.user_id WHERE p.published=1 AND p.deleted_at IS NULL ORDER BY p.updated_at DESC LIMIT 100`).all();
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
    if (!editorView) await env.DB.prepare('UPDATE projects SET views=views+1 WHERE id=?').bind(row.id).run();
    const updated = await projectRow(env,row.id);
    return json({ project: await projectDetail(env,updated,user) });
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
    if (category !== row.category && ['Roblox','Картинки','Медиа','Видео','Сайт','Разговорник'].includes(category) && !pUrl) fail(400,'Для этого типа проекта нужна внешняя ссылка.');
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
    const rows = await env.DB.prepare(`SELECT p.*,u.username author,(SELECT COUNT(*) FROM project_likes l WHERE l.project_id=p.id) likes_count,(SELECT COUNT(*) FROM comments c WHERE c.project_id=p.id) comments_count FROM projects p JOIN users u ON u.id=p.user_id WHERE p.published=1 AND p.deleted_at IS NULL ORDER BY p.updated_at DESC LIMIT 100`).all();
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
    const parentProject = await projectRow(env,commentsMatch[1]);
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
    return json({reports:rows.results.map(r=>({
      id:String(r.id),type:r.target_type,targetId:String(r.target_id),targetName:r.target_name,
      targetOwner:r.target_owner||'',targetParentType:r.comment_project_id?'project':r.comment_dwarf_id?'dwarf':'',
      targetParentId:String(r.comment_project_id||r.comment_dwarf_id||''),targetParentOwner:r.comment_parent_owner||(r.du_username||''),
      reporter:r.reporter,reason:r.reason,date:Number(r.created_at)
    }))});
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
    const configuredOrigin = env.APP_ORIGIN || new URL(request.url).origin;
    const allowed=!!origin && (configuredOrigin==='*' || origin===configuredOrigin || (env.ALLOW_PAGES_PREVIEWS==='true' && /^https:\/\/[a-z0-9-]+\.pages\.dev$/i.test(origin)));
    if (origin && !allowed) return json({error:'Origin не разрешён'},403);
    const corsHeaders=allowed?{'access-control-allow-origin':origin,'vary':'Origin'}:{};
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
