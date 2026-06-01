// Synthesizer Configuration
const synth = new Tone.PolySynth(Tone.Synth).toDestination();
synth.set({
    oscillator: { type: "square8" },
    envelope: { attack: 0.01, decay: 0.1, sustain: 0.2, release: 0.1 }
});

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

// UI Panel View Switcher
function switchPanel(panelId) {
    ['panel-main', 'panel-play', 'panel-settings', 'panel-status'].forEach(id => {
        document.getElementById(id).classList.add('hidden');
    });
    document.getElementById(panelId).classList.remove('hidden');
}

// Framework Engine Constants
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const BASE_WIDTH = 1280;
const BASE_HEIGHT = 720;
canvas.width = BASE_WIDTH;
canvas.height = BASE_HEIGHT;

// UPDATED PHYSICS CONSTANTS: Floatier gravity and friction handling
const GRAVITY = 0.35;
const FRICTION = 0.85;
const MAX_FALL_SPEED = 10;
const MOVE_SPEED = 3;
const DASH_SPEED = 14;

// Ultimate Chicken Horse Architecture Global State Machine
let currentEngineMode = 'MENU';
let isHost = false;
let roomCodeString = "";
let timerVal = 60;
let gameTimer = null;

// Lobby Countdown States
let lobbyCountdownVal = -1;
let lobbyTimerId = null;

// Player Pool Matrix (Max 6 Players)
let localPlayerId = "";
let players = {};
const playerColors = ['#00f2fe', '#ff007f', '#00ff66', '#ffff00', '#ff9900', '#a020f0'];

// Global slot manager - tracks which players occupy which slots for permanent P-number assignment
const MAX_PLAYERS = 6;
const playerSlots = Array(MAX_PLAYERS).fill(null); // Will store the peerId for each slot

// Dynamic Customization Door configuration station
const skinDoor = {
    x: 220,
    y: 390,
    w: 70,
    h: 110,
    color: '#ff007f'
};

// Call this when someone joins to claim the first empty P-number
function claimSlot(peerId) {
    for (let i = 0; i < MAX_PLAYERS; i++) {
        if (playerSlots[i] === null) {
            playerSlots[i] = peerId;
            return `P${i + 1}`; // Returns "P1", "P2", etc.
        }
    }
    return "P?"; // Fallback if full
}

// Call this when someone leaves to free their slot
function releaseSlot(peerId) {
    const index = playerSlots.indexOf(peerId);
    if (index !== -1) {
        playerSlots[index] = null;
    }
}

// Map Layout Elements
let platforms = [];
let hazards = [];
let gems = [];

let particles = [];

// NEW: Time tracking for frame-rate independence
let lastTime = 0;

// NEW: Camera and Viewport Scaling Configuration
let camera = {
    x: 0,
    y: 0,
    zoom: 1.0,        // Current interpolated zoom value
    targetZoom: 1.0,  // Viewport destination zoom value
    minZoom: 1.0,     // Zoomed all the way out (See full 1280x720 map)
    maxZoom: 2.5      // Zoomed all the way in close to character
};

// Dynamic Door Object configuration
const lobbyDoor = {
    x: 1150,
    y: 530,
    w: 70,
    h: 110,
    color: '#ffcc00'
};

// Define your unique pool of player colors globally (Updated to match HTML additions)
const PLAYER_COLORS = [
    '#ff007f', // Neon Pink
    '#00f2fe', // Cyber Cyan
    '#00ff66', // Neon Green
    '#ffff00', // Neon Yellow
    '#9400d3', // Neon Purple
    '#ffaa00', // Neon Orange
    '#181717', // Psychedelic Purple
    '#ff0055', // Cyberpunk Crimson
    '#ff5500', // Hot Coral
    '#0011ff', // Electric Lime
    '#ff97dc', // Laser Pink
    '#5500ff'  // Deep Violet
];

// Helper to find the first color NOT currently in use
function getNextAvailableColor() {
    for (let color of PLAYER_COLORS) {
        let isColorTaken = false;
        for (let id in players) {
            if (players[id].color === color) {
                isColorTaken = true;
                break;
            }
        }
        if (!isColorTaken) return color;
    }
    // Fallback: If lobby full, reuse the first color (or handle as you see fit)
    return PLAYER_COLORS[0];
}

// Inputs Map
const keys = { ArrowLeft: false, ArrowRight: false, ArrowUp: false, ShiftLeft: false, Interact: false };
const touchState = { left: false, right: false, jump: false };

// Mouse tracking
let mousePos = { x: 0, y: 0 };
window.addEventListener('mousemove', (e) => {
    mousePos.x = e.clientX;
    mousePos.y = e.clientY;
});

// Convert mouse screen coords to canvas world coords
function getMouseWorldPos() {
    const rect = canvas.getBoundingClientRect();
    const canvasX = (mousePos.x - rect.left);
    const canvasY = (mousePos.y - rect.top);

    // Since the context is already transformed by scale and translate,
    // we need to reverse the camera transform
    const worldX = canvasX / camera.zoom + camera.x;
    const worldY = canvasY / camera.zoom + camera.y;

    return { x: worldX, y: worldY };
}

// Level Profiles definitions
function setupLobbyEnvironment() {
    platforms = [
        { x: 0, y: 640, w: 1280, h: 40 },
        { x: 0, y: 0, w: 20, h: 680 },
        { x: 1260, y: 0, w: 20, h: 680 },
        { x: 200, y: 500, w: 250, h: 20 },
        { x: 550, y: 400, w: 300, h: 20 },
        { x: 900, y: 280, w: 250, h: 20 }
    ];
    hazards = [];
    gems = [];
}

function setupActiveMatchEnvironment() {
    platforms = [
        { x: 0, y: 680, w: 1280, h: 40 },
        { x: 0, y: 0, w: 20, h: 680 },
        { x: 1260, y: 0, w: 20, h: 680 },
        { x: 150, y: 520, w: 300, h: 20 },
        { x: 830, y: 520, w: 300, h: 20 },
        { x: 440, y: 400, w: 400, h: 25 },
        { x: 380, y: 220, w: 520, h: 20 }
    ];
    hazards = [
        { x: 450, y: 660, w: 380, h: 20 },
        { x: 230, y: 512, w: 80, h: 8 }
    ];

    gems = [
        { id: 1, x: 640, y: 320, collected: false },
        { id: 2, x: 250, y: 450, collected: false },
        { id: 3, x: 1000, y: 450, collected: false }
    ];
}

// Multiplayer P2P Mesh Engine
let peer = null;
const defaultColor = (typeof skinDoor !== 'undefined' && skinDoor.color) ? skinDoor.color : null;

function createPlayerProfile(id, nameTag) {
    return {
        id: id,
        nameTag: nameTag, // Permanent P-number like "P1", "P2", etc.
        x: 640,
        y: 530,
        vx: 0,
        vy: 0,
        width: 20,
        height: 48,
        color: (defaultColor && !isColorAlreadyUsed(defaultColor, null)) ? defaultColor : getNextAvailableColor(),
        isGrounded: false,
        facingRight: true,
        score: 0,
        jumpsLeft: 2,
        wasJumpPressed: false,
        dashCooldown: 0,
        dashTimer: 0,
        isDashing: false,
        wasDashPressed: false,
        lastSeen: Date.now() // Heartbeat tracking
    };
}

function initHost() {
    switchPanel('panel-status');
    roomCodeString = Math.floor(1000 + Math.random() * 9000).toString();
    peer = new Peer(`neon-uhub-${roomCodeString}`);

    peer.on('open', (id) => {
        document.getElementById('status-spinner').classList.add('hidden');
        document.getElementById('room-code-display').classList.remove('hidden');
        document.getElementById('room-code').innerText = roomCodeString;
        document.getElementById('hud-room').innerText = roomCodeString;

        // Auto-copy Room ID on host creation click gesture
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(roomCodeString).catch(err => console.warn(err));
        }

        isHost = true;
        localPlayerId = "HOST";
        const hostNameTag = claimSlot(localPlayerId);
        players[localPlayerId] = createPlayerProfile(localPlayerId, hostNameTag);

        enterLobbyState();
        startHostWatchdog(); // Start monitoring for dead connections
    });

    peer.on('connection', (conn) => {
        if (Object.keys(players).length >= 6) {
            conn.on('open', () => {
                conn.send({ type: 'room_full' });
                setTimeout(() => conn.close(), 500);
            });
            return;
        }
        clientConnections.push(conn);
        setupHostRoutingRules(conn);
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
        hostConnection = peer.connect(`neon-uhub-${roomCodeString}`);
        setupClientRoutingRules(hostConnection);
    });

    peer.on('error', () => {
        alert("找不到目標房間代碼，請確認代碼是否輸入正確。");
        cancelConnection();
    });
}

function cancelConnection() {
    if (hostConnection) hostConnection.close();
    clientConnections.forEach(c => c.close());
    if (peer) peer.destroy();
    location.reload();
}

function disconnectGame() {
    cancelConnection();
}

let clientConnections = [];
let hostConnection = null;

// Heartbeat constants and watchdog timer
const HEARTBEAT_TIMEOUT = 5000; // 5 seconds of silence = disconnected
let hostWatchdogTimer = null;

// Unified cleanup function for disconnected players
function cleanupPlayer(peerId) {
    if (players[peerId]) {
        releaseSlot(peerId); // Free the P1/P2/P3 slot
        delete players[peerId];
        updateHudDisplays();
        broadcastToRoom('sync_players', { allPlayers: players });
    }
}

// Host watchdog: checks for silent players and disconnects them
function startHostWatchdog() {
    if (hostWatchdogTimer) clearInterval(hostWatchdogTimer);

    hostWatchdogTimer = setInterval(() => {
        if (!isHost) return;

        const now = Date.now();
        for (let peerId in players) {
            // Ignore the host itself
            if (peerId === localPlayerId) continue;

            // If the player hasn't checked in for HEARTBEAT_TIMEOUT
            if (now - players[peerId].lastSeen > HEARTBEAT_TIMEOUT) {
                console.warn(`Watchdog: Forcibly disconnecting silent player: ${peerId}`);
                cleanupPlayer(peerId);
            }
        }
    }, 2000); // Check every 2 seconds
}

function setupHostRoutingRules(conn) {
    conn.on('open', () => {
        const newClientId = conn.peer;
        const assignedNameTag = claimSlot(newClientId);

        players[newClientId] = createPlayerProfile(newClientId, assignedNameTag);
        updateHudDisplays();

        conn.send({
            type: 'init_welcome',
            payload: { assignedId: newClientId, allPlayers: players, mode: currentEngineMode }
        });

        broadcastToRoom('sync_map', { platforms, hazards, gems });
        broadcastToRoom('sync_players', { allPlayers: players });
    });

    conn.on('data', (package) => {
        if (package.type === 'heartbeat') {
            if (players[conn.peer]) {
                players[conn.peer].lastSeen = Date.now();
            }
        } else if (package.type === 'client_input_update') {
            if (players[package.senderId]) {
                players[package.senderId].x = package.payload.x;
                players[package.senderId].y = package.payload.y;
                players[package.senderId].facingRight = package.payload.facingRight;
                players[package.senderId].isDashing = package.payload.isDashing;
                players[package.senderId].handAngle = package.payload.handAngle;
                players[package.senderId].lastSeen = Date.now();
            }
            broadcastToRoom('sync_players', { allPlayers: players });
        }else if (package.type === 'update_skin') {
            if (players[package.senderId]) {
                players[package.senderId].color = package.payload.color;
            }
            // Re-broadcast the updated player data back to the group room immediately
            broadcastToRoom('sync_players', { allPlayers: players });
            if (!document.getElementById('skin-modal').classList.contains('hidden')) {
                updateColorButtonStates();
            }
        } else if (package.type === 'request_collect_gem') {
            processGemCapture(package.payload.gemId, package.senderId);
        }
    });

    conn.on('close', () => {
        releaseSlot(conn.peer);
        clientConnections = clientConnections.filter(c => c !== conn);
        delete players[conn.peer];
        updateHudDisplays();
        broadcastToRoom('sync_players', { allPlayers: players });
    });
}

function setupClientRoutingRules(conn) {
    conn.on('data', (package) => {
        switch (package.type) {
            case 'room_full':
                alert("房間已滿 (上限 6 人)！");
                cancelConnection();
                break;
            case 'init_welcome':
                localPlayerId = package.payload.assignedId;
                players = package.payload.allPlayers;
                currentEngineMode = package.payload.mode;
                document.getElementById('hud-room').innerText = roomCodeString;
                enterLobbyState();
                startClientHeartbeat(conn); // Start sending heartbeats to host
                break;
            case 'sync_players':
                // 1. Add or update players coming from the host broadcast
                for (let id in package.payload.allPlayers) {
                    if (id !== localPlayerId) {
                        if (!players[id]) {
                            // NEW: If the player doesn't exist in our local registry yet, register them!
                            players[id] = package.payload.allPlayers[id];
                        } else {
                            // If they do exist, update their moving properties smoothly
                            players[id].x = package.payload.allPlayers[id].x;
                            players[id].y = package.payload.allPlayers[id].y;
                            players[id].facingRight = package.payload.allPlayers[id].facingRight;
                            players[id].score = package.payload.allPlayers[id].score;
                            players[id].isDashing = package.payload.allPlayers[id].isDashing;
                            // SYNC COLOR MODIFICATIONS NATIVELY
                            players[id].color = package.payload.allPlayers[id].color;
                        }
                    }
                }

                // 2. NEW: Clean up players who left the room
                for (let id in players) {
                    if (id !== localPlayerId && !package.payload.allPlayers[id]) {
                        delete players[id];
                    }
                }

                updateHudDisplays();
                updateColorButtonStates();
                break;
            case 'sync_map':
                platforms = package.payload.platforms;
                hazards = package.payload.hazards;
                gems = package.payload.gems;
                break;
            case 'sync_lobby_countdown':
                lobbyCountdownVal = package.payload.value;
                break;
            case 'trigger_match_start':
                executeActiveMatchStart();
                break;
            case 'sync_timer':
                timerVal = package.payload.time;
                document.getElementById('timer').innerText = timerVal;
                break;
            case 'match_over':
                executeMatchEndingSequence(package.payload.summary);
                break;
            case 'return_to_lobby':
                executeLobbyReturnSequence();
                break;
        }
    });

    conn.on('close', () => {
        document.getElementById('disconnect-modal').classList.remove('hidden');
    });
}

// Client-side heartbeat sender
let clientHeartbeatTimer = null;
function startClientHeartbeat(conn) {
    if (clientHeartbeatTimer) clearInterval(clientHeartbeatTimer);

    clientHeartbeatTimer = setInterval(() => {
        if (!isHost && conn && conn.open) {
            conn.send({ type: 'heartbeat' });
        }
    }, 1000); // Send heartbeat every second
}

function broadcastToRoom(type, payload) {
    if (!isHost) return;
    const msg = { type: type, payload: payload };
    clientConnections.forEach(conn => {
        if (conn.open) conn.send(msg);
    });
}

function updateHudDisplays() {
    const count = Object.keys(players).length;
    document.getElementById('player-count-hud').innerText = `${count} / 6`;

    let stateLabel = "大廳整備中";
    if (currentEngineMode === 'MENU') stateLabel = "主選單配置中";
    if (currentEngineMode === 'GAME') stateLabel = "決戰進行中";
    document.getElementById('game-state-hud').innerText = stateLabel;
}

function enterLobbyState() {
    currentEngineMode = 'LOBBY';
    lobbyCountdownVal = -1;
    if (lobbyTimerId) clearInterval(lobbyTimerId);
    document.getElementById('menu-screen').classList.add('hidden');
    setupLobbyEnvironment();
    updateHudDisplays();
}

function evaluateLobbyDoorTrigger() {
    if (!isHost || currentEngineMode !== 'LOBBY') return;

    const totalPlayers = Object.keys(players).length;
    let touchingCount = 0;

    for (let id in players) {
        if (checkCollision(players[id], lobbyDoor)) {
            touchingCount++;
        }
    }

    if (totalPlayers >= 2 && touchingCount > totalPlayers / 2) {
        if (lobbyCountdownVal === -1) {
            lobbyCountdownVal = 10;
            playSound('door');
            broadcastToRoom('sync_lobby_countdown', { value: lobbyCountdownVal });

            if (lobbyTimerId) clearInterval(lobbyTimerId);
            lobbyTimerId = setInterval(() => {
                if (currentEngineMode !== 'LOBBY') {
                    clearInterval(lobbyTimerId);
                    lobbyTimerId = null;
                    lobbyCountdownVal = -1;
                    return;
                }

                let currentTotal = Object.keys(players).length;
                let currentTouching = 0;
                for (let id in players) {
                    if (checkCollision(players[id], lobbyDoor)) {
                        currentTouching++;
                    }
                }

                if (currentTotal >= 2 && currentTouching > currentTotal / 2) {
                    lobbyCountdownVal--;
                    broadcastToRoom('sync_lobby_countdown', { value: lobbyCountdownVal });

                    if (lobbyCountdownVal <= 0) {
                        clearInterval(lobbyTimerId);
                        lobbyTimerId = null;
                        lobbyCountdownVal = -1;
                        broadcastToRoom('sync_lobby_countdown', { value: lobbyCountdownVal });
                        broadcastToRoom('trigger_match_start');
                        executeActiveMatchStart();
                    }
                } else {
                    clearInterval(lobbyTimerId);
                    lobbyTimerId = null;
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

function getTouchingDoorCount() {
    let touchingCount = 0;
    for (let id in players) {
        if (checkCollision(players[id], lobbyDoor)) {
            touchingCount++;
        }
    }
    return touchingCount;
}

function executeActiveMatchStart() {
    currentEngineMode = 'GAME';
    setupActiveMatchEnvironment();
    updateHudDisplays();

    let idx = 0;
    for (let id in players) {
        players[id].x = 100 + (idx * 50);
        players[id].y = 400;
        players[id].vx = 0;
        players[id].vy = 0;
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
                let results = [];
                for (let id in players) {
                    results.push({ id: id, score: players[id].score });
                }
                broadcastToRoom('match_over', { summary: results });
                executeMatchEndingSequence(results);
            }
        }, 1000);
    }
}

function executeMatchEndingSequence(summary) {
    const overlay = document.getElementById('gameover-overlay');
    const resText = document.getElementById('match-result');
    overlay.classList.remove('hidden');

    summary.sort((a, b) => b.score - a.score);
    resText.innerText = `最高分玩家: ${summary[0].id} (${summary[0].score} 分)`;
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
        players[id].x = 100 + (idx * 45);
        players[id].y = 500;
        players[id].vx = 0;
        players[id].vy = 0;
        idx++;
    }
}

// Player-to-player collision resolution
function resolvePlayerCollisions() {
    const playerIds = Object.keys(players);
    for (let i = 0; i < playerIds.length; i++) {
        for (let j = i + 1; j < playerIds.length; j++) {
            let p1 = players[playerIds[i]];
            let p2 = players[playerIds[j]];

            // Check AABB collision
            if (p1.x < p2.x + p2.width &&
                p1.x + p1.width > p2.x &&
                p1.y < p2.y + p2.height &&
                p1.y + p1.height > p2.y) {

                // Simple collision resolution: push them away from each other horizontally
                let overlapX = (p1.x + p1.width / 2) - (p2.x + p2.width / 2);
                if (overlapX > 0) {
                    p1.x += 2;
                    p2.x -= 2;
                } else {
                    p1.x -= 2;
                    p2.x += 2;
                }
            }
        }
    }
}

// REMADE: Gameplay Physics Engine Mechanics Loop
function updateCharacterPhysics(player, dt) {
    // 1. Scale cooldowns by delta time instead of fixed integers
    if (player.dashCooldown > 0) {
        player.dashCooldown -= dt;
    }

    const wasGrounded = player.isGrounded;
    let landed = false;

    let left = keys.ArrowLeft || touchState.left;
    let right = keys.ArrowRight || touchState.right;
    let jump = keys.ArrowUp || touchState.jump;
    let shift = keys.ShiftLeft;

    let dashJustPressed = shift && !player.wasDashPressed;
    player.wasDashPressed = shift;

    if (dashJustPressed && player.dashCooldown <= 0 && !player.isDashing) {
        player.isDashing = true;
        player.dashTimer = 10;
        player.dashCooldown = 90; // coolcown in frames (1.5 seconds at 60fps)
        // CRITICAL FIX: Removed player.vy = 0; to preserve jump momentum!
    }

    // --- HORIZONTAL AXIS PHYSICS ---
    if (player.isDashing) {
        player.vx = player.facingRight ? DASH_SPEED : -DASH_SPEED;

        // 2. Decrement dash duration timer by delta slices
        player.dashTimer -= dt;

        if (player.dashTimer <= 0) {
            player.isDashing = false;
            player.vx *= 0.4;
        }
    } else {
        if (left) {
            player.vx = -MOVE_SPEED;
            player.facingRight = false;
        } else if (right) {
            player.vx = MOVE_SPEED;
            player.facingRight = true;
        } else {
            // 3. Convert linear friction multiplication to an exponential curve matching real-world time
            player.vx *= Math.pow(FRICTION, dt);
            if (Math.abs(player.vx) < 0.1) player.vx = 0;
        }
    }

    // --- VERTICAL AXIS PHYSICS ---
    let dynamicGravity = GRAVITY;
    if (jump && player.vy < 0) {
        dynamicGravity = GRAVITY * 0.4;
    }

    // 4. Scale gravity acceleration steps by delta time
    player.vy += dynamicGravity * dt;

    if (player.vy > MAX_FALL_SPEED) player.vy = MAX_FALL_SPEED;

    if (player.isGrounded) {
        player.jumpsLeft = 2;
    }

    // Jump Input Triggers (Instant velocity impulses do NOT get multiplied by dt)
    let jumpJustPressed = jump && !player.wasJumpPressed;
    player.wasJumpPressed = jump;

    if (jumpJustPressed) {
        if (player.isGrounded) {
            player.vy = -9;
            player.isGrounded = false;
            player.jumpsLeft = 1;
            playSound('jump');
            spawnJumpParticles(player.x + player.width / 2, player.y + player.height, true); // <-- grounded = true
        } else if (player.jumpsLeft > 0) {
            player.vy = -6;
            player.jumpsLeft = 0;
            playSound('jump');
            spawnJumpParticles(player.x + player.width / 2, player.y + player.height, false); // <-- airborne
        }
    }


    player.isGrounded = false;

    // --- POSITION UPDATES AND BOUNDING BOX COLLISIONS ---

    // 5. Multiply the velocity vector by delta time before modifying coordinates
    player.x += player.vx * dt;

    platforms.forEach(plat => {
        if (checkCollision(player, plat)) {
            if (player.vx > 0) player.x = plat.x - player.width;
            else if (player.vx < 0) player.x = plat.x + plat.w;
            player.vx = 0;
            if (player.isDashing) player.isDashing = false; // Cancel dash on wall hit
        }
    });

    // 6. Multiply vertical fall/rise steps by delta time
    player.y += player.vy * dt;

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

    if (player.x < 20) player.x = 20;
    if (player.x + player.width > 1260) player.x = 1260 - player.width;

    hazards.forEach(h => {
        if (checkCollision(player, h)) {
            player.isDashing = false;
            respawnMatchEntity(player);
        }
    });

    gems.forEach(g => {
        if (!g.collected && checkCircleCollision(player, g)) {
            if (isHost) {
                processGemCapture(g.id, player.id);
            } else {
                hostConnection.send({
                    type: 'request_collect_gem',
                    senderId: localPlayerId,
                    payload: { gemId: g.id }
                });
            }
        }
    });

    // --- PLAYER-ON-PLAYER STACKING ---
    for (let otherId in players) {
        if (otherId === player.id) continue;
        let target = players[otherId];

        // Check if player is falling onto another player's head
        if (player.vy > 0 &&
            player.x + player.width > target.x &&
            player.x < target.x + target.width &&
            player.y + player.height <= target.y + 5 &&
            player.y + player.height + player.vy * dt >= target.y) {

            // Snap player onto target's head
            player.y = target.y - player.height;
            player.vy = 0;
            player.isGrounded = true;
            landed = true;
        }
    }
    if (!wasGrounded && landed) {
        // spawn once at feet
        spawnDustParticles(player.x + player.width / 2, player.y + player.height);
        playSound('spike'); // optional landing sound
    }
}

// Spawn jump particles. grounded = true when jump started from ground.
function spawnJumpParticles(spawnX, spawnY, grounded = false) {
    if (grounded) {
        // Two-sided burst at feet: left and right sprays
        const outwardSpeed = 2.2;
        const upwardSpeed = -1.6;
        const countPerSide = 6;

        for (let i = 0; i < countPerSide; i++) {
            // Right side
            pushParticle({
                type: 'jump_side',
                x: spawnX + 6 + Math.random() * 6,
                y: spawnY + 2 + (Math.random() - 0.5) * 4,
                vx: outwardSpeed + Math.random() * 0.8,
                vy: upwardSpeed + (Math.random() - 0.5) * 0.6,
                life: 0.6 + Math.random() * 0.2,
                age: 0,
                size: Math.random() * 2 + 1.2,
                radius: 4,
                bounce: 0.18,
                friction: 0.88,
                onGround: false,
                color: '#d0d0d0',
                alpha: 1
            });

            // Left side
            pushParticle({
                type: 'jump_side',
                x: spawnX - 6 + (Math.random() - 0.5) * 6,
                y: spawnY + 2 + (Math.random() - 0.5) * 4,
                vx: -outwardSpeed - Math.random() * 0.8,
                vy: upwardSpeed + (Math.random() - 0.5) * 0.6,
                life: 0.6 + Math.random() * 0.2,
                age: 0,
                size: Math.random() * 2 + 1.2,
                radius: 4,
                bounce: 0.18,
                friction: 0.88,
                onGround: false,
                color: '#d0d0d0',
                alpha: 1
            });
        }

        // small center sparks for visual punch
        for (let i = 0; i < 4; i++) {
            pushParticle({
                type: 'spark',
                x: spawnX + (Math.random() - 0.5) * 8,
                y: spawnY,
                vx: (Math.random() - 0.5) * 0.6,
                vy: -0.6 + Math.random() * 0.4,
                life: 0.45,
                age: 0,
                size: Math.random() * 1.2 + 0.6,
                color: '#ffffff',
                alpha: 1
            });
        }
    } else {
        // Keep original downward burst for mid-air jumps
        for (let i = 0; i < 8; i++) {
            pushParticle({
                type: 'dust_down',
                x: spawnX + (Math.random() - 0.5) * 14,
                y: spawnY + 2,
                vx: (Math.random() - 0.5) * 1.2,
                vy: (Math.random() * 0.6 + 0.6), // downward
                life: 0.45,
                age: 0,
                size: Math.random() * 3 + 1.2,
                radius: 5,
                bounce: 0.12,
                friction: 0.9,
                onGround: false,
                color: '#bfbfbf',
                alpha: 1
            });
        }

        // optional small sparks
        for (let i = 0; i < 4; i++) {
            pushParticle({
                type: 'spark',
                x: spawnX + (Math.random() - 0.5) * 8,
                y: spawnY,
                vx: (Math.random() - 0.5) * 1.0,
                vy: (Math.random() * 0.6 + 0.2),
                life: 0.5,
                age: 0,
                size: Math.random() * 1.6 + 0.8,
                color: '#ffffff',
                alpha: 1
            });
        }
    }
}

// Grounded landing dust: launch outward a short range then fall
function spawnDustParticles(spawnX, spawnY) {
    // Short outward burst then gravity takes over
    const count = 12;
    for (let i = 0; i < count; i++) {
        const dir = (i % 2 === 0) ? 1 : -1; // alternate left/right
        const speed = 1.6 + Math.random() * 1.2;
        const upward = -0.8 - Math.random() * 0.8;

        pushParticle({
            type: 'dust_up', // re-used type but now with outward velocity
            x: spawnX + (Math.random() - 0.5) * 8,
            y: spawnY + 2,
            vx: dir * speed + (Math.random() - 0.5) * 0.6,
            vy: upward + (Math.random() - 0.3) * 0.4,
            life: 0.8 + Math.random() * 0.4,
            age: 0,
            size: Math.random() * 2 + 1.6,
            radius: 5,
            bounce: 0.22,
            friction: 0.86,
            onGround: false,
            color: '#888888',
            alpha: 1
        });
    }
}

const PARTICLE_CAP = 250;

function pushParticle(p) {
    if (particles.length >= PARTICLE_CAP) particles.shift();
    if (p.alpha === undefined) p.alpha = 1;
    particles.push(p);
}


// UPDATED: Physically accurate particle engine with player/hazard collision
function updateParticles(dt) {
    const seconds = dt * (1 / 60);
    const GRAV = 18; // Particle gravity constant

    for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];

        // Age and lifetime
        p.age += seconds;
        if (p.age >= p.life) {
            particles.splice(i, 1);
            continue;
        }

        // Gravity
        if (!p.onGround) {
            p.vy += GRAV * seconds;
        }

        // Integrate position (scale by dt to match engine)
        p.x += p.vx * dt;
        p.y += p.vy * dt;

        // Platform collisions (existing)
        for (let plat of platforms) {
            if (p.x + p.radius < plat.x || p.x - p.radius > plat.x + plat.w ||
                p.y + p.radius < plat.y || p.y - p.radius > plat.y + plat.h) continue;

            const nearestX = Math.max(plat.x, Math.min(p.x, plat.x + plat.w));
            const nearestY = Math.max(plat.y, Math.min(p.y, plat.y + plat.h));
            const dx = p.x - nearestX;
            const dy = p.y - nearestY;
            const dist2 = dx * dx + dy * dy;

            if (dist2 <= (p.radius * p.radius)) {
                const dist = Math.sqrt(dist2) || 0.0001;
                const pen = p.radius - dist;

                // Push particle out of platform
                p.x += (dx / dist) * pen;
                p.y += (dy / dist) * pen;

                // If hitting top, settle or bounce
                if (dy < 0) {
                    if (Math.abs(p.vy) > 1.0) {
                        p.vy = -p.vy * (p.bounce || 0.2);
                        p.vx *= 0.7;
                    } else {
                        p.vy = 0;
                        p.onGround = true;
                        p.vx *= (p.friction || 0.85);
                    }
                } else {
                    p.vx *= 0.6;
                    p.vy *= 0.6;
                }
            }
        }

        // NEW: Simple collision with players (AABB). Particles bounce off players slightly.
        for (let id in players) {
            const pl = players[id];
            if (!pl) continue;
            // AABB test
            if (p.x + p.radius > pl.x && p.x - p.radius < pl.x + pl.width &&
                p.y + p.radius > pl.y && p.y - p.radius < pl.y + pl.height) {

                // Push particle away from player center
                const cx = (pl.x + pl.width / 2);
                const cy = (pl.y + pl.height / 2);
                let dx = p.x - cx;
                let dy = p.y - cy;
                const d = Math.sqrt(dx * dx + dy * dy) || 0.0001;
                dx /= d; dy /= d;

                // Nudge particle out and damp velocity
                p.x += dx * (p.radius + Math.max(pl.width, pl.height) * 0.1);
                p.y += dy * (p.radius + Math.max(pl.width, pl.height) * 0.1);
                p.vx = p.vx * 0.4 + dx * 0.6;
                p.vy = p.vy * 0.4 + dy * 0.6;
            }
        }

        // NEW: Simple collision with hazards (treat as solid)
        for (let h of hazards) {
            if (p.x + p.radius > h.x && p.x - p.radius < h.x + h.w &&
                p.y + p.radius > h.y && p.y - p.radius < h.y + h.h) {

                // Bounce away from hazard center
                const hx = h.x + h.w / 2;
                const hy = h.y + h.h / 2;
                let dx = p.x - hx;
                let dy = p.y - hy;
                const d = Math.sqrt(dx * dx + dy * dy) || 0.0001;
                dx /= d; dy /= d;

                p.x += dx * (p.radius + Math.max(h.w, h.h) * 0.1);
                p.y += dy * (p.radius + Math.max(h.w, h.h) * 0.1);
                p.vx = p.vx * 0.3 + dx * 0.6;
                p.vy = p.vy * 0.3 + dy * 0.6;
            }
        }

        // Appearance updates
        p.alpha = Math.max(0, 1 - (p.age / p.life));
        p.renderSize = (p.size || 2) * (0.6 + 0.4 * (1 - p.age / p.life));
    }
}


function drawParticles() {
    particles.forEach(p => {
        if (p.type === 'dust_down') {
            ctx.globalAlpha = p.alpha * 0.9;
            ctx.fillStyle = p.color;
            ctx.fillRect(p.x - p.renderSize, p.y - (p.renderSize * 0.15), p.renderSize * 2, p.renderSize * 0.35);
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

function processGemCapture(gemId, targetId) {
    if (!isHost) return;
    const targetGem = gems.find(g => g.id === gemId);
    if (targetGem && !targetGem.collected) {
        targetGem.collected = true;
        if (players[targetId]) players[targetId].score += 10;

        playSound('gem');
        broadcastToRoom('sync_map', { platforms, hazards, gems });
        broadcastToRoom('sync_players', { allPlayers: players });
        updateHudDisplays();
    }
}

function respawnMatchEntity(player) {
    player.x = 100;
    player.y = 200;
    player.vx = 0;
    player.vy = 0;
    player.score = Math.max(0, player.score - 5);
    playSound('spike');

    if (isHost) {
        broadcastToRoom('sync_players', { allPlayers: players });
        updateHudDisplays();
    }
}

// Boundary Collision utilities
function checkCollision(r1, r2) {
    return (r1.x < r2.x + r2.w && r1.x + r1.width > r2.x && r1.y < r2.y + r2.h && r1.y + r1.height > r2.y);
}

function checkCircleCollision(player, gem) {
    const pCenterX = player.x + player.width / 2;
    const pCenterY = player.y + player.height / 2;
    return Math.hypot(pCenterX - gem.x, pCenterY - gem.y) < (player.width / 2 + 15);
}

// Rendering elements
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
        if (g.collected) return;
        ctx.fillStyle = '#00ff66';
        ctx.beginPath();
        ctx.arc(g.x, g.y, 8, 0, Math.PI * 2);
        ctx.fill();
    });

    if (currentEngineMode === 'LOBBY') {
        ctx.shadowColor = skinDoor.color;
        ctx.shadowBlur = 15;
        ctx.fillStyle = '#1c0515';
        ctx.fillRect(skinDoor.x, skinDoor.y, skinDoor.w, skinDoor.h);
        ctx.strokeStyle = skinDoor.color;
        ctx.lineWidth = 4;
        ctx.strokeRect(skinDoor.x, skinDoor.y, skinDoor.w, skinDoor.h);

        ctx.fillStyle = '#ffffff';
        ctx.font = '12px "Orbitron"';
        ctx.textAlign = 'center';
        ctx.shadowBlur = 0;

        ctx.shadowColor = lobbyDoor.color;
        ctx.shadowBlur = 15;
        ctx.fillStyle = '#2a1a00';
        ctx.fillRect(lobbyDoor.x, lobbyDoor.y, lobbyDoor.w, lobbyDoor.h);

        ctx.strokeStyle = lobbyDoor.color;
        ctx.lineWidth = 4;
        ctx.strokeRect(lobbyDoor.x, lobbyDoor.y, lobbyDoor.w, lobbyDoor.h);
        ctx.shadowBlur = 0;

        if (lobbyCountdownVal >= 0) {
            ctx.fillStyle = '#ff007f';
            ctx.font = 'bold 36px "Orbitron"';
            ctx.textAlign = 'center';
            ctx.shadowColor = '#ff007f';
            ctx.shadowBlur = 15;
            ctx.fillText(`MATCH STARTING IN: ${lobbyCountdownVal}s`, canvas.width / 2, 60);
            ctx.shadowBlur = 0;
        }
    }
}

// Calculate hand angle for a player looking at cursor
function calculateHandAngle(player) {
    const handPivotX = player.x + player.width * 0.5;
    const handPivotY = player.y + player.height * 0.2;
    
    const mouseWorld = getMouseWorldPos();
    const dx = mouseWorld.x - handPivotX;
    const dy = mouseWorld.y - handPivotY;

    // Calculate angle to cursor
    const cursorAngle = Math.atan2(dy, dx);

    // Player facing direction: 0 rad = facing right, Math.PI = facing left
    const facingAngle = player.facingRight ? 0 : Math.PI;

    // Calculate angle difference (normalized to -π to π)
    let angleDiff = cursorAngle - facingAngle;
    while (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
    while (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;

    // Only draw hand if cursor is within 150° (75° each side) of facing direction
    const maxAngle = (150 * Math.PI) / 360; // 75 degrees in radians

    if (Math.abs(angleDiff) <= maxAngle) {
        // Cursor is within view cone - point at cursor
        return cursorAngle;
    } else {
        // Cursor is behind player - point hand backward at edge of view cone
        return facingAngle + (angleDiff > 0 ? maxAngle : -maxAngle);
    }
}

function drawCharacterModel(pModel) {
    // 1. Calculate squish factor based on movement state (squash when grounded, stretch when airborne)
    let squishY = pModel.isGrounded ? 0 : 5;

    // OUTLINE EFFECT: Draw darker outline around character (works with any shape)
    ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
    const outlineSize = 1.5;
    // Draw offset copies to create outline glow
    for (let ox = -outlineSize; ox <= outlineSize; ox++) {
        for (let oy = -outlineSize; oy <= outlineSize; oy++) {
            if (ox === 0 && oy === 0) continue; // Skip center (will be filled normally)
            ctx.fillRect(pModel.x + ox, pModel.y + squishY + oy, pModel.width, pModel.height - squishY);
        }
    }

    // 2. Draw the player with squash/stretch effect (main body)
    ctx.fillStyle = pModel.color;
    ctx.fillRect(pModel.x, pModel.y + squishY, pModel.width, pModel.height - squishY);

    // 3. Draw head (circle above the body)
    const headRadius = pModel.width / 1.5;
    const headCenterX = pModel.x + pModel.width / 2;
    const headCenterY = pModel.y - 10;

    // Head outline
    ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
    for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.arc(headCenterX, headCenterY, headRadius + i * 0.5, 0, Math.PI * 2);
        ctx.fill();
    }

    // Head main
    ctx.fillStyle = pModel.color;
    ctx.beginPath();
    ctx.arc(headCenterX, headCenterY, headRadius, 0, Math.PI * 2);
    ctx.fill();

    // 5. Draw hand (rectangle) - use synchronized hand angle for all players
    const handPivotX = pModel.x + pModel.width * 0.5;
    const handPivotY = pModel.y + pModel.height * 0.2;
    
    // For local player, calculate hand angle in real-time based on cursor
    // For other players, use the synchronized hand angle
    let handAngle;
    if (pModel.id === localPlayerId) {
        handAngle = calculateHandAngle(pModel);
    } else {
        handAngle = pModel.handAngle !== undefined ? pModel.handAngle : (pModel.facingRight ? 0 : Math.PI);
    }

    // Draw hand
    ctx.save();
    ctx.translate(handPivotX, handPivotY);
    ctx.rotate(handAngle);

    // Draw hand outline
    ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.fillRect(-1, -4, 20, 8);

    // Draw hand main
    ctx.fillStyle = pModel.color;
    ctx.fillRect(0, -3, 18, 6);

    // Optional finger/point
    ctx.fillStyle = pModel.color;
    ctx.beginPath();
    ctx.moveTo(18, -5);
    ctx.lineTo(26, 0);
    ctx.lineTo(18, 5);
    ctx.closePath();
    ctx.fill();

    ctx.globalAlpha = 1;
    ctx.restore();

    // 6. Draw nametag and score
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    let labelStr = pModel.nameTag || 'P?';
    if (pModel.id === localPlayerId) {
        labelStr += ' (YOU)';
    }
    ctx.fillText(labelStr, pModel.x + pModel.width / 2, pModel.y - 30);

    // 7. Spawn dust particles when landing (squishY = 0 means grounded)
    if (pModel.isGrounded && pModel.vy > 5 && !pModel.isDashing) {
        spawnDustParticles(pModel.x, pModel.y + pModel.height);
    }
}

// Helper to step through particle arrays and clean them up when dead
function updateAndRenderParticles() {
    for (let i = particles.length - 1; i >= 0; i--) {
        let p = particles[i];
        p.x += p.vx;
        p.y += p.vy;
        p.alpha -= 0.04; // Fade out rate

        if (p.alpha <= 0) {
            particles.splice(i, 1);
            continue;
        }

        ctx.save();
        ctx.globalAlpha = p.alpha;
        ctx.fillStyle = p.color;
        // Draw decorative retro square dust trail particle fragments
        ctx.fillRect(p.x, p.y, p.size, p.size);
        ctx.restore();
    }
}

function drawOffscreenRadarIndicators() {
    if (!players[localPlayerId]) return;

    const padding = 25; // Margin away from canvas edges

    for (let id in players) {
        if (id === localPlayerId) continue; // Skip ourselves

        let p = players[id];

        // Convert world platform positions into real screen pixel positions
        let screenX = (p.x + p.width / 2 - camera.x) * camera.zoom;
        let screenY = (p.y + p.height / 2 - camera.y) * camera.zoom;

        // Determine if target coordinates sit outside our 1280x720 window
        let isOffscreen = (screenX < 0 || screenX > BASE_WIDTH || screenY < 0 || screenY > BASE_HEIGHT);

        if (isOffscreen) {
            // Pin arrow coordinates cleanly inside screen boundaries
            let arrowX = Math.max(padding, Math.min(BASE_WIDTH - padding, screenX));
            let arrowY = Math.max(padding, Math.min(BASE_HEIGHT - padding, screenY));

            // Derive directional rotation pointing outward toward player's position
            let angle = Math.atan2(screenY - arrowY, screenX - arrowX);

            ctx.save();
            ctx.translate(arrowX, arrowY);
            ctx.rotate(angle);

            // Draw a high-visibility neon triangular arrow matching player color
            ctx.fillStyle = p.color;
            ctx.shadowColor = p.color;
            ctx.shadowBlur = 10;

            ctx.beginPath();
            ctx.moveTo(12, 0);     // Tip of pointer facing outward
            ctx.lineTo(-8, -10);   // Back top tail
            ctx.lineTo(-4, 0);     // Indented center tail
            ctx.lineTo(-8, 10);    // Back bottom tail
            ctx.closePath();
            ctx.fill();

            // Draw a micro label marker for player tracking identification
            ctx.shadowBlur = 0;
            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 9px monospace';
            ctx.textAlign = 'center';
            ctx.fillText("PLR", -16, 3);

            ctx.restore();
        }
    }
}

// NEW: Draw a custom, private neon dash cooldown indicator above the character
function drawDashCooldownBar(p) {
    const barWidth = p.width + 20;       // Match the width of your character
    const barHeight = 3;            // Thickness of the bar
    const x = p.x - 10;
    const y = p.y - 24;             // Floats 24 pixels directly above the character's head

    // 1. Draw the semi-transparent dark background track frame
    ctx.fillStyle = 'rgba(11, 6, 18, 0.7)';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.lineWidth = 1;
    ctx.fillRect(x, y, barWidth, barHeight);
    ctx.strokeRect(x, y, barWidth, barHeight);

    // 2. Calculate the filling progress factor (from 0.0 to 1.0)
    const maxCooldown = 45; // Matches the player.dashCooldown assignment in your physics rules
    let currentCooldown = Math.max(0, p.dashCooldown || 0);
    let fillPercent = (maxCooldown - currentCooldown) / maxCooldown;
    fillPercent = Math.max(0, Math.min(1, fillPercent)); // Safety clamp boundaries

    // 3. Draw the filling animation bar with contextual glow states
    ctx.save(); // Save canvas context state to separate shadows from the rest of the game scene

    if (fillPercent >= 1) {
        // --- DASH READY STATE: Radiant Cyan Glowing Bar ---
        ctx.shadowBlur = 10;
        ctx.shadowColor = '#00f2fe';
        ctx.fillStyle = '#00f2fe';
    } else {
        // --- CHARGING STATE: Dim Neon Pink Bar (No Glow) ---
        ctx.shadowBlur = 0;
        ctx.fillStyle = '#ff007f';
    }

    // Render the filled fraction slice inside the track container
    ctx.fillRect(x + 0.5, y + 0.5, (barWidth - 1) * fillPercent, barHeight - 1);

    ctx.restore(); // Safely clear out shadow configuration for subsequent rendering iterations
}

// Convert world coordinates to screen space (after camera transforms are removed)
function worldToScreen(worldX, worldY) {
    return {
        sx: (worldX - camera.x) * camera.zoom + BASE_WIDTH / 2,
        sy: (worldY - camera.y) * camera.zoom + BASE_HEIGHT / 2
    };
}

// REFACTORED: Draw interactive skin door UI with neon glow styling (world space - zooms with camera)
function drawSkinDoorUI() {
    if (currentEngineMode !== 'LOBBY') {
        return;
    }

    // Setup neon text styling
    ctx.fillStyle = '#ffffff';
    ctx.font = '20px "Orbitron"';
    ctx.textAlign = 'center';
    ctx.shadowColor = '#ff007f';
    ctx.shadowBlur = 12;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;

    // Door center in WORLD coordinates (not screen space)
    const doorCenterX = skinDoor.x + skinDoor.w / 2;
    const doorCenterY = skinDoor.y;

    // Draw "Edit Skin" label above the door (always visible)
    ctx.fillText("Edit Skin", doorCenterX, doorCenterY - 20);

    // Draw "[F] | open" prompt at the door center (only when colliding)
    const localPlayer = players[localPlayerId];
    if (localPlayer && checkCollision(localPlayer, skinDoor)) {
        ctx.fillText("[F] | open", doorCenterX, doorCenterY + skinDoor.h / 2);

        // Handle interaction
        if (keys.Interact) {
            openSkinMenu();
            keys.Interact = false;
        }
    }
}

// Draw start door UI label with neon glow styling
function drawStartDoorUI() {
    if (currentEngineMode !== 'LOBBY') {
        return;
    }

    // Setup neon text styling
    ctx.fillStyle = '#ffffff';
    ctx.font = '20px "Orbitron"';
    ctx.textAlign = 'center';
    ctx.shadowColor = '#ffcc00';
    ctx.shadowBlur = 12;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;

    // Door center in WORLD coordinates (not screen space)
    const doorCenterX = lobbyDoor.x + lobbyDoor.w / 2;
    const doorCenterY = lobbyDoor.y;

    // Draw "Start" label above the door (always visible)
    ctx.fillText("Start", doorCenterX, doorCenterY - 20);

    // Display countdown indicator instead of interaction prompt
    const doorDisplayY = doorCenterY + lobbyDoor.h / 2;
    const touchingCount = getTouchingDoorCount();
    const totalPlayers = Object.keys(players).length;

    ctx.font = '16px "Orbitron"';
    ctx.fillText(`${touchingCount}/${totalPlayers}`, doorCenterX, doorDisplayY);
}

// Updated to accept the browser's high-resolution timestamp
function enginePipelineTick(timestamp) {
    // Initialize timestamp on the very first frame execution
    if (!lastTime) lastTime = timestamp;

    // Calculate delta time relative to a baseline of 60 FPS (16.66ms per frame = dt of 1.0)
    let dt = (timestamp - lastTime) / 16.666;
    lastTime = timestamp;

    // Safety Cap: Prevent massive physics glitches/clipping if the browser lags or focus drops
    if (dt > 3.0) dt = 3.0;

    ctx.fillStyle = '#0b0612';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (currentEngineMode === 'LOBBY' || currentEngineMode === 'GAME') {
        let localPlayer = players[localPlayerId];

        if (localPlayer) {
            // PASS DELTA TIME DOWN INTO PHYSICS
            updateCharacterPhysics(localPlayer, dt);

            // Resolve player-to-player collisions
            resolvePlayerCollisions();

            if (isHost) {
                evaluateLobbyDoorTrigger();
                // Update local player's hand angle for sync
                localPlayer.handAngle = calculateHandAngle(localPlayer);
                broadcastToRoom('sync_players', { allPlayers: players });
            } else {
                hostConnection.send({
                    type: 'client_input_update',
                    senderId: localPlayerId,
                    payload: {
                        x: localPlayer.x,
                        y: localPlayer.y,
                        facingRight: localPlayer.facingRight,
                        isDashing: localPlayer.isDashing,
                        handAngle: calculateHandAngle(localPlayer)
                    }
                });
            }

            // Camera calculations naturally adjust with smooth interpolation
            camera.zoom += (camera.targetZoom - camera.zoom) * 0.1 * dt;

            let targetCamX = (localPlayer.x + localPlayer.width / 2) - (BASE_WIDTH / 2) / camera.zoom;
            let targetCamY = (localPlayer.y + localPlayer.height / 2) - (BASE_HEIGHT / 2) / camera.zoom;

            let maxCamX = BASE_WIDTH - BASE_WIDTH / camera.zoom;
            let maxCamY = BASE_HEIGHT - BASE_HEIGHT / camera.zoom;
            targetCamX = Math.max(0, Math.min(targetCamX, maxCamX));
            targetCamY = Math.max(0, Math.min(targetCamY, maxCamY));

            camera.x += (targetCamX - camera.x) * 0.1 * dt;
            camera.y += (targetCamY - camera.y) * 0.1 * dt;
        } else {
            camera.zoom = 1.0;
            camera.x = 0;
            camera.y = 0;
        }

        ctx.save();
        ctx.scale(camera.zoom, camera.zoom);
        ctx.translate(-camera.x, -camera.y);

        drawCanvasLevelLayout();
        updateAndRenderParticles(); // These can continue running visually frame-by-frame

        for (let id in players) {
            let p = players[id];

            if (p.isDashing) {
                for (let i = 0; i < 2; i++) {
                    particles.push({
                        x: p.x + (p.facingRight ? 0 : p.width),
                        y: p.y + Math.random() * p.height,
                        vx: (p.facingRight ? -3 : 3) + (Math.random() - 0.5),
                        vy: (Math.random() - 0.5) * 1,
                        alpha: 1,
                        size: Math.random() * 5 + 4,
                        color: p.color
                    });
                }
            }
            drawCharacterModel(p);

            // --- CRITICAL UPDATE: PRIVATE POV DASH COOLDOWN INDICATOR ---
            // Evaluates natively on each client; only renders if the loop ID matches your own connection
            if (id === localPlayerId) {
                drawDashCooldownBar(p);
            }
        }

        // --- INTERACTIVE SKIN DOOR DETECTION PROMPT (drawn in world space) ---
        drawSkinDoorUI();

        // --- INTERACTIVE START DOOR DETECTION PROMPT (drawn in world space) ---
        drawStartDoorUI();

        ctx.restore();

        drawOffscreenRadarIndicators();

    } else {
        ctx.fillStyle = '#110924';
        ctx.font = '20px "Orbitron"';
        ctx.textAlign = 'center';
        ctx.fillText("WAITING IN PLATFORM MENU...", canvas.width / 2, canvas.height / 2);
    }

    requestAnimationFrame(enginePipelineTick);
}

// Hardware Input Mapping Events
window.addEventListener('keydown', (e) => {
    if (['ArrowLeft', 'a', 'A'].includes(e.key)) keys.ArrowLeft = true;
    if (['ArrowRight', 'd', 'D'].includes(e.key)) keys.ArrowRight = true;
    if (['ArrowUp', 'w', 'W', ' '].includes(e.key)) keys.ArrowUp = true;
    if (['f', 'F'].includes(e.key)) keys.Interact = true;
    if (e.code === 'ShiftLeft') keys.ShiftLeft = true; // NEW: Map physical Left Shift
});

window.addEventListener('keyup', (e) => {
    if (['ArrowLeft', 'a', 'A'].includes(e.key)) keys.ArrowLeft = false;
    if (['ArrowRight', 'd', 'D'].includes(e.key)) keys.ArrowRight = false;
    if (['ArrowUp', 'w', 'W', ' '].includes(e.key)) keys.ArrowUp = false;
    if (['f', 'F'].includes(e.key)) keys.Interact = false;
    if (e.code === 'ShiftLeft') keys.ShiftLeft = false; // NEW: Release physical Left Shift
});

// NEW: Mouse Observers for Viewport Toggle
window.addEventListener('mousedown', (e) => {
    if (e.button === 1) { // 1 is the Middle Mouse Button
        e.preventDefault();
        camera.isZoomed = !camera.isZoomed;
        camera.targetZoom = camera.isZoomed ? 1.75 : 1.0; // 1.75x close up focus zoom
    }
});

// NEW: Dynamic Scroll Wheel Zoom Observers
window.addEventListener('wheel', (e) => {
    // Only capture zoom adjustments if the game is active
    if (currentEngineMode === 'LOBBY' || currentEngineMode === 'GAME') {
        e.preventDefault(); // Stop the browser from scrolling the web page

        const zoomSensitivity = 0.15; // Tuning variable for increment speed per notch

        if (e.deltaY < 0) {
            // Rolling Up -> Zoom In closer to character
            camera.targetZoom = Math.min(camera.maxZoom, camera.targetZoom + zoomSensitivity);
        } else if (e.deltaY > 0) {
            // Rolling Down -> Zoom Out back toward full overview
            camera.targetZoom = Math.max(camera.minZoom, camera.targetZoom - zoomSensitivity);
        }
    }
}, { passive: false });

// Keep this to prevent default middle-click scroll anchor popups from disrupting focus
window.addEventListener('pointerdown', (e) => {
    if (e.button === 1) e.preventDefault();
});

function bindTouchBtn(elementId, action) {
    const el = document.getElementById(elementId);
    if (!el) return;
    el.addEventListener('touchstart', (e) => { e.preventDefault(); touchState[action] = true; });
    el.addEventListener('touchend', (e) => { e.preventDefault(); touchState[action] = false; });
    el.addEventListener('touchcancel', (e) => { e.preventDefault(); touchState[action] = false; });
}
bindTouchBtn('btn-left', 'left');
bindTouchBtn('btn-right', 'right');
bindTouchBtn('btn-jump', 'jump');

// Color Management Matrix Selection Triggers
function selectCharacterColor(hexColor, buttonElement) {
    if (players[localPlayerId] && players[localPlayerId].color === hexColor) {
        return;
    }

    // Check if color is already taken by another player
    const isColorTaken = isColorAlreadyUsed(hexColor, localPlayerId);
    if (isColorTaken) {
        return; // Prevent selection of taken colors
    }

    if (players[localPlayerId]) {
        players[localPlayerId].color = hexColor;

        if (isHost) {
            // Host propagates changes outwards directly
            broadcastToRoom('sync_players', { allPlayers: players });
        } else if (hostConnection && hostConnection.open) {
            // Guests pass changes upwards through data stream pipes
            hostConnection.send({
                type: 'update_skin',
                senderId: localPlayerId,
                payload: { color: hexColor }
            });
        }
    }

    // --- VISUAL SELECTION INDICATION ---
    if (buttonElement) {
        // 1. Reset all buttons back to transparent borders
        document.querySelectorAll('.color-btn').forEach(btn => {
            btn.classList.remove('border-white', 'scale-105');
            btn.classList.add('border-transparent');
        });

        // 2. Highlight only the one the user just clicked
        buttonElement.classList.remove('border-transparent');
        buttonElement.classList.add('border-white', 'scale-105');
    }

    // Optional: Leave this commented out if you want players to see 
    // their selection border active before they choose to close the menu.
    // closeSkinMenu();
}
function isColorAlreadyUsed(hexColor, excludePlayerId) {
    if (!hexColor) return false;
    const cleanHexColor = hexColor.trim().toLowerCase();

    for (let id in players) {
        if (id !== excludePlayerId && players[id] && players[id].color) {
            const cleanPlayerColor = players[id].color.trim().toLowerCase();
            if (cleanPlayerColor === cleanHexColor) {
                return true;
            }
        }
    }
    return false;
}

// Update color button states based on which colors are taken by OTHER players
function updateColorButtonStates() {
    const localColor = players[localPlayerId]?.color?.trim().toLowerCase();

    document.querySelectorAll('.color-btn').forEach(btn => {
        const btnColorRaw = btn.getAttribute('data-color');
        if (!btnColorRaw) return;
        const btnColor = btnColorRaw.trim().toLowerCase();

        // If this is the local player's color, keep it highlighted and enabled
        if (localColor && btnColor === localColor) {
            btn.classList.remove('disabled-color', 'border-transparent');
            btn.classList.add('border-white', 'scale-105');
            btn.style.pointerEvents = 'auto';
            return;
        }

        // Mark as taken only if another player uses it
        const takenByOther = isColorAlreadyUsed(btnColor, localPlayerId);
        if (takenByOther) {
            btn.classList.add('disabled-color');
            btn.classList.remove('border-white', 'scale-105');
            btn.classList.add('border-transparent');
            btn.style.pointerEvents = 'none';
        } else {
            btn.classList.remove('disabled-color');
            btn.classList.remove('border-white', 'scale-105');
            btn.classList.add('border-transparent');
            btn.style.pointerEvents = 'auto';
        }
    });
}


function openSkinMenu() {
    console.log('openSkinMenu called');

    const modal = document.getElementById('skin-modal');
    console.log('skin-modal element:', modal);

    try {
        if (modal) modal.classList.remove('hidden');
    } catch (err) {
        console.error('error toggling modal class:', err);
    }

    // 1: mark taken colors
    if (typeof updateColorButtonStates === 'function') {
        console.log('calling updateColorButtonStates');
        try { updateColorButtonStates(); } catch (err) { console.error('updateColorButtonStates error', err); }
    } else {
        console.warn('updateColorButtonStates is not defined');
    }

    // 2: highlight local player's color
    console.log('localPlayerId:', localPlayerId);
    console.log('players object keys:', Object.keys(players || {}));
    const currentColor = players[localPlayerId]?.color;
    console.log('currentColor raw:', currentColor);

    if (currentColor) {
        const normalized = currentColor.trim().toLowerCase();
        document.querySelectorAll('.color-btn').forEach(btn => {
            const btnColor = btn.getAttribute('data-color')?.trim().toLowerCase();
            if (btnColor === normalized) {
                console.log('highlighting button for color', btnColor, btn);
                btn.classList.remove('border-transparent');
                btn.classList.add('border-white', 'scale-105');
                btn.style.pointerEvents = 'auto';
            }
        });
    } else {
        console.warn('no currentColor to highlight');
    }

    console.log('openSkinMenu finished');
}



function closeSkinMenu() {
    document.getElementById('skin-modal').classList.add('hidden');
}

// Initialization Start
enginePipelineTick();