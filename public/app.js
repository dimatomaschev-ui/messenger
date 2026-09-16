let token = localStorage.getItem('token');
let me = null;
let chats = [];
let currentChat = null;
let socket = null;
let isReg = false;
let recording = null;   // MediaRecorder
let mediaStream = null;

const $ = id => document.getElementById(id);

// ---------- API helper ----------
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

// ---------- AUTH UI ----------
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
    if (isReg) body.name = $('regName').value.trim();
    const data = await api(isReg ? '/api/register' : '/api/login', { method: 'POST', body: JSON.stringify(body) });
    token = data.token; me = data.user;
    localStorage.setItem('token', token);
    startApp();
  } catch (e) { $('authErr').textContent = e.message; }
};

// ---------- APP ----------
async function startApp() {
  $('auth').style.display = 'none';
  $('app').style.display = 'flex';
  renderMe();
  connectSocket();
  await loadChats();
}

function renderMe() {
  $('meName').textContent = me.name;
  $('mePhone').textContent = me.phone;
  $('meAvatarLetter').textContent = (me.name || '?')[0].toUpperCase();
  $('meAvatar').style.background = '#5288c1';
  $('meAvatar').querySelectorAll('img').forEach(i => i.remove());
  if (me.avatar) {
    const img = document.createElement('img');
    img.src = me.avatar;
    $('meAvatar').appendChild(img);
  }
}

$('logoutBtn').onclick = () => { localStorage.removeItem('token'); location.reload(); };

// avatar upload
$('meAvatar').onclick = () => $('avatarInput').click();
$('avatarInput').onchange = async () => {
  const f = $('avatarInput').files[0];
  if (!f) return;
  const fd = new FormData();
  fd.append('file', f);
  const res = await fetch('/api/avatar', { method: 'POST', body: fd, headers: { Authorization: 'Bearer ' + token } });
  const data = await res.json();
  if (!res.ok) return alert(data.error);
  me = data.user;
  renderMe();
  await loadChats();
};

// ---------- SOCKET ----------
function connectSocket() {
  socket = io({ auth: { token } });
  socket.on('new_message', msg => {
    if (currentChat && msg.chatId === currentChat.id) renderMessage(msg);
    loadChats();
  });
  socket.on('message_updated', msg => {
    const el = document.querySelector(`.msg[data-id="${msg.id}"]`);
    if (el) {
      const body = el.querySelector('.body');
      if (body) {
        body.innerHTML = msg.type === 'text' ? esc(msg.text) : mediaHtml(msg);
        body.innerHTML += msg.edited ? ' <span class="edited">(изменено)</span>' : '';
      }
    }
  });
  socket.on('message_deleted', ({ id }) => {
    document.querySelector(`.msg[data-id="${id}"]`)?.remove();
  });
  socket.on('user_updated', user => {
    chats.forEach(c => c.members.forEach(m => { if (m.id === user.id) Object.assign(m, user); }));
    if (currentChat) renderChatList();
  });
  socket.on('typing', ({ chatId }) => {
    if (currentChat && chatId === currentChat.id) {
      $('typing').textContent = 'печатает…';
      clearTimeout(connectSocket._t);
      connectSocket._t = setTimeout(() => $('typing').textContent = '', 1500);
    }
  });
}

async function loadChats() {
  const data = await api('/api/chats');
  chats = data.chats;
  renderChatList();
}

function renderChatList() {
  $('chatList').innerHTML = '';
  for (const c of chats) {
    const el = document.createElement('div');
    el.className = 'chat-item' + (currentChat?.id === c.id ? ' active' : '');
    const other = c.members.find(m => m.id !== me.id);
    const name = c.type === 'group' ? c.name : (other?.name || 'Чат');
    const lm = c.lastMessage;
    const preview = lm ? (lm.type === 'image' ? '🖼 Фото' : lm.type === 'video' ? '🎬 Видео'
      : lm.type === 'audio' ? '🎤 Голосовое' : lm.text) : 'Нет сообщений';
    el.innerHTML = avatarHtml(c.type === 'group' ? { name } : other, 'avatar-sm')
      + `<div style="min-width:0"><div class="name">${esc(name)}</div><div class="preview">${esc(preview)}</div></div>`;
    el.onclick = () => openChat(c.id);
    $('chatList').appendChild(el);
  }
}

async function openChat(id) {
  currentChat = chats.find(c => c.id === id);
  document.querySelector('.app').classList.add('chat-open');
  const other = currentChat.members.find(m => m.id !== me.id);
  const title = currentChat.type === 'group'
    ? currentChat.name + ` (${currentChat.members.length})`
    : other?.name || 'Чат';
  $('chatHeader').textContent = title;
  renderChatList();
  const data = await api(`/api/chats/${id}/messages`);
  $('messages').innerHTML = '';
  data.messages.forEach(renderMessage);
  $('messages').scrollTop = $('messages').scrollHeight;
}

function mediaHtml(m) {
  if (m.type === 'image') return `<a href="${m.file.url}" target="_blank"><img src="${m.file.url}" loading="lazy"></a>`;
  if (m.type === 'video') return `<video src="${m.file.url}" controls></video>`;
  if (m.type === 'audio') return `<audio src="${m.file.url}" controls></audio>`;
  if (m.type === 'file') return `<a href="${m.file.url}" target="_blank">📎 ${esc(m.file.name)}</a>`;
  return '';
}

function renderMessage(m) {
  const mine = m.senderId === me.id;
  const sender = db_user(m.senderId);
  const el = document.createElement('div');
  el.className = 'msg' + (mine ? ' mine' : '');
  el.dataset.id = m.id;

  let body;
  if (m.type === 'text') body = esc(m.text) + (m.edited ? ' <span class="edited">(изменено)</span>' : '');
  else if (m.type === 'audio' && !m.file?.name) body = mediaHtml(m);
  else if (m.text && m.type !== 'text') body = mediaHtml(m) + '<br>' + esc(m.text);
  else body = mediaHtml(m);

  let header = '';
  if (currentChat?.type === 'group' && !mine && sender)
    header = avatarHtml(sender) + `<b style="color:#6ab3f3">${esc(sender.name)}</b><br>`;

  let actions = '';
  if (mine) {
    actions = `<div class="actions">
      ${m.type === 'text' ? '<button class="act-edit" title="Изменить">✏️</button>' : ''}
      <button class="act-del" title="Удалить">🗑</button>
    </div>`;
  }

  el.innerHTML = actions + header + `<span class="body">${body}</span>
    <div class="meta">${new Date(m.ts).toLocaleTimeString('ru-RU', {hour:'2-digit',minute:'2-digit'})}</div>`;

  el.querySelector('.act-edit')?.addEventListener('click', () => {
    const t = prompt('Изменить сообщение:', m.text);
    if (t && t.trim() && t.trim() !== m.text) {
      api('/api/messages/' + m.id, { method: 'PATCH', body: JSON.stringify({ text: t.trim() }) })
        .catch(e => alert(e.message));
    }
  });
  el.querySelector('.act-del')?.addEventListener('click', async () => {
    if (!confirm('Удалить сообщение?')) return;
    try { await api('/api/messages/' + m.id, { method: 'DELETE' }); el.remove(); }
    catch (e) { alert(e.message); }
  });

  $('messages').appendChild(el);
  $('messages').scrollTop = $('messages').scrollHeight;
}

function db_user(id) {
  for (const c of chats) {
    const m = c.members.find(m => m.id === id);
    if (m) return m;
  }
  return id === me.id ? me : null;
}

// ---------- sending ----------
async function sendMessage(filePayload = null) {
  const text = $('msgInput').value.trim();
  if (!text && !filePayload) return;
  $('msgInput').value = '';
  socket.emit('send_message', { chatId: currentChat.id, text, file: filePayload }, r => {
    if (r?.error) alert(r.error);
  });
}
$('sendBtn').onclick = () => sendMessage();
$('msgInput').addEventListener('keydown', e => { if (e.key === 'Enter') sendMessage(); });
$('msgInput').addEventListener('input', () => {
  if (currentChat) socket.emit('typing', { chatId: currentChat.id });
});

// photo / video (original quality)
$('attachBtn').onclick = () => $('fileInput').click();
$('fileInput').onchange = async () => {
  const f = $('fileInput').files[0];
  if (!f || !currentChat) return;
  const fd = new FormData();
  fd.append('file', f);
  const res = await fetch('/api/upload', { method: 'POST', body: fd, headers: { Authorization: 'Bearer ' + token } });
  const data = await res.json();
  if (!res.ok) return alert(data.error);
  await sendMessage({ url: data.url, type: data.type, name: data.name, size: data.size });
  $('fileInput').value = '';
};

// ---------- voice messages ----------
$('voiceBtn').onclick = async () => {
  if (recording) { stopRecording(); return; }
  if (!currentChat) return alert('Сначала выберите чат');
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const chunks = [];
    recording = new MediaRecorder(mediaStream);
    recording.ondataavailable = e => chunks.push(e.data);
    recording.onstop = async () => {
      const blob = new Blob(chunks, { type: recording.mimeType || 'audio/webm' });
      mediaStream.getTracks().forEach(t => t.stop());
      mediaStream = null;
      const fd = new FormData();
      fd.append('file', blob, 'voice.webm');
      const res = await fetch('/api/upload', { method: 'POST', body: fd, headers: { Authorization: 'Bearer ' + token } });
      const data = await res.json();
      if (!res.ok) return alert(data.error);
      await sendMessage({ url: data.url, type: 'audio', name: '', size: blob.size });
    };
    recording.start();
    $('voiceBtn').classList.add('recording');
  } catch { alert('Нет доступа к микрофону'); }
};
function stopRecording() {
  recording.stop();
  recording = null;
  $('voiceBtn').classList.remove('recording');
}

// ---------- modal: new chat / group ----------
let modalMode = 'group';
$('newGroupBtn').onclick = () => openModal('group');
$('newChatBtn').onclick = () => openModal('private');
$('modalCancel').onclick = () => $('modal').style.display = 'none';

async function openModal(mode) {
  modalMode = mode;
  $('modal').style.display = 'flex';
  $('modalTitle').textContent = mode === 'group' ? 'Новая группа' : 'Новый личный чат';
  $('groupName').style.display = mode === 'group' ? 'block' : 'none';
  const { users } = await api('/api/users');
  const picker = $('userPicker');
  picker.innerHTML = '';
  for (const u of users) {
    const el = document.createElement('label');
    el.className = 'user-opt';
    el.innerHTML = `<input type="${mode === 'group' ? 'checkbox' : 'radio'}" name="userpick" value="${u.id}">
      ${avatarHtml(u, 'avatar-sm')} ${esc(u.name)} <span class="muted">${esc(u.phone)}</span>`;
    picker.appendChild(el);
  }
}

$('modalOk').onclick = async () => {
  const ids = [...document.querySelectorAll('#userPicker input:checked')].map(i => i.value);
  try {
    if (modalMode === 'private' && ids[0]) {
      await api('/api/chats', { method: 'POST', body: JSON.stringify({ userId: ids[0] }) });
    } else {
      await api('/api/chats', { method: 'POST', body: JSON.stringify({ name: $('groupName').value.trim(), memberIds: ids }) });
    }
    $('modal').style.display = 'none';
    await loadChats();
  } catch (e) { alert(e.message); }
};

// auto-login
if (token) {
  api('/api/me').then(d => { me = d.user; startApp(); }).catch(() => localStorage.removeItem('token'));
}
