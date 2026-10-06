const SERVER_KEY = 'travel.server.v1';
const params = new URLSearchParams(location.search);
const shareId = params.get('share');
const requestedGen = params.get('g');
const staleRequested = params.has('stale');
const root = document.getElementById('share-root');

function esc(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]));
}
function shell(title, body) {
  root.innerHTML = `<section class="glass-panel trip-card"><p class="eyebrow">Published Generation</p><h1>${esc(title)}</h1>${body}</section>`;
}
function renderTombstone(reason, current) {
  shell('此分享链接的缓存版本不可显示', `
    <div class="conflict-card">
      <h3>请求的发布代次已失效或无法在线验证</h3>
      <p>${esc(reason)}</p>
      <p>浏览器没有回退到旧缓存正文，以避免显示已撤回的姓名、联系方式、精确位置，或已撤下节点的悬空摘要。</p>
      ${current ? `<a class="btn primary" href="/travel/share.html?share=${encodeURIComponent(current.shareId)}&g=${encodeURIComponent(current.generationId)}">查看当前发布代次</a>` : ''}
      <a class="btn" href="/travel/editor.html">返回编辑器</a>
    </div>`);
}
function renderSnapshot(share, snapshot) {
  shell(share.label, `
    <div class="status-card" style="border-top:0;margin-top:0;padding-top:0">
      <div class="status-line"><span class="dot"></span><strong>访客视图已验证：路线和章节来自同一发布代次</strong></div>
      <div class="status-grid">
        <span>发布代次</span><b>${esc(snapshot.generationId)}</b>
        <span>共享方式</span><b>${snapshot.mode === 'fullChapter' ? '全章共享' : '字段/单元白名单快照'}</b>
        <span>姓名</span><b>${snapshot.allow.names ? '可见' : '隐藏'}</b>
        <span>联系信息</span><b>${snapshot.allow.contacts ? '可见' : '隐藏'}</b>
        <span>精确位置</span><b>${snapshot.allow.preciseLocation ? '可见' : '仅约 10 公里'}</b>
      </div>
    </div>
    ${Object.values(snapshot.chapters).map((chapter) => `
      <article class="chapter-card" style="margin:18px 0">
        <h2>${esc(chapter.title)}</h2><p class="muted">${esc(chapter.summary)}</p>
        <div class="blocks">
          ${Object.values(snapshot.blocks).filter((b) => b.chapterId === chapter.id).map((block) => {
            if (block.type === 'text') return `<div class="block-card"><span class="block-kind">¶</span><div><p>${esc(block.text)}</p></div></div>`;
            if (block.type === 'photo') {
              const photo = snapshot.photos[block.photoId];
              return `<div class="block-card"><span class="block-kind">▧</span><div><strong>${esc(photo?.name || '照片')}</strong><p>${esc(photo?.caption || '')}</p><p class="block-meta">${esc(photo?.mediaState)} · ${esc(photo?.location.precision)}</p></div></div>`;
            }
            const node = snapshot.nodes[block.nodeId];
            return `<div class="block-card"><span class="block-kind">⌖</span><div><strong>${esc(node?.name)}</strong><p class="block-meta">${node?.lat},${node?.lng} · ${esc(node?.precision)}</p></div></div>`;
          }).join('')}
        </div>
      </article>`).join('')}
    <section class="glass-panel trip-card"><h2>本代次索引</h2><ol>${snapshot.index.map((entry) => `<li><code>${esc(entry.ref)}</code> — ${esc(String(entry.text).slice(0, 90))}</li>`).join('')}</ol></section>`);
  if (navigator.serviceWorker?.controller) navigator.serviceWorker.controller.postMessage({ type: 'SHARE_VIEWED', shareId: share.id, generationId: snapshot.generationId });
}
function showState(server) {
  const doc = server.doc;
  const share = doc.shares?.[shareId];
  const activeGen = doc.activeGenerationId;
  if (!share || share.status !== 'active') return renderTombstone('分享不存在或已停用。');
  if (staleRequested || requestedGen !== activeGen || share.generationId !== activeGen) {
    return renderTombstone(`请求代次 ${requestedGen || '(未指定)'} 与当前代次 ${activeGen} 不一致。`, { shareId, generationId: activeGen });
  }
  const snapshot = doc.snapshots[share.snapshotId];
  if (!snapshot || snapshot.generationId !== activeGen) return renderTombstone('快照与路线不属于同一发布代次。', { shareId, generationId: activeGen });
  renderSnapshot(share, snapshot);
}

async function boot() {
  let server = null;
  if (location.protocol !== 'file:') {
    try {
      const response = await fetch('/api/state', { cache: 'no-store' });
      if (!response.ok) throw new Error('state unavailable');
      server = await response.json();
      localStorage.setItem(SERVER_KEY, JSON.stringify(server));
    } catch {
      renderTombstone('当前离线，无法确认链接是否为最新代次；受控客户端不使用旧缓存正文。');
      return;
    }
  } else {
    const raw = localStorage.getItem(SERVER_KEY);
    if (raw) server = JSON.parse(raw);
  }
  if (!server) renderTombstone('尚未载入发布数据，无法验证链接是否仍为当前代次。');
  else showState(server);
}
boot();
if (navigator.serviceWorker) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type === 'SHARE_PURGED' && event.data.activeGeneration !== requestedGen) {
      renderTombstone('受控客户端重连后已收到撤回/发布清理信号。', { shareId, generationId: event.data.activeGeneration });
    }
  });
  navigator.serviceWorker.register('/travel/sw.js').catch(() => {});
}
