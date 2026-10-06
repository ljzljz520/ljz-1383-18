import {
  analyzeConsentImpact,
  positionBetween,
  sortedByPosition,
  uid,
} from './kernel.js';
import { Repository, idbGet, now } from './repository.js';
import { createOriginalBlob, processMediaJob } from './media.js';

const repo = new Repository('main');
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const dialog = $('#share-dialog');
const personDialog = $('#person-dialog');
const nodeDialog = $('#node-dialog');
const thumbUrls = new Map();
let activeDragId = null;

function toast(message, type = 'success') {
  const el = document.createElement('div');
  el.className = `toast ${type === 'success' ? '' : type}`;
  el.innerHTML = `<strong>${type === 'error' ? '未完成' : type === 'warn' ? '请注意' : '已完成'}</strong><br>${message}`;
  $('#toast-container').appendChild(el);
  setTimeout(() => el.remove(), 4600);
}

function esc(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]));
}

function chapterById(id) { return repo.doc.chapters[id]; }
function chapterBlocks(chapterId) {
  return sortedByPosition(Object.values(repo.doc.blocks).filter((b) => b.chapterId === chapterId));
}
function personsFor(ids = []) { return ids.map((id) => repo.doc.people[id]?.name || '同行人').join('、') || '无标记同行人'; }
function nodePrecision(node) {
  return node ? `${node.name} · ${node.lat.toFixed(5)},${node.lng.toFixed(5)}` : '';
}

function renderStatus() {
  const doc = repo.doc;
  $('#net-dot').classList.toggle('offline', !repo.online);
  $('#net-label').textContent = repo.online ? '在线 / API 已连接' : '离线 / 本地可编辑';
  $('#toggle-online').textContent = repo.online ? '切换离线' : '恢复联网';
  $('#gen-label').textContent = doc.activeGenerationId || '未发布';
  $('#outbox-count').textContent = repo.state.outbox.length;
  $('#conflict-count').textContent = repo.state.conflicts.length;
}

async function renderPhotos() {
  const entries = Object.values(repo.doc.photos);
  await Promise.all(entries.map(async (photo) => {
    const preferred = photo.derivativeId || `${photo.id}.original`;
    const key = `${photo.id}:${preferred}`;
    if (!thumbUrls.has(key)) {
      const blob = (await idbGet(preferred)) || (await idbGet(`${photo.id}.original`));
      if (blob) thumbUrls.set(key, URL.createObjectURL(blob));
    }
    const url = thumbUrls.get(key);
    const img = $(`[data-photo-thumb="${photo.id}"]`);
    if (img && url) img.src = url;
  }));
}

function renderConflicts() {
  const box = $('#conflicts');
  const conflicts = repo.state.conflicts || [];
  if (!conflicts.length) { box.className = 'conflicts hidden'; box.innerHTML = ''; return; }
  box.className = 'conflicts';
  box.innerHTML = `
    <h2>需要理解的结构合并结果（${conflicts.length}）</h2>
    ${conflicts.map((c, i) => `
      <article class="conflict-card">
        <h3>${i + 1}. ${esc(c.code === 'WITHDRAWN_INFO_REUPLOAD' ? '离线稿重新上传已撤回信息' : c.code === 'CONCURRENT_REORDER' ? '两个标签页同时重排' : c.code)}</h3>
        <p>${esc(c.message)}</p>
        <p><strong>合并策略：</strong>${esc(c.resolution)}</p>
        ${c.removed?.length ? `<p class="muted">清洗字段：${c.removed.map((r) => esc(r.path)).join('、')}</p>` : ''}
      </article>`).join('')}
  `;
}

function renderPeople() {
  $('#people').innerHTML = Object.values(repo.doc.people).map((person) => {
    const consent = repo.doc.consents[person.id];
    const withdrawn = consent?.status === 'withdrawn';
    const impact = withdrawn ? analyzeConsentImpact(repo.doc, person.id) : null;
    return `<article class="person-card ${withdrawn ? 'withdrawn' : ''}">
      <div class="button-row" style="justify-content:space-between">
        <h3>${withdrawn ? '同行人（姓名已隐藏）' : esc(person.name)}</h3>
        <span class="badge ${withdrawn ? 'withdrawn' : ''}">${withdrawn ? '许可撤回' : '许可有效'}</span>
      </div>
      <p class="muted">${withdrawn ? '联系信息不可见，旧快照与索引已重新生成。' : esc(person.contact)}</p>
      ${withdrawn && impact ? `<p class="muted">影响：${impact.photoIds.length} 张图、${impact.blockIds.length} 个段落/引用、${impact.snapshotIds.length} 个快照；外部不可达副本 ${impact.externalCopyIds.length} 个。</p>` : ''}
      <div class="button-row">
        ${withdrawn ? '' : `<button class="btn danger small" data-withdraw="${person.id}">撤回许可并重新生成</button>`}
      </div>
    </article>`;
  }).join('');
}

function renderChapters() {
  const chapters = sortedByPosition(Object.values(repo.doc.chapters));
  $('#chapters').innerHTML = chapters.map((chapter, index) => {
    const blocks = chapterBlocks(chapter.id);
    return `<article class="chapter-card" draggable="true" data-chapter="${chapter.id}">
      <div class="chapter-head">
        <span class="drag-handle" draggable="true" data-drag-chapter="${chapter.id}">⋮⋮</span>
        <div>
          <input value="${esc(chapter.title)}" data-chapter-title="${chapter.id}" aria-label="章节标题" />
          <div class="block-meta">chapterId=${chapter.id} · pos=${chapter.pos} · 拖动时引用不变</div>
        </div>
        <div class="chapter-actions">
          <button class="btn small" data-add-text="${chapter.id}">加段落</button>
          <button class="btn small" data-add-photo="${chapter.id}">加照片</button>
          <button class="btn small" data-add-map="${chapter.id}">加地图</button>
          <button class="btn small danger" data-remove-node-from-chapter="${chapter.id}">撤下节点</button>
        </div>
      </div>
      <textarea rows="2" data-chapter-summary="${chapter.id}">${esc(chapter.summary)}</textarea>
      <div class="blocks">
        ${blocks.map((block) => renderBlock(block)).join('')}
      </div>
    </article>`;
  }).join('');
}

function renderBlock(block) {
  let body = '';
  let kind = '¶';
  if (block.type === 'text') {
    kind = '¶';
    body = `
      <textarea rows="3" data-block-text="${block.id}">${esc(block.text)}</textarea>
      <div class="block-meta">人物引用：${esc(personsFor(block.personIds))}</div>`;
  } else if (block.type === 'photo') {
    kind = '▧';
    const photo = repo.doc.photos[block.photoId];
    body = photo ? `
      <div>
        <strong>${esc(photo.name)}</strong>
        <div class="block-meta">photoId=${photo.id} · ${photo.status} · ${photo.derivativeId}</div>
        <textarea rows="2" data-photo-caption="${photo.id}">${esc(photo.caption)}</textarea>
        <img class="photo-thumb" data-photo-thumb="${photo.id}" alt="${esc(photo.name)}" />
      </div>` : '<p class="badge danger">照片引用失效</p>';
  } else {
    kind = '⌖';
    const node = repo.doc.nodes[block.nodeId];
    body = node ? `
      <div><strong>${node.status === 'removed' ? '已撤下节点' : esc(node.name)}</strong>
      <div class="block-meta">nodeId=${node.id} · ${node.status === 'removed' ? '发布时此地图块不会悬空保留' : esc(nodePrecision(node))}</div></div>`
      : '<p class="badge danger">地图节点不存在</p>';
  }
  return `<div class="block-card" draggable="true" data-block="${block.id}">
    <span class="block-kind">${kind}</span>
    <div>${body}</div>
    <div class="inline-actions"><span class="drag-handle" draggable="true" data-drag-block="${block.id}">⋮⋮</span></div>
  </div>`;
}

function renderMediaJobs() {
  const jobs = Object.values(repo.doc.mediaJobs || {});
  if (!jobs.length) return;
  const box = document.createElement('section');
  box.className = 'glass-panel trip-card';
  box.innerHTML = `<h2>媒体处理队列（检查点持久）</h2>` + jobs.map((job) => `
    <div style="margin:12px 0">
      <div class="button-row" style="justify-content:space-between">
        <strong>${job.photoId} → ${job.targetDerivativeId}</strong>
        <span class="badge ${job.state === 'done' ? '' : job.state === 'interrupted' ? 'warn' : 'danger'}">${job.state} ${job.progress || 0}%</span>
      </div>
      <progress max="100" value="${job.progress || 0}"></progress>
      ${job.state === 'interrupted' ? `<button class="btn small primary" data-resume-job="${job.id}">从 ${job.progress}% 继续</button>` : ''}
    </div>`).join('');
  const existing = $('#jobs');
  if (existing) existing.replaceWith(box);
  else $('.workspace').appendChild(box);
  box.id = 'jobs';
}

function renderShares() {
  const shares = Object.values(repo.doc.shares || {});
  $('#share-list').innerHTML = shares.map((share) => {
    const url = `/travel/share.html?share=${encodeURIComponent(share.id)}&g=${encodeURIComponent(share.generationId || '')}`;
    const fields = [];
    if (share.allow?.names) fields.push('姓名');
    if (share.allow?.contacts) fields.push('联系信息');
    if (share.allow?.preciseLocation) fields.push('精确位置');
    return `<div class="share-item">
      <strong>${esc(share.label)}</strong>
      <p><span class="badge ${share.mode === 'fullChapter' ? '' : 'warn'}">${share.mode === 'fullChapter' ? '全章共享' : '白名单快照'}</span></p>
      <p class="muted">代次 ${esc(share.generationId)}<br>可见字段：${fields.length ? fields.join('、') : '仅隐藏后的内容'}<br>单元：${share.mode === 'snapshot' ? (share.unitIds || []).length + ' 个冻结引用' : '随章节结构展开'}</p>
      <a href="${url}" target="_blank">${location.origin}${url}</a>
    </div>`;
  }).join('') + '<button id="new-share" class="btn full">＋ 新建分享版本</button>';
  $('#new-share')?.addEventListener('click', openShareDialog);
}

function renderCopies() {
  $('#copies').innerHTML = Object.values(repo.doc.copies || {}).map((copy) => `
    <div class="copy-row">
      <div class="button-row" style="justify-content:space-between"><strong>${esc(copy.label)}</strong><span class="badge ${copy.kind === 'external' || copy.state === 'unreachable' ? 'danger' : copy.purgeRequired ? 'warn' : ''}">${copy.kind === 'external' ? '不可撤回：无法接触的外部副本' : copy.purgeRequired ? '待清理' : '已受控'}</span></div>
      <span class="muted">已知代次：${copy.knownGenerationId || '-'}${copy.purgedAt ? `；清理于 ${copy.purgedAt}` : ''}</span>
    </div>`).join('');
}

function render() {
  $('#trip-title').value = repo.doc.trip.title;
  $('#trip-purpose').value = repo.doc.trip.purpose;
  renderStatus();
  renderConflicts();
  renderPeople();
  renderChapters();
  renderShares();
  renderCopies();
  renderMediaJobs();
  void renderPhotos();
  $('#node-chapter').innerHTML = sortedByPosition(Object.values(repo.doc.chapters)).map((c) => `<option value="${c.id}">${esc(c.title)}</option>`).join('');
}

repo.addEventListener('change', render);

// ---------- 基础编辑 ----------
$('#trip-title').addEventListener('change', () => repo.mutate(repo.makeOp('setTrip', { patch: { title: $('#trip-title').value } })));
$('#trip-purpose').addEventListener('change', () => repo.mutate(repo.makeOp('setTrip', { patch: { purpose: $('#trip-purpose').value } })));
$('#add-chapter').addEventListener('click', () => {
  const chapters = sortedByPosition(Object.values(repo.doc.chapters));
  const id = uid('ch');
  repo.mutate(repo.makeOp('addChapter', { chapter: {
    id, title: '新章节：这一站发生了什么？', summary: '写清这一站的目的，而不是只放照片。',
    pos: positionBetween(chapters.at(-1)?.pos || null, null),
  }}));
});
$('#add-person').addEventListener('click', () => personDialog.showModal());
$('#person-save').addEventListener('click', (event) => {
  event.preventDefault();
  const name = $('#person-name').value.trim();
  if (!name) return toast('请填写姓名', 'error');
  repo.mutate(repo.makeOp('addPerson', { person: { id: uid('p'), name, contact: $('#person-contact').value.trim() } }));
  personDialog.close();
});
$('#add-node').addEventListener('click', () => nodeDialog.showModal());
$('#node-save').addEventListener('click', (event) => {
  event.preventDefault();
  const id = uid('n');
  const chapterId = $('#node-chapter').value;
  const node = {
    id,
    name: $('#node-name').value.trim() || '未命名地点',
    address: $('#node-address').value.trim(),
    lat: Number($('#node-lat').value),
    lng: Number($('#node-lng').value),
    chapterId,
    status: 'active',
  };
  repo.mutate(repo.makeOp('addNode', { node }));
  const blocks = chapterBlocks(chapterId);
  repo.mutate(repo.makeOp('addBlock', { block: { id: uid('b'), chapterId, type: 'map', nodeId: id, pos: positionBetween(blocks.at(-1)?.pos || null, null) } }));
  nodeDialog.close();
});

document.addEventListener('change', (event) => {
  const el = event.target;
  const chapterTitle = el.dataset.chapterTitle;
  const chapterSummary = el.dataset.chapterSummary;
  const blockText = el.dataset.blockText;
  const caption = el.dataset.photoCaption;
  if (chapterTitle) repo.mutate(repo.makeOp('updateChapter', { chapterId: chapterTitle, patch: { title: el.value } }));
  if (chapterSummary) repo.mutate(repo.makeOp('updateChapter', { chapterId: chapterSummary, patch: { summary: el.value } }));
  if (blockText) repo.mutate(repo.makeOp('updateBlock', { blockId: blockText, patch: { text: el.value } }));
  if (caption) repo.mutate(repo.makeOp('updatePhoto', { photoId: caption, patch: { caption: el.value } }));
});

document.addEventListener('click', async (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  const chapterId = button.dataset.addText || button.dataset.addPhoto || button.dataset.addMap;
  if (button.dataset.addText) addBlock(chapterId, { type: 'text', text: '新段落：写下这张照片为什么重要。', personIds: [] });
  if (button.dataset.addPhoto) await addPhotoBlock(chapterId);
  if (button.dataset.addMap) addMapBlock(chapterId);
  if (button.dataset.removeNodeFromChapter) removeChapterNode(chapterId);
  if (button.dataset.withdraw) await withdrawConsent(button.dataset.withdraw);
  if (button.dataset.resumeJob) await runJob(button.dataset.resumeJob);
});

function addBlock(chapterId, extra) {
  const blocks = chapterBlocks(chapterId);
  repo.mutate(repo.makeOp('addBlock', { block: {
    id: uid('b'), chapterId, pos: positionBetween(blocks.at(-1)?.pos || null, null), ...extra,
  }}));
}

function addMapBlock(chapterId) {
  const node = Object.values(repo.doc.nodes).find((n) => n.chapterId === chapterId && n.status === 'active');
  if (!node) return toast('请先为该章节新增地图节点', 'warn');
  addBlock(chapterId, { type: 'map', nodeId: node.id });
}

function removeChapterNode(chapterId) {
  const block = chapterBlocks(chapterId).find((b) => b.type === 'map');
  const node = block && repo.doc.nodes[block.nodeId];
  if (!node) return toast('这个章节没有地图节点', 'warn');
  repo.mutate(repo.makeOp('removeNode', { nodeId: node.id }));
  toast('节点已标记撤下；发布新代次后，地图块和摘要都不会悬空保留。');
}

async function addPhotoBlock(chapterId) {
  const photoId = uid('ph');
  const node = Object.values(repo.doc.nodes).find((n) => n.chapterId === chapterId && n.status === 'active') || null;
  const title = `现场照片 ${Object.keys(repo.doc.photos).length + 1}`;
  await createOriginalBlob(photoId, title);
  const job = {
    id: `job_${photoId}_initial`,
    photoId,
    kind: 'initial-strip-metadata',
    targetDerivativeId: `${photoId}.v0.safe`,
    state: 'queued',
    progress: 0,
    attempts: 0,
  };
  repo.mutate(repo.makeOp('addPhoto', { photo: {
    id: photoId, name: title, caption: '在这里写与照片稳定绑定的图注。', nodeId: node?.id || null,
    personIds: [], regions: [], exif: node ? { lat: node.lat, lng: node.lng } : {},
    mediaId: `${photoId}.original`, derivativeId: job.targetDerivativeId, mediaVersion: 0, status: 'processing',
  }}));
  addBlock(chapterId, { type: 'photo', photoId });
  repo.enqueueMediaJob(job);
  await runJob(job.id);
}

async function runJob(jobId) {
  try {
    await processMediaJob(repo, jobId, { steps: 7 });
    toast('媒体衍生物已生成并持久化。');
  } catch (error) {
    if (error.code === 'MEDIA_INTERRUPTED') toast(`媒体处理在 ${error.progress}% 中断，检查点已保存，可从同一衍生物继续。`, 'warn');
    else throw error;
  }
}

async function processPendingJobs(personId = null) {
  const jobs = Object.values(repo.doc.mediaJobs || {})
    .filter((job) => (!personId || job.personId === personId) && (job.state === 'queued' || job.state === 'interrupted' || (job.state === 'processing' && job.progress < 100)));
  for (const job of jobs) await runJob(job.id);
}

async function remoteWithdrawConsent(personId) {
  const generationId = `gen_withdraw_${Date.now().toString(36)}`;
  if (repo.apiMode) {
    const response = await fetch(`/api/consents/${personId}/withdraw`, { method: 'POST' });
    if (!response.ok) throw new Error('后台撤回失败');
    return (await response.json()).generationId;
  }
  const state = repo.server;
  const { withdrawConsent: withdraw } = await import('./kernel.js');
  state.doc = withdraw(state.doc, personId, generationId, new Date().toISOString());
  state.rev = state.doc.rev;
  repo.server = state;
  return generationId;
}

async function withdrawConsent(personId) {
  const generationId = `gen_${Date.now().toString(36)}`;
  const impact = analyzeConsentImpact(repo.doc, personId);
  const op = repo.makeOp('withdrawConsent', { personId, generationId });
  repo.mutate(op);
  toast(`许可已撤回：${impact.photoIds.length} 张图、${impact.blockIds.length} 段文字/引用、${impact.snapshotIds.length} 个快照与索引正在重新生成。`);
  if (repo.online) {
    const result = await repo.sync({ purge: true });
    result.conflicts.forEach((c) => toast(c.message, 'warn'));
  }
  await processPendingJobs(personId);
}

// ---------- 拖放重排：分数位位置，实体引用不动 ----------
document.addEventListener('dragstart', (event) => {
  const chapter = event.target.dataset.dragChapter;
  const block = event.target.dataset.dragBlock;
  activeDragId = chapter || block;
  event.dataTransfer.setData('text/plain', activeDragId);
  $$('[data-chapter], [data-block]').forEach((el) => {
    if (el.dataset.chapter === chapter || el.dataset.block === block) el.classList.add('dragging');
  });
});
document.addEventListener('dragover', (event) => {
  const card = event.target.closest('[data-chapter],[data-block]');
  if (card) { event.preventDefault(); card.classList.add('drop-target'); }
});
document.addEventListener('dragleave', (event) => event.target.closest?.('[data-chapter],[data-block]')?.classList.remove('drop-target'));
document.addEventListener('drop', (event) => {
  event.preventDefault();
  const chapterCard = event.target.closest('[data-chapter]');
  const blockCard = event.target.closest('[data-block]');
  $$('.drop-target').forEach((el) => el.classList.remove('drop-target'));
  $$('.dragging').forEach((el) => el.classList.remove('dragging'));
  if (!activeDragId) return;
  if (activeDragId.startsWith('ch_') && chapterCard) reorderChapter(activeDragId, chapterCard.dataset.chapter);
  if (activeDragId.startsWith('b_') && blockCard) reorderBlock(activeDragId, blockCard.dataset.block, chapterCard?.dataset.chapter);
  activeDragId = null;
});
document.addEventListener('dragend', () => {
  activeDragId = null;
  $$('.drop-target,.dragging').forEach((el) => el.classList.remove('drop-target', 'dragging'));
});

function reorderChapter(dragId, targetId) {
  if (dragId === targetId) return;
  const items = sortedByPosition(Object.values(repo.doc.chapters));
  const targetIndex = items.findIndex((x) => x.id === targetId);
  const pos = positionBetween(items[targetIndex - 1]?.pos || null, items[targetIndex]?.pos || null);
  repo.mutate(repo.makeOp('moveChapter', { chapterId: dragId, pos }));
}
function reorderBlock(dragId, targetId, chapterId) {
  const drag = repo.doc.blocks[dragId];
  const targetChapter = chapterId || repo.doc.blocks[targetId].chapterId;
  const scopeChapter = drag.chapterId === targetChapter ? targetChapter : targetChapter;
  const items = chapterBlocks(scopeChapter);
  const targetIndex = items.findIndex((x) => x.id === targetId);
  const pos = positionBetween(items[targetIndex - 1]?.pos || null, items[targetIndex]?.pos || null);
  repo.mutate(repo.makeOp('moveBlock', { blockId: dragId, chapterId: scopeChapter, pos }));
}

// ---------- 在线状态、同步与发布 ----------
$('#toggle-online').addEventListener('click', async () => {
  repo.online = !repo.online;
  if (repo.online) {
    const result = await repo.sync({ purge: true });
    toast(result.conflicts.length ? `重连合并完成：${result.conflicts.length} 个冲突已解释处理。` : '重连成功，离线操作已上传，受控缓存已清理。');
    await processPendingJobs();
  } else toast('已离线：编辑仍会保存在本机，稍后用操作日志合并。', 'warn');
  render();
});
$('#sync').addEventListener('click', async () => {
  const result = await repo.sync({ purge: false });
  toast(result.conflicts.length ? `同步完成，有 ${result.conflicts.length} 个合并结果需要查看。` : '同步完成。');
});
$('#purge').addEventListener('click', async () => {
  await repo.purgeStaleContent();
  toast('受控客户端中的旧代次缓存、失效衍生物与离线内容已清理；外部副本仍列为不可撤回。');
});
$('#publish').addEventListener('click', () => {
  const generationId = `gen_${Date.now().toString(36)}`;
  repo.mutate(repo.makeOp('publish', { generationId, reason: 'manual-publish' }));
  if (repo.online) void repo.sync();
  toast(`已发布新代次 ${generationId}，路线与章节快照来自同一版本。`);
});
$('#open-share').addEventListener('click', () => {
  const share = Object.values(repo.doc.shares || {}).find((item) => item.status === 'active');
  if (!share) return toast('还没有分享版本，请先生成。', 'warn');
  window.open(`/travel/share.html?share=${encodeURIComponent(share.id)}&g=${encodeURIComponent(repo.doc.activeGenerationId)}`, '_blank');
});
$('#reset-demo').addEventListener('click', () => { repo.reset(); toast('演示数据已重置。'); });

// ---------- 分享版本 ----------
function openShareDialog() {
  const chapters = sortedByPosition(Object.values(repo.doc.chapters));
  $('#share-label').value = '';
  $('#share-chapters').innerHTML = chapters.map((c) => `<label><input type="checkbox" name="share-chapter" value="${c.id}" checked /> ${esc(c.title)}</label>`).join('');
  $('#share-units').innerHTML = chapters.map((c) => {
    return `<fieldset style="grid-column:1/-1"><legend>${esc(c.title)}</legend>${chapterBlocks(c.id).map((b) => {
      const label = b.type === 'photo' ? repo.doc.photos[b.photoId]?.name : b.type === 'map' ? repo.doc.nodes[b.nodeId]?.name : (b.text || '段落').slice(0, 28);
      return `<label><input type="checkbox" name="share-unit" value="${b.id}" checked /> ${b.type} · ${esc(label)}</label>`;
    }).join('')}</fieldset>`;
  }).join('');
  dialog.showModal();
}
$('#create-share').addEventListener('click', async (event) => {
  event.preventDefault();
  const share = {
    id: uid('sh'),
    label: $('#share-label').value.trim() || `分享 ${new Date().toLocaleString('zh-CN')}`,
    mode: new FormData(dialog.querySelector('form')).get('mode'),
    chapterIds: $$('[name="share-chapter"]:checked').map((x) => x.value),
    unitIds: $$('[name="share-unit"]:checked').map((x) => x.value),
    allow: { names: $('#allow-name').checked, contacts: $('#allow-contact').checked, preciseLocation: $('#allow-location').checked },
    status: 'active',
    createdAt: now(),
  };
  if (!share.chapterIds.length) return toast('至少选择一个章节', 'error');
  const generationId = repo.doc.activeGenerationId || `gen_${Date.now().toString(36)}`;
  repo.mutate(repo.makeOp('addShare', { share }));
  repo.mutate(repo.makeOp('publish', { generationId, reason: `share:${share.id}` }));
  if (repo.online) await repo.sync();
  dialog.close();
  toast('分享版本已生成；白名单快照中的字段和单元集合不可被后续编辑隐式扩大。');
});

// ---------- 四个验收场景 ----------
$('#demo-withdraw-offline').addEventListener('click', async () => {
  repo.online = false;
  render();
  const current = repo.doc.blocks.b_ridge_text?.text || '旅行记录';
  repo.mutate(repo.makeOp('updateBlock', { blockId: 'b_ridge_text', patch: {
    text: `${current}\n离线补记：林岚的邮箱 lan@example.com，电话 +86 138-0000-1234。`,
  }}));
  const generationId = await remoteWithdrawConsent('p_lan');
  toast(`已模拟：后台先进入新代次 ${generationId}，本机离线稿仍含旧姓名和联系方式。点击“恢复联网”查看服务端拒绝与安全改写。`, 'warn');
});

$('#demo-two-tabs').addEventListener('click', async () => {
  // 用独立 clientId 的持久仓库代表第二个标签页；两者共享模拟后台，操作日志走同一 API。
  const tabB = new Repository('simulated-tab-b');
  const target = positionBetween(null, repo.doc.chapters.ch_harbor.pos);
  tabB.mutate(tabB.makeOp('moveChapter', { chapterId: 'ch_ridge', pos: target }));
  await tabB.sync();
  repo.mutate(repo.makeOp('moveChapter', { chapterId: 'ch_harbor', pos: target }));
  const result = await repo.sync();
  toast(result.conflicts.some((c) => c.code === 'CONCURRENT_REORDER') ? '两个标签页把章节移到同一位置：已用相邻分数位合并，图注仍绑定照片。' : '已模拟跨标签页重排。', 'warn');
});

$('#demo-media-interrupt').addEventListener('click', async () => {
  repo.interruptMedia();
  const job = Object.values(repo.doc.mediaJobs).find((j) => j.state !== 'done') || Object.values(repo.doc.mediaJobs)[0];
  if (!job) return toast('请先新增一张照片生成媒体任务。', 'warn');
  await runJob(job.id);
});

$('#demo-old-link').addEventListener('click', () => {
  const oldGen = 'gen_cached_old';
  window.open(`/travel/share.html?share=sh_family&g=${oldGen}&stale=1`, '_blank');
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/travel/sw.js').catch((error) => console.warn('SW registration failed', error));
}
await repo.ready;
// 预置示例照片的 EXIF 剥离任务，便于直接验收“中断—检查点—继续”。
if (repo.doc.photos.ph_harbor && !repo.doc.mediaJobs.job_ph_harbor_initial) {
  repo.enqueueMediaJob({
    id: 'job_ph_harbor_initial',
    photoId: 'ph_harbor',
    kind: 'initial-strip-metadata',
    targetDerivativeId: 'ph_harbor.v0.safe',
    state: 'queued',
    progress: 0,
    attempts: 0,
  });
  if (repo.apiMode && repo.online) await repo.sync();
}
render();
