import assert from 'node:assert/strict';
import { startServer } from './server-harness.mjs';

const { base, stop } = await startServer(18787);

async function json(path, options) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options?.headers || {}) },
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}
function op(type, patch = {}) {
  const ts = new Date().toISOString() + Math.random().toString(16).slice(2, 8);
  return { id: `op_${Math.random().toString(16).slice(2)}`, clientId: 'api-test', type, at: ts, ts, ...patch };
}

try {
  let { body: state } = await json('/api/reset', { method: 'POST' });
  const initialRev = state.rev;
  const oldGen = state.doc.activeGenerationId;

  // 客户端先记下旧基线，然后离线。
  const baseDoc = state.doc;
  const staleText = {
    ...op('updateBlock', { blockId: 'b_ridge_text', patch: { text: '旧离线稿：林岚 lan@example.com +86 138-0000-1234' } }),
    ts: '2026-10-05T10:00:00.000Z', at: '2026-10-05T10:00:00.000Z',
  };

  // 服务端先发生许可撤回。
  const withdrawn = await json(`/api/consents/p_lan/withdraw`, { method: 'POST' });
  assert.equal(withdrawn.body.server.doc.activeGenerationId !== oldGen, true);
  assert.equal(withdrawn.body.server.doc.mediaJobs.job_ph_harbor_v1.targetDerivativeId, 'ph_harbor.v1.blur');

  // 媒体处理检查点可通过 API 持久，即使中断后重启也能读回。
  const checkpoint = await json('/api/media-jobs/job_ph_harbor_v1', {
    method: 'PATCH', body: JSON.stringify({ state: 'interrupted', progress: 64 }),
  });
  assert.equal(checkpoint.body.progress, 64);
  state = (await json('/api/state')).body;
  assert.equal(state.doc.mediaJobs.job_ph_harbor_v1.state, 'interrupted');

  // 旧离线稿重放：服务端通过操作日志重放并返回安全版本，不持久原文。
  const replayed = await json('/api/sync', {
    method: 'POST', body: JSON.stringify({ baseDoc, baseRev: initialRev, ops: [staleText] }),
  });
  assert.equal(replayed.status, 200);
  assert.equal(replayed.body.result.conflicts[0].code, 'WITHDRAWN_INFO_REUPLOAD');
  assert.doesNotMatch(replayed.body.server.doc.blocks.b_ridge_text.text, /lan@example\.com/);
  assert.match(replayed.body.server.doc.blocks.b_ridge_text.text, /重新生成/);
  assert.equal(replayed.body.server.doc.copies.copy_downloaded.state, 'unreachable');

  // 不可变媒体衍生物 PUT/GET。
  const put = await fetch(`${base}/api/media/ph_harbor.v1.blur`, { method: 'PUT', body: Buffer.from([255, 216, 1, 2]) });
  assert.equal(put.status, 200);
  const get = await fetch(`${base}/api/media/ph_harbor.v1.blur`);
  assert.equal(get.headers.get('content-type'), 'image/jpeg');
  assert.equal((await get.arrayBuffer()).byteLength, 4);

  console.log('✓ API 持久化、离线撤回冲突、媒体检查点与不可变媒体均可工作');
} finally {
  stop();
}
