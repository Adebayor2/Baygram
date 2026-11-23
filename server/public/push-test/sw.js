self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (_) {}
  event.waitUntil(
    self.registration.showNotification(payload.title || "BayGram", {
      body: payload.body || "",
      icon: payload.icon || undefined,
      tag: payload.tag || "baygram",
      data: { url: payload.url || "/" }
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil(clients.openWindow(url));
});
