// snapshot.js — 白名单快照 + 发布代次。访客看到的章节与路线始终来自同一代次。
const db = require('./db');
const crypto = require('crypto');

const SCOPES = ['name', 'contact', 'exact_location'];
const uid = () => crypto.randomUUID();
const now = () => Date.now();

// 计算某 companion 各 scope 的最终可见性：需 (许可granted) 且 (分享白名单允许)
function visibilityFor(companionId, consents, allowedFields) {
  const v = {};
  for (const s of SCOPES) {
    const c = consents.find(x => x.companion_id === companionId && x.scope === s);
    const consentOk = c ? c.status === 'granted' : false; // 默认不授予
    const allowOk = allowedFields[s] !== false;           // 白名单默认允许，显式false才关
    v[s] = consentOk && allowOk;
  }
  return v;
}

// 正文中 [[companion:ID]] / [[media:ID]] / [[node:ID]] 按可见性改写为安全文本
function renderBodySafe(body, ctx) {
  return body.replace(/\[\[(media|node|companion):([^\]]+)\]\]/g, (m, type, id) => {
    if (type === 'companion') {
      const vis = ctx.vis[id];
      if (!vis) return '一位同行人';
      return vis.name ? (ctx.names[id] || '一位同行人') : '一位同行人';
    }
    if (type === 'node') {
      const n = ctx.nodes[id];
      if (!n) return ''; // 已撤下/删除：不留悬空引用
      return n.label;
    }
    if (type === 'media') {
      const md = ctx.media[id];
      if (!md) return ''; // 未就绪/删除：占位由前端渲染，不在快照里泄露
      return `〔照片:${md.caption || md.filename}〕`;
    }
    return m;
  });
}

// 生成一个不可变快照（新代次）。allowedFields: {name,contact,exact_location}
function generateSnapshot(albumId, policy, allowedFields, shareToken) {
  return db.tx(() => {
    const album = db.get('SELECT * FROM albums WHERE id=?', [albumId]);
    const generation = album.generation + 1;
    db.run('UPDATE albums SET generation=? WHERE id=?', [generation, albumId]);

    const chapters = db.all('SELECT * FROM chapters WHERE album_id=? AND deleted=0 ORDER BY order_key', [albumId]);
    const nodes = db.all('SELECT * FROM nodes WHERE album_id=? AND deleted=0 AND published=1 ORDER BY order_key', [albumId]);
    const media = db.all("SELECT * FROM media WHERE album_id=? AND deleted=0 AND status='ready'", [albumId]);
    const companions = db.all('SELECT * FROM companions WHERE album_id=?', [albumId]);
    const consents = db.all('SELECT * FROM consents WHERE album_id=?', [albumId]);

    const ctx = { vis: {}, names: {}, nodes: {}, media: {} };
    for (const n of nodes) ctx.nodes[n.id] = n;
    for (const m of media) ctx.media[m.id] = m;

    // 同行人按可见性脱敏
    const safeCompanions = companions.map(c => {
      const vis = visibilityFor(c.id, consents, allowedFields);
      ctx.vis[c.id] = vis;
      ctx.names[c.id] = c.name;
      return {
        id: c.id,
        name: vis.name ? c.name : '一位同行人',
        contact: vis.contact ? c.contact : undefined, // 不可见即省略字段
      };
    });

    // 节点按位置可见性降级
    const anyExactRevoked = (nid) => {
      // 精确位置是相册级 scope：任一同行人 exact_location 被撤则该相册精确坐标不可公开
      return consents.some(c => c.scope === 'exact_location' && c.status === 'revoked');
    };
    const exactAllowed = allowedFields.exact_location !== false && !anyExactRevoked();
    const safeNodes = nodes.map(n => ({
      id: n.id, label: n.label,
      lat: exactAllowed ? n.lat : undefined,
      lng: exactAllowed ? n.lng : undefined,
      coarse: n.geohash5, // 始终提供城市级
    }));

    const safeChapters = chapters.map(ch => ({
      id: ch.id, title: ch.title,
      body: renderBodySafe(ch.body, ctx), // 文字层面的引用也按可见性改写
      order_key: ch.order_key,
    }));

    const safeMedia = media.map(m => ({
      id: m.id, caption: m.caption, filename: m.filename,
      variant_of: m.variant_of || undefined,
    }));

    const payload = {
      album_id: albumId, generation, policy,
      chapters: safeChapters, nodes: safeNodes, media: safeMedia,
      companions: safeCompanions, produced_at: now(),
    };

    const id = uid();
    db.run(
      'INSERT INTO snapshots(id,album_id,generation,share_token,policy,allowed_fields,payload,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      [id, albumId, generation, shareToken || null, policy, JSON.stringify(allowedFields), JSON.stringify(payload), 'current', now()]
    );
    // 旧快照全部标记 superseded（同一代次一致性：旧代次不再可服务）
    db.run("UPDATE snapshots SET status='superseded', superseded_by=? WHERE album_id=? AND id!=? AND status='current'", [id, albumId, id]);
    return { id, generation, payload };
  });
}

// 撤下一个节点：新代次 + 清理其派生摘要，避免悬空摘要泄露
function unpublishNode(albumId, nodeId) {
  return db.tx(() => {
    db.run('UPDATE nodes SET published=0, updated_at=? WHERE id=?', [now(), nodeId]);
    // 该节点的派生摘要（搜索索引/站点地图）标记 stale，交由重生成
    db.run("UPDATE derivatives SET status='stale' WHERE album_id=? AND ref_type='node' AND ref_id=?", [albumId, nodeId]);
    rebuildIndexes(albumId);
    return { ok: true };
  });
}

// 重建索引类派生物（搜索索引 + 站点地图），只收录当前可见且已发布实体
function rebuildIndexes(albumId) {
  const album = db.get('SELECT * FROM albums WHERE id=?', [albumId]);
  const gen = album.generation;
  const chapters = db.all('SELECT id,title FROM chapters WHERE album_id=? AND deleted=0', [albumId]);
  const nodes = db.all('SELECT id,label FROM nodes WHERE album_id=? AND deleted=0 AND published=1', [albumId]);
  const upsert = (kind, payload) => {
    const ex = db.get('SELECT id FROM derivatives WHERE album_id=? AND kind=?', [albumId, kind]);
    if (ex) db.run('UPDATE derivatives SET generation=?, payload=?, status=\'current\' WHERE id=?', [gen, JSON.stringify(payload), ex.id]);
    else db.run('INSERT INTO derivatives(id,album_id,kind,ref_type,ref_id,generation,payload,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      [uid(), albumId, kind, 'album', albumId, gen, JSON.stringify(payload), 'current', now()]);
  };
  upsert('search_index', {
    chapters: chapters.map(c => ({ id: c.id, title: c.title })),
    nodes: nodes.map(n => ({ id: n.id, label: n.label })), // 撤下的节点不会出现在索引里
  });
  upsert('sitemap', {
    urls: [
      ...chapters.map(c => `/share/.../c/${c.id}`),
      ...nodes.map(n => `/share/.../n/${n.id}`),
    ],
  });
}

function getShareView(token) {
  const link = db.get('SELECT * FROM share_links WHERE token=?', [token]);
  if (!link || link.revoked) return { error: 404 };
  const snap = db.get('SELECT * FROM snapshots WHERE id=?', [link.snapshot_id]);
  if (!snap || snap.status !== 'current') return { error: 410 }; // 旧代次/已取代
  return { snapshot: JSON.parse(snap.payload), generation: snap.generation };
}

module.exports = { generateSnapshot, unpublishNode, rebuildIndexes, getShareView, visibilityFor, SCOPES };
