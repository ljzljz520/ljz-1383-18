#!/usr/bin/env node
// 无第三方依赖的后台 API：
// - GET  /api/state
// - POST /api/sync { baseDoc, baseRev, ops }  操作日志三路合并
// - POST /api/publish / POST /api/consents/:id/withdraw
// - GET/PUT /api/media/:id                    章节图与衍生物以不可变 ID 持久化
// - PATCH /api/media-jobs/:id                 媒体处理检查点
// - POST /api/reset
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyOp, applyOps, createSeedDoc, publishAll, rebase, uid, withdrawConsent } from './js/travel/kernel.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataFile = path.join(root, 'travel-data.json');
const mediaDir = path.join(root, 'media-store');
const port = Number(process.env.PORT || 8787);
const mime = {
  '.html': 'text/html;charset=utf-8', '.js': 'text/javascript;charset=utf-8',
  '.css': 'text/css;charset=utf-8', '.json': 'application/json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
};

async function loadState() {
  try {
    return JSON.parse(await fs.readFile(dataFile, 'utf8'));
  } catch {
    let doc = createSeedDoc();
    doc = applyOps(doc, [{
      id: uid('op'), type: 'addShare', at: new Date().toISOString(),
      share: {
        id: 'sh_family', label: '给家人的白名单版本', mode: 'snapshot',
        chapterIds: ['ch_harbor', 'ch_ridge'],
        unitIds: ['b_harbor_text', 'b_harbor_photo', 'b_harbor_map', 'b_ridge_text', 'b_ridge_map'],
        allow: { names: true, contacts: false, preciseLocation: false },
        status: 'active',
      },
    }]);
    doc = publishAll(doc, 'gen_seed_001', new Date().toISOString(), 'initial-publish');
    return { doc, rev: doc.rev, ops: [] };
  }
}
async function saveState(state) {
  await fs.writeFile(dataFile, `${JSON.stringify(state, null, 2)}\n`);
}
async function bodyJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
async function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
}
async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/travel/editor.html';
  const file = path.normalize(path.join(root, pathname));
  if (file !== root && !file.startsWith(`${root}${path.sep}`)) { res.writeHead(403); return res.end('forbidden'); }
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('not found');
  }
}

await fs.mkdir(mediaDir, { recursive: true });
let state = await loadState();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/api/health') return sendJson(res, 200, { ok: true });
    if (req.method === 'GET' && url.pathname === '/api/state') return sendJson(res, 200, state);
    if (req.method === 'POST' && url.pathname === '/api/reset') {
      await fs.rm(dataFile, { force: true });
      await fs.rm(mediaDir, { recursive: true, force: true });
      await fs.mkdir(mediaDir, { recursive: true });
      state = await loadState();
      return sendJson(res, 200, state);
    }

    if (req.method === 'POST' && url.pathname === '/api/sync') {
      const body = await bodyJson(req);
      const remoteOps = state.ops.filter((op) => op.rev > Number(body.baseRev || 0));
      const result = rebase(body.baseDoc || state.doc, remoteOps, body.ops || []);
      let rev = state.rev;
      const persisted = result.acceptedLocal.map((op) => {
        rev += 1;
        return { ...op, rev };
      });
      state = { doc: result.doc, rev, ops: [...state.ops, ...persisted] };
      await saveState(state);
      return sendJson(res, 200, { server: state, result });
    }

    if (req.method === 'POST' && url.pathname === '/api/publish') {
      const { generationId = `gen_${Date.now().toString(36)}`, reason = 'api-publish' } = await bodyJson(req);
      const at = new Date().toISOString();
      const persisted = { id: uid('op'), type: 'publish', generationId, reason, at, ts: at, rev: state.rev + 1 };
      state.doc = applyOp(state.doc, persisted);
      state.rev = persisted.rev;
      state.ops.push(persisted);
      await saveState(state);
      return sendJson(res, 200, state);
    }

    const consentMatch = url.pathname.match(/^\/api\/consents\/([^/]+)\/withdraw$/);
    if (req.method === 'POST' && consentMatch) {
      const personId = decodeURIComponent(consentMatch[1]);
      const generationId = `gen_${Date.now().toString(36)}`;
      const at = new Date().toISOString();
      const persisted = { id: uid('op'), type: 'withdrawConsent', personId, generationId, at, ts: at, rev: state.rev + 1 };
      state.doc = applyOp(state.doc, persisted);
      state.rev = persisted.rev;
      state.ops.push(persisted);
      await saveState(state);
      return sendJson(res, 200, { server: state, generationId });
    }

    const jobMatch = url.pathname.match(/^\/api\/media-jobs\/([^/]+)$/);
    if (req.method === 'PATCH' && jobMatch) {
      const jobId = decodeURIComponent(jobMatch[1]);
      const patch = await bodyJson(req);
      if (!state.doc.mediaJobs[jobId]) return sendJson(res, 404, { error: 'job not found' });
      Object.assign(state.doc.mediaJobs[jobId], patch, { updatedAt: new Date().toISOString() });
      if (patch.state === 'done') state.doc.photos[state.doc.mediaJobs[jobId].photoId].status = 'ready';
      await saveState(state);
      return sendJson(res, 200, state.doc.mediaJobs[jobId]);
    }

    const mediaMatch = url.pathname.match(/^\/api\/media\/([^/]+)$/);
    if (req.method === 'PUT' && mediaMatch) {
      const id = decodeURIComponent(mediaMatch[1]);
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      await fs.writeFile(path.join(mediaDir, id), Buffer.concat(chunks));
      return sendJson(res, 200, { id, bytes: Buffer.concat(chunks).length });
    }
    if (req.method === 'GET' && mediaMatch) {
      const file = path.join(mediaDir, decodeURIComponent(mediaMatch[1]));
      try {
        const data = await fs.readFile(file);
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=300' });
        return res.end(data);
      } catch {
        res.writeHead(404); return res.end('not found');
      }
    }

    if (req.method === 'GET') return serveStatic(req, res);
    sendJson(res, 405, { error: 'method not allowed' });
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(port, () => console.log(`Travel API listening on http://localhost:${port}`));
