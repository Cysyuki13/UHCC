// ============================================================================
//  objects.js - 所有可放置对象的定义与辅助函数
// ============================================================================

// ---------- 洗牌工具 ----------
function shuffleArray(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

// ---------- 放置对象基类（预留扩展） ----------
class PlacementObject {
    constructor(config) {
        this.id = config.id;               // 唯一标识
        this.type = config.type;           // 'shape', 'cannon', 'turret' 等
        this.w = config.w;
        this.h = config.h;
        this.color = config.color;
        this.blocks = config.blocks;       // 网格单元数组 [{x, y}, ...]
        // 未来功能预留
        this.onPlace = config.onPlace || null;
        this.onUpdate = config.onUpdate || null;
        this.onInteract = config.onInteract || null;
        this.custom = config.custom || {};
    }
}

// ---------- 所有可用的对象模板 ----------
const AVAILABLE_PLACEMENT_OBJECTS = [
    {
        id: 'I_BLOCK',
        type: 'shape',
        w: 160,
        h: 40,
        color: '#00f2fe',
        blocks: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 80, y: 0 }, { x: 120, y: 0 }]
    },
    {
        id: 'O_BLOCK',
        type: 'shape',
        w: 80,
        h: 80,
        color: '#ffcc00',
        blocks: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 0, y: 40 }, { x: 40, y: 40 }]
    },
    {
        id: 'T_BLOCK',
        type: 'shape',
        w: 120,
        h: 80,
        color: '#aa66ff',
        blocks: [{ x: 40, y: 0 }, { x: 0, y: 40 }, { x: 40, y: 40 }, { x: 80, y: 40 }]
    },
    {
        id: 'L_BLOCK',
        type: 'shape',
        w: 80,
        h: 120,
        color: '#ff9900',
        blocks: [{ x: 0, y: 0 }, { x: 0, y: 40 }, { x: 0, y: 80 }, { x: 40, y: 80 }]
    },
    {
        id: 'Z_BLOCK',
        type: 'shape',
        w: 120,
        h: 80,
        color: '#ff007f',
        blocks: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 80, y: 40 }]
    },
    {
        id: 'S_BLOCK',          // 与 Z 镜像
        type: 'shape',
        w: 120,
        h: 80,
        color: '#66ff66',       // 亮绿色
        blocks: [
            { x: 40, y: 0 },
            { x: 80, y: 0 },
            { x: 0, y: 40 },
            { x: 40, y: 40 }
        ]
    },
    {
        id: 'J_BLOCK',          // L 的镜像
        type: 'shape',
        w: 80,
        h: 120,
        color: '#3366ff',       // 蓝色
        blocks: [
            { x: 0, y: 0 },
            { x: 0, y: 40 },
            { x: 0, y: 80 },
            { x: -40, y: 80 }     // 注意：左偏移，使形状居中
        ]
    },
    {
        id: 'U_BLOCK',          // U 形
        type: 'shape',
        w: 120,
        h: 80,
        color: '#ff66cc',       // 粉色
        blocks: [
            { x: 0, y: 0 },
            { x: 40, y: 0 },
            { x: 80, y: 0 },
            { x: 0, y: 40 },
            { x: 80, y: 40 }
        ]
    },
    {
        id: 'CROSS_BLOCK',      // 十字形
        type: 'shape',
        w: 120,
        h: 120,
        color: '#ffff00',       // 黄色
        blocks: [
            { x: 40, y: 0 },
            { x: 0, y: 40 },
            { x: 40, y: 40 },
            { x: 80, y: 40 },
            { x: 40, y: 80 }
        ]
    },
    {
        id: 'BIG_L_BLOCK',      // 更大的 L（3x3 缺一角）
        type: 'shape',
        w: 120,
        h: 120,
        color: '#ff8800',       // 橙色
        blocks: [
            { x: 0, y: 0 },
            { x: 0, y: 40 },
            { x: 0, y: 80 },
            { x: 40, y: 80 },
            { x: 80, y: 80 }
        ]
    },
    {
        id: 'BOMB',
        type: 'bomb', // Used for special handling
        w: 40,
        h: 40,
        color: '#ff0000', // Red for bomb
        radius: 150,      // Explosion radius
        blocks: [{ x: 0, y: 0 }] // 1x1 grid
    }
];

// ---------- 向后兼容：暴露旧的 DRAFT_SHAPES 变量 ----------
const DRAFT_SHAPES = AVAILABLE_PLACEMENT_OBJECTS;

// ---------- 辅助：获取指定数量的随机对象池 ----------
function getPlacementPool(count) {
    const shuffled = shuffleArray(AVAILABLE_PLACEMENT_OBJECTS);
    return shuffled.slice(0, count);
}

// ---------- 暴露到全局（供 game_core.js 使用） ----------
window.shuffleArray = shuffleArray;
window.DRAFT_SHAPES = DRAFT_SHAPES;
window.AVAILABLE_PLACEMENT_OBJECTS = AVAILABLE_PLACEMENT_OBJECTS;
window.PlacementObject = PlacementObject;
window.getPlacementPool = getPlacementPool;