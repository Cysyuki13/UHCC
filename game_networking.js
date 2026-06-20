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
let scoreboardVisible = true;

// Helper to show/hide the scoreboard toggle button based on game mode
function updateScoreboardButtonVisibility() {
    const btn = document.getElementById('toggle-scoreboard-btn');
    if (!btn) return;
    if (currentEngineMode === 'LOBBY' || currentEngineMode === 'GAME') {
        btn.style.display = 'inline-block';
    } else {
        btn.style.display = 'none';
    }
}

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
            safePlayers[id].grabbedBy = players[id].grabbedBy;
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
                    if (!pl.grabbedBy) {
                        pl.x = pkg.payload.x;
                        pl.y = pkg.payload.y;
                    }
                    pl.vx = pkg.payload.vx;
                    pl.vy = pkg.payload.vy;
                    pl.isGrounded = pkg.payload.isGrounded;
                    pl.facingRight = pkg.payload.facingRight;
                    pl.isDashing = pkg.payload.isDashing;
                    pl.handAngle = pkg.payload.handAngle;
                    pl.jumpsLeft = pkg.payload.jumpsLeft;   // <-- ADD THIS
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

            // ==== DRAFT/PLACEMENT PHASE ADDITIONS – HOST ROUTING ====
            case 'client_placement_cursor_update':
                if (matchPhase === 'CHOOSE' || matchPhase === 'PLACE') {
                    if (placementCursors[pkg.senderId]) {
                        placementCursors[pkg.senderId].x = pkg.payload.x;
                        placementCursors[pkg.senderId].y = pkg.payload.y;
                    }
                    broadcastToRoom('sync_placement_cursors', { cursors: placementCursors });
                }
                break;

            case 'client_draft_claim':
                if (matchPhase === 'CHOOSE') {
                    const targetItem = placementPool.find(item => item.id === pkg.payload.itemId);
                    if (targetItem && !targetItem.claimedBy) {
                        targetItem.claimedBy = pkg.senderId;
                        playerSelectedBlock[pkg.senderId] = targetItem;
                        placementCursors[pkg.senderId].confirmed = true;
                        broadcastToRoom('sync_placement_pool', { pool: placementPool, selections: playerSelectedBlock, cursors: placementCursors });
                        if (Object.keys(players).every(id => placementCursors[id].confirmed)) {
                            matchPhase = 'PLACE';
                            Object.keys(placementCursors).forEach(id => placementCursors[id].confirmed = false);
                            broadcastToRoom('transition_to_placement', { phase: 'PLACE' });
                        }
                    }
                }
                break;

            case 'client_confirm_placement':
                if (matchPhase === 'PLACE') {
                    const px = pkg.payload.x;
                    const py = pkg.payload.y;
                    const senderId = pkg.senderId;
                    const block = playerSelectedBlock[senderId];
                    if (!block) {
                        conn.send({ type: 'placement_rejected', payload: { message: "No block selected!" } });
                        break;
                    }

                    // Validate using the actual block's cells (reuse validatePlacement)
                    if (!validatePlacement(px, py, block)) {
                        conn.send({ type: 'placement_rejected', payload: { message: "Overlap or invalid position!" } });
                        break;
                    }

                    // Place each cell as a separate platform
                    const CELL_SIZE = 40;
                    block.blocks.forEach(cell => {
                        platforms.push({
                            x: px + cell.x,
                            y: py + cell.y,
                            w: CELL_SIZE,
                            h: CELL_SIZE,
                            color: block.color,
                            isDynamicObject: true,
                            isPlacedCell: true
                        });
                    });

                    placementCursors[senderId].confirmed = true;

                    broadcastToRoom('sync_map', { platforms, hazards, gems, cameraBounds, voidYThreshold });
                    broadcastToRoom('sync_placement_cursors', { cursors: placementCursors });

                    const allPlaced = Object.keys(players).every(id => placementCursors[id].confirmed);
                    if (allPlaced) {
                        matchPhase = 'PLAY';
                        broadcastToRoom('match_phase_play', { phase: 'PLAY' });
                        startOfficialMatchRun();
                    }
                }
                break;
            case 'client_rotate_block':
                if ((matchPhase === 'CHOOSE' || matchPhase === 'PLACE') && playerSelectedBlock[pkg.senderId]) {
                    const block = playerSelectedBlock[pkg.senderId];
                    block.w = pkg.payload.w;
                    block.h = pkg.payload.h;
                    block.blocks = pkg.payload.blocks;

                    if (placementCursors[pkg.senderId]) {
                        placementCursors[pkg.senderId].x = pkg.payload.cursorX;
                        placementCursors[pkg.senderId].y = pkg.payload.cursorY;
                    }

                    console.debug(`[HOST] Player ${pkg.senderId} rotated block: new size ${block.w}x${block.h}, cursor at (${placementCursors[pkg.senderId]?.x.toFixed(1)}, ${placementCursors[pkg.senderId]?.y.toFixed(1)})`);

                    broadcastToRoom('sync_placement_pool', {
                        pool: placementPool,
                        selections: playerSelectedBlock,
                        cursors: placementCursors
                    });
                }
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
                            players[id].jumpsLeft = data.jumpsLeft;   // <-- ADD THIS
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
                        players[localPlayerId].deathReason = local.deathReason || null;
                        players[localPlayerId].grabbedBy = local.grabbedBy;
                        keys.ArrowLeft = false;
                        keys.ArrowRight = false;
                        keys.ArrowUp = false;
                        spectatorMode = false;
                        spectatorTargetId = null;
                        document.getElementById('spectator-controls')?.classList.add('hidden');
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
                const localData = pkg.payload.allPlayers[localPlayerId];
                if (players[localPlayerId] && players[localPlayerId].item && localData) {
                    if (players[localPlayerId].item.ammo !== undefined) {
                        players[localPlayerId].item.ammo = localData.ammo;
                    }
                    if (localData.itemCooldown !== undefined) {
                        players[localPlayerId].item.cooldown = localData.itemCooldown;
                    }
                    players[localPlayerId].ammo = localData.ammo;
                }
                localPlayerItem = players[localPlayerId] ? players[localPlayerId].item : null;
                updateHudDisplays();
                updateColorButtonStates();
                break;
            }

            case 'sync_throwables':
                throwables = pkg.payload.throwables;
                break;
            case 'sync_robot_hands':
                activeRobotHands = pkg.payload.activeRobotHands;
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
            case 'sync_placement_cursors':
                placementCursors = pkg.payload.cursors;
                break;
            case 'sync_placement_timer':
                placementTimer = pkg.payload.value;
                break;
            case 'sync_placement_pool':
                placementPool = pkg.payload.pool;
                playerSelectedBlock = pkg.payload.selections;
                if (pkg.payload.cursors) {
                    placementCursors = pkg.payload.cursors;
                }
                break;
            case 'transition_to_placement':
                matchPhase = pkg.payload.phase;
                break;
            case 'match_phase_play':
                matchPhase = pkg.payload.phase;
                break;
            case 'placement_rejected':
                console.warn("Invalid position: " + pkg.payload.message);
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
            safe[id].grabbedBy = payload.allPlayers[id].grabbedBy || null;
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
    camera.zoom = 1.0;
    camera.targetZoom = 1.0;
    if (lobbyTimerId) clearInterval(lobbyTimerId);
    document.getElementById('menu-screen').classList.add('hidden');
    setupLobbyEnvironment();
    repositionAllPlayersToSpawnPoints();
    spectatorMode = false;
    spectatorTargetId = null;
    document.getElementById('spectator-controls')?.classList.add('hidden');
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
    timerVal = 60;
    document.getElementById('timer').innerText = timerVal;
    updateHudDisplays();
    updateScoreboardButtonVisibility();
    updateTimerVisibility();
}

function evaluateLobbyDoorTrigger() {
    if (!isHost || currentEngineMode !== 'LOBBY') return;
    const total = Object.keys(players).length;
    const ready = Object.keys(readyPlayers).length;
    if (total >= 2 && ready > total / 2) {
        if (lobbyCountdownVal === -1) {
            lobbyCountdownVal = 5; // count down 10s
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

// ============================================================================
//  READY TOGGLE VIA R KEY
// ============================================================================
function toggleReadyStatus() {
    if (!players[localPlayerId]) return;
    if (currentEngineMode !== 'LOBBY') return;

    if (readyPlayers[localPlayerId]) {
        delete readyPlayers[localPlayerId];
    } else {
        readyPlayers[localPlayerId] = true;
    }
    if (!isHost && hostConnection?.open) {
        hostConnection.send({
            type: 'player_ready_toggle',
            senderId: localPlayerId,
            payload: { isReady: !!readyPlayers[localPlayerId] }
        });
    } else if (isHost) {
        broadcastToRoom('sync_ready_players', { readyPlayers });
    }
    playSound('door');
}

// ============================================================================
//  MATCH END HELPERS (IMMEDIATE END WHEN FINISHER + ALL OTHERS ELIMINATED)
// ============================================================================
function allPlayersFinishedOrEliminated() {
    for (let id in players) {
        const p = players[id];
        if (!p.finished && !p.eliminated) return false;
    }
    return true;
}

function finalizeMatchAndEnd() {
    if (!isHost || currentEngineMode !== 'GAME') return;
    if (matchEndingInProgress) return;
    matchEndingInProgress = true;

    if (gameTimer) clearInterval(gameTimer);
    if (raceTimerId) clearInterval(raceTimerId);
    raceTimerId = null;
    gameTimer = null;

    // Give points based on finish order (only for finished players)
    const finishedList = finishPositions.slice();
    const points = [3, 2, 1];
    for (let i = 0; i < finishedList.length && i < points.length; i++) {
        const pid = finishedList[i];
        if (players[pid]) players[pid].score += points[i];
    }

    let results = [];
    for (let id in players) {
        results.push({
            id,
            nameTag: players[id].nameTag,
            score: players[id].score,
            position: finishPositions.indexOf(id) + 1 || -1
        });
    }

    broadcastToRoom('match_over', { summary: results });
    executeMatchEndingSequence(results);
}

// ============================================================================
//  MODIFIED MATCH START (INTEGRATES DRAFT/PLACEMENT PHASE)
// ============================================================================
function executeActiveMatchStart() {
    currentEngineMode = 'GAME';
    matchPhase = 'CHOOSE';
    readyPlayers = {};

    const selectedMap = MAPS[currentSelectedMapName];
    if (!selectedMap) {
        console.warn(`Map "${currentSelectedMapName}" not found, falling back to "match"`);
        setupActiveMatchEnvironment();
    } else {
        platforms = selectedMap.platforms || [];
        hazards = selectedMap.hazards || [];
        gems = (selectedMap.gems || []).map(g => ({ ...g, collected: false }));
        spawnPoints = (selectedMap.spawnPoints || []).map(sp => ({ x: sp.x, y: sp.y }));
        if (selectedMap.finishLine) Object.assign(finishLine, selectedMap.finishLine);
        cameraBounds = selectedMap.cameraBounds || { minX: 0, minY: 0, maxX: WORLD_WIDTH, maxY: WORLD_HEIGHT };
        voidYThreshold = (selectedMap.voidYThreshold !== undefined) ? selectedMap.voidYThreshold : 2000;

        if (itemManager) {
            itemManager.worldItems = [];
            if (selectedMap.items && Array.isArray(selectedMap.items)) {
                for (let item of selectedMap.items) {
                    itemManager.spawnItem(item.x, item.y, item.itemType, item.initialDelay || 0, item.shouldRespawn !== false, item.ammo || 3);
                }
            }
        }
    }

    // 🔥 Force sync the map to all clients (host only)
    if (isHost) {
        broadcastToRoom('sync_map', { platforms, hazards, gems, cameraBounds, voidYThreshold });
    }

    updateHudDisplays();
    raceStarted = false;
    firstPlayerFinishTime = -1;
    raceCountdownVal = -1;
    finishPositions = [];

    camera.zoom = 1.0;
    camera.targetZoom = 1.0;

    projectiles = [];
    throwables = [];
    activeRobotHands = [];
    particles = [];
    lastThrowableSnapshot = null;
    lastProjectileSnapshot = null;
    lastRobotHandSnapshot = null;

    const totalPlayers = Object.keys(players).length;
    placementPool = [];
    playerSelectedBlock = {};
    placementCursors = {};

    const shuffledShapes = shuffleArray(DRAFT_SHAPES);

    function getRandomPosition(template, placedShapes) {
        const margin = 20;
        const topMargin = 150;
        const maxX = BASE_WIDTH - template.w - margin;
        const maxY = BASE_HEIGHT - template.h - margin;
        let attempts = 0;
        let pos;
        let overlap;
        do {
            pos = {
                x: margin + Math.random() * (maxX - margin),
                y: topMargin + Math.random() * (maxY - topMargin)
            };
            overlap = placedShapes.some(p =>
                pos.x < p.menuX + p.w && pos.x + template.w > p.menuX &&
                pos.y < p.menuY + p.h && pos.y + template.h > p.menuY
            );
            attempts++;
        } while (overlap && attempts < 100);
        return pos;
    }

    const placedShapes = [];

    for (let i = 0; i < totalPlayers + 2; i++) {
        const template = shuffledShapes[i % shuffledShapes.length];
        const pos = getRandomPosition(template, placedShapes);
        placementPool.push({
            id: 'item_' + i,
            type: template.type,
            w: template.w,
            h: template.h,
            color: template.color,
            blocks: template.blocks,
            claimedBy: null,
            menuX: pos.x,
            menuY: pos.y
        });
        placedShapes.push({ menuX: pos.x, menuY: pos.y, w: template.w, h: template.h });
    }

    for (let id in players) {
        placementCursors[id] = { x: BASE_WIDTH / 2, y: BASE_HEIGHT / 2, confirmed: false };
        players[id].eliminated = false;
        players[id].x = spawnPoints[0].x;
        players[id].y = spawnPoints[0].y;
        players[id].vx = 0;
        players[id].vy = 0;
        players[id].finished = false;
        players[id].finishTime = -1;
        players[id].deathReason = null;
        players[id].knockbackTimer = 0;
        players[id].knockbackVx = 0;
        players[id].knockbackVy = 0;
        players[id].item = null;
        players[id].itemType = null;
        players[id].ammo = 0;
        players[id].grabbedBy = null;
    }

    localPlayerItem = null;
    spectatorMode = false;
    spectatorTargetId = null;
    document.getElementById('spectator-controls')?.classList.add('hidden');
    matchEndingInProgress = false;

    if (isHost) {
        broadcastToRoom('sync_placement_pool', { pool: placementPool, selections: playerSelectedBlock });
        broadcastToRoom('sync_placement_cursors', { cursors: placementCursors });

        // --- Start the 60-second draft timer ---
        placementTimer = 60;
        broadcastToRoom('sync_placement_timer', { value: placementTimer });

        if (placementTimerInterval) clearInterval(placementTimerInterval);
        placementTimerInterval = setInterval(() => {
            placementTimer--;
            broadcastToRoom('sync_placement_timer', { value: placementTimer });

            if (placementTimer <= 0) {
                clearInterval(placementTimerInterval);
                placementTimerInterval = null;
                autoAssignRemainingBlocks();
            }
        }, 1000);
    }

    console.log("%c[UHCC] Match started with DRAFT phase. Map: " + currentSelectedMapName, "color: #00f2fe; font-weight: bold;");
    updateScoreboardButtonVisibility();
    updateTimerVisibility();
}

// ===== Host only: start actual gameplay after placement =====
function startOfficialMatchRun() {
    if (!isHost) return;
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
            let results = [];
            for (let id in players) {
                results.push({ id, nameTag: players[id].nameTag, score: players[id].score });
            }
            broadcastToRoom('match_over', { summary: results });
            executeMatchEndingSequence(results);
        }
    }, 1000);
    raceStarted = true;
    repositionAllPlayersToSpawnPoints();
    console.log("[UHCC] Placement phase completed. Gameplay started.");
}

// ============================================================================
//  RACE FINISH & EARLY END LOGIC
// ============================================================================
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
                    finalizeMatchAndEnd();
                }
            }, 1000);
        }

        // 原有检查：冲线后立即判断
        if (allPlayersFinishedOrEliminated()) {
            if (raceTimerId) {
                clearInterval(raceTimerId);
                raceTimerId = null;
            }
            finalizeMatchAndEnd();
            break;
        }
    }

    // 🔥 原新增检查（保留）
    if (raceTimerId && allPlayersFinishedOrEliminated()) {
        clearInterval(raceTimerId);
        raceTimerId = null;
        finalizeMatchAndEnd();
    }

    // 🆕 无条件检查：只要比赛已开始且所有玩家都完成或淘汰，立即结束
    if (raceStarted && allPlayersFinishedOrEliminated()) {
        if (raceTimerId) {
            clearInterval(raceTimerId);
            raceTimerId = null;
        }
        finalizeMatchAndEnd();
    }
}

let lobbyReturnTimeout = null;

function executeMatchEndingSequence(summary) {
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

    summary.sort((a, b) => b.score - a.score);
    let resultText = "🏁 MATCH OVER\n";
    resultText += summary.slice(0, 3).map((s, i) => `${['🥇', '🥈', '🥉'][i]} ${s.nameTag}: ${s.score} pts`).join('\n');
    resText.innerText = resultText;

    if (isHost) {
        waitingMsg.classList.add('hidden');
        backBtn.classList.remove('hidden');
        if (lobbyReturnTimeout) clearTimeout(lobbyReturnTimeout);
        lobbyReturnTimeout = setTimeout(() => backToInteractiveLobby(), 5000);
    } else {
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
    if (isReturningToLobby) return;
    isReturningToLobby = true;

    matchEndingInProgress = false;
    document.getElementById('gameover-overlay').classList.add('hidden');

    if (gameTimer) {
        clearInterval(gameTimer);
        gameTimer = null;
    }
    if (raceTimerId) {
        clearInterval(raceTimerId);
        raceTimerId = null;
    }

    raceStarted = false;
    firstPlayerFinishTime = -1;
    raceCountdownVal = -1;
    finishPositions = [];

    for (let id in players) {
        players[id].eliminated = false;
        players[id].finished = false;
        players[id].finishTime = -1;
        players[id].item = null;
        players[id].itemType = null;
        players[id].ammo = 0;
        players[id].knockbackTimer = 0;
        players[id].knockbackVx = 0;
        players[id].knockbackVy = 0;
        players[id].deathReason = null;
        players[id].grabbedBy = null;
    }

    spectatorMode = false;
    spectatorTargetId = null;

    enterLobbyState();

    if (isHost) {
        broadcastToRoom('sync_players', { allPlayers: players, reset: true });
        broadcastToRoom('sync_lobby_countdown', { value: -1 });
    }

    updateResetButtonVisibility();
    updateTimerVisibility();

    setTimeout(() => { isReturningToLobby = false; }, 500);
}

// ============================================================================
//  PHYSICS & COLLISIONS (unchanged)
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

function resolvePlatformCollision(player) {
    for (let plat of platforms) {
        if (player.x < plat.x + plat.w && player.x + player.width > plat.x &&
            player.y < plat.y + plat.h && player.y + player.height > plat.y) {
            const topOverlap = (player.y + player.height) - plat.y;
            const bottomOverlap = (plat.y + plat.h) - player.y;
            const leftOverlap = (player.x + player.width) - plat.x;
            const rightOverlap = (plat.x + plat.w) - player.x;
            const minOverlap = Math.min(topOverlap, bottomOverlap, leftOverlap, rightOverlap);

            if (minOverlap === topOverlap && player.vy >= 0) {
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
    for (let plat of platforms) {
        if (player.x < plat.x + plat.w && player.x + player.width > plat.x &&
            player.y < plat.y + plat.h && player.y + player.height > plat.y) {
            player.y = plat.y - player.height;
            player.isGrounded = true;
            player.vy = 0;
        }
    }
}

// ============================================================================
//  UPDATE CHARACTER PHYSICS – FIX: finished players cannot move
// ============================================================================
function updateCharacterPhysics(player, dt) {
    if (player.eliminated) return;
    if (player.finished) return; // 👈 new: finished players can't move

    if (player.item) {
        if (typeof player.item.update === 'function') {
            player.item.update(dt);
        }
        player.ammo = player.item.ammo;
    }

    if (player.grabbedBy) {
        player.vx = 0;
        player.vy = 0;
        return;
    }

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
        player.x += player.vx * dt * 2;
    }

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

    if (player.x < 0) player.x = 0;
    if (player.x + player.width > WORLD_WIDTH) player.x = WORLD_WIDTH - player.width;

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

    hazards.forEach(h => {
        if (checkCollision(player, h)) {
            player.isDashing = false;
            if (currentEngineMode === 'GAME') voidEliminateGame(player, 'touched a hazard');
            else respawnMatchEntity(player);
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
//  PARTICLES (unchanged)
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
//  RENDERING (includes new Draft/Placement overlay)
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
    if (!scoreboardVisible) return;

    const x = 40, y = 20, w = 250, h = 200;

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

let robotHandBaseImg = new Image();
robotHandBaseImg.src = 'assets/items/robot_hand_base.svg';
let robotHandArmImg = new Image();
robotHandArmImg.src = 'assets/items/robot_hand_arm.svg';
let robotHandClawImg = new Image();
robotHandClawImg.src = 'assets/items/robot_hand_claw.svg';

function drawCanvasLevelLayout() {
    platforms.forEach(plat => {
        // 使用平台自身的颜色，若未定义则使用默认色
        ctx.fillStyle = plat.color || '#170c30';
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

        ctx.shadowColor = settingsDoor.color;
        ctx.shadowBlur = 15;
        ctx.fillStyle = '#1a0033';
        ctx.fillRect(settingsDoor.x, settingsDoor.y, settingsDoor.w, settingsDoor.h);
        ctx.strokeStyle = settingsDoor.color;
        ctx.lineWidth = 4;
        ctx.strokeRect(settingsDoor.x, settingsDoor.y, settingsDoor.w, settingsDoor.h);
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
        if (preview?.complete) {
            ctx.drawImage(preview, -18, -18, 36, 36);
        } else {
            ctx.fillStyle = '#ffaa44';
            ctx.fillRect(-18, -18, 36, 36);
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

        if (robotHandClawImg.complete && robotHandClawImg.naturalWidth > 0) {
            ctx.save();
            ctx.translate(endX, endY);
            ctx.rotate(angle - 90 * Math.PI / 180);
            ctx.drawImage(robotHandClawImg, -38, -16, 64, 32);
            ctx.restore();
        } else {
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

function updateTimerVisibility() {
    const container = document.getElementById('timer-container');
    if (!container) return;
    // In LOBBY mode, hide the whole container; otherwise show it.
    if (currentEngineMode === 'LOBBY') {
        container.style.display = 'none';
    } else {
        container.style.display = 'flex';  // matches the original flex layout
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

function drawSettingsDoorUI() {
    if (currentEngineMode !== 'LOBBY') return;
    ctx.fillStyle = '#fff';
    ctx.font = '20px "Orbitron"';
    ctx.textAlign = 'center';
    ctx.shadowColor = settingsDoor.color;
    ctx.shadowBlur = 12;
    const cx = settingsDoor.x + settingsDoor.w / 2;
    const cy = settingsDoor.y;
    ctx.fillText("Settings", cx, cy - 20);

    const local = players[localPlayerId];
    if (local && checkCollision(local, settingsDoor)) {
        ctx.fillText("[F] | Open", cx, cy + settingsDoor.h / 2);
        if (keys.Interact) {
            openSettingsMenu();
            keys.Interact = false;
        }
    }
}

function openSettingsMenu() {
    const modal = document.getElementById('settings-modal');
    if (!modal) return;
    const modeSelect = document.getElementById('settings-game-mode');
    const mapSelect = document.getElementById('settings-map');
    if (modeSelect) modeSelect.value = currentSelectedGameMode;
    if (mapSelect) mapSelect.value = currentSelectedMapName;
    modal.classList.remove('hidden');
}

function closeSettingsMenu() {
    const modal = document.getElementById('settings-modal');
    if (modal) modal.classList.add('hidden');
}

function saveSettings() {
    const modeSelect = document.getElementById('settings-game-mode');
    const mapSelect = document.getElementById('settings-map');
    if (modeSelect) currentSelectedGameMode = modeSelect.value;
    if (mapSelect) currentSelectedMapName = mapSelect.value;
    console.log(`Settings saved: Mode=${currentSelectedGameMode}, Map=${currentSelectedMapName}`);
    closeSettingsMenu();
}

// ============================================================================
//  MAIN GAME LOOP (with placement phase hooks)
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

        if (isHost && currentEngineMode === 'GAME') {
            hostCheckHazardsForAllPlayers();
        }
        checkVoidDeath();
        if (isHost && currentEngineMode === 'GAME') {
            checkAllPlayersEliminatedAndEndMatch();
        }

        updatePlacementPhases(dt);

        if (matchPhase === 'PLAY') {
            // ─── 1. Local player physics & actions ──────────────────────────────
            if (localPlayer && !spectatorMode) {
                updateCharacterPhysics(localPlayer, dt);
                resolvePlayerCollisions();
                if (isHost) {
                    localPlayer.handAngle = calculateHandAngle(localPlayer);
                }

                // ── Item pickup (host or client) ──
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
                    } else if (!isHost && localPlayer && !localPlayer.item) {
                        for (let wi of itemManager.worldItems) {
                            if (wi.isAvailable && checkCollision(localPlayer, wi)) {
                                hostConnection.send({ type: 'request_pickup_item', senderId: localPlayerId });
                                playSound('gem');
                                break;
                            }
                        }
                    }
                }

                // ── Drop item ──
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
                // ── Spectator camera follow ──
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

            // ─── 2. Host authority: collisions, finish detection, broadcast ──────
            if (isHost) {
                resolvePlayerCollisions();          // Resolve all player‑player collisions
                if (currentEngineMode === 'GAME') {
                    checkAndProcessRaceFinish();    // Check finish line and end match
                }
                // Broadcast updated state after collisions
                broadcastToRoom('sync_players', { allPlayers: players });
            }

            // ─── 3. Client sends input to host (if not grabbed) ──────────────────
            if (!isHost && localPlayer && !localPlayer.grabbedBy) {
                hostConnection.send({
                    type: 'client_input_update',
                    senderId: localPlayerId,
                    payload: {
                        x: localPlayer.x,
                        y: localPlayer.y,
                        vx: localPlayer.vx,
                        vy: localPlayer.vy,
                        isGrounded: localPlayer.isGrounded,
                        facingRight: localPlayer.facingRight,
                        isDashing: localPlayer.isDashing,
                        handAngle: calculateHandAngle(localPlayer),
                        jumpsLeft: localPlayer.jumpsLeft,   // <-- ADD THIS
                        resetVersion: clientResetVersion
                    }
                });
            }

            // ─── 4. Lobby door trigger (host only) ──────────────────────────────
            if (isHost && currentEngineMode === 'LOBBY') {
                evaluateLobbyDoorTrigger();
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

        if (matchPhase === 'PLAY') {
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
                    const dx = p.x - (t.x + t.width / 2);
                    const dy = p.y - (t.y + t.height / 2);
                    if (Math.hypot(dx, dy) < p.radius + t.width / 2) {
                        const angle = Math.atan2(p.vy, p.vx);
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

            if (isHost && (currentEngineMode === 'GAME' || currentEngineMode === 'LOBBY')) {
                for (let i = 0; i < activeRobotHands.length; i++) {
                    const grab = activeRobotHands[i];
                    const holder = players[grab.holderId];
                    if (!holder || holder.eliminated) {
                        if (grab.targetId && players[grab.targetId]) {
                            players[grab.targetId].grabbedBy = null;
                            broadcastToRoom('sync_players', { allPlayers: players });
                        }
                        activeRobotHands.splice(i, 1);
                        i--;
                        continue;
                    }
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
                        if (now - grab._lastProgressTime > 500) {
                            grab._lastProgressTime = now;
                            grab._lastProgress = grab.progress;
                        }
                    }
                    const MAX_LENGTH = 400;
                    const EXTEND_SPEED = 20;
                    const RETRACT_SPEED = EXTEND_SPEED + 10;
                    const handX = holder.x + holder.width / 2;
                    const handY = holder.y + 32;
                    if (grab.direction === 1) {
                        const oldProgress = grab.progress;
                        grab.progress += (EXTEND_SPEED * dt) / MAX_LENGTH;
                        if (grab.progress >= 1) {
                            grab.progress = 1;
                            grab.direction = -1;
                        } else {
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
                                    const grabOffsetY = -3;
                                    target.x = tipX - target.width / 2;
                                    target.y = tipY - target.height / 2 + grabOffsetY;
                                    target.vx = 0;
                                    target.vy = 0;
                                    target.isGrounded = false;
                                    resolvePlatformCollision(target);
                                    playSound('door');
                                    broadcastToRoom('sync_players', { allPlayers: players });
                                    break;
                                }
                            }
                        }
                    }
                    if (grab.direction === -1) {
                        const oldProgress = grab.progress;
                        grab.progress -= (RETRACT_SPEED * dt) / MAX_LENGTH;
                        if (grab.progress <= 0) {
                            if (grab.targetId && players[grab.targetId]) {
                                const target = players[grab.targetId];
                                const angleToHolder = Math.atan2(handY - target.y, handX - target.x);
                                target.vx += Math.cos(angleToHolder) * 20;
                                target.vy += Math.sin(angleToHolder) * 20;
                                target.grabbedBy = null;
                                target.isGrounded = false;
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
                            const grabOffsetY = -5;
                            newY += grabOffsetY;
                            newX = Math.max(0, Math.min(WORLD_WIDTH - target.width, newX));
                            newY = Math.max(0, Math.min(WORLD_HEIGHT - target.height, newY));
                            target.x = newX;
                            target.y = newY;
                            target.vx = 0;
                            target.vy = 0;
                            target.isGrounded = false;
                            resolvePlatformCollision(target);
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
                    const tipX = handX + Math.cos(grab.angle) * MAX_LENGTH * grab.progress;
                    const tipY = handY + Math.sin(grab.angle) * MAX_LENGTH * grab.progress;
                    grab.headX = tipX;
                    grab.headY = tipY;
                }
                broadcastRobotHands();
            }

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
        drawSkinDoorUI();
        drawStartDoorUI();
        drawSettingsDoorUI();
        ctx.restore();
        drawOffscreenRadarIndicators();

        drawPlacementPhaseOverlay();

        if (currentEngineMode === 'LOBBY' || (currentEngineMode === 'GAME' && matchPhase === 'PLAY')) {
            drawLobbyScoreboard();
        }

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
//  INPUT HANDLING (with R key for ready, zoom disabled during placement)
// ============================================================================

window.addEventListener('keydown', (e) => {
    if (['ArrowLeft', 'a', 'A'].includes(e.key)) keys.ArrowLeft = true;
    if (['ArrowRight', 'd', 'D'].includes(e.key)) keys.ArrowRight = true;
    if (['ArrowUp', 'w', 'W', ' '].includes(e.key)) keys.ArrowUp = true;
    if (['f', 'F'].includes(e.key)) keys.Interact = true;
    if (e.key === 'q' || e.key === 'Q') keys.Drop = true;
    if (e.code === 'ShiftLeft') keys.ShiftLeft = true;

    // Press R to toggle ready status in lobby
    if ((e.key === 'r' || e.key === 'R') && currentEngineMode === 'LOBBY') {
        e.preventDefault();
        toggleReadyStatus();
    }

    if ((e.key === 'r' || e.key === 'R') && matchPhase === 'PLACE') {
        e.preventDefault();
        rotatePlayerBlock(localPlayerId);
    }

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
    // Disable zoom during placement phases (CHOOSE or PLACE)
    if (currentEngineMode === 'GAME' && (matchPhase === 'CHOOSE' || matchPhase === 'PLACE')) {
        e.preventDefault();
        return;
    }
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

    const statusContainer = document.querySelector('header .flex.items-center.gap-4');
    if (statusContainer) {
        const toggleBtn = document.createElement('button');
        toggleBtn.id = 'toggle-scoreboard-btn';
        toggleBtn.textContent = '📊';
        toggleBtn.style.padding = '4px 10px';
        toggleBtn.style.backgroundColor = '#00f2fe';
        toggleBtn.style.color = '#000';
        toggleBtn.style.border = 'none';
        toggleBtn.style.borderRadius = '6px';
        toggleBtn.style.fontFamily = 'Orbitron, monospace';
        toggleBtn.style.fontWeight = 'bold';
        toggleBtn.style.fontSize = '14px';
        toggleBtn.style.cursor = 'pointer';
        toggleBtn.style.boxShadow = '0 0 10px rgba(0,242,254,0.5)';
        toggleBtn.style.display = 'none'; // hidden by default
        statusContainer.appendChild(toggleBtn);

        toggleBtn.addEventListener('click', () => {
            scoreboardVisible = !scoreboardVisible;
            toggleBtn.textContent = '📊';
        });
    }

    const closeSettingsBtn = document.getElementById('close-settings-btn');
    if (closeSettingsBtn) {
        closeSettingsBtn.addEventListener('click', saveSettings);
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
//  FACE DRAWING (fixed: global applyFaceDrawingMode)
// ============================================================================

let faceDrawingCanvas = null, faceDrawingCtx = null, faceOverlayCanvas = null, faceOverlayCtx = null;
let isDrawingFace = false, currentDrawColorFace = '#FFFFFF', currentBrushSizeFace = 20;
let eraserActiveFace = false, lastPenColorFace = '#FFFFFF', faceCanvasBgColor = '#0c0516';

function applyFaceDrawingMode() {
    if (!faceOverlayCtx) return;
    if (eraserActiveFace) {
        faceOverlayCtx.globalCompositeOperation = 'destination-out';
        faceOverlayCtx.strokeStyle = 'rgba(0,0,0,1)';
    } else {
        faceOverlayCtx.globalCompositeOperation = 'source-over';
        faceOverlayCtx.strokeStyle = currentDrawColorFace;
    }
    faceOverlayCtx.lineWidth = currentBrushSizeFace;
    faceOverlayCtx.lineCap = 'round';
    faceOverlayCtx.lineJoin = 'round';
}

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
    function start(e) {
        e.preventDefault();
        isDrawingFace = true;
        const { x, y } = getCoords(e);
        faceOverlayCtx.beginPath();
        faceOverlayCtx.moveTo(x, y);
        applyFaceDrawingMode();
    }
    function draw(e) {
        if (!isDrawingFace) return;
        e.preventDefault();
        const { x, y } = getCoords(e);
        faceOverlayCtx.lineTo(x, y);
        faceOverlayCtx.stroke();
        compositeLayers();
    }
    function stop() {
        isDrawingFace = false;
        faceOverlayCtx.beginPath();
    }
    faceDrawingCanvas.addEventListener('mousedown', start);
    faceDrawingCanvas.addEventListener('mousemove', draw);
    faceDrawingCanvas.addEventListener('mouseup', stop);
    faceDrawingCanvas.addEventListener('mouseleave', stop);
    faceDrawingCanvas.addEventListener('touchstart', start);
    faceDrawingCanvas.addEventListener('touchmove', draw);
    faceDrawingCanvas.addEventListener('touchend', stop);
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
    if (faceOverlayCtx) applyFaceDrawingMode();
}
function deactivateEraserFace() { eraserActiveFace = false; currentDrawColorFace = lastPenColorFace; const btn = document.getElementById('eraserBtn'); if (btn) { btn.style.backgroundColor = ''; btn.style.color = '#ff007f'; btn.innerText = '🧽 ERASER MODE'; } if (faceOverlayCtx) applyFaceDrawingMode(); }
function setDrawColorFace(col) { if (eraserActiveFace) deactivateEraserFace(); currentDrawColorFace = col; if (faceOverlayCtx) applyFaceDrawingMode(); }
function setBrushSizeFace(size) { currentBrushSizeFace = parseInt(size); document.getElementById('brushSizeDisplay').innerText = size; if (faceOverlayCtx) applyFaceDrawingMode(); }
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