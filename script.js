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
const MAX_FALL_SPEED = 5;
const MOVE_SPEED = 2;
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

// Map Layout Elements
let platforms = [];
let hazards = [];
let gems = [];

let particles = [];

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

// Inputs Map
const keys = { ArrowLeft: false, ArrowRight: false, ArrowUp: false, ShiftLeft: false };
const touchState = { left: false, right: false, jump: false };

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

function createPlayerProfile(id, slotIndex) {
    return {
        id: id,
        x: 100 + (slotIndex * 45),
        y: 500,
        vx: 0,
        vy: 0,
        width: 32,
        height: 48,
        color: playerColors[slotIndex % playerColors.length],
        isGrounded: false,
        facingRight: true,
        score: 0,
        jumpsLeft: 2,
        wasJumpPressed: false,
        dashCooldown: 0,
        dashTimer: 0,
        isDashing: false,
        wasDashPressed: false
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
        players[localPlayerId] = createPlayerProfile(localPlayerId, 0);

        enterLobbyState();
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

function setupHostRoutingRules(conn) {
    conn.on('open', () => {
        const assignedSlotIndex = Object.keys(players).length;
        const newClientId = conn.peer;

        players[newClientId] = createPlayerProfile(newClientId, assignedSlotIndex);
        updateHudDisplays();

        conn.send({
            type: 'init_welcome',
            payload: { assignedId: newClientId, allPlayers: players, mode: currentEngineMode }
        });

        broadcastToRoom('sync_map', { platforms, hazards, gems });
        broadcastToRoom('sync_players', { allPlayers: players });
    });

    conn.on('data', (package) => {
        if (package.type === 'client_input_update') {
            if (players[package.senderId]) {
                players[package.senderId].x = package.payload.x;
                players[package.senderId].y = package.payload.y;
                players[package.senderId].facingRight = package.payload.facingRight;
                players[package.senderId].isDashing = package.payload.isDashing;
            }
            broadcastToRoom('sync_players', { allPlayers: players });
        }
        if (package.type === 'request_collect_gem') {
            processGemCapture(package.payload.gemId, package.senderId);
        }
    });

    conn.on('close', () => {
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

// REMADE: Gameplay Physics Engine Mechanics Loop
function updateCharacterPhysics(player) {
    if (player.dashCooldown > 0) player.dashCooldown--;

    let left = keys.ArrowLeft || touchState.left;
    let right = keys.ArrowRight || touchState.right;
    let jump = keys.ArrowUp || touchState.jump;
    let shift = keys.ShiftLeft;

    let dashJustPressed = shift && !player.wasDashPressed;
    player.wasDashPressed = shift;

    if (dashJustPressed && player.dashCooldown <= 0 && !player.isDashing) {
        player.isDashing = true;
        player.dashTimer = 10;
        player.dashCooldown = 45;
        // CRITICAL FIX: Removed player.vy = 0; to preserve jump momentum!
    }

    // --- HORIZONTAL AXIS PHYSICS ---
    if (player.isDashing) {
        player.vx = player.facingRight ? DASH_SPEED : -DASH_SPEED;
        player.dashTimer--;

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
            player.vx *= FRICTION;
            if (Math.abs(player.vx) < 0.1) player.vx = 0;
        }
    }

    // --- VERTICAL AXIS PHYSICS (Runs unconditionally to blend trajectories!) ---
    let dynamicGravity = GRAVITY;
    if (jump && player.vy < 0) {
        dynamicGravity = GRAVITY * 0.4;
    }
    player.vy += dynamicGravity;

    if (player.vy > MAX_FALL_SPEED) player.vy = MAX_FALL_SPEED;

    if (player.isGrounded) {
        player.jumpsLeft = 2;
    }

    // Jump Input Triggers
    let jumpJustPressed = jump && !player.wasJumpPressed;
    player.wasJumpPressed = jump;

    if (jumpJustPressed) {
        if (player.isGrounded) {
            player.vy = -9;
            player.isGrounded = false;
            player.jumpsLeft = 1;
            playSound('jump');
        } else if (player.jumpsLeft > 0) {
            player.vy = -6;
            player.jumpsLeft = 0;
            playSound('jump');
        }
    }

    player.isGrounded = false;

    // Position updates and bounding updates
    player.x += player.vx;
    platforms.forEach(plat => {
        if (checkCollision(player, plat)) {
            if (player.vx > 0) player.x = plat.x - player.width;
            else if (player.vx < 0) player.x = plat.x + plat.w;
            player.vx = 0;
            if (player.isDashing) player.isDashing = false; // Cancel dash on wall hit
        }
    });

    player.y += player.vy;
    platforms.forEach(plat => {
        if (checkCollision(player, plat)) {
            if (player.vy > 0) {
                player.y = plat.y - player.height;
                player.isGrounded = true;
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
        ctx.shadowColor = lobbyDoor.color;
        ctx.shadowBlur = 15;
        ctx.fillStyle = '#2a1a00';
        ctx.fillRect(lobbyDoor.x, lobbyDoor.y, lobbyDoor.w, lobbyDoor.h);

        ctx.strokeStyle = lobbyDoor.color;
        ctx.lineWidth = 4;
        ctx.strokeRect(lobbyDoor.x, lobbyDoor.y, lobbyDoor.w, lobbyDoor.h);

        const totalPlayers = Object.keys(players).length;
        let touchingCount = 0;
        for (let id in players) {
            if (checkCollision(players[id], lobbyDoor)) {
                touchingCount++;
            }
        }

        ctx.fillStyle = '#ffffff';
        ctx.font = '16px "Orbitron"';
        ctx.textAlign = 'center';
        ctx.fillText(`${touchingCount}/${totalPlayers}`, lobbyDoor.x + lobbyDoor.w / 2, lobbyDoor.y + lobbyDoor.h / 2 + 5);
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

function drawCharacterModel(pModel) {
    ctx.fillStyle = pModel.color;
    ctx.fillRect(pModel.x, pModel.y, pModel.width, pModel.height);

    ctx.fillStyle = '#ffffff';
    const offset = pModel.facingRight ? 20 : 4;
    ctx.fillRect(pModel.x + offset, pModel.y + 10, 8, 4);

    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    const labelStr = pModel.id === localPlayerId ? `YOU (${pModel.score}分)` : `PLR (${pModel.score}分)`;
    ctx.fillText(labelStr, pModel.x + pModel.width / 2, pModel.y - 8);
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

function enginePipelineTick() {
    ctx.fillStyle = '#0b0612';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (currentEngineMode === 'LOBBY' || currentEngineMode === 'GAME') {
        let localPlayer = players[localPlayerId];

        if (localPlayer) {
            updateCharacterPhysics(localPlayer);

            if (isHost) {
                evaluateLobbyDoorTrigger();
                broadcastToRoom('sync_players', { allPlayers: players });
            } else {
                hostConnection.send({
                    type: 'client_input_update',
                    senderId: localPlayerId,
                    payload: {
                        x: localPlayer.x,
                        y: localPlayer.y,
                        facingRight: localPlayer.facingRight,
                        isDashing: localPlayer.isDashing
                    }
                });
            }

            // --- CAMERA CALCULATIONS ---
            // Interpolate scaling values smoothly
            camera.zoom += (camera.targetZoom - camera.zoom) * 0.1;

            // Calculate destination target centered squarely around player center
            let targetCamX = (localPlayer.x + localPlayer.width / 2) - (BASE_WIDTH / 2) / camera.zoom;
            let targetCamY = (localPlayer.y + localPlayer.height / 2) - (BASE_HEIGHT / 2) / camera.zoom;

            // Clamp camera viewport coordinates to map borders (0,0 to 1280,720)
            let maxCamX = BASE_WIDTH - BASE_WIDTH / camera.zoom;
            let maxCamY = BASE_HEIGHT - BASE_HEIGHT / camera.zoom;
            targetCamX = Math.max(0, Math.min(targetCamX, maxCamX));
            targetCamY = Math.max(0, Math.min(targetCamY, maxCamY));

            // Smooth horizontal and vertical camera transitions
            camera.x += (targetCamX - camera.x) * 0.1;
            camera.y += (targetCamY - camera.y) * 0.1;
        } else {
            // Default global fallback positioning rules if player profile missing
            camera.zoom = 1.0;
            camera.x = 0;
            camera.y = 0;
        }

        // ==========================================
        // LAYER 1: WORLD SPACE RENDERING (TRANSFORMED)
        // ==========================================
        ctx.save();
        ctx.scale(camera.zoom, camera.zoom);
        ctx.translate(-camera.x, -camera.y);

        drawCanvasLevelLayout();
        updateAndRenderParticles();

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
        }
        ctx.restore(); // Return back to standard 1:1 pixel grid definitions

        // ==========================================
        // LAYER 2: SCREEN SPACE RENDERING (UI & RADAR)
        // ==========================================
        drawOffscreenRadarIndicators(); // Draw pointer elements securely over gameplay

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
    if (e.code === 'ShiftLeft') keys.ShiftLeft = true; // NEW: Map physical Left Shift
});

window.addEventListener('keyup', (e) => {
    if (['ArrowLeft', 'a', 'A'].includes(e.key)) keys.ArrowLeft = false;
    if (['ArrowRight', 'd', 'D'].includes(e.key)) keys.ArrowRight = false;
    if (['ArrowUp', 'w', 'W', ' '].includes(e.key)) keys.ArrowUp = false;
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

// Initialization Start
enginePipelineTick();