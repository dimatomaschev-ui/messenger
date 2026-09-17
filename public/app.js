let token = localStorage.getItem('token');
let me = null;
let myPrivacy = { showPhone: 'all', showUsername: true };
let chats = [];
let currentChat = null;
let socket = null;
let isReg = false;
let recording = null;
let mediaStream = null;
const chatKeys = {}; // chatId -> CryptoKey (AES-GCM) for secret chats

const $ = id => document.getElementById(id);

// ---------- PWA ----------
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

// ---------- API ----------
async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, ...(opts.headers || {}) }
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Ошибка');
  return data;
}
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function avatarHtml(user, cls = 'sender-avatar') {
  if (user?.avatar) return `<span class="${cls}"><img src="${user.avatar}" alt=""></span>`;
  return `<span class="${cls}">${esc((user?.name || '?')[0].toUpperCase())}</span>`;
}

// ================= E2E (WebCrypto ECDH + AES-GCM) =================
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

async function ensureKeyPair() {
  let privJwk = JSON.parse(localStorage.getItem('ec_priv') || 'null');
  let pubJwk = JSON.parse(localStorage.getItem('ec_pub') || 'null');
  if (!privJwk || !pubJwk) {
    const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
    privJwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
    pubJwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
    localStorage.setItem('ec_priv', JSON.stringify(privJwk));
    localStorage.setItem('ec_pub', JSON.stringify(pubJwk));
  }
  if (!me.publicKey) {
    try { await api('/api/profile', { method: 'PATCH', body: JSON.stringify({ publicKey: pubJwk }) }); me.publicKey = pubJwk; } catch {}
  }
  return { privJwk, pubJwk };
}

async function getChatKey(chat) {
  if (chatKeys[chat.id]) return chatKeys[chat.id];
  const other = chat.members.find(m => m.id !== me.id);
  if (!other?.publicKey || !me.publicKey) return null;
  const priv = await crypto.subtle.importKey('jwk', JSON.parse(localStorage.getItem('ec_priv')),
    { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey']);
  const theirPub = await crypto.subtle.importKey('jwk', other.publicKey,
    { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const key = await crypto.subtle.deriveKey(
    { name: 'ECDH', public: theirPub }, priv,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  chatKeys[chat.id] = key;
  return key;
}

async function e2eEncrypt(chat, text) {
  const key = await getChatKey(chat);
  if (!key) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text));
  return b64(iv) + '.' + b64(ct);
}
async function e2eDecrypt(chat, payload) {
  try {
    const key = await getChatKey(chat);
    if (!key) return null;
    const [ivB, ctB] = payload.split('.');
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(ivB) }, key, unb64(ctB));
    return new TextDecoder().decode(pt);
  } catch { return null; }
}

// ================= NOTIFICATIONS =================
async function ensureNotifyPermission() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') {
    try { await Notification.requestPermission(); } catch {}
  }
}
function notify(msg) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (document.hasFocus() && currentChat?.id === msg.chatId) return;
  const sender = db_user(msg.senderId);
  const chat = chats.find(c => c.id === msg.chatId);
  const title = chat?.type === 'group' ? chat.name : (sender?.name || 'Сообщение');
  const body = msg.encrypted ? '🔒 Секретное сообщение'
    : msg.type === 'image' ? '🖼 Фото' : msg.type === 'video' ? '🎬 Видео'
    : msg.type === 'audio' ? '🎤 Голосовое' : msg.text.slice(0, 120);
  const n = new Notification(title, { body });
  n.onclick = () => { window.focus(); if (chat) openChat(chat.id); };
}

// ================= PRESENCE =================
function presenceInfo(u) {
  if (!u) return '';
  if (u.online) return '<span class="dot"></span>в сети';
  if (u.lastSeen) return 'был(а) ' + new Date(u.lastSeen).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  return '';
}

// ================= AUTH =================
$('tabLogin').onclick = () => { isReg = false; switchTab(); };
$('tabReg').onclick = () => { isReg = true; switchTab(); };
function switchTab() {
  $('tabLogin').classList.toggle('active', !isReg);
  $('tabReg').classList.toggle('active', isReg);
  $('regNameWrap').style.display = isReg ? 'block' : 'none';
  $('authBtn').textContent = isReg ? 'Зарегистрироваться' : 'Войти';
  $('authErr').textContent = '';
}
$('authBtn').onclick = async () => {
  $('authErr').textContent = '';
  try {
    const body = { phone: $('phone').value.trim(), password: $('password').value };
    if (isReg) { body.name = $('regName').value.trim(); body.username = $('regUsername').value.trim().replace(/^@/, ''); }
    const data = await api(isReg ? '/api/register' : '/api/login', { method: 'POST', body: JSON.stringify(body) });
    token = data.token; me = data.user;
    localStorage.setItem('token', token);
    await ensureKeyPair();
    startApp();
  } catch (e) { $('authErr').textContent = e.message; }
};

// ================= APP =================
async function startApp() {
  $('auth').style.display = 'none';
  $('app').style.display = 'flex';
  renderMe();
  connectSocket();
  ensureNotifyPermission();
  await loadChats();
}
function renderMe() {
  $('meName').textContent = me.name;
  $('meUsername').textContent = me.username ? '@' + me.username : '';
  $('mePhone').textContent = me.phone || '';
  $('meAvatarLetter').textContent = (me.name || '?')[0].toUpperCase();
  $('meAvatar').querySelectorAll('img').forEach(i => i.remove());
  if (me.avatar) { const img = document.createElement('img'); img.src = me.avatar; $('meAvatar').appendChild(img); }
}
$('logoutBtn').onclick = () => { localStorage.removeItem('token'); localStorage.removeItem('ec_priv'); localStorage.removeItem('ec_pub'); location.reload(); };

$('meAvatar').onclick = () => $('avatarInput').click();
$('avatarInput').onchange = async () => {
  const f = $('avatarInput').files[0];
  if (!f) return;
  const fd = new FormData(); fd.append('file', f);
  const res = await fetch('/api/avatar', { method: 'POST', body: fd, headers: { Authorization: 'Bearer ' + token } });
  const data = await res.json();
  if (!res.ok) return alert(data.error);
  me = data.user; renderMe(); await loadChats();
};

// ================= SETTINGS =================
$('settingsBtn').onclick = async () => {
  $('setErr').textContent = '';
  $('setName').value = me.name;
  $('setUsername').value = me.username || '';
  const d = await api('/api/me');
  myPrivacy = d.privacy || myPrivacy;
  $('setShowPhone').value = myPrivacy.showPhone;
  $('setShowUsername').checked = myPrivacy.showUsername !== false;
  $('settingsModal').style.display = 'flex';
};
$('settingsCancel').onclick = () => $('settingsModal').style.display = 'none';
$('settingsSave').onclick = async () => {
  $('setErr').textContent = '';
  try {
    const d = await api('/api/profile', {
      method: 'PATCH',
      body: JSON.stringify({
        name: $('setName').value.trim(),
        username: $('setUsername').value.trim().replace(/^@/, ''),
        privacy: { showPhone: $('setShowPhone').value, showUsername: $('setShowUsername').checked }
      })
    });
    me = d.user; myPrivacy = d.privacy;
    renderMe();
    $('settingsModal').style.display = 'none';
    await loadChats();
  } catch (e) { $('setErr').textContent = e.message; }
};

// ================= SOCKET =================
function connectSocket() {
  socket = io({ auth: { token }, reconnection: true, reconnectionDelay: 1000, reconnectionDelayMax: 10000 });
  socket.on('connect', () => {
    $('connBar').style.display = 'none';
    if (currentChat) openChat(currentChat.id);
    else loadChats();
  });
  socket.on('disconnect', () => { $('connBar').style.display = 'block'; });

  socket.on('new_message', msg => {
    if (currentChat && msg.chatId === currentChat.id) renderMessage(msg);
    loadChats();
    notify(msg);
  });
  socket.on('message_updated', msg => {
    const el = document.querySelector(`.msg[data-id="${msg.id}"]`);
    if (el) el.querySelector('.body').innerHTML = esc(msg.text) + (msg.edited ? ' <span class="edited">(изменено)</span>' : '');
  });
  socket.on('message_deleted', ({ id }) => document.querySelector(`.msg[data-id="${id}"]`)?.remove());
  socket.on('user_updated', user => {
    chats.forEach(c => c.members.forEach(m => { if (m.id === user.id) Object.assign(m, user); }));
    if (me.id === user.id) { me = { ...me, ...user }; renderMe(); }
    renderChatList();
    if (currentChat) renderChatHeader();
  });
  socket.on('presence', ({ userId, online, lastSeen }) => {
    chats.forEach(c => c.members.forEach(m => { if (m.id === userId) { m.online = online; m.lastSeen = lastSeen; } }));
    if (me.id === userId) { me.online = online; me.lastSeen = lastSeen; }
    renderChatList();
    if (currentChat) renderChatHeader();
  });
  socket.on('chat_secret', ({ chatId, secret }) => {
    const c = chats.find(x => x.id === chatId);
    if (c) { c.secret = secret; if (currentChat?.id === chatId) { currentChat.secret = secret; renderChatHeader(); } }
  });
  socket.on('group_updated', () => { loadChats(); if (currentChat) openChat(currentChat.id); });
  socket.on('typing', ({ chatId }) => {
    if (currentChat && chatId === currentChat.id) {
      $('typing').textContent = 'печатает…';
      clearTimeout(connectSocket._t);
      connectSocket._t = setTimeout(() => $('typing').textContent = '', 1500);
    }
  });
}

async function loadChats() {
  try {
    const data = await api('/api/chats');
    chats = data.chats;
    renderChatList();
  } catch (e) {}
}

function userLabel(u) { return `${esc(u.name)}${u.username ? ` <span class="uname">@${esc(u.username)}</span>` : ''}`; }

function renderChatList() {
  $('chatList').innerHTML = '';
  for (const c of chats) {
    const el = document.createElement('div');
    el.className = 'chat-item' + (currentChat?.id === c.id ? ' active' : '');
    const other = c.members.find(m => m.id !== me.id);
    const name = c.type === 'group' ? c.name : (other?.name || 'Чат');
    const lm = c.lastMessage;
    const preview = lm ? (lm.encrypted ? '🔒 Секретное сообщение'
      : lm.type === 'image' ? '🖼 Фото' : lm.type === 'video' ? '🎬 Видео'
      : lm.type === 'audio' ? '🎤 Голосовое' : lm.text) : 'Нет сообщений';
    const lock = c.secret ? ' 🔒' : '';
    const pres = c.type === 'private' && other ? `<div class="ci-status">${presenceInfo(other)}</div>` : '';
    el.innerHTML = avatarHtml(c.type === 'group' ? { name } : other, 'avatar-sm')
      + `<div style="min-width:0"><div class="name">${esc(name)}${lock}</div><div class="preview">${esc(preview)}</div>${pres}</div>`;
    el.onclick = () => openChat(c.id);
    $('chatList').appendChild(el);
  }
}

function renderChatHeader() {
  const other = currentChat.members.find(m => m.id !== me.id);
  const title = currentChat.type === 'group'
    ? esc(currentChat.name) + ` (${currentChat.members.length})`
    : (other ? userLabel(other) : 'Чат');
  $('chatHeaderText').innerHTML = (currentChat.secret ? '🔒 ' : '') + title;
  const st = $('chatHeaderStatus');
  if (currentChat.type === 'private' && other) {
    st.innerHTML = presenceInfo(other);
    st.className = 'ch-status' + (other.online ? ' online' : '');
  } else st.textContent = '';

  const btns = $('chatHeaderBtns');
  btns.innerHTML = '';
  if (currentChat.type === 'private') {
    const b = document.createElement('button');
    b.textContent = '🔒';
    b.className = currentChat.secret ? 'on' : '';
    b.title = 'Секретный чат (сквозное шифрование)';
    b.onclick = toggleSecret;
    btns.appendChild(b);
  } else {
    const b = document.createElement('button');
    b.textContent = '＋';
    b.title = 'Добавить участников';
    b.onclick = () => openModal('addmember');
    btns.appendChild(b);
  }
}

async function toggleSecret() {
  try {
    const d = await api('/api/chats/' + currentChat.id + '/secret', {
      method: 'PATCH', body: JSON.stringify({ secret: !currentChat.secret })
    });
    currentChat.secret = d.chat.secret;
    await loadChats();
    renderChatHeader();
    if (currentChat.secret) {
      await ensureKeyPair();
      const other = currentChat.members.find(m => m.id !== me.id);
      if (!other?.publicKey) alert('⚠️ Собеседник ещё не заходил после обновления — его ключей нет. Попросите его открыть мессенджер, иначе он не сможет прочитать сообщения.');
    }
  } catch (e) { alert(e.message); }
}

async function openChat(id) {
  currentChat = chats.find(c => c.id === id);
  document.querySelector('.app').classList.add('chat-open');
  renderChatHeader();
  renderChatList();
  try {
    const data = await api(`/api/chats/${id}/messages`);
    $('messages').innerHTML = '';
    for (const m of data.messages) await renderMessage(m);
    $('messages').scrollTop = $('messages').scrollHeight;
  } catch (e) {}
}

function mediaHtml(m) {
  if (m.type === 'image') return `<a href="${m.file.url}" target="_blank"><img src="${m.file.url}" loading="lazy"></a>`;
  if (m.type === 'video') return `<video src="${m.file.url}" controls></video>`;
  if (m.type === 'audio') return `<audio src="${m.file.url}" controls></audio>`;
  if (m.type === 'file') return `<a href="${m.file.url}" target="_blank">📎 ${esc(m.file.name)}</a>`;
  return '';
}

async function renderMessage(m) {
  if (document.querySelector(`.msg[data-id="${m.id}"]`)) return;
  const mine = m.senderId === me.id;
  const sender = db_user(m.senderId);
  const el = document.createElement('div');
  el.className = 'msg' + (mine ? ' mine' : '') + (m.encrypted ? ' secret' : '');
  el.dataset.id = m.id;

  let body;
  if (m.encrypted) {
    const plain = await e2eDecrypt(currentChat, m.text);
    body = plain !== null ? esc(plain) : '<i class="lock-mark">🔒 Зашифрованное сообщение (нет ключа)</i>';
    if (mine && plain === null) body = '<i class="lock-mark">🔒 ' + esc(m.text.slice(0, 40)) + '…</i>';
  } else if (m.type === 'text') {
    body = esc(m.text) + (m.edited ? ' <span class="edited">(изменено)</span>' : '');
  } else if (m.text) {
    body = mediaHtml(m) + '<br>' + esc(m.text);
  } else {
    body = mediaHtml(m);
  }

  let header = '';
  if (currentChat?.type === 'group' && !mine && sender)
    header = avatarHtml(sender) + `<b style="color:#6ab3f3">${userLabel(sender)}</b><br>`;

  let actions = '';
  if (mine) {
    actions = `<div class="actions">
      ${m.type === 'text' && !m.encrypted ? '<button class="act-edit" title="Изменить">✏️</button>' : ''}
      <button class="act-del" title="Удалить">🗑</button>
    </div>`;
  }

  el.innerHTML = actions + header + `<span class="body">${body}</span>
    <div class="meta">${m.encrypted ? '🔒 end-to-end • ' : ''}${new Date(m.ts).toLocaleTimeString('ru-RU', {hour:'2-digit',minute:'2-digit'})}</div>`;

  el.querySelector('.act-edit')?.addEventListener('click', () => {
    const t = prompt('Изменить сообщение:', m.text);
    if (t && t.trim() && t.trim() !== m.text)
      api('/api/messages/' + m.id, { method: 'PATCH', body: JSON.stringify({ text: t.trim() }) }).catch(e => alert(e.message));
  });
  el.querySelector('.act-del')?.addEventListener('click', async () => {
    if (!confirm('Удалить сообщение?')) return;
    try { await api('/api/messages/' + m.id, { method: 'DELETE' }); el.remove(); } catch (e) { alert(e.message); }
  });

  $('messages').appendChild(el);
  $('messages').scrollTop = $('messages').scrollHeight;
}

function db_user(id) {
  if (id === me.id) return me;
  for (const c of chats) { const m = c.members.find(m => m.id === id); if (m) return m; }
  return null;
}

// ================= SENDING =================
async function sendMessage(filePayload = null) {
  const text = $('msgInput').value.trim();
  if (!text && !filePayload) return;
  $('msgInput').value = '';
  let payloadText = text, encrypted = false;
  if (text && currentChat.secret && !filePayload) {
    const enc = await e2eEncrypt(currentChat, text);
    if (enc) { payloadText = enc; encrypted = true; }
    else { alert('Нет ключа собеседника для шифрования. Попросите его открыть мессенджер.'); $('msgInput').value = text; return; }
  }
  socket.emit('send_message', { chatId: currentChat.id, text: payloadText, file: filePayload, encrypted }, r => {
    if (r?.error) alert(r.error);
  });
}
$('sendBtn').onclick = () => sendMessage();
$('msgInput').addEventListener('keydown', e => { if (e.key === 'Enter') sendMessage(); });
$('msgInput').addEventListener('input', () => { if (currentChat) socket.emit('typing', { chatId: currentChat.id }); });

$('attachBtn').onclick = () => $('fileInput').click();
$('fileInput').onchange = async () => {
  const f = $('fileInput').files[0];
  if (!f || !currentChat) return;
  if (currentChat.secret) { alert('Файлы в секретном чате не шифруются. Отключите 🔒 для отправки медиа.'); $('fileInput').value = ''; return; }
  const fd = new FormData(); fd.append('file', f);
  const res = await fetch('/api/upload', { method: 'POST', body: fd, headers: { Authorization: 'Bearer ' + token } });
  const data = await res.json();
  if (!res.ok) return alert(data.error);
  await sendMessage({ url: data.url, type: data.type, name: data.name, size: data.size });
  $('fileInput').value = '';
};

// ================= VOICE =================
$('voiceBtn').onclick = async () => {
  if (recording) { stopRecording(); return; }
  if (!currentChat) return alert('Сначала выберите чат');
  if (currentChat.secret) return alert('Голосовые в секретном чате не шифруются. Отключите 🔒.');
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const chunks = [];
    recording = new MediaRecorder(mediaStream);
    recording.ondataavailable = e => chunks.push(e.data);
    recording.onstop = async () => {
      const blob = new Blob(chunks, { type: recording.mimeType || 'audio/webm' });
      mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null;
      const fd = new FormData(); fd.append('file', blob, 'voice.webm');
      const res = await fetch('/api/upload', { method: 'POST', body: fd, headers: { Authorization: 'Bearer ' + token } });
      const data = await res.json();
      if (!res.ok) return alert(data.error);
      await sendMessage({ url: data.url, type: 'audio', name: '', size: blob.size });
    };
    recording.start();
    $('voiceBtn').classList.add('recording');
  } catch { alert('Нет доступа к микрофону'); }
};
function stopRecording() { recording.stop(); recording = null; $('voiceBtn').classList.remove('recording'); }

// ================= MODAL: chat / group / add member =================
let modalMode = 'group';
$('newGroupBtn').onclick = () => openModal('group');
$('newChatBtn').onclick = () => openModal('private');
$('modalCancel').onclick = () => $('modal').style.display = 'none';

async function openModal(mode) {
  modalMode = mode;
  $('modal').style.display = 'flex';
  $('modalTitle').textContent = mode === 'group' ? 'Новая группа'
    : mode === 'private' ? 'Новый личный чат' : 'Добавить в группу';
  $('groupName').style.display = mode === 'group' ? 'block' : 'none';
  $('modalOk').textContent = mode === 'addmember' ? 'Добавить' : 'Создать';
  $('userSearch').value = '';
  await renderPicker('');
}
$('userSearch').addEventListener('input', () => renderPicker($('userSearch').value.trim()));

async function renderPicker(q) {
  const { users } = await api('/api/users' + (q ? '?q=' + encodeURIComponent(q) : ''));
  const existing = currentChat?.members.map(m => m.id) || [];
  const list = modalMode === 'addmember' ? users.filter(u => !existing.includes(u.id)) : users;
  const picker = $('userPicker');
  picker.innerHTML = list.length ? '' : '<div class="muted" style="padding:12px">Никого не найдено</div>';
  for (const u of list) {
    const el = document.createElement('label');
    el.className = 'user-opt';
    el.innerHTML = `<input type="${modalMode === 'group' ? 'checkbox' : 'radio'}" name="userpick" value="${u.id}">
      ${avatarHtml(u, 'avatar-sm')} <div>${userLabel(u)} <span class="ci-status">${presenceInfo(u)}</span>
      <div class="muted-sm">${u.phone ? esc(u.phone) : 'номер скрыт настройками конфиденциальности'}</div></div>`;
    picker.appendChild(el);
  }
}

$('modalOk').onclick = async () => {
  const ids = [...document.querySelectorAll('#userPicker input:checked')].map(i => i.value);
  try {
    if (modalMode === 'private' && ids[0]) {
      await api('/api/chats', { method: 'POST', body: JSON.stringify({ userId: ids[0] }) });
    } else if (modalMode === 'addmember') {
      await api('/api/chats/' + currentChat.id + '/members', { method: 'POST', body: JSON.stringify({ userIds: ids }) });
    } else {
      await api('/api/chats', { method: 'POST', body: JSON.stringify({ name: $('groupName').value.trim(), memberIds: ids }) });
    }
    $('modal').style.display = 'none';
    await loadChats();
    if (currentChat && modalMode === 'addmember') openChat(currentChat.id);
  } catch (e) { alert(e.message); }
};

// auto-login
if (token) {
  api('/api/me').then(async d => {
    me = d.user; myPrivacy = d.privacy || myPrivacy;
    await ensureKeyPair();
    startApp();
  }).catch(() => localStorage.removeItem('token'));
}
