// يعرض الفيديوهات التعليمية وآراء العملاء من content/learn-videos.json و content/testimonials.json
// إضافة/حذف/تعديل أي عنصر = من لوحة التحكم (Netlify CMS) فقط، بدون لمس هذا الملف
(function () {
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

  function renderEmpty(grid, text) {
    const p = document.createElement("p");
    p.style.gridColumn = "1/-1";
    p.style.textAlign = "center";
    p.style.color = "var(--ink-soft)";
    p.textContent = text;
    grid.appendChild(p);
  }

  function renderVideo(grid, v) {
    if (!v.title && !v.video_url) return;
    const card = document.createElement("div");
    card.className = "learn-card";

    const thumb = document.createElement("div");
    thumb.className = "thumb";
    if (v.thumbnail_url) {
      const img = document.createElement("img");
      img.src = v.thumbnail_url;
      img.loading = "lazy";
      img.alt = v.title || "";
      img.onerror = () => { img.style.display = "none"; };
      thumb.appendChild(img);
    }
    const play = document.createElement("div");
    play.className = "play";
    play.textContent = "▶";
    thumb.appendChild(play);
    if (v.video_url) thumb.addEventListener("click", () => openVideoModal(v.video_url));

    const meta = document.createElement("div");
    meta.className = "meta";
    const t = document.createElement("div");
    t.className = "ltitle";
    t.textContent = v.title || "";
    meta.appendChild(t);

    card.appendChild(thumb);
    card.appendChild(meta);
    grid.appendChild(card);
  }

  function renderReview(grid, r) {
    if (!r.text && !r.name) return;
    const card = document.createElement("div");
    card.className = "testimonial-card";

    const stars = document.createElement("div");
    stars.className = "stars";
    const n = Math.max(1, Math.min(5, parseInt(r.rating, 10) || 5));
    stars.textContent = "★".repeat(n) + "☆".repeat(5 - n);
    card.appendChild(stars);

    if (r.text) {
      const text = document.createElement("p");
      text.className = "ttext";
      text.textContent = r.text;
      card.appendChild(text);
    }

    const by = document.createElement("div");
    by.className = "tby";
    if (r.photo_url) {
      const img = document.createElement("img");
      img.src = r.photo_url;
      img.loading = "lazy";
      img.alt = r.name || "";
      img.onerror = () => { img.style.display = "none"; };
      by.appendChild(img);
    }
    const nameWrap = document.createElement("div");
    if (r.name) {
      const name = document.createElement("div");
      name.className = "tname";
      name.textContent = r.name;
      nameWrap.appendChild(name);
    }
    if (r.occasion) {
      const occ = document.createElement("div");
      occ.className = "toccasion";
      occ.textContent = r.occasion;
      nameWrap.appendChild(occ);
    }
    by.appendChild(nameWrap);
    card.appendChild(by);

    grid.appendChild(card);
  }

  document.addEventListener("DOMContentLoaded", () => {
    const videoGrid = document.getElementById("learn-videos-grid");
    const reviewGrid = document.getElementById("testimonials-grid");

    if (videoGrid) {
      fetch("content/learn-videos.json").then(r => r.json()).catch(() => ({ videos: [] })).then(data => {
        const items = (data && data.videos) || [];
        const valid = items.filter(v => v.title || v.video_url);
        if (!valid.length) { renderEmpty(videoGrid, "قريبًا نضيف فيديوهات تعليمية هنا — تُضاف مباشرة من لوحة التحكم."); return; }
        valid.forEach(v => renderVideo(videoGrid, v));
      });
    }

    if (reviewGrid) {
      fetch("content/testimonials.json").then(r => r.json()).catch(() => ({ reviews: [] })).then(data => {
        const items = (data && data.reviews) || [];
        const valid = items.filter(r => r.text || r.name);
        if (!valid.length) { renderEmpty(reviewGrid, "قريبًا نضيف آراء عملائنا هنا — تُضاف مباشرة من لوحة التحكم."); return; }
        valid.forEach(r => renderReview(reviewGrid, r));
      });
    }
  });
})();
