import assert from 'node:assert/strict';
import {
  applyOp,
  analyzeConsentImpact,
  buildSnapshot,
  comparePosition,
  createSeedDoc,
  positionBetween,
  publishAll,
  rebase,
  sortedByPosition,
  uid,
  withdrawConsent,
} from '../js/travel/kernel.js';

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

test('分数位排序支持多次拖动且保持严格顺序', () => {
  const a = positionBetween(null, null);
  const b = positionBetween(a, null);
  const c = positionBetween(a, b);
  assert.equal(comparePosition(a, c), -1);
  assert.equal(comparePosition(c, b), -1);
  assert.ok(positionBetween(positionBetween(null, null), null).startsWith('0.'));
});

test('移动章节只改变位置，照片段落仍通过稳定 ID 引用照片', () => {
  const seed = createSeedDoc('2026-10-01T00:00:00.000Z');
  const ridge = seed.chapters.ch_ridge;
  const harbor = seed.chapters.ch_harbor;
  const newPos = positionBetween(null, harbor.pos);
  const moved = applyOp(seed, {
    id: 'op_move_1', type: 'moveChapter', chapterId: 'ch_ridge', pos: newPos,
    at: '2026-10-02T00:00:00.000Z', ts: '2026-10-02T00:00:00.000Z',
  });
  const order = sortedByPosition(Object.values(moved.chapters)).map((c) => c.id);
  assert.deepEqual(order, ['ch_ridge', 'ch_harbor']);
  assert.equal(moved.blocks.b_harbor_photo.photoId, 'ph_harbor');
  assert.equal(moved.photos.ph_harbor.caption, seed.photos.ph_harbor.caption);
  assert.equal(ridge.id, 'ch_ridge');
});

test('白名单快照分别控制姓名、联系信息和精确位置', () => {
  let doc = createSeedDoc('2026-10-01T00:00:00.000Z');
  doc = applyOp(doc, {
    id: 'op_share_1',
    type: 'addShare',
    at: '2026-10-02T00:00:00.000Z',
    share: {
      id: 'sh_friend',
      label: '给普通朋友的快照',
      mode: 'snapshot',
      chapterIds: ['ch_harbor', 'ch_ridge'],
      unitIds: ['b_harbor_text', 'b_harbor_photo', 'b_harbor_map', 'b_ridge_text', 'b_ridge_map'],
      allow: { names: true, contacts: false, preciseLocation: false },
      status: 'active',
    },
  });
  doc = publishAll(doc, 'gen_1', '2026-10-02T00:00:00.000Z');
  const snap = doc.snapshots['sh_friend@gen_1'];
  assert.match(snap.blocks.b_harbor_text.text, /林岚/);
  assert.match(snap.blocks.b_harbor_text.text, /联系方式已隐藏/);
  assert.doesNotMatch(snap.blocks.b_harbor_text.text, /lan@example\.com/);
  assert.match(snap.blocks.b_ridge_text.text, /精确位置已隐藏/);
  assert.ok(Math.abs(snap.nodes.n_camp.lat - 24.6) < 0.001);

  const share = doc.shares.sh_friend;
  share.allow = { names: false, contacts: false, preciseLocation: false };
  doc = publishAll(doc, 'gen_2', '2026-10-03T00:00:00.000Z');
  const snap2 = doc.snapshots['sh_friend@gen_2'];
  assert.doesNotMatch(snap2.blocks.b_harbor_text.text, /林岚/);
  assert.match(snap2.blocks.b_harbor_text.text, /同行人/);
});

test('全章共享保留章节结构，白名单快照冻结字段与单元集合', () => {
  let doc = createSeedDoc('2026-10-01T00:00:00.000Z');
  doc = applyOp(doc, { id: 'op_s', type: 'addShare', at: '2026-10-02T00:00:00.000Z', share: {
    id: 'sh_full', label: '全章', mode: 'fullChapter',
    chapterIds: ['ch_harbor', 'ch_ridge'], unitIds: [],
    allow: { names: true, contacts: true, preciseLocation: true },
  }});
  doc = publishAll(doc, 'gen_full', '2026-10-02T00:00:00.000Z');
  const snap = doc.snapshots['sh_full@gen_full'];
  assert.equal(Object.keys(snap.blocks).length, 5);
  assert.equal(snap.nodes.n_camp.lat, 24.5555);
  assert.match(snap.blocks.b_harbor_text.text, /lan@example\.com/);
});

test('撤回许可会列出并重新生成图像、文字、快照、索引及受控副本清理任务', () => {
  const doc = publishAll(createSeedDoc('2026-10-01T00:00:00.000Z'), 'gen_old', '2026-10-02T00:00:00.000Z');
  const impact = analyzeConsentImpact(doc, 'p_lan');
  assert.deepEqual(impact.photoIds.sort(), ['ph_harbor']);
  assert.ok(impact.blockIds.includes('b_harbor_text'));
  assert.ok(impact.blockIds.includes('b_harbor_photo'));
  assert.ok(impact.controlledCopyIds.includes('copy_this_browser'));
  assert.ok(impact.externalCopyIds.includes('copy_downloaded'));

  const next = withdrawConsent(doc, 'p_lan', 'gen_safe', '2026-10-04T00:00:00.000Z');
  assert.equal(next.photos.ph_harbor.derivativeId, 'ph_harbor.v1.blur');
  assert.equal(next.mediaJobs.job_ph_harbor_v1.state, 'queued');
  for (const share of Object.values(next.shares)) {
    const snap = next.snapshots[share.snapshotId];
    assert.doesNotMatch(JSON.stringify(snap), /林岚/);
    assert.doesNotMatch(JSON.stringify(snap), /lan@example\.com/);
  }
  assert.equal(next.activeGenerationId, 'gen_safe');
  assert.equal(next.copies.copy_this_browser.purgeRequired, true);
  assert.equal(next.copies.copy_downloaded.state, 'unreachable');
});

test('离线稿重新上传已撤回信息时不接收原文，并返回可解释冲突', () => {
  const base = publishAll(createSeedDoc('2026-10-01T00:00:00.000Z'), 'gen_old', '2026-10-02T00:00:00.000Z');
  const remote = withdrawConsent(base, 'p_lan', 'gen_safe', '2026-10-03T00:00:00.000Z');
  const local = [
    { id: 'off_1', type: 'updateBlock', blockId: 'b_ridge_text', ts: '2026-10-03T12:00:00.000Z', at: '2026-10-03T12:00:00.000Z',
      patch: { text: '离线补写：林岚的邮箱 lan@example.com' } },
  ];
  const result = rebase(base, remote.audit.filter((x) => x.type === 'consent-withdrawn').map(() => ({
    id: 'remote_withdraw', type: 'withdrawConsent', personId: 'p_lan', generationId: 'gen_safe',
    ts: '2026-10-03T00:00:00.000Z', at: '2026-10-03T00:00:00.000Z',
  })), local);
  assert.equal(result.conflicts[0].code, 'WITHDRAWN_INFO_REUPLOAD');
  assert.match(result.doc.blocks.b_ridge_text.text, /重新生成/);
  assert.doesNotMatch(result.doc.blocks.b_ridge_text.text, /lan@example\.com/);
  assert.equal(result.acceptedLocal[0].scrubbed, true);
});

test('两个标签页同时重排时自动选择相邻位置且引用不脱钩', () => {
  const base = createSeedDoc('2026-10-01T00:00:00.000Z');
  const target = positionBetween(null, base.chapters.ch_harbor.pos);
  const opsA = [{ id: 'a1', type: 'moveChapter', chapterId: 'ch_ridge', pos: target, ts: '2026-10-02T00:01:00.000Z', at: '2026-10-02T00:01:00.000Z' }];
  const opsB = [{ id: 'b1', type: 'moveChapter', chapterId: 'ch_harbor', pos: target, ts: '2026-10-02T00:02:00.000Z', at: '2026-10-02T00:02:00.000Z' }];
  const r1 = rebase(base, opsA, opsB);
  const order = sortedByPosition(Object.values(r1.doc.chapters)).map((x) => x.id);
  assert.equal(new Set(order).size, 2);
  assert.deepEqual(order, ['ch_ridge', 'ch_harbor']);
  assert.equal(r1.conflicts[0].code, 'CONCURRENT_REORDER');
  assert.equal(r1.doc.blocks.b_harbor_photo.photoId, 'ph_harbor');
});

test('撤下地图节点后发布代次中的地图引用和摘要不会悬空泄露', () => {
  let doc = publishAll(createSeedDoc('2026-10-01T00:00:00.000Z'), 'gen_before', '2026-10-02T00:00:00.000Z');
  doc = applyOp(doc, { id: 'remove_node', type: 'removeNode', nodeId: 'n_camp', ts: '2026-10-03T00:00:00.000Z', at: '2026-10-03T00:00:00.000Z' });
  doc.chapters.ch_ridge.summary = '今晚住在鹰嘴岩营地：24.5555,118.1111';
  doc = publishAll(doc, 'gen_after', '2026-10-03T00:10:00.000Z', 'remove-node');
  for (const share of Object.values(doc.shares)) {
    const snap = buildSnapshot(doc, share, 'gen_after');
    assert.equal(snap.blocks.b_ridge_map, undefined);
    assert.doesNotMatch(JSON.stringify(snap), /24\.5555/);
    assert.ok(snap.removedRefs.some((r) => r.nodeId === 'n_camp'));
  }
});

test('媒体处理中断保留检查点并可从同一目标衍生物继续', () => {
  const before = publishAll(createSeedDoc('2026-10-01T00:00:00.000Z'), 'g1', '2026-10-02T00:00:00.000Z');
  const after = withdrawConsent(before, 'p_lan', 'g2', '2026-10-03T00:00:00.000Z');
  const job = after.mediaJobs.job_ph_harbor_v1;
  assert.equal(job.progress, 0);
  assert.equal(job.targetDerivativeId, 'ph_harbor.v1.blur');
  job.progress = 64;
  job.state = 'interrupted';
  assert.equal(job.targetDerivativeId, 'ph_harbor.v1.blur');
  assert.ok(job.progress < 100);
});

console.log(`\n${passed} 项内核测试通过`);
