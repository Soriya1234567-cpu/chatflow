const CACHE_NAME = "chatflow-shell-v25";
const APP_SHELL = [
  "./",
  "./index.html",
  "./css/style.css?v=25",
  "./js/config.js",
  "./js/app.js?v=25",
  "./manifest.json",
  "./assets/icons/icon.svg"
];
const activeConversations = new Map();

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener("push", event => {
  event.waitUntil((async () => {
    let payload = {};
    try {
      payload = event.data ? event.data.json() : {};
    } catch (error) {
      console.warn("Ignoring malformed push payload", error);
      return;
    }

    const conversationId = payload.data?.conversationId;
    const messageId = payload.data?.messageId;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(conversationId || "")
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(messageId || "")) {
      console.warn("Ignoring push with invalid conversation or message id");
      return;
    }

    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const focusedClient = windows.find(client => client.focused);
    if (focusedClient && activeConversations.get(focusedClient.id) === conversationId) return;

    let icon = new URL("./assets/icons/icon-192.png", self.registration.scope).href;
    try {
      const candidate = new URL(payload.icon || icon, self.registration.scope);
      if (candidate.protocol === "https:" || candidate.origin === self.location.origin) icon = candidate.href;
    } catch (error) {
      console.warn("Ignoring invalid push icon URL", error);
    }
    await self.registration.showNotification(String(payload.title || "ChatFlow").slice(0, 80), {
      body: String(payload.body || "You have a new message.").slice(0, 180),
      icon,
      badge: "./assets/icons/icon-192.png",
      tag: `chatflow-message-${messageId}`,
      data: { conversationId, messageId },
      renotify: false,
    });
  })());
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const { conversationId } = event.notification.data || {};
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(conversationId || "")) return;

  event.waitUntil((async () => {
    const destination = new URL(self.registration.scope);
    destination.searchParams.set("conversation", conversationId);
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find(client => new URL(client.url).origin === destination.origin
      && new URL(client.url).pathname.startsWith(destination.pathname));
    if (existing) {
      await existing.navigate(destination.href);
      await existing.focus();
      return;
    }
    await self.clients.openWindow(destination.href);
  })());
});

self.addEventListener("message", event => {
  if (event.data?.type !== "CHATFLOW_ACTIVE_CONVERSATION") return;
  const sourceId = event.source?.id;
  if (!sourceId) return;
  if (event.data.visible && event.data.conversationId) {
    activeConversations.set(sourceId, event.data.conversationId);
  } else {
    activeConversations.delete(sourceId);
  }
});

self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  // Cache the static app shell only. Never cache authenticated Supabase/API responses.
  event.respondWith(
    caches.match(request).then(cached => cached || fetch(request).then(response => {
      if (response.ok && (request.destination === "style" || request.destination === "script" || request.destination === "image")) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
      }
      return response;
    }).catch(() => caches.match("./index.html")))
  );
});
