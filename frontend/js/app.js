import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const EARTH_RADIUS = 2;
const PI = Math.PI;
const DEG2RAD = PI / 180;
const RAD2DEG = 180 / PI;
const TRANSITION_DIST = EARTH_RADIUS + 0.8;
const TRANSITION_BACK_ZOOM = 3;
const ALL_GROUP_FILTERS = ['stations', 'military', 'weather', 'resource', 'starlink', 'oneweb', 'custom'];
// Icon scales dynamically with camera distance
const API_BASE = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? 'http://localhost:8003'
    : '/api';
const IS_MOBILE = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || window.innerWidth <= 768;
const MOBILE_SCALE = IS_MOBILE ? 2.0 : 1.0; // 2x bigger sprites/markers on mobile

const GROUP_COLORS = {
    stations: '#00e676', military: '#ff5252',
    weather: '#ffab00', resource: '#2196f3', starlink: '#ba68c8',
    oneweb: '#26c6da', custom: '#ff9800',
};
const GROUP_NAMES = {
    stations: 'Станции', military: 'Военные',
    weather: 'Метео', resource: 'ДЗЗ', starlink: 'Starlink',
    oneweb: 'OneWeb', custom: 'Мои',
};

const COUNTRY_NAMES = {
    'USA': 'США', 'RUS': 'Россия', 'CHN': 'Китай', 'IND': 'Индия',
    'EU': 'Европа/ESA', 'JPN': 'Япония', 'KOR': 'Ю. Корея',
    'GBR': 'Великобритания', 'ISS': 'МКС (Межд.)', 'UKR': 'Украина',
};

// ============================================================
//  STATE
// ============================================================
let scene, camera, renderer, controls;
let earthMesh, cloudsMesh, atmosphereMesh, starsMesh;
let leafletMap = null;
let currentMode = '3d';
let isTransitioning = false;
let savedCamPos = null, savedCamTarget = null;
let frameCount = 0, lastFpsTime = performance.now();

// Satellites
let satEntries = [];
let selectedSat = null;
let trackLine3D = null;
let trackLine2D = null;
let lastTrackUpdate = 0;
const TRACK_UPDATE_INTERVAL = 3000; // Redraw track every 3 seconds
let activeGroupFilters = new Set(ALL_GROUP_FILTERS);
let favoritesOnly = false;
let activeOrbitFilter = null;
let activeCountryFilter = '';
let searchQuery = '';
let altFilterMin = null;
let altFilterMax = null;
let starlinkLimit = 1000; // max starlink satellites to show (default 1000)
let activeShellFilter = null; // starlink orbital shell filter
let totalInDB = 0;
let countryLayers2D = [];
let countryGeoData = {}; // { 'RUS': geojsonFeatureCollection, 'USA': ..., 'EU_FRA': ..., etc. }

// Camera restore on deselect
let savedSelectCamPos = null;
let savedSelectCamTarget = null;
let savedSelectMapView = null;
let _camFollowSat = false; // true = camera follows satellite, false = user controls camera

// Coverage zone & hex grid ("соты связи")
let hexCells3D = [];          // THREE.Mesh array for hex cells on globe
let hexCellData = [];         // {lat, lon, mesh3d, layer2d} for each cell
let coverageCircle3D = null;  // THREE.Line — work zone footprint (15°)
let coverageFill3D = null;    // THREE.Mesh - work zone fill
let coverageCircle2D = null;  // Leaflet polygon — work zone on 2D map
let coverageCone3D = null;    // THREE.Mesh — translucent cone from sat to Earth
let coverageOuterCircle3D = null; // THREE.Line — geometric visibility (0°)
let coverageOuterFill3D = null;   // THREE.Mesh — geometric visibility fill
let coverageOuterCircle2D = null; // Leaflet polygon — geometric visibility 2D
const COVERAGE_WORK_ELEV = 15;    // Work zone elevation angle (degrees)
const COVERAGE_GEO_ELEV = 0;      // Geometric visibility elevation angle
let hexLayer2D = null;        // Leaflet layer group for 2D hex cells
let hexGridBuilt = false;
let showCoverage = false;     // Coverage + hex cells toggle (right sidebar button)
const COVERAGE_GRID_FREQUENCY = 9; // geodesic subdivision tuned for realistic LEO coverage density
const HEX_GRID_STEP = 8; // legacy constant kept to avoid stale references before overrides

// Timeline / Simulation
let simTimeOffset = 0;       // offset in ms from real time (slider controls this)
let simSpeed = 1;            // speed multiplier (0.5, 1, 2, 5, 10)
let simPlaying = true;       // is simulation advancing?
let simLastReal = 0;         // last real timestamp for delta calc
let simAccumulated = 0;      // accumulated sim offset from speed != 1
let simPausedAt = null;      // frozen Date when paused

function getSimTime() {
    if (!simPlaying && simPausedAt) return simPausedAt;
    return new Date(Date.now() + simTimeOffset + simAccumulated);
}

// Auth
let authToken = localStorage.getItem('sputnik_token') || null;
let currentUser = null;
let userFavorites = new Set();

// ============================================================
//  AUTH SYSTEM
// ============================================================
async function apiRequest(url, options = {}) {
    if (authToken) {
        options.headers = { ...options.headers, 'Authorization': `Bearer ${authToken}` };
    }
    const r = await fetch(url, options);
    return r;
}

async function login(username, password) {
    const body = new URLSearchParams();
    body.append('username', username);
    body.append('password', password);
    const r = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST', body,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    if (!r.ok) {
        const d = await r.json();
        throw new Error(d.detail || 'Ошибка авторизации');
    }
    const d = await r.json();
    authToken = d.access_token;
    localStorage.setItem('sputnik_token', authToken);
    await loadCurrentUser();
}

async function register(username, email, fullName, password) {
    const r = await fetch(`${API_BASE}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, email, full_name: fullName, password }),
    });
    if (!r.ok) {
        const d = await r.json();
        throw new Error(d.detail || 'Ошибка регистрации');
    }
    // Auto-login after register
    await login(username, password);
}

async function loadCurrentUser() {
    if (!authToken) return;
    try {
        const r = await apiRequest(`${API_BASE}/auth/me`);
        if (r.ok) {
            currentUser = await r.json();
            updateAuthUI();
            await loadFavorites();
        } else {
            logout();
        }
    } catch (e) {
        logout();
    }
}

function logout() {
    authToken = null;
    currentUser = null;
    userFavorites.clear();
    localStorage.removeItem('sputnik_token');
    updateAuthUI();
}

// ---------- Auth form switching ----------
function showAuthForm(type) {
    const forms = ['loginForm', 'registerForm', 'forgotForm', 'resetForm', 'confirmResult'];
    forms.forEach(id => document.getElementById(id).style.display = 'none');
    document.getElementById('authError').classList.remove('visible');
    const titles = { login: 'Вход', register: 'Регистрация', forgot: 'Восстановление пароля', reset: 'Новый пароль', confirm: 'Подтверждение email' };
    document.getElementById('authModalTitle').textContent = titles[type] || 'Вход';
    const formMap = { login: 'loginForm', register: 'registerForm', forgot: 'forgotForm', reset: 'resetForm', confirm: 'confirmResult' };
    if (formMap[type]) document.getElementById(formMap[type]).style.display = '';
}

async function forgotPassword(email) {
    const r = await fetch(`${API_BASE}/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
    });
    const d = await r.json();
    return d;
}

async function resetPassword(token, newPassword) {
    const r = await fetch(`${API_BASE}/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, new_password: newPassword }),
    });
    if (!r.ok) {
        const d = await r.json();
        throw new Error(d.detail || 'Ошибка сброса пароля');
    }
    return await r.json();
}

async function confirmEmail(token) {
    const r = await fetch(`${API_BASE}/auth/confirm-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
    });
    const d = await r.json();
    return { ok: r.ok, data: d };
}

function updateAuthUI() {
    const btn = document.getElementById('btnAuth');
    const menu = document.getElementById('userMenu');
    if (currentUser) {
        btn.textContent = currentUser.username;
        btn.classList.add('logged-in');
        document.getElementById('menuUserName').textContent = currentUser.full_name || currentUser.username;
        document.getElementById('menuUserRole').textContent = currentUser.roles.join(', ');
        // Show leader menu item if leader or admin
        document.getElementById('menuLeader').style.display =
            (currentUser.roles.includes('leader') || currentUser.roles.includes('admin')) ? '' : 'none';
        // Show admin menu item if admin
        document.getElementById('menuAdmin').style.display =
            currentUser.roles.includes('admin') ? '' : 'none';
        // Show resend confirmation if email not confirmed
        document.getElementById('menuResendConfirm').style.display =
            currentUser.email_confirmed ? 'none' : '';
    } else {
        btn.textContent = 'Войти';
        btn.classList.remove('logged-in');
        menu.classList.remove('visible');
    }
    // Update fav button on detail panel
    updateFavButton();
    // Update chat input visibility
    const chatWrap = document.getElementById('chatInputWrap');
    if (chatWrap) chatWrap.style.display = currentUser ? 'flex' : 'none';
    if (chatOpen) loadChatMessages();
}

// ============================================================
//  FAVORITES
// ============================================================
async function loadFavorites() {
    if (!authToken) return;
    try {
        const r = await apiRequest(`${API_BASE}/favorites/`);
        if (r.ok) {
            const list = await r.json();
            userFavorites = new Set(list.map(f => f.norad_id));
        }
    } catch (e) {}
}

async function toggleFavorite(noradId) {
    if (!authToken) {
        openAuthModal();
        return;
    }
    if (userFavorites.has(noradId)) {
        const r = await apiRequest(`${API_BASE}/favorites/${noradId}`, { method: 'DELETE' });
        if (r.ok) userFavorites.delete(noradId);
    } else {
        const r = await apiRequest(`${API_BASE}/favorites/${noradId}`, { method: 'POST' });
        if (r.ok) userFavorites.add(noradId);
    }
    updateFavButton();
}

function updateFavButton() {
    const btn = document.getElementById('detailFav');
    if (!selectedSat) return;
    if (userFavorites.has(selectedSat.norad_id)) {
        btn.innerHTML = '&#9733;';
        btn.classList.add('active');
        btn.title = 'Убрать из избранного';
    } else {
        btn.innerHTML = '&#9734;';
        btn.classList.remove('active');
        btn.title = 'В избранное';
    }
}

async function showFavorites() {
    const list = document.getElementById('favList');
    list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-dim);font-size:12px;">Загрузка...</div>';
    document.getElementById('favModal').classList.add('visible');

    if (!authToken) {
        list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-dim);font-size:12px;">Войдите, чтобы видеть избранное</div>';
        return;
    }

    try {
        const r = await apiRequest(`${API_BASE}/favorites/`);
        if (!r.ok) throw new Error();
        const favs = await r.json();
        if (favs.length === 0) {
            list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-dim);font-size:12px;">Список пуст</div>';
            return;
        }
        list.innerHTML = favs.map(f => `
            <div class="fav-list-item" data-norad="${f.norad_id}">
                <div>
                    <div class="fav-list-name">${f.satellite_name}</div>
                    <div class="fav-list-id">NORAD ${f.norad_id}</div>
                </div>
                <button class="fav-remove" data-norad="${f.norad_id}" title="Удалить">&times;</button>
            </div>
        `).join('');

        list.querySelectorAll('.fav-list-item').forEach(el => {
            el.addEventListener('click', (e) => {
                if (e.target.closest('.fav-remove')) return;
                const nid = parseInt(el.dataset.norad);
                const sat = satEntries.find(s => s.norad_id === nid);
                if (sat) {
                    selectSatellite(sat);
                    document.getElementById('favModal').classList.remove('visible');
                }
            });
        });
        list.querySelectorAll('.fav-remove').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const nid = parseInt(btn.dataset.norad);
                await apiRequest(`${API_BASE}/favorites/${nid}`, { method: 'DELETE' });
                userFavorites.delete(nid);
                btn.closest('.fav-list-item').remove();
                updateFavButton();
                if (list.children.length === 0) {
                    list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-dim);font-size:12px;">Список пуст</div>';
                }
            });
        });
    } catch (e) {
        list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--danger);font-size:12px;">Ошибка загрузки</div>';
    }
}

// ============================================================
//  ADMIN PANEL
// ============================================================
let adminUsersCache = [];

async function showAdminPanel() {
    document.getElementById('adminModal').classList.add('visible');
    // Setup tabs
    document.querySelectorAll('.admin-tab').forEach(tab => {
        tab.onclick = () => {
            document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.admin-tab-content').forEach(c => c.classList.remove('active'));
            tab.classList.add('active');
            document.getElementById(tab.dataset.tab).classList.add('active');
        };
    });
    // Load all tabs
    loadAdminStats();
    loadAdminUsers();
    loadAdminTle();
    loadAdminSystem();
}

// ----- Stats Tab -----
async function loadAdminStats() {
    const container = document.getElementById('adminStatsContent');
    try {
        const [usersR, satR] = await Promise.all([
            apiRequest(`${API_BASE}/auth/users`),
            fetch(`${API_BASE}/satellites?limit=1`),
        ]);
        const users = usersR.ok ? await usersR.json() : [];
        adminUsersCache = users;

        const totalUsers = users.length;
        const admins = users.filter(u => u.roles.includes('admin')).length;
        const leaders = users.filter(u => u.roles.includes('leader')).length;
        const blocked = users.filter(u => !u.is_active).length;
        const confirmed = users.filter(u => u.email_confirmed).length;
        const totalSats = satEntries.length;
        const groups = {};
        satEntries.forEach(s => { groups[s.group] = (groups[s.group] || 0) + 1; });

        container.innerHTML = `
            <div class="stats-grid">
                <div class="stat-card">
                    <div class="stat-value">${totalUsers}</div>
                    <div class="stat-label">Пользователей</div>
                </div>
                <div class="stat-card success">
                    <div class="stat-value">${admins}</div>
                    <div class="stat-label">Админов</div>
                </div>
                <div class="stat-card warn">
                    <div class="stat-value">${leaders}</div>
                    <div class="stat-label">Руководителей</div>
                </div>
                <div class="stat-card${blocked > 0 ? ' danger' : ''}">
                    <div class="stat-value">${blocked}</div>
                    <div class="stat-label">Заблокировано</div>
                </div>
                <div class="stat-card${confirmed < totalUsers ? ' warn' : ' success'}">
                    <div class="stat-value">${confirmed}/${totalUsers}</div>
                    <div class="stat-label">Email подтв.</div>
                </div>
            </div>
            <div class="stats-grid">
                <div class="stat-card" style="grid-column:span 2;">
                    <div class="stat-value">${totalSats.toLocaleString()}</div>
                    <div class="stat-label">Спутников в базе</div>
                </div>
                <div class="stat-card" style="grid-column:span 2;">
                    <div class="stat-value">${Object.keys(groups).length}</div>
                    <div class="stat-label">Групп TLE</div>
                </div>
            </div>
            <div class="admin-section-title">Спутники по группам</div>
            ${Object.entries(groups).sort((a,b) => b[1] - a[1]).map(([g, c]) => `
                <div class="admin-info-row">
                    <span class="admin-info-label">${g}</span>
                    <span class="admin-info-value">${c.toLocaleString()}</span>
                </div>
            `).join('')}
            <div class="admin-section-title">Последние регистрации</div>
            ${users.slice(-5).reverse().map(u => `
                <div class="admin-info-row">
                    <span class="admin-info-label">${u.username} <span style="color:var(--text-dim);font-size:10px;">(${u.email})</span></span>
                    <span>${u.roles.map(r => `<span class="badge badge-${r}">${r}</span>`).join(' ')}</span>
                </div>
            `).join('')}
        `;
    } catch (e) {
        container.innerHTML = `<div class="admin-loading" style="color:var(--danger)">Ошибка: ${e.message}</div>`;
    }
}

// ----- Users Tab -----
async function loadAdminUsers() {
    const container = document.getElementById('adminUsersList');
    try {
        if (!adminUsersCache.length) {
            const r = await apiRequest(`${API_BASE}/auth/users`);
            if (!r.ok) throw new Error((await r.json()).detail);
            adminUsersCache = await r.json();
        }
        renderAdminUsers(adminUsersCache);

        // Search & filter
        document.getElementById('adminUserSearch').oninput = () => filterAdminUsers();
        document.getElementById('adminUserFilter').onchange = () => filterAdminUsers();
    } catch (e) {
        container.innerHTML = `<div class="admin-loading" style="color:var(--danger)">Ошибка: ${e.message}</div>`;
    }
}

function filterAdminUsers() {
    const q = (document.getElementById('adminUserSearch').value || '').toLowerCase();
    const f = document.getElementById('adminUserFilter').value;
    let list = adminUsersCache;
    if (q) list = list.filter(u => u.username.toLowerCase().includes(q) || u.email.toLowerCase().includes(q));
    if (f === 'admin') list = list.filter(u => u.roles.includes('admin'));
    if (f === 'leader') list = list.filter(u => u.roles.includes('leader'));
    if (f === 'active') list = list.filter(u => u.is_active);
    if (f === 'blocked') list = list.filter(u => !u.is_active);
    if (f === 'unconfirmed') list = list.filter(u => !u.email_confirmed);
    renderAdminUsers(list);
}

function renderAdminUsers(users) {
    const container = document.getElementById('adminUsersList');
    if (!users.length) {
        container.innerHTML = '<div class="admin-loading">Нет пользователей</div>';
        return;
    }
    container.innerHTML = `<table class="admin-table">
        <thead><tr>
            <th>ID</th><th>Логин</th><th>Email</th><th>Роли</th><th>Email</th><th>Статус</th><th>Действия</th>
        </tr></thead>
        <tbody>${users.map(u => `<tr>
            <td style="color:var(--text-dim)">${u.id}</td>
            <td><strong>${u.username}</strong></td>
            <td style="font-size:10px;color:var(--text-dim);">${u.email}</td>
            <td>${u.roles.map(r => `<span class="badge badge-${r}">${r}</span>`).join(' ')}</td>
            <td><span class="badge ${u.email_confirmed ? 'badge-confirmed' : 'badge-unconfirmed'}">${u.email_confirmed ? '&#10003;' : '&#10007;'}</span></td>
            <td><span class="badge ${u.is_active ? 'badge-active' : 'badge-inactive'}">${u.is_active ? 'Активен' : 'Заблокирован'}</span></td>
            <td>
                <div class="admin-actions">
                    <button class="small-btn toggle-user" data-uid="${u.id}" title="${u.is_active ? 'Заблокировать' : 'Разблокировать'}">
                        ${u.is_active ? '&#9888;' : '&#10003;'}
                    </button>
                    ${u.roles.includes('admin')
                        ? `<button class="small-btn danger remove-admin" data-uid="${u.id}" title="Снять админа">&#9733;</button>`
                        : `<button class="small-btn make-admin" data-uid="${u.id}" title="Сделать админом">&#9734;</button>`
                    }
                </div>
            </td>
        </tr>`).join('')}</tbody>
    </table>`;

    // Event listeners
    container.querySelectorAll('.toggle-user').forEach(btn => {
        btn.addEventListener('click', async () => {
            btn.disabled = true;
            await apiRequest(`${API_BASE}/auth/users/${btn.dataset.uid}/toggle`, { method: 'PUT' });
            await refreshAdminUsers();
        });
    });
    container.querySelectorAll('.make-admin').forEach(btn => {
        btn.addEventListener('click', async () => {
            btn.disabled = true;
            await apiRequest(`${API_BASE}/auth/users/${btn.dataset.uid}/role`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ role: 'admin', action: 'assign' }),
            });
            await refreshAdminUsers();
        });
    });
    container.querySelectorAll('.remove-admin').forEach(btn => {
        btn.addEventListener('click', async () => {
            if (!confirm('Снять роль администратора?')) return;
            btn.disabled = true;
            await apiRequest(`${API_BASE}/auth/users/${btn.dataset.uid}/role`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ role: 'admin', action: 'remove' }),
            });
            await refreshAdminUsers();
        });
    });
}

async function refreshAdminUsers() {
    const r = await apiRequest(`${API_BASE}/auth/users`);
    if (r.ok) {
        adminUsersCache = await r.json();
        filterAdminUsers();
        loadAdminStats();
    }
}

// ----- TLE Tab -----
async function loadAdminTle() {
    const container = document.getElementById('adminTleContent');
    try {
        const groups = {};
        satEntries.forEach(s => {
            if (!groups[s.group]) groups[s.group] = { count: 0, orbits: {} };
            groups[s.group].count++;
            const orb = s.orbit_type || 'N/A';
            groups[s.group].orbits[orb] = (groups[s.group].orbits[orb] || 0) + 1;
        });

        container.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
                <div>
                    <div style="font-size:13px;font-weight:600;">TLE данные — ${satEntries.length.toLocaleString()} спутников</div>
                    <div style="font-size:10px;color:var(--text-dim);">Источник: Celestrak (NORAD)</div>
                </div>
                <button class="admin-action-btn" id="adminTleRefresh">&#8635; Обновить TLE</button>
            </div>
            ${Object.entries(groups).sort((a,b) => b[1].count - a[1].count).map(([g, data]) => `
                <div class="tle-group-card">
                    <div>
                        <div class="tle-group-name">${g}</div>
                        <div class="tle-group-meta">
                            ${Object.entries(data.orbits).map(([o,c]) => `${o}: ${c}`).join(' · ')}
                        </div>
                    </div>
                    <div class="tle-group-count">${data.count.toLocaleString()} шт.</div>
                </div>
            `).join('')}
            <div class="admin-section-title" style="margin-top:20px;">Быстрые действия</div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;">
                <button class="admin-action-btn" id="adminExportTle">&#8682; Экспорт списка</button>
            </div>
        `;

        document.getElementById('adminTleRefresh').addEventListener('click', async function() {
            this.disabled = true;
            this.textContent = 'Обновление...';
            try {
                const r = await apiRequest(`${API_BASE}/tle/update`, { method: 'POST' });
                const d = await r.json();
                this.textContent = '&#10003; Обновлено!';
                setTimeout(() => {
                    this.disabled = false;
                    this.innerHTML = '&#8635; Обновить TLE';
                    loadAdminTle();
                }, 2000);
            } catch (e) {
                this.textContent = 'Ошибка';
                this.disabled = false;
            }
        });

        document.getElementById('adminExportTle').addEventListener('click', () => {
            const csv = 'NORAD_ID,Name,Group,Orbit_Type\n' +
                satEntries.map(s => `${s.norad_id},"${s.name}",${s.group},${s.orbit_type||''}`).join('\n');
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'sputnik_satellites.csv';
            a.click();
        });
    } catch (e) {
        container.innerHTML = `<div class="admin-loading" style="color:var(--danger)">Ошибка: ${e.message}</div>`;
    }
}

// ----- System Tab -----
function loadAdminSystem() {
    const container = document.getElementById('adminSystemContent');
    const uptime = Math.floor((Date.now() - performance.timeOrigin) / 1000);
    const mins = Math.floor(uptime / 60);
    const secs = uptime % 60;

    container.innerHTML = `
        <div class="admin-section-title">Информация о системе</div>
        <div class="admin-info-row">
            <span class="admin-info-label">Платформа</span>
            <span class="admin-info-value">Sputnik v0.1.0</span>
        </div>
        <div class="admin-info-row">
            <span class="admin-info-label">Backend API</span>
            <span class="admin-info-value">${API_BASE}</span>
        </div>
        <div class="admin-info-row">
            <span class="admin-info-label">Сессия браузера</span>
            <span class="admin-info-value">${mins}м ${secs}с</span>
        </div>
        <div class="admin-info-row">
            <span class="admin-info-label">Режим отображения</span>
            <span class="admin-info-value">${currentMode === '3d' ? '3D (Three.js)' : '2D (Leaflet)'}</span>
        </div>
        <div class="admin-info-row">
            <span class="admin-info-label">Загружено спутников</span>
            <span class="admin-info-value">${satEntries.length.toLocaleString()}</span>
        </div>
        <div class="admin-info-row">
            <span class="admin-info-label">Текущий пользователь</span>
            <span class="admin-info-value">${currentUser ? currentUser.username + ' (' + currentUser.roles.join(', ') + ')' : '—'}</span>
        </div>
        <div class="admin-info-row">
            <span class="admin-info-label">Симуляция</span>
            <span class="admin-info-value">${simPlaying ? 'Играет' : 'Пауза'} · x${simSpeed}</span>
        </div>
        <div class="admin-section-title" style="margin-top:16px;">Управление</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;">
            <button class="admin-action-btn" id="adminClearDb">&#10006; Очистить тестовые данные</button>
            <button class="admin-action-btn" onclick="location.reload()">&#8635; Перезагрузить клиент</button>
        </div>
        <div class="admin-section-title" style="margin-top:16px;">Горячие клавиши</div>
        <div class="admin-info-row">
            <span class="admin-info-label">F — Полный экран</span>
            <span class="admin-info-label">Space — Play/Pause</span>
        </div>
        <div class="admin-info-row">
            <span class="admin-info-label">Esc — Закрыть/Сброс</span>
            <span class="admin-info-label">Tab — Переключить 2D/3D</span>
        </div>
    `;

    document.getElementById('adminClearDb').addEventListener('click', async function() {
        if (!confirm('Удалить всех тестовых пользователей (кроме админов)?')) return;
        this.disabled = true;
        this.textContent = 'Очистка...';
        // Just reload to show effect
        setTimeout(() => { this.disabled = false; this.innerHTML = '&#10006; Очистить тестовые данные'; }, 1500);
    });
}

// ============================================================
//  LEADER PANEL
// ============================================================
let leaderUsersCache = [];

async function showLeaderPanel() {
    document.getElementById('leaderModal').classList.add('visible');
    // Setup tabs
    document.querySelectorAll('#leaderModal .admin-tab').forEach(tab => {
        tab.onclick = () => {
            document.querySelectorAll('#leaderModal .admin-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('#leaderModal .admin-tab-content').forEach(c => c.classList.remove('active'));
            tab.classList.add('active');
            document.getElementById(tab.dataset.tab).classList.add('active');
        };
    });
    await loadLeaderTeam();
    loadLeaderActivity();

    // Add user button
    document.getElementById('leaderAddUser').onclick = () => {
        const username = prompt('Логин нового пользователя:');
        if (!username) return;
        const email = prompt('Email:');
        if (!email) return;
        const fullName = prompt('Полное имя:');
        if (!fullName) return;
        const password = prompt('Пароль:');
        if (!password) return;

        fetch(`${API_BASE}/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, email, full_name: fullName, password }),
        })
        .then(r => r.json())
        .then(d => {
            if (d.id) {
                alert(`Пользователь ${d.username} создан (ID: ${d.id})`);
                loadLeaderTeam();
            } else {
                alert('Ошибка: ' + (d.detail || JSON.stringify(d)));
            }
        })
        .catch(e => alert('Ошибка: ' + e.message));
    };
}

async function loadLeaderTeam() {
    const container = document.getElementById('leaderUsersList');
    container.innerHTML = '<div class="admin-loading">Загрузка...</div>';
    try {
        const r = await apiRequest(`${API_BASE}/auth/users`);
        if (!r.ok) {
            container.innerHTML = '<div class="admin-loading" style="color:var(--danger)">Нет доступа</div>';
            return;
        }
        leaderUsersCache = await r.json();
        filterLeaderUsers();
    } catch (e) {
        container.innerHTML = '<div class="admin-loading" style="color:var(--danger)">Ошибка загрузки</div>';
    }
}

function filterLeaderUsers() {
    const search = (document.getElementById('leaderUserSearch')?.value || '').toLowerCase();
    const container = document.getElementById('leaderUsersList');
    let users = leaderUsersCache;
    if (search) {
        users = users.filter(u =>
            u.username.toLowerCase().includes(search) ||
            u.email.toLowerCase().includes(search) ||
            (u.full_name || '').toLowerCase().includes(search)
        );
    }

    container.innerHTML = `
    <table class="admin-table">
        <thead><tr>
            <th>ID</th><th>Логин</th><th>Имя</th><th>Email</th><th>Роли</th><th>Статус</th><th>Действия</th>
        </tr></thead>
        <tbody>${users.map(u => `<tr>
            <td>${u.id}</td>
            <td style="font-weight:600;">${u.username}</td>
            <td>${u.full_name || '—'}</td>
            <td style="font-size:10px;">${u.email}</td>
            <td>${u.roles.map(r =>
                `<span class="badge badge-${r==='admin'?'admin':r==='leader'?'admin':'user'}"
                 ${r==='leader'?'style="background:rgba(255,171,0,0.15);color:var(--warning);"':''}>${r}</span>`
            ).join(' ')}</td>
            <td><span class="badge ${u.is_active ? 'badge-active' : 'badge-inactive'}">${u.is_active ? 'Активен' : 'Заблокирован'}</span></td>
            <td class="admin-actions">
                ${u.roles.includes('leader') || u.roles.includes('admin') ? '' :
                    `<button class="small-btn leader-assign" data-uid="${u.id}" title="Назначить в команду">&#43;</button>`
                }
                ${u.roles.includes('leader') && !u.roles.includes('admin') ?
                    `<button class="small-btn danger leader-remove" data-uid="${u.id}" title="Убрать из команды">&#8722;</button>` : ''
                }
            </td>
        </tr>`).join('')}</tbody>
    </table>`;

    // Search handler
    const searchInput = document.getElementById('leaderUserSearch');
    if (searchInput && !searchInput.dataset.bound) {
        searchInput.dataset.bound = 'true';
        searchInput.addEventListener('input', () => filterLeaderUsers());
    }

    // Assign to team (give leader role)
    container.querySelectorAll('.leader-assign').forEach(btn => {
        btn.addEventListener('click', async () => {
            btn.disabled = true;
            await apiRequest(`${API_BASE}/auth/users/${btn.dataset.uid}/role`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ role: 'leader', action: 'assign' }),
            });
            await loadLeaderTeam();
        });
    });

    // Remove from team
    container.querySelectorAll('.leader-remove').forEach(btn => {
        btn.addEventListener('click', async () => {
            if (!confirm('Убрать пользователя из команды?')) return;
            btn.disabled = true;
            await apiRequest(`${API_BASE}/auth/users/${btn.dataset.uid}/role`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ role: 'leader', action: 'remove' }),
            });
            await loadLeaderTeam();
        });
    });
}

async function loadLeaderActivity() {
    const container = document.getElementById('leaderActivityContent');
    try {
        // Show recent chat messages as activity
        const r = await apiRequest(`${API_BASE}/chat/messages?limit=30`);
        if (!r.ok) {
            container.innerHTML = '<div class="admin-loading">Нет данных</div>';
            return;
        }
        const msgs = await r.json();
        if (msgs.length === 0) {
            container.innerHTML = '<div class="admin-loading">Нет активности</div>';
            return;
        }
        container.innerHTML = `
            <div class="admin-section-title" style="padding:16px 16px 0;">Последние сообщения в чате</div>
            <div style="padding:8px 16px;">
            ${msgs.slice(-20).reverse().map(m => {
                const time = m.created_at ? new Date(m.created_at).toLocaleString('ru-RU', {day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}) : '';
                const topRole = m.user_roles.includes('admin') ? 'admin' : m.user_roles.includes('leader') ? 'leader' : '';
                return `<div class="admin-info-row" style="flex-direction:column;align-items:flex-start;gap:2px;">
                    <div style="display:flex;gap:6px;align-items:center;width:100%;">
                        <span style="font-weight:600;color:${topRole==='admin'?'var(--danger)':topRole==='leader'?'var(--warning)':'var(--accent)'};font-size:11px;">${escapeHtml(m.full_name || m.username)}</span>
                        ${topRole ? `<span class="badge badge-${topRole}" ${topRole==='leader'?'style="background:rgba(255,171,0,0.15);color:var(--warning);"':''}>${topRole==='admin'?'Админ':'Руководитель'}</span>` : ''}
                        <span style="margin-left:auto;font-size:9px;color:var(--text-dim);">${time}</span>
                    </div>
                    <div style="font-size:11px;color:var(--text);word-break:break-word;">${escapeHtml(m.text).substring(0, 120)}${m.text.length > 120 ? '...' : ''}</div>
                </div>`;
            }).join('')}
            </div>
        `;
    } catch (e) {
        container.innerHTML = '<div class="admin-loading" style="color:var(--danger)">Ошибка</div>';
    }
}

// ============================================================
//  SATELLITE MANAGER
// ============================================================
// ============================================================
//  ANALYSIS PANEL — Constellation comparison & stats
// ============================================================
function showAnalysis() {
    const modal = document.getElementById('analysisModal');
    modal.classList.add('visible');
    document.getElementById('analysisModalClose').onclick = () => modal.classList.remove('visible');

    // Tab switching
    modal.querySelectorAll('.admin-tab').forEach(tab => {
        tab.onclick = () => {
            modal.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
            modal.querySelectorAll('.admin-tab-content').forEach(c => c.classList.remove('active'));
            tab.classList.add('active');
            document.getElementById(tab.dataset.tab).classList.add('active');
            if (tab.dataset.tab === 'analysis-compare') renderAnalysisCompare();
            if (tab.dataset.tab === 'analysis-passes') initAnalysisPasses();
        };
    });

    renderAnalysisOverview();
}

function renderAnalysisOverview() {
    const container = document.getElementById('analysisOverviewContent');
    const total = satEntries.length;

    // Group stats
    const groups = {};
    const orbits = { LEO: 0, MEO: 0, GEO: 0, HEO: 0 };
    const countries = {};
    let totalAlt = 0, altCount = 0;

    satEntries.forEach(s => {
        groups[s.group] = (groups[s.group] || 0) + 1;
        if (s.orbit_type && orbits[s.orbit_type] !== undefined) orbits[s.orbit_type]++;
        if (s.country) countries[s.country] = (countries[s.country] || 0) + 1;
        if (s.alt > 0) { totalAlt += s.alt; altCount++; }
    });

    const avgAlt = altCount ? (totalAlt / altCount).toFixed(0) : '—';
    const maxGroup = Object.entries(groups).sort((a,b) => b[1]-a[1]);

    container.innerHTML = `
        <div class="analysis-stat-grid">
            <div class="analysis-stat-card">
                <div class="analysis-stat-value">${total}</div>
                <div class="analysis-stat-label">На карте</div>
            </div>
            <div class="analysis-stat-card">
                <div class="analysis-stat-value">${totalInDB.toLocaleString()}</div>
                <div class="analysis-stat-label">Всего в БД</div>
            </div>
            <div class="analysis-stat-card">
                <div class="analysis-stat-value">${Object.keys(groups).length}</div>
                <div class="analysis-stat-label">Группировок</div>
            </div>
            <div class="analysis-stat-card">
                <div class="analysis-stat-value">${Object.keys(countries).length}</div>
                <div class="analysis-stat-label">Стран</div>
            </div>
            <div class="analysis-stat-card">
                <div class="analysis-stat-value">${avgAlt}</div>
                <div class="analysis-stat-label">Ср. высота (км)</div>
            </div>
        </div>

        <div class="analysis-section-title">Распределение по группировкам</div>
        ${maxGroup.map(([g, cnt]) => {
            const pct = (cnt / total * 100).toFixed(1);
            const color = GROUP_COLORS[g] || '#00bfff';
            const name = GROUP_NAMES[g] || g;
            return `<div class="analysis-bar-row">
                <div class="analysis-bar-label">${name}</div>
                <div class="analysis-bar-wrap"><div class="analysis-bar-fill" style="width:${pct}%;background:${color};"></div></div>
                <div class="analysis-bar-count">${cnt} (${pct}%)</div>
            </div>`;
        }).join('')}

        <div class="analysis-section-title">Распределение по типу орбиты</div>
        ${Object.entries(orbits).map(([o, cnt]) => {
            const pct = total ? (cnt / total * 100).toFixed(1) : 0;
            const colors = { LEO: '#00e676', MEO: '#2196f3', GEO: '#ffab00', HEO: '#ff5252' };
            return `<div class="analysis-bar-row">
                <div class="analysis-bar-label">${o}</div>
                <div class="analysis-bar-wrap"><div class="analysis-bar-fill" style="width:${pct}%;background:${colors[o]};"></div></div>
                <div class="analysis-bar-count">${cnt} (${pct}%)</div>
            </div>`;
        }).join('')}

        <div class="analysis-section-title">Распределение по странам</div>
        ${Object.entries(countries).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([c, cnt]) => {
            const pct = (cnt / total * 100).toFixed(1);
            const name = COUNTRY_NAMES[c] || c;
            return `<div class="analysis-bar-row">
                <div class="analysis-bar-label">${name}</div>
                <div class="analysis-bar-wrap"><div class="analysis-bar-fill" style="width:${pct}%;background:var(--accent);"></div></div>
                <div class="analysis-bar-count">${cnt} (${pct}%)</div>
            </div>`;
        }).join('')}
    `;
}

function renderAnalysisCompare() {
    const container = document.getElementById('analysisCompareContent');

    // Build group comparison table
    const groupData = {};
    satEntries.forEach(s => {
        if (!groupData[s.group]) groupData[s.group] = { count: 0, orbits: {}, altSum: 0, altCount: 0, countries: new Set() };
        const gd = groupData[s.group];
        gd.count++;
        gd.orbits[s.orbit_type || 'N/A'] = (gd.orbits[s.orbit_type || 'N/A'] || 0) + 1;
        if (s.alt > 0) { gd.altSum += s.alt; gd.altCount++; }
        if (s.country) gd.countries.add(s.country);
    });

    const rows = Object.entries(groupData).sort((a,b) => b[1].count - a[1].count);

    container.innerHTML = `
        <div class="analysis-section-title">Сравнение группировок</div>
        <div style="overflow-x:auto;">
        <table class="analysis-compare-table">
            <thead>
                <tr>
                    <th>Группировка</th>
                    <th>Кол-во</th>
                    <th>Ср. высота</th>
                    <th>Орбиты</th>
                    <th>Стран</th>
                </tr>
            </thead>
            <tbody>
                ${rows.map(([g, d]) => {
                    const avgAlt = d.altCount ? (d.altSum / d.altCount).toFixed(0) + ' км' : '—';
                    const color = GROUP_COLORS[g] || '#00bfff';
                    const name = GROUP_NAMES[g] || g;
                    const orbitStr = Object.entries(d.orbits).map(([o,c]) => `${o}: ${c}`).join(', ');
                    return `<tr>
                        <td><span class="analysis-group-dot" style="background:${color};"></span>${name}</td>
                        <td>${d.count}</td>
                        <td>${avgAlt}</td>
                        <td style="font-size:10px;">${orbitStr}</td>
                        <td>${d.countries.size}</td>
                    </tr>`;
                }).join('')}
            </tbody>
        </table>
        </div>

        <div class="analysis-section-title" style="margin-top:20px;">Starlink vs OneWeb</div>
        ${renderConstellationComparison('starlink', 'oneweb')}

        <div class="analysis-section-title" style="margin-top:20px;">Военные vs ДЗЗ</div>
        ${renderConstellationComparison('military', 'resource')}
    `;
}

function renderConstellationComparison(group1, group2) {
    const g1 = satEntries.filter(s => s.group === group1);
    const g2 = satEntries.filter(s => s.group === group2);
    const name1 = GROUP_NAMES[group1] || group1;
    const name2 = GROUP_NAMES[group2] || group2;
    const color1 = GROUP_COLORS[group1] || '#00bfff';
    const color2 = GROUP_COLORS[group2] || '#ff9800';

    const avgAlt1 = g1.filter(s=>s.alt>0).reduce((a,s)=>a+s.alt,0) / Math.max(g1.filter(s=>s.alt>0).length, 1);
    const avgAlt2 = g2.filter(s=>s.alt>0).reduce((a,s)=>a+s.alt,0) / Math.max(g2.filter(s=>s.alt>0).length, 1);
    const avgVel1 = g1.filter(s=>s.vel>0).reduce((a,s)=>a+s.vel,0) / Math.max(g1.filter(s=>s.vel>0).length, 1);
    const avgVel2 = g2.filter(s=>s.vel>0).reduce((a,s)=>a+s.vel,0) / Math.max(g2.filter(s=>s.vel>0).length, 1);

    const metrics = [
        ['Спутников на карте', g1.length, g2.length],
        ['Средняя высота (км)', avgAlt1.toFixed(0), avgAlt2.toFixed(0)],
        ['Средняя скорость (км/с)', avgVel1.toFixed(2), avgVel2.toFixed(2)],
    ];

    return `<table class="analysis-compare-table">
        <thead><tr><th>Параметр</th><th style="color:${color1};">${name1}</th><th style="color:${color2};">${name2}</th></tr></thead>
        <tbody>${metrics.map(([label, v1, v2]) => `<tr><td>${label}</td><td>${v1}</td><td>${v2}</td></tr>`).join('')}</tbody>
    </table>`;
}

function initAnalysisPasses() {
    // Region chip multi-select
    document.querySelectorAll('#analysisRegionChips .region-chip').forEach(chip => {
        chip.addEventListener('click', () => chip.classList.toggle('active'));
    });

    document.getElementById('analysisPassCalc').onclick = async () => {
        const selectedRegions = [...document.querySelectorAll('#analysisRegionChips .region-chip.active')].map(c => c.dataset.region);
        if (selectedRegions.length === 0) {
            document.getElementById('analysisPassResults').innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-dim);font-size:12px;">Выберите хотя бы один регион</div>';
            return;
        }
        const group = document.getElementById('analysisPassGroup').value;
        const hours = parseInt(document.getElementById('analysisPassHours')?.value) || 24;
        const resultsDiv = document.getElementById('analysisPassResults');
        const progressDiv = document.getElementById('analysisPassProgress');
        progressDiv.style.display = '';
        resultsDiv.innerHTML = '';

        // Run calculation in next tick to let UI update
        await new Promise(r => setTimeout(r, 50));

        try {
            const results = predictPassesOverRegions(selectedRegions, hours, group);
            progressDiv.style.display = 'none';

            if (results.length === 0) {
                resultsDiv.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-dim);font-size:12px;">Нет пролётов в ближайшие ' + hours + ' часов</div>';
                return;
            }

            const totalPasses = results.reduce((sum, r) => sum + r.passes.length, 0);
            const regionNames = selectedRegions.map(c => COUNTRY_NAMES[c] || c).join(', ');
            resultsDiv.innerHTML =
                '<div style="font-size:11px;color:var(--text-dim);margin-bottom:10px;">' +
                    'Найдено <b>' + totalPasses + '</b> пролётов от <b>' + results.length + '</b> спутников над <b>' + regionNames + '</b>' +
                '</div>' +
                results.slice(0, 50).map(sat => {
                    const passes = sat.passes.slice(0, 5);
                    return '<div class="pass-card">' +
                        '<div class="pass-card-header">' +
                            '<span class="pass-card-name">' + sat.name + '</span>' +
                            '<span class="pass-card-badge">' + (sat.orbit_type || 'N/A') + ' · ' + (GROUP_NAMES[sat.group] || sat.group) + '</span>' +
                        '</div>' +
                        passes.map(p => {
                            const enter = new Date(p.enter_time);
                            const exit = new Date(p.exit_time);
                            return '<div class="pass-card-detail">' +
                                enter.toLocaleString('ru-RU', {day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}) +
                                ' — ' + exit.toLocaleTimeString('ru-RU', {hour:'2-digit',minute:'2-digit'}) +
                                ' · ' + p.duration_seconds + 'с · Высота: ' + p.max_altitude_km + ' км' +
                            '</div>';
                        }).join('') +
                    '</div>';
                }).join('');

            // Click on pass card to select satellite
            resultsDiv.querySelectorAll('.pass-card').forEach((card, idx) => {
                card.style.cursor = 'pointer';
                card.addEventListener('click', () => {
                    const satData = results[idx];
                    const found = satEntries.find(s => s.norad_id === satData.norad_id);
                    if (found) {
                        selectSatellite(found);
                        document.getElementById('analysisModal').classList.remove('visible');
                    }
                });
            });
        } catch (e) {
            progressDiv.style.display = 'none';
            resultsDiv.innerHTML = '<div style="text-align:center;color:var(--danger);font-size:12px;padding:16px;">Ошибка: ' + e.message + '</div>';
        }
    };
}

// ============================================================
//  SATELLITE MANAGER
// ============================================================
function showSatManager() {
    const modal = document.getElementById('satManagerModal');
    modal.classList.add('visible');

    // Tab switching
    modal.querySelectorAll('.admin-tab').forEach(tab => {
        tab.onclick = () => {
            modal.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
            modal.querySelectorAll('.admin-tab-content').forEach(c => c.classList.remove('active'));
            tab.classList.add('active');
            document.getElementById(tab.dataset.tab).classList.add('active');
            if (tab.dataset.tab === 'satmgr-my') loadMySatellites();
        };
    });
    document.getElementById('satManagerClose').onclick = () => modal.classList.remove('visible');

    // Browse tab
    renderSatBrowseList();
    document.getElementById('satBrowseSearch').oninput = () => renderSatBrowseList();
    document.getElementById('satBrowseGroup').onchange = () => renderSatBrowseList();
    document.getElementById('satBrowseCountry').onchange = () => renderSatBrowseList();

    // Import tab
    const fileInput = document.getElementById('tleFileInput');
    const importBtn = document.getElementById('tleImportBtn');
    fileInput.onchange = () => { importBtn.disabled = !fileInput.files.length; };
    importBtn.onclick = () => importTleFile();

    // Export buttons
    document.getElementById('exportCsvBtn').onclick = () => exportCsv();
    document.getElementById('exportTleBtn').onclick = () => exportTle();
}

function renderSatBrowseList() {
    const search = (document.getElementById('satBrowseSearch').value || '').toLowerCase();
    const group = document.getElementById('satBrowseGroup').value;
    const country = document.getElementById('satBrowseCountry').value;

    let list = satEntries;
    if (group) list = list.filter(s => s.group === group);
    if (country) list = list.filter(s => s.country === country);
    if (search) list = list.filter(s => s.name.toLowerCase().includes(search) || String(s.norad_id).includes(search));

    const shown = list.slice(0, 200);
    const container = document.getElementById('satBrowseList');
    document.getElementById('satBrowseCount').textContent = `Показано ${shown.length} из ${list.length} спутников`;

    if (shown.length === 0) {
        container.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-dim);font-size:12px;">Ничего не найдено</div>';
        return;
    }

    container.innerHTML = shown.map(s => {
        const orbitClass = s.orbit_type ? `orbit-${s.orbit_type}` : '';
        const countryLabel = s.country || '';
        const operatorLabel = s.operator ? ` · ${s.operator}` : '';
        return `<div class="sat-browse-item" data-norad="${s.norad_id}">
            <div>
                <div class="sat-browse-name">${escapeHtml(s.name)}</div>
                <div class="sat-browse-meta">NORAD ${s.norad_id} · ${GROUP_NAMES[s.group]||s.group}${countryLabel ? ' · '+countryLabel : ''}${operatorLabel}</div>
            </div>
            <div style="display:flex;gap:4px;align-items:center;">
                ${s.orbit_type ? `<span class="sat-browse-badge ${orbitClass}">${s.orbit_type}</span>` : ''}
                ${s.alt ? `<span class="sat-browse-badge">${Math.round(s.alt)} km</span>` : ''}
            </div>
        </div>`;
    }).join('');

    // Click to select satellite and close modal
    container.querySelectorAll('.sat-browse-item').forEach(item => {
        item.addEventListener('click', () => {
            const nid = parseInt(item.dataset.norad);
            const sat = satEntries.find(s => s.norad_id === nid);
            if (sat) {
                document.getElementById('satManagerModal').classList.remove('visible');
                selectSatellite(sat);
            }
        });
    });
}

async function importTleFile() {
    const fileInput = document.getElementById('tleFileInput');
    const resultDiv = document.getElementById('tleImportResult');
    if (!fileInput.files.length) return;

    const file = fileInput.files[0];
    const formData = new FormData();
    formData.append('file', file);

    resultDiv.innerHTML = '<span style="color:var(--accent);">Загрузка...</span>';
    document.getElementById('tleImportBtn').disabled = true;

    try {
        const r = await apiRequest(`${API_BASE}/satellites/import-tle`, {
            method: 'POST',
            body: formData,
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.detail || 'Ошибка импорта');

        resultDiv.innerHTML = `<span style="color:var(--success);">Импорт завершён: +${d.added} новых, ~${d.updated} обновлено${d.errors ? `, ${d.errors} ошибок` : ''} (всего ${d.total_in_file} в файле)</span>`;

        // Reload satellites
        await loadSatellites();
        await initSatSprites3D();
        initSatMarkers2D();
        applyFilters();
    } catch (e) {
        resultDiv.innerHTML = `<span style="color:var(--danger);">${e.message}</span>`;
    }
    document.getElementById('tleImportBtn').disabled = false;
}

function exportCsv() {
    const csv = 'NORAD_ID,Name,Group,Orbit_Type,Country,Operator\n' +
        satEntries.map(s => `${s.norad_id},"${s.name}",${s.group},${s.orbit_type||''},${s.country||''},${s.operator||''}`).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'sputnik_satellites.csv';
    a.click();
}

function exportTle() {
    const tle = satEntries.map(s => {
        const rec = s.satrec;
        if (!rec) return null;
        return `${s.name}\n${rec.satnum ? s.name : s.name}\n`;
    }).filter(Boolean);
    // Use actual TLE lines from the API data — we need to re-fetch or store them
    // For now, export name + norad
    const lines = [];
    satEntries.forEach(s => {
        if (s.satrec && s.satrec.satnum) {
            // reconstruct from stored data (we need tle_line1/tle_line2)
            // Since we don't store raw TLE on client, do a simple export
            lines.push(s.name);
            lines.push(`NORAD: ${s.norad_id} | Group: ${s.group} | Orbit: ${s.orbit_type || 'N/A'} | Country: ${s.country || 'N/A'}`);
            lines.push('');
        }
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'sputnik_satellites.txt';
    a.click();
}

async function loadMySatellites() {
    const container = document.getElementById('mySatsList');
    if (!authToken) {
        container.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-dim);font-size:12px;">Войдите в аккаунт для просмотра</div>';
        return;
    }
    container.innerHTML = '<div class="admin-loading">Загрузка...</div>';
    try {
        const r = await apiRequest(`${API_BASE}/satellites/my`);
        if (!r.ok) throw new Error('Ошибка загрузки');
        const d = await r.json();
        if (d.count === 0) {
            container.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-dim);font-size:12px;">У вас нет загруженных спутников.<br>Перейдите на вкладку «Импорт / Экспорт» для загрузки TLE-файла.</div>';
            return;
        }
        container.innerHTML = d.satellites.map(s => `
            <div class="sat-browse-item">
                <div>
                    <div class="sat-browse-name">${escapeHtml(s.name)}</div>
                    <div class="sat-browse-meta">NORAD ${s.norad_id} · ${s.orbit_type || 'N/A'}${s.country ? ' · '+s.country : ''}</div>
                </div>
                <button class="admin-action-btn" style="font-size:10px;padding:3px 8px;color:var(--danger);border-color:var(--danger);" onclick="window.deleteMysat(${s.norad_id})">Удалить</button>
            </div>
        `).join('');
    } catch (e) {
        container.innerHTML = `<div class="admin-loading" style="color:var(--danger);">${e.message}</div>`;
    }
}

window.deleteMysat = async function(noradId) {
    if (!confirm('Удалить этот спутник?')) return;
    try {
        const r = await apiRequest(`${API_BASE}/satellites/my/${noradId}`, { method: 'DELETE' });
        if (r.ok) loadMySatellites();
    } catch (e) {}
};

// ============================================================
//  CHAT SYSTEM
// ============================================================
let chatOpen = false;
let chatMessages = [];
let chatPollingTimer = null;
let chatMentionSearch = '';

function toggleChat() {
    chatOpen = !chatOpen;
    document.getElementById('chatSidebar').classList.toggle('open', chatOpen);
    document.getElementById('chatToggleBtn').style.display = chatOpen ? 'none' : '';
    if (chatOpen) {
        loadChatMessages();
        startChatPolling();
        if (currentUser) {
            document.getElementById('chatInputWrap').style.display = 'flex';
        }
    } else {
        stopChatPolling();
    }
}

function startChatPolling() {
    stopChatPolling();
    chatPollingTimer = setInterval(loadChatMessages, 5000);
}

function stopChatPolling() {
    if (chatPollingTimer) { clearInterval(chatPollingTimer); chatPollingTimer = null; }
}

async function loadChatMessages() {
    if (!authToken) {
        document.getElementById('chatMessages').innerHTML =
            '<div class="chat-empty">Войдите в аккаунт, чтобы видеть и отправлять сообщения</div>';
        return;
    }
    try {
        const r = await apiRequest(`${API_BASE}/chat/messages?limit=100`);
        if (!r.ok) return;
        const msgs = await r.json();
        chatMessages = msgs;
        renderChatMessages();
    } catch (e) { /* silent */ }
}

function renderChatMessages() {
    const container = document.getElementById('chatMessages');
    if (!chatMessages.length) {
        container.innerHTML = '<div class="chat-empty">Нет сообщений. Начните диалог!</div>';
        return;
    }
    const myId = currentUser ? currentUser.id : -1;
    container.innerHTML = chatMessages.map(m => {
        const isOwn = m.user_id === myId;
        const topRole = m.user_roles.includes('admin') ? 'admin'
            : m.user_roles.includes('leader') ? 'leader' : '';
        const canDelete = isOwn || (currentUser && (currentUser.roles.includes('admin') || currentUser.roles.includes('leader')));

        // Process text — find @satellite mentions
        let processedText = escapeHtml(m.text);
        // Replace @SAT_NAME patterns with clickable cards
        processedText = processedText.replace(/@\[([^\]]+)\]\((\d+)\)/g, (match, name, noradId) => {
            const sat = satEntries.find(s => s.norad_id == noradId);
            const info = sat ? `${sat.orbit_type || '?'} · ${sat.group}` : '';
            return `<a class="chat-sat-mention" onclick="chatFocusSat(${noradId})" title="Нажмите для фокусировки">
                <span class="sat-icon">&#128752;</span>
                <span>${name}<span class="chat-sat-info">${info}</span></span>
            </a>`;
        });

        const time = m.created_at ? new Date(m.created_at).toLocaleTimeString('ru-RU', {hour:'2-digit',minute:'2-digit'}) : '';
        const date = m.created_at ? new Date(m.created_at).toLocaleDateString('ru-RU', {day:'2-digit',month:'2-digit'}) : '';

        return `<div class="chat-msg${isOwn ? ' own' : ''}" data-mid="${m.id}">
            <div class="chat-msg-header">
                <span class="chat-msg-user ${topRole}">${escapeHtml(m.full_name || m.username)}</span>
                ${topRole ? `<span class="chat-msg-role ${topRole}">${topRole === 'admin' ? 'Админ' : 'Руководитель'}</span>` : ''}
                <span class="chat-msg-time">${date} ${time}</span>
                ${canDelete ? `<button class="chat-msg-delete" onclick="deleteChatMsg(${m.id})" title="Удалить">&#10006;</button>` : ''}
            </div>
            <div class="chat-msg-text">${processedText}</div>
        </div>`;
    }).join('');

    // Auto-scroll to bottom
    container.scrollTop = container.scrollHeight;
}

function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
}

async function sendChatMessage() {
    const input = document.getElementById('chatInput');
    let text = input.value.trim();
    if (!text || !authToken) return;

    // Disable while sending
    input.disabled = true;
    document.getElementById('chatSend').disabled = true;

    try {
        // Extract mentioned satellite norad_id (first mention)
        let mentionedNoradId = null;
        const mentionMatch = text.match(/@\[([^\]]+)\]\((\d+)\)/);
        if (mentionMatch) mentionedNoradId = parseInt(mentionMatch[2]);

        const r = await apiRequest(`${API_BASE}/chat/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, mentioned_norad_id: mentionedNoradId }),
        });
        if (r.ok) {
            input.value = '';
            input.style.height = 'auto';
            await loadChatMessages();
        }
    } catch (e) { /* silent */ }

    input.disabled = false;
    document.getElementById('chatSend').disabled = false;
    input.focus();
}

async function deleteChatMsg(id) {
    if (!confirm('Удалить сообщение?')) return;
    try {
        await apiRequest(`${API_BASE}/chat/messages/${id}`, { method: 'DELETE' });
        await loadChatMessages();
    } catch (e) { /* silent */ }
}

function chatFocusSat(noradId) {
    const sat = satEntries.find(s => s.norad_id == noradId);
    if (sat) selectSatellite(sat);
}

// @mention autocomplete
function setupChatMentions() {
    const input = document.getElementById('chatInput');
    const popup = document.getElementById('chatMentionPopup');

    input.addEventListener('input', () => {
        const val = input.value;
        const cursorPos = input.selectionStart;
        // Find @ before cursor
        const beforeCursor = val.substring(0, cursorPos);
        const atMatch = beforeCursor.match(/@([^@\s]{0,30})$/);

        if (atMatch) {
            chatMentionSearch = atMatch[1].toLowerCase();
            const results = satEntries
                .filter(s => s.name.toLowerCase().includes(chatMentionSearch) ||
                             String(s.norad_id).includes(chatMentionSearch))
                .slice(0, 8);

            if (results.length && chatMentionSearch.length >= 1) {
                popup.innerHTML = results.map(s => `
                    <div class="chat-mention-item" data-norad="${s.norad_id}" data-name="${escapeHtml(s.name)}">
                        <span class="chat-mention-name">&#128752; ${escapeHtml(s.name)}</span>
                        <span class="chat-mention-id">#${s.norad_id} · ${s.orbit_type || '?'}</span>
                    </div>
                `).join('');
                popup.classList.add('visible');

                popup.querySelectorAll('.chat-mention-item').forEach(item => {
                    item.addEventListener('click', () => {
                        const name = item.dataset.name;
                        const norad = item.dataset.norad;
                        // Replace @query with @[NAME](NORAD_ID)
                        const before = val.substring(0, cursorPos - chatMentionSearch.length - 1);
                        const after = val.substring(cursorPos);
                        input.value = before + `@[${name}](${norad}) ` + after;
                        popup.classList.remove('visible');
                        input.focus();
                    });
                });
            } else {
                popup.classList.remove('visible');
            }
        } else {
            popup.classList.remove('visible');
        }

        // Auto-resize
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 80) + 'px';
    });

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendChatMessage();
        }
    });
}

// ============================================================
//  PASSES CALCULATION
// ============================================================

/**
 * Client-side satellite pass prediction over a country polygon.
 * Uses satellite.js for orbit propagation and turf.js for point-in-polygon.
 * @param {string[]} regionCodes - array of country codes (e.g. ['RUS','UKR'])
 * @param {number} hoursAhead - how many hours to predict
 * @param {string} groupFilter - satellite group filter or '' for all
 * @returns {Array} array of pass objects
 */
function predictPassesOverRegions(regionCodes, hoursAhead = 24, groupFilter = '') {
    // Merge all selected region polygons into one multipolygon for testing
    let regionFeatures = [];
    for (const code of regionCodes) {
        const gj = countryGeoData[code];
        if (gj && gj.features) {
            regionFeatures.push(...gj.features);
        }
        // Also check EU sub-countries
        if (code === 'EU') {
            for (const euCode of EU_COUNTRY_CODES) {
                const euGj = countryGeoData['EU_' + euCode];
                if (euGj && euGj.features) regionFeatures.push(...euGj.features);
            }
        }
    }
    if (regionFeatures.length === 0) return [];

    // Filter satellites
    let sats = satEntries;
    if (groupFilter) sats = sats.filter(s => s.group === groupFilter);

    const now = new Date();
    const endTime = new Date(now.getTime() + hoursAhead * 3600000);
    const stepMs = hoursAhead <= 12 ? 30000 : 60000; // 30s for short, 60s for long predictions
    const results = [];

    for (const sat of sats) {
        if (!sat.satrec) continue;
        const passes = [];
        let inRegion = false;
        let passStart = null;
        let maxAlt = 0;

        for (let t = now.getTime(); t <= endTime.getTime(); t += stepMs) {
            const date = new Date(t);
            try {
                const posVel = satellite.propagate(sat.satrec, date);
                if (!posVel.position) continue;
                const gmst = satellite.gstime(date);
                const geo = satellite.eciToGeodetic(posVel.position, gmst);
                const lat = satellite.degreesLat(geo.latitude);
                const lon = satellite.degreesLong(geo.longitude);
                const alt = geo.height;
                const pt = turf.point([lon, lat]);

                let inside = false;
                for (const feat of regionFeatures) {
                    try {
                        if (turf.booleanPointInPolygon(pt, feat)) { inside = true; break; }
                    } catch(e) {}
                }

                if (inside && !inRegion) {
                    // Enter region
                    inRegion = true;
                    passStart = date;
                    maxAlt = alt;
                } else if (inside && inRegion) {
                    maxAlt = Math.max(maxAlt, alt);
                } else if (!inside && inRegion) {
                    // Exit region
                    inRegion = false;
                    const duration = Math.round((t - passStart.getTime()) / 1000);
                    if (duration >= 10) { // ignore very short passes
                        passes.push({
                            enter_time: passStart.toISOString(),
                            exit_time: date.toISOString(),
                            duration_seconds: duration,
                            max_altitude_km: Math.round(maxAlt),
                            sat_name: sat.name,
                            norad_id: sat.norad_id,
                            group: sat.group,
                            orbit_type: sat.orbit_type,
                        });
                    }
                }
            } catch(e) {}
        }
        // If still in region at end
        if (inRegion && passStart) {
            const duration = Math.round((endTime.getTime() - passStart.getTime()) / 1000);
            if (duration >= 10) {
                passes.push({
                    enter_time: passStart.toISOString(),
                    exit_time: endTime.toISOString(),
                    duration_seconds: duration,
                    max_altitude_km: Math.round(maxAlt),
                    sat_name: sat.name,
                    norad_id: sat.norad_id,
                    group: sat.group,
                    orbit_type: sat.orbit_type,
                });
            }
        }
        if (passes.length > 0) {
            results.push({ name: sat.name, norad_id: sat.norad_id, group: sat.group, orbit_type: sat.orbit_type, passes });
        }
    }

    // Sort by first pass time
    results.sort((a, b) => new Date(a.passes[0].enter_time) - new Date(b.passes[0].enter_time));
    return results;
}

function populatePassRegions() {
    const select = document.getElementById('passesRegion');
    if (!select) return;
    select.innerHTML = '';
    const countries = { RUS:'Россия', USA:'США', CHN:'Китай', IND:'Индия', UKR:'Украина', JPN:'Япония', KOR:'Ю. Корея', GBR:'Великобритания', EU:'Европа/ESA' };
    for (const [code, name] of Object.entries(countries)) {
        const opt = document.createElement('option');
        opt.value = code;
        opt.textContent = name;
        select.appendChild(opt);
    }
}

async function loadPassesRegions() {
    try {
        const r = await fetch(`${API_BASE}/passes/regions`);
        if (!r.ok) return;
        const regions = await r.json();
        const select = document.getElementById('passesRegion');
        select.innerHTML = Object.entries(regions).map(([k, v]) =>
            `<option value="${k}">${v.name} (${v.lat.toFixed(2)}, ${v.lon.toFixed(2)})</option>`
        ).join('');
    } catch (e) {}
}

async function calculatePasses() {
    const btn = document.getElementById('passesCalcBtn');
    const results = document.getElementById('passesResults');
    const region = document.getElementById('passesRegion').value;
    const group = document.getElementById('passesGroup').value;
    const hours = parseInt(document.getElementById('passesHours').value) || 24;

    btn.disabled = true;
    btn.textContent = 'Расчёт...';
    results.innerHTML = '<div style="text-align:center;color:var(--text-dim);font-size:12px;padding:16px;">Идёт расчёт орбит, подождите...</div>';

    await new Promise(r => setTimeout(r, 50));

    try {
        const data = predictPassesOverRegions([region], hours, group);

        if (data.length === 0) {
            results.innerHTML = '<div style="text-align:center;color:var(--text-dim);font-size:12px;padding:16px;">Пролётов не найдено</div>';
        } else {
            const totalPasses = data.reduce((sum, r) => sum + r.passes.length, 0);
            results.innerHTML = '<div style="font-size:11px;color:var(--text-dim);margin-bottom:8px;">Найдено ' + totalPasses + ' пролётов от ' + data.length + ' спутников</div>' +
                data.slice(0, 20).map(sat =>
                    '<div class="passes-sat-group">' +
                        '<div class="passes-sat-name">' + sat.name + ' <span style="color:var(--text-dim);font-size:10px;">' + (sat.orbit_type || '') + '</span></div>' +
                        sat.passes.slice(0, 3).map(p => {
                            const enter = new Date(p.enter_time);
                            const exit = new Date(p.exit_time);
                            return '<div class="pass-item">' +
                                '<div class="pass-time">' + enter.toLocaleString('ru-RU', {day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}) + ' — ' + exit.toLocaleTimeString('ru-RU', {hour:'2-digit',minute:'2-digit'}) + '</div>' +
                                '<div class="pass-meta">' + p.duration_seconds + 'с | Высота: ' + p.max_altitude_km + ' км</div>' +
                            '</div>';
                        }).join('') +
                    '</div>'
                ).join('');
        }
    } catch (e) {
        results.innerHTML = '<div style="text-align:center;color:var(--danger);font-size:12px;padding:16px;">Ошибка: ' + e.message + '</div>';
    }
    btn.disabled = false;
    btn.textContent = 'Рассчитать';
}

// ============================================================
//  MODAL HELPERS
// ============================================================
function openAuthModal() {
    document.getElementById('authError').classList.remove('visible');
    document.getElementById('loginForm').style.display = '';
    document.getElementById('registerForm').style.display = 'none';
    document.getElementById('authModalTitle').textContent = 'Вход';
    document.getElementById('authModal').classList.add('visible');
}

function closeAllModals() {
    document.querySelectorAll('.modal-overlay').forEach(m => m.classList.remove('visible'));
}

// ============================================================
//  COUNTRY DETECTION FROM TLE / SATELLITE NAME
// ============================================================
function detectCountry(name, intlDes) {
    const n = name.toUpperCase();
    if (n.includes('STARLINK') || n.includes('GPS') || n.includes('TDRS') || n.includes('GOES') || n.includes('NOAA')) return 'USA';
    if (n.includes('COSMOS') || n.includes('KOSMOS') || n.includes('RESURS') || n.includes('METEOR') || n.includes('GLONASS') || n.includes('ZARYA') || n.includes('NAUKA') || n.includes('PROGRESS') || n.includes('SOYUZ')) return 'RUS';
    if (n.includes('BEIDOU') || n.includes('YAOGAN') || n.includes('SHIJIAN') || n.includes('TIANHE') || n.includes('WENTIAN') || n.includes('MENGTIAN') || n.includes('CZ-')) return 'CHN';
    if (n.includes('IRNSS') || n.includes('GSAT') || n.includes('CARTOSAT') || n.includes('RESOURCESAT') || n.includes('OCEANSAT')) return 'IND';
    if (n.includes('ASTRA') || n.includes('GALILEO') || n.includes('SENTINEL') || n.includes('METEOSAT')) return 'EU';
    if (n.includes('QZSS') || n.includes('HIMAWARI')) return 'JPN';
    if (n.includes('ISS')) return 'ISS (Межд.)';
    // Fallback by international designator launch site patterns
    return '';
}

function parseIntlDesignator(tleLine1) {
    if (!tleLine1 || tleLine1.length < 17) return '';
    return tleLine1.substring(9, 17).trim();
}

// ============================================================
//  SGP4 CLIENT-SIDE CALCULATIONS
// ============================================================
function propagateSat(satrec, date) {
    if (!satrec) return null;
    const pv = satellite.propagate(satrec, date);
    if (!pv || !pv.position) return null;
    const gmst = satellite.gstime(date);
    const gd = satellite.eciToGeodetic(pv.position, gmst);
    const lat = satellite.degreesLat(gd.latitude);
    const lon = satellite.degreesLong(gd.longitude);
    const alt = gd.height;
    const vel = Math.sqrt(pv.velocity.x**2 + pv.velocity.y**2 + pv.velocity.z**2);
    return { lat, lon, alt, vel };
}

function calcTrack(satrec, orbitsCount = 1.5, steps = 300) {
    const points = [];
    const now = getSimTime().getTime();
    const periodMin = satrec.no > 0 ? (2 * PI / satrec.no) : 90;
    const totalMinutes = periodMin * orbitsCount;
    // 40% past, 60% future — so the trail behind is clearly visible
    const pastMinutes = totalMinutes * 0.4;
    const futureMinutes = totalMinutes * 0.6;
    const totalMs = (pastMinutes + futureMinutes) * 60000;
    const startMs = now - pastMinutes * 60000;
    for (let i = 0; i <= steps; i++) {
        const t = new Date(startMs + (i / steps) * totalMs);
        const pos = propagateSat(satrec, t);
        if (pos) points.push({ ...pos, t: t.getTime(), isFuture: t.getTime() > now });
    }
    return points;
}

// ============================================================
//  SUN DIRECTION
// ============================================================
function getSunDirection() {
    const now = getSimTime();
    const dayOfYear = Math.floor((now - new Date(now.getUTCFullYear(), 0, 0)) / 86400000);
    const hourUTC = now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600;
    const sunLon = -(hourUTC - 12) * 15 * DEG2RAD;
    const sunLat = 23.44 * Math.sin(2 * PI * (dayOfYear - 80) / 365) * DEG2RAD;
    return new THREE.Vector3(Math.cos(sunLat)*Math.cos(sunLon), Math.sin(sunLat), Math.cos(sunLat)*Math.sin(sunLon)).normalize();
}

// ============================================================
//  HELPERS
// ============================================================
function getCameraLatLng() {
    const d = camera.position.clone().normalize();
    return { lat: Math.asin(d.y) * RAD2DEG, lng: Math.atan2(d.z, d.x) * RAD2DEG };
}
let camAnim = null;
function animateCameraTo(pos, dur = 1500, lookAt = null) {
    camAnim = {
        start: camera.position.clone(),
        target: pos.clone(),
        targetStart: controls ? controls.target.clone() : null,
        targetLookAt: lookAt ? lookAt.clone() : null,
        t0: performance.now(),
        dur,
    };
}
function updateCamAnim() {
    if (!camAnim) return;
    const t = Math.min(1, (performance.now() - camAnim.t0) / camAnim.dur);
    const e = t < 0.5 ? 2*t*t : 1 - Math.pow(-2*t+2,2)/2;
    camera.position.lerpVectors(camAnim.start, camAnim.target, e);
    if (camAnim.targetLookAt && camAnim.targetStart) {
        controls.target.lerpVectors(camAnim.targetStart, camAnim.targetLookAt, e);
    }
    if (t >= 1) camAnim = null;
}
function latLonToVec3(lat, lon, altKm) {
    const r = EARTH_RADIUS + (altKm / 6371) * EARTH_RADIUS;
    const la = lat * DEG2RAD, lo = lon * DEG2RAD;
    return new THREE.Vector3(r*Math.cos(la)*Math.cos(lo), r*Math.sin(la), r*Math.cos(la)*Math.sin(lo));
}
function hasSatPosition(s) {
    return !!s && Number.isFinite(s.lat) && Number.isFinite(s.lon) && Number.isFinite(s.alt);
}
function getSatelliteCameraPose(s) {
    const satPos = latLonToVec3(s.lat, s.lon, s.alt || 0);
    const outward = satPos.clone().normalize();
    const extraOffset = Math.min(2.4, Math.max(0.45, satPos.length() * 0.18));
    return {
        satPos,
        cameraPos: satPos.clone().add(outward.multiplyScalar(extraOffset)),
    };
}

// ============================================================
//  TEXTURES
// ============================================================
function loadTex(url, fb) {
    return new Promise(res => { new THREE.TextureLoader().load(url, res, undefined, () => res(fb ? fb() : new THREE.Texture())); });
}
function proceduralEarth() {
    const c = document.createElement('canvas'); c.width = 2048; c.height = 1024;
    const x = c.getContext('2d');
    const g = x.createLinearGradient(0,0,0,1024);
    g.addColorStop(0,'#1a3a5c'); g.addColorStop(0.5,'#1976D2'); g.addColorStop(1,'#1a3a5c');
    x.fillStyle=g; x.fillRect(0,0,2048,1024);
    x.fillStyle='#2E7D32';
    [[600,180,800,220,820,310,700,380,520,250],[1100,140,1500,160,1550,240,1400,340,1090,200]].forEach(pts=>{
        x.beginPath(); x.moveTo(pts[0],pts[1]); for(let i=2;i<pts.length;i+=2)x.lineTo(pts[i],pts[i+1]); x.closePath(); x.fill();
    });
    return new THREE.CanvasTexture(c);
}
function proceduralNight() {
    const c = document.createElement('canvas'); c.width = 2048; c.height = 1024;
    const x = c.getContext('2d'); x.fillStyle='#000'; x.fillRect(0,0,2048,1024);
    [[520,220,80],[540,240,60],[580,230,50],[600,200,50],[640,210,40],[1400,260,90],[1420,280,70],
     [1200,350,60],[340,240,80],[360,250,60],[200,270,50],[1460,250,50],[1520,520,40]].forEach(([cx,cy,r])=>{
        const g=x.createRadialGradient(cx,cy,0,cx,cy,r);
        g.addColorStop(0,'rgba(255,200,80,0.9)'); g.addColorStop(0.3,'rgba(255,170,50,0.5)');
        g.addColorStop(0.7,'rgba(255,140,30,0.15)'); g.addColorStop(1,'rgba(255,100,0,0)');
        x.fillStyle=g; x.fillRect(cx-r,cy-r,r*2,r*2);
        for(let i=0;i<r*1.5;i++){const sx=cx+(Math.random()-.5)*r*2,sy=cy+(Math.random()-.5)*r*2,sr=1+Math.random()*3;
        const sg=x.createRadialGradient(sx,sy,0,sx,sy,sr);sg.addColorStop(0,`rgba(255,${180+Math.random()*75|0},${50+Math.random()*80|0},0.5)`);sg.addColorStop(1,'rgba(0,0,0,0)');x.fillStyle=sg;x.fillRect(sx-sr,sy-sr,sr*2,sr*2);}
    });
    return new THREE.CanvasTexture(c);
}
function proceduralClouds() {
    const c = document.createElement('canvas'); c.width=2048; c.height=1024;
    const x=c.getContext('2d'); x.clearRect(0,0,2048,1024);
    for(let i=0;i<500;i++){const cx=Math.random()*2048,cy=Math.random()*1024,r=20+Math.random()*80;
    const g=x.createRadialGradient(cx,cy,0,cx,cy,r);g.addColorStop(0,`rgba(255,255,255,${0.1+Math.random()*0.15})`);g.addColorStop(1,'rgba(255,255,255,0)');x.fillStyle=g;x.fillRect(cx-r,cy-r,r*2,r*2);}
    return new THREE.CanvasTexture(c);
}

// ============================================================
//  EARTH SHADER
// ============================================================
const earthVS = `varying vec2 vUv; varying vec3 vNormal; varying vec3 vWorldPos;
void main(){vUv=uv;vNormal=normalize((modelMatrix*vec4(normal,0.0)).xyz);vWorldPos=(modelMatrix*vec4(position,1.0)).xyz;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`;
const earthFS = `uniform sampler2D dayMap,nightMap,specMap;uniform vec3 sunDir;uniform float nightLightsIntensity;
varying vec2 vUv;varying vec3 vNormal;varying vec3 vWorldPos;
void main(){vec3 n=normalize(vNormal);float NdL=dot(n,sunDir);float df=smoothstep(-0.15,0.25,NdL);
vec3 dc=texture2D(dayMap,vUv).rgb*(.08+.92*max(NdL,0.));
vec3 vd=normalize(cameraPosition-vWorldPos);float sp=pow(max(dot(n,normalize(sunDir+vd)),0.),25.)*.4*texture2D(specMap,vUv).r;dc+=vec3(sp)*df;
vec3 nl=texture2D(nightMap,vUv).rgb*vec3(1.3,1.,.7)*2.*nightLightsIntensity;
gl_FragColor=vec4(mix(nl+dc*.02,dc,df),1.);}`;

// ============================================================
//  INIT 3D
// ============================================================
async function init3D() {
    scene = new THREE.Scene(); scene.background = new THREE.Color(0x0a0e17);
    const h = window.innerHeight - 48;
    camera = new THREE.PerspectiveCamera(45, window.innerWidth / h, 0.1, 200);
    camera.position.set(0, 1.5, 5.5);
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, h);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;
    document.getElementById('view3D').appendChild(renderer.domElement);

    controls = new OrbitControls(camera, renderer.domElement);
    Object.assign(controls, { enableDamping:true, dampingFactor:0.06, rotateSpeed:0.6, zoomSpeed:0.9, minDistance:EARTH_RADIUS+0.05, maxDistance:Infinity, enablePan:false });
    controls.addEventListener('start', () => { _camFollowSat = false; });
    // Unbind camera from satellite when user interacts
    renderer.domElement.addEventListener('mousedown', () => { _camFollowSat = false; });
    renderer.domElement.addEventListener('wheel', () => { _camFollowSat = false; });
    renderer.domElement.addEventListener('touchstart', () => { _camFollowSat = false; });

    const sunLight = new THREE.DirectionalLight(0xffffff, 2.0);
    sunLight.position.copy(getSunDirection().multiplyScalar(10)); sunLight.name='sunLight';
    scene.add(sunLight); scene.add(new THREE.AmbientLight(0x334466, 0.4));

    const [earthMap, earthSpec, nightMap, cloudMap] = await Promise.all([
        loadTex('https://threejs.org/examples/textures/planets/earth_atmos_2048.jpg', proceduralEarth),
        loadTex('https://threejs.org/examples/textures/planets/earth_specular_2048.jpg', null),
        loadTex('https://threejs.org/examples/textures/planets/earth_lights_2048.png', proceduralNight),
        loadTex('https://threejs.org/examples/textures/planets/earth_clouds_1024.png', proceduralClouds),
    ]);

    earthMesh = new THREE.Mesh(new THREE.SphereGeometry(EARTH_RADIUS,128,64), new THREE.ShaderMaterial({
        uniforms:{dayMap:{value:earthMap},nightMap:{value:nightMap},specMap:{value:earthSpec},sunDir:{value:getSunDirection()},nightLightsIntensity:{value:1.0}},
        vertexShader:earthVS, fragmentShader:earthFS,
    }));
    earthMesh.rotation.y = -PI/2; scene.add(earthMesh);

    cloudsMesh = new THREE.Mesh(new THREE.SphereGeometry(EARTH_RADIUS+0.012,96,48),
        new THREE.MeshPhongMaterial({map:cloudMap,transparent:true,opacity:0.35,depthWrite:false,blending:THREE.AdditiveBlending}));
    cloudsMesh.rotation.y=-PI/2; scene.add(cloudsMesh);

    atmosphereMesh = new THREE.Mesh(new THREE.SphereGeometry(EARTH_RADIUS+0.1,64,32), new THREE.ShaderMaterial({
        vertexShader:`varying vec3 vN,vW;void main(){vN=normalize(normalMatrix*normal);vW=(modelMatrix*vec4(position,1.)).xyz;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
        fragmentShader:`varying vec3 vN,vW;void main(){float r=pow(1.-max(dot(normalize(cameraPosition-vW),vN),0.),3.);gl_FragColor=vec4(mix(vec3(.3,.6,1.),vec3(.1,.3,.8),r),r*.45);}`,
        transparent:true,side:THREE.BackSide,depthWrite:false}));
    scene.add(atmosphereMesh);

    const sg=new THREE.BufferGeometry(),sc=10000,sp=new Float32Array(sc*3);
    for(let i=0;i<sc;i++){const r=50+Math.random()*50,th=Math.random()*PI*2,ph=Math.acos(2*Math.random()-1);sp[i*3]=r*Math.sin(ph)*Math.cos(th);sp[i*3+1]=r*Math.sin(ph)*Math.sin(th);sp[i*3+2]=r*Math.cos(ph);}
    sg.setAttribute('position',new THREE.BufferAttribute(sp,3));
    starsMesh=new THREE.Points(sg,new THREE.PointsMaterial({color:0xffffff,size:0.08,transparent:true,opacity:0.25}));
    scene.add(starsMesh);

    renderer.domElement.addEventListener('mousemove', onMouseMove3D);
    renderer.domElement.addEventListener('click', onClick3D);
}

// ============================================================
//  SATELLITE SPRITE FACTORY
// ============================================================
// ============================================================
//  GROUP-SPECIFIC SATELLITE SVG ICONS (vector, crisp at any zoom)
// ============================================================

/** SVG icon templates per satellite group. Each returns an SVG string.
 *  COLOR is injected at runtime. viewBox is 0 0 64 64. */
const SAT_SVG_ICONS = {
    // Stations: ISS — body + 4 solar panels + truss
    stations: (c) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
        <line x1="4" y1="32" x2="60" y2="32" stroke="${c}" stroke-width="2"/>
        <rect x="27" y="22" width="10" height="20" rx="1" fill="${c}"/>
        <rect x="4" y="22" width="20" height="8" rx="1" fill="${c}" opacity="0.8"/>
        <rect x="4" y="34" width="20" height="8" rx="1" fill="${c}" opacity="0.8"/>
        <rect x="40" y="22" width="20" height="8" rx="1" fill="${c}" opacity="0.8"/>
        <rect x="40" y="34" width="20" height="8" rx="1" fill="${c}" opacity="0.8"/>
        <line x1="14" y1="22" x2="14" y2="30" stroke="${c}" stroke-width="0.5" opacity="0.4"/>
        <line x1="24" y1="22" x2="24" y2="30" stroke="${c}" stroke-width="0.5" opacity="0.4"/>
        <line x1="14" y1="34" x2="14" y2="42" stroke="${c}" stroke-width="0.5" opacity="0.4"/>
        <line x1="50" y1="22" x2="50" y2="30" stroke="${c}" stroke-width="0.5" opacity="0.4"/>
        <line x1="50" y1="34" x2="50" y2="42" stroke="${c}" stroke-width="0.5" opacity="0.4"/>
    </svg>`,

    // Military: angular shield / stealth
    military: (c) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
        <polygon points="32,4 56,22 48,52 32,60 16,52 8,22" fill="${c}"/>
        <polygon points="32,18 42,30 32,42 22,30" fill="#000" opacity="0.25"/>
        <line x1="32" y1="4" x2="32" y2="18" stroke="#000" stroke-width="0.5" opacity="0.2"/>
    </svg>`,

    // Weather/Meteo: body + parabolic dish + panels
    weather: (c) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
        <path d="M18,18 A18,18 0 0,1 40,10" stroke="${c}" stroke-width="3.5" fill="none" stroke-linecap="round"/>
        <line x1="26" y1="16" x2="38" y2="40" stroke="${c}" stroke-width="2"/>
        <circle cx="38" cy="40" r="8" fill="${c}"/>
        <line x1="18" y1="40" x2="58" y2="40" stroke="${c}" stroke-width="1.5"/>
        <rect x="8" y="36" width="12" height="8" rx="1" fill="${c}" opacity="0.7"/>
        <rect x="52" y="36" width="10" height="8" rx="1" fill="${c}" opacity="0.7"/>
    </svg>`,

    // Resource/DZZ: body + camera lens + panels
    resource: (c) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
        <rect x="24" y="14" width="16" height="26" rx="2" fill="${c}"/>
        <circle cx="32" cy="46" r="7" fill="${c}"/>
        <circle cx="32" cy="46" r="3.5" fill="#000" opacity="0.35"/>
        <line x1="24" y1="28" x2="8" y2="28" stroke="${c}" stroke-width="1.5"/>
        <line x1="40" y1="28" x2="56" y2="28" stroke="${c}" stroke-width="1.5"/>
        <rect x="4" y="23" width="16" height="10" rx="1" fill="${c}" opacity="0.7"/>
        <rect x="44" y="23" width="16" height="10" rx="1" fill="${c}" opacity="0.7"/>
    </svg>`,

    // Starlink: minimalist triangle
    starlink: (c) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
        <polygon points="32,8 56,52 8,52" fill="${c}" opacity="0.85"/>
    </svg>`,

    // OneWeb: sphere + signal arcs + solar wings
    oneweb: (c) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
        <circle cx="32" cy="32" r="10" fill="${c}"/>
        <path d="M44,22 A18,18 0 0,1 44,42" stroke="${c}" stroke-width="2" fill="none" opacity="0.6"/>
        <path d="M50,18 A24,24 0 0,1 50,46" stroke="${c}" stroke-width="1.5" fill="none" opacity="0.4"/>
        <path d="M55,14 A30,30 0 0,1 55,50" stroke="${c}" stroke-width="1" fill="none" opacity="0.25"/>
        <rect x="4" y="28" width="16" height="8" rx="1" fill="${c}" opacity="0.75"/>
        <rect x="44" y="28" width="16" height="8" rx="1" fill="${c}" opacity="0.75"/>
    </svg>`,

    // Custom/My: 5-pointed star
    custom: (c) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
        <polygon points="32,4 38,24 58,24 42,36 48,56 32,44 16,56 22,36 6,24 26,24" fill="${c}"/>
        <circle cx="32" cy="32" r="4" fill="#000" opacity="0.2"/>
    </svg>`,
};

/** Default fallback: simple circle */
const SAT_SVG_DEFAULT = (c) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
    <circle cx="32" cy="32" r="16" fill="${c}"/>
</svg>`;

// ---- SVG → Texture cache (per group+color+selected combo) ----
const _svgTexCache = new Map();

/** Convert an SVG string to a THREE.CanvasTexture (high-res, crisp) */
function svgToTexture(svgStr, size) {
    const img = new Image();
    const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const c = document.createElement('canvas');
    c.width = size; c.height = size;
    // Draw synchronously by setting src (works for data/blob URIs in same origin)
    img.src = url;
    const ctx = c.getContext('2d');
    // We'll draw on load; return a texture that updates
    const tex = new THREE.CanvasTexture(c);
    tex.needsUpdate = false;
    img.onload = () => {
        ctx.clearRect(0, 0, size, size);
        ctx.drawImage(img, 0, 0, size, size);
        tex.needsUpdate = true;
        URL.revokeObjectURL(url);
    };
    return tex;
}

function makeSatSprite(color, selected = false, group = '') {
    const key = `${group}|${color}|${selected ? 1 : 0}`;
    let tex = _svgTexCache.get(key);
    if (tex) return tex;

    const sz = selected ? 128 : 64; // High-res canvas for crisp rendering
    const svgFn = SAT_SVG_ICONS[group] || SAT_SVG_DEFAULT;
    let svgStr = svgFn(color);

    if (selected) {
        // Add selection ring around the icon
        svgStr = svgStr.replace('</svg>',
            `<circle cx="32" cy="32" r="30" stroke="${color}" stroke-width="2" fill="none" opacity="0.8"/>` +
            `<circle cx="32" cy="32" r="31" stroke="${color}" stroke-width="0.5" fill="none" opacity="0.3" stroke-dasharray="3 2"/>` +
            '</svg>');
    }

    tex = svgToTexture(svgStr, sz);
    _svgTexCache.set(key, tex);
    return tex;
}

/** Generate an HTML string for a 2D Leaflet satellite icon (inline SVG, no drop-shadow for perf) */
function makeSatIconHtml(group, color, size) {
    const svgFn = SAT_SVG_ICONS[group] || SAT_SVG_DEFAULT;
    const svg = svgFn(color).replace('<svg ', `<svg width="${size}" height="${size}" `);
    return svg;
}

// ============================================================
//  LOAD SATELLITES FROM API (TLE data)
// ============================================================
async function loadSatellites() {
    satEntries = [];
    invalidateFilterCache();
    // Load ALL satellite groups (including large constellations)
    const allGroups = ['stations','military','weather','resource','starlink','oneweb'];
    const BATCH_SIZE = 5000;
    let loadedCount = 0;

    for (const g of allGroups) {
        let offset = 0;
        let hasMore = true;
        while (hasMore) {
            try {
                const r = await fetch(`${API_BASE}/satellites/tle-data?group=${g}&limit=${BATCH_SIZE}&offset=${offset}`);
                if (!r.ok) break;
                const d = await r.json();
                totalInDB = Math.max(totalInDB, d.total || 0);
                const sats = d.satellites || [];
                for (const s of sats) {
                    try {
                        const satrec = satellite.twoline2satrec(s.tle_line1, s.tle_line2);
                        const intlDes = parseIntlDesignator(s.tle_line1);
                        const country = s.country || detectCountry(s.name, intlDes);
                        const operator = s.operator || '';
                        satEntries.push({ norad_id:s.norad_id, name:s.name, group:s.group, orbit_type:s.orbit_type, satrec, lat:0, lon:0, alt:0, vel:0, sprite3d:null, marker2d:null, country, operator, intlDes });
                    } catch(e) {}
                }
                loadedCount += sats.length;
                document.getElementById('statusText').textContent = `Загрузка спутников... ${loadedCount}`;
                offset += BATCH_SIZE;
                hasMore = sats.length === BATCH_SIZE;
            } catch(e) { hasMore = false; }
        }
    }
    // Load user custom satellites
    if (authToken) {
        try {
            const r = await apiRequest(`${API_BASE}/satellites/my`);
            if (r.ok) {
                const d = await r.json();
                for (const s of d.satellites) {
                    // Skip if already loaded
                    if (satEntries.find(e => e.norad_id === s.norad_id)) continue;
                    try {
                        const sr = satellite.twoline2satrec(s.tle_line1, s.tle_line2);
                        satEntries.push({norad_id:s.norad_id, name:s.name, group:'custom', orbit_type:s.orbit_type, satrec:sr, lat:0, lon:0, alt:0, vel:0, sprite3d:null, marker2d:null, country:s.country||'', operator:s.operator||'', intlDes:parseIntlDesignator(s.tle_line1)});
                    } catch(e){}
                }
            }
        } catch(e){}
    }
    // Get total DB count
    try { const r=await fetch(`${API_BASE}/satellites/?limit=1`);if(r.ok){const d=await r.json();totalInDB=d.total;} } catch(e){}
    invalidateFilterCache(); // MUST invalidate AFTER loading, not before
    // Adjust SGP4 update interval for large datasets
    if (satEntries.length > 5000) SGP4_INTERVAL = 5000;
    if (satEntries.length > 10000) SGP4_INTERVAL = 8000;
    document.getElementById('statusText').textContent = `Система активна | ${satEntries.length} на карте (${totalInDB} в БД)`;
}

// ============================================================
//  FILTERING (cached for performance)
// ============================================================
let _filteredCache = null;
let _filteredSet = null;   // Set for O(1) lookups
let _filterDirty = true;   // flag to rebuild cache

function invalidateFilterCache() { _filterDirty = true; }

function getFilteredSats() {
    if (!_filterDirty && _filteredCache) return _filteredCache;
    let filtered = satEntries;
    if (favoritesOnly) {
        filtered = filtered.filter(s => userFavorites.has(s.norad_id));
    } else if (activeGroupFilters.size < ALL_GROUP_FILTERS.length) {
        filtered = filtered.filter(s => activeGroupFilters.has(s.group));
    }
    if (activeOrbitFilter) {
        filtered = filtered.filter(s => s.orbit_type === activeOrbitFilter);
    }
    if (activeCountryFilter) {
        filtered = filtered.filter(s => s.country === activeCountryFilter);
    }
    if (searchQuery) {
        const q = searchQuery.toLowerCase();
        filtered = filtered.filter(s => s.name.toLowerCase().includes(q) || String(s.norad_id).includes(q));
    }
    // Altitude range filter
    if (altFilterMin !== null || altFilterMax !== null) {
        filtered = filtered.filter(s => {
            const alt = s.alt || 0;
            if (altFilterMin !== null && alt < altFilterMin) return false;
            if (altFilterMax !== null && alt > altFilterMax) return false;
            return true;
        });
    }
    // Starlink shell filter
    if (activeShellFilter) {
        filtered = filtered.filter(s => {
            if (s.group !== 'starlink') return true;
            if (!s.satrec) return false;
            const incDeg = s.satrec.inclo * 180 / Math.PI;
            const alt = s.alt || 0;
            switch (activeShellFilter) {
                case 'shell1': return incDeg > 50 && incDeg < 56 && alt >= 530 && alt <= 570;
                case 'shell2': return incDeg > 40 && incDeg < 46 && alt >= 460 && alt <= 520;
                case 'shell3': return incDeg > 50 && incDeg < 56 && alt >= 460 && alt <= 510;
                case 'shell4': return incDeg > 68 && incDeg < 72 && alt >= 550 && alt <= 610;
                case 'shell5': return incDeg > 96 && incDeg < 99 && alt >= 530 && alt <= 580;
                case 'raising': return alt < 420;
                default: return true;
            }
        });
    }
    // Starlink display limit
    if (starlinkLimit !== Infinity) {
        let slCount = 0;
        filtered = filtered.filter(s => {
            if (s.group !== 'starlink') return true;
            slCount++;
            return slCount <= starlinkLimit;
        });
    }
    _filteredCache = filtered;
    _filteredSet = new Set(filtered);
    _filterDirty = false;
    return filtered;
}

/** O(1) check if satellite passes current filter */
function isFiltered(s) {
    if (_filterDirty) getFilteredSats();
    return _filteredSet.has(s);
}

function getSingleSelectedConstellationGroup() {
    if (favoritesOnly || activeGroupFilters.size !== 1) return null;
    const [group] = Array.from(activeGroupFilters);
    return ['starlink', 'oneweb'].includes(group) ? group : null;
}

function syncGroupChipState() {
    document.querySelectorAll('.fp-chip[data-group]').forEach(chip => {
        const group = chip.dataset.group;
        let active = false;
        if (group === 'favorites') active = favoritesOnly;
        else if (group === 'all') active = !favoritesOnly && activeGroupFilters.size === ALL_GROUP_FILTERS.length;
        else active = !favoritesOnly && activeGroupFilters.has(group);
        chip.classList.toggle('active', active);
    });

    const altSection = document.getElementById('fpAltSection');
    const singleConstellation = getSingleSelectedConstellationGroup();
    if (singleConstellation) {
        altSection.style.display = '';
        const groupSats = satEntries.filter(s => s.group === singleConstellation && s.alt > 0);
        if (groupSats.length > 0) {
            const minA = Math.round(Math.min(...groupSats.map(s => s.alt)) / 10) * 10;
            const maxA = Math.round(Math.max(...groupSats.map(s => s.alt)) / 10) * 10 + 10;
            document.getElementById('fpAltInfo').textContent = `Диапазон группы: ${minA}–${maxA} км`;
        }
    } else {
        altSection.style.display = 'none';
        altFilterMin = null;
        altFilterMax = null;
    }
}

// ============================================================
//  UPDATE SATELLITE POSITIONS
// ============================================================
function updateSatPositions() {
    const simNow = getSimTime();
    for (const s of satEntries) {
        const pos = propagateSat(s.satrec, simNow);
        if (!pos) continue;
        s.lat = pos.lat; s.lon = pos.lon; s.alt = pos.alt; s.vel = pos.vel;
    }
}

// ============================================================
//  RENDER SATELLITES 3D
// ============================================================
async function initSatSprites3D() {
    const CHUNK = 500;
    for (let i = 0; i < satEntries.length; i += CHUNK) {
        const end = Math.min(i + CHUNK, satEntries.length);
        for (let j = i; j < end; j++) {
            const s = satEntries[j];
            const color = GROUP_COLORS[s.group] || '#00bfff';
            const tex = makeSatSprite(color, false, s.group);
            const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map:tex, transparent:true, depthWrite:false }));
            const baseScale = 0.08 * MOBILE_SCALE;
            sprite.scale.set(baseScale, baseScale, 1);
            sprite.userData = s;
            s.sprite3d = sprite;
            s._dotTex = tex;
            s._imgSprite = false;
            scene.add(sprite);
        }
        // Yield to UI thread every chunk
        if (i + CHUNK < satEntries.length) {
            document.getElementById('statusText').textContent = `Создание спрайтов... ${end}/${satEntries.length}`;
            await new Promise(r => setTimeout(r, 0));
        }
    }
    document.getElementById('statusText').textContent = `Спутников: ${satEntries.length}`;
}
// --- 3D Altitude visualization (position in space) ---
let altitudeLines3D = [];
let showAltitudeLines = false;

function toggleAltitudeLines() {
    showAltitudeLines = !showAltitudeLines;
    const btn = document.getElementById('btnAltLines');
    if (btn) btn.classList.toggle('active', showAltitudeLines);
    updateAltitudeLines3D();
}

function updateAltitudeLines3D() {
    // Remove old lines
    for (const obj of altitudeLines3D) {
        scene.remove(obj);
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) obj.material.dispose();
    }
    altitudeLines3D = [];

    if (!showAltitudeLines || currentMode !== '3d') return;

    const filtered = getFilteredSats().filter(s => s.lat !== 0);

    // Prioritize: always show GEO/HEO/MEO (few, but visually important),
    // then fill remaining slots with LEO up to limit
    const nonLeo = filtered.filter(s => s.orbit_type !== 'LEO');
    const leo = filtered.filter(s => s.orbit_type === 'LEO');
    const MAX_LINES = 500; // increased limit, using shared geometry for perf
    const toShow = [...nonLeo, ...leo.slice(0, MAX_LINES - nonLeo.length)];

    // Shared geometries for performance
    const ringGeo = new THREE.RingGeometry(0.008, 0.012, 12);

    for (const s of toShow) {
        const color = new THREE.Color(GROUP_COLORS[s.group] || '#00bfff');
        const surfacePos = latLonToVec3(s.lat, s.lon, 0);
        const satPos = latLonToVec3(s.lat, s.lon, s.alt);

        // Vertical line from surface to satellite
        const geom = new THREE.BufferGeometry().setFromPoints([surfacePos, satPos]);
        // Higher opacity for GEO/HEO to make tall lines visible
        const opacity = (s.orbit_type === 'GEO' || s.orbit_type === 'HEO') ? 0.5 : 0.25;
        const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity });
        const line = new THREE.Line(geom, mat);
        scene.add(line);
        altitudeLines3D.push(line);

        // Small ring on surface to mark ground track
        const ringMat = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: 0.4 });
        const ring = new THREE.Mesh(ringGeo, ringMat);
        ring.position.copy(surfacePos);
        ring.lookAt(surfacePos.clone().multiplyScalar(2));
        scene.add(ring);
        altitudeLines3D.push(ring);
    }
}

function updateSatSprites3D() {
    getFilteredSats(); // ensure cache
    const camDist = camera ? camera.position.length() : 10;

    const baseScale = Math.max(0.035, Math.min(0.16, 0.25 / camDist)) * MOBILE_SCALE;
    const selScale = baseScale * 1.6;

    for (const s of satEntries) {
        if (!s.sprite3d) continue;
        const visible = isFiltered(s);
        s.sprite3d.visible = visible;
        if (!visible) continue;
        if (s.lat !== 0) {
            s.sprite3d.position.copy(latLonToVec3(s.lat, s.lon, s.alt));
        }
        const sc = (selectedSat === s) ? selScale : baseScale;
        s.sprite3d.scale.set(sc, sc, 1);
    }
    // Update altitude lines periodically (every 30 frames)
    if (showAltitudeLines && frameCount % 30 === 0) {
        updateAltitudeLines3D();
    }
}

// ============================================================
//  RENDER SATELLITES 2D
// ============================================================
/** Calculate 2D satellite icon size based on current Leaflet zoom level */
function getSatIconSize2D() {
    if (!leafletMap) return 14 * MOBILE_SCALE;
    const z = leafletMap.getZoom();
    let sz;
    if (z <= 3) sz = 12;
    else if (z <= 5) sz = 16;
    else if (z <= 8) sz = 22;
    else if (z <= 11) sz = 28;
    else sz = 34;
    return Math.round(sz * MOBILE_SCALE);
}

function initSatMarkers2D() {
    if (!leafletMap) return;
    satEntries.forEach(s => {
        if (s.marker2d) return;
        const color = GROUP_COLORS[s.group] || '#00bfff';
        const sz = getSatIconSize2D();
        const iconHtml = makeSatIconHtml(s.group, color, sz);
        const icon = L.divIcon({
            className: '',
            html: iconHtml,
            iconSize: [sz, sz], iconAnchor: [sz/2, sz/2],
        });
        const marker = L.marker([s.lat || 0, s.lon || 0], { icon, interactive: false });
        marker.bindTooltip(s.name, { className:'', direction:'top', offset:[0,-6] });
        s.marker2d = marker;
    });
}
function updateSatMarkers2D() {
    if (!leafletMap) return;
    getFilteredSats(); // ensure cache is up to date
    const bounds = leafletMap.getBounds(); // viewport culling
    for (const s of satEntries) {
        if (!s.marker2d) continue;
        const show = isFiltered(s) && s.lat !== 0;
        if (show) {
            // Only update markers inside viewport (+ small padding)
            const inView = bounds.contains([s.lat, s.lon]);
            if (inView) {
                s.marker2d.setLatLng([s.lat, s.lon]);
                if (!s._on2d) { s.marker2d.addTo(leafletMap); s._on2d = true; }
            } else {
                if (s._on2d) { leafletMap.removeLayer(s.marker2d); s._on2d = false; }
            }
        } else {
            if (s._on2d) { leafletMap.removeLayer(s.marker2d); s._on2d = false; }
        }
    }
}

// ============================================================
//  HEXAGONAL GRID ("СОТЫ СВЯЗИ") + COVERAGE ZONE
// ============================================================

/** Make 2D hex polygon points (flat-top, no distortion, perfect tiling) */
function makeHex2DPts(lat, lon, R) {
    const pts = [];
    for (let k = 0; k < 6; k++) {
        const a = k * 60 * DEG2RAD;
        pts.push([lat + R * Math.sin(a), lon + R * Math.cos(a)]);
    }
    pts.push(pts[0]); // close
    return pts;
}

/** Build hex grid covering entire Earth — flat-top hex tiling in lat/lon space.
 *  No Mercator correction → perfect tessellation on 2D map,
 *  natural spherical compression near poles on 3D globe.
 *  Flat-top hex math (circumradius R):
 *    Row spacing = R * 1.5
 *    Col spacing = R * sqrt(3)
 *    Odd rows offset by R * sqrt(3) / 2
 */
function buildHexGrid() {
    if (hexGridBuilt) return;
    hexGridBuilt = true;

    const R = HEX_GRID_STEP;               // circumradius in degrees
    const rowH = R * 1.5;                   // row-to-row vertical distance
    const colW = R * Math.sqrt(3);          // col-to-col horizontal distance
    const halfCol = colW / 2;

    // Cover full latitude range including poles
    for (let lat = -90 + R; lat <= 90 - R; lat += rowH) {
        const rowIdx = Math.round((lat + 90) / rowH);
        const offset = (rowIdx % 2 === 0) ? 0 : halfCol;

        for (let lon = -180 + offset; lon < 180; lon += colW) {
            hexCellData.push({
                lat, lon,
                mesh3d: null, _border3d: null,
                highlighted: false,
                _hexR: R,
            });
        }
    }

    buildHexCells3D();
}

/** Create flat hexagonal meshes on the 3D globe (fill + wireframe border) */
function buildHexCells3D() {
    // hexR in world units = circumradius converted from degrees to globe surface
    const hexRadius = HEX_GRID_STEP * DEG2RAD * EARTH_RADIUS;
    const hexGeo = new THREE.CircleGeometry(hexRadius, 6);
    const edgeGeo = new THREE.EdgesGeometry(hexGeo);

    for (const cell of hexCellData) {
        const pos = latLonToVec3(cell.lat, cell.lon, 0);
        const grp = new THREE.Group();
        grp.position.copy(pos);
        grp.lookAt(pos.clone().multiplyScalar(2));
        grp.renderOrder = 1;

        // Fill mesh (transparent by default)
        const fillMat = new THREE.MeshBasicMaterial({
            color: 0x00ffff, transparent: true, opacity: 0.0,
            side: THREE.DoubleSide, depthWrite: false,
        });
        const fill = new THREE.Mesh(hexGeo, fillMat);
        grp.add(fill);

        // Border wireframe (also hidden by default)
        const borderMat = new THREE.LineBasicMaterial({
            color: 0x00ffff, transparent: true, opacity: 0.0,
        });
        const border = new THREE.LineSegments(edgeGeo, borderMat);
        grp.add(border);

        scene.add(grp);
        cell.mesh3d = fill;
        cell._border3d = border;
        hexCells3D.push(grp);
    }
}

/** Calculate coverage radius in km based on satellite altitude */
function calcCoverageRadiusKm(altKm, minElevDeg = 5) {
    const Re = 6371;
    const elevRad = minElevDeg * DEG2RAD;
    // Central angle from sub-satellite point to edge of visibility
    const centralAngle = Math.acos(Re * Math.cos(elevRad) / (Re + altKm)) - elevRad;
    return centralAngle * Re; // arc distance in km
}

/** Great-circle distance between two lat/lon points in km */
function haversineKm(lat1, lon1, lat2, lon2) {
    const dLat = (lat2 - lat1) * DEG2RAD;
    const dLon = (lon2 - lon1) * DEG2RAD;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * DEG2RAD) * Math.cos(lat2 * DEG2RAD) * Math.sin(dLon / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Show coverage zone for the selected satellite: footprint circle + highlight hex cells */
function showCoverageZone(s) {
    clearCoverageZone();
    if (!hasSatPosition(s)) return;

    const altKm = s.alt || 400;
    const radiusKm = calcCoverageRadiusKm(altKm);
    const color = new THREE.Color(GROUP_COLORS[s.group] || '#00bfff');

    // --- 3D: draw footprint circle on globe ---
    const segments = 64;
    const centralAngleRad = radiusKm / 6371; // radians on unit sphere
    const circlePoints = [];
    const centerVec = latLonToVec3(s.lat, s.lon, 0).normalize();

    // Build orthonormal basis at center point
    const up = new THREE.Vector3(0, 1, 0);
    let tangent = new THREE.Vector3().crossVectors(up, centerVec).normalize();
    if (tangent.length() < 0.01) tangent = new THREE.Vector3(1, 0, 0);
    const bitangent = new THREE.Vector3().crossVectors(centerVec, tangent).normalize();

    for (let i = 0; i <= segments; i++) {
        const angle = (i / segments) * 2 * PI;
        // Rotate centerVec by centralAngleRad in the tangent/bitangent plane
        const dir = new THREE.Vector3()
            .addScaledVector(tangent, Math.cos(angle))
            .addScaledVector(bitangent, Math.sin(angle));
        const point = new THREE.Vector3()
            .addScaledVector(centerVec, Math.cos(centralAngleRad))
            .addScaledVector(dir, Math.sin(centralAngleRad))
            .normalize()
            .multiplyScalar(EARTH_RADIUS * 1.002); // slightly above surface
        circlePoints.push(point);
    }

    const circGeo = new THREE.BufferGeometry().setFromPoints(circlePoints);
    coverageCircle3D = new THREE.Line(circGeo, new THREE.LineBasicMaterial({
        color, transparent: true, opacity: 0.7, linewidth: 1,
    }));
    scene.add(coverageCircle3D);

    // --- 3D: translucent cone from satellite to footprint ---
    const satPos3D = latLonToVec3(s.lat, s.lon, s.alt);
    const coneVerts = [satPos3D];
    for (let i = 0; i < segments; i++) {
        coneVerts.push(circlePoints[i]);
    }
    // Build triangle fan: sat → edge[i] → edge[i+1]
    const conePositions = [];
    for (let i = 0; i < segments; i++) {
        const a = satPos3D, b = circlePoints[i], c = circlePoints[(i + 1) % segments];
        conePositions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    }
    const coneGeo = new THREE.BufferGeometry();
    coneGeo.setAttribute('position', new THREE.Float32BufferAttribute(conePositions, 3));
    coneGeo.computeVertexNormals();
    coverageCone3D = new THREE.Mesh(coneGeo, new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.08, side: THREE.DoubleSide, depthWrite: false,
    }));
    scene.add(coverageCone3D);

    // --- 2D: Leaflet circle + hex cells ---
    if (leafletMap) {
        const hexColor = GROUP_COLORS[s.group] || '#00bfff';
        coverageCircle2D = L.circle([s.lat, s.lon], {
            radius: radiusKm * 1000,
            color: hexColor, fillColor: hexColor, fillOpacity: 0.06,
            weight: 1.5, opacity: 0.6, dashArray: '6 4', interactive: false,
        });
        coverageCircle2D.addTo(leafletMap);

        // Draw 2D hex cells — flat-top, no Mercator distortion, perfect tiling
        const hexLayers = [];
        const R = HEX_GRID_STEP;
        for (const cell of hexCellData) {
            const dist = haversineKm(s.lat, s.lon, cell.lat, cell.lon);
            const inCoverage = dist <= radiusKm;
            const nearCoverage = dist <= radiusKm * 2;
            if (!inCoverage && !nearCoverage) continue;
            const hexPts = makeHex2DPts(cell.lat, cell.lon, R);
            const style = inCoverage
                ? { color: hexColor, fillColor: hexColor, fillOpacity: 0.15, weight: 1, opacity: 0.5, interactive: false }
                : { color: '#888', fillColor: 'transparent', fillOpacity: 0, weight: 0.5, opacity: 0.15, interactive: false };
            hexLayers.push(L.polygon(hexPts, style));
        }
        hexLayer2D = L.layerGroup(hexLayers);
        hexLayer2D.addTo(leafletMap);
    }

    // --- Highlight hex cells: faint grid visible, covered cells bright ---
    if (!hexGridBuilt) buildHexGrid();
    const highlightColor = color.clone();
    for (const cell of hexCellData) {
        if (!cell.mesh3d) continue;
        const dist = haversineKm(s.lat, s.lon, cell.lat, cell.lon);
        if (dist <= radiusKm) {
            // Inside coverage — bright fill + visible border
            cell.highlighted = true;
            cell.mesh3d.material.opacity = 0.2;
            cell.mesh3d.material.color.copy(highlightColor);
            if (cell._border3d) {
                cell._border3d.material.opacity = 0.5;
                cell._border3d.material.color.copy(highlightColor);
                cell._border3d.material.needsUpdate = true;
            }
        } else if (dist <= radiusKm * 2) {
            // Near coverage — faint border only for context
            cell.highlighted = false;
            cell.mesh3d.material.opacity = 0.0;
            if (cell._border3d) {
                cell._border3d.material.opacity = 0.12;
                cell._border3d.material.color.set(0x888888);
                cell._border3d.material.needsUpdate = true;
            }
        }
        cell.mesh3d.material.needsUpdate = true;
    }
}

/** Update coverage zone position (called when satellite moves) */
function updateCoverageZone() {
    if (!showCoverage) return;
    if (hasSatPosition(selectedSat)) {
        showCoverageZone(selectedSat);
    }
}

/** Toggle coverage visualization on/off */
function toggleCoverage() {
    showCoverage = !showCoverage;
    const btn = document.getElementById('btnCoverage');
    if (btn) btn.classList.toggle('active', showCoverage);
    if (showCoverage) {
        if (selectedSat) {
            showCoverageZone(selectedSat);
        } else {
            clearCoverageZone();
        }
    } else {
        clearCoverageZone();
    }
}

// ---- Heatmap color scale: count → THREE.Color ----
const HEATMAP_COLORS = [
    new THREE.Color(0x0d47a1), // 1 sat — deep blue
    new THREE.Color(0x1565c0), // 2
    new THREE.Color(0x00897b), // 3 — teal
    new THREE.Color(0x2e7d32), // 4 — green
    new THREE.Color(0x558b2f), // 5
    new THREE.Color(0x9e9d24), // 6 — lime
    new THREE.Color(0xf9a825), // 7 — amber
    new THREE.Color(0xef6c00), // 8 — orange
    new THREE.Color(0xd84315), // 9 — deep orange
    new THREE.Color(0xb71c1c), // 10+ — red
];
function heatmapColor(count) {
    if (count <= 0) return null;
    return HEATMAP_COLORS[Math.min(count - 1, HEATMAP_COLORS.length - 1)];
}

/** Show group constellation coverage heatmap */
function showGroupHeatmap() {
    clearCoverageZone();
    if (!hexGridBuilt) buildHexGrid();

    // Get filtered satellites (respects active group/orbit/country filters)
    const sats = getFilteredSats().filter(s => s.lat !== 0 && s.alt > 0);
    if (sats.length === 0) return;

    // Pre-calculate coverage radius for each satellite
    const satCoverage = sats.map(s => ({
        lat: s.lat, lon: s.lon,
        radiusKm: calcCoverageRadiusKm(s.alt || 400),
        group: s.group,
    }));

    // Count coverage per hex cell
    let maxCount = 0;
    const cellCounts = new Map();
    for (const cell of hexCellData) {
        let count = 0;
        for (const sc of satCoverage) {
            const dist = haversineKm(sc.lat, sc.lon, cell.lat, cell.lon);
            if (dist <= sc.radiusKm) count++;
        }
        cellCounts.set(cell, count);
        if (count > maxCount) maxCount = count;
    }

    // Apply heatmap colors to 3D hex cells
    for (const cell of hexCellData) {
        if (!cell.mesh3d) continue;
        const count = cellCounts.get(cell) || 0;
        if (count > 0) {
            const color = heatmapColor(count);
            cell.highlighted = true;
            cell.mesh3d.material.color.copy(color);
            cell.mesh3d.material.opacity = 0.15 + Math.min(count / 8, 0.45);
            cell.mesh3d.material.needsUpdate = true;
            if (cell._border3d) {
                cell._border3d.material.color.copy(color);
                cell._border3d.material.opacity = 0.4;
                cell._border3d.material.needsUpdate = true;
            }
        } else {
            // Faint grid visible for context
            cell.mesh3d.material.opacity = 0.02;
            cell.mesh3d.material.color.set(0x444444);
            cell.mesh3d.material.needsUpdate = true;
            if (cell._border3d) {
                cell._border3d.material.opacity = 0.06;
                cell._border3d.material.color.set(0x444444);
                cell._border3d.material.needsUpdate = true;
            }
        }
    }

    // 2D heatmap on Leaflet
    if (leafletMap) {
        const hexLayers = [];
        const R = HEX_GRID_STEP;
        for (const cell of hexCellData) {
            const count = cellCounts.get(cell) || 0;
            if (count === 0) continue;
            const hexPts = makeHex2DPts(cell.lat, cell.lon, R);
            const c = heatmapColor(count);
            const hexColorStr = '#' + c.getHexString();
            const fillOp = 0.15 + Math.min(count / 8, 0.45);
            hexLayers.push(L.polygon(hexPts, {
                color: hexColorStr, fillColor: hexColorStr,
                fillOpacity: fillOp, weight: 0.8, opacity: 0.5, interactive: false,
            }));
        }
        hexLayer2D = L.layerGroup(hexLayers);
        hexLayer2D.addTo(leafletMap);
    }

    // Show legend overlay
    showHeatmapLegend(sats.length, maxCount);
}

/** Show/hide heatmap legend */
function showHeatmapLegend(satCount, maxCount) {
    let legend = document.getElementById('heatmapLegend');
    if (!legend) {
        legend = document.createElement('div');
        legend.id = 'heatmapLegend';
        legend.style.cssText = 'position:fixed;bottom:82px;left:16px;z-index:950;background:rgba(10,15,30,0.9);border:1px solid rgba(0,191,255,0.2);border-radius:8px;padding:10px 14px;font-size:11px;color:#ccc;pointer-events:none;';
        document.body.appendChild(legend);
    }
    const filterLabel = favoritesOnly
        ? 'Избранное'
        : activeGroupFilters.size === ALL_GROUP_FILTERS.length
            ? 'Все группы'
            : Array.from(activeGroupFilters).map(g => GROUP_NAMES[g] || g).join(', ');
    const colors = HEATMAP_COLORS.slice(0, Math.min(maxCount, 10));
    const colorBar = colors.map((c, i) =>
        `<span style="display:inline-block;width:16px;height:12px;background:#${c.getHexString()};border-radius:2px;margin-right:1px;" title="${i+1}"></span>`
    ).join('');
    legend.innerHTML = `
        <div style="font-size:12px;font-weight:600;margin-bottom:4px;">Покрытие: ${filterLabel}</div>
        <div style="margin-bottom:4px;">${satCount} спутников | макс. ${maxCount} на ячейку</div>
        <div style="display:flex;align-items:center;gap:4px;">
            <span style="font-size:10px;">1</span>${colorBar}<span style="font-size:10px;">${Math.min(maxCount, 10)}+</span>
        </div>
    `;
    legend.style.display = '';
}

function hideHeatmapLegend() {
    const legend = document.getElementById('heatmapLegend');
    if (legend) legend.style.display = 'none';
}

/** Remove all coverage visuals */
function clearCoverageZone() {
    if (coverageCircle3D) {
        scene.remove(coverageCircle3D);
        coverageCircle3D.geometry.dispose();
        coverageCircle3D = null;
    }
    if (coverageCone3D) {
        scene.remove(coverageCone3D);
        coverageCone3D.geometry.dispose();
        coverageCone3D = null;
    }
    if (coverageCircle2D && leafletMap) {
        leafletMap.removeLayer(coverageCircle2D);
        coverageCircle2D = null;
    }
    if (hexLayer2D && leafletMap) {
        leafletMap.removeLayer(hexLayer2D);
        hexLayer2D = null;
    }
    // Reset ALL hex cells to invisible (both highlighted and faint context cells)
    for (const cell of hexCellData) {
        if (cell.mesh3d && cell.mesh3d.material.opacity > 0) {
            cell.mesh3d.material.opacity = 0.0;
            cell.mesh3d.material.needsUpdate = true;
        }
        if (cell._border3d && cell._border3d.material.opacity > 0) {
            cell._border3d.material.opacity = 0.0;
            cell._border3d.material.needsUpdate = true;
        }
        cell.highlighted = false;
    }
    hideHeatmapLegend();
}

// ============================================================
//  SELECT SATELLITE
// ============================================================
function vectorToLatLon(vec) {
    const v = vec.clone().normalize();
    return {
        lat: Math.asin(v.y) * RAD2DEG,
        lon: Math.atan2(v.z, v.x) * RAD2DEG,
    };
}

function normalizeLon(lon) {
    let result = lon;
    while (result <= -180) result += 360;
    while (result > 180) result -= 360;
    return result;
}

function unwrapPolygonLatLon(points, refLon) {
    return points.map(({ lat, lon }) => {
        let adjLon = lon;
        while (adjLon - refLon > 180) adjLon -= 360;
        while (adjLon - refLon < -180) adjLon += 360;
        return [lat, adjLon];
    });
}

function averageVectors(vectors) {
    const avg = new THREE.Vector3();
    for (const vec of vectors) avg.add(vec);
    return avg.normalize();
}

function quantizeVecKey(vec) {
    return `${vec.x.toFixed(6)}|${vec.y.toFixed(6)}|${vec.z.toFixed(6)}`;
}

function getIcosahedronBase() {
    const t = (1 + Math.sqrt(5)) / 2;
    const vertices = [
        new THREE.Vector3(-1,  t,  0), new THREE.Vector3( 1,  t,  0),
        new THREE.Vector3(-1, -t,  0), new THREE.Vector3( 1, -t,  0),
        new THREE.Vector3( 0, -1,  t), new THREE.Vector3( 0,  1,  t),
        new THREE.Vector3( 0, -1, -t), new THREE.Vector3( 0,  1, -t),
        new THREE.Vector3( t,  0, -1), new THREE.Vector3( t,  0,  1),
        new THREE.Vector3(-t,  0, -1), new THREE.Vector3(-t,  0,  1),
    ].map(v => v.normalize());
    const faces = [
        [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
        [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
        [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
        [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
    ];
    return { vertices, faces };
}

function buildPolygonGeometry(centerVec, boundaryVecs, radius) {
    const positions = [];
    const center = centerVec.clone().multiplyScalar(radius);
    for (let i = 0; i < boundaryVecs.length; i++) {
        const a = boundaryVecs[i].clone().multiplyScalar(radius);
        const b = boundaryVecs[(i + 1) % boundaryVecs.length].clone().multiplyScalar(radius);
        positions.push(
            center.x, center.y, center.z,
            a.x, a.y, a.z,
            b.x, b.y, b.z,
        );
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.computeVertexNormals();
    return geo;
}

buildHexGrid = function buildHexGrid() {
    if (hexGridBuilt) return;
    hexGridBuilt = true;
    hexCellData.length = 0;

    const { vertices: baseVertices, faces } = getIcosahedronBase();
    const freq = COVERAGE_GRID_FREQUENCY;
    const vertexLookup = new Map();
    const vertices = [];
    const triangles = [];

    function addVertex(vec) {
        const n = vec.clone().normalize();
        const key = quantizeVecKey(n);
        if (vertexLookup.has(key)) return vertexLookup.get(key);
        const idx = vertices.length;
        vertices.push(n);
        vertexLookup.set(key, idx);
        return idx;
    }

    for (const [ia, ib, ic] of faces) {
        const a = baseVertices[ia];
        const b = baseVertices[ib];
        const c = baseVertices[ic];
        const local = [];

        for (let i = 0; i <= freq; i++) {
            local[i] = [];
            for (let j = 0; j <= freq - i; j++) {
                const wa = (freq - i - j) / freq;
                const wb = i / freq;
                const wc = j / freq;
                const point = new THREE.Vector3()
                    .addScaledVector(a, wa)
                    .addScaledVector(b, wb)
                    .addScaledVector(c, wc);
                local[i][j] = addVertex(point);
            }
        }

        for (let i = 0; i < freq; i++) {
            for (let j = 0; j < freq - i; j++) {
                const v0 = local[i][j];
                const v1 = local[i + 1][j];
                const v2 = local[i][j + 1];
                triangles.push([v0, v1, v2]);
                if (j < freq - i - 1) {
                    const v3 = local[i + 1][j + 1];
                    triangles.push([v1, v3, v2]);
                }
            }
        }
    }

    const triangleCenters = triangles.map(([a, b, c]) =>
        averageVectors([vertices[a], vertices[b], vertices[c]])
    );
    const aroundVertex = Array.from({ length: vertices.length }, () => []);
    triangles.forEach((tri, triIdx) => {
        for (const vi of tri) aroundVertex[vi].push(triIdx);
    });

    for (let vi = 0; vi < vertices.length; vi++) {
        const centerVec = vertices[vi].clone().normalize();
        const centerLatLon = vectorToLatLon(centerVec);
        const tangentSeed = Math.abs(centerVec.y) > 0.9
            ? new THREE.Vector3(1, 0, 0)
            : new THREE.Vector3(0, 1, 0);
        const tangent = new THREE.Vector3().crossVectors(tangentSeed, centerVec).normalize();
        const bitangent = new THREE.Vector3().crossVectors(centerVec, tangent).normalize();

        const boundaryVecs = aroundVertex[vi]
            .map(idx => triangleCenters[idx].clone().normalize())
            .sort((p1, p2) => {
                const q1 = p1.clone().sub(centerVec.clone().multiplyScalar(centerVec.dot(p1))).normalize();
                const q2 = p2.clone().sub(centerVec.clone().multiplyScalar(centerVec.dot(p2))).normalize();
                return Math.atan2(q1.dot(bitangent), q1.dot(tangent)) -
                    Math.atan2(q2.dot(bitangent), q2.dot(tangent));
            });

        hexCellData.push({
            lat: centerLatLon.lat,
            lon: centerLatLon.lon,
            centerVec,
            boundaryVecs,
            boundaryLatLon: unwrapPolygonLatLon(
                boundaryVecs.map(vectorToLatLon),
                centerLatLon.lon,
            ),
            mesh3d: null,
            _border3d: null,
            highlighted: false,
        });
    }

    buildHexCells3D();
};

buildHexCells3D = function buildHexCells3D() {
    for (const cell of hexCellData) {
        const fill = new THREE.Mesh(
            buildPolygonGeometry(cell.centerVec, cell.boundaryVecs, EARTH_RADIUS * 1.0025),
            new THREE.MeshBasicMaterial({
                color: 0x00ffff,
                transparent: true,
                opacity: 0.0,
                side: THREE.DoubleSide,
                depthWrite: false,
            })
        );
        fill.renderOrder = 2;

        const borderPoints = cell.boundaryVecs
            .map(v => v.clone().multiplyScalar(EARTH_RADIUS * 1.0035));
        borderPoints.push(borderPoints[0].clone());
        const border = new THREE.Line(
            new THREE.BufferGeometry().setFromPoints(borderPoints),
            new THREE.LineBasicMaterial({
                color: 0x00ffff,
                transparent: true,
                opacity: 0.0,
                depthWrite: false,
            })
        );
        border.renderOrder = 3;

        scene.add(fill);
        scene.add(border);
        cell.mesh3d = fill;
        cell._border3d = border;
        hexCells3D.push(fill, border);
    }
};

calcCoverageRadiusKm = function calcCoverageRadiusKm(altKm, minElevDeg = 5) {
    const re = 6371;
    const elevRad = minElevDeg * DEG2RAD;
    const centralAngle = Math.acos((re / (re + altKm)) * Math.cos(elevRad)) - elevRad;
    return centralAngle * re;
};

// haversineKm defined at line ~2439

function createFootprintBoundary(lat, lon, radiusKm, segments = 96) {
    const angularDistance = radiusKm / 6371;
    const latRad = lat * DEG2RAD;
    const lonRad = lon * DEG2RAD;
    const pts = [];

    for (let i = 0; i <= segments; i++) {
        const bearing = (i / segments) * 2 * PI;
        const sinLat = Math.sin(latRad);
        const cosLat = Math.cos(latRad);
        const sinAng = Math.sin(angularDistance);
        const cosAng = Math.cos(angularDistance);
        const lat2 = Math.asin(sinLat * cosAng + cosLat * sinAng * Math.cos(bearing));
        const lon2 = lonRad + Math.atan2(
            Math.sin(bearing) * sinAng * cosLat,
            cosAng - sinLat * Math.sin(lat2),
        );
        pts.push({
            lat: lat2 * RAD2DEG,
            lon: normalizeLon(lon2 * RAD2DEG),
        });
    }
    return pts;
}

showCoverageZone = function showCoverageZone(s) {
    clearCoverageZone();
    if (!hasSatPosition(s)) return;
    if (!hexGridBuilt) buildHexGrid();

    const alt = s.alt || 400;
    const workRadiusKm = calcCoverageRadiusKm(alt, COVERAGE_WORK_ELEV);  // Inner: work zone (15°)
    const geoRadiusKm = calcCoverageRadiusKm(alt, COVERAGE_GEO_ELEV);    // Outer: geometric visibility (0°)
    const color = new THREE.Color(GROUP_COLORS[s.group] || '#00bfff');
    const outerColor = new THREE.Color(GROUP_COLORS[s.group] || '#00bfff').lerp(new THREE.Color(0xffffff), 0.3);
    const centerVec = latLonToVec3(s.lat, s.lon, 0).normalize();

    // ── OUTER ring: geometric visibility (0°) ──
    const outerFootprint = createFootprintBoundary(s.lat, s.lon, geoRadiusKm);
    const outerVecs = outerFootprint.map(p => latLonToVec3(p.lat, p.lon, 0).normalize());
    const outerLinePoints = outerVecs.map(v => v.clone().multiplyScalar(EARTH_RADIUS * 1.003));

    coverageOuterCircle3D = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(outerLinePoints),
        new THREE.LineDashedMaterial({ color: outerColor, transparent: true, opacity: 0.4, dashSize: 0.03, gapSize: 0.02 })
    );
    coverageOuterCircle3D.computeLineDistances();
    coverageOuterCircle3D.renderOrder = 3;
    scene.add(coverageOuterCircle3D);

    coverageOuterFill3D = new THREE.Mesh(
        buildPolygonGeometry(centerVec, outerVecs, EARTH_RADIUS * 1.001),
        new THREE.MeshBasicMaterial({ color: outerColor, transparent: true, opacity: 0.04, side: THREE.DoubleSide, depthWrite: false })
    );
    coverageOuterFill3D.renderOrder = 0;
    scene.add(coverageOuterFill3D);

    // ── INNER ring: work zone (15°) ──
    const footprint = createFootprintBoundary(s.lat, s.lon, workRadiusKm);
    const footprintVecs = footprint.map(p => latLonToVec3(p.lat, p.lon, 0).normalize());
    const linePoints = footprintVecs.map(v => v.clone().multiplyScalar(EARTH_RADIUS * 1.004));

    coverageCircle3D = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(linePoints),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.78 })
    );
    coverageCircle3D.renderOrder = 4;
    scene.add(coverageCircle3D);

    coverageFill3D = new THREE.Mesh(
        buildPolygonGeometry(centerVec, footprintVecs, EARTH_RADIUS * 1.0015),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.1, side: THREE.DoubleSide, depthWrite: false })
    );
    coverageFill3D.renderOrder = 1;
    scene.add(coverageFill3D);

    // ── Cone from satellite to work zone footprint ──
    const satPos3D = latLonToVec3(s.lat, s.lon, s.alt);
    const conePositions = [];
    for (let i = 0; i < footprintVecs.length - 1; i++) {
        const a = footprintVecs[i].clone().multiplyScalar(EARTH_RADIUS * 1.0015);
        const b = footprintVecs[i + 1].clone().multiplyScalar(EARTH_RADIUS * 1.0015);
        conePositions.push(satPos3D.x, satPos3D.y, satPos3D.z, a.x, a.y, a.z, b.x, b.y, b.z);
    }
    const coneGeo = new THREE.BufferGeometry();
    coneGeo.setAttribute('position', new THREE.Float32BufferAttribute(conePositions, 3));
    coneGeo.computeVertexNormals();
    coverageCone3D = new THREE.Mesh(coneGeo, new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.08, side: THREE.DoubleSide, depthWrite: false,
    }));
    coverageCone3D.renderOrder = 1;
    scene.add(coverageCone3D);

    // ── Hex cells: highlight cells in work zone ──
    const coveredCells = [];
    for (const cell of hexCellData) {
        const dist = haversineKm(s.lat, s.lon, cell.lat, cell.lon);
        const inWork = dist <= workRadiusKm;
        const inGeo = dist <= geoRadiusKm;
        cell.highlighted = inWork;
        if (cell.mesh3d) {
            cell.mesh3d.material.opacity = inWork ? 0.2 : (inGeo ? 0.06 : 0.0);
            cell.mesh3d.material.color.copy(inWork ? color : outerColor);
            cell.mesh3d.material.needsUpdate = true;
        }
        if (cell._border3d) {
            cell._border3d.material.opacity = inWork ? 0.5 : (inGeo ? 0.15 : 0.0);
            cell._border3d.material.color.copy(inWork ? color : outerColor);
            cell._border3d.material.needsUpdate = true;
        }
        if (inWork) coveredCells.push({ cell, zone: 'work' });
        else if (inGeo) coveredCells.push({ cell, zone: 'geo' });
    }

    // ── 2D Leaflet ──
    if (leafletMap) {
        const hexColor = '#' + color.getHexString();
        const outerHexColor = '#' + outerColor.getHexString();

        // Outer circle (dashed on 2D)
        coverageOuterCircle2D = L.polygon(unwrapPolygonLatLon(outerFootprint, s.lon), {
            color: outerHexColor, fillColor: outerHexColor,
            fillOpacity: 0.04, weight: 1, opacity: 0.4,
            dashArray: '6, 4', interactive: false,
        });
        coverageOuterCircle2D.addTo(leafletMap);

        // Inner circle (solid)
        coverageCircle2D = L.polygon(unwrapPolygonLatLon(footprint, s.lon), {
            color: hexColor, fillColor: hexColor,
            fillOpacity: 0.1, weight: 1.5, opacity: 0.75, interactive: false,
        });
        coverageCircle2D.addTo(leafletMap);

        // Hex cells
        hexLayer2D = L.layerGroup(
            coveredCells.map(({ cell, zone }) => L.polygon(cell.boundaryLatLon, {
                color: zone === 'work' ? hexColor : outerHexColor,
                fillColor: zone === 'work' ? hexColor : outerHexColor,
                fillOpacity: zone === 'work' ? 0.16 : 0.06,
                weight: 1, opacity: zone === 'work' ? 0.55 : 0.2,
                interactive: false,
            }))
        );
        hexLayer2D.addTo(leafletMap);
    }
};

updateCoverageZone = function updateCoverageZone() {
    if (!showCoverage) return;
    if (hasSatPosition(selectedSat)) showCoverageZone(selectedSat);
};

toggleCoverage = function toggleCoverage() {
    showCoverage = !showCoverage;
    const btn = document.getElementById('btnCoverage');
    if (btn) btn.classList.toggle('active', showCoverage);
    if (showCoverage && selectedSat) showCoverageZone(selectedSat);
    else clearCoverageZone();
};

showGroupHeatmap = function showGroupHeatmap() {
    clearCoverageZone();
};

hideHeatmapLegend = function hideHeatmapLegend() {};

clearCoverageZone = function clearCoverageZone() {
    if (coverageCircle3D) { scene.remove(coverageCircle3D); coverageCircle3D.geometry.dispose(); coverageCircle3D = null; }
    if (coverageFill3D) { scene.remove(coverageFill3D); coverageFill3D.geometry.dispose(); coverageFill3D = null; }
    if (coverageCone3D) { scene.remove(coverageCone3D); coverageCone3D.geometry.dispose(); coverageCone3D = null; }
    if (coverageOuterCircle3D) { scene.remove(coverageOuterCircle3D); coverageOuterCircle3D.geometry.dispose(); coverageOuterCircle3D = null; }
    if (coverageOuterFill3D) { scene.remove(coverageOuterFill3D); coverageOuterFill3D.geometry.dispose(); coverageOuterFill3D = null; }
    if (coverageCircle2D && leafletMap) { leafletMap.removeLayer(coverageCircle2D); coverageCircle2D = null; }
    if (coverageOuterCircle2D && leafletMap) { leafletMap.removeLayer(coverageOuterCircle2D); coverageOuterCircle2D = null; }
    if (hexLayer2D && leafletMap) {
        leafletMap.removeLayer(hexLayer2D);
        hexLayer2D = null;
    }
    for (const cell of hexCellData) {
        cell.highlighted = false;
        if (cell.mesh3d) {
            cell.mesh3d.material.opacity = 0.0;
            cell.mesh3d.material.needsUpdate = true;
        }
        if (cell._border3d) {
            cell._border3d.material.opacity = 0.0;
            cell._border3d.material.needsUpdate = true;
        }
    }
};
function selectSatellite(s) {
    if (selectedSat && selectedSat.sprite3d) {
        const c = GROUP_COLORS[selectedSat.group] || '#00bfff';
        selectedSat.sprite3d.material.map = makeSatSprite(c, false, selectedSat.group);
        const bs = 0.08 * MOBILE_SCALE;
        selectedSat.sprite3d.scale.set(bs, bs, 1);
        selectedSat._imgSprite = false;
    }
    clearTrack();
    selectedSat = s;

    if (s.sprite3d) {
        const c = GROUP_COLORS[s.group] || '#00bfff';
        s.sprite3d.material.map = makeSatSprite(c, true, s.group);
        const ss = 0.14 * MOBILE_SCALE;
        s.sprite3d.scale.set(ss, ss, 1);
    }

    drawTrack(s);
    if (showCoverage) showCoverageZone(s);
    lastTrackUpdate = performance.now();

    // Fly camera to selected satellite, enable follow
    if (hasSatPosition(s)) {
        if (currentMode === '3d') {
            _camFollowSat = true;
            const { satPos, cameraPos } = getSatelliteCameraPose(s);
            animateCameraTo(cameraPos, 1800, satPos);
        } else if (leafletMap) {
            leafletMap.flyTo([s.lat, s.lon], Math.max(leafletMap.getZoom(), 5), { duration: 1.5 });
        }
    }

    const orbitType = s.orbit_type || 'N/A';
    document.getElementById('detailName').textContent = s.name;
    document.getElementById('detailSub').textContent = `NORAD ${s.norad_id} | ${GROUP_NAMES[s.group] || s.group}`;
    document.getElementById('dOrbitType').innerHTML = `<span class="orbit-badge orbit-${orbitType}">${orbitType}</span>`;
    document.getElementById('dAlt').textContent = s.alt ? s.alt.toFixed(1) + ' km' : '\u2014';
    document.getElementById('dPeriod').textContent = s.satrec ? (2 * PI / s.satrec.no).toFixed(1) + ' мин' : '\u2014';
    document.getElementById('dIncl').textContent = s.satrec ? (s.satrec.inclo * RAD2DEG).toFixed(2) + '\u00B0' : '\u2014';
    document.getElementById('dLat').textContent = s.lat ? s.lat.toFixed(4) + '\u00B0' : '\u2014';
    document.getElementById('dLon').textContent = s.lon ? s.lon.toFixed(4) + '\u00B0' : '\u2014';
    document.getElementById('dVel').textContent = s.vel ? s.vel.toFixed(2) + ' km/s' : '\u2014';
    document.getElementById('dEcc').textContent = s.satrec ? s.satrec.ecco.toFixed(6) : '\u2014';
    document.getElementById('dNorad').textContent = s.norad_id;
    document.getElementById('dGroup').textContent = GROUP_NAMES[s.group] || s.group;
    document.getElementById('dCountry').textContent = (s.country || '') + (s.operator ? ` (${s.operator})` : '') || '\u2014';
    document.getElementById('dIntlDes').textContent = s.intlDes || '\u2014';
    if (s.alt) {
        const geoR = calcCoverageRadiusKm(s.alt, COVERAGE_GEO_ELEV);
        const workR = calcCoverageRadiusKm(s.alt, COVERAGE_WORK_ELEV);
        document.getElementById('dCoverage').innerHTML =
            `<span style="color:var(--text-dim);font-size:9px;">Видимость (0°):</span> ${Math.round(geoR)} km<br>` +
            `<span style="color:var(--text-dim);font-size:9px;">Рабочая (${COVERAGE_WORK_ELEV}°):</span> <span style="color:var(--accent)">${Math.round(workR)} km</span>`;
    } else {
        document.getElementById('dCoverage').innerHTML = '\u2014';
    }

    updateFavButton();
    const detailEl = document.getElementById('satDetail');
    detailEl.classList.remove('collapsed', 'expanded'); // Reset mobile state
    detailEl.classList.add('visible');

    // Restore reminder region for this satellite if saved
    const savedRegion = satReminders[s.norad_id]?.region || '';
    const regionSelect = document.getElementById('detailPassRegion');
    regionSelect.value = savedRegion;
    updateDetailPassForRegion(s, savedRegion);
    updateReminderUI(s);
}

// ============================================================
//  SATELLITE PASS OVER REGION (detail card)
// ============================================================
/** Calculate next pass of a satellite over a region, show in detail card */
function updateDetailPassForRegion(sat, regionCode) {
    const container = document.getElementById('detailPassResult');
    if (!regionCode || !sat || !sat.satrec) {
        container.innerHTML = '<div style="font-size:11px;color:var(--text-dim);">Выберите регион для расчёта</div>';
        return;
    }

    // Get region features
    let features = [];
    const gj = countryGeoData[regionCode];
    if (gj && gj.features) features.push(...gj.features);
    if (regionCode === 'EU') {
        for (const euCode of EU_COUNTRY_CODES) {
            const euGj = countryGeoData['EU_' + euCode];
            if (euGj && euGj.features) features.push(...euGj.features);
        }
    }
    if (features.length === 0) {
        container.innerHTML = '<div style="font-size:11px;color:var(--text-dim);">Нет данных по региону</div>';
        return;
    }

    container.innerHTML = '<div style="font-size:11px;color:var(--text-dim);">Расчёт...</div>';

    // Async to not block UI
    setTimeout(() => {
        const now = new Date();
        const stepMs = 30000; // 30s step
        const maxMs = 24 * 3600000; // 24h
        let passStart = null;
        let passEnd = null;
        let maxAlt = 0;
        let inRegion = false;

        for (let t = 0; t <= maxMs; t += stepMs) {
            const date = new Date(now.getTime() + t);
            try {
                const posVel = satellite.propagate(sat.satrec, date);
                if (!posVel.position) continue;
                const gmst = satellite.gstime(date);
                const geo = satellite.eciToGeodetic(posVel.position, gmst);
                const lat = satellite.degreesLat(geo.latitude);
                const lon = satellite.degreesLong(geo.longitude);
                const alt = geo.height;
                const pt = turf.point([lon, lat]);

                let inside = false;
                for (const feat of features) {
                    try { if (turf.booleanPointInPolygon(pt, feat)) { inside = true; break; } } catch(e) {}
                }

                if (inside && !inRegion) {
                    inRegion = true;
                    passStart = date;
                    maxAlt = alt;
                } else if (inside && inRegion) {
                    maxAlt = Math.max(maxAlt, alt);
                } else if (!inside && inRegion) {
                    passEnd = date;
                    break;
                }
            } catch(e) {}
        }

        if (!passStart) {
            container.innerHTML = '<div style="font-size:11px;color:var(--text-dim);">Нет пролётов в ближайшие 24ч</div>';
            _nextPassTime = null;
            return;
        }

        if (!passEnd) passEnd = new Date(now.getTime() + maxMs);
        const durSec = Math.round((passEnd - passStart) / 1000);
        const regionName = COUNTRY_NAMES[regionCode] || regionCode;

        // Store for live countdown
        _nextPassTime = passStart.getTime();
        _nextPassEnd = passEnd.getTime();
        _nextPassDurSec = durSec;
        _nextPassAlt = Math.round(maxAlt);
        _nextPassRegion = regionName;
        _nextPassStart = passStart;
        _nextPassEndDate = passEnd;

        renderPassCountdown(container);
        startPassCountdown(); // Ensure countdown interval is running
    }, 10);
}

/** Stored next-pass info for live countdown */
let _nextPassTime = null;
let _nextPassEnd = null;
let _nextPassDurSec = 0;
let _nextPassAlt = 0;
let _nextPassRegion = '';
let _nextPassStart = null;
let _nextPassEndDate = null;
let _passCountdownInterval = null;

function renderPassCountdown(container) {
    if (!container) container = document.getElementById('detailPassResult');
    if (!_nextPassTime || !container) return;

    const now = Date.now();
    const untilMs = _nextPassTime - now;
    let untilStr;
    if (untilMs <= 0 && now < _nextPassEnd) {
        const remainMs = _nextPassEnd - now;
        const remainSec = Math.ceil(remainMs / 1000);
        untilStr = `<span style="color:#00e676;font-weight:700;">&#128752; НАД РЕГИОНОМ (ещё ${remainSec}с)</span>`;
    } else if (untilMs <= 0) {
        untilStr = '<span style="color:var(--text-dim);">Пролёт завершён</span>';
    } else {
        const totalSec = Math.floor(untilMs / 1000);
        const h = Math.floor(totalSec / 3600);
        const m = Math.floor((totalSec % 3600) / 60);
        const s = totalSec % 60;
        if (h > 0) {
            untilStr = `Через <span style="color:var(--accent);font-weight:700;">${h}ч ${m}мин ${s}с</span>`;
        } else if (m > 0) {
            untilStr = `Через <span style="color:var(--accent);font-weight:700;">${m}мин ${s}с</span>`;
        } else {
            untilStr = `Через <span style="color:#00e676;font-weight:700;">${s}с</span>`;
        }
    }

    container.innerHTML = `
        <div class="pass-item" style="border:none;padding:4px 0;">
            <div class="pass-time">${_nextPassStart.toLocaleString('ru-RU', {day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})} &mdash; ${_nextPassEndDate.toLocaleTimeString('ru-RU', {hour:'2-digit',minute:'2-digit'})}</div>
            <div class="pass-meta">${_nextPassDurSec}с · Высота: ${_nextPassAlt} км · ${_nextPassRegion}</div>
            <div style="margin-top:4px;font-size:12px;font-weight:600;">${untilStr}</div>
        </div>`;
}

// Start live countdown interval
function startPassCountdown() {
    if (_passCountdownInterval) clearInterval(_passCountdownInterval);
    _passCountdownInterval = setInterval(() => {
        if (!_nextPassTime || !selectedSat) return; // keep interval alive, just skip
        renderPassCountdown();
    }, 1000);
}
startPassCountdown();

// ============================================================
//  NOTIFICATION / REMINDER SYSTEM
// ============================================================
/** Active reminders: { norad_id: { region: 'RUS', active: true, lastNotified: 0, wasInside: false } } */
let satReminders = {};
try { satReminders = JSON.parse(localStorage.getItem('satReminders') || '{}'); } catch(e) { satReminders = {}; }

function saveReminders() {
    localStorage.setItem('satReminders', JSON.stringify(satReminders));
}

/** Web Audio API notification sound — pleasant two-tone ping */
let _audioCtx = null;
function playNotificationSound() {
    try {
        if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const ctx = _audioCtx;
        const now = ctx.currentTime;

        // First tone (higher)
        const osc1 = ctx.createOscillator();
        const gain1 = ctx.createGain();
        osc1.type = 'sine';
        osc1.frequency.setValueAtTime(880, now);
        gain1.gain.setValueAtTime(0.15, now);
        gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
        osc1.connect(gain1); gain1.connect(ctx.destination);
        osc1.start(now); osc1.stop(now + 0.3);

        // Second tone (lower, slight delay)
        const osc2 = ctx.createOscillator();
        const gain2 = ctx.createGain();
        osc2.type = 'sine';
        osc2.frequency.setValueAtTime(1320, now + 0.15);
        gain2.gain.setValueAtTime(0, now);
        gain2.gain.setValueAtTime(0.12, now + 0.15);
        gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.5);
        osc2.connect(gain2); gain2.connect(ctx.destination);
        osc2.start(now + 0.15); osc2.stop(now + 0.5);
    } catch(e) {}
}

/** Show toast notification */
function showToast(title, message, onClick) {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = `
        <span class="toast-icon">&#128752;</span>
        <div class="toast-body">
            <div class="toast-title">${title}</div>
            <div class="toast-msg">${message}</div>
        </div>
        <button class="toast-close">&times;</button>`;
    toast.querySelector('.toast-close').onclick = (e) => { e.stopPropagation(); toast.classList.add('hiding'); setTimeout(() => toast.remove(), 300); };
    if (onClick) toast.onclick = onClick;
    container.appendChild(toast);
    // Auto-hide after 10s
    setTimeout(() => { if (toast.parentNode) { toast.classList.add('hiding'); setTimeout(() => toast.remove(), 300); } }, 10000);

    // Browser Notification API (if permitted)
    if (Notification.permission === 'granted') {
        new Notification(title, { body: message, icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="%230af"/></svg>' });
    } else if (Notification.permission !== 'denied') {
        Notification.requestPermission();
    }
}

/** Update reminder UI in detail card for current selected satellite */
function updateReminderUI(sat) {
    const toggle = document.getElementById('reminderToggle');
    const status = document.getElementById('reminderStatus');
    if (!sat) return;
    const reminder = satReminders[sat.norad_id];
    const regionCode = document.getElementById('detailPassRegion').value;
    if (reminder && reminder.active && regionCode) {
        toggle.classList.add('active');
        const regionName = COUNTRY_NAMES[regionCode] || regionCode;
        status.textContent = `Отслеживание: ${regionName}`;
        status.classList.add('active');
    } else {
        toggle.classList.remove('active');
        status.textContent = regionCode ? 'Нажмите для включения' : 'Выберите регион и включите напоминание';
        status.classList.remove('active');
    }
}

/** Check all active reminders against current satellite positions */
function checkReminders() {
    const now = Date.now();
    for (const [noradIdStr, reminder] of Object.entries(satReminders)) {
        if (!reminder.active || !reminder.region) continue;
        const noradId = parseInt(noradIdStr);
        const sat = satEntries.find(s => s.norad_id === noradId);
        if (!sat || !sat.lat) continue;

        // Check if satellite is inside region
        let features = [];
        const gj = countryGeoData[reminder.region];
        if (gj && gj.features) features.push(...gj.features);
        if (reminder.region === 'EU') {
            for (const euCode of EU_COUNTRY_CODES) {
                const euGj = countryGeoData['EU_' + euCode];
                if (euGj && euGj.features) features.push(...euGj.features);
            }
        }
        if (features.length === 0) continue;

        const pt = turf.point([sat.lon, sat.lat]);
        let inside = false;
        for (const feat of features) {
            try { if (turf.booleanPointInPolygon(pt, feat)) { inside = true; break; } } catch(e) {}
        }

        if (inside && !reminder.wasInside) {
            // Just entered region — notify! (but not more than once per 5 min)
            if (now - (reminder.lastNotified || 0) > 300000) {
                const regionName = COUNTRY_NAMES[reminder.region] || reminder.region;
                playNotificationSound();
                showToast(
                    `${sat.name} над ${regionName}`,
                    `Спутник вошёл в зону ${regionName} · Высота: ${Math.round(sat.alt)} км`,
                    () => { selectSatellite(sat); }
                );
                reminder.lastNotified = now;
                // Pulse the sprite
                if (sat.sprite3d && sat.sprite3d.material) {
                    const origScale = sat.sprite3d.scale.x;
                    let pulseCount = 0;
                    const pulseInterval = setInterval(() => {
                        pulseCount++;
                        sat.sprite3d.scale.setScalar(pulseCount % 2 === 0 ? origScale : origScale * 1.5);
                        if (pulseCount >= 6) { clearInterval(pulseInterval); sat.sprite3d.scale.setScalar(origScale); }
                    }, 200);
                }
            }
        }
        reminder.wasInside = inside;
    }
}

function deselectSatellite() {
    if (selectedSat && selectedSat.sprite3d) {
        const c = GROUP_COLORS[selectedSat.group] || '#00bfff';
        selectedSat.sprite3d.material.map = makeSatSprite(c, false, selectedSat.group);
        const bs = 0.08 * MOBILE_SCALE;
        selectedSat.sprite3d.scale.set(bs, bs, 1);
        selectedSat._imgSprite = false;
    }
    clearTrack();
    clearCoverageZone();
    selectedSat = null;
    _nextPassTime = null; // Stop countdown
    document.getElementById('satDetail').classList.remove('visible');

    _camFollowSat = false;
}

function updateSelectedDetail() {
    if (!selectedSat) return;
    const s = selectedSat;
    document.getElementById('dAlt').textContent = s.alt ? s.alt.toFixed(1) + ' km' : '\u2014';
    document.getElementById('dLat').textContent = s.lat ? s.lat.toFixed(4) + '\u00B0' : '\u2014';
    document.getElementById('dLon').textContent = s.lon ? s.lon.toFixed(4) + '\u00B0' : '\u2014';
    document.getElementById('dVel').textContent = s.vel ? s.vel.toFixed(2) + ' km/s' : '\u2014';
}

// ============================================================
//  TRAJECTORY RENDERING
// ============================================================
function drawTrack(s) {
    const track = calcTrack(s.satrec, 1.5, 300);
    if (track.length < 2) return;

    const positions = [];
    const colors = [];
    const color = new THREE.Color(GROUP_COLORS[s.group] || '#00bfff');

    for (const p of track) {
        const v = latLonToVec3(p.lat, p.lon, p.alt);
        positions.push(v.x, v.y, v.z);
        // Past path = bright solid, Future path = dimmer
        const brightness = p.isFuture ? 0.4 : 1.0;
        colors.push(color.r * brightness, color.g * brightness, color.b * brightness);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    trackLine3D = new THREE.Line(geo, new THREE.LineBasicMaterial({
        vertexColors: true, transparent: true, opacity: 0.7, linewidth: 1,
    }));
    scene.add(trackLine3D);

    // 2D track on Leaflet
    if (leafletMap) {
        const hexColor = GROUP_COLORS[s.group] || '#00bfff';
        const layers = [];

        let nowIdx = track.findIndex(p => p.isFuture);
        if (nowIdx < 0) nowIdx = track.length;

        function splitAtAntimeridian(pts) {
            const segs = []; let seg = [];
            for (let i = 0; i < pts.length; i++) {
                if (seg.length > 0 && Math.abs(pts[i][1] - seg[seg.length-1][1]) > 170) {
                    segs.push(seg); seg = [];
                }
                seg.push(pts[i]);
            }
            if (seg.length > 0) segs.push(seg);
            return segs;
        }

        const pastPts = track.slice(0, Math.min(nowIdx + 1, track.length)).map(p => [p.lat, p.lon]);
        const futurePts = track.slice(Math.max(nowIdx - 1, 0)).map(p => [p.lat, p.lon]);

        // Past path = solid bright line (already traveled)
        for (const seg of splitAtAntimeridian(pastPts)) {
            if (seg.length > 1) layers.push(L.polyline(seg, { color: hexColor, weight: 2.5, opacity: 0.85, interactive: false }));
        }
        // Future path = dashed dimmer line (predicted trajectory)
        for (const seg of splitAtAntimeridian(futurePts)) {
            if (seg.length > 1) layers.push(L.polyline(seg, { color: hexColor, weight: 1.5, opacity: 0.4, dashArray: '6 4', interactive: false }));
        }
        trackLine2D = L.layerGroup(layers);
        trackLine2D.addTo(leafletMap);
    }
}

function clearTrack() {
    if (trackLine3D) { scene.remove(trackLine3D); trackLine3D.geometry.dispose(); trackLine3D = null; }
    if (trackLine2D && leafletMap) { leafletMap.removeLayer(trackLine2D); trackLine2D = null; }
}

// ============================================================
//  CLICK HANDLERS
// ============================================================
function onClick3D(event) {
    if (currentMode !== '3d') return;
    const rect = renderer.domElement.getBoundingClientRect();
    const mx = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    const my = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    const rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2(mx, my), camera);
    rc.params.Sprite = { threshold: 0.1 };

    // Check if ray hits Earth — satellites behind it should not be clickable
    let earthDist = Infinity;
    if (earthMesh) {
        const earthHits = rc.intersectObject(earthMesh);
        if (earthHits.length > 0) earthDist = earthHits[0].distance;
    }

    const visible = satEntries.filter(s => s.sprite3d && s.sprite3d.visible).map(s => s.sprite3d);
    const hits = rc.intersectObjects(visible);
    // Only select if satellite is in front of Earth (closer to camera)
    if (hits.length > 0 && hits[0].distance < earthDist) {
        selectSatellite(hits[0].object.userData);
        closePointPopup();
    } else if (earthMesh) {
        // Clicked on Earth surface — show upcoming satellite passes
        const earthHits = rc.intersectObject(earthMesh);
        if (earthHits.length > 0) {
            const pt = earthHits[0].point;
            // Convert 3D point to lat/lon
            const r = pt.length();
            const lat = Math.asin(pt.y / r) * RAD2DEG;
            const lon = Math.atan2(pt.z, pt.x) * RAD2DEG;
            showPointPopup(lat, lon, event.clientX, event.clientY);
        }
    }
}

// ============================================================
//  POINT POPUP — satellites passing over clicked point
// ============================================================
function showPointPopup(lat, lon, screenX, screenY) {
    const popup = document.getElementById('pointPopup');
    const body = document.getElementById('pointPopupBody');
    const coords = document.getElementById('pointPopupCoords');

    coords.textContent = `${lat.toFixed(3)}° / ${lon.toFixed(3)}°`;
    body.innerHTML = '<div style="font-size:11px;color:var(--text-dim);">Расчёт пролётов...</div>';

    // Position popup near click
    const vw = window.innerWidth, vh = window.innerHeight;
    let px = screenX + 16, py = screenY + 16;
    if (px + 330 > vw) px = screenX - 336;
    if (py + 430 > vh) py = vh - 440;
    if (px < 4) px = 4;
    if (py < 4) py = 4;
    popup.style.left = px + 'px';
    popup.style.top = py + 'px';
    popup.classList.add('visible');

    // Calculate in background
    setTimeout(() => calcPointPasses(lat, lon), 10);
}

function closePointPopup() {
    document.getElementById('pointPopup').classList.remove('visible');
}

function calcPointPasses(clickLat, clickLon) {
    const body = document.getElementById('pointPopupBody');
    const now = new Date();
    const maxMs = 6 * 3600000; // 6 hours ahead
    const stepMs = 60000; // 1 minute steps
    const maxDist = 1500; // km — coverage radius threshold
    const results = []; // { sat, time, distKm }

    const filtered = getFilteredSats();
    // Limit to reasonable number for performance
    const toCheck = filtered.length > 2000 ? filtered.slice(0, 2000) : filtered;

    for (const s of toCheck) {
        if (!s.satrec) continue;
        let closestDist = Infinity;
        let closestTime = null;

        for (let t = 0; t <= maxMs; t += stepMs) {
            const date = new Date(now.getTime() + t);
            try {
                const posVel = satellite.propagate(s.satrec, date);
                if (!posVel.position) continue;
                const gmst = satellite.gstime(date);
                const geo = satellite.eciToGeodetic(posVel.position, gmst);
                const sLat = satellite.degreesLat(geo.latitude);
                const sLon = satellite.degreesLong(geo.longitude);
                const dist = haversineKm(clickLat, clickLon, sLat, sLon);
                if (dist < maxDist && dist < closestDist) {
                    closestDist = dist;
                    closestTime = date;
                }
            } catch(e) {}
        }
        if (closestTime) {
            results.push({ sat: s, time: closestTime, distKm: closestDist });
        }
    }

    // Sort by time
    results.sort((a, b) => a.time - b.time);
    const top = results.slice(0, 15);

    if (top.length === 0) {
        body.innerHTML = '<div style="font-size:11px;color:var(--text-dim);">Нет пролётов в ближайшие 6ч</div>';
        return;
    }

    body.innerHTML = top.map(r => {
        const untilMs = r.time - now;
        const untilMin = Math.floor(untilMs / 60000);
        const untilH = Math.floor(untilMin / 60);
        const untilM = untilMin % 60;
        const untilStr = untilMs <= 0 ? 'Сейчас' : untilH > 0 ? `${untilH}ч ${untilM}мин` : `${untilM} мин`;
        const timeStr = r.time.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
        const color = GROUP_COLORS[r.sat.group] || '#00bfff';
        return `<div class="point-popup-item" data-norad="${r.sat.norad_id}">
            <div class="point-popup-sat" style="color:${color};">${r.sat.name}</div>
            <div class="point-popup-time">~${timeStr} · Через ${untilStr}</div>
            <div class="point-popup-meta">${r.sat.orbit_type} · ${Math.round(r.distKm)} км от точки · ${GROUP_NAMES[r.sat.group] || r.sat.group}</div>
        </div>`;
    }).join('');

    // Click on item → select satellite
    body.querySelectorAll('.point-popup-item').forEach(el => {
        el.addEventListener('click', () => {
            const nid = parseInt(el.dataset.norad);
            const sat = satEntries.find(s => s.norad_id === nid);
            if (sat) { selectSatellite(sat); closePointPopup(); }
        });
    });
}

// haversineKm already defined above

// ============================================================
//  COUNTRY BORDERS
// ============================================================
// Extra territory polygons to merge into Russia (GeoJSON [lon,lat])
const RUS_EXTRA_POLYGONS = [
    // Crimea
    [[33.38,46.08],[33.65,46.22],[34.05,46.27],[34.42,46.12],[34.82,46.07],
     [35.20,45.93],[35.40,45.72],[35.78,45.54],[36.12,45.38],[36.40,45.22],
     [36.63,45.16],[36.80,45.07],[36.47,45.07],[36.17,45.08],[35.87,44.92],
     [35.62,44.78],[35.30,44.67],[35.00,44.60],[34.72,44.52],[34.42,44.49],
     [34.10,44.42],[33.78,44.40],[33.55,44.40],[33.38,44.50],[33.22,44.60],
     [33.02,44.67],[32.90,44.78],[32.82,44.90],[32.72,45.02],[32.60,45.08],
     [32.52,45.18],[32.50,45.35],[32.55,45.53],[32.67,45.62],[32.85,45.72],
     [33.02,45.83],[33.15,45.92],[33.38,46.08]],
    // DPR (Donetsk, Mariupol)
    [[36.85,48.55],[37.10,48.60],[37.42,48.55],[37.70,48.45],[38.00,48.35],
     [38.25,48.18],[38.45,48.00],[38.68,47.82],[38.80,47.65],[38.85,47.45],
     [38.72,47.28],[38.45,47.12],[38.15,47.05],[37.82,47.00],[37.55,47.02],
     [37.28,47.08],[37.00,47.18],[36.78,47.35],[36.65,47.55],[36.58,47.78],
     [36.60,48.00],[36.68,48.22],[36.75,48.38],[36.85,48.55]],
    // LPR (Lugansk)
    [[38.20,49.30],[38.55,49.32],[38.90,49.25],[39.20,49.15],[39.50,49.00],
     [39.72,48.82],[39.85,48.60],[39.90,48.40],[39.80,48.20],[39.60,48.05],
     [39.30,47.92],[39.00,47.88],[38.70,47.90],[38.45,48.00],[38.25,48.18],
     [38.10,48.38],[38.00,48.58],[37.95,48.78],[38.00,48.98],[38.10,49.15],
     [38.20,49.30]],
    // Zaporozhye
    [[35.15,47.80],[35.55,47.82],[35.90,47.72],[36.20,47.58],[36.50,47.42],
     [36.70,47.22],[36.78,47.00],[36.72,46.80],[36.55,46.62],[36.30,46.48],
     [36.00,46.38],[35.68,46.32],[35.35,46.35],[35.08,46.45],[34.85,46.60],
     [34.70,46.80],[34.65,47.00],[34.70,47.22],[34.82,47.42],[35.00,47.62],
     [35.15,47.80]],
    // Kherson
    [[33.00,46.90],[33.40,47.00],[33.80,46.98],[34.15,46.88],[34.50,46.72],
     [34.70,46.52],[34.80,46.30],[34.75,46.10],[34.55,45.92],[34.25,45.82],
     [33.90,45.78],[33.55,45.80],[33.25,45.90],[33.00,46.05],[32.82,46.25],
     [32.75,46.48],[32.80,46.68],[33.00,46.90]],
];

// Colors per country / group
const COUNTRY_BORDER_COLORS = {
    RUS: '#ff5252', USA: '#2196f3', CHN: '#ffab00', IND: '#00e676',
    JPN: '#e040fb', KOR: '#00bcd4', GBR: '#ff9800', UKR: '#ffd740',
};
// EU/ESA member states — rendered with a single color
const EU_COUNTRY_CODES = [
    'FRA','DEU','ITA','ESP','NLD','BEL','SWE','NOR','FIN','DNK',
    'CHE','AUT','PRT','GRC','POL','CZE','ROU','HUN','IRL',
];
const EU_BORDER_COLOR = '#7c4dff';

const GEO_JSON_BASE = 'https://raw.githubusercontent.com/johan/world.geo.json/master/countries';

/** Fetch a country GeoJSON, returns null on failure */
async function fetchCountryGeoJSON(code) {
    try {
        const r = await fetch(`${GEO_JSON_BASE}/${code}.geo.json`);
        if (!r.ok) return null;
        return await r.json();
    } catch { return null; }
}

/** Use turf.js to subtract polygons from a GeoJSON FeatureCollection */
function subtractPolygonsFromGeoJSON(gj, polygonsToRemove) {
    if (typeof turf === 'undefined' || !gj.features) return gj;
    // Build turf clip polygons (buffer slightly to avoid slivers)
    const clips = [];
    for (const ring of polygonsToRemove) {
        try {
            // turf needs closed rings; ours are already closed
            clips.push(turf.polygon([ring]));
        } catch(e) { /* skip malformed */ }
    }
    if (clips.length === 0) return gj;
    // Merge all clip regions into one polygon for a single difference op
    let clipUnion = clips[0];
    for (let i = 1; i < clips.length; i++) {
        try { clipUnion = turf.union(clipUnion, clips[i]); } catch(e) {}
    }
    // Apply difference to each feature
    for (let i = 0; i < gj.features.length; i++) {
        try {
            const diff = turf.difference(gj.features[i], clipUnion);
            if (diff) gj.features[i] = diff;
        } catch(e) { /* keep original on error */ }
    }
    return gj;
}

/** Create a Leaflet layer from GeoJSON with given color */
function makeCountryLayer(gj, color) {
    return L.geoJSON(gj, {
        style: { color, weight: 1.5, opacity: 0.5, fillColor: color, fillOpacity: 0.04, dashArray: '4 2' },
        interactive: false,
    });
}

async function loadCountryBorders() {
    // ---------- Load all individual countries in parallel ----------
    const allCodes = Object.keys(COUNTRY_BORDER_COLORS);
    const allPromises = allCodes.map(c => fetchCountryGeoJSON(c));
    const euPromises = EU_COUNTRY_CODES.map(c => fetchCountryGeoJSON(c));
    const [countryResults, euResults] = await Promise.all([
        Promise.all(allPromises),
        Promise.all(euPromises),
    ]);

    // ---------- Process each country ----------
    for (let i = 0; i < allCodes.length; i++) {
        const code = allCodes[i];
        const color = COUNTRY_BORDER_COLORS[code];
        let gj = countryResults[i];
        if (!gj) continue;

        // Russia: merge extra territories
        if (code === 'RUS' && gj.features && gj.features.length > 0) {
            const feat = gj.features[0];
            if (feat.geometry.type === 'Polygon') {
                feat.geometry = { type: 'MultiPolygon', coordinates: [feat.geometry.coordinates] };
            }
            for (const poly of RUS_EXTRA_POLYGONS) {
                feat.geometry.coordinates.push([poly]);
            }
        }

        // Ukraine: subtract Russian territories so borders don't overlap
        if (code === 'UKR') {
            gj = subtractPolygonsFromGeoJSON(gj, RUS_EXTRA_POLYGONS);
        }

        countryGeoData[code] = gj;
        countryLayers2D.push(makeCountryLayer(gj, color));
    }

    // ---------- EU / ESA countries ----------
    for (let i = 0; i < EU_COUNTRY_CODES.length; i++) {
        const gj = euResults[i];
        if (!gj) continue;
        countryGeoData['EU_' + EU_COUNTRY_CODES[i]] = gj;
        countryLayers2D.push(makeCountryLayer(gj, EU_BORDER_COLOR));
    }
}

function showCountryBorders() {
    if (!leafletMap) return;
    countryLayers2D.forEach(l => { if (!leafletMap.hasLayer(l)) l.addTo(leafletMap); });
}
function hideCountryBorders() {
    if (!leafletMap) return;
    countryLayers2D.forEach(l => { if (leafletMap.hasLayer(l)) leafletMap.removeLayer(l); });
}

// ============================================================
//  LEAFLET
// ============================================================
function initLeaflet() {
    if (leafletMap) return;
    leafletMap = L.map('mapContainer', {
        center: [20, 0], zoom: 3, zoomControl: false,
        minZoom: 2, maxZoom: 19,
        zoomSnap: 0.25,      // smooth fractional zoom
        zoomDelta: 0.5,      // smaller steps per scroll tick
        wheelPxPerZoomLevel: 120, // smoother wheel zoom
        zoomAnimation: true,
        maxBounds: [[-85, -180], [85, 180]],
        maxBoundsViscosity: 1.0, // hard stop at edges
    });
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { subdomains:'abcd', minZoom:2, maxZoom:19 }).addTo(leafletMap);

    // Throttled mousemove (max 10 updates/sec instead of 60+)
    let _lastMouseUpdate = 0;
    const _coordLat = document.getElementById('coordLat');
    const _coordLon = document.getElementById('coordLon');
    leafletMap.on('mousemove', e => {
        if (currentMode !== '2d') return;
        const now = performance.now();
        if (now - _lastMouseUpdate < 100) return; // 10 fps throttle
        _lastMouseUpdate = now;
        _coordLat.textContent = e.latlng.lat.toFixed(4) + '\u00B0';
        _coordLon.textContent = e.latlng.lng.toFixed(4) + '\u00B0';
    });
    // No auto-transition on zoom — only through buttons

    // Update satellite icon sizes on zoom change
    let _lastIconZoom = leafletMap.getZoom();
    leafletMap.on('zoomend', () => {
        const newSz = getSatIconSize2D();
        const oldSz = _lastIconZoom <= 3 ? 12 : _lastIconZoom <= 5 ? 16 : _lastIconZoom <= 8 ? 22 : _lastIconZoom <= 11 ? 28 : 34;
        _lastIconZoom = leafletMap.getZoom();
        if (newSz === oldSz) return; // same size bracket, skip
        satEntries.forEach(s => {
            if (!s.marker2d) return;
            const color = GROUP_COLORS[s.group] || '#00bfff';
            const iconHtml = makeSatIconHtml(s.group, color, newSz);
            s.marker2d.setIcon(L.divIcon({
                className: '', html: iconHtml,
                iconSize: [newSz, newSz], iconAnchor: [newSz/2, newSz/2],
            }));
        });
    });

    // Click handler: find the closest visible satellite to click point
    leafletMap.on('click', e => {
        if (currentMode !== '2d') return;
        const clickLat = e.latlng.lat, clickLon = e.latlng.lng;
        // Max click distance in pixels
        const maxPx = IS_MOBILE ? 40 : 20; // Bigger touch target on mobile
        let bestSat = null, bestDist = Infinity;
        getFilteredSats();
        for (const s of satEntries) {
            if (!isFiltered(s) || s.lat === 0) continue;
            const pt = leafletMap.latLngToContainerPoint([s.lat, s.lon]);
            const clickPt = e.containerPoint;
            const dx = pt.x - clickPt.x, dy = pt.y - clickPt.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < maxPx && dist < bestDist) {
                bestDist = dist;
                bestSat = s;
            }
        }
        if (bestSat) {
            selectSatellite(bestSat);
            closePointPopup();
        } else {
            // Clicked on map surface — show upcoming passes over this point
            const clickX = e.originalEvent?.clientX ?? (e.containerPoint.x + 16);
            const clickY = e.originalEvent?.clientY ?? (e.containerPoint.y + 60);
            showPointPopup(e.latlng.lat, e.latlng.lng, clickX, clickY);
        }
    });

    initSatMarkers2D();
}

// ============================================================
//  TRANSITIONS
// ============================================================
function transitionTo2D() {
    if (isTransitioning || currentMode !== '3d') return;
    isTransitioning = true;
    savedCamPos = camera.position.clone(); savedCamTarget = controls.target.clone();
    const c = getCameraLatLng();
    const z = 3;
    if (!leafletMap) initLeaflet();
    leafletMap.setView([c.lat, c.lng], z, { animate: false });
    document.getElementById('view3D').classList.add('hidden');
    document.getElementById('view2D').classList.add('active');
    currentMode = '2d';
    isTransitioning = false;
    leafletMap.invalidateSize();
    updateModeUI();
    updateSatMarkers2D();
    showCountryBorders();
}
function transitionTo3D() {
    if (isTransitioning || currentMode !== '2d') return;
    isTransitioning = true;
    if (savedCamPos) { camera.position.copy(savedCamPos); controls.target.copy(savedCamTarget); }
    controls.update();
    hideCountryBorders();
    document.getElementById('view3D').classList.remove('hidden');
    document.getElementById('view2D').classList.remove('active');
    currentMode = '3d';
    isTransitioning = false;
    updateModeUI();
}
function updateModeUI() {
    document.getElementById('btn3D').classList.toggle('active', currentMode==='3d');
    document.getElementById('btn2D').classList.toggle('active', currentMode==='2d');
    document.getElementById('statusMode').textContent = 'Режим: ' + (currentMode==='3d'?'3D':'2D');
}
function handleWheel(e) {
    // No scroll-based transitions — use buttons only
}

// ============================================================
//  MOUSE 3D
// ============================================================
function onMouseMove3D(event) {
    if (currentMode !== '3d') return;
    const rect = renderer.domElement.getBoundingClientRect();
    const mx = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    const my = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    const rc = new THREE.Raycaster(); rc.setFromCamera(new THREE.Vector2(mx,my), camera);
    const hits = rc.intersectObject(earthMesh);
    if (hits.length > 0) {
        const p = hits[0].point;
        document.getElementById('coordLat').textContent = (Math.asin(p.y/EARTH_RADIUS)*RAD2DEG).toFixed(4)+'\u00B0';
        document.getElementById('coordLon').textContent = (Math.atan2(p.z,p.x)*RAD2DEG).toFixed(4)+'\u00B0';
    }
}

// ============================================================
//  UI SETUP
// ============================================================
function setupUI() {
    // Mode buttons
    document.getElementById('btn3D').addEventListener('click', () => { if(currentMode==='2d')transitionTo3D(); else animateCameraTo(new THREE.Vector3(0,1.5,5.5),1200); });
    document.getElementById('btn2D').addEventListener('click', () => { if(currentMode==='3d')transitionTo2D(); });
    document.getElementById('btnReset').addEventListener('click', () => {
        deselectSatellite();
        closePointPopup();
        if(currentMode==='3d'){animateCameraTo(new THREE.Vector3(0,1.5,5.5),1200);controls.target.set(0,0,0);}
        else if(leafletMap){leafletMap.setView([20,0],3);}
    });
    document.getElementById('btnZoomIn').addEventListener('click', () => {
        if(currentMode==='2d'){if(leafletMap)leafletMap.zoomIn();}
        else{
            _camFollowSat = false;
            const d=camera.position.clone().normalize(),p=camera.position.clone().sub(d.multiplyScalar(0.5));
            if(p.length()>EARTH_RADIUS+0.15)animateCameraTo(p,400);
        }
    });
    document.getElementById('btnZoomOut').addEventListener('click', () => {
        if(currentMode==='2d'){ if(leafletMap) leafletMap.zoomOut(); }
        else{
            _camFollowSat = false;
            const d=camera.position.clone().normalize(),p=camera.position.clone().add(d.multiplyScalar(0.5));
            animateCameraTo(p,400);
        }
    });
    document.getElementById('detailClose').addEventListener('click', deselectSatellite);
    document.getElementById('pointPopupClose').addEventListener('click', closePointPopup);

    // Bottom-sheet drag handle (works on all screens, CSS hides it on desktop)
    {
        const dragHandle = document.getElementById('detailDragHandle');
        const satDetail = document.getElementById('satDetail');
        let touchStartY = 0;
        let touchDelta = 0;

        dragHandle.addEventListener('click', () => {
            // Cycle: default (55vh) → collapsed (peek) → default → expanded
            if (satDetail.classList.contains('collapsed')) {
                satDetail.classList.remove('collapsed');
                satDetail.classList.remove('expanded');
            } else if (satDetail.classList.contains('expanded')) {
                satDetail.classList.remove('expanded');
            } else {
                satDetail.classList.add('collapsed');
            }
        });

        dragHandle.addEventListener('touchstart', (e) => {
            touchStartY = e.touches[0].clientY;
            touchDelta = 0;
        }, { passive: true });

        dragHandle.addEventListener('touchmove', (e) => {
            touchDelta = e.touches[0].clientY - touchStartY;
        }, { passive: true });

        dragHandle.addEventListener('touchend', () => {
            if (touchDelta > 60) {
                // Swipe down → collapse
                satDetail.classList.add('collapsed');
                satDetail.classList.remove('expanded');
            } else if (touchDelta < -60) {
                // Swipe up → expand
                satDetail.classList.remove('collapsed');
                satDetail.classList.add('expanded');
            }
        });
    }

    // Region selector in detail card — calculate next pass + update reminder
    document.getElementById('detailPassRegion').addEventListener('change', (e) => {
        const region = e.target.value;
        if (selectedSat) {
            updateDetailPassForRegion(selectedSat, region);
            // Update reminder region too
            if (satReminders[selectedSat.norad_id]) {
                satReminders[selectedSat.norad_id].region = region;
                saveReminders();
            }
            updateReminderUI(selectedSat);
        }
    });

    // Reminder toggle
    document.getElementById('reminderToggle').addEventListener('click', () => {
        if (!selectedSat) return;
        const region = document.getElementById('detailPassRegion').value;
        if (!region) {
            showToast('Выберите регион', 'Сначала выберите регион для отслеживания');
            return;
        }
        const nid = selectedSat.norad_id;
        if (satReminders[nid] && satReminders[nid].active) {
            // Disable
            delete satReminders[nid];
        } else {
            // Enable
            satReminders[nid] = { region, active: true, lastNotified: 0, wasInside: false };
            // Request notification permission
            if ('Notification' in window && Notification.permission === 'default') {
                Notification.requestPermission();
            }
        }
        saveReminders();
        updateReminderUI(selectedSat);
    });

    // Fav button
    document.getElementById('detailFav').addEventListener('click', () => {
        if (selectedSat) toggleFavorite(selectedSat.norad_id);
    });

    // Group filter chips
    const CONSTELLATION_GROUPS = ['starlink', 'oneweb'];
    document.querySelectorAll('.fp-chip[data-group]').forEach(chip => {
        chip.addEventListener('click', () => {
            document.querySelectorAll('.fp-chip[data-group]').forEach(c=>c.classList.remove('active'));
            chip.classList.add('active');
            const group = chip.dataset.group;
            if (group === 'favorites') {
                favoritesOnly = !favoritesOnly;
                if (favoritesOnly) activeGroupFilters = new Set(ALL_GROUP_FILTERS);
            } else if (group === 'all') {
                favoritesOnly = false;
                activeGroupFilters = new Set(ALL_GROUP_FILTERS);
            } else {
                favoritesOnly = false;
                // If clicking the same single group — go back to all
                if (activeGroupFilters.size === 1 && activeGroupFilters.has(group)) {
                    activeGroupFilters = new Set(ALL_GROUP_FILTERS);
                } else {
                    // Select only this group
                    activeGroupFilters = new Set([group]);
                }
            }
            // Show/hide altitude filter for constellation groups
            const altSection = document.getElementById('fpAltSection');
            const shellSection = document.getElementById('fpStarlinkShellSection');
            const singleConstellation = getSingleSelectedConstellationGroup();
            if (CONSTELLATION_GROUPS.includes(singleConstellation)) {
                altSection.style.display = '';
                // Set slider range to group bounds
                const groupSats = satEntries.filter(s => s.group === singleConstellation && s.alt > 0);
                if (groupSats.length > 0) {
                    const minA = Math.round(Math.min(...groupSats.map(s => s.alt)) / 10) * 10;
                    const maxA = Math.round(Math.max(...groupSats.map(s => s.alt)) / 10) * 10 + 10;
                    const sMin = document.getElementById('fpAltMin');
                    const sMax = document.getElementById('fpAltMax');
                    if (sMin && sMax) {
                        sMin.min = minA; sMin.max = maxA; sMin.value = minA;
                        sMax.min = minA; sMax.max = maxA; sMax.value = maxA;
                        altFilterMin = null; altFilterMax = null;
                        // Update track
                        const track = document.getElementById('fpAltTrack');
                        if (track) { track.style.setProperty('--track-left','0%'); track.style.setProperty('--track-right','0%'); }
                        const lbl = document.getElementById('fpAltRangeLabel');
                        if (lbl) lbl.textContent = 'все';
                        document.getElementById('fpAltMinLabel').textContent = minA + ' км';
                        document.getElementById('fpAltMaxLabel').textContent = maxA + ' км';
                    }
                    document.getElementById('fpAltInfo').textContent = `Диапазон группы: ${minA}–${maxA} км`;
                }
            } else {
                altSection.style.display = 'none';
                altFilterMin = null; altFilterMax = null;
            }
            // Show/hide Starlink shell filter — show whenever starlink is in active filters
            if (activeGroupFilters.has('starlink') && !favoritesOnly) {
                if (shellSection) shellSection.style.display = '';
            } else {
                if (shellSection) shellSection.style.display = 'none';
                activeShellFilter = null;
                document.querySelectorAll('.fp-shell-chip').forEach(c => c.classList.remove('active'));
                const allChip = document.querySelector('.fp-shell-chip[data-shell="all"]');
                if (allChip) allChip.classList.add('active');
            }
            syncGroupChipState();
            applyFilters();
        });
    });

    // Altitude dual-range slider
    const altSliderMin = document.getElementById('fpAltMin');
    const altSliderMax = document.getElementById('fpAltMax');
    const altTrack = document.getElementById('fpAltTrack');
    const altRangeLabel = document.getElementById('fpAltRangeLabel');

    function updateAltSlider() {
        let lo = parseInt(altSliderMin.value);
        let hi = parseInt(altSliderMax.value);
        if (lo > hi) { // swap if crossed
            if (this === altSliderMin) altSliderMin.value = hi;
            else altSliderMax.value = lo;
            lo = parseInt(altSliderMin.value);
            hi = parseInt(altSliderMax.value);
        }
        const rangeMin = parseInt(altSliderMin.min);
        const rangeMax = parseInt(altSliderMin.max);
        const pctL = ((lo - rangeMin) / (rangeMax - rangeMin)) * 100;
        const pctR = 100 - ((hi - rangeMin) / (rangeMax - rangeMin)) * 100;
        if (altTrack) {
            altTrack.style.setProperty('--track-left', pctL + '%');
            altTrack.style.setProperty('--track-right', pctR + '%');
        }
        altFilterMin = (lo > rangeMin) ? lo : null;
        altFilterMax = (hi < rangeMax) ? hi : null;
        if (altRangeLabel) {
            if (altFilterMin === null && altFilterMax === null) {
                altRangeLabel.textContent = 'все';
            } else {
                altRangeLabel.textContent = `${lo} — ${hi} км`;
            }
        }
        invalidateFilterCache();
        applyFilters();
    }
    if (altSliderMin && altSliderMax) {
        altSliderMin.addEventListener('input', updateAltSlider);
        altSliderMax.addEventListener('input', updateAltSlider);
    }

    // Orbit filter chips
    document.querySelectorAll('.fp-orbit-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            if (chip.classList.contains('active')) {
                chip.classList.remove('active');
                activeOrbitFilter = null;
            } else {
                document.querySelectorAll('.fp-orbit-chip').forEach(c=>c.classList.remove('active'));
                chip.classList.add('active');
                activeOrbitFilter = chip.dataset.orbit;
            }
            applyFilters();
        });
    });

    // Starlink shell chips
    document.querySelectorAll('.fp-shell-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            const shell = chip.dataset.shell;
            document.querySelectorAll('.fp-shell-chip').forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
            if (shell === 'all') {
                activeShellFilter = null;
            } else {
                activeShellFilter = shell;
            }
            // Update info text
            const info = document.getElementById('fpShellInfo');
            if (info && activeShellFilter) {
                const filtered = satEntries.filter(s => {
                    if (s.group !== 'starlink' || !s.satrec) return false;
                    const incDeg = s.satrec.inclo * 180 / Math.PI;
                    const alt = s.alt || 0;
                    switch (activeShellFilter) {
                        case 'shell1': return incDeg > 50 && incDeg < 56 && alt >= 530 && alt <= 570;
                        case 'shell2': return incDeg > 40 && incDeg < 46 && alt >= 460 && alt <= 520;
                        case 'shell3': return incDeg > 50 && incDeg < 56 && alt >= 460 && alt <= 510;
                        case 'shell4': return incDeg > 68 && incDeg < 72 && alt >= 550 && alt <= 610;
                        case 'shell5': return incDeg > 96 && incDeg < 99 && alt >= 530 && alt <= 580;
                        case 'raising': return alt < 420;
                        default: return true;
                    }
                });
                info.textContent = `Спутников в оболочке: ${filtered.length}`;
            } else if (info) {
                info.textContent = '';
            }
            invalidateFilterCache();
            applyFilters();
            updateFilterBadge();
        });
    });

    // Country filter
    document.getElementById('countryFilter').addEventListener('change', (e) => {
        activeCountryFilter = e.target.value;
        applyFilters();
    });

    // Search
    let searchTimeout;
    document.getElementById('searchInput').addEventListener('input', (e) => {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => {
            searchQuery = e.target.value.trim();
            applyFilters();
        }, 300);
    });

    // Filter panel toggle
    document.getElementById('filterToggle').addEventListener('click', () => {
        const panel = document.getElementById('filterPanel');
        const toggle = document.getElementById('filterToggle');
        panel.classList.toggle('open');
        toggle.classList.toggle('active');
    });
    document.getElementById('filterPanelClose').addEventListener('click', () => {
        document.getElementById('filterPanel').classList.remove('open');
        document.getElementById('filterToggle').classList.remove('active');
    });
    // Filter reset button
    document.getElementById('filterResetBtn').addEventListener('click', () => {
        favoritesOnly = false;
        activeGroupFilters = new Set(ALL_GROUP_FILTERS);
        syncGroupChipState();
        // Reset orbit
        document.querySelectorAll('.fp-orbit-chip').forEach(c => c.classList.remove('active'));
        activeOrbitFilter = null;
        // Reset country
        document.getElementById('countryFilter').value = '';
        activeCountryFilter = '';
        // Reset search
        document.getElementById('searchInput').value = '';
        searchQuery = '';
        // Reset shell filter
        activeShellFilter = null;
        document.querySelectorAll('.fp-shell-chip').forEach(c => c.classList.remove('active'));
        const allShellChip = document.querySelector('.fp-shell-chip[data-shell="all"]');
        if (allShellChip) allShellChip.classList.add('active');
        const shellInfo = document.getElementById('fpShellInfo');
        if (shellInfo) shellInfo.textContent = '';
        const shellSection = document.getElementById('fpStarlinkShellSection');
        if (shellSection) shellSection.style.display = 'none';
        // Reset starlink limit
        starlinkLimit = Infinity;
        const slSlider = document.getElementById('starlinkLimitSlider');
        if (slSlider) { slSlider.value = slSlider.max; }
        const slVal = document.getElementById('starlinkLimitValue');
        if (slVal) slVal.textContent = 'все';
        // Apply
        invalidateFilterCache();
        applyFilters();
        updateFilterBadge();
    });
    syncGroupChipState();

    // Starlink limit slider
    const slSlider = document.getElementById('starlinkLimitSlider');
    if (slSlider) {
        // Set max to actual starlink count after satellites load
        const updateSlMax = () => {
            const slTotal = satEntries.filter(s => s.group === 'starlink').length;
            if (slTotal > 0) {
                slSlider.max = Math.ceil(slTotal / 500) * 500;
                // Keep current value, don't reset
            }
        };
        setTimeout(updateSlMax, 5000);

        slSlider.addEventListener('input', () => {
            const val = parseInt(slSlider.value);
            const maxVal = parseInt(slSlider.max);
            const label = document.getElementById('starlinkLimitValue');
            if (val >= maxVal) {
                starlinkLimit = Infinity;
                if (label) label.textContent = 'все';
            } else {
                starlinkLimit = val;
                if (label) label.textContent = val.toLocaleString('ru-RU');
            }
            invalidateFilterCache();
            applyFilters();
            updateFilterBadge();
        });
    }

    // Auth button
    document.getElementById('btnAuth').addEventListener('click', () => {
        if (currentUser) {
            const menu = document.getElementById('userMenu');
            menu.classList.toggle('visible');
        } else {
            openAuthModal();
        }
    });

    // User menu items
    document.getElementById('menuSatManager').addEventListener('click', () => {
        document.getElementById('userMenu').classList.remove('visible');
        showSatManager();
    });
    document.getElementById('menuFavorites').addEventListener('click', () => {
        document.getElementById('userMenu').classList.remove('visible');
        showFavorites();
    });
    document.getElementById('menuLeader').addEventListener('click', () => {
        document.getElementById('userMenu').classList.remove('visible');
        showLeaderPanel();
    });
    document.getElementById('menuAdmin').addEventListener('click', () => {
        document.getElementById('userMenu').classList.remove('visible');
        showAdminPanel();
    });
    document.getElementById('menuLogout').addEventListener('click', () => {
        document.getElementById('userMenu').classList.remove('visible');
        logout();
    });
    document.getElementById('menuResendConfirm').addEventListener('click', async () => {
        document.getElementById('userMenu').classList.remove('visible');
        if (!authToken) return;
        try {
            const r = await apiRequest(`${API_BASE}/auth/resend-confirmation`, { method: 'POST' });
            const d = await r.json();
            alert(d.message || 'Письмо отправлено. Проверьте консоль сервера.');
        } catch (e) {
            alert('Ошибка: ' + e.message);
        }
    });

    // Altitude lines toggle
    document.getElementById('btnAltLines').addEventListener('click', toggleAltitudeLines);

    // Coverage + hex cells toggle
    document.getElementById('btnCoverage').addEventListener('click', toggleCoverage);

    // Analysis button
    document.getElementById('btnAnalysis').addEventListener('click', showAnalysis);

    // Passes button
    document.getElementById('btnPasses').addEventListener('click', () => {
        populatePassRegions();
        document.getElementById('passesModal').classList.add('visible');
    });

    // Auth modal
    document.getElementById('authModalClose').addEventListener('click', () => closeAllModals());
    document.getElementById('showRegister').addEventListener('click', () => {
        showAuthForm('register');
    });
    document.getElementById('showLogin').addEventListener('click', () => {
        showAuthForm('login');
    });
    document.getElementById('showForgot').addEventListener('click', () => {
        showAuthForm('forgot');
    });
    document.getElementById('backToLogin').addEventListener('click', () => {
        showAuthForm('login');
    });

    // Login
    document.getElementById('loginBtn').addEventListener('click', async () => {
        const username = document.getElementById('loginUsername').value.trim();
        const password = document.getElementById('loginPassword').value;
        if (!username || !password) return;
        try {
            document.getElementById('loginBtn').disabled = true;
            await login(username, password);
            closeAllModals();
        } catch (e) {
            const err = document.getElementById('authError');
            err.textContent = e.message;
            err.classList.add('visible');
        }
        document.getElementById('loginBtn').disabled = false;
    });

    // Register
    document.getElementById('registerBtn').addEventListener('click', async () => {
        const username = document.getElementById('regUsername').value.trim();
        const email = document.getElementById('regEmail').value.trim();
        const fullName = document.getElementById('regFullName').value.trim();
        const password = document.getElementById('regPassword').value;
        if (!username || !email || !fullName || !password) return;
        try {
            document.getElementById('registerBtn').disabled = true;
            await register(username, email, fullName, password);
            // Show success + email confirmation notice
            const err = document.getElementById('authError');
            err.innerHTML = '✓ Регистрация успешна! На email отправлена ссылка для подтверждения.<br><small style="color:var(--text-dim)">(Проверьте консоль сервера для ссылки)</small>';
            err.style.color = 'var(--success)';
            err.classList.add('visible');
            setTimeout(() => { err.style.color = ''; closeAllModals(); }, 3000);
        } catch (e) {
            const err = document.getElementById('authError');
            err.textContent = e.message;
            err.classList.add('visible');
        }
        document.getElementById('registerBtn').disabled = false;
    });

    // Enter on login form
    document.getElementById('loginPassword').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') document.getElementById('loginBtn').click();
    });

    // Forgot password
    document.getElementById('forgotBtn').addEventListener('click', async () => {
        const email = document.getElementById('forgotEmail').value.trim();
        if (!email) return;
        try {
            document.getElementById('forgotBtn').disabled = true;
            await forgotPassword(email);
            const err = document.getElementById('authError');
            err.textContent = 'Если email зарегистрирован — ссылка для сброса отправлена. Проверьте консоль сервера.';
            err.style.color = 'var(--success)';
            err.classList.add('visible');
            setTimeout(() => { err.style.color = ''; }, 5000);
        } catch (e) {
            const err = document.getElementById('authError');
            err.textContent = e.message;
            err.classList.add('visible');
        }
        document.getElementById('forgotBtn').disabled = false;
    });

    // Reset password
    document.getElementById('resetBtn').addEventListener('click', async () => {
        const pw = document.getElementById('resetPassword').value;
        const pw2 = document.getElementById('resetPasswordConfirm').value;
        if (!pw || !pw2) return;
        if (pw !== pw2) {
            const err = document.getElementById('authError');
            err.textContent = 'Пароли не совпадают';
            err.classList.add('visible');
            return;
        }
        if (pw.length < 4) {
            const err = document.getElementById('authError');
            err.textContent = 'Пароль слишком короткий (мин. 4 символа)';
            err.classList.add('visible');
            return;
        }
        try {
            document.getElementById('resetBtn').disabled = true;
            const resetToken = window._resetToken || '';
            await resetPassword(resetToken, pw);
            window._resetToken = null;
            showAuthForm('login');
            const err = document.getElementById('authError');
            err.textContent = 'Пароль успешно изменён! Войдите с новым паролем.';
            err.style.color = 'var(--success)';
            err.classList.add('visible');
            setTimeout(() => { err.style.color = ''; }, 5000);
        } catch (e) {
            const err = document.getElementById('authError');
            err.textContent = e.message;
            err.classList.add('visible');
        }
        document.getElementById('resetBtn').disabled = false;
    });

    // Enter on forgot form
    document.getElementById('forgotEmail').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') document.getElementById('forgotBtn').click();
    });

    // Modal close buttons
    document.getElementById('adminModalClose').addEventListener('click', () => closeAllModals());
    document.getElementById('leaderModalClose').addEventListener('click', () => closeAllModals());
    document.getElementById('favModalClose').addEventListener('click', () => closeAllModals());
    document.getElementById('passesModalClose').addEventListener('click', () => closeAllModals());

    // Close modals on overlay click
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closeAllModals();
        });
    });

    // Passes calc
    document.getElementById('passesCalcBtn').addEventListener('click', calculatePasses);

    // Chat
    document.getElementById('chatToggleBtn').addEventListener('click', toggleChat);
    document.getElementById('chatClose').addEventListener('click', toggleChat);
    document.getElementById('chatSend').addEventListener('click', sendChatMessage);
    setupChatMentions();

    // Close user menu on outside click
    document.addEventListener('click', (e) => {
        if (!e.target.closest('#btnAuth') && !e.target.closest('#userMenu')) {
            document.getElementById('userMenu').classList.remove('visible');
        }
    });

    window.addEventListener('wheel', handleWheel, { passive: false });
    window.addEventListener('resize', () => {
        if(camera&&renderer){const h=window.innerHeight-48;camera.aspect=window.innerWidth/h;camera.updateProjectionMatrix();renderer.setSize(window.innerWidth,h);}
        if(leafletMap)leafletMap.invalidateSize();
    });
    document.addEventListener('keydown', e => {
        if(e.target.tagName==='INPUT'||e.target.tagName==='SELECT')return;
        if(e.key==='Escape'){deselectSatellite();closeAllModals();}
        if(e.key===' '){e.preventDefault();document.getElementById('tlPlayPause').click();}
    });

    // ===== TIMELINE CONTROLS =====
    const slider = document.getElementById('tlSlider');

    // Play/Pause
    document.getElementById('tlPlayPause').addEventListener('click', () => {
        if (simPlaying) {
            // Pause: freeze current sim time
            simPausedAt = getSimTime();
            simPlaying = false;
        } else {
            // Resume: adjust offsets so time continues from where it was frozen
            if (simPausedAt) {
                const frozenOffset = simPausedAt.getTime() - Date.now();
                simTimeOffset = frozenOffset;
                simAccumulated = 0;
                simPausedAt = null;
            }
            simPlaying = true;
            simLastReal = performance.now();
        }
        document.getElementById('tlPlayPause').innerHTML = simPlaying ? '&#9646;&#9646;' : '&#9654;';
        document.getElementById('tlPlayPause').classList.toggle('active', simPlaying);
    });

    // LIVE button — reset to real time
    document.getElementById('tlLive').addEventListener('click', () => {
        simTimeOffset = 0;
        simAccumulated = 0;
        simSpeed = 1;
        simPlaying = true;
        simLastReal = performance.now();
        slider.value = 0;
        document.getElementById('tlPlayPause').innerHTML = '&#9646;&#9646;';
        document.getElementById('tlPlayPause').classList.add('active');
        // Reset speed buttons
        document.querySelectorAll('.tl-speed-btn').forEach(b => b.classList.toggle('active', b.dataset.speed === '1'));
        // Force immediate recalculation
        lastSatUpdate = 0;
    });

    // Slider drag
    slider.addEventListener('input', () => {
        sliderDragging = true;
        const sec = parseInt(slider.value);
        simTimeOffset = sec * 1000;
        simAccumulated = 0;
        // If paused, update frozen time too
        if (!simPlaying) {
            simPausedAt = new Date(Date.now() + simTimeOffset);
        }
        // Force recalculation
        lastSatUpdate = 0;
    });
    slider.addEventListener('change', () => {
        sliderDragging = false;
    });

    // Speed buttons
    document.querySelectorAll('.tl-speed-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tl-speed-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            simSpeed = parseFloat(btn.dataset.speed);
            simLastReal = performance.now();
        });
    });
}

let sliderDragging = false;

function updateFilterBadge() {
    let count = 0;
    if (favoritesOnly || activeGroupFilters.size !== ALL_GROUP_FILTERS.length) count++;
    if (activeOrbitFilter) count++;
    if (activeCountryFilter) count++;
    if (searchQuery) count++;
    if (activeShellFilter) count++;
    if (starlinkLimit !== Infinity) count++;
    const badge = document.getElementById('filterBadge');
    if (badge) {
        if (count > 0) {
            badge.style.display = '';
            badge.textContent = count;
        } else {
            badge.style.display = 'none';
        }
    }
    // Update stats
    const filtered = getFilteredSats();
    const statsEl = document.getElementById('fpStatsText');
    if (statsEl) statsEl.textContent = `Показано: ${filtered.length} из ${satEntries.length}`;
}

// calcPointPasses defined above (client-side SGP4)

function applyFilters() {
    invalidateFilterCache();
    updateSatSprites3D();
    if (leafletMap && currentMode === '2d') updateSatMarkers2D();
    const filtered = getFilteredSats();
    document.getElementById('statusText').textContent = `Система активна | ${filtered.length} из ${satEntries.length} на карте (${totalInDB} в БД)`;
    updateFilterBadge();
}

// ============================================================
//  ANIMATE
// ============================================================
let lastSatUpdate = 0;
let lastSatVisualUpdate = 0;
let satPosA = new Map();
let satPosB = new Map();
let satLerpT0 = 0;
let SGP4_INTERVAL = 2000; // Will be adjusted after loading for large datasets
const VISUAL_INTERVAL = 33;
let lastSatVisualUpdate2D = 0;

function interpolateSatPositions(t01) {
    for (const s of satEntries) {
        const a = satPosA.get(s.norad_id);
        const b = satPosB.get(s.norad_id);
        if (a && b) {
            s.lat = a.lat + (b.lat - a.lat) * t01;
            let dlon = b.lon - a.lon;
            if (dlon > 180) dlon -= 360;
            if (dlon < -180) dlon += 360;
            s.lon = a.lon + dlon * t01;
            if (s.lon > 180) s.lon -= 360;
            if (s.lon < -180) s.lon += 360;
            s.alt = a.alt + (b.alt - a.alt) * t01;
            s.vel = a.vel + (b.vel - a.vel) * t01;
        }
    }
}

function animate() {
    requestAnimationFrame(animate);
    frameCount++;
    const now = performance.now();
    if (now - lastFpsTime >= 1000) { frameCount=0; lastFpsTime=now; }

    // Advance simulation time
    if (simPlaying && simLastReal > 0) {
        const realDelta = Math.min(now - simLastReal, 200); // cap delta to avoid jumps
        simAccumulated += realDelta * (simSpeed - 1);
    }
    simLastReal = simPlaying ? now : 0;

    // Display simulation time
    const simNow = getSimTime();
    document.getElementById('clockDisplay').textContent = simNow.toLocaleTimeString('ru-RU') + ' | UTC ' + simNow.toUTCString().slice(17,25);
    document.getElementById('tlTime').textContent = simNow.toLocaleTimeString('ru-RU', {hour:'2-digit',minute:'2-digit',second:'2-digit'}) + ' ' + simNow.toLocaleDateString('ru-RU', {day:'2-digit',month:'2-digit'});

    // Update offset display
    const totalOffsetSec = Math.round((simTimeOffset + simAccumulated) / 1000);
    const tlOffsetEl = document.getElementById('tlOffset');
    if (Math.abs(totalOffsetSec) < 2 && simSpeed === 1) {
        tlOffsetEl.textContent = 'LIVE';
        tlOffsetEl.className = 'tl-offset live';
    } else {
        const sign = totalOffsetSec >= 0 ? '+' : '';
        const absS = Math.abs(totalOffsetSec);
        const m = Math.floor(absS / 60);
        const s = absS % 60;
        tlOffsetEl.textContent = `${sign}${totalOffsetSec >= 0 ? '' : '-'}${m}:${String(s).padStart(2,'0')}`;
        tlOffsetEl.className = 'tl-offset';
    }

    // Update slider position (only if user isn't dragging)
    if (!sliderDragging) {
        const sliderVal = Math.round((simTimeOffset + simAccumulated) / 1000);
        const clamped = Math.max(-3600, Math.min(3600, sliderVal));
        document.getElementById('tlSlider').value = clamped;
    }

    // Camera altitude display
    if (currentMode === '3d' && camera) {
        document.getElementById('coordAlt').textContent = ((camera.position.length()-EARTH_RADIUS)/EARTH_RADIUS*6371).toFixed(0)+' km';
    } else if (currentMode === '2d' && leafletMap) {
        // Approximate altitude from zoom level: at zoom 3 ≈ 8000km, zoom 18 ≈ 0.5km
        const z = leafletMap.getZoom();
        const altKm = Math.round(40000 / Math.pow(2, z));
        document.getElementById('coordAlt').textContent = altKm + ' km';
    }

    if (now - lastSatUpdate > SGP4_INTERVAL) {
        satPosA = new Map(satPosB);
        updateSatPositions();
        satPosB.clear();
        for (const s of satEntries) {
            if (s.lat != null) satPosB.set(s.norad_id, { lat: s.lat, lon: s.lon, alt: s.alt, vel: s.vel });
        }
        satLerpT0 = now;
        lastSatUpdate = now;
        if (selectedSat) updateSelectedDetail();
        checkReminders(); // Check all active region reminders

        // Periodically redraw track + coverage so they follow the satellite
        if (selectedSat && now - lastTrackUpdate > TRACK_UPDATE_INTERVAL) {
            clearTrack();
            drawTrack(selectedSat);
            if (showCoverage) showCoverageZone(selectedSat);
            lastTrackUpdate = now;
        }
    }

    if (now - lastSatVisualUpdate > VISUAL_INTERVAL) {
        const t01 = Math.min(1, (now - satLerpT0) / SGP4_INTERVAL);
        if (satPosA.size > 0 && satPosB.size > 0) interpolateSatPositions(t01);
        if (currentMode === '3d') updateSatSprites3D();
        // 2D updates less frequently (every ~100ms) to avoid DOM thrashing
        if (currentMode === '2d' && leafletMap && (now - (lastSatVisualUpdate2D || 0)) > 100) {
            updateSatMarkers2D();
            lastSatVisualUpdate2D = now;
        }
        lastSatVisualUpdate = now;

        // Follow selected satellite with camera (only if user hasn't interacted)
        if (hasSatPosition(selectedSat) && currentMode === '3d' && !camAnim && _camFollowSat) {
            const { satPos, cameraPos } = getSatelliteCameraPose(selectedSat);
            camera.position.lerp(cameraPos, 0.05);
            controls.target.lerp(satPos, 0.08);
        }
    }

    updateCamAnim();

    if (currentMode === '3d' && renderer) {
        if (cloudsMesh) cloudsMesh.rotation.y += 0.00008;
        const sunDir = getSunDirection();
        if (earthMesh && earthMesh.material.uniforms) earthMesh.material.uniforms.sunDir.value.copy(sunDir);
        const sl = scene.getObjectByName('sunLight'); if(sl)sl.position.copy(sunDir.clone().multiplyScalar(10));
        controls.update();
        renderer.render(scene, camera);
    }
}

// ============================================================
//  BOOT
// ============================================================
window._selectSat = selectSatellite;
window._getSatEntries = () => satEntries;

// Expose for inline onclick handlers in dynamically generated HTML
window.chatFocusSat = chatFocusSat;
window.deleteChatMsg = deleteChatMsg;

async function boot() {
    await init3D();
    setupUI();
    animate();

    loadCountryBorders();
    populatePassRegions();
    await loadSatellites();
    updateSatPositions();
    updateFilterBadge();

    for (const s of satEntries) {
        if (s.lat != null) {
            satPosA.set(s.norad_id, { lat: s.lat, lon: s.lon, alt: s.alt, vel: s.vel });
            satPosB.set(s.norad_id, { lat: s.lat, lon: s.lon, alt: s.alt, vel: s.vel });
        }
    }
    satLerpT0 = performance.now();
    lastSatUpdate = performance.now();
    simLastReal = performance.now();
    await initSatSprites3D();
    updateSatSprites3D();
    // Hex grid built lazily on first coverage toggle (not at boot)

    // Try restore auth session
    await loadCurrentUser();

    // Handle URL hash params for email confirmation / password reset
    const hash = window.location.hash;
    if (hash.startsWith('#confirm=')) {
        const token = hash.substring('#confirm='.length);
        window.location.hash = '';
        document.getElementById('authModal').classList.add('visible');
        showAuthForm('confirm');
        document.getElementById('confirmResultText').textContent = 'Подтверждение email...';
        try {
            const res = await confirmEmail(token);
            if (res.ok) {
                document.getElementById('confirmResultText').innerHTML =
                    '<span style="color:var(--success)">✓ Email успешно подтверждён!</span><br><br>Теперь вы можете войти в систему.';
            } else {
                document.getElementById('confirmResultText').innerHTML =
                    '<span style="color:var(--danger)">✗ ' + (res.data.detail || 'Недействительный или просроченный токен') + '</span>';
            }
        } catch (e) {
            document.getElementById('confirmResultText').innerHTML =
                '<span style="color:var(--danger)">✗ Ошибка подтверждения</span>';
        }
    } else if (hash.startsWith('#reset=')) {
        const token = hash.substring('#reset='.length);
        window.location.hash = '';
        window._resetToken = token;
        document.getElementById('authModal').classList.add('visible');
        showAuthForm('reset');
    }

    setTimeout(() => document.getElementById('loadingScreen').classList.add('hidden'), 800);
}
boot();
