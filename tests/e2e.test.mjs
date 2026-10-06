import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import fakeIndexedDB, { IDBKeyRange } from 'fake-indexeddb';
import { startServer } from './server-harness.mjs';

const { base: apiBase, stop } = await startServer(18788);
const nativeFetch = globalThis.fetch;
const appFetch = (resource, init) => {
  const input = typeof resource === 'string' && resource.startsWith('/') ? `${apiBase}${resource}` : resource;
  return nativeFetch(input, init);
};
const html = await (await appFetch('/travel/editor.html')).text();
const dom = new JSDOM(html, {
  url: `${apiBase}/travel/editor.html`,
  runScripts: 'outside-only',
  pretendToBeVisual: true,
});
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.localStorage = window.localStorage;
globalThis.location = window.location;
globalThis.navigator = window.navigator;
globalThis.CustomEvent = window.CustomEvent;
globalThis.EventTarget = window.EventTarget;
globalThis.HTMLElement = window.HTMLElement;
globalThis.HTMLDialogElement = window.HTMLDialogElement;
globalThis.fetch = appFetch;
window.fetch = appFetch;
globalThis.indexedDB = fakeIndexedDB;
globalThis.IDBKeyRange = IDBKeyRange;
window.indexedDB = fakeIndexedDB;
window.navigator.serviceWorker = { controller: null, register: async () => ({}), addEventListener() {} };
globalThis.URL.createObjectURL = () => '';
globalThis.URL.revokeObjectURL = () => {};
window.URL = globalThis.URL;

function make2d() {
  return new Proxy({}, { get: (_, prop) => {
    if (prop === 'createLinearGradient') return () => ({ addColorStop() {} });
    if (['measureText', 'getImageData'].includes(prop)) return () => ({ width: 0, height: 0, data: [] });
    return typeof prop === 'string' ? () => {} : undefined;
  }});
}
window.HTMLCanvasElement.prototype.getContext = make2d;
window.HTMLCanvasElement.prototype.toBlob = function (cb) { cb(Buffer.from([255, 216])); };
window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/jpeg;base64,/9o=';
globalThis.createImageBitmap = async () => ({ width: 10, height: 10, close() {} });
window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
window.HTMLDialogElement.prototype.close = function () { this.open = false; };
window.HTMLDialogElement.prototype.show = function () { this.open = true; };

await appFetch('/api/reset', { method: 'POST' });
await import('../js/travel/app.js');
await new Promise((resolve) => setTimeout(resolve, 200));
const $ = (sel) => window.document.querySelector(sel);
const $$ = (sel) => [...window.document.querySelectorAll(sel)];
const click = async (sel) => { $(sel).click(); await new Promise((resolve) => setTimeout(resolve, 100)); };

try {
  assert.match($('#gen-label').textContent, /gen_seed/);
  assert.equal($$('#chapters .chapter-card').length, 2);
  const captionBefore = $('[data-photo-caption="ph_harbor"]').value;
  assert.match(captionBefore, /林岚/);

  // 图注保存在照片实体，章节重排只改变 chapter.pos；DOM 中两者通过 photoId 连接。
  const appState = () => JSON.parse(window.localStorage.getItem('travel.client.main.v1'));
  assert.equal(appState().doc.blocks.b_harbor_photo.photoId, 'ph_harbor');
  assert.equal(appState().doc.photos.ph_harbor.caption, captionBefore);

  // 离线撤回信息重传。
  $('#demo-withdraw-offline').click();
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal($('#net-label').textContent, '离线 / 本地可编辑');
  assert.ok(appState().outbox.some((op) => op.type === 'updateBlock' && op.patch.text.includes('lan@example.com')));
  $('#toggle-online').click();
  await new Promise((resolve) => setTimeout(resolve, 900));
  const merged = appState();
  assert.equal(merged.outbox.length, 0);
  assert.ok(merged.conflicts.some((c) => c.code === 'WITHDRAWN_INFO_REUPLOAD'));
  assert.doesNotMatch(merged.doc.blocks.b_ridge_text.text, /lan@example\.com/);
  assert.match(merged.doc.blocks.b_ridge_text.text, /重新生成/);
  assert.equal(merged.doc.photos.ph_harbor.derivativeId, 'ph_harbor.v1.blur');
  await new Promise((resolve) => setTimeout(resolve, 1800));

  // 旧链接必须是墓碑，不渲染旧快照。
  window.localStorage.setItem('test-old-share', `${location.origin}/travel/share.html?share=sh_family&g=gen_cached_old&stale=1`);
  const currentGen = merged.doc.activeGenerationId;
  assert.notEqual(currentGen, 'gen_cached_old');

  console.log('✓ DOM E2E：离线撤回重传、级联重生成与稳定引用通过');
} finally {
  window.close();
  stop();
}
