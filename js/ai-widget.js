(function() {
  'use strict';

  var STORAGE_KEY = 'jamrat_ai_history';
  var MAX_MESSAGES = 10;
  var MAX_INPUT = 500;
  var API_ENDPOINT = '/.netlify/functions/ai-chat';
  var Z_INDEX = 9998;

  /* ─── Styles ─── */
  var css = `
    #jai-fab{position:fixed;bottom:24px;left:24px;z-index:${Z_INDEX};width:56px;height:56px;border-radius:50%;background:#d4af37;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 16px rgba(0,0,0,.45);transition:transform .2s,box-shadow .2s;animation:jai-pulse 2.5s infinite}
    #jai-fab:hover{transform:scale(1.08);box-shadow:0 6px 24px rgba(212,175,55,.35)}
    #jai-fab svg{width:28px;height:28px;fill:#111}
    @keyframes jai-pulse{0%,100%{box-shadow:0 4px 16px rgba(0,0,0,.45)}50%{box-shadow:0 4px 16px rgba(0,0,0,.45),0 0 0 10px rgba(212,175,55,.15)}}
    #jai-panel{position:fixed;bottom:24px;left:24px;z-index:${Z_INDEX};width:370px;max-width:calc(100vw - 32px);height:520px;max-height:calc(100vh - 48px);background:#1c1c1c;border:1px solid #333;border-radius:14px;display:none;flex-direction:column;overflow:hidden;box-shadow:0 8px 40px rgba(0,0,0,.6);font-family:Tahoma,Arial,sans-serif;direction:rtl}
    #jai-panel.open{display:flex}
    #jai-header{background:#111;padding:14px 16px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #333;flex-shrink:0}
    #jai-header h3{margin:0;font-size:15px;color:#d4af37;font-weight:600}
    #jai-close{background:none;border:none;color:#888;font-size:22px;cursor:pointer;padding:0 4px;line-height:1;transition:color .2s}
    #jai-close:hover{color:#eee}
    #jai-messages{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px}
    #jai-messages::-webkit-scrollbar{width:5px}
    #jai-messages::-webkit-scrollbar-track{background:transparent}
    #jai-messages::-webkit-scrollbar-thumb{background:#444;border-radius:3px}
    .jai-msg{max-width:82%;padding:10px 14px;border-radius:12px;font-size:13.5px;line-height:1.7;word-wrap:break-word;white-space:pre-wrap}
    .jai-msg.user{align-self:flex-end;background:#d4af37;color:#111;border-bottom-right-radius:4px}
    .jai-msg.ai{align-self:flex-start;background:#2a2a2a;color:#ddd;border-bottom-left-radius:4px}
    .jai-msg.system{align-self:center;background:transparent;color:#888;font-size:12px;text-align:center;max-width:100%}
    .jai-typing{align-self:flex-start;display:flex;gap:5px;padding:12px 16px;background:#2a2a2a;border-radius:12px;border-bottom-left-radius:4px}
    .jai-typing span{width:7px;height:7px;background:#888;border-radius:50%;animation:jai-bounce .6s infinite alternate}
    .jai-typing span:nth-child(2){animation-delay:.15s}
    .jai-typing span:nth-child(3){animation-delay:.3s}
    @keyframes jai-bounce{to{opacity:.3;transform:translateY(-4px)}}
    #jai-input-area{padding:12px;border-top:1px solid #333;display:flex;gap:8px;flex-shrink:0}
    #jai-input{flex:1;background:#111;border:1px solid #333;border-radius:10px;padding:10px 14px;color:#eee;font-size:13.5px;font-family:inherit;resize:none;outline:none;max-height:80px;min-height:40px;line-height:1.5;direction:rtl;transition:border-color .2s}
    #jai-input:focus{border-color:#d4af37}
    #jai-input::placeholder{color:#555}
    #jai-send{background:#d4af37;border:none;color:#111;width:40px;height:40px;border-radius:10px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:opacity .2s}
    #jai-send:hover{opacity:.85}
    #jai-send:disabled{opacity:.35;cursor:default}
    #jai-send svg{width:18px;height:18px;fill:#111}
    @media(max-width:420px){#jai-panel{width:calc(100vw - 16px);height:calc(100vh - 32px);bottom:16px;left:8px;border-radius:12px}}
  `;

  /* ─── Inject Styles ─── */
  var styleEl = document.createElement('style');
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  /* ─── Create FAB ─── */
  var fab = document.createElement('button');
  fab.id = 'jai-fab';
  fab.setAttribute('aria-label', 'فتح مساعد جمرة AI');
  fab.innerHTML = '<svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/><path d="M7 9h2v2H7zm4 0h2v2h-2zm4 0h2v2h-2z"/></svg>';
  document.body.appendChild(fab);

  /* ─── Create Panel ─── */
  var panel = document.createElement('div');
  panel.id = 'jai-panel';
  panel.innerHTML =
    '<div id="jai-header">' +
      '<h3>جمرة AI</h3>' +
      '<button id="jai-close" aria-label="إغلاق">&times;</button>' +
    '</div>' +
    '<div id="jai-messages"></div>' +
    '<div id="jai-input-area">' +
      '<textarea id="jai-input" rows="1" placeholder="اكتب رسالتك..." maxlength="' + MAX_INPUT + '"></textarea>' +
      '<button id="jai-send" aria-label="إرسال">' +
        '<svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>' +
      '</button>' +
    '</div>';
  document.body.appendChild(panel);

  /* ─── DOM Refs ─── */
  var closeBtn = panel.querySelector('#jai-close');
  var messagesEl = panel.querySelector('#jai-messages');
  var inputEl = panel.querySelector('#jai-input');
  var sendBtn = panel.querySelector('#jai-send');
  var isOpen = false;
  var aiEnabled = null; // null = not checked yet
  var isLoading = false;

  /* ─── Helpers ─── */
  function getHistory() {
    try { return JSON.parse(sessionStorage.getItem(STORAGE_KEY)) || []; } catch(e) { return []; }
  }
  function setHistory(arr) {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(arr.slice(-MAX_MESSAGES)));
  }
  function appendBubble(text, type) {
    var div = document.createElement('div');
    div.className = 'jai-msg ' + type;
    div.textContent = text;
    messagesEl.appendChild(div);
    scrollToBottom();
  }
  function showTyping() {
    var div = document.createElement('div');
    div.className = 'jai-typing';
    div.id = 'jai-typing-indicator';
    div.innerHTML = '<span></span><span></span><span></span>';
    messagesEl.appendChild(div);
    scrollToBottom();
  }
  function hideTyping() {
    var el = document.getElementById('jai-typing-indicator');
    if (el) el.remove();
  }
  function scrollToBottom() {
    requestAnimationFrame(function() {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    });
  }
  function setInputState(disabled) {
    inputEl.disabled = disabled;
    sendBtn.disabled = disabled;
    isLoading = disabled;
  }

  /* ─── Toggle Panel ─── */
  function openPanel() {
    isOpen = true;
    panel.classList.add('open');
    fab.style.display = 'none';
    inputEl.focus();
    checkAIEnabled();
  }
  function closePanel() {
    isOpen = false;
    panel.classList.remove('open');
    fab.style.display = 'flex';
  }

  /* ─── Check AI Enabled ─── */
  function checkAIEnabled() {
    if (aiEnabled !== null) return;
    fetch(API_ENDPOINT)
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data && data.enabled === false) {
          aiEnabled = false;
          appendBubble('المساعد غير متاح حالياً', 'system');
          setInputState(true);
          inputEl.placeholder = 'المساعد غير متاح';
        } else {
          aiEnabled = true;
        }
      })
      .catch(function() {
        // If check fails, assume enabled and let send fail gracefully
        aiEnabled = true;
      });
  }

  /* ─── Send Message ─── */
  function sendMessage() {
    var text = inputEl.value.trim();
    if (!text || isLoading) return;
    if (text.length > MAX_INPUT) text = text.substring(0, MAX_INPUT);

    // Show user bubble
    appendBubble(text, 'user');
    inputEl.value = '';
    autoResize();

    // Save to history
    var history = getHistory();
    history.push({ role: 'user', text: text });
    setHistory(history);

    // Send to API
    setInputState(true);
    showTyping();

    fetch(API_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text })
    })
      .then(function(r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function(data) {
        hideTyping();
        var reply = (data && data.reply) ? data.reply : 'عذراً، حدث خطأ. حاول مرة أخرى.';
        appendBubble(reply, 'ai');
        history.push({ role: 'ai', text: reply });
        setHistory(history);
        setInputState(false);
        inputEl.focus();
      })
      .catch(function(err) {
        hideTyping();
        appendBubble('عذراً، تعذر الاتصال بالمساعد. حاول لاحقاً.', 'ai');
        setInputState(false);
        inputEl.focus();
      });
  }

  /* ─── Auto-resize Textarea ─── */
  function autoResize() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 80) + 'px';
  }

  /* ─── Event Listeners ─── */
  fab.addEventListener('click', openPanel);
  closeBtn.addEventListener('click', closePanel);
  sendBtn.addEventListener('click', sendMessage);

  inputEl.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  inputEl.addEventListener('input', function() {
    if (inputEl.value.length > MAX_INPUT) {
      inputEl.value = inputEl.value.substring(0, MAX_INPUT);
    }
    autoResize();
  });

  // Close on Escape
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && isOpen) closePanel();
  });

})();
