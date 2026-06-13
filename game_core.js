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

let robotHandSound = null;

function loadRobotHandSound() {
    robotHandSound = new Audio('assets/sounds/robot_hand.mp3');
    robotHandSound.preload = 'auto';
}
loadRobotHandSound();

function playRobotHandSound() {
    if (!robotHandSound) return;
    if (Tone.context.state !== 'running') return;
    robotHandSound.currentTime = 0;
    robotHandSound.play().catch(e => console.warn("Robot hand sound play failed:", e));
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

    // Prevent using robot hand again if an active grab already exists
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

    // --- CLIENT-SIDE ANGLE VALIDATION FOR ROBOT HAND ---
    if (!isHost && localPlayerItem.name === 'robot_hand') {
        const angle = calculateHandAngle(players[localPlayerId]);
        const facingAngle = players[localPlayerId].facingRight ? 0 : Math.PI;
        let diff = angle - facingAngle;
        while (diff > Math.PI) diff -= 2 * Math.PI;
        while (diff < -Math.PI) diff += 2 * Math.PI;
        const MAX_ANGLE_OFFSET = (60 * Math.PI) / 180;
        if (Math.abs(diff) > MAX_ANGLE_OFFSET) {
            console.warn(`[RobotHand] Client blocked shoot: angle ${angle.toFixed(2)} out of range.`);
            if (emptyPistolSound) {
                emptyPistolSound.currentTime = 0;
                emptyPistolSound.play().catch(e => console.warn("Wrong direction sound play failed:", e));
            }
            return;
        }
    }

    if (isHost) {
        const gameState = {
            projectiles,
            activeRobotHands,
            mouseWorld: getMouseWorldPos()
        };

        // Play sound immediately if it can be used
        if (localPlayerItem.name === 'pistol') {
            playPistolSound();
        } else if (localPlayerItem.name === 'robot_hand') {
            playRobotHandSound();
        }
        const used = localPlayerItem.onUse(players[localPlayerId], gameState);

        if (used) {
            // Play appropriate sound based on item type
            if (localPlayerItem.name === 'pistol') {
                playPistolSound();
            } else if (localPlayerItem.name === 'robot_hand') {
                playRobotHandSound();
            }

            if (players[localPlayerId].item) {
                players[localPlayerId].ammo = players[localPlayerId].item.ammo;
            }

            broadcastToRoom('sync_players', { allPlayers: players });

            if (!players[localPlayerId].item) {
                localPlayerItem = null;
            }

        } else if (emptyPistolSound) {
            emptyPistolSound.currentTime = 0;
            emptyPistolSound.play().catch(e => console.warn("Empty pistol sound play failed:", e));
        }
    } else {
        // --- Client prediction branch ---
        const isRobotHand = (localPlayerItem.name === 'robot_hand');
        const isPistol = (localPlayerItem.name === 'pistol');

        if (isPistol && localPlayerItem.ammo !== undefined) {
            localPlayerItem.ammo--;
            players[localPlayerId].ammo = localPlayerItem.ammo;
        } else if (isRobotHand) {
            players[localPlayerId].item = null;
            players[localPlayerId].itemType = null;
            players[localPlayerId].ammo = 0;
            localPlayerItem = null;
        }

        const angle = calculateHandAngle(players[localPlayerId]);
        console.log(`[CLIENT] Sending shoot request. Ammo left: ${localPlayerItem?.ammo}`);

        hostConnection.send({
            type: 'client_shoot',
            senderId: localPlayerId,
            payload: {
                handAngle: angle,
                ammo: isRobotHand ? 0 : (localPlayerItem?.ammo ?? 0),
                mouseWorld: getMouseWorldPos()
            }
        });

        if (localPlayerItem) {
            localPlayerItem.cooldown = localPlayerItem.cooldownMax;
        }

        // Play appropriate sound based on item type
        if (isRobotHand) {
            playRobotHandSound();
        } else if (isPistol) {
            playPistolSound();
        }
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

// Settings door and preferences
let settingsDoor = { x: 1560, y: 1268, w: 70, h: 110, color: '#aa66ff' };
let currentSelectedGameMode = 'active_match';
let currentSelectedMapName = 'match';

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
        console.log("[Setup] Scoreboard position from map:", window.lobbyScoreboardPos);
    } else {
        window.lobbyScoreboardPos = { x: 50, y: 50, w: 250, h: 200 };
        console.log("[Setup] Scoreboard using default position");
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
        if (map.doors.settingsDoor) Object.assign(settingsDoor, map.doors.settingsDoor);
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