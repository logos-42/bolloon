/**
 * P2P 模块统一导出
 */

// 类型
export * from './types.js';

// 存储
export { P2PStoreMemory, p2pStore } from './p2p-store-memory.js';

// 身份
export { P2PIdentityManager, p2pIdentity } from './p2p-identity.js';

// 连接
export { P2PConnectionManager, p2pConnection } from './p2p-connection.js';

// 消息
export { P2PMessagesManager, p2pMessages } from './p2p-messages.js';

// 核心管理器
export { P2PManager, p2pManager } from './p2p-manager.js';

// Web Component
export { P2PModal } from './p2p-modal.js';

// 初始化
console.log('[P2P Module] P2P 模块已加载');