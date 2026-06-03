// items.js - Item system with world items and pickups

// ------------------------------------------------------------------
// Base Item Class (the "usable" item held by a player)
// ------------------------------------------------------------------
class UsableItem {
    constructor(name, svgPath, cooldownFrames = 30) {
        this.name = name;
        this.svgPath = svgPath;
        this.cooldown = 0;
        this.cooldownMax = cooldownFrames;
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
            // Vertical flip (mirror over X-axis)
            ctx.scale(1, -1);
            // Negate the angle to keep the item pointing in the correct direction
            angle = -angle;
        }

        ctx.rotate(angle);

        if (this.loaded && this.image) {
            const w = 24, h = 24;
            ctx.drawImage(this.image, -w / 2, -h / 2, w, h);
        } else {
            // fallback (unchanged)
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

    update() {
        if (this.cooldown > 0) this.cooldown--;
    }

    canUse() { return this.cooldown === 0; }

    // Called when player uses the item
    onUse(player, gameState) {
        if (!this.canUse()) return false;
        this.cooldown = this.cooldownMax;
        // Override in subclass
        return true;
    }
}

// ------------------------------------------------------------------
// pistol Item – shoots projectile with knockback
// ------------------------------------------------------------------
class pistolItem extends UsableItem {
    constructor() {
        super('pistol', 'assets/items/pistol.svg', 30);
        this.projectileSpeed = 12;
        this.projectileRadius = 6;
        this.knockbackForce = 8;
    }

    onUse(player, gameState) {
        if (!super.onUse(player, gameState)) return false;

        // Spawn projectile from hand position
        const handX = player.x + player.width * 0.5;
        const handY = player.y + 32;
        const angle = player.handAngle !== undefined ? player.handAngle : (player.facingRight ? 0 : Math.PI);
        const dirX = Math.cos(angle);
        const dirY = Math.sin(angle);
        const spawnX = handX + dirX * 20;
        const spawnY = handY + dirY * 20;

        const projectile = {
            x: spawnX,
            y: spawnY,
            vx: dirX * this.projectileSpeed,
            vy: dirY * this.projectileSpeed,
            radius: this.projectileRadius,
            life: 120,
            ownerId: player.id,
            type: 'pistol_ammo',
            knockback: this.knockbackForce
        };
        gameState.projectiles.push(projectile);
        return true;
    }
}

// ------------------------------------------------------------------
// WorldItem – item entity lying on the ground
// ------------------------------------------------------------------
class WorldItem {
    constructor(x, y, itemType) {
        this.x = x;
        this.y = y;
        this.w = 24;
        this.h = 24;
        this.itemType = itemType;   // e.g., 'pistol'
        this.respawnTimer = 0;
        this.isAvailable = true;
    }

    // When player picks up, returns a new UsableItem instance
    pickup() {
        if (!this.isAvailable) return null;
        this.isAvailable = false;
        this.respawnTimer = 300; // frames (~5 seconds at 60fps)
        switch (this.itemType) {
            case 'pistol': return new pistolItem();
            default: return null;
        }
    }

    update() {
        if (!this.isAvailable) {
            this.respawnTimer--;
            if (this.respawnTimer <= 0) {
                this.isAvailable = true;
            }
        }
    }

    draw(ctx, itemManager) {
        if (!this.isAvailable) return;

        // Try to get the preview image from the item manager
        const previewImg = itemManager.getPreviewImage(this.itemType);
        if (previewImg && previewImg.complete) {
            ctx.drawImage(previewImg, this.x, this.y, this.w, this.h);
        } else {
            // Fallback: orange placeholder box with a '?'
            ctx.fillStyle = '#ffaa44';
            ctx.shadowBlur = 8;
            ctx.shadowColor = '#ffaa44';
            ctx.fillRect(this.x, this.y, this.w, this.h);
            ctx.fillStyle = '#ffffff';
            ctx.font = '12px monospace';
            ctx.fillText('?', this.x + this.w / 2 - 4, this.y + this.h / 2 + 4);
            ctx.shadowBlur = 0;
        }
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
            const item = new WorldItem(data.x, data.y, data.itemType);
            item.isAvailable = data.isAvailable;
            item.respawnTimer = data.respawnTimer;
            return item;
        });
    }

    getPreviewImage(itemType) {
        if (!this.previewCache) this.previewCache = {};
        if (!this.previewCache[itemType]) {
            // Create a temporary item to get its image
            let tempItem;
            switch (itemType) {
                case 'pistol': tempItem = new pistolItem(); break;
                default: return null;
            }
            if (tempItem.image && tempItem.image.src) {
                this.previewCache[itemType] = tempItem.image;
            } else {
                // Fallback: create a new Image object and start loading
                const img = new Image();
                if (tempItem.svgPath) img.src = tempItem.svgPath;
                this.previewCache[itemType] = img;
            }
        }
        return this.previewCache[itemType];
    }

    update() {
        let changed = false;
        for (let item of this.worldItems) {
            const wasAvailable = item.isAvailable;
            item.update();
            if (wasAvailable !== item.isAvailable) {
                changed = true;
            }
        }
        if (changed) this.needsBroadcast = true;
    }

    spawnItem(x, y, type) {
        const item = new WorldItem(x, y, type);
        this.worldItems.push(item);
        return item;
    }

    checkPickup(player) {
        for (let item of this.worldItems) {
            if (!item.isAvailable) continue;
            // AABB collision
            if (player.x < item.x + item.w &&
                player.x + player.width > item.x &&
                player.y < item.y + item.h &&
                player.y + player.height > item.y) {
                const usable = item.pickup();
                if (usable) {
                    return usable;
                }
            }
        }
        return null;
    }
}

// Expose globally
window.UsableItem = UsableItem;
window.pistolItem = pistolItem;
window.WorldItem = WorldItem;
window.ItemManager = ItemManager;