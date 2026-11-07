/* StarAlgo cloud bridge: authentication and shared data are server-authoritative. */
(() => {
  'use strict';

  const API_ROOT = String(window.STARALGO_API_BASE || '').replace(/\/+$/, '');
  const TOKEN_KEY = 'staralgo_auth_token';
  const LEGACY_KEYS = [
    'staralgo_users_db', 'staralgo_yellow_dwarfs_db', 'staralgo_reports_db'
  ];
  let profileSnapshot = '';
  let pendingProjectSave = null;
  let projectSaveTimer = null;
  let bootstrapped = false;

  function apiUrl(path) { return `${API_ROOT}${path}`; }
  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (options.body !== undefined && !headers.has('Content-Type') && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
    const token = localStorage.getItem(TOKEN_KEY);
    if (token) headers.set('Authorization', `Bearer ${token}`);
    let response;
    try {
      response = await fetch(apiUrl(path), { ...options, headers, cache: 'no-store' });
    } catch (error) {
      throw new Error('Не удалось связаться с сервером StarAlgo. Проверь API-адрес и подключение.');
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Ошибка сервера (${response.status})`);
    return payload;
  }
  function jsonBody(value) { return JSON.stringify(value); }
  function safeImgHtml(url) {
    if (!url) return typeof defaultStarSvg !== 'undefined' ? defaultStarSvg : '';
    const safe = String(url).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<img src="${safe}" alt="Avatar">`;
  }
  function imageUrlFromMarkup(markup) {
    const match = String(markup || '').match(/<img[^>]+src=["']([^"']+)["']/i);
    return match ? match[1] : '';
  }
  function normalizeProject(p) {
    return {
      ...p,
      id: Number(p.id),
      date: Number(p.date || p.created_at || Date.now()),
      likes: Number(p.likes || 0),
      views: Number(p.views || 0),
      comments: Array.isArray(p.comments) ? p.comments : [],
      likedBy: Array.isArray(p.likedBy) ? p.likedBy : [],
      coverUrl: p.coverUrl || '',
      data: p.data || '',
      sb3Data: p.sb3Data || '',
      sb3Url: p.sb3Url || ''
    };
  }
  function normalizeUser(u) {
    if (!u) return null;
    const avatarUrl = u.avatarUrl || u.avatar_url || '';
    return {
      ...u,
      id: u.id,
      username: u.username,
      role: u.role || '[Начинающий]',
      isSupernova: !!u.isSupernova,
      isBanned: !!u.isBanned,
      banUntil: u.banUntil || null,
      reputation: Number(u.reputation ?? 6),
      awards: Number(u.awards || 0),
      likes: Number(u.likes || 0),
      projects: Number(u.projects || 0),
      avatarUrl,
      avatarHtml: safeImgHtml(avatarUrl),
      bio: u.bio || '',
      projectsList: (u.projectsList || []).map(normalizeProject),
      vacuumList: (u.vacuumList || []).map(normalizeProject),
      followingList: u.followingList || [],
      followersList: u.followersList || [],
      notifications: u.notifications || []
    };
  }
  function readObjectCache(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key) || ''); } catch { return fallback; }
  }
  function cacheBootstrap(data) {
    const users = {};
    Object.entries(data.users || {}).forEach(([key, value]) => { users[key] = normalizeUser(value); });
    currentUser = normalizeUser(data.user);
    if (currentUser) users[currentUser.username.toLowerCase()] = currentUser;
    localStorage.setItem('staralgo_users_db', JSON.stringify(users));
    localStorage.setItem('staralgo_yellow_dwarfs_db', JSON.stringify(data.dwarfs || []));
    localStorage.setItem('staralgo_reports_db', JSON.stringify(data.reports || []));
    if (currentUser) {
      const safe = { ...currentUser };
      delete safe.password;
      localStorage.setItem('staralgo_current_session', JSON.stringify(safe));
      profileSnapshot = JSON.stringify({ bio: currentUser.bio, avatarUrl: currentUser.avatarUrl });
    } else {
      localStorage.removeItem('staralgo_current_session');
      profileSnapshot = '';
    }
    return users;
  }
  async function refreshBootstrap(options = {}) {
    const data = await api('/api/bootstrap');
    cacheBootstrap(data);
    if (options.render !== false) {
      if (currentUser) applyUserSession();
      else {
        const auth = document.getElementById('auth-btn');
        const header = document.getElementById('user-header-profile');
        if (auth) auth.style.display = 'block';
        if (header) header.style.display = 'none';
      }
      if (typeof renderZvezdnyFeed === 'function') renderZvezdnyFeed();
      if (typeof renderTelescopeFeed === 'function') renderTelescopeFeed();
      if (typeof updateNavVisibility === 'function') updateNavVisibility();
    }
    return data;
  }
  function storeCurrentUserInCache() {
    if (!currentUser) return;
    const db = readObjectCache('staralgo_users_db', {});
    const safe = { ...currentUser };
    delete safe.password;
    db[currentUser.username.toLowerCase()] = safe;
    localStorage.setItem('staralgo_users_db', JSON.stringify(db));
    localStorage.setItem('staralgo_current_session', JSON.stringify(safe));
  }
  async function syncProfileIfChanged(user) {
    if (!user) return;
    const avatarUrl = user.avatarUrl || imageUrlFromMarkup(user.avatarHtml) || '';
    const snapshot = JSON.stringify({ bio: user.bio || '', avatarUrl });
    if (snapshot === profileSnapshot) return;
    const result = await api('/api/profile', { method: 'PATCH', body: jsonBody({ bio: user.bio || '', avatarUrl }) });
    if (result.user) {
      currentUser = normalizeUser(result.user);
      currentUser.projectsList = user.projectsList || currentUser.projectsList;
      currentUser.vacuumList = user.vacuumList || currentUser.vacuumList;
      currentUser.avatarHtml = safeImgHtml(avatarUrl);
      profileSnapshot = snapshot;
      storeCurrentUserInCache();
    }
  }
  async function loadProject(projectId, editMode = false) {
    const result = await api(`/api/projects/${encodeURIComponent(projectId)}${editMode?'?edit=1':''}`);
    return normalizeProject(result.project);
  }
  function updateLocalProject(project) {
    if (!project) return;
    const normalized = normalizeProject(project);
    const db = readObjectCache('staralgo_users_db', {});
    const key = normalized.author.toLowerCase();
    const owner = db[key] || (currentUser && key === currentUser.username.toLowerCase() ? currentUser : null);
    if (owner) {
      if (!owner.projectsList) owner.projectsList = [];
      const index = owner.projectsList.findIndex(p => Number(p.id) === Number(normalized.id));
      if (index >= 0) owner.projectsList[index] = normalized;
      else owner.projectsList.push(normalized);
      if (currentUser && key === currentUser.username.toLowerCase()) {
        currentUser.projectsList = owner.projectsList;
      }
      db[key] = owner;
      localStorage.setItem('staralgo_users_db', JSON.stringify(db));
    }
    return normalized;
  }
  async function saveProjectNow(project = activeStarObject) {
    if (projectSaveTimer) { clearTimeout(projectSaveTimer); projectSaveTimer = null; }
    if (!project || !currentUser) return false;
    if (String(project.author).toLowerCase() !== currentUser.username.toLowerCase()) return false;
    const snapshot = { ...project };
    const payload = {
      name: snapshot.name,
      category: snapshot.category,
      description: snapshot.description || '',
      published: !!snapshot.published,
      coverUrl: snapshot.coverUrl || '',
      projectUrl: snapshot.projectUrl || '',
      data: snapshot.data || '',
      sb3Data: snapshot.sb3Data || '',
      sb3Url: snapshot.sb3Url || ''
    };
    const previous = pendingProjectSave;
    const task = (async () => {
      if (previous) await previous.catch(() => {});
      return api(`/api/projects/${encodeURIComponent(snapshot.id)}`, { method: 'PATCH', body: jsonBody(payload) });
    })();
    pendingProjectSave = task;
    try {
      const result = await task;
      const next = normalizeProject(result.project);
      next.comments = snapshot.comments || [];
      next.likedBy = snapshot.likedBy || [];
      if (activeStarObject && Number(activeStarObject.id) === Number(snapshot.id)) activeStarObject = next;
      updateLocalProject(next);
      return true;
    } catch (error) {
      console.error(error); alert(error.message); return false;
    }
  }

  // Do not derive any permission from a username in the browser.
  window.isUserSingularity = function(username) {
    const key = String(username || '').toLowerCase();
    const db = readObjectCache('staralgo_users_db', {});
    if (db[key]?.role === '[Сингулярность]') return true;
    return !!currentUser && currentUser.username.toLowerCase() === key && currentUser.role === '[Сингулярность]';
  };
  window.checkAndUpdateUserRole = function(user) {
    if (!user) return;
    user.isSupernova = !!user.isSupernova;
    // Roles are set and checked on the server only.
  };
  window.saveSession = function(user) {
    if (!user) return;
    currentUser = user;
    storeCurrentUserInCache();
    syncProfileIfChanged(user).catch(error => { console.error(error); alert(error.message); });
  };
  window.initApp = async function() {
    if (window.__staralgoCloudInitialized) return;
    window.__staralgoCloudInitialized = true;
    updateRealTime();
    setInterval(updateRealTime, 1000);
    // Local records from the former demo are deliberately not imported.
    LEGACY_KEYS.forEach(key => localStorage.removeItem(key));
    const token = localStorage.getItem(TOKEN_KEY);
    // Restore the last server-confirmed profile immediately while the token is revalidated.
    if (token) {
      const cachedSession = readObjectCache('staralgo_current_session', null);
      if (cachedSession) {
        currentUser = normalizeUser(cachedSession);
        applyUserSession();
      }
    }
    try {
      await refreshBootstrap({ render: false });
      if (token && !currentUser) localStorage.removeItem(TOKEN_KEY);
    } catch (error) {
      console.error('StarAlgo API:', error);
      const errorBox = document.getElementById('auth-error');
      if (errorBox) {
        errorBox.textContent = 'Сервер StarAlgo пока не подключён. Проверь Pages Functions и привязку D1 (DB).';
        errorBox.style.display = 'block';
      }
    }
    setupSoundEffects();
    const userSearchInput = document.getElementById('user-search-input');
    if (userSearchInput) userSearchInput.value = '';
    if (typeof handleUserSearch === 'function') handleUserSearch();
    if (typeof handleStarSearch === 'function') handleStarSearch();
    updateNavVisibility();
    renderZvezdnyFeed();
    renderTelescopeFeed();
    renderReportsInbox();
    if (currentUser) applyUserSession();
    else {
      const auth = document.getElementById('auth-btn');
      const header = document.getElementById('user-header-profile');
      if (auth) auth.style.display = 'block';
      if (header) header.style.display = 'none';
    }
  };
  window.handleAuthSubmit = async function() {
    const username = document.getElementById('auth-username').value.trim();
    const password = document.getElementById('auth-password').value;
    const error = document.getElementById('auth-error');
    if (!username || !password) {
      error.textContent = 'Заполните все поля!'; error.style.display = 'block'; return;
    }
    const button = document.getElementById('modal-submit-btn');
    if (button) button.disabled = true;
    error.style.display = 'none';
    try {
      const result = await api(authMode === 'register' ? '/api/auth/register' : '/api/auth/login', {
        method: 'POST', body: jsonBody({ username, password, captchaToken: window.starAlgoCaptchaToken || '' })
      });
      localStorage.setItem(TOKEN_KEY, result.token);
      window.starAlgoCaptchaToken = '';
      // Show the authenticated account immediately; hydrate the rest in the background.
      currentUser = normalizeUser(result.user);
      applyUserSession();
      closeAuthModal();
      const searchInput = document.getElementById('user-search-input');
      const searchList = document.getElementById('search-results-list');
      if (searchInput) searchInput.value = '';
      if (searchList) searchList.innerHTML = '<div class="empty-placeholder">Начните ввод для поиска пользователей...</div>';
      refreshBootstrap({ render: false }).then(() => {
        if (currentUser) applyUserSession();
        renderZvezdnyFeed();
        renderTelescopeFeed();
      }).catch(err => console.error('StarAlgo background sync:', err));
    } catch (err) {
      error.textContent = err.message;
      error.style.display = 'block';
      if (authMode === 'register') window.refreshStarAlgoCaptcha?.();
    } finally { if (button) button.disabled = false; }
  };
  window.logout = async function() {
    try { await api('/api/auth/logout', { method:'POST', body:'{}' }); } catch (e) { console.warn(e); }
    localStorage.removeItem(TOKEN_KEY);
    currentUser = null;
    viewingUser = null;
    activeStarObject = null;
    await refreshBootstrap({ render:false }).catch(() => {});
    const auth = document.getElementById('auth-btn');
    const header = document.getElementById('user-header-profile');
    if (auth) auth.style.display = 'block';
    if (header) header.style.display = 'none';
    if (['profile','proto','star-editor','reports','dwarf-viewer'].includes(currentTab)) setTab(null,'main','Главная');
    updateNavVisibility();
  };
  window.handleUserSearch = async function() {
    const input = document.getElementById('user-search-input');
    const list = document.getElementById('search-results-list');
    if (!input || !list) return;
    const q = input.value.trim();
    if (!q) { list.innerHTML = '<div class="empty-placeholder">Начните ввод для поиска пользователей...</div>'; return; }
    try {
      const result = await api(`/api/users/search?q=${encodeURIComponent(q)}`);
      const users = result.users || [];
      const db = readObjectCache('staralgo_users_db', {});
      users.forEach(row => {
        const key = row.username.toLowerCase();
        db[key] = normalizeUser({ ...row, isSupernova: !!row.is_supernova, avatarHtml: safeImgHtml(row.avatar_url), projectsList: db[key]?.projectsList || [] });
      });
      localStorage.setItem('staralgo_users_db', JSON.stringify(db));
      list.innerHTML = users.length ? users.map(u => {
        const avatar = safeImgHtml(u.avatar_url);
        const count = db[u.username.toLowerCase()]?.projects || 0;
        return `<div class="search-result-card" onclick="viewUserProfile('${String(u.username).replace(/'/g,"\\'")}')"><div class="search-result-avatar">${avatar}</div><div class="search-result-info"><div class="uname">${u.username}</div><div class="urole">${u.role} | Звёзд: ${count}</div></div></div>`;
      }).join('') : '<div class="empty-placeholder">Пользователи не найдены</div>';
    } catch (e) { list.innerHTML = `<div class="empty-placeholder">${e.message}</div>`; }
  };
  window.viewUserProfile = async function(username) {
    try {
      const result = await api(`/api/users/${encodeURIComponent(username)}`);
      viewingUser = normalizeUser(result.user);
      const db = readObjectCache('staralgo_users_db', {});
      db[viewingUser.username.toLowerCase()] = viewingUser;
      localStorage.setItem('staralgo_users_db', JSON.stringify(db));
      renderProfileData(viewingUser);
      setTab(null,'profile',`Профиль: ${viewingUser.username}`);
    } catch (e) { alert(e.message); }
  };
  window.toggleFollowUser = async function() {
    if (!currentUser || !viewingUser) { openAuthModal(); return; }
    if (String(currentUser.id)===String(viewingUser.id)) return;
    const target=viewingUser, me=currentUser;
    const meKey=me.username.toLowerCase(), targetKey=target.username.toLowerCase();
    const wasFollowing=(me.followingList||[]).includes(targetKey);
    const previousFollowers=target.followersList||[];
    me.followingList=Array.isArray(me.followingList)?me.followingList.slice():[];
    target.followersList=Array.isArray(target.followersList)?target.followersList.slice():[];
    if(wasFollowing){
      me.followingList=me.followingList.filter(x=>String(x).toLowerCase()!==targetKey);
      target.followersList=target.followersList.filter(x=>String(x).toLowerCase()!==meKey);
    } else {
      me.followingList.push(targetKey);
      if(!target.followersList.some(x=>String(x).toLowerCase()===meKey)) target.followersList.push(meKey);
    }
    renderProfileData(target);
    storeCurrentUserInCache();
    try {
      const result=await api('/api/follows',{method:'POST',body:jsonBody({userId:target.id})});
      const isFollowing=!!result.following;
      if(isFollowing!==!wasFollowing){
        me.followingList=me.followingList.filter(x=>String(x).toLowerCase()!==targetKey);
        target.followersList=target.followersList.filter(x=>String(x).toLowerCase()!==meKey);
        if(isFollowing){me.followingList.push(targetKey);target.followersList.push(meKey);}
      }
      target.followersList=target.followersList.filter(x=>String(x).toLowerCase()!==meKey);
      if(isFollowing) target.followersList.push(meKey);
      renderProfileData(target);
      storeCurrentUserInCache();
    } catch(e) {
      me.followingList=wasFollowing?[...new Set([...(me.followingList||[]),targetKey])]:me.followingList.filter(x=>String(x).toLowerCase()!==targetKey);
      target.followersList=previousFollowers;
      renderProfileData(target);
      storeCurrentUserInCache();
      alert(e.message);
    }
  };
  window.handleAvatarUpload = async function(event) {
    const input = event.target;
    const file = input.files?.[0];
    if (!file || !currentUser) return;
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) {
      alert('Выбери PNG, JPG, WEBP или GIF.'); input.value=''; return;
    }
    if (file.size > 10 * 1024 * 1024) {
      alert('Аватарка должна быть не больше 10 МБ.'); input.value=''; return;
    }
    const container = document.getElementById('profile-page-avatar');
    try {
      const body = new FormData();
      body.append('file', file, file.name || 'avatar');
      const uploaded = await api('/api/avatar/upload', { method: 'POST', body });
      const avatarUrl = String(uploaded.secure_url || '');
      if (!/^https:\/\//i.test(avatarUrl)) throw new Error('Сервис вернул некорректную ссылку на аватарку');
      const saved = await api('/api/profile', { method:'PATCH', body:jsonBody({bio:currentUser.bio || '',avatarUrl}) });
      currentUser.avatarUrl = avatarUrl;
      currentUser.avatarHtml = safeImgHtml(avatarUrl);
      if (saved.user) {
        const normalized = normalizeUser(saved.user);
        currentUser = { ...currentUser, ...normalized };
      }
      profileSnapshot = JSON.stringify({bio:currentUser.bio || '',avatarUrl});
      applyAvatarToAll(currentUser.avatarHtml);
      storeCurrentUserInCache();
    } catch (err) {
      alert(err.message || 'Не удалось обновить аватарку');
    } finally {
      input.value = '';
    }
  };
  window.submitCreateProject = async function() {
    if (!currentUser) { openAuthModal(); return; }
    const name = document.getElementById('project-name-input').value.trim();
    const category = document.getElementById('project-category-select').value;
    if (!name) { alert('Введите название звезды!'); return; }
    const projectUrl = '';
    const defaults = category === 'Python'
      ? '# Нарисуем квадрат черепашкой\nimport turtle\nfor i in range(4):\n    turtle.forward(100)\n    turtle.right(90)\n'
      : ['Roblox','Картинки','Медиа','Видео','Сайт','Разговорник','Scratch'].includes(category) ? '' : '// Напишите HTML код здесь';
    const submitButton = document.querySelector('#project-modal .modal-actions .auth-btn');
    if (submitButton) { submitButton.disabled = true; submitButton.dataset.oldLabel = submitButton.textContent; submitButton.textContent = 'Создаём…'; }
    try {
      const createdResult = await api('/api/projects',{method:'POST',body:jsonBody({name,category,description:'',published:false,data:defaults,projectUrl})});
      const createdProject = normalizeProject(createdResult.project);
      currentUser.projectsList = currentUser.projectsList || [];
      currentUser.projectsList.unshift(createdProject);
      document.getElementById('stat-projects').textContent = currentUser.projectsList.length;
      closeCreateProjectModal();
      switchProtoSection(null,'stars');
      // Refresh account data after the modal has already closed; don't make the user wait for bootstrap.
      refreshBootstrap({render:false}).then(() => {
        applyUserSession();
        const stat = document.getElementById('stat-projects');
        if (stat) stat.textContent = currentUser.projectsList.length;
        if (typeof renderProtoStars === 'function') renderProtoStars();
      }).catch(() => {});
    } catch (e) {
      alert(e.message);
    } finally {
      if (submitButton) { submitButton.disabled = false; submitButton.textContent = submitButton.dataset.oldLabel || 'Создать'; }
    }
  };
  window.openStarEditor = async function(projectId) {
    if (!currentUser) { openAuthModal(); return; }
    try {
      const project = await loadProject(projectId, true);
      if (project.author.toLowerCase() !== currentUser.username.toLowerCase()) { alert('Это не ваша звезда.'); return; }
      activeStarObject = project;
      starOpenSource = 'proto';
      document.getElementById('editor-project-title-header').textContent = project.name;
      document.getElementById('star-back-btn').textContent = '← К списку звезд';
      setTab(null,'star-editor',`Настройка звезды: ${project.name}`);
      renderStarRuntime(project,false);
    } catch (e) { alert(e.message); }
  };
  window.viewPublishedStar = async function(authorName, starId) {
    try {
      const project = await loadProject(starId);
      activeStarObject = project;
      starOpenSource = 'hall';
      document.getElementById('editor-project-title-header').textContent = `${project.name} (${project.author || authorName})`;
      document.getElementById('star-back-btn').textContent = '← К Звёздному залу';
      setTab(null,'star-editor',`Звезда: ${project.name}`);
      renderStarRuntime(project, !currentUser || project.author.toLowerCase() !== currentUser.username.toLowerCase());
    } catch (e) { alert(e.message); }
  };
  window.openRobloxGame = function() {
    const input=document.getElementById('roblox-link-input');
    try {
      const url=new URL(input?.value||'');
      if(url.protocol!=='https:' || !['roblox.com','www.roblox.com'].includes(url.hostname) || !/^\/games\/\d+/.test(url.pathname)) throw new Error();
      window.open(url.href,'_blank','noopener,noreferrer');
    } catch { alert('Укажи корректную HTTPS-ссылку на игру Roblox.'); }
  };
  window.viewStarFromProfile = async function(authorName, starId) {
    try {
      const project = await loadProject(starId);
      activeStarObject = project;
      starOpenSource = 'proto';
      document.getElementById('editor-project-title-header').textContent = `${project.name} (${project.author || authorName})`;
      document.getElementById('star-back-btn').textContent = '← К списку звезд';
      setTab(null,'star-editor',`Звезда: ${project.name}`);
      renderStarRuntime(project, !currentUser || project.author.toLowerCase() !== currentUser.username.toLowerCase());
    } catch (e) { alert(e.message); }
  };
  window.saveActiveStarChanges = function() {
    if (!activeStarObject || !currentUser || activeStarObject.author.toLowerCase() !== currentUser.username.toLowerCase()) return;
    updateLocalProject(activeStarObject);
    clearTimeout(projectSaveTimer);
    const snapshot = { ...activeStarObject };
    projectSaveTimer = setTimeout(() => saveProjectNow(snapshot), 900);
  };
  window.likeCurrentStar = async function() {
    if (!currentUser) { openAuthModal(); return; }
    if (!activeStarObject) return;
    try {
      const result = await api(`/api/projects/${activeStarObject.id}/like`,{method:'POST',body:'{}'});
      activeStarObject.likes = Number(result.likes);
      activeStarObject.isLiked = !!result.liked;
      updateLocalProject(activeStarObject);
      const counter = document.getElementById('star-likes-counter');
      if (counter) counter.textContent = result.likes;
      await refreshBootstrap({render:false});
      renderZvezdnyFeed();
    } catch (e) { alert(e.message); }
  };
  window.postComment = async function() {
    if (!currentUser) { openAuthModal(); return; }
    const input = document.getElementById('new-comment-input');
    const body = input?.value.trim();
    if (!body || !activeStarObject) return;
    try {
      const result = await api(`/api/projects/${activeStarObject.id}/comments`,{method:'POST',body:jsonBody({body,parentId:replyingToCommentId})});
      activeStarObject.comments = [...(activeStarObject.comments || []), result.comment];
      activeStarObject.commentsCount = activeStarObject.comments.length;
      updateLocalProject(activeStarObject);
      if (input) { input.value=''; input.placeholder='Написать комментарий...'; }
      replyingToCommentId = null;
      document.getElementById('star-comments-counter').textContent = activeStarObject.comments.length;
      renderCommentsList(activeStarObject);
      renderZvezdnyFeed();
    } catch (e) { alert(e.message); }
  };
  window.deleteComment = async function(commentId) {
    if (!activeStarObject || !confirm('Удалить комментарий?')) return;
    try {
      await api(`/api/comments/${commentId}`,{method:'DELETE'});
      activeStarObject.comments = (activeStarObject.comments || []).filter(c => String(c.id) !== String(commentId));
      activeStarObject.commentsCount = activeStarObject.comments.length;
      updateLocalProject(activeStarObject);
      document.getElementById('star-comments-counter').textContent = activeStarObject.comments.length;
      renderCommentsList(activeStarObject);
    } catch (e) { alert(e.message); }
  };
  window.deleteCurrentProject = async function() {
    if (!activeStarObject || !currentUser) return;
    if (activeStarObject.author.toLowerCase() !== currentUser.username.toLowerCase()) { alert('Нельзя удалить чужую звезду!'); return; }
    if (!confirm('Отправить эту звезду в Вакуум?')) return;
    if (projectSaveTimer) { clearTimeout(projectSaveTimer); projectSaveTimer = null; }
    try {
      if (pendingProjectSave) await pendingProjectSave.catch(() => {});
      await api(`/api/projects/${activeStarObject.id}`,{method:'DELETE'});
      const star = currentUser.projectsList.find(p => Number(p.id) === Number(activeStarObject.id));
      if (star) { currentUser.projectsList = currentUser.projectsList.filter(p => Number(p.id)!==Number(activeStarObject.id)); star.deletedAt=Date.now(); currentUser.vacuumList.push(star); }
      storeCurrentUserInCache();
      closePublishModal();
      setTab(null,'proto','Моё протозвездие');
      switchProtoSection(null,'vacuum');
    } catch (e) { alert(e.message); }
  };
  window.restoreFromVacuum = async function(projectId) {
    try {
      await api(`/api/projects/${projectId}/restore`,{method:'POST',body:'{}'});
      const result = await refreshBootstrap({render:false});
      currentUser = normalizeUser(result.user);
      applyUserSession();
      switchProtoSection(null,'vacuum');
    } catch (e) { alert(e.message); }
  };
  window.permanentlyDeleteFromVacuum = async function(projectId) {
    if (!confirm('Полностью удалить эту звезду без возможности восстановления?')) return;
    try {
      await api(`/api/projects/${projectId}/permanent`,{method:'DELETE'});
      currentUser.vacuumList = currentUser.vacuumList.filter(p => Number(p.id)!==Number(projectId));
      storeCurrentUserInCache();
      switchProtoSection(null,'vacuum');
    } catch (e) { alert(e.message); }
  };
  window.adminDeleteCurrentStar = async function() {
    if (!activeStarObject || !currentUser || !['[Сингулярность]','[Администратор]','[Модератор]'].includes(currentUser.role)) return;
    if (!confirm('Отправить эту звезду в Вакуум?')) return;
    try {
      await api(`/api/admin/projects/${activeStarObject.id}/delete`,{method:'POST',body:'{}'});
      await refreshBootstrap();
      setTab(null,'hall','Звёздный Зал');
    } catch (e) { alert(e.message); }
  };
  window.togglePublishProject = async function() {
    if (!activeStarObject || !currentUser || activeStarObject.author.toLowerCase() !== currentUser.username.toLowerCase()) return;
    activeStarObject.name = document.getElementById('modal-proj-name').value.trim();
    activeStarObject.description = document.getElementById('modal-proj-desc').value;
    activeStarObject.published = !activeStarObject.published;
    try {
      const saved = await saveProjectNow();
      if (!saved) return;
      updatePublishButtonState(activeStarObject.published);
      document.getElementById('editor-project-title-header').textContent = activeStarObject.name;
      document.getElementById('star-detail-name').textContent = activeStarObject.name;
      document.getElementById('star-detail-desc').textContent = activeStarObject.description || 'Без описания...';
      renderZvezdnyFeed();
    } catch (e) { alert(e.message); }
  };
  window.handleSb3Upload = function() {
    alert('Чтобы не занимать место StarAlgo, сначала загрузи .sb3 на Catbox.moe, затем вставь прямую HTTPS-ссылку в поле «Ссылка на .sb3» ниже.');
  };
  window.saveScratchUrl = async function() {
    if (!activeStarObject || !currentUser || activeStarObject.author.toLowerCase() !== currentUser.username.toLowerCase()) return;
    const input = document.getElementById('scratch-project-url');
    const value = String(input?.value || '').trim();
    if (!value) { alert('Вставь прямую ссылку на .sb3 файл.'); return; }
    activeStarObject.sb3Url = value;
    activeStarObject.sb3Data = '';
    try {
      if (await saveProjectNow()) {
        renderLocalScratchPlayer(value);
        const status = document.getElementById('sb3-status-label');
        if (status) status.textContent = 'Внешняя ссылка сохранена';
      }
    } catch (error) { alert(error.message); }
  };
  window.handlePanoramaUpload = async function(event) {
    const input = event.target;
    const file = input.files?.[0];
    if (!file || !activeStarObject || !currentUser) return;
    if (activeStarObject.author.toLowerCase() !== currentUser.username.toLowerCase()) { input.value=''; return; }
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) { alert('Выбери PNG, JPG, WEBP или GIF.'); input.value=''; return; }
    if (file.size > 10 * 1024 * 1024) { alert('Панорама должна быть не больше 10 МБ.'); input.value=''; return; }
    try {
      const body = new FormData();
      body.append('file', file, file.name || 'panorama');
      body.append('purpose', 'panorama');
      const uploaded = await api('/api/avatar/upload', { method:'POST', body });
      const url = String(uploaded.secure_url || '');
      if (!/^https:\/\//i.test(url)) throw new Error('Сервис вернул некорректную ссылку на панораму');
      activeStarObject.coverUrl = url;
      if (await saveProjectNow()) {
        const image = document.getElementById('star-panorama-img');
        const zoom = document.getElementById('zoomed-panorama-img');
        if (image) image.src = url;
        if (zoom) zoom.src = url;
        const status = document.getElementById('panorama-upload-status');
        if (status) status.textContent = 'Панорама загружена и сохранена';
        renderZvezdnyFeed();
      }
    } catch (error) { alert(error.message || 'Не удалось загрузить панораму'); }
    finally { input.value = ''; }
  };
  window.saveCoverUrl = async function() {
    if (!activeStarObject || !currentUser || activeStarObject.author.toLowerCase() !== currentUser.username.toLowerCase()) return;
    const input = document.getElementById('cover-url-input');
    const value = String(input?.value || '').trim();
    if (!value) { alert('Вставь HTTPS-ссылку на обложку с разрешённого сервиса.'); return; }
    activeStarObject.coverUrl = value;
    try {
      if (await saveProjectNow()) {
        const image = document.getElementById('star-panorama-img');
        const zoom = document.getElementById('zoomed-panorama-img');
        if (image) image.src = value;
        if (zoom) zoom.src = value;
        renderZvezdnyFeed();
      }
    } catch (error) { alert(error.message); }
  };
  window.saveProjectResourceUrl = async function() {
    if (!activeStarObject || !currentUser || activeStarObject.author.toLowerCase() !== currentUser.username.toLowerCase()) return;
    const input = document.getElementById('project-resource-url');
    const value = String(input?.value || '').trim();
    if (!value) { alert('Вставь HTTPS-ссылку на внешний ресурс.'); return; }
    activeStarObject.projectUrl = value;
    try { if (await saveProjectNow()) renderStarRuntime(activeStarObject, false); }
    catch (error) { alert(error.message); }
  };
  window.saveProjectMediaUrl = async function() {
    if (!activeStarObject || !currentUser || activeStarObject.author.toLowerCase() !== currentUser.username.toLowerCase()) return;
    const input = document.getElementById('project-media-url');
    const value = String(input?.value || '').trim();
    if (!value) { alert('Вставь HTTPS-ссылку на изображение или GIF.'); return; }
    activeStarObject.projectUrl = value;
    activeStarObject.data = '';
    try { if (await saveProjectNow()) renderStarRuntime(activeStarObject, false); }
    catch (error) { alert(error.message); }
  };
  window.handleImageProjectUpload = function(event) {
    const file=event.target.files?.[0];
    if (!file || !activeStarObject || !currentUser || file.size>250000) { if(file) alert('Изображение должно быть меньше 250 КБ.'); return; }
    if (activeStarObject.author.toLowerCase()!==currentUser.username.toLowerCase()) return;
    const reader=new FileReader();
    reader.onload=async e=>{ activeStarObject.data=String(e.target.result); await saveProjectNow(); renderStarRuntime(activeStarObject,false); };
    reader.readAsDataURL(file);
  };
  window.viewYellowDwarf = async function(dwarfId) {
    try {
      const result=await api(`/api/dwarfs/${dwarfId}`);
      activeDwarfObject=result.dwarf;
      setTab(null,'dwarf-viewer',`Новость: ${activeDwarfObject.name}`);
      renderDwarfRuntime(activeDwarfObject);
    } catch(e) { alert(e.message); }
  };
  window.submitCreateDwarf = async function() {
    const name=document.getElementById('dwarf-name-input').value.trim();
    const description=document.getElementById('dwarf-desc-input').value.trim();
    if(!name||!description){alert('Заполните название и описание!');return;}
    try {
      await api('/api/dwarfs',{method:'POST',body:jsonBody({title:name,body:description,imageUrl:tempDwarfCover||''})});
      closeDwarfCreateModal();
      await refreshBootstrap();
    } catch(e){alert(e.message);}
  };
  window.deleteYellowDwarf = async function(dwarfId) {
    if(!confirm('Удалить этот Жёлтый Карлик?'))return;
    try { await api(`/api/dwarfs/${dwarfId}`,{method:'DELETE'}); await refreshBootstrap(); }
    catch(e){alert(e.message);}
  };
  window.likeCurrentDwarf = async function() {
    if(!currentUser){openAuthModal();return;}
    if(!activeDwarfObject)return;
    try {
      const result=await api(`/api/dwarfs/${activeDwarfObject.id}/like`,{method:'POST',body:'{}'});
      activeDwarfObject.likes=Number(result.likes);
      document.getElementById('dwarf-likes-counter').textContent=activeDwarfObject.likes;
      refreshBootstrap().catch(console.error);
    } catch(e){alert(e.message);}
  };
  window.postDwarfComment = async function() {
    if(!currentUser){openAuthModal();return;}
    const input=document.getElementById('dwarf-comment-input'), body=input?.value.trim();
    if(!body||!activeDwarfObject)return;
    try {
      const result=await api(`/api/dwarfs/${activeDwarfObject.id}/comments`,{method:'POST',body:jsonBody({body})});
      activeDwarfObject.comments.push(result.comment);
      activeDwarfObject.commentsCount=activeDwarfObject.comments.length;
      input.value=''; renderDwarfCommentsList(activeDwarfObject); renderTelescopeFeed();
    } catch(e){alert(e.message);}
  };
  window.deleteDwarfComment = async function(commentId) {
    if(!activeDwarfObject)return;
    try { await api(`/api/dwarf-comments/${commentId}`,{method:'DELETE'}); activeDwarfObject.comments=activeDwarfObject.comments.filter(c=>String(c.id)!==String(commentId)); activeDwarfObject.commentsCount=activeDwarfObject.comments.length; renderDwarfCommentsList(activeDwarfObject); renderTelescopeFeed(); }
    catch(e){alert(e.message);}
  };
  window.openNotificationsModal = async function() {
    if(!currentUser)return;
    try {
      const result=await api('/api/notifications');
      currentUser.notifications=result.notifications||[];
      await api('/api/notifications/read',{method:'POST',body:'{}'});
      currentUser.notifications.forEach(n=>n.read=true);
      storeCurrentUserInCache(); updateBellIndicator();
      const box=document.getElementById('notifications-list-container');
      box.innerHTML=currentUser.notifications.length?currentUser.notifications.map(n=>`<div class="notification-item" onclick="handleNotificationClick('${esc(n.linkType||'')}',decodeURIComponent('${jsName(n.targetUser||'')}'),decodeURIComponent('${jsName(n.targetAuthor||'')}'),${Number(n.targetStarId||0)})" style="cursor:pointer;"><div><span class="notification-actor" style="font-size:1.1rem;">${esc(n.actor||'Система')}</span> ${esc(n.text||'')}</div></div>`).join(''):'<div class="empty-placeholder">Уведомлений пока нет...</div>';
      document.getElementById('notification-modal').classList.add('open');
    } catch(e){alert(e.message);}
  };
  window.submitReport = async function() {
    const reason=document.getElementById('report-reason-input').value.trim();
    if(!reason||!pendingReportData){alert('Укажите причину жалобы!');return;}
    try {
      await api('/api/reports',{method:'POST',body:jsonBody({...pendingReportData,reason})});
      alert('Жалоба отправлена модераторам.'); closeReportModal();
    } catch(e){alert(e.message);}
  };
  window.renderReportsInbox = async function() {
    const grid=document.getElementById('reports-grid-container');
    if(!grid)return;
    if(!currentUser||!['[Сингулярность]','[Администратор]','[Модератор]'].includes(currentUser.role)){
      grid.innerHTML='<div class="empty-placeholder">Нет доступа.</div>';return;
    }
    try {
      const result=await api('/api/reports'); const reports=result.reports||[];
      localStorage.setItem('staralgo_reports_db',JSON.stringify(reports));
      if(!reports.length){grid.innerHTML='<div class="empty-placeholder">Жалоб пока нет. Всё спокойно в космосе!</div>';return;}
      grid.innerHTML=reports.map(r=>`<div class="report-card" id="report-${r.id}"><div class="report-header"><span>Тип: <strong>${String(r.type).toUpperCase()}</strong> | Объект: ${esc(r.targetName||'N/A')}</span><span>От: ${esc(r.reporter)}</span></div><div><strong>Причина:</strong> ${esc(r.reason)}</div><div style="display:flex;gap:8px;margin-top:5px;"><button class="auth-btn" onclick="openReportTarget('${r.type}','${r.targetId}','${jsName(r.targetOwner||'')}','${r.targetParentType||''}','${r.targetParentId||''}','${jsName(r.targetParentOwner||'')}')">Перейти к объекту</button><button class="auth-btn" style="color:#ff5555;border-color:#ff5555;" onclick="resolveReport('${r.id}','${r.type}','${r.targetId}','${jsName(r.targetOwner||'')}')">Обработать</button><button class="auth-btn" onclick="dismissReport('${r.id}')">Отклонить</button></div></div>`).join('');
    } catch(e){grid.innerHTML=`<div class="empty-placeholder">${e.message}</div>`;}
  };
  window.openReportTarget = async function(type,targetId,targetOwnerEncoded,parentType,parentId,parentOwnerEncoded) {
    const owner=decodeURIComponent(targetOwnerEncoded||'');
    const parentOwner=decodeURIComponent(parentOwnerEncoded||'');
    try {
      if(type==='project') { await viewPublishedStar(owner,targetId); return; }
      if(type==='user') { await viewUserProfile(owner); return; }
      if(type==='comment') {
        if(parentType==='dwarf') {
          await viewYellowDwarf(parentId);
          requestAnimationFrame(()=>document.getElementById('dwarf-comment-'+CSS.escape(String(targetId)))?.scrollIntoView({behavior:'smooth',block:'center'}));
        } else if(parentType==='project') {
          await viewPublishedStar(parentOwner,parentId);
          requestAnimationFrame(()=>document.getElementById('comment-'+CSS.escape(String(targetId)))?.scrollIntoView({behavior:'smooth',block:'center'}));
        } else alert('Не удалось определить публикацию, к которой относится комментарий.');
      }
    } catch(e) { alert(e.message); }
  };
  window.dismissReport = async function(reportId) {
    try { await api(`/api/reports/${reportId}`,{method:'DELETE'}); renderReportsInbox(); }
    catch(e){alert(e.message);}
  };
  window.resolveReport = async function(reportId,type,targetId,targetOwner) {
    const action=type==='project'?'delete-project':type==='comment'?'delete-comment':'resolve-user';
    const promptText=type==='project'?'Отправить проект в Вакуум?':type==='comment'?'Удалить этот комментарий и закрыть жалобу?':'Отметить жалобу на пользователя как обработанную?';
    if(!confirm(promptText))return;
    try {
      await api(`/api/admin/reports/${reportId}`,{method:'POST',body:jsonBody({action})});
      await refreshBootstrap({render:false});
      renderReportsInbox();
      if(type==='comment' && activeDwarfObject) {
        const d=await api(`/api/dwarfs/${activeDwarfObject.id}`);
        activeDwarfObject=d.dwarf; renderDwarfCommentsList(activeDwarfObject);
      }
    } catch(e){alert(e.message);}
  };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  window.saEscapeHTML = esc;
  const jsName = value => encodeURIComponent(String(value || '')).replace(/'/g,'%27');

  // Render untrusted community content as text, never as markup.
  window.renderCommentsList = function(project) {
    const box=document.getElementById('star-comments-list');
    if(!box)return;
    const comments=project.comments||[];
    if(!comments.length){box.innerHTML='<div class="empty-placeholder">Пока нет комментариев...</div>';return;}
    box.innerHTML=comments.map(c=>{
      const mine=currentUser && currentUser.username.toLowerCase()===String(c.author).toLowerCase();
      return `<div class="comment-item${c.parentId?' comment-reply-item':''}" id="comment-${esc(c.id)}"><div class="comment-header-row"><span class="comment-author" onclick="viewUserProfile(decodeURIComponent('${jsName(c.author)}'))">${esc(c.author)}</span><div class="comment-actions-row"><button class="comment-action-btn" onclick="setReplyTo('${jsName(c.id)}',decodeURIComponent('${jsName(c.author)}'))">Ответить</button>${!mine?`<button class="comment-action-btn" style="color:#ff5555;" onclick="openReportModal('comment',decodeURIComponent('${jsName(c.id)}'),'Комментарий',decodeURIComponent('${jsName(c.author)}'),'project',${Number(project.id)})">⚠️</button>`:''}${(mine||(currentUser&&['[Сингулярность]','[Администратор]','[Модератор]'].includes(currentUser.role)))?`<button class="comment-action-btn" style="color:#ff5555;" onclick="deleteComment(decodeURIComponent('${jsName(c.id)}'))">Удалить</button>`:''}</div></div><div>${c.replyToUser?`<span style="opacity:.7;font-size:.9rem;">Ответ для @${esc(c.replyToUser)}:</span><br>`:''}${esc(c.text)}</div></div>`;
    }).join('');
  };
  window.renderDwarfCommentsList = function(dwarf) {
    const box=document.getElementById('dwarf-comments-list');
    if(!box)return;
    const comments=dwarf.comments||[];
    if(!comments.length){box.innerHTML='<div class="empty-placeholder">Пока нет комментариев...</div>';return;}
    box.innerHTML=comments.map(c=>{
      const mine=currentUser && currentUser.username.toLowerCase()===String(c.author).toLowerCase();
      return `<div class="comment-item" id="dwarf-comment-${esc(c.id)}"><div class="comment-header-row"><span class="comment-author" onclick="viewUserProfile(decodeURIComponent('${jsName(c.author)}'))">${esc(c.author)}</span><div class="comment-actions-row">${!mine?`<button class="comment-action-btn" style="color:#ff5555;" onclick="openReportModal('comment',decodeURIComponent('${jsName(c.id)}'),'Комментарий к новости',decodeURIComponent('${jsName(c.author)}'),'dwarf',${Number(dwarf.id)})">⚠️</button>`:''}${(mine||(currentUser&&['[Сингулярность]','[Администратор]','[Модератор]'].includes(currentUser.role)))?`<button class="comment-action-btn" style="color:#ff5555;" onclick="deleteDwarfComment('${jsName(c.id)}')">Удалить</button>`:''}</div></div><div>${esc(c.text)}</div></div>`;
    }).join('');
  };
  window.renderZvezdnyFeed = function() {
    const db=readObjectCache('staralgo_users_db',{});
    let projects=Object.values(db).flatMap(u=>u.projectsList||[]).filter(p=>p.published);
    const now=Date.now();
    const periodMs=currentPeriodFilter==='week'?7*86400000:currentPeriodFilter==='month'?30*86400000:86400000;
    const top=projects.filter(p=>now-(p.date||0)<=periodMs).sort((a,b)=>(b.likes||0)-(a.likes||0)).slice(0,3);
    const topBox=document.getElementById('constellation-display-box');
    if(topBox) topBox.innerHTML=top.length?`<div class="constellation-top-cards">${top.map(p=>`<div class="feed-star-card" style="width:200px;" onclick="viewPublishedStar(decodeURIComponent('${jsName(p.author)}'),${Number(p.id)})"><img src="${esc(p.coverUrl||generateRandomPanorama(p.name+p.id))}" class="star-cover-preview" style="height:90px;" alt="Cover"><div class="feed-star-title" style="font-size:1.1rem;">${esc(p.name)}</div><div class="feed-star-author">Автор: ${esc(p.author)}${db[String(p.author).toLowerCase()]?.isSupernova?' ⭐':''}</div><div style="color:var(--gold-bright);">❤️ ${Number(p.likes||0)} лайков</div></div>`).join('')}</div>`:`<span style="font-size:1.2rem;opacity:.7;">В созвездиях пока нет популярных звёзд за этот период (${esc(currentPeriodFilter)}).</span>`;
    if(currentHallCategory!=='all') projects=projects.filter(p=>p.category===currentHallCategory);
    if(currentSortFilter==='popular') projects.sort((a,b)=>(b.likes||0)-(a.likes||0));
    else if(currentSortFilter==='discussed') projects.sort((a,b)=>(b.commentsCount||b.comments?.length||0)-(a.commentsCount||a.comments?.length||0));
    else if(currentSortFilter==='supernovas') projects.sort((a,b)=>(db[String(b.author).toLowerCase()]?.isSupernova?1:0)-(db[String(a.author).toLowerCase()]?.isSupernova?1:0));
    else projects.sort((a,b)=>(b.date||0)-(a.date||0));
    const grid=document.getElementById('zvezdny-feed-grid');
    if(!grid)return;
    grid.innerHTML=projects.length?projects.map(p=>`<div class="feed-star-card" onclick="viewPublishedStar(decodeURIComponent('${jsName(p.author)}'),${Number(p.id)})"><img src="${esc(p.coverUrl||generateRandomPanorama(p.name+p.id))}" class="star-cover-preview" alt="Cover"><div class="feed-star-title">${esc(p.name)}</div><div class="feed-star-author">Автор: ${esc(p.author)}${db[String(p.author).toLowerCase()]?.isSupernova?' ⭐':''} [${esc(p.category)}]</div><div style="display:flex;justify-content:space-between;font-size:1rem;color:var(--gold-bright);margin-top:4px;"><span>❤️ ${Number(p.likes||0)}</span><span>💬 ${Number(p.commentsCount||p.comments?.length||0)}</span><span>👁 ${Number(p.views||0)}</span></div></div>`).join(''):'<div class="empty-placeholder">В Звёздном зале пока нет опубликованных звёзд.</div>';
  };
  window.renderProtoProjectsView = function(container) {
    if(!currentUser||!container)return;
    const projects=currentUser.projectsList||[];
    const categories=[...new Set(projects.map(p=>p.category))];
    const tabHtml=[`<button class="proto-tab-pill ${activeProtoCategory==='all'?'active':''}" onclick="filterProtoTab(event,'all')">Все</button>`,...categories.map(cat=>`<button class="proto-tab-pill ${activeProtoCategory===cat?'active':''}" onclick="filterProtoTab(event,decodeURIComponent('${jsName(cat)}'))">${esc(cat)}</button>`)].join('');
    const filtered=activeProtoCategory==='all'?projects:projects.filter(p=>p.category===activeProtoCategory);
    const cards=filtered.length?filtered.map(p=>`<div class="project-item-card" onclick="openStarEditor(${Number(p.id)})"><img src="${esc(p.coverUrl||generateRandomPanorama(p.name+p.id))}" class="star-cover-preview" alt="Cover"><div class="project-item-title">${esc(p.name)}</div><div class="project-item-cat">Основа: ${esc(p.category)} ${p.published?'🌐':''}</div></div>`).join(''):'<div class="empty-placeholder" style="grid-column:1/-1;margin-top:20px;">Нет звёзд в этой категории.</div>';
    container.innerHTML=`<div class="proto-top-bar"><h1 class="page-title" style="margin-bottom:0;">Звёзды</h1><div class="proto-controls"><span class="proto-sort-label">Сортировать</span><button class="proto-btn-pill" disabled>↓ Дата</button><button class="proto-btn-pill" disabled>↓ А-Я</button><button class="proto-create-btn" onclick="openCreateProjectModal()">+ Создать</button></div></div><div class="proto-tabs-row" id="proto-category-tabs">${tabHtml}</div><div class="proto-projects-grid" id="proto-projects-grid">${cards}</div>`;
  };
  window.renderProtoVacuumView = function(container) {
    if(!currentUser||!container)return;
    const items=currentUser.vacuumList||[];
    const cards=items.length?items.map(p=>`<div class="project-item-card" style="border-color:#ff5555;"><img src="${esc(p.coverUrl||generateRandomPanorama(p.name+p.id))}" class="star-cover-preview" alt="Cover"><div class="project-item-title">${esc(p.name)}</div><div class="project-item-cat">Удалено: ${new Date(p.deletedAt||Date.now()).toLocaleDateString()}</div><div style="display:flex;gap:6px;margin-top:6px;"><button class="auth-btn" style="flex:1;font-size:1rem;padding:4px;" onclick="restoreFromVacuum(${Number(p.id)})">Достать</button><button class="auth-btn" style="flex:1;font-size:1rem;padding:4px;color:#ff5555;border-color:#ff5555;" onclick="permanentlyDeleteFromVacuum(${Number(p.id)})">Удалить</button></div></div>`).join(''):'<div class="empty-placeholder" style="grid-column:1/-1;margin-top:20px;">Вакуум пуст. Удаленные звёзды хранятся здесь до 6 месяцев.</div>';
    container.innerHTML=`<div class="proto-top-bar"><h1 class="page-title" style="margin-bottom:0;">Вакуум</h1></div><p class="page-text" style="font-size:1.1rem;margin-bottom:10px;">Здесь хранятся удалённые проекты (до 6 месяцев).</p><div class="proto-projects-grid">${cards}</div>`;
  };
  window.renderTelescopeFeed = function() {
    const grid=document.getElementById('telescope-feed-grid');
    if(!grid)return;
    const dwarfs=readObjectCache('staralgo_yellow_dwarfs_db',[]).slice().sort((a,b)=>(b.date||0)-(a.date||0));
    if(!dwarfs.length){grid.innerHTML='<div class="empty-placeholder">Новости (Жёлтые Карлики) пока отсутствуют...</div>';return;}
    const db=readObjectCache('staralgo_users_db',{});
    grid.innerHTML=dwarfs.map(d=>`<div class="dwarf-banner-card" onclick="viewYellowDwarf(${Number(d.id)})"><img src="${esc(d.coverUrl||generateYellowDwarfPanorama(d.name+d.id))}" class="dwarf-cover-large" alt="Cover"><div style="display:flex;justify-content:space-between;align-items:center;"><div class="feed-star-title" style="font-size:1.8rem;">${esc(d.name)}</div>${currentUser&&(currentUser.username.toLowerCase()===String(d.author).toLowerCase()||['[Сингулярность]','[Администратор]','[Модератор]'].includes(currentUser.role))?`<button class="auth-btn" style="color:#ff5555;border-color:#ff5555;" onclick="event.stopPropagation();deleteYellowDwarf(${Number(d.id)})">🗑 Удалить</button>`:''}</div><div class="feed-star-author">Автор: ${esc(d.author)}${db[String(d.author).toLowerCase()]?.isSupernova?' ⭐':''} [Жёлтый Карлик]</div><div class="feed-star-desc" style="font-size:1.2rem;">${esc(d.description)}</div><div style="display:flex;justify-content:space-between;font-size:1.1rem;color:var(--gold-bright);margin-top:8px;border-top:1px dashed rgba(212,178,54,.3);padding-top:8px;"><span>❤️ ${Number(d.likes||0)} лайков</span><span>💬 ${Number(d.commentsCount||0)} комментариев</span><span>📅 ${new Date(d.date).toLocaleDateString()}</span></div></div>`).join('');
  };
  window.handleDwarfCoverUpload = function(event) {
    const file=event.target.files?.[0]; if(!file)return;
    if(!file.type.startsWith('image/')||file.size>250000){alert('Обложка должна быть изображением размером до 250 КБ.');return;}
    const reader=new FileReader(); reader.onload=e=>{tempDwarfCover=String(e.target.result);document.getElementById('dwarf-cover-status').textContent='Панорама успешно загружена!';}; reader.readAsDataURL(file);
  };

  // Admin controls call protected endpoints. Client-side edits never grant privileges.
  window.initSingularityAdminPanel = function() {
    if(!currentUser||currentUser.role!=='[Сингулярность]')return;
    const select=document.getElementById('admin-user-select'); if(!select)return;
    const db=readObjectCache('staralgo_users_db',{});
    select.innerHTML='<option value="">-- Выбрать --</option>'+Object.values(db).map(u=>`<option value="${esc(u.username)}">${esc(u.username)} (${esc(u.role)})</option>`).join('');
  };
  window.loadAdminUserData = function(username) {
    const form=document.getElementById('admin-user-edit-form'); if(!form)return;
    if(!username){form.style.display='none';return;}
    const u=readObjectCache('staralgo_users_db',{})[String(username).toLowerCase()]; if(!u)return;
    document.getElementById('admin-edit-rep').value=u.reputation||6;
    document.getElementById('admin-edit-likes').value=u.likes||0;
    document.getElementById('admin-edit-likes').readOnly=true;
    document.getElementById('admin-edit-likes').title='Количество лайков считается сервером автоматически';
    document.getElementById('admin-edit-awards').value=u.awards||0;
    document.getElementById('admin-edit-role').value=u.role||'[Начинающий]';
    form.style.display='flex';
  };
  window.saveAdminUserData = async function() {
    const username=document.getElementById('admin-user-select')?.value;
    const u=readObjectCache('staralgo_users_db',{})[String(username||'').toLowerCase()]; if(!u)return;
    try {
      await api('/api/admin/users',{method:'PATCH',body:jsonBody({userId:u.id,reputation:Number(document.getElementById('admin-edit-rep').value),awards:Number(document.getElementById('admin-edit-awards').value),role:document.getElementById('admin-edit-role').value})});
      await refreshBootstrap(); alert(`Параметры пользователя ${u.username} обновлены!`);
    } catch(e){alert(e.message);}
  };
  window.applyRoleChange = async function(username) {
    const u=readObjectCache('staralgo_users_db',{})[String(username).toLowerCase()]; if(!u)return;
    try { await api('/api/admin/users',{method:'PATCH',body:jsonBody({userId:u.id,role:document.getElementById('role-change-select').value})}); await refreshBootstrap(); await viewUserProfile(username); }
    catch(e){alert(e.message);}
  };
  window.toggleSupernova = async function(username) {
    const u=readObjectCache('staralgo_users_db',{})[String(username).toLowerCase()]; if(!u)return;
    try { await api('/api/admin/users',{method:'PATCH',body:jsonBody({userId:u.id,isSupernova:!u.isSupernova})}); await refreshBootstrap(); await viewUserProfile(username); }
    catch(e){alert(e.message);}
  };
  window.openModBanModal = function(username) {
    pendingBanUsername = username;
    const u=readObjectCache('staralgo_users_db',{})[String(username).toLowerCase()];
    if(!u || u.role==='[Сингулярность]') return;
    if(u.isBanned || (u.banUntil && Date.now()<u.banUntil)) {
      if(confirm('Разблокировать пользователя?')) {
        api('/api/mod/users/ban',{method:'PATCH',body:jsonBody({userId:u.id,isBanned:false})})
          .then(()=>refreshBootstrap().then(()=>viewUserProfile(username)))
          .catch(e=>alert(e.message));
      }
      return;
    }
    document.getElementById('ban-days').value=0;
    document.getElementById('ban-hours').value=0;
    document.getElementById('ban-minutes').value=0;
    document.getElementById('ban-seconds').value=0;
    document.getElementById('mod-ban-modal').classList.add('open');
  };
  window.confirmModBan = async function() {
    if(!pendingBanUsername)return;
    const u=readObjectCache('staralgo_users_db',{})[String(pendingBanUsername).toLowerCase()]; if(!u)return;
    const days=Number(document.getElementById('ban-days').value)||0;
    const hours=Number(document.getElementById('ban-hours').value)||0;
    const minutes=Number(document.getElementById('ban-minutes').value)||0;
    const seconds=Number(document.getElementById('ban-seconds').value)||0;
    const duration=((days*86400)+(hours*3600)+(minutes*60)+seconds)*1000;
    if(duration<=0){alert('Укажите срок бана!');return;}
    try { await api('/api/mod/users/ban',{method:'PATCH',body:jsonBody({userId:u.id,isBanned:true,banUntil:Date.now()+duration})}); closeModBanModal(); await refreshBootstrap(); await viewUserProfile(pendingBanUsername||u.username); }
    catch(e){alert(e.message);}
  };
  window.deleteUserAccount = async function(username) {
    const u=readObjectCache('staralgo_users_db',{})[String(username).toLowerCase()]; if(!u)return;
    if(!confirm(`Удалить аккаунт ${username}?`))return;
    try { await api('/api/admin/users',{method:'DELETE',body:jsonBody({userId:u.id})}); await refreshBootstrap(); setTab(null,'main','Главная'); }
    catch(e){alert(e.message);}
  };
  window.generateDummyProjects = function(){alert('Тестовые заглушки отключены в серверной версии.');};
  window.deleteAllDummyProjects = function(){alert('Тестовые заглушки отключены в серверной версии.');};
  window.runPythonReadonlyResult = function(code) {
    const canvasBox=document.getElementById('turtle-graphics-canvas-container');
    const outputBox=document.getElementById('python-console-output');
    if(!canvasBox||!outputBox)return;
    canvasBox.innerHTML='';
    const frame=document.createElement('iframe');
    frame.title='Изолированный запуск Python';
    frame.setAttribute('sandbox','allow-scripts');
    frame.style.cssText='width:100%;height:100%;min-height:190px;border:0;background:#fff;';
    canvasBox.appendChild(frame);
    outputBox.textContent='Python выполняется в изолированном окне.';
    const encoded=btoa(unescape(encodeURIComponent(String(code||''))));
    frame.srcdoc=`<!doctype html><html><head><meta charset="utf-8"><script src="https://cdnjs.cloudflare.com/ajax/libs/brython/3.11.1/brython.min.js"><\/script><script src="https://cdnjs.cloudflare.com/ajax/libs/brython/3.11.1/brython_stdlib.js"><\/script><style>body{margin:0;font:13px monospace;background:#fff;color:#111}canvas{max-width:100%;height:150px}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style></head><body onload="brython()"><canvas id="turtle-canvas" width="400" height="150"></canvas><pre id="python-output"></pre><script type="text/python">
import base64, sys, io
from browser import document
class Output(io.StringIO):
    def write(self, value):
        document["python-output"].text += value
        return len(value)
sys.stdout = Output()
sys.stderr = sys.stdout
try:
    source = base64.b64decode("${encoded}").decode("utf-8")
    exec(source)
except Exception as error:
    print("Ошибка:", error)
<\/script></body></html>`;
  };
  window.addEventListener('beforeunload', () => { if (projectSaveTimer) clearTimeout(projectSaveTimer); });

  const start = () => window.initApp().then(() => window.restoreRoute?.());
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once:true });
  else start();
})();
