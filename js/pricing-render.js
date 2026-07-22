// يعرض باقات الأسعار من content/pricing.json — تُدار بالكامل من لوحة التحكم بدون لمس هذا الملف
(function () {
  function cleanPhone(num) {
    return (num || "966547266733").toString().replace(/[^\d]/g, "");
  }

  function orderPackage(pkg, settings) {
    const useMethod = settings.order_method === "payment" && settings.payment_link && settings.payment_link !== "PAYMENT_LINK_PLACEHOLDER"
      ? "payment"
      : "whatsapp";
    if (useMethod === "payment") {
      window.open(settings.payment_link, "_blank");
      return;
    }
    const phone = cleanPhone(settings.whatsapp_number);
    const text = "مرحبا، أبي أطلب الباقة " + pkg.name;
    window.open(`https://wa.me/${phone}?text=${encodeURIComponent(text)}`, "_blank");
  }

  function renderPackage(grid, pkg, settings) {
    const card = document.createElement("div");
    card.className = "price-card" + (pkg.badge ? " featured" : "");

    if (pkg.badge) {
      const badge = document.createElement("span");
      badge.className = "price-badge";
      badge.textContent = pkg.badge;
      card.appendChild(badge);
    }

    const name = document.createElement("h3");
    name.textContent = pkg.name;
    card.appendChild(name);

    const price = document.createElement("div");
    price.className = "price-tag";
    price.textContent = pkg.price;
    card.appendChild(price);

    const ul = document.createElement("ul");
    ul.className = "price-features";
    (pkg.features || []).forEach(f => {
      const li = document.createElement("li");
      li.textContent = f;
      ul.appendChild(li);
    });
    card.appendChild(ul);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-solid";
    btn.textContent = "اطلبي هذه الباقة";
    btn.addEventListener("click", () => orderPackage(pkg, settings));
    card.appendChild(btn);

    grid.appendChild(card);
  }

  document.addEventListener("DOMContentLoaded", () => {
    const grid = document.getElementById("pricing-grid");
    if (!grid) return;

    Promise.all([
      fetch("content/pricing.json").then(r => r.json()).catch(() => ({ packages: [] })),
      fetch("content/settings.json").then(r => r.json()).catch(() => ({}))
    ]).then(([data, settings]) => {
      grid.innerHTML = "";
      const items = (data && data.packages) || [];
      if (!items.length) {
        grid.innerHTML = '<p style="grid-column:1/-1;text-align:center;color:var(--ink-soft);">قريبًا نضيف الباقات هنا.</p>';
        return;
      }
      items.forEach(p => renderPackage(grid, p, settings));

      const introEl = document.getElementById("pricing-intro");
      if (introEl && data.intro) introEl.textContent = data.intro;
    });
  });
})();
