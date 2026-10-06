import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { startServer } from './server-harness.mjs';

const { base, stop } = await startServer(18789);

async function loadShare(url) {
  const dom = new JSDOM('<!doctype html><html><body><main id="share-root"></main></body></html>', {
    url, runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const { window } = dom;
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.location = window.location;
  globalThis.navigator = window.navigator;
  const nativeFetch = globalThis.fetch;
  window.fetch = (resource, init) => nativeFetch(new URL(resource, url).href, init);
  window.navigator.serviceWorker = { register: async () => ({}), addEventListener() {}, controller: null };
  const script = await (await nativeFetch(`${base}/js/travel/share.js`)).text();
  window.eval(script);
  await new Promise((resolve) => setTimeout(resolve, 100));
  return window.document.body.textContent;
}

await fetch(`${base}/api/reset`, { method: 'POST' });
const validText = await loadShare(`${base}/travel/share.html?share=sh_family&g=gen_seed_001`);
assert.match(validText, /访客视图已验证/);
assert.match(validText, /约 10 公里/);
assert.doesNotMatch(validText, /lan@example\.com/);

const staleText = await loadShare(`${base}/travel/share.html?share=sh_family&g=gen_cached_old&stale=1`);
assert.match(staleText, /缓存版本不可显示/);
assert.match(staleText, /没有回退到旧缓存正文/);
console.log('✓ 分享页：当前代次可显示，旧链接显示墓碑而非缓存私人内容');
stop();
