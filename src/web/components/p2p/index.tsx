import { createRoot } from 'react-dom/client';
import React, { useState } from 'react';
import { P2PModal } from './P2PModal.js';

class P2PModalBridge {
  private container: HTMLDivElement;
  private root: any;
  private modalContainer: HTMLDivElement;

  constructor() {
    this.modalContainer = document.createElement('div');
    this.modalContainer.id = 'p2p-modal-root';
    document.body.appendChild(this.modalContainer);

    this.root = createRoot(this.modalContainer);
    this.render(false);

    const style = document.createElement('style');
    style.textContent = `
      .p2p-modal-overlay {
        display: flex;
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.7);
        z-index: 1000;
        align-items: center;
        justify-content: center;
      }
      .p2p-modal {
        width: 90%;
        max-width: 700px;
        max-height: 90vh;
        background: var(--bg-secondary, #1e1e2e);
        border: 1px solid var(--border, #3a3a4a);
        border-radius: 12px;
        padding: 24px;
        overflow-y: auto;
      }
      .modal-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 20px;
      }
      .modal-header h2 {
        margin: 0;
        font-size: 18px;
        color: var(--text-primary, #e0e0e0);
      }
      .modal-close {
        background: none;
        border: none;
        font-size: 24px;
        cursor: pointer;
        color: var(--text-secondary, #888);
      }
      .tabs {
        display: flex;
        gap: 4px;
        margin-bottom: 20px;
        border-bottom: 1px solid var(--border, #3a3a4a);
        padding-bottom: 8px;
      }
      .tab {
        padding: 8px 16px;
        background: transparent;
        border: none;
        border-radius: 6px 6px 0 0;
        color: var(--text-secondary, #888);
        font-size: 14px;
        cursor: pointer;
      }
      .tab:hover { color: var(--text-primary, #e0e0e0); }
      .tab.active {
        color: var(--accent, #7c3aed);
        background: var(--bg-hover, #2a2a3a);
      }
      .tab-content { display: none; }
      .tab-content.active { display: block; }
      .identity-card {
        background: var(--bg-hover, #2a2a3a);
        border: 1px solid var(--border, #3a3a4a);
        border-radius: 8px;
        padding: 20px;
        margin-bottom: 16px;
      }
      .status-row {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 16px;
      }
      .status-indicator {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: var(--text-muted, #666);
      }
      .status-indicator.online { background: var(--success, #22c55e); }
      .status-indicator.connecting { background: var(--warning, #eab308); animation: pulse 1s infinite; }
      .status-indicator.error { background: var(--error, #ef4444); }
      @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
      .info-row {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 0;
        border-bottom: 1px solid var(--border, #3a3a4a);
      }
      .info-row:last-child { border-bottom: none; }
      .info-label { min-width: 80px; color: var(--text-secondary, #888); font-size: 13px; }
      .info-value { flex: 1; font-size: 13px; word-break: break-all; font-family: monospace; }
      .copy-btn {
        padding: 4px 8px;
        background: var(--bg-primary, #252536);
        border: 1px solid var(--border, #3a3a4a);
        border-radius: 4px;
        cursor: pointer;
        font-size: 12px;
      }
      .copy-btn:hover { background: var(--accent, #7c3aed); color: white; }
      .btn-primary {
        padding: 12px 24px;
        background: var(--accent, #7c3aed);
        color: white;
        border: none;
        border-radius: 8px;
        cursor: pointer;
        font-size: 14px;
        width: 100%;
      }
      .btn-primary:hover { opacity: 0.9; }
      .share-panel {
        background: var(--bg-hover, #2a2a3a);
        border: 1px solid var(--border, #3a3a4a);
        border-radius: 8px;
        padding: 16px;
        margin-bottom: 16px;
      }
      .share-panel h4 { margin: 0 0 12px 0; color: var(--text-primary, #e0e0e0); }
      .share-actions { display: flex; gap: 8px; flex-wrap: wrap; }
      .btn-secondary {
        padding: 8px 16px;
        background: var(--bg-primary, #252536);
        border: 1px solid var(--border, #3a3a4a);
        border-radius: 6px;
        cursor: pointer;
        font-size: 13px;
      }
      .btn-secondary:hover { border-color: var(--accent, #7c3aed); }
      .btn-sm { padding: 6px 12px; font-size: 12px; }
      .connect-form { display: flex; gap: 8px; margin-bottom: 16px; }
      .connect-form input {
        flex: 1;
        padding: 12px 16px;
        background: var(--bg-hover, #2a2a3a);
        border: 1px solid var(--border, #3a3a4a);
        border-radius: 8px;
        color: var(--text-primary, #e0e0e0);
        font-size: 14px;
      }
      .progress {
        display: none;
        margin-bottom: 16px;
        padding: 16px;
        background: var(--bg-hover, #2a2a3a);
        border-radius: 8px;
      }
      .progress.show { display: block; }
      .progress-bar {
        height: 6px;
        background: var(--bg-primary, #252536);
        border-radius: 3px;
        overflow: hidden;
        margin-bottom: 8px;
      }
      .progress-fill {
        height: 100%;
        background: var(--accent, #7c3aed);
        border-radius: 3px;
        transition: width 0.3s;
      }
      .progress-text { color: var(--text-secondary, #888); font-size: 13px; }
      .connect-result {
        display: none;
        padding: 12px;
        border-radius: 8px;
        font-size: 14px;
        margin-bottom: 16px;
      }
      .connect-result.show { display: block; }
      .connect-result.success { background: rgba(34, 197, 94, 0.1); border: 1px solid var(--success, #22c55e); color: var(--success, #22c55e); }
      .connect-result.error { background: rgba(239, 68, 68, 0.1); border: 1px solid var(--error, #ef4444); color: var(--error, #ef4444); }
      .empty-hint { color: var(--text-muted, #666); font-size: 13px; padding: 32px; text-align: center; }
      .history-item, .peer-item {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 12px;
        background: var(--bg-hover, #2a2a3a);
        border: 1px solid var(--border, #3a3a4a);
        border-radius: 8px;
        margin-bottom: 8px;
      }
      .history-item.pinned { border-left: 3px solid var(--accent, #7c3aed); }
      .history-item-icon { font-size: 20px; }
      .history-item-info { flex: 1; }
      .history-item-name { font-weight: 500; display: flex; align-items: center; gap: 6px; }
      .history-item-meta { font-size: 12px; color: var(--text-secondary, #888); display: flex; gap: 12px; margin-top: 4px; }
      .history-item-actions { display: flex; gap: 8px; }
      .peer-status { display: flex; align-items: center; }
      .peer-status .dot { width: 8px; height: 8px; border-radius: 50%; }
      .peer-status .dot.online { background: var(--success, #22c55e); }
      .peer-info { flex: 1; }
      .peer-name { font-weight: 500; }
      .peer-meta { font-size: 12px; color: var(--text-secondary, #888); }
      .message-item {
        padding: 12px;
        background: var(--bg-hover, #2a2a3a);
        border: 1px solid var(--border, #3a3a4a);
        border-radius: 8px;
        margin-bottom: 8px;
      }
      .message-item.unread { border-left: 3px solid var(--accent, #7c3aed); }
      .message-header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
      .message-sender { font-weight: 500; }
      .message-time { font-size: 12px; color: var(--text-secondary, #888); }
      .message-content { font-size: 14px; line-height: 1.5; }
      .peers-section {
        margin-top: 24px;
        padding-top: 16px;
        border-top: 1px solid var(--border, #3a3a4a);
      }
      .peers-section h4 { margin-bottom: 12px; color: var(--text-secondary, #888); font-size: 13px; }
      .toolbar { margin-bottom: 12px; display: flex; justify-content: flex-end; }
      .unread-badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 18px;
        height: 18px;
        padding: 0 6px;
        font-size: 11px;
        font-weight: 600;
        color: white;
        background: var(--accent, #7c3aed);
        border-radius: 9px;
        margin-left: 4px;
      }
      .pin-icon { font-size: 12px; }
      .toast {
        position: fixed;
        bottom: 24px;
        left: 50%;
        transform: translateX(-50%);
        padding: 12px 24px;
        background: var(--bg-secondary, #1e1e2e);
        border: 1px solid var(--border, #3a3a4a);
        border-radius: 8px;
        color: var(--text-primary, #e0e0e0);
        font-size: 14px;
        z-index: 2000;
        animation: toastIn 0.2s ease-out;
      }
      @keyframes toastIn {
        from { opacity: 0; transform: translateX(-50%) translateY(10px); }
        to { opacity: 1; transform: translateX(-50%) translateY(0); }
      }
    `;
    document.head.appendChild(style);
  }

  private render(visible: boolean) {
    this.root.render(
      React.createElement(P2PModal, {
        visible,
        onClose: () => this.hide()
      })
    );
  }

  show() {
    this.render(true);
  }

  hide() {
    this.render(false);
  }
}

const p2pModalReact = new P2PModalBridge();

(window as any).p2pModalReact = p2pModalReact;
(window as any).showP2PModal = () => p2pModalReact.show();
(window as any).hideP2PModal = () => p2pModalReact.hide();

console.log('[P2P Modal React] 已初始化');
