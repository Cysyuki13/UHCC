// items.js - Item system with world items and pickups

// ------------------------------------------------------------------
// Base Item Class (the "usable" item held by a player)
// ------------------------------------------------------------------
class UsableItem {
    constructor(name, svgPath, cooldownSeconds = 0.75) {
        this.name = name;
        this.svgPath = svgPath;
        this.cooldown = 0;
        this.cooldownMax = cooldownSeconds;
        this.image = null;
        this.loaded = false;
        this.loadImage();
    }

    loadImage() {
        this.image = new Image();
        this.image.onload = () => { this.loaded = true; };
        this.image.src = this.svgPath;
    }

    draw(ctx, x, y, angle, facingRight = true) {
        ctx.save();
        ctx.translate(x, y);
        if (!facingRight) {
            ctx.scale(1, -1);
            angle = -angle;
        }
        ctx.rotate(angle);
        if (this.loaded && this.image) {
            const w = 24, h = 24;
            ctx.drawImage(this.image, -w / 2, -h / 2, w, h);
        } else {
            ctx.fillStyle = '#aaa';
            ctx.fillRect(-10, -12, 20, 24);
            ctx.fillStyle = '#666';
            ctx.fillRect(-4, -16, 8, 8);
            ctx.fillStyle = '#ff6600';
            ctx.beginPath();
            ctx.arc(0, 12, 6, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();
    }

    update(dt) {
        if (this.cooldown > 0) {
            this.cooldown -= dt;
            if (this.cooldown < 0) this.cooldown = 0;
        }
    }

    canUse() {
        return this.cooldown <= 0;
    }

    onUse(player, gameState) {
        if (!this.canUse()) return false;
        this.cooldown = this.cooldownMax;
        return true;
    }
}

// ------------------------------------------------------------------
// pistol Item – shoots projectile with knockback, has ammo (3)
// ------------------------------------------------------------------
class pistolItem extends UsableItem {
    constructor(ammo = 3) {
        super('pistol', 'assets/items/pistol.svg', 0.75);
        this.projectileSpeed = window.PISTOL_PROJECTILE_SPEED || 36;
        this.projectileRadius = 6;
        this.knockbackForce = 15;
        this.ammo = ammo;
        this.maxAmmo = 3;
    }

    onUse(player, gameState) {
        if (!super.onUse(player, gameState)) return false;
        if (this.ammo <= 0) return false;

        const handX = player.x + player.width * 0.5;
        const handY = player.y + 32;
        const angle = player.handAngle !== undefined ? player.handAngle : (player.facingRight ? 0 : Math.PI);
        const dirX = Math.cos(angle);
        const dirY = Math.sin(angle);
        const spawnX = handX + dirX * 20;
        const spawnY = handY + dirY * 20;

        const projectile = {
            x: spawnX, y: spawnY,
            vx: dirX * this.projectileSpeed,
            vy: dirY * this.projectileSpeed,
            radius: this.projectileRadius,
            life: 120,
            ownerId: player.id,
            type: 'pistol_ammo',
            knockback: this.knockbackForce
        };
        gameState.projectiles.push(projectile);
        this.ammo--;
        return true;
    }
}

// ===========================================================================
// ROBOT HAND ITEM – grappling hook
// ===========================================================================
class RobotHandItem extends UsableItem {
    constructor() {
        super('robot_hand', 'assets/items/robot_hand.svg', 2.0);
        this.projectileSpeed = 28;
        this.projectileRadius = 10;
        this.range = 400;
        this.retractSpeed = 240;

        // Load the three parts with meaningful names
        this.handBaseImg = new Image();
        this.handBaseImg.src = 'assets/items/robot_hand_base.svg';

        this.stretchArmImg = new Image();
        this.stretchArmImg.src = 'assets/items/robot_hand_arm.svg';

        this.clawImg = new Image();
        this.clawImg.src = 'assets/items/robot_hand_claw.svg';
    }

    // items.js - inside RobotHandItem class
    onUse(player, gameState) {
        if (!super.onUse(player, gameState)) return false;

        // Determine target angle (mouse or default)
        let angle;
        let usingMouse = false;
        if (gameState.mouseWorld) {
            const handX = player.x + player.width / 2;
            const handY = player.y + 32;
            angle = Math.atan2(gameState.mouseWorld.y - handY, gameState.mouseWorld.x - handX);
            usingMouse = true;
            console.log(`[RobotHand] Used with mouse angle: ${angle.toFixed(2)} rad`);
        } else {
            angle = player.facingRight ? 0 : Math.PI;
            console.log(`[RobotHand] Used with default angle: ${angle.toFixed(2)} rad`);
        }

        // --- ANGLE RESTRICTION ---
        // Max allowed angle offset from player's facing direction (in radians)
        const MAX_ANGLE_OFFSET = (60 * Math.PI) / 180;  // 60 degrees total? Actually 60° = 1.047 rad. Adjust as needed.
        const facingAngle = player.facingRight ? 0 : Math.PI;
        let diff = angle - facingAngle;
        // Normalize to [-PI, PI]
        while (diff > Math.PI) diff -= 2 * Math.PI;
        while (diff < -Math.PI) diff += 2 * Math.PI;

        if (Math.abs(diff) > MAX_ANGLE_OFFSET) {
            console.warn(`[RobotHand] Aiming angle ${angle.toFixed(2)} is outside allowed range. Facing: ${facingAngle}, diff: ${diff.toFixed(2)}. Shoot blocked.`);
            return false;   // Do not fire the robot hand
        }
        // --- END OF ANGLE RESTRICTION ---

        // Instead of creating a projectile, create a "stretched hand" object
        activeRobotHands.push({
            holderId: player.id,
            angle: angle,
            progress: 0,
            direction: 1,
            targetReached: false,
        });
        console.log(`[RobotHand] Created activeRobotHands entry for player ${player.id}. Total active: ${activeRobotHands.length}`);

        // Remove item (single use)
        player.item = null;
        player.itemType = null;
        player.ammo = 0;
        console.log(`[RobotHand] Item removed from player ${player.id}`);
        return true;
    }

    draw(ctx, x, y, angle, facingRight = true) {
        ctx.save();
        ctx.translate(x, y);
        if (!facingRight) {
            ctx.scale(1, -1);
            angle = -angle;
        }
        ctx.rotate(angle);
        if (this.loaded && this.image) {
            ctx.drawImage(this.image, -16, -16, 32, 32);
        } else {
            ctx.fillStyle = '#aa66ff';
            ctx.fillRect(-12, -12, 24, 24);
        }
        ctx.restore();
    }
}

// ------------------------------------------------------------------
// WorldItem – item entity lying on the ground
// ------------------------------------------------------------------
class WorldItem {
    constructor(x, y, itemType, initialDelay = 0, shouldRespawn = true, ammo = 3) {
        this.x = x;
        this.y = y;
        this.w = 36;
        this.h = 36;
        this.itemType = itemType;
        this.respawnTimer = 0;
        this.pickupDelayTimer = initialDelay;
        this.isAvailable = (initialDelay === 0);
        this.shouldRespawn = shouldRespawn;
        this.ammo = ammo;
    }

    pickup() {
        if (!this.isAvailable) return null;
        this.isAvailable = false;
        if (this.shouldRespawn) {
            this.respawnTimer = 300;
        }
        switch (this.itemType) {
            case 'pistol': return new pistolItem(this.ammo);
            case 'robot_hand': return new RobotHandItem();
            default: return null;
        }
    }

    update() {
        if (this.pickupDelayTimer > 0) {
            this.pickupDelayTimer--;
            if (this.pickupDelayTimer <= 0) {
                this.isAvailable = true;
            }
        }
        if (!this.isAvailable && this.pickupDelayTimer <= 0 && this.shouldRespawn) {
            this.respawnTimer--;
            if (this.respawnTimer <= 0) {
                this.isAvailable = true;
            }
        }
    }

    draw(ctx, itemManager) {
        if (!this.isAvailable && this.pickupDelayTimer <= 0 && this.shouldRespawn) return;

        const isCoolingDown = (this.pickupDelayTimer > 0);
        const previewImg = itemManager.getPreviewImage(this.itemType);

        if (isCoolingDown) {
            ctx.globalAlpha = 0.5;
            ctx.shadowBlur = 0;
        } else {
            ctx.globalAlpha = 1;
            ctx.shadowBlur = 8;
            ctx.shadowColor = '#ffaa44';
        }

        if (previewImg && previewImg.complete) {
            ctx.drawImage(previewImg, this.x, this.y, this.w, this.h);
        } else {
            ctx.fillStyle = '#ffaa44';
            ctx.fillRect(this.x, this.y, this.w, this.h);
            ctx.fillStyle = '#ffffff';
            ctx.font = '12px monospace';
            ctx.fillText('?', this.x + this.w / 2 - 4, this.y + this.h / 2 + 4);
        }

        if (isCoolingDown) {
            ctx.globalAlpha = 1;
            ctx.shadowBlur = 0;
            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 14px "Orbitron", monospace';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'bottom';
            const remainingSeconds = (this.pickupDelayTimer / 60).toFixed(1);
            ctx.fillText(`${remainingSeconds}s`, this.x + this.w / 2, this.y - 5);
        }

        ctx.shadowBlur = 0;
        ctx.globalAlpha = 1;
    }
}

// ------------------------------------------------------------------
// ItemManager – holds all world items and spawns them
// ------------------------------------------------------------------
class ItemManager {
    constructor() {
        this.worldItems = [];
        this.registeredItems = { 'pistol': pistolItem };
        this.previewCache = {};
        this.needsBroadcast = false;
    }

    getPreview(type) {
        return this.previewCache[type];
    }

    syncFromData(itemsData) {
        this.worldItems = itemsData.map(data => {
            const item = new WorldItem(data.x, data.y, data.itemType, data.pickupDelayTimer, data.shouldRespawn, data.ammo);
            item.isAvailable = data.isAvailable;
            item.respawnTimer = data.respawnTimer;
            item.pickupDelayTimer = data.pickupDelayTimer;
            return item;
        });
    }

    getPreviewImage(itemType) {
        if (!this.previewCache) this.previewCache = {};
        if (!this.previewCache[itemType]) {
            let tempItem;
            switch (itemType) {
                case 'pistol': tempItem = new pistolItem(); break;
                case 'robot_hand': tempItem = new RobotHandItem(); break;
                default: return null;
            }
            if (tempItem.image && tempItem.image.src) {
                this.previewCache[itemType] = tempItem.image;
            } else {
                const img = new Image();
                if (tempItem.svgPath) img.src = tempItem.svgPath;
                this.previewCache[itemType] = img;
            }
        }
        return this.previewCache[itemType];
    }

    update() {
        let changed = false;
        for (let i = 0; i < this.worldItems.length; i++) {
            const item = this.worldItems[i];
            const wasAvailable = item.isAvailable;
            item.update();
            if (wasAvailable !== item.isAvailable) {
                changed = true;
            }
            if (!item.shouldRespawn && !item.isAvailable && item.pickupDelayTimer <= 0) {
                this.worldItems.splice(i, 1);
                i--;
                changed = true;
            }
        }
        if (changed) this.needsBroadcast = true;
    }

    spawnItem(x, y, type, delayFrames = 0, shouldRespawn = true, ammo = 3) {
        const item = new WorldItem(x, y, type, delayFrames, shouldRespawn, ammo);
        this.worldItems.push(item);
        return item;
    }

    checkPickup(player) {
        if (player.item !== null) return null;
        for (let i = 0; i < this.worldItems.length; i++) {
            const item = this.worldItems[i];
            if (!item.isAvailable) continue;
            if (player.x < item.x + item.w &&
                player.x + player.width > item.x &&
                player.y < item.y + item.h &&
                player.y + player.height > item.y) {
                const usable = item.pickup();
                if (usable) {
                    if (!item.shouldRespawn) {
                        this.worldItems.splice(i, 1);
                    }
                    return usable;
                }
            }
        }
        return null;
    }
}

window.UsableItem = UsableItem;
window.pistolItem = pistolItem;
window.RobotHandItem = RobotHandItem;
window.WorldItem = WorldItem;
window.ItemManager = ItemManager;