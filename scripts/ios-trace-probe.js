/**
 * ios-trace-probe.js — iOS 模拟器内「智能体操作轨迹 (agent trace)」真机探针
 *
 * 注入到**构建产物** App.app/public/index.html (只动产物, 不污染仓库源码)。
 * 做什么: 过首启同意门 → 切网络页 → 点「一键入网」(手机端本地执行, 会产生 worklog)
 *        → 等 .agent-trace 出现 → 把轨迹行渲染成全屏 overlay
 *        → 供 `xcrun simctl io booted screenshot` 截图后人工/视觉核对。
 */
(function () {
  var DESKTOP = '__DESKTOP_BASE__';
  var log = function (m) { try { console.log('[trace-probe] ' + m); } catch (e) {} };

  function overlay(title, body) {
    var el = document.getElementById('probe-overlay');
    if (!el) {
      el = document.createElement('pre');
      el.id = 'probe-overlay';
      el.style.cssText = 'position:fixed;inset:0;z-index:99999;margin:0;padding:14px;' +
        'background:#0f0f0f;color:#c4d640;font:12px/1.4 -apple-system,Menlo,monospace;' +
        'white-space:pre-wrap;overflow:auto;';
      document.body.appendChild(el);
    }
    el.textContent = title + '\n' + (body || '');
    document.title = 'TRACE:' + title;
  }

  function traceLines() {
    var t = document.querySelector('.agent-trace');
    if (!t) return [];
    return Array.prototype.slice.call(t.querySelectorAll('.agent-trace-line')).map(function (e) { return e.textContent || ''; });
  }

  function joinItemVisible() {
    var item = document.getElementById('item-join-global');
    if (!item) return false;
    var page = document.getElementById('page-network');
    if (page && page.hidden) return false;
    return item.offsetParent !== null;
  }

  var clicked = false;
  var gateClicked = false;
  var t0 = Date.now();
  var iv = setInterval(function () {
    try {
      if (!window.BolloonCore) { if (Date.now() - t0 > 60000) { overlay('timeout-core', '内核没就绪'); clearInterval(iv); } return; }
      var gate = document.getElementById('privacy-agree');
      // 只在第一次处理同意门: 点过之后元素可能仍留在 DOM (只是隐藏), 不认这一点会死循环在 consent
      var gateVisible = !!gate && !gateClicked && (gate.offsetParent !== null || !gate.hidden);
      if (gateVisible) { gate.click(); gateClicked = true; overlay('phase=consent', '已过首启同意门…'); return; }
      if (!clicked) {
        if (joinItemVisible()) {
          localStorage.setItem('bolloon_desktop_base_url', DESKTOP);
          document.getElementById('item-join-global').click();
          clicked = true;
          overlay('phase=clicked', 'DESKTOP=' + DESKTOP + '\n已点「一键入网」, 等手机端本地执行 + 轨迹…');
        } else {
          var tab = document.querySelector('button.tab[data-tab="network"]') || document.querySelector('[data-tab="network"]');
          if (tab) tab.click();
          // 每轮都把卡在哪一步报出来 (否则只看到上一次的 overlay, 无法定位)
          var pg = document.getElementById('page-network');
          overlay('phase=wait-network', 'DESKTOP=' + DESKTOP +
            '\ngate=' + !!document.getElementById('privacy-agree') +
            '\ntab=' + !!tab + '\npage-network.hidden=' + (pg ? pg.hidden : 'n/a') +
            '\nitem=' + !!document.getElementById('item-join-global'));
        }
        return;
      }
      var lines = traceLines();
      if (lines.length >= 2) {
        overlay('phase=trace-ok', 'DESKTOP=' + DESKTOP + '\n轨迹行数=' + lines.length + '\n\n' + lines.join('\n'));
        clearInterval(iv);
      } else if (Date.now() - t0 > 90000) {
        overlay('timeout-trace', '没等到轨迹\n轨迹行数=' + lines.length);
        clearInterval(iv);
      }
    } catch (e) { overlay('probe-error', String((e && e.message) || e)); clearInterval(iv); }
  }, 700);

  log('trace probe installed, desktop=' + DESKTOP);
})();
