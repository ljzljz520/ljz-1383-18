// app.js — 叙事编辑器前端。离线优先：所有变更统一经 /sync（携带 base_version）合并。
const $ = (s) => document.querySelector(s);
const state = {
  albumId: new URLSearchParams(location.search).get('album') || localStorage.getItem('albumId'),
  headVersion: 0,
  online: true,
  queue: JSON.parse(localStorage.getItem('queue') || '[]'),
  data: null,
  selected: null,
  clientId: sessionStorage.getItem('cid') || (sessionStorage.setItem('cid', Math.random().toString(36).slice(2)), sessionStorage.getItem('cid')),
};
if (state.albumId) localStorage.setItem('albumId', state.albumId);

const saveQueue = () => { localStorage.setItem('queue', JSON.stringify(state.queue)); $('#qN').textContent = state.queue.length; };
const now = () => Date.now();
function keyBetween(a, b) { if (a == null && b == null) return 1; if (a == null) return b - 1; if (b == null) return a + 1; return (a + b) / 2; }

async function api(path, method = 'GET', body) {
  const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
}
function report(html, cls = '') {
  const el = $('#report'); el.classList.add('show');
  el.innerHTML += `<div class="${cls}">${html}</div>`;
  el.scrollTop = el.scrollHeight;
  clearTimeout(report._t); report._t = setTimeout(() => el.classList.remove('show'), 9000);
}

// ---------- 加载 ----------
async function load() {
  if (!state.albumId) {
    const r = await api('/api/albums', 'POST', { title: '我的旅行影集' });
    state.albumId = r.id; localStorage.setItem('albumId', r.id);
    history.replaceState(null, '', '?album=' + r.id);
  }
  const d = await api('/api/albums/' + state.albumId);
  state.data = d; state.headVersion = d.album.head_version;
  $('#headV').textContent = state.headVersion;
  $('#albumId').textContent = 'album ' + state.albumId.slice(0, 8);
  renderAll();
}

// ---------- 渲染 ----------
function refLabel(type, id) {
  const d = state.data;
  if (type === 'media') { const m = d.media.find(x => x.id === id); return m ? `📷 ${m.caption || m.filename}${m.status !== 'ready' ? '（处理中）' : ''}` : '📷 [已移除]'; }
  if (type === 'node') { const n = d.nodes.find(x => x.id === id); return n ? `📍 ${n.label}` : '📍 [已撤下]'; }
  if (type === 'companion') { const c = d.companions.find(x => x.id === id); return c ? `👤 ${c.name}` : '👤 [已移除]'; }
  return id;
}
function renderBody(body) {
  return (body || '').replace(/\[\[(media|node|companion):([^\]]+)\]\]/g,
    (m, t, id) => `<span class="tag ${t}">${refLabel(t, id)}</span>`);
}
function renderAll() { renderChapters(); renderMedia(); renderNodes(); renderComps(); renderShares(); renderEditor(); }

function renderChapters() {
  const list = $('#chapterList'); list.innerHTML = '';
  for (const ch of state.data.chapters) {
    const div = document.createElement('div');
    div.className = 'card ch' + (state.selected === ch.id ? ' active' : '');
    div.draggable = true; div.dataset.id = ch.id;
    div.innerHTML = `<div class="t">${escapeHtml(ch.title) || '（无标题）'}</div><div class="meta">refs: ${(ch.body.match(/\[\[/g) || []).length} · v${ch.version}</div>`;
    div.onclick = () => { state.selected = ch.id; renderAll(); };
    div.ondragstart = (e) => { e.dataTransfer.setData('text/plain', ch.id); div.classList.add('dragging'); };
    div.ondragend = () => div.classList.remove('dragging');
    div.ondragover = (e) => e.preventDefault();
    div.ondrop = (e) => { e.preventDefault(); onDrop(ch.id, e.dataTransfer.getData('text/plain')); };
    list.appendChild(div);
  }
}
function escapeHtml(s) { return String(s || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

function renderEditor() {
  const ch = state.data.chapters.find(c => c.id === state.selected);
  $('#editor').style.display = ch ? 'block' : 'none';
  $('#noSel').style.display = ch ? 'none' : 'block';
  if (!ch) return;
  $('#chTitle').value = ch.title; $('#chBody').value = ch.body;
  $('#preview').innerHTML = renderBody(ch.body);
}
function renderMedia() {
  $('#mediaList').innerHTML = state.data.media.map(m =>
    `<div class="item"><span>📷 ${escapeHtml(m.caption || m.filename)} <span class="muted">${m.status}${m.variant_of ? '·变体' : ''}</span></span><code>${m.id.slice(0, 6)}</code></div>`).join('');
}
function renderNodes() {
  $('#nodeList').innerHTML = state.data.nodes.map(n =>
    `<div class="item"><span>📍 ${escapeHtml(n.label)} ${n.published ? '' : '<span class="muted">(已撤下)</span>'}</span>
     <span><button class="danger" onclick="unpublishNode('${n.id}')">撤下</button></span></div>`).join('');
}
function renderComps() {
  const consents = state.data.consents;
  $('#compList').innerHTML = state.data.companions.map(c => {
    const sc = (s) => { const x = consents.find(y => y.companion_id === c.id && y.scope === s); return x && x.status === 'granted'; };
    return `<div class="item"><span>👤 ${escapeHtml(c.name)}<br><span class="muted">${escapeHtml(c.contact)}</span></span>
      <span class="consent">
      ${['name', 'contact', 'exact_location'].map(s =>
        `<label>${s} <input type="checkbox" ${sc(s) ? 'checked' : ''} onchange="toggleConsent('${c.id}','${s}',this.checked)"></label>`).join('')}
      </span></div>`;
  }).join('');
}
function renderShares() {
  $('#shareList').innerHTML = state.data.shares.map(s =>
    `<div class="item"><span>🔗 ${s.policy} ${s.revoked ? '(已撤销)' : ''}</span><a href="/share/${s.token}" target="_blank">打开</a></div>`).join('');
}

// ---------- 变更（统一构造 op，经 sync 合并） ----------
async function commit(op) {
  op.lamport = now();
  if (state.online) {
    await syncOps([op]);
  } else {
    applyLocal(op); state.queue.push(op); saveQueue();
    report(`离线：已暂存 ${op.type}，待重连同步`, 'okc'); renderAll();
  }
}
function applyLocal(op) { // 离线时乐观应用到本地视图
  const d = state.data;
  if (op.type === 'chapter.create') d.chapters.push({ ...op.chapter, version: 1 });
  else if (op.type === 'chapter.update') { const c = d.chapters.find(x => x.id === op.chapter_id); if (c) Object.assign(c, op.fields); }
  else if (op.type === 'chapter.delete') { d.chapters = d.chapters.filter(x => x.id !== op.chapter_id); }
  else if (op.type === 'chapter.reorder') {
    const c = d.chapters.find(x => x.id === op.chapter_id); if (!c) return;
    const b = d.chapters.find(x => x.id === op.before_id), a = d.chapters.find(x => x.id === op.after_id);
    c.order_key = keyBetween(b && b.order_key, a && a.order_key);
    d.chapters.sort((x, y) => x.order_key - y.order_key);
  }
}

async function syncOps(ops) {
  const r = await api(`/api/albums/${state.albumId}/sync`, 'POST', { client_id: state.clientId, base_version: state.headVersion, ops });
  if (!r.ok) return report('同步失败: ' + r.error, 'purged');
  state.headVersion = r.head_version; $('#headV').textContent = state.headVersion;
  for (const res of r.results) {
    if (res.status === 'conflict') report(`⚖️ 合并冲突（${res.op}）：${res.note}`, 'conflict');
    else if (res.status === 'purged') report(`🧹 已脱敏（${res.op}）：${res.note || '含已撤回信息'}`, 'purged');
    else if (res.status === 'rejected') report(`⛔ 已拒绝（${res.op}）：${res.note}`, 'purged');
  }
  for (const p of (r.purged || [])) report(`🧹 移除已撤回内容：${p.field} — ${p.reason}`, 'purged');
  applyTombstones(r.tombstones);
  await load();
}

function applyTombstones(t) {
  if (!t) return;
  const d = state.data; if (!d) return;
  const before = JSON.stringify([d.chapters.length, d.nodes.length, d.media.length]);
  d.chapters = d.chapters.filter(c => !t.chapters.includes(c.id));
  d.nodes = d.nodes.filter(n => !t.nodes.includes(n.id));
  d.media = d.media.filter(m => !t.media.includes(m.id));
  if (t.revoked_consents && t.revoked_consents.length)
    report(`🔒 ${t.revoked_consents.length} 项许可已撤回，本地缓存中的相关内容已清理`, 'conflict');
  const after = JSON.stringify([d.chapters.length, d.nodes.length, d.media.length]);
  if (before !== after) report('🧽 已按服务端墓碑清理失效的本地离线内容', 'okc');
}

// ---------- 事件 ----------
async function onDrop(targetId, draggedId) {
  if (targetId === draggedId) return;
  const chs = state.data.chapters;
  const ti = chs.findIndex(c => c.id === targetId);
  const before = ti > 0 ? chs[ti - 1] : null;
  const after = chs[ti];
  await commit({ type: 'chapter.reorder', chapter_id: draggedId, before_id: before && before.id, after_id: after && after.id });
  if (state.online) await load();
}
window.unpublishNode = async (id) => { await api(`/api/albums/${state.albumId}/nodes/${id}/unpublish`, 'POST'); report('节点已撤下，相关摘要与分享快照已更新', 'okc'); await load(); };
window.toggleConsent = async (cid, scope, granted) => {
  const r = granted ? await api(`/api/companions/${cid}/grant`, 'POST', { scope }) : await api(`/api/companions/${cid}/revoke`, 'POST', { scope });
  if (r.report) report(`🔒 撤回 ${scope}：重写章节${r.report.chapters_rewritten}、图注${r.report.captions_rewritten}、重生成图像${r.report.images_regenerated}、快照${r.report.snapshots_regenerated}；不可撤回外部副本 ${r.report.non_revocable_external.length} 份`, 'conflict');
  await load();
};

$('#newChapter').onclick = async () => {
  const id = Math.random().toString(36).slice(2) + Date.now();
  await commit({ type: 'chapter.create', chapter: { id, title: '新章节', body: '' } });
  state.selected = id; if (state.online) await load(); else renderAll();
};
$('#saveChapter').onclick = async () => {
  await commit({ type: 'chapter.update', chapter_id: state.selected, fields: { title: $('#chTitle').value, body: $('#chBody').value } });
  report('已保存', 'okc');
};
$('#delChapter').onclick = async () => { await commit({ type: 'chapter.delete', chapter_id: state.selected }); state.selected = null; if (state.online) await load(); else renderAll(); };
document.querySelectorAll('[data-ins]').forEach(b => b.onclick = () => {
  const t = b.dataset.ins; const d = state.data;
  let pool = t === 'media' ? d.media : t === 'node' ? d.nodes : d.companions;
  if (!pool.length) return alert('没有可引用的' + t);
  const pick = pool[0]; // 简化：取第一个；实际可弹选择器
  const ta = $('#chBody'); ta.value += ` [[${t}:${pick.id}]] `; $('#preview').innerHTML = renderBody(ta.value);
});
$('#addMedia').onclick = async () => { await api(`/api/albums/${state.albumId}/media`, 'POST', { filename: $('#mediaName').value || 'photo.jpg', caption: '' }); await api('/api/media/process', 'POST'); await load(); };
$('#addNode').onclick = async () => { await api(`/api/albums/${state.albumId}/nodes`, 'POST', { label: $('#nodeLabel').value, lat: +$('#nodeLat').value, lng: +$('#nodeLng').value }); await load(); };
$('#addComp').onclick = async () => { await api(`/api/albums/${state.albumId}/companions`, 'POST', { name: $('#compName').value, contact: $('#compContact').value }); await load(); };
$('#shareWhitelist').onclick = async () => {
  const r = await api(`/api/albums/${state.albumId}/share`, 'POST', { policy: 'whitelist', allowed_fields: { name: $('#allowName').checked, contact: $('#allowContact').checked, exact_location: $('#allowLoc').checked } });
  report(`已生成白名单快照：<a href="${r.url}" target="_blank" style="color:#7dd3fc">${r.url}</a>`, 'okc'); await load();
};
$('#shareFull').onclick = async () => { const r = await api(`/api/albums/${state.albumId}/share`, 'POST', { policy: 'full' }); report(`已生成全章共享：<a href="${r.url}" target="_blank" style="color:#7dd3fc">${r.url}</a>`, 'okc'); await load(); };

$('#toggleNet').onclick = () => {
  state.online = !state.online;
  const p = $('#netPill'); p.textContent = state.online ? '在线' : '离线'; p.className = 'pill ' + (state.online ? 'on' : 'off');
};
$('#syncBtn').onclick = async () => {
  if (!state.queue.length) { await load(); return report('没有待同步的离线变更', 'okc'); }
  const ops = state.queue; state.queue = []; saveQueue();
  await syncOps(ops); report(`已同步 ${ops.length} 条离线操作`, 'okc');
};
$('#reloadBtn').onclick = load;

$('#qN').textContent = state.queue.length;
load();
