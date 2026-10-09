/**
 * montyaxx.com — Script principal
 * Integração em tempo real com a API Lanyard do Discord.
 */

const CONFIG = {
  DISCORD_ID: '901940360782159872',
  DEFAULT_USERNAME: 'montyaxx',
  LANYARD_REST_URL: 'https://api.lanyard.rest/v1/users/',
  LANYARD_WS_URL: 'wss://api.lanyard.rest/socket',
  POLL_INTERVAL: 30000, // Polling de fallback a cada 30s; o WebSocket cobre atualizações em tempo real
  FALLBACK_BANNER: 'images/banner.png',
};

// Estado da aplicação
let spotifyTimer = null;   // Referência ao setInterval do progresso do Spotify
let lanyardSocket = null;  // Instância do WebSocket Lanyard
let pollInterval = null;   // Referência única ao setInterval de polling REST

// Elementos do DOM
const introScreen        = document.getElementById('intro-screen');
const titleWrapper       = document.getElementById('title-wrapper');
const profileSection     = document.getElementById('profile-section');
const cardBanner         = document.getElementById('card-banner');
const discordAvatar      = document.getElementById('discord-avatar');
const statusBadge        = document.getElementById('status-badge');
const copyTagBtn         = document.getElementById('copy-tag-btn');
const discordUsernameText = document.getElementById('discord-username-text');
const userGlobalName     = document.getElementById('user-global-name');
const activityBox        = document.getElementById('activity-box');
const toastContainer     = document.getElementById('toast-container');

/* ============================================================
   Utilitários
   ============================================================ */

/** Escapa caracteres HTML para evitar XSS ao inserir dados externos via innerHTML */
function escapeHTML(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ============================================================
   Inicialização
   ============================================================ */

function initApp() {
  initBackgroundCanvas();
  setupEventListeners();
  fetchLanyardData();
  connectLanyardWebSocket();
}

function setupEventListeners() {
  // Clique ou Enter/Espaço no título abre o perfil
  titleWrapper.addEventListener('click', openProfile);
  titleWrapper.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openProfile();
    }
  });

  // ESC fecha o perfil e volta à tela inicial
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !profileSection.classList.contains('hidden')) {
      closeProfile();
    }
  });

  // Botão de copiar tag do Discord
  copyTagBtn.addEventListener('click', () => {
    navigator.clipboard
      .writeText(CONFIG.DEFAULT_USERNAME)
      .then(() => showToast('<i class="fa-brands fa-discord"></i> Tag @montyaxx copiada!'))
      .catch(() => showToast('<i class="fa-solid fa-check"></i> Tag montyaxx copiada!'));
  });
}

function openProfile() {
  introScreen.classList.add('fade-out');
  setTimeout(() => {
    profileSection.classList.remove('hidden');
    profileSection.setAttribute('aria-hidden', 'false');
  }, 200);
}

function closeProfile() {
  profileSection.classList.add('hidden');
  profileSection.setAttribute('aria-hidden', 'true');
  setTimeout(() => {
    introScreen.classList.remove('fade-out');
  }, 200);
}

/* ============================================================
   Lanyard — API REST e WebSocket
   ============================================================ */

async function fetchLanyardData() {
  try {
    const response = await fetch(`${CONFIG.LANYARD_REST_URL}${CONFIG.DISCORD_ID}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const json = await response.json();
    if (json.success && json.data) {
      updateUIWithLanyardData(json.data);
    }
  } catch (error) {
    console.warn('Lanyard REST: usando perfil padrão.', error);
    renderDefaultProfile();
  }
}

/** Inicia o polling REST garantindo que nunca existam dois intervals simultâneos */
function startPolling() {
  if (pollInterval) return;
  pollInterval = setInterval(fetchLanyardData, CONFIG.POLL_INTERVAL);
}

function connectLanyardWebSocket() {
  try {
    lanyardSocket = new WebSocket(CONFIG.LANYARD_WS_URL);

    lanyardSocket.onopen = () => {
      lanyardSocket.send(JSON.stringify({
        op: 2,
        d: { subscribe_to_id: CONFIG.DISCORD_ID },
      }));
      startPolling(); // Ativa o polling de fallback apenas após conexão bem-sucedida
    };

    lanyardSocket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.t === 'INIT_STATE' || data.t === 'PRESENCE_UPDATE') {
          updateUIWithLanyardData(data.d);
        }
      } catch (e) {
        console.warn('Lanyard WS: erro ao processar mensagem.', e);
      }
    };

    lanyardSocket.onerror = () => {
      // Fecha explicitamente para que o onclose dispare e faça a reconexão
      lanyardSocket.close();
    };

    lanyardSocket.onclose = () => {
      lanyardSocket = null;
      setTimeout(connectLanyardWebSocket, 5000);
    };

  } catch (e) {
    console.warn('Lanyard WS: conexão falhou, usando apenas polling.');
    startPolling();
  }
}

function updateUIWithLanyardData(data) {
  const user   = data.discord_user;
  const status = data.discord_status || 'offline';

  // Mantém o banner escolhido para o site, mesmo quando o Discord fornece outro.
  cardBanner.style.backgroundImage = `url('${CONFIG.FALLBACK_BANNER}')`;

  // Avatar
  discordAvatar.src = user && user.avatar
    ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=256`
    : 'https://cdn.discordapp.com/embed/avatars/0.png';

  // Nome de exibição (global_name tem prioridade sobre username)
  userGlobalName.textContent = user
    ? (user.global_name || user.username)
    : CONFIG.DEFAULT_USERNAME;

  discordUsernameText.textContent = `@${user ? user.username : CONFIG.DEFAULT_USERNAME}`;

  // Badge de status
  const statusLabels = {
    online:  'Status: Online',
    idle:    'Status: Ausente',
    dnd:     'Status: Não Perturbe',
    offline: 'Status: Offline',
  };
  statusBadge.className = `status-badge ${status}`;
  statusBadge.title = statusLabels[status] || 'Status: Offline';

  renderActivity(data);
}

/* ============================================================
   Renderização de Atividade
   ============================================================ */

function renderActivity(data) {
  // Cancela o timer anterior antes de renderizar uma nova atividade
  if (spotifyTimer) {
    clearInterval(spotifyTimer);
    spotifyTimer = null;
  }

  // Prioridade 1: Spotify
  if (data.listening_to_spotify && data.spotify) {
    const s = data.spotify;
    const albumArt = s.album_art_url || 'https://i.scdn.co/image/ab67616d0000b273f83bf9ddf5364a5958f3fe55';

    activityBox.innerHTML = `
      <div class="spotify-activity">
        <div class="spotify-header">
          <span><i class="fa-brands fa-spotify"></i> Ouvindo Spotify</span>
          <i class="fa-solid fa-bars-staggered fa-beat"></i>
        </div>
        <div class="spotify-content">
          <img src="${escapeHTML(albumArt)}" alt="${escapeHTML(s.album)}" class="spotify-album-art" />
          <div class="spotify-details">
            <div class="spotify-song" title="${escapeHTML(s.song)}">${escapeHTML(s.song)}</div>
            <div class="spotify-artist" title="${escapeHTML(s.artist)}">por ${escapeHTML(s.artist)}</div>
          </div>
        </div>
        <div class="spotify-progress-container">
          <div class="spotify-bar-bg">
            <div id="spotify-bar-fill" class="spotify-bar-fill"></div>
          </div>
          <div class="spotify-timestamps">
            <span id="spotify-current-time">0:00</span>
            <span id="spotify-total-time">0:00</span>
          </div>
        </div>
      </div>
    `;

    updateSpotifyProgress(s.timestamps);
    spotifyTimer = setInterval(() => updateSpotifyProgress(s.timestamps), 1000);
    return;
  }

  // Prioridade 2: Jogo ou Rich Presence (exclui tipo 4 = status customizado e tipo 2 = Spotify)
  const gameActivity = data.activities
    ? data.activities.find((a) => a.type !== 4 && a.type !== 2)
    : null;

  if (gameActivity) {
    const gameName = escapeHTML(gameActivity.name || 'Jogo');
    const state    = escapeHTML(gameActivity.state || gameActivity.details || 'Em execução');
    let iconUrl    = null;

    if (gameActivity.assets?.large_image) {
      const img = gameActivity.assets.large_image;
      if (img.startsWith('mp:external')) {
        iconUrl = `https://media.discordapp.net/${img.replace('mp:', '')}`;
      } else if (!img.startsWith('spotify:')) {
        iconUrl = `https://cdn.discordapp.com/app-assets/${gameActivity.application_id}/${img}.png`;
      }
    }

    const iconHTML = iconUrl
      ? `<img src="${escapeHTML(iconUrl)}" alt="${gameName}" class="game-icon-img" onerror="this.style.display='none'" />`
      : `<div style="width:42px;height:42px;display:grid;place-items:center;color:var(--accent-purple);font-size:1.5rem;"><i class="fa-solid fa-gamepad"></i></div>`;

    activityBox.innerHTML = `
      <div class="game-activity">
        ${iconHTML}
        <div class="game-details">
          <div class="game-label"><i class="fa-solid fa-gamepad"></i> Jogando Agora</div>
          <div class="game-title">${gameName}</div>
          <div class="game-state">${state}</div>
        </div>
      </div>
    `;
    return;
  }

  // Padrão: apenas o status do Discord
  const statusStr = data.discord_status || 'offline';
  const statusTexts = {
    online:  'Online no Discord',
    idle:    'Ausente no Discord',
    dnd:     'Ocupado / Não Perturbe',
    offline: 'Offline no momento',
  };

  activityBox.innerHTML = `
    <div class="default-activity">
      <i class="fa-brands fa-discord"></i>
      <span>${statusTexts[statusStr] || 'Disponível no Discord'}</span>
    </div>
  `;
}

/** Atualiza a barra de progresso e os timestamps da música do Spotify */
function updateSpotifyProgress(timestamps) {
  if (!timestamps?.start || !timestamps?.end) return;

  const totalMs   = timestamps.end - timestamps.start;
  const currentMs = Math.min(Math.max(Date.now() - timestamps.start, 0), totalMs);
  const percent   = (currentMs / totalMs) * 100;

  const barFill        = document.getElementById('spotify-bar-fill');
  const currentTimeEl  = document.getElementById('spotify-current-time');
  const totalTimeEl    = document.getElementById('spotify-total-time');

  if (barFill)       barFill.style.width = `${percent}%`;
  if (currentTimeEl) currentTimeEl.textContent = formatTime(currentMs);
  if (totalTimeEl)   totalTimeEl.textContent   = formatTime(totalMs);
}

function formatTime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
}

/** Exibido quando a API falha — não assume nenhum status ativo */
function renderDefaultProfile() {
  cardBanner.style.backgroundImage = `url('${CONFIG.FALLBACK_BANNER}')`;
  discordAvatar.src = 'https://cdn.discordapp.com/embed/avatars/0.png';
  userGlobalName.textContent = CONFIG.DEFAULT_USERNAME;
  discordUsernameText.textContent = `@${CONFIG.DEFAULT_USERNAME}`;
  statusBadge.className = 'status-badge offline';
  statusBadge.title = 'Status: Offline';
  activityBox.innerHTML = `
    <div class="default-activity">
      <i class="fa-brands fa-discord"></i>
      <span>Offline no momento</span>
    </div>
  `;
}

/* ============================================================
   Toasts
   ============================================================ */

function showToast(message) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerHTML = message;
  toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('toast-out');
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
  }, 2500);
}

/* ============================================================
   Canvas de Partículas
   ============================================================ */

function initBackgroundCanvas() {
  const canvas = document.getElementById('bg-canvas');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  let width  = (canvas.width  = window.innerWidth);
  let height = (canvas.height = window.innerHeight);

  window.addEventListener('resize', () => {
    width  = canvas.width  = window.innerWidth;
    height = canvas.height = window.innerHeight;
  });

  const particles = Array.from({ length: 50 }, () => ({
    x:      Math.random() * width,
    y:      Math.random() * height,
    radius: Math.random() * 2 + 0.5,
    alpha:  Math.random() * 0.6 + 0.15,
    speedX: (Math.random() - 0.5) * 0.35,
    speedY: (Math.random() - 0.5) * 0.35,
  }));

  function animate() {
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, width, height);

    // Define o brilho uma vez por frame para todas as partículas
    ctx.shadowBlur  = 6;
    ctx.shadowColor = 'rgba(88, 101, 242, 0.6)';

    for (const p of particles) {
      p.x += p.speedX;
      p.y += p.speedY;

      // Wrap: partícula que sai de um lado reaparece no oposto
      if (p.x < 0)      p.x = width;
      else if (p.x > width)  p.x = 0;
      if (p.y < 0)      p.y = height;
      else if (p.y > height) p.y = 0;

      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255, 255, 255, ${p.alpha})`;
      ctx.fill();
    }

    // Reseta o shadow para não afetar outras operações de canvas futuras
    ctx.shadowBlur  = 0;
    ctx.shadowColor = 'transparent';

    requestAnimationFrame(animate);
  }

  animate();
}

document.addEventListener('DOMContentLoaded', initApp);
