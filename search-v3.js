(() => {
  const form = document.querySelector("#addProductForm");
  const input = document.querySelector("#productUrl");
  const addButton = document.querySelector("#addButton");
  const formMessage = document.querySelector("#formMessage");
  if (!form || !input || !addButton || !formMessage) return;

  input.type = "text";
  input.inputMode = "search";
  input.placeholder = "Tên sản phẩm hoặc link Shopee…";
  input.setAttribute("aria-label", "Tên sản phẩm hoặc link Shopee");

  const heroCopy = document.querySelector(".hero-copy");
  if (heroCopy) {
    heroCopy.textContent = "Nhập tên sản phẩm để tìm trên Shopee, hoặc dán link nếu em đã có. Chọn đúng sản phẩm rồi hệ thống sẽ kiểm tra giá mỗi giờ.";
  }

  const emptyCopy = document.querySelector("#emptyState p");
  if (emptyCopy) emptyCopy.textContent = "Tìm tên sản phẩm ở phía trên để bắt đầu.";

  const dialog = createSearchDialog();
  document.body.append(dialog);

  input.addEventListener("input", () => {
    addButton.textContent = looksLikeUrl(input.value.trim()) ? "Theo dõi" : "Tìm";
  });

  form.addEventListener("submit", async (event) => {
    const value = input.value.trim();
    if (!value || looksLikeUrl(value)) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    await runSearch(value, dialog);
  }, true);

  async function runSearch(query, modal) {
    const list = modal.querySelector(".search-result-list");
    const heading = modal.querySelector(".search-query-title");
    const status = modal.querySelector(".search-status");

    addButton.disabled = true;
    addButton.textContent = "Đang tìm…";
    formMessage.textContent = "Đang tìm sản phẩm trên Shopee…";
    formMessage.classList.remove("error");
    heading.textContent = `“${query}”`;
    status.textContent = "Đang tải kết quả…";
    list.replaceChildren();
    modal.showModal();

    try {
      const result = await gateway(`/api/search?q=${encodeURIComponent(query)}`);
      const products = Array.isArray(result.products) ? result.products : [];
      status.textContent = products.length
        ? `${products.length} kết quả gần nhất. Chọn đúng sản phẩm em muốn theo dõi.`
        : "Không tìm thấy sản phẩm phù hợp.";
      renderResults(list, products, modal);
      formMessage.textContent = products.length ? "Chọn một sản phẩm trong danh sách kết quả." : "Không tìm thấy sản phẩm phù hợp.";
    } catch (error) {
      status.textContent = error.message;
      formMessage.textContent = error.message;
      formMessage.classList.add("error");
    } finally {
      addButton.disabled = false;
      addButton.textContent = "Tìm";
    }
  }

  function renderResults(list, products, modal) {
    list.replaceChildren();

    for (const product of products) {
      const card = document.createElement("article");
      card.className = "search-result-card";

      const media = document.createElement("div");
      media.className = "search-result-media";
      if (product.imageUrl) {
        const img = document.createElement("img");
        img.src = product.imageUrl;
        img.alt = product.name || "Ảnh sản phẩm";
        img.loading = "lazy";
        media.append(img);
      } else {
        media.textContent = "S.";
      }

      const main = document.createElement("div");
      main.className = "search-result-main";

      const name = document.createElement("strong");
      name.className = "search-result-name";
      name.textContent = product.name || "Sản phẩm Shopee";

      const price = document.createElement("div");
      price.className = "search-result-price";
      price.textContent = priceLabel(product.priceMin, product.priceMax);

      const meta = document.createElement("div");
      meta.className = "search-result-meta";
      const metaParts = [];
      if (product.discount) metaParts.push(product.discount);
      if (product.rating) metaParts.push(`★ ${Number(product.rating).toFixed(1)}`);
      if (product.sold) metaParts.push(`Đã bán ${formatCompact(product.sold)}`);
      if (product.shopLocation) metaParts.push(product.shopLocation);
      meta.textContent = metaParts.join(" · ") || "Shopee Việt Nam";

      const actions = document.createElement("div");
      actions.className = "search-result-actions";

      const track = document.createElement("button");
      track.className = "pill-button";
      track.type = "button";
      track.textContent = "Theo dõi";
      track.addEventListener("click", async () => {
        track.disabled = true;
        track.textContent = "Đang thêm…";
        try {
          await gateway("/api/products", {
            method: "POST",
            body: JSON.stringify({ url: product.url })
          });
          formMessage.textContent = "Đã thêm sản phẩm và lưu giá hiện tại làm mốc.";
          formMessage.classList.remove("error");
          input.value = "";
          modal.close();
          window.location.reload();
        } catch (error) {
          track.disabled = false;
          track.textContent = "Theo dõi";
          const status = modal.querySelector(".search-status");
          status.textContent = error.message;
          formMessage.textContent = error.message;
          formMessage.classList.add("error");
        }
      });

      const open = document.createElement("a");
      open.className = "outline-button";
      open.href = product.url;
      open.target = "_blank";
      open.rel = "noreferrer";
      open.textContent = "Mở Shopee";

      actions.append(track, open);
      main.append(name, price, meta, actions);
      card.append(media, main);
      list.append(card);
    }
  }

  function createSearchDialog() {
    const modal = document.createElement("dialog");
    modal.className = "search-dialog";

    const shell = document.createElement("section");
    shell.className = "search-card";

    const head = document.createElement("div");
    head.className = "search-head";
    head.innerHTML = '<div><p class="section-label">TÌM TRÊN SHOPEE</p><h2>Kết quả</h2><strong class="search-query-title"></strong></div>';

    const close = document.createElement("button");
    close.className = "icon-button";
    close.type = "button";
    close.setAttribute("aria-label", "Đóng");
    close.textContent = "×";
    close.addEventListener("click", () => modal.close());
    head.append(close);

    const status = document.createElement("p");
    status.className = "search-status";

    const list = document.createElement("div");
    list.className = "search-result-list";

    shell.append(head, status, list);
    modal.append(shell);
    return modal;
  }

  async function gateway(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    const response = await fetch(`/api/gateway?path=${encodeURIComponent(path)}`, { ...options, headers });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || data.message || `Request failed (${response.status})`);
    return data;
  }

  function looksLikeUrl(value) {
    return /^https?:\/\//i.test(value);
  }

  function priceLabel(min, max) {
    if (!Number.isFinite(Number(min)) || Number(min) <= 0) return "Giá chưa xác định";
    if (Number(max) > Number(min)) return `${money(min)} – ${money(max)}`;
    return money(min);
  }

  function money(value) {
    return new Intl.NumberFormat("vi-VN", {
      style: "currency",
      currency: "VND",
      maximumFractionDigits: 0
    }).format(Number(value));
  }

  function formatCompact(value) {
    return new Intl.NumberFormat("vi-VN", { notation: "compact", maximumFractionDigits: 1 }).format(Number(value));
  }
})();
