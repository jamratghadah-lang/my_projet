// يعرض فيديوهات القسم من content/portfolio/<slug>.json
// إضافة/حذف/إعادة ترتيب فيديو = من لوحة التحكم فقط (اسحبي العنصر بالقائمة لتغيير ترتيبه)، بدون لمس هذا الملف
(function () {
  const scriptTag = document.currentScript;
  const slug = scriptTag.dataset.slug;
  const _settingsCache = sessionStorage.getItem('jg_settings');

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

  function orderVideoWhatsapp(v, settings) {
    const phone = cleanPhone(settings.whatsapp_number);
    const label = v.title ? `${v.number} (${v.title})` : v.number;
    const text = "مرحبا، أبي أطلب الفيديو رقم " + label;
    window.open(`https://wa.me/${phone}?text=${encodeURIComponent(text)}`, "_blank", "noopener,noreferrer");
  }

  function orderVideoPayment(settings) {
    window.open(settings.payment_link, "_blank", "noopener,noreferrer");
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
      img.decoding = "async";
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
      thumb.dataset.videoUrl = v.video_url;
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

    const orderBtnWrap = document.createElement("div");
    orderBtnWrap.className = "vorder-wrap";
    orderBtnWrap.style.cssText = "display:flex;flex-direction:column;gap:6px";

    const method = settings.order_method || "whatsapp";
    const hasValidPaymentLink = settings.payment_link && settings.payment_link !== "PAYMENT_LINK_PLACEHOLDER";
    const showWhatsapp = method === "whatsapp" || method === "both";
    const showPayment = (method === "payment" || method === "both") && hasValidPaymentLink;

    if (showWhatsapp) {
      const waBtn = document.createElement("button");
      waBtn.type = "button";
      waBtn.className = "btn btn-solid vorder";
      waBtn.dataset.action = "wa-order";
      waBtn.dataset.videoNumber = v.number;
      waBtn.dataset.videoTitle = v.title || "";
      waBtn.textContent = "📱 اطلبي عبر واتساب";
      orderBtnWrap.appendChild(waBtn);
    }

    if (showPayment) {
      const payBtn = document.createElement("button");
      payBtn.type = "button";
      payBtn.className = "btn btn-outline vorder";
      payBtn.dataset.action = "pay-order";
      payBtn.textContent = "💳 ادفعي إلكترونيًا";
      orderBtnWrap.appendChild(payBtn);
    }

    if (!showWhatsapp && !showPayment) {
      const waBtn = document.createElement("button");
      waBtn.type = "button";
      waBtn.className = "btn btn-solid vorder";
      waBtn.dataset.action = "wa-order";
      waBtn.dataset.videoNumber = v.number;
      waBtn.dataset.videoTitle = v.title || "";
      waBtn.textContent = "📱 اطلبي عبر واتساب";
      orderBtnWrap.appendChild(waBtn);
    }

    meta.appendChild(orderBtnWrap);

    card.appendChild(thumb);
    card.appendChild(meta);
    grid.appendChild(card);
  }

  document.addEventListener("DOMContentLoaded", () => {
    const grid = document.getElementById("portfolio-grid");
    if (!grid) return;

    const settingsPromise = _settingsCache
      ? Promise.resolve(JSON.parse(_settingsCache))
      : fetch("../content/settings.json").then(r => r.json()).then(s => { try { sessionStorage.setItem('jg_settings', JSON.stringify(s)); } catch(e){} return s; }).catch(() => ({}));

    Promise.all([
      fetch("../content/portfolio/" + slug + ".json").then(r => r.json()).catch(() => ({ videos: [] })),
      settingsPromise
    ]).then(([data, settings]) => {
      const items = (data && data.videos) || [];
      if (!items.length) { renderEmpty(grid); return; }
      items.forEach(v => renderVideo(grid, v, settings));

      // Event delegation — مستمع واحد بدل مستمع لكل زر
      grid.addEventListener('click', (e) => {
        const thumb = e.target.closest('.thumb');
        if (thumb && thumb.dataset.videoUrl) {
          openVideoModal(thumb.dataset.videoUrl);
          return;
        }
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        if (btn.dataset.action === 'wa-order') {
          orderVideoWhatsapp(
            { number: btn.dataset.videoNumber, title: btn.dataset.videoTitle },
            settings
          );
        } else if (btn.dataset.action === 'pay-order') {
          orderVideoPayment(settings);
        }
      });

      const waBtn = document.getElementById("general-whatsapp-btn");
      if (waBtn) waBtn.href = `https://wa.me/${cleanPhone(settings.whatsapp_number)}`;
    });
  });
})();
