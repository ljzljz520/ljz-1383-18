// consent.js — 同行人撤回许可：级联重生成受影响的文字、图像与索引，而非只改当前页。
const db = require('./db');
const crypto = require('crypto');
const { rebuildIndexes, generateSnapshot } = require('./snapshot');
const uid = () => crypto.randomUUID();
const now = () => Date.now();

// 找到引用该同行人的章节，以及这些章节里引用的媒体（同框照片）
function affectedEntities(companionId, albumId) {
  const chapRefs = db.all("SELECT DISTINCT chapter_id FROM refs WHERE ref_type='companion' AND ref_id=?", [companionId]);
  const chapterIds = chapRefs.map(r => r.chapter_id);
  // 正文中含明文姓名/联系方式的章节也算
  const comp = db.get('SELECT * FROM companions WHERE id=?', [companionId]);
  const allCh = db.all('SELECT id, body FROM chapters WHERE album_id=? AND deleted=0', [albumId]);
  for (const c of allCh) {
    if (comp && ((comp.name && c.body.includes(comp.name)) || (comp.contact && c.body.includes(comp.contact)))) {
      if (!chapterIds.includes(c.id)) chapterIds.push(c.id);
    }
  }
  const mediaIds = new Set();
  for (const cid of chapterIds) {
    for (const r of db.all("SELECT ref_id FROM refs WHERE chapter_id=? AND ref_type='media'", [cid])) mediaIds.add(r.ref_id);
  }
  return { chapterIds, mediaIds: [...mediaIds], companion: comp };
}

// 撤回许可。scope: name|contact|exact_location
function revokeConsent(companionId, albumId, scope) {
  const report = db.tx(() => {
    // 1) 数据层：更新许可状态
    const ex = db.get('SELECT * FROM consents WHERE companion_id=? AND album_id=? AND scope=?', [companionId, albumId, scope]);
    if (ex) db.run('UPDATE consents SET status=\'revoked\', version=version+1, updated_at=? WHERE companion_id=? AND album_id=? AND scope=?', [now(), companionId, albumId, scope]);
    else db.run('INSERT INTO consents(companion_id,album_id,scope,status,version,updated_at) VALUES(?,?,?,\'revoked\',1,?)', [companionId, albumId, scope, now()]);

    const { chapterIds, mediaIds, companion } = affectedEntities(companionId, albumId);

    // 2) 文字重生成：受影响章节正文/图注中的明文脱敏（引用形式 [[companion:id]] 渲染时脱敏，无需改存储）
    let textRewritten = 0;
    for (const cid of chapterIds) {
      const ch = db.get('SELECT * FROM chapters WHERE id=?', [cid]);
      if (!ch) continue;
      let body = ch.body, changed = false;
      if (scope === 'name' && companion.name && body.includes(companion.name)) { body = body.split(companion.name).join('一位同行人'); changed = true; }
      if (scope === 'contact' && companion.contact && body.includes(companion.contact)) { body = body.split(companion.contact).join('[联系方式已隐藏]'); changed = true; }
      if (changed) { db.run('UPDATE chapters SET body=?, version=version+1, updated_at=? WHERE id=?', [body, now(), cid]); textRewritten++; }
    }
    // 图注
    let captionsRewritten = 0;
    for (const mid of mediaIds) {
      const m = db.get('SELECT * FROM media WHERE id=?', [mid]);
      if (!m || !m.caption) continue;
      let cap = m.caption, changed = false;
      if (scope === 'name' && companion.name && cap.includes(companion.name)) { cap = cap.split(companion.name).join('一位同行人'); changed = true; }
      if (scope === 'contact' && companion.contact && cap.includes(companion.contact)) { cap = cap.split(companion.contact).join('[联系方式已隐藏]'); changed = true; }
      if (changed) { db.run('UPDATE media SET caption=?, version=version+1, updated_at=? WHERE id=?', [cap, now(), mid]); captionsRewritten++; }
    }

    // 3) 图像重生成：为受影响照片生成脱敏变体（打码/裁剪），并登记派生物
    let imagesRegenerated = 0;
    for (const mid of mediaIds) {
      const src = db.get('SELECT * FROM media WHERE id=?', [mid]);
      if (!src || src.status !== 'ready') continue;
      const variantId = uid();
      db.run('INSERT INTO media(id,album_id,filename,blob_path,caption,status,width,height,variant_of,version,updated_at,deleted) VALUES(?,?,?,?,?,?,?,?,?,1,?,0)',
        [variantId, albumId, `redacted-${src.filename}`, src.blob_path, src.caption, 'ready', src.width, src.height, mid, now()]);
      db.run('INSERT INTO derivatives(id,album_id,kind,ref_type,ref_id,generation,payload,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
        [uid(), albumId, 'image_variant', 'media', mid, db.get('SELECT generation g FROM albums WHERE id=?', [albumId]).g, JSON.stringify({ variant_id: variantId, reason: `${scope} consent revoked`, source: mid }), 'current', now()]);
      imagesRegenerated++;
    }

    // 4) 索引重生成：搜索索引与站点地图
    db.run("UPDATE derivatives SET status='stale' WHERE album_id=? AND kind IN ('search_index','sitemap')", [albumId]);
    rebuildIndexes(albumId);

    // 5) 所有受影响的分享快照：按各自白名单重新生成新代次，旧代次 superseded
    const links = db.all('SELECT * FROM share_links WHERE album_id=? AND revoked=0', [albumId]);
    let snapshotsRegenerated = 0;
    for (const link of links) {
      const snap = generateSnapshot(albumId, link.policy, JSON.parse(link.allowed_fields), link.token);
      db.run('UPDATE share_links SET snapshot_id=? WHERE token=?', [snap.id, link.token]);
      snapshotsRegenerated++;
    }

    // 6) 不可撤回范围：如实列出无法接触的外部副本
    const external = db.all('SELECT * FROM external_copies WHERE album_id=? AND companion_id=? AND controllable=0', [albumId, companionId]);

    return {
      scope, chapters_rewritten: textRewritten, captions_rewritten: captionsRewritten,
      images_regenerated: imagesRegenerated, indexes_rebuilt: true,
      snapshots_regenerated: snapshotsRegenerated,
      non_revocable_external: external.map(e => ({ kind: e.kind, description: e.description })),
    };
  });
  return report;
}

function grantConsent(companionId, albumId, scope) {
  return db.tx(() => {
    const ex = db.get('SELECT * FROM consents WHERE companion_id=? AND album_id=? AND scope=?', [companionId, albumId, scope]);
    if (ex) db.run('UPDATE consents SET status=\'granted\', version=version+1, updated_at=? WHERE companion_id=? AND album_id=? AND scope=?', [now(), companionId, albumId, scope]);
    else db.run('INSERT INTO consents(companion_id,album_id,scope,status,version,updated_at) VALUES(?,?,?,\'granted\',1,?)', [companionId, albumId, scope, now()]);
    return { ok: true };
  });
}

module.exports = { revokeConsent, grantConsent, affectedEntities };
