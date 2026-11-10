(() => {
  "use strict";

  const cfg = window.CHATFLOW_CONFIG || {};
  const configured = cfg.SUPABASE_URL && !cfg.SUPABASE_URL.includes("YOUR_PROJECT_ID")
    && cfg.SUPABASE_ANON_KEY && !cfg.SUPABASE_ANON_KEY.includes("YOUR_SUPABASE");
  const $ = (id) => document.getElementById(id);
  const state = {
    supabase: null, user: null, profile: null,
    profileDraft: { avatarFile: null, previewUrl: null, removeAvatar: false },
    savingProfile: false, avatarRefreshTimer: null, conversations: [], activeId: null,
    messages: [], subscriptions: [], isRegister: false, deferredInstall: null,
    typingTimeout: null, typingChannel: null, toastTimeout: null,
    hasOlderMessages: false, loadingOlderMessages: false, reactions: [], readReceipts: [],
    selectedAttachment: null, attachmentPreviewUrl: null, recorder: null,
    recordingStream: null, recordingChunks: [], recordingStartedAt: 0,
    recordingTimer: null, recordingPausedAt: 0, recordingPausedDuration: 0,
    cancelRecording: false, requestingMicrophone: false, sendingMessage: false, activeUpload: null,
    readObserver: null, pendingReadMessageIds: new Set(), directorySearchTimer: null,
    directoryRequestId: 0, directorySuggestionRequestId: 0, directoryProfiles: new Map(),
    profileRequestId: 0, viewedProfileId: null, contactingProfileIds: new Set(), unreadCounts: new Map(),
    groupAvatarDraft: { file: null, previewUrl: null, remove: false }, savingGroupDetails: false,
    addingGroupMembers: false, deletingGroup: false,
    notificationWelcomeUsers: new Set(),
    notificationPreferences: { desktop_enabled: false, push_enabled: false, sound_enabled: true, previews_enabled: true },
    seenIncomingMessageIds: new Set(), notificationToasts: new Map(),
    serviceWorkerRegistration: null, audioContext: null, unreadSetupWarningShown: false,
    openingProfileId: null
  };
  const MESSAGE_PAGE_SIZE = 50;
  const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024;
  const MAX_AVATAR_SIZE = 5 * 1024 * 1024;
  const PROFILE_LOAD_TIMEOUT_MS = 15000;
  const ATTACHMENT_BUCKET = "chat-attachments";
  const PROFILE_BUCKET = "avatars";
  const GROUP_AVATAR_BUCKET = "group-avatars";
  const REACTION_EMOJIS = ["👍", "❤️", "😂", "🎉"];

  const escapeText = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[ch]));
  const initials = (name) => (String(name || "?").trim().split(/\s+/).slice(0, 2).map(x => x[0] || "").join("") || "?").toUpperCase();
  const friendlyError = (error, operation = "") => {
    const message = error?.message || "Something went wrong.";
    const errorText = [error?.message, error?.details, error?.hint].filter(Boolean).join(" ");
    if (/function public\.(search_public_profiles|get_public_profile|suggest_public_profiles)/i.test(errorText)) {
      return "Profile discovery is not configured yet. Run supabase/profile_discovery.sql in the Supabase SQL Editor.";
    }
    if (/function public\.get_unread_message_counts/i.test(errorText)) {
      return "Unread counts are not configured yet. Run supabase/notifications.sql in the Supabase SQL Editor.";
    }
    if (/set_direct_contact_hidden|hidden_at/i.test(errorText)) {
      return "Contact removal is not configured yet. Run supabase/contact_management.sql in the Supabase SQL Editor.";
    }
    if (/column .* does not exist|could not find the .*column|PGRST204/i.test(errorText)) {
      return "The profile database migration is missing. Run supabase/profile_avatars.sql in Supabase first, then refresh the app.";
    }
    if (/invalid login credentials/i.test(message)) return "Email or password is incorrect.";
    if (/email not confirmed/i.test(message)) return "Please confirm your email before signing in.";
    if (/duplicate key|unique constraint/i.test(message) && /username/i.test(message)) return "That username is already in use.";
    if (/duplicate key|already exists/i.test(message)) return "That conversation already exists.";
    if (/row-level security|permission denied/i.test(message)) {
      if (operation === "avatar upload" || operation === "avatar removal") {
        return "Supabase Storage denied this avatar operation. Apply supabase/profile_avatars.sql and confirm Storage policies allow your authenticated user to access only their own UUID folder.";
      }
      if (operation === "profile update") {
        return "Supabase denied the profile update. Apply supabase/profile_avatars.sql, then reload the app so it uses the updated database permissions.";
      }
      return "You don't have permission to do that. Check the Supabase policies and migration setup.";
    }
    if (/bucket|storage.*not|does not exist/i.test(message)) return "Profile image storage is not configured yet. Apply supabase/profile_avatars.sql in Supabase first.";
    return message;
  };
  function getProfileDisplayName(profile = state.profile, fallback = state.user) {
    const source = profile ?? {};
    return source.display_name || fallback?.user_metadata?.display_name || fallback?.email?.split("@")[0] || "ChatFlow user";
  }
  function getProfileAvatarUrl(profile = state.profile) {
    if (profile?.avatar_resolution_failed) return "";
    return profile?.avatar_signed_url || profile?.avatar_url || "";
  }
  function hasStoredAvatar(profile = state.profile) {
    return !!(profile?.avatar_path || profile?.avatar_url);
  }
  function applyAvatarStyles(element, profile = state.profile, fallbackText = "?") {
    if (!element) return;
    const avatarUrl = getProfileAvatarUrl(profile);
    let safeUrl = "";
    if (avatarUrl) {
      try {
        const parsed = new URL(avatarUrl, window.location.href);
        if (["https:", "http:", "blob:"].includes(parsed.protocol)) safeUrl = parsed.href;
      } catch (error) {
        console.warn("Invalid profile avatar URL", error);
      }
    }
    element.textContent = safeUrl ? "" : fallbackText;
    element.style.backgroundImage = safeUrl ? `url(${JSON.stringify(safeUrl)})` : "";
    element.style.backgroundSize = "cover";
    element.style.backgroundPosition = "center";
    element.style.backgroundRepeat = "no-repeat";
    element.classList.toggle("avatar-photo", !!safeUrl);
  }
  const ico = (name, cls = "ico") => `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  function setRecordState(on) {
    const button = $("record-audio");
    const label = on ? "Stop recording" : "Record voice message";
    button.classList.toggle("recording", on);
    button.title = label;
    button.setAttribute("aria-label", label);
  }
  function setPauseState(paused) {
    const button = $("pause-recording");
    const label = paused ? "Resume recording" : "Pause recording";
    button.classList.toggle("paused", paused);
    button.title = label;
    button.setAttribute("aria-label", label);
  }
  function setSendState(label, percent) {
    const form = $("message-form"), b = form.querySelector('[type="submit"]'), text = label || "Send message";
    b.classList.toggle("busy", !!label); b.title = text; b.setAttribute("aria-label", text);
    form.classList.toggle("uploading", percent != null);
    form.style.setProperty("--upload", `${percent || 0}%`);
  }
  function formatChatTime(iso) {
    if (!iso) return "";
    const d = new Date(iso), now = new Date(), days = (now - d) / 864e5;
    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    if (days < 7) return d.toLocaleDateString([], { weekday: "short" });
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  }
  function notice(id, message, success = false) {
    const el = $(id); if (!el) return;
    el.textContent = message || ""; el.classList.toggle("success", !!success);
  }
  function toast(message) {
    const el = $("app-notice"); el.textContent = message; el.classList.add("show");
    clearTimeout(state.toastTimeout);
    state.toastTimeout = setTimeout(() => el.classList.remove("show"), 3200);
  }
  function getNotificationPreview(message) {
    if (!state.notificationPreferences.previews_enabled) return "You have a new message.";
    const text = message.content?.trim() || (message.message_type === "image" ? "Photo"
      : message.message_type === "video" ? "Video"
        : message.message_type === "audio" ? "Voice message"
          : message.attachment_name ? `File: ${message.attachment_name}` : "New message");
    return text.length > 120 ? `${text.slice(0, 117)}…` : text;
  }
  function updateServiceWorkerConversationState() {
    const controller = navigator.serviceWorker?.controller;
    if (!controller) return;
    controller.postMessage({
      type: "CHATFLOW_ACTIVE_CONVERSATION",
      conversationId: state.activeId,
      visible: !!state.user && !!state.activeId && document.visibilityState === "visible" && document.hasFocus()
    });
  }
  function updateUnreadIndicators() {
    const total = [...state.unreadCounts.values()].reduce((sum, count) => sum + count, 0);
    document.title = total > 0 ? `(${total}) ChatFlow` : "ChatFlow — Real-time chat";
    const badge = $("total-unread-badge");
    badge.textContent = total > 99 ? "99+" : String(total);
    badge.classList.toggle("hidden", total < 1);
    if (navigator.setAppBadge) navigator.setAppBadge(total).catch(error => console.warn("Could not update app badge", error));
    if (!total && navigator.clearAppBadge) navigator.clearAppBadge().catch(error => console.warn("Could not clear app badge", error));
    renderConversations();
  }
  async function refreshUnreadCounts() {
    if (!state.user) return;
    const { data, error } = await state.supabase.rpc("get_unread_message_counts");
    if (error) {
      console.warn("Could not reconcile unread counts", error);
      if (!state.unreadSetupWarningShown) {
        state.unreadSetupWarningShown = true;
        toast(friendlyError(error));
      }
      return;
    }
    state.unreadCounts = new Map((data || []).map(row => [row.conversation_id, Number(row.unread_count)]));
    updateUnreadIndicators();
  }
  async function loadNotificationPreferences() {
    const { data, error } = await state.supabase.from("notification_preferences")
      .select("desktop_enabled, push_enabled, sound_enabled, previews_enabled")
      .eq("user_id", state.user.id)
      .maybeSingle();
    if (error) {
      console.warn("Could not load notification preferences", error);
      toast("Notification settings are not configured. Apply supabase/notifications.sql.");
      return;
    }
    if (data) state.notificationPreferences = { ...state.notificationPreferences, ...data };
  }
  async function saveNotificationPreferences(patch) {
    const next = { ...state.notificationPreferences, ...patch };
    const { error } = await state.supabase.from("notification_preferences").upsert({
      user_id: state.user.id,
      ...next
    }, { onConflict: "user_id" });
    if (error) throw error;
    state.notificationPreferences = next;
    syncNotificationSettingsUI();
  }
  function syncNotificationSettingsUI() {
    $("desktop-notifications-enabled").checked = state.notificationPreferences.desktop_enabled;
    $("notification-sound-enabled").checked = state.notificationPreferences.sound_enabled;
    $("notification-previews-enabled").checked = state.notificationPreferences.previews_enabled;
    const permission = !("Notification" in window)
      ? "Browser notifications are unsupported. In-app alerts and unread counts remain available."
      : Notification.permission === "granted" ? "Browser permission: allowed."
        : Notification.permission === "denied" ? "Browser permission: blocked in browser settings."
          : "Browser permission: not requested.";
    $("notification-permission-status").textContent = permission;
    $("push-notifications-button").textContent = state.notificationPreferences.push_enabled ? "Disable push" : "Enable push";
    if (state.notificationPreferences.push_enabled) {
      $("push-notification-status").textContent = "Push subscription is saved for this account.";
    } else if (!("PushManager" in window) || !("serviceWorker" in navigator)) {
      $("push-notification-status").textContent = "Push is unsupported in this browser. In-app alerts remain available.";
    } else if (!cfg.VAPID_PUBLIC_KEY) {
      $("push-notification-status").textContent = "Add the public VAPID key to js/config.js and deploy the Edge Function.";
    } else {
      $("push-notification-status").textContent = "Enable push to receive messages when ChatFlow is closed.";
    }
  }
  async function openNotificationSettings() {
    syncNotificationSettingsUI();
    notice("notification-settings-message", "");
    if (!$("notification-settings-dialog").open) $("notification-settings-dialog").showModal();
  }
  function urlBase64ToUint8Array(value) {
    const padding = "=".repeat((4 - value.length % 4) % 4);
    const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(base64);
    return Uint8Array.from(raw, character => character.charCodeAt(0));
  }
  async function togglePushNotifications() {
    const button = $("push-notifications-button");
    button.disabled = true;
    notice("notification-settings-message", "");
    try {
      if (state.notificationPreferences.push_enabled) {
        const registration = state.serviceWorkerRegistration || await navigator.serviceWorker.ready;
        const subscription = await registration.pushManager.getSubscription();
        await saveNotificationPreferences({ push_enabled: false });
        if (subscription) {
          const { error } = await state.supabase.from("push_subscriptions")
            .delete().eq("user_id", state.user.id).eq("endpoint", subscription.endpoint);
          if (error) throw error;
          await subscription.unsubscribe();
        }
        notice("notification-settings-message", "Push notifications are disabled.", true);
        return;
      }
      if (!("Notification" in window) || !("PushManager" in window) || !("serviceWorker" in navigator)) {
        throw new Error("Push notifications are not supported by this browser.");
      }
      if (!window.isSecureContext) throw new Error("Push notifications require HTTPS or localhost.");
      if (!cfg.VAPID_PUBLIC_KEY) throw new Error("Push is not configured. Add the public VAPID key and deploy the Supabase Edge Function first.");
      const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
      if (permission !== "granted") throw new Error(permission === "denied" ? "Notification permission is blocked in browser settings." : "Notification permission was not granted.");
      const registration = state.serviceWorkerRegistration || await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription()
        || await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(cfg.VAPID_PUBLIC_KEY)
        });
      const json = subscription.toJSON();
      if (!subscription.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
        throw new Error("The browser returned an incomplete push subscription.");
      }
      const { error } = await state.supabase.from("push_subscriptions").upsert({
        user_id: state.user.id,
        endpoint: subscription.endpoint,
        p256dh: json.keys.p256dh,
        auth: json.keys.auth
      }, { onConflict: "endpoint" });
      if (error) {
        try {
          await subscription.unsubscribe();
        } catch (cleanupError) {
          console.error("Could not remove push subscription after saving it failed", cleanupError);
        }
        throw error;
      }
      try {
        await saveNotificationPreferences({ push_enabled: true });
      } catch (preferenceError) {
        const { error: cleanupError } = await state.supabase.from("push_subscriptions")
          .delete().eq("user_id", state.user.id).eq("endpoint", subscription.endpoint);
        if (cleanupError) console.error("Could not remove push subscription after saving preferences failed", cleanupError);
        try {
          await subscription.unsubscribe();
        } catch (unsubscribeError) {
          console.error("Could not unsubscribe after saving preferences failed", unsubscribeError);
        }
        throw preferenceError;
      }
      notice("notification-settings-message", "Push subscription saved. Server delivery is ready when the Supabase webhook is deployed.", true);
    } catch (error) {
      notice("notification-settings-message", friendlyError(error));
    } finally {
      button.disabled = false;
      syncNotificationSettingsUI();
    }
  }
  async function setDesktopNotifications(enabled, messageId = "notification-settings-message") {
    try {
      if (enabled) {
        if (!("Notification" in window)) throw new Error("Browser notifications are not supported.");
        const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
        if (permission !== "granted") throw new Error(permission === "denied" ? "Notifications are blocked in browser settings." : "Notification permission was not granted.");
      }
      await saveNotificationPreferences({ desktop_enabled: enabled });
      notice(messageId, enabled ? "Desktop notifications are enabled." : "Desktop notifications are disabled.", true);
      return true;
    } catch (error) {
      $("desktop-notifications-enabled").checked = state.notificationPreferences.desktop_enabled;
      notice(messageId, friendlyError(error));
      return false;
    } finally {
      syncNotificationSettingsUI();
    }
  }
  function playNotificationSound() {
    if (!state.notificationPreferences.sound_enabled) return;
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return;
      state.audioContext ||= new AudioContextClass();
      if (state.audioContext.state === "suspended") {
        state.audioContext.resume().catch(error => console.warn("Could not resume notification audio", error));
      }
      const oscillator = state.audioContext.createOscillator();
      const gain = state.audioContext.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = 660;
      gain.gain.setValueAtTime(0.035, state.audioContext.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, state.audioContext.currentTime + 0.12);
      oscillator.connect(gain);
      gain.connect(state.audioContext.destination);
      oscillator.start();
      oscillator.stop(state.audioContext.currentTime + 0.12);
    } catch (error) {
      console.warn("Notification sound is unavailable", error);
    }
  }
  function showMessageToast(message, conversation, sender) {
    const region = $("notification-toasts");
    const card = document.createElement("button");
    card.type = "button";
    card.className = "message-toast";
    const avatar = document.createElement("span");
    avatar.className = "avatar";
    applyAvatarStyles(avatar, sender, initials(getProfileDisplayName(sender, null)));
    const copy = document.createElement("span");
    copy.className = "message-toast-copy";
    const name = document.createElement("strong");
    name.textContent = getProfileDisplayName(sender, null);
    const preview = document.createElement("span");
    preview.textContent = getNotificationPreview(message);
    const time = document.createElement("time");
    time.textContent = new Date(message.created_at || Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    copy.append(name, preview);
    card.append(avatar, copy, time);
    const toastId = message.id;
    card.addEventListener("click", async () => {
      clearTimeout(state.notificationToasts.get(toastId)?.timeout);
      state.notificationToasts.delete(toastId);
      card.remove();
      await openConversation(conversation.id);
    });
    region.append(card);
    const timeout = setTimeout(() => {
      card.remove();
      state.notificationToasts.delete(toastId);
    }, 5000);
    state.notificationToasts.set(toastId, { element: card, timeout });
    while (region.children.length > 4) {
      const oldest = region.firstElementChild;
      const oldId = [...state.notificationToasts].find(([, entry]) => entry.element === oldest)?.[0];
      if (oldId) {
        clearTimeout(state.notificationToasts.get(oldId).timeout);
        state.notificationToasts.delete(oldId);
      }
      oldest.remove();
    }
  }
  async function showDesktopNotification(message, conversation, sender) {
    if (!state.notificationPreferences.desktop_enabled
      || !("Notification" in window)
      || Notification.permission !== "granted") return;
    const options = {
      body: getNotificationPreview(message),
      icon: sender.avatar_signed_url || "./assets/icons/icon-192.png",
      badge: "./assets/icons/icon-192.png",
      tag: `chatflow-message-${message.id}`,
      data: { conversationId: conversation.id, messageId: message.id }
    };
    try {
      const registration = state.serviceWorkerRegistration || await navigator.serviceWorker?.ready;
      if (registration?.showNotification) {
        await registration.showNotification(getProfileDisplayName(sender, null), options);
      } else {
        const notification = new Notification(getProfileDisplayName(sender, null), options);
        notification.onclick = () => {
          window.focus();
          openConversation(conversation.id);
          notification.close();
        };
      }
    } catch (error) {
      console.warn("Could not display desktop notification", error);
    }
  }
  function setAuthMode(register) {
    state.isRegister = register;
    $("auth-title").textContent = register ? "Create your account" : "Welcome back";
    $("auth-subtitle").textContent = register ? "Join ChatFlow and start connecting." : "Sign in to continue your conversations.";
    $("name-field").classList.toggle("hidden", !register);
    $("display-name").required = register;
    $("auth-submit").textContent = register ? "Create account" : "Sign in";
    $("auth-switch-label").textContent = register ? "Already have an account?" : "New to ChatFlow?";
    $("auth-switch").textContent = register ? "Sign in" : "Create an account";
    $("password").autocomplete = register ? "new-password" : "current-password";
    notice("auth-message", "");
  }
  function showAuth() {
    $("auth-screen").classList.remove("hidden");
    $("app-screen").classList.add("hidden");
  }
  function showApp() {
    $("auth-screen").classList.add("hidden");
    $("app-screen").classList.remove("hidden");
  }
  async function fetchProfileRecord(user) {
    const selectFields = "id, display_name, email, avatar_url, avatar_path, username, bio, status_message, updated_at, created_at";
    const { data, error } = await state.supabase.from("profiles").select(selectFields).eq("id", user.id).maybeSingle();
    if (error) throw error;
    return data || null;
  }
  async function ensureProfile(user) {
    const existing = await fetchProfileRecord(user);
    if (!existing) throw new Error("Your profile record could not be found. Sign out and back in; if this continues, check the profile trigger in Supabase.");
    return resolveProfileAvatar({ ...existing, username: existing.username || "", bio: existing.bio || "", status_message: existing.status_message || "" });
  }
  function renderProfileHeader() {
    const name = getProfileDisplayName();
    $("my-name").textContent = name;
    applyAvatarStyles($("my-avatar"), state.profile, initials(name));
    if ($("profile-avatar-preview") && !$("profile-dialog").open) {
      renderProfilePreview(getProfileAvatarUrl(state.profile));
    }
  }
  async function resolveProfileAvatar(profile) {
    const avatarPath = profile?.avatar_path || getLegacyAvatarPath(profile);
    if (!avatarPath) return profile;
    const { data, error } = await state.supabase.storage.from(PROFILE_BUCKET)
      .createSignedUrl(avatarPath, 3600);
    if (error) {
      console.warn(`Could not sign avatar for profile ${profile.id}`, error);
      return { ...profile, avatar_path: avatarPath, avatar_signed_url: "", avatar_resolution_failed: true };
    }
    return { ...profile, avatar_path: avatarPath, avatar_signed_url: data.signedUrl, avatar_resolution_failed: false };
  }
  function getLegacyAvatarPath(profile) {
    if (!profile?.avatar_url || !cfg.SUPABASE_URL) return null;
    try {
      const avatar = new URL(profile.avatar_url);
      const projectOrigin = new URL(cfg.SUPABASE_URL).origin;
      if (avatar.origin !== projectOrigin) return null;
      const match = avatar.pathname.match(/^\/storage\/v1\/object\/(?:public|sign)\/avatars\/(.+)$/);
      if (!match) return null;
      const path = decodeURIComponent(match[1]);
      const ownerId = profile.id || state.user?.id;
      return ownerId && path.startsWith(`${ownerId}/`) ? path : null;
    } catch (error) {
      console.warn("Could not read legacy avatar path", error);
      return null;
    }
  }
  function scheduleAvatarRefresh() {
    clearTimeout(state.avatarRefreshTimer);
    clearTimeout(state.directorySearchTimer);
    state.directoryRequestId += 1;
    state.avatarRefreshTimer = setTimeout(async () => {
      try {
        state.profile = await resolveProfileAvatar(state.profile);
        const users = new Map();
        for (const conversation of state.conversations) {
          for (const member of conversation.members) users.set(member.user_id, member.profile);
        }
        for (const [userId, profile] of users) {
          users.set(userId, await resolveProfileAvatar(profile));
        }
        for (const conversation of state.conversations) {
          conversation.members = conversation.members.map(member => ({
            ...member, profile: users.get(member.user_id) || member.profile
          }));
        }
        renderProfileHeader();
        renderConversations();
        if (state.activeId) {
          const active = state.conversations.find(conversation => conversation.id === state.activeId);
          if (active) updateActiveHeader(active);
          renderMessages(false);
        }
      } catch (error) {
        toast(friendlyError(error));
      } finally {
        if (state.user) scheduleAvatarRefresh();
      }
    }, 50 * 60 * 1000);
  }
  async function enterApp(user) {
    state.user = user;
    state.profile = await ensureProfile(user);
    await loadNotificationPreferences();
    renderProfileHeader();
    scheduleAvatarRefresh();
    showApp();
    await loadConversations();
    subscribeToConversationChanges();
    updateServiceWorkerConversationState();
    const requestedConversation = new URL(window.location.href).searchParams.get("conversation");
    if (requestedConversation && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestedConversation)) {
      const conversation = state.conversations.find(item => item.id === requestedConversation);
      if (conversation) await openConversation(conversation.id);
      const url = new URL(window.location.href);
      url.searchParams.delete("conversation");
      window.history.replaceState({}, "", url.href);
    }
    maybeShowNotificationWelcome();
  }
  function hasSeenNotificationWelcome() {
    if (!state.user) return true;
    if (state.notificationWelcomeUsers.has(state.user.id)) return true;
    try {
      return window.localStorage.getItem(`chatflow-notification-welcome:${state.user.id}`) === "seen";
    } catch (error) {
      console.warn("Could not read notification welcome preference", error);
      return false;
    }
  }
  function markNotificationWelcomeSeen() {
    if (!state.user) return;
    state.notificationWelcomeUsers.add(state.user.id);
    try {
      window.localStorage.setItem(`chatflow-notification-welcome:${state.user.id}`, "seen");
    } catch (error) {
      console.warn("Could not save notification welcome preference", error);
      toast("This browser could not save your notification choice. You may see this prompt again after reloading.");
    }
  }
  function maybeShowNotificationWelcome() {
    if (!state.user || state.notificationPreferences.desktop_enabled || hasSeenNotificationWelcome()) return;
    const dialog = $("notification-welcome-dialog");
    if (!dialog.open) {
      notice("notification-welcome-message", "");
      dialog.showModal();
    }
  }
  async function enableNotificationsFromWelcome() {
    const button = $("enable-first-login-notifications");
    button.disabled = true;
    $("notification-welcome-not-now").disabled = true;
    const enabled = await setDesktopNotifications(true, "notification-welcome-message");
    if (enabled) {
      markNotificationWelcomeSeen();
      $("notification-welcome-dialog").close();
    }
    button.disabled = false;
    $("notification-welcome-not-now").disabled = false;
  }
  function dismissNotificationWelcome() {
    markNotificationWelcomeSeen();
    $("notification-welcome-dialog").close();
  }
  async function signOut() {
    state.subscriptions.forEach(s => state.supabase.removeChannel(s));
    state.subscriptions = [];
    if (state.typingChannel) state.supabase.removeChannel(state.typingChannel);
    clearTimeout(state.avatarRefreshTimer);
    state.avatarRefreshTimer = null;
    finishVoiceRecording(true);
    if (state.readObserver) state.readObserver.disconnect();
    clearSelectedAttachment();
    state.notificationToasts.forEach(item => clearTimeout(item.timeout));
    state.notificationToasts.clear();
    $("notification-toasts").replaceChildren();
    const { error } = await state.supabase.auth.signOut();
    if (error) toast(friendlyError(error));
    state.user = null; state.profile = null; state.activeId = null;
    state.conversations = []; state.messages = [];
    state.unreadCounts.clear();
    state.seenIncomingMessageIds.clear();
    state.notificationPreferences = { desktop_enabled: false, push_enabled: false, sound_enabled: true, previews_enabled: true };
    updateUnreadIndicators();
    showAuth();
  }
  async function loadConversations() {
    const { data: memberships, error } = await state.supabase.from("conversation_members")
      .select("conversation_id, role, joined_at").eq("user_id", state.user.id).is("hidden_at", null);
    if (error) throw error;
    const ids = (memberships || []).map(m => m.conversation_id);
    if (!ids.length) {
      state.conversations = []; state.unreadCounts.clear(); renderConversations(); renderEmptyChat();
      await refreshUnreadCounts();
      return;
    }
    const { data: conversations, error: convError } = await state.supabase.from("conversations")
      .select("id, type, name, group_avatar_path, created_at, created_by").in("id", ids).order("created_at", { ascending: false });
    if (convError) throw convError;
    const { data: allMembers, error: memberError } = await state.supabase.from("conversation_members")
      .select("conversation_id, user_id, role").in("conversation_id", ids);
    if (memberError) throw memberError;
    const memberIds = [...new Set((allMembers || []).map(m => m.user_id))];
    let profiles = [];
    if (memberIds.length) {
      const result = await state.supabase.from("profiles")
        .select("id, display_name, email, avatar_url, avatar_path, username, bio, status_message")
        .in("id", memberIds);
      if (result.error) throw result.error;
      profiles = await Promise.all((result.data || []).map(resolveProfileAvatar));
    }
    state.conversations = await Promise.all((conversations || []).map(async c => {
      const members = (allMembers || []).filter(m => m.conversation_id === c.id).map(m => ({
        ...m, profile: profiles.find(p => p.id === m.user_id) || { display_name: "Unknown user", email: "" }
      }));
      const other = members.find(m => m.user_id !== state.user.id);
      const displayName = c.type === "group" ? c.name : (other?.profile.display_name || "Private chat");
      let groupAvatarUrl = "";
      if (c.type === "group" && c.group_avatar_path) {
        const { data, error: avatarError } = await state.supabase.storage.from(GROUP_AVATAR_BUCKET)
          .createSignedUrl(c.group_avatar_path, 3600);
        if (avatarError) console.warn(`Could not sign group photo for conversation ${c.id}`, avatarError);
        else groupAvatarUrl = data.signedUrl;
      }
      return { ...c, groupAvatarUrl, members, displayName, memberCount: members.length };
    }));
    renderConversations();
    await refreshUnreadCounts();
    updateServiceWorkerConversationState();
    if (state.activeId) {
      const active = state.conversations.find(c => c.id === state.activeId);
      if (active) {
        updateActiveHeader(active);
        renderMessages(false);
      }
      else renderEmptyChat();
    }
  }
  function conversationPreview(c) {
    const m = c.lastMessage;
    if (!m) return c.type === "group" ? `${c.memberCount} members` : "Start a conversation";
    const preview = m.content || (m.message_type === "image" ? "Photo"
      : m.message_type === "video" ? "Video"
        : m.message_type === "audio" ? "Voice message"
          : m.attachment_name || "");
    return `${m.sender_id === state.user.id ? "You: " : ""}${preview}`;
  }
  function renderConversations() {
    const q = $("chat-search").value.trim().toLowerCase();
    const items = state.conversations.filter(c => c.displayName.toLowerCase().includes(q));
    $("chat-count").textContent = String(state.conversations.length);
    const list = $("conversation-list");
    if (!items.length) {
      list.innerHTML = `<div class="empty-sidebar">${q ? "No conversations match your search." : "No conversations yet. Press + to start one."}</div>`;
      return;
    }
    list.innerHTML = items.map(c => {
      const member = c.type === "direct" ? c.members.find(item => item.user_id !== state.user.id) : null;
      const unreadCount = state.unreadCounts.get(c.id) || 0;
      const avatar = member
        ? `<button class="avatar profile-trigger" data-profile-id="${escapeText(member.user_id)}" data-profile-label="${escapeText(member.profile.display_name)}" type="button" aria-label="View ${escapeText(member.profile.display_name)}'s profile" data-conversation-avatar="${escapeText(c.id)}">${escapeText(initials(c.displayName))}</button>`
        : `<span class="avatar" data-conversation-avatar="${escapeText(c.id)}">${escapeText(initials(c.displayName))}</span>`;
      const title = member
        ? `<button class="conversation-name profile-trigger" data-profile-id="${escapeText(member.user_id)}" type="button">${escapeText(c.displayName)}</button>`
        : `<button class="conversation-name conversation-open" data-id="${escapeText(c.id)}" type="button">${ico("users", "ico tiny")}${escapeText(c.displayName)}</button>`;
      return `<div class="conversation-item ${c.id === state.activeId ? "active" : ""}">
        ${avatar}
        <span class="conversation-copy"><span>${title}</span>
          <button class="conversation-preview conversation-open" data-id="${escapeText(c.id)}" type="button">${escapeText(conversationPreview(c))}</button>
        </span>
        <span class="conversation-meta"><time>${escapeText(formatChatTime(c.lastMessage?.created_at))}</time>${unreadCount ? `<span class="conversation-unread" aria-label="${unreadCount} unread messages">${unreadCount > 99 ? "99+" : unreadCount}</span>` : ""}${member ? `<button class="remove-contact" data-remove-contact="${escapeText(c.id)}" data-contact-name="${escapeText(c.displayName)}" type="button" title="Remove ${escapeText(c.displayName)} from your contacts" aria-label="Remove ${escapeText(c.displayName)} from your contacts">${ico("trash", "ico tiny")}</button>` : ""}</span>
      </div>`;
    }).join("");
    list.querySelectorAll("[data-conversation-avatar]").forEach(element => {
      const conversation = items.find(item => item.id === element.dataset.conversationAvatar);
      const member = conversation?.type === "direct"
        ? conversation.members.find(item => item.user_id !== state.user.id)
        : null;
      const avatarProfile = member?.profile || (conversation?.groupAvatarUrl ? { avatar_url: conversation.groupAvatarUrl } : null);
      applyAvatarStyles(element, avatarProfile, initials(conversation?.displayName));
    });
    list.querySelectorAll("[data-id]").forEach(btn => btn.addEventListener("click", () => openConversation(btn.dataset.id)));
    list.querySelectorAll("[data-remove-contact]").forEach(btn => btn.addEventListener("click", () => {
      removeContact(btn.dataset.removeContact, btn.dataset.contactName, btn);
    }));
  }
  async function removeContact(conversationId, contactName, button) {
    if (!conversationId || !window.confirm(`Remove ${contactName} from your contacts? This only removes the conversation from your list; it does not affect the other person's account.`)) return;
    button.disabled = true;
    try {
      const { error } = await state.supabase.rpc("set_direct_contact_hidden", {
        target_conversation: conversationId,
        is_hidden: true
      });
      if (error) throw error;
      state.conversations = state.conversations.filter(conversation => conversation.id !== conversationId);
      if (state.activeId === conversationId) renderEmptyChat();
      else renderConversations();
      toast(`${contactName} removed from your contacts.`);
    } catch (error) {
      button.disabled = false;
      toast(friendlyError(error));
    }
  }
  function renderEmptyChat() {
    if (state.readObserver) state.readObserver.disconnect();
    state.activeId = null;
    $("active-title").textContent = "Welcome to ChatFlow";
    $("active-title").removeAttribute("data-profile-id");
    $("active-avatar").removeAttribute("data-profile-id");
    $("active-title").disabled = true;
    $("active-avatar").disabled = true;
    $("active-subtitle").textContent = "Choose a conversation to get started";
    applyAvatarStyles($("active-avatar"), null, "C");
    $("welcome-panel").classList.remove("hidden");
    $("messages").classList.add("hidden");
    $("message-form").classList.add("hidden");
    $("load-older").classList.add("hidden");
    $("chat-info").disabled = true;
    updateServiceWorkerConversationState();
    renderConversations();
    if (window.matchMedia("(max-width: 760px)").matches) $("app-screen").classList.remove("mobile-chat-open");
  }
  function updateActiveHeader(c) {
    $("active-title").textContent = c.displayName;
    const otherMember = c.type === "direct" ? c.members.find(member => member.user_id !== state.user.id) : null;
    if (otherMember) {
      $("active-title").dataset.profileId = otherMember.user_id;
      $("active-avatar").dataset.profileId = otherMember.user_id;
      $("active-title").disabled = false;
      $("active-avatar").disabled = false;
      $("active-title").setAttribute("aria-label", `View ${c.displayName}'s profile`);
      $("active-avatar").setAttribute("aria-label", `View ${c.displayName}'s profile`);
    } else {
      $("active-title").removeAttribute("data-profile-id");
      $("active-avatar").removeAttribute("data-profile-id");
      $("active-title").disabled = true;
      $("active-avatar").disabled = true;
      $("active-title").removeAttribute("aria-label");
      $("active-avatar").setAttribute("aria-label", "Group conversation");
    }
    $("active-subtitle").textContent = c.type === "group"
      ? `${c.memberCount} members · Group chat`
      : (otherMember?.profile.status_message || "Private conversation");
    const avatarProfile = otherMember?.profile || (c.groupAvatarUrl ? { avatar_url: c.groupAvatarUrl } : null);
    applyAvatarStyles($("active-avatar"), avatarProfile, initials(c.displayName));
    $("chat-info").disabled = false;
    updateServiceWorkerConversationState();
  }
  async function openConversation(id) {
    const c = state.conversations.find(x => x.id === id);
    if (!c) return;
    if (state.readObserver) state.readObserver.disconnect();
    if (state.activeId !== id) clearSelectedAttachment();
    state.activeId = id;
    state.unreadCounts.delete(id);
    updateUnreadIndicators();
    state.messages = [];
    state.reactions = [];
    state.readReceipts = [];
    state.hasOlderMessages = false;
    $("load-older").classList.add("hidden");
    updateActiveHeader(c);
    $("welcome-panel").classList.add("hidden");
    $("messages").classList.remove("hidden");
    $("message-form").classList.remove("hidden");
    $("app-screen").classList.add("mobile-chat-open");
    renderConversations();
    if (state.typingChannel) state.supabase.removeChannel(state.typingChannel);
    try {
      const { data, error } = await state.supabase.from("messages")
        .select("id, conversation_id, sender_id, content, message_type, attachment_path, attachment_name, attachment_mime, attachment_size, edited_at, created_at")
        .eq("conversation_id", id).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(MESSAGE_PAGE_SIZE + 1);
      if (error) throw error;
      const page = data || [];
      state.hasOlderMessages = page.length > MESSAGE_PAGE_SIZE;
      state.messages = await signMessageAttachments(page.slice(0, MESSAGE_PAGE_SIZE).reverse());
      $("load-older").classList.toggle("hidden", !state.hasOlderMessages);
      await refreshMessageMetadata();
      renderMessages();
      await refreshUnreadCounts();
      await subscribeToMessages(id);
      subscribeToTyping(id);
      $("message-input").focus();
    } catch (error) { toast(friendlyError(error)); }
  }
  async function signMessageAttachments(messages) {
    return Promise.all(messages.map(async message => {
      if (!message.attachment_path) return message;
      const { data, error } = await state.supabase.storage.from(ATTACHMENT_BUCKET)
        .createSignedUrl(message.attachment_path, 3600);
      if (error) throw error;
      return { ...message, attachment_url: data.signedUrl };
    }));
  }
  async function loadOlderMessages() {
    if (state.loadingOlderMessages || !state.hasOlderMessages || !state.messages.length || !state.activeId) return;
    state.loadingOlderMessages = true;
    const button = $("load-older");
    const previousLabel = button.textContent;
    const box = $("messages");
    const previousHeight = box.scrollHeight;
    const previousTop = box.scrollTop;
    button.disabled = true;
    button.textContent = "Loading…";
    try {
      const oldest = state.messages[0];
      const { data, error } = await state.supabase.from("messages")
        .select("id, conversation_id, sender_id, content, message_type, attachment_path, attachment_name, attachment_mime, attachment_size, edited_at, created_at")
        .eq("conversation_id", state.activeId)
        .or(`created_at.lt.${oldest.created_at},and(created_at.eq.${oldest.created_at},id.lt.${oldest.id})`)
        .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(MESSAGE_PAGE_SIZE + 1);
      if (error) throw error;
      const page = data || [];
      state.hasOlderMessages = page.length > MESSAGE_PAGE_SIZE;
      const older = await signMessageAttachments(page.slice(0, MESSAGE_PAGE_SIZE).reverse());
      state.messages = [...older, ...state.messages];
      $("load-older").classList.toggle("hidden", !state.hasOlderMessages);
      await refreshMessageMetadata();
      renderMessages(false);
      box.scrollTop = box.scrollHeight - previousHeight + previousTop;
    } catch (error) {
      toast(friendlyError(error));
    } finally {
      state.loadingOlderMessages = false;
      button.disabled = false;
      button.textContent = previousLabel;
    }
  }
  async function refreshMessageMetadata() {
    if (!state.messages.length) return;
    const ids = state.messages.map(message => message.id);
    const [reactions, receipts] = await Promise.all([
      state.supabase.from("message_reactions").select("message_id, user_id, emoji").in("message_id", ids),
      state.supabase.from("message_reads").select("message_id, user_id, read_at").in("message_id", ids)
    ]);
    if (reactions.error) throw reactions.error;
    if (receipts.error) throw receipts.error;
    state.reactions = reactions.data || [];
    state.readReceipts = receipts.data || [];
  }
  async function markMessagesRead(messages) {
    const unread = messages.filter(message => message.sender_id !== state.user.id
      && !state.readReceipts.some(receipt => receipt.message_id === message.id && receipt.user_id === state.user.id)
      && !state.pendingReadMessageIds.has(message.id));
    if (!unread.length) return;
    unread.forEach(message => state.pendingReadMessageIds.add(message.id));
    try {
      const { error } = await state.supabase.from("message_reads").upsert(
        unread.map(message => ({ message_id: message.id, user_id: state.user.id })),
        { onConflict: "message_id,user_id" }
      );
      if (error) throw error;
      state.readReceipts.push(...unread.map(message => ({
        message_id: message.id, user_id: state.user.id, read_at: new Date().toISOString()
      })));
      renderMessages(false);
      await refreshUnreadCounts();
    } finally {
      unread.forEach(message => state.pendingReadMessageIds.delete(message.id));
    }
  }
  function renderAttachment(message) {
    const url = escapeText(message.attachment_url || "");
    const name = escapeText(message.attachment_name || "Attachment");
    if (!url) return `<div class="message-attachment-error">Attachment preview unavailable</div>`;
    if (message.message_type === "image") {
      return `<button class="attachment-image-button" type="button" data-action="view-image" data-url="${url}" aria-label="View ${name}">
        <img class="message-image" src="${url}" alt="${name}" loading="lazy"></button>`;
    }
    if (message.message_type === "video") {
      return `<video class="message-video" src="${url}" controls preload="metadata" playsinline></video>`;
    }
    if (message.message_type === "audio") {
      return `<audio class="message-audio" src="${url}" controls preload="metadata"></audio>`;
    }
    const size = message.attachment_size < 1024 * 1024
      ? `${Math.max(1, Math.round(message.attachment_size / 1024))} KB`
      : `${(message.attachment_size / (1024 * 1024)).toFixed(1)} MB`;
    return `<a class="message-file" href="${url}" target="_blank" rel="noopener noreferrer" download="${name}">
      <span class="file-icon">${ico("download")}</span><span><strong>${name}</strong><small>${escapeText(size)} · ${escapeText(message.attachment_mime)}</small></span></a>`;
  }
  function renderMessages(scrollToBottom = true) {
    const box = $("messages");
    if (state.readObserver) state.readObserver.disconnect();
    if (!state.messages.length) {
      box.innerHTML = `<div class="date-divider">This is the beginning of your conversation</div>`;
      return;
    }
    let lastDate = "";
    const activeChat = state.conversations.find(c => c.id === state.activeId);
    const isGroup = activeChat?.type === "group";
    box.classList.toggle("is-direct", !isGroup);
    const sameGroup = (a, b) => a && b && a.sender_id === b.sender_id
      && new Date(a.created_at).toDateString() === new Date(b.created_at).toDateString()
      && Math.abs(new Date(b.created_at) - new Date(a.created_at)) < 5 * 60 * 1000;
    box.innerHTML = state.messages.map((m, index) => {
      const isFirst = !sameGroup(state.messages[index - 1], m);
      const isLast = !sameGroup(m, state.messages[index + 1]);
      const date = new Date(m.created_at);
      const day = date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
      const mine = m.sender_id === state.user.id;
      const member = state.conversations.find(c => c.id === state.activeId)?.members.find(x => x.user_id === m.sender_id);
      const name = mine ? "You" : (member?.profile.display_name || "Member");
      const senderLabel = !mine && isGroup && isFirst
        ? `<button class="message-sender profile-trigger" data-profile-id="${escapeText(m.sender_id)}" type="button">${escapeText(name)}</button>`
        : "";
      const summary = REACTION_EMOJIS.map(emoji => {
        const users = state.reactions.filter(reaction => reaction.message_id === m.id && reaction.emoji === emoji);
        return users.length ? `<button class="reaction-chip ${users.some(reaction => reaction.user_id === state.user.id) ? "selected" : ""}" type="button" data-action="react" data-id="${escapeText(m.id)}" data-emoji="${emoji}">${emoji} ${users.length}</button>` : "";
      }).join("");
      const hasRead = mine && state.readReceipts.some(receipt => receipt.message_id === m.id && receipt.user_id !== state.user.id);
      const actions = `<div class="message-actions">
        <button type="button" data-action="copy" data-id="${escapeText(m.id)}" aria-label="Copy message" title="Copy">${ico("copy")}</button>
        <button type="button" data-action="react" data-id="${escapeText(m.id)}" data-emoji="👍" aria-label="React with thumbs up">👍</button>
        ${mine && m.message_type === "text" ? `<button type="button" data-action="edit" data-id="${escapeText(m.id)}" aria-label="Edit message" title="Edit">${ico("edit")}</button>` : ""}
        ${mine ? `<button type="button" data-action="delete" data-id="${escapeText(m.id)}" aria-label="Delete message" title="Delete" class="danger">${ico("trash")}</button>` : ""}
      </div>`;
      let divider = "";
      if (day !== lastDate) { divider = `<div class="date-divider">${escapeText(day)}</div>`; lastDate = day; }
      return `${divider}<article class="message-row ${mine ? "mine" : ""} ${isFirst ? "is-first" : ""} ${isLast ? "is-last" : ""}" data-message-id="${escapeText(m.id)}">
        <button class="avatar profile-trigger" data-profile-id="${escapeText(m.sender_id)}" type="button" aria-label="View ${escapeText(name)}'s profile" data-message-avatar="${escapeText(m.sender_id)}">${escapeText(initials(name))}</button>
        <div class="message-body">${senderLabel}
          <div class="message-bubble">${m.attachment_path ? renderAttachment(m) : ""}${m.content ? `<div class="message-text">${escapeText(m.content)}</div>` : ""}</div>
          ${summary ? `<div class="message-reactions">${summary}</div>` : ""}
          ${actions}
          <div class="message-time">${escapeText(date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))}${m.edited_at ? " · edited" : ""}${hasRead ? " · seen" : ""}</div>
        </div></article>`;
    }).join("");
    box.querySelectorAll("[data-message-avatar]").forEach(element => {
      const userId = element.dataset.messageAvatar;
      const member = state.conversations.find(c => c.id === state.activeId)?.members.find(x => x.user_id === userId);
      const profile = userId === state.user.id ? state.profile : member?.profile || null;
      applyAvatarStyles(element, profile, initials(userId === state.user.id ? getProfileDisplayName() : member?.profile.display_name));
    });
    if (scrollToBottom) box.scrollTop = box.scrollHeight;
    if ("IntersectionObserver" in window) {
        state.readObserver = new IntersectionObserver(entries => {
          const visible = entries.filter(entry => entry.isIntersecting)
            .map(entry => state.messages.find(message => message.id === entry.target.dataset.messageId))
            .filter(Boolean);
          if (visible.length) markMessagesRead(visible).catch(error => toast(friendlyError(error)));
        }, { root: box, threshold: 0.6 });
        box.querySelectorAll(".message-row[data-message-id]").forEach(row => state.readObserver.observe(row));
    }
  }
  async function subscribeToMessages(conversationId) {
    state.subscriptions.filter(s => ["messages", "reactions", "reads"].includes(s.__kind)).forEach(s => state.supabase.removeChannel(s));
    state.subscriptions = state.subscriptions.filter(s => !["messages", "reactions", "reads"].includes(s.__kind));
    const channel = state.supabase.channel(`messages:${conversationId}:${state.user.id}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages", filter: `conversation_id=eq.${conversationId}` }, async payload => {
        if (state.activeId !== conversationId) return;
        try {
          const [incoming] = await signMessageAttachments([payload.new]);
          if (state.messages.some(m => m.id === incoming.id)) return;
          state.messages.push(incoming);
          renderMessages();
          const c = state.conversations.find(x => x.id === conversationId);
          if (c) { c.lastMessage = incoming; renderConversations(); }
        } catch (error) { toast(friendlyError(error)); }
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "messages", filter: `conversation_id=eq.${conversationId}` }, payload => {
        const index = state.messages.findIndex(message => message.id === payload.new.id);
        if (index >= 0) { state.messages[index] = { ...state.messages[index], ...payload.new }; renderMessages(false); }
      })
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "messages" }, payload => {
        state.messages = state.messages.filter(message => message.id !== payload.old.id);
        state.reactions = state.reactions.filter(reaction => reaction.message_id !== payload.old.id);
        state.readReceipts = state.readReceipts.filter(receipt => receipt.message_id !== payload.old.id);
        renderMessages(false);
      }).subscribe();
    channel.__kind = "messages";
    state.subscriptions.push(channel);
    const metadataChannel = state.supabase.channel(`message-metadata:${conversationId}:${state.user.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "message_reactions" }, payload => {
        const messageId = payload.new?.message_id || payload.old?.message_id;
        if (!messageId || !state.messages.some(message => message.id === messageId)) return;
        refreshMessageMetadata().then(() => renderMessages(false)).catch(error => toast(friendlyError(error)));
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "message_reads" }, payload => {
        const messageId = payload.new?.message_id || payload.old?.message_id;
        if (!messageId || !state.messages.some(message => message.id === messageId)) return;
        refreshMessageMetadata().then(() => renderMessages(false)).catch(error => toast(friendlyError(error)));
      }).subscribe();
    metadataChannel.__kind = "reactions";
    state.subscriptions.push(metadataChannel);
  }
  function rememberIncomingMessage(messageId) {
    if (state.seenIncomingMessageIds.has(messageId)) return false;
    state.seenIncomingMessageIds.add(messageId);
    if (state.seenIncomingMessageIds.size > 1000) {
      state.seenIncomingMessageIds.delete(state.seenIncomingMessageIds.values().next().value);
    }
    return true;
  }
  async function handleIncomingMessage(message) {
    if (!state.user || !message?.id || message.sender_id === state.user.id || !rememberIncomingMessage(message.id)) return;
    const conversation = state.conversations.find(item => item.id === message.conversation_id);
    if (!conversation) return;

    conversation.lastMessage = message;
    renderConversations();
    const isFocused = document.visibilityState === "visible" && document.hasFocus();
    const isViewingConversation = state.activeId === conversation.id && isFocused;
    try {
      await refreshUnreadCounts();
    } catch (error) {
      toast(friendlyError(error));
    }
    if (isViewingConversation) {
      updateServiceWorkerConversationState();
      return;
    }

    const sender = conversation.members.find(member => member.user_id === message.sender_id)?.profile
      || { id: message.sender_id, display_name: "New message" };
    if (document.visibilityState === "visible") showMessageToast(message, conversation, sender);
    playNotificationSound();
    if (!isFocused) await showDesktopNotification(message, conversation, sender);
  }
  function subscribeToIncomingMessages() {
    state.subscriptions.filter(subscription => ["incoming-messages", "incoming-reads"].includes(subscription.__kind))
      .forEach(subscription => state.supabase.removeChannel(subscription));
    state.subscriptions = state.subscriptions.filter(subscription => !["incoming-messages", "incoming-reads"].includes(subscription.__kind));

    const messageChannel = state.supabase.channel(`incoming-messages:${state.user.id}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, payload => {
        handleIncomingMessage(payload.new).catch(error => toast(friendlyError(error)));
      })
      .subscribe(status => {
        if (status === "SUBSCRIBED") {
          refreshUnreadCounts().catch(error => toast(friendlyError(error)));
        }
      });
    messageChannel.__kind = "incoming-messages";
    state.subscriptions.push(messageChannel);

    const readChannel = state.supabase.channel(`incoming-reads:${state.user.id}`)
      .on("postgres_changes", {
        event: "*", schema: "public", table: "message_reads", filter: `user_id=eq.${state.user.id}`
      }, () => {
        refreshUnreadCounts().catch(error => toast(friendlyError(error)));
        if (state.activeId) refreshMessageMetadata().then(() => renderMessages(false)).catch(error => toast(friendlyError(error)));
      })
      .subscribe();
    readChannel.__kind = "incoming-reads";
    state.subscriptions.push(readChannel);
  }
  function subscribeToConversationChanges() {
    state.subscriptions.filter(s => ["memberships", "profiles", "conversations", "incoming-messages", "incoming-reads"].includes(s.__kind)).forEach(s => state.supabase.removeChannel(s));
    state.subscriptions = state.subscriptions.filter(s => !["memberships", "profiles", "conversations", "incoming-messages", "incoming-reads"].includes(s.__kind));
    const channel = state.supabase.channel(`memberships:${state.user.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "conversation_members", filter: `user_id=eq.${state.user.id}` }, () => {
        loadConversations().then(() => {
          if ($("info-dialog").open) {
            if (state.activeId && state.conversations.some(conversation => conversation.id === state.activeId)) showConversationInfo();
            else $("info-dialog").close();
          }
        }).catch(e => toast(friendlyError(e)));
      }).subscribe();
    channel.__kind = "memberships";
    state.subscriptions.push(channel);
    const conversationChannel = state.supabase.channel(`conversations:${state.user.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "conversations" }, payload => {
        const conversationId = payload.new?.id || payload.old?.id;
        if (state.conversations.some(conversation => conversation.id === conversationId)) {
          loadConversations().then(() => {
            if ($("info-dialog").open) {
              if (state.activeId && state.conversations.some(conversation => conversation.id === state.activeId)) showConversationInfo();
              else $("info-dialog").close();
            }
          }).catch(error => toast(friendlyError(error)));
        }
      }).subscribe();
    conversationChannel.__kind = "conversations";
    state.subscriptions.push(conversationChannel);
    subscribeToIncomingMessages();
    const profileChannel = state.supabase.channel(`profiles:${state.user.id}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "profiles" }, payload => {
        if (payload.new?.id === state.user.id) {
          fetchProfileRecord(state.user)
            .then(profile => resolveProfileAvatar(profile).then(resolved => {
              state.profile = resolved;
              applyProfileToConversationViews();
            }))
            .catch(error => toast(friendlyError(error)));
        } else {
          state.directoryProfiles.delete(payload.new?.id);
          loadConversations().catch(error => toast(friendlyError(error)));
          if (state.viewedProfileId === payload.new?.id && $("view-profile-dialog").open) {
            openUserProfile(state.viewedProfileId);
          }
        }
      }).subscribe();
    profileChannel.__kind = "profiles";
    state.subscriptions.push(profileChannel);
  }
  function subscribeToTyping(conversationId) {
    state.typingChannel = state.supabase.channel(`typing:${conversationId}`, { config: { presence: { key: state.user.id }, broadcast: { self: false } } });
    state.typingChannel.on("broadcast", { event: "typing" }, ({ payload }) => {
      if (payload.user_id === state.user.id || state.activeId !== conversationId) return;
      $("typing-indicator").textContent = payload.is_typing ? `${payload.name} is typing…` : "";
      $("typing-indicator").classList.toggle("hidden", !payload.is_typing);
    }).subscribe();
  }
  async function broadcastTyping(isTyping) {
    if (!state.typingChannel) return;
    await state.typingChannel.send({ type: "broadcast", event: "typing", payload: {
      user_id: state.user.id, name: state.profile.display_name, is_typing: isTyping
    }});
  }
  const MIME_BY_EXTENSION = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
    mp4: "video/mp4", webm: "video/webm", ogg: "audio/ogg"
  };
  const PHOTO_VIDEO_MIMES = new Set(["image/jpeg", "image/png", "image/webp", "video/mp4", "video/webm"]);
  const VOICE_MIMES = new Set(["audio/webm", "audio/ogg", "audio/mp4"]);
  function attachmentKind(mime) {
    if (mime.startsWith("image/")) return "image";
    if (mime.startsWith("video/")) return "video";
    return "audio";
  }
  async function validateAttachment(file, isVoiceMessage = false) {
    if (!file || file.size < 1 || file.size > MAX_ATTACHMENT_SIZE) {
      throw new Error("Attachments must be between 1 byte and 25 MB.");
    }
    const extension = file.name.split(".").pop().toLowerCase();
    const extensionMime = isVoiceMessage
      ? ({ webm: "audio/webm", ogg: "audio/ogg", mp4: "audio/mp4" })[extension]
      : MIME_BY_EXTENSION[extension];
    const mime = file.type && file.type !== "application/octet-stream" ? file.type : extensionMime;
    const allowed = isVoiceMessage ? VOICE_MIMES.has(mime) : PHOTO_VIDEO_MIMES.has(mime);
    if (!extensionMime || !allowed) {
      throw new Error(isVoiceMessage
        ? "This voice recording format is not supported."
        : "Only JPEG, PNG, or WebP photos and MP4 or WebM videos are supported.");
    }
    if (extensionMime !== mime) {
      throw new Error("The file extension and file type do not match.");
    }
    const bytes = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    const begins = (...signature) => signature.every((byte, index) => bytes[index] === byte);
    let valid = false;
    if (mime === "image/jpeg") valid = begins(0xff, 0xd8, 0xff);
    else if (mime === "image/png") valid = begins(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    else if (mime === "image/webp") valid = begins(0x52, 0x49, 0x46, 0x46) && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
    else if (mime === "video/mp4") valid = String.fromCharCode(...bytes.slice(4, 8)) === "ftyp";
    else if (mime === "video/webm") valid = begins(0x1a, 0x45, 0xdf, 0xa3);
    else if (mime === "audio/mp4") valid = String.fromCharCode(...bytes.slice(4, 8)) === "ftyp";
    else if (mime === "audio/webm") valid = begins(0x1a, 0x45, 0xdf, 0xa3);
    else if (mime === "audio/ogg") valid = String.fromCharCode(...bytes.slice(0, 4)) === "OggS";
    if (!valid) throw new Error("The selected file contents do not match its supported file type.");
    return {
      file,
      mime,
      kind: attachmentKind(mime),
      name: file.name.replace(/[\\/\u0000-\u001f]/g, "_").slice(0, 255)
    };
  }
  function clearSelectedAttachment() {
    state.selectedAttachment = null;
    if (state.attachmentPreviewUrl) URL.revokeObjectURL(state.attachmentPreviewUrl);
    state.attachmentPreviewUrl = null;
    $("attachment-input").value = "";
    $("attachment-preview").replaceChildren();
    $("attachment-preview").classList.add("hidden");
  }
  async function chooseAttachment(file, isVoiceMessage = false) {
    try {
      const attachment = await validateAttachment(file, isVoiceMessage);
      clearSelectedAttachment();
      state.selectedAttachment = attachment;
      state.attachmentPreviewUrl = URL.createObjectURL(file);
      const preview = $("attachment-preview");
      const mediaPreview = attachment.kind === "image"
        ? `<img src="${escapeText(state.attachmentPreviewUrl)}" alt="Selected image preview">`
        : attachment.kind === "video"
          ? `<video src="${escapeText(state.attachmentPreviewUrl)}" controls preload="metadata"></video>`
          : `<audio src="${escapeText(state.attachmentPreviewUrl)}" controls></audio>`;
      preview.innerHTML = `${mediaPreview}<span>${escapeText(attachment.name)} · ${(file.size / 1024).toFixed(0)} KB</span><button type="button" class="icon-button small" data-clear-attachment aria-label="Remove attachment">×</button>`;
      preview.classList.remove("hidden");
    } catch (error) {
      toast(friendlyError(error));
    }
  }
  async function startVoiceRecording() {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      toast("Voice recording is not supported in this browser.");
      return;
    }
    if (state.requestingMicrophone) return;
    state.requestingMicrophone = true;
    $("record-audio").disabled = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"]
        .find(type => MediaRecorder.isTypeSupported(type));
      state.recordingStream = stream;
      state.recordingChunks = [];
      state.cancelRecording = false;
      state.recordingPausedAt = 0;
      state.recordingPausedDuration = 0;
      state.recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      state.recorder.addEventListener("dataavailable", event => {
        if (event.data.size) state.recordingChunks.push(event.data);
      });
      state.recorder.addEventListener("stop", async () => {
        const recordedMimeType = state.recorder.mimeType || mimeType;
        clearInterval(state.recordingTimer);
        state.recordingTimer = null;
        stream.getTracks().forEach(track => track.stop());
        state.recordingStream = null;
        state.recorder = null;
        $("recording-status").classList.add("hidden");
        $("cancel-recording").classList.add("hidden");
        $("pause-recording").classList.add("hidden");
        setRecordState(false);
        $("record-audio").disabled = false;
        if (state.cancelRecording) return;
        const type = recordedMimeType?.split(";")[0] || "audio/webm";
        const extension = type === "audio/ogg" ? "ogg" : type === "audio/mp4" ? "mp4" : "webm";
        await chooseAttachment(new File(state.recordingChunks, `voice-message.${extension}`, { type }), true);
      });
      state.recordingStartedAt = Date.now();
      state.recorder.start(250);
      setRecordState(true);
      setPauseState(false);
      $("pause-recording").classList.remove("hidden");
      $("cancel-recording").classList.remove("hidden");
      $("recording-status").classList.remove("hidden");
      const updateDuration = () => {
        const elapsed = (state.recordingPausedAt || Date.now()) - state.recordingStartedAt - state.recordingPausedDuration;
        const seconds = Math.floor(elapsed / 1000);
        const prefix = state.recordingPausedAt ? "Recording paused" : "Recording voice message";
        $("recording-status").textContent = `${prefix} · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
      };
      updateDuration();
      state.recordingTimer = setInterval(updateDuration, 500);
    } catch (error) {
      state.recordingStream?.getTracks().forEach(track => track.stop());
      state.recordingStream = null;
      state.recorder = null;
      $("record-audio").disabled = false;
      setRecordState(false);
      $("recording-status").classList.add("hidden");
      $("pause-recording").classList.add("hidden");
      $("cancel-recording").classList.add("hidden");
      toast(error.name === "NotAllowedError" ? "Microphone permission was denied." : friendlyError(error));
    } finally {
      state.requestingMicrophone = false;
      $("record-audio").disabled = false;
    }
  }
  function toggleVoiceRecordingPause() {
    if (!state.recorder) return;
    if (state.recorder.state === "recording") {
      state.recorder.pause();
      state.recordingPausedAt = Date.now();
      setPauseState(true);
    } else if (state.recorder.state === "paused") {
      state.recordingPausedDuration += Date.now() - state.recordingPausedAt;
      state.recordingPausedAt = 0;
      state.recorder.resume();
      setPauseState(false);
    }
  }
  function finishVoiceRecording(cancelled) {
    if (!state.recorder || state.recorder.state === "inactive") return;
    state.cancelRecording = cancelled;
    $("record-audio").disabled = true;
    state.recorder.stop();
  }
  async function uploadAttachment(path, attachment) {
    const { data, error } = await state.supabase.auth.getSession();
    if (error) throw error;
    if (!data.session?.access_token) throw new Error("Your session expired. Sign in again to upload this file.");
    await new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      state.activeUpload = request;
      $("cancel-upload").classList.remove("hidden");
      request.open("POST", `${cfg.SUPABASE_URL.replace(/\/+$/, "")}/storage/v1/object/${ATTACHMENT_BUCKET}/${path.split("/").map(encodeURIComponent).join("/")}`);
      request.setRequestHeader("apikey", cfg.SUPABASE_ANON_KEY);
      request.setRequestHeader("Authorization", `Bearer ${data.session.access_token}`);
      request.setRequestHeader("Content-Type", attachment.mime);
      request.setRequestHeader("x-upsert", "false");
      request.upload.addEventListener("progress", event => {
        if (event.lengthComputable) {
          { const pct = Math.round(event.loaded / event.total * 100); setSendState(`Uploading ${pct}%`, pct); }
        }
      });
      request.addEventListener("load", () => {
        if (request.status >= 200 && request.status < 300) {
          resolve();
          return;
        }
        let detail = `Upload failed (HTTP ${request.status}).`;
        try {
          const response = JSON.parse(request.responseText);
          detail = response.message || response.error || detail;
        } catch (parseError) {
          detail = `Upload failed (HTTP ${request.status}); the server returned an invalid error response.`;
        }
        reject(new Error(detail));
      });
      request.addEventListener("error", () => reject(new Error("Network error while uploading the attachment.")));
      request.addEventListener("abort", () => reject(new Error("Upload canceled.")));
      request.addEventListener("loadend", () => {
        state.activeUpload = null;
        $("cancel-upload").classList.add("hidden");
      });
      request.send(attachment.file);
    });
  }
  async function sendMessage(event) {
    event.preventDefault();
    const input = $("message-input");
    const content = input.value.trim();
    const attachment = state.selectedAttachment;
    const conversationId = state.activeId;
    if ((!content && !attachment) || !conversationId || state.sendingMessage) return;
    state.sendingMessage = true;
    const button = $("message-form").querySelector('[type="submit"]');
    button.disabled = true;
    setSendState(attachment ? "Uploading…" : "Sending…");
    let uploadedPath = null;
    try {
      await broadcastTyping(false);
      const messageId = crypto.randomUUID();
      let attachmentPath = null;
      if (attachment) {
        const extension = attachment.name.includes(".") ? `.${attachment.name.split(".").pop().toLowerCase()}` : "";
        attachmentPath = `${conversationId}/${state.user.id}/${crypto.randomUUID()}${extension}`;
        uploadedPath = attachmentPath;
        await uploadAttachment(attachmentPath, attachment);
      }
      const { data, error } = await state.supabase.from("messages").insert({
        id: messageId,
        conversation_id: conversationId,
        sender_id: state.user.id,
        content,
        message_type: attachment ? attachment.kind : "text",
        attachment_path: attachmentPath,
        attachment_name: attachment?.name || null,
        attachment_mime: attachment?.mime || null,
        attachment_size: attachment?.file.size || null
      }).select("id, conversation_id, sender_id, content, message_type, attachment_path, attachment_name, attachment_mime, attachment_size, edited_at, created_at").single();
      if (error) throw error;
      uploadedPath = null;
      input.value = "";
      input.style.height = "auto";
      if (state.selectedAttachment === attachment) clearSelectedAttachment();
      const [signedMessage] = await signMessageAttachments([data]);
      if (state.activeId === conversationId && !state.messages.some(message => message.id === signedMessage.id)) {
        state.messages.push(signedMessage);
        renderMessages();
      }
      const c = state.conversations.find(x => x.id === conversationId);
      if (c) { c.lastMessage = signedMessage; renderConversations(); }
    } catch (error) {
      let message = friendlyError(error);
      if (uploadedPath) {
        const { error: cleanupError } = await state.supabase.storage.from(ATTACHMENT_BUCKET).remove([uploadedPath]);
        if (cleanupError) message += ` Attachment cleanup failed: ${friendlyError(cleanupError)}`;
      }
      toast(message);
    } finally {
      state.sendingMessage = false;
      button.disabled = false;
      setSendState(null);
      $("cancel-upload").classList.add("hidden");
    }
  }
  async function handleMessageAction(event) {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const { action, id, emoji } = button.dataset;
    const message = state.messages.find(item => item.id === id);
    if (action === "view-image") {
      $("image-preview-full").src = button.dataset.url;
      $("image-preview-dialog").showModal();
      return;
    }
    if (!message) return;
    try {
      if (action === "copy") {
        await navigator.clipboard.writeText(message.content || message.attachment_name || "");
        toast("Copied.");
      } else if (action === "react") {
        const existing = state.reactions.find(reaction =>
          reaction.message_id === id && reaction.user_id === state.user.id && reaction.emoji === emoji);
        const result = existing
          ? await state.supabase.from("message_reactions").delete().eq("message_id", id).eq("user_id", state.user.id).eq("emoji", emoji)
          : await state.supabase.from("message_reactions").insert({ message_id: id, user_id: state.user.id, emoji });
        if (result.error) throw result.error;
        await refreshMessageMetadata();
        renderMessages(false);
      } else if (action === "edit" && message.sender_id === state.user.id && message.message_type === "text") {
        const content = window.prompt("Edit message", message.content);
        if (content === null) return;
        const trimmed = content.trim();
        if (!trimmed || trimmed.length > 4000) throw new Error("Messages must contain 1 to 4000 characters.");
        const { data, error } = await state.supabase.from("messages")
          .update({ content: trimmed, edited_at: new Date().toISOString() })
          .eq("id", id).select("id, content, edited_at").single();
        if (error) throw error;
        Object.assign(message, data);
        renderMessages(false);
      } else if (action === "delete" && message.sender_id === state.user.id) {
        if (!window.confirm("Delete this message for everyone in the conversation?")) return;
        const { error } = await state.supabase.from("messages").delete().eq("id", id);
        if (error) throw error;
        state.messages = state.messages.filter(item => item.id !== id);
        state.reactions = state.reactions.filter(reaction => reaction.message_id !== id);
        state.readReceipts = state.readReceipts.filter(receipt => receipt.message_id !== id);
        if (message.attachment_path) {
          const { error: removeError } = await state.supabase.storage.from(ATTACHMENT_BUCKET).remove([message.attachment_path]);
          if (removeError) toast(`Message deleted, but attachment cleanup failed: ${friendlyError(removeError)}`);
        }
        renderMessages(false);
      }
    } catch (error) {
      toast(friendlyError(error));
    }
  }
  function getExistingDirectContacts() {
    const contacts = new Map();
    state.conversations.filter(conversation => conversation.type === "direct").forEach(conversation => {
      const member = conversation.members.find(item => item.user_id !== state.user.id);
      if (member && !contacts.has(member.user_id)) contacts.set(member.user_id, member.profile);
    });
    return [...contacts.entries()].map(([id, profile]) => ({ id, profile }))
      .sort((a, b) => (a.profile.display_name || "").localeCompare(b.profile.display_name || ""));
  }
  function renderGroupContactPicker() {
    const query = $("group-contact-search").value.trim().toLowerCase();
    const selectedIds = new Set([...$("group-contact-picker").querySelectorAll('input[name="group-contact"]:checked')].map(input => input.value));
    const contacts = getExistingDirectContacts().filter(({ profile }) => {
      const name = profile.display_name || "";
      const username = profile.username || "";
      return !query || name.toLowerCase().includes(query) || username.toLowerCase().includes(query);
    });
    const picker = $("group-contact-picker");
    picker.innerHTML = contacts.length ? contacts.map(({ id, profile }) => `
      <label class="group-contact-option">
        <input type="checkbox" name="group-contact" value="${escapeText(id)}" ${selectedIds.has(id) ? "checked" : ""}>
        <span class="avatar" data-contact-avatar="${escapeText(id)}">${escapeText(initials(profile.display_name || "ChatFlow user"))}</span>
        <span class="group-contact-copy"><strong>${escapeText(profile.display_name || "ChatFlow user")}</strong>
          <small>${profile.username ? `@${escapeText(profile.username)}` : "Existing contact"}</small></span>
      </label>`).join("") : `<p class="muted small-text">${query ? "No contacts match your search." : "No existing direct-chat contacts yet. Add people by email instead."}</p>`;
    picker.querySelectorAll("[data-contact-avatar]").forEach(element => {
      const contact = contacts.find(item => item.id === element.dataset.contactAvatar);
      applyAvatarStyles(element, contact?.profile || null, initials(contact?.profile.display_name || "ChatFlow user"));
    });
  }
  function updateNewChatType() {
    const isGroup = $("conversation-type").value === "group";
    $("group-name").disabled = !isGroup;
    $("group-name").required = isGroup;
    $("member-emails").required = !isGroup;
    $("member-emails").placeholder = isGroup ? "alex@example.com, sam@example.com" : "alex@example.com";
    $("group-contact-search-field").classList.toggle("hidden", !isGroup);
    $("group-contact-picker").classList.toggle("hidden", !isGroup);
    if (isGroup) renderGroupContactPicker();
  }
  function openNewChat() {
    $("new-chat-form").reset();
    $("group-contact-picker").querySelectorAll('input[name="group-contact"]').forEach(input => { input.checked = false; });
    notice("new-chat-message", "");
    updateNewChatType();
    $("new-chat-dialog").showModal();
  }
  async function createConversation(event) {
    event.preventDefault();
    notice("new-chat-message", "");
    const type = $("conversation-type").value;
    const emails = [...new Set($("member-emails").value.split(",").map(x => x.trim().toLowerCase()).filter(Boolean))];
    const groupName = $("group-name").value.trim();
    const selectedContactIds = type === "group"
      ? [...$("group-contact-picker").querySelectorAll('input[name="group-contact"]:checked')].map(input => input.value)
      : [];
    if (type === "direct" && !emails.length) return notice("new-chat-message", "Enter one registered email address.");
    if (type === "group" && !emails.length && !selectedContactIds.length) return notice("new-chat-message", "Choose at least one contact or enter a registered email.");
    if (emails.includes(state.user.email.toLowerCase())) return notice("new-chat-message", "You are already added automatically. Enter other people only.");
    if (type === "direct" && emails.length !== 1) return notice("new-chat-message", "Private chats require exactly one other person.");
    if (type === "group" && !groupName) return notice("new-chat-message", "Please name your group.");
    const button = $("create-conversation");
    button.disabled = true; button.textContent = "Creating…";
    try {
      let matched = [];
      if (emails.length) {
        // Resolve email additions via the exact-match RPC; selected contacts need no lookup.
        const { data: found, error: lookupError } = await state.supabase.rpc("lookup_profiles_by_email", { lookup_emails: emails });
        if (lookupError) throw lookupError;
        matched = found || [];
        const missing = emails.filter(email => !matched.some(p => p.email?.toLowerCase() === email));
        if (missing.length) throw new Error(`No registered profile found for: ${missing.join(", ")}`);
      }
      const memberIds = [...new Set([state.user.id, ...selectedContactIds, ...matched.map(p => p.id)])];
      if (type === "direct" && memberIds.length !== 2) throw new Error("A private conversation needs one other user.");
      if (type === "group" && memberIds.length < 2) throw new Error("A group needs at least one other person.");
      // RPC performs creation atomically and only after validating the caller.
      const { data: conversationId, error } = await state.supabase.rpc("create_conversation", {
        conversation_type: type, conversation_name: type === "group" ? groupName : null, member_ids: memberIds
      });
      if (error) throw error;
      $("new-chat-dialog").close();
      $("new-chat-form").reset();
      $("group-contact-picker").querySelectorAll('input[name="group-contact"]').forEach(input => { input.checked = false; });
      updateNewChatType();
      await loadConversations();
      if (conversationId) await openConversation(conversationId);
      toast("Conversation created.");
    } catch (error) { notice("new-chat-message", friendlyError(error)); }
    finally { button.disabled = false; button.textContent = "Create conversation"; }
  }
  function renderViewedProfile(profile) {
    const name = getProfileDisplayName(profile, null);
    $("view-profile-title").textContent = name;
    applyAvatarStyles($("view-profile-avatar"), profile, initials(name));
    $("view-profile-avatar").setAttribute("aria-label", `${name}'s profile avatar`);
    $("view-profile-username").textContent = profile.username ? `@${profile.username}` : "";
    $("view-profile-username").classList.toggle("hidden", !profile.username);
    $("view-profile-status").textContent = profile.status_message || "";
    $("view-profile-status").classList.toggle("hidden", !profile.status_message);
    $("view-profile-bio").textContent = profile.bio || "No biography added.";
    const ownProfile = profile.id === state.user.id;
    $("view-profile-edit").classList.toggle("hidden", !ownProfile);
    $("view-profile-start-chat").classList.toggle("hidden", ownProfile);
    if (profile.avatar_resolution_failed) {
      notice("view-profile-message", "This profile photo could not be loaded.");
    } else {
      notice("view-profile-message", "");
    }
  }
  async function openUserProfile(userId) {
    if (!state.user || !userId) return;
    if (state.openingProfileId === userId && state.viewedProfileId === userId && $("view-profile-dialog").open) return;
    clearTimeout(state.directorySearchTimer);
    if ($("directory-dialog").open) $("directory-dialog").close();
    state.viewedProfileId = userId;
    state.openingProfileId = userId;
    const requestId = ++state.profileRequestId;
    $("view-profile-title").textContent = "Loading profile…";
    $("view-profile-avatar").textContent = "…";
    $("view-profile-avatar").style.backgroundImage = "";
    $("view-profile-username").textContent = "";
    $("view-profile-status").textContent = "";
    $("view-profile-bio").textContent = "";
    $("view-profile-edit").classList.add("hidden");
    $("view-profile-start-chat").classList.add("hidden");
    notice("view-profile-message", "Loading profile…");
    if (!$("view-profile-dialog").open) $("view-profile-dialog").showModal();
    let timeoutId;
    try {
      const profilePromise = (async () => {
        if (userId === state.user.id) return state.profile;
        if (state.directoryProfiles.has(userId)) return state.directoryProfiles.get(userId);
        const { data, error } = await state.supabase.rpc("get_public_profile", { target_profile_id: userId });
        if (error) throw error;
        let profile = Array.isArray(data) ? data[0] : data;
        if (!profile) throw new Error("This profile is unavailable.");
        return resolveProfileAvatar(profile);
      })();
      const timeoutPromise = new Promise((resolve, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error("Profile loading timed out. Check your connection and Supabase setup, then try again.")),
          PROFILE_LOAD_TIMEOUT_MS
        );
      });
      const profile = await Promise.race([profilePromise, timeoutPromise]);
      if (requestId !== state.profileRequestId || !profile) return;
      renderViewedProfile(profile);
    } catch (error) {
      if (requestId !== state.profileRequestId) return;
      $("view-profile-title").textContent = "Profile unavailable";
      $("view-profile-avatar").textContent = "?";
      notice("view-profile-message", friendlyError(error));
    } finally {
      clearTimeout(timeoutId);
      if (state.openingProfileId === userId) state.openingProfileId = null;
    }
  }
  function openPeopleDirectory() {
    state.directoryRequestId += 1;
    state.directorySuggestionRequestId += 1;
    $("directory-search").value = "";
    $("directory-results").innerHTML = "";
    $("directory-suggestions").classList.remove("hidden");
    $("directory-suggestion-results").innerHTML = "";
    notice("directory-message", "Search ChatFlow profiles. Emails are not shown.");
    if (!$("directory-dialog").open) $("directory-dialog").showModal();
    $("directory-search").focus();
    loadSuggestedPeople();
  }
  function renderDirectoryProfiles(container, profiles, contactLabel) {
    container.innerHTML = profiles.map(profile => `
      <div class="directory-result" data-directory-card="${escapeText(profile.id)}">
        <button class="directory-profile profile-trigger" data-profile-id="${escapeText(profile.id)}" type="button" aria-label="View ${escapeText(profile.display_name)}'s profile">
          <span class="avatar" data-directory-avatar="${escapeText(profile.id)}">${escapeText(initials(profile.display_name))}</span>
          <span class="directory-result-copy">
            <strong>${escapeText(profile.display_name)}</strong>
            <span>${profile.username ? `@${escapeText(profile.username)}` : escapeText(profile.status_message || "ChatFlow member")}</span>
            ${profile.bio ? `<small>${escapeText(profile.bio)}</small>` : ""}
          </span>
        </button>
        <span class="directory-result-actions">
          <button class="directory-profile-action profile-trigger" data-profile-id="${escapeText(profile.id)}" type="button">View profile</button>
          <button class="directory-action" type="button" data-contact-profile="${escapeText(profile.id)}">${contactLabel}</button>
        </span>
      </div>`).join("");
    for (const profile of profiles) state.directoryProfiles.set(profile.id, profile);
    container.querySelectorAll("[data-directory-avatar]").forEach(element => {
      const profile = profiles.find(item => item.id === element.dataset.directoryAvatar);
      applyAvatarStyles(element, profile, initials(profile?.display_name));
    });
    container.querySelectorAll("[data-contact-profile]").forEach(button => {
      button.addEventListener("click", async event => {
        event.preventDefault();
        event.stopPropagation();
        await startDirectConversation(button.dataset.contactProfile, button);
      });
    });
  }
  async function loadSuggestedPeople() {
    const requestId = ++state.directorySuggestionRequestId;
    const results = $("directory-suggestion-results");
    const message = $("directory-suggestions-message");
    results.innerHTML = "";
    message.textContent = "Finding people to connect with…";
    try {
      const { data, error } = await state.supabase.rpc("suggest_public_profiles", { result_limit: 8 });
      if (error) throw error;
      if (requestId !== state.directorySuggestionRequestId || !$("directory-dialog").open
        || $("directory-search").value.trim()) return;
      const profiles = await Promise.all((data || []).map(resolveProfileAvatar));
      if (requestId !== state.directorySuggestionRequestId || !$("directory-dialog").open
        || $("directory-search").value.trim()) return;
      if (!profiles.length) {
        message.textContent = "No new suggestions right now. Try searching for someone by name or username.";
        return;
      }
      renderDirectoryProfiles(results, profiles, "Message");
      message.textContent = "People you can connect with:";
    } catch (error) {
      if (requestId !== state.directorySuggestionRequestId) return;
      message.textContent = friendlyError(error);
    }
  }
  async function searchPeopleDirectory() {
    const searchTerm = $("directory-search").value.trim();
    const requestId = ++state.directoryRequestId;
    const results = $("directory-results");
    if (searchTerm.length < 2) {
      results.innerHTML = "";
      if (!searchTerm) {
        $("directory-suggestions").classList.remove("hidden");
        notice("directory-message", "Search ChatFlow profiles. Emails are not shown.");
        loadSuggestedPeople();
      } else {
        $("directory-suggestions").classList.add("hidden");
        notice("directory-message", "Enter at least 2 characters to search by name or username.");
      }
      return;
    }
    $("directory-suggestions").classList.add("hidden");
    results.innerHTML = `<div class="directory-empty">Searching…</div>`;
    notice("directory-message", "Searching profiles…");
    try {
      const { data, error } = await state.supabase.rpc("search_public_profiles", {
        search_term: searchTerm,
        result_limit: 30
      });
      if (error) throw error;
      if (requestId !== state.directoryRequestId || !$("directory-dialog").open) return;
      const profiles = await Promise.all((data || []).map(resolveProfileAvatar));
      if (requestId !== state.directoryRequestId) return;
      if (!profiles.length) {
        results.innerHTML = `<div class="directory-empty">No profiles matched “${escapeText(searchTerm)}”.</div>`;
        notice("directory-message", "");
        return;
      }
      renderDirectoryProfiles(results, profiles, "Add contact");
      notice("directory-message", `Showing ${profiles.length} profile${profiles.length === 1 ? "" : "s"} (up to 30).`);
    } catch (error) {
      if (requestId !== state.directoryRequestId) return;
      results.innerHTML = "";
      notice("directory-message", friendlyError(error));
    }
  }
  async function startDirectConversation(userId, actionButton = $("view-profile-start-chat")) {
    if (!state.user || !userId || userId === state.user.id || state.contactingProfileIds.has(userId)) return;
    state.contactingProfileIds.add(userId);
    const previousLabel = actionButton?.textContent;
    if (actionButton) {
      actionButton.disabled = true;
      actionButton.textContent = "Opening…";
    }
    if (state.viewedProfileId === userId && $("view-profile-dialog").open) {
      notice("view-profile-message", "");
    }
    try {
      const { data: conversationId, error } = await state.supabase.rpc("create_conversation", {
        conversation_type: "direct",
        conversation_name: null,
        member_ids: [state.user.id, userId]
      });
      if (error) throw error;
      if (!conversationId) throw new Error("ChatFlow could not open this conversation.");
      const { error: restoreError } = await state.supabase.rpc("set_direct_contact_hidden", {
        target_conversation: conversationId,
        is_hidden: false
      });
      if (restoreError) throw restoreError;
      if ($("view-profile-dialog").open) $("view-profile-dialog").close();
      if ($("directory-dialog").open) $("directory-dialog").close();
      await loadConversations();
      await openConversation(conversationId);
      toast("Contact added. Conversation started.");
    } catch (error) {
      const message = friendlyError(error);
      if (state.viewedProfileId === userId && $("view-profile-dialog").open) notice("view-profile-message", message);
      else if ($("directory-dialog").open) notice("directory-message", message);
      else toast(message);
    } finally {
      state.contactingProfileIds.delete(userId);
      if (actionButton) {
        actionButton.disabled = false;
        actionButton.textContent = previousLabel;
      }
    }
  }
  async function showConversationInfo() {
    const c = state.conversations.find(x => x.id === state.activeId);
    if (!c) return;
    $("info-title").textContent = c.displayName;
    $("info-description").textContent = c.type === "group" ? `Group chat · ${c.memberCount} members` : "Private conversation";
    const canManageGroup = c.type === "group" && c.created_by === state.user.id;
    $("group-add-people").classList.toggle("hidden", c.type !== "group");
    $("group-management").classList.toggle("hidden", !canManageGroup);
    if (c.type === "group") renderGroupAddContactPicker(c);
    if (canManageGroup) {
      resetGroupAvatarDraft();
      $("group-edit-name").value = c.name || "";
      $("group-avatar-remove").disabled = !c.group_avatar_path;
      $("group-edit-message").textContent = "";
      renderGroupAvatarPreview(c.groupAvatarUrl);
    }
    renderConversationInfoMembers(c);
    if (!$("info-dialog").open) $("info-dialog").showModal();
  }
  function renderConversationInfoMembers(conversation) {
    $("info-members").innerHTML = conversation.members.map(member => `<div class="member-row"><button class="avatar profile-trigger" data-profile-id="${escapeText(member.user_id)}" type="button" aria-label="View ${escapeText(member.profile.display_name)}'s profile" data-info-avatar="${escapeText(member.user_id)}">${escapeText(initials(member.profile.display_name))}</button><button class="profile-trigger" data-profile-id="${escapeText(member.user_id)}" type="button">${escapeText(member.profile.display_name)}${member.user_id === state.user.id ? " (you)" : ""}</button></div>`).join("");
    $("info-members").querySelectorAll("[data-info-avatar]").forEach(element => {
      const member = conversation.members.find(item => item.user_id === element.dataset.infoAvatar);
      applyAvatarStyles(element, member?.profile || null, initials(member?.profile.display_name));
    });
  }
  function renderGroupAddContactPicker(conversation) {
    const query = $("group-add-contact-search").value.trim().toLowerCase();
    const selectedIds = new Set([...$("group-add-contact-picker").querySelectorAll('input[name="group-add-contact"]:checked')].map(input => input.value));
    const members = new Set(conversation.members.map(member => member.user_id));
    const contacts = getExistingDirectContacts().filter(({ id, profile }) => {
      if (members.has(id)) return false;
      const name = profile.display_name || "";
      const username = profile.username || "";
      return !query || name.toLowerCase().includes(query) || username.toLowerCase().includes(query);
    });
    const picker = $("group-add-contact-picker");
    picker.innerHTML = contacts.length ? contacts.map(({ id, profile }) => `
      <label class="group-contact-option">
        <input type="checkbox" name="group-add-contact" value="${escapeText(id)}" ${selectedIds.has(id) ? "checked" : ""}>
        <span class="avatar" data-group-contact-avatar="${escapeText(id)}">${escapeText(initials(profile.display_name || "ChatFlow user"))}</span>
        <span class="group-contact-copy"><strong>${escapeText(profile.display_name || "ChatFlow user")}</strong>
          <small>${profile.username ? `@${escapeText(profile.username)}` : "Direct-chat contact"}</small></span>
      </label>`).join("") : `<p class="muted small-text">${query ? "No contacts match your search." : "All your direct-chat contacts are already in this group, or you have no contacts to add."}</p>`;
    picker.querySelectorAll("[data-group-contact-avatar]").forEach(element => {
      const contact = contacts.find(item => item.id === element.dataset.groupContactAvatar);
      applyAvatarStyles(element, contact?.profile || null, initials(contact?.profile.display_name || "ChatFlow user"));
    });
    $("add-group-contacts").disabled = state.addingGroupMembers || contacts.length === 0;
  }
  async function addSelectedGroupContacts() {
    if (state.addingGroupMembers) return;
    const conversation = state.conversations.find(item => item.id === state.activeId);
    if (!conversation || conversation.type !== "group") return;
    const memberIds = [...$("group-add-contact-picker").querySelectorAll('input[name="group-add-contact"]:checked')].map(input => input.value);
    if (!memberIds.length) {
      notice("group-add-message", "Choose at least one contact to add.");
      return;
    }
    const button = $("add-group-contacts");
    state.addingGroupMembers = true;
    button.disabled = true;
    button.textContent = "Adding people…";
    $("group-add-contact-search").disabled = true;
    $("group-add-contact-picker").querySelectorAll("input").forEach(input => { input.disabled = true; });
    notice("group-add-message", "");
    try {
      const { data: addedCount, error } = await state.supabase.rpc("add_group_members", {
        target_conversation: conversation.id,
        new_member_ids: memberIds
      });
      if (error) throw error;
      notice("group-add-message", addedCount
        ? `Added ${addedCount} ${addedCount === 1 ? "person" : "people"} to the group.`
        : "Those contacts are already in the group.");
      if (addedCount) toast(`Added ${addedCount} ${addedCount === 1 ? "person" : "people"} to the group.`);
      try {
        await loadConversations();
        const refreshedConversation = state.conversations.find(item => item.id === conversation.id);
        if (refreshedConversation) {
          $("info-title").textContent = refreshedConversation.displayName;
          $("info-description").textContent = `Group chat · ${refreshedConversation.memberCount} members`;
          renderGroupAddContactPicker(refreshedConversation);
          renderConversationInfoMembers(refreshedConversation);
        }
      } catch (refreshError) {
        toast(`Contacts were added, but the group view could not be refreshed: ${friendlyError(refreshError)}`);
      }
    } catch (error) {
      notice("group-add-message", friendlyError(error));
    } finally {
      state.addingGroupMembers = false;
      button.textContent = "Add selected people";
      $("group-add-contact-search").disabled = false;
      if ($("info-dialog").open) renderGroupAddContactPicker(state.conversations.find(item => item.id === state.activeId) || conversation);
    }
  }
  async function deleteCurrentGroup() {
    if (state.deletingGroup) return;
    const conversation = state.conversations.find(item => item.id === state.activeId);
    if (!conversation || conversation.type !== "group" || conversation.created_by !== state.user.id) return;
    const confirmed = window.confirm(`Delete "${conversation.displayName}" for everyone? This permanently removes the group and its messages.`);
    if (!confirmed) return;
    state.deletingGroup = true;
    const button = $("delete-group");
    button.disabled = true;
    button.textContent = "Deleting group…";
    try {
      const { error } = await state.supabase.rpc("delete_group_conversation", {
        target_conversation: conversation.id
      });
      if (error) throw error;
      $("info-dialog").close();
      state.conversations = state.conversations.filter(item => item.id !== conversation.id);
      renderEmptyChat();
      toast("Group and its messages were deleted.");
      try {
        await loadConversations();
      } catch (refreshError) {
        toast(`Group was deleted, but the conversation list could not be refreshed: ${friendlyError(refreshError)}`);
      }
    } catch (error) {
      $("group-edit-message").textContent = friendlyError(error);
      toast(friendlyError(error));
    } finally {
      state.deletingGroup = false;
      button.disabled = false;
      button.textContent = "Delete group";
    }
  }
  function resetGroupAvatarDraft() {
    if (state.groupAvatarDraft.previewUrl) URL.revokeObjectURL(state.groupAvatarDraft.previewUrl);
    state.groupAvatarDraft = { file: null, previewUrl: null, remove: false };
    $("group-avatar-input").value = "";
  }
  function renderGroupAvatarPreview(avatarUrl) {
    const conversation = state.conversations.find(item => item.id === state.activeId);
    const name = $("group-edit-name").value.trim() || conversation?.displayName || "Group";
    applyAvatarStyles($("group-avatar-preview"), avatarUrl ? { avatar_url: avatarUrl } : null, initials(name));
  }
  async function saveGroupDetails() {
    if (state.savingGroupDetails) return;
    const conversation = state.conversations.find(item => item.id === state.activeId);
    if (!conversation || conversation.type !== "group" || conversation.created_by !== state.user.id) return;
    const name = $("group-edit-name").value.trim().replace(/\s+/g, " ");
    if (!name || name.length > 80) {
      notice("group-edit-message", "Group name must contain 1 to 80 characters.");
      return;
    }
    const button = $("save-group-details");
    const inputs = $("group-management").querySelectorAll("input, button");
    const previousPath = conversation.group_avatar_path || null;
    let uploadedPath = null;
    let updateCommitted = false;
    state.savingGroupDetails = true;
    inputs.forEach(control => { control.disabled = true; });
    button.textContent = state.groupAvatarDraft.file ? "Uploading photo…" : "Saving…";
    notice("group-edit-message", "");
    try {
      let nextPath = previousPath;
      if (state.groupAvatarDraft.file) {
        const file = state.groupAvatarDraft.file;
        const mimeType = await validateAvatarFile(file);
        const extension = mimeType === "image/jpeg" ? "jpg" : mimeType.split("/")[1];
        const filename = globalThis.crypto?.randomUUID
          ? `${crypto.randomUUID()}.${extension}`
          : `${Date.now()}-${Math.random().toString(36).slice(2)}.${extension}`;
        uploadedPath = `${conversation.id}/${filename}`;
        const { error: uploadError } = await state.supabase.storage.from(GROUP_AVATAR_BUCKET).upload(uploadedPath, file, {
          cacheControl: "3600", upsert: false, contentType: mimeType
        });
        if (uploadError) throw uploadError;
        nextPath = uploadedPath;
      } else if (state.groupAvatarDraft.remove) {
        nextPath = null;
      }
      const { data: updated, error: updateError } = await state.supabase.from("conversations")
        .update({ name, group_avatar_path: nextPath })
        .eq("id", conversation.id).eq("created_by", state.user.id)
        .select("id, name, group_avatar_path").single();
      if (updateError) throw updateError;
      updateCommitted = true;
      conversation.name = updated.name;
      conversation.displayName = updated.name;
      conversation.group_avatar_path = updated.group_avatar_path;
      conversation.groupAvatarUrl = "";
      renderConversations();
      if (state.activeId === conversation.id) updateActiveHeader(conversation);
      if (previousPath && previousPath !== nextPath) {
        const { error: removeError } = await state.supabase.storage.from(GROUP_AVATAR_BUCKET).remove([previousPath]);
        if (removeError) toast(`Group details saved, but old photo cleanup failed: ${friendlyError(removeError)}`);
      }
      if (nextPath) {
        const { data: signed, error: signError } = await state.supabase.storage.from(GROUP_AVATAR_BUCKET).createSignedUrl(nextPath, 3600);
        if (signError) {
          console.warn(`Group details saved but photo preview could not be refreshed for ${conversation.id}`, signError);
          toast("Group details saved, but the photo preview could not be refreshed.");
        } else {
          conversation.groupAvatarUrl = signed.signedUrl;
        }
      }
      renderConversations();
      updateActiveHeader(conversation);
      $("info-title").textContent = conversation.displayName;
      $("info-description").textContent = `Group chat · ${conversation.memberCount} members`;
      $("group-avatar-remove").disabled = !conversation.group_avatar_path;
      renderGroupAvatarPreview(conversation.groupAvatarUrl);
      resetGroupAvatarDraft();
      $("group-edit-message").textContent = "Group details saved.";
      toast("Group details saved.");
    } catch (error) {
      if (uploadedPath && !updateCommitted) {
        const { error: cleanupError } = await state.supabase.storage.from(GROUP_AVATAR_BUCKET).remove([uploadedPath]);
        if (cleanupError) toast(`Group update failed and uploaded-photo cleanup failed: ${friendlyError(cleanupError)}`);
      }
      notice("group-edit-message", friendlyError(error));
    } finally {
      state.savingGroupDetails = false;
      inputs.forEach(control => { control.disabled = false; });
      $("group-avatar-remove").disabled = !conversation.group_avatar_path;
      button.textContent = "Save group details";
    }
  }
  function resetProfileDraft() {
    if (state.profileDraft.previewUrl) URL.revokeObjectURL(state.profileDraft.previewUrl);
    state.profileDraft = { avatarFile: null, previewUrl: null, mimeType: null, removeAvatar: false };
    if ($("profile-avatar-input")) $("profile-avatar-input").value = "";
    $("cancel-photo-selection").classList.add("hidden");
    $("avatar-upload-status").textContent = "";
    $("upload-photo").textContent = hasStoredAvatar(state.profile) ? "Change photo" : "Upload photo";
    $("remove-photo").disabled = !hasStoredAvatar(state.profile);
  }
  function updateProfileCounter() {
    const bio = $("profile-bio");
    const counter = $("profile-bio-counter");
    if (!bio || !counter) return;
    counter.textContent = `${bio.value.length}/180`;
  }
  function renderProfilePreview(avatarUrl) {
    const target = $("profile-avatar-preview");
    if (!target) return;
    if (avatarUrl) {
      applyAvatarStyles(target, { avatar_url: avatarUrl }, initials(getProfileDisplayName()));
    } else {
      const fallback = getProfileDisplayName();
      target.textContent = initials(fallback);
      target.style.backgroundImage = "";
      target.classList.remove("avatar-photo");
    }
  }
  async function validateAvatarFile(file) {
    if (!file || file.size < 1 || file.size > MAX_AVATAR_SIZE) {
      throw new Error("Choose an image between 1 byte and 5 MB.");
    }
    const extension = file.name.split(".").pop().toLowerCase();
    const byExtension = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };
    const expectedType = byExtension[extension];
    const mimeType = file.type && file.type !== "application/octet-stream" ? file.type : expectedType;
    if (!expectedType || !["image/jpeg", "image/png", "image/webp"].includes(mimeType) || mimeType !== expectedType) {
      throw new Error("Choose a JPEG, PNG, or WebP image with a matching file extension.");
    }
    const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    const startsWith = (...signature) => signature.every((byte, index) => bytes[index] === byte);
    const validSignature = mimeType === "image/jpeg"
      ? startsWith(0xff, 0xd8, 0xff)
      : mimeType === "image/png"
        ? startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
        : startsWith(0x52, 0x49, 0x46, 0x46) && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
    if (!validSignature) throw new Error("This file does not appear to be a valid JPEG, PNG, or WebP image.");
    return mimeType;
  }
  function cancelAvatarSelection() {
    if (state.profileDraft.previewUrl) URL.revokeObjectURL(state.profileDraft.previewUrl);
    state.profileDraft = { avatarFile: null, previewUrl: null, mimeType: null, removeAvatar: false };
    $("profile-avatar-input").value = "";
    $("cancel-photo-selection").classList.add("hidden");
    $("avatar-upload-status").textContent = "";
    $("upload-photo").textContent = hasStoredAvatar(state.profile) ? "Change photo" : "Upload photo";
    renderProfilePreview(getProfileAvatarUrl(state.profile));
  }
  function applyProfileToConversationViews() {
    for (const conversation of state.conversations) {
      conversation.members = conversation.members.map(member => member.user_id === state.user.id
        ? { ...member, profile: state.profile }
        : member);
      if (conversation.type === "direct") {
        const other = conversation.members.find(member => member.user_id !== state.user.id);
        conversation.displayName = other?.profile.display_name || other?.profile.email || "Private chat";
      }
    }
    renderProfileHeader();
    renderConversations();
    if (state.activeId) {
      const active = state.conversations.find(conversation => conversation.id === state.activeId);
      if (active) updateActiveHeader(active);
      renderMessages(false);
    }
    if ($("info-dialog").open) showConversationInfo();
  }
  function setProfileSaving(isSaving, buttonLabel = "Save changes") {
    state.savingProfile = isSaving;
    $("profile-dialog").querySelectorAll("input, textarea, button").forEach(control => {
      control.disabled = isSaving || (control.id === "remove-photo" && !hasStoredAvatar(state.profile));
    });
    $("save-profile").textContent = isSaving ? buttonLabel : "Save changes";
  }
  function openProfileEditor() {
    if (!state.user || !state.profile) return;
    resetProfileDraft();
    $("profile-display-name").value = state.profile.display_name || "";
    $("profile-username").value = state.profile.username || "";
    $("profile-status").value = state.profile.status_message || "";
    $("profile-bio").value = state.profile.bio || "";
    updateProfileCounter();
    const preview = getProfileAvatarUrl(state.profile);
    renderProfilePreview(preview);
    notice("profile-message", "");
    if (state.profile.avatar_resolution_failed) {
      $("avatar-upload-status").textContent = "The saved photo could not be loaded. Upload a replacement or remove it.";
    }
    setProfileSaving(false);
    $("profile-dialog").showModal();
  }
  function closeProfileEditor() {
    if (state.savingProfile) return;
    if ($("profile-dialog").open) $("profile-dialog").close();
    resetProfileDraft();
    notice("profile-message", "");
  }
  async function saveProfileChanges(event) {
    event.preventDefault();
    if (!state.user || state.savingProfile) return;
    const displayName = $("profile-display-name").value.trim().replace(/\s+/g, " ");
    const username = $("profile-username").value.trim().replace(/^@/, "").toLowerCase();
    const statusMessage = $("profile-status").value.trim();
    const bio = $("profile-bio").value.trim();
    if (!displayName || displayName.length > 40) {
      notice("profile-message", "Display name must contain 1 to 40 characters.");
      return;
    }
    if (username && !/^[a-z0-9._-]{2,30}$/.test(username)) {
      notice("profile-message", "Username must be 2–30 characters using letters, numbers, dots, underscores, or hyphens.");
      return;
    }
    if (bio.length > 180 || statusMessage.length > 80) {
      notice("profile-message", "Bio is limited to 180 characters and status to 80 characters.");
      return;
    }
    setProfileSaving(true, state.profileDraft.avatarFile ? "Uploading photo…" : "Saving profile…");
    let uploadedPath = null;
    let profileSaveStage = "profile update";
    const previousPath = state.profile.avatar_path || getLegacyAvatarPath(state.profile);
    let updateCommitted = false;
    try {
      let nextAvatarPath = previousPath;
      let nextAvatarUrl = state.profile.avatar_url || null;
      if (state.profileDraft.avatarFile) {
        const file = state.profileDraft.avatarFile;
        const extension = state.profileDraft.mimeType === "image/jpeg" ? "jpg" : state.profileDraft.mimeType.split("/")[1];
        const filename = globalThis.crypto?.randomUUID
          ? `${crypto.randomUUID()}.${extension}`
          : `${Date.now()}-${Math.random().toString(36).slice(2)}.${extension}`;
        const newAvatarPath = `${state.user.id}/${filename}`;
        $("avatar-upload-status").textContent = "Uploading your photo…";
        setProfileSaving(true, "Uploading photo…");
        profileSaveStage = "avatar upload";
        const uploadResult = await state.supabase.storage.from(PROFILE_BUCKET).upload(newAvatarPath, file, {
          cacheControl: "3600",
          upsert: false,
          contentType: state.profileDraft.mimeType
        });
        if (uploadResult.error) throw uploadResult.error;
        uploadedPath = newAvatarPath;
        nextAvatarPath = newAvatarPath;
        nextAvatarUrl = state.supabase.storage.from(PROFILE_BUCKET).getPublicUrl(newAvatarPath).data.publicUrl;
        $("avatar-upload-status").textContent = "Photo uploaded. Saving profile…";
      } else if (state.profileDraft.removeAvatar) {
        nextAvatarPath = null;
        nextAvatarUrl = null;
      }
      setProfileSaving(true, "Saving profile…");
      profileSaveStage = "profile update";
      const { data: updatedProfile, error: updateError } = await state.supabase.from("profiles")
        .update({
          display_name: displayName,
          avatar_url: nextAvatarUrl,
          avatar_path: nextAvatarPath,
          username: username || null,
          bio: bio || null,
          status_message: statusMessage || null
        })
        .eq("id", state.user.id)
        .select("id, display_name, email, avatar_url, avatar_path, username, bio, status_message, updated_at, created_at")
        .single();
      if (updateError) throw updateError;
      updateCommitted = true;
      state.profile = await resolveProfileAvatar(updatedProfile);
      applyProfileToConversationViews();
      let cleanupWarning = "";
      const obsoletePath = state.profileDraft.removeAvatar ? previousPath
        : (uploadedPath && previousPath && previousPath !== uploadedPath ? previousPath : null);
      if (obsoletePath) {
        const { error: deleteError } = await state.supabase.storage.from(PROFILE_BUCKET).remove([obsoletePath]);
        if (deleteError) cleanupWarning = ` Profile saved, but the previous photo could not be deleted: ${friendlyError(deleteError, "avatar removal")}`;
      }
      setProfileSaving(false);
      closeProfileEditor();
      toast(`Profile saved.${cleanupWarning}`);
    } catch (error) {
      let message = friendlyError(error, profileSaveStage);
      if (uploadedPath && !updateCommitted) {
        const { error: cleanupError } = await state.supabase.storage.from(PROFILE_BUCKET).remove([uploadedPath]);
        if (cleanupError) message += ` The previous profile remains unchanged, but cleanup of the newly uploaded file failed: ${friendlyError(cleanupError, "avatar removal")}`;
      }
      if (updateCommitted) {
        notice("profile-message", `Profile saved, but the display could not be refreshed: ${message}`, true);
        toast(`Profile saved. ${message}`);
      } else {
        if (profileSaveStage === "avatar upload") {
          $("avatar-upload-status").textContent = "Photo upload failed. Your saved profile photo is unchanged.";
        } else {
          $("avatar-upload-status").textContent = "Profile save failed. Your saved profile is unchanged.";
        }
        notice("profile-message", message);
      }
    } finally {
      if ($("profile-dialog").open) setProfileSaving(false);
    }
  }
  function wireEvents() {
    document.addEventListener("click", event => {
      const profileTrigger = event.target.closest("[data-profile-id]");
      if (profileTrigger) {
        event.preventDefault();
        event.stopPropagation();
        openUserProfile(profileTrigger.dataset.profileId);
        return;
      }
    });
    document.addEventListener("keydown", event => {
      const profileTrigger = event.target.closest("[data-profile-id][role='button']");
      if (profileTrigger && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        openUserProfile(profileTrigger.dataset.profileId);
      }
    });
    $("auth-switch").addEventListener("click", () => setAuthMode(!state.isRegister));
    $("auth-form").addEventListener("submit", async e => {
      e.preventDefault(); notice("auth-message", "");
      const email = $("email").value.trim().toLowerCase();
      const password = $("password").value;
      const button = $("auth-submit"); button.disabled = true;
      try {
        if (state.isRegister) {
          const displayName = $("display-name").value.trim();
          if (!displayName) throw new Error("Please enter a display name.");
          const { data, error } = await state.supabase.auth.signUp({
            email, password, options: { data: { display_name: displayName } }
          });
          if (error) throw error;
          if (!data.session) {
            notice("auth-message", "Account created. Check your email to confirm it, then sign in.", true);
          } else {
            await enterApp(data.user);
          }
        } else {
          const { data, error } = await state.supabase.auth.signInWithPassword({ email, password });
          if (error) throw error;
          await enterApp(data.user);
        }
      } catch (error) { notice("auth-message", friendlyError(error)); }
      finally { button.disabled = false; }
    });
    $("sign-out").addEventListener("click", signOut);
    $("edit-profile-button").addEventListener("click", openProfileEditor);
    $("notification-settings").addEventListener("click", openNotificationSettings);
    $("close-notification-settings").addEventListener("click", () => $("notification-settings-dialog").close());
    $("notification-settings-done").addEventListener("click", () => $("notification-settings-dialog").close());
    $("enable-first-login-notifications").addEventListener("click", enableNotificationsFromWelcome);
    $("notification-welcome-not-now").addEventListener("click", dismissNotificationWelcome);
    $("notification-welcome-dialog").addEventListener("close", markNotificationWelcomeSeen);
    $("desktop-notifications-enabled").addEventListener("change", event => setDesktopNotifications(event.target.checked));
    $("push-notifications-button").addEventListener("click", togglePushNotifications);
    $("notification-sound-enabled").addEventListener("change", async event => {
      try {
        await saveNotificationPreferences({ sound_enabled: event.target.checked });
        notice("notification-settings-message", "Sound preference saved.", true);
      } catch (error) {
        syncNotificationSettingsUI();
        notice("notification-settings-message", friendlyError(error));
      }
    });
    $("notification-previews-enabled").addEventListener("change", async event => {
      try {
        await saveNotificationPreferences({ previews_enabled: event.target.checked });
        notice("notification-settings-message", "Preview preference saved.", true);
      } catch (error) {
        syncNotificationSettingsUI();
        notice("notification-settings-message", friendlyError(error));
      }
    });
    $("discover-people").addEventListener("click", openPeopleDirectory);
    $("directory-search").addEventListener("input", () => {
      const hasSearchTerm = !!$("directory-search").value.trim();
      $("directory-suggestions").classList.toggle("hidden", hasSearchTerm);
      if (hasSearchTerm) state.directorySuggestionRequestId += 1;
      clearTimeout(state.directorySearchTimer);
      state.directorySearchTimer = setTimeout(searchPeopleDirectory, 250);
    });
    $("close-directory").addEventListener("click", () => $("directory-dialog").close());
    $("directory-close-button").addEventListener("click", () => $("directory-dialog").close());
    $("directory-dialog").addEventListener("close", () => {
      clearTimeout(state.directorySearchTimer);
      state.directoryRequestId += 1;
      state.directorySuggestionRequestId += 1;
    });
    $("close-view-profile").addEventListener("click", () => $("view-profile-dialog").close());
    $("view-profile-close").addEventListener("click", () => $("view-profile-dialog").close());
    $("view-profile-dialog").addEventListener("close", () => {
      state.profileRequestId += 1;
      state.openingProfileId = null;
    });
    $("view-profile-edit").addEventListener("click", () => {
      if (state.viewedProfileId !== state.user?.id) return;
      $("view-profile-dialog").close();
      openProfileEditor();
    });
    $("view-profile-start-chat").addEventListener("click", () => startDirectConversation(state.viewedProfileId));
    $("upload-photo").addEventListener("click", () => $("profile-avatar-input").click());
    $("remove-photo").addEventListener("click", () => {
      if (!hasStoredAvatar(state.profile) && !state.profileDraft.avatarFile) return;
      if (!window.confirm("Remove your profile photo? The change is applied when you save your profile.")) return;
      if (state.profileDraft.previewUrl) URL.revokeObjectURL(state.profileDraft.previewUrl);
      state.profileDraft = { avatarFile: null, previewUrl: null, mimeType: null, removeAvatar: true };
      $("profile-avatar-input").value = "";
      $("cancel-photo-selection").classList.remove("hidden");
      $("upload-photo").textContent = "Upload photo";
      $("avatar-upload-status").textContent = "Photo will be removed when you save.";
      renderProfilePreview("");
    });
    $("cancel-photo-selection").addEventListener("click", cancelAvatarSelection);
    $("profile-avatar-input").addEventListener("change", async event => {
      const file = event.target.files && event.target.files[0];
      if (!file) return;
      try {
        const mimeType = await validateAvatarFile(file);
        if (state.profileDraft.previewUrl) URL.revokeObjectURL(state.profileDraft.previewUrl);
        const previewUrl = URL.createObjectURL(file);
        state.profileDraft = { avatarFile: file, previewUrl, mimeType, removeAvatar: false };
        $("cancel-photo-selection").classList.remove("hidden");
        $("upload-photo").textContent = "Change photo";
        $("avatar-upload-status").textContent = "Preview ready. Save changes to upload.";
        notice("profile-message", "");
        renderProfilePreview(previewUrl);
      } catch (error) {
        $("profile-avatar-input").value = "";
        notice("profile-message", friendlyError(error));
      }
    });
    $("profile-bio").addEventListener("input", updateProfileCounter);
    $("profile-cancel").addEventListener("click", closeProfileEditor);
    $("profile-dialog").addEventListener("click", (event) => {
      if (event.target === $("profile-dialog")) closeProfileEditor();
    });
    $("profile-form").addEventListener("submit", saveProfileChanges);
    $("profile-dialog").querySelectorAll("[data-close-profile]").forEach(button => button.addEventListener("click", closeProfileEditor));
    $("profile-dialog").addEventListener("cancel", event => {
      if (state.savingProfile) event.preventDefault();
    });
    $("new-chat").addEventListener("click", openNewChat);
    $("welcome-new-chat").addEventListener("click", openNewChat);
    $("new-chat-dialog").querySelectorAll("[data-close-dialog]").forEach(button => {
      button.addEventListener("click", () => $("new-chat-dialog").close());
    });
    $("new-chat-form").addEventListener("submit", createConversation);
    $("conversation-type").addEventListener("change", updateNewChatType);
    $("group-contact-search").addEventListener("input", renderGroupContactPicker);
    $("group-edit-name").addEventListener("input", () => {
      if (!state.groupAvatarDraft.file && !state.groupAvatarDraft.remove) {
        const conversation = state.conversations.find(item => item.id === state.activeId);
        renderGroupAvatarPreview(conversation?.groupAvatarUrl);
      }
    });
    $("group-avatar-choose").addEventListener("click", () => $("group-avatar-input").click());
    $("group-avatar-input").addEventListener("change", async event => {
      const file = event.target.files?.[0];
      if (!file) return;
      try {
        await validateAvatarFile(file);
        if (state.groupAvatarDraft.previewUrl) URL.revokeObjectURL(state.groupAvatarDraft.previewUrl);
        state.groupAvatarDraft = { file, previewUrl: URL.createObjectURL(file), remove: false };
        $("group-avatar-remove").disabled = false;
        $("group-edit-message").textContent = "Photo preview ready. Save group details to upload.";
        renderGroupAvatarPreview(state.groupAvatarDraft.previewUrl);
      } catch (error) {
        $("group-avatar-input").value = "";
        notice("group-edit-message", friendlyError(error));
      }
    });
    $("group-avatar-remove").addEventListener("click", () => {
      const conversation = state.conversations.find(item => item.id === state.activeId);
      if (state.groupAvatarDraft.previewUrl) URL.revokeObjectURL(state.groupAvatarDraft.previewUrl);
      state.groupAvatarDraft = { file: null, previewUrl: null, remove: !!conversation?.group_avatar_path };
      $("group-avatar-input").value = "";
      $("group-avatar-remove").disabled = !conversation?.group_avatar_path;
      $("group-edit-message").textContent = conversation?.group_avatar_path
        ? "Photo will be removed when you save."
        : "Selected photo cleared.";
      renderGroupAvatarPreview("");
    });
    $("save-group-details").addEventListener("click", saveGroupDetails);
    $("group-add-contact-search").addEventListener("input", () => {
      const conversation = state.conversations.find(item => item.id === state.activeId);
      if (conversation?.type === "group") renderGroupAddContactPicker(conversation);
    });
    $("add-group-contacts").addEventListener("click", addSelectedGroupContacts);
    $("delete-group").addEventListener("click", deleteCurrentGroup);
    $("info-dialog").addEventListener("submit", event => {
      event.preventDefault();
      if (!state.savingGroupDetails && !state.addingGroupMembers && !state.deletingGroup) $("info-dialog").close();
    });
    $("info-dialog").addEventListener("cancel", event => {
      if (state.savingGroupDetails || state.addingGroupMembers || state.deletingGroup) event.preventDefault();
    });
    $("info-dialog").addEventListener("close", resetGroupAvatarDraft);
    $("message-form").addEventListener("submit", sendMessage);
    $("load-older").addEventListener("click", loadOlderMessages);
    $("messages").addEventListener("click", handleMessageAction);
    $("attachment-input").addEventListener("change", event => {
      if (event.target.files?.[0]) chooseAttachment(event.target.files[0]);
    });
    $("attach-file").addEventListener("click", () => $("attachment-input").click());
    $("attachment-preview").addEventListener("click", event => {
      if (event.target.closest("[data-clear-attachment]")) clearSelectedAttachment();
    });
    $("record-audio").addEventListener("click", () => {
      if (state.recorder) {
        if (state.recorder.state === "recording" || state.recorder.state === "paused") finishVoiceRecording(false);
        return;
      }
      startVoiceRecording();
    });
    $("pause-recording").addEventListener("click", toggleVoiceRecordingPause);
    $("cancel-recording").addEventListener("click", () => finishVoiceRecording(true));
    $("cancel-upload").addEventListener("click", () => state.activeUpload?.abort());
    $("close-image-preview").addEventListener("click", () => {
      $("image-preview-dialog").close();
      $("image-preview-full").removeAttribute("src");
    });
    $("message-input").addEventListener("keydown", e => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("message-form").requestSubmit(); }
    });
    $("message-input").addEventListener("input", () => {
      const input = $("message-input"); input.style.height = "auto"; input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
      broadcastTyping(true);
      clearTimeout(state.typingTimeout); state.typingTimeout = setTimeout(() => broadcastTyping(false), 1200);
    });
    $("chat-search").addEventListener("input", renderConversations);
    $("chat-info").addEventListener("click", showConversationInfo);
    $("mobile-back").addEventListener("click", () => $("app-screen").classList.remove("mobile-chat-open"));
    window.addEventListener("focus", updateServiceWorkerConversationState);
    window.addEventListener("blur", updateServiceWorkerConversationState);
    document.addEventListener("visibilitychange", updateServiceWorkerConversationState);
    window.addEventListener("online", () => {
      loadConversations().catch(error => toast(friendlyError(error)));
      refreshUnreadCounts().catch(error => toast(friendlyError(error)));
    });
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.addEventListener("message", event => {
        if (event.data?.type !== "CHATFLOW_OPEN_CONVERSATION") return;
        const id = event.data.conversationId;
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id || "")) return;
        if (state.conversations.some(conversation => conversation.id === id)) openConversation(id);
      });
      navigator.serviceWorker.addEventListener("controllerchange", updateServiceWorkerConversationState);
    }
    window.addEventListener("beforeinstallprompt", e => {
      e.preventDefault(); state.deferredInstall = e; $("install-app").classList.remove("hidden");
    });
    $("install-app").addEventListener("click", async () => {
      if (!state.deferredInstall) return;
      state.deferredInstall.prompt();
      await state.deferredInstall.userChoice;
      state.deferredInstall = null; $("install-app").classList.add("hidden");
    });
    window.addEventListener("appinstalled", () => toast("ChatFlow installed."));
  }
  async function init() {
    wireEvents();
    updateNewChatType();
    if (!configured || !window.supabase) {
      showAuth();
      notice("auth-message", "Setup required: add your Supabase project URL and public key in js/config.js, then run the SQL migrations in supabase/.");
      $("auth-submit").disabled = true;
      return;
    }
    state.supabase = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    if ("serviceWorker" in navigator && location.protocol !== "file:") {
      try {
        state.serviceWorkerRegistration = await navigator.serviceWorker.register("./service-worker.js");
      } catch (error) {
        console.warn("Service worker registration failed", error);
      }
    }
    const { data: { session }, error } = await state.supabase.auth.getSession();
    if (error) { notice("auth-message", friendlyError(error)); return; }
    if (session?.user) {
      try { await enterApp(session.user); }
      catch (e) { showAuth(); notice("auth-message", friendlyError(e)); }
    } else showAuth();
    state.supabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT") { showAuth(); return; }
      if (event === "SIGNED_IN" && session?.user && !state.user) {
        // Defer Supabase queries out of the auth callback to avoid lock contention.
        setTimeout(() => enterApp(session.user).catch(e => { showAuth(); notice("auth-message", friendlyError(e)); }), 0);
      }
    });
  }
  document.addEventListener("DOMContentLoaded", init);
})();
