(() => {
  const bellButton = document.querySelector("#bellButton");
  const enableButton = document.querySelector("#notificationButton");
  const testButton = document.querySelector("#testNotificationButton");
  const message = document.querySelector("#notificationMessage");

  if (!bellButton || !enableButton || !testButton) return;

  const setMessage = (text = "", isError = false) => {
    if (!message) return;
    message.textContent = text;
    message.classList.toggle("error", isError);
  };

  const api = async (path, options = {}) => {
    const headers = new Headers(options.headers || {});
    if (options.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    const response = await fetch(`/api/gateway?path=${encodeURIComponent(path)}`, {
      ...options,
      headers
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || data.message || `Request failed (${response.status})`);
    }
    return data;
  };

  const urlBase64ToBytes = (value) => {
    const padding = "=".repeat((4 - (value.length % 4)) % 4);
    const normalized = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(normalized);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  };

  const serverKeyBytes = (subscription) => {
    const key = subscription?.options?.applicationServerKey;
    if (!key) return null;
    if (key instanceof ArrayBuffer) return new Uint8Array(key);
    if (ArrayBuffer.isView(key)) {
      return new Uint8Array(key.buffer, key.byteOffset, key.byteLength);
    }
    return null;
  };

  const sameBytes = (left, right) => {
    if (!left || !right || left.length !== right.length) return false;
    for (let i = 0; i < left.length; i += 1) {
      if (left[i] !== right[i]) return false;
    }
    return true;
  };

  const subscriptionMatches = (subscription, publicKey) => {
    const actual = serverKeyBytes(subscription);
    const expected = urlBase64ToBytes(publicKey);
    return sameBytes(actual, expected);
  };

  const getPushContext = async () => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
      throw new Error("Thiết bị này chưa hỗ trợ Web Push.");
    }

    const config = await api("/api/config");
    if (!config.vapidPublicKey) {
      throw new Error("Hệ thống chưa tạo được khóa Web Push.");
    }

    const registration = await navigator.serviceWorker.ready;
    return { config, registration };
  };

  const ensureCurrentSubscription = async () => {
    const permission = Notification.permission === "granted"
      ? "granted"
      : await Notification.requestPermission();

    if (permission !== "granted") {
      throw new Error("Quyền thông báo chưa được cho phép.");
    }

    const { config, registration } = await getPushContext();
    let subscription = await registration.pushManager.getSubscription();

    if (subscription && !subscriptionMatches(subscription, config.vapidPublicKey)) {
      const oldEndpoint = subscription.endpoint;
      try {
        await api("/api/push/subscribe", {
          method: "DELETE",
          body: JSON.stringify({ endpoint: oldEndpoint })
        });
      } catch {}
      try { await subscription.unsubscribe(); } catch {}
      subscription = null;
    }

    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToBytes(config.vapidPublicKey)
      });
    }

    await api("/api/push/subscribe", {
      method: "POST",
      body: JSON.stringify(subscription.toJSON())
    });

    return subscription;
  };

  const refreshButton = async () => {
    try {
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
        enableButton.textContent = "Thiết bị không hỗ trợ Web Push";
        enableButton.disabled = true;
        return;
      }

      if (Notification.permission === "denied") {
        enableButton.textContent = "Thông báo đang bị chặn";
        enableButton.disabled = true;
        return;
      }

      const { config, registration } = await getPushContext();
      const subscription = await registration.pushManager.getSubscription();

      if (Notification.permission === "granted" && subscription) {
        if (subscriptionMatches(subscription, config.vapidPublicKey)) {
          enableButton.textContent = "Thông báo đã bật";
          enableButton.disabled = true;
        } else {
          enableButton.textContent = "Cập nhật thông báo trên thiết bị này";
          enableButton.disabled = false;
        }
      } else {
        enableButton.textContent = "Bật thông báo trên thiết bị này";
        enableButton.disabled = false;
      }

      if (message?.textContent?.includes("chưa cấu hình Web Push")) {
        setMessage("");
      }
    } catch (error) {
      enableButton.textContent = "Bật thông báo trên thiết bị này";
      enableButton.disabled = false;
      setMessage(error.message, true);
    }
  };

  enableButton.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();

    enableButton.disabled = true;
    setMessage("");
    try {
      await ensureCurrentSubscription();
      setMessage("Đã bật Web Push trên thiết bị này.");
    } catch (error) {
      setMessage(error.message, true);
    }
    await refreshButton();
  }, true);

  testButton.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();

    testButton.disabled = true;
    setMessage("");
    try {
      await ensureCurrentSubscription();
      const result = await api("/api/test-notification", { method: "POST" });
      setMessage(result.sent > 0 ? "Đã gửi thông báo thử." : "Đã cập nhật Web Push. Hãy bấm Gửi thử lại nếu thông báo chưa xuất hiện.");
    } catch (error) {
      setMessage(error.message, true);
    } finally {
      testButton.disabled = false;
      await refreshButton();
    }
  }, true);

  bellButton.addEventListener("click", () => {
    setTimeout(refreshButton, 180);
  }, true);

  window.addEventListener("pageshow", () => {
    setTimeout(refreshButton, 250);
  });
})();
