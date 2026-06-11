// ============================================================================
//  SOUND & UI
// ============================================================================

const synth = new Tone.PolySynth(Tone.Synth, { maxPolyphony: 16 }).toDestination();
synth.set({
    oscillator: { type: "square8" },
    envelope: { attack: 0.01, decay: 0.1, sustain: 0.2, release: 0.1 }
});

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
//  SHOOT & THROW ACTIONS (reusable for mouse/keyboard and mobile)
// ============================================================================

function performShoot() {
    if (!localPlayerItem) return;
    if (players[localPlayerId]?.eliminated) return;

    // 🔥 NEW: Prevent using robot hand again if an active grab already exists
    if (localPlayerItem.name === 'robot_hand' && activeRobotHands.some(g => g.holderId === localPlayerId)) {
        console.warn("[RobotHand] Already have an active grab, cannot shoot again.");
        return;
    }

    // Pistol: check ammo
    if (localPlayerItem.name === 'pistol' && localPlayerItem.ammo !== undefined && localPlayerItem.ammo <= 0) {
        if (emptyPistolSound) {
            emptyPistolSound.currentTime = 0;
            emptyPistolSound.play().catch(e => console.warn("Empty pistol sound play failed:", e));
        }
        return;
    }

    if (!localPlayerItem.canUse()) return;

    if (isHost) {
        // Host: the item's onUse method will remove the robot hand automatically
        const gameState = {
            projectiles,
            activeRobotHands,
            mouseWorld: getMouseWorldPos()
        };
        const used = localPlayerItem.onUse(players[localPlayerId], gameState);
        if (used) {
            playPistolSound();
            // For pistol, update ammo; for robot hand, ammo will be 0/undefined
            players[localPlayerId].ammo = localPlayerItem.ammo;
            // Robot hand is already removed inside onUse, so we sync that change
            broadcastToRoom('sync_players', { allPlayers: players });
            // 🔥 CRITICAL: Clear local reference to the item
            localPlayerItem = null;
        } else if (emptyPistolSound) {
            emptyPistolSound.currentTime = 0;
            emptyPistolSound.play().catch(e => console.warn("Empty pistol sound play failed:", e));
        }
    } else {
        // --- Client prediction branch ---
        const isRobotHand = (localPlayerItem.name === 'robot_hand');
        const isPistol = (localPlayerItem.name === 'pistol');

        if (isPistol && localPlayerItem.ammo !== undefined) {
            // Decrement pistol ammo locally
            localPlayerItem.ammo--;
            players[localPlayerId].ammo = localPlayerItem.ammo;
        } else if (isRobotHand) {
            // Single-use: remove robot hand immediately after firing
            players[localPlayerId].item = null;
            players[localPlayerId].itemType = null;
            players[localPlayerId].ammo = 0;
            localPlayerItem = null; // Clear local reference
        }

        const mouseWorld = getMouseWorldPos();
        const angle = calculateHandAngle(players[localPlayerId]);
        hostConnection.send({
            type: 'client_shoot',
            senderId: localPlayerId,
            payload: {
                handAngle: angle,
                ammo: isRobotHand ? 0 : (localPlayerItem?.ammo ?? 0),
                mouseWorld: { x: mouseWorld.x, y: mouseWorld.y }
            }
        });

        // Only apply cooldown if the item still exists (pistol case)
        if (localPlayerItem) {
            localPlayerItem.cooldown = localPlayerItem.cooldownMax;
        }
        playPistolSound();
    }
}

function performThrow() {
    if (!players[localPlayerId] || !players[localPlayerId].item) return;
    if (players[localPlayerId].eliminated) return;
    const angle = calculateHandAngle(players[localPlayerId]);
    if (!isHost && hostConnection?.open) {
        hostConnection.send({ type: 'request_throw_item', senderId: localPlayerId, payload: { angle } });
    } else if (isHost) {
        hostThrowItem(localPlayerId, angle);
    }
}

// ============================================================================
//  GLOBALS & CONSTANTS
// ============================================================================

let itemManager = null;
let localPlayerItem = null;
let projectiles = [];
let activeRobotHands = [];      // Robot hand grab data
let lastRobotHandSnapshot = null;
const THROWABLE_GRAVITY = 0.35;

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

// Canvas render size (fixed)
const BASE_WIDTH = 1280;
const BASE_HEIGHT = 720;
canvas.width = BASE_WIDTH;
canvas.height = BASE_HEIGHT;

// World size (matches map_creator's virtual size)
const WORLD_WIDTH = 3840;
const WORLD_HEIGHT = 2160;

// Camera bounds (per map)
let cameraBounds = { minX: 0, minY: 0, maxX: WORLD_WIDTH, maxY: WORLD_HEIGHT };

// Void threshold (per map) – default 2000 to avoid immediate death
let voidYThreshold = 2000;

const GRAVITY = 0.35;
const FRICTION = 0.85;
const MAX_FALL_SPEED = 10;
const MOVE_SPEED = 3;
const DASH_SPEED = 14;
const BREAK_BOUNDS_OFFSET = 300;

const PISTOL_PROJECTILE_SPEED = 36;
window.PISTOL_PROJECTILE_SPEED = PISTOL_PROJECTILE_SPEED;

let currentEngineMode = 'MENU';
let isHost = false;
let roomCodeString = "";
let timerVal = 60;
let gameTimer = null;

let lobbyCountdownVal = -1;
let lobbyTimerId = null;
let isReturningToLobby = false;

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
let spawnPoints = [];

// Spectator mode
let spectatorMode = false;
let spectatorTargetId = null;
let spectatorCycleButtonsAdded = false;

// Match ending flag to prevent duplicate endings
let matchEndingInProgress = false;

function getAlivePlayers() {
    return Object.values(players).filter(p => !p.eliminated);
}

// Helper to end match if no players left alive
function checkAllPlayersEliminatedAndEndMatch() {
    if (!isHost || currentEngineMode !== 'GAME') return false;
    if (matchEndingInProgress) return false;

    const alive = getAlivePlayers();
    if (alive.length === 0) {
        matchEndingInProgress = true;
        console.log("[MATCH END] All players eliminated. Ending match.");

        // Stop any running timers immediately
        if (gameTimer) {
            clearInterval(gameTimer);
            gameTimer = null;
        }
        if (raceTimerId) {
            clearInterval(raceTimerId);
            raceTimerId = null;
        }

        // Build results with current scores
        let results = [];
        for (let id in players) {
            results.push({
                id,
                nameTag: players[id].nameTag,
                score: players[id].score
            });
        }
        broadcastToRoom('match_over', { summary: results });
        executeMatchEndingSequence(results);
        return true;
    }
    return false;
}

function cycleSpectator(direction) {
    if (!spectatorMode || currentEngineMode !== 'GAME') return;
    const alive = getAlivePlayers();
    if (alive.length === 0) return;
    let currentIndex = alive.findIndex(p => p.id === spectatorTargetId);
    if (currentIndex === -1) currentIndex = 0;
    let newIndex = (currentIndex + direction + alive.length) % alive.length;
    spectatorTargetId = alive[newIndex].id;
    // Update camera immediately
    updateCameraToTarget();
}

function updateCameraToTarget() {
    if (!spectatorMode || !spectatorTargetId) return;
    const target = players[spectatorTargetId];
    if (!target) return;
    let targetCamX = (target.x + target.width / 2) - (BASE_WIDTH / 2) / camera.zoom;
    let targetCamY = (target.y + target.height / 2) - (BASE_HEIGHT / 2) / camera.zoom;
    let maxX = cameraBounds.maxX - BASE_WIDTH / camera.zoom;
    let maxY = cameraBounds.maxY - BASE_HEIGHT / camera.zoom;
    let minX = cameraBounds.minX;
    let minY = cameraBounds.minY;
    targetCamX = Math.max(minX, Math.min(targetCamX, maxX));
    targetCamY = Math.max(minY, Math.min(targetCamY, maxY));
    camera.x = targetCamX;
    camera.y = targetCamY;
}

function repositionAllPlayersToSpawnPoints() {
    if (spawnPoints.length === 0) return;
    // Use the first spawn point for all players
    const sp = spawnPoints[0];
    for (let id in players) {
        players[id].x = sp.x;
        players[id].y = sp.y;
        players[id].vx = 0;
        players[id].vy = 0;
        players[id].isGrounded = true;
        players[id].jumpsLeft = 2;
        players[id].dashCooldown = 0;
        players[id].dashTimer = 0;
        players[id].isDashing = false;
        players[id].dashPushedBy = null;
        players[id].eliminated = false;
        players[id].deathReason = null;
        players[id].knockbackTimer = 0;
        players[id].knockbackVx = 0;
        players[id].knockbackVy = 0;
        players[id].grabbedBy = null;
    }
}

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

// ------------------------------------------------------------------
// TOUCH AIMING (mobile)
// ------------------------------------------------------------------
function getTouchWorldPos(touch) {
    const rect = canvas.getBoundingClientRect();
    const canvasX = (touch.clientX - rect.left) * (canvas.width / rect.width);
    const canvasY = (touch.clientY - rect.top) * (canvas.height / rect.height);
    return {
        x: canvasX / camera.zoom + camera.x,
        y: canvasY / camera.zoom + camera.y
    };
}

function handleTouchAim(e) {
    if (!players[localPlayerId]) return;
    if (players[localPlayerId].eliminated) return;
    e.preventDefault();
    if (e.touches.length === 0) return;
    const touch = e.touches[0];
    const worldPos = getTouchWorldPos(touch);
    const handX = players[localPlayerId].x + players[localPlayerId].width / 2;
    const handY = players[localPlayerId].y + 32;
    const angle = Math.atan2(worldPos.y - handY, worldPos.x - handX);
    players[localPlayerId].handAngle = angle;
}
canvas.addEventListener('touchstart', handleTouchAim);
canvas.addEventListener('touchmove', handleTouchAim);
canvas.addEventListener('touchend', (e) => {
    if (players[localPlayerId] && !players[localPlayerId].eliminated) {
        players[localPlayerId].handAngle = players[localPlayerId].facingRight ? 0 : Math.PI;
    }
});

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
//  ENVIRONMENT SETUP (with camera bounds and void threshold)
// ============================================================================

function setupLobbyEnvironment() {
    if (!itemManager) itemManager = new ItemManager();

    const map = MAPS.lobby;
    platforms = map.platforms || [];
    hazards = map.hazards || [];
    gems = map.gems || [];

    if (map.scoreboard) {
        window.lobbyScoreboardPos = { x: map.scoreboard.x, y: map.scoreboard.y, w: map.scoreboard.w, h: map.scoreboard.h };
    } else {
        window.lobbyScoreboardPos = { x: 50, y: 50, w: 250, h: 200 };
    }


    // Read spawn points from map
    spawnPoints = (map.spawnPoints || []).map(sp => ({ x: sp.x, y: sp.y }));
    if (spawnPoints.length === 0) {
        spawnPoints = [
            { x: 100, y: 500 }, { x: 200, y: 500 }, { x: 300, y: 500 },
            { x: 400, y: 500 }, { x: 500, y: 500 }, { x: 600, y: 500 }
        ];
    }
    if (map.doors) {
        if (map.doors.skinDoor) Object.assign(skinDoor, map.doors.skinDoor);
        if (map.doors.lobbyDoor) Object.assign(lobbyDoor, map.doors.lobbyDoor);
    }
    // Spawn items from map
    if (map.items && Array.isArray(map.items)) {
        itemManager.worldItems = [];
        for (let item of map.items) {
            itemManager.spawnItem(item.x, item.y, item.itemType, item.initialDelay || 0, item.shouldRespawn !== false, item.ammo || 3);
        }
    } else {
        // default pistol for lobby (only if no items defined)
        itemManager.worldItems = [];
        itemManager.spawnItem(300, 580, 'pistol', 0, true, 3);
    }
    // Set camera bounds
    cameraBounds = map.cameraBounds || { minX: 0, minY: 0, maxX: WORLD_WIDTH, maxY: WORLD_HEIGHT };
    // Set void threshold
    voidYThreshold = (map.voidYThreshold !== undefined) ? map.voidYThreshold : 2000;
}

function setupActiveMatchEnvironment() {
    const map = MAPS.match;
    platforms = map.platforms || [];
    hazards = map.hazards || [];
    gems = (map.gems || []).map(g => ({ ...g, collected: false }));
    // Read spawn points
    spawnPoints = (map.spawnPoints || []).map(sp => ({ x: sp.x, y: sp.y }));
    if (spawnPoints.length === 0) {
        spawnPoints = [{ x: 100, y: 400 }, { x: 150, y: 400 }, { x: 200, y: 400 }];
    }
    if (map.finishLine) Object.assign(finishLine, map.finishLine);
    // Items from map
    if (map.items && Array.isArray(map.items) && itemManager) {
        itemManager.worldItems = [];
        for (let item of map.items) {
            itemManager.spawnItem(item.x, item.y, item.itemType, item.initialDelay || 0, item.shouldRespawn !== false, item.ammo || 3);
        }
    } else if (itemManager) {
        // optional default items (none by default)
        itemManager.worldItems = [];
    }
    cameraBounds = map.cameraBounds || { minX: 0, minY: 0, maxX: WORLD_WIDTH, maxY: WORLD_HEIGHT };
    voidYThreshold = (map.voidYThreshold !== undefined) ? map.voidYThreshold : 2000;
}

// ------------------------------------------------------------------
// HOST LOBBY RESET FUNCTION (with version)
// ------------------------------------------------------------------
function hostResetLobby() {
    if (!isHost || currentEngineMode !== 'LOBBY') return;

    projectiles = [];
    throwables = [];
    activeRobotHands = [];
    lastThrowableSnapshot = null;
    lastProjectileSnapshot = null;
    lastRobotHandSnapshot = null;

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

    readyPlayers = {};
    localPlayerItem = null;
    resetVersion++;
    broadcastToRoom('sync_players', { allPlayers: players, reset: true });
    broadcastToRoom('sync_ready_players', { readyPlayers });
    broadcastToRoom('sync_map', { platforms, hazards, gems, cameraBounds, voidYThreshold });
    broadcastWorldItems();
    broadcastToRoom('sync_throwables', { throwables });
    broadcastProjectiles();
    broadcastRobotHands();
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
    if (player.x < 0) player.x = 0;
    if (player.x + player.width > WORLD_WIDTH) player.x = WORLD_WIDTH - player.width;
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
        eliminated: false,
        deathReason: null,
        knockbackTimer: 0,
        knockbackVx: 0,
        knockbackVy: 0,
        grabbedBy: null
    };
}

// ============================================================================
//  VOID DEATH HANDLING
// ============================================================================

function voidRespawnLobby(player) {
    console.warn(`[VOID RESPAWN LOBBY] ${player.id} fell below ${voidYThreshold} from (${player.x},${player.y})`);
    if (spawnPoints.length === 0) {
        player.x = 100;
        player.y = 500;
    } else {
        const playerIds = Object.keys(players);
        const playerIndex = playerIds.indexOf(player.id);
        const idx = playerIndex % spawnPoints.length;
        const sp = spawnPoints[idx];
        player.x = sp.x;
        player.y = sp.y;
    }
    player.vx = 0;
    player.vy = 0;
    player.isGrounded = true;
    player.jumpsLeft = 2;
    player.dashCooldown = 0;
    player.dashTimer = 0;
    player.isDashing = false;
    player.dashPushedBy = null;
    player.knockbackTimer = 0;
    player.knockbackVx = 0;
    player.knockbackVy = 0;
    playSound('spike');
}

function voidEliminateGame(player, reason) {
    if (player.eliminated) return;
    player.eliminated = true;
    player.deathReason = reason || 'unknown';
    player.item = null;
    player.itemType = null;
    player.ammo = 0;
    player.knockbackTimer = 0;
    // Clear any active grab involving this player
    if (isHost) {
        activeRobotHands = activeRobotHands.filter(g => g.holderId !== player.id && g.targetId !== player.id);
        for (let id in players) {
            if (players[id].grabbedBy === player.id) players[id].grabbedBy = null;
        }
        broadcastRobotHands();
    }
    playSound('spike');
    console.log(`[ELIMINATED] ${player.id} (${player.nameTag}) eliminated. Reason: ${player.deathReason}. Remaining alive: ${getAlivePlayers().length}`);

    // If local player eliminated, enter spectator mode
    if (player.id === localPlayerId && currentEngineMode === 'GAME') {
        spectatorMode = true;
        const alive = getAlivePlayers();
        if (alive.length > 0) {
            spectatorTargetId = alive[0].id;
            updateCameraToTarget();
        }
        document.getElementById('spectator-controls')?.classList.remove('hidden');
    }
    // Host: check if all players eliminated (immediate match end)
    if (isHost && currentEngineMode === 'GAME') {
        checkAllPlayersEliminatedAndEndMatch();
    }
}

function checkVoidDeath() {
    if (currentEngineMode !== 'LOBBY' && currentEngineMode !== 'GAME') return;
    const isGame = (currentEngineMode === 'GAME');
    for (let id in players) {
        const p = players[id];
        if (p.eliminated) continue;
        if (p.y > voidYThreshold) {
            if (!isGame) voidRespawnLobby(p);
            else voidEliminateGame(p, 'fell into void');
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
        radius: 12,
        life: 300,
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

function broadcastRobotHands() {
    if (!isHost) return;
    const snap = JSON.stringify(activeRobotHands);
    if (snap === lastRobotHandSnapshot) return;
    lastRobotHandSnapshot = snap;
    console.log(`[RobotHand] Broadcasting activeRobotHands: ${activeRobotHands.length} entries`);
    broadcastToRoom('sync_robot_hands', { activeRobotHands });
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

function hostCheckHazardsForAllPlayers() {
    if (!isHost || currentEngineMode !== 'GAME') return;
    for (let id in players) {
        const p = players[id];
        if (p.eliminated) continue;
        // Check hazards
        for (let h of hazards) {
            if (checkCollision(p, h)) {
                voidEliminateGame(p, 'touched a hazard');
                break;
            }
        }
    }
    // void is already handled by checkVoidDeath() but call it again for safety
    checkVoidDeath();
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
        const spawnIndex = Object.keys(players).length % spawnPoints.length;
        const sp = spawnPoints[spawnIndex];
        players[newId] = createPlayerProfile(newId, claimSlot(newId));
        players[newId].x = sp.x;
        players[newId].y = sp.y;
        updateHudDisplays();

        const safePlayers = {};
        for (let id in players) {
            safePlayers[id] = { ...players[id] };
            delete safePlayers[id].item;
            safePlayers[id].eliminated = players[id].eliminated;
            safePlayers[id].grabbedBy = players[id].grabbedBy;  // ✅ sync grabbed state
        }
        conn.send({
            type: 'init_welcome',
            payload: { assignedId: newId, allPlayers: safePlayers, mode: currentEngineMode, readyPlayers, resetVersion }
        });

        broadcastToRoom('sync_map', { platforms, hazards, gems, cameraBounds, voidYThreshold });
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
                        players[pkg.senderId].itemType = picked.name === 'pistol' ? 'pistol' : 'robot_hand';
                        players[pkg.senderId].ammo = picked.ammo;
                        broadcastToRoom('sync_players', { allPlayers: players });
                        broadcastWorldItems();
                    }
                }
                break;
            case 'client_shoot':
                if (players[pkg.senderId]) {
                    const player = players[pkg.senderId];
                    if (pkg.payload.ammo !== undefined) {
                        if (player.item) player.item.ammo = pkg.payload.ammo;
                        player.ammo = pkg.payload.ammo;
                    }
                    if (player.item && player.item.canUse()) {
                        const gameState = {
                            projectiles,
                            activeRobotHands,
                            mouseWorld: pkg.payload.mouseWorld || null
                        };
                        const used = player.item.onUse(player, gameState);
                        if (used) {
                            playSound('door');
                            broadcastToRoom('sync_players', { allPlayers: players });
                        }
                    }
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
            case 'room_full':
                alert("Room is full (max 6 players)!");
                cancelConnection();
                break;

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
                    } else if (players[id].itemType === 'robot_hand') {
                        if (!players[id].item || players[id].item.constructor !== RobotHandItem) {
                            players[id].item = new RobotHandItem();
                            players[id].item.ammo = players[id].ammo;
                        } else {
                            players[id].item.ammo = players[id].ammo;
                        }
                    } else {
                        players[id].item = null;
                    }
                }
                if (players[localPlayerId] && players[localPlayerId].item)
                    localPlayerItem = players[localPlayerId].item;
                else
                    localPlayerItem = null;
                break;

            case 'sync_players': {
                const isReset = pkg.payload.reset === true;
                const newVersion = pkg.payload.resetVersion;
                if (newVersion !== undefined && newVersion !== clientResetVersion) {
                    clientResetVersion = newVersion;
                }

                // Update other players
                for (let id in pkg.payload.allPlayers) {
                    const data = pkg.payload.allPlayers[id];
                    if (id !== localPlayerId) {
                        if (!players[id]) {
                            players[id] = data;
                        } else {
                            players[id].x = data.x;
                            players[id].y = data.y;
                            players[id].vx = data.vx;
                            players[id].vy = data.vy;
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
                            players[id].deathReason = data.deathReason || null;
                        }
                    }
                }

                // Update local player
                if (pkg.payload.allPlayers[localPlayerId]) {
                    const local = pkg.payload.allPlayers[localPlayerId];

                    // --- FULL RESET (entire state overwritten) ---
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
                        players[localPlayerId].deathReason = local.deathReason || null;
                        players[localPlayerId].grabbedBy = local.grabbedBy;

                        // Reset input & spectator mode
                        keys.ArrowLeft = false;
                        keys.ArrowRight = false;
                        keys.ArrowUp = false;

                        spectatorMode = false;
                        spectatorTargetId = null;
                        document.getElementById('spectator-controls')?.classList.add('hidden');

                        // Reset camera
                        let initCamX = local.x - BASE_WIDTH / 2;
                        let initCamY = local.y - BASE_HEIGHT / 2;
                        let maxX = cameraBounds.maxX - BASE_WIDTH / camera.zoom;
                        let maxY = cameraBounds.maxY - BASE_HEIGHT / camera.zoom;
                        initCamX = Math.max(cameraBounds.minX, Math.min(initCamX, maxX));
                        initCamY = Math.max(cameraBounds.minY, Math.min(initCamY, maxY));
                        camera.x = initCamX;
                        camera.y = initCamY;

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

                    // --- CRITICAL: If grabbed, always accept host position & physics ---
                    if (local.grabbedBy) {
                        players[localPlayerId].x = local.x;
                        players[localPlayerId].y = local.y;
                        players[localPlayerId].vx = local.vx;
                        players[localPlayerId].vy = local.vy;
                        players[localPlayerId].isGrounded = local.isGrounded;
                        players[localPlayerId].facingRight = local.facingRight;
                        players[localPlayerId].isDashing = local.isDashing;
                        players[localPlayerId].handAngle = local.handAngle;
                        players[localPlayerId].grabbedBy = local.grabbedBy;
                    }

                    // Update non‑positional attributes (always)
                    players[localPlayerId].grabbedBy = local.grabbedBy;
                    players[localPlayerId].score = local.score;
                    players[localPlayerId].color = local.color;
                    players[localPlayerId].itemType = local.itemType;
                    players[localPlayerId].finished = local.finished;
                    players[localPlayerId].finishTime = local.finishTime;
                    players[localPlayerId].ammo = local.ammo;
                    players[localPlayerId].eliminated = local.eliminated || false;
                    players[localPlayerId].deathReason = local.deathReason || null;
                }

                // Reconstruct items for all players
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
                    } else if (players[id].itemType === 'robot_hand') {
                        if (!players[id].item || players[id].item.constructor !== RobotHandItem) {
                            players[id].item = new RobotHandItem();
                            players[id].item.ammo = players[id].ammo;
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

                if (players[localPlayerId] && players[localPlayerId].item)
                    localPlayerItem = players[localPlayerId].item;
                else
                    localPlayerItem = null;

                updateHudDisplays();
                updateColorButtonStates();
                break;
            }

            case 'sync_throwables':
                throwables = pkg.payload.throwables;
                break;

            case 'sync_robot_hands':
                activeRobotHands = pkg.payload.activeRobotHands;
                console.log(`[RobotHand] Client received ${activeRobotHands.length} active hands`);
                break;

            case 'sync_map':
                platforms = pkg.payload.platforms;
                hazards = pkg.payload.hazards;
                gems = pkg.payload.gems;
                if (pkg.payload.cameraBounds) {
                    cameraBounds = pkg.payload.cameraBounds;
                }
                if (pkg.payload.voidYThreshold !== undefined) {
                    voidYThreshold = pkg.payload.voidYThreshold;
                }
                break;

            case 'sync_lobby_countdown':
                lobbyCountdownVal = pkg.payload.value;
                break;

            case 'sync_ready_players':
                readyPlayers = pkg.payload.readyPlayers;
                break;

            case 'sync_face_drawing':
                localStorage.setItem('playerFaceDrawing_' + pkg.payload.playerId, pkg.payload.faceData);
                localStorage.setItem('playerHasCustomFace_' + pkg.payload.playerId, 'true');
                break;

            case 'trigger_match_start':
                executeActiveMatchStart();
                break;

            case 'sync_timer':
                timerVal = pkg.payload.time;
                document.getElementById('timer').innerText = timerVal;
                break;

            case 'match_over':
                executeMatchEndingSequence(pkg.payload.summary);
                break;

            case 'return_to_lobby':
                executeLobbyReturnSequence();
                break;

            case 'sync_race_start':
                raceCountdownVal = pkg.payload.raceCountdownVal;
                firstPlayerFinishTime = Date.now();
                break;

            case 'sync_race_countdown':
                raceCountdownVal = pkg.payload.value;
                break;

            case 'sync_world_items':
                if (itemManager) itemManager.syncFromData(pkg.payload.items);
                break;

            case 'sync_projectiles':
                projectiles = pkg.payload.projectiles;
                break;
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
            safe[id].deathReason = payload.allPlayers[id].deathReason || null;
            safe[id].grabbedBy = payload.allPlayers[id].grabbedBy || null;   // ✅ ADD THIS LINE
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
    repositionAllPlayersToSpawnPoints();
    // Reset spectator mode
    spectatorMode = false;
    spectatorTargetId = null;
    document.getElementById('spectator-controls')?.classList.add('hidden');
    // Immediately set camera to local player's position (clamped to bounds)
    if (players[localPlayerId]) {
        let targetX = players[localPlayerId].x + players[localPlayerId].width / 2 - BASE_WIDTH / 2 / camera.zoom;
        let targetY = players[localPlayerId].y + players[localPlayerId].height / 2 - BASE_HEIGHT / 2 / camera.zoom;
        let maxX = cameraBounds.maxX - BASE_WIDTH / camera.zoom;
        let maxY = cameraBounds.maxY - BASE_HEIGHT / camera.zoom;
        let minX = cameraBounds.minX;
        let minY = cameraBounds.minY;
        camera.x = Math.max(minX, Math.min(targetX, maxX));
        camera.y = Math.max(minY, Math.min(targetY, maxY));
    }
    timerVal = 60;                         // reset match timer display
    document.getElementById('timer').innerText = timerVal;
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

    // Clear any leftover projectiles, throwables, particles, robot hands
    projectiles = [];
    throwables = [];
    activeRobotHands = [];
    particles = [];
    lastThrowableSnapshot = null;
    lastProjectileSnapshot = null;
    lastRobotHandSnapshot = null;

    // Use the first spawn point for all players
    const sp = spawnPoints[0];
    for (let id in players) {
        players[id].x = sp.x;
        players[id].y = sp.y;
        players[id].vx = 0;
        players[id].vy = 0;
        players[id].finished = false;
        players[id].finishTime = -1;
        players[id].eliminated = false;
        players[id].deathReason = null;
        players[id].knockbackTimer = 0;
        players[id].knockbackVx = 0;
        players[id].knockbackVy = 0;
        players[id].item = null;
        players[id].itemType = null;
        players[id].ammo = 0;
        players[id].grabbedBy = null;
    }

    // Reset local player's item reference
    localPlayerItem = null;

    // Reset spectator mode
    spectatorMode = false;
    spectatorTargetId = null;
    document.getElementById('spectator-controls')?.classList.add('hidden');

    // Reset match ending flag for new match
    matchEndingInProgress = false;

    if (isHost) {
        timerVal = 60;
        if (gameTimer) clearInterval(gameTimer);
        gameTimer = setInterval(() => {
            timerVal--;
            broadcastToRoom('sync_timer', { time: timerVal });
            document.getElementById('timer').innerText = timerVal;

            if (timerVal <= 0) {
                clearInterval(gameTimer);
                gameTimer = null;

                if (raceTimerId) {
                    clearInterval(raceTimerId);
                    raceTimerId = null;
                }

                // Gather final results safely even if nobody reached the finish line
                let results = [];
                for (let id in players) {
                    results.push({ id, nameTag: players[id].nameTag, score: players[id].score });
                }
                broadcastToRoom('match_over', { summary: results });
                executeMatchEndingSequence(results);
            }
        }, 1000);
    }

    // Log available debug commands
    console.log("%c[UHCC] Match started! Available debug commands:", "color: #00f2fe; font-weight: bold;");
    console.log("  forceStartMatch()   - Force start match (host only)");
    console.log("  forceHostResetLobby() - Reset lobby (host only)");
    console.log("  status()            - Show player status (alive/dead, reason, score, position)");
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

let lobbyReturnTimeout = null;

function executeMatchEndingSequence(summary) {
    // Stop match timers
    if (gameTimer) {
        clearInterval(gameTimer);
        gameTimer = null;
    }
    if (raceTimerId) {
        clearInterval(raceTimerId);
        raceTimerId = null;
    }

    const overlay = document.getElementById('gameover-overlay');
    const resText = document.getElementById('match-result');
    const waitingMsg = document.getElementById('waiting-for-host');
    const backBtn = document.getElementById('back-to-lobby-btn');

    overlay.classList.remove('hidden');

    // Sort and display results
    summary.sort((a, b) => b.score - a.score);
    let resultText = "🏁 MATCH OVER\n";
    resultText += summary.slice(0, 3).map((s, i) => `${['🥇', '🥈', '🥉'][i]} ${s.nameTag}: ${s.score} pts`).join('\n');
    resText.innerText = resultText;

    if (isHost) {
        // Host shows the button, hides waiting message
        waitingMsg.classList.add('hidden');
        backBtn.classList.remove('hidden');
        if (lobbyReturnTimeout) clearTimeout(lobbyReturnTimeout);
        lobbyReturnTimeout = setTimeout(() => backToInteractiveLobby(), 5000);
    } else {
        // Client: hide the button, show waiting message
        backBtn.classList.add('hidden');
        waitingMsg.classList.remove('hidden');
    }
}

function backToInteractiveLobby() {
    if (!isHost) return;
    if (lobbyReturnTimeout) clearTimeout(lobbyReturnTimeout);
    lobbyReturnTimeout = null;
    broadcastToRoom('return_to_lobby');
    executeLobbyReturnSequence();
}

function executeLobbyReturnSequence() {
    // Prevent re‑entrancy
    if (isReturningToLobby) return;
    isReturningToLobby = true;

    matchEndingInProgress = false;

    // Hide game over overlay
    document.getElementById('gameover-overlay').classList.add('hidden');

    // Stop any remaining match timers
    if (gameTimer) {
        clearInterval(gameTimer);
        gameTimer = null;
    }
    if (raceTimerId) {
        clearInterval(raceTimerId);
        raceTimerId = null;
    }

    // Reset match-specific flags
    raceStarted = false;
    firstPlayerFinishTime = -1;
    raceCountdownVal = -1;
    finishPositions = [];

    // Reset all players for lobby
    for (let id in players) {
        players[id].eliminated = false;
        players[id].finished = false;
        players[id].finishTime = -1;
        players[id].score = 0;
        players[id].item = null;
        players[id].itemType = null;
        players[id].ammo = 0;
        players[id].knockbackTimer = 0;
        players[id].knockbackVx = 0;
        players[id].knockbackVy = 0;
        players[id].deathReason = null;
        players[id].grabbedBy = null;
    }

    // Reset spectator mode
    spectatorMode = false;
    spectatorTargetId = null;

    // Enter lobby state (reloads map, positions players, etc.)
    enterLobbyState();

    // Ensure the host broadcasts the reset state to any clients
    if (isHost) {
        broadcastToRoom('sync_players', { allPlayers: players, reset: true });
        broadcastToRoom('sync_lobby_countdown', { value: -1 });
    }

    updateResetButtonVisibility();

    // Release the lock after a short delay
    setTimeout(() => { isReturningToLobby = false; }, 500);
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

                const sep = minOverlap / 2;
                if (minOverlap === overlapLeft || minOverlap === overlapRight) {
                    if (minOverlap === overlapLeft) {
                        p1.x -= sep;
                        p2.x += sep;
                    } else {
                        p1.x += sep;
                        p2.x -= sep;
                    }
                } else {
                    if (minOverlap === overlapTop) {
                        p1.y -= sep;
                        p2.y += sep;
                    } else {
                        p1.y += sep;
                        p2.y -= sep;
                    }
                    if (p1.vy > 0 && p2.vy < 0) { p1.vy = 0; p2.vy = 0; }
                }

                const MAX_PUSH = 18;
                p1.vx = Math.min(MAX_PUSH, Math.max(-MAX_PUSH, p1.vx));
                p2.vx = Math.min(MAX_PUSH, Math.max(-MAX_PUSH, p2.vx));
            }
        }
    }
}

// ============================================================================
//  KNOCKBACK PRIORITY (overrides movement, dash, jump)
// ============================================================================

function resolvePlatformCollision(player) {
    for (let plat of platforms) {
        if (player.x < plat.x + plat.w && player.x + player.width > plat.x &&
            player.y < plat.y + plat.h && player.y + player.height > plat.y) {
            // Vertical overlap handling (most common after grab)
            const topOverlap = (player.y + player.height) - plat.y;
            const bottomOverlap = (plat.y + plat.h) - player.y;
            const leftOverlap = (player.x + player.width) - plat.x;
            const rightOverlap = (plat.x + plat.w) - player.x;
            const minOverlap = Math.min(topOverlap, bottomOverlap, leftOverlap, rightOverlap);

            if (minOverlap === topOverlap && player.vy >= 0) {
                // Land on top of platform
                player.y = plat.y - player.height;
                player.isGrounded = true;
                player.vy = 0;
            } else if (minOverlap === bottomOverlap && player.vy <= 0) {
                player.y = plat.y + plat.h;
                player.vy = 0;
            } else if (minOverlap === leftOverlap) {
                player.x = plat.x - player.width;
            } else if (minOverlap === rightOverlap) {
                player.x = plat.x + plat.w;
            }
        }
    }
    // Additional safety: if still overlapping, force a simple upward push
    for (let plat of platforms) {
        if (player.x < plat.x + plat.w && player.x + player.width > plat.x &&
            player.y < plat.y + plat.h && player.y + player.height > plat.y) {
            player.y = plat.y - player.height;
            player.isGrounded = true;
            player.vy = 0;
        }
    }
}

function updateCharacterPhysics(player, dt) {
    if (player.eliminated) return;

    // If grabbed by robot hand, host controls everything – freeze completely
    if (player.grabbedBy) {
        player.vx = 0;
        player.vy = 0;
        return;
    }

    const isGrabbed = false; // keep for compatibility

    // --- KNOCKBACK TAKES PRIORITY ---
    let isKnockedBack = false;
    if (player.knockbackTimer > 0) {
        player.knockbackTimer -= dt;
        player.vx = player.knockbackVx;
        player.vy = player.knockbackVy;
        player.knockbackVx *= 0.95;
        player.knockbackVy *= 0.95;
        if (player.knockbackTimer <= 0) {
            player.knockbackTimer = 0;
            player.knockbackVx = 0;
            player.knockbackVy = 0;
        }
        isKnockedBack = true;
    }

    // --- Input / Dash / Jump ---
    if (!isKnockedBack) {
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

        // Jump
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
    }

    // --- Platform collisions (horizontal sides) ---
    platforms.forEach(plat => {
        if (checkCollision(player, plat)) {
            const verticalOverlap = (player.y + player.height > plat.y && player.y < plat.y + plat.h);
            if (verticalOverlap && player.vx !== 0) {
                const oldX = player.x;
                let newX = player.x;
                if (player.vx > 0) {
                    newX = plat.x - player.width;
                } else if (player.vx < 0) {
                    newX = plat.x + plat.w;
                }
                if (Math.abs(newX - oldX) <= 30) {
                    player.x = newX;
                    player.vx = 0;
                    if (player.isDashing) player.isDashing = false;
                }
            }
        }
    });

    // --- Vertical movement and landing ---
    player.y += player.vy * dt;
    let landed = false;
    platforms.forEach(plat => {
        if (checkCollision(player, plat)) {
            if (player.vy > 0) {
                const bottomDiff = (player.y + player.height) - plat.y;
                if (bottomDiff >= 0 && bottomDiff <= 10) {
                    const horizontalOverlap = Math.min(player.x + player.width - plat.x, plat.x + plat.w - player.x);
                    if (horizontalOverlap > player.width * 0.3) {
                        player.y = plat.y - player.height;
                        player.isGrounded = true;
                        landed = true;
                        player.vy = 0;
                    }
                }
            } else if (player.vy < 0) {
                const topDiff = plat.y + plat.h - player.y;
                if (topDiff >= 0 && topDiff <= 10) {
                    player.y = plat.y + plat.h;
                    player.vy = 0;
                }
            }
        }
    });

    // WORLD BOUNDARIES
    if (player.x < 0) player.x = 0;
    if (player.x + player.width > WORLD_WIDTH) player.x = WORLD_WIDTH - player.width;

    // VOID CHECK
    const BOTTOM_DEATH_Y = 2200;
    if (player.y > BOTTOM_DEATH_Y) {
        if (currentEngineMode === 'GAME') {
            if (!player.eliminated) voidEliminateGame(player, 'fell into void');
            player.vx = 0;
            player.vy = 0;
        } else {
            voidRespawnLobby(player);
        }
        return;
    }

    // HAZARDS
    hazards.forEach(h => {
        if (checkCollision(player, h)) {
            player.isDashing = false;
            if (currentEngineMode === 'GAME') voidEliminateGame(player, 'touched a hazard');
            else respawnMatchEntity(player);
        }
    });

    // GEMS
    gems.forEach(g => {
        if (!g.collected && checkCircleCollision(player, g)) {
            if (isHost) processGemCapture(g.id, player.id);
            else hostConnection.send({ type: 'request_collect_gem', senderId: localPlayerId, payload: { gemId: g.id } });
        }
    });

    // PLAYER-ON-PLAYER LANDING
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
        broadcastToRoom('sync_map', { platforms, hazards, gems, cameraBounds, voidYThreshold });
        broadcastToRoom('sync_players', { allPlayers: players });
        updateHudDisplays();
    }
}

function respawnMatchEntity(player) {
    if (spawnPoints.length === 0) {
        player.x = 100;
        player.y = 200;
    } else {
        const playerIds = Object.keys(players);
        const playerIndex = playerIds.indexOf(player.id);
        const idx = playerIndex % spawnPoints.length;
        const sp = spawnPoints[idx];
        player.x = sp.x;
        player.y = sp.y;
    }
    player.vx = 0;
    player.vy = 0;
    player.score = Math.max(0, player.score - 5);
    player.knockbackTimer = 0;
    player.knockbackVx = 0;
    player.knockbackVy = 0;
    playSound('spike');
    if (isHost) {
        broadcastToRoom('sync_players', { allPlayers: players });
        updateHudDisplays();
    }
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
    // Use canvas pixel coordinates (0-1280, 0-720)
    const pos = window.lobbyScoreboardPos || { x: 50, y: 50, w: 250, h: 200 };
    let x = pos.x, y = pos.y, w = pos.w, h = pos.h;

    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = '#00f2fe';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);
    ctx.fillStyle = '#00f2fe';
    ctx.font = 'bold 14px "Orbitron"';
    ctx.textAlign = 'left';
    ctx.fillText('📊 Scoreboard', x + 10, y + 25);

    const sorted = Object.values(players).sort((a, b) => b.score - a.score);
    ctx.font = '12px "Orbitron"';
    sorted.slice(0, 5).forEach((pl, idx) => {
        const yy = y + 45 + idx * 30;
        ctx.fillStyle = pl.color;
        ctx.beginPath();
        ctx.arc(x + 15, yy, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.fillText(`${pl.nameTag}:`, x + 30, yy + 4);
        ctx.fillStyle = '#ffff00';
        ctx.textAlign = 'right';
        ctx.fillText(`${pl.score} pt`, x + w - 15, yy + 4);
        ctx.textAlign = 'left';
    });
}

// Robot hand stretched parts (global, used in drawCanvasLevelLayout)
let robotHandBaseImg = new Image();
robotHandBaseImg.src = 'assets/items/robot_hand_base.svg';
let robotHandArmImg = new Image();
robotHandArmImg.src = 'assets/items/robot_hand_arm.svg';
let robotHandClawImg = new Image();
robotHandClawImg.src = 'assets/items/robot_hand_claw.svg';

function drawCanvasLevelLayout() {
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

    // Draw active robot hands using SVG parts (BASE PART REMOVED)
    for (let grab of activeRobotHands) {
        const holder = players[grab.holderId];
        if (!holder) continue;

        const startX = holder.x + holder.width * 0.5;
        const startY = holder.y + 32;
        const endX = grab.headX || (startX + Math.cos(grab.angle) * 400 * (grab.progress ?? 0));
        const endY = grab.headY || (startY + Math.sin(grab.angle) * 400 * (grab.progress ?? 0));
        const angle = Math.atan2(endY - startY, endX - startX);
        const length = Math.hypot(endX - startX, endY - startY);

        ctx.save();

        // Part 2: stretchable arm (scaled horizontally to length)
        if (robotHandArmImg.complete && robotHandArmImg.naturalWidth > 0 && length > 0) {
            ctx.save();
            ctx.translate(startX, startY);
            ctx.rotate(angle);
            const imgW = robotHandArmImg.width;
            const imgH = robotHandArmImg.height / 10;
            const scaleX = length / imgW;
            ctx.scale(scaleX, 1);
            ctx.drawImage(robotHandArmImg, 0, -imgH / 2, imgW, imgH);
            ctx.restore();
        }

        // Part 3: claw at the tip
        if (robotHandClawImg.complete && robotHandClawImg.naturalWidth > 0) {
            ctx.save();
            ctx.translate(endX, endY);
            ctx.rotate(angle - 90 * Math.PI / 180);
            ctx.drawImage(robotHandClawImg, -38, -16, 64, 32);
            ctx.restore();
        } else {
            // fallback (if image missing)
            ctx.fillStyle = '#ff66cc';
            ctx.beginPath();
            ctx.arc(endX, endY, 12, 0, Math.PI * 2);
            ctx.fill();
            for (let ang = 0; ang < Math.PI * 2; ang += Math.PI / 4) {
                const spikeX = endX + Math.cos(ang) * 16;
                const spikeY = endY + Math.sin(ang) * 16;
                ctx.beginPath();
                ctx.moveTo(endX, endY);
                ctx.lineTo(spikeX, spikeY);
                ctx.lineWidth = 3;
                ctx.strokeStyle = '#ffffff';
                ctx.stroke();
            }
        }
        ctx.restore();
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
    let handAngle;
    if (p.id === localPlayerId && !spectatorMode) {
        handAngle = calculateHandAngle(p);
    } else {
        handAngle = p.handAngle !== undefined ? p.handAngle : (facingRight ? 0 : Math.PI);
    }
    ctx.save(); ctx.translate(handPivotX, handPivotY); ctx.rotate(handAngle);
    ctx.fillStyle = p.color; roundedRect(ctx, 0, -3, 18, 6, 3); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.arc(24, 0, 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.restore();

    if (p.item && !p.eliminated) {
        const handX = handPivotX + Math.cos(handAngle) * 33;
        const handY = handPivotY + Math.sin(handAngle) * 33;
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
    if (p.eliminated) label += ' 💀';
    ctx.fillText(label, p.x + p.width / 2, p.y - 20);
    if (p.isGrounded && p.vy > 5 && !p.isDashing) spawnDustParticles(p.x, p.y + p.height);
}

function updateAndRenderParticles() {
    for (let i = particles.length - 1; i >= 0; i--) {
        let p = particles[i];
        p.x += p.vx;
        p.y += p.vy;
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
//  MAIN GAME LOOP (with camera bounds)
// ============================================================================

function enginePipelineTick(timestamp) {
    if (!lastTime) lastTime = timestamp;
    let dt = (timestamp - lastTime) / 16.666;
    lastTime = timestamp;
    if (dt > 3.0) dt = 3.0;
    ctx.fillStyle = '#24212a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (currentEngineMode === 'LOBBY' || currentEngineMode === 'GAME') {
        let localPlayer = players[localPlayerId];

        // --- CRITICAL: Death checks MUST run for ALL players every frame, regardless of spectator status ---
        if (isHost && currentEngineMode === 'GAME') {
            hostCheckHazardsForAllPlayers();
        }
        checkVoidDeath();
        // After death checks, evaluate match end
        if (isHost && currentEngineMode === 'GAME') {
            checkAllPlayersEliminatedAndEndMatch();
        }

        if (localPlayer && !spectatorMode) {
            updateCharacterPhysics(localPlayer, dt);
            resolvePlayerCollisions();
            if (currentEngineMode === 'GAME' && isHost) checkAndProcessRaceFinish();
            if (isHost) {
                evaluateLobbyDoorTrigger();
                localPlayer.handAngle = calculateHandAngle(localPlayer);
                broadcastToRoom('sync_players', { allPlayers: players });
            } else {
                // Do NOT send input updates if the local player is grabbed – host controls position
                if (!localPlayer.grabbedBy) {
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
            }

            if (itemManager) {
                itemManager.update();
                if (isHost && localPlayer) {
                    const picked = itemManager.checkPickup(localPlayer);
                    if (picked) {
                        players[localPlayerId].item = picked;
                        players[localPlayerId].itemType = picked.name === 'pistol' ? 'pistol' : 'robot_hand';
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
        } else if (localPlayer && spectatorMode) {
            if (spectatorTargetId && players[spectatorTargetId]) {
                updateCameraToTarget();
            } else {
                const alive = getAlivePlayers();
                if (alive.length > 0) {
                    spectatorTargetId = alive[0].id;
                    updateCameraToTarget();
                }
            }
        }
        camera.zoom += (camera.targetZoom - camera.zoom) * 0.1 * dt;
        if (!spectatorMode && players[localPlayerId]) {
            let targetCamX = (players[localPlayerId].x + players[localPlayerId].width / 2) - (BASE_WIDTH / 2) / camera.zoom;
            let targetCamY = (players[localPlayerId].y + players[localPlayerId].height / 2) - (BASE_HEIGHT / 2) / camera.zoom;
            let maxX = cameraBounds.maxX - BASE_WIDTH / camera.zoom;
            let maxY = cameraBounds.maxY - BASE_HEIGHT / camera.zoom;
            let minX = cameraBounds.minX;
            let minY = cameraBounds.minY;
            targetCamX = Math.max(minX, Math.min(targetCamX, maxX));
            targetCamY = Math.max(minY, Math.min(targetCamY, maxY));
            camera.x += (targetCamX - camera.x) * 0.1 * dt;
            camera.y += (targetCamY - camera.y) * 0.1 * dt;
        }

        // bullets (projectile hit logic with knockback)
        for (let i = 0; i < projectiles.length; i++) {
            const p = projectiles[i];
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            p.life -= dt;
            if (p.life <= 0) {
                projectiles.splice(i, 1);
                i--;
                continue;
            }
            const out = p.x + p.radius < 0 || p.x - p.radius > WORLD_WIDTH ||
                p.y + p.radius < 0 || p.y - p.radius > WORLD_HEIGHT;
            if (out) {
                for (let s = 0; s < 3; s++) particles.push({ x: p.x, y: p.y, vx: (Math.random() - 0.5) * 2, vy: (Math.random() - 0.5) * 2, life: 0.3, age: 0, size: Math.random() * 2 + 1, color: '#ffaa44', alpha: 1 });
                projectiles.splice(i, 1);
                i--;
                continue;
            }
            let solid = false;
            for (let plat of platforms) if (p.x + p.radius > plat.x && p.x - p.radius < plat.x + plat.w && p.y + p.radius > plat.y && p.y - p.radius < plat.y + plat.h) { solid = true; break; }
            if (solid) {
                for (let s = 0; s < 3; s++) particles.push({ x: p.x, y: p.y, vx: (Math.random() - 0.5) * 2, vy: (Math.random() - 0.5) * 2, life: 0.3, age: 0, size: Math.random() * 2 + 1, color: '#ffaa44', alpha: 1 });
                projectiles.splice(i, 1);
                i--;
                continue;
            }
            for (let h of hazards) if (p.x + p.radius > h.x && p.x - p.radius < h.x + h.w && p.y + p.radius > h.y && p.y - p.radius < h.y + h.h) { solid = true; break; }
            if (solid) {
                for (let s = 0; s < 3; s++) particles.push({ x: p.x, y: p.y, vx: (Math.random() - 0.5) * 2, vy: (Math.random() - 0.5) * 2, life: 0.3, age: 0, size: Math.random() * 2 + 1, color: '#ffaa44', alpha: 1 });
                projectiles.splice(i, 1);
                i--;
                continue;
            }
            for (let id in players) {
                if (id === p.ownerId) continue;
                const t = players[id];
                if (t.eliminated) continue;

                // Normal knockback projectile
                const dx = p.x - (t.x + t.width / 2);
                const dy = p.y - (t.y + t.height / 2);
                if (Math.hypot(dx, dy) < p.radius + t.width / 2) {
                    const angle = Math.atan2(p.vy, p.vx);
                    // Apply knockback with priority
                    t.knockbackTimer = 0.25;
                    t.knockbackVx = Math.cos(angle) * p.knockback;
                    t.knockbackVy = Math.sin(angle) * p.knockback;
                    projectiles.splice(i, 1);
                    i--;
                    playSound('spike');
                    break;
                }
            }
        }

        // Robot hand stretch/retract updates (host only)
        if (isHost && (currentEngineMode === 'GAME' || currentEngineMode === 'LOBBY')) {
            for (let i = 0; i < activeRobotHands.length; i++) {
                const grab = activeRobotHands[i];
                const holder = players[grab.holderId];

                // Remove if holder missing or eliminated
                if (!holder || holder.eliminated) {
                    if (grab.targetId && players[grab.targetId]) {
                        players[grab.targetId].grabbedBy = null;
                        broadcastToRoom('sync_players', { allPlayers: players });
                    }
                    activeRobotHands.splice(i, 1);
                    console.log(`[RobotHand] Removed grab because holder invalid. Remaining: ${activeRobotHands.length}`);
                    i--;
                    continue;
                }

                // STUCK DETECTION: if progress hasn't changed in 2 seconds, force remove
                const now = Date.now();
                if (!grab._lastProgressTime) {
                    grab._lastProgressTime = now;
                    grab._lastProgress = grab.progress;
                } else if (now - grab._lastProgressTime > 2000 && Math.abs(grab.progress - grab._lastProgress) < 0.01) {
                    console.warn(`[RobotHand] Grab stuck for >2s, force removing. Holder: ${grab.holderId}, progress: ${grab.progress}`);
                    if (grab.targetId && players[grab.targetId]) {
                        players[grab.targetId].grabbedBy = null;
                    }
                    activeRobotHands.splice(i, 1);
                    i--;
                    continue;
                } else {
                    // Update tracking every 0.5s to avoid spam
                    if (now - grab._lastProgressTime > 500) {
                        grab._lastProgressTime = now;
                        grab._lastProgress = grab.progress;
                    }
                }

                const MAX_LENGTH = 400;
                const EXTEND_SPEED = 20; // 20 (tesing with 5)
                const RETRACT_SPEED = EXTEND_SPEED + 10;

                const handX = holder.x + holder.width / 2;
                const handY = holder.y + 32;

                // --- Extending phase ---
                if (grab.direction === 1) {
                    const oldProgress = grab.progress;
                    grab.progress += (EXTEND_SPEED * dt) / MAX_LENGTH;
                    console.log(`[RobotHand] Extending: progress=${grab.progress.toFixed(3)}, angle=${grab.angle.toFixed(2)}`);

                    if (grab.progress >= 1) {
                        grab.progress = 1;
                        grab.direction = -1;
                        console.log(`[RobotHand] Reached max length, now retracting (no target)`);
                    } else {
                        // Check collision at the tip
                        const tipX = handX + Math.cos(grab.angle) * MAX_LENGTH * grab.progress;
                        const tipY = handY + Math.sin(grab.angle) * MAX_LENGTH * grab.progress;
                        for (let id in players) {
                            if (id === grab.holderId) continue;
                            const target = players[id];
                            if (target.eliminated) continue;
                            const targetCenterX = target.x + target.width / 2;
                            const targetCenterY = target.y + target.height / 2;
                            const dx = tipX - targetCenterX;
                            const dy = tipY - targetCenterY;
                            const dist = Math.hypot(dx, dy);
                            if (dist < 25 + target.width / 2) {
                                grab.targetId = id;
                                grab.direction = -1;
                                target.grabbedBy = grab.holderId;

                                // Apply upward offset when first grabbed
                                const grabOffsetY = -3;
                                target.x = tipX - target.width / 2;
                                target.y = tipY - target.height / 2 + grabOffsetY;

                                target.vx = 0;
                                target.vy = 0;
                                target.isGrounded = false;

                                // --- NEW: Immediately resolve platform collision on grab ---
                                resolvePlatformCollision(target);

                                console.log(`[RobotHand] HIT ${target.nameTag} (${id})...`);
                                playSound('door');
                                broadcastToRoom('sync_players', { allPlayers: players });
                                break;
                            }
                        }
                    }
                }

                // --- Retracting phase ---
                if (grab.direction === -1) {
                    const oldProgress = grab.progress;
                    grab.progress -= (RETRACT_SPEED * dt) / MAX_LENGTH;

                    if (grab.progress <= 0) {
                        // RELEASE TARGET
                        if (grab.targetId && players[grab.targetId]) {
                            const target = players[grab.targetId];
                            const angleToHolder = Math.atan2(handY - target.y, handX - target.x);
                            target.vx += Math.cos(angleToHolder) * 20;
                            target.vy += Math.sin(angleToHolder) * 20;
                            target.grabbedBy = null;
                            target.isGrounded = false;
                            // --- NEW: Resolve platform collision so they don't fall through ---
                            resolvePlatformCollision(target);
                            broadcastToRoom('sync_players', { allPlayers: players });
                        }
                        activeRobotHands.splice(i, 1);
                        continue;
                    }

                    if (grab.targetId && players[grab.targetId]) {
                        const target = players[grab.targetId];
                        const pulled = (oldProgress - grab.progress) * MAX_LENGTH;
                        const angle = Math.atan2(handY - target.y, handX - target.x);

                        let newX = target.x + Math.cos(angle) * pulled;
                        let newY = target.y + Math.sin(angle) * pulled;

                        // Apply upward offset while being pulled
                        const grabOffsetY = -5;
                        newY += grabOffsetY;

                        // Clamp to world boundaries
                        newX = Math.max(0, Math.min(WORLD_WIDTH - target.width, newX));
                        newY = Math.max(0, Math.min(WORLD_HEIGHT - target.height, newY));

                        target.x = newX;
                        target.y = newY;
                        target.vx = 0;
                        target.vy = 0;
                        target.isGrounded = false;

                        // --- NEW: Avoid pushing target into platforms during grab ---
                        resolvePlatformCollision(target);
                        // Ensure target stays above any platform after adjustment
                        for (let plat of platforms) {
                            if (target.x < plat.x + plat.w && target.x + target.width > plat.x &&
                                target.y + target.height > plat.y && target.y < plat.y + plat.h) {
                                if (target.vy <= 0 && target.y + target.height - plat.y < 15) {
                                    target.y = plat.y - target.height;
                                    target.isGrounded = true;
                                }
                            }
                        }
                    }
                }

                // Update stored head position for drawing
                const tipX = handX + Math.cos(grab.angle) * MAX_LENGTH * grab.progress;
                const tipY = handY + Math.sin(grab.angle) * MAX_LENGTH * grab.progress;
                grab.headX = tipX;
                grab.headY = tipY;
            }
            broadcastRobotHands();
        }

        // throwables (player hit logic with knockback)
        for (let i = 0; i < throwables.length; i++) {
            const t = throwables[i];

            t.vy += THROWABLE_GRAVITY * dt;
            t.angularSpeed *= 0.996;
            const maxStep = 8;
            let remainingX = t.vx * dt;
            let remainingY = t.vy * dt;
            let steps = Math.max(1, Math.ceil(Math.abs(remainingX) / maxStep), Math.ceil(Math.abs(remainingY) / maxStep));
            const stepX = remainingX / steps;
            const stepY = remainingY / steps;

            for (let step = 0; step < steps; step++) {
                t.x += stepX;
                t.y += stepY;
                t.life -= dt / steps;
                t.angle += t.angularSpeed * dt / steps;
                if (t.life <= 0) break;

                // world boundaries bounce (no bottom bounce)
                let bounced = false;
                if (t.x - t.radius < 0 && t.x + t.radius > -BREAK_BOUNDS_OFFSET) {
                    t.x = t.radius;
                    t.vx = -t.vx * 0.4;
                    t.angularSpeed = -t.angularSpeed * 0.8 + (Math.random() - 0.5) * 0.1;
                    bounced = true;
                }
                if (t.x + t.radius > WORLD_WIDTH && t.x - t.radius < WORLD_WIDTH + BREAK_BOUNDS_OFFSET) {
                    t.x = WORLD_WIDTH - t.radius;
                    t.vx = -t.vx * 0.4;
                    bounced = true;
                }
                if (t.y - t.radius < 0 && t.y + t.radius > -BREAK_BOUNDS_OFFSET) {
                    t.y = t.radius;
                    t.vy = -t.vy * 0.4;
                    bounced = true;
                }
                if (bounced) continue;

                // platform collisions
                let hitPlatform = false;
                for (let plat of platforms) {
                    if (t.x + t.radius > plat.x && t.x - t.radius < plat.x + plat.w &&
                        t.y + t.radius > plat.y && t.y - t.radius < plat.y + plat.h) {
                        const left = t.x + t.radius - plat.x;
                        const right = plat.x + plat.w - (t.x - t.radius);
                        const top = t.y + t.radius - plat.y;
                        const bottom = plat.y + plat.h - (t.y - t.radius);
                        const minOver = Math.min(left, right, top, bottom);
                        if (minOver === left || minOver === right) {
                            t.vx = -t.vx * 0.7;
                            if (minOver === left) t.x = plat.x - t.radius;
                            else t.x = plat.x + plat.w + t.radius;
                        } else {
                            t.vy = -t.vy * 0.5;
                            t.vx *= 0.92;
                            t.angularSpeed *= 0.7;
                            if (Math.abs(t.vx) < 0.2) t.vx = 0;
                            if (minOver === top) t.y = plat.y - t.radius;
                            else t.y = plat.y + plat.h + t.radius;
                            t.life -= 0.5;
                        }
                        hitPlatform = true;
                        break;
                    }
                }
                if (hitPlatform) continue;

                // hazard collisions
                let hitHazard = false;
                for (let h of hazards) {
                    if (t.x + t.radius > h.x && t.x - t.radius < h.x + h.w &&
                        t.y + t.radius > h.y && t.y - t.radius < h.y + h.h) {
                        const left = t.x + t.radius - h.x;
                        const right = h.x + h.w - (t.x - t.radius);
                        const top = t.y + t.radius - h.y;
                        const bottom = h.y + h.h - (t.y - t.radius);
                        const minOver = Math.min(left, right, top, bottom);
                        if (minOver === left || minOver === right) {
                            t.vx = -t.vx * 0.6;
                            t.angularSpeed = -t.angularSpeed * 0.9;
                            if (minOver === left) t.x = h.x - t.radius;
                            else t.x = h.x + h.w + t.radius;
                        } else {
                            t.vy = -t.vy * 0.6;
                            if (minOver === top) t.y = h.y - t.radius;
                            else t.y = h.y + h.h + t.radius;
                        }
                        hitHazard = true;
                        break;
                    }
                }
                if (hitHazard) continue;

                // player collisions
                let hitPlayer = false;
                for (let id in players) {
                    if (id === t.ownerId) continue;
                    const target = players[id];
                    if (target.eliminated) continue;
                    const dx = t.x - (target.x + target.width / 2);
                    const dy = t.y - (target.y + target.height / 2);
                    const dist = Math.hypot(dx, dy);
                    if (dist < t.radius + target.width / 2) {
                        const angle = Math.atan2(t.vy, t.vx);
                        if (t.dropItem) {
                            t.vx = Math.cos(angle) * Math.abs(t.vx) * 0.5;
                            t.vy = Math.sin(angle) * Math.abs(t.vy) * 0.5;
                            const pushX = dx / dist * (t.radius + target.width / 2);
                            const pushY = dy / dist * (t.radius + target.height / 2);
                            t.x += pushX * 0.5;
                            t.y += pushY * 0.5;
                            hitPlayer = true;
                            break;
                        }
                        // Apply knockback to target
                        target.knockbackTimer = 0.25;
                        target.knockbackVx = Math.cos(angle) * 15;
                        target.knockbackVy = Math.sin(angle) * 15;
                        if (target.item !== null) {
                            t.vx = Math.cos(angle) * Math.abs(t.vx) * 0.7;
                            t.vy = Math.sin(angle) * Math.abs(t.vy) * 0.7;
                            t.life = Math.max(t.life - 30, 30);
                            const pushX = dx / dist * (t.radius + target.width / 2);
                            const pushY = dy / dist * (t.radius + target.height / 2);
                            t.x += pushX * 0.8;
                            t.y += pushY * 0.8;
                            playSound('spike');
                        } else {
                            const dropX = target.x + target.width / 2 - 12;
                            const dropY = target.y + target.height - 12;
                            itemManager.spawnItem(dropX, dropY, t.itemType, 0, false, t.ammo);
                            broadcastWorldItems();
                            throwables.splice(i, 1);
                            i--;
                        }
                        hitPlayer = true;
                        break;
                    }
                }
                if (hitPlayer) break;
            }

            // life expired → spawn item if not broken
            if (throwables[i] && t.life <= 0) {
                const spawnX = t.x - 12;
                const spawnY = t.y - 12;
                if (spawnX > -BREAK_BOUNDS_OFFSET && spawnX < WORLD_WIDTH + BREAK_BOUNDS_OFFSET &&
                    spawnY > -BREAK_BOUNDS_OFFSET && spawnY < WORLD_HEIGHT + BREAK_BOUNDS_OFFSET) {
                    itemManager.spawnItem(spawnX, spawnY, t.itemType, 0, false, t.ammo);
                    broadcastWorldItems();
                }
                throwables.splice(i, 1);
                i--;
                continue;
            }

            // out-of-bounds break
            const breakX = (t.x + t.radius < -BREAK_BOUNDS_OFFSET || t.x - t.radius > WORLD_WIDTH + BREAK_BOUNDS_OFFSET);
            const breakY = (t.y + t.radius < -BREAK_BOUNDS_OFFSET || t.y - t.radius > WORLD_HEIGHT + BREAK_BOUNDS_OFFSET);
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
            }
        }

        if (isHost) broadcastThrowables();
        if (isHost) broadcastProjectiles();
        ctx.save(); ctx.scale(camera.zoom, camera.zoom); ctx.translate(-camera.x, -camera.y);
        drawCanvasLevelLayout();
        updateAndRenderParticles();
        for (let id in players) {
            let p = players[id];
            if (p.eliminated && p.id !== localPlayerId) continue;
            if (p.isDashing) {
                for (let i = 0; i < 2; i++) particles.push({
                    x: p.x + (p.facingRight ? 0 : p.width), y: p.y + Math.random() * p.height,
                    vx: (p.facingRight ? -3 : 3) + (Math.random() - 0.5), vy: (Math.random() - 0.5) * 1, alpha: 1, size: Math.random() * 5 + 4, color: p.color
                });
            }
            drawCharacterModel(p);
            if (id === localPlayerId && !spectatorMode) drawDashCooldownBar(p);
        }
        drawSkinDoorUI(); drawStartDoorUI();
        ctx.restore();
        drawOffscreenRadarIndicators();

        // EXTRA SAFETY: After everything, ensure match ends if no players left (in case something was missed)
        if (isHost && currentEngineMode === 'GAME') {
            checkAllPlayersEliminatedAndEndMatch();
        }

        if (spectatorMode && currentEngineMode === 'GAME') {
            ctx.font = 'bold 24px "Orbitron"';
            ctx.fillStyle = '#ffcc00';
            ctx.shadowBlur = 10;
            ctx.shadowColor = '#000';
            ctx.textAlign = 'center';
            ctx.fillText("👁️ SPECTATOR MODE", canvas.width / 2, 40);
            ctx.font = '16px "Orbitron"';
            ctx.fillStyle = '#fff';
            ctx.fillText("Use ← → to switch players", canvas.width / 2, 80);
            ctx.shadowBlur = 0;
        }

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
//  INPUT HANDLING (unchanged from earlier version)
// ============================================================================

window.addEventListener('keydown', (e) => {
    if (['ArrowLeft', 'a', 'A'].includes(e.key)) keys.ArrowLeft = true;
    if (['ArrowRight', 'd', 'D'].includes(e.key)) keys.ArrowRight = true;
    if (['ArrowUp', 'w', 'W', ' '].includes(e.key)) keys.ArrowUp = true;
    if (['f', 'F'].includes(e.key)) keys.Interact = true;
    if (e.key === 'q' || e.key === 'Q') keys.Drop = true;
    if (e.code === 'ShiftLeft') keys.ShiftLeft = true;

    if (spectatorMode && currentEngineMode === 'GAME') {
        if (e.key === 'ArrowLeft') {
            e.preventDefault();
            cycleSpectator(-1);
        } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            cycleSpectator(1);
        }
    }
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
    if (spectatorMode) return;
    if (e.button === 0) {
        e.preventDefault();
        performShoot();
    }
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('mousedown', (e) => {
    if (spectatorMode) return;
    if (e.button === 2 && players[localPlayerId] && players[localPlayerId].item) {
        e.preventDefault();
        performThrow();
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

document.addEventListener('DOMContentLoaded', () => {
    const shootBtn = document.getElementById('btn-shoot');
    const throwBtn = document.getElementById('btn-throw');
    if (shootBtn) {
        shootBtn.addEventListener('touchstart', (e) => {
            e.preventDefault();
            if (!spectatorMode) performShoot();
        });
        shootBtn.addEventListener('mousedown', (e) => {
            e.preventDefault();
            if (!spectatorMode) performShoot();
        });
    }
    if (throwBtn) {
        throwBtn.addEventListener('touchstart', (e) => {
            e.preventDefault();
            if (!spectatorMode) performThrow();
        });
        throwBtn.addEventListener('mousedown', (e) => {
            e.preventDefault();
            if (!spectatorMode) performThrow();
        });
    }
});

// ============================================================================
//  SKIN MENU & COLOR SELECTION (unchanged)
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
//  FACE DRAWING (unchanged)
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

// ============================================================================
//  CONSOLE STATUS COMMAND
// ============================================================================

window.status = function () {
    console.clear();
    console.log("%c=== PLAYER STATUS ===", "color: #00f2fe; font-weight: bold;");
    const playerList = Object.values(players).map(p => ({
        "ID": p.id,
        "Name": p.nameTag,
        "Alive": p.eliminated ? "❌ DEAD" : "✅ ALIVE",
        "Death Reason": p.deathReason || (p.eliminated ? "unknown" : "—"),
        "Score": p.score,
        "Position": `(${Math.floor(p.x)}, ${Math.floor(p.y)})`
    }));
    console.table(playerList);
    const aliveCount = playerList.filter(p => p.Alive === "✅ ALIVE").length;
    console.log(`%cAlive players: ${aliveCount} / ${playerList.length}`, `color: ${aliveCount === 0 ? "#ff007f" : "#00ff66"}; font-weight: bold;`);
    if (aliveCount === 0 && currentEngineMode === 'GAME') {
        console.log("%c⚠️ Match should end immediately! ⚠️", "color: #ffaa00; font-weight: bold;");
    }
};

// ------------------------------------------------------------------
// DEBUG / CONSOLE COMMANDS
// ------------------------------------------------------------------
window.forceStartMatch = function () {
    if (!isHost) {
        console.warn("forceStartMatch: You are not the host.");
        return;
    }
    if (currentEngineMode !== 'LOBBY') {
        console.warn("forceStartMatch: Not in LOBBY mode.");
        return;
    }
    console.log("Forcing match start (bypassing door & player count)...");
    if (lobbyTimerId) {
        clearInterval(lobbyTimerId);
        lobbyTimerId = null;
    }
    lobbyCountdownVal = -1;
    broadcastToRoom('sync_lobby_countdown', { value: -1 });
    executeActiveMatchStart();
    broadcastToRoom('trigger_match_start');
};

window.forceHostResetLobby = function () {
    if (!isHost) {
        console.warn("forceHostResetLobby: You are not the host.");
        return;
    }
    if (currentEngineMode !== 'LOBBY') {
        console.warn("forceHostResetLobby: Not in LOBBY mode.");
        return;
    }
    hostResetLobby();
};

enginePipelineTick();