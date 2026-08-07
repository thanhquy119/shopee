const STORAGE = {
  apiUrl: "shopee-watch.api-url",
  apiToken: "shopee-watch.api-token"
};

const $ = (selector) => document.querySelector(selector);
const state = { products: [], deferredPrompt: null };

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
  setupNotice: $("#setupNotice"),
  settingsButton: $("#settingsButton"),
  settingsDialog: $("#settingsDialog"),
  apiUrlInput: $("#apiUrlInput"),
  apiTokenInput: $("#apiTokenInput"),
  saveSettingsButton: $("#saveSettingsButton"),
  notificationButton: $("#notificationButton"),
  testNotificationButton: $("#testNotificationButton"),
  settingsMessage: $("#settingsMessage"),
  installButton: $("#installButton")
};

function getApiUrl() {
  return (localStorage.getItem(STORAGE.apiUrl) || window.__SHOPEE_CONFIG__?.apiUrl || "").replace(/\/$/, "");
}

function getApiToken() {
  return localStorage.getItem(STORAGE.apiToken) || "";
}

function isConfigured() {
  return Boolean(getApiUrl() && getApiToken());
}

function setMessage(el, text = "", isError = false) {
  el.textContent = text;
  el.classList.toggle("error", isError);
}

async function api(path, options = {}) {
  if (!isConfigured()) throw new Error("Chưa cấu hình Cloudflare Worker và API key.");
  const headers = new Headers(options.headers || {});
  headers.set("Authorization", `Bearer ${getApiToken()}`);
  if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");

  const response = await fetch(`${getApiUrl()}${path}`, { ...options, headers });
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
  return new Intl.DateTimeFormat("vi-VN", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

function percentageDrop(product) {
  if (!product.baseline_price || product.current_price >= product.baseline_price) return 0;
  return Math.round(((product.baseline_price - product.current_price) / product.baseline_price) * 100);
}

function updateStats() {
  elements.totalProducts.textContent = String(state.products.length);
  const discounted = state.products.filter((p) => p.current_price < p.baseline_price).length;
  elements.discountedProducts.textContent = String(discounted);
  const latest = state.products.map((p) => p.checked_at).filter(Boolean).sort().at(-1);
  elements.lastUpdated.textContent = latest ? when(latest) : "—";
}

function renderProducts() {
  elements.productList.replaceChildren();
  elements.emptyState.hidden = state.products.length > 0 || !isConfigured();
  elements.setupNotice.hidden = isConfigured();

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
        await loadProducts(false);
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
  if (!isConfigured()) {
    state.products = [];
    renderProducts();
    return;
  }
  elements.setupNotice.hidden = true;
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
  if (!isConfigured()) {
    elements.settingsDialog.showModal();
    setMessage(elements.settingsMessage, "Nhập Worker URL và API key trước.", true);
    return;
  }

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

function openSettings() {
  elements.apiUrlInput.value = getApiUrl();
  elements.apiTokenInput.value = getApiToken();
  setMessage(elements.settingsMessage, "");
  elements.settingsDialog.showModal();
}

async function saveSettings() {
  const apiUrl = elements.apiUrlInput.value.trim().replace(/\/$/, "");
  const token = elements.apiTokenInput.value.trim();
  if (!apiUrl || !token) {
    setMessage(elements.settingsMessage, "Cần nhập đủ Worker URL và API key.", true);
    return;
  }
  localStorage.setItem(STORAGE.apiUrl, apiUrl);
  localStorage.setItem(STORAGE.apiToken, token);
  setMessage(elements.settingsMessage, "Đã lưu. Đang kiểm tra kết nối…");
  try {
    await api("/api/health");
    setMessage(elements.settingsMessage, "Kết nối thành công.");
    await loadProducts();
  } catch (error) {
    setMessage(elements.settingsMessage, error.message, true);
  }
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
  if (!config.vapidPublicKey) throw new Error("Worker chưa cấu hình VAPID_PUBLIC_KEY.");

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

async function handleEnableNotifications() {
  elements.notificationButton.disabled = true;
  try {
    await enableNotifications();
    setMessage(elements.settingsMessage, "Thông báo đã được bật trên thiết bị này.");
    elements.notificationButton.textContent = "Đã bật thông báo";
  } catch (error) {
    setMessage(elements.settingsMessage, error.message, true);
  } finally {
    elements.notificationButton.disabled = false;
  }
}

async function testNotification() {
  elements.testNotificationButton.disabled = true;
  try {
    await api("/api/test-notification", { method: "POST" });
    setMessage(elements.settingsMessage, "Đã yêu cầu gửi thông báo thử.");
  } catch (error) {
    setMessage(elements.settingsMessage, error.message, true);
  } finally {
    elements.testNotificationButton.disabled = false;
  }
}

async function registerPwa() {
  if ("serviceWorker" in navigator) {
    try { await navigator.serviceWorker.register("/sw.js", { scope: "/" }); } catch (error) { console.error("Service worker registration failed", error); }
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
elements.refreshButton.addEventListener("click", () => loadProducts());
elements.settingsButton.addEventListener("click", openSettings);
elements.saveSettingsButton.addEventListener("click", saveSettings);
elements.notificationButton.addEventListener("click", handleEnableNotifications);
elements.testNotificationButton.addEventListener("click", testNotification);

registerPwa();
renderProducts();
loadProducts();
