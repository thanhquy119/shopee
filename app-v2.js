const $ = (selector) => document.querySelector(selector);
const state = { products: [], notifications: [], deferredPrompt: null };

const elements = {
  form: $("#addProductForm"),
  productUrl: $("#productUrl"),
  addButton: $("#addButton"),
  formMessage: $("#formMessage"),
  refreshButton: $("#refreshButton"),
  productList: $("#productList"),
  productTemplate: $("#productTemplate"),
  totalProducts: $("#totalProducts"),
  discountedProducts: $("#discountedProducts"),
  lastUpdated: $("#lastUpdated"),
  emptyState: $("#emptyState"),
  loadingState: $("#loadingState"),
  bellButton: $("#bellButton"),
  bellBadge: $("#bellBadge"),
  notificationDialog: $("#notificationDialog"),
  notificationList: $("#notificationList"),
  notificationEmpty: $("#notificationEmpty"),
  notificationMessage: $("#notificationMessage"),
  notificationButton: $("#notificationButton"),
  testNotificationButton: $("#testNotificationButton"),
  installButton: $("#installButton")
};

function setMessage(el, text = "", isError = false) {
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("error", isError);
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(`/api/gateway?path=${encodeURIComponent(path)}`, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || data.message || `Request failed (${response.status})`);
  return data;
}

function money(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
  return new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 }).format(Number(value));
}

function when(value) {
  if (!value) return "Chưa kiểm tra";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("vi-VN", {
    day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit"
  }).format(date);
}

function percentageDrop(product) {
  if (!product.baseline_price || product.current_price >= product.baseline_price) return 0;
  return Math.round(((product.baseline_price - product.current_price) / product.baseline_price) * 100);
}

function updateStats() {
  elements.totalProducts.textContent = String(state.products.length);
  elements.discountedProducts.textContent = String(state.products.filter((p) => p.current_price < p.baseline_price).length);
  const latest = state.products.map((p) => p.checked_at).filter(Boolean).sort().at(-1);
  elements.lastUpdated.textContent = latest ? when(latest) : "—";
}

function renderProducts() {
  elements.productList.replaceChildren();
  elements.emptyState.hidden = state.products.length > 0;

  for (const product of state.products) {
    const node = elements.productTemplate.content.cloneNode(true);
    const card = node.querySelector(".product-card");
    const img = node.querySelector(".product-image");
    const fallback = node.querySelector(".product-image-fallback");
    const name = node.querySelector(".product-name");
    const statusChip = node.querySelector(".status-chip");
    const checkTime = node.querySelector(".check-time");
    const currentPrice = node.querySelector(".current-price");
    const dropBadge = node.querySelector(".drop-badge");
    const baselinePrice = node.querySelector(".baseline-price");
    const lowestPrice = node.querySelector(".lowest-price");
    const priceStatus = node.querySelector(".price-status");
    const productError = node.querySelector(".product-error");
    const shopLink = node.querySelector(".shop-link");
    const checkButton = node.querySelector(".check-button");
    const deleteButton = node.querySelector(".delete-button");

    name.textContent = product.name || `Shopee ${product.shop_id}.${product.item_id}`;
    currentPrice.textContent = money(product.current_price);
    baselinePrice.textContent = money(product.baseline_price);
    lowestPrice.textContent = money(product.lowest_price);
    checkTime.textContent = when(product.checked_at);
    shopLink.href = product.canonical_url || product.url;

    const drop = percentageDrop(product);
    const isDiscounted = product.current_price < product.baseline_price;
    statusChip.textContent = isDiscounted ? "ĐANG RẺ HƠN" : "ĐANG THEO DÕI";
    statusChip.classList.toggle("discount", isDiscounted);
    priceStatus.textContent = isDiscounted ? `Giảm ${money(product.baseline_price - product.current_price)}` : "Chưa thấp hơn giá gốc";
    if (drop > 0) {
      dropBadge.hidden = false;
      dropBadge.textContent = `↓ ${drop}%`;
    }

    if (product.image_url) {
      img.src = product.image_url;
      img.alt = product.name || "Ảnh sản phẩm";
      img.addEventListener("load", () => { fallback.hidden = true; });
      img.addEventListener("error", () => { img.hidden = true; fallback.hidden = false; });
    } else {
      img.hidden = true;
    }

    if (product.check_error) {
      productError.hidden = false;
      productError.textContent = `Lần kiểm tra gần nhất lỗi: ${product.check_error}`;
    }

    checkButton.addEventListener("click", async () => {
      checkButton.disabled = true;
      checkButton.textContent = "Đang kiểm tra…";
      try {
        await api(`/api/products/${encodeURIComponent(product.id)}/check`, { method: "POST" });
        await Promise.all([loadProducts(false), loadNotifications(false)]);
      } catch (error) {
        setMessage(elements.formMessage, error.message, true);
      } finally {
        checkButton.disabled = false;
        checkButton.textContent = "Kiểm tra ngay";
      }
    });

    deleteButton.addEventListener("click", async () => {
      if (!confirm(`Xoá theo dõi “${product.name || "sản phẩm này"}”?`)) return;
      deleteButton.disabled = true;
      try {
        await api(`/api/products/${encodeURIComponent(product.id)}`, { method: "DELETE" });
        state.products = state.products.filter((p) => p.id !== product.id);
        renderProducts();
        updateStats();
      } catch (error) {
        setMessage(elements.formMessage, error.message, true);
        deleteButton.disabled = false;
      }
    });

    card.dataset.productId = product.id;
    elements.productList.append(node);
  }

  updateStats();
}

async function loadProducts(showLoading = true) {
  if (showLoading) elements.loadingState.hidden = false;
  try {
    const result = await api("/api/products");
    state.products = Array.isArray(result.products) ? result.products : [];
    renderProducts();
    setMessage(elements.formMessage, "");
  } catch (error) {
    state.products = [];
    renderProducts();
    setMessage(elements.formMessage, error.message, true);
  } finally {
    elements.loadingState.hidden = true;
  }
}

async function addProduct(event) {
  event.preventDefault();
  const url = elements.productUrl.value.trim();
  if (!url) return;

  elements.addButton.disabled = true;
  elements.addButton.textContent = "Đang đọc giá…";
  setMessage(elements.formMessage, "Đang lấy thông tin sản phẩm Shopee…");
  try {
    await api("/api/products", { method: "POST", body: JSON.stringify({ url }) });
    elements.productUrl.value = "";
    setMessage(elements.formMessage, "Đã thêm sản phẩm và lưu giá hiện tại làm mốc.");
    await loadProducts(false);
  } catch (error) {
    setMessage(elements.formMessage, error.message, true);
  } finally {
    elements.addButton.disabled = false;
    elements.addButton.textContent = "Theo dõi";
  }
}

function setBellCount(count) {
  const value = Math.max(0, Number(count) || 0);
  elements.bellBadge.textContent = value > 99 ? "99+" : String(value);
  elements.bellBadge.hidden = value === 0;
}

function renderNotifications() {
  elements.notificationList.replaceChildren();
  elements.notificationEmpty.hidden = state.notifications.length > 0;

  for (const item of state.notifications) {
    const row = document.createElement(item.url ? "a" : "div");
    row.className = `notification-item${item.read_at ? "" : " unread"}`;
    if (item.url) {
      row.href = item.url;
      row.target = "_blank";
      row.rel = "noreferrer";
    }

    const icon = document.createElement("span");
    icon.className = "notification-dot";
    icon.setAttribute("aria-hidden", "true");

    const copy = document.createElement("span");
    copy.className = "notification-copy";
    const title = document.createElement("strong");
    title.textContent = item.title || "S. — Thông báo";
    const body = document.createElement("span");
    body.textContent = item.body || "";
    const time = document.createElement("time");
    time.textContent = when(item.created_at);
    copy.append(title, body, time);
    row.append(icon, copy);
    elements.notificationList.append(row);
  }
}

async function loadNotifications(markRead = false) {
  try {
    const result = await api("/api/notifications?limit=60");
    state.notifications = Array.isArray(result.notifications) ? result.notifications : [];
    setBellCount(result.unreadCount || 0);
    renderNotifications();

    if (markRead && Number(result.unreadCount || 0) > 0) {
      await api("/api/notifications/read", { method: "POST" });
      state.notifications = state.notifications.map((item) => ({ ...item, read_at: item.read_at || new Date().toISOString() }));
      setBellCount(0);
      renderNotifications();
    }
  } catch (error) {
    setMessage(elements.notificationMessage, error.message, true);
  }
}

async function openNotifications() {
  setMessage(elements.notificationMessage, "");
  elements.notificationDialog.showModal();
  await Promise.all([loadNotifications(true), refreshNotificationButton()]);
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
}

async function enableNotifications() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) throw new Error("Trình duyệt này chưa hỗ trợ Web Push.");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Quyền thông báo chưa được cho phép.");

  const config = await api("/api/config");
  if (!config.vapidPublicKey) throw new Error("Hệ thống chưa cấu hình Web Push.");

  const registration = await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(config.vapidPublicKey)
    });
  }
  await api("/api/push/subscribe", { method: "POST", body: JSON.stringify(subscription.toJSON()) });
}

async function refreshNotificationButton() {
  if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
    elements.notificationButton.textContent = "Thiết bị không hỗ trợ Web Push";
    elements.notificationButton.disabled = true;
    return;
  }
  if (Notification.permission === "denied") {
    elements.notificationButton.textContent = "Thông báo đang bị chặn";
    elements.notificationButton.disabled = true;
    return;
  }
  if (Notification.permission === "granted") {
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        elements.notificationButton.textContent = "Thông báo đã bật";
        elements.notificationButton.disabled = true;
        return;
      }
    } catch {}
  }
  elements.notificationButton.textContent = "Bật thông báo trên thiết bị này";
  elements.notificationButton.disabled = false;
}

async function handleEnableNotifications() {
  elements.notificationButton.disabled = true;
  try {
    await enableNotifications();
    setMessage(elements.notificationMessage, "Đã bật Web Push trên thiết bị này.");
  } catch (error) {
    setMessage(elements.notificationMessage, error.message, true);
  }
  await refreshNotificationButton();
}

async function testNotification() {
  elements.testNotificationButton.disabled = true;
  try {
    await api("/api/test-notification", { method: "POST" });
    setMessage(elements.notificationMessage, "Đã yêu cầu gửi thông báo thử.");
    setTimeout(() => loadNotifications(false), 800);
  } catch (error) {
    setMessage(elements.notificationMessage, error.message, true);
  } finally {
    elements.testNotificationButton.disabled = false;
  }
}

async function registerPwa() {
  if ("serviceWorker" in navigator) {
    try { await navigator.serviceWorker.register("/sw.js", { scope: "/" }); }
    catch (error) { console.error("Service worker registration failed", error); }
  }
}

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  state.deferredPrompt = event;
  elements.installButton.hidden = false;
});

elements.installButton.addEventListener("click", async () => {
  if (!state.deferredPrompt) return;
  state.deferredPrompt.prompt();
  await state.deferredPrompt.userChoice;
  state.deferredPrompt = null;
  elements.installButton.hidden = true;
});

elements.form.addEventListener("submit", addProduct);
elements.refreshButton.addEventListener("click", () => Promise.all([loadProducts(), loadNotifications(false)]));
elements.bellButton.addEventListener("click", openNotifications);
elements.notificationButton.addEventListener("click", handleEnableNotifications);
elements.testNotificationButton.addEventListener("click", testNotification);

registerPwa();
renderProducts();
Promise.all([loadProducts(), loadNotifications(false)]);
