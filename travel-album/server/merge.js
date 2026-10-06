// merge.js — 离线操作的三向合并。所有结构变更（含网页直改）都统一走 op 日志。
const db = require('./db');
const crypto = require('crypto');
const uid = () => crypto.randomUUID();
const now = () => Date.now();

function keyBetween(a, b) {
  if (a == null && b == null) return 1.0;
  if (a == null) return b - 1.0;
  if (b == null) return a + 1.0;
  return (a + b) / 2;
}

// 当前生效的许可：scope -> Set(companion_id) of revoked
function revokedMap(albumId) {
  const rows = db.all("SELECT companion_id, scope FROM consents WHERE album_id=? AND status='revoked'", [albumId]);
  const m = {};
  for (const r of rows) { (m[r.scope] = m[r.scope] || new Set()).add(r.companion_id); }
  return m;
}

// 净化文本：若离线稿包含已撤回许可的同行人明文姓名/联系方式，替换为占位
function sanitizeText(text, albumId, purged, clientId) {
  if (!text) return { text, changed: false };
  const revoked = revokedMap(albumId);
  let out = text, changed = false;
  const comps = db.all('SELECT * FROM companions WHERE album_id=?', [albumId]);
  for (const c of comps) {
    if (revoked.name && revoked.name.has(c.id) && c.name && out.includes(c.name)) {
      out = out.split(c.name).join('一位同行人'); changed = true;
      purged.push({ field: 'name', companion_id: c.id, value: c.name, reason: '同行人已撤回姓名许可，离线稿中的明文已被移除' });
    }
    if (revoked.contact && revoked.contact.has(c.id) && c.contact && out.includes(c.contact)) {
      out = out.split(c.contact).join('[联系方式已隐藏]'); changed = true;
      purged.push({ field: 'contact', companion_id: c.id, value: c.contact, reason: '同行人已撤回联系方式许可，离线稿中的明文已被移除' });
    }
  }
  return { text: out, changed };
}

// 自 baseSeq 以来服务端已应用的变更索引：entityKey -> {field -> {lamport, client_id}}
function serverChangesSince(albumId, baseSeq) {
  const rows = db.all('SELECT * FROM ops WHERE album_id=? AND seq>? AND status IN (\'applied\',\'conflict\')', [albumId, baseSeq]);
  const idx = { chapterFields: {}, chapterOrder: {}, chapterDeleted: new Set(), nodeFields: {}, nodeDeleted: new Set() };
  for (const r of rows) {
    const p = JSON.parse(r.payload);
    if (r.op_type === 'chapter.update') {
      const o = (idx.chapterFields[p.chapter_id] = idx.chapterFields[p.chapter_id] || {});
      for (const f of Object.keys(p.fields)) {
        if (!o[f] || r.lamport > o[f].lamport) o[f] = { lamport: r.lamport, client_id: r.client_id };
      }
    } else if (r.op_type === 'chapter.reorder') {
      const cur = idx.chapterOrder[p.chapter_id];
      if (!cur || r.lamport > cur.lamport) idx.chapterOrder[p.chapter_id] = { lamport: r.lamport, client_id: r.client_id };
    } else if (r.op_type === 'chapter.delete') {
      idx.chapterDeleted.add(p.chapter_id);
    } else if (r.op_type === 'node.update') {
      const o = (idx.nodeFields[p.node_id] = idx.nodeFields[p.node_id] || {});
      for (const f of Object.keys(p.fields)) {
        if (!o[f] || r.lamport > o[f].lamport) o[f] = { lamport: r.lamport, client_id: r.client_id };
      }
    } else if (r.op_type === 'node.delete') {
      idx.nodeDeleted.add(p.node_id);
    }
  }
  return idx;
}

function recordOp(albumId, clientId, baseVersion, type, payload, lamport, status, note) {
  db.run('INSERT INTO ops(album_id,client_id,base_version,op_type,payload,lamport,applied_at,status,conflict_note) VALUES(?,?,?,?,?,?,?,?,?)',
    [albumId, clientId, baseVersion, type, JSON.stringify(payload), lamport || now(), now(), status, note || null]);
  return db.get('SELECT MAX(seq) AS s FROM ops').s;
}

// 应用一批离线 op。返回可理解的合并报告。
function applyOps(albumId, clientId, baseVersion, ops) {
  return db.tx(() => {
    const album = db.get('SELECT * FROM albums WHERE id=?', [albumId]);
    const headSeq = db.get('SELECT MAX(seq) AS s FROM ops WHERE album_id=?', [albumId]).s || 0;
    const changes = serverChangesSince(albumId, baseVersion);
    const purged = [];
    const results = [];
    let lastSeq = headSeq;

    const bumpHead = (seq) => { db.run('UPDATE albums SET head_version=? WHERE id=?', [seq, albumId]); lastSeq = seq; };

    for (const op of ops) {
      const lam = op.lamport || now();
      let status = 'applied', note = null;

      if (op.type === 'chapter.create') {
        const ch = op.chapter;
        const s = sanitizeText(ch.body || '', albumId, purged, clientId);
        const st = sanitizeText(ch.title || '', albumId, purged, clientId);
        db.run('INSERT INTO chapters(id,album_id,title,body,order_key,version,updated_at,deleted) VALUES(?,?,?,?,?,1,?,0)',
          [ch.id || uid(), albumId, st.text, s.text, ch.order_key != null ? ch.order_key : keyBetween(maxOrder('chapters', albumId), null), now()]);
        extractRefs(ch.id, s.text, albumId);
        if (s.changed || st.changed) { status = 'purged'; note = '离线新建的章节含有已撤回许可的信息，已脱敏后保存'; }

      } else if (op.type === 'chapter.update') {
        const cid = op.chapter_id;
        if (changes.chapterDeleted.has(cid)) {
          status = 'rejected'; note = '该章节已在另一处被删除，你的离线修改未应用（删除优先）';
        } else {
          const appliedFields = [], droppedFields = [];
          const fields = {};
          for (const [f, v] of Object.entries(op.fields)) {
            const sv = changes.chapterFields[cid] && changes.chapterFields[cid][f];
            if (sv && sv.lamport > lam) {
              droppedFields.push(f); // 服务端更新，保留服务端
            } else {
              const s = sanitizeText(v, albumId, purged, clientId);
              fields[f] = s.text;
              if (s.changed) { status = 'purged'; }
              appliedFields.push(f + (sv ? '(覆盖并发修改)' : ''));
            }
          }
          if (Object.keys(fields).length) {
            const sets = Object.keys(fields).map(f => `${f}=?`).join(',');
            db.run(`UPDATE chapters SET ${sets}, version=version+1, updated_at=? WHERE id=?`, [...Object.values(fields), now(), cid]);
            if (fields.body != null) extractRefs(cid, fields.body, albumId);
          }
          if (droppedFields.length) {
            status = status === 'applied' ? 'conflict' : status;
            note = `字段 ${droppedFields.join(',')} 在另一设备上有更新的修改，已保留较新版本；你的其余修改(${appliedFields.join(',') || '无'})已合并`;
          } else if (appliedFields.some(f => f.includes('覆盖'))) {
            status = status === 'applied' ? 'conflict' : status;
            note = `你的离线修改覆盖了另一设备对字段 ${appliedFields.join(',')} 的并发修改`;
          }
        }

      } else if (op.type === 'chapter.reorder') {
        const cid = op.chapter_id;
        if (changes.chapterDeleted.has(cid)) {
          status = 'rejected'; note = '该章节已被删除，离线重排未应用';
        } else {
          const sv = changes.chapterOrder[cid];
          if (sv && sv.lamport > lam) {
            status = 'conflict';
            note = '该章节在另一标签页/设备上被更新地移动过，已保留较新的位置（你的重排未生效）';
          } else {
            const before = op.before_id ? db.get('SELECT order_key k FROM chapters WHERE id=?', [op.before_id]) : null;
            const after = op.after_id ? db.get('SELECT order_key k FROM chapters WHERE id=?', [op.after_id]) : null;
            const k = keyBetween(before && before.k, after && after.k);
            db.run('UPDATE chapters SET order_key=?, version=version+1, updated_at=? WHERE id=?', [k, now(), cid]);
            if (sv) { status = 'conflict'; note = '两个标签页同时重排了该章节，已采用你这次较新的位置'; }
          }
        }

      } else if (op.type === 'chapter.delete') {
        db.run('UPDATE chapters SET deleted=1, updated_at=? WHERE id=?', [now(), op.chapter_id]);
        db.run('DELETE FROM refs WHERE chapter_id=?', [op.chapter_id]);

      } else if (op.type === 'node.create') {
        const n = op.node;
        db.run('INSERT INTO nodes(id,album_id,label,lat,lng,geohash5,order_key,version,published,updated_at,deleted) VALUES(?,?,?,?,?,?,?,1,1,?,0)',
          [n.id || uid(), albumId, n.label, n.lat, n.lng, coarse(n.lat, n.lng), n.order_key != null ? n.order_key : keyBetween(maxOrder('nodes', albumId), null), now()]);

      } else if (op.type === 'node.update') {
        const nid = op.node_id;
        if (changes.nodeDeleted.has(nid)) { status = 'rejected'; note = '该地点已被删除，离线修改未应用'; }
        else {
          const sets = [], vals = [];
          for (const [f, v] of Object.entries(op.fields)) {
            const sv = changes.nodeFields[nid] && changes.nodeFields[nid][f];
            if (sv && sv.lamport > lam) { status = 'conflict'; note = `地点字段 ${f} 已保留较新版本`; continue; }
            sets.push(`${f}=?`); vals.push(v);
            if (f === 'lat' || f === 'lng') { /* 坐标变更后重算粗粒度 */ }
          }
          if (sets.length) {
            db.run(`UPDATE nodes SET ${sets.join(',')}, version=version+1, updated_at=? WHERE id=?`, [...vals, now(), nid]);
            const nn = db.get('SELECT lat,lng FROM nodes WHERE id=?', [nid]);
            db.run('UPDATE nodes SET geohash5=? WHERE id=?', [coarse(nn.lat, nn.lng), nid]);
          }
        }

      } else if (op.type === 'node.delete') {
        db.run('UPDATE nodes SET deleted=1, updated_at=? WHERE id=?', [now(), op.node_id]);

      } else if (op.type === 'media.caption') {
        const s = sanitizeText(op.caption, albumId, purged, clientId);
        db.run('UPDATE media SET caption=?, version=version+1, updated_at=? WHERE id=?', [s.text, now(), op.media_id]);
        if (s.changed) { status = 'purged'; note = '图注含已撤回许可的信息，已脱敏'; }

      } else {
        status = 'rejected'; note = `未知操作类型 ${op.type}`;
      }

      const seq = recordOp(albumId, clientId, baseVersion, op.type, op, lam, status, note);
      bumpHead(seq);
      results.push({ op: op.type, status, note });
    }

    // 收集 tombstones：客户端需清理的失效内容（已删章节/节点/媒体 + 已撤许可的同行人字段）
    const tombstones = buildTombstones(albumId);
    const head = db.get('SELECT head_version h FROM albums WHERE id=?', [albumId]).h;
    return { head_version: head, results, purged, tombstones };
  });
}

function maxOrder(table, albumId) {
  const r = db.get(`SELECT MAX(order_key) k FROM ${table} WHERE album_id=? AND deleted=0`, [albumId]);
  return r && r.k != null ? r.k : null;
}

function coarse(lat, lng) {
  if (lat == null || lng == null) return null;
  return `${Number(lat).toFixed(1)},${Number(lng).toFixed(1)}`; // 城市级（约10km）
}

// 从正文中抽取稳定引用，重建 refs（引用随内容走，与章节顺序无关）
function extractRefs(chapterId, body, albumId) {
  if (!chapterId) return;
  db.run('DELETE FROM refs WHERE chapter_id=?', [chapterId]);
  if (!body) return;
  const re = /\[\[(media|node|companion):([^\]]+)\]\]/g;
  let m, i = 0;
  while ((m = re.exec(body))) {
    db.run('INSERT INTO refs(id,chapter_id,ref_type,ref_id,anchor,created_at) VALUES(?,?,?,?,?,?)',
      [uid(), chapterId, m[1], m[2], `a${i++}`, now()]);
  }
}

function buildTombstones(albumId) {
  return {
    chapters: db.all('SELECT id FROM chapters WHERE album_id=? AND deleted=1', [albumId]).map(r => r.id),
    nodes: db.all('SELECT id FROM nodes WHERE album_id=? AND (deleted=1 OR published=0)', [albumId]).map(r => r.id),
    media: db.all('SELECT id FROM media WHERE album_id=? AND deleted=1', [albumId]).map(r => r.id),
    revoked_consents: db.all("SELECT companion_id, scope FROM consents WHERE album_id=? AND status='revoked'", [albumId]),
  };
}

module.exports = { applyOps, keyBetween, coarse, extractRefs, buildTombstones, sanitizeText };
