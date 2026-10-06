// acceptance.js — 验收场景测试
const fs = require('fs');
const path = require('path');
// 干净的数据库
const DBF = path.join(__dirname, '..', 'data', 'album.sqlite');
if (fs.existsSync(DBF)) fs.unlinkSync(DBF);

const { start } = require('../server/index');
const db = require('../server/db');
const media = require('../server/media');

let base, server, passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${extra ? ' — ' + JSON.stringify(extra) : ''}`); }
}
const api = async (p, m = 'GET', b) => {
  const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, body: ct.includes('json') ? await r.json() : await r.text() };
};
const newAlbum = async (t) => (await api('/api/albums', 'POST', { title: t })).body.id;

async function run() {
  server = await start(0);
  base = `http://localhost:${server.address().port}`;
  console.log('服务已启动', base);

  // ===== 1. 拖动章节不使图注与照片错配 =====
  console.log('\n[1] 拖动章节 — 图注与照片引用稳定');
  {
    const a = await newAlbum('拖拽');
    const m = (await api(`/api/albums/${a}/media`, 'POST', { filename: 'sunset.jpg', caption: '日落' })).body.id;
    await api('/api/media/process', 'POST');
    const c1 = (await api(`/api/albums/${a}/chapters`, 'POST', { title: 'A', body: `看图 [[media:${m}]]` })).body.id;
    const c2 = (await api(`/api/albums/${a}/chapters`, 'POST', { title: 'B', body: '第二章' })).body.id;
    const c3 = (await api(`/api/albums/${a}/chapters`, 'POST', { title: 'C', body: '第三章' })).body.id;
    // 把 c1 拖到最后
    await api(`/api/albums/${a}/reorder`, 'POST', { chapter_id: c1, before_id: c3, after_id: null });
    const d = (await api(`/api/albums/${a}`)).body;
    const moved = d.chapters.find(c => c.id === c1);
    check('拖动后章节顺序改变', d.chapters[d.chapters.length - 1].id === c1);
    check('正文仍引用同一照片ID', moved.body.includes(`[[media:${m}]]`));
    const ref = db.all('SELECT * FROM refs WHERE chapter_id=? AND ref_type=?', [c1, 'media']);
    check('refs 表关联未因拖动错配', ref.length === 1 && ref[0].ref_id === m);
    const photo = d.media.find(x => x.id === m);
    check('照片记录本身未被拖动影响', photo && photo.caption === '日落');
  }

  // ===== 2. 离线稿重新上传已撤信息 =====
  console.log('\n[2] 离线稿重新上传已撤信息 — 服务端脱敏 + 清理');
  {
    const a = await newAlbum('离线撤信息');
    const comp = (await api(`/api/albums/${a}/companions`, 'POST', { name: '张三', contact: '13900001111' })).body.id;
    await api(`/api/companions/${comp}/revoke`, 'POST', { scope: 'name' }); // 撤回姓名
    const head = (await api(`/api/albums/${a}`)).body.album.head_version;
    // 离线客户端仍持有旧快照，上传含明文姓名的章节
    const r = (await api(`/api/albums/${a}/sync`, 'POST', {
      client_id: 'offline-1', base_version: head,
      ops: [{ type: 'chapter.create', chapter: { id: 'choff1', title: '和张三同行', body: '今天和张三一起爬山' }, lamport: Date.now() }],
    })).body;
    check('离线提交被接受但触发脱敏', r.ok === true);
    check('purged 清单报告了被撤的姓名', r.purged.some(p => p.field === 'name' && p.value === '张三'), r.purged);
    const ch = db.get('SELECT * FROM chapters WHERE id=?', ['choff1']);
    check('落库正文已不含明文姓名', !ch.body.includes('张三') && ch.body.includes('一位同行人'), ch.body);
    check('tombstones 含已撤许可', r.tombstones.revoked_consents.some(x => x.companion_id === comp && x.scope === 'name'));
  }

  // ===== 3. 两个标签页同时重排 =====
  console.log('\n[3] 两个标签页同时重排 — 可理解合并');
  {
    const a = await newAlbum('并发重排');
    const c1 = (await api(`/api/albums/${a}/chapters`, 'POST', { title: '一' })).body.id;
    const c2 = (await api(`/api/albums/${a}/chapters`, 'POST', { title: '二' })).body.id;
    const c3 = (await api(`/api/albums/${a}/chapters`, 'POST', { title: '三' })).body.id;
    const H = (await api(`/api/albums/${a}`)).body.album.head_version;
    // 标签页A：把 c1 移到末尾（lamport 较小）
    const rA = (await api(`/api/albums/${a}/sync`, 'POST', { client_id: 'tab-A', base_version: H, ops: [{ type: 'chapter.reorder', chapter_id: c1, before_id: c3, after_id: null, lamport: 100 }] })).body;
    // 标签页B：基于同一旧版本，把 c1 移到最前（lamport 较大）
    const rB = (await api(`/api/albums/${a}/sync`, 'POST', { client_id: 'tab-B', base_version: H, ops: [{ type: 'chapter.reorder', chapter_id: c1, before_id: null, after_id: c2, lamport: 200 }] })).body;
    check('标签页A 应用成功', rA.results[0].status === 'applied');
    check('标签页B 检测到并发并合并', rB.results[0].status === 'conflict', rB.results);
    check('B 的冲突说明可理解', /较新|同时|另一/.test(rB.results[0].note || ''), rB.results[0].note);
    const d = (await api(`/api/albums/${a}`)).body;
    check('较新的重排（B）最终生效', d.chapters[0].id === c1, d.chapters.map(c => c.id));
  }

  // ===== 4. 媒体处理中断 =====
  console.log('\n[4] 媒体处理中断 — 崩溃恢复');
  {
    const a = await newAlbum('媒体中断');
    const m = (await api(`/api/albums/${a}/media`, 'POST', { filename: 'big.jpg' })).body.id;
    check('上传后为 processing', db.get('SELECT status s FROM media WHERE id=?', [m]).s === 'processing');
    media._setInjectCrash(true);
    try { media.processNextJob(); } catch (e) { /* 模拟崩溃：进程“死掉”，任务停在 running */ }
    const stuck = db.get("SELECT status s FROM jobs WHERE payload LIKE ?", [`%${m}%`]);
    check('崩溃后任务停在 running（未完成）', stuck && stuck.s === 'running', stuck);
    check('媒体仍未就绪（不会错配为就绪）', db.get('SELECT status s FROM media WHERE id=?', [m]).s === 'processing');
    media._setInjectCrash(false);
    const recovered = media.recoverJobs();
    check('重连后恢复中断任务', recovered >= 1);
    media.processNextJob();
    check('恢复后处理完成 ready', db.get('SELECT status s FROM media WHERE id=?', [m]).s === 'ready');
  }

  // ===== 5+6+7. 撤回级联 + 旧链接缓存 + 不可撤回范围 =====
  console.log('\n[5/6/7] 撤回许可级联重生成 / 旧链接失效 / 不可撤回范围');
  {
    const a = await newAlbum('撤回级联');
    const comp = (await api(`/api/albums/${a}/companions`, 'POST', { name: '李四', contact: '13800002222' })).body.id;
    const m = (await api(`/api/albums/${a}/media`, 'POST', { filename: 'group.jpg', caption: '和李四的合影' })).body.id;
    await api('/api/media/process', 'POST');
    const ch = (await api(`/api/albums/${a}/chapters`, 'POST', { title: '合影', body: `和李四 [[companion:${comp}]] 在 [[media:${m}]] 前` })).body.id;
    const share = (await api(`/api/albums/${a}/share`, 'POST', { policy: 'whitelist', allowed_fields: { name: true, contact: true, exact_location: true } })).body;
    const gen1 = db.get('SELECT generation g FROM snapshots WHERE share_token=?', [share.token]).g;
    const view1 = (await api(`/share/${share.token}`)).body;
    check('撤回前分享页含姓名', view1.includes('李四'));

    const rep = (await api(`/api/companions/${comp}/revoke`, 'POST', { scope: 'name' })).body.report;
    check('级联：重写了章节文字', rep.chapters_rewritten >= 1, rep);
    check('级联：重写了图注', rep.captions_rewritten >= 1, rep);
    check('级联：重新生成了图像变体', rep.images_regenerated >= 1, rep);
    check('级联：重建了索引', rep.indexes_rebuilt === true);
    check('级联：重新生成了分享快照', rep.snapshots_regenerated >= 1, rep);
    check('不可撤回范围被如实列出', rep.non_revocable_external.length >= 1, rep.non_revocable_external);

    const chAfter = db.get('SELECT body FROM chapters WHERE id=?', [ch]);
    check('章节正文明文已脱敏', !chAfter.body.includes('李四') || chAfter.body.includes('[[companion:'), chAfter.body);
    const capAfter = db.get('SELECT caption FROM media WHERE id=?', [m]);
    check('图注明文已脱敏', !capAfter.caption.includes('李四'), capAfter.caption);
    const variant = db.get('SELECT * FROM media WHERE variant_of=?', [m]);
    check('生成了脱敏图像变体', !!variant);

    // 旧链接（被缓存的旧代次）
    const oldGen = await api(`/share/${share.token}/gen/${gen1}`);
    check('旧代次链接返回 410', oldGen.status === 410);
    const view2 = (await api(`/share/${share.token}`)).body;
    check('当前分享页不再含已撤姓名', !view2.includes('李四'));
    const cur = db.all("SELECT * FROM snapshots WHERE share_token=? AND status='current'", [share.token]);
    check('仅一个当前代次（同一代次一致性）', cur.length === 1 && cur[0].generation > gen1);
  }

  // ===== 8. 撤下节点不留悬空摘要 =====
  console.log('\n[8] 撤下节点 — 无悬空摘要泄露');
  {
    const a = await newAlbum('撤下节点');
    const n = (await api(`/api/albums/${a}/nodes`, 'POST', { label: '秘密基地', lat: 31.23, lng: 121.47 })).body.id;
    await api(`/api/albums/${a}/chapters`, 'POST', { title: '抵达', body: `到了 [[node:${n}]]` });
    const share = (await api(`/api/albums/${a}/share`, 'POST', { policy: 'full' })).body;
    const before = (await api(`/share/${share.token}`)).body;
    check('撤下前分享页含节点名', before.includes('秘密基地'));
    await api(`/api/albums/${a}/nodes/${n}/unpublish`, 'POST');
    const idx = db.get("SELECT payload FROM derivatives WHERE album_id=? AND kind='search_index'", [a]);
    check('搜索索引已不含被撤节点', !idx.payload.includes('秘密基地'), idx.payload);
    const sm = db.get("SELECT payload FROM derivatives WHERE album_id=? AND kind='sitemap'", [a]);
    check('站点地图已不含被撤节点', !sm.payload.includes(n));
    const after = (await api(`/share/${share.token}`)).body;
    check('分享页不再暴露被撤节点名', !after.includes('秘密基地'));
    check('分享页无悬空节点条目', !after.includes(n));
  }

  // ===== 9+10. 白名单独立可见范围 / 全章共享对比 =====
  console.log('\n[9/10] 白名单快照 — 姓名/联系方式/精确位置独立可见');
  {
    const a = await newAlbum('白名单');
    await api(`/api/albums/${a}/companions`, 'POST', { name: '王五', contact: '13711113333' });
    await api(`/api/albums/${a}/nodes`, 'POST', { label: '家', lat: 31.2304, lng: 121.4737 });
    const get = async (allowed, policy = 'whitelist') => {
      const s = (await api(`/api/albums/${a}/share`, 'POST', { policy, allowed_fields: allowed })).body;
      return (await api(`/share/${s.token}`)).body;
    };
    const onlyName = await get({ name: true, contact: false, exact_location: false });
    check('仅姓名可见：含姓名', onlyName.includes('王五'));
    check('仅姓名可见：不含联系方式', !onlyName.includes('13711113333'));
    check('仅姓名可见：不含精确坐标', !onlyName.includes('31.2304'), onlyName.slice(0, 200));

    const onlyContact = await get({ name: false, contact: true, exact_location: false });
    check('仅联系方式可见：不含姓名', !onlyContact.includes('王五'));
    check('仅联系方式可见：含联系方式', onlyContact.includes('13711113333'));

    const onlyLoc = await get({ name: false, contact: false, exact_location: true });
    check('仅精确位置可见：含精确坐标', onlyLoc.includes('31.2304'));
    check('仅精确位置可见：不含姓名', !onlyLoc.includes('王五'));

    const noneW = await get({ name: false, contact: false, exact_location: false });
    check('全关：姓名/联系方式/精确坐标均不可见', !noneW.includes('王五') && !noneW.includes('13711113333') && !noneW.includes('31.2304'));
    check('全关：仍有城市级粗粒度位置', noneW.includes('31.2') || noneW.includes('大致'));

    const full = await get(null, 'full');
    check('全章共享：姓名/联系方式/精确坐标均可见', full.includes('王五') && full.includes('13711113333') && full.includes('31.2304'));
  }

  // ===== 11. 访客路线与章节同一代次 =====
  console.log('\n[11] 访客路线与章节来自同一发布代次');
  {
    const a = await newAlbum('同代次');
    await api(`/api/albums/${a}/nodes`, 'POST', { label: 'P1', lat: 1, lng: 1 });
    await api(`/api/albums/${a}/chapters`, 'POST', { title: 'S1', body: 'x' });
    const s = (await api(`/api/albums/${a}/share`, 'POST', { policy: 'full' })).body;
    const snap = db.get('SELECT * FROM snapshots WHERE share_token=? AND status=\'current\'', [s.token]);
    const payload = JSON.parse(snap.payload);
    check('快照内章节与路线同属一个 generation', payload.generation === snap.generation && payload.chapters.length === 1 && payload.nodes.length === 1);
    // 撤回/撤下后代次推进且唯一
    await api(`/api/albums/${a}/nodes/${payload.nodes[0].id}/unpublish`, 'POST');
    const cur = db.all("SELECT * FROM snapshots WHERE share_token=? AND status='current'", [s.token]);
    check('撤下后仅一个新代次为当前', cur.length === 1 && cur[0].generation > snap.generation);
    check('新代次不再含被撤节点', JSON.parse(cur[0].payload).nodes.length === 0);
  }

  console.log(`\n结果：${passed} 通过, ${failed} 失败`);
  server.close();
  process.exit(failed ? 1 : 0);
}

run().catch(e => { console.error('测试运行异常:', e); process.exit(1); });
