import { useState, useEffect, useCallback } from 'react';
import { p2pManager } from './p2p-manager.js';
import type {
  P2PIdentity,
  P2PMessage,
  ConnectionHistoryEntry,
  ConnectProgress,
  PersistentConnection
} from './types.js';

type Tab = 'identity' | 'connect' | 'history' | 'messages';
type Status = 'idle' | 'connecting' | 'online' | 'error';

interface P2PModalProps {
  visible: boolean;
  onClose: () => void;
}

export function P2PModal({ visible, onClose }: P2PModalProps) {
  const [activeTab, setActiveTab] = useState<Tab>('identity');
  const [initialized, setInitialized] = useState(false);
  const [status, setStatus] = useState<Status>('idle');
  const [statusText, setStatusText] = useState('未初始化');
  const [identity, setIdentity] = useState<P2PIdentity | null>(null);
  const [connectInput, setConnectInput] = useState('');
  const [progress, setProgress] = useState<ConnectProgress | null>(null);
  const [progressVisible, setProgressVisible] = useState(false);
  const [connectResult, setConnectResult] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [history, setHistory] = useState<ConnectionHistoryEntry[]>([]);
  const [messages, setMessages] = useState<P2PMessage[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [peers, setPeers] = useState<{ nodeId: string; info: any }[]>([]);
  const [persistentConnections, setPersistentConnections] = useState<PersistentConnection[]>([]);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (visible && !initialized) {
      initP2P();
    }
  }, [visible, initialized]);

  useEffect(() => {
    if (visible) {
      loadActiveTab();
    }
  }, [activeTab, visible]);

  async function initP2P() {
    setStatus('connecting');
    setStatusText('初始化中...');

    try {
      const identity = await p2pManager.init();
      setIdentity(identity);
      setStatus('online');
      setStatusText('已连接');
      setInitialized(true);
    } catch (e) {
      setStatus('error');
      setStatusText('初始化失败');
    }
  }

  async function loadActiveTab() {
    switch (activeTab) {
      case 'history':
        await loadHistory();
        break;
      case 'messages':
        await loadMessages();
        break;
      case 'connect':
        loadPeers();
        loadPersistentConnections();
        break;
    }
  }

  async function loadHistory() {
    try {
      const hist = await p2pManager.getHistory();
      setHistory(hist);
    } catch (e) {
      console.error('[P2P Modal] 加载历史失败:', e);
    }
  }

  async function loadMessages() {
    try {
      const msgs = await p2pManager.getMessages();
      setMessages(msgs);
      const unread = p2pManager.getUnreadCount();
      setUnreadCount(unread);
    } catch (e) {
      console.error('[P2P Modal] 加载消息失败:', e);
    }
  }

  function loadPeers() {
    const connectedPeers = p2pManager.getConnectedPeers();
    setPeers(connectedPeers);
  }

  async function loadPersistentConnections() {
    try {
      const connections = await p2pManager.getPersistentConnections();
      setPersistentConnections(connections);
    } catch (e) {
      console.error('[P2P Modal] 加载持久连接失败:', e);
    }
  }

  async function handleToggleConnection(connection: PersistentConnection) {
    const newStatus = connection.status === 'connected' ? 'disconnected' : 'connected';
    const enable = newStatus === 'connected';

    try {
      const success = await p2pManager.toggleConnection(connection, enable);
      if (success) {
        await loadPersistentConnections();
        loadPeers();
        showToast(enable ? '正在连接...' : '已断开');
      } else {
        showToast('操作失败');
      }
    } catch (e) {
      showToast('操作失败');
    }
  }

  async function handleOpenChannel(channelId: string) {
    showToast(`打开通道: ${channelId}`);
    onClose();
  }

  async function handleConnect() {
    if (!connectInput.trim()) return;

    setProgressVisible(true);
    setProgress({ stage: 'init', percent: 0, message: '验证输入格式...' });
    setConnectResult(null);

    try {
      const result = await p2pManager.connectAndCreateChannel(connectInput, (p) => setProgress(p));

      if (result.success) {
        setConnectResult({ type: 'success', text: `已连接到 ${result.name || '节点'}` });
        setConnectInput('');
        await loadHistory();
        loadPeers();
        loadPersistentConnections();
      } else {
        setConnectResult({ type: 'error', text: result.error || '连接失败' });
      }
    } catch (e) {
      setConnectResult({ type: 'error', text: (e as Error).message });
    } finally {
      setTimeout(() => {
        setProgressVisible(false);
        setProgress(null);
      }, 2000);
    }
  }

  async function handleHistoryAction(action: string, item: ConnectionHistoryEntry) {
    if (action === 'connect') {
      setConnectInput(item.cid);
      setActiveTab('connect');
    } else if (action === 'pin') {
      await p2pManager.updateHistory(item.id, { isPinned: !item.isPinned });
      await loadHistory();
    } else if (action === 'delete') {
      await p2pManager.deleteHistory(item.id);
      await loadHistory();
    }
  }

  async function handleMarkAllRead() {
    await p2pManager.messages.markAllRead();
    await loadMessages();
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text);
    showToast('已复制');
  }

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 2000);
  }

  function handleCopyLink() {
    if (identity) {
      const link = `bolloon://connect?did=${encodeURIComponent(identity.did)}&cid=${encodeURIComponent(identity.cid)}`;
      navigator.clipboard.writeText(link);
      showToast('链接已复制');
    }
  }

  function handleExportFile() {
    p2pManager.identity.exportIdentityFile();
  }

  if (!visible) return null;

  return (
    <div className="p2p-modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="p2p-modal">
        <div className="modal-header">
          <h2>P2P 网络</h2>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>

        <div className="tabs">
          <button className={`tab ${activeTab === 'identity' ? 'active' : ''}`} onClick={() => setActiveTab('identity')}>我的身份</button>
          <button className={`tab ${activeTab === 'connect' ? 'active' : ''}`} onClick={() => setActiveTab('connect')}>连接</button>
          <button className={`tab ${activeTab === 'history' ? 'active' : ''}`} onClick={() => setActiveTab('history')}>历史记录</button>
          <button className={`tab ${activeTab === 'messages' ? 'active' : ''}`} onClick={() => setActiveTab('messages')}>
            消息 {unreadCount > 0 && <span className="unread-badge">{unreadCount}</span>}
          </button>
        </div>

        {/* 身份 */}
        {activeTab === 'identity' && (
          <div className="tab-content active">
            <div className="identity-card">
              <div className="status-row">
                <span className={`status-indicator ${status}`}></span>
                <span>{statusText}</span>
              </div>
              <div className="info-row">
                <span className="info-label">DID:</span>
                <code className="info-value">{identity?.did || '-'}</code>
                {identity?.did && <button className="copy-btn" onClick={() => copyToClipboard(identity.did)}>📋</button>}
              </div>
              <div className="info-row">
                <span className="info-label">CID:</span>
                <code className="info-value">{identity?.cid || '-'}</code>
                {identity?.cid && <button className="copy-btn" onClick={() => copyToClipboard(identity.cid)}>📋</button>}
              </div>
              <div className="info-row">
                <span className="info-label">Node ID:</span>
                <code className="info-value">{identity?.irohNodeId || '-'}</code>
                {identity?.irohNodeId && <button className="copy-btn" onClick={() => copyToClipboard(identity.irohNodeId)}>📋</button>}
              </div>
            </div>

            {!initialized && <button className="btn-primary" onClick={initP2P}>初始化 P2P</button>}

            {identity && (
              <div className="share-panel">
                <h4>分享给好友</h4>
                <div className="share-actions">
                  <button className="btn-secondary" onClick={handleCopyLink}>📋 复制链接</button>
                  <button className="btn-secondary" onClick={handleExportFile}>📁 导出文件</button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* 连接 */}
        {activeTab === 'connect' && (
          <div className="tab-content active">
            <div className="connect-form">
              <input
                type="text"
                placeholder="粘贴 CID 或链接..."
                value={connectInput}
                onChange={(e) => setConnectInput(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && handleConnect()}
              />
              <button className="btn-secondary" onClick={handleConnect}>连接 ▶</button>
            </div>

            {progressVisible && progress && (
              <div className="progress show">
                <div className="progress-bar">
                  <div className="progress-fill" style={{ width: `${progress.percent}%` }}></div>
                </div>
                <span className="progress-text">{progress.message}</span>
              </div>
            )}

            {connectResult && (
              <div className={`connect-result ${connectResult.type} show`}>
                {connectResult.text}
              </div>
            )}

            {/* 持久连接列表 */}
            <div className="persistent-peers-section">
              <h4>持久连接 ({persistentConnections.length})</h4>
              {persistentConnections.length === 0 ? (
                <div className="empty-hint">暂无持久连接</div>
              ) : (
                persistentConnections.map((conn) => (
                  <div key={conn.id} className={`persistent-peer-item ${conn.status}`}>
                    <div className="peer-status-indicator">
                      <span className={`dot ${conn.status === 'connected' ? 'online' : 'offline'}`}></span>
                    </div>
                    <div className="peer-info">
                      <div className="peer-name">
                        {conn.peerName || 'Unknown'}
                        {conn.isAutoConnect && <span className="auto-badge">自动</span>}
                      </div>
                      <div className="peer-meta">
                        <span>DID: {conn.peerDid?.substring(0, 16)}...</span>
                        <span>状态: {conn.status === 'connected' ? '已连接' : '未连接'}</span>
                      </div>
                    </div>
                    <div className="peer-actions">
                      <button
                        className={`btn-sm ${conn.status === 'connected' ? 'btn-danger' : 'btn-primary'}`}
                        onClick={() => handleToggleConnection(conn)}
                      >
                        {conn.status === 'connected' ? '断开' : '连接'}
                      </button>
                      {conn.channelId && (
                        <button
                          className="btn-sm btn-secondary"
                          onClick={() => handleOpenChannel(conn.channelId!)}
                        >
                          对话
                        </button>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="peers-section">
              <h4>当前连接 ({peers.length})</h4>
              <div id="p2p-peers-list">
                {peers.length === 0 && <div className="empty-hint">暂无连接</div>}
                {peers.map((peer, i) => (
                  <div key={i} className="peer-item">
                    <div className="peer-status"><span className="dot online"></span></div>
                    <div className="peer-info">
                      <div className="peer-name">{peer.info?.name || 'Unknown'}</div>
                      <div className="peer-meta">{(peer.nodeId || '').substring(0, 16)}...</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* 历史记录 */}
        {activeTab === 'history' && (
          <div className="tab-content active">
            <div className="toolbar">
              <button className="btn-secondary btn-sm" onClick={loadHistory}>🔄 刷新</button>
            </div>
            <div id="p2p-history-list">
              {history.length === 0 && <div className="empty-hint">暂无连接历史</div>}
              {history.map((item) => (
                <div key={item.id} className={`history-item ${item.isPinned ? 'pinned' : ''}`}>
                  <div className="history-item-icon">💬</div>
                  <div className="history-item-info">
                    <div className="history-item-name">
                      {item.name || 'Unknown'}
                      {item.isPinned && <span className="pin-icon">📌</span>}
                    </div>
                    <div className="history-item-meta">
                      <span>上次: {new Date(item.lastConnectedAt).toLocaleString()}</span>
                      <span>消息: {item.totalMessages || 0}</span>
                    </div>
                  </div>
                  <div className="history-item-actions">
                    <button className="btn-sm btn-secondary" onClick={() => handleHistoryAction('connect', item)}>连接</button>
                    <button className="btn-sm btn-secondary" onClick={() => handleHistoryAction('pin', item)}>
                      {item.isPinned ? '取消置顶' : '置顶'}
                    </button>
                    <button className="btn-sm btn-secondary" onClick={() => handleHistoryAction('delete', item)}>删除</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 消息 */}
        {activeTab === 'messages' && (
          <div className="tab-content active">
            <div className="toolbar">
              <button className="btn-secondary btn-sm" onClick={handleMarkAllRead}>全部已读</button>
            </div>
            <div id="p2p-messages-list">
              {messages.length === 0 && <div className="empty-hint">暂无消息</div>}
              {messages.slice(-20).map((msg) => (
                <div key={msg.id} className={`message-item ${!msg.isRead ? 'unread' : ''}`}>
                  <div className="message-header">
                    <span className="message-sender">{msg.fromName || msg.fromDid}</span>
                    <span className="message-time">{new Date(msg.timestamp).toLocaleString()}</span>
                  </div>
                  <div className="message-content">{msg.content.substring(0, 200)}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
