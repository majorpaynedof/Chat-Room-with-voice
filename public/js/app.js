// ============ State ============
const state = {
  user: null,
  socket: null,
  servers: [],
  currentServer: null,
  currentChannel: null,
  currentDMUser: null,
  channels: [],
  members: [],
  messages: [],
  voiceStates: {},    // channelId -> [participants]
  showMembers: true,
  view: 'home',       // 'home' | 'server'
  // Voice
  voiceChannelId: null,
  voiceConnections: new Map(), // socketId -> RTCPeerConnection
  localStream: null,
  isMuted: false,
};

// ============ DOM refs ============
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const authScreen = $('#auth-screen');
const appScreen = $('#app-screen');
const authForm = $('#auth-form');
const usernameInput = $('#username');
const passwordInput = $('#password');
const loginBtn = $('#login-btn');
const switchLink = $('#switch-to-register');

const serverIcons = $('#server-icons');
const homeBtn = $('#home-btn');
const addServerBtn = $('#add-server-btn');

const channelList = $('#channel-list');
const sidebarHeader = $('#sidebar-header');
const serverNameDisplay = $('#server-name-display');

const chatTitle = $('#chat-title');
const channelIcon = $('#channel-icon');
const messagesEl = $('#messages');
const messageInput = $('#message-input');
const uploadBtn = $('#upload-btn');
const fileInput = $('#file-input');
const imagePreview = $('#image-preview');
const previewImg = $('#preview-img');
const removePreview = $('#remove-preview');
const typingIndicator = $('#typing-indicator');
const membersToggle = $('#members-toggle');
const membersSidebar = $('#members-sidebar');
const membersList = $('#members-list');
const messageInputArea = $('#message-input-area');

const modalOverlay = $('#modal-overlay');
const modal = $('#modal');
const modalTitle = $('#modal-title');
const modalBody = $('#modal-body');
const modalClose = $('#modal-close');

const userAvatar = $('#user-avatar');
const userDisplayName = $('#user-display-name');
const settingsBtn = $('#settings-btn');

let isRegistering = false;
let typingTimeout = null;
let pendingImageUrl = null;

// ============ API helpers ============
async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// ============ Auth ============
switchLink.addEventListener('click', (e) => {
  e.preventDefault();
  isRegistering = !isRegistering;
  loginBtn.textContent = isRegistering ? 'Register' : 'Log In';
  switchLink.textContent = isRegistering ? 'Already have an account?' : 'Register';
});

authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = usernameInput.value.trim();
  const password = passwordInput.value;

  try {
    const endpoint = isRegistering ? '/api/auth/register' : '/api/auth/login';
    const user = await api(endpoint, {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    state.user = user;
    initApp();
  } catch (err) {
    alert(err.message);
  }
});

// Check if already logged in
async function checkAuth() {
  try {
    const user = await api('/api/auth/me');
    state.user = user;
    initApp();
  } catch {
    // Not logged in
  }
}

// ============ Init App ============
function initApp() {
  authScreen.classList.add('hidden');
  appScreen.classList.remove('hidden');

  userAvatar.style.backgroundColor = state.user.avatar_color;
  userAvatar.textContent = state.user.username[0].toUpperCase();
  userDisplayName.textContent = state.user.username;

  initSocket();
  loadServers();
  showHome();
}

// ============ Socket.IO ============
function initSocket() {
  state.socket = io();

  state.socket.on('message:new', (msg) => {
    if (state.currentChannel && msg.channel_id === state.currentChannel.id) {
      appendMessage(msg);
      scrollToBottom();
    }
  });

  state.socket.on('message:deleted', ({ messageId }) => {
    const el = document.getElementById(`msg-${messageId}`);
    if (el) el.remove();
  });

  state.socket.on('dm:new', (msg) => {
    if (state.currentDMUser) {
      const otherId = msg.sender_id === state.user.id ? msg.receiver_id : msg.sender_id;
      if (otherId === state.currentDMUser.id) {
        appendMessage(msg, true);
        scrollToBottom();
      }
    }
  });

  state.socket.on('user:status', ({ userId, status }) => {
    // Update members list if visible
    const memberEl = document.querySelector(`.member-item[data-user-id="${userId}"]`);
    if (memberEl) {
      const dot = memberEl.querySelector('.status-dot');
      const name = memberEl.querySelector('.member-name');
      if (dot) {
        dot.className = `status-dot ${status}`;
      }
      if (name) {
        name.className = `member-name ${status === 'online' ? 'online-name' : ''}`;
      }
    }
  });

  state.socket.on('typing:start', ({ username, channelId }) => {
    if (state.currentChannel && channelId === state.currentChannel.id) {
      typingIndicator.classList.remove('hidden');
      typingIndicator.textContent = `${username} is typing...`;
    }
  });

  state.socket.on('typing:stop', ({ channelId }) => {
    if (state.currentChannel && channelId === state.currentChannel.id) {
      typingIndicator.classList.add('hidden');
    }
  });

  state.socket.on('voice:state', ({ channelId, participants }) => {
    state.voiceStates[channelId] = participants;
    renderVoiceParticipants(channelId);
  });

  state.socket.on('voice:user-joined', async (participant) => {
    if (state.voiceChannelId && participant.socketId !== state.socket.id) {
      await createPeerConnection(participant.socketId, true);
    }
  });

  state.socket.on('voice:user-left', ({ socketId }) => {
    const pc = state.voiceConnections.get(socketId);
    if (pc) {
      pc.close();
      state.voiceConnections.delete(socketId);
    }
    removeRemoteAudio(socketId);
  });

  state.socket.on('voice:offer', async ({ from, offer }) => {
    const pc = await createPeerConnection(from, false);
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    state.socket.emit('voice:answer', { to: from, answer });
  });

  state.socket.on('voice:answer', async ({ from, answer }) => {
    const pc = state.voiceConnections.get(from);
    if (pc) {
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
    }
  });

  state.socket.on('voice:ice-candidate', async ({ from, candidate }) => {
    const pc = state.voiceConnections.get(from);
    if (pc && candidate) {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    }
  });
}

// ============ Servers ============
async function loadServers() {
  state.servers = await api('/api/servers');
  renderServerList();
}

function renderServerList() {
  serverIcons.innerHTML = '';
  for (const server of state.servers) {
    const icon = document.createElement('div');
    icon.className = `server-icon${state.currentServer?.id === server.id ? ' active' : ''}`;
    icon.style.backgroundColor = server.icon_color;
    icon.textContent = server.name.substring(0, 2).toUpperCase();
    icon.title = server.name;
    icon.addEventListener('click', () => selectServer(server));
    serverIcons.appendChild(icon);
  }
}

async function selectServer(server) {
  state.view = 'server';
  state.currentServer = server;
  state.currentDMUser = null;
  state.socket.emit('server:join', server.id);

  renderServerList();
  serverNameDisplay.textContent = server.name;

  const channels = await api(`/api/servers/${server.id}/channels`);
  state.channels = channels;
  renderChannels();

  const members = await api(`/api/servers/${server.id}/members`);
  state.members = members;
  renderMembers();

  // Auto-select first text channel
  const textChannel = channels.find((c) => c.type === 'text');
  if (textChannel) {
    selectChannel(textChannel);
  }
}

// ============ Channels ============
function renderChannels() {
  channelList.innerHTML = '';

  const textChannels = state.channels.filter((c) => c.type === 'text');
  const voiceChannels = state.channels.filter((c) => c.type === 'voice');

  if (textChannels.length) {
    const cat = createCategoryHeader('Text Channels');
    channelList.appendChild(cat);
    for (const ch of textChannels) {
      channelList.appendChild(createChannelItem(ch));
    }
  }

  if (voiceChannels.length) {
    const cat = createCategoryHeader('Voice Channels');
    channelList.appendChild(cat);
    for (const ch of voiceChannels) {
      channelList.appendChild(createChannelItem(ch));
      // Voice participants
      const participantsDiv = document.createElement('div');
      participantsDiv.className = 'voice-participants';
      participantsDiv.id = `voice-participants-${ch.id}`;
      channelList.appendChild(participantsDiv);
      renderVoiceParticipants(ch.id);
    }
  }

  // Add channel button (if owner)
  if (state.currentServer && state.currentServer.owner_id === state.user.id) {
    const addBtn = document.createElement('div');
    addBtn.className = 'channel-item';
    addBtn.innerHTML = '<span class="channel-icon">+</span><span class="channel-name">Add Channel</span>';
    addBtn.addEventListener('click', showAddChannelModal);
    channelList.appendChild(addBtn);
  }
}

function createCategoryHeader(text) {
  const el = document.createElement('div');
  el.className = 'channel-category-header';
  el.textContent = text;
  return el;
}

function createChannelItem(ch) {
  const el = document.createElement('div');
  el.className = `channel-item${state.currentChannel?.id === ch.id ? ' active' : ''}`;
  el.dataset.channelId = ch.id;

  const icon = ch.type === 'voice' ? '🔊' : '#';
  el.innerHTML = `<span class="channel-icon">${icon}</span><span class="channel-name">${escapeHtml(ch.name)}</span>`;

  el.addEventListener('click', () => {
    if (ch.type === 'text') {
      selectChannel(ch);
    } else {
      joinVoiceChannel(ch);
    }
  });

  return el;
}

async function selectChannel(channel) {
  // Leave previous channel room
  if (state.currentChannel) {
    state.socket.emit('channel:leave', state.currentChannel.id);
  }

  state.currentChannel = channel;
  state.currentDMUser = null;
  state.socket.emit('channel:join', channel.id);

  chatTitle.textContent = channel.name;
  channelIcon.textContent = '#';
  messageInput.placeholder = `Message #${channel.name}`;
  messageInputArea.classList.remove('hidden');

  // Re-render to show active
  renderChannels();

  // Load messages
  const msgs = await api(`/api/channels/${channel.id}/messages`);
  renderMessages(msgs);
  scrollToBottom();
}

// ============ Home / DMs ============
homeBtn.addEventListener('click', showHome);

async function showHome() {
  state.view = 'home';
  state.currentServer = null;
  state.currentChannel = null;
  renderServerList();

  homeBtn.classList.add('active');
  serverNameDisplay.textContent = 'Direct Messages';

  // Load DM partners and all users
  const [partners, allUsers] = await Promise.all([
    api('/api/dms/partners'),
    api('/api/users'),
  ]);

  channelList.innerHTML = '';

  // Find new DM button
  const newDmBtn = document.createElement('div');
  newDmBtn.className = 'channel-item';
  newDmBtn.innerHTML = '<span class="channel-icon">+</span><span class="channel-name">New Message</span>';
  newDmBtn.addEventListener('click', () => showNewDMModal(allUsers));
  channelList.appendChild(newDmBtn);

  const catHeader = createCategoryHeader('Direct Messages');
  channelList.appendChild(catHeader);

  for (const partner of partners) {
    const item = document.createElement('div');
    item.className = `dm-item${state.currentDMUser?.id === partner.id ? ' active' : ''}`;
    item.innerHTML = `
      <div class="avatar small" style="background-color:${partner.avatar_color}">${partner.username[0].toUpperCase()}</div>
      <span>${escapeHtml(partner.username)}</span>
      <div class="dm-status ${partner.status}"></div>
    `;
    item.addEventListener('click', () => selectDMUser(partner));
    channelList.appendChild(item);
  }

  // Show welcome screen
  messagesEl.innerHTML = '';
  messageInputArea.classList.add('hidden');
  chatTitle.textContent = 'Friends';
  channelIcon.textContent = '';
  membersList.innerHTML = '';

  showWelcomeScreen();
}

function showWelcomeScreen() {
  messagesEl.innerHTML = `
    <div class="welcome-screen">
      <h2>Welcome to Discord Clone!</h2>
      <p>Select a server from the sidebar or start a direct message to begin chatting. Create your own server with the + button.</p>
    </div>
  `;
}

async function selectDMUser(user) {
  state.currentDMUser = user;
  state.currentChannel = null;

  chatTitle.textContent = user.username;
  channelIcon.textContent = '@';
  messageInput.placeholder = `Message @${user.username}`;
  messageInputArea.classList.remove('hidden');
  membersList.innerHTML = '';

  // Refresh DM list highlight
  showHome().then(() => {
    // The DM is selected after home reloads
  });

  const msgs = await api(`/api/dms/${user.id}`);
  renderMessages(msgs, true);
  scrollToBottom();
}

// ============ Messages ============
function renderMessages(msgs, isDM = false) {
  messagesEl.innerHTML = '';
  let lastUserId = null;
  let lastTime = null;

  for (const msg of msgs) {
    const userId = isDM ? msg.sender_id : msg.user_id;
    const msgTime = new Date(msg.created_at);
    const showHeader = userId !== lastUserId ||
      (lastTime && (msgTime - lastTime) > 5 * 60 * 1000);

    appendMessage(msg, isDM, showHeader);
    lastUserId = userId;
    lastTime = msgTime;
  }
}

function appendMessage(msg, isDM = false, forceHeader = true) {
  const userId = isDM ? msg.sender_id : msg.user_id;
  const div = document.createElement('div');
  div.className = `message${forceHeader ? ' has-header' : ''}`;
  div.id = `msg-${msg.id}`;

  const time = new Date(msg.created_at);
  const timeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const dateStr = time.toLocaleDateString();

  let html = '';

  if (forceHeader) {
    html += `
      <div class="msg-avatar" style="background-color:${msg.avatar_color}">${msg.username[0].toUpperCase()}</div>
      <div class="msg-header">
        <span class="msg-username">${escapeHtml(msg.username)}</span>
        <span class="msg-timestamp">${dateStr} ${timeStr}</span>
      </div>
    `;
  }

  if (msg.content) {
    html += `<div class="msg-content">${formatMessage(msg.content)}</div>`;
  }

  if (msg.image_url) {
    html += `<img class="msg-image" src="${escapeHtml(msg.image_url)}" alt="image" onclick="viewImage('${escapeHtml(msg.image_url)}')" loading="lazy">`;
  }

  // Delete button for own messages
  if (userId === state.user.id && !isDM) {
    html += `
      <div class="msg-actions">
        <button onclick="deleteMessage('${msg.id}', '${msg.channel_id}')" title="Delete">🗑</button>
      </div>
    `;
  }

  div.innerHTML = html;
  messagesEl.appendChild(div);
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ============ Message Input ============
messageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

messageInput.addEventListener('input', () => {
  if (state.currentChannel) {
    state.socket.emit('typing:start', state.currentChannel.id);
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
      state.socket.emit('typing:stop', state.currentChannel.id);
    }, 2000);
  }
});

async function sendMessage() {
  const content = messageInput.value.trim();
  const imageUrl = pendingImageUrl;

  if (!content && !imageUrl) return;

  if (state.currentDMUser) {
    state.socket.emit('dm:send', {
      receiverId: state.currentDMUser.id,
      content: content || null,
      imageUrl,
    });
  } else if (state.currentChannel) {
    state.socket.emit('message:send', {
      channelId: state.currentChannel.id,
      content: content || null,
      imageUrl,
    });
    state.socket.emit('typing:stop', state.currentChannel.id);
  }

  messageInput.value = '';
  pendingImageUrl = null;
  imagePreview.classList.add('hidden');
}

// ============ Image Upload ============
uploadBtn.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0];
  if (!file) return;

  const formData = new FormData();
  formData.append('image', file);

  try {
    const res = await fetch('/api/upload', {
      method: 'POST',
      body: formData,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    pendingImageUrl = data.url;
    previewImg.src = data.url;
    imagePreview.classList.remove('hidden');
  } catch (err) {
    alert('Upload failed: ' + err.message);
  }

  fileInput.value = '';
});

removePreview.addEventListener('click', () => {
  pendingImageUrl = null;
  imagePreview.classList.add('hidden');
});

// ============ Members ============
membersToggle.addEventListener('click', () => {
  state.showMembers = !state.showMembers;
  membersSidebar.classList.toggle('hidden-panel', !state.showMembers);
});

function renderMembers() {
  membersList.innerHTML = '';

  const online = state.members.filter((m) => m.status === 'online');
  const offline = state.members.filter((m) => m.status !== 'online');

  if (online.length) {
    membersList.innerHTML += `<div class="member-category">Online — ${online.length}</div>`;
    for (const m of online) {
      membersList.appendChild(createMemberItem(m, true));
    }
  }

  if (offline.length) {
    membersList.innerHTML += `<div class="member-category">Offline — ${offline.length}</div>`;
    for (const m of offline) {
      membersList.appendChild(createMemberItem(m, false));
    }
  }
}

function createMemberItem(member, isOnline) {
  const el = document.createElement('div');
  el.className = 'member-item';
  el.dataset.userId = member.id;
  el.innerHTML = `
    <div class="avatar small" style="background-color:${member.avatar_color}">
      ${member.username[0].toUpperCase()}
      <div class="status-dot ${isOnline ? 'online' : 'offline'}"></div>
    </div>
    <span class="member-name ${isOnline ? 'online-name' : ''}">${escapeHtml(member.username)}</span>
  `;
  el.addEventListener('click', () => {
    if (member.id !== state.user.id) {
      selectDMUser(member);
    }
  });
  return el;
}

// ============ Voice Chat (WebRTC) ============
async function joinVoiceChannel(channel) {
  // If already in a voice channel, leave it first
  if (state.voiceChannelId) {
    leaveVoiceChannel();
  }

  try {
    state.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (err) {
    alert('Microphone access denied. Voice chat requires microphone permission.');
    return;
  }

  state.voiceChannelId = channel.id;
  state.socket.emit('voice:join', channel.id);
  renderVoiceStatus(channel);
}

function leaveVoiceChannel() {
  if (!state.voiceChannelId) return;

  state.socket.emit('voice:leave', state.voiceChannelId);

  // Close all peer connections
  for (const [socketId, pc] of state.voiceConnections) {
    pc.close();
    removeRemoteAudio(socketId);
  }
  state.voiceConnections.clear();

  // Stop local stream
  if (state.localStream) {
    state.localStream.getTracks().forEach((t) => t.stop());
    state.localStream = null;
  }

  state.voiceChannelId = null;
  state.isMuted = false;

  // Remove voice panel
  const panel = document.querySelector('.voice-connected');
  if (panel) panel.remove();
}

function toggleMute() {
  if (!state.localStream) return;
  state.isMuted = !state.isMuted;
  state.localStream.getAudioTracks().forEach((t) => {
    t.enabled = !state.isMuted;
  });

  const muteBtn = document.querySelector('.voice-btn-mute');
  if (muteBtn) {
    muteBtn.classList.toggle('muted', state.isMuted);
    muteBtn.textContent = state.isMuted ? '🔇' : '🎙️';
  }
}

async function createPeerConnection(remoteSocketId, isInitiator) {
  const config = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ],
  };

  // Add TURN server if configured
  const turnUrl = document.querySelector('meta[name="turn-url"]')?.content;
  if (turnUrl) {
    config.iceServers.push({
      urls: turnUrl,
      username: document.querySelector('meta[name="turn-username"]')?.content || '',
      credential: document.querySelector('meta[name="turn-password"]')?.content || '',
    });
  }

  const pc = new RTCPeerConnection(config);
  state.voiceConnections.set(remoteSocketId, pc);

  // Add local tracks
  if (state.localStream) {
    state.localStream.getTracks().forEach((track) => {
      pc.addTrack(track, state.localStream);
    });
  }

  // Handle remote tracks
  pc.ontrack = (event) => {
    let audio = document.getElementById(`audio-${remoteSocketId}`);
    if (!audio) {
      audio = document.createElement('audio');
      audio.id = `audio-${remoteSocketId}`;
      audio.autoplay = true;
      document.body.appendChild(audio);
    }
    audio.srcObject = event.streams[0];
  };

  // ICE candidates
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      state.socket.emit('voice:ice-candidate', {
        to: remoteSocketId,
        candidate: event.candidate,
      });
    }
  };

  // If initiator, create and send offer
  if (isInitiator) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    state.socket.emit('voice:offer', { to: remoteSocketId, offer });
  }

  return pc;
}

function removeRemoteAudio(socketId) {
  const audio = document.getElementById(`audio-${socketId}`);
  if (audio) audio.remove();
}

function renderVoiceStatus(channel) {
  // Remove existing panel
  let panel = document.querySelector('.voice-connected');
  if (panel) panel.remove();

  panel = document.createElement('div');
  panel.className = 'voice-connected';
  panel.innerHTML = `
    <div class="voice-connected-header">
      <div>
        <div class="voice-connected-info">Voice Connected</div>
        <div class="voice-connected-channel">🔊 ${escapeHtml(channel.name)}</div>
      </div>
      <div class="voice-controls">
        <button class="voice-btn-mute" onclick="toggleMute()" title="Toggle Mute">🎙️</button>
        <button class="voice-btn-disconnect" onclick="leaveVoiceChannel()" title="Disconnect">📞</button>
      </div>
    </div>
  `;

  // Insert before user panel in sidebar
  const userPanel = document.querySelector('.user-panel');
  userPanel.parentNode.insertBefore(panel, userPanel);
}

function renderVoiceParticipants(channelId) {
  const container = document.getElementById(`voice-participants-${channelId}`);
  if (!container) return;

  const participants = state.voiceStates[channelId] || [];
  container.innerHTML = '';

  for (const p of participants) {
    const el = document.createElement('div');
    el.className = 'voice-participant';
    el.innerHTML = `
      <div class="avatar" style="background-color:#5865f2;width:20px;height:20px;font-size:10px">${p.username[0].toUpperCase()}</div>
      <span>${escapeHtml(p.username)}</span>
    `;
    container.appendChild(el);
  }
}

// ============ Modals ============
function showModal(title, bodyHtml) {
  modalTitle.textContent = title;
  modalBody.innerHTML = bodyHtml;
  modalOverlay.classList.remove('hidden');
}

function hideModal() {
  modalOverlay.classList.add('hidden');
}

modalClose.addEventListener('click', hideModal);
modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) hideModal();
});

addServerBtn.addEventListener('click', () => {
  showModal('Create a Server', `
    <div class="form-group">
      <label for="new-server-name">SERVER NAME</label>
      <input type="text" id="new-server-name" placeholder="My Awesome Server" maxlength="100">
    </div>
    <button class="btn-primary" onclick="createServer()">Create Server</button>
    <div style="margin-top:16px; text-align:center; color:var(--text-muted);">
      <p style="margin-bottom: 8px;">Have an invite code?</p>
    </div>
    <div class="form-group">
      <label for="join-server-id">SERVER ID</label>
      <input type="text" id="join-server-id" placeholder="Paste server ID here">
    </div>
    <button class="btn-secondary" onclick="joinServerById()">Join Server</button>
  `);
});

async function createServer() {
  const name = document.getElementById('new-server-name').value.trim();
  if (!name) return;

  try {
    const server = await api('/api/servers', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    hideModal();
    await loadServers();
    selectServer(server);
  } catch (err) {
    alert(err.message);
  }
}

async function joinServerById() {
  const id = document.getElementById('join-server-id').value.trim();
  if (!id) return;

  try {
    const server = await api(`/api/servers/${id}/join`, { method: 'POST' });
    hideModal();
    await loadServers();
    selectServer(server);
  } catch (err) {
    alert(err.message);
  }
}

function showAddChannelModal() {
  showModal('Create Channel', `
    <div class="form-group">
      <label for="new-channel-name">CHANNEL NAME</label>
      <input type="text" id="new-channel-name" placeholder="new-channel" maxlength="100">
    </div>
    <div class="form-group">
      <label>CHANNEL TYPE</label>
      <div style="display:flex;gap:8px;margin-top:4px;">
        <label style="color:var(--text-normal);cursor:pointer;">
          <input type="radio" name="channel-type" value="text" checked> Text
        </label>
        <label style="color:var(--text-normal);cursor:pointer;">
          <input type="radio" name="channel-type" value="voice"> Voice
        </label>
      </div>
    </div>
    <button class="btn-primary" onclick="createChannel()">Create Channel</button>
  `);
}

async function createChannel() {
  const name = document.getElementById('new-channel-name').value.trim();
  const type = document.querySelector('input[name="channel-type"]:checked').value;
  if (!name) return;

  try {
    await api(`/api/servers/${state.currentServer.id}/channels`, {
      method: 'POST',
      body: JSON.stringify({ name, type }),
    });
    hideModal();
    const channels = await api(`/api/servers/${state.currentServer.id}/channels`);
    state.channels = channels;
    renderChannels();
  } catch (err) {
    alert(err.message);
  }
}

function showNewDMModal(allUsers) {
  const others = allUsers.filter((u) => u.id !== state.user.id);
  let html = '<p style="color:var(--text-muted);margin-bottom:12px;">Select a user to message:</p>';

  for (const u of others) {
    html += `
      <div class="server-browse-item" style="cursor:pointer" onclick="startDM('${u.id}', '${escapeHtml(u.username)}', '${u.avatar_color}', '${u.status}')">
        <div class="server-browse-info">
          <div class="avatar small" style="background-color:${u.avatar_color}">${u.username[0].toUpperCase()}</div>
          <span style="color:var(--text-normal)">${escapeHtml(u.username)}</span>
        </div>
        <div class="dm-status ${u.status}" style="width:10px;height:10px;border-radius:50%;"></div>
      </div>
    `;
  }

  if (others.length === 0) {
    html += '<p style="color:var(--text-muted);">No other users yet. Invite someone!</p>';
  }

  showModal('New Direct Message', html);
}

function startDM(userId, username, color, status) {
  hideModal();
  selectDMUser({ id: userId, username, avatar_color: color, status });
}

// Settings
settingsBtn.addEventListener('click', () => {
  let serverSettingsHtml = '';
  if (state.currentServer) {
    const isOwner = state.currentServer.owner_id === state.user.id;
    serverSettingsHtml = `
      <hr style="border-color:var(--border-subtle);margin:16px 0;">
      <h3 style="color:var(--header-primary);margin-bottom:8px;">${escapeHtml(state.currentServer.name)}</h3>
      <div class="invite-code" style="margin-bottom:8px;">${state.currentServer.id}</div>
      <p style="color:var(--text-muted);font-size:12px;margin-bottom:12px;">Share this Server ID so others can join</p>
      ${isOwner ? `<button class="btn-danger" onclick="deleteCurrentServer()">Delete Server</button>` :
      `<button class="btn-secondary" onclick="leaveCurrentServer()">Leave Server</button>`}
    `;
  }

  showModal('Settings', `
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;">
      <div class="avatar" style="background-color:${state.user.avatar_color}">${state.user.username[0].toUpperCase()}</div>
      <div>
        <div style="color:var(--header-primary);font-weight:600;">${escapeHtml(state.user.username)}</div>
        <div style="color:var(--text-muted);font-size:12px;">ID: ${state.user.id}</div>
      </div>
    </div>
    <button class="btn-danger" onclick="logout()">Log Out</button>
    ${serverSettingsHtml}
  `);
});

async function deleteCurrentServer() {
  if (!confirm('Are you sure you want to delete this server? This cannot be undone.')) return;
  await api(`/api/servers/${state.currentServer.id}`, { method: 'DELETE' });
  hideModal();
  await loadServers();
  showHome();
}

async function leaveCurrentServer() {
  await api(`/api/servers/${state.currentServer.id}/leave`, { method: 'POST' });
  hideModal();
  await loadServers();
  showHome();
}

async function logout() {
  await api('/api/auth/logout', { method: 'POST' });
  location.reload();
}

function deleteMessage(messageId, channelId) {
  state.socket.emit('message:delete', { messageId, channelId });
}

function viewImage(url) {
  const viewer = document.getElementById('image-viewer');
  document.getElementById('viewer-img').src = url;
  viewer.classList.remove('hidden');
}

// ============ Utilities ============
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatMessage(text) {
  let escaped = escapeHtml(text);
  // Bold
  escaped = escaped.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Italic
  escaped = escaped.replace(/\*(.+?)\*/g, '<em>$1</em>');
  // Code blocks
  escaped = escaped.replace(/```([\s\S]+?)```/g, '<pre style="background:var(--bg-tertiary);padding:8px;border-radius:4px;margin:4px 0;">$1</pre>');
  // Inline code
  escaped = escaped.replace(/`(.+?)`/g, '<code style="background:var(--bg-tertiary);padding:2px 4px;border-radius:3px;">$1</code>');
  // Links
  escaped = escaped.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener" style="color:var(--text-link)">$1</a>');
  return escaped;
}

// ============ Global functions (called from onclick) ============
window.createServer = createServer;
window.joinServerById = joinServerById;
window.createChannel = createChannel;
window.startDM = startDM;
window.deleteCurrentServer = deleteCurrentServer;
window.leaveCurrentServer = leaveCurrentServer;
window.logout = logout;
window.deleteMessage = deleteMessage;
window.viewImage = viewImage;
window.toggleMute = toggleMute;
window.leaveVoiceChannel = leaveVoiceChannel;

// ============ Boot ============
checkAuth();
