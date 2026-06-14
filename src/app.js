(() => {
  "use strict";

  const STORAGE_KEY = "little-spud-webui:v1";
  const CLIENT_VERSION = "0.1.32";
  const MAX_HISTORY_MESSAGES = 14;
  const MAX_IMAGE_SEND_BYTES = 5 * 1024 * 1024;
  const MAX_STT_SECONDS = 45;
  const NOTIFICATION_POLL_WAIT_SECONDS = 20;
  const NOTIFICATION_RETRY_MS = 5000;
  const TTS_START_GRACE_MS = 1400;
  const SILENT_WAV_DATA_URL = "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQQAAAAAAA==";

  const $ = (selector) => document.querySelector(selector);
  const els = {
    app: $("#app"),
    sidebarScrim: $("#sidebar-scrim"),
    sidebarToggleBtn: $("#sidebar-toggle-btn"),
    connectionSubtitle: $("#connection-subtitle"),
    userName: $("#user-name"),
    deviceName: $("#device-name"),
    hubUrl: $("#hub-url"),
    syncCode: $("#sync-code"),
    pairBtn: $("#pair-btn"),
    scanBtn: $("#scan-btn"),
    pairingStatus: $("#pairing-status"),
    statusPill: $("#status-pill"),
    hubName: $("#hub-name"),
    hubMode: $("#hub-mode"),
    hubTools: $("#hub-tools"),
    notifyBtn: $("#notify-btn"),
    notifyStatus: $("#notify-status"),
    heartbeatBtn: $("#heartbeat-btn"),
    disconnectBtn: $("#disconnect-btn"),
    chatContext: $("#chat-context"),
    clearChatBtn: $("#clear-chat-btn"),
    messageList: $("#message-list"),
    composer: $("#composer"),
    attachmentTray: $("#attachment-tray"),
    attachBtn: $("#attach-btn"),
    cameraBtn: $("#camera-btn"),
    ttsToggleBtn: $("#tts-toggle-btn"),
    sttBtn: $("#stt-btn"),
    ttsStatus: $("#tts-status"),
    ttsAudio: $("#tts-audio"),
    fileInput: $("#file-input"),
    cameraInput: $("#camera-input"),
    messageInput: $("#message-input"),
    sendBtn: $("#send-btn"),
    scannerDialog: $("#scanner-dialog"),
    scannerVideo: $("#scanner-video"),
    scannerStatus: $("#scanner-status"),
    scannerClose: $("#scanner-close")
  };

  const state = {
    profile: {
      userName: "",
      deviceName: detectDeviceName()
    },
    connection: {
      hubUrl: "",
      token: "",
      node: null,
      hub: null,
      pairedAt: 0,
      lastSeenAt: 0
    },
    messages: [],
    attachments: [],
    busy: false,
    typing: false,
    pendingChats: 0,
    activeRuns: [],
    historySyncTimer: 0,
    notifications: {
      polling: false,
      timer: 0
    },
    ui: {
      sidebarCollapsed: false,
      ttsEnabled: false,
      browserNotifications: false
    },
    tts: {
      audio: null,
      abort: null,
      objectUrl: "",
      audioContext: null,
      unlocked: false,
      cleanup: null
    },
    stt: {
      recording: false,
      submitting: false,
      stream: null,
      audioContext: null,
      source: null,
      processor: null,
      mute: null,
      ws: null,
      chunks: [],
      sampleRate: 16000,
      startedAt: 0,
      stopTimer: 0,
      finalReceived: false
    },
    scanner: {
      stream: null,
      raf: 0,
      detector: null
    }
  };

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function escapeAttributeSelector(value) {
    return String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  function formatBytes(bytes) {
    const value = Number(bytes || 0);
    if (value < 1024) return `${value} B`;
    const units = ["KB", "MB", "GB"];
    let size = value / 1024;
    let unit = units[0];
    for (let i = 1; i < units.length && size >= 1024; i += 1) {
      size /= 1024;
      unit = units[i];
    }
    return `${size.toFixed(size >= 100 ? 0 : size >= 10 ? 1 : 2)} ${unit}`;
  }

  function normalizeUrl(value) {
    const text = String(value || "").trim().replace(/\/+$/, "");
    if (!text) return "";
    if (/^https?:\/\//i.test(text)) return text;
    return `http://${text}`;
  }

  function hubApiUrl(hubUrl, path) {
    const base = normalizeUrl(hubUrl);
    if (!base) return "";
    const cleanPath = `/${String(path || "").replace(/^\/+/, "")}`;
    return `${base}${cleanPath}`;
  }

  function spudLinkMediaUrl(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    const absolute = raw.startsWith("/") && state.connection.hubUrl ? hubApiUrl(state.connection.hubUrl, raw) : raw;
    if (!absolute || !state.connection.token) return absolute;
    try {
      const parsed = new URL(absolute, window.location.href);
      if (parsed.pathname.startsWith("/api/spudlink/")) {
        parsed.searchParams.set("token", state.connection.token);
      }
      return parsed.toString();
    } catch {
      return absolute;
    }
  }

  function hubBaseFromApiUrl(value, apiPath) {
    const endpoint = normalizeUrl(value);
    const cleanApiPath = `/${String(apiPath || "").replace(/^\/+/, "").replace(/\/+$/, "")}`;
    if (!endpoint || !cleanApiPath) return "";
    const cleanEndpoint = endpoint.replace(/\/+$/, "");
    if (!cleanEndpoint.toLowerCase().endsWith(cleanApiPath.toLowerCase())) return "";
    return cleanEndpoint.slice(0, -cleanApiPath.length).replace(/\/+$/, "");
  }

  function webSocketUrlFromHttpUrl(value) {
    const url = new URL(value);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url;
  }

  function isLocalHttpHost(hostname) {
    const host = String(hostname || "").trim().toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  }

  function assertBrowserCanReach(url, actionLabel) {
    const parsed = new URL(url, window.location.href);
    if (window.location.protocol === "https:" && parsed.protocol === "http:" && !isLocalHttpHost(parsed.hostname)) {
      throw new Error(
        `${actionLabel} is trying to call ${parsed.origin} from an HTTPS Little Spud page. Browsers block that. Use an HTTPS Tater/Spud Hub proxy URL in the QR/Public URL, or open Little Spud over HTTP on the LAN.`
      );
    }
    if (window.location.protocol === "https:" && parsed.protocol === "ws:") {
      throw new Error(
        `${actionLabel} is trying to open an insecure WebSocket from an HTTPS Little Spud page. Use an HTTPS Tater/Spud Hub proxy URL so STT can connect with WSS.`
      );
    }
    return parsed;
  }

  function detectDeviceName() {
    const uaData = navigator.userAgentData;
    const platform = uaData?.platform || navigator.platform || "Device";
    const ua = navigator.userAgent || "";
    if (/iphone/i.test(ua)) return "iPhone";
    if (/ipad/i.test(ua)) return "iPad";
    if (/android/i.test(ua)) return "Android";
    if (/mac/i.test(platform)) return "Mac";
    if (/win/i.test(platform)) return "Windows PC";
    if (/linux/i.test(platform)) return "Linux PC";
    return platform || "Little Spud";
  }

  function loadState() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      if (raw.profile && typeof raw.profile === "object") Object.assign(state.profile, raw.profile);
      if (raw.connection && typeof raw.connection === "object") Object.assign(state.connection, raw.connection);
      if (raw.ui && typeof raw.ui === "object") Object.assign(state.ui, raw.ui);
      state.ui.ttsEnabled = false;
      if (Array.isArray(raw.messages)) state.messages = raw.messages.slice(-80);
    } catch (error) {
      console.warn("State load failed", error);
    }
  }

  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      profile: state.profile,
      connection: state.connection,
      ui: state.ui,
      messages: state.messages.slice(-80)
    }));
  }

  function messageDedupeKey(message) {
    return [
      String(message?.id || "").trim(),
      String(message?.role || "").trim(),
      String(message?.content || "").trim()
    ].join("|");
  }

  function normalizeHubHistoryMessage(message) {
    if (!message || typeof message !== "object") return null;
    const role = String(message.role || "").trim();
    const content = String(message.content || "").trim();
    if (!["user", "assistant", "system"].includes(role) || !content) return null;
    const attachments = normalizeAssistantArtifacts(message.attachments || message.artifacts || []);
    return {
      id: String(message.id || crypto.randomUUID?.() || `${Date.now()}-hub-history`),
      role,
      content,
      attachments,
      createdAt: Number(message.createdAt || Date.now()),
      meta: {
        ...(message.meta && typeof message.meta === "object" ? message.meta : {}),
        source: "spud_hub_history"
      }
    };
  }

  function mergeHubHistory(messages) {
    const incoming = Array.isArray(messages) ? messages.map(normalizeHubHistoryMessage).filter(Boolean) : [];
    if (!incoming.length) return false;
    const seen = new Set(state.messages.map(messageDedupeKey));
    let changed = false;
    for (const message of incoming) {
      const key = messageDedupeKey(message);
      const softDuplicate = state.messages.some((existing) => (
        String(existing.role || "") === message.role
        && String(existing.content || "").trim() === message.content
        && (
          existing.meta?.kind !== "tool_notice"
          || message.meta?.kind === "tool_notice"
        )
      ));
      if (seen.has(key) || softDuplicate) continue;
      state.messages.push(message);
      seen.add(key);
      changed = true;
    }
    if (!changed) return false;
    state.messages.sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
    state.messages = state.messages.slice(-80);
    saveState();
    renderMessages();
    return true;
  }

  function scheduleHistorySync(delayMs = 5000) {
    if (state.historySyncTimer || !isPaired()) return;
    state.historySyncTimer = window.setTimeout(() => {
      state.historySyncTimer = 0;
      if (isPaired()) syncHistoryFromHub().catch(() => null);
    }, Math.max(1000, Number(delayMs || 5000)));
  }

  function clearHistorySyncTimer() {
    if (!state.historySyncTimer) return;
    window.clearTimeout(state.historySyncTimer);
    state.historySyncTimer = 0;
  }

  function refreshTypingState({ render = false } = {}) {
    state.typing = Number(state.pendingChats || 0) > 0 || (Array.isArray(state.activeRuns) && state.activeRuns.length > 0);
    if (render) renderMessages();
  }

  function applyHubActiveRun(activeRunOrRuns) {
    const runItems = Array.isArray(activeRunOrRuns)
      ? activeRunOrRuns
      : activeRunOrRuns
        ? [activeRunOrRuns]
        : [];
    const runningRuns = runItems.filter((run) => ["queued", "running"].includes(String(run?.status || "").toLowerCase()));
    state.activeRuns = runningRuns;
    if (!runningRuns.length) {
      clearHistorySyncTimer();
      refreshTypingState({ render: true });
      return false;
    }
    const latestRun = runningRuns[0] || {};
    const noticeText = String(latestRun?.text || "").trim();
    refreshTypingState();
    if (noticeText && latestRun.phase === "tool_start") {
      const hasNotice = state.messages.some((message) => (
        message.meta?.kind === "tool_notice"
        && String(message.content || "").trim() === noticeText
      ));
      if (!hasNotice) {
        appendToolNotice({
          text: noticeText,
          display_name: latestRun.display_name || latestRun.tool || ""
        });
      }
    } else {
      renderMessages();
    }
    scheduleHistorySync();
    return true;
  }

  function notificationMessageContent(notification) {
    const title = String(notification?.title || "").trim();
    const message = String(notification?.message || notification?.content || "").trim();
    if (title && message) return `${title}\n\n${message}`;
    return title || message;
  }

  function normalizeHubNotification(notification) {
    if (!notification || typeof notification !== "object") return null;
    const content = notificationMessageContent(notification);
    const attachments = normalizeAssistantArtifacts(notification.attachments || notification.artifacts || []);
    if (!content && !attachments.length) return null;
    return {
      id: String(notification.id || crypto.randomUUID?.() || `${Date.now()}-notification`),
      role: "system",
      content: content || "Notification",
      attachments,
      createdAt: Number(notification.createdAt || (Number(notification.created_at || 0) * 1000) || Date.now()),
      meta: {
        ...(notification.meta && typeof notification.meta === "object" ? notification.meta : {}),
        kind: "notification",
        source: "spud_hub_notification",
        priority: notification.priority || notification.meta?.priority || "normal"
      }
    };
  }

  function appendHubNotification(notification) {
    const message = normalizeHubNotification(notification);
    if (!message) return false;
    const key = messageDedupeKey(message);
    const exists = state.messages.some((existing) => (
      messageDedupeKey(existing) === key
      || (existing.meta?.kind === "notification" && String(existing.id || "") === message.id)
    ));
    if (exists) return false;
    state.messages.push(message);
    state.messages.sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
    state.messages = state.messages.slice(-80);
    saveState();
    renderMessages();
    showBrowserNotification(message);
    return true;
  }

  function showBrowserNotification(message) {
    if (!state.ui.browserNotifications) return;
    const nativeNotify = window.webkit?.messageHandlers?.littleSpudNotify;
    if (!nativeNotify?.postMessage && (!("Notification" in window) || Notification.permission !== "granted")) return;
    if (document.visibilityState === "visible" && !nativeNotify?.postMessage) return;
    const title = "Little Spud";
    const body = String(message?.content || "").replace(/\s+/g, " ").trim();
    const options = {
      body: body.slice(0, 220),
      tag: String(message?.id || "little-spud-notification"),
      icon: "./assets/little-spud-app-icon.png",
      badge: "./assets/little-spud-app-icon.png",
      data: { url: window.location.href }
    };
    if (nativeNotify?.postMessage) {
      nativeNotify.postMessage({
        title,
        body: options.body,
        tag: options.tag,
        url: window.location.href
      });
      return;
    }
    const fallback = () => {
      try {
        new Notification(title, options);
      } catch {
        // Browser notifications are best-effort; the in-app message is the source of truth.
      }
    };
    if ("serviceWorker" in navigator && window.ServiceWorkerRegistration && "showNotification" in ServiceWorkerRegistration.prototype) {
      navigator.serviceWorker.ready
        .then((registration) => registration.showNotification(title, options))
        .catch(fallback);
      return;
    }
    fallback();
  }

  function nativeNotificationsSupported() {
    return Boolean(window.webkit?.messageHandlers?.littleSpudNotify?.postMessage);
  }

  function browserNotificationsSupported() {
    return nativeNotificationsSupported() || ("Notification" in window && (
      window.isSecureContext
      || location.protocol === "https:"
      || location.hostname === "localhost"
      || location.hostname === "127.0.0.1"
    ));
  }

  function browserNotificationStatus() {
    if (!browserNotificationsSupported()) return "unsupported";
    if (nativeNotificationsSupported()) return "granted";
    return Notification.permission || "default";
  }

  function updateNotifyButton() {
    if (!els.notifyBtn || !els.notifyStatus) return;
    const status = browserNotificationStatus();
    const enabled = Boolean(state.ui.browserNotifications && status === "granted");
    if (state.ui.browserNotifications && status !== "granted") {
      state.ui.browserNotifications = false;
      saveState();
    }
    els.notifyBtn.disabled = status === "unsupported" || status === "denied";
    els.notifyBtn.classList.toggle("active", enabled);
    els.notifyBtn.setAttribute("aria-pressed", enabled ? "true" : "false");
    els.notifyBtn.textContent = enabled ? "Notify On" : "Notify";
    els.notifyBtn.title = enabled ? "Disable browser notifications" : "Enable browser notifications";
    els.notifyStatus.className = `status-line ${enabled ? "ok" : status === "denied" || status === "unsupported" ? "error" : ""}`.trim();
    els.notifyStatus.textContent = enabled
      ? "On"
      : status === "denied"
        ? "Blocked"
        : status === "unsupported"
          ? "Unavailable"
          : "Off";
  }

  async function toggleBrowserNotifications() {
    const status = browserNotificationStatus();
    if (status === "unsupported" || status === "denied") {
      state.ui.browserNotifications = false;
      saveState();
      updateNotifyButton();
      return;
    }
    if (state.ui.browserNotifications && status === "granted") {
      state.ui.browserNotifications = false;
      saveState();
      updateNotifyButton();
      return;
    }
    let permission = status;
    if (permission === "default") {
      try {
        permission = await Notification.requestPermission();
      } catch {
        permission = browserNotificationStatus();
      }
    }
    state.ui.browserNotifications = permission === "granted";
    saveState();
    updateNotifyButton();
    if (state.ui.browserNotifications) {
      showBrowserNotification({
        id: "little-spud-notifications-enabled",
        content: "Device notifications enabled."
      });
    }
  }

  function clearNotificationPollTimer() {
    if (!state.notifications.timer) return;
    window.clearTimeout(state.notifications.timer);
    state.notifications.timer = 0;
  }

  function scheduleNotificationPoll(delayMs = 0) {
    if (!isPaired() || state.notifications.polling || state.notifications.timer) return;
    state.notifications.timer = window.setTimeout(() => {
      state.notifications.timer = 0;
      pollNotificationsFromHub().catch(() => null);
    }, Math.max(0, Number(delayMs || 0)));
  }

  async function pollNotificationsFromHub() {
    if (!isPaired() || state.notifications.polling) return null;
    state.notifications.polling = true;
    try {
      const payload = await fetchJson(
        hubApiUrl(state.connection.hubUrl, `/api/spudlink/v1/notifications/next?wait_seconds=${NOTIFICATION_POLL_WAIT_SECONDS}`),
        {
          method: "GET",
          headers: authHeaders()
        },
        "Notification poll"
      );
      if (payload.notification) appendHubNotification(payload.notification);
      return payload;
    } catch (error) {
      console.warn("Notification poll failed", error);
      return null;
    } finally {
      state.notifications.polling = false;
      if (isPaired()) scheduleNotificationPoll(document.hidden ? NOTIFICATION_RETRY_MS : 250);
    }
  }

  function setStatus(message, kind = "") {
    els.pairingStatus.textContent = message;
    els.pairingStatus.className = `status-line ${kind}`.trim();
  }

  function isPaired() {
    return Boolean(state.connection.hubUrl && state.connection.token);
  }

  function updateTtsButton() {
    if (!els.ttsToggleBtn) return;
    const enabled = Boolean(state.ui.ttsEnabled);
    els.ttsToggleBtn.disabled = !isPaired();
    els.ttsToggleBtn.classList.toggle("active", enabled);
    els.ttsToggleBtn.setAttribute("aria-pressed", enabled ? "true" : "false");
    els.ttsToggleBtn.title = enabled ? "Disable TTS" : "Enable TTS";
    els.ttsToggleBtn.setAttribute("aria-label", enabled ? "Disable TTS" : "Enable TTS");
  }

  function updateSttButton() {
    if (!els.sttBtn) return;
    const recording = Boolean(state.stt.recording);
    els.sttBtn.disabled = (!isPaired() || state.stt.submitting) && !recording;
    els.sttBtn.classList.toggle("recording", recording);
    els.sttBtn.setAttribute("aria-pressed", recording ? "true" : "false");
    els.sttBtn.title = recording ? "Stop voice input" : "Start voice input";
    els.sttBtn.setAttribute("aria-label", recording ? "Stop voice input" : "Start voice input");
  }

  function setSpeechStatus(message = "", kind = "") {
    if (!els.ttsStatus) return;
    els.ttsStatus.textContent = message;
    els.ttsStatus.className = `tts-status ${kind}`.trim();
  }

  function setTtsStatus(message = "", kind = "") {
    setSpeechStatus(message, kind);
  }

  function renderConnection() {
    const paired = isPaired();
    const hub = state.connection.hub || {};
    const node = state.connection.node || {};
    els.connectionSubtitle.textContent = paired ? `Paired as ${node.name || state.profile.deviceName || "Little Spud"}` : "Not paired";
    els.statusPill.className = `status-pill ${paired ? "online" : ""}`;
    els.statusPill.innerHTML = `<span></span> ${paired ? "Connected" : "Offline"}`;
    els.hubName.textContent = hub.name || (paired ? state.connection.hubUrl : "-");
    els.hubMode.textContent = hub.mode || "-";
    els.hubTools.textContent = hub.tools_enabled === true ? "Hydra tools" : hub.tools_enabled === false ? "LLM only" : "-";
    els.chatContext.textContent = paired
      ? `${state.profile.userName || "User"} on ${state.profile.deviceName || "Little Spud"} via ${state.connection.hubUrl}`
      : "Pair with Tater to start.";
    els.messageInput.disabled = !paired;
    els.sendBtn.disabled = !paired;
    els.heartbeatBtn.disabled = !paired;
    els.disconnectBtn.disabled = !paired;
    updateTtsButton();
    updateSttButton();
    updateNotifyButton();
  }

  function renderMessages() {
    if (!state.messages.length) {
      els.messageList.innerHTML = `
        <div class="empty-state">
          <img class="empty-state-logo" src="./assets/new-tater-logo.png" alt="Tater" decoding="async" />
          <strong>Pocket Tater, ready when paired.</strong>
          <span>Once synced, messages from this device arrive at your Spud Hub with your Little Spud identity.</span>
        </div>
      `;
      return;
    }
    const typing = state.typing ? renderTypingMessage() : "";
    els.messageList.innerHTML = `${state.messages.map((message) => renderMessage(message)).join("")}${typing}`;
    wireMediaScrollFollow();
    scrollMessagesToBottom();
  }

  function scrollMessagesToBottom({ immediate = true } = {}) {
    if (!els.messageList) return;
    const scroll = () => {
      els.messageList.scrollTop = els.messageList.scrollHeight;
    };
    if (immediate) scroll();
    window.requestAnimationFrame?.(() => {
      scroll();
      window.requestAnimationFrame?.(scroll);
    });
    window.setTimeout(scroll, 80);
  }

  function isNearMessageBottom(tolerance = 220) {
    if (!els.messageList) return true;
    const remaining = els.messageList.scrollHeight - els.messageList.scrollTop - els.messageList.clientHeight;
    return remaining <= tolerance;
  }

  function wireMediaScrollFollow() {
    const messages = Array.from(els.messageList.querySelectorAll(".message"));
    const lastMessage = messages[messages.length - 1];
    if (!lastMessage) return;
    const mediaItems = lastMessage.querySelectorAll("img");
    mediaItems.forEach((item) => {
      if (item.dataset.scrollFollowBound === "true") return;
      item.dataset.scrollFollowBound = "true";
      item.addEventListener("load", () => {
        if (isNearMessageBottom()) scrollMessagesToBottom();
      }, { once: true });
    });
  }

  function renderMessage(message) {
    const role = message.role || "assistant";
    const label = role === "user" ? state.profile.userName || "You" : role === "system" ? "Little Spud" : "Tater";
    const media = Array.isArray(message.attachments) && message.attachments.length ? renderMediaGrid(message.attachments) : "";
    const assistantMedia = role === "assistant" ? renderLinkedMedia(message.content || "") : "";
    const id = escapeHtml(message.id || "");
    const body = role === "assistant"
      ? `${media}${assistantMedia}<div class="bubble">${linkify(escapeHtml(message.content || ""))}</div>`
      : `<div class="bubble">${linkify(escapeHtml(message.content || ""))}</div>${media}${assistantMedia}`;
    return `
      <article class="message ${escapeHtml(role)}" data-message-id="${id}">
        <div class="message-meta">${escapeHtml(label)}</div>
        ${body}
      </article>
    `;
  }

  function renderTypingMessage() {
    return `
      <article class="message assistant typing-message" data-message-id="typing">
        <div class="message-meta">Tater</div>
        <div class="bubble typing-bubble">
          <span class="typing-label">Tater is thinking</span>
          <span class="typing-dots" aria-hidden="true"><i></i><i></i><i></i></span>
        </div>
      </article>
    `;
  }

  function linkify(html) {
    return html.replace(/(https?:\/\/[^\s<]+)/g, (match) => {
      const clean = match.replace(/[),.]+$/, "");
      const suffix = match.slice(clean.length);
      return `<a href="${clean}" target="_blank" rel="noreferrer">${clean}</a>${suffix}`;
    });
  }

  function renderMediaGrid(attachments) {
    return `<div class="media-grid">${attachments.map(renderMediaCard).join("")}</div>`;
  }

  function renderMediaCard(file) {
    const name = escapeHtml(file.name || "attachment");
    const type = String(file.type || "");
    const src = file.previewUrl || file.dataUrl || "";
    if (type.startsWith("image/") && src) return `<div class="media-card"><img src="${src}" alt="${name}" loading="lazy" /><small>${name}</small></div>`;
    if (type.startsWith("video/") && src) return `<div class="media-card"><video src="${src}" controls preload="none" tabindex="-1"></video><small>${name}</small></div>`;
    if (type.startsWith("audio/") && src) return `<div class="media-card"><audio src="${src}" controls preload="none" tabindex="-1"></audio><small>${name}</small></div>`;
    return `<div class="media-card"><small>${name}<br>${escapeHtml(type || "file")} • ${escapeHtml(formatBytes(file.size))}</small></div>`;
  }

  function normalizeAssistantArtifacts(artifacts) {
    if (!Array.isArray(artifacts)) return [];
    return artifacts
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const mimetype = String(item.mimetype || item.mime_type || "").trim();
        const kind = String(item.type || "").trim().toLowerCase();
        const type = mimetype || (kind === "image" ? "image/remote" : kind === "video" ? "video/remote" : kind === "audio" ? "audio/remote" : "application/octet-stream");
        const url = String(item.previewUrl || item.preview_url || item.url || item.uri || "").trim();
        const previewUrl = spudLinkMediaUrl(url);
        return {
          id: String(item.id || item.file_id || "").trim(),
          name: String(item.name || item.filename || "attachment").trim() || "attachment",
          type,
          size: Number(item.size || 0) || 0,
          previewUrl,
          dataUrl: String(item.dataUrl || item.data_url || "").trim()
        };
      })
      .filter((item) => item && (item.previewUrl || item.dataUrl || item.name));
  }

  function renderLinkedMedia(content) {
    const urls = [
      ...Array.from(String(content || "").matchAll(/https?:\/\/[^\s<>()]+/g)).map((match) => match[0]),
      ...Array.from(String(content || "").matchAll(/\]\((\/[^)\s]+)\)/g)).map((match) => match[1])
    ];
    const media = urls
      .map((url) => {
        const clean = url.replace(/[),.]+$/, "");
        const previewUrl = clean.startsWith("/") && state.connection.hubUrl ? hubApiUrl(state.connection.hubUrl, clean) : clean;
        const lower = clean.toLowerCase();
        if (/\.(png|jpe?g|gif|webp)(\?|#|$)/.test(lower)) return { type: "image/remote", previewUrl, name: clean };
        if (/\.(mp4|webm|mov)(\?|#|$)/.test(lower)) return { type: "video/remote", previewUrl, name: clean };
        if (/\.(mp3|wav|ogg|m4a)(\?|#|$)/.test(lower)) return { type: "audio/remote", previewUrl, name: clean };
        return null;
      })
      .filter(Boolean);
    return media.length ? renderMediaGrid(media) : "";
  }

  function renderAttachments() {
    if (!state.attachments.length) {
      els.attachmentTray.innerHTML = "";
      return;
    }
    els.attachmentTray.innerHTML = state.attachments.map((file) => {
      const type = String(file.type || "file");
      const preview = type.startsWith("image/") && file.previewUrl
        ? `<img src="${file.previewUrl}" alt="" />`
        : type.startsWith("video/") && file.previewUrl
          ? `<video src="${file.previewUrl}" muted></video>`
          : `<span class="file-tile">${escapeHtml(type.split("/")[0] || "file")}</span>`;
      return `
        <div class="attachment-chip" data-id="${escapeHtml(file.id)}">
          ${preview}
          <span><strong>${escapeHtml(file.name)}</strong><small>${escapeHtml(formatBytes(file.size))}</small></span>
          <button type="button" class="icon-btn remove-attachment" data-remove-attachment="${escapeHtml(file.id)}" aria-label="Remove attachment">×</button>
        </div>
      `;
    }).join("");
  }

  function renderLayout() {
    const collapsed = Boolean(state.ui.sidebarCollapsed);
    els.app.classList.toggle("sidebar-collapsed", collapsed);
    els.sidebarToggleBtn.setAttribute("aria-expanded", String(!collapsed));
    els.sidebarToggleBtn.setAttribute("aria-label", collapsed ? "Show controls" : "Hide controls");
    els.sidebarToggleBtn.setAttribute("title", collapsed ? "Show controls" : "Hide controls");
  }

  function isMobileLayout() {
    return window.matchMedia?.("(max-width: 860px)")?.matches || window.innerWidth <= 860;
  }

  function setSidebarCollapsed(collapsed, { save = true } = {}) {
    state.ui.sidebarCollapsed = Boolean(collapsed);
    if (save) saveState();
    renderLayout();
  }

  function autoCollapseSidebarForMobile() {
    if (!isMobileLayout() || state.ui.sidebarCollapsed) return;
    setSidebarCollapsed(true, { save: false });
  }

  function renderAll() {
    renderLayout();
    els.userName.value = state.profile.userName;
    els.deviceName.value = state.profile.deviceName;
    els.hubUrl.value = state.connection.hubUrl;
    renderConnection();
    renderMessages();
    renderAttachments();
  }

  function decodeBase64Url(value) {
    const padded = String(value || "").replace(/-/g, "+").replace(/_/g, "/") + "===".slice((String(value || "").length + 3) % 4);
    return atob(padded);
  }

  function parseSyncPayload(rawInput, hubUrlInput) {
    const input = String(rawInput || "").trim();
    const fallbackHubUrl = normalizeUrl(hubUrlInput);
    if (!input) throw new Error("Enter a sync code or scan a QR payload.");

    let payload = null;
    if (input.startsWith("tater-spudlink://")) {
      const url = new URL(input);
      const data = url.searchParams.get("data") || "";
      if (!data) throw new Error("QR payload is missing data.");
      payload = JSON.parse(decodeBase64Url(data));
    } else if (input.startsWith("{") || input.startsWith("[")) {
      payload = JSON.parse(input);
    }

    if (payload && typeof payload === "object") {
      const payloadHubUrl = normalizeUrl(payload.hub_url || payload.server_url || fallbackHubUrl);
      const payloadPairUrl = normalizeUrl(payload.pair_url || "");
      const pairBaseUrl = hubBaseFromApiUrl(payloadPairUrl, "/api/spudlink/pair");
      const hubUrl = pairBaseUrl || payloadHubUrl;
      const pairUrl = payloadPairUrl || (hubUrl ? hubApiUrl(hubUrl, "/api/spudlink/pair") : "");
      const pairingCode = String(payload.pairing_code || payload.code || "").trim();
      if (!pairingCode) throw new Error("Pairing payload is missing a code.");
      if (!hubUrl && !pairUrl) throw new Error("Pairing payload is missing a Tater URL.");
      return { hubUrl: hubUrl || hubBaseFromApiUrl(pairUrl, "/api/spudlink/pair"), pairUrl, pairingCode };
    }

    if (!fallbackHubUrl) throw new Error("Enter the Tater URL when using a manual pairing code.");
    return {
      hubUrl: fallbackHubUrl,
      pairUrl: hubApiUrl(fallbackHubUrl, "/api/spudlink/pair"),
      pairingCode: input
    };
  }

  function endpointLabel(url) {
    try {
      const parsed = new URL(url, window.location.href);
      return parsed.origin;
    } catch {
      return String(url || "Tater");
    }
  }

  function payloadErrorMessage(payload, fallback) {
    if (payload?.detail) return String(payload.detail);
    if (payload?.error?.message) return String(payload.error.message);
    if (payload?.error) return String(payload.error);
    return fallback;
  }

  async function fetchJson(url, options, actionLabel) {
    let response;
    try {
      assertBrowserCanReach(url, actionLabel);
      response = await fetch(url, options);
    } catch (error) {
      if (error?.message && !/Load failed|Failed to fetch|NetworkError/i.test(String(error.message))) {
        throw error;
      }
      const reason = String(error?.message || error || "Load failed");
      throw new Error(
        `${actionLabel} could not reach ${endpointLabel(url)}. Browser said: ${reason}. Check the Tater URL, reverse proxy route, and that Tater is running.`
      );
    }
    const payload = await readJsonResponse(response);
    if (!response.ok || payload.ok === false || payload.error) {
      const detail = payloadErrorMessage(payload, response.statusText || `HTTP ${response.status}`);
      throw new Error(`${actionLabel} failed: ${detail}`);
    }
    return payload;
  }

  function parseSseBlock(block) {
    let event = "message";
    const data = [];
    for (const rawLine of String(block || "").split(/\r?\n/)) {
      if (!rawLine || rawLine.startsWith(":")) continue;
      const separator = rawLine.indexOf(":");
      const field = separator >= 0 ? rawLine.slice(0, separator) : rawLine;
      let value = separator >= 0 ? rawLine.slice(separator + 1) : "";
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") event = value.trim() || "message";
      if (field === "data") data.push(value);
    }
    return { event, data: data.join("\n") };
  }

  async function fetchChatCompletionStream(url, options, actionLabel, callbacks = {}) {
    let response;
    try {
      assertBrowserCanReach(url, actionLabel);
      response = await fetch(url, options);
    } catch (error) {
      if (error?.message && !/Load failed|Failed to fetch|NetworkError/i.test(String(error.message))) {
        throw error;
      }
      const reason = String(error?.message || error || "Load failed");
      throw new Error(
        `${actionLabel} could not reach ${endpointLabel(url)}. Browser said: ${reason}. Check the Tater URL, reverse proxy route, and that Tater is running.`
      );
    }

    if (!response.ok) {
      const payload = await readJsonResponse(response);
      const detail = payloadErrorMessage(payload, response.statusText || `HTTP ${response.status}`);
      throw new Error(`${actionLabel} failed: ${detail}`);
    }

    if (!response.body?.getReader) {
      return readJsonResponse(response);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    const meta = {};

    const handleEvent = (block) => {
      const parsed = parseSseBlock(block);
      if (!parsed.data) return false;
      if (parsed.data.trim() === "[DONE]") return true;
      let payload;
      try {
        payload = JSON.parse(parsed.data);
      } catch {
        return false;
      }
      if (parsed.event === "tater.tool") {
        callbacks.onTool?.(payload);
        return false;
      }
      if (parsed.event === "tater.meta") {
        if (payload?.spud_link) meta.spud_link = payload.spud_link;
        return false;
      }
      if (parsed.event === "tater.error") {
        throw new Error(payloadErrorMessage(payload, payload?.message || "Tater request failed."));
      }
      const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
      const delta = choice?.delta || {};
      if (typeof delta.content === "string") content += delta.content;
      const messageContent = choice?.message?.content;
      if (typeof messageContent === "string") content = messageContent;
      return false;
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split(/\n\n|\r\n\r\n/);
      buffer = blocks.pop() || "";
      for (const block of blocks) {
        if (handleEvent(block)) {
          await reader.cancel().catch(() => null);
          return {
            choices: [{ message: { role: "assistant", content } }],
            spud_link: meta.spud_link || {}
          };
        }
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) handleEvent(buffer);
    return {
      choices: [{ message: { role: "assistant", content } }],
      spud_link: meta.spud_link || {}
    };
  }

  async function fetchTaterChatStream(url, options, actionLabel, callbacks = {}) {
    let response;
    try {
      assertBrowserCanReach(url, actionLabel);
      response = await fetch(url, options);
    } catch (error) {
      if (error?.message && !/Load failed|Failed to fetch|NetworkError/i.test(String(error.message))) {
        throw error;
      }
      const reason = String(error?.message || error || "Load failed");
      throw new Error(
        `${actionLabel} could not reach ${endpointLabel(url)}. Browser said: ${reason}. Check the Tater URL, reverse proxy route, and that Tater is running.`
      );
    }

    if (!response.ok) {
      const payload = await readJsonResponse(response);
      const detail = payloadErrorMessage(payload, response.statusText || `HTTP ${response.status}`);
      throw new Error(`${actionLabel} failed: ${detail}`);
    }
    if (!response.body?.getReader) {
      return readJsonResponse(response);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const result = {
      content: "",
      artifacts: [],
      spud_link: {}
    };
    const seenToolNotices = new Set();

    const noticeKey = (notice) => [
      String(notice?.run_id || "").trim(),
      String(notice?.display_name || notice?.tool || "").trim(),
      String(notice?.text || notice?.wait_text || "").trim()
    ].join("|");

    const emitToolNotice = (notice) => {
      const key = noticeKey(notice);
      if (!key.trim() || seenToolNotices.has(key)) return;
      seenToolNotices.add(key);
      callbacks.onTool?.(notice);
    };

    const handleEvent = (block) => {
      const parsed = parseSseBlock(block);
      if (!parsed.data) return false;
      if (parsed.data.trim() === "[DONE]") return true;
      let payload;
      try {
        payload = JSON.parse(parsed.data);
      } catch {
        return false;
      }
      if (parsed.event === "tater.tool") {
        emitToolNotice(payload);
        return false;
      }
      if (parsed.event === "tater.message") {
        const notices = Array.isArray(payload?.tool_notices) ? payload.tool_notices : [];
        for (const notice of notices) emitToolNotice(notice);
        result.content = String(payload?.content || "");
        return false;
      }
      if (parsed.event === "tater.artifacts") {
        const artifacts = Array.isArray(payload?.artifacts) ? payload.artifacts : [];
        result.artifacts.push(...artifacts);
        result.spud_link.artifacts = result.artifacts;
        return false;
      }
      if (parsed.event === "tater.follow_up") {
        if (payload?.follow_up) result.spud_link.follow_up = payload.follow_up;
        return false;
      }
      if (parsed.event === "tater.error") {
        throw new Error(payloadErrorMessage(payload, payload?.message || "Tater request failed."));
      }
      if (parsed.event === "tater.done") {
        return true;
      }
      return false;
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split(/\n\n|\r\n\r\n/);
      buffer = blocks.pop() || "";
      for (const block of blocks) {
        if (handleEvent(block)) {
          await reader.cancel().catch(() => null);
          return result;
        }
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) handleEvent(buffer);
    return result;
  }

  async function fetchAudioBlob(url, options, actionLabel) {
    let response;
    try {
      assertBrowserCanReach(url, actionLabel);
      response = await fetch(url, options);
    } catch (error) {
      if (options?.signal?.aborted) throw error;
      if (error?.message && !/Load failed|Failed to fetch|NetworkError/i.test(String(error.message))) {
        throw error;
      }
      const reason = String(error?.message || error || "Load failed");
      throw new Error(`${actionLabel} could not reach ${endpointLabel(url)}. Browser said: ${reason}.`);
    }
    if (!response.ok) {
      const payload = await readJsonResponse(response);
      const detail = payloadErrorMessage(payload, response.statusText || `HTTP ${response.status}`);
      throw new Error(`${actionLabel} failed: ${detail}`);
    }
    return response.blob();
  }

  async function pairLittleSpud() {
    const userName = els.userName.value.trim();
    const deviceName = els.deviceName.value.trim() || detectDeviceName();
    if (!userName) throw new Error("Enter a user name first.");
    const sync = parseSyncPayload(els.syncCode.value, els.hubUrl.value);
    setStatus("Pairing with Tater...", "");
    const payload = await fetchJson(sync.pairUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pairing_code: sync.pairingCode,
        role: "little_spud",
        node_name: `${userName} on ${deviceName}`,
        metadata: {
          client: "little-spud-webui",
          client_version: CLIENT_VERSION,
          user_name: userName,
          device_name: deviceName,
          user_agent: navigator.userAgent || ""
        }
      })
    }, "Pairing");
    state.profile.userName = userName;
    state.profile.deviceName = deviceName;
    state.connection = {
      hubUrl: sync.hubUrl,
      token: payload.node_token || "",
      node: payload.node || null,
      hub: payload.hub || payload.server || null,
      pairedAt: Date.now(),
      lastSeenAt: Date.now()
    };
    if (!state.connection.token) throw new Error("Pairing succeeded but no node token was returned.");
    els.syncCode.value = "";
    saveState();
    renderAll();
    setStatus("Connected. Little Spud is ready.", "ok");
    await sendHeartbeat().catch(() => null);
    await syncHistoryFromHub().catch(() => null);
    scheduleNotificationPoll(0);
  }

  async function sendHeartbeat() {
    if (!isPaired()) throw new Error("Not paired.");
    const payload = await fetchJson(hubApiUrl(state.connection.hubUrl, "/api/spudlink/heartbeat"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        node_name: `${state.profile.userName || "User"} on ${state.profile.deviceName || "Little Spud"}`,
        mode: "little_spud",
        version: CLIENT_VERSION,
        stats: clientStats(),
        activity: {
          messages: state.messages.length,
          attachments_pending: state.attachments.length
        }
      })
    }, "Hub ping");
    state.connection.hub = payload.server || payload.hub || state.connection.hub;
    state.connection.node = payload.node || state.connection.node;
    state.connection.lastSeenAt = Date.now();
    saveState();
    renderConnection();
    return payload;
  }

  async function syncHistoryFromHub() {
    if (!isPaired()) return null;
    const payload = await fetchJson(hubApiUrl(state.connection.hubUrl, "/api/spudlink/v1/history?limit=80"), {
      method: "GET",
      headers: authHeaders()
    }, "History sync");
    mergeHubHistory(payload.messages);
    applyHubActiveRun(Array.isArray(payload.active_runs) ? payload.active_runs : payload.active_run);
    return payload;
  }

  function authHeaders(extra = {}) {
    return {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${state.connection.token}`,
      "X-SpudLink-User": state.profile.userName || "User",
      "X-SpudLink-Device": state.profile.deviceName || "Little Spud",
      ...extra
    };
  }

  function clientStats() {
    return {
      user_agent: navigator.userAgent || "",
      language: navigator.language || "",
      platform: navigator.userAgentData?.platform || navigator.platform || "",
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      online: navigator.onLine
    };
  }

  function stopTtsPlayback() {
    if (typeof state.tts.cleanup === "function") {
      state.tts.cleanup();
      state.tts.cleanup = null;
      return;
    }
    if (state.tts.abort) {
      state.tts.abort.abort();
      state.tts.abort = null;
    }
    if (state.tts.audio) {
      state.tts.audio.pause();
      state.tts.audio.removeAttribute("src");
      state.tts.audio.load();
      if (state.tts.audio !== els.ttsAudio) state.tts.audio = null;
    }
    if (state.tts.objectUrl) {
      URL.revokeObjectURL(state.tts.objectUrl);
      state.tts.objectUrl = "";
    }
  }

  async function unlockTtsAudio() {
    if (state.tts.unlocked) return;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) {
      if (!state.tts.audioContext) state.tts.audioContext = new AudioContextClass();
      if (state.tts.audioContext.state === "suspended") {
        await state.tts.audioContext.resume();
      }
    }
    if (els.ttsAudio) {
      els.ttsAudio.muted = true;
      els.ttsAudio.src = SILENT_WAV_DATA_URL;
      await els.ttsAudio.play().catch(() => null);
      els.ttsAudio.pause();
      els.ttsAudio.removeAttribute("src");
      els.ttsAudio.muted = false;
      els.ttsAudio.load();
    }
    state.tts.unlocked = true;
  }

  function setTtsEnabled(enabled) {
    state.ui.ttsEnabled = Boolean(enabled);
    if (state.ui.ttsEnabled) {
      setTtsStatus("TTS on");
      unlockTtsAudio().catch((error) => {
        state.tts.unlocked = false;
        setTtsStatus(`Tap again to allow audio: ${error.message}`, "error");
      });
    } else {
      stopTtsPlayback();
      setTtsStatus("");
    }
    saveState();
    updateTtsButton();
  }

  function textForTts(value) {
    return String(value || "")
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
      .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
      .replace(/https?:\/\/\S+/gi, " ")
      .replace(/[`*_#>~|]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 4000);
  }

  async function speakAssistantText(fullText) {
    if (!state.ui.ttsEnabled || !isPaired()) return;
    const text = textForTts(fullText);
    if (!text) return;
    stopTtsPlayback();
    setTtsStatus("Preparing voice...");
    if (!state.tts.unlocked) {
      await unlockTtsAudio().catch(() => null);
    }
    const controller = new AbortController();
    state.tts.abort = controller;
    try {
      const blob = await fetchAudioBlob(hubApiUrl(state.connection.hubUrl, "/api/spudlink/v1/tts/speech"), {
        method: "POST",
        headers: authHeaders(),
        signal: controller.signal,
        body: JSON.stringify({ text })
      }, "TTS");
      if (controller.signal.aborted || !state.ui.ttsEnabled) return;
      const objectUrl = URL.createObjectURL(blob);
      const audio = els.ttsAudio || new Audio();
      audio.pause();
      audio.muted = false;
      audio.src = objectUrl;
      state.tts.audio = audio;
      state.tts.objectUrl = objectUrl;
      state.tts.abort = null;
      let settled = false;
      const playbackDone = new Promise((resolve) => {
        const cleanup = () => {
          if (settled) return;
          settled = true;
          audio.removeEventListener("ended", cleanup);
          audio.removeEventListener("error", cleanup);
          if (state.tts.cleanup === cleanup) state.tts.cleanup = null;
          if (state.tts.audio === audio) {
            state.tts.audio = null;
            state.tts.objectUrl = "";
          }
          audio.pause();
          audio.removeAttribute("src");
          audio.load();
          URL.revokeObjectURL(objectUrl);
          if (state.ui.ttsEnabled) setTtsStatus("TTS on");
          resolve();
        };
        state.tts.cleanup = cleanup;
        audio.addEventListener("ended", cleanup);
        audio.addEventListener("error", cleanup);
      });
      audio.load();
      setTtsStatus("Speaking...");
      await audio.play();
      await playbackDone;
    } catch (error) {
      if (controller.signal.aborted) return;
      stopTtsPlayback();
      console.warn("Little Spud TTS failed", error);
      setTtsStatus(`TTS failed: ${error.message}`, "error");
      setStatus(`TTS failed: ${error.message}`, "error");
    } finally {
      if (state.tts.abort === controller) state.tts.abort = null;
    }
  }

  async function readJsonResponse(response) {
    const text = await response.text();
    if (!text) return {};
    try { return JSON.parse(text); }
    catch { return { error: text }; }
  }

  async function fileToAttachment(file) {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const type = file.type || "application/octet-stream";
    const base = {
      id,
      file,
      name: file.name || "attachment",
      type,
      size: file.size || 0,
      previewUrl: "",
      dataUrl: ""
    };
    if (type.startsWith("image/") || type.startsWith("video/") || type.startsWith("audio/")) {
      base.previewUrl = URL.createObjectURL(file);
    }
    if (type.startsWith("image/") && file.size <= MAX_IMAGE_SEND_BYTES) {
      base.dataUrl = await readFileAsDataUrl(file);
    }
    return base;
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error || new Error("File read failed."));
      reader.readAsDataURL(file);
    });
  }

  function insertTranscript(text) {
    const transcript = String(text || "").replace(/\s+/g, " ").trim();
    if (!transcript) return;
    const current = els.messageInput.value;
    const prefix = current && !/[\s\n]$/.test(current) ? " " : "";
    els.messageInput.value = `${current}${prefix}${transcript}`;
    els.messageInput.focus();
    els.messageInput.style.height = "auto";
    els.messageInput.style.height = `${Math.min(150, els.messageInput.scrollHeight)}px`;
  }

  function closeSttSocket() {
    const ws = state.stt.ws;
    state.stt.ws = null;
    if (!ws) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      try { ws.close(1000, "client-reset"); } catch {}
    }
  }

  function resetSttCapture({ closeSocket = false } = {}) {
    if (state.stt.stopTimer) clearTimeout(state.stt.stopTimer);
    state.stt.stopTimer = 0;
    if (state.stt.processor) {
      state.stt.processor.onaudioprocess = null;
      try { state.stt.processor.disconnect(); } catch {}
    }
    if (state.stt.source) {
      try { state.stt.source.disconnect(); } catch {}
    }
    if (state.stt.mute) {
      try { state.stt.mute.disconnect(); } catch {}
    }
    if (state.stt.stream) {
      for (const track of state.stt.stream.getTracks()) track.stop();
    }
    if (state.stt.audioContext) {
      state.stt.audioContext.close().catch(() => null);
    }
    state.stt.stream = null;
    state.stt.audioContext = null;
    state.stt.source = null;
    state.stt.processor = null;
    state.stt.mute = null;
    state.stt.startedAt = 0;
    if (closeSocket) closeSttSocket();
  }

  function cancelSttRecording(message = "", kind = "") {
    if (!state.stt.recording && !state.stt.submitting) return;
    state.stt.recording = false;
    state.stt.submitting = false;
    state.stt.chunks = [];
    resetSttCapture({ closeSocket: true });
    updateSttButton();
    if (message) setSpeechStatus(message, kind);
  }

  function sttStreamUrl(sampleRate) {
    const url = webSocketUrlFromHttpUrl(hubApiUrl(state.connection.hubUrl, "/api/spudlink/v1/stt/stream"));
    assertBrowserCanReach(url.toString(), "Voice input");
    url.searchParams.set("token", state.connection.token);
    url.searchParams.set("rate", String(Math.max(8000, Math.min(48000, Math.round(sampleRate || 16000)))));
    url.searchParams.set("bits", "16");
    url.searchParams.set("channels", "1");
    url.searchParams.set("language", navigator.language?.split("-")?.[0] || "");
    url.searchParams.set("user", state.profile.userName || "User");
    url.searchParams.set("device", state.profile.deviceName || "Little Spud");
    return url.toString();
  }

  function floatSamplesToPcm16(samples) {
    const buffer = new ArrayBuffer(samples.length * 2);
    const view = new DataView(buffer);
    for (let index = 0; index < samples.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, samples[index] || 0));
      view.setInt16(index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    }
    return buffer;
  }

  function finishSttStream(payload) {
    if (state.stt.finalReceived) return;
    state.stt.finalReceived = true;
    const transcript = String(payload?.text || "").trim();
    state.stt.recording = false;
    state.stt.submitting = false;
    resetSttCapture({ closeSocket: true });
    if (!transcript) {
      setSpeechStatus("No speech recognized. Try again.", "error");
      updateSttButton();
      return;
    }
    insertTranscript(transcript);
    updateSttButton();
    renderConnection();
    setSpeechStatus("Sending voice message...");
    void sendMessage(null, { fromVoice: true });
  }

  function handleSttStreamPayload(payload) {
    const type = String(payload?.type || "").toLowerCase();
    if (type === "listening") {
      setSpeechStatus("Listening... Tater will stop when you pause.");
      return;
    }
    if (type === "speech_start") {
      setSpeechStatus("Got it, keep talking...");
      return;
    }
    if (type === "speech_end") {
      state.stt.recording = false;
      state.stt.submitting = true;
      resetSttCapture();
      updateSttButton();
      setSpeechStatus("Transcribing...");
      return;
    }
    if (type === "final") {
      finishSttStream(payload);
      return;
    }
    if (type === "cancelled") {
      cancelSttRecording("Voice input cancelled.");
      return;
    }
    if (type === "error" || payload?.ok === false) {
      throw new Error(String(payload?.error || "Voice input failed."));
    }
  }

  async function openSttSocket(sampleRate) {
    const ws = new WebSocket(sttStreamUrl(sampleRate));
    ws.binaryType = "arraybuffer";
    state.stt.ws = ws;
    await new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error("Voice input connection timed out.")), 8000);
      ws.onopen = () => {
        window.clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        window.clearTimeout(timer);
        reject(new Error("Voice input stream failed to connect."));
      };
    });
    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(String(event.data || "{}"));
        handleSttStreamPayload(payload);
      } catch (error) {
        cancelSttRecording(`Voice input failed: ${error.message}`, "error");
        setStatus(`Voice input failed: ${error.message}`, "error");
      }
    };
    ws.onerror = () => {
      if (!state.stt.finalReceived) cancelSttRecording("Voice input stream failed.", "error");
    };
    ws.onclose = () => {
      if ((state.stt.recording || state.stt.submitting) && !state.stt.finalReceived) {
        cancelSttRecording("Voice input stream closed before Tater returned text.", "error");
      }
    };
    return ws;
  }

  async function startSttRecording() {
    if (!isPaired() || state.stt.submitting) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      setSpeechStatus("Mic access is not available in this browser.", "error");
      return;
    }
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) {
      setSpeechStatus("Audio capture is not available in this browser.", "error");
      return;
    }
    stopTtsPlayback();
    resetSttCapture({ closeSocket: true });
    state.stt.finalReceived = false;
    setSpeechStatus("Opening mic...");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      const audioContext = new AudioContextCtor();
      await audioContext.resume();
      const ws = await openSttSocket(audioContext.sampleRate || 16000);
      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      const mute = audioContext.createGain();
      mute.gain.value = 0;
      processor.onaudioprocess = (event) => {
        if (!state.stt.recording || ws.readyState !== WebSocket.OPEN) return;
        const input = event.inputBuffer.getChannelData(0);
        ws.send(floatSamplesToPcm16(input));
      };
      source.connect(processor);
      processor.connect(mute);
      mute.connect(audioContext.destination);
      state.stt.stream = stream;
      state.stt.audioContext = audioContext;
      state.stt.source = source;
      state.stt.processor = processor;
      state.stt.mute = mute;
      state.stt.sampleRate = audioContext.sampleRate || 16000;
      state.stt.startedAt = Date.now();
      state.stt.recording = true;
      state.stt.submitting = false;
      state.stt.stopTimer = window.setTimeout(() => {
        stopSttRecording();
      }, MAX_STT_SECONDS * 1000);
      setSpeechStatus("Listening... Tater will stop when you pause.");
    } catch (error) {
      resetSttCapture({ closeSocket: true });
      state.stt.recording = false;
      state.stt.submitting = false;
      setSpeechStatus(`Mic failed: ${error.message}`, "error");
    } finally {
      updateSttButton();
    }
  }

  function stopSttRecording() {
    if (!state.stt.recording && !state.stt.ws) return;
    state.stt.recording = false;
    state.stt.submitting = true;
    resetSttCapture();
    updateSttButton();
    setSpeechStatus("Transcribing...");
    const ws = state.stt.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "stop" }));
      return;
    }
    cancelSttRecording("Voice input stream was not connected.", "error");
  }

  function toggleSttRecording() {
    if (state.stt.recording) {
      stopSttRecording().catch((error) => setSpeechStatus(`Voice input failed: ${error.message}`, "error"));
      return;
    }
    startSttRecording().catch((error) => setSpeechStatus(`Voice input failed: ${error.message}`, "error"));
  }

  async function addFiles(fileList) {
    const files = Array.from(fileList || []).slice(0, 8);
    for (const file of files) {
      state.attachments.push(await fileToAttachment(file));
    }
    renderAttachments();
  }

  function buildAttachmentSummary(attachments) {
    if (!attachments.length) return "";
    const lines = attachments.map((item, index) => {
      const sendMode = item.dataUrl ? "included as image_url" : "previewed locally; metadata only";
      return `${index + 1}. ${item.name} (${item.type || "file"}, ${formatBytes(item.size)}, ${sendMode})`;
    });
    return `\n\nAttached media:\n${lines.join("\n")}`;
  }

  function buildMessageContent(text, attachments) {
    const summary = buildAttachmentSummary(attachments);
    const content = [{ type: "text", text: `${text || "Please review the attached media."}${summary}` }];
    for (const item of attachments) {
      if (item.dataUrl) {
        content.push({ type: "image_url", image_url: { url: item.dataUrl } });
      }
    }
    return content;
  }

  function historyForApi(currentContent) {
    const history = state.messages
      .filter((message) => message.role === "user" || message.role === "assistant")
      .filter((message) => message.meta?.kind !== "tool_notice")
      .slice(-MAX_HISTORY_MESSAGES)
      .map((message) => ({ role: message.role, content: message.content || "" }));
    history.push({ role: "user", content: currentContent });
    return history;
  }

  function historyForTater(excludeMessageId = "") {
    return state.messages
      .filter((message) => message.role === "user" || message.role === "assistant")
      .filter((message) => message.meta?.kind !== "tool_notice")
      .filter((message) => !excludeMessageId || String(message.id || "") !== String(excludeMessageId))
      .slice(-MAX_HISTORY_MESSAGES)
      .map((message) => ({ role: message.role, content: message.content || "" }));
  }

  function shouldReopenMicFromResponse(payload, { fromVoice = false } = {}) {
    if (!fromVoice || !isPaired()) return false;
    const followUp = payload?.spud_link?.follow_up;
    return Boolean(followUp?.enabled && followUp?.reopen_mic);
  }

  function appendToolNotice(notice) {
    const text = String(notice?.text || notice?.wait_text || "").trim();
    if (!text) return;
    state.messages.push({
      id: crypto.randomUUID?.() || `${Date.now()}-tool-notice`,
      role: "assistant",
      content: text,
      meta: {
        kind: "tool_notice",
        tool: String(notice?.display_name || notice?.tool || "").trim()
      },
      createdAt: Date.now()
    });
    renderMessages();
    saveState();
  }

  function reopenMicAfterReply() {
    if (!isPaired() || state.stt.recording || state.stt.submitting) return;
    setSpeechStatus("I'm listening...");
    window.setTimeout(() => {
      if (!isPaired() || state.stt.recording || state.stt.submitting) return;
      startSttRecording().catch((error) => setSpeechStatus(`Voice input failed: ${error.message}`, "error"));
    }, 250);
  }

  async function sendMessage(event, options = {}) {
    event?.preventDefault?.();
    if (!isPaired()) return;
    const fromVoice = Boolean(options?.fromVoice);
    let reopenMic = false;
    let pendingChatActive = false;
    let ttsPlayback = null;
    const text = els.messageInput.value.trim();
    const attachments = state.attachments.slice();
    if (!text && !attachments.length) return;
    const apiContent = buildMessageContent(text, attachments);
    const displayText = text || "Attached media";
    const userMessage = {
      id: crypto.randomUUID?.() || `${Date.now()}`,
      role: "user",
      content: displayText,
      attachments: attachments.map((item) => ({
        name: item.name,
        type: item.type,
        size: item.size,
        previewUrl: item.previewUrl,
        dataUrl: item.type.startsWith("image/") ? item.previewUrl : ""
      })),
      createdAt: Date.now()
    };
    state.messages.push(userMessage);
    state.attachments = [];
    els.messageInput.value = "";
    state.pendingChats = Number(state.pendingChats || 0) + 1;
    pendingChatActive = true;
    refreshTypingState();
    renderAll();
    saveState();
    const finishPendingChat = () => {
      if (!pendingChatActive) return;
      pendingChatActive = false;
      state.pendingChats = Math.max(0, Number(state.pendingChats || 0) - 1);
      refreshTypingState();
    };
    try {
      const payload = await fetchTaterChatStream(hubApiUrl(state.connection.hubUrl, "/api/spudlink/v1/tater/chat"), {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          user: state.profile.userName || "User",
          user_name: state.profile.userName || "User",
          device_name: state.profile.deviceName || "Little Spud",
          message: apiContent,
          history: historyForTater(userMessage.id),
          attachments: attachments.map((item) => ({ name: item.name, type: item.type, size: item.size })),
          metadata: {
            client: "little-spud-webui",
            client_version: CLIENT_VERSION,
            transport: "tater_native_event_stream"
          }
        })
      }, "Chat request", { onTool: appendToolNotice });
      const content = payload.content || "";
      const assistantAttachments = normalizeAssistantArtifacts(payload.artifacts || payload?.spud_link?.artifacts || []);
      if (!content.trim() && !assistantAttachments.length) {
        throw new Error("Tater returned no message content.");
      }
      finishPendingChat();
      reopenMic = shouldReopenMicFromResponse(payload, { fromVoice });
      const assistantId = crypto.randomUUID?.() || `${Date.now()}-assistant`;
      const assistantMessage = {
        id: assistantId,
        role: "assistant",
        content: "",
        attachments: assistantAttachments,
        createdAt: Date.now()
      };
      const responseText = content;
      ttsPlayback = state.ui.ttsEnabled ? speakAssistantText(responseText).catch(() => null) : null;
      if (ttsPlayback) {
        await Promise.race([ttsPlayback, sleep(TTS_START_GRACE_MS)]);
      }
      refreshTypingState();
      state.messages.push(assistantMessage);
      renderMessages();
      await revealAssistantMessage(assistantId, responseText);
      await sendHeartbeat().catch(() => null);
      await syncHistoryFromHub().catch(() => null);
    } catch (error) {
      finishPendingChat();
      state.messages.push({
        id: crypto.randomUUID?.() || `${Date.now()}-error`,
        role: "system",
        content: `Request failed: ${error.message}`,
        createdAt: Date.now()
      });
    } finally {
      finishPendingChat();
      saveState();
      renderAll();
    }
    if (reopenMic) {
      if (ttsPlayback) await ttsPlayback;
      reopenMicAfterReply();
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function revealAssistantMessage(messageId, fullText) {
    const text = String(fullText || "");
    const message = state.messages.find((item) => item.id === messageId);
    if (!message) return;
    const article = els.messageList.querySelector(`[data-message-id="${escapeAttributeSelector(messageId)}"]`);
    const bubble = article?.querySelector(".bubble");
    if (!bubble || !text) {
      message.content = text;
      return;
    }
    const chunkSize = text.length > 900 ? 10 : text.length > 420 ? 6 : 3;
    for (let index = 0; index < text.length; index += chunkSize) {
      bubble.textContent = text.slice(0, index + chunkSize);
      scrollMessagesToBottom({ immediate: true });
      await sleep(12);
    }
    message.content = text;
    saveState();
    renderMessages();
  }

  async function startScanner() {
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus("Camera access is not available in this browser.", "error");
      return;
    }
    if (!("BarcodeDetector" in window)) {
      setStatus("QR camera scan is not supported in this browser. Paste the sync payload instead.", "error");
      return;
    }
    stopScanner();
    els.scannerDialog.showModal();
    els.scannerStatus.textContent = "Camera starting...";
    state.scanner.detector = new BarcodeDetector({ formats: ["qr_code"] });
    state.scanner.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
    els.scannerVideo.srcObject = state.scanner.stream;
    await els.scannerVideo.play();
    els.scannerStatus.textContent = "Point the camera at the Little Spud QR.";
    scanFrame();
  }

  async function scanFrame() {
    if (!state.scanner.stream || !state.scanner.detector) return;
    try {
      const results = await state.scanner.detector.detect(els.scannerVideo);
      const value = results?.[0]?.rawValue || "";
      if (value) {
        els.syncCode.value = value;
        stopScanner();
        els.scannerDialog.close();
        setStatus("QR scanned. Confirm user/device name, then connect.", "ok");
        return;
      }
    } catch (error) {
      els.scannerStatus.textContent = `Scan failed: ${error.message}`;
    }
    state.scanner.raf = requestAnimationFrame(scanFrame);
  }

  function stopScanner() {
    if (state.scanner.raf) cancelAnimationFrame(state.scanner.raf);
    state.scanner.raf = 0;
    if (state.scanner.stream) {
      for (const track of state.scanner.stream.getTracks()) track.stop();
    }
    state.scanner.stream = null;
    if (els.scannerVideo) els.scannerVideo.srcObject = null;
  }

  function disconnect() {
    stopTtsPlayback();
    resetSttCapture({ closeSocket: true });
    clearHistorySyncTimer();
    clearNotificationPollTimer();
    state.notifications.polling = false;
    state.stt.recording = false;
    state.stt.submitting = false;
    state.connection = { hubUrl: "", token: "", node: null, hub: null, pairedAt: 0, lastSeenAt: 0 };
    saveState();
    renderAll();
    setStatus("Pairing removed from this browser.", "");
  }

  function bindEvents() {
    els.sidebarToggleBtn.addEventListener("click", () => {
      setSidebarCollapsed(!state.ui.sidebarCollapsed);
    });
    els.sidebarScrim?.addEventListener("click", () => {
      if (isMobileLayout()) setSidebarCollapsed(true);
    });
    els.userName.addEventListener("input", () => { state.profile.userName = els.userName.value.trim(); saveState(); renderConnection(); });
    els.deviceName.addEventListener("input", () => { state.profile.deviceName = els.deviceName.value.trim(); saveState(); renderConnection(); });
    els.hubUrl.addEventListener("input", () => { if (!isPaired()) state.connection.hubUrl = normalizeUrl(els.hubUrl.value); saveState(); });
    els.pairBtn.addEventListener("click", () => pairLittleSpud().catch((error) => setStatus(error.message, "error")));
    els.heartbeatBtn.addEventListener("click", () => sendHeartbeat().then(() => setStatus("Hub ping succeeded.", "ok")).catch((error) => setStatus(error.message, "error")));
    els.notifyBtn?.addEventListener("click", () => toggleBrowserNotifications().catch(() => updateNotifyButton()));
    els.disconnectBtn.addEventListener("click", disconnect);
    els.clearChatBtn.addEventListener("click", () => { stopTtsPlayback(); state.messages = []; saveState(); renderMessages(); });
    els.composer.addEventListener("submit", sendMessage);
    els.attachBtn.addEventListener("click", () => els.fileInput.click());
    els.cameraBtn.addEventListener("click", () => els.cameraInput.click());
    els.ttsToggleBtn.addEventListener("click", () => setTtsEnabled(!state.ui.ttsEnabled));
    els.sttBtn.addEventListener("click", toggleSttRecording);
    els.fileInput.addEventListener("change", (event) => addFiles(event.target.files).finally(() => { event.target.value = ""; }));
    els.cameraInput.addEventListener("change", (event) => addFiles(event.target.files).finally(() => { event.target.value = ""; }));
    els.attachmentTray.addEventListener("click", (event) => {
      const id = event.target?.closest?.("[data-remove-attachment]")?.getAttribute("data-remove-attachment");
      if (!id) return;
      const removed = state.attachments.find((item) => item.id === id);
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      state.attachments = state.attachments.filter((item) => item.id !== id);
      renderAttachments();
    });
    els.messageInput.addEventListener("input", () => {
      els.messageInput.style.height = "auto";
      els.messageInput.style.height = `${Math.min(150, els.messageInput.scrollHeight)}px`;
    });
    els.messageInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        els.composer.requestSubmit();
      }
    });
    els.scanBtn.addEventListener("click", () => startScanner().catch((error) => setStatus(error.message, "error")));
    els.scannerDialog.addEventListener("close", stopScanner);
    els.scannerClose.addEventListener("click", stopScanner);
    window.addEventListener("online", renderConnection);
    window.addEventListener("offline", renderConnection);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && isPaired()) {
        syncHistoryFromHub().catch(() => null);
        scheduleNotificationPoll(0);
      }
      updateNotifyButton();
    });
    window.addEventListener("resize", autoCollapseSidebarForMobile);
    window.addEventListener("orientationchange", () => window.setTimeout(autoCollapseSidebarForMobile, 120));
    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && isMobileLayout() && !state.ui.sidebarCollapsed) {
        setSidebarCollapsed(true);
      }
    });
  }

  function init() {
    loadState();
    if (!state.profile.deviceName) state.profile.deviceName = detectDeviceName();
    autoCollapseSidebarForMobile();
    bindEvents();
    renderAll();
    if (isPaired()) {
      sendHeartbeat()
        .then(() => syncHistoryFromHub().catch(() => null))
        .then(() => scheduleNotificationPoll(0))
        .catch((error) => setStatus(`Hub ping failed: ${error.message}`, "error"));
      scheduleNotificationPoll(1000);
    }
    if ("serviceWorker" in navigator && location.protocol !== "file:") {
      navigator.serviceWorker.register("./sw.js").catch(() => null);
    }
  }

  init();
})();
