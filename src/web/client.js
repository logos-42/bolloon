"use strict";
(() => {
  if (typeof marked === "undefined") {
    window.marked = { parse: (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>") };
  }
  (function installConsoleProxy() {
    const VERBOSE = typeof process !== "undefined" && process.env && process.env.BOLLOON_VERBOSE === "1";
    const SUPPRESSED = ["[SSE]", "[broadcast]"];
    const orig = console.log.bind(console);
    console.log = (...args) => {
      if (VERBOSE) return orig(...args);
      const first = args[0];
      if (typeof first === "string") {
        for (const p of SUPPRESSED) {
          if (first.startsWith(p)) return;
        }
      }
      return orig(...args);
    };
  })();
  let MR = {};
  try {
    if (typeof require !== "undefined") MR = require("./ui/message-renderer.js") || {};
  } catch (e) {
  }
  function _getMR() {
    if (MR && MR.addMessage) return MR;
    if (typeof window !== "undefined" && window.MR) return window.MR;
    return {};
  }
  const MR_addMessage = (...args) => _getMR().addMessage?.(...args);
  const MR_handleStreamTokenEvent = (...args) => _getMR().handleStreamTokenEvent?.(...args);
  const MR_finalizeTimelineAsMessage = (...args) => _getMR().finalizeTimelineAsMessage?.(...args);
  const MR_handleStepEvent = (...args) => _getMR().handleStepEvent?.(...args);
  const MR_escapeHtml = (s) => _getMR().escapeHtml?.(s);
  const MR_hasStreamingText = () => _getMR().hasStreamingText?.() ?? false;
  function getRendererCtx() {
    return {
      messagesEl,
      messagesContainers,
      currentChannelId,
      lastUsedJudgmentIds,
      openJudgmentsModalWithFilter
      // 引用 client.js 函数, 通过参数注入避免循环 import
    };
  }
  const messagesEl = document.getElementById("messages");
  const input = document.getElementById("input");
  const sendBtn = document.getElementById("send");
  const sidebar = document.getElementById("sidebar");
  const loopStatusBar = document.getElementById("loop-status-bar");
  const loopStatusText = document.getElementById("loop-status-text");
  const loopStatusMeta = document.getElementById("loop-status-meta");
  const LOOP_STATUS_TOOLS = /* @__PURE__ */ new Set(["loop", "compactor", "recovery", "system"]);
  let loopBarState = "loading";
  let loopBarLastSummary = "";
  function renderLoopStatusBar(tool, content) {
    if (!loopStatusBar || !loopStatusText) return;
    const t = String(tool || "").toLowerCase();
    if (!LOOP_STATUS_TOOLS.has(t)) {
      console.log("[SSE] status (tool=" + t + ", ignored by UI):", content?.slice(0, 80));
      return;
    }
    const retryMatch = String(content || "").match(/自动重试(?: loop)?\s+(\d+)\/(\d+)/);
    const retryFinal = /自动重试\s+\d+\s*次后仍失败/.test(String(content || ""));
    loopStatusBar.hidden = false;
    let mainText = String(content || "").replace(/^[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}]\s*/u, "").replace(/^↻\s*/, "").replace(/^⛔\s*/, "").replace(/^⚠️\s*/, "").slice(0, 200);
    loopStatusText.textContent = mainText;
    if (retryMatch) {
      loopBarState = "retrying";
      const retryEl = document.getElementById("loop-status-retry");
      if (retryEl) {
        retryEl.hidden = false;
        retryEl.textContent = `\u81EA\u52A8\u91CD\u8BD5 ${retryMatch[1]}/${retryMatch[2]}`;
      }
    } else if (retryFinal) {
      loopBarState = "done";
      const retryEl = document.getElementById("loop-status-retry");
      if (retryEl) retryEl.hidden = true;
    } else {
      if (loopBarState !== "loading") loopBarState = "loading";
      const retryEl = document.getElementById("loop-status-retry");
      if (retryEl) retryEl.hidden = true;
    }
    applyLoopBarState();
  }
  function applyLoopBarState() {
    if (!loopStatusBar) return;
    loopStatusBar.dataset.state = loopBarState;
    const checkBtn = document.getElementById("loop-status-check");
    if (checkBtn) checkBtn.hidden = loopBarState !== "done";
  }
  function hideLoopStatusBar() {
    if (!loopStatusBar) return;
    loopStatusBar.hidden = true;
    loopBarState = "loading";
    loopBarLastSummary = "";
    const retryEl = document.getElementById("loop-status-retry");
    if (retryEl) retryEl.hidden = true;
    applyLoopBarState();
  }
  const sidebarToggle = document.getElementById("sidebar-toggle");
  const themeToggle = document.getElementById("theme-toggle");
  const channelList = document.getElementById("channel-list");
  const newChannelBtn = document.getElementById("new-channel-btn");
  const newChannelInput = document.getElementById("new-channel-input");
  const channelNameEl = document.getElementById("channel-name");
  let eventSources = /* @__PURE__ */ new Map();
  let currentChannelId = null;
  let currentAgentId = "";
  let channels = [];
  let remoteChannels = [];
  let isSidebarCollapsed = false;
  let reconnectAttempts = /* @__PURE__ */ new Map();
  let reconnectTimers = /* @__PURE__ */ new Map();
  let heartbeatTimers = /* @__PURE__ */ new Map();
  const COLLAPSED_PEERS_KEY = "bolloon.p2p.collapsedPeers";
  const SEEN_PEERS_KEY = "bolloon.p2p.seenPeers";
  let collapsedPeers = function loadCollapsed() {
    try {
      const raw = localStorage.getItem(COLLAPSED_PEERS_KEY);
      return new Set(raw ? JSON.parse(raw) : []);
    } catch {
      return /* @__PURE__ */ new Set();
    }
  }();
  let seenPeers = function loadSeen() {
    try {
      const raw = localStorage.getItem(SEEN_PEERS_KEY);
      return new Set(raw ? JSON.parse(raw) : []);
    } catch {
      return /* @__PURE__ */ new Set();
    }
  }();
  function saveCollapsedPeers() {
    try {
      localStorage.setItem(COLLAPSED_PEERS_KEY, JSON.stringify([...collapsedPeers]));
    } catch {
    }
  }
  function saveSeenPeers() {
    try {
      localStorage.setItem(SEEN_PEERS_KEY, JSON.stringify([...seenPeers]));
    } catch {
    }
  }
  function togglePeerCollapsed(peerPk) {
    if (collapsedPeers.has(peerPk)) {
      collapsedPeers.delete(peerPk);
    } else {
      collapsedPeers.add(peerPk);
    }
    saveCollapsedPeers();
    renderRemoteChannels();
    if (typeof window.__syncP2PToggleAllBtn === "function") window.__syncP2PToggleAllBtn();
  }
  function expandAllPeers() {
    const allPks = /* @__PURE__ */ new Set([
      ...knownPeers.map((p) => p.publicKey),
      ...remoteChannels.map((g) => g.peerId)
    ]);
    for (const pk of allPks) collapsedPeers.delete(pk);
    saveCollapsedPeers();
    renderRemoteChannels();
    if (typeof window.__syncP2PToggleAllBtn === "function") window.__syncP2PToggleAllBtn();
  }
  function collapseAllPeers() {
    const allPks = /* @__PURE__ */ new Set([
      ...knownPeers.map((p) => p.publicKey),
      ...remoteChannels.map((g) => g.peerId)
    ]);
    for (const pk of allPks) collapsedPeers.add(pk);
    saveCollapsedPeers();
    renderRemoteChannels();
    if (typeof window.__syncP2PToggleAllBtn === "function") window.__syncP2PToggleAllBtn();
  }
  let messagesContainers = /* @__PURE__ */ new Map();
  let sessionMessages = /* @__PURE__ */ new Map();
  let currentSessionId = null;
  let expandedAgents = /* @__PURE__ */ new Set();
  function generateId() {
    return crypto.randomUUID();
  }
  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
  }
  async function loadTheme() {
    try {
      const res = await fetch("/theme");
      const data = await res.json();
      applyTheme(data.theme);
      if (data.agentId) {
        currentAgentId = data.agentId;
      }
      return data;
    } catch {
      applyTheme("dark");
      return { theme: "dark", agentId: "" };
    }
  }
  async function saveTheme(theme, agentId) {
    try {
      await fetch("/theme", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theme, agentId })
      });
    } catch (err) {
      console.error("Failed to save theme:", err);
    }
  }
  function toggleTheme() {
    const current = document.documentElement.getAttribute("data-theme") || "dark";
    const next = current === "dark" ? "light" : "dark";
    applyTheme(next);
    saveTheme(next, currentAgentId);
  }
  function toggleSidebar() {
    isSidebarCollapsed = !isSidebarCollapsed;
    if (isSidebarCollapsed) {
      sidebar.classList.add("collapsed");
    } else {
      sidebar.classList.remove("collapsed");
    }
  }
  function expandSidebar() {
    isSidebarCollapsed = false;
    sidebar.classList.remove("collapsed");
  }
  async function loadChannels() {
    try {
      const res = await fetch("/channels");
      channels = await res.json();
      console.log("[\u52A0\u8F7D\u9891\u9053] \u4ECE\u670D\u52A1\u5668\u83B7\u53D6\u5230", channels.length, "\u4E2A\u9891\u9053");
      channels.forEach((ch, i) => {
        console.log(`  [${i}] ${ch.name} - did: "${ch.did}"`);
      });
      renderChannels();
    } catch (err) {
      console.error("[\u52A0\u8F7D\u9891\u9053] \u5931\u8D25:", err);
    }
  }
  let v3GlobalEventSource = null;
  function startV3GlobalSSE() {
    if (v3GlobalEventSource) return;
    try {
      v3GlobalEventSource = new EventSource("/events?channelId=p2p-global");
      v3GlobalEventSource.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === "remote-chat-reply") {
            const log = document.getElementById("rcm-log");
            const thinkingEl = document.getElementById("rcm-thinking");
            if (thinkingEl) thinkingEl.style.display = "none";
            const liveThinking = document.getElementById("rcm-thinking-live");
            if (liveThinking) liveThinking.remove();
            if (log) {
              if (msg.error) {
                const errEl = document.createElement("div");
                errEl.className = "remote-chat-sysmsg remote-chat-sysmsg-error";
                errEl.textContent = `\u274C \u5BF9\u65B9\u56DE\u590D\u51FA\u9519: ${msg.error}`;
                log.appendChild(errEl);
              } else {
                const prefix = `\u{1F916} \u8FDC\u7AEF AI \u56DE\u590D

`;
                addMessage(prefix + (msg.text || "(\u7A7A\u56DE\u590D)"), "ai", false, log);
              }
              log.scrollTop = log.scrollHeight;
            } else {
              if (typeof showSimpleToast === "function") {
                const preview = (msg.text || "").slice(0, 50);
                showSimpleToast(`\u{1F4AC} \u8FDC\u7AEF channel \u6709\u65B0\u56DE\u590D: ${preview}${msg.text && msg.text.length > 50 ? "\u2026" : ""}`);
              }
            }
          } else if (msg.type === "remote-chat-thinking") {
            const phase = msg.phase;
            const log = document.getElementById("rcm-log");
            if (!log) return;
            if (phase === "start") {
              const judgments = msg.usedJudgments || { bound: [], candidates: [] };
              const judgmentBlock = document.createElement("div");
              judgmentBlock.className = "rcm-judgment-block";
              judgmentBlock.style.cssText = "margin:6px 0;padding:8px 10px;background:#fef3c7;border-left:3px solid #f59e0b;border-radius:4px;font-size:12px;";
              let jh = '<div style="font-weight:600;color:#92400e;margin-bottom:4px;">\u{1F6E1}\uFE0F \u5BF9\u65B9\u4F7F\u7528\u7684\u5224\u65AD\u529B (\u6765\u81EA ta \u7684 channel)</div>';
              if (judgments.bound && judgments.bound.length > 0) {
                jh += '<div style="color:#78350f;margin-bottom:4px;"><b>\u786C\u7ED1\u5B9A</b> (\u5FC5\u987B\u9075\u5FAA):</div>';
                for (const j of judgments.bound) {
                  jh += `<div style="margin:2px 0;padding-left:8px;">\u2022 <b>${escapeHtml((j.decision || "").slice(0, 80))}</b>${j.reasons && j.reasons.length ? '<br><span style="color:#92400e;font-size:11px;">\u7406\u7531: ' + escapeHtml(j.reasons.join("; ").slice(0, 80)) + "</span>" : ""}</div>`;
                }
              }
              if (judgments.candidates && judgments.candidates.length > 0) {
                jh += `<div style="color:#78350f;margin-top:4px;"><b>\u5019\u9009\u6C60</b> (${judgments.candidates.length} \u6761, LLM \u81EA\u9009)</div>`;
              }
              log.appendChild(judgmentBlock);
              const thinkingEl = document.createElement("div");
              thinkingEl.id = "rcm-thinking-live";
              thinkingEl.style.cssText = "margin:6px 0;padding:8px 10px;background:#ede9fe;border-left:3px solid #8b5cf6;border-radius:4px;font-size:12px;color:#5b21b6;font-style:italic;";
              thinkingEl.textContent = "\u{1F4AD} \u5BF9\u65B9\u6B63\u5728\u601D\u8003...";
              log.appendChild(thinkingEl);
              log.scrollTop = log.scrollHeight;
            } else if (phase === "token") {
              const thinkingEl = document.getElementById("rcm-thinking-live");
              if (thinkingEl) {
                thinkingEl.textContent = "\u{1F4AD} \u5BF9\u65B9\u6B63\u5728\u601D\u8003: " + (msg.partial || "").slice(-200);
                log.scrollTop = log.scrollHeight;
              }
            }
          } else if (msg.type === "cross-mention-received") {
            const allModals = document.querySelectorAll('.rcm-mention-toast, [id^="rcm-log"]');
            for (const log of allModals) {
              if (!log.id) continue;
              const toast = document.createElement("div");
              toast.style.cssText = "margin:6px 0;padding:8px 10px;background:#fce7f3;border-left:3px solid #ec4899;border-radius:4px;font-size:12px;color:#831843;";
              const fromTxt = msg.source === "ai-mention-remote" ? `\u8FDC\u7AEF\u8282\u70B9 ${(msg.fromPublicKey || "").substring(0, 8)}\u2026 \u7684 ${msg.originChannelName}` : `${msg.originChannelName} (\u672C\u5730)`;
              toast.innerHTML = `\u{1F4E1} <b>${fromTxt}</b> @-mention \u2192 \u5F53\u524D channel: <i>${escapeHtml((msg.text || "").slice(0, 100))}</i>${msg.text && msg.text.length > 100 ? "\u2026" : ""}`;
              log.appendChild(toast);
              log.scrollTop = log.scrollHeight;
            }
          } else if (msg.type === "remote-channel-update") {
            const peerId = msg.peerId;
            const channels2 = msg.channels || [];
            const peerName = msg.peerName || null;
            let group = remoteChannels.find((g) => g.peerId === peerId);
            if (!group) {
              group = { peerId, channels: [], peerName: peerName || "peer-" + peerId.substring(0, 8) };
              remoteChannels.push(group);
            } else if (peerName) {
              group.peerName = peerName;
            }
            group.channels = channels2;
            if (peerName && !knownPeers.find((p) => p.publicKey === peerId)) {
              knownPeers.push({
                publicKey: peerId,
                name: peerName,
                addedAt: (/* @__PURE__ */ new Date()).toISOString(),
                lastConnectedAt: (/* @__PURE__ */ new Date()).toISOString()
              });
              console.log(`[v3] \u8FDC\u7AEF ${peerId.substring(0, 12)}... \u81EA\u62A5\u540D\u5B57 = ${peerName}, \u5DF2\u52A0\u5230 knownPeers`);
            }
            renderRemoteChannels();
            console.log(`[v3] \u6536\u5230\u8FDC\u7AEF ${peerId.substring(0, 12)}... \u7684 ${channels2.length} \u4E2A channel \u66F4\u65B0 (name=${peerName || "?"})`);
          } else if (msg.type === "friend-request") {
            showFriendRequestModal(msg);
          } else if (msg.type === "friend-request-ack") {
            const pending = window.__pendingFriendRequests;
            if (pending && msg.requestId && pending.has(msg.requestId)) {
              const { name } = pending.get(msg.requestId);
              pending.delete(msg.requestId);
              console.log(`[v3-friend] \u2705 ack \u6536\u5230: ${name} \u5DF2\u6536\u5230\u597D\u53CB\u7533\u8BF7`);
              showSimpleToast(`\u{1F4EC} ${name} \u5DF2\u6536\u5230\u4F60\u7684\u597D\u53CB\u7533\u8BF7, \u7B49\u5BF9\u65B9\u63A5\u53D7`);
            }
          }
        } catch (err) {
          console.error("[v3] \u5168\u5C40 SSE \u89E3\u6790\u5931\u8D25:", err);
        }
      };
      v3GlobalEventSource.onerror = (e) => {
        console.warn("[v3] \u5168\u5C40 SSE \u9519\u8BEF");
      };
    } catch (err) {
      console.error("[v3] \u542F\u52A8\u5168\u5C40 SSE \u5931\u8D25:", err);
    }
  }
  async function createChannel(name) {
    if (!name.trim()) return;
    try {
      const res = await fetch("/channels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), agentId: currentAgentId })
      });
      const channel = await res.json();
      console.log("[\u521B\u5EFA\u9891\u9053] \u670D\u52A1\u5668\u8FD4\u56DE:", channel);
      console.log("[\u521B\u5EFA\u9891\u9053] DID:", channel.did, "CID:", channel.cid);
      channels.push(channel);
      renderChannels();
      selectChannel(channel.id);
      if (newChannelInput) newChannelInput.value = "";
      if (!channel.did || channel.did === "undefined") {
        console.log("[\u521B\u5EFA\u9891\u9053] \u540E\u53F0\u751F\u6210 DID...");
        scheduleChannelsRefresh();
      }
    } catch (err) {
      console.error("Failed to create channel:", err);
    }
  }
  async function deleteChannel(channelId, e) {
    e.stopPropagation();
    if (!confirm("\u786E\u5B9A\u8981\u5220\u9664\u8BE5\u667A\u80FD\u4F53\u53CA\u5176\u6240\u6709\u4F1A\u8BDD\u5417\uFF1F\u6B64\u64CD\u4F5C\u4E0D\u53EF\u64A4\u9500\u3002")) return;
    try {
      await fetch(`/channels/${channelId}`, { method: "DELETE" });
      channels = channels.filter((c) => c.id !== channelId);
      expandedAgents.delete(channelId);
      cleanupChannelState(channelId);
      if (currentChannelId === channelId) {
        currentChannelId = channels[0]?.id || null;
        currentSessionId = null;
        if (currentChannelId) {
          const ch = channels.find((c) => c.id === currentChannelId);
          if (channelNameEl) channelNameEl.textContent = ch?.name || "Bolloon Agent";
          await selectChannel(currentChannelId);
        } else {
          messagesEl.innerHTML = "";
          if (channelNameEl) channelNameEl.textContent = "Bolloon Agent";
        }
      }
      renderChannels();
    } catch (err) {
      console.error("Failed to delete channel:", err);
    }
  }
  function cleanupChannelState(channelId) {
    if (eventSources.has(channelId)) {
      try {
        eventSources.get(channelId).close();
      } catch {
      }
      eventSources.delete(channelId);
    }
    if (heartbeatTimers.has(channelId)) {
      clearInterval(heartbeatTimers.get(channelId));
      heartbeatTimers.delete(channelId);
    }
    if (reconnectTimers.has(channelId)) {
      clearTimeout(reconnectTimers.get(channelId));
      reconnectTimers.delete(channelId);
    }
    reconnectAttempts.delete(channelId);
    const container = messagesContainers.get(channelId);
    if (container && container.parentNode) {
      container.parentNode.removeChild(container);
    }
    messagesContainers.delete(channelId);
    const prefix = `${channelId}:`;
    for (const key of sessionMessages.keys()) {
      if (key === channelId || key.startsWith(prefix)) {
        sessionMessages.delete(key);
      }
    }
  }
  async function createNewSession() {
    if (!currentChannelId) {
      console.log("[\u65B0\u4F1A\u8BDD] \u6CA1\u6709\u9009\u4E2D\u7684\u9891\u9053");
      return;
    }
    try {
      saveCurrentSessionMessages();
      const res = await fetch(`/channels/${currentChannelId}/sessions`, {
        method: "POST"
      });
      const data = await res.json();
      console.log("[\u65B0\u4F1A\u8BDD] \u521B\u5EFA\u6210\u529F:", data);
      const channel = channels.find((c) => c.id === currentChannelId);
      if (channel) {
        if (!channel.sessions) channel.sessions = [];
        channel.sessions.push(data.session);
        channel.currentSessionId = data.currentSessionId;
      }
      currentSessionId = data.currentSessionId;
      const container = messagesContainers.get(currentChannelId);
      if (container) {
        container.innerHTML = "";
        showChannelView(currentChannelId);
        addMessage("\u4F60\u597D\uFF01\u65B0\u4F1A\u8BDD\u5DF2\u5F00\u59CB\uFF0C\u6709\u4EC0\u4E48\u6211\u53EF\u4EE5\u5E2E\u4F60\u7684\u5417\uFF1F", "ai", false, container);
      }
      expandedAgents.add(currentChannelId);
      renderChannels();
      console.log("[\u65B0\u4F1A\u8BDD] \u5DF2\u5207\u6362\u5230:", data.currentSessionId);
    } catch (err) {
      console.error("Failed to create new session:", err);
    }
  }
  async function createNewSessionForChannel(channelId, e) {
    if (e) e.stopPropagation();
    if (!channelId) return;
    if (channelId === currentChannelId) {
      if (currentSessionId) saveCurrentSessionMessages();
      await createNewSession();
      return;
    }
    try {
      const res = await fetch(`/channels/${channelId}/sessions`, { method: "POST" });
      if (!res.ok) throw new Error("create session failed");
      const data = await res.json();
      const channel = channels.find((c) => c.id === channelId);
      if (channel) {
        if (!channel.sessions) channel.sessions = [];
        channel.sessions.push(data.session);
        channel.currentSessionId = data.currentSessionId;
      }
      expandedAgents.add(channelId);
      renderChannels();
    } catch (err) {
      console.error("Failed to create new session:", err);
    }
  }
  async function switchSession(channelId, sessionId, e) {
    if (e) e.stopPropagation();
    if (!channelId || !sessionId) return;
    if (channelId === currentChannelId && sessionId === currentSessionId) return;
    if (currentChannelId && currentSessionId) {
      saveCurrentSessionMessages();
    }
    try {
      const res = await fetch(`/channels/${channelId}/sessions/${sessionId}/switch`, { method: "POST" });
      if (!res.ok) throw new Error("switch failed");
      const channel = channels.find((c) => c.id === channelId);
      if (channel) {
        channel.currentSessionId = sessionId;
        await saveChannels();
      }
      await selectChannel(channelId, sessionId);
      renderChannels();
    } catch (err) {
      console.error("Failed to switch session:", err);
    }
  }
  async function deleteSession(channelId, sessionId, e) {
    if (e) e.stopPropagation();
    if (!confirm("\u786E\u5B9A\u8981\u5220\u9664\u8BE5\u4F1A\u8BDD\u5417\uFF1F\u6B64\u64CD\u4F5C\u4E0D\u53EF\u64A4\u9500\u3002")) return;
    try {
      const res = await fetch(`/channels/${channelId}/sessions/${sessionId}`, { method: "DELETE" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(err.error || "\u5220\u9664\u5931\u8D25");
        return;
      }
      const data = await res.json();
      const channel = channels.find((c) => c.id === channelId);
      if (channel) {
        if (channel.sessions) {
          channel.sessions = channel.sessions.filter((s) => s.id !== sessionId);
        }
        if (data.currentSessionId) {
          channel.currentSessionId = data.currentSessionId;
        }
      }
      if (channelId === currentChannelId && sessionId === currentSessionId) {
        if (data.currentSessionId) {
          currentSessionId = data.currentSessionId;
          const container = messagesContainers.get(channelId);
          if (container) container.innerHTML = "";
          await loadSession(channelId);
        }
      }
      renderChannels();
    } catch (err) {
      console.error("Failed to delete session:", err);
    }
  }
  let _saveSessionMessagesDirty = false;
  let _saveSessionMessagesTimer = null;
  function saveCurrentSessionMessages() {
    if (!currentChannelId || !currentSessionId) return;
    _saveSessionMessagesDirty = true;
    if (_saveSessionMessagesTimer) return;
    _saveSessionMessagesTimer = setTimeout(() => {
      _saveSessionMessagesTimer = null;
      if (!_saveSessionMessagesDirty) return;
      _saveSessionMessagesDirty = false;
      if (!currentChannelId || !currentSessionId) return;
      const container = messagesContainers.get(currentChannelId);
      if (!container) return;
      const messages = Array.from(container.querySelectorAll(".message")).map((msg) => ({
        type: msg.classList.contains("message-user") ? "user" : "ai",
        content: msg.querySelector(".message-content")?.textContent || ""
      }));
      if (messages.length > 0) {
        sessionMessages.set(`${currentChannelId}:${currentSessionId}`, messages);
      }
    }, 50);
  }
  async function saveChannels() {
    scheduleChannelsRefresh();
    await new Promise((r) => setTimeout(r, 600));
  }
  let channelRefreshTimer = null;
  let channelRefreshInFlight = null;
  function scheduleChannelsRefresh() {
    if (channelRefreshTimer) return;
    channelRefreshTimer = setTimeout(async () => {
      channelRefreshTimer = null;
      if (channelRefreshInFlight) return channelRefreshInFlight;
      channelRefreshInFlight = (async () => {
        try {
          const res = await fetch("/channels");
          if (res.ok) {
            const fresh = await res.json();
            channels = fresh;
            renderChannels();
          }
        } catch (err) {
          console.error("Failed to re-fetch channels:", err);
        } finally {
          channelRefreshInFlight = null;
        }
      })();
      return channelRefreshInFlight;
    }, 800);
  }
  function toggleAgentExpand(channelId, e) {
    if (e) e.stopPropagation();
    if (expandedAgents.has(channelId)) {
      expandedAgents.delete(channelId);
    } else {
      expandedAgents.add(channelId);
    }
    renderChannels();
  }
  function renderChannelsLite(activeChannelId, activeSessionId) {
    if (!channelList) return;
    channelList.querySelectorAll(".agent-row").forEach((row) => {
      const li = row.closest(".agent-group");
      const chId = li?.dataset.channelId;
      row.classList.toggle("active", chId === activeChannelId);
    });
    if (activeChannelId) expandedAgents.add(activeChannelId);
    const activeLi = channelList.querySelector(`.agent-group[data-channel-id="${activeChannelId}"]`);
    if (activeLi) {
      activeLi.classList.add("expanded");
      const ch = channels.find((c) => c.id === activeChannelId);
      activeLi.querySelectorAll(".session-item").forEach((sessLi) => {
        const sessId = sessLi.dataset.sessionId;
        const shouldBeActive = sessId === activeSessionId;
        sessLi.classList.toggle("active", shouldBeActive);
      });
      if (ch) {
        const currentSess = Array.isArray(ch.sessions) ? ch.sessions.find((s) => s.id === activeSessionId) : null;
        const labelEl = activeLi.querySelector(".agent-current-session");
        if (labelEl) {
          labelEl.textContent = currentSess ? "\xB7 " + formatSessionName(currentSess) : "";
        }
      }
    }
  }
  function renderChannels() {
    if (!channelList) return;
    channelList.innerHTML = "";
    const fragment = document.createDocumentFragment();
    if (!channelList._scrollListenersBound) {
      const onUserScroll = () => {
        channelList.classList.add("is-scrolling");
        if (channelList._scrollIdleTimer) clearTimeout(channelList._scrollIdleTimer);
        channelList._scrollIdleTimer = setTimeout(() => {
          channelList.classList.remove("is-scrolling");
        }, 1200);
      };
      channelList.addEventListener("wheel", onUserScroll, { passive: true });
      channelList.addEventListener("touchmove", onUserScroll, { passive: true });
      channelList.addEventListener("keydown", (ev) => {
        if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(ev.key)) {
          onUserScroll();
        }
      });
      channelList._scrollListenersBound = true;
    }
    channels.forEach((ch) => {
      const li = document.createElement("li");
      const isExpanded = expandedAgents.has(ch.id);
      li.className = `agent-group ${isExpanded ? "expanded" : ""}`;
      li.dataset.channelId = ch.id;
      const row = document.createElement("div");
      row.className = `agent-row ${ch.id === currentChannelId ? "active" : ""}`;
      const currentSess = ch.id === currentChannelId && Array.isArray(ch.sessions) ? ch.sessions.find((s) => s.id === ch.currentSessionId) : null;
      const currentSessLabel = currentSess ? formatSessionName(currentSess) : "";
      const sessionCount = Array.isArray(ch.sessions) ? ch.sessions.length : 0;
      const walletBadge2 = "";
      const toolsBadge = "";
      row.innerHTML = `
      <svg class="agent-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="9 18 15 12 9 6"></polyline>
      </svg>
      <div class="channel-icon">\u{1F4AC}</div>
      <span class="channel-name" title="${escapeHtml(ch.name || "")}">${escapeHtml(ch.name || "(\u672A\u547D\u540D)")}</span>
      <span class="agent-row-meta">
        ${walletBadge2}
        ${toolsBadge}
        ${sessionCount > 1 ? `<span class="agent-session-count" title="${sessionCount} \u4E2A\u4F1A\u8BDD">${sessionCount}</span>` : ""}
        ${currentSessLabel ? `<span class="agent-current-session" title="\u5F53\u524D\u4F1A\u8BDD\uFF1A${escapeHtml(currentSessLabel)}">\xB7 ${escapeHtml(currentSessLabel)}</span>` : ""}
        <button class="agent-config-btn" title="\u914D\u7F6E\u667A\u80FD\u4F53 (\u94B1\u5305 / \u5DE5\u5177)">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="3"></circle>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
          </svg>
        </button>
        <button class="channel-delete" title="\u5220\u9664\u667A\u80FD\u4F53">\xD7</button>
      </span>
    `;
      row.addEventListener("click", (ev) => {
        if (ev.target.closest(".channel-delete") || ev.target.closest(".agent-config-btn")) return;
        if (ev.target.closest(".agent-caret")) {
          toggleAgentExpand(ch.id, ev);
          return;
        }
        toggleAgentExpand(ch.id, ev);
        if (ch.id !== currentChannelId) {
          expandSidebar();
          selectChannel(ch.id);
        }
      });
      row.querySelector(".channel-delete").addEventListener("click", (ev) => deleteChannel(ch.id, ev));
      row.querySelector(".agent-config-btn").addEventListener("click", (ev) => {
        ev.stopPropagation();
        openAgentAddModal(ch);
      });
      li.appendChild(row);
      const sessionUl = document.createElement("ul");
      sessionUl.className = "session-list";
      if (isExpanded) {
        const newSessLi = document.createElement("li");
        newSessLi.className = "session-new-item";
        newSessLi.setAttribute("role", "button");
        newSessLi.setAttribute("tabindex", "0");
        newSessLi.title = "\u65B0\u5EFA\u4F1A\u8BDD";
        newSessLi.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="12" y1="5" x2="12" y2="19"></line>
          <line x1="5" y1="12" x2="19" y2="12"></line>
        </svg>
        <span>\u65B0\u5EFA\u4F1A\u8BDD</span>
      `;
        const onNewSession = (ev) => {
          ev.stopPropagation();
          createNewSessionForChannel(ch.id, ev);
        };
        newSessLi.addEventListener("click", onNewSession);
        newSessLi.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter" || ev.key === " ") {
            ev.preventDefault();
            onNewSession(ev);
          }
        });
        sessionUl.appendChild(newSessLi);
        const sessions = Array.isArray(ch.sessions) ? ch.sessions : [];
        sessions.forEach((sess) => {
          const sessLi = document.createElement("li");
          const isActive = ch.id === currentChannelId && sess.id === ch.currentSessionId;
          sessLi.className = `session-item ${isActive ? "active" : ""}`;
          sessLi.dataset.sessionId = sess.id;
          sessLi.innerHTML = `
          <span class="session-name" title="${escapeHtml(formatSessionName(sess))}">${escapeHtml(formatSessionName(sess))}</span>
          <button class="session-delete" title="\u5220\u9664\u4F1A\u8BDD">\xD7</button>
        `;
          sessLi.addEventListener("click", (ev) => {
            if (ev.target.closest(".session-delete")) return;
            switchSession(ch.id, sess.id, ev);
          });
          sessLi.querySelector(".session-delete").addEventListener("click", (ev) => deleteSession(ch.id, sess.id, ev));
          sessionUl.appendChild(sessLi);
        });
      }
      li.appendChild(sessionUl);
      fragment.appendChild(li);
    });
    channelList.appendChild(fragment);
    refreshWalletBadge();
    if (currentChannelId) {
      requestAnimationFrame(() => scrollActiveChannelIntoView(false));
    }
  }
  function scrollActiveChannelIntoView(smooth = true) {
    if (!channelList || !currentChannelId) return;
    const active = channelList.querySelector(`.agent-group[data-channel-id="${currentChannelId}"]`);
    if (!active) return;
    const listRect = channelList.getBoundingClientRect();
    const itemRect = active.getBoundingClientRect();
    const margin = 24;
    if (itemRect.top < listRect.top + margin) {
      channelList.scrollBy({ top: itemRect.top - listRect.top - margin, behavior: smooth ? "smooth" : "auto" });
    } else if (itemRect.bottom > listRect.bottom - margin) {
      channelList.scrollBy({ top: itemRect.bottom - listRect.bottom + margin, behavior: smooth ? "smooth" : "auto" });
    }
  }
  function formatSessionName(sess) {
    if (!sess) return "\u65B0\u4F1A\u8BDD";
    if (sess.preview && sess.preview.trim()) return sess.preview.trim();
    const id = sess.id || "";
    return id ? `\u4F1A\u8BDD ${id.slice(-6)}` : "\u65B0\u4F1A\u8BDD";
  }
  const escapeHtml = MR_escapeHtml || ((s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[c]));
  function ensureMessageContainer(channelId) {
    if (!messagesContainers.has(channelId)) {
      const container = document.createElement("div");
      container.className = "channel-messages";
      container.id = `channel-messages-${channelId}`;
      container.style.display = "none";
      messagesEl.appendChild(container);
      messagesContainers.set(channelId, container);
    }
    return messagesContainers.get(channelId);
  }
  function showChannelView(channelId) {
    messagesContainers.forEach((container2, cid) => {
      container2.style.display = "none";
    });
    const container = messagesContainers.get(channelId);
    if (container) {
      container.style.display = "block";
    }
  }
  async function selectChannel(channelId, targetSessionId = null) {
    console.log("[selectChannel] \u5F00\u59CB\u5207\u6362\u5230:", channelId, "targetSession:", targetSessionId);
    currentChannelId = channelId;
    reconnectAttempts.set(channelId, 0);
    if (typeof judgmentsModal !== "undefined" && judgmentsModal && judgmentsModal.classList.contains("active")) {
      if (typeof lastJudgmentsCache !== "undefined") renderJudgments(lastJudgmentsCache);
    }
    const channel = channels.find((c) => c.id === channelId);
    if (channel) {
      if (channelNameEl) channelNameEl.textContent = channel.name || "(\u672A\u547D\u540D)";
      currentSessionId = targetSessionId || channel.currentSessionId || "default";
      if (targetSessionId) {
        channel.currentSessionId = targetSessionId;
      }
      expandedAgents.add(channelId);
      console.log("[selectChannel] \u9891\u9053:", channel.name, "session:", currentSessionId);
    }
    const t0 = performance.now();
    renderChannelsLite(channelId, currentSessionId);
    console.log(`[selectChannel] renderChannelsLite \u8017\u65F6 ${(performance.now() - t0).toFixed(1)}ms`);
    const container = ensureMessageContainer(channelId);
    showChannelView(channelId);
    if (!eventSources.has(channelId)) {
      console.log("[selectChannel] \u5EFA\u7ACB SSE \u8FDE\u63A5");
      connect(channelId);
    }
    container.innerHTML = "";
    try {
      const res = await fetch(`/sessions/${channelId}?sessionId=${encodeURIComponent(currentSessionId)}`);
      const session = await res.json();
      const msgs = session.messages || [];
      if (msgs.length > 0) {
        const frag = document.createDocumentFragment();
        const tmpContainer = document.createElement("div");
        tmpContainer.style.display = "none";
        for (const msg of msgs) {
          addMessage(msg.content, msg.type, false, tmpContainer, msg.metadata?.usedJudgmentIds || []);
        }
        while (tmpContainer.firstChild) {
          frag.appendChild(tmpContainer.firstChild);
        }
        container.appendChild(frag);
      } else {
        addMessage("\u4F60\u597D\uFF01\u6211\u662F Bolloon Agent\u3002\u6709\u4EC0\u4E48\u6211\u53EF\u4EE5\u5E2E\u4F60\u7684\u5417\uFF1F", "ai", false, container);
      }
    } catch (err) {
      console.error("[selectChannel] \u52A0\u8F7D session \u5931\u8D25:", err);
      addMessage("\u4F60\u597D\uFF01\u6211\u662F Bolloon Agent\u3002\u6709\u4EC0\u4E48\u6211\u53EF\u4EE5\u5E2E\u4F60\u7684\u5417\uFF1F", "ai", false, container);
    }
  }
  async function loadSession(channelId, sessionId = null) {
    const container = messagesContainers.get(channelId);
    if (!container) return;
    const targetSessionId = sessionId || currentSessionId || "default";
    try {
      const res = await fetch(`/sessions/${channelId}?sessionId=${encodeURIComponent(targetSessionId)}`);
      const session = await res.json();
      container.innerHTML = "";
      if (session.messages && session.messages.length > 0) {
        session.messages.forEach((msg) => {
          addMessage(msg.content, msg.type, false, container, msg.metadata?.usedJudgmentIds || []);
        });
      } else {
        addMessage("\u4F60\u597D\uFF01\u6211\u662F Bolloon Agent\u3002\u6709\u4EC0\u4E48\u6211\u53EF\u4EE5\u5E2E\u4F60\u7684\u5417\uFF1F", "ai", false, container);
      }
    } catch (err) {
      console.error("Failed to load session:", err);
      container.innerHTML = "";
      addMessage("\u4F60\u597D\uFF01\u6211\u662F Bolloon Agent\u3002\u6709\u4EC0\u4E48\u6211\u53EF\u4EE5\u5E2E\u4F60\u7684\u5417\uFF1F", "ai", false, container);
    }
  }
  function addMessage(content, type, save = true, container, usedJudgmentIds = []) {
    return MR_addMessage(content, type, save, container, usedJudgmentIds, getRendererCtx());
  }
  function handleStreamTokenEvent(data) {
    return MR_handleStreamTokenEvent(data, getRendererCtx());
  }
  function finalizeTimelineAsMessage() {
    return MR_finalizeTimelineAsMessage(getRendererCtx());
  }
  function handleStepEvent(data) {
    return MR_handleStepEvent(data, getRendererCtx());
  }
  let lastUsedJudgmentIds = [];
  let selfImproveCardSeq = 0;
  function getMessagesContainerForCurrent() {
    if (currentChannelId && messagesContainers.get(currentChannelId)) {
      return messagesContainers.get(currentChannelId);
    }
    return messagesEl;
  }
  function makeSelfImproveCard(data) {
    const seq = ++selfImproveCardSeq;
    const id = `self-improve-card-${seq}`;
    const card = document.createElement("div");
    card.className = "self-improve-card";
    card.id = id;
    card.dataset.seq = String(seq);
    card.style.cssText = "margin:8px 12px;padding:10px 12px;border:1px solid var(--accent);border-left:3px solid var(--accent);border-radius:6px;background:var(--bg-hover);color:var(--text);font-size:12px;line-height:1.5;";
    card.innerHTML = `
    <div class="self-improve-header" style="display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none;">
      <span class="self-improve-caret" style="font-size:10px;color:var(--text-muted);">\u25BE</span>
      <span class="self-improve-title" style="flex:1;font-weight:600;color:var(--accent);"></span>
      <span class="self-improve-status" style="font-size:10px;color:var(--text-muted);"></span>
    </div>
    <div class="self-improve-body" style="margin-top:6px;display:none;color:var(--text-muted);white-space:pre-wrap;word-break:break-word;"></div>
  `;
    const header = card.querySelector(".self-improve-header");
    const body = card.querySelector(".self-improve-body");
    const caret = card.querySelector(".self-improve-caret");
    header.addEventListener("click", () => {
      const collapsed = body.style.display === "none";
      body.style.display = collapsed ? "block" : "none";
      caret.style.transform = collapsed ? "rotate(0deg)" : "rotate(-90deg)";
    });
    return card;
  }
  function handleSelfImproveTriggered(data) {
    const container = getMessagesContainerForCurrent();
    if (!container) return;
    const card = makeSelfImproveCard(data);
    card.querySelector(".self-improve-title").textContent = `\u{1F9E0} \u81EA\u8FED\u4EE3\u89E6\u53D1 \xB7 ${data.eventKind || "unknown"}`;
    card.querySelector(".self-improve-status").textContent = new Date(data.ts || Date.now()).toLocaleTimeString();
    const body = card.querySelector(".self-improve-body");
    body.textContent = JSON.stringify({
      eventKind: data.eventKind,
      details: data.details,
      goal: data.goal
    }, null, 2);
    container.appendChild(card);
    card.scrollIntoView({ block: "end", behavior: "smooth" });
  }
  function handleSelfImproveResult(data) {
    const container = getMessagesContainerForCurrent();
    if (!container) return;
    const card = makeSelfImproveCard(data);
    const ok = !!data.success;
    card.style.borderColor = ok ? "var(--success)" : "var(--warning)";
    card.style.borderLeftColor = ok ? "var(--success)" : "var(--warning)";
    card.querySelector(".self-improve-title").textContent = `${ok ? "\u2705" : "\u26A0\uFE0F"} \u81EA\u8FED\u4EE3\u5B8C\u6210 \xB7 ${ok ? "\u6210\u529F" : "\u5931\u8D25"}`;
    card.querySelector(".self-improve-status").textContent = new Date(data.ts || Date.now()).toLocaleTimeString();
    const body = card.querySelector(".self-improve-body");
    body.textContent = (ok ? data.output || "" : data.error || "") || "(no output)";
    if (!ok) {
      const btn = document.createElement("button");
      btn.textContent = "\u{1F501} \u91CD\u8BD5";
      btn.style.cssText = "margin-top:6px;padding:4px 10px;background:var(--accent);color:var(--bg-main);border:none;border-radius:4px;cursor:pointer;font-size:11px;";
      btn.onclick = async () => {
        btn.disabled = true;
        btn.textContent = "\u23F3 \u91CD\u8BD5\u4E2D...";
        try {
          const r = await fetch("/self-improve", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ reason: "user retry from UI card" })
          });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          btn.textContent = "\u2713 \u5DF2\u91CD\u8BD5";
        } catch (err) {
          btn.disabled = false;
          btn.textContent = "\u{1F501} \u91CD\u8BD5 (\u5931\u8D25)";
          body.textContent += `
[retry error] ${err && err.message || err}`;
        }
      };
      body.appendChild(btn);
    }
    container.appendChild(card);
    card.scrollIntoView({ block: "end", behavior: "smooth" });
  }
  function setSendMode(mode) {
    if (!sendBtn) return;
    sendBtn.dataset.state = mode;
    sendBtn.title = mode === "abort" ? "\u23F9 \u7EC8\u6B62\u5F53\u524D\u751F\u6210 (Esc)" : "\u53D1\u9001 (Enter)";
    const sendIcon = sendBtn.querySelector('[data-mode="send"]');
    const abortIcon = sendBtn.querySelector('[data-mode="abort"]');
    if (sendIcon) sendIcon.style.display = mode === "idle" ? "" : "none";
    if (abortIcon) abortIcon.style.display = mode === "idle" ? "none" : "";
  }
  async function abortCurrentRun() {
    if (sendBtn && sendBtn.dataset.state === "aborting") return;
    setSendMode("aborting");
    try {
      const r = await fetch("/api/chat/abort", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channelId: currentChannelId || "" })
      });
      const j = await r.json().catch(() => ({}));
      if (j.aborted) {
        if (typeof showSimpleToast === "function") showSimpleToast("\u2713 \u5DF2\u7EC8\u6B62");
      } else {
        if (typeof showSimpleToast === "function") showSimpleToast("\u25CB \u5F53\u524D\u65E0\u8FD0\u884C\u4E2D");
      }
    } catch (err) {
      console.error("[abort] error:", err);
      if (typeof showSimpleToast === "function") showSimpleToast("\u2717 \u7EC8\u6B62\u5931\u8D25");
    }
    setTimeout(() => {
      if (sendBtn && sendBtn.dataset.state === "aborting") setSendMode("idle");
    }, 1500);
  }
  function connect(channelId) {
    const targetChannelId = channelId || currentChannelId;
    if (!targetChannelId) return;
    if (reconnectTimers.has(targetChannelId)) {
      clearTimeout(reconnectTimers.get(targetChannelId));
      reconnectTimers.delete(targetChannelId);
    }
    if (heartbeatTimers.has(targetChannelId)) {
      clearInterval(heartbeatTimers.get(targetChannelId));
      heartbeatTimers.delete(targetChannelId);
    }
    if (eventSources.has(targetChannelId)) {
      eventSources.get(targetChannelId).close();
      eventSources.delete(targetChannelId);
    }
    const sseUrl = `/events?channelId=${encodeURIComponent(targetChannelId)}`;
    console.log("[connect] \u521B\u5EFA SSE \u8FDE\u63A5:", sseUrl);
    const eventSource = new EventSource(sseUrl);
    eventSources.set(targetChannelId, eventSource);
    if (!reconnectAttempts.has(targetChannelId)) {
      reconnectAttempts.set(targetChannelId, 0);
    }
    eventSource.onopen = () => {
      console.log("[SSE] \u5DF2\u8FDE\u63A5 channelId:", targetChannelId);
      reconnectAttempts.set(targetChannelId, 0);
    };
    let lastEventTime = Date.now();
    const heartbeatTimer = setInterval(() => {
      if (!eventSources.has(targetChannelId)) {
        clearInterval(heartbeatTimer);
        return;
      }
      if (Date.now() - lastEventTime > 3e4) {
        console.warn("[SSE] 30s \u65E0\u6570\u636E, \u5F3A\u5236\u91CD\u5EFA\u8FDE\u63A5:", targetChannelId);
        clearInterval(heartbeatTimer);
        try {
          eventSource.close();
        } catch {
        }
        eventSources.delete(targetChannelId);
        const attempts = (reconnectAttempts.get(targetChannelId) || 0) + 1;
        reconnectAttempts.set(targetChannelId, attempts);
        const delay = Math.min(1e3 * Math.pow(2, attempts - 1), 15e3);
        const timer = setTimeout(() => connect(targetChannelId), delay);
        reconnectTimers.set(targetChannelId, timer);
      }
    }, 1e4);
    eventSource.onerror = () => {
      console.warn("[SSE] \u9519\u8BEF, \u6D4F\u89C8\u5668\u81EA\u52A8\u91CD\u8FDE\u4E2D:", targetChannelId, "readyState=", eventSource.readyState);
      if (eventSource.readyState === EventSource.CLOSED) {
        clearInterval(heartbeatTimer);
        eventSources.delete(targetChannelId);
        const attempts = (reconnectAttempts.get(targetChannelId) || 0) + 1;
        reconnectAttempts.set(targetChannelId, attempts);
        const delay = Math.min(1e3 * Math.pow(2, attempts - 1), 15e3);
        const timer = setTimeout(() => connect(targetChannelId), delay);
        reconnectTimers.set(targetChannelId, timer);
      }
    };
    eventSource.onmessage = (e) => {
      lastEventTime = Date.now();
      try {
        const data = JSON.parse(e.data);
        if (data && data.type === "ping") {
          return;
        }
        const msgChannelId = data.channelId || targetChannelId;
        console.log("[SSE] \u6536\u5230\u6D88\u606F:", data.type, "channelId:", msgChannelId);
        if (msgChannelId && msgChannelId !== targetChannelId) {
          console.log("[SSE] \u5FFD\u7565\u975E\u76EE\u6807\u9891\u9053\u6D88\u606F");
          return;
        }
        const container = messagesContainers.get(msgChannelId) || messagesEl;
        if (data.type === "user") {
          if (data.source === "remote") {
            addMessage(data.content, "user", true, container);
          }
        } else if (data.type === "ai") {
          if (!MR_hasStreamingText()) {
            addMessage(data.content, "ai", true, container, lastUsedJudgmentIds);
          }
        } else if (data.type === "stream") {
          if (data.streamType === "thinking" || data.streamType === "token") {
            handleStreamTokenEvent(data);
          }
        } else if (data.type === "regenerating") {
          const messages = container.querySelectorAll(".message-ai");
          if (messages.length > 0) {
            const lastAiMsg = messages[messages.length - 1];
            lastAiMsg.remove();
          }
          setSendMode("abort");
        } else if (data.type === "status") {
          renderLoopStatusBar(data.tool, data.content);
        } else if (data.type === "step_start" || data.type === "step_done" || data.type === "step_error") {
          handleStepEvent(data);
        } else if (data.type === "done") {
          finalizeTimelineAsMessage();
          hideLoopStatusBar();
          setSendMode("idle");
        } else if (data.type === "renamed") {
          const channel = channels.find((c) => c.id === data.channelId);
          if (channel) {
            channel.name = data.newName;
            renderChannels();
            if (currentChannelId === data.channelId && channelNameEl) {
              channelNameEl.textContent = data.newName;
            }
          }
        } else if (data.type === "error") {
          if (typeof showSimpleToast === "function") {
            const msg = String(data.content || "").slice(0, 200);
            showSimpleToast("\u26A0\uFE0F " + msg);
          } else {
            console.error("[SSE] error:", data.content);
          }
          hideLoopStatusBar();
          setSendMode("idle");
        } else if (data.type === "task_status" || data.type === "workflow_step" || data.type === "workflow_loop") {
          if (data.type === "workflow_step" && (data.step === "AI \u601D\u8003" || data.step === "\u5F00\u59CB\u601D\u8003")) {
            return;
          }
          console.log("[SSE] workflow (deprecated for UI):", data.type, data.content?.slice(0, 80));
        } else if (data.type === "phase") {
          console.log("[SSE] phase (no UI):", data.phase);
        } else if (data.type === "queue_update") {
          console.log("[SSE] queue_update (no UI):", data.queueLength);
        } else if (data.type === "used_judgments" && Array.isArray(data.usedIds)) {
          lastUsedJudgmentIds = data.usedIds;
        } else if (data.type === "self_improve_triggered") {
          handleSelfImproveTriggered(data);
        } else if (data.type === "self_improve_result") {
          handleSelfImproveResult(data);
        }
      } catch (parseErr) {
        console.error("[SSE] \u89E3\u6790\u9519\u8BEF", parseErr);
      }
    };
  }
  async function sendMessage() {
    const text = input.value.trim();
    if (!text) return;
    const container = messagesContainers.get(currentChannelId) || messagesEl;
    addMessage(text, "user", true, container);
    if (container) container.scrollTop = container.scrollHeight;
    input.value = "";
    setSendMode("abort");
    persistLastMessageToServer("user", text);
    const channel = channels.find((c) => c.id === currentChannelId);
    const channelDid = channel?.did || "";
    console.log("[\u53D1\u9001\u6D88\u606F] \u9891\u9053 DID:", channelDid);
    try {
      const res = await fetch("/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          channelId: currentChannelId,
          channelDid
        })
      });
      if (!res.ok) {
        addMessage("\u53D1\u9001\u5931\u8D25", "ai");
        setSendMode("idle");
      }
    } catch (err) {
      addMessage("\u8FDE\u63A5\u9519\u8BEF", "ai");
      console.error("Send error", err);
      setSendMode("idle");
    }
  }
  function persistLastMessageToServer(type, content) {
    if (!currentChannelId || !currentSessionId) return;
    fetch(`/sessions/${currentChannelId}/${currentSessionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: { type, content, timestamp: (/* @__PURE__ */ new Date()).toISOString() }
      })
    }).catch((err) => {
      console.warn("[persist] \u843D\u76D8\u5931\u8D25:", err);
    });
  }
  sendBtn.addEventListener("click", () => {
    if (sendBtn.dataset.state === "abort" || sendBtn.dataset.state === "aborting") {
      abortCurrentRun();
    } else {
      sendMessage();
    }
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (sendBtn.dataset.state === "abort" || sendBtn.dataset.state === "aborting") {
        abortCurrentRun();
      } else {
        sendMessage();
      }
    } else if (e.key === "Escape" && (sendBtn.dataset.state === "abort" || sendBtn.dataset.state === "aborting")) {
      e.preventDefault();
      abortCurrentRun();
    }
  });
  let mentionChannels = [];
  let mentionDropdownEl = null;
  let mentionHighlightIdx = -1;
  let mentionQuery = null;
  let mentionAnchor = -1;
  let mentionBlockEnd = -1;
  let mentionDocMousedownBound = false;
  function ensureMentionDocMousedown() {
    if (mentionDocMousedownBound) return;
    mentionDocMousedownBound = true;
    document.addEventListener("mousedown", (e) => {
      if (mentionDropdownEl && !mentionDropdownEl.contains(e.target) && e.target !== input) {
        closeMentionDropdown();
      }
    });
  }
  async function refreshMentionChannels() {
    try {
      const res = await fetch("/channels");
      const local = res.ok ? await res.json() : [];
      const r2 = await fetch("/api/remote-channels");
      const remoteData = r2.ok ? await r2.json() : { peers: [] };
      const remote = [];
      for (const p of remoteData.peers || []) {
        for (const c of p.channels || []) {
          remote.push({ id: c.id, name: c.name, source: "remote", ownerPublicKey: p.peerId });
        }
      }
      mentionChannels = [
        ...Array.isArray(local) ? local.map((c) => ({ id: c.id, name: c.name, source: "local" })) : [],
        ...remote
      ];
    } catch (err) {
      console.warn("[mention] \u52A0\u8F7D\u6E20\u9053\u5217\u8868\u5931\u8D25:", err);
    }
  }
  function closeMentionDropdown() {
    if (mentionDropdownEl) {
      mentionDropdownEl.remove();
      mentionDropdownEl = null;
    }
    mentionHighlightIdx = -1;
    mentionQuery = null;
    mentionAnchor = -1;
    mentionBlockEnd = -1;
  }
  function getCurrentMentionQuery() {
    const pos = input.selectionStart || input.value.length;
    const before = input.value.slice(0, pos);
    const m = before.match(/@([一-龥A-Za-z0-9_\-]{0,30})$/);
    return m ? { query: m[1], anchor: pos - m[0].length } : null;
  }
  function renderMentionDropdown(items) {
    if (!mentionDropdownEl) {
      mentionDropdownEl = document.createElement("div");
      mentionDropdownEl.id = "mention-dropdown";
      mentionDropdownEl.style.cssText = "position:fixed;background:#fff;border:1px solid #d1d5db;border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,0.15);max-height:240px;overflow-y:auto;z-index:10000;font-size:13px;min-width:240px;";
      document.body.appendChild(mentionDropdownEl);
      ensureMentionDocMousedown();
    }
    const headerHtml = `<div style="padding:6px 10px;background:#f9fafb;border-bottom:1px solid #e5e7eb;font-size:11px;color:#6b7280;display:flex;justify-content:space-between;align-items:center;">
    <span>\u{1F4A1} \u70B9\u51FB\u6216\u56DE\u8F66\u9009\u4E2D \u2192 \u81EA\u52A8\u586B\u5165\u8F93\u5165\u6846</span>
    <span style="color:#9ca3af;">\u2191\u2193 \u79FB\u52A8</span>
  </div>`;
    if (items.length === 0) {
      mentionDropdownEl.innerHTML = headerHtml + '<div style="padding:10px 12px;color:#6b7280;font-size:12px;">\u6CA1\u6709\u5339\u914D\u7684\u6E20\u9053</div>';
    } else {
      const rows = items.map((c, i) => {
        const isLocal = c.source === "local";
        const tag = isLocal ? "\u{1F3E0} \u672C\u5730" : "\u{1F310} \u8FDC\u7AEF";
        const owner = !isLocal && c.ownerPublicKey ? ` <span style="color:#9ca3af;font-size:11px;">(${c.ownerPublicKey.substring(0, 8)}\u2026)</span>` : "";
        const bg = i === mentionHighlightIdx ? "#eff6ff" : "#fff";
        const borderLeft = i === mentionHighlightIdx ? "3px solid #93c5fd" : "3px solid transparent";
        return `<div class="mention-item" data-idx="${i}" data-channel-id="${escapeHtml(c.id)}" data-channel-name="${escapeHtml(c.name || "")}" style="padding:8px 12px;cursor:pointer;background:${bg};border-bottom:1px solid #f3f4f6;display:flex;align-items:center;gap:8px;border-left:${borderLeft};">
        <span style="font-size:10px;color:${isLocal ? "#059669" : "#2563eb"};background:${isLocal ? "#d1fae5" : "#dbeafe"};padding:1px 6px;border-radius:3px;white-space:nowrap;">${tag}</span>
        <span style="flex:1;">${escapeHtml(c.name || "(\u672A\u547D\u540D)")}</span>${owner}
      </div>`;
      }).join("");
      mentionDropdownEl.innerHTML = headerHtml + rows;
      mentionDropdownEl.querySelectorAll(".mention-item").forEach((el) => {
        const idx = parseInt(el.getAttribute("data-idx"));
        el.onclick = () => {
          applyMention(items[idx]);
        };
        el.onmouseenter = () => {
          if (mentionHighlightIdx === idx) return;
          mentionHighlightIdx = idx;
          const itemEls = mentionDropdownEl.querySelectorAll(".mention-item");
          itemEls.forEach((ie, ii) => {
            const isHi = ii === idx;
            ie.style.background = isHi ? "#eff6ff" : "#fff";
            ie.style.borderLeft = isHi ? "3px solid #93c5fd" : "3px solid transparent";
          });
        };
      });
    }
    const rect = input.getBoundingClientRect();
    mentionDropdownEl.style.left = rect.left + "px";
    mentionDropdownEl.style.top = "auto";
    mentionDropdownEl.style.bottom = window.innerHeight - rect.top + 4 + "px";
  }
  function applyMention(channel) {
    const anchor = mentionAnchor;
    const blockEnd = mentionBlockEnd >= 0 ? mentionBlockEnd : anchor + 1 + (mentionQuery || "").length;
    if (anchor < 0 || anchor > input.value.length || input.value[anchor] !== "@") {
      closeMentionDropdown();
      return;
    }
    const before = input.value.slice(0, anchor);
    const after = input.value.slice(blockEnd);
    const insert = `@${channel.name} `;
    input.value = before + insert + after;
    const newPos = before.length + insert.length;
    input.focus();
    input.setSelectionRange(newPos, newPos);
    closeMentionDropdown();
  }
  function updateMentionDropdown() {
    if (!mentionChannels.length) {
      refreshMentionChannels().then(() => {
        if (mentionChannels.length) updateMentionDropdown();
      });
      return;
    }
    const m = getCurrentMentionQuery();
    if (!m) {
      closeMentionDropdown();
      return;
    }
    if (mentionAnchor === -1) {
      mentionAnchor = m.anchor;
      mentionBlockEnd = m.anchor + 1 + (m.query || "").length;
      refreshMentionChannels();
    }
    mentionQuery = m.query;
    const q = m.query.toLowerCase();
    const items = mentionChannels.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 8);
    mentionHighlightIdx = items.length > 0 ? 0 : -1;
    renderMentionDropdown(items);
  }
  input.addEventListener("input", () => {
    updateMentionDropdown();
  });
  input.addEventListener("keydown", (e) => {
    if (!mentionDropdownEl) return;
    const items = mentionDropdownEl.querySelectorAll(".mention-item");
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (items.length === 0) return;
      mentionHighlightIdx = (mentionHighlightIdx + 1) % items.length;
      const q = (mentionQuery || "").toLowerCase();
      const filtered = mentionChannels.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 8);
      renderMentionDropdown(filtered);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (items.length === 0) return;
      mentionHighlightIdx = (mentionHighlightIdx - 1 + items.length) % items.length;
      const q = (mentionQuery || "").toLowerCase();
      const filtered = mentionChannels.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 8);
      renderMentionDropdown(filtered);
    } else if (e.key === "Enter" || e.key === "Tab") {
      if (items.length > 0) {
        e.preventDefault();
        e.stopPropagation();
        const q = (mentionQuery || "").toLowerCase();
        const filtered = mentionChannels.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 8);
        const cur = filtered[mentionHighlightIdx];
        if (cur) applyMention(cur);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeMentionDropdown();
    }
  }, true);
  refreshMentionChannels();
  setInterval(refreshMentionChannels, 5e3);
  function setupMentionAutocomplete(inputEl) {
    if (!inputEl || inputEl.__mentionBound) return;
    inputEl.__mentionBound = true;
    let localQuery = null;
    let localAnchor = -1;
    let localBlockEnd = -1;
    let localHighlight = -1;
    function closeLocal() {
      if (inputEl.__mentionDD) {
        inputEl.__mentionDD.remove();
        inputEl.__mentionDD = null;
      }
      localHighlight = -1;
      localQuery = null;
      localAnchor = -1;
      localBlockEnd = -1;
    }
    function detectQuery() {
      const pos = inputEl.selectionStart || inputEl.value.length;
      const before = inputEl.value.slice(0, pos);
      const m = before.match(/@([一-龥A-Za-z0-9_\-]{0,30})$/);
      return m ? { query: m[1], anchor: pos - m[0].length } : null;
    }
    function applyLocal(channel) {
      const anchor = localAnchor;
      const blockEnd = localBlockEnd >= 0 ? localBlockEnd : anchor + 1 + (localQuery || "").length;
      if (anchor < 0 || anchor > inputEl.value.length || inputEl.value[anchor] !== "@") {
        closeLocal();
        return;
      }
      const before = inputEl.value.slice(0, anchor);
      const after = inputEl.value.slice(blockEnd);
      const insert = `@${channel.name} `;
      inputEl.value = before + insert + after;
      const newPos = before.length + insert.length;
      inputEl.focus();
      inputEl.setSelectionRange(newPos, newPos);
      closeLocal();
    }
    function renderLocal(items) {
      if (!inputEl.__mentionDD) {
        inputEl.__mentionDD = document.createElement("div");
        inputEl.__mentionDD.style.cssText = "position:fixed;background:#fff;border:1px solid #d1d5db;border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,0.15);max-height:240px;overflow-y:auto;z-index:10001;font-size:13px;min-width:240px;";
        document.body.appendChild(inputEl.__mentionDD);
      }
      const headerHtml = `<div style="padding:6px 10px;background:#f9fafb;border-bottom:1px solid #e5e7eb;font-size:11px;color:#6b7280;display:flex;justify-content:space-between;align-items:center;">
      <span>\u{1F4A1} \u70B9\u51FB\u6216\u56DE\u8F66\u9009\u4E2D \u2192 \u81EA\u52A8\u586B\u5165\u8F93\u5165\u6846</span>
      <span style="color:#9ca3af;">\u2191\u2193 \u79FB\u52A8</span>
    </div>`;
      if (items.length === 0) {
        inputEl.__mentionDD.innerHTML = headerHtml + '<div style="padding:10px 12px;color:#6b7280;font-size:12px;">\u6CA1\u6709\u5339\u914D\u7684\u6E20\u9053</div>';
      } else {
        inputEl.__mentionDD.innerHTML = headerHtml + items.map((c, i) => {
          const isLocal = c.source === "local";
          const tag = isLocal ? "\u{1F3E0} \u672C\u5730" : "\u{1F310} \u8FDC\u7AEF";
          const owner = !isLocal && c.ownerPublicKey ? ` <span style="color:#9ca3af;font-size:11px;">(${c.ownerPublicKey.substring(0, 8)}\u2026)</span>` : "";
          const bg = i === localHighlight ? "#eff6ff" : "#fff";
          const borderLeft = i === localHighlight ? "3px solid #93c5fd" : "3px solid transparent";
          return `<div class="mention-item" data-idx="${i}" data-channel-id="${escapeHtml(c.id)}" data-channel-name="${escapeHtml(c.name || "")}" style="padding:8px 12px;cursor:pointer;background:${bg};border-bottom:1px solid #f3f4f6;display:flex;align-items:center;gap:8px;border-left:${borderLeft};">
          <span style="font-size:10px;color:${isLocal ? "#059669" : "#2563eb"};background:${isLocal ? "#d1fae5" : "#dbeafe"};padding:1px 6px;border-radius:3px;white-space:nowrap;">${tag}</span>
          <span style="flex:1;">${escapeHtml(c.name || "(\u672A\u547D\u540D)")}</span>${owner}
        </div>`;
        }).join("");
        inputEl.__mentionDD.querySelectorAll(".mention-item").forEach((el) => {
          const idx = parseInt(el.getAttribute("data-idx"));
          el.onclick = () => applyLocal(items[idx]);
          el.onmouseenter = () => {
            if (localHighlight === idx) return;
            localHighlight = idx;
            const itemEls = inputEl.__mentionDD.querySelectorAll(".mention-item");
            itemEls.forEach((ie, ii) => {
              const isHi = ii === idx;
              ie.style.background = isHi ? "#eff6ff" : "#fff";
              ie.style.borderLeft = isHi ? "3px solid #93c5fd" : "3px solid transparent";
            });
          };
        });
      }
      const rect = inputEl.getBoundingClientRect();
      inputEl.__mentionDD.style.left = rect.left + "px";
      inputEl.__mentionDD.style.top = "auto";
      inputEl.__mentionDD.style.bottom = window.innerHeight - rect.top + 4 + "px";
    }
    function update() {
      if (!mentionChannels.length) {
        refreshMentionChannels().then(() => {
          if (mentionChannels.length) update();
        });
        return;
      }
      const m = detectQuery();
      if (!m) {
        closeLocal();
        return;
      }
      if (localAnchor === -1) {
        localAnchor = m.anchor;
        localBlockEnd = m.anchor + 1 + (m.query || "").length;
        refreshMentionChannels();
      }
      localQuery = m.query;
      const q = m.query.toLowerCase();
      const items = mentionChannels.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 8);
      localHighlight = items.length > 0 ? 0 : -1;
      renderLocal(items);
    }
    inputEl.addEventListener("input", update);
    inputEl.addEventListener("keydown", (e) => {
      if (!inputEl.__mentionDD) return;
      const items = inputEl.__mentionDD.querySelectorAll(".mention-item");
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (items.length === 0) return;
        localHighlight = (localHighlight + 1) % items.length;
        const q = (localQuery || "").toLowerCase();
        renderLocal(mentionChannels.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 8));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (items.length === 0) return;
        localHighlight = (localHighlight - 1 + items.length) % items.length;
        const q = (localQuery || "").toLowerCase();
        renderLocal(mentionChannels.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 8));
      } else if (e.key === "Enter" || e.key === "Tab") {
        if (items.length > 0) {
          e.preventDefault();
          e.stopPropagation();
          const q = (localQuery || "").toLowerCase();
          const filtered = mentionChannels.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 8);
          const cur = filtered[localHighlight];
          if (cur) applyLocal(cur);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        closeLocal();
      }
    }, true);
  }
  const inputArea = document.querySelector(".input-area");
  if (input && inputArea) {
    const onDragOver = (e) => {
      if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("application/x-bolloon-judgment")) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        inputArea.classList.add("drop-target");
      }
    };
    const onDragLeave = (e) => {
      if (e.target === inputArea || !inputArea.contains(e.relatedTarget)) {
        inputArea.classList.remove("drop-target");
      }
    };
    const onDrop = (e) => {
      inputArea.classList.remove("drop-target");
      const raw = e.dataTransfer.getData("application/x-bolloon-judgment");
      if (!raw) return;
      e.preventDefault();
      try {
        const { id, decision } = JSON.parse(raw);
        const prefix = input.value.trim() ? input.value.trim() + "\n" : "";
        input.value = `${prefix}\u6309\u6211\u7684\u5224\u65AD #${id?.substring(0, 8) || ""} \u6267\u884C: ${decision}`;
        input.focus();
        input.style.transition = "box-shadow 0.3s";
        input.style.boxShadow = "0 0 0 2px #2563eb";
        setTimeout(() => {
          input.style.boxShadow = "";
        }, 800);
      } catch {
      }
    };
    inputArea.addEventListener("dragover", onDragOver);
    inputArea.addEventListener("dragleave", onDragLeave);
    inputArea.addEventListener("drop", onDrop);
  }
  if (themeToggle) {
    themeToggle.addEventListener("click", toggleTheme);
  }
  const apiConfigBtn = document.getElementById("api-config-btn");
  if (apiConfigBtn) {
    apiConfigBtn.addEventListener("click", () => {
      window.location.href = "/api-config";
    });
  }
  const walletBtn = document.getElementById("wallet-btn");
  const walletBadge = document.getElementById("wallet-badge");
  if (walletBtn) {
    walletBtn.addEventListener("click", openWalletModal);
  }
  function refreshWalletBadge() {
    if (!walletBadge) return;
    const count = channels.filter((c) => c.walletAddress).length;
    if (count > 0) {
      walletBadge.textContent = String(count);
      walletBadge.style.display = "";
    } else {
      walletBadge.style.display = "none";
    }
  }
  if (sidebarToggle) {
    sidebarToggle.addEventListener("click", toggleSidebar);
  }
  if (newChannelBtn) {
    newChannelBtn.addEventListener("click", () => {
      createChannel("\u667A\u80FD\u4F53");
    });
  }
  if (newChannelInput) {
    newChannelInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        createChannel(newChannelInput.value);
      }
    });
  }
  async function checkApiConfig() {
    try {
      const res = await fetch("/api/llm-config");
      const config = await res.json();
      const hasConfigured = Object.values(config.providers).some((p) => p.enabled && p.apiKey);
      if (!hasConfigured) {
        const hint = document.createElement("div");
        hint.className = "api-config-hint";
        hint.innerHTML = `
        <div class="hint-icon">\u26A0\uFE0F</div>
        <div class="hint-text">
          <strong>API \u672A\u914D\u7F6E</strong><br>
          \u8BF7\u5148\u914D\u7F6E AI \u6A21\u578B\u624D\u80FD\u5F00\u59CB\u5BF9\u8BDD
        </div>
        <button class="hint-btn" id="api-config-hint-btn">\u524D\u5F80\u914D\u7F6E</button>
      `;
        document.body.appendChild(hint);
        const hintBtn = document.getElementById("api-config-hint-btn");
        if (hintBtn) {
          hintBtn.addEventListener("click", () => {
            window.location.href = "/api-config";
          });
        }
      }
    } catch (err) {
      console.error("Failed to check API config:", err);
    }
  }
  async function init() {
    const themeData = await loadTheme();
    currentAgentId = themeData.agentId || `agent_${generateId().substring(0, 8)}`;
    if (!themeData.agentId) {
      await saveTheme(themeData.theme, currentAgentId);
    }
    await loadChannels();
    await checkApiConfig();
    if (channels.length > 0) {
      await selectChannel(channels[0].id);
    } else {
      await createChannel("\u9ED8\u8BA4\u4F1A\u8BDD");
    }
  }
  const p2pNetworkBtn = document.getElementById("p2p-network-btn");
  if (p2pNetworkBtn) {
    p2pNetworkBtn.addEventListener("click", () => {
      if (typeof window.showP2PModal === "function") {
        window.showP2PModal();
      }
    });
  }
  const judgmentsModal = document.getElementById("judgments-modal");
  const judgmentsBtn = document.getElementById("judgments-btn");
  const judgmentsModalClose = document.getElementById("judgments-modal-close");
  const judgmentDecision = document.getElementById("judgment-decision");
  const judgmentReason = document.getElementById("judgment-reason");
  const judgmentDomain = document.getElementById("judgment-domain");
  const judgmentStakes = document.getElementById("judgment-stakes");
  const judgmentSubmitBtn = document.getElementById("judgment-submit-btn");
  const judgmentError = document.getElementById("judgment-error");
  const judgmentsList = document.getElementById("judgments-list");
  const judgmentsBadge = document.getElementById("judgments-badge");
  let judgmentsLoaded = false;
  function showJudgmentsModal() {
    if (judgmentsModal) judgmentsModal.classList.add("active");
    if (!judgmentsLoaded) loadJudgments();
    else renderJudgments(lastJudgmentsCache);
  }
  function switchJudgmentTab(tab) {
    currentJudgmentTab = tab;
    document.querySelectorAll(".judgment-tab").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tab === tab);
    });
    renderJudgments(lastJudgmentsCache);
  }
  function switchStatusFilter(status) {
    currentStatusFilter = status;
    document.querySelectorAll(".judgment-status-tab").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.status === status);
    });
    loadJudgments();
  }
  function openJudgmentsModalWithFilter(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return;
    if (typeof openJudgmentsModal === "function") {
      openJudgmentsModal();
    } else if (judgmentsModal) {
      judgmentsModal.classList.add("active");
    }
    setTimeout(() => {
      if (typeof lastJudgmentsCache === "undefined") return;
      lastJudgmentsCache = (lastJudgmentsCache || []).filter((j) => ids.includes(j.id));
      if (typeof renderJudgments === "function") {
        renderJudgments(lastJudgmentsCache);
      }
    }, 150);
  }
  function hideJudgmentsModal() {
    if (judgmentsModal) judgmentsModal.classList.remove("active");
  }
  let currentJudgmentTab = "channel";
  let currentStatusFilter = "all";
  let lastJudgmentsCache = [];
  function renderJudgments(items) {
    if (!judgmentsList) return;
    const all = items || [];
    const titleEl = document.getElementById("judgments-list-title");
    const chNameEl = document.getElementById("judgments-tab-channel-name");
    const currentCh = currentChannelId ? channels.find((c) => c.id === currentChannelId) : null;
    if (chNameEl) {
      chNameEl.textContent = currentCh ? `(${currentCh.name})` : "(\u672A\u9009)";
    }
    if (all.length === 0) {
      judgmentsList.innerHTML = '<div class="task-empty">\u8FD8\u6CA1\u6709\u5224\u65AD, \u5728\u4E0A\u9762\u8BB0\u5F55\u7B2C\u4E00\u6761\u5427</div>';
      if (titleEl) titleEl.textContent = "\u672C channel \u7684\u5224\u65AD\u529B";
      return;
    }
    if (currentJudgmentTab === "global") {
      if (titleEl) titleEl.textContent = `\u5168\u5C40\u5224\u65AD\u529B (${all.length} \u6761)`;
      judgmentsList.innerHTML = renderJudgmentItems(all, { showBindToggle: false });
      return;
    }
    if (!currentCh) {
      if (titleEl) titleEl.textContent = "\u672C channel \u7684\u5224\u65AD\u529B";
      judgmentsList.innerHTML = `
      <div style="padding:24px 12px;text-align:center;color:#6b7280;font-size:13px;">
        \u8BF7\u5148\u5728\u5DE6\u4FA7\u9009\u4E2D\u4E00\u4E2A channel,<br>\u7136\u540E\u8FD9\u91CC\u4F1A\u663E\u793A\u5DF2\u7ED1\u5B9A\u548C\u53EF\u52A0\u5165\u7684\u5224\u65AD\u529B\u3002
      </div>
    `;
      return;
    }
    const boundIds = new Set(
      Array.isArray(currentCh.bound_judgment_ids) ? currentCh.bound_judgment_ids : []
    );
    const bound = all.filter((j) => boundIds.has(j.id));
    const unbound = all.filter((j) => !boundIds.has(j.id));
    if (titleEl) titleEl.textContent = `${currentCh.name} \u7684\u5224\u65AD\u529B (\u5DF2\u7ED1 ${bound.length} / \u5171 ${all.length})`;
    let html = "";
    if (bound.length > 0) {
      html += `<div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;padding:8px 4px 4px;">\u5DF2\u7ED1\u5B9A (${bound.length})</div>`;
      html += renderJudgmentItems(bound, { showBindToggle: true, isBound: true });
    }
    if (unbound.length > 0) {
      html += `<div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;padding:14px 4px 4px;">\u672A\u7ED1\u5B9A (${unbound.length})</div>`;
      html += renderJudgmentItems(unbound, { showBindToggle: true, isBound: false });
    }
    judgmentsList.innerHTML = html;
  }
  function renderJudgmentItems(items, opts) {
    const { showBindToggle, isBound } = opts || {};
    return items.map((j) => {
      const reason = j.reasons && j.reasons[0] ? escapeHtml(j.reasons[0]) : "";
      const domain = j.context && j.context.domain ? escapeHtml(j.context.domain) : "general";
      const stakes = j.context && j.context.stakes ? escapeHtml(j.context.stakes) : "medium";
      const isSuperseded = j.status === "superseded";
      const isRejected = j.status === "rejected";
      const dimmedStyle = isSuperseded || isRejected ? "opacity:0.55;background:#f3f4f6;" : "";
      const statusTag = isSuperseded ? `<span style="display:inline-block;background:#fef3c7;color:#92400e;font-size:10px;padding:1px 6px;border-radius:3px;margin-left:6px;" title="\u5DF2\u88AB\u65B0\u5224\u65AD\u529B\u6F14\u5316\u66FF\u4EE3">\u5DF2\u8FC7\u65F6</span>` : isRejected ? `<span style="display:inline-block;background:#fee2e2;color:#991b1b;font-size:10px;padding:1px 6px;border-radius:3px;margin-left:6px;">\u5DF2\u62D2\u7EDD</span>` : "";
      const evolveNote = isSuperseded && j.supersededBy ? `<div style="font-size:10px;color:#6b7280;margin-top:2px;">\u88AB\u65B0\u6761\u66FF\u4EE3 \xB7 ${escapeHtml(j.evolutionReason || "merged")} \xB7 ${escapeHtml(j.evolvedAt || "").substring(0, 10)}</div>` : "";
      const bindBtn = showBindToggle ? isBound ? `<button class="judgment-toggle-btn" data-id="${escapeHtml(j.id)}" data-action="unbind" title="\u4ECE\u5F53\u524D channel \u79FB\u9664" style="background:none;border:1px solid #fca5a5;color:#b91c1c;padding:1px 8px;border-radius:3px;cursor:pointer;font-size:11px;">\xD7 \u79FB\u9664</button>` : `<button class="judgment-toggle-btn" data-id="${escapeHtml(j.id)}" data-action="bind" title="\u52A0\u8FDB\u5F53\u524D channel" style="background:none;border:1px solid #6b7280;color:#6b7280;padding:1px 8px;border-radius:3px;cursor:pointer;font-size:11px;">+ \u52A0\u5165</button>` : "";
      return `
      <div class="task-item completed judgment-row"
           data-judgment-id="${escapeHtml(j.id)}"
           draggable="true"
           style="cursor:grab;${dimmedStyle}">
        <div class="task-item-header">
          <label class="judgment-checkbox" style="display:flex;align-items:center;cursor:pointer;margin-right:8px;" onclick="event.stopPropagation();">
            <input type="checkbox" class="judgment-select-cb" data-id="${escapeHtml(j.id)}" style="cursor:pointer;" onclick="event.stopPropagation();">
          </label>
          <div class="task-item-title">
            <span class="judgment-decision">${escapeHtml(j.decision)}</span>${statusTag}
          </div>
          <span class="task-item-status completed">${stakes}</span>
        </div>
        ${reason ? `<div class="task-item-desc" style="color:#555;font-size:13px;margin-top:4px;">\u7406\u7531: ${reason}</div>` : ""}
        ${evolveNote}
        <div class="task-item-meta" style="color:#999;font-size:11px;margin-top:4px;display:flex;justify-content:space-between;align-items:center;">
          <span>${domain} \xB7 ${escapeHtml(j.timestamp)} \xB7 ${escapeHtml(j.id)}</span>
          <span style="display:flex;gap:4px;">
            ${bindBtn}
            <button class="judgment-edit-btn" data-id="${escapeHtml(j.id)}" title="\u7F16\u8F91\u5224\u65AD" style="background:none;border:1px solid #d1d5db;color:#374151;padding:1px 8px;border-radius:3px;cursor:pointer;font-size:11px;">\u7F16\u8F91</button>
            <button class="judgment-del-btn" data-id="${escapeHtml(j.id)}" title="\u5220\u9664\u5224\u65AD" style="background:none;border:1px solid #fca5a5;color:#b91c1c;padding:1px 8px;border-radius:3px;cursor:pointer;font-size:11px;">\u5220\u9664</button>
          </span>
        </div>
      </div>
    `;
    }).join("");
  }
  async function loadJudgments() {
    if (!judgmentsList) return;
    try {
      if (currentStatusFilter === "violations") {
        const res2 = await fetch("/api/judgments/violations?limit=50");
        if (!res2.ok) throw new Error("HTTP " + res2.status);
        const data2 = await res2.json();
        renderViolations(data2.items || []);
        judgmentsLoaded = true;
        return;
      }
      if (currentStatusFilter === "adaptive") {
        const res2 = await fetch("/api/judgments/adaptive-suggestions");
        if (!res2.ok) throw new Error("HTTP " + res2.status);
        const data2 = await res2.json();
        renderAdaptiveSuggestions(data2);
        judgmentsLoaded = true;
        return;
      }
      if (currentStatusFilter === "causal") {
        const res2 = await fetch("/api/judgments/causal/correlation?topN=10");
        if (!res2.ok) throw new Error("HTTP " + res2.status);
        const data2 = await res2.json();
        renderCausalAnalysis(data2.items || []);
        judgmentsLoaded = true;
        return;
      }
      const res = await fetch("/api/judgments?status=" + encodeURIComponent(currentStatusFilter));
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      lastJudgmentsCache = data.judgments || [];
      renderJudgments(lastJudgmentsCache);
      if (judgmentsBadge) {
        let activeCount;
        if (currentStatusFilter === "active") {
          activeCount = data.count;
        } else {
          activeCount = lastJudgmentsCache.filter((j) => (j.status ?? "active") === "active").length;
        }
        if (activeCount > 0) {
          judgmentsBadge.textContent = activeCount;
          judgmentsBadge.style.display = "";
        } else {
          judgmentsBadge.style.display = "none";
        }
      }
      judgmentsLoaded = true;
    } catch (e) {
      if (judgmentsList) judgmentsList.innerHTML = '<div class="task-empty">\u52A0\u8F7D\u5931\u8D25: ' + escapeHtml(e.message) + "</div>";
    }
  }
  function renderViolations(items) {
    if (!judgmentsList) return;
    if (!items || items.length === 0) {
      judgmentsList.innerHTML = '<div class="task-empty">\u6682\u65E0\u8FDD\u89C4\u8BB0\u5F55 (AI \u56DE\u590D\u672A\u8FDD\u53CD\u6CE8\u5165\u539F\u5219).</div>';
      return;
    }
    judgmentsList.innerHTML = items.map((v) => {
      const ts = escapeHtml((v.ts || "").substring(0, 19).replace("T", " "));
      const userPrev = escapeHtml(v.userInputPreview || "");
      const aiPrev = escapeHtml(v.aiReplyPreview || "");
      const principles = (v.result?.violatedPrinciples || []).map(
        (p) => `<div style="margin-top:3px;padding:4px 8px;background:#fef2f2;border-radius:3px;">
        <span style="color:#dc2626;">\u26A0</span> <strong>${escapeHtml(p.principle || "")}</strong>
        <span style="color:#991b1b;">\u2014 ${escapeHtml(p.reason || "")}</span>
      </div>`
      ).join("");
      return `
      <div class="task-item" style="border-left:3px solid #dc2626;padding:8px 12px;background:#fffbfb;">
        <div style="font-size:11px;color:#6b7280;margin-bottom:4px;">${ts} \xB7 confidence=${escapeHtml(String(v.result?.confidence ?? 0))}</div>
        <div style="font-size:12px;color:#1f2937;"><strong>\u7528\u6237:</strong> ${userPrev}</div>
        <div style="font-size:12px;color:#1f2937;margin-top:2px;"><strong>AI:</strong> ${aiPrev}</div>
        <div style="margin-top:6px;">${principles}</div>
      </div>
    `;
    }).join("");
  }
  function renderAdaptiveSuggestions(data) {
    if (!judgmentsList) return;
    const { judgmentsTotal, usageEntriesScanned, suggestions, scannedAt } = data;
    const ts = escapeHtml((scannedAt || "").substring(0, 19).replace("T", " "));
    if (!suggestions || suggestions.length === 0) {
      judgmentsList.innerHTML = `
      <div class="task-empty">\u{1F4CA} \u81EA\u9002\u5E94\u626B\u63CF: \u65E0\u5EFA\u8BAE
        <div style="margin-top:8px;font-size:11px;color:#6b7280;">\u626B\u4E86 ${judgmentsTotal} \u6761\u539F\u5219, ${usageEntriesScanned} \u6761\u4F7F\u7528\u8BB0\u5F55, \u90FD\u633A\u5065\u5EB7.</div>
        <div style="margin-top:4px;font-size:11px;color:#6b7280;">\u626B\u63CF\u4E8E ${ts}</div>
      </div>`;
      return;
    }
    const KIND_STYLE = {
      rising: { color: "#059669", bg: "#ecfdf5", label: "\u2191 rising", action: "boost" },
      stale: { color: "#92400e", bg: "#fef3c7", label: "\u23F0 stale", action: "deprecate" },
      unused: { color: "#6b7280", bg: "#f3f4f6", label: "\u{1F440} unused", action: "review" }
    };
    const header = `
    <div style="padding:8px 12px;background:#f9fafb;border-radius:4px;margin-bottom:8px;font-size:11px;color:#374151;">
      \u{1F4CA} \u626B\u63CF\u4E8E ${ts} \xB7 ${judgmentsTotal} \u6761\u539F\u5219 \xB7 ${usageEntriesScanned} \u6761\u4F7F\u7528\u8BB0\u5F55 \xB7 <strong>${suggestions.length}</strong> \u6761\u5EFA\u8BAE
      <button class="rescan-btn" style="margin-left:8px;background:none;border:1px solid #6b7280;color:#374151;padding:1px 8px;border-radius:3px;cursor:pointer;font-size:11px;">\u{1F504} \u91CD\u65B0\u626B\u63CF</button>
    </div>
  `;
    const rows = suggestions.map((s) => {
      const style = KIND_STYLE[s.kind] || KIND_STYLE.unused;
      const m = s.metrics || {};
      return `
      <div class="task-item" data-suggestion-key="${escapeHtml(s.key)}"
           style="border-left:3px solid ${style.color};padding:8px 12px;background:${style.bg};margin-bottom:6px;">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
          <span style="color:${style.color};font-weight:600;font-size:12px;">${style.label}</span>
          <span style="font-size:11px;color:#6b7280;">${s.action === "boost" ? "\u5EFA\u8BAE\u52A0\u6743" : s.action === "deprecate" ? "\u5EFA\u8BAE\u5E9F\u5F03" : "\u5EFA\u8BAE\u5BA1\u89C6"}</span>
        </div>
        <div style="font-size:12px;color:#1f2937;margin-bottom:4px;"><strong>${escapeHtml(s.decision)}</strong></div>
        <div style="font-size:11px;color:#6b7280;margin-bottom:6px;">${escapeHtml(s.reason)}</div>
        <div style="font-size:11px;color:#9ca3af;margin-bottom:6px;">
          7\u5929 ${m.usage7d || 0} \xB7 30\u5929 ${m.usage30d || 0} \xB7 \u5171 ${m.totalUsage || 0} \xB7 \u4E0A\u6B21\u7528 ${m.daysSinceLastUse || 0} \u5929\u524D
        </div>
        <div style="display:flex;gap:6px;">
          <button class="adaptive-accept" data-key="${escapeHtml(s.key)}" data-id="${escapeHtml(s.judgmentId)}" data-action-kind="${escapeHtml(s.action)}"
                  style="background:#059669;color:#fff;border:none;padding:2px 10px;border-radius:3px;cursor:pointer;font-size:11px;">\u2713 \u63A5\u53D7</button>
          <button class="adaptive-reject" data-key="${escapeHtml(s.key)}" data-id="${escapeHtml(s.judgmentId)}" data-action-kind="${escapeHtml(s.action)}"
                  style="background:none;border:1px solid #d1d5db;color:#6b7280;padding:2px 10px;border-radius:3px;cursor:pointer;font-size:11px;">\u2717 \u62D2\u7EDD</button>
        </div>
      </div>
    `;
    }).join("");
    judgmentsList.innerHTML = header + rows;
    const rescanBtn = judgmentsList.querySelector(".rescan-btn");
    if (rescanBtn) {
      rescanBtn.onclick = async () => {
        rescanBtn.disabled = true;
        rescanBtn.textContent = "\u{1F504} \u626B\u63CF\u4E2D...";
        try {
          const r = await fetch("/api/judgments/adaptive-suggestions?force=1");
          if (r.ok) renderAdaptiveSuggestions(await r.json());
        } catch (err) {
          console.error("[adaptive] rescan failed:", err);
        } finally {
          rescanBtn.disabled = false;
          rescanBtn.textContent = "\u{1F504} \u91CD\u65B0\u626B\u63CF";
        }
      };
    }
    judgmentsList.querySelectorAll(".adaptive-accept").forEach((btn) => {
      btn.onclick = () => applyAdaptiveSuggestion(btn.dataset.key, btn.dataset.id, btn.dataset.actionKind, "accept");
    });
    judgmentsList.querySelectorAll(".adaptive-reject").forEach((btn) => {
      btn.onclick = () => applyAdaptiveSuggestion(btn.dataset.key, btn.dataset.id, btn.dataset.actionKind, "reject");
    });
  }
  async function applyAdaptiveSuggestion(key, judgmentId, actionKind, decision) {
    const row = judgmentsList?.querySelector(`[data-suggestion-key="${key}"]`);
    if (row) row.style.opacity = "0.5";
    try {
      const res = await fetch("/api/judgments/adaptive-apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: decision,
          suggestion: {
            key,
            judgmentId,
            kind: actionKind,
            action: actionKind,
            decision: "",
            reason: "",
            metrics: {},
            scannedAt: (/* @__PURE__ */ new Date()).toISOString()
          }
        })
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      if (row) row.style.display = "none";
    } catch (err) {
      if (row) row.style.opacity = "";
      console.error("[adaptive] apply failed:", err);
      alert("\u64CD\u4F5C\u5931\u8D25: " + (err && err.message || "unknown"));
    }
  }
  function renderCausalAnalysis(items) {
    if (!judgmentsList) return;
    if (!items || items.length === 0) {
      judgmentsList.innerHTML = `
      <div class="task-empty">\u{1F50D} \u56E0\u679C\u5206\u6790: \u65E0\u9AD8\u5173\u8054\u5BF9
        <div style="margin-top:8px;font-size:11px;color:#6b7280;">usage \u6570\u636E\u4E0D\u8DB3 (\u81F3\u5C11 3 \u6761\u540C\u73B0), \u6216 LLM \u4E0D\u53EF\u7528. \u591A\u7528 bolloon \u4E00\u6BB5\u65F6\u95F4\u540E\u91CD\u8BD5.</div>
      </div>`;
      return;
    }
    const rows = items.map((p, idx) => `
    <div class="task-item" data-causal-idx="${idx}" data-judgment-a="${escapeHtml(p.judgmentA)}" data-judgment-b="${escapeHtml(p.judgmentB)}"
         style="border-left:3px solid #7c3aed;padding:8px 12px;background:#faf5ff;margin-bottom:6px;">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
        <span style="color:#7c3aed;font-weight:600;font-size:12px;">${escapeHtml(p.causalDirection)}</span>
        <span style="font-size:11px;color:#6b7280;">MI=${p.mutualInfo} \xB7 co=${p.coOccurrence}</span>
      </div>
      <div style="font-size:11px;color:#374151;margin-bottom:4px;">${escapeHtml(p.explanation || "(\u65E0 LLM \u89E3\u91CA)")}</div>
      <div style="font-size:10px;color:#9ca3af;">A: ${escapeHtml(p.judgmentA)} \u2194 B: ${escapeHtml(p.judgmentB)}</div>
      <div style="margin-top:6px;display:flex;gap:6px;">
        <button class="causal-intervention-a" data-jid="${escapeHtml(p.judgmentA)}"
                style="background:#7c3aed;color:#fff;border:none;padding:2px 10px;border-radius:3px;cursor:pointer;font-size:11px;">\u{1F52C} do(A)</button>
        <button class="causal-intervention-b" data-jid="${escapeHtml(p.judgmentB)}"
                style="background:#7c3aed;color:#fff;border:none;padding:2px 10px;border-radius:3px;cursor:pointer;font-size:11px;">\u{1F52C} do(B)</button>
      </div>
      <div class="causal-result" data-jid="" style="display:none;margin-top:6px;padding:6px;background:#f3e8ff;border-radius:3px;font-size:11px;"></div>
    </div>
  `).join("");
    judgmentsList.innerHTML = `
    <div style="padding:8px 12px;background:#f9fafb;border-radius:4px;margin-bottom:8px;font-size:11px;color:#374151;">
      \u{1F50D} \u5173\u8054\u5206\u6790 (top ${items.length} \u4E92\u4FE1\u606F\u5BF9) \xB7 <span style="color:#7c3aed;">LLM \u63A8\u65AD\u65B9\u5411</span>
      <button class="causal-refresh" style="margin-left:8px;background:none;border:1px solid #7c3aed;color:#7c3aed;padding:1px 8px;border-radius:3px;cursor:pointer;font-size:11px;">\u{1F504} \u91CD\u65B0\u8DD1</button>
    </div>
    ${rows}
  `;
    const refresh = judgmentsList.querySelector(".causal-refresh");
    if (refresh) {
      refresh.onclick = async () => {
        refresh.disabled = true;
        refresh.textContent = "\u{1F504} \u8DD1\u4E2D...";
        try {
          const r = await fetch("/api/judgments/causal/correlation?topN=10");
          if (r.ok) renderCausalAnalysis((await r.json()).items || []);
        } finally {
          refresh.disabled = false;
          refresh.textContent = "\u{1F504} \u91CD\u65B0\u8DD1";
        }
      };
    }
    judgmentsList.querySelectorAll(".causal-intervention-a, .causal-intervention-b").forEach((btn) => {
      btn.onclick = async () => {
        const jid = btn.getAttribute("data-jid");
        const resultDiv = btn.closest(".task-item")?.querySelector(".causal-result");
        if (!resultDiv) return;
        resultDiv.style.display = "block";
        resultDiv.textContent = "\u{1F52C} \u8DD1 do-calculus (LLM \u6A21\u62DF\u53CD\u4E8B\u5B9E)...";
        btn.disabled = true;
        try {
          const r = await fetch(`/api/judgments/causal/intervention?judgmentId=${encodeURIComponent(jid)}`);
          if (!r.ok) throw new Error("HTTP " + r.status);
          const data = await r.json();
          const effect = data.causalEffect;
          const sign = effect > 0 ? "+" : "";
          const color = Math.abs(effect) > 0.5 ? "#dc2626" : Math.abs(effect) > 0.2 ? "#d97706" : "#059669";
          resultDiv.innerHTML = `
          <div style="color:${color};font-weight:600;">do-calculus: causalEffect = ${sign}${effect} (${data.marginalContribution})</div>
          <div style="color:#374151;margin-top:4px;">${escapeHtml(data.reasoning)}</div>
          <div style="color:#9ca3af;margin-top:4px;">confidence=${data.confidence}</div>
        `;
        } catch (err) {
          resultDiv.innerHTML = `<div style="color:#dc2626;">\u5931\u8D25: ${escapeHtml(err.message)}</div>`;
        } finally {
          btn.disabled = false;
        }
      };
    });
  }
  async function toggleChannelJudgment(judgmentId, action) {
    if (!currentChannelId) {
      showJudgmentError("\u8BF7\u5148\u9009\u4E2D\u4E00\u4E2A channel");
      return;
    }
    const ch = channels.find((c) => c.id === currentChannelId);
    if (!ch) return;
    const set = new Set(Array.isArray(ch.bound_judgment_ids) ? ch.bound_judgment_ids : []);
    if (action === "bind") set.add(judgmentId);
    else set.delete(judgmentId);
    const next = Array.from(set);
    try {
      const res = await fetch(`/channels/${currentChannelId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bound_judgment_ids: next })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const updated = await res.json();
      const idx = channels.findIndex((c) => c.id === currentChannelId);
      if (idx >= 0) channels[idx] = updated;
      if (judgmentsModal && judgmentsModal.classList.contains("active")) {
        renderJudgments(lastJudgmentsCache);
      }
    } catch (err) {
      showJudgmentError("\u7ED1\u5B9A\u5931\u8D25: " + err.message);
    }
  }
  if (judgmentsList) {
    judgmentsList.addEventListener("click", async (e) => {
      const editBtn = e.target.closest && e.target.closest(".judgment-edit-btn");
      const delBtn = e.target.closest && e.target.closest(".judgment-del-btn");
      const toggleBtn = e.target.closest && e.target.closest(".judgment-toggle-btn");
      if (editBtn) {
        const id = editBtn.getAttribute("data-id");
        await editJudgment(id);
      } else if (delBtn) {
        const id = delBtn.getAttribute("data-id");
        if (!confirm("\u786E\u5B9A\u5220\u9664\u8FD9\u6761\u5224\u65AD?")) return;
        try {
          const res = await fetch("/api/judgments/" + encodeURIComponent(id), { method: "DELETE" });
          const out = await res.json();
          if (!out.ok) throw new Error(out.error || "delete failed");
          await loadJudgments();
        } catch (err) {
          showJudgmentError("\u5220\u9664\u5931\u8D25: " + err.message);
        }
      } else if (toggleBtn) {
        const id = toggleBtn.getAttribute("data-id");
        const action = toggleBtn.getAttribute("data-action");
        await toggleChannelJudgment(id, action);
      }
    });
    document.querySelectorAll(".judgment-tab").forEach((btn) => {
      btn.addEventListener("click", () => switchJudgmentTab(btn.dataset.tab));
    });
    document.querySelectorAll(".judgment-status-tab").forEach((btn) => {
      btn.addEventListener("click", () => switchStatusFilter(btn.dataset.status));
    });
    judgmentsList.addEventListener("dragstart", (e) => {
      const row = e.target.closest && e.target.closest(".judgment-row");
      if (!row) return;
      const decision = row.querySelector(".judgment-decision")?.textContent || "";
      const id = row.getAttribute("data-judgment-id") || "";
      e.dataTransfer.effectAllowed = "copy";
      e.dataTransfer.setData("text/plain", decision);
      e.dataTransfer.setData("application/x-bolloon-judgment", JSON.stringify({ id, decision }));
    });
    judgmentsList.addEventListener("change", (e) => {
      if (e.target.classList && e.target.classList.contains("judgment-select-cb")) {
        updateBulkDeleteToolbar();
      }
    });
  }
  const judgmentSelectAll = document.getElementById("judgment-select-all");
  const judgmentSelectedCount = document.getElementById("judgment-selected-count");
  const judgmentBulkDeleteBtn = document.getElementById("judgment-bulk-delete-btn");
  function getSelectedJudgmentIds() {
    if (!judgmentsList) return [];
    return Array.from(judgmentsList.querySelectorAll(".judgment-select-cb")).filter((cb) => cb.checked).map((cb) => cb.getAttribute("data-id")).filter(Boolean);
  }
  function updateBulkDeleteToolbar() {
    const ids = getSelectedJudgmentIds();
    if (judgmentSelectedCount) judgmentSelectedCount.textContent = `\u5DF2\u9009 ${ids.length}`;
    if (judgmentBulkDeleteBtn) {
      judgmentBulkDeleteBtn.disabled = ids.length === 0;
      judgmentBulkDeleteBtn.style.opacity = ids.length === 0 ? "0.5" : "1";
      judgmentBulkDeleteBtn.style.cursor = ids.length === 0 ? "not-allowed" : "pointer";
    }
    if (judgmentSelectAll && judgmentsList) {
      const all = judgmentsList.querySelectorAll(".judgment-select-cb");
      const checked = Array.from(all).filter((cb) => cb.checked);
      judgmentSelectAll.checked = all.length > 0 && checked.length === all.length;
      judgmentSelectAll.indeterminate = checked.length > 0 && checked.length < all.length;
    }
  }
  if (judgmentSelectAll) {
    judgmentSelectAll.addEventListener("change", (e) => {
      if (!judgmentsList) return;
      const checked = e.target.checked;
      judgmentsList.querySelectorAll(".judgment-select-cb").forEach((cb) => {
        cb.checked = checked;
      });
      updateBulkDeleteToolbar();
    });
  }
  if (judgmentBulkDeleteBtn) {
    judgmentBulkDeleteBtn.addEventListener("click", async () => {
      const ids = getSelectedJudgmentIds();
      if (ids.length === 0) return;
      if (!confirm(`\u786E\u5B9A\u5220\u9664\u9009\u4E2D\u7684 ${ids.length} \u6761\u5224\u65AD? \u6B64\u64CD\u4F5C\u4E0D\u53EF\u64A4\u9500.`)) return;
      judgmentBulkDeleteBtn.disabled = true;
      try {
        const res = await fetch("/api/judgments/batch-delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids })
        });
        const out = await res.json();
        if (!out.ok) throw new Error(out.error || "failed");
        showJudgmentOk(`\u2713 \u6279\u91CF\u5220\u9664 ${out.deleted} \u6761${out.notFound?.length ? ` (${out.notFound.length} \u6761\u672A\u627E\u5230)` : ""}`);
        await loadJudgments();
      } catch (err) {
        showJudgmentError("\u6279\u91CF\u5220\u9664\u5931\u8D25: " + err.message);
      } finally {
        if (judgmentBulkDeleteBtn) judgmentBulkDeleteBtn.disabled = false;
      }
    });
  }
  async function editJudgment(id) {
    const all = await (await fetch("/api/judgments")).json();
    const j = (all.judgments || []).find((x) => x.id === id);
    if (!j) {
      showJudgmentError("\u627E\u4E0D\u5230\u8BE5\u5224\u65AD (\u53EF\u80FD\u5DF2\u5220\u9664)");
      return;
    }
    const newDecision = prompt("\u4FEE\u6539\u5224\u65AD (decision):", j.decision);
    if (newDecision === null) return;
    const newReason = prompt("\u4FEE\u6539\u7406\u7531 (reason, \u7559\u7A7A\u4E0D\u6539):", j.reasons && j.reasons[0] || "");
    const newStakes = prompt("\u4FEE\u6539\u98CE\u9669 (low/medium/high/critical):", j.context && j.context.stakes || "medium");
    const patch = {
      decision: newDecision.trim() || j.decision,
      reasons: newReason !== null ? [newReason.trim()].filter(Boolean) : j.reasons,
      context: newStakes ? { ...j.context || {}, stakes: newStakes } : j.context
    };
    try {
      const res = await fetch("/api/judgments/" + encodeURIComponent(id), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch)
      });
      const out = await res.json();
      if (!out.ok) throw new Error(out.error || "update failed");
      showJudgmentOk("\u2713 \u5DF2\u66F4\u65B0");
      await loadJudgments();
    } catch (err) {
      showJudgmentError("\u66F4\u65B0\u5931\u8D25: " + err.message);
    }
  }
  async function submitJudgment() {
    if (!judgmentSubmitBtn) return;
    const decision = (judgmentDecision?.value || "").trim();
    const reason = (judgmentReason?.value || "").trim();
    if (!decision) {
      if (judgmentError) {
        judgmentError.textContent = "\u5224\u65AD\u4E0D\u80FD\u4E3A\u7A7A";
        judgmentError.style.display = "";
      }
      return;
    }
    judgmentSubmitBtn.disabled = true;
    if (judgmentError) judgmentError.style.display = "none";
    try {
      const res = await fetch("/api/judgments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision,
          reason: reason || void 0,
          context: { domain: judgmentDomain?.value, stakes: judgmentStakes?.value }
        })
      });
      const out = await res.json();
      if (!out.ok) throw new Error(out.error || "unknown");
      if (judgmentDecision) judgmentDecision.value = "";
      if (judgmentReason) judgmentReason.value = "";
      await loadJudgments();
      try {
        const del = await fetch("/api/judgments/auto-delegate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            judgmentId: out.judgment.id,
            capability: judgmentDomain?.value || "general",
            instruction: `\u6267\u884C\u5224\u65AD: ${out.judgment.decision}` + (reason ? ` (\u7406\u7531: ${reason})` : "")
          })
        });
        const delOut = await del.json();
        if (delOut.matched && delOut.sent) {
          showJudgmentOk(`\u2713 \u5DF2\u8BB0\u5F55\u5E76\u81EA\u52A8\u59D4\u6D3E\u7ED9 ${delOut.targetAgent.name}`);
        } else if (delOut.matched) {
          showJudgmentOk(`\u2713 \u5DF2\u8BB0\u5F55 (\u5339\u914D\u5230 ${delOut.targetAgent.name}, \u4F46 ${delOut.reason || "\u672A\u53D1\u9001"})`);
        } else {
          showJudgmentOk("\u2713 \u5DF2\u8BB0\u5F55 (\u672C\u5730, \u65E0\u5339\u914D\u8FDC\u7AEF agent)");
        }
      } catch (e) {
        console.warn("[judgments] auto-delegate fire failed:", e);
      }
    } catch (e) {
      if (judgmentError) {
        judgmentError.textContent = "\u8BB0\u5F55\u5931\u8D25: " + e.message;
        judgmentError.style.display = "";
      }
    } finally {
      judgmentSubmitBtn.disabled = false;
    }
  }
  if (judgmentsBtn) judgmentsBtn.addEventListener("click", showJudgmentsModal);
  if (judgmentsModalClose) judgmentsModalClose.addEventListener("click", hideJudgmentsModal);
  if (judgmentsModal) {
    judgmentsModal.addEventListener("click", (e) => {
      if (e.target === judgmentsModal) hideJudgmentsModal();
    });
  }
  const judgmentImportBtn = document.getElementById("judgment-import-btn");
  const judgmentImportFile = document.getElementById("judgment-import-file");
  function showJudgmentError(msg) {
    if (!judgmentError) return;
    judgmentError.textContent = msg;
    judgmentError.style.display = "";
    judgmentError.style.color = "#b91c1c";
  }
  function showJudgmentOk(msg) {
    if (!judgmentError) return;
    judgmentError.textContent = msg;
    judgmentError.style.display = "";
    judgmentError.style.color = "#15803d";
  }
  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => {
        const s = String(r.result || "");
        const idx = s.indexOf(",");
        resolve(idx >= 0 ? s.substring(idx + 1) : s);
      };
      r.onerror = () => reject(r.error || new Error("read failed"));
      r.readAsDataURL(file);
    });
  }
  async function importJudgmentFile(file) {
    if (!file) return;
    if (judgmentImportBtn) judgmentImportBtn.disabled = true;
    try {
      const content = await fileToBase64(file);
      const res = await fetch("/api/judgments/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name, content })
      });
      const out = await res.json();
      if (!out.ok) throw new Error(out.error || "import failed");
      showJudgmentOk(`\u2713 \u5BFC\u5165 ${out.imported} \u6761${out.failed ? `, ${out.failed} \u6761\u5931\u8D25` : ""}`);
      await loadJudgments();
    } catch (e) {
      showJudgmentError("\u5BFC\u5165\u5931\u8D25: " + e.message);
    } finally {
      if (judgmentImportBtn) judgmentImportBtn.disabled = false;
      if (judgmentImportFile) judgmentImportFile.value = "";
    }
  }
  if (judgmentImportBtn) {
    judgmentImportBtn.addEventListener("click", () => {
      if (judgmentImportFile) judgmentImportFile.click();
    });
  }
  if (judgmentImportFile) {
    judgmentImportFile.addEventListener("change", (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) importJudgmentFile(f);
    });
  }
  document.addEventListener("click", async (e) => {
    const btn = e.target.closest && e.target.closest(".save-as-judgment");
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const channelId = btn.getAttribute("data-channel-id");
    const decision = (btn.getAttribute("data-decision") || "").trim();
    if (channelId) {
      btn.classList.add("loading");
      btn.disabled = true;
      try {
        const res = await fetch("/api/judgments/distill-from-conversation", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ channelId })
        });
        const out = await res.json();
        if (!res.ok) throw new Error(out.error || "HTTP " + res.status);
        if (!out.triggered) {
          btn.classList.remove("loading");
          btn.disabled = false;
          btn.title = "\u84B8\u998F\u5931\u8D25: " + (out.reason || "\u65E0\u5185\u5BB9");
          return;
        }
        const j = out.judgment;
        const ev = out.evolved || { merged: 0, superseded: 0 };
        btn.classList.remove("loading");
        btn.classList.add("saved");
        btn.title = "\u5DF2\u84B8\u998F\u4E3A\u5224\u65AD";
        showDistillConfirm(btn, {
          value: j.decision,
          evidence: j.reasons && j.reasons[0] || "",
          merged: ev.merged,
          superseded: ev.superseded,
          onEdit: async (newText) => {
            try {
              await fetch("/api/judgments/" + encodeURIComponent(j.id), {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ decision: newText })
              });
            } catch (err) {
              console.error("[judgments] edit failed:", err);
            }
          },
          onReject: async () => {
            try {
              await fetch("/api/judgments/" + encodeURIComponent(j.id), {
                method: "DELETE"
              });
            } catch (err) {
              console.error("[judgments] reject failed:", err);
            }
          }
        });
        setTimeout(() => loadJudgments(), 100);
      } catch (err) {
        console.error("[judgments] distill-from-chat failed:", err);
        btn.classList.remove("loading");
        btn.disabled = false;
        btn.title = "\u84B8\u998F\u5931\u8D25: " + err.message;
      }
      return;
    }
    if (!decision) return;
    try {
      const res = await fetch("/api/judgments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, reason: "\u4ECE\u5BF9\u8BDD\u4FDD\u5B58" })
      });
      const out = await res.json();
      if (!out.ok) throw new Error(out.error || "failed");
      btn.classList.add("saved");
      btn.title = "\u5DF2\u5B58\u4E3A\u5224\u65AD";
    } catch (err) {
      console.error("[judgments] save-from-chat failed:", err);
      btn.title = "\u4FDD\u5B58\u5931\u8D25: " + err.message;
    }
  });
  function showDistillConfirm(btn, opts) {
    const { value, evidence, merged, superseded, onEdit, onReject } = opts;
    const old = document.getElementById("distill-confirm-popup");
    if (old) old.remove();
    const popup = document.createElement("div");
    popup.id = "distill-confirm-popup";
    popup.style.cssText = `
    position:absolute; z-index:1000;
    background:#fff; border:1px solid #d1d5db; border-radius:6px;
    box-shadow:0 4px 12px rgba(0,0,0,0.1);
    padding:10px 12px; min-width:280px; max-width:380px;
    font-size:13px; color:#1f2937;
  `;
    let evolveNote = "";
    if (merged > 0 || superseded > 0) {
      evolveNote = `<div style="font-size:11px;color:#059669;margin-top:6px;">\u2713 \u6F14\u5316\u5BF9\u9F50: ${merged} \u6761\u5DF2\u5408\u5E76${superseded > 0 ? `, ${superseded} \u6761\u5DF2\u6DD8\u6C70` : ""}</div>`;
    }
    popup.innerHTML = `
    <div style="font-weight:600;margin-bottom:4px;">\u5DF2\u84B8\u998F\u4E3A\u5224\u65AD\u529B</div>
    <div style="background:#f9fafb;padding:6px 8px;border-radius:4px;line-height:1.4;">${escapeHtml(value)}</div>
    ${evidence ? `<div style="font-size:11px;color:#6b7280;margin-top:4px;">\u8BC1\u636E: ${escapeHtml(evidence)}</div>` : ""}
    ${evolveNote}
    <div style="display:flex;gap:6px;margin-top:8px;">
      <button class="dc-edit" style="background:none;border:1px solid #d1d5db;color:#374151;padding:2px 10px;border-radius:3px;cursor:pointer;font-size:11px;">\u7F16\u8F91</button>
      <button class="dc-reject" style="background:none;border:1px solid #fca5a5;color:#b91c1c;padding:2px 10px;border-radius:3px;cursor:pointer;font-size:11px;">\u62D2\u7EDD</button>
      <button class="dc-close" style="margin-left:auto;background:none;border:none;color:#6b7280;cursor:pointer;font-size:14px;">\xD7</button>
    </div>
  `;
    const rect = btn.getBoundingClientRect();
    popup.style.top = window.scrollY + rect.bottom + 4 + "px";
    popup.style.left = window.scrollX + rect.left + "px";
    document.body.appendChild(popup);
    popup.querySelector(".dc-edit").onclick = () => {
      const newText = prompt("\u7F16\u8F91\u5224\u65AD\u529B:", value);
      if (newText && newText.trim() && onEdit) onEdit(newText.trim());
      popup.remove();
    };
    popup.querySelector(".dc-reject").onclick = () => {
      if (onReject) onReject();
      popup.remove();
    };
    popup.querySelector(".dc-close").onclick = () => popup.remove();
    setTimeout(() => popup.remove(), 5e3);
  }
  if (judgmentSubmitBtn) judgmentSubmitBtn.addEventListener("click", submitJudgment);
  loadJudgments();
  setInterval(loadJudgments, 1e4);
  let knownPeers = [];
  async function loadRemoteChannels() {
    try {
      const res = await fetch("/api/p2p-peers");
      if (res.ok) {
        const data = await res.json();
        knownPeers = Array.isArray(data.peers) ? data.peers : [];
      }
      const r2 = await fetch("/api/remote-channels");
      if (r2.ok) {
        const data2 = await r2.json();
        const peers = Array.isArray(data2.peers) ? data2.peers : [];
        for (const p of peers) {
          let group = remoteChannels.find((g) => g.peerId === p.peerId);
          if (!group) {
            group = { peerId: p.peerId, channels: [], peerName: "peer-" + p.peerId.substring(0, 8) };
            remoteChannels.push(group);
          }
          group.channels = p.channels || [];
        }
      }
      renderRemoteChannels();
      if (typeof refreshMentionChannels === "function") {
        refreshMentionChannels();
      }
    } catch (err) {
      console.error("[v3] loadRemoteChannels \u5931\u8D25:", err);
    }
  }
  function renderRemoteChannels() {
    const list = document.getElementById("remote-channel-list");
    if (!list) return;
    const channelsByPeer = {};
    for (const p of remoteChannels) {
      channelsByPeer[p.peerId] = p.channels || [];
    }
    const knownPks = new Set(knownPeers.map((p) => p.publicKey));
    const strangerPeers = remoteChannels.filter((p) => !knownPks.has(p.peerId)).map((p) => ({
      publicKey: p.peerId,
      name: p.peerName || "\u672A\u6388\u6743 " + p.peerId.substring(0, 8),
      lastConnectedAt: null,
      _isStranger: true
    }));
    const allPeers = [...knownPeers, ...strangerPeers];
    if (allPeers.length === 0) {
      list.innerHTML = '<li style="color:var(--text-muted);font-size:11px;padding:8px 4px;text-align:center;">(\u6682\u65E0\u597D\u53CB, \u70B9 + \u6DFB\u52A0)</li>';
      return;
    }
    const html = allPeers.map((peer) => {
      const peerChannels = channelsByPeer[peer.publicKey] || [];
      const lastConn = peer.lastConnectedAt ? new Date(peer.lastConnectedAt).toLocaleDateString() : peer._isStranger ? "\u964C\u751F peer" : "\u4ECE\u672A\u8FDE\u63A5";
      const strangerStyle = peer._isStranger ? "border:1px dashed var(--border-light);" : "";
      const strangerIcon = peer._isStranger ? "\u2754" : "\u{1F464}";
      if (!seenPeers.has(peer.publicKey)) {
        seenPeers.add(peer.publicKey);
        collapsedPeers.add(peer.publicKey);
        saveSeenPeers();
        saveCollapsedPeers();
      }
      const isCollapsed = collapsedPeers.has(peer.publicKey);
      const caretChar = "\u25BE";
      return `
      <li class="remote-peer-group ${isCollapsed ? "collapsed" : ""}" style="margin-bottom:10px;${strangerStyle}">
        <div class="remote-peer-header" data-peer-name="${escapeHtml(peer.name)}" data-peer-pk="${escapeHtml(peer.publicKey)}"
             style="display:flex;align-items:center;gap:6px;padding:6px 8px;background:var(--bg-hover);border-radius:4px;cursor:pointer;">
          <button class="peer-caret-btn" data-toggle-peer="${escapeHtml(peer.publicKey)}" title="\u6298\u53E0/\u5C55\u5F00"
                  style="background:var(--bg-active);border:1px solid var(--border);color:var(--text);cursor:pointer;width:22px;height:22px;border-radius:4px;font-size:12px;line-height:1;padding:0;display:flex;align-items:center;justify-content:center;flex:0 0 auto;">${caretChar}</button>
          <span style="font-size:13px;">${strangerIcon}</span>
          <span style="flex:1;font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(peer.publicKey)}">${escapeHtml(peer.name)}</span>
          <span style="font-size:9px;color:var(--text-muted);">${peerChannels.length > 0 ? `${peerChannels.length} ch \xB7 ` : ""}${lastConn}</span>
          <button class="peer-share-btn" title="\u5206\u4EAB channel \u7ED9 ${escapeHtml(peer.name)}"
                  style="background:transparent;border:1px solid var(--border);color:var(--text);cursor:pointer;width:22px;height:22px;border-radius:4px;font-size:12px;line-height:1;padding:0;display:flex;align-items:center;justify-content:center;flex:0 0 auto;">\u{1F4E4}</button>
        </div>
        <div class="remote-peer-channels" style="margin-top:4px;margin-left:8px;">
          ${peerChannels.length === 0 ? '<div style="font-size:10px;color:var(--text-muted);padding:2px 4px;">(\u5BF9\u65B9\u8FD8\u6CA1\u5206\u4EAB channel \u7ED9\u4F60)</div>' : peerChannels.map((c) => `
              <div class="remote-channel-row" data-peer-id="${escapeHtml(peer.publicKey)}" data-channel-id="${escapeHtml(c.id)}"
                   style="display:flex;align-items:center;gap:6px;padding:4px 6px;cursor:pointer;border-radius:4px;font-size:12px;">
                <span>\u{1F916}</span>
                <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(c.name || "")}">${escapeHtml(c.name || "(\u672A\u547D\u540D)")}</span>
              </div>
            `).join("")}
        </div>
      </li>
    `;
    }).join("");
    list.innerHTML = html;
    list.querySelectorAll(".peer-caret-btn[data-toggle-peer]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const pk = btn.getAttribute("data-toggle-peer");
        togglePeerCollapsed(pk);
      });
    });
    list.querySelectorAll(".remote-channel-row").forEach((row) => {
      row.addEventListener("click", () => {
        const peerId = row.dataset.peerId;
        const channelId = row.dataset.channelId;
        const channelName = row.querySelector("span[title]")?.getAttribute("title") || channelId;
        console.log("[v3] \u70B9\u51FB\u8FDC\u7AEF channel:", peerId.substring(0, 12), channelId);
        openRemoteChannelChat(peerId, channelId, channelName);
      });
    });
    list.querySelectorAll(".remote-peer-header").forEach((row) => {
      const shareBtn = row.querySelector(".peer-share-btn");
      if (shareBtn) {
        shareBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          const peerName = row.dataset.peerName;
          const peerPk = row.dataset.peerPk;
          openShareToPeerModal(peerName, peerPk);
        });
      }
    });
    list.querySelectorAll(".remote-peer-header").forEach((row) => {
      row.addEventListener("dblclick", (e) => {
        if (e.target.closest(".peer-caret-btn")) return;
        const peerName = row.dataset.peerName;
        const peerPk = row.dataset.peerPk;
        openEditPeerModal(peerName, peerPk);
      });
    });
    if (typeof window.__syncP2PToggleAllBtn === "function") window.__syncP2PToggleAllBtn();
  }
  async function openEditPeerModal(peerName, peerPublicKey) {
    document.getElementById("edit-peer-modal")?.remove();
    let currentNotes = "";
    let currentName = peerName;
    try {
      const r = await fetch("/api/p2p-peers");
      if (r.ok) {
        const d = await r.json();
        const entry = (d.peers || []).find((p) => p.publicKey === peerPublicKey);
        if (entry) {
          currentName = entry.name || peerName;
          currentNotes = entry.notes || "";
        }
      }
    } catch {
    }
    const html = `
    <div id="edit-peer-modal" class="friend-req-overlay">
      <div class="friend-req-shell" style="width:520px;">
        <div class="friend-req-header">
          <span style="font-size:18px;">\u270F\uFE0F</span>
          <div style="flex:1;min-width:0;">
            <div class="friend-req-title">\u7F16\u8F91\u597D\u53CB</div>
            <div class="friend-req-meta">publicKey: ${escapeHtml(peerPublicKey.substring(0, 16))}\u2026</div>
          </div>
        </div>
        <div class="friend-req-body">
          <label style="display:block;margin-bottom:6px;font-size:12px;color:var(--text-secondary);">\u663E\u793A\u540D\u5B57</label>
          <input id="epm-name" type="text" value="${escapeHtml(currentName)}"
                 style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:4px;background:var(--bg-main);color:var(--text);font-family:inherit;font-size:13px;box-sizing:border-box;margin-bottom:12px;">
          <label style="display:block;margin-bottom:6px;font-size:12px;color:var(--text-secondary);">\u5907\u6CE8 (\u81EA\u7531\u6587\u672C, \u4F8B\u5982\u5408\u4F5C\u9886\u57DF / \u600E\u4E48\u8BA4\u8BC6\u7684)</label>
          <textarea id="epm-notes" rows="4" placeholder="\u4F8B\u5982: 2026-06 \u5408\u4F5C LLM \u4EE3\u53D1\u9A8C\u8BC1"
                    style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:4px;background:var(--bg-main);color:var(--text);font-family:inherit;font-size:13px;box-sizing:border-box;resize:vertical;">${escapeHtml(currentNotes)}</textarea>
        </div>
        <div class="friend-req-actions">
          <button id="epm-cancel" class="friend-req-btn-deny">\u53D6\u6D88</button>
          <button id="epm-save" class="friend-req-btn-accept">\u4FDD\u5B58</button>
        </div>
      </div>
    </div>
  `;
    document.body.insertAdjacentHTML("beforeend", html);
    const close = () => document.getElementById("edit-peer-modal")?.remove();
    document.getElementById("epm-cancel").onclick = close;
    document.getElementById("epm-save").onclick = async () => {
      const newName = document.getElementById("epm-name").value.trim() || currentName;
      const newNotes = document.getElementById("epm-notes").value;
      try {
        const r = await fetch(`/api/p2p-peers/${encodeURIComponent(peerName)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: newName, notes: newNotes })
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || "save failed");
        console.log("[v3] \u6539 peer \u6210\u529F:", newName, "\u5907\u6CE8:", newNotes);
        showSimpleToast(`\u2705 \u5DF2\u4FDD\u5B58 ${newName}`);
        close();
        const r2 = await fetch("/api/p2p-peers");
        if (r2.ok) {
          const d2 = await r2.json();
          knownPeers = Array.isArray(d2.peers) ? d2.peers : [];
        }
        renderRemoteChannels();
      } catch (err) {
        console.error("[v3] \u4FDD\u5B58 peer \u5931\u8D25:", err);
        alert("\u4FDD\u5B58\u5931\u8D25: " + (err.message || err));
      }
    };
  }
  async function openShareToPeerModal(peerName, peerPublicKey) {
    document.getElementById("share-to-peer-modal")?.remove();
    let allChannels = [];
    try {
      const res = await fetch("/channels");
      if (res.ok) allChannels = await res.json();
    } catch (err) {
      console.error("openShareToPeerModal:", err);
    }
    const rows = allChannels.length === 0 ? '<div class="share-modal-empty">\u8FD8\u6CA1\u6709 channel</div>' : allChannels.map((ch) => {
      const isShared = Array.isArray(ch.shared_with_peers) && ch.shared_with_peers.includes(peerPublicKey);
      return `
          <label class="share-modal-row">
            <input type="checkbox" data-cid="${escapeHtml(ch.id)}" ${isShared ? "checked" : ""} class="share-modal-cb">
            <div class="share-modal-row-info">
              <div class="share-modal-row-name">${escapeHtml(ch.name || "(\u672A\u547D\u540D)")}</div>
              <div class="share-modal-row-meta">
                ${isShared ? "\u2713 \u5DF2\u5206\u4EAB" : "\u672A\u5206\u4EAB"} \xB7 ${escapeHtml(ch.id.slice(0, 24))}\u2026
              </div>
            </div>
          </label>
        `;
    }).join("");
    const html = `
    <div id="share-to-peer-modal" class="friend-req-overlay">
      <div class="friend-req-shell share-modal-shell">
        <div class="friend-req-header">
          <span style="font-size:18px;">\u{1F4E4}</span>
          <div style="flex:1;min-width:0;">
            <div class="friend-req-title">\u5206\u4EAB channel \u7ED9 ${escapeHtml(peerName)}</div>
            <div class="friend-req-meta">${escapeHtml(peerPublicKey.substring(0, 16))}\u2026</div>
          </div>
          <button id="spm-close" class="friend-req-btn-close">\xD7</button>
        </div>
        <div class="share-modal-hint">\u52FE\u9009\u8981\u5206\u4EAB\u7684 channel, \u5BF9\u65B9\u624D\u80FD\u770B\u5230</div>
        <div id="spm-list" class="share-modal-list">${rows}</div>
        <div class="friend-req-actions">
          <button id="spm-cancel" class="friend-req-btn-deny">\u53D6\u6D88</button>
          <button id="spm-save" class="friend-req-btn-accept">\u4FDD\u5B58\u5206\u4EAB</button>
        </div>
      </div>
    </div>
  `;
    document.body.insertAdjacentHTML("beforeend", html);
    const overlay = document.getElementById("share-to-peer-modal");
    const closeModal = () => {
      overlay.remove();
      document.removeEventListener("keydown", onEsc);
    };
    const onEsc = (e) => {
      if (e.key === "Escape") closeModal();
    };
    document.addEventListener("keydown", onEsc);
    document.getElementById("spm-close").onclick = closeModal;
    document.getElementById("spm-cancel").onclick = closeModal;
    overlay.onclick = (e) => {
      if (e.target === overlay) closeModal();
    };
    document.getElementById("spm-save").onclick = async () => {
      const checkedIds = [...overlay.querySelectorAll("input[type=checkbox][data-cid]:checked")].map((el) => el.dataset.cid);
      let ok = 0, fail = 0;
      for (const ch of allChannels) {
        const shouldShare = checkedIds.includes(ch.id);
        const wasShared = Array.isArray(ch.shared_with_peers) && ch.shared_with_peers.includes(peerPublicKey);
        if (shouldShare === wasShared) continue;
        const newList = (ch.shared_with_peers || []).filter((p) => p !== peerPublicKey);
        if (shouldShare) newList.push(peerPublicKey);
        try {
          const res = await fetch(`/channels/${encodeURIComponent(ch.id)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ shared_with_peers: newList })
          });
          if (res.ok) ok++;
          else fail++;
        } catch {
          fail++;
        }
      }
      showSimpleToast(`\u5206\u4EAB\u66F4\u65B0\u5B8C\u6210: \u6210\u529F ${ok}, \u5931\u8D25 ${fail}`, ok > 0 ? "info" : fail > 0 ? "error" : "info");
      overlay.remove();
    };
  }
  function openRemoteChannelChat(peerPublicKey, channelId, channelName) {
    document.getElementById("remote-chat-modal")?.remove();
    const html = `
    <div id="remote-chat-modal" class="remote-chat-overlay">
      <div class="remote-chat-shell">
        <div class="remote-chat-header">
          <div style="flex:1;min-width:0;">
            <div class="remote-chat-title">\u{1F310} \u8DDF ${escapeHtml(channelName)} \u804A\u5929</div>
            <div class="remote-chat-meta">\u8FDC\u7AEF peer: ${escapeHtml(peerPublicKey.substring(0, 16))}\u2026 \xB7 ${escapeHtml(channelId)}</div>
          </div>
          <button id="rcm-refresh-history" title="\u91CD\u65B0\u62C9\u5386\u53F2" class="remote-chat-btn-secondary">\u21BB \u5386\u53F2</button>
          <button id="rcm-close" class="remote-chat-btn-close">\xD7</button>
        </div>
        <div id="rcm-thinking" class="remote-chat-thinking" style="display:none;">
          \u{1F4E5} \u6B63\u5728\u4ECE\u8FDC\u7AEF\u62C9\u5386\u53F2 + \u5224\u65AD\u529B\u2026
        </div>
        <div id="rcm-log" class="messages remote-chat-log"></div>
        <div class="remote-chat-input-row">
          <input id="rcm-input" type="text" placeholder="\u8F93\u5165\u6D88\u606F, \u53D1\u9001\u5230\u8FDC\u7AEF channel..." class="remote-chat-input">
          <button id="rcm-send" class="remote-chat-btn-send">\u53D1\u9001</button>
        </div>
      </div>
    </div>
  `;
    document.body.insertAdjacentHTML("beforeend", html);
    const log = document.getElementById("rcm-log");
    const inputEl = document.getElementById("rcm-input");
    const sendBtn2 = document.getElementById("rcm-send");
    const thinkingEl = document.getElementById("rcm-thinking");
    let historyRefreshTimer = null;
    document.getElementById("rcm-close").onclick = () => {
      if (historyRefreshTimer) {
        clearInterval(historyRefreshTimer);
        historyRefreshTimer = null;
      }
      document.getElementById("remote-chat-modal").remove();
    };
    document.getElementById("rcm-refresh-history").onclick = () => loadHistory(false);
    const append = (text, role) => {
      addMessage(text, role === "user" ? "user" : "ai", false, log);
      log.scrollTop = log.scrollHeight;
    };
    const appendSystem = (text, kind = "info") => {
      const el = document.createElement("div");
      el.className = `remote-chat-sysmsg remote-chat-sysmsg-${kind}`;
      el.textContent = text;
      log.appendChild(el);
      log.scrollTop = log.scrollHeight;
    };
    async function loadHistory(isSilent) {
      if (!document.getElementById("remote-chat-modal")) return;
      if (isSilent) {
        try {
          const res = await fetch(`/api/remote-channels/chat-history?targetPublicKey=${encodeURIComponent(peerPublicKey)}&channelId=${encodeURIComponent(channelId)}`);
          if (!res.ok || !document.getElementById("remote-chat-modal")) return;
          const data = await res.json();
          const newMsgs = data.messages || [];
          const oldCount = log.querySelectorAll(".message").length;
          if (newMsgs.length === oldCount) return;
          const scrollWasAtBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
          renderHistory(data);
          if (scrollWasAtBottom) {
            setTimeout(() => {
              log.scrollTop = log.scrollHeight;
            }, 50);
          }
        } catch (_) {
        }
        return;
      }
      thinkingEl.style.display = "block";
      log.innerHTML = "";
      try {
        const res = await fetch(`/api/remote-channels/chat-history?targetPublicKey=${encodeURIComponent(peerPublicKey)}&channelId=${encodeURIComponent(channelId)}`);
        const data = await res.json();
        if (!res.ok) {
          appendSystem(`\u62C9\u53D6\u5931\u8D25: ${data.error || "unknown"}`, "error");
          thinkingEl.style.display = "none";
          return;
        }
        renderHistory(data);
      } catch (err) {
        appendSystem(`\u62C9\u53D6\u5F02\u5E38: ${err.message}`, "error");
      } finally {
        thinkingEl.style.display = "none";
      }
    }
    function renderHistory(data) {
      log.innerHTML = "";
      const judgments = data.judgments || { bound: [], candidates: [] };
      if (judgments.bound && judgments.bound.length > 0) {
        const jh = document.createElement("div");
        jh.className = "remote-chat-judgments";
        let h = `<div class="remote-chat-judgments-title">\u{1F6E1}\uFE0F \u5BF9\u65B9 channel \u7ED1\u5B9A\u7684\u5224\u65AD\u529B (${judgments.bound.length} \u6761\u786C\u7EA6\u675F)</div>`;
        for (const j of judgments.bound) {
          h += `<div class="remote-chat-judgment-item">\u2022 <b>${escapeHtml((j.decision || "").slice(0, 100))}</b>${j.domain ? `<span class="remote-chat-judgment-tag"> [${escapeHtml(j.domain)}${j.stakes ? "/" + escapeHtml(j.stakes) : ""}]</span>` : ""}${j.reasons && j.reasons.length ? '<br><span class="remote-chat-judgment-reason">\u7406\u7531: ' + escapeHtml(j.reasons.join("; ").slice(0, 100)) + "</span>" : ""}</div>`;
        }
        if (judgments.candidates && judgments.candidates.length > 0) {
          h += `<div class="remote-chat-judgments-foot">+ ${judgments.candidates.length} \u6761\u5019\u9009\u5224\u65AD\u529B (LLM \u53EF\u81EA\u9009\u53C2\u8003)</div>`;
        }
        jh.innerHTML = h;
        log.appendChild(jh);
      }
      const msgs = data.messages || [];
      if (msgs.length === 0) {
        appendSystem("\u8FD8\u6CA1\u6709\u5386\u53F2\u6D88\u606F, \u5728\u4E0B\u9762\u53D1\u7B2C\u4E00\u6761\u5427", "info");
      } else {
        for (const m of msgs) {
          const type = m.type === "user" ? "user" : "ai";
          let prefix = "";
          if (m.type === "user") {
            if (m.source === "remote") {
              prefix = `\u{1F310} \u8FDC\u7AEF\u8BBF\u5BA2${m.fromPublicKey ? " (" + m.fromPublicKey.substring(0, 8) + "\u2026)" : ""}

`;
            } else {
              prefix = `\u{1F464} A (\u5185\u90E8 owner)

`;
            }
          } else {
            prefix = `\u{1F916} A \u7684 LLM

`;
          }
          addMessage(prefix + (m.content || ""), type, false, log);
        }
        setTimeout(() => {
          log.scrollTop = log.scrollHeight;
        }, 50);
      }
    }
    const doSend = async () => {
      const text = inputEl.value.trim();
      if (!text) return;
      append(text, "user");
      inputEl.value = "";
      sendBtn2.disabled = true;
      sendBtn2.textContent = "...";
      try {
        const res = await fetch("/api/remote-channels/chat-send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ targetPublicKey: peerPublicKey, channelId, text })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "send failed");
      } catch (err) {
        appendSystem("\u53D1\u9001\u5931\u8D25: " + (err.message || err), "error");
      } finally {
        sendBtn2.disabled = false;
        sendBtn2.textContent = "\u53D1\u9001";
      }
    };
    sendBtn2.onclick = doSend;
    inputEl.onkeydown = (e) => {
      if (e.key === "Enter") doSend();
    };
    setupMentionAutocomplete(inputEl);
    inputEl.focus();
    startV3GlobalSSE();
    loadHistory(false);
    historyRefreshTimer = setInterval(() => loadHistory(true), 15e3);
  }
  const showMyIdBtn = document.getElementById("show-my-p2p-id-btn");
  if (showMyIdBtn) {
    showMyIdBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      document.getElementById("my-p2p-id-modal")?.remove();
      const html = `
      <div id="my-p2p-id-modal" style="position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10003;display:flex;align-items:center;justify-content:center;">
        <div style="background:#fff;border-radius:8px;width:480px;max-width:92vw;display:flex;flex-direction:column;box-shadow:0 10px 40px rgba(0,0,0,0.2);">
          <div style="padding:14px 18px;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;justify-content:space-between;">
            <div style="font-size:15px;font-weight:600;">\u{1FAAA} \u6211\u7684 P2P \u8EAB\u4EFD</div>
            <button id="mpim-close" style="background:none;border:none;font-size:20px;color:#6b7280;cursor:pointer;">\xD7</button>
          </div>
          <div id="mpim-body" style="padding:16px 18px;">
            <div style="color:#6b7280;font-size:13px;margin-bottom:10px;">\u6B63\u5728\u83B7\u53D6 publicKey\u2026</div>
          </div>
        </div>
      </div>
    `;
      document.body.insertAdjacentHTML("beforeend", html);
      document.getElementById("mpim-close").onclick = () => document.getElementById("my-p2p-id-modal").remove();
      try {
        const res = await fetch("/api/p2p-publickey");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const pk = data.publicKey || "";
        const body = document.getElementById("mpim-body");
        if (!pk || pk.length !== 64) {
          body.innerHTML = `<div style="color:#b91c1c;font-size:13px;">\u2717 P2PDirect \u8FD8\u6CA1\u542F\u52A8, \u5237\u65B0\u9875\u9762\u7A0D\u540E\u518D\u8BD5</div>`;
          return;
        }
        body.innerHTML = `
        <div style="font-size:12px;color:#6b7280;margin-bottom:8px;">\u628A\u4E0B\u9762\u8FD9\u4E32\u53D1\u7ED9\u597D\u53CB, \u597D\u53CB\u5728 P2P \u597D\u53CB\u533A\u70B9 "+ \u597D\u53CB" \u7C98\u8D34\u5373\u53EF\u52A0\u4F60:</div>
        <div style="display:flex;gap:6px;align-items:center;margin-bottom:12px;">
          <code id="mpim-pk" style="flex:1;padding:8px 10px;background:#f3f4f6;border:1px solid #d1d5db;border-radius:4px;font-family:monospace;font-size:11px;word-break:break-all;line-height:1.4;">${escapeHtml(pk)}</code>
          <button id="mpim-copy" style="padding:8px 14px;background:#2563eb;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:13px;white-space:nowrap;">\u{1F4CB} \u590D\u5236</button>
        </div>
        <div id="mpim-status" style="font-size:12px;color:#059669;min-height:16px;"></div>
        <div style="margin-top:14px;padding-top:12px;border-top:1px solid #e5e7eb;font-size:11px;color:#6b7280;">
          \u{1F4A1} \u540C\u4E00\u4E2A role \u91CD\u542F\u540E publicKey \u4E0D\u4F1A\u53D8, \u597D\u53CB\u4E0D\u9700\u8981\u91CD\u65B0\u52A0\u4F60.
        </div>
      `;
        document.getElementById("mpim-copy").onclick = async () => {
          const statusEl = document.getElementById("mpim-status");
          try {
            await navigator.clipboard.writeText(pk);
            statusEl.textContent = "\u2713 \u5DF2\u590D\u5236\u5230\u526A\u8D34\u677F";
          } catch {
            const ta = document.createElement("textarea");
            ta.value = pk;
            ta.style.position = "fixed";
            ta.style.opacity = "0";
            document.body.appendChild(ta);
            ta.select();
            try {
              document.execCommand("copy");
              statusEl.textContent = "\u2713 \u5DF2\u590D\u5236 (fallback)";
            } catch {
              statusEl.textContent = "\u2717 \u590D\u5236\u5931\u8D25, \u8BF7\u624B\u52A8\u9009\u4E2D\u590D\u5236";
            }
            document.body.removeChild(ta);
          }
        };
      } catch (err) {
        const body = document.getElementById("mpim-body");
        if (body) body.innerHTML = `<div style="color:#b91c1c;font-size:13px;">\u2717 \u83B7\u53D6\u5931\u8D25: ${escapeHtml(err.message || String(err))}</div>`;
      }
    });
  }
  const addPeerBtn = document.getElementById("add-p2p-peer-btn");
  if (addPeerBtn) {
    addPeerBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const name = prompt("\u7ED9\u8FD9\u4E2A P2P \u597D\u53CB\u8D77\u4E2A\u540D\u5B57 (\u5982: \u540C\u4E8B-\u5F20\u78CA)");
      if (!name) return;
      const publicKey = prompt("\u7C98\u8D34\u5BF9\u65B9\u7684 P2PDirect publicKey (64 \u5B57\u7B26 hex):\n\n\u83B7\u53D6\u65B9\u5F0F: \u5BF9\u65B9\u5728 http://localhost:54188/api/p2p-publickey");
      if (!publicKey) return;
      if (publicKey.length !== 64) {
        alert("publicKey \u957F\u5EA6\u4E0D\u5BF9, \u5E94\u8BE5\u662F 64 \u5B57\u7B26 hex");
        return;
      }
      try {
        const res = await fetch("/api/friend-request", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ targetPublicKey: publicKey, name, message: "\u60F3\u52A0\u4F60\u4E3A P2P \u597D\u53CB, \u5171\u4EAB channel \u534F\u4F5C" })
        });
        const data = await res.json();
        if (res.status === 502) {
          const reason = data.code === "NO_CONN" ? "\u5BF9\u65B9\u672A\u5728\u7EBF\u6216 P2P \u63E1\u624B\u8D85\u65F6" : "\u5199\u5165 P2P \u901A\u9053\u5931\u8D25";
          alert(`\u597D\u53CB\u7533\u8BF7\u53D1\u9001\u5931\u8D25: ${reason}

\u672C\u5730\u5DF2\u8BB0\u4F4F\u5BF9\u65B9 publicKey (${publicKey.substring(0, 8)}...), \u7B49\u5BF9\u65B9\u4E0A\u7EBF\u540E\u53EF\u5728 P2P \u9762\u677F\u624B\u52A8\u91CD\u8BD5.`);
          await loadRemoteChannels();
          return;
        }
        if (!res.ok) throw new Error(data.error || "connect failed");
        window.__pendingFriendRequests = window.__pendingFriendRequests || /* @__PURE__ */ new Map();
        if (data.requestId) {
          window.__pendingFriendRequests.set(data.requestId, { name, publicKey, at: Date.now() });
          setTimeout(() => {
            if (window.__pendingFriendRequests.has(data.requestId)) {
              window.__pendingFriendRequests.delete(data.requestId);
              console.warn(`[v3-friend] \u7533\u8BF7\u8D85\u65F6\u672A\u6536\u5230 ack (requestId=${data.requestId.substring(0, 8)})`);
              showSimpleToast(`\u26A0\uFE0F \u5BF9\u65B9\u672A\u786E\u8BA4\u6536\u5230 (\u53EF\u80FD\u662F\u65E7\u7248\u5BA2\u6237\u7AEF, \u7533\u8BF7\u5DF2\u53D1\u51FA\u4F46\u65E0\u6CD5\u9A8C\u8BC1)`, "warn");
            }
          }, 8e3);
        }
        alert(`\u5DF2\u53D1\u9001\u597D\u53CB\u7533\u8BF7\u7ED9 ${name} (${publicKey.substring(0, 12)}...)
\u5BF9\u65B9\u6536\u5230\u540E\u81EA\u5DF1\u7AEF\u5F39\u7533\u8BF7 modal, \u63A5\u53D7\u540E\u4F1A\u51FA\u73B0\u5728 P2P \u597D\u53CB\u533A.`);
        await loadRemoteChannels();
      } catch (err) {
        alert("\u7533\u8BF7\u5931\u8D25: " + (err.message || err));
      }
    });
  }
  function showFriendRequestModal(req) {
    document.getElementById("friend-request-modal")?.remove();
    const html = `
    <div id="friend-request-modal" class="friend-req-overlay">
      <div class="friend-req-shell">
        <div class="friend-req-header">
          <span style="font-size:20px;">\u{1F91D}</span>
          <div style="flex:1;min-width:0;">
            <div class="friend-req-title">\u597D\u53CB\u7533\u8BF7</div>
            <div class="friend-req-meta">\u6765\u81EA ${escapeHtml(req.fromName)} (${escapeHtml(req.fromPublicKey.substring(0, 16))}\u2026)</div>
          </div>
        </div>
        <div class="friend-req-body">
          <p style="margin:0 0 8px;">${escapeHtml(req.message || "\u60F3\u52A0\u4F60\u4E3A P2P \u597D\u53CB")}</p>
          <p style="margin:0;color:var(--text-muted);font-size:11px;">\u63A5\u53D7\u540E: \u53CC\u65B9\u4E92\u52A0\u597D\u53CB, \u5BF9\u65B9\u5206\u4EAB\u7684 channel \u4F1A\u81EA\u52A8\u51FA\u73B0\u5728 P2P \u597D\u53CB\u533A.</p>
        </div>
        <div class="friend-req-actions">
          <button id="frm-deny" class="friend-req-btn-deny">\u62D2\u7EDD</button>
          <button id="frm-accept" class="friend-req-btn-accept">\u63A5\u53D7</button>
        </div>
      </div>
    </div>
  `;
    document.body.insertAdjacentHTML("beforeend", html);
    const close = () => document.getElementById("friend-request-modal")?.remove();
    document.getElementById("frm-deny").onclick = close;
    document.getElementById("frm-accept").onclick = async () => {
      close();
      try {
        const res = await fetch("/api/friend-accept", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fromPublicKey: req.fromPublicKey, name: req.fromName })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "accept failed");
        console.log("[v3-friend] \u63A5\u53D7\u4E86\u597D\u53CB\u7533\u8BF7:", req.fromName);
        setTimeout(loadRemoteChannels, 1e3);
        showSimpleToast(`\u2705 \u5DF2\u63A5\u53D7 ${req.fromName} \u7684\u597D\u53CB\u7533\u8BF7`);
      } catch (err) {
        console.error("[v3-friend] accept \u5931\u8D25:", err);
        alert("\u63A5\u53D7\u5931\u8D25: " + (err.message || err));
      }
    };
  }
  function showSimpleToast(text, kind = "info") {
    const containerId = "simple-toast-container";
    let container = document.getElementById(containerId);
    if (!container) {
      container = document.createElement("div");
      container.id = containerId;
      container.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:10005;display:flex;flex-direction:column;gap:8px;max-width:320px;";
      document.body.appendChild(container);
    }
    const el = document.createElement("div");
    el.className = `simple-toast simple-toast-${kind}`;
    el.style.cssText = `background:var(--bg-sidebar);color:var(--text);border:1px solid var(--border);padding:10px 14px;border-radius:6px;font-size:12px;box-shadow:0 4px 16px rgba(0,0,0,0.3);font-family:inherit;animation:toast-in .2s ease-out;`;
    el.textContent = text;
    container.appendChild(el);
    setTimeout(() => {
      el.style.transition = "opacity .3s, transform .3s";
      el.style.opacity = "0";
      el.style.transform = "translateX(20px)";
      setTimeout(() => el.remove(), 320);
    }, 3e3);
  }
  const p2pToggleAllBtn = document.getElementById("p2p-toggle-all-btn");
  if (p2pToggleAllBtn) {
    let syncToggleAllBtn = function() {
      const allPks = /* @__PURE__ */ new Set([
        ...knownPeers.map((p) => p.publicKey),
        ...remoteChannels.map((g) => g.peerId)
      ]);
      if (allPks.size === 0) {
        p2pToggleAllBtn.textContent = "\u229E \u5C55\u5F00";
        p2pToggleAllBtn.title = "\u5207\u6362\u5168\u90E8\u5C55\u5F00/\u6298\u53E0";
        return;
      }
      let collapsedCount = 0;
      for (const pk of allPks) if (collapsedPeers.has(pk)) collapsedCount++;
      const majorityCollapsed = collapsedCount >= allPks.size / 2;
      if (majorityCollapsed) {
        p2pToggleAllBtn.textContent = "\u229E \u5C55\u5F00";
        p2pToggleAllBtn.title = "\u70B9\u51FB\u5C55\u5F00\u6240\u6709 P2P \u597D\u53CB";
      } else {
        p2pToggleAllBtn.textContent = "\u229F \u6298\u53E0";
        p2pToggleAllBtn.title = "\u70B9\u51FB\u6298\u53E0\u6240\u6709 P2P \u597D\u53CB";
      }
    };
    var syncToggleAllBtn2 = syncToggleAllBtn;
    p2pToggleAllBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const allPks = /* @__PURE__ */ new Set([
        ...knownPeers.map((p) => p.publicKey),
        ...remoteChannels.map((g) => g.peerId)
      ]);
      if (allPks.size === 0) return;
      let collapsedCount = 0;
      for (const pk of allPks) if (collapsedPeers.has(pk)) collapsedCount++;
      const majorityCollapsed = collapsedCount >= allPks.size / 2;
      if (majorityCollapsed) {
        expandAllPeers();
      } else {
        collapseAllPeers();
      }
      syncToggleAllBtn();
    });
    window.__syncP2PToggleAllBtn = syncToggleAllBtn;
    syncToggleAllBtn();
  }
  const refreshSharedBtn = document.getElementById("refresh-shared-btn");
  if (refreshSharedBtn) {
    refreshSharedBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const originalText = refreshSharedBtn.textContent;
      refreshSharedBtn.disabled = true;
      refreshSharedBtn.textContent = "...";
      try {
        const res = await fetch("/api/remote-channels/refresh", { method: "POST" });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "refresh failed");
        await new Promise((r) => setTimeout(r, 1500));
        await loadRemoteChannels();
        console.log(`[v3] \u53CC\u5411\u5237\u65B0: \u5411 ${data.peerCount || 0} \u4E2A\u597D\u53CB\u53D1 list \u8BF7\u6C42`);
      } catch (err) {
        alert("\u5237\u65B0\u5931\u8D25: " + (err.message || err));
      } finally {
        refreshSharedBtn.disabled = false;
        refreshSharedBtn.textContent = originalText;
      }
    });
  }
  loadRemoteChannels();
  setInterval(loadRemoteChannels, 8e3);
  startV3GlobalSSE();
  const localSection = document.querySelector(".sidebar-section");
  const remoteSection = document.getElementById("remote-agents-section");
  if (localSection) localSection.classList.add("local-flex");
  if (remoteSection) remoteSection.classList.add("remote-flex");
  const remoteHeader = document.getElementById("remote-agents-header");
  if (remoteHeader && remoteSection) {
    remoteHeader.addEventListener("click", (e) => {
      remoteSection.classList.toggle("collapsed");
    });
  }
  const splitHandle = document.getElementById("sidebar-split-handle");
  if (splitHandle && localSection && remoteSection) {
    const updateFlexVars = (localRatio, remoteRatio) => {
      localSection.style.setProperty("--local-flex", String(localRatio));
      remoteSection.style.setProperty("--remote-flex", String(remoteRatio));
    };
    updateFlexVars(1, 1);
    let isDragging = false;
    let dragStartY = 0;
    let startLocalFlex = 1;
    let startRemoteFlex = 1;
    let sidebarHeight = 0;
    splitHandle.addEventListener("mousedown", (e) => {
      isDragging = true;
      splitHandle.classList.add("dragging");
      dragStartY = e.clientY;
      const lf = parseFloat(getComputedStyle(localSection).getPropertyValue("--local-flex")) || 1;
      const rf = parseFloat(getComputedStyle(remoteSection).getPropertyValue("--remote-flex")) || 1;
      startLocalFlex = lf;
      startRemoteFlex = rf;
      const sidebar2 = document.querySelector(".sidebar");
      if (sidebar2) sidebarHeight = sidebar2.clientHeight;
      e.preventDefault();
      document.body.style.cursor = "ns-resize";
    });
    document.addEventListener("mousemove", (e) => {
      if (!isDragging) return;
      const deltaY = e.clientY - dragStartY;
      if (sidebarHeight <= 0) return;
      const deltaRatio = deltaY / sidebarHeight * 4;
      let newLocal = Math.max(0.1, startLocalFlex + deltaRatio);
      let newRemote = Math.max(0.1, startRemoteFlex - deltaRatio);
      updateFlexVars(newLocal, newRemote);
    });
    document.addEventListener("mouseup", () => {
      if (!isDragging) return;
      isDragging = false;
      splitHandle.classList.remove("dragging");
      document.body.style.cursor = "";
    });
    splitHandle.addEventListener("dblclick", () => {
      updateFlexVars(1, 1);
    });
  }
  const walletModal = document.getElementById("wallet-modal");
  const walletModalClose = document.getElementById("wallet-modal-close");
  const walletBindAddress = document.getElementById("wallet-bind-address");
  const walletGenerateBtn = document.getElementById("wallet-generate-btn");
  const walletAutoTools = document.getElementById("wallet-auto-tools");
  const walletBindBtn = document.getElementById("wallet-bind-btn");
  const walletUnbindBtn = document.getElementById("wallet-unbind-btn");
  const walletNewInfo = document.getElementById("wallet-new-info");
  const walletListEl = document.getElementById("wallet-list");
  let walletModalPendingSecret = null;
  let walletModalPendingMnemonic = null;
  if (walletModalClose) {
    walletModalClose.addEventListener("click", closeWalletModal);
  }
  if (walletBindBtn) {
    walletBindBtn.addEventListener("click", async () => {
      if (!currentChannelId) {
        alert("\u8BF7\u5148\u5728\u4FA7\u8FB9\u680F\u9009\u62E9\u4E00\u4E2A\u667A\u80FD\u4F53");
        return;
      }
      const address = (walletBindAddress.value || "").trim();
      if (!address) {
        alert("\u8BF7\u8F93\u5165\u94B1\u5305\u5730\u5740\u6216\u70B9\u51FB\u300C\u751F\u6210\u300D");
        return;
      }
      const ch = channels.find((c) => c.id === currentChannelId);
      const did = ch?.did || "";
      if (!did || did === "undefined" || did === "null") {
        alert("\u5F53\u524D\u667A\u80FD\u4F53\u8FD8\u6CA1\u6709\u751F\u6210 DID, \u8BF7\u7A0D\u7B49\u51E0\u79D2\u540E\u91CD\u8BD5");
        return;
      }
      if (!walletModalPendingSecret) {
        alert("\u8BF7\u5148\u5728\u300C\u94B1\u5305\u7BA1\u7406\u300D\u9762\u677F\u70B9\u51FB\u300C\u751F\u6210\u300D\u6216\u5BFC\u5165\u79C1\u94A5, \u4E34\u65F6\u79C1\u94A5\u4EC5\u5728\u672C\u4F1A\u8BDD\u4FDD\u7559");
        return;
      }
      let challenge;
      try {
        challenge = await signDIDChallengeAsync(walletModalPendingSecret, did, currentChannelId);
      } catch (err) {
        alert("\u7B7E\u540D\u5931\u8D25: " + err.message);
        return;
      }
      if (challenge.address.toLowerCase() !== address.toLowerCase()) {
        alert(`\u7B7E\u540D\u5730\u5740 ${challenge.address} \u4E0E\u8F93\u5165\u5730\u5740 ${address} \u4E0D\u4E00\u81F4, \u62D2\u7EDD\u7ED1\u5B9A`);
        return;
      }
      try {
        const res = await fetch(`/channels/${currentChannelId}/bind-wallet`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            walletAddress: challenge.address,
            signature: challenge.signature,
            message: challenge.message,
            did: challenge.did,
            autoInvokeTools: !!walletAutoTools.checked
          })
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || "bind failed");
        }
        const updated = await res.json();
        const idx = channels.findIndex((c) => c.id === currentChannelId);
        if (idx >= 0) channels[idx] = updated;
        renderChannels();
        renderWalletList();
        walletModalPendingSecret = null;
        walletModalPendingMnemonic = null;
        walletNewInfo.style.display = "block";
        walletNewInfo.innerHTML = "\u2705 \u7ED1\u5B9A\u6210\u529F<br><strong>\u5730\u5740:</strong> <code>" + escapeHtml(updated.walletAddress) + "</code><br><strong>\u7B7E\u540D DID:</strong> <code>" + escapeHtml(did) + '</code><br><small style="color:#9c9;">\u670D\u52A1\u7AEF\u5DF2\u7528 recoverMessage \u6821\u9A8C\u7B7E\u540D, \u8BC1\u660E\u4F60\u6301\u6709\u8BE5\u94B1\u5305\u79C1\u94A5\u3002</small>';
      } catch (err) {
        alert("\u7ED1\u5B9A\u5931\u8D25: " + err.message);
      }
    });
  }
  if (walletUnbindBtn) {
    walletUnbindBtn.addEventListener("click", async () => {
      if (!currentChannelId) {
        alert("\u8BF7\u5148\u9009\u62E9\u4E00\u4E2A\u667A\u80FD\u4F53");
        return;
      }
      if (!confirm("\u89E3\u7ED1\u5F53\u524D\u667A\u80FD\u4F53\u7684\u94B1\u5305?")) return;
      try {
        const res = await fetch(`/channels/${currentChannelId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ walletAddress: null })
        });
        if (!res.ok) throw new Error("unbind failed");
        const updated = await res.json();
        const idx = channels.findIndex((c) => c.id === currentChannelId);
        if (idx >= 0) channels[idx] = updated;
        walletBindAddress.value = "";
        renderChannels();
        renderWalletList();
      } catch (err) {
        alert("\u89E3\u7ED1\u5931\u8D25: " + err.message);
      }
    });
  }
  function openWalletModal() {
    if (walletModal) {
      walletModal.classList.add("active");
      if (currentChannelId && walletBindAddress && channels.find((c) => c.id === currentChannelId)) {
        const ch = channels.find((c) => c.id === currentChannelId);
        walletBindAddress.value = ch?.walletAddress || "";
      }
      renderWalletList();
    }
  }
  function closeWalletModal() {
    if (walletModal) walletModal.classList.remove("active");
  }
  function renderWalletList() {
    if (!walletListEl) return;
    const bound = channels.filter((c) => c.walletAddress);
    if (bound.length === 0) {
      walletListEl.innerHTML = '<div class="wallet-empty">\u6682\u672A\u7ED1\u5B9A\u94B1\u5305</div>';
      return;
    }
    const frag = document.createDocumentFragment();
    bound.forEach((ch) => {
      const isActive = ch.id === currentChannelId;
      const chain = detectChain(ch.walletAddress);
      const row = document.createElement("div");
      row.className = "wallet-row" + (isActive ? " is-active" : "");
      row.innerHTML = `
      <span class="wallet-chain">${escapeHtml(chain)}</span>
      <div class="wallet-info">
        <span class="wallet-agent" title="${escapeHtml(ch.name || "")}">${escapeHtml(ch.name || "(\u672A\u547D\u540D)")}</span>
        <span class="wallet-address" title="${escapeHtml(ch.walletAddress)}">${escapeHtml(ch.walletAddress)}</span>
      </div>
      <div class="wallet-actions">
        <button class="wallet-mini-btn" data-action="copy" data-addr="${escapeHtml(ch.walletAddress)}" title="\u590D\u5236\u5730\u5740">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="9" y="9" width="13" height="13" rx="2"></rect>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
          </svg>
        </button>
        <button class="wallet-mini-btn" data-action="goto" data-id="${escapeHtml(ch.id)}" title="\u5207\u6362\u5230\u8BE5\u667A\u80FD\u4F53">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M5 12h14M12 5l7 7-7 7"></path>
          </svg>
        </button>
        <button class="wallet-mini-btn" data-action="unbind" data-id="${escapeHtml(ch.id)}" title="\u89E3\u7ED1">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>
    `;
      frag.appendChild(row);
    });
    walletListEl.innerHTML = "";
    walletListEl.appendChild(frag);
    walletListEl.onclick = async (ev) => {
      const btn = ev.target.closest("button[data-action]");
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === "copy") {
        try {
          await navigator.clipboard.writeText(btn.dataset.addr);
          btn.style.background = "var(--accent)";
          btn.style.color = "var(--bg)";
          setTimeout(() => {
            btn.style.background = "";
            btn.style.color = "";
          }, 800);
        } catch {
        }
      } else if (action === "goto") {
        closeWalletModal();
        selectChannel(btn.dataset.id);
      } else if (action === "unbind") {
        if (!confirm("\u89E3\u7ED1\u8BE5\u667A\u80FD\u4F53\u7684\u94B1\u5305?")) return;
        try {
          const res = await fetch(`/channels/${btn.dataset.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ walletAddress: null })
          });
          if (!res.ok) throw new Error("unbind failed");
          const updated = await res.json();
          const idx = channels.findIndex((c) => c.id === btn.dataset.id);
          if (idx >= 0) channels[idx] = updated;
          renderChannels();
          renderWalletList();
          if (btn.dataset.id === currentChannelId) walletBindAddress.value = "";
        } catch (err) {
          alert("\u89E3\u7ED1\u5931\u8D25: " + err.message);
        }
      }
    };
  }
  function detectChain(addr) {
    if (!addr) return "?";
    if (/^0x[0-9a-fA-F]{40}$/.test(addr)) return "EVM";
    if (/^0x[0-9a-fA-F]{64}$/.test(addr)) return "SUI";
    if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr)) return "SOL";
    return "?";
  }
  init();
  const agentAddModal = document.getElementById("agent-add-modal");
  const agentAddTitle = document.getElementById("agent-add-title");
  const agentAddModalClose = document.getElementById("agent-add-modal-close");
  const agentAddName = document.getElementById("agent-add-name");
  const agentAddWallet = document.getElementById("agent-add-wallet");
  const agentAddAutoTools = document.getElementById("agent-add-auto-tools");
  const agentAddConfirmBtn = document.getElementById("agent-add-confirm-btn");
  const agentAddCancelBtn = document.getElementById("agent-add-cancel-btn");
  const agentAddWalletInfo = document.getElementById("agent-add-wallet-info");
  const agentGenerateWalletBtn = document.getElementById("agent-generate-wallet-btn");
  let pendingWalletSecret = null;
  let pendingWalletMnemonic = null;
  function openAgentAddModal(existingChannel) {
    if (!agentAddModal) return;
    if (existingChannel) {
      agentAddTitle.textContent = "\u914D\u7F6E\u667A\u80FD\u4F53\uFF1A" + existingChannel.name;
      agentAddName.value = existingChannel.name || "";
      agentAddName.readOnly = false;
      agentAddName.placeholder = "\u8F93\u5165\u65B0\u540D\u79F0";
      agentAddWallet.value = existingChannel.walletAddress || "";
      agentAddAutoTools.checked = !!existingChannel.autoInvokeTools;
      agentAddConfirmBtn.dataset.mode = "update";
      agentAddConfirmBtn.dataset.channelId = existingChannel.id;
      agentAddConfirmBtn.dataset.originalName = existingChannel.name || "";
    } else {
      agentAddTitle.textContent = "\u6DFB\u52A0\u667A\u80FD\u4F53";
      agentAddName.value = "";
      agentAddName.readOnly = false;
      agentAddName.placeholder = "\u4F8B\u5982: \u4EA4\u6613\u52A9\u624B";
      agentAddWallet.value = "";
      agentAddAutoTools.checked = true;
      agentAddConfirmBtn.dataset.mode = "create";
      delete agentAddConfirmBtn.dataset.channelId;
      delete agentAddConfirmBtn.dataset.originalName;
    }
    agentAddWalletInfo.style.display = "none";
    agentAddWalletInfo.innerHTML = "";
    pendingWalletSecret = null;
    agentAddModal.classList.add("active");
  }
  function closeAgentAddModal() {
    if (!agentAddModal) return;
    agentAddModal.classList.remove("active");
    pendingWalletSecret = null;
  }
  async function generateRealWalletAsync() {
    if (!window.WalletViem) {
      throw new Error("\u94B1\u5305\u6A21\u5757\u5C1A\u672A\u52A0\u8F7D, \u8BF7\u7A0D\u540E\u91CD\u8BD5");
    }
    return window.WalletViem.generateRealWallet();
  }
  async function signDIDChallengeAsync(privateKeyHex, did, channelId) {
    if (!window.WalletViem) {
      throw new Error("\u94B1\u5305\u6A21\u5757\u5C1A\u672A\u52A0\u8F7D, \u8BF7\u7A0D\u540E\u91CD\u8BD5");
    }
    return window.WalletViem.signDIDChallenge(privateKeyHex, did, channelId);
  }
  function formatWalletInfoHtml({ address, privateKey, mnemonic }) {
    const parts = [
      "\u2713 \u5DF2\u751F\u6210\u771F\u5B9E EVM \u94B1\u5305 (BIP-39 + secp256k1 + EIP-55)",
      "<strong>\u5730\u5740:</strong> <code>" + escapeHtml(address) + "</code>"
    ];
    if (mnemonic) {
      parts.push(
        "<strong>\u52A9\u8BB0\u8BCD (12 \u8BCD, \u8BF7\u6284\u5199\u4FDD\u5B58):</strong>",
        '<code style="color:#fc6;word-break:break-all;">' + escapeHtml(mnemonic) + "</code>"
      );
    }
    parts.push(
      "<strong>\u79C1\u94A5 (0x + 32 \u5B57\u8282):</strong>",
      '<code style="color:#f88;word-break:break-all;">' + escapeHtml(privateKey) + "</code>",
      '<small style="color:#f88;">\u26A0 \u52A9\u8BB0\u8BCD + \u79C1\u94A5\u5747\u4EC5\u5728\u672C\u6D4F\u89C8\u5668\u5185\u5B58, \u5173\u95ED\u9875\u9762\u540E\u65E0\u6CD5\u627E\u56DE\u3002</small>',
      '<small style="color:#999;">\u7B7E\u540D\u7ED1\u5B9A\u5230 channel DID (EIP-191 personal_sign) \u4F1A\u53D1\u9001\u5230\u670D\u52A1\u7AEF, \u7528\u4E8E\u8BC1\u660E\u94B1\u5305\u6240\u6709\u6743\u3002</small>'
    );
    return parts.join("<br>");
  }
  if (agentGenerateWalletBtn) {
    agentGenerateWalletBtn.addEventListener("click", async () => {
      agentAddWalletInfo.style.display = "block";
      agentAddWalletInfo.innerHTML = "\u23F3 \u6B63\u5728\u751F\u6210\u771F\u5B9E EVM \u94B1\u5305...";
      try {
        const wallet = await generateRealWalletAsync();
        agentAddWallet.value = wallet.address;
        pendingWalletSecret = wallet.privateKey;
        pendingWalletMnemonic = wallet.mnemonic;
        agentAddWalletInfo.innerHTML = formatWalletInfoHtml(wallet);
      } catch (err) {
        agentAddWalletInfo.innerHTML = "\u2717 \u751F\u6210\u94B1\u5305\u5931\u8D25: " + escapeHtml(err.message);
      }
    });
  }
  if (agentAddModalClose) agentAddModalClose.addEventListener("click", closeAgentAddModal);
  if (agentAddCancelBtn) agentAddCancelBtn.addEventListener("click", closeAgentAddModal);
  if (agentAddConfirmBtn) {
    agentAddConfirmBtn.addEventListener("click", async () => {
      const mode = agentAddConfirmBtn.dataset.mode || "create";
      const name = (agentAddName.value || "").trim();
      if (!name && mode === "create") {
        alert("\u8BF7\u8F93\u5165\u667A\u80FD\u4F53\u540D\u79F0");
        return;
      }
      const walletAddress = (agentAddWallet.value || "").trim();
      const autoInvokeTools = !!agentAddAutoTools.checked;
      try {
        if (mode === "create") {
          const res = await fetch("/channels", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name,
              agentId: currentAgentId,
              walletAddress: walletAddress || void 0,
              autoInvokeTools
            })
          });
          if (!res.ok) throw new Error("create failed");
          const channel = await res.json();
          channels.push(channel);
          renderChannels();
          selectChannel(channel.id);
        } else {
          const channelId = agentAddConfirmBtn.dataset.channelId;
          const originalName = agentAddConfirmBtn.dataset.originalName || "";
          const body = { walletAddress: walletAddress || null, autoInvokeTools };
          if (name && name !== originalName) {
            body.name = name;
          }
          const res = await fetch(`/channels/${channelId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
          });
          if (!res.ok) throw new Error("update failed");
          const updated = await res.json();
          const idx = channels.findIndex((c) => c.id === channelId);
          if (idx >= 0) channels[idx] = updated;
          renderChannels();
        }
        closeAgentAddModal();
      } catch (err) {
        console.error("Failed to save agent:", err);
        alert("\u4FDD\u5B58\u5931\u8D25: " + err.message);
      }
    });
  }
})();
