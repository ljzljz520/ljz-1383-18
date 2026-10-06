// index.js — 旅行影集叙事编辑器 后台 API
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const merge = require('./merge');
const snapshot = require('./snapshot');
const consent = require('./consent');
const media = require('./media');

const uid = () => crypto.randomUUID();
const now = () => Date.now();
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const ok = (res, data) => res.json({ ok: true, ...data });
const bad = (res, code, msg) => res.status(code).json({ ok: false, error: msg });

// 统一通过 op 日志应用结构变更（网页直改等价于 base=当前head 的“离线”提交）
function applyOwnerOp(albumId, op) {
  const head = db.get('SELECT head_version h FROM albums WHERE id=?', [albumId]).h || 0;
  return merge.applyOps(albumId, 'owner-web', head, [{ lamport: now(), ...op }]);
}

// ---------- Album ----------
app.post('/api/albums', (req, res) => {
  const id = uid();
  db.tx(() => db.run('INSERT INTO albums(id,title,created_at,head_version,generation) VALUES(?,?,?,0,0)', [id, req.body.title || '未命名影集', now()]));
  ok(res, { id });
});

app.get('/api/albums/:id', (req, res) => {
  const a = db.get('SELECT * FROM albums WHERE id=?', [req.params.id]);
  if (!a) return bad(res, 404, 'album not found');
  ok(res, {
    album: a,
    chapters: db.all('SELECT * FROM chapters WHERE album_id=? AND deleted=0 ORDER BY order_key', [a.id]),
    nodes: db.all('SELECT * FROM nodes WHERE album_id=? AND deleted=0 ORDER BY order_key', [a.id]),
    media: db.all('SELECT * FROM media WHERE album_id=? AND deleted=0', [a.id]),
    companions: db.all('SELECT * FROM companions WHERE album_id=?', [a.id]),
    consents: db.all('SELECT * FROM consents WHERE album_id=?', [a.id]),
    shares: db.all('SELECT token,policy,allowed_fields,revoked,snapshot_id FROM share_links WHERE album_id=?', [a.id]),
  });
});

// ---------- Chapters（稳定引用：拖动只改 order_key，引用随内容走） ----------
app.post('/api/albums/:id/chapters', (req, res) => {
  const id = uid();
  const r = applyOwnerOp(req.params.id, { type: 'chapter.create', chapter: { id, title: req.body.title || '', body: req.body.body || '' } });
  ok(res, { id, merge: r });
});

app.patch('/api/chapters/:id', (req, res) => {
  const ch = db.get('SELECT * FROM chapters WHERE id=?', [req.params.id]);
  if (!ch) return bad(res, 404, 'chapter not found');
  const fields = {};
  if (req.body.title != null) fields.title = req.body.title;
  if (req.body.body != null) fields.body = req.body.body;
  const r = applyOwnerOp(ch.album_id, { type: 'chapter.update', chapter_id: ch.id, fields });
  ok(res, { merge: r });
});

app.post('/api/albums/:id/reorder', (req, res) => {
  const { chapter_id, before_id, after_id } = req.body;
  const r = applyOwnerOp(req.params.id, { type: 'chapter.reorder', chapter_id, before_id: before_id || null, after_id: after_id || null });
  ok(res, { merge: r });
});

app.delete('/api/chapters/:id', (req, res) => {
  const ch = db.get('SELECT * FROM chapters WHERE id=?', [req.params.id]);
  if (!ch) return bad(res, 404, 'not found');
  const r = applyOwnerOp(ch.album_id, { type: 'chapter.delete', chapter_id: ch.id });
  ok(res, { merge: r });
});

// ---------- Nodes（地图节点） ----------
app.post('/api/albums/:id/nodes', (req, res) => {
  const id = uid();
  const { label, lat, lng } = req.body;
  const r = applyOwnerOp(req.params.id, { type: 'node.create', node: { id, label, lat, lng } });
  ok(res, { id, merge: r });
});

app.post('/api/albums/:id/nodes/:nid/unpublish', (req, res) => {
  snapshot.unpublishNode(req.params.id, req.params.nid);
  // 撤下节点 → 所有分享链接生成新代次，旧代次不再可服务
  const links = db.all('SELECT * FROM share_links WHERE album_id=? AND revoked=0', [req.params.id]);
  for (const link of links) {
    const snap = snapshot.generateSnapshot(req.params.id, link.policy, JSON.parse(link.allowed_fields), link.token);
    db.run('UPDATE share_links SET snapshot_id=? WHERE token=?', [snap.id, link.token]);
  }
  db.persist();
  ok(res, { unpublished: req.params.nid });
});

// ---------- Media（异步处理 + 中断恢复） ----------
app.post('/api/albums/:id/media', (req, res) => {
  const id = uid();
  db.tx(() => {
    db.run('INSERT INTO media(id,album_id,filename,blob_path,caption,status,version,updated_at,deleted) VALUES(?,?,?,?,?,?,1,?,0)',
      [id, req.params.id, req.body.filename || 'photo.jpg', `/blob/${id}`, req.body.caption || '', 'processing', now()]);
    media.enqueueMedia(id);
  });
  ok(res, { id, status: 'processing' });
});

app.post('/api/media/process', (req, res) => {
  const r = media.processNextJob();
  ok(res, { result: r });
});

// ---------- Companions & Consent ----------
app.post('/api/albums/:id/companions', (req, res) => {
  const id = uid();
  db.tx(() => {
    db.run('INSERT INTO companions(id,album_id,name,contact,created_at) VALUES(?,?,?,?,?)', [id, req.params.id, req.body.name || '', req.body.contact || '', now()]);
    for (const scope of snapshot.SCOPES) consent.grantConsent(id, req.params.id, scope); // 默认授予，可撤
  });
  ok(res, { id });
});

app.post('/api/companions/:id/revoke', (req, res) => {
  const comp = db.get('SELECT * FROM companions WHERE id=?', [req.params.id]);
  if (!comp) return bad(res, 404, 'companion not found');
  const report = consent.revokeConsent(comp.id, comp.album_id, req.body.scope);
  ok(res, { report });
});

app.post('/api/companions/:id/grant', (req, res) => {
  const comp = db.get('SELECT * FROM companions WHERE id=?', [req.params.id]);
  if (!comp) return bad(res, 404, 'companion not found');
  consent.grantConsent(comp.id, comp.album_id, req.body.scope);
  ok(res, {});
});

// ---------- Share（全章共享 vs 白名单快照） ----------
app.post('/api/albums/:id/share', (req, res) => {
  const albumId = req.params.id;
  const policy = req.body.policy || 'whitelist'; // full | whitelist
  const allowed = req.body.allowed_fields || { name: true, contact: false, exact_location: false };
  const token = crypto.randomBytes(8).toString('hex');
  db.tx(() => {
    const snap = snapshot.generateSnapshot(albumId, policy, policy === 'full' ? { name: true, contact: true, exact_location: true } : allowed, token);
    db.run('INSERT INTO share_links(token,album_id,policy,allowed_fields,snapshot_id,created_at,revoked) VALUES(?,?,?,?,?,?,0)',
      [token, albumId, policy, JSON.stringify(allowed), snap.id, now()]);
    // 如实登记一份不可控外部副本（链接可能被缓存/下载/转发）
    const comp = db.get('SELECT id FROM companions WHERE album_id=? LIMIT 1', [albumId]);
    if (comp) db.run('INSERT INTO external_copies(id,album_id,companion_id,kind,description,controllable,created_at) VALUES(?,?,?,?,?,0,?)',
      [uid(), albumId, comp.id, 'shared_link', `分享链接 /share/${token} 可能被浏览器/代理缓存或被接收方下载、截图、转发`, now()]);
  });
  ok(res, { token, url: `/share/${token}` });
});

// ---------- 离线同步 ----------
app.post('/api/albums/:id/sync', (req, res) => {
  const { client_id, base_version, ops } = req.body;
  const r = merge.applyOps(req.params.id, client_id || 'anon', base_version || 0, ops || []);
  ok(res, r);
});

app.get('/api/albums/:id/tombstones', (req, res) => {
  ok(res, { tombstones: merge.buildTombstones(req.params.id), head_version: db.get('SELECT head_version h FROM albums WHERE id=?', [req.params.id]).h });
});

// ---------- 访客视图（同一代次的章节+路线） ----------
function renderShareHTML(snap, token) {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const chapters = snap.chapters.map(c => `<section class="ch" data-id="${c.id}"><h2>${esc(c.title)}</h2><p>${esc(c.body)}</p></section>`).join('\n');
  const nodes = snap.nodes.map(n => `<li data-id="${n.id}">${esc(n.label)} — ${n.lat != null ? `精确(${n.lat},${n.lng})` : `大致(${esc(n.coarse)})`}</li>`).join('\n');
  const comps = snap.companions.map(c => `<li>${esc(c.name)}${c.contact ? ` · ${esc(c.contact)}` : ''}</li>`).join('\n');
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>旅行影集</title>
<meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate">
<style>body{font-family:system-ui;max-width:720px;margin:2rem auto;padding:0 1rem;line-height:1.7}section.ch{border-top:1px solid #ddd;padding:1rem 0}.gen{color:#888;font-size:.85rem}</style>
</head><body>
<div class="gen">发布代次 generation ${snap.generation} · 策略 ${snap.policy}</div>
<h1>旅行影集</h1>
<h3>路线</h3><ul>${nodes}</ul>
<h3>同行人</h3><ul>${comps}</ul>
${chapters}
</body></html>`;
}

app.get('/share/:token', (req, res) => {
  const v = snapshot.getShareView(req.params.token);
  if (v.error) return res.status(v.error).send(v.error === 410 ? '该分享内容已更新，此代次不再可用' : '分享不存在或已撤销');
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.send(renderShareHTML(v.snapshot, req.params.token));
});

// 指定代次的旧链接：若非当前代次 → 410，避免缓存的旧内容暴露
app.get('/share/:token/gen/:g', (req, res) => {
  const link = db.get('SELECT * FROM share_links WHERE token=?', [req.params.token]);
  if (!link || link.revoked) return res.status(404).send('not found');
  const cur = db.get('SELECT * FROM snapshots WHERE id=?', [link.snapshot_id]);
  const want = db.get('SELECT * FROM snapshots WHERE share_token=? AND generation=?', [req.params.token, Number(req.params.g)]);
  if (!want) return res.status(404).send('no such generation');
  if (want.status !== 'current' || want.id !== cur.id) {
    return res.status(410).send('该代次已被取代（内容已更新或撤回），请访问最新链接');
  }
  res.set('Cache-Control', 'no-cache');
  res.send(renderShareHTML(JSON.parse(want.payload), req.params.token));
});

// 验证用：查看派生索引（确认无悬空摘要）
app.get('/api/albums/:id/derivatives', (req, res) => {
  ok(res, { derivatives: db.all('SELECT kind,ref_type,ref_id,generation,status,payload FROM derivatives WHERE album_id=?', [req.params.id]) });
});

async function start(port) {
  await db.init();
  const recovered = media.recoverJobs(); // 崩溃恢复
  if (recovered) console.log(`[recover] ${recovered} 个中断任务已重新排队`);
  const server = app.listen(port || 3000, () => console.log(`travel-album listening on ${port || 3000}`));
  return server;
}

if (require.main === module) start();
module.exports = { app, start };
