/* SecShare 前台交互脚本 */
(function () {
  'use strict';

  function csrf() {
    var m = document.cookie.match(/(?:^|;\s*)csrf=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  }

  function toast(msg, type) {
    var el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText = 'position:fixed;top:22px;left:50%;transform:translateX(-50%);z-index:9999;padding:11px 22px;border-radius:9px;' +
      'font-size:14px;color:#fff;box-shadow:0 8px 24px rgba(0,0,0,.18);transition:opacity .3s;background:' +
      (type === 'error' ? '#ef4444' : '#10b981');
    document.body.appendChild(el);
    setTimeout(function () { el.style.opacity = '0'; setTimeout(function () { el.remove(); }, 320); }, 2200);
  }

  // 移动端菜单
  var toggle = document.getElementById('navToggle');
  if (toggle) {
    toggle.addEventListener('click', function () {
      var nav = document.getElementById('mainNav');
      if (nav) nav.classList.toggle('open');
    });
  }

  // 公告轮播
  var rotate = document.getElementById('noticeRotate');
  if (rotate) {
    var items = (rotate.getAttribute('data-notices') || '').split('|||').filter(Boolean);
    if (items.length > 1) {
      var i = 0;
      setInterval(function () {
        i = (i + 1) % items.length;
        rotate.style.opacity = '0';
        setTimeout(function () { rotate.textContent = items[i]; rotate.style.opacity = '1'; }, 220);
      }, 6000);
      rotate.style.transition = 'opacity .22s';
    }
  }

  // 收藏
  var favBtn = document.getElementById('favBtn');
  if (favBtn) {
    favBtn.addEventListener('click', function () {
      fetch('/api/favorite/' + favBtn.getAttribute('data-id'), {
        method: 'POST',
        headers: { 'x-csrf-token': csrf(), 'Content-Type': 'application/json' },
      }).then(function (r) { return r.json(); }).then(function (res) {
        if (res.needLogin) { location.href = '/login?redirect=' + encodeURIComponent(location.pathname); return; }
        if (!res.ok) { toast(res.error || '操作失败', 'error'); return; }
        favBtn.textContent = res.favorited ? '★ 已收藏' : '☆ 收藏此资源';
        toast(res.favorited ? '已加入收藏' : '已取消收藏');
      }).catch(function () { toast('网络异常，请重试', 'error'); });
    });
  }

  // 评论
  var commentBtn = document.getElementById('commentBtn');
  if (commentBtn) {
    commentBtn.addEventListener('click', function () {
      var box = document.getElementById('commentContent');
      var text = (box.value || '').trim();
      if (text.length < 2) { toast('评论内容太短', 'error'); return; }
      commentBtn.disabled = true;
      fetch('/api/comment/' + commentBtn.getAttribute('data-id'), {
        method: 'POST',
        headers: { 'x-csrf-token': csrf(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text }),
      }).then(function (r) { return r.json(); }).then(function (res) {
        commentBtn.disabled = false;
        if (!res.ok) { toast(res.error || '评论失败', 'error'); return; }
        var list = document.getElementById('commentList');
        var empty = list.querySelector('.muted.small');
        if (empty && empty.textContent.indexOf('还没有评论') > -1) empty.remove();
        var div = document.createElement('div');
        div.className = 'comment';
        div.innerHTML = '<div class="avatar"></div><div class="c-main"><div class="c-top"><b></b><span class="muted small">刚刚</span></div><div class="c-body"></div></div>';
        div.querySelector('.avatar').textContent = (res.comment.author || '游')[0];
        div.querySelector('.c-top b').textContent = res.comment.author;
        div.querySelector('.c-body').textContent = res.comment.content;
        list.prepend(div);
        box.value = '';
        toast('评论发表成功');
      }).catch(function () { commentBtn.disabled = false; toast('网络异常', 'error'); });
    });
  }

  // 消息已读
  var readAll = document.getElementById('readAllNotices');
  if (readAll) {
    readAll.addEventListener('click', function () {
      fetch('/api/notices/read', { method: 'POST', headers: { 'x-csrf-token': csrf() } })
        .then(function () { location.reload(); });
    });
  }
})();
