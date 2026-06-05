// ============================================================================
//  SOUND & UI
// ============================================================================

const synth = new Tone.PolySynth(Tone.Synth).toDestination();
synth.set({
    oscillator: { type: "square8" },
    envelope: { attack: 0.01, decay: 0.1, sustain: 0.2, release: 0.1 }
});

// Custom pistol sound (MP3)
let pistolSound = null;
function loadPistolSound() {
    pistolSound = new Audio('assets/sounds/pistol_fire.mp3');
    pistolSound.preload = 'auto';
}
loadPistolSound();

let emptyPistolSound = null;
function loadEmptyPistolSound() {
    emptyPistolSound = new Audio('assets/sounds/pistol_empty.mp3');
    emptyPistolSound.preload = 'auto';
}
loadEmptyPistolSound();

function playPistolSound() {
    if (!pistolSound) return;
    // Only play if Tone context is running (user already clicked)
    if (Tone.context.state !== 'running') return;
    pistolSound.currentTime = 0;
    pistolSound.play().catch(e => console.warn("Pistol sound play failed:", e));
}

function playSound(type) {
    try {
        if (Tone.context.state !== "running") return;
        if (type === 'jump') synth.triggerAttackRelease("D4", "16n", undefined, 0.3);
        else if (type === 'gem') synth.triggerAttackRelease("B5", "16n", undefined, 0.4);
        else if (type === 'spike') synth.triggerAttackRelease("F2", "8n", undefined, 0.5);
        else if (type === 'door') {
            synth.triggerAttackRelease("A4", "16n", undefined, 0.4);
            synth.triggerAttackRelease("E5", "16n", "+0.08", 0.4);
        }
    } catch (e) { console.warn(e); }
}

window.addEventListener('click', () => {
    if (Tone.context.state !== 'running') Tone.start();
});

function switchPanel(panelId) {
    ['panel-main', 'panel-play', 'panel-settings', 'panel-status'].forEach(id => {
        document.getElementById(id).classList.add('hidden');
    });
    document.getElementById(panelId).classList.remove('hidden');
}

// ============================================================================
//  GLOBALS & CONSTANTS
// ============================================================================

let itemManager = null;
let localPlayerItem = null;
let projectiles = [];
const THROWABLE_GRAVITY = 0.35;

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const BASE_WIDTH = 1280;
const BASE_HEIGHT = 720;
canvas.width = BASE_WIDTH;
canvas.height = BASE_HEIGHT;

const GRAVITY = 0.35;
const FRICTION = 0.85;
const MAX_FALL_SPEED = 10;
const MOVE_SPEED = 3;
const DASH_SPEED = 14;
const VOID_Y_THRESHOLD = 1000;
const BREAK_BOUNDS_OFFSET = 300; // <-- NEW

const PISTOL_PROJECTILE_SPEED = 36;
window.PISTOL_PROJECTILE_SPEED = PISTOL_PROJECTILE_SPEED;

let currentEngineMode = 'MENU';
let isHost = false;
let roomCodeString = "";
let timerVal = 60;
let gameTimer = null;

let lobbyCountdownVal = -1;
let lobbyTimerId = null;

let raceStarted = false;
let firstPlayerFinishTime = -1;
let raceCountdownVal = -1;
let raceTimerId = null;
let finishPositions = [];

let localPlayerId = "";
let players = {};
let readyPlayers = {};
const MAX_PLAYERS = 6;
const playerSlots = Array(MAX_PLAYERS).fill(null);

let throwables = [];
let lastThrowableSnapshot = null;
let wasDropPressed = false;

let platforms = [];
let hazards = [];
let gems = [];

let particles = [];
let bulletImage = new Image();
bulletImage.src = 'assets/items/pistol_bullet.svg';

let faceImageCache = {};
let lastTime = 0;

let camera = {
    x: 0, y: 0, zoom: 1.0, targetZoom: 1.0,
    minZoom: 1.0, maxZoom: 2.5
};

let skinDoor = { x: 220, y: 390, w: 70, h: 110, color: '#ff007f' };
let lobbyDoor = { x: 1150, y: 530, w: 70, h: 110, color: '#ffcc00' };
let finishLine = { x: 1150, y: 550, w: 70, h: 80, color: '#00ff66' };

const PLAYER_COLORS = [
    '#FF0000', '#0000FF', '#000000', '#ffffff', '#FF69B4', '#00FFFF',
    '#8B4513', '#FFC0CB', '#800080', '#FFA500', '#808080', '#63c363'
];

const keys = { ArrowLeft: false, ArrowRight: false, ArrowUp: false, ShiftLeft: false, Interact: false, Drop: false };
const touchState = { left: false, right: false, jump: false };

let mousePos = { x: 0, y: 0 };
window.addEventListener('mousemove', (e) => {
    mousePos.x = e.clientX;
    mousePos.y = e.clientY;
});

function getMouseWorldPos() {
    const rect = canvas.getBoundingClientRect();
    const canvasX = (mousePos.x - rect.left) * (canvas.width / rect.width);
    const canvasY = (mousePos.y - rect.top) * (canvas.height / rect.height);
    return {
        x: canvasX / camera.zoom + camera.x,
        y: canvasY / camera.zoom + camera.y
    };
}

function getNextAvailableColor() {
    for (let color of PLAYER_COLORS) {
        let taken = false;
        for (let id in players) if (players[id].color === color) { taken = true; break; }
        if (!taken) return color;
    }
    return PLAYER_COLORS[0];
}

function claimSlot(peerId) {
    for (let i = 0; i < MAX_PLAYERS; i++) if (playerSlots[i] === null) { playerSlots[i] = peerId; return `P${i + 1}`; }
    return "P?";
}
function releaseSlot(peerId) {
    const idx = playerSlots.indexOf(peerId);
    if (idx !== -1) playerSlots[idx] = null;
}

// ============================================================================
//  ENVIRONMENT SETUP
// ============================================================================

function setupLobbyEnvironment() {
    const map = MAPS.lobby;
    platforms = map.platforms;
    hazards = map.hazards;
    gems = map.gems;
    if (map.doors) {
        if (map.doors.skinDoor) Object.assign(skinDoor, map.doors.skinDoor);
        if (map.doors.lobbyDoor) Object.assign(lobbyDoor, map.doors.lobbyDoor);
    }
}

function setupActiveMatchEnvironment() {
    const map = MAPS.match;
    platforms = map.platforms;
    hazards = map.hazards;
    gems = map.gems.map(g => ({ ...g, collected: false }));
    if (map.finishLine) Object.assign(finishLine, map.finishLine);
}

// ------------------------------------------------------------------
// HOST LOBBY RESET FUNCTION (with version)
// ------------------------------------------------------------------
function hostResetLobby() {
    if (!isHost || currentEngineMode !== 'LOBBY') return;

    projectiles = [];
    throwables = [];
    lastThrowableSnapshot = null;
    lastProjectileSnapshot = null;

    if (itemManager) {
        itemManager.worldItems = [];
        itemManager.spawnItem(300, 580, 'pistol', 0, true, 3);
    }

    setupLobbyEnvironment();

    if (lobbyTimerId) {
        clearInterval(lobbyTimerId);
        lobbyTimerId = null;
    }
    if (raceTimerId) {
        clearInterval(raceTimerId);
        raceTimerId = null;
    }
    lobbyCountdownVal = -1;
    raceCountdownVal = -1;
    raceStarted = false;
    firstPlayerFinishTime = -1;
    finishPositions = [];

    let idx = 0;
    for (let id in players) {
        const p = players[id];
        p.x = 100 + idx * 45;
        p.y = 500;
        p.vx = 0;
        p.vy = 0;
        p.isGrounded = true;
        p.jumpsLeft = 2;
        p.dashCooldown = 0;
        p.dashTimer = 0;
        p.isDashing = false;
        p.dashPushedBy = null;
        p.score = 0;
        p.item = null;
        p.itemType = null;
        p.ammo = 0;
        p.finished = false;
        p.finishTime = -1;
        p.handAngle = p.facingRight ? 0 : Math.PI;
        p.eliminated = false;
        idx++;
    }

    readyPlayers = {};
    localPlayerItem = null;
    resetVersion++;
    broadcastToRoom('sync_players', { allPlayers: players, reset: true });
    broadcastToRoom('sync_ready_players', { readyPlayers });
    broadcastToRoom('sync_map', { platforms, hazards, gems });
    broadcastWorldItems();
    broadcastToRoom('sync_throwables', { throwables });
    broadcastProjectiles();
    broadcastToRoom('sync_lobby_countdown', { value: -1 });

    playSound('door');
    updateHudDisplays();
}

// ------------------------------------------------------------------
// Show/hide reset button based on host and engine mode
// ------------------------------------------------------------------
function updateResetButtonVisibility() {
    const resetBtn = document.getElementById('reset-lobby-btn');
    if (!resetBtn) return;
    if (isHost && currentEngineMode === 'LOBBY') {
        resetBtn.classList.remove('hidden');
    } else {
        resetBtn.classList.add('hidden');
    }
}

const originalEnterLobbyState = enterLobbyState;
enterLobbyState = function () {
    originalEnterLobbyState();
    updateResetButtonVisibility();
};

const originalExecuteMatchStart = executeActiveMatchStart;
executeActiveMatchStart = function () {
    originalExecuteMatchStart();
    updateResetButtonVisibility();
};

const originalExecuteLobbyReturn = executeLobbyReturnSequence;
executeLobbyReturnSequence = function () {
    originalExecuteLobbyReturn();
    updateResetButtonVisibility();
};

document.addEventListener('DOMContentLoaded', () => {
    const resetBtn = document.getElementById('reset-lobby-btn');
    if (resetBtn) {
        resetBtn.addEventListener('click', hostResetLobby);
    }
});

// ============================================================================
//  PLAYER PROFILE & DIMENSIONS
// ============================================================================

const CHARACTER_BASE_WIDTH = 21;
const CHARACTER_BASE_HEIGHT = 70;
let characterSizeMultiplier = 1.0;

function updatePlayerDimensions(player, multiplier) {
    const oldCenterX = player.x + player.width / 2;
    player.width = CHARACTER_BASE_WIDTH * multiplier;
    player.height = CHARACTER_BASE_HEIGHT * multiplier;
    player.x = oldCenterX - player.width / 2;
    if (player.x + player.width > 1260) player.x = 1260 - player.width;
    if (player.x < 20) player.x = 20;
}

function createPlayerProfile(id, nameTag) {
    return {
        id: id, nameTag: nameTag,
        x: 640, y: 530, vx: 0, vy: 0,
        width: CHARACTER_BASE_WIDTH, height: CHARACTER_BASE_HEIGHT,
        color: getNextAvailableColor(),
        isGrounded: false, facingRight: true,
        score: 0, jumpsLeft: 2,
        wasJumpPressed: false,
        dashCooldown: 0, dashTimer: 0, isDashing: false, wasDashPressed: false,
        dashPushedBy: null,
        lastSeen: Date.now(),
        sizeMultiplier: 1,
        itemType: null, item: null,
        ammo: 0,
        eliminated: false
    };
}

// ============================================================================
//  VOID DEATH HANDLING
// ============================================================================

function voidRespawnLobby(player) {
    player.x = 100;
    player.y = 500;
    player.vx = 0;
    player.vy = 0;
    player.isGrounded = true;
    player.jumpsLeft = 2;
    player.dashCooldown = 0;
    player.dashTimer = 0;
    player.isDashing = false;
    player.dashPushedBy = null;
    playSound('spike');
}

function voidEliminateGame(player) {
    if (player.eliminated) return;
    player.eliminated = true;
    player.item = null;
    player.itemType = null;
    player.ammo = 0;
    playSound('spike');
}

function checkVoidDeath() {
    if (currentEngineMode !== 'LOBBY' && currentEngineMode !== 'GAME') return;
    const isGame = (currentEngineMode === 'GAME');
    for (let id in players) {
        const p = players[id];
        if (p.eliminated) continue;
        if (p.y > VOID_Y_THRESHOLD) {
            if (!isGame) voidRespawnLobby(p);
            else voidEliminateGame(p);
        }
    }
}

// ============================================================================
//  ITEM & THROWABLE HELPERS
// ============================================================================

function createThrowable(itemType, x, y, vx, vy, ownerId, dropItem = false, ammo = 3) {
    return {
        id: Math.random() + Date.now(),
        itemType, x, y, vx, vy,
        radius: 12, life: 150,
        ownerId, angle: 0,
        angularSpeed: (vx * 0.025) + ((Math.random() - 0.5) * 0.04),
        dropItem, ammo
    };
}

function broadcastThrowables() {
    if (!isHost) return;
    const snap = JSON.stringify(throwables);
    if (snap === lastThrowableSnapshot) return;
    lastThrowableSnapshot = snap;
    broadcastToRoom('sync_throwables', { throwables });
}

// ============================================================================
//  BREAK PARTICLES (empty pistol drop)
// ============================================================================

function spawnBreakParticles(x, y) {
    for (let i = 0; i < 20; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = 2 + Math.random() * 3;
        pushParticle({
            type: 'spark',
            x, y,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed - 2,
            life: 0.5 + Math.random() * 0.3,
            age: 0,
            size: Math.random() * 5 + 4,
            radius: 3,
            bounce: 0.1,
            friction: 0.95,
            onGround: false,
            color: '#ff6600',
            alpha: 1
        });
    }
    playSound('spike');
}

// ============================================================================
//  DROP & THROW (HOST)
// ============================================================================

function hostDropItem(playerId) {
    const player = players[playerId];
    if (!player || !player.item) return;
    const itemType = player.itemType;
    if (!itemType) return;
    const ammo = player.item.ammo;

    if (ammo === 0) {
        spawnBreakParticles(player.x + player.width / 2, player.y + player.height / 2);
        player.item = null;
        player.itemType = null;
        player.ammo = 0;
        if (playerId === localPlayerId) localPlayerItem = null;
        broadcastToRoom('sync_players', { allPlayers: players });
        playSound('gem');
        return;
    }

    const handX = player.x + player.width * 0.5;
    const handY = player.y + 32;
    const dirX = player.facingRight ? 1 : -1;
    const throwable = createThrowable(itemType, handX, handY, dirX * 2, -3, playerId, true, ammo);
    throwables.push(throwable);
    broadcastThrowables();

    player.item = null;
    player.itemType = null;
    player.ammo = 0;
    if (playerId === localPlayerId) localPlayerItem = null;
    broadcastToRoom('sync_players', { allPlayers: players });
    playSound('gem');
}

function hostThrowItem(playerId, angle, power = 14) {
    const player = players[playerId];
    if (!player || !player.item) return;
    const itemType = player.itemType;
    if (!itemType) return;
    const ammo = player.item.ammo;

    const handX = player.x + player.width * 0.5;
    const handY = player.y + 32;
    const dirX = Math.cos(angle);
    const dirY = Math.sin(angle);
    const spawnX = handX + dirX * 20;
    const spawnY = handY + dirY * 20;
    const vx = dirX * power;
    const vy = dirY * power;

    const throwable = createThrowable(itemType, spawnX, spawnY, vx, vy, playerId, false, ammo);
    throwables.push(throwable);
    broadcastThrowables();

    player.item = null;
    player.itemType = null;
    player.ammo = 0;
    if (playerId === localPlayerId) localPlayerItem = null;
    broadcastToRoom('sync_players', { allPlayers: players });
    playSound('door');
}

// ============================================================================
//  NETWORKING – PEERJS
// ============================================================================

let peer = null;
let clientConnections = [];
let hostConnection = null;
const HEARTBEAT_TIMEOUT = 5000;
let hostWatchdogTimer = null;
let resetVersion = 0;
let clientResetVersion = 0;

function initHost() {
    switchPanel('panel-status');
    roomCodeString = Math.floor(1000 + Math.random() * 9000).toString();
    peer = new Peer(`uhcc-${roomCodeString}`);

    peer.on('open', () => {
        document.getElementById('status-spinner').classList.add('hidden');
        document.getElementById('room-code-display').classList.remove('hidden');
        document.getElementById('room-code').innerText = roomCodeString;
        document.getElementById('hud-room').innerText = roomCodeString;
        if (navigator.clipboard) navigator.clipboard.writeText(roomCodeString).catch(() => { });

        isHost = true;
        localPlayerId = "HOST";
        players[localPlayerId] = createPlayerProfile(localPlayerId, claimSlot(localPlayerId));

        itemManager = new ItemManager();
        itemManager.spawnItem(300, 580, 'pistol', 0, true, 3);

        enterLobbyState();
        updateResetButtonVisibility();
        startHostWatchdog();
    });

    peer.on('connection', (conn) => {
        if (Object.keys(players).length >= 6) {
            conn.on('open', () => { conn.send({ type: 'room_full' }); setTimeout(() => conn.close(), 500); });
            return;
        }
        clientConnections.push(conn);
        setupHostRoutingRules(conn);
    });
}

function startHostWatchdog() {
    if (hostWatchdogTimer) clearInterval(hostWatchdogTimer);
    hostWatchdogTimer = setInterval(() => {
        if (!isHost) return;
        const now = Date.now();
        for (let id in players) {
            if (id === localPlayerId) continue;
            if (now - players[id].lastSeen > HEARTBEAT_TIMEOUT) {
                cleanupPlayer(id);
            }
        }
    }, 2000);
}

function cleanupPlayer(peerId) {
    if (players[peerId]) {
        releaseSlot(peerId);
        delete players[peerId];
        updateHudDisplays();
        broadcastToRoom('sync_players', { allPlayers: players });
    }
}

function setupHostRoutingRules(conn) {
    conn.on('open', () => {
        const newId = conn.peer;
        players[newId] = createPlayerProfile(newId, claimSlot(newId));
        updateHudDisplays();

        const safePlayers = {};
        for (let id in players) {
            safePlayers[id] = { ...players[id] };
            delete safePlayers[id].item;
            safePlayers[id].eliminated = players[id].eliminated;
        }
        conn.send({
            type: 'init_welcome',
            payload: { assignedId: newId, allPlayers: safePlayers, mode: currentEngineMode, readyPlayers, resetVersion }
        });

        broadcastToRoom('sync_map', { platforms, hazards, gems });
        broadcastToRoom('sync_players', { allPlayers: players });
        broadcastToRoom('sync_ready_players', { readyPlayers });

        if (itemManager) {
            const itemsData = itemManager.worldItems.map(item => ({
                x: item.x, y: item.y, itemType: item.itemType,
                isAvailable: item.isAvailable, respawnTimer: item.respawnTimer,
                pickupDelayTimer: item.pickupDelayTimer, shouldRespawn: item.shouldRespawn,
                ammo: item.ammo
            }));
            conn.send({ type: 'sync_world_items', payload: { items: itemsData } });
        }

        for (let id in players) {
            if (id !== newId) {
                const face = localStorage.getItem('playerFaceDrawing_' + id);
                if (face) conn.send({ type: 'sync_face_drawing', payload: { playerId: id, faceData: face } });
            }
        }
    });

    conn.on('data', (pkg) => {
        const sender = conn.peer;
        switch (pkg.type) {
            case 'heartbeat':
                if (players[sender]) players[sender].lastSeen = Date.now();
                break;
            case 'client_input_update':
                if (players[pkg.senderId]) {
                    if (pkg.payload.resetVersion !== undefined && pkg.payload.resetVersion !== resetVersion) break;
                    const pl = players[pkg.senderId];
                    pl.x = pkg.payload.x; pl.y = pkg.payload.y;
                    pl.vx = pkg.payload.vx; pl.vy = pkg.payload.vy;
                    pl.isGrounded = pkg.payload.isGrounded;
                    pl.facingRight = pkg.payload.facingRight;
                    pl.isDashing = pkg.payload.isDashing;
                    pl.handAngle = pkg.payload.handAngle;
                    pl.lastSeen = Date.now();
                }
                broadcastToRoom('sync_players', { allPlayers: players });
                break;
            case 'update_skin':
                if (players[pkg.senderId]) players[pkg.senderId].color = pkg.payload.color;
                broadcastToRoom('sync_players', { allPlayers: players });
                if (!document.getElementById('skin-modal').classList.contains('hidden')) updateColorButtonStates();
                break;
            case 'request_collect_gem':
                processGemCapture(pkg.payload.gemId, pkg.senderId);
                break;
            case 'player_ready_toggle':
                if (pkg.payload.isReady) readyPlayers[pkg.senderId] = true;
                else delete readyPlayers[pkg.senderId];
                broadcastToRoom('sync_ready_players', { readyPlayers });
                break;
            case 'update_face_drawing':
                localStorage.setItem('playerFaceDrawing_' + pkg.senderId, pkg.payload.faceData);
                localStorage.setItem('playerHasCustomFace_' + pkg.senderId, 'true');
                broadcastToRoom('sync_face_drawing', { playerId: pkg.senderId, faceData: pkg.payload.faceData });
                break;
            case 'request_pickup_item':
                if (players[pkg.senderId] && itemManager) {
                    const picked = itemManager.checkPickup(players[pkg.senderId]);
                    if (picked) {
                        players[pkg.senderId].item = picked;
                        players[pkg.senderId].itemType = 'pistol';
                        players[pkg.senderId].ammo = picked.ammo;
                        broadcastToRoom('sync_players', { allPlayers: players });
                        broadcastWorldItems();
                    }
                }
                break;
            case 'client_shoot':
                if (players[pkg.senderId] && pkg.payload.handAngle !== undefined) {
                    const player = players[pkg.senderId];
                    if (pkg.payload.ammo !== undefined) {
                        if (player.item) player.item.ammo = pkg.payload.ammo;
                        player.ammo = pkg.payload.ammo;
                    }
                    const handX = player.x + player.width / 2;
                    const handY = player.y + 32;
                    const angle = pkg.payload.handAngle;
                    const dirX = Math.cos(angle);
                    const dirY = Math.sin(angle);
                    const spawnX = handX + dirX * 20;
                    const spawnY = handY + dirY * 20;
                    const projectile = {
                        x: spawnX, y: spawnY,
                        vx: dirX * PISTOL_PROJECTILE_SPEED,
                        vy: dirY * PISTOL_PROJECTILE_SPEED,
                        radius: 6, life: 120,
                        ownerId: pkg.senderId,
                        type: 'pistol_ammo',
                        knockback: 15
                    };
                    projectiles.push(projectile);
                    broadcastProjectiles();
                    playSound('door');
                    broadcastToRoom('sync_players', { allPlayers: players });
                }
                break;
            case 'request_drop_item':
                if (players[pkg.senderId]) hostDropItem(pkg.senderId);
                break;
            case 'request_throw_item':
                if (players[pkg.senderId] && players[pkg.senderId].item)
                    hostThrowItem(pkg.senderId, pkg.payload.angle);
                break;
        }
    });

    conn.on('close', () => {
        releaseSlot(conn.peer);
        clientConnections = clientConnections.filter(c => c !== conn);
        delete players[conn.peer];
        delete readyPlayers[conn.peer];
        updateHudDisplays();
        broadcastToRoom('sync_players', { allPlayers: players });
    });
}

function initGuest() {
    const code = document.getElementById('room-input').value.trim();
    if (!/^[0-9]{4}$/.test(code)) return;
    switchPanel('panel-status');
    roomCodeString = code;
    peer = new Peer();
    peer.on('open', (id) => {
        localPlayerId = id;
        hostConnection = peer.connect(`uhcc-${roomCodeString}`);
        itemManager = new ItemManager();
        setupClientRoutingRules(hostConnection);
    });
    peer.on('error', () => { alert("Room code not found"); cancelConnection(); });
}

function setupClientRoutingRules(conn) {
    conn.on('data', (pkg) => {
        switch (pkg.type) {
            case 'room_full': alert("Room is full (max 6 players)!"); cancelConnection(); break;
            case 'init_welcome':
                localPlayerId = pkg.payload.assignedId;
                players = pkg.payload.allPlayers;
                currentEngineMode = pkg.payload.mode;
                clientResetVersion = pkg.payload.resetVersion || 0;
                document.getElementById('hud-room').innerText = roomCodeString;
                enterLobbyState();
                readyPlayers = pkg.payload.readyPlayers || {};
                startClientHeartbeat(conn);

                for (let id in players) {
                    if (players[id].itemType === 'pistol') {
                        if (!players[id].item || players[id].item.constructor !== pistolItem) {
                            players[id].item = new pistolItem(players[id].ammo);
                        } else {
                            players[id].item.ammo = players[id].ammo;
                        }
                    } else {
                        players[id].item = null;
                    }
                }
                if (players[localPlayerId] && players[localPlayerId].item) localPlayerItem = players[localPlayerId].item;
                else localPlayerItem = null;
                break;
            case 'sync_players':
                const isReset = pkg.payload.reset === true;
                const newVersion = pkg.payload.resetVersion;
                if (newVersion !== undefined && newVersion !== clientResetVersion) {
                    clientResetVersion = newVersion;
                }
                for (let id in pkg.payload.allPlayers) {
                    const data = pkg.payload.allPlayers[id];
                    if (id !== localPlayerId) {
                        if (!players[id]) players[id] = data;
                        else {
                            players[id].x = data.x; players[id].y = data.y;
                            players[id].vx = data.vx; players[id].vy = data.vy;
                            players[id].isGrounded = data.isGrounded;
                            players[id].facingRight = data.facingRight;
                            players[id].score = data.score;
                            players[id].isDashing = data.isDashing;
                            players[id].handAngle = data.handAngle;
                            players[id].color = data.color;
                            players[id].finished = data.finished;
                            players[id].finishTime = data.finishTime;
                            players[id].itemType = data.itemType;
                            players[id].ammo = data.ammo;
                            players[id].eliminated = data.eliminated || false;
                        }
                    }
                }

                if (pkg.payload.allPlayers[localPlayerId]) {
                    const local = pkg.payload.allPlayers[localPlayerId];
                    if (isReset) {
                        players[localPlayerId].x = local.x;
                        players[localPlayerId].y = local.y;
                        players[localPlayerId].vx = local.vx;
                        players[localPlayerId].vy = local.vy;
                        players[localPlayerId].isGrounded = local.isGrounded;
                        players[localPlayerId].facingRight = local.facingRight;
                        players[localPlayerId].isDashing = local.isDashing;
                        players[localPlayerId].handAngle = local.handAngle;
                        players[localPlayerId].itemType = local.itemType;
                        players[localPlayerId].ammo = local.ammo;
                        players[localPlayerId].finished = local.finished;
                        players[localPlayerId].finishTime = local.finishTime;
                        players[localPlayerId].eliminated = local.eliminated || false;

                        keys.ArrowLeft = false;
                        keys.ArrowRight = false;
                        keys.ArrowUp = false;

                        camera.x = local.x - BASE_WIDTH / 2;
                        camera.y = local.y - BASE_HEIGHT / 2;

                        players[localPlayerId].item = null;
                        localPlayerItem = null;

                        if (hostConnection && hostConnection.open) {
                            hostConnection.send({
                                type: 'client_input_update',
                                senderId: localPlayerId,
                                payload: {
                                    x: players[localPlayerId].x,
                                    y: players[localPlayerId].y,
                                    vx: players[localPlayerId].vx,
                                    vy: players[localPlayerId].vy,
                                    isGrounded: players[localPlayerId].isGrounded,
                                    facingRight: players[localPlayerId].facingRight,
                                    isDashing: players[localPlayerId].isDashing,
                                    handAngle: players[localPlayerId].handAngle,
                                    resetVersion: clientResetVersion
                                }
                            });
                        }
                    }
                    players[localPlayerId].score = local.score;
                    players[localPlayerId].color = local.color;
                    players[localPlayerId].itemType = local.itemType;
                    players[localPlayerId].finished = local.finished;
                    players[localPlayerId].finishTime = local.finishTime;
                    players[localPlayerId].ammo = local.ammo;
                    players[localPlayerId].eliminated = local.eliminated || false;
                }
                for (let id in players) {
                    if (players[id].itemType === 'pistol') {
                        if (!players[id].item || players[id].item.constructor !== pistolItem) {
                            players[id].item = new pistolItem(players[id].ammo);
                        } else {
                            players[id].item.ammo = players[id].ammo;
                        }
                        const data = pkg.payload.allPlayers[id];
                        if (data && data.itemCooldown !== undefined) {
                            players[id].item.cooldown = data.itemCooldown;
                        }
                    } else {
                        players[id].item = null;
                    }
                }
                if (players[localPlayerId] && players[localPlayerId].item) localPlayerItem = players[localPlayerId].item;
                else localPlayerItem = null;
                updateHudDisplays();
                updateColorButtonStates();
                break;
            case 'sync_throwables': throwables = pkg.payload.throwables; break;
            case 'sync_map': platforms = pkg.payload.platforms; hazards = pkg.payload.hazards; gems = pkg.payload.gems; break;
            case 'sync_lobby_countdown': lobbyCountdownVal = pkg.payload.value; break;
            case 'sync_ready_players': readyPlayers = pkg.payload.readyPlayers; break;
            case 'sync_face_drawing':
                localStorage.setItem('playerFaceDrawing_' + pkg.payload.playerId, pkg.payload.faceData);
                localStorage.setItem('playerHasCustomFace_' + pkg.payload.playerId, 'true');
                break;
            case 'trigger_match_start': executeActiveMatchStart(); break;
            case 'sync_timer': timerVal = pkg.payload.time; document.getElementById('timer').innerText = timerVal; break;
            case 'match_over': executeMatchEndingSequence(pkg.payload.summary); break;
            case 'return_to_lobby': executeLobbyReturnSequence(); break;
            case 'sync_race_start': raceCountdownVal = pkg.payload.raceCountdownVal; firstPlayerFinishTime = Date.now(); break;
            case 'sync_race_countdown': raceCountdownVal = pkg.payload.value; break;
            case 'sync_world_items': if (itemManager) itemManager.syncFromData(pkg.payload.items); break;
            case 'sync_projectiles': projectiles = pkg.payload.projectiles; break;
        }
    });
    conn.on('close', () => document.getElementById('disconnect-modal').classList.remove('hidden'));
}

let clientHeartbeatTimer = null;
function startClientHeartbeat(conn) {
    if (clientHeartbeatTimer) clearInterval(clientHeartbeatTimer);
    clientHeartbeatTimer = setInterval(() => {
        if (!isHost && conn && conn.open) conn.send({ type: 'heartbeat' });
    }, 1000);
}

function broadcastToRoom(type, payload) {
    if (!isHost) return;
    let msgPayload = payload;
    if (type === 'sync_players' && payload.allPlayers) {
        const safe = {};
        for (let id in payload.allPlayers) {
            safe[id] = { ...payload.allPlayers[id] };
            delete safe[id].item;
            if (payload.allPlayers[id].item && payload.allPlayers[id].item.cooldown !== undefined) {
                safe[id].itemCooldown = payload.allPlayers[id].item.cooldown;
            }
            safe[id].eliminated = payload.allPlayers[id].eliminated;
        }
        msgPayload = { allPlayers: safe, resetVersion: resetVersion };
        if (payload.reset === true) msgPayload.reset = true;
    }
    const msg = { type, payload: msgPayload };
    clientConnections.forEach(conn => { if (conn.open) conn.send(msg); });
}

let lastProjectileSnapshot = null;
function broadcastProjectiles() {
    if (!isHost) return;
    const snap = JSON.stringify(projectiles);
    if (snap === lastProjectileSnapshot) return;
    lastProjectileSnapshot = snap;
    broadcastToRoom('sync_projectiles', { projectiles });
}

function broadcastWorldItems() {
    if (!isHost) return;
    const itemsData = itemManager.worldItems.map(item => ({
        x: item.x, y: item.y, itemType: item.itemType,
        isAvailable: item.isAvailable, respawnTimer: item.respawnTimer,
        pickupDelayTimer: item.pickupDelayTimer, shouldRespawn: item.shouldRespawn,
        ammo: item.ammo
    }));
    broadcastToRoom('sync_world_items', { items: itemsData });
}

function cancelConnection() {
    if (hostConnection) hostConnection.close();
    clientConnections.forEach(c => c.close());
    if (peer) peer.destroy();
    location.reload();
}
function disconnectGame() { cancelConnection(); }

// ============================================================================
//  GAME STATE & LOBBY
// ============================================================================

function updateHudDisplays() {
    const count = Object.keys(players).length;
    document.getElementById('player-count-hud').innerText = `${count} / 6`;
    let stateLabel = "LOBBY";
    if (currentEngineMode === 'MENU') stateLabel = "UHCC";
    if (currentEngineMode === 'GAME') stateLabel = "MATCH IN PROGRESS";
    document.getElementById('game-state-hud').innerText = stateLabel;
}

function enterLobbyState() {
    currentEngineMode = 'LOBBY';
    lobbyCountdownVal = -1;
    readyPlayers = {};
    raceStarted = false;
    firstPlayerFinishTime = -1;
    raceCountdownVal = -1;
    finishPositions = [];
    if (lobbyTimerId) clearInterval(lobbyTimerId);
    document.getElementById('menu-screen').classList.add('hidden');
    setupLobbyEnvironment();
    updateHudDisplays();
}

function evaluateLobbyDoorTrigger() {
    if (!isHost || currentEngineMode !== 'LOBBY') return;
    const total = Object.keys(players).length;
    const ready = Object.keys(readyPlayers).length;
    if (total >= 2 && ready > total / 2) {
        if (lobbyCountdownVal === -1) {
            lobbyCountdownVal = 10;
            playSound('door');
            broadcastToRoom('sync_lobby_countdown', { value: lobbyCountdownVal });
            if (lobbyTimerId) clearInterval(lobbyTimerId);
            lobbyTimerId = setInterval(() => {
                if (currentEngineMode !== 'LOBBY') {
                    clearInterval(lobbyTimerId); lobbyTimerId = null;
                    lobbyCountdownVal = -1;
                    return;
                }
                let newTotal = Object.keys(players).length;
                let newReady = Object.keys(readyPlayers).length;
                if (newTotal >= 2 && newReady > newTotal / 2) {
                    lobbyCountdownVal--;
                    broadcastToRoom('sync_lobby_countdown', { value: lobbyCountdownVal });
                    if (lobbyCountdownVal <= 0) {
                        clearInterval(lobbyTimerId); lobbyTimerId = null;
                        lobbyCountdownVal = -1;
                        broadcastToRoom('sync_lobby_countdown', { value: lobbyCountdownVal });
                        broadcastToRoom('trigger_match_start');
                        executeActiveMatchStart();
                    }
                } else {
                    clearInterval(lobbyTimerId); lobbyTimerId = null;
                    lobbyCountdownVal = -1;
                    broadcastToRoom('sync_lobby_countdown', { value: lobbyCountdownVal });
                }
            }, 1000);
        }
    } else {
        if (lobbyCountdownVal !== -1) {
            if (lobbyTimerId) clearInterval(lobbyTimerId);
            lobbyTimerId = null;
            lobbyCountdownVal = -1;
            broadcastToRoom('sync_lobby_countdown', { value: lobbyCountdownVal });
        }
    }
}

function executeActiveMatchStart() {
    currentEngineMode = 'GAME';
    readyPlayers = {};
    setupActiveMatchEnvironment();
    updateHudDisplays();
    raceStarted = true;
    firstPlayerFinishTime = -1;
    raceCountdownVal = -1;
    finishPositions = [];
    let idx = 0;
    for (let id in players) {
        players[id].x = 100 + idx * 50;
        players[id].y = 400;
        players[id].vx = players[id].vy = 0;
        players[id].finished = false;
        players[id].finishTime = -1;
        players[id].eliminated = false;
        idx++;
    }
    if (isHost) {
        timerVal = 60;
        if (gameTimer) clearInterval(gameTimer);
        gameTimer = setInterval(() => {
            timerVal--;
            broadcastToRoom('sync_timer', { time: timerVal });
            document.getElementById('timer').innerText = timerVal;
            if (timerVal <= 0) {
                clearInterval(gameTimer);
                if (raceCountdownVal !== -1) {
                    if (raceTimerId) clearInterval(raceTimerId);
                    raceTimerId = null;
                    let results = [];
                    for (let id in players) results.push({ id, nameTag: players[id].nameTag, score: players[id].score });
                    broadcastToRoom('match_over', { summary: results });
                    executeMatchEndingSequence(results);
                }
            }
        }, 1000);
    }
}

function checkAndProcessRaceFinish() {
    if (!isHost || currentEngineMode !== 'GAME' || !raceStarted) return;
    for (let id in players) {
        const pl = players[id];
        if (pl.eliminated || pl.finished) continue;
        if (!checkCollision(pl, finishLine)) continue;
        pl.finished = true;
        pl.finishTime = Date.now();
        finishPositions.push(id);
        if (firstPlayerFinishTime === -1) {
            firstPlayerFinishTime = Date.now();
            raceCountdownVal = 30;
            playSound('door');
            broadcastToRoom('sync_race_start', { raceCountdownVal });
            if (raceTimerId) clearInterval(raceTimerId);
            raceTimerId = setInterval(() => {
                raceCountdownVal--;
                broadcastToRoom('sync_race_countdown', { value: raceCountdownVal });
                if (raceCountdownVal <= 0) {
                    clearInterval(raceTimerId);
                    raceTimerId = null;
                    let points = [3, 2, 1];
                    for (let i = 0; i < Math.min(finishPositions.length, 3); i++)
                        if (players[finishPositions[i]]) players[finishPositions[i]].score += points[i];
                    if (gameTimer) clearInterval(gameTimer);
                    gameTimer = null;
                    let results = [];
                    for (let id in players) results.push({ id, nameTag: players[id].nameTag, score: players[id].score, position: finishPositions.indexOf(id) + 1 || -1 });
                    broadcastToRoom('match_over', { summary: results });
                    executeMatchEndingSequence(results);
                }
            }, 1000);
        }
    }
}

function executeMatchEndingSequence(summary) {
    const overlay = document.getElementById('gameover-overlay');
    const resText = document.getElementById('match-result');
    overlay.classList.remove('hidden');
    summary.sort((a, b) => b.score - a.score);
    let resultText = "🏁 MATCH OVER\n";
    resultText += summary.slice(0, 3).map((s, i) => `${['🥇', '🥈', '🥉'][i]} ${s.nameTag}: ${s.score} pts`).join('\n');
    resText.innerText = resultText;
    if (isHost) setTimeout(() => backToInteractiveLobby(), 5000);
}

function backToInteractiveLobby() {
    if (!isHost) return;
    broadcastToRoom('return_to_lobby');
    executeLobbyReturnSequence();
}

function executeLobbyReturnSequence() {
    document.getElementById('gameover-overlay').classList.add('hidden');
    enterLobbyState();
    let idx = 0;
    for (let id in players) {
        players[id].x = 100 + idx * 45;
        players[id].y = 500;
        players[id].vx = players[id].vy = 0;
        players[id].eliminated = false;
        idx++;
    }
    updateResetButtonVisibility();
}

// ============================================================================
//  PHYSICS & COLLISIONS
// ============================================================================

function checkCollision(r1, r2) {
    return r1.x < r2.x + r2.w && r1.x + r1.width > r2.x &&
        r1.y < r2.y + r2.h && r1.y + r1.height > r2.y;
}

function checkCircleCollision(player, gem) {
    const cx = player.x + player.width / 2, cy = player.y + player.height / 2;
    return Math.hypot(cx - gem.x, cy - gem.y) < (player.width / 2 + 15);
}

function resolvePlayerCollisions() {
    const ids = Object.keys(players);
    for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
            let p1 = players[ids[i]], p2 = players[ids[j]];
            if (p1.eliminated || p2.eliminated) continue;
            if (p1.x < p2.x + p2.width && p1.x + p1.width > p2.x &&
                p1.y < p2.y + p2.height && p1.y + p1.height > p2.y) {

                const overlapLeft = p1.x + p1.width - p2.x;
                const overlapRight = p2.x + p2.width - p1.x;
                const overlapTop = p1.y + p1.height - p2.y;
                const overlapBottom = p2.y + p2.height - p1.y;
                const minOverlap = Math.min(overlapLeft, overlapRight, overlapTop, overlapBottom);

                const DASH_PUSH = 6;
                const MAX_VICTIM_SPEED = 12;

                if (p1.isDashing && !p2.isDashing && p2.dashPushedBy !== p1.id) {
                    const dir = (p1.x + p1.width / 2) > (p2.x + p2.width / 2) ? 1 : -1;
                    p2.vx += dir * DASH_PUSH;
                    p2.vx = Math.min(MAX_VICTIM_SPEED, Math.max(-MAX_VICTIM_SPEED, p2.vx));
                    p2.dashPushedBy = p1.id;
                } else if (p2.isDashing && !p1.isDashing && p1.dashPushedBy !== p2.id) {
                    const dir = (p2.x + p2.width / 2) > (p1.x + p1.width / 2) ? 1 : -1;
                    p1.vx += dir * DASH_PUSH;
                    p1.vx = Math.min(MAX_VICTIM_SPEED, Math.max(-MAX_VICTIM_SPEED, p1.vx));
                    p1.dashPushedBy = p2.id;
                } else if (p1.isDashing && p2.isDashing && p1.dashPushedBy !== p2.id && p2.dashPushedBy !== p1.id) {
                    const dir = (p1.x + p1.width / 2) > (p2.x + p2.width / 2) ? 1 : -1;
                    p1.vx -= dir * DASH_PUSH * 0.7;
                    p2.vx += dir * DASH_PUSH * 0.7;
                    p1.vx = Math.min(MAX_VICTIM_SPEED, Math.max(-MAX_VICTIM_SPEED, p1.vx));
                    p2.vx = Math.min(MAX_VICTIM_SPEED, Math.max(-MAX_VICTIM_SPEED, p2.vx));
                    p1.dashPushedBy = p2.id;
                    p2.dashPushedBy = p1.id;
                }

                if (minOverlap === overlapLeft || minOverlap === overlapRight) {
                    const sep = Math.min(minOverlap, 5);
                    if (minOverlap === overlapLeft) { p1.x -= sep; p2.x += sep; }
                    else { p1.x += sep; p2.x -= sep; }
                } else {
                    const sep = Math.min(minOverlap, 5);
                    if (minOverlap === overlapTop) { p1.y -= sep; p2.y += sep; }
                    else { p1.y += sep; p2.y -= sep; }
                    if (p1.vy > 0 && p2.vy < 0) { p1.vy = 0; p2.vy = 0; }
                }

                const MAX_PUSH = 18;
                p1.vx = Math.min(MAX_PUSH, Math.max(-MAX_PUSH, p1.vx));
                p2.vx = Math.min(MAX_PUSH, Math.max(-MAX_PUSH, p2.vx));
            }
        }
    }
}

function updateCharacterPhysics(player, dt) {
    if (player.eliminated) return;
    if (player.dashCooldown > 0) player.dashCooldown -= dt;
    let left = keys.ArrowLeft || touchState.left;
    let right = keys.ArrowRight || touchState.right;
    let jump = keys.ArrowUp || touchState.jump;
    let shift = keys.ShiftLeft;
    let dashJustPressed = shift && !player.wasDashPressed;
    player.wasDashPressed = shift;

    if (dashJustPressed && player.dashCooldown <= 0 && !player.isDashing) {
        player.isDashing = true;
        player.dashTimer = 10;
        player.dashCooldown = 90;
    }

    let dashMovementApplied = false;
    if (player.isDashing) {
        player.vx = player.facingRight ? DASH_SPEED : -DASH_SPEED;
        const totalMove = player.vx * dt;
        const stepSize = 3;
        let moved = 0;

        while (Math.abs(moved) < Math.abs(totalMove)) {
            let remaining = Math.abs(totalMove) - Math.abs(moved);
            let step = Math.min(stepSize, remaining);
            let stepX = (totalMove > 0 ? step : -step);
            let newX = player.x + stepX;

            let tempPlayer = {
                x: newX,
                y: player.y,
                width: player.width,
                height: player.height
            };

            let collision = false;

            for (let id in players) {
                if (id === player.id) continue;
                let other = players[id];
                if (checkCollision(tempPlayer, other)) {
                    collision = true;
                    break;
                }
            }

            if (!collision) {
                for (let plat of platforms) {
                    if (checkCollision(tempPlayer, plat)) {
                        collision = true;
                        break;
                    }
                }
            }

            if (collision) {
                player.isDashing = false;
                player.dashTimer = 0;
                player.vx = 0;
                dashMovementApplied = true;
                break;
            } else {
                player.x = newX;
                moved += stepX;
                dashMovementApplied = true;
            }
        }

        player.dashTimer -= dt;
        if (player.dashTimer <= 0 && player.isDashing) {
            player.isDashing = false;
            player.vx *= 0.4;
            player.dashPushedBy = null;
        }
    }

    if (!player.isDashing && !dashMovementApplied) {
        if (left) {
            player.vx = -MOVE_SPEED;
            player.facingRight = false;
        } else if (right) {
            player.vx = MOVE_SPEED;
            player.facingRight = true;
        } else {
            player.vx *= Math.pow(FRICTION, dt);
            if (Math.abs(player.vx) < 0.1) player.vx = 0;
        }
        player.x += player.vx * dt;
    }

    let dynGravity = GRAVITY;
    if (jump && player.vy < 0) dynGravity = GRAVITY * 0.4;
    player.vy += dynGravity * dt;
    if (player.vy > MAX_FALL_SPEED) player.vy = MAX_FALL_SPEED;
    if (player.isGrounded) player.jumpsLeft = 2;
    let jumpJustPressed = jump && !player.wasJumpPressed;
    player.wasJumpPressed = jump;
    if (jumpJustPressed) {
        if (player.isGrounded) {
            player.vy = -6;
            player.isGrounded = false;
            player.jumpsLeft = 1;
            playSound('jump');
            spawnJumpParticles(player.x + player.width / 2, player.y + player.height, true);
        } else if (player.jumpsLeft > 0) {
            player.vy = -6;
            player.jumpsLeft = 0;
            playSound('jump');
            spawnJumpParticles(player.x + player.width / 2, player.y + player.height, false);
        }
    }

    player.isGrounded = false;
    platforms.forEach(plat => {
        if (checkCollision(player, plat)) {
            if (player.vx > 0) player.x = plat.x - player.width;
            else if (player.vx < 0) player.x = plat.x + plat.w;
            player.vx = 0;
            if (player.isDashing) player.isDashing = false;
        }
    });

    player.y += player.vy * dt;
    let landed = false;
    platforms.forEach(plat => {
        if (checkCollision(player, plat)) {
            if (player.vy > 0) {
                player.y = plat.y - player.height;
                player.isGrounded = true;
                landed = true;
                player.vy = 0;
            } else if (player.vy < 0) {
                player.y = plat.y + plat.h;
                player.vy = 0;
            }
        }
    });

    if (player.x < 20) {
        player.x = 20;
    }
    if (player.x + player.width > 1260) {
        player.x = 1260 - player.width;
    }

    hazards.forEach(h => {
        if (checkCollision(player, h)) {
            player.isDashing = false;
            respawnMatchEntity(player);
        }
    });

    gems.forEach(g => {
        if (!g.collected && checkCircleCollision(player, g)) {
            if (isHost) processGemCapture(g.id, player.id);
            else hostConnection.send({ type: 'request_collect_gem', senderId: localPlayerId, payload: { gemId: g.id } });
        }
    });

    for (let otherId in players) {
        if (otherId === player.id) continue;
        let target = players[otherId];
        if (player.vy > 0 && player.x + player.width > target.x && player.x < target.x + target.width &&
            player.y + player.height <= target.y + 5 && player.y + player.height + player.vy * dt >= target.y) {
            player.y = target.y - player.height;
            player.vy = 0;
            player.isGrounded = true;
            landed = true;
        }
    }

    if (!player.isGrounded && landed) {
        spawnDustParticles(player.x + player.width / 2, player.y + player.height);
        playSound('spike');
    }
}

function processGemCapture(gemId, targetId) {
    if (!isHost) return;
    const gem = gems.find(g => g.id === gemId);
    if (gem && !gem.collected) {
        gem.collected = true;
        if (players[targetId]) players[targetId].score += 10;
        playSound('gem');
        broadcastToRoom('sync_map', { platforms, hazards, gems });
        broadcastToRoom('sync_players', { allPlayers: players });
        updateHudDisplays();
    }
}

function respawnMatchEntity(player) {
    player.x = 100; player.y = 200; player.vx = player.vy = 0;
    player.score = Math.max(0, player.score - 5);
    playSound('spike');
    if (isHost) { broadcastToRoom('sync_players', { allPlayers: players }); updateHudDisplays(); }
}

// ============================================================================
//  PARTICLES
// ============================================================================

const PARTICLE_CAP = 250;
function pushParticle(p) {
    if (particles.length >= PARTICLE_CAP) particles.shift();
    if (p.alpha === undefined) p.alpha = 1;
    particles.push(p);
}

function spawnJumpParticles(spawnX, spawnY, grounded) {
    if (grounded) {
        const outward = 2.2, upward = -1.6;
        for (let i = 0; i < 6; i++) {
            pushParticle({
                type: 'jump_side', x: spawnX + 6 + Math.random() * 6, y: spawnY + 2 + (Math.random() - 0.5) * 4,
                vx: outward + Math.random() * 0.8, vy: upward + (Math.random() - 0.5) * 0.6, life: 0.6 + Math.random() * 0.2, age: 0,
                size: Math.random() * 2 + 1.2, radius: 4, bounce: 0.18, friction: 0.88, onGround: false, color: '#d0d0d0', alpha: 1
            });
            pushParticle({
                type: 'jump_side', x: spawnX - 6 + (Math.random() - 0.5) * 6, y: spawnY + 2 + (Math.random() - 0.5) * 4,
                vx: -outward - Math.random() * 0.8, vy: upward + (Math.random() - 0.5) * 0.6, life: 0.6 + Math.random() * 0.2, age: 0,
                size: Math.random() * 2 + 1.2, radius: 4, bounce: 0.18, friction: 0.88, onGround: false, color: '#d0d0d0', alpha: 1
            });
        }
        for (let i = 0; i < 4; i++) pushParticle({
            type: 'spark', x: spawnX + (Math.random() - 0.5) * 8, y: spawnY,
            vx: (Math.random() - 0.5) * 0.6, vy: -0.6 + Math.random() * 0.4, life: 0.45, age: 0, size: Math.random() * 1.2 + 0.6, color: '#ffffff', alpha: 1
        });
    } else {
        for (let i = 0; i < 8; i++) pushParticle({
            type: 'dust_down', x: spawnX + (Math.random() - 0.5) * 14, y: spawnY + 2,
            vx: (Math.random() - 0.5) * 1.2, vy: Math.random() * 0.6 + 0.6, life: 0.45, age: 0, size: Math.random() * 3 + 1.2,
            radius: 5, bounce: 0.12, friction: 0.9, onGround: false, color: '#bfbfbf', alpha: 1
        });
        for (let i = 0; i < 4; i++) pushParticle({
            type: 'spark', x: spawnX + (Math.random() - 0.5) * 8, y: spawnY,
            vx: (Math.random() - 0.5) * 1.0, vy: Math.random() * 0.6 + 0.2, life: 0.5, age: 0, size: Math.random() * 1.6 + 0.8, color: '#ffffff', alpha: 1
        });
    }
}

function spawnDustParticles(spawnX, spawnY) {
    for (let i = 0; i < 12; i++) {
        const dir = i % 2 === 0 ? 1 : -1;
        pushParticle({
            type: 'dust_up', x: spawnX + (Math.random() - 0.5) * 8, y: spawnY + 2,
            vx: dir * (1.6 + Math.random() * 1.2) + (Math.random() - 0.5) * 0.6, vy: -0.8 - Math.random() * 0.8 + (Math.random() - 0.3) * 0.4,
            life: 0.8 + Math.random() * 0.4, age: 0, size: Math.random() * 2 + 1.6, radius: 5, bounce: 0.22, friction: 0.86,
            onGround: false, color: '#888888', alpha: 1
        });
    }
}

function updateParticles(dt) {
    const seconds = dt / 60;
    const GRAV = 18;
    for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.age += seconds;
        if (p.age >= p.life) { particles.splice(i, 1); continue; }
        if (!p.onGround) p.vy += GRAV * seconds;
        p.x += p.vx * dt; p.y += p.vy * dt;
        for (let plat of platforms) {
            if (p.x + p.radius < plat.x || p.x - p.radius > plat.x + plat.w || p.y + p.radius < plat.y || p.y - p.radius > plat.y + plat.h) continue;
            const nx = Math.max(plat.x, Math.min(p.x, plat.x + plat.w));
            const ny = Math.max(plat.y, Math.min(p.y, plat.y + plat.h));
            const dx = p.x - nx, dy = p.y - ny;
            const d2 = dx * dx + dy * dy;
            if (d2 <= p.radius * p.radius) {
                const d = Math.sqrt(d2) || 0.0001;
                const pen = p.radius - d;
                p.x += (dx / d) * pen; p.y += (dy / d) * pen;
                if (dy < 0) {
                    if (Math.abs(p.vy) > 1.0) { p.vy = -p.vy * (p.bounce || 0.2); p.vx *= 0.7; }
                    else { p.vy = 0; p.onGround = true; p.vx *= (p.friction || 0.85); }
                } else { p.vx *= 0.6; p.vy *= 0.6; }
            }
        }
        for (let id in players) {
            const pl = players[id];
            if (!pl) continue;
            if (p.x + p.radius > pl.x && p.x - p.radius < pl.x + pl.width && p.y + p.radius > pl.y && p.y - p.radius < pl.y + pl.height) {
                const cx = pl.x + pl.width / 2, cy = pl.y + pl.height / 2;
                let dx = p.x - cx, dy = p.y - cy;
                const d = Math.hypot(dx, dy) || 0.0001;
                dx /= d; dy /= d;
                p.x += dx * (p.radius + Math.max(pl.width, pl.height) * 0.1);
                p.y += dy * (p.radius + Math.max(pl.width, pl.height) * 0.1);
                p.vx = p.vx * 0.4 + dx * 0.6;
                p.vy = p.vy * 0.4 + dy * 0.6;
            }
        }
        for (let h of hazards) {
            if (p.x + p.radius > h.x && p.x - p.radius < h.x + h.w && p.y + p.radius > h.y && p.y - p.radius < h.y + h.h) {
                const hx = h.x + h.w / 2, hy = h.y + h.h / 2;
                let dx = p.x - hx, dy = p.y - hy;
                const d = Math.hypot(dx, dy) || 0.0001;
                dx /= d; dy /= d;
                p.x += dx * (p.radius + Math.max(h.w, h.h) * 0.1);
                p.y += dy * (p.radius + Math.max(h.w, h.h) * 0.1);
                p.vx = p.vx * 0.3 + dx * 0.6;
                p.vy = p.vy * 0.3 + dy * 0.6;
            }
        }
        p.alpha = Math.max(0, 1 - p.age / p.life);
        p.renderSize = (p.size || 2) * (0.6 + 0.4 * (1 - p.age / p.life));
    }
}

// ============================================================================
//  RENDERING
// ============================================================================

function drawParticles() {
    particles.forEach(p => {
        if (p.type === 'dust_down') {
            ctx.globalAlpha = p.alpha * 0.9;
            ctx.fillStyle = p.color;
            ctx.fillRect(p.x - p.renderSize, p.y - p.renderSize * 0.15, p.renderSize * 2, p.renderSize * 0.35);
        } else if (p.type === 'dust_up') {
            ctx.globalAlpha = p.alpha;
            ctx.fillStyle = p.color;
            ctx.beginPath();
            ctx.ellipse(p.x, p.y, p.renderSize * 1.2, p.renderSize * 0.9, 0, 0, Math.PI * 2);
            ctx.fill();
        }
    });
    ctx.globalAlpha = 1;
}

function drawLobbyScoreboard() {
    const x = 50, y = 50, w = 250, h = 200;
    ctx.fillStyle = 'rgba(0,0,0,0.7)'; ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = '#00f2fe'; ctx.lineWidth = 2; ctx.strokeRect(x, y, w, h);
    ctx.fillStyle = '#00f2fe'; ctx.font = 'bold 14px "Orbitron"'; ctx.textAlign = 'left'; ctx.fillText('📊 Scoreboard', x + 10, y + 25);
    const sorted = Object.values(players).sort((a, b) => b.score - a.score);
    ctx.font = '12px "Orbitron"';
    sorted.slice(0, 5).forEach((pl, idx) => {
        const yy = y + 45 + idx * 30;
        ctx.fillStyle = pl.color; ctx.beginPath(); ctx.arc(x + 15, yy, 4, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#ffffff'; ctx.fillText(`${pl.nameTag}:`, x + 30, yy + 4);
        ctx.fillStyle = '#ffff00'; ctx.textAlign = 'right'; ctx.fillText(`${pl.score} pt`, x + w - 15, yy + 4);
        ctx.textAlign = 'left';
    });
}

function drawCanvasLevelLayout() {
    // 1. Static environment
    platforms.forEach(plat => {
        ctx.fillStyle = '#170c30';
        ctx.fillRect(plat.x, plat.y, plat.w, plat.h);
        ctx.strokeStyle = '#7f00ff';
        ctx.lineWidth = 2;
        ctx.strokeRect(plat.x, plat.y, plat.w, plat.h);
    });

    hazards.forEach(h => {
        ctx.fillStyle = '#ff003c';
        ctx.fillRect(h.x, h.y, h.w, h.h);
    });

    gems.forEach(g => {
        if (!g.collected) {
            ctx.fillStyle = '#00ff66';
            ctx.beginPath();
            ctx.arc(g.x, g.y, 8, 0, Math.PI * 2);
            ctx.fill();
        }
    });

    // 2. Doors / Finish line
    if (currentEngineMode === 'GAME') {
        ctx.fillStyle = '#00ff66';
        ctx.fillRect(finishLine.x, finishLine.y, finishLine.w, finishLine.h);
        ctx.strokeStyle = '#00cc44';
        ctx.lineWidth = 3;
        ctx.strokeRect(finishLine.x, finishLine.y, finishLine.w, finishLine.h);
        ctx.fillStyle = '#ffff00';
        ctx.fillRect(finishLine.x + finishLine.w / 2 - 2, finishLine.y - 30, 4, 30);
        const time = Date.now() * 0.001;
        const flagWave = Math.sin(time * 3) * 8;
        ctx.fillStyle = '#ff007f';
        ctx.beginPath();
        ctx.moveTo(finishLine.x + finishLine.w / 2 + 2, finishLine.y - 20);
        ctx.lineTo(finishLine.x + finishLine.w / 2 + 20 + flagWave, finishLine.y - 25);
        ctx.lineTo(finishLine.x + finishLine.w / 2 + 20 + flagWave, finishLine.y - 10);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 12px "Orbitron"';
        ctx.textAlign = 'center';
        ctx.fillText('FINISH', finishLine.x + finishLine.w / 2, finishLine.y + finishLine.h / 2 + 3);
    } else if (currentEngineMode === 'LOBBY') {
        ctx.shadowColor = skinDoor.color;
        ctx.shadowBlur = 15;
        ctx.fillStyle = '#1c0515';
        ctx.fillRect(skinDoor.x, skinDoor.y, skinDoor.w, skinDoor.h);
        ctx.strokeStyle = skinDoor.color;
        ctx.lineWidth = 4;
        ctx.strokeRect(skinDoor.x, skinDoor.y, skinDoor.w, skinDoor.h);
        ctx.shadowBlur = 0;

        ctx.shadowColor = lobbyDoor.color;
        ctx.shadowBlur = 15;
        ctx.fillStyle = '#2a1a00';
        ctx.fillRect(lobbyDoor.x, lobbyDoor.y, lobbyDoor.w, lobbyDoor.h);
        ctx.strokeStyle = lobbyDoor.color;
        ctx.lineWidth = 4;
        ctx.strokeRect(lobbyDoor.x, lobbyDoor.y, lobbyDoor.w, lobbyDoor.h);
        ctx.shadowBlur = 0;
    }

    // 3. Dynamic objects
    projectiles.forEach(p => {
        ctx.save();
        ctx.shadowBlur = 0;
        ctx.beginPath();
        const angle = Math.atan2(p.vy, p.vx);
        const trailLength = 36;
        const backX = p.x - Math.cos(angle) * trailLength;
        const backY = p.y - Math.sin(angle) * trailLength;
        ctx.moveTo(backX, backY);
        ctx.lineTo(p.x, p.y);
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.stroke();
        ctx.restore();

        if (bulletImage.complete) {
            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.rotate(angle);
            ctx.drawImage(bulletImage, -p.radius, -p.radius, p.radius * 2, p.radius * 2);
            ctx.restore();
        } else {
            ctx.fillStyle = '#ffaa44';
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#ff6600';
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.radius - 2, 0, Math.PI * 2);
            ctx.fill();
        }
    });

    const MAX_THROWABLE_LIFE = 150;
    for (let t of throwables) {
        ctx.save();
        ctx.translate(t.x, t.y);
        ctx.rotate(t.angle);
        const preview = itemManager.getPreviewImage(t.itemType);
        if (preview?.complete) ctx.drawImage(preview, -12, -12, 24, 24);
        else {
            ctx.fillStyle = '#ffaa44';
            ctx.fillRect(-12, -12, 24, 24);
            ctx.fillStyle = '#fff';
            ctx.font = '12px monospace';
            ctx.fillText('?', -4, 4);
        }
        ctx.restore();

        const percent = Math.max(0, Math.min(1, (MAX_THROWABLE_LIFE - t.life) / MAX_THROWABLE_LIFE));
        const barX = t.x - 12, barY = t.y - 14;
        ctx.fillStyle = '#222';
        ctx.fillRect(barX, barY, 24, 4);
        ctx.fillStyle = t.itemType === 'pistol' ? '#ffaa44' : '#88ff88';
        ctx.fillRect(barX, barY, 24 * percent, 4);
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 0.5;
        ctx.strokeRect(barX, barY, 24, 4);
        ctx.font = 'bold 8px monospace';
        ctx.fillStyle = '#fff';
        ctx.shadowBlur = 0;
        ctx.fillText(`${Math.floor(percent * 100)}%`, t.x, barY - 2);
    }

    if (itemManager) {
        for (let wi of itemManager.worldItems) {
            wi.draw(ctx, itemManager);
        }
    }

    if (currentEngineMode === 'LOBBY') {
        drawLobbyScoreboard();
    }
}

function calculateHandAngle(player) {
    const handX = player.x + player.width / 2, handY = player.y + 32;
    const mouse = getMouseWorldPos();
    const cursorAngle = Math.atan2(mouse.y - handY, mouse.x - handX);
    const facingAngle = player.facingRight ? 0 : Math.PI;
    let diff = cursorAngle - facingAngle;
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    const maxAngle = (150 * Math.PI) / 360;
    if (Math.abs(diff) <= maxAngle) return cursorAngle;
    return facingAngle + (diff > 0 ? maxAngle : -maxAngle);
}

function getAdaptiveOutlineColor(hex) {
    let r, g, b;
    if (hex.startsWith('#')) { r = parseInt(hex.slice(1, 3), 16); g = parseInt(hex.slice(3, 5), 16); b = parseInt(hex.slice(5, 7), 16); }
    else return 'rgba(255,255,255,0.8)';
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum > 0.7 ? 'rgba(0,0,0,0.9)' : 'rgba(255,255,255,0.9)';
}

function roundedRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
}

function drawCharacterModel(p) {
    const OUTLINE = 3;
    let outlineColor = getAdaptiveOutlineColor(p.color);
    const bodyRatio = 0.58;
    const bodyH = Math.max(12, Math.round(p.height * bodyRatio));
    const bodyX = p.x, bodyY = p.y + 10, bodyW = p.width;
    const hipY = bodyY + bodyH - 2;
    const hipCenterX = p.x + p.width / 2;
    const HIP_OFFSET_X = Math.max(4, Math.round(p.width * 0.22));
    const LEG_H = 22, LEG_W = 6;
    const now = Date.now();
    const LEG_SPEED = 0.012, LEG_AMP = 0.6;
    const JUMP_R = 0.3, JUMP_L = -0.3, DOUBLE_R = 0.45, DOUBLE_L = -0.45, FALL_R = 0.1, FALL_L = -0.1;
    let leftLeg = 0, rightLeg = 0;
    const facingRight = p.facingRight !== undefined ? p.facingRight : p.vx >= 0;
    const animateLocally = p.id === localPlayerId;
    if (p.isGrounded) {
        if (Math.abs(p.vx) > 0.15) {
            let phase = Math.sin(now * LEG_SPEED);
            const maxRef = animateLocally ? MOVE_SPEED : Math.max(0.15, Math.abs(p.vx));
            const factor = Math.min(Math.abs(p.vx) / maxRef, 1);
            const swing = LEG_AMP * factor * phase;
            if (p.vx < -0.01) { leftLeg = -swing; rightLeg = swing; }
            else { leftLeg = swing; rightLeg = -swing; }
        } else {
            if (animateLocally) { const sway = Math.sin(now * 0.004) * 0.06; leftLeg = sway; rightLeg = -sway; }
            else { leftLeg = rightLeg = 0; }
        }
    } else {
        const rising = p.vy < 0;
        const doubleJump = p.jumpsLeft === 0;
        if (rising) {
            if (doubleJump) {
                const spread = 0.45;
                if (facingRight) {
                    leftLeg = spread - 0.1;
                    rightLeg = -spread - 0.3;
                } else {
                    leftLeg = spread + 0.3;
                    rightLeg = -spread + 0.1;
                }
            } else {
                leftLeg = rightLeg = facingRight ? JUMP_R : JUMP_L;
            }
        } else {
            leftLeg = rightLeg = facingRight ? FALL_R : FALL_L;
        }
    }
    const drawLeg = (angle, offX) => {
        ctx.save(); ctx.translate(hipCenterX + offX, hipY); ctx.rotate(Math.PI / 2 + angle);
        ctx.fillStyle = p.color; ctx.lineWidth = OUTLINE; ctx.strokeStyle = outlineColor;
        ctx.fillRect(0, -LEG_W / 2, LEG_H, LEG_W); ctx.strokeRect(0, -LEG_W / 2, LEG_H, LEG_W);
        ctx.restore();
    };
    drawLeg(leftLeg, -HIP_OFFSET_X); drawLeg(rightLeg, HIP_OFFSET_X);
    ctx.fillStyle = p.color; ctx.fillRect(bodyX, bodyY, bodyW, bodyH);
    ctx.lineWidth = OUTLINE; ctx.strokeStyle = outlineColor; ctx.strokeRect(bodyX, bodyY, bodyW, bodyH);
    const headR = p.width / 1.4;
    const headX = p.x + p.width / 2, headY = p.y + 20;
    ctx.fillStyle = p.color; ctx.beginPath(); ctx.arc(headX, headY, headR, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    const hasFace = localStorage.getItem('playerHasCustomFace_' + p.id) === 'true';
    if (hasFace) {
        const faceData = localStorage.getItem('playerFaceDrawing_' + p.id);
        if (faceData) {
            if (!faceImageCache[p.id] || faceImageCache[p.id].src !== faceData) {
                faceImageCache[p.id] = new Image(); faceImageCache[p.id].src = faceData;
            }
            const faceImg = faceImageCache[p.id];
            if (faceImg.complete) {
                ctx.save(); ctx.beginPath(); ctx.arc(headX, headY, headR, 0, Math.PI * 2); ctx.clip();
                const size = headR * 2 * 0.95; ctx.drawImage(faceImg, headX - size / 2, headY - size / 2, size, size);
                ctx.restore();
            }
        }
    }
    const handPivotX = p.x + p.width / 2;
    const handPivotY = p.y + (bodyH * 0.22) + 30;
    const handAngle = (p.id === localPlayerId) ? calculateHandAngle(p) : (p.handAngle !== undefined ? p.handAngle : (facingRight ? 0 : Math.PI));
    ctx.save(); ctx.translate(handPivotX, handPivotY); ctx.rotate(handAngle);
    ctx.fillStyle = p.color; roundedRect(ctx, 0, -3, 18, 6, 3); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.arc(24, 0, 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.restore();
    if (p.item) {
        const handX = handPivotX + Math.cos(handAngle) * 24;
        const handY = handPivotY + Math.sin(handAngle) * 24;
        p.item.draw(ctx, handX, handY, handAngle, p.facingRight);
        if (p.id === localPlayerId && p.itemType === 'pistol' && p.item.ammo !== undefined) {
            ctx.font = 'bold 14px "Orbitron"';
            ctx.fillStyle = '#fff';
            ctx.shadowBlur = 2;
            ctx.shadowColor = '#000';
            ctx.textAlign = 'center';
            ctx.fillText(`${p.item.ammo}`, handX, handY - 8);
        }
    }
    ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.font = 'bold 10px monospace'; ctx.textAlign = 'center';
    let label = p.nameTag || 'P?'; if (p.id === localPlayerId) label += ' (YOU)';
    ctx.fillText(label, p.x + p.width / 2, p.y - 20);
    if (p.isGrounded && p.vy > 5 && !p.isDashing) spawnDustParticles(p.x, p.y + p.height);
}

function updateAndRenderParticles() {
    for (let i = particles.length - 1; i >= 0; i--) {
        let p = particles[i];
        p.x += p.vx; p.y += p.vy;
        p.alpha -= 0.04;
        if (p.alpha <= 0) { particles.splice(i, 1); continue; }
        ctx.save(); ctx.globalAlpha = p.alpha; ctx.fillStyle = p.color; ctx.fillRect(p.x, p.y, p.size, p.size); ctx.restore();
    }
}

function drawOffscreenRadarIndicators() {
    if (!players[localPlayerId]) return;
    const pad = 25;
    for (let id in players) {
        if (id === localPlayerId) continue;
        let p = players[id];
        if (p.eliminated) continue;
        let sx = (p.x + p.width / 2 - camera.x) * camera.zoom;
        let sy = (p.y + p.height / 2 - camera.y) * camera.zoom;
        if (sx < 0 || sx > BASE_WIDTH || sy < 0 || sy > BASE_HEIGHT) {
            let ax = Math.max(pad, Math.min(BASE_WIDTH - pad, sx));
            let ay = Math.max(pad, Math.min(BASE_HEIGHT - pad, sy));
            let angle = Math.atan2(sy - ay, sx - ax);
            ctx.save(); ctx.translate(ax, ay); ctx.rotate(angle);
            ctx.fillStyle = p.color; ctx.shadowColor = p.color; ctx.shadowBlur = 10;
            ctx.beginPath(); ctx.moveTo(12, 0); ctx.lineTo(-8, -10); ctx.lineTo(-4, 0); ctx.lineTo(-8, 10); ctx.fill();
            ctx.shadowBlur = 0; ctx.fillStyle = '#fff'; ctx.font = 'bold 9px monospace'; ctx.textAlign = 'center';
            ctx.fillText("PLR", -16, 3); ctx.restore();
        }
    }
}

function drawDashCooldownBar(p) {
    const w = p.width + 10, h = 3, x = p.x - 5, y = p.y - 12;
    ctx.fillStyle = 'rgba(11,6,18,0.7)'; ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.15)'; ctx.lineWidth = 1; ctx.strokeRect(x, y, w, h);
    const maxCD = 45, cur = Math.max(0, p.dashCooldown || 0);
    let fill = (maxCD - cur) / maxCD;
    fill = Math.max(0, Math.min(1, fill));
    ctx.save();
    if (fill >= 1) { ctx.shadowBlur = 10; ctx.shadowColor = '#00f2fe'; ctx.fillStyle = '#00f2fe'; }
    else { ctx.fillStyle = '#ff007f'; }
    ctx.fillRect(x + 0.5, y + 0.5, (w - 1) * fill, h - 1);
    ctx.restore();
}

// ============================================================================
//  UI DOORS
// ============================================================================

function drawSkinDoorUI() {
    if (currentEngineMode !== 'LOBBY') return;
    ctx.fillStyle = '#fff'; ctx.font = '20px "Orbitron"'; ctx.textAlign = 'center';
    ctx.shadowColor = '#ff007f'; ctx.shadowBlur = 12;
    const cx = skinDoor.x + skinDoor.w / 2, cy = skinDoor.y;
    ctx.fillText("Edit Skin", cx, cy - 20);
    const local = players[localPlayerId];
    if (local && checkCollision(local, skinDoor)) {
        ctx.fillText("[F] | open", cx, cy + skinDoor.h / 2);
        if (keys.Interact) { openSkinMenu(); keys.Interact = false; }
    }
}

function drawStartDoorUI() {
    if (currentEngineMode !== 'LOBBY') return;
    ctx.fillStyle = '#fff'; ctx.font = '20px "Orbitron"'; ctx.textAlign = 'center';
    ctx.shadowColor = '#ffcc00'; ctx.shadowBlur = 12;
    const cx = lobbyDoor.x + lobbyDoor.w / 2, cy = lobbyDoor.y;
    ctx.fillText("Start", cx, cy - 20);
    const local = players[localPlayerId];
    if (local && checkCollision(local, lobbyDoor)) {
        ctx.fillText("[F] | Ready", cx, cy + lobbyDoor.h / 2);
        if (keys.Interact) {
            if (readyPlayers[localPlayerId]) delete readyPlayers[localPlayerId];
            else readyPlayers[localPlayerId] = true;
            keys.Interact = false;
            if (!isHost && hostConnection?.open) {
                hostConnection.send({ type: 'player_ready_toggle', senderId: localPlayerId, payload: { isReady: !!readyPlayers[localPlayerId] } });
            }
        }
    }
    const total = Object.keys(players).length, ready = Object.keys(readyPlayers).length;
    ctx.font = '16px "Orbitron"'; ctx.fillText(`Ready: ${ready}/${total}`, cx, cy - lobbyDoor.h / 2 - 15);
}

// ============================================================================
//  MAIN GAME LOOP
// ============================================================================

function enginePipelineTick(timestamp) {
    if (!lastTime) lastTime = timestamp;
    let dt = (timestamp - lastTime) / 16.666;
    lastTime = timestamp;
    if (dt > 3.0) dt = 3.0;
    ctx.fillStyle = '#24212a'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (currentEngineMode === 'LOBBY' || currentEngineMode === 'GAME') {
        let localPlayer = players[localPlayerId];
        if (localPlayer) {
            updateCharacterPhysics(localPlayer, dt);
            resolvePlayerCollisions();
            if (currentEngineMode === 'GAME' && isHost) checkAndProcessRaceFinish();
            if (isHost) {
                evaluateLobbyDoorTrigger();
                localPlayer.handAngle = calculateHandAngle(localPlayer);
                broadcastToRoom('sync_players', { allPlayers: players });
            } else {
                hostConnection.send({
                    type: 'client_input_update', senderId: localPlayerId,
                    payload: {
                        x: localPlayer.x, y: localPlayer.y, vx: localPlayer.vx, vy: localPlayer.vy,
                        isGrounded: localPlayer.isGrounded, facingRight: localPlayer.facingRight,
                        isDashing: localPlayer.isDashing, handAngle: calculateHandAngle(localPlayer),
                        resetVersion: clientResetVersion
                    }
                });
            }
            checkVoidDeath();

            if (itemManager) {
                itemManager.update();
                if (isHost && localPlayer) {
                    const picked = itemManager.checkPickup(localPlayer);
                    if (picked) {
                        players[localPlayerId].item = picked;
                        players[localPlayerId].itemType = 'pistol';
                        players[localPlayerId].ammo = picked.ammo;
                        localPlayerItem = picked;
                        broadcastToRoom('sync_players', { allPlayers: players });
                        broadcastWorldItems();
                        playSound('gem');
                    }
                } else if (!isHost && localPlayer) {
                    for (let wi of itemManager.worldItems) {
                        if (wi.isAvailable && checkCollision(localPlayer, wi)) {
                            hostConnection.send({ type: 'request_pickup_item', senderId: localPlayerId });
                            break;
                        }
                    }
                }
            }
            if (keys.Drop && !wasDropPressed) {
                if (localPlayer.item) {
                    if (!isHost && hostConnection?.open) {
                        if (localPlayer.item.ammo !== undefined && localPlayer.item.ammo === 0) {
                            spawnBreakParticles(localPlayer.x + localPlayer.width / 2, localPlayer.y + localPlayer.height / 2);
                            localPlayer.item = null;
                            localPlayer.itemType = null;
                            localPlayer.ammo = 0;
                            localPlayerItem = null;
                        }
                        hostConnection.send({ type: 'request_drop_item', senderId: localPlayerId });
                    } else if (isHost) {
                        hostDropItem(localPlayerId);
                    }
                }
            }
            wasDropPressed = keys.Drop;
            if (localPlayerItem) localPlayerItem.update(dt);
            camera.zoom += (camera.targetZoom - camera.zoom) * 0.1 * dt;
            let targetCamX = (localPlayer.x + localPlayer.width / 2) - (BASE_WIDTH / 2) / camera.zoom;
            let targetCamY = (localPlayer.y + localPlayer.height / 2) - (BASE_HEIGHT / 2) / camera.zoom;
            let maxX = BASE_WIDTH - BASE_WIDTH / camera.zoom, maxY = BASE_HEIGHT - BASE_HEIGHT / camera.zoom;
            targetCamX = Math.max(0, Math.min(targetCamX, maxX));
            targetCamY = Math.max(0, Math.min(targetCamY, maxY));
            camera.x += (targetCamX - camera.x) * 0.1 * dt;
            camera.y += (targetCamY - camera.y) * 0.1 * dt;
        } else {
            camera.zoom = 1; camera.x = camera.y = 0;
        }

        // bullets
        for (let i = 0; i < projectiles.length; i++) {
            const p = projectiles[i];
            p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt;
            if (p.life <= 0) { projectiles.splice(i, 1); i--; continue; }
            const out = p.x - p.radius < 0 || p.x + p.radius > BASE_WIDTH || p.y - p.radius < 0 || p.y + p.radius > BASE_HEIGHT;
            if (out) {
                for (let s = 0; s < 3; s++) particles.push({ x: p.x, y: p.y, vx: (Math.random() - 0.5) * 2, vy: (Math.random() - 0.5) * 2, life: 0.3, age: 0, size: Math.random() * 2 + 1, color: '#ffaa44', alpha: 1 });
                projectiles.splice(i, 1); i--; continue;
            }
            let solid = false;
            for (let plat of platforms) if (p.x + p.radius > plat.x && p.x - p.radius < plat.x + plat.w && p.y + p.radius > plat.y && p.y - p.radius < plat.y + plat.h) { solid = true; break; }
            if (solid) { for (let s = 0; s < 3; s++) particles.push({ x: p.x, y: p.y, vx: (Math.random() - 0.5) * 2, vy: (Math.random() - 0.5) * 2, life: 0.3, age: 0, size: Math.random() * 2 + 1, color: '#ffaa44', alpha: 1 }); projectiles.splice(i, 1); i--; continue; }
            for (let h of hazards) if (p.x + p.radius > h.x && p.x - p.radius < h.x + h.w && p.y + p.radius > h.y && p.y - p.radius < h.y + h.h) { solid = true; break; }
            if (solid) { for (let s = 0; s < 3; s++) particles.push({ x: p.x, y: p.y, vx: (Math.random() - 0.5) * 2, vy: (Math.random() - 0.5) * 2, life: 0.3, age: 0, size: Math.random() * 2 + 1, color: '#ffaa44', alpha: 1 }); projectiles.splice(i, 1); i--; continue; }
            for (let id in players) {
                if (id === p.ownerId) continue;
                const t = players[id];
                if (t.eliminated) continue;
                const dx = p.x - (t.x + t.width / 2), dy = p.y - (t.y + t.height / 2);
                if (Math.hypot(dx, dy) < p.radius + t.width / 2) {
                    const angle = Math.atan2(p.vy, p.vx);
                    t.vx += Math.cos(angle) * p.knockback;
                    t.vy += Math.sin(angle) * p.knockback;
                    projectiles.splice(i, 1); i--; playSound('spike'); break;
                }
            }
        }

        // throwables (MODIFIED)
        for (let i = 0; i < throwables.length; i++) {
            const t = throwables[i];
            t.vy += THROWABLE_GRAVITY * dt;
            t.angularSpeed *= 0.996;
            t.x += t.vx * dt;
            t.y += t.vy * dt;
            t.life -= dt;
            t.angle += t.angularSpeed * dt;

            // === BREAK IF TOO FAR OUTSIDE MAP ===
            const breakX = (t.x + t.radius < -BREAK_BOUNDS_OFFSET || t.x - t.radius > BASE_WIDTH + BREAK_BOUNDS_OFFSET);
            const breakY = (t.y + t.radius < -BREAK_BOUNDS_OFFSET || t.y - t.radius > BASE_HEIGHT + BREAK_BOUNDS_OFFSET);
            if (breakX || breakY) {
                for (let s = 0; s < 8; s++) {
                    particles.push({
                        x: t.x, y: t.y,
                        vx: (Math.random() - 0.5) * 4,
                        vy: (Math.random() - 0.5) * 4,
                        life: 0.4, age: 0,
                        size: Math.random() * 4 + 2,
                        color: '#ffaa44', alpha: 1
                    });
                }
                playSound('spike');
                throwables.splice(i, 1);
                i--;
                continue;
            }

            if (t.life <= 0) {
                const spawnX = t.x - 12, spawnY = t.y - 12;
                if (spawnX > -BREAK_BOUNDS_OFFSET && spawnX < BASE_WIDTH + BREAK_BOUNDS_OFFSET &&
                    spawnY > -BREAK_BOUNDS_OFFSET && spawnY < BASE_HEIGHT + BREAK_BOUNDS_OFFSET) {
                    itemManager.spawnItem(spawnX, spawnY, t.itemType, 0, false, t.ammo);
                    broadcastWorldItems();
                }
                throwables.splice(i, 1);
                i--;
                continue;
            }

            let bounced = false;
            if (t.x - t.radius < 0 && t.x + t.radius > -BREAK_BOUNDS_OFFSET) {
                t.x = t.radius;
                t.vx = -t.vx * 0.4;
                t.angularSpeed = -t.angularSpeed * 0.8 + (Math.random() - 0.5) * 0.1;
                bounced = true;
            }
            if (t.x + t.radius > BASE_WIDTH && t.x - t.radius < BASE_WIDTH + BREAK_BOUNDS_OFFSET) {
                t.x = BASE_WIDTH - t.radius;
                t.vx = -t.vx * 0.4;
                bounced = true;
            }
            if (t.y - t.radius < 0 && t.y + t.radius > -BREAK_BOUNDS_OFFSET) {
                t.y = t.radius;
                t.vy = -t.vy * 0.4;
                bounced = true;
            }
            // BOTTOM BOUNCE REMOVED – items fall into void
            if (bounced) continue;

            // --- platform collisions ---
            let hitPlatform = false;
            for (let plat of platforms) {
                if (t.x + t.radius > plat.x && t.x - t.radius < plat.x + plat.w && t.y + t.radius > plat.y && t.y - t.radius < plat.y + plat.h) {
                    const left = t.x + t.radius - plat.x, right = plat.x + plat.w - (t.x - t.radius);
                    const top = t.y + t.radius - plat.y, bottom = plat.y + plat.h - (t.y - t.radius);
                    const minOver = Math.min(left, right, top, bottom);
                    if (minOver === left || minOver === right) {
                        t.vx = -t.vx * 0.7;
                        if (minOver === left) t.x = plat.x - t.radius;
                        else t.x = plat.x + plat.w + t.radius;
                    } else {
                        t.vy = -t.vy * 0.5; t.vx *= 0.92; t.angularSpeed *= 0.7;
                        if (Math.abs(t.vx) < 0.2) t.vx = 0;
                        if (minOver === top) t.y = plat.y - t.radius;
                        else t.y = plat.y + plat.h + t.radius;
                    }
                    hitPlatform = true; break;
                }
            }
            if (hitPlatform) continue;

            // --- hazard collisions ---
            let hitHazard = false;
            for (let h of hazards) {
                if (t.x + t.radius > h.x && t.x - t.radius < h.x + h.w && t.y + t.radius > h.y && t.y - t.radius < h.y + h.h) {
                    const left = t.x + t.radius - h.x, right = h.x + h.w - (t.x - t.radius);
                    const top = t.y + t.radius - h.y, bottom = h.y + h.h - (t.y - t.radius);
                    const minOver = Math.min(left, right, top, bottom);
                    if (minOver === left || minOver === right) {
                        t.vx = -t.vx * 0.6; t.angularSpeed = -t.angularSpeed * 0.9;
                        if (minOver === left) t.x = h.x - t.radius;
                        else t.x = h.x + h.w + t.radius;
                    } else {
                        t.vy = -t.vy * 0.6;
                        if (minOver === top) t.y = h.y - t.radius;
                        else t.y = h.y + h.h + t.radius;
                    }
                    hitHazard = true; break;
                }
            }
            if (hitHazard) continue;

            // --- player collisions ---
            for (let id in players) {
                if (id === t.ownerId) continue;
                const target = players[id];
                if (target.eliminated) continue;
                const dx = t.x - (target.x + target.width / 2), dy = t.y - (target.y + target.height / 2);
                const dist = Math.hypot(dx, dy);
                if (dist < t.radius + target.width / 2) {
                    if (t.dropItem) {
                        const angle = Math.atan2(t.vy, t.vx);
                        t.vx = Math.cos(angle) * Math.abs(t.vx) * 0.5;
                        t.vy = Math.sin(angle) * Math.abs(t.vy) * 0.5;
                        const pushX = dx / dist * (t.radius + target.width / 2);
                        const pushY = dy / dist * (t.radius + target.height / 2);
                        t.x += pushX * 0.5; t.y += pushY * 0.5;
                        continue;
                    } else {
                        const angle = Math.atan2(t.vy, t.vx);
                        target.vx += Math.cos(angle) * 15;
                        target.vy += Math.sin(angle) * 15;
                        const dropX = target.x + target.width / 2 - 12;
                        const dropY = target.y + target.height - 12;
                        itemManager.spawnItem(dropX, dropY, t.itemType, 0, false, t.ammo);
                        broadcastWorldItems();
                        throwables.splice(i, 1); i--;
                        playSound('spike'); break;
                    }
                }
            }
        }

        if (isHost) broadcastThrowables();
        if (isHost) broadcastProjectiles();
        ctx.save(); ctx.scale(camera.zoom, camera.zoom); ctx.translate(-camera.x, -camera.y);
        drawCanvasLevelLayout();
        updateAndRenderParticles();
        for (let id in players) {
            let p = players[id];
            if (p.eliminated) continue;
            if (p.isDashing) {
                for (let i = 0; i < 2; i++) particles.push({
                    x: p.x + (p.facingRight ? 0 : p.width), y: p.y + Math.random() * p.height,
                    vx: (p.facingRight ? -3 : 3) + (Math.random() - 0.5), vy: (Math.random() - 0.5) * 1, alpha: 1, size: Math.random() * 5 + 4, color: p.color
                });
            }
            drawCharacterModel(p);
            if (id === localPlayerId) drawDashCooldownBar(p);
        }
        drawSkinDoorUI(); drawStartDoorUI();
        ctx.restore();
        drawOffscreenRadarIndicators();
        if (lobbyCountdownVal >= 0) {
            ctx.fillStyle = '#ff007f'; ctx.font = 'bold 36px "Orbitron"'; ctx.textAlign = 'center';
            ctx.shadowColor = '#ff007f'; ctx.shadowBlur = 15;
            ctx.fillText(`MATCH STARTING IN: ${lobbyCountdownVal}s`, canvas.width / 2, 60);
            ctx.shadowBlur = 0;
        }
        if (raceCountdownVal > 0 && currentEngineMode === 'GAME') {
            ctx.fillStyle = '#00ff66'; ctx.font = 'bold 48px "Orbitron"'; ctx.textAlign = 'center';
            ctx.shadowColor = '#00ff66'; ctx.shadowBlur = 20;
            ctx.fillText(`${raceCountdownVal}s`, canvas.width / 2, canvas.height / 2);
            ctx.shadowBlur = 0;
        }
    } else {
        ctx.fillStyle = '#110924'; ctx.font = '20px "Orbitron"'; ctx.textAlign = 'center';
        ctx.fillText("WAITING IN PLATFORM MENU...", canvas.width / 2, canvas.height / 2);
    }
    requestAnimationFrame(enginePipelineTick);
}

// ============================================================================
//  INPUT HANDLING
// ============================================================================

window.addEventListener('keydown', (e) => {
    if (['ArrowLeft', 'a', 'A'].includes(e.key)) keys.ArrowLeft = true;
    if (['ArrowRight', 'd', 'D'].includes(e.key)) keys.ArrowRight = true;
    if (['ArrowUp', 'w', 'W', ' '].includes(e.key)) keys.ArrowUp = true;
    if (['f', 'F'].includes(e.key)) keys.Interact = true;
    if (e.key === 'q' || e.key === 'Q') keys.Drop = true;
    if (e.code === 'ShiftLeft') keys.ShiftLeft = true;
});

window.addEventListener('keyup', (e) => {
    if (['ArrowLeft', 'a', 'A'].includes(e.key)) keys.ArrowLeft = false;
    if (['ArrowRight', 'd', 'D'].includes(e.key)) keys.ArrowRight = false;
    if (['ArrowUp', 'w', 'W', ' '].includes(e.key)) keys.ArrowUp = false;
    if (['f', 'F'].includes(e.key)) keys.Interact = false;
    if (e.key === 'q' || e.key === 'Q') keys.Drop = false;
    if (e.code === 'ShiftLeft') keys.ShiftLeft = false;
});

window.addEventListener('mousedown', (e) => { if (e.button === 1) { e.preventDefault(); camera.isZoomed = !camera.isZoomed; camera.targetZoom = camera.isZoomed ? 1.75 : 1.0; } });
window.addEventListener('wheel', (e) => {
    if (currentEngineMode === 'LOBBY' || currentEngineMode === 'GAME') {
        e.preventDefault();
        const sens = 0.15;
        if (e.deltaY < 0) camera.targetZoom = Math.min(camera.maxZoom, camera.targetZoom + sens);
        else if (e.deltaY > 0) camera.targetZoom = Math.max(camera.minZoom, camera.targetZoom - sens);
    }
}, { passive: false });

window.addEventListener('pointerdown', (e) => { if (e.button === 1) e.preventDefault(); });
canvas.addEventListener('mousedown', (e) => {
    if (currentEngineMode !== 'LOBBY' && currentEngineMode !== 'GAME') return;
    if (e.button !== 0) return;
    if (!localPlayerItem) return;

    if (localPlayerItem.name === 'pistol' && localPlayerItem.ammo !== undefined && localPlayerItem.ammo <= 0) {
        if (emptyPistolSound) {
            emptyPistolSound.currentTime = 0;
            emptyPistolSound.play().catch(e => console.warn("Empty pistol sound play failed:", e));
        }
        return;
    }

    if (!localPlayerItem.canUse()) return;

    if (isHost) {
        const used = localPlayerItem.onUse(players[localPlayerId], { projectiles });
        if (used) {
            playPistolSound();
            players[localPlayerId].ammo = localPlayerItem.ammo;
            broadcastToRoom('sync_players', { allPlayers: players });
        } else {
            if (emptyPistolSound) {
                emptyPistolSound.currentTime = 0;
                emptyPistolSound.play().catch(e => console.warn("Empty pistol sound play failed:", e));
            }
        }
    } else {
        if (localPlayerItem.ammo !== undefined) {
            localPlayerItem.ammo--;
            players[localPlayerId].ammo = localPlayerItem.ammo;
        }
        const angle = calculateHandAngle(players[localPlayerId]);
        hostConnection.send({
            type: 'client_shoot',
            senderId: localPlayerId,
            payload: { handAngle: angle, ammo: localPlayerItem.ammo }
        });
        localPlayerItem.cooldown = localPlayerItem.cooldownMax;
        playPistolSound();
    }
});

canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('mousedown', (e) => {
    if (e.button === 2 && players[localPlayerId] && players[localPlayerId].item) {
        e.preventDefault();
        const angle = calculateHandAngle(players[localPlayerId]);
        if (!isHost && hostConnection?.open) hostConnection.send({ type: 'request_throw_item', senderId: localPlayerId, payload: { angle } });
        else if (isHost) hostThrowItem(localPlayerId, angle);
    }
});

function bindTouchBtn(id, action) {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('touchstart', (e) => { e.preventDefault(); touchState[action] = true; });
    el.addEventListener('touchend', (e) => { e.preventDefault(); touchState[action] = false; });
    el.addEventListener('touchcancel', (e) => { e.preventDefault(); touchState[action] = false; });
}
bindTouchBtn('btn-left', 'left'); bindTouchBtn('btn-right', 'right'); bindTouchBtn('btn-jump', 'jump');

// ============================================================================
//  SKIN MENU & COLOR SELECTION
// ============================================================================

function selectCharacterColor(hexColor, buttonElement) {
    if (players[localPlayerId] && players[localPlayerId].color === hexColor) return;
    if (isColorAlreadyUsed(hexColor, localPlayerId)) return;
    if (players[localPlayerId]) {
        players[localPlayerId].color = hexColor;
        if (isHost) broadcastToRoom('sync_players', { allPlayers: players });
        else if (hostConnection?.open) hostConnection.send({ type: 'update_skin', senderId: localPlayerId, payload: { color: hexColor } });
    }
    if (buttonElement) {
        document.querySelectorAll('.color-btn').forEach(btn => {
            btn.classList.remove('border-white', 'scale-105'); btn.classList.add('border-transparent');
        });
        buttonElement.classList.remove('border-transparent'); buttonElement.classList.add('border-white', 'scale-105');
    }
}

function isColorAlreadyUsed(hex, excludeId) {
    if (!hex) return false;
    const clean = hex.trim().toLowerCase();
    for (let id in players) if (id !== excludeId && players[id]?.color?.trim().toLowerCase() === clean) return true;
    return false;
}

function updateColorButtonStates() {
    const local = players[localPlayerId]?.color?.trim().toLowerCase();
    document.querySelectorAll('.color-btn').forEach(btn => {
        const raw = btn.getAttribute('data-color');
        if (!raw) return;
        const col = raw.trim().toLowerCase();
        if (local && col === local) {
            btn.classList.remove('disabled-color', 'border-transparent'); btn.classList.add('border-white', 'scale-105'); btn.style.pointerEvents = 'auto';
        } else if (isColorAlreadyUsed(col, localPlayerId)) {
            btn.classList.add('disabled-color'); btn.classList.remove('border-white', 'scale-105'); btn.classList.add('border-transparent'); btn.style.pointerEvents = 'none';
        } else {
            btn.classList.remove('disabled-color'); btn.classList.remove('border-white', 'scale-105'); btn.classList.add('border-transparent'); btn.style.pointerEvents = 'auto';
        }
    });
}

function openSkinMenu() {
    const modal = document.getElementById('skin-modal');
    if (modal) modal.classList.remove('hidden');
    if (typeof updateColorButtonStates === 'function') updateColorButtonStates();
    const cur = players[localPlayerId]?.color;
    if (cur) {
        const norm = cur.trim().toLowerCase();
        document.querySelectorAll('.color-btn').forEach(btn => {
            const col = btn.getAttribute('data-color')?.trim().toLowerCase();
            if (col === norm) { btn.classList.remove('border-transparent'); btn.classList.add('border-white', 'scale-105'); btn.style.pointerEvents = 'auto'; }
        });
    }
}
function closeSkinMenu() { document.getElementById('skin-modal').classList.add('hidden'); }

// ============================================================================
//  FACE DRAWING
// ============================================================================

let faceDrawingCanvas = null, faceDrawingCtx = null, faceOverlayCanvas = null, faceOverlayCtx = null;
let isDrawingFace = false, currentDrawColorFace = '#FFFFFF', currentBrushSizeFace = 20;
let eraserActiveFace = false, lastPenColorFace = '#FFFFFF', faceCanvasBgColor = '#0c0516';

function initializeFaceCanvas() {
    faceDrawingCanvas = document.getElementById('faceDrawingCanvas');
    faceDrawingCtx = faceDrawingCanvas.getContext('2d');
    faceOverlayCanvas = document.createElement('canvas');
    faceOverlayCanvas.width = faceDrawingCanvas.width;
    faceOverlayCanvas.height = faceDrawingCanvas.height;
    faceOverlayCtx = faceOverlayCanvas.getContext('2d');
    const saved = localStorage.getItem('playerFaceDrawing_' + localPlayerId);
    if (saved) {
        const img = new Image();
        img.onload = () => { faceOverlayCtx.drawImage(img, 0, 0); compositeLayers(); };
        img.src = saved;
    } else { faceOverlayCtx.clearRect(0, 0, faceOverlayCanvas.width, faceOverlayCanvas.height); compositeLayers(); }
    drawFaceCanvasBackground();
    function getCoords(e) {
        const rect = faceDrawingCanvas.getBoundingClientRect();
        const sx = faceDrawingCanvas.width / rect.width, sy = faceDrawingCanvas.height / rect.height;
        let cx, cy;
        if (e.touches) { cx = e.touches[0].clientX; cy = e.touches[0].clientY; }
        else { cx = e.clientX; cy = e.clientY; }
        return { x: Math.max(0, Math.min(faceDrawingCanvas.width, (cx - rect.left) * sx)), y: Math.max(0, Math.min(faceDrawingCanvas.height, (cy - rect.top) * sy)) };
    }
    function start(e) { e.preventDefault(); isDrawingFace = true; const { x, y } = getCoords(e); faceOverlayCtx.beginPath(); faceOverlayCtx.moveTo(x, y); applyMode(); }
    function draw(e) { if (!isDrawingFace) return; e.preventDefault(); const { x, y } = getCoords(e); faceOverlayCtx.lineTo(x, y); faceOverlayCtx.stroke(); compositeLayers(); }
    function stop() { isDrawingFace = false; faceOverlayCtx.beginPath(); }
    function applyMode() {
        if (eraserActiveFace) { faceOverlayCtx.globalCompositeOperation = 'destination-out'; faceOverlayCtx.strokeStyle = 'rgba(0,0,0,1)'; }
        else { faceOverlayCtx.globalCompositeOperation = 'source-over'; faceOverlayCtx.strokeStyle = currentDrawColorFace; }
        faceOverlayCtx.lineWidth = currentBrushSizeFace; faceOverlayCtx.lineCap = 'round'; faceOverlayCtx.lineJoin = 'round';
    }
    faceDrawingCanvas.addEventListener('mousedown', start); faceDrawingCanvas.addEventListener('mousemove', draw);
    faceDrawingCanvas.addEventListener('mouseup', stop); faceDrawingCanvas.addEventListener('mouseleave', stop);
    faceDrawingCanvas.addEventListener('touchstart', start); faceDrawingCanvas.addEventListener('touchmove', draw); faceDrawingCanvas.addEventListener('touchend', stop);
}
function compositeLayers() { if (!faceDrawingCtx || !faceOverlayCtx) return; drawFaceCanvasBackground(); faceDrawingCtx.drawImage(faceOverlayCanvas, 0, 0); }
function drawFaceCanvasBackground() {
    if (!faceDrawingCtx) return;
    const col = (players && players[localPlayerId]) ? players[localPlayerId].color : '#0c0516';
    faceDrawingCtx.fillStyle = col; faceDrawingCtx.fillRect(0, 0, faceDrawingCanvas.width, faceDrawingCanvas.height);
    faceDrawingCtx.strokeStyle = '#fff'; faceDrawingCtx.lineWidth = 2;
    faceDrawingCtx.beginPath(); faceDrawingCtx.arc(faceDrawingCanvas.width / 2, faceDrawingCanvas.height / 2, faceDrawingCanvas.width / 2 - 2, 0, Math.PI * 2); faceDrawingCtx.stroke();
}
function toggleEraserFace() {
    const btn = document.getElementById('eraserBtn');
    if (!eraserActiveFace) { eraserActiveFace = true; lastPenColorFace = currentDrawColorFace; currentDrawColorFace = faceCanvasBgColor; if (btn) { btn.style.backgroundColor = '#ff007f'; btn.style.color = 'white'; btn.innerText = '✏️ PEN MODE'; } }
    else deactivateEraserFace();
    if (faceOverlayCtx) applyMode();
}
function deactivateEraserFace() { eraserActiveFace = false; currentDrawColorFace = lastPenColorFace; const btn = document.getElementById('eraserBtn'); if (btn) { btn.style.backgroundColor = ''; btn.style.color = '#ff007f'; btn.innerText = '🧽 ERASER MODE'; } if (faceOverlayCtx) applyMode(); }
function setDrawColorFace(col) { if (eraserActiveFace) deactivateEraserFace(); currentDrawColorFace = col; }
function setBrushSizeFace(size) { currentBrushSizeFace = parseInt(size); document.getElementById('brushSizeDisplay').innerText = size; }
function resetFaceDrawing() { if (faceOverlayCtx) { faceOverlayCtx.clearRect(0, 0, faceOverlayCanvas.width, faceOverlayCanvas.height); compositeLayers(); } }
function saveFaceDrawing() {
    const data = faceOverlayCanvas.toDataURL('image/png');
    localStorage.setItem('playerFaceDrawing_' + localPlayerId, data);
    localStorage.setItem('playerHasCustomFace_' + localPlayerId, 'true');
    if (isHost) broadcastToRoom('sync_face_drawing', { playerId: localPlayerId, faceData: data });
    else if (hostConnection?.open) hostConnection.send({ type: 'update_face_drawing', senderId: localPlayerId, payload: { faceData: data } });
    closeFaceDrawing(); playSound('door');
}
function openFaceDrawing() { document.getElementById('face-drawing-modal').classList.remove('hidden'); setTimeout(() => { if (!faceDrawingCanvas) initializeFaceCanvas(); else compositeLayers(); }, 10); }
function closeFaceDrawing() { document.getElementById('face-drawing-modal').classList.add('hidden'); }

window.setDrawColor = setDrawColorFace;
window.setBrushSize = setBrushSizeFace;
window.toggleEraser = toggleEraserFace;
window.resetFaceDrawing = resetFaceDrawing;
window.saveFaceDrawing = saveFaceDrawing;
window.openFaceDrawing = openFaceDrawing;
window.closeFaceDrawing = closeFaceDrawing;

enginePipelineTick();