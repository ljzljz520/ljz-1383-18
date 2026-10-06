import {
  applyOp,
  buildSnapshot,
  clone,
  createSeedDoc,
  publishAll,
  rebase,
  uid,
} from './kernel.js';

const SERVER_KEY = 'travel.server.v1';
const ONLINE_KEY = 'travel.online';
const INTERRUPT_KEY = 'travel.media.interrupt';
const DB_NAME = 'travel-media-v1';
const STORE = 'blobs';

export function now() { return new Date().toISOString(); }

export function openMediaDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function idbRequest(storeName, mode, run) {
  const db = await openMediaDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = run(tx.objectStore(STORE));
    let result;
    request.addEventListener('success', () => { result = request.result; });
    tx.oncomplete = () => resolve(result);
    request.addEventListener('error', () => reject(request.error));
    tx.onerror = () => reject(tx.error);
  });
}
export const idbPut = (key, blob) => idbRequest(STORE, 'readwrite', (store) => store.put(blob, key));
export const idbGet = async (key) => (await idbRequest(STORE, 'readonly', (store) => store.get(key))) || null;
export const idbDelete = (key) => idbRequest(STORE, 'readwrite', (store) => store.delete(key));
export const idbKeys = async () => (await idbRequest(STORE, 'readonly', (store) => store.getAllKeys())) || [];

function createServerState() {
  let doc = createSeedDoc();
  doc = applyOp(doc, {
    id: uid('op'), type: 'addShare', at: now(),
    share: {
      id: 'sh_family', label: '给家人的白名单版本', mode: 'snapshot',
      chapterIds: ['ch_harbor', 'ch_ridge'],
      unitIds: ['b_harbor_text', 'b_harbor_photo', 'b_harbor_map', 'b_ridge_text', 'b_ridge_map'],
      allow: { names: true, contacts: false, preciseLocation: false },
      status: 'active',
    },
  });
  doc = publishAll(doc, 'gen_seed_001', now(), 'initial-publish');
  return { doc, rev: doc.rev, ops: [] };
}
const readJSON = (key) => {
  const raw = localStorage.getItem(key);
  return raw ? JSON.parse(raw) : null;
};
const writeJSON = (key, value) => localStorage.setItem(key, JSON.stringify(value));

export class Repository extends EventTarget {
  constructor(clientId = 'main', options = {}) {
    super();
    this.clientId = clientId;
    this.clientKey = `travel.client.${clientId}.v1`;
    this.apiMode = false;
    this.manualOffline = false;
    this.ready = this.init(options);
    window.addEventListener('storage', (event) => {
      if (event.key === SERVER_KEY || event.key === this.clientKey || event.key === ONLINE_KEY) this.dispatchEvent(new CustomEvent('change'));
    });
  }

  async init(options = {}) {
    if (localStorage.getItem(ONLINE_KEY) === '0') this.manualOffline = true;
    if (options.forceMock || location.protocol === 'file:') {
      this.ensureMock();
      return;
    }
    try {
      const response = await fetch('/api/state', { cache: 'no-store' });
      if (!response.ok) throw new Error('bad state');
      const server = await response.json();
      this.apiMode = true;
      writeJSON(SERVER_KEY, server);
      this.ensureClient(server);
    } catch {
      this.apiMode = false;
      this.ensureMock();
    }
  }

  ensureMock() {
    if (!localStorage.getItem(SERVER_KEY)) writeJSON(SERVER_KEY, createServerState());
    this.ensureClient(this.server);
  }
  ensureClient(server) {
    if (!localStorage.getItem(this.clientKey)) {
      writeJSON(this.clientKey, {
        doc: clone(server.doc), baseDoc: clone(server.doc), baseRev: server.rev,
        outbox: [], conflicts: [],
      });
    }
  }

  get server() { return readJSON(SERVER_KEY); }
  set server(value) { writeJSON(SERVER_KEY, value); }
  get state() { return readJSON(this.clientKey); }
  set state(value) { writeJSON(this.clientKey, value); }
  get online() { return !this.manualOffline; }
  set online(value) {
    this.manualOffline = !value;
    localStorage.setItem(ONLINE_KEY, value ? '1' : '0');
  }
  get doc() { return this.state.doc; }

  async reset() {
    if (this.apiMode) {
      const response = await fetch('/api/reset', { method: 'POST' });
      const server = await response.json();
      writeJSON(SERVER_KEY, server);
    } else {
      localStorage.removeItem(SERVER_KEY);
      const server = createServerState();
      this.server = server;
    }
    localStorage.removeItem(this.clientKey);
    localStorage.removeItem(INTERRUPT_KEY);
    await this.ready;
    this.ensureClient(this.server);
    this.dispatchEvent(new CustomEvent('change'));
  }

  makeOp(type, patch = {}) {
    const at = now();
    return { id: uid('op'), clientId: this.clientId, type, at, ts: at, ...patch };
  }
  mutate(op) {
    const state = this.state;
    state.doc = applyOp(state.doc, op);
    state.outbox.push(op);
    this.state = state;
    this.dispatchEvent(new CustomEvent('change', { detail: { op } }));
    return op;
  }

  updateJob(jobId, patch) {
    const state = this.state;
    if (!state.doc.mediaJobs[jobId]) return;
    Object.assign(state.doc.mediaJobs[jobId], patch, { updatedAt: now() });
    if (patch.state === 'done') state.doc.photos[state.doc.mediaJobs[jobId].photoId].status = 'ready';
    this.state = state;

    const cached = this.server;
    if (!cached.doc.mediaJobs[jobId]) cached.doc.mediaJobs[jobId] = clone(state.doc.mediaJobs[jobId]);
    Object.assign(cached.doc.mediaJobs[jobId], patch, { updatedAt: now() });
    if (patch.state === 'done') cached.doc.photos[cached.doc.mediaJobs[jobId].photoId].status = 'ready';
    this.server = cached;

    if (this.apiMode) {
      fetch(`/api/media-jobs/${encodeURIComponent(jobId)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      }).catch(() => {});
    }
    this.dispatchEvent(new CustomEvent('change'));
  }

  enqueueMediaJob(job) {
    const photo = this.doc.photos[job.photoId];
    this.mutate(this.makeOp('updatePhoto', {
      photoId: job.photoId,
      patch: {
        status: 'processing', derivativeId: job.targetDerivativeId,
        mediaVersion: job.kind.includes('initial') ? 0 : (photo.mediaVersion || 0),
      },
    }));
    this.mutate(this.makeOp('queueMediaJob', { job: { ...job, createdAt: now(), updatedAt: now() } }));
  }

  async sync({ purge = false, preserveConflicts = [] } = {}) {
    const before = this.state;
    let result;
    let server;

    if (this.apiMode) {
      const response = await fetch('/api/sync', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseDoc: before.baseDoc, baseRev: before.baseRev, ops: before.outbox }),
      });
      if (!response.ok) throw new Error(await response.text());
      const payload = await response.json();
      server = payload.server;
      result = payload.result;
      this.server = server;
    } else {
      server = this.server;
      const remoteOps = server.ops.filter((op) => op.rev > before.baseRev);
      result = rebase(before.baseDoc, remoteOps, before.outbox);
      let rev = server.rev;
      const persistedOps = result.acceptedLocal.map((op) => {
        rev += 1;
        return { ...op, rev };
      });
      server = { doc: result.doc, rev, ops: [...server.ops, ...persistedOps] };
      this.server = server;
    }

    const conflicts = [...preserveConflicts, ...result.conflicts];
    this.state = {
      doc: clone(result.doc), baseDoc: clone(result.doc), baseRev: server.rev,
      outbox: [], conflicts,
    };
    if (purge) await this.purgeStaleContent(result.doc, conflicts);
    this.dispatchEvent(new CustomEvent('change', { detail: { conflicts } }));
    return { ...result, conflicts };
  }

  async purgeStaleContent(doc = this.doc, preservedConflicts = []) {
    const activeGeneration = doc.activeGenerationId;
    const activeDerivatives = new Set();
    for (const share of Object.values(doc.shares || {})) {
      if (share.status !== 'active' || share.generationId !== activeGeneration) continue;
      const snapshot = doc.snapshots[share.snapshotId] || buildSnapshot(doc, share, activeGeneration);
      Object.values(snapshot.photos || {}).forEach((photo) => activeDerivatives.add(photo.derivativeId));
    }
    for (const key of await idbKeys()) {
      if (!activeDerivatives.has(key) && !String(key).endsWith('.original')) await idbDelete(key);
    }
    if (navigator.serviceWorker?.controller) {
      await navigator.serviceWorker.controller.postMessage({ type: 'PURGE_SHARES', activeGeneration });
    }
    if (doc.copies.copy_this_browser) {
      this.mutate(this.makeOp('checkinCopy', { copyId: 'copy_this_browser', generationId: activeGeneration }));
      if (this.apiMode || !this.manualOffline) await this.sync({ preserveConflicts: preservedConflicts });
    }
  }

  interruptMedia() { localStorage.setItem(INTERRUPT_KEY, '1'); }
  clearInterrupt() { localStorage.removeItem(INTERRUPT_KEY); }
  shouldInterrupt() { return localStorage.getItem(INTERRUPT_KEY) === '1'; }
}
