// يعرض فيديوهات القسم من content/portfolio/<slug>.json
// إضافة/حذف/إعادة ترتيب فيديو = من لوحة التحكم فقط (اسحبي العنصر بالقائمة لتغيير ترتيبه)، بدون لمس هذا الملف
(function () {
  const scriptTag = document.currentScript;
  const slug = scriptTag.dataset.slug;

  function renderEmpty(grid) {
    const p = document.createElement("p");
    p.style.gridColumn = "1/-1";
    p.style.textAlign = "center";
    p.style.color = "var(--ink-soft)";
    p.textContent = "قريبًا نضيف نماذج من أعمالنا هنا — تُضاف مباشرة من لوحة التحكم بدون أي تعديل بالكود.";
    grid.appendChild(p);
  }

  function cleanPhone(num) {
    return (num || "966547266733").toString().replace(/[^\d]/g, "");
  }

  function orderVideo(v, settings) {
    const useMethod = settings.order_method === "payment" && settings.payment_link && settings.payment_link !== "PAYMENT_LINK_PLACEHOLDER"
      ? "payment"
      : "whatsapp";
    if (useMethod === "payment") {
      window.open(settings.payment_link, "_blank");
      return;
    }
    const phone = cleanPhone(settings.whatsapp_number);
    const label = v.title ? `${v.number} (${v.title})` : v.number;
    const text = "مرحبا، أبي أطلب الفيديو رقم " + label;
    window.open(`https://wa.me/${phone}?text=${encodeURIComponent(text)}`, "_blank");
  }

  function openVideoModal(url) {
    if (!url) return;
    let modal = document.getElementById("jg-video-modal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "jg-video-modal";
      modal.className = "jg-video-modal";
      modal.innerHTML = '<div class="jg-video-modal-inner"><span class="jg-video-modal-close">&times;</span><video controls playsinline></video></div>';
      document.body.appendChild(modal);
      modal.addEventListener("click", (e) => {
        if (e.target === modal || e.target.classList.contains("jg-video-modal-close")) closeVideoModal();
      });
    }
    const video = modal.querySelector("video");
    video.src = url;
    modal.classList.add("active");
    video.play().catch(() => {});
  }

  function closeVideoModal() {
    const modal = document.getElementById("jg-video-modal");
    if (!modal) return;
    const video = modal.querySelector("video");
    video.pause();
    video.removeAttribute("src");
    video.load();
    modal.classList.remove("active");
  }

  function renderVideo(grid, v, settings) {
    const card = document.createElement("div");
    card.className = "video-card";

    const thumb = document.createElement("div");
    thumb.className = "thumb";

    if (v.thumbnail_url) {
      const img = document.createElement("img");
      img.src = v.thumbnail_url;
      img.loading = "lazy";
      img.alt = v.title || ("فيديو رقم " + v.number);
      img.onerror = () => { img.style.display = "none"; };
      thumb.appendChild(img);
    }
    const play = document.createElement("div");
    play.className = "play";
    play.textContent = "▶";
    thumb.appendChild(play);

    if (v.video_url) {
      thumb.style.cursor = "pointer";
      thumb.addEventListener("click", () => openVideoModal(v.video_url));
    }

    const meta = document.createElement("div");
    meta.className = "meta";

    const num = document.createElement("div");
    num.className = "num";
    num.textContent = "فيديو رقم " + v.number;
    meta.appendChild(num);

    if (v.title) {
      const t = document.createElement("div");
      t.className = "vtitle";
      t.textContent = v.title;
      meta.appendChild(t);
    }

    if (v.price) {
      const p = document.createElement("div");
      p.className = "vprice";
      p.textContent = v.price;
      meta.appendChild(p);
    }

    const orderBtn = document.createElement("button");
    orderBtn.type = "button";
    orderBtn.className = "btn btn-solid vorder";
    orderBtn.textContent = "اطلبي هذا الفيديو";
    orderBtn.addEventListener("click", () => orderVideo(v, settings));
    meta.appendChild(orderBtn);

    card.appendChild(thumb);
    card.appendChild(meta);
    grid.appendChild(card);
  }

  document.addEventListener("DOMContentLoaded", () => {
    const grid = document.getElementById("portfolio-grid");
    if (!grid) return;

    Promise.all([
      fetch("../content/portfolio/" + slug + ".json").then(r => r.json()).catch(() => ({ videos: [] })),
      fetch("../content/settings.json").then(r => r.json()).catch(() => ({}))
    ]).then(([data, settings]) => {
      const items = (data && data.videos) || [];
      if (!items.length) { renderEmpty(grid); return; }
      items.forEach(v => renderVideo(grid, v, settings));

      const waBtn = document.getElementById("general-whatsapp-btn");
      if (waBtn) waBtn.href = `https://wa.me/${cleanPhone(settings.whatsapp_number)}`;
    });
  });
})();
