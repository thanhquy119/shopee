(() => {
  const formMessage = document.querySelector("#formMessage");
  const heroCopy = document.querySelector(".hero-copy");
  if (heroCopy) {
    heroCopy.textContent = "Nhập tên sản phẩm để tìm trên Shopee, hoặc dán link nếu em đã có. Chọn đúng sản phẩm rồi hệ thống sẽ kiểm tra giá mỗi ngày.";
  }

  document.addEventListener("click", async (event) => {
    const button = event.target.closest?.(".search-result-card button.pill-button");
    if (!button || button.textContent.trim() !== "Theo dõi") return;

    const card = button.closest(".search-result-card");
    const link = card?.querySelector("a.outline-button[href]");
    if (!card || !link) return;

    const productUrl = link.href;
    const ids = parseIds(productUrl);
    if (!ids) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    const name = card.querySelector(".search-result-name")?.textContent?.trim() || "Sản phẩm Shopee";
    const imageUrl = card.querySelector(".search-result-media img")?.src || null;
    const priceText = card.querySelector(".search-result-price")?.textContent || "";
    const price = parsePrice(priceText);
    const dialog = card.closest("dialog");
    const status = dialog?.querySelector(".search-status");

    button.disabled = true;
    button.textContent = "Đang lưu…";

    try {
      const response = await fetch(`/api/gateway?path=${encodeURIComponent("/api/products")}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: productUrl,
          productHint: {
            shopId: ids.shopId,
            itemId: ids.itemId,
            name,
            imageUrl,
            price
          }
        })
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || data.message || `Request failed (${response.status})`);

      if (formMessage) {
        formMessage.textContent = price
          ? "Đã thêm sản phẩm và dùng giá hiện tại làm mốc."
          : "Đã thêm sản phẩm và lấy giá hiện tại từ Apify làm mốc.";
        formMessage.classList.remove("error");
      }
      dialog?.close();
      window.location.reload();
    } catch (error) {
      button.disabled = false;
      button.textContent = "Theo dõi";
      if (status) status.textContent = error.message;
      if (formMessage) {
        formMessage.textContent = error.message;
        formMessage.classList.add("error");
      }
    }
  }, true);

  function parseIds(value) {
    try {
      const url = new URL(value);
      const product = url.pathname.match(/\/product\/(\d+)\/(\d+)/i);
      if (product) return { shopId: product[1], itemId: product[2] };
      const named = decodeURIComponent(url.pathname).match(/i\.(\d+)\.(\d+)/i);
      return named ? { shopId: named[1], itemId: named[2] } : null;
    } catch {
      return null;
    }
  }

  function parsePrice(text) {
    if (!text || /Giá sẽ lấy/i.test(text)) return null;
    const match = String(text).match(/\d[\d.,\s]*/);
    if (!match) return null;
    const value = Number(match[0].replace(/[^0-9]/g, ""));
    return Number.isFinite(value) && value >= 1000 ? value : null;
  }
})();
