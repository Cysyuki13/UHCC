// ============================================================================
//  PLACEMENT PHASE STATE TRACKING
// ============================================================================
let matchPhase = 'PLAY'; // States: 'CHOOSE', 'PLACE', 'PLAY'
let placementPool = [];   // Shared objects list available to draft
let playerSelectedBlock = {}; // Mapping: { playerId: blockObject }
let placementCursors = {};    // Mapping: { playerId: { x, y, confirmed } }
let matchDuration = 120; // 120 秒 = 2 分钟

// Draft timer (30 seconds) – only active on host
let placementTimer = 30;
let placementTimerInterval = null;

// Placement timer (15 seconds) – only active on host
let placementPlaceTimer = 15;
let placementPlaceTimerInterval = null;

const BOMB_DRAFT_SCALE = 2.0;   // adjust to your liking (1.5–2.5)

// Track left‑click specifically for placement (button 0)
window.leftMouseClicked = false;
window.mouseJustClicked = false; // kept for CHOOSE phase & other uses

window.addEventListener('mousedown', (e) => {
    if (e.button === 0) {
        window.leftMouseClicked = true;
    }
    window.mouseJustClicked = true;
});

// ============================================================================
//  BOMB GLOBALS
// ============================================================================
let previousRoundHadFinisher = false;   // true if last match had at least one finisher
let previousRoundFinishersCount = 0;
let activeBombs = [];                  // list of placed bombs waiting to explode
let lastBombSnapshot = null;

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
        if (matchEndingInProgress && type === 'tick') return;


        if (type === 'jump') synth.triggerAttackRelease("D4", "16n", undefined, 0.3);
        else if (type === 'gem') synth.triggerAttackRelease("B5", "16n", undefined, 0.4);
        else if (type === 'spike') synth.triggerAttackRelease("F2", "8n", undefined, 0.5);
        else if (type === 'door') {
            synth.triggerAttackRelease("A4", "16n", undefined, 0.4);
            synth.triggerAttackRelease("E5", "16n", "+0.08", 0.4);
        }
        else if (type === 'crouch') {
            synth.triggerAttackRelease("G2", "8n", undefined, 0.3);
        }
        else if (type === 'tick') {
            synth.triggerAttackRelease("C5", "32n", undefined, 0.2);
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
    if (matchPhase !== 'PLAY') return; // Disable shooting during setup draft phases
    if (!localPlayerItem) return;
    if (players[localPlayerId]?.eliminated) return;

    // ─── 新增：机器人手角度限制检查（主机与客户端统一） ───
    if (localPlayerItem.name === 'robot_hand') {
        const player = players[localPlayerId];
        const angle = calculateHandAngle(player);
        const facingAngle = player.facingRight ? 0 : Math.PI;
        let diff = angle - facingAngle;
        while (diff > Math.PI) diff -= 2 * Math.PI;
        while (diff < -Math.PI) diff += 2 * Math.PI;
        const MAX_ANGLE_OFFSET = (60 * Math.PI) / 180;
        if (Math.abs(diff) > MAX_ANGLE_OFFSET) {
            // 播放空手枪音效
            if (emptyPistolSound) {
                emptyPistolSound.currentTime = 0;
                emptyPistolSound.play().catch(e => console.warn("Empty pistol sound play failed:", e));
            }
            return; // 阻止发射
        }
    }

    // 其他已有检查...
    if (localPlayerItem.name === 'robot_hand' && activeRobotHands.some(g => g.holderId === localPlayerId)) {
        console.warn("[RobotHand] Already have an active grab, cannot shoot again.");
        return;
    }

    if (localPlayerItem.name === 'pistol' && localPlayerItem.ammo !== undefined && localPlayerItem.ammo <= 0) {
        if (emptyPistolSound) {
            emptyPistolSound.currentTime = 0;
            emptyPistolSound.play().catch(e => console.warn("Empty pistol sound play failed:", e));
        }
        return;
    }

    if (!localPlayerItem.canUse()) return;

    // 主机处理逻辑
    if (isHost) {
        const gameState = { projectiles, activeRobotHands, mouseWorld: getMouseWorldPos() };
        const used = localPlayerItem.onUse(players[localPlayerId], gameState);

        if (used) {
            if (localPlayerItem.name === 'pistol') playPistolSound();
            else if (localPlayerItem.name === 'robot_hand') playRobotHandSound();

            if (players[localPlayerId].item) {
                players[localPlayerId].ammo = players[localPlayerId].item.ammo;
            }
            broadcastToRoom('sync_players', { allPlayers: players });
            if (!players[localPlayerId].item) localPlayerItem = null;
        }
    } else {
        // 客户端处理：移除了原先重复的角度检查（现已统一处理）
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
        hostConnection.send({
            type: 'client_shoot',
            senderId: localPlayerId,
            payload: {
                handAngle: angle,
                ammo: isRobotHand ? 0 : (localPlayerItem?.ammo ?? 0),
                mouseWorld: getMouseWorldPos()
            }
        });

        if (localPlayerItem) localPlayerItem.cooldown = localPlayerItem.cooldownMax;
        if (isRobotHand) playRobotHandSound();
        else if (isPistol) playPistolSound();
    }
}

function performThrow() {
    if (matchPhase !== 'PLAY') return; // Restrict item drops/throws during setup
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
let activeRobotHands = [];
let lastRobotHandSnapshot = null;
const THROWABLE_GRAVITY = 0.35;

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

const BASE_WIDTH = 1280;
const BASE_HEIGHT = 720;
canvas.width = BASE_WIDTH;
canvas.height = BASE_HEIGHT;

const WORLD_WIDTH = 3840;
const WORLD_HEIGHT = 2160;

let cameraBounds = { minX: 0, minY: 0, maxX: WORLD_WIDTH, maxY: WORLD_HEIGHT };
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

let spectatorMode = false;
let spectatorTargetId = null;
let spectatorCycleButtonsAdded = false;
let matchEndingInProgress = false;

let settingsDoor = { x: 1560, y: 1268, w: 70, h: 110, color: '#aa66ff' };
let currentSelectedGameMode = 'active_match';
let currentSelectedMapName = 'match';

function getAlivePlayers() {
    return Object.values(players).filter(p => !p.eliminated);
}

function checkAllPlayersEliminatedAndEndMatch() {
    if (!isHost || currentEngineMode !== 'GAME') return false;
    if (matchEndingInProgress) return false;

    const alive = getAlivePlayers();

    // 1. Check if anyone has crossed the finish line yet
    const hasAnyoneFinished = finishPositions && finishPositions.length > 0;

    // 2. Filter out alive players who have already finished to find active racers
    // (This safely checks if finishPositions contains player IDs or full player objects)
    const activeRacersStillAlive = alive.filter(p => {
        return !finishPositions.some(f => f === p.id || f.id === p.id);
    });

    // Match ends if:
    // - Option A: Absolutely everyone is dead (alive.length === 0)
    // - Option B: Someone finished, and all other players are dead (activeRacersStillAlive.length === 0)
    if (alive.length === 0 || (hasAnyoneFinished && activeRacersStillAlive.length === 0)) {
        matchEndingInProgress = true;

        // Stop both the main match timer and the 30-second countdown timer immediately
        if (gameTimer) { clearInterval(gameTimer); gameTimer = null; }
        if (raceTimerId) { clearInterval(raceTimerId); raceTimerId = null; }

        let results = [];
        for (let id in players) {
            results.push({ id, nameTag: players[id].nameTag, score: players[id].score });
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
        players[id].isCrouching = false;
    }
}

let particles = [];
let bulletImage = new Image();
bulletImage.src = 'assets/items/pistol_bullet.svg';

let bombImage = new Image();
bombImage.src = 'assets/objects/bomb.svg';

let faceImageCache = {};
let lastTime = 0;

let camera = {
    x: 0, y: 0, zoom: 1.0, targetZoom: 1.0,
    minZoom: 1.0, maxZoom: 2.5
};

let skinDoor = { x: 220, y: 390, w: 70, h: 110, color: '#ff007f' };
let lobbyDoor = { x: 1150, y: 530, w: 70, h: 110, color: '#ffcc00' };
let finishLine = { x: 1150, y: 550, w: 100, h: 5, color: '#00ff66' };

const PLAYER_COLORS = [
    '#FF0000', '#0000FF', '#000000', '#ffffff', '#FF69B4', '#00FFFF',
    '#8B4513', '#FFC0CB', '#800080', '#FFA500', '#808080', '#63c363'
];

const keys = { ArrowLeft: false, ArrowRight: false, ArrowUp: false, ShiftLeft: false, Interact: false, Drop: false, KeyW: false, KeyA: false, KeyS: false, KeyD: false, Crouch: false };
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
    if (matchPhase !== 'PLAY') return;
    if (!players[localPlayerId] || players[localPlayerId].eliminated) return;
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
//  ENVIRONMENT SETUP 
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
    if (map.items && Array.isArray(map.items)) {
        itemManager.worldItems = [];
        for (let item of map.items) {
            itemManager.spawnItem(item.x, item.y, item.itemType, item.initialDelay || 0, item.shouldRespawn !== false, item.ammo || 3);
        }
    } else {
        itemManager.worldItems = [];
        itemManager.spawnItem(300, 580, 'pistol', 0, true, 3);
    }
    cameraBounds = map.cameraBounds || { minX: 0, minY: 0, maxX: WORLD_WIDTH, maxY: WORLD_HEIGHT };
    voidYThreshold = (map.voidYThreshold !== undefined) ? map.voidYThreshold : 2000;
}

function setupActiveMatchEnvironment() {
    const map = MAPS.match;
    platforms = map.platforms || [];
    hazards = map.hazards || [];
    gems = (map.gems || []).map(g => ({ ...g, collected: false }));
    spawnPoints = (map.spawnPoints || []).map(sp => ({ x: sp.x, y: sp.y }));
    if (spawnPoints.length === 0) {
        spawnPoints = [{ x: 100, y: 400 }, { x: 150, y: 400 }, { x: 200, y: 400 }];
    }
    if (map.finishLine) Object.assign(finishLine, map.finishLine);
    if (map.items && Array.isArray(map.items) && itemManager) {
        itemManager.worldItems = [];
        for (let item of map.items) {
            itemManager.spawnItem(item.x, item.y, item.itemType, item.initialDelay || 0, item.shouldRespawn !== false, item.ammo || 3);
        }
    } else if (itemManager) {
        itemManager.worldItems = [];
    }
    cameraBounds = map.cameraBounds || { minX: 0, minY: 0, maxX: WORLD_WIDTH, maxY: WORLD_HEIGHT };
    voidYThreshold = (map.voidYThreshold !== undefined) ? map.voidYThreshold : 2000;
}

function hostResetLobby() {
    if (!isHost || currentEngineMode !== 'LOBBY') return;

    projectiles = [];
    throwables = [];
    activeRobotHands = [];
    activeBombs = [];
    lastThrowableSnapshot = null;
    lastProjectileSnapshot = null;
    lastRobotHandSnapshot = null;
    lastBombSnapshot = null;

    setupLobbyEnvironment();
    repositionAllPlayersToSpawnPoints();


    if (lobbyTimerId) { clearInterval(lobbyTimerId); lobbyTimerId = null; }
    if (raceTimerId) { clearInterval(raceTimerId); raceTimerId = null; }
    if (placementTimerInterval) {
        clearInterval(placementTimerInterval);
        placementTimerInterval = null;
    }
    if (placementPlaceTimerInterval) {
        clearInterval(placementPlaceTimerInterval);
        placementPlaceTimerInterval = null;
    }
    lobbyCountdownVal = -1;
    raceCountdownVal = -1;
    raceStarted = false;
    firstPlayerFinishTime = -1;
    finishPositions = [];

    readyPlayers = {};
    localPlayerItem = null;
    matchPhase = 'PLAY';
    resetVersion++;

    timerVal = matchDuration;
    document.getElementById('timer').innerText = timerVal;

    broadcastToRoom('sync_players', { allPlayers: players, reset: true });
    broadcastToRoom('sync_ready_players', { readyPlayers });
    broadcastToRoom('sync_map', { platforms, hazards, gems, cameraBounds, voidYThreshold });
    broadcastWorldItems();
    broadcastToRoom('sync_throwables', { throwables });
    broadcastProjectiles();
    broadcastRobotHands();
    broadcastBombs();
    broadcastToRoom('sync_lobby_countdown', { value: -1 });

    playSound('door');
    updateHudDisplays();
}

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
        grabbedBy: null,
        isCrouching: false,
        standHeight: CHARACTER_BASE_HEIGHT,
        lastThrowableHitTime: 0
    };
}

// ============================================================================
//  VOID DEATH HANDLING
// ============================================================================

function voidRespawnLobby(player) {
    console.warn(`[VOID RESPAWN LOBBY] ${player.id} fell below ${voidYThreshold}`);
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
    player.isCrouching = false;
    player.height = player.standHeight || CHARACTER_BASE_HEIGHT;
    playSound('spike');
}

function voidEliminateGame(player, reason) {
    if (player.eliminated) return;

    player.eliminated = true;
    player.deathReason = reason || 'unknown';

    player.vx = 0;
    player.vy = 0;
    player.knockbackTimer = 0;
    player.knockbackVx = 0;
    player.knockbackVy = 0;

    player.item = null;
    player.itemType = null;
    player.ammo = 0;
    if (isHost) {
        activeRobotHands = activeRobotHands.filter(g => g.holderId !== player.id && g.targetId !== player.id);
        for (let id in players) {
            if (players[id].grabbedBy === player.id) players[id].grabbedBy = null;
        }
        broadcastRobotHands();
    }
    playSound('spike');

    if (player.id === localPlayerId && currentEngineMode === 'GAME') {
        spectatorMode = true;
        const alive = getAlivePlayers();
        if (alive.length > 0) {
            spectatorTargetId = alive[0].id;
            updateCameraToTarget();
        }
        document.getElementById('spectator-controls')?.classList.remove('hidden');
    }
    if (isHost && currentEngineMode === 'GAME') {
        checkAllPlayersEliminatedAndEndMatch();
    }
}

function checkVoidDeath() {
    if (currentEngineMode !== 'LOBBY' && currentEngineMode !== 'GAME') return;
    if (matchPhase !== 'PLAY') return; // Delay physical void calculations during setup steps
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
    broadcastToRoom('sync_robot_hands', { activeRobotHands });
}

function broadcastBombs() {
    if (!isHost) return;
    const snap = JSON.stringify(activeBombs);
    if (snap === lastBombSnapshot) return;
    lastBombSnapshot = snap;
    broadcastToRoom('sync_bombs', { activeBombs });
}

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
    if (matchPhase !== 'PLAY') return;
    for (let id in players) {
        const p = players[id];
        if (p.eliminated) continue;
        for (let h of hazards) {
            if (checkCollision(p, h)) {
                voidEliminateGame(p, 'touched a hazard');
                break;
            }
        }
    }
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
//  SAFE ZONES – prevent placing blocks over spawn points and finish line
// ============================================================================

function getSafeZones() {
    const zones = [];
    if (currentEngineMode !== 'GAME') return zones;
    if (matchPhase === 'PLAY') return zones;

    // 只使用地图 JSON 中定义的 safeZones
    const map = MAPS[currentSelectedMapName];
    if (map && map.safeZones && Array.isArray(map.safeZones)) {
        map.safeZones.forEach(zone => {
            zones.push({
                x: zone.x,
                y: zone.y,
                w: zone.w,
                h: zone.h,
                type: 'custom'
            });
        });
    }
    return zones;
}

// ============================================================================
//  NEW PRE-MATCH DRAFTING LOGIC MECHANISMS
// ============================================================================

function initializePlacementPhase() {
    matchPhase = 'CHOOSE';
    const playerIds = Object.keys(players);
    const totalCount = playerIds.length + 1;
    placementPool = [];
    playerSelectedBlock = {};
    placementCursors = {};

    playerIds.forEach(id => {
        placementCursors[id] = { x: BASE_WIDTH / 2, y: BASE_HEIGHT / 2, confirmed: false };
    });

    // Shuffle the shapes for variety
    const shuffledShapes = shuffleArray(DRAFT_SHAPES);
    for (let i = 0; i < totalCount; i++) {
        const shapeTemplate = shuffledShapes[i % shuffledShapes.length];
        const spacing = BASE_WIDTH / (totalCount + 1);
        placementPool.push({
            id: 'block_' + i,
            type: shapeTemplate.type,
            w: shapeTemplate.w,
            h: shapeTemplate.h,
            color: shapeTemplate.color,
            blocks: shapeTemplate.blocks,
            claimedBy: null,
            menuX: spacing * (i + 1) - shapeTemplate.w / 2,
            menuY: BASE_HEIGHT / 2 - shapeTemplate.h / 2
        });
    }
}

// Auto-assign remaining blocks when timer expires
function autoAssignRemainingBlocks() {
    if (!isHost || matchPhase !== 'CHOOSE') return;

    const playersWithoutBlock = Object.keys(players).filter(id => !playerSelectedBlock[id]);
    const unclaimedBlocks = placementPool.filter(b => !b.claimedBy);

    playersWithoutBlock.forEach((id, index) => {
        if (unclaimedBlocks.length === 0) return;
        const blockIndex = index % unclaimedBlocks.length;
        const block = unclaimedBlocks.splice(blockIndex, 1)[0];
        block.claimedBy = id;
        playerSelectedBlock[id] = block;
        if (placementCursors[id]) placementCursors[id].confirmed = true;
    });

    broadcastToRoom('sync_placement_pool', { pool: placementPool, selections: playerSelectedBlock, cursors: placementCursors });
    const allChosen = Object.keys(players).every(id => playerSelectedBlock[id] !== undefined);
    if (allChosen) {
        if (placementTimerInterval) {
            clearInterval(placementTimerInterval);
            placementTimerInterval = null;
        }
        matchPhase = 'PLACE';
        // 重置左键点击状态，防止进入 PLACE 时立即触发
        window.leftMouseClicked = false;
        window.mouseJustClicked = false;

        Object.keys(placementCursors).forEach(id => {
            placementCursors[id].confirmed = false;
            if (spawnPoints.length > 0) {
                placementCursors[id].x = spawnPoints[0].x;
                placementCursors[id].y = spawnPoints[0].y - 100;
            } else {
                placementCursors[id].x = WORLD_WIDTH / 2;
                placementCursors[id].y = WORLD_HEIGHT / 2;
            }
        });
        broadcastToRoom('transition_to_placement', { phase: 'PLACE', cursors: placementCursors });
        broadcastToRoom('sync_map', { platforms, hazards, gems, cameraBounds, voidYThreshold });
        // 启动放置计时器
        startPlacementPlaceTimer();
    }
}

// ============================================================================
//  PLACEMENT PLACE TIMER (15 seconds)
// ============================================================================
function startPlacementPlaceTimer() {
    if (!isHost) return;
    if (matchPhase !== 'PLACE') return;
    if (placementPlaceTimerInterval) return;

    placementPlaceTimer = 15;
    broadcastToRoom('sync_placement_place_timer', { value: placementPlaceTimer });

    placementPlaceTimerInterval = setInterval(() => {
        placementPlaceTimer--;
        broadcastToRoom('sync_placement_place_timer', { value: placementPlaceTimer });

        if (placementPlaceTimer <= 5 && placementPlaceTimer > 0) {
            playSound('tick');
        }

        if (placementPlaceTimer <= 0) {
            clearInterval(placementPlaceTimerInterval);
            placementPlaceTimerInterval = null;
            forceFinishPlacement();
        }
    }, 1000);
}

function forceFinishPlacement() {
    if (!isHost || matchPhase !== 'PLACE') return;
    // 将所有未确认的玩家标记为已确认（不实际放置）
    let anyUnconfirmed = false;
    for (let id in placementCursors) {
        if (!placementCursors[id].confirmed) {
            placementCursors[id].confirmed = true;
            anyUnconfirmed = true;
        }
    }
    if (anyUnconfirmed) {
        broadcastToRoom('sync_placement_cursors', { cursors: placementCursors });
        // 检查是否所有玩家都已确认
        const allPlaced = Object.keys(players).every(id => placementCursors[id].confirmed);
        if (allPlaced) {
            matchPhase = 'PLAY';
            broadcastToRoom('match_phase_play', { phase: 'PLAY' });
            startOfficialMatchRun();
        }
    }
}

// ============================================================================
//  LEFT‑CLICK ICON (loaded from external SVG file)
// ============================================================================
let leftClickIconImg = null;

function loadLeftClickIcon() {
    const img = new Image();
    img.src = 'assets/icons/left_click_icon.svg'; // 路径根据你的实际目录调整
    img.onload = () => {
        console.log('[UI] Left‑click icon loaded successfully.');
    };
    img.onerror = () => {
        console.warn('[UI] Failed to load left‑click icon, using fallback drawing.');
    };
    return img;
}

// Load the icon once
leftClickIconImg = loadLeftClickIcon();

function updatePlacementPhases(dt) {
    if (currentEngineMode !== 'GAME' || matchPhase === 'PLAY') return;

    // Clamp dt to avoid huge movement steps
    const maxDt = 0.033;
    let safeDt = Math.min(dt, maxDt);
    if (safeDt <= 0) safeDt = 0.016; // fallback

    let cursor = placementCursors[localPlayerId];
    if (!cursor) {
        placementCursors[localPlayerId] = { x: BASE_WIDTH / 2, y: BASE_HEIGHT / 2, confirmed: false };
        cursor = placementCursors[localPlayerId];
    }
    if (cursor.confirmed) return;

    let moved = false;
    const moveSpeed = 200; // units per second (was 400)
    const step = moveSpeed * safeDt;

    // Keyboard movement
    if (keys.ArrowLeft || keys.KeyA) { cursor.x -= step; moved = true; }
    if (keys.ArrowRight || keys.KeyD) { cursor.x += step; moved = true; }
    if (keys.ArrowUp || keys.KeyW) { cursor.y -= step; moved = true; }
    if (keys.Drop || keys.KeyS) { cursor.y += step; moved = true; }

    // Mouse movement – only update when mouse actually moves, with smoothing
    const mouseWorld = getMouseWorldPos();
    let mouseMoved = false;
    if (matchPhase === 'CHOOSE') {
        const rect = canvas.getBoundingClientRect();
        const screenX = (mousePos.x - rect.left) * (canvas.width / rect.width);
        const screenY = (mousePos.y - rect.top) * (canvas.height / rect.height);
        if (screenX >= 0 && screenX <= BASE_WIDTH && screenY >= 0 && screenY <= BASE_HEIGHT) {
            cursor.x = screenX;
            cursor.y = screenY;
            moved = true;
            mouseMoved = true;
        }
    } else if (matchPhase === 'PLACE') {
        // Smooth mouse movement – avoid instant snapping
        const targetX = mouseWorld.x;
        const targetY = mouseWorld.y;
        const smoothing = 0.85;
        cursor.x = cursor.x * smoothing + targetX * (1 - smoothing);
        cursor.y = cursor.y * smoothing + targetY * (1 - smoothing);
        moved = true;
        mouseMoved = true;
    }

    // Clamp position based on phase
    if (matchPhase === 'CHOOSE') {
        cursor.x = Math.max(0, Math.min(cursor.x, BASE_WIDTH));
        cursor.y = Math.max(0, Math.min(cursor.y, BASE_HEIGHT));
    } else {
        cursor.x = Math.max(cameraBounds.minX, Math.min(cursor.x, cameraBounds.maxX));
        cursor.y = Math.max(cameraBounds.minY, Math.min(cursor.y, cameraBounds.maxY));
    }

    if (moved) {
        sendPlacementCursorUpdate(cursor.x, cursor.y);
    }

    // ─── Handle placement / selection ──────────────────────────────────────────
    // CHOOSE phase: any click (mouseJustClicked) OR Interact key
    if (matchPhase === 'CHOOSE') {
        if (keys.Interact || window.mouseJustClicked) {
            if (keys.Interact) keys.Interact = false;
            if (window.mouseJustClicked) window.mouseJustClicked = false;

            const item = placementPool.find(p =>
                cursor.x >= p.menuX && cursor.x <= p.menuX + p.w &&
                cursor.y >= p.menuY && cursor.y <= p.menuY + p.h &&
                p.claimedBy === null
            );
            if (item) selectBlockRequest(item.id);
        }
    }
    // PLACE phase: ONLY left‑click (no keyboard, no right/middle click)
    else if (matchPhase === 'PLACE') {
        if (window.leftMouseClicked) {
            window.leftMouseClicked = false; // consume the click

            const block = playerSelectedBlock[localPlayerId];
            if (block) {
                if (validatePlacement(cursor.x, cursor.y, block)) {
                    confirmPlacementRequest(cursor.x, cursor.y);
                } else {
                    console.log("Placement overlaps map component, safe zone, or object!");
                    playSound('spike');
                }
            }
        }
    }
}

function validatePlacement(x, y, block) {
    const CELL_SIZE = 40; // must match the cell size used in DRAFT_SHAPES and rotation

    // Check every cell of the block
    for (let cell of block.blocks) {
        const bx1 = x + cell.x;
        const by1 = y + cell.y;
        const bx2 = bx1 + CELL_SIZE;
        const by2 = by1 + CELL_SIZE;

        // World bounds check
        if (bx1 < cameraBounds.minX || bx2 > cameraBounds.maxX ||
            by1 < cameraBounds.minY || by2 > cameraBounds.maxY) {
            return false;
        }

        // Check against existing platforms (including other placed cells)
        for (let plat of platforms) {
            if (bx1 < plat.x + plat.w && bx2 > plat.x &&
                by1 < plat.y + plat.h && by2 > plat.y) {
                return false;
            }
        }

        // Check against hazards
        for (let haz of hazards) {
            if (bx1 < haz.x + haz.w && bx2 > haz.x &&
                by1 < haz.y + haz.h && by2 > haz.y) {
                return false;
            }
        }

        // Check against safe zones
        const safeZones = getSafeZones();
        for (let zone of safeZones) {
            if (bx1 < zone.x + zone.w && bx2 > zone.x &&
                by1 < zone.y + zone.h && by2 > zone.y) {
                return false;
            }
        }
    }

    return true; // all cells are clear
}

// ============================================================================
//  ROTATION LOGIC (Press R during PLACE phase)
// ============================================================================

function rotatePlayerBlock(playerId) {
    if (matchPhase !== 'PLACE') return;   // only rotate during placement
    const block = playerSelectedBlock[playerId];
    if (!block) return;
    const cursor = placementCursors[playerId];
    if (!cursor || cursor.confirmed) return;

    const cellSize = 40;
    const oldW = block.w;
    const oldH = block.h;

    // Keep center fixed
    const centerX = cursor.x + oldW / 2;
    const centerY = cursor.y + oldH / 2;

    // Rotate each cell 90° clockwise: (x, y) → (y, oldW - x - cellSize)
    const newBlocks = block.blocks.map(cell => ({
        x: cell.y,
        y: oldW - cell.x - cellSize
    }));

    const newW = oldH;
    const newH = oldW;

    block.w = newW;
    block.h = newH;
    block.blocks = newBlocks;

    // Reposition cursor to keep center
    cursor.x = centerX - newW / 2;
    cursor.y = centerY - newH / 2;

    // --- Sync with host or broadcast ---
    if (isHost) {
        broadcastToRoom('sync_placement_pool', {
            pool: placementPool,
            selections: playerSelectedBlock,
            cursors: placementCursors
        });
    } else if (hostConnection && hostConnection.open) {
        hostConnection.send({
            type: 'client_rotate_block',
            senderId: localPlayerId,
            payload: {
                w: block.w,
                h: block.h,
                blocks: block.blocks,
                cursorX: placementCursors[localPlayerId]?.x || 0,
                cursorY: placementCursors[localPlayerId]?.y || 0
            }
        });
    }
}

// ============================================================================
//  NETWORKING HELPERS (cursor updates, selection, placement)
// ============================================================================

function sendPlacementCursorUpdate(cx, cy) {
    if (isHost) {
        placementCursors[localPlayerId].x = cx;
        placementCursors[localPlayerId].y = cy;
        broadcastToRoom('sync_placement_cursors', { cursors: placementCursors });
    } else if (hostConnection?.open) {
        hostConnection.send({
            type: 'client_placement_cursor_update',
            senderId: localPlayerId,
            payload: { x: cx, y: cy }
        });
    }
}

function selectBlockRequest(blockId) {
    if (isHost) {
        handleHostBlockClaim(localPlayerId, blockId);
    } else if (hostConnection?.open) {
        hostConnection.send({
            type: 'client_draft_claim',
            senderId: localPlayerId,
            payload: { itemId: blockId }
        });
    }
}

function confirmPlacementRequest(px, py) {
    if (isHost) {
        handleHostPlacementConfirm(localPlayerId, px, py);
    } else if (hostConnection?.open) {
        const block = playerSelectedBlock[localPlayerId];
        if (!block) return;
        hostConnection.send({
            type: 'client_confirm_placement',
            senderId: localPlayerId,
            payload: {
                x: px,
                y: py,
                w: block.w,
                h: block.h,
                color: block.color
            }
        });
    }
}

function handleHostBlockClaim(playerId, blockId) {
    if (matchPhase !== 'CHOOSE') return;
    const block = placementPool.find(b => b.id === blockId);
    if (block && !block.claimedBy) {
        block.claimedBy = playerId;
        playerSelectedBlock[playerId] = block;
        if (placementCursors[playerId]) placementCursors[playerId].confirmed = true;

        broadcastToRoom('sync_placement_pool', { pool: placementPool, selections: playerSelectedBlock, cursors: placementCursors });

        const allChosen = Object.keys(players).every(id => playerSelectedBlock[id] !== undefined);
        if (allChosen) {
            if (placementTimerInterval) {
                clearInterval(placementTimerInterval);
                placementTimerInterval = null;
            }
            matchPhase = 'PLACE';
            // 重置左键点击状态
            window.leftMouseClicked = false;
            window.mouseJustClicked = false;

            Object.keys(placementCursors).forEach(id => {
                placementCursors[id].confirmed = false;
                if (spawnPoints.length > 0) {
                    placementCursors[id].x = spawnPoints[0].x;
                    placementCursors[id].y = spawnPoints[0].y - 100;
                } else {
                    placementCursors[id].x = WORLD_WIDTH / 2;
                    placementCursors[id].y = WORLD_HEIGHT / 2;
                }
            });
            broadcastToRoom('transition_to_placement', { phase: 'PLACE', cursors: placementCursors });
            broadcastToRoom('sync_map', { platforms, hazards, gems, cameraBounds, voidYThreshold });
            // 启动放置计时器
            startPlacementPlaceTimer();
        }
    }
}

// ============================================================================
//  BOMB EXPLOSION HANDLING (HOST ONLY)
// ============================================================================

function triggerBombExplosion(bomb) {
    const cx = bomb.x + 20;   // center of 40×40 cell
    const cy = bomb.y + 20;
    const radius = bomb.radius;

    // Collect indices of player‑placed platforms within radius (including other bombs)
    const toRemove = [];
    for (let i = 0; i < platforms.length; i++) {
        const plat = platforms[i];
        if (!plat.isPlacedBlock) continue;   // ignore original map platforms
        const platCx = plat.x + plat.w / 2;
        const platCy = plat.y + plat.h / 2;
        const dist = Math.hypot(platCx - cx, platCy - cy);
        if (dist < radius) {
            toRemove.push(i);
        }
    }

    // Remove platforms (reverse order to keep indices valid)
    toRemove.sort((a, b) => b - a);
    for (let idx of toRemove) {
        platforms.splice(idx, 1);
    }

    // Spawn explosion particles
    for (let i = 0; i < 60; i++) {
        const angle = Math.random() * 2 * Math.PI;
        const speed = 2 + Math.random() * 6;
        pushParticle({
            type: 'spark',
            x: cx, y: cy,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed,
            life: 0.6 + Math.random() * 0.6,
            age: 0,
            size: Math.random() * 5 + 3,
            color: '#ff6600',
            alpha: 1
        });
    }

    // Remove this bomb from the active list
    const idx = activeBombs.indexOf(bomb);
    if (idx !== -1) activeBombs.splice(idx, 1);

    // Broadcast updated map and bomb state
    broadcastToRoom('sync_map', { platforms, hazards, gems, cameraBounds, voidYThreshold });
    broadcastBombs();
    console.log(`[Bomb] Explosion at (${cx},${cy}) radius ${radius}, removing ${toRemove.length} blocks`);

    playSound('spike');
}

function handleHostPlacementConfirm(playerId, px, py) {
    if (matchPhase !== 'PLACE') return;
    const block = playerSelectedBlock[playerId];
    if (block && placementCursors[playerId] && !placementCursors[playerId].confirmed) {
        if (validatePlacement(px, py, block)) {
            const CELL_SIZE = 40;
            const isBomb = (block.type === 'bomb');

            block.blocks.forEach(cell => {
                platforms.push({
                    x: px + cell.x,
                    y: py + cell.y,
                    w: CELL_SIZE,
                    h: CELL_SIZE,
                    color: block.color,
                    isPlacedBlock: true,
                    isBomb: isBomb,
                    bombRadius: block.radius || 150
                });
            });

            if (isBomb) {
                console.log(`[Bomb] Host: Bomb placed at (${px}, ${py}) by player ${playerId}`);
                activeBombs.push({
                    x: px,
                    y: py,
                    radius: block.radius || 150,
                    timer: 0.5,
                    ownerId: playerId
                });
                console.log(`[Bomb] activeBombs now length: ${activeBombs.length}`);
                broadcastBombs();
            }

            placementCursors[playerId].confirmed = true;

            broadcastToRoom('sync_map', { platforms, hazards, gems, cameraBounds, voidYThreshold });
            broadcastToRoom('sync_placement_cursors', { cursors: placementCursors });

            const allPlaced = Object.keys(players).every(id => placementCursors[id].confirmed);
            if (allPlaced) {
                // 清除放置计时器
                if (placementPlaceTimerInterval) {
                    clearInterval(placementPlaceTimerInterval);
                    placementPlaceTimerInterval = null;
                }
                matchPhase = 'PLAY';
                broadcastToRoom('match_phase_play', { phase: 'PLAY' });
                startOfficialMatchRun();
            }
        }
    }
}

function startOfficialMatchRun() {
    // 清除放置计时器（如果有）
    if (placementPlaceTimerInterval) {
        clearInterval(placementPlaceTimerInterval);
        placementPlaceTimerInterval = null;
    }
    timerVal = matchDuration; // 使用设置的时长
    if (gameTimer) clearInterval(gameTimer);
    gameTimer = setInterval(() => {
        timerVal--;
        broadcastToRoom('sync_timer', { time: timerVal });
        const timerEl = document.getElementById('timer');
        if (timerEl) timerEl.innerText = timerVal;
    }, 1000);
    repositionAllPlayersToSpawnPoints();
}

// ============================================================================
//  DRAFT OVERLAY RENDERING (with left‑click icon during PLACE phase)
// ============================================================================

function drawPlacementPhaseOverlay() {
    if (currentEngineMode !== 'GAME' || matchPhase === 'PLAY') return;

    if (matchPhase === 'CHOOSE') {
        ctx.fillStyle = "rgba(12, 5, 22, 0.95)";
        ctx.fillRect(0, 0, BASE_WIDTH, BASE_HEIGHT);

        // --- Title (moved up slightly) ---
        ctx.font = "bold 28px Orbitron";
        ctx.fillStyle = "#00f2fe";
        ctx.textAlign = "center";
        ctx.fillText("CHOOSE YOUR OBJECT TO PLACE", BASE_WIDTH / 2, 85);

        // --- Progress bar for the timer ---
        const barX = 0;
        const barY = 115;
        const barW = BASE_WIDTH;
        const barH = 5;

        ctx.fillStyle = "rgba(0,0,0,0.7)";
        ctx.fillRect(barX, barY, barW, barH);

        const progress = Math.max(0, placementTimer / 30);
        let barColor;
        if (progress > 0.5) barColor = "#00ff66";
        else if (progress > 0.25) barColor = "#ffcc00";
        else barColor = "#ff3333";
        ctx.fillStyle = barColor;
        ctx.fillRect(barX, barY, barW * progress, barH);

        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 0.5;
        ctx.strokeRect(barX, barY, barW, barH);

        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 16px Orbitron";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(`${placementTimer}s`, barX + barW / 2, barY + barH + 15);
        ctx.textBaseline = "alphabetic";

        // --- Draw the draft blocks ---
        placementPool.forEach(item => {
            ctx.save();
            const CELL_SIZE = 40;
            const isBomb = (item.type === 'bomb');

            if (item.claimedBy) {
                ctx.globalAlpha = 0.5;
                if (isBomb && bombImage.complete) {
                    const scaledW = item.w * BOMB_DRAFT_SCALE;
                    const scaledH = item.h * BOMB_DRAFT_SCALE;
                    const dx = item.menuX + (item.w - scaledW) / 2;
                    const dy = item.menuY + (item.h - scaledH) / 2;
                    ctx.drawImage(bombImage, dx, dy, scaledW, scaledH);
                } else {
                    item.blocks.forEach(cell => {
                        const cx = item.menuX + cell.x;
                        const cy = item.menuY + cell.y;
                        ctx.fillStyle = item.color;
                        ctx.fillRect(cx, cy, CELL_SIZE, CELL_SIZE);
                        ctx.strokeStyle = 'rgba(255,255,255,0.3)';
                        ctx.lineWidth = 1;
                        ctx.strokeRect(cx, cy, CELL_SIZE, CELL_SIZE);
                    });
                }
                ctx.globalAlpha = 1;
                ctx.strokeStyle = "#ff007f";
                ctx.lineWidth = 2;
                ctx.strokeRect(item.menuX, item.menuY, item.w, item.h);
                ctx.font = "bold 12px Orbitron";
                ctx.fillStyle = "#ff007f";
                ctx.textAlign = "center";
                const claimer = players[item.claimedBy]?.nameTag || "TAKEN";
                ctx.fillText(claimer, item.menuX + item.w / 2, item.menuY + item.h / 2 + 4);
            } else {
                if (isBomb && bombImage.complete) {
                    const scaledW = item.w * BOMB_DRAFT_SCALE;
                    const scaledH = item.h * BOMB_DRAFT_SCALE;
                    const dx = item.menuX + (item.w - scaledW) / 2;
                    const dy = item.menuY + (item.h - scaledH) / 2;
                    ctx.drawImage(bombImage, dx, dy, scaledW, scaledH);
                } else {
                    item.blocks.forEach(cell => {
                        const cx = item.menuX + cell.x;
                        const cy = item.menuY + cell.y;
                        ctx.fillStyle = item.color;
                        ctx.fillRect(cx, cy, CELL_SIZE, CELL_SIZE);
                        ctx.strokeStyle = "rgba(255,255,255,0.3)";
                        ctx.lineWidth = 1;
                        ctx.strokeRect(cx, cy, CELL_SIZE, CELL_SIZE);
                    });
                }
                ctx.strokeStyle = "rgba(255,255,255,0.2)";
                ctx.lineWidth = 1;
                ctx.strokeRect(item.menuX, item.menuY, item.w, item.h);
            }
            ctx.restore();
        });

        // --- Draw all cursors ---
        for (let id in placementCursors) {
            const cur = placementCursors[id];
            const pColor = players[id]?.color || '#ffffff';
            ctx.fillStyle = pColor;
            ctx.beginPath();
            ctx.arc(cur.x, cur.y, 10, 0, Math.PI * 2);
            ctx.fill();
            ctx.font = "10px Orbitron";
            ctx.fillStyle = "#fff";
            ctx.fillText(players[id]?.nameTag || "Player", cur.x, cur.y - 15);
            if (cur.confirmed) {
                ctx.strokeStyle = "#00ff66";
                ctx.lineWidth = 3;
                ctx.beginPath();
                ctx.arc(cur.x, cur.y, 14, 0, Math.PI * 2);
                ctx.stroke();
            }
        }
    } else if (matchPhase === 'PLACE') {
        const localCur = placementCursors[localPlayerId];
        if (localCur) {
            const CAM_LERP = 0.07;
            let targetCamX = localCur.x - BASE_WIDTH / 2;
            let targetCamY = localCur.y - BASE_HEIGHT / 2;
            const maxWorldCamX = WORLD_WIDTH - BASE_WIDTH;
            const maxWorldCamY = WORLD_HEIGHT - BASE_HEIGHT;
            targetCamX = Math.max(cameraBounds.minX, Math.min(targetCamX, maxWorldCamX));
            targetCamY = Math.max(cameraBounds.minY, Math.min(targetCamY, maxWorldCamY));
            camera.x += (targetCamX - camera.x) * CAM_LERP;
            camera.y += (targetCamY - camera.y) * CAM_LERP;
            camera.x = Math.max(cameraBounds.minX, Math.min(camera.x, cameraBounds.maxX - BASE_WIDTH));
            camera.y = Math.max(cameraBounds.minY, Math.min(camera.y, cameraBounds.maxY - BASE_HEIGHT));
        }

        ctx.save();
        ctx.translate(-camera.x, -camera.y);

        // --- Draw safe zones ---
        const safeZones = getSafeZones();
        safeZones.forEach(zone => {
            ctx.fillStyle = 'rgba(255, 0, 0, 0.15)';
            ctx.fillRect(zone.x, zone.y, zone.w, zone.h);
            ctx.strokeStyle = 'rgba(255, 0, 0, 0.6)';
            ctx.lineWidth = 2;
            ctx.setLineDash([6, 4]);
            ctx.strokeRect(zone.x, zone.y, zone.w, zone.h);
            ctx.setLineDash([]);
            ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
            ctx.font = '12px Orbitron';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'bottom';
            const label = zone.type === 'spawn' ? 'SPAWN' : 'FINISH';
            ctx.fillText(label, zone.x + zone.w / 2, zone.y - 4);
            ctx.textBaseline = 'alphabetic';
        });

        const CELL_SIZE = 40;

        function drawBlock(block, x, y, alpha, outlineColor) {
            if (!block || !block.blocks) return;
            ctx.globalAlpha = alpha;
            if (block.type === 'bomb' && bombImage.complete) {
                ctx.drawImage(bombImage, x, y, block.w, block.h);
            } else {
                block.blocks.forEach(cell => {
                    const cx = x + cell.x;
                    const cy = y + cell.y;
                    ctx.fillStyle = block.color;
                    ctx.fillRect(cx, cy, CELL_SIZE, CELL_SIZE);
                    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
                    ctx.lineWidth = 1;
                    ctx.strokeRect(cx, cy, CELL_SIZE, CELL_SIZE);
                });
            }
            if (outlineColor) {
                ctx.globalAlpha = 1.0;
                ctx.strokeStyle = outlineColor;
                ctx.lineWidth = 3;
                ctx.strokeRect(x, y, block.w, block.h);
            }
            ctx.globalAlpha = 1.0;
        }

        // --- Other players' projections ---
        for (let id in placementCursors) {
            if (id === localPlayerId) continue;
            const cur = placementCursors[id];
            if (cur.confirmed) continue;
            const block = playerSelectedBlock[id];
            if (!block) continue;
            drawBlock(block, cur.x, cur.y, 0.3, null);
            ctx.font = "10px Orbitron";
            ctx.fillStyle = "#fff";
            ctx.textAlign = "center";
            ctx.fillText(players[id]?.nameTag || "Player", cur.x + block.w / 2, cur.y - 5);
        }

        // --- Local player preview ---
        const myBlock = playerSelectedBlock[localPlayerId];
        if (myBlock && localCur && !localCur.confirmed) {
            const valid = validatePlacement(localCur.x, localCur.y, myBlock);
            const outlineColor = valid ? "#00ff66" : "#ff0000";
            drawBlock(myBlock, localCur.x, localCur.y, valid ? 0.6 : 0.25, outlineColor);

            if (myBlock.type === 'bomb') {
                const centerX = localCur.x + myBlock.w / 2;
                const centerY = localCur.y + myBlock.h / 2;
                const radius = myBlock.radius || 150;
                ctx.save();
                ctx.beginPath();
                ctx.arc(centerX, centerY, radius, 0, 2 * Math.PI);
                ctx.strokeStyle = 'rgba(255, 0, 0, 0.4)';
                ctx.lineWidth = 2;
                ctx.setLineDash([6, 8]);
                ctx.stroke();
                ctx.restore();
                ctx.fillStyle = 'rgba(255,0,0,0.7)';
                ctx.font = '12px Orbitron';
                ctx.textAlign = 'center';
                ctx.fillText('💥 BOMB', centerX, centerY - radius - 10);
            }
        }

        // --- All cursors ---
        for (let id in placementCursors) {
            const cur = placementCursors[id];
            const pColor = players[id]?.color || '#ffffff';
            ctx.fillStyle = pColor;
            ctx.beginPath();
            ctx.arc(cur.x, cur.y, 8, 0, Math.PI * 2);
            ctx.fill();
            ctx.font = "12px Orbitron";
            ctx.fillStyle = "#fff";
            ctx.fillText(players[id]?.nameTag || "Player", cur.x, cur.y - 12);
            if (cur.confirmed) {
                ctx.strokeStyle = "#00ff66";
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.arc(cur.x, cur.y, 12, 0, Math.PI * 2);
                ctx.stroke();
            }
        }

        ctx.restore();

        // --- UI overlay (screen coordinates) ---
        ctx.font = "bold 24px Orbitron";
        ctx.fillStyle = "#ffcc00";
        ctx.textAlign = "center";
        ctx.fillText("PLACE YOUR BLOCK ON THE MAP", BASE_WIDTH / 2, 50);

        const barX = 0, barY = 70, barW = BASE_WIDTH, barH = 5;
        ctx.fillStyle = "rgba(0,0,0,0.7)";
        ctx.fillRect(barX, barY, barW, barH);
        const progress = Math.max(0, placementPlaceTimer / 15);
        let barColor;
        if (progress > 0.5) barColor = "#00ff66";
        else if (progress > 0.25) barColor = "#ffcc00";
        else barColor = "#ff3333";
        ctx.fillStyle = barColor;
        ctx.fillRect(barX, barY, barW * progress, barH);
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 0.5;
        ctx.strokeRect(barX, barY, barW, barH);

        const iconSize = 32, iconX = BASE_WIDTH / 2 - 140, iconY = 85;
        if (leftClickIconImg && leftClickIconImg.complete && leftClickIconImg.naturalWidth > 0) {
            ctx.drawImage(leftClickIconImg, iconX, iconY, iconSize, iconSize);
        } else {
            // fallback
            ctx.fillStyle = "#00f2fe";
            ctx.beginPath();
            ctx.moveTo(iconX + 4, iconY + 4);
            ctx.lineTo(iconX + 4, iconY + iconSize - 8);
            ctx.lineTo(iconX + 12, iconY + iconSize - 16);
            ctx.lineTo(iconX + 20, iconY + iconSize - 4);
            ctx.lineTo(iconX + 26, iconY + iconSize - 10);
            ctx.lineTo(iconX + 16, iconY + iconSize - 20);
            ctx.lineTo(iconX + iconSize - 8, iconY + 4);
            ctx.closePath();
            ctx.fill();
            ctx.strokeStyle = "#ffffff";
            ctx.lineWidth = 1.5;
            ctx.stroke();
            ctx.fillStyle = "#ff007f";
            ctx.beginPath();
            ctx.arc(iconX + iconSize - 6, iconY + 6, 8, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = "#ffffff";
            ctx.font = "bold 8px Orbitron";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText("L", iconX + iconSize - 6, iconY + 7);
            ctx.textBaseline = "alphabetic";
        }
        ctx.font = "bold 16px Orbitron";
        ctx.fillStyle = "#00f2fe";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText("LEFT CLICK TO PLACE", iconX + iconSize + 12, iconY + iconSize / 2);
        ctx.textBaseline = "alphabetic";

        ctx.font = "14px Share Tech Mono";
        ctx.fillStyle = "#aaa";
        ctx.textAlign = "center";
        ctx.fillText("Press R to rotate your block", BASE_WIDTH / 2, iconY + iconSize + 20);

        if (myBlock && localCur && !localCur.confirmed) {
            const valid = validatePlacement(localCur.x, localCur.y, myBlock);
            if (!valid) {
                ctx.font = "14px Orbitron";
                ctx.fillStyle = "#ff3333";
                ctx.textAlign = "center";
                ctx.fillText("⚠️ Invalid position – overlaps safe zone or existing object", BASE_WIDTH / 2, iconY + iconSize + 45);
            }
        }
    }
}