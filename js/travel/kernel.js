// 旅行影集叙事编辑器：纯数据内核。
// 不依赖 DOM/IndexedDB，可同时被浏览器、Mock API 与 Node 测试复用。

export const REPLACEMENTS = {
  person: '［同行人信息已隐藏］',
  withdrawn: '［应同行人撤回许可，此内容已重新生成］',
  contact: '［联系方式已隐藏］',
  coordinate: '［精确位置已隐藏］',
  node: '［已撤下的地点］',
};

export function uid(prefix = 'id') {
  if (globalThis.crypto?.randomUUID) return `${prefix}_${crypto.randomUUID()}`;
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function tsOf(op) {
  return op.ts || op.at || '';
}

function shouldSet(doc, path, ts) {
  if (!ts) return true;
  const old = doc.fieldClock?.[path] || '';
  return ts > old;
}

function markField(doc, path, ts) {
  if (!ts) return;
  doc.fieldClock[path] = ts;
}

// ---------- 分数位排序：拖动只改变位置，不改变实体或引用 ----------
function rational(position, fallback) {
  if (!position) return fallback;
  const match = /^0\.(\d+)$/.exec(position);
  if (!match) throw new Error(`非法位置: ${position}`);
  const digits = match[1].replace(/0+$/, '');
  return { n: BigInt(digits || '0'), s: digits.length };
}

export function positionBetween(left, right) {
  const a = rational(left, { n: 0n, s: 0 });
  const b = rational(right, { n: 1n, s: 0 });
  const scale = Math.max(a.s, b.s);
  const an = a.n * 10n ** BigInt(scale - a.s);
  const bn = b.n * 10n ** BigInt(scale - b.s);
  if (an >= bn) throw new Error('左侧位置必须小于右侧位置');
  let n = (an + bn) * 5n;
  let s = scale + 1;
  while (s > 0 && n % 10n === 0n) {
    n /= 10n;
    s -= 1;
  }
  if (s === 0) return '1';
  return `0.${n.toString().padStart(s, '0')}`;
}

export function comparePosition(a, b) {
  const left = rational(a, { n: 0n, s: 0 });
  const right = rational(b, { n: 1n, s: 0 });
  const s = Math.max(left.s, right.s);
  const ln = left.n * 10n ** BigInt(s - left.s);
  const rn = right.n * 10n ** BigInt(s - right.s);
  return ln < rn ? -1 : ln > rn ? 1 : 0;
}

export function sortedByPosition(items) {
  return [...items].sort((a, b) => comparePosition(a.pos, b.pos));
}

function positionAround(items, id, newPos, ts) {
  const collision = items.find((item) => item.id !== id && item.pos === newPos);
  if (!collision) return newPos;
  const ordered = sortedByPosition(items.filter((item) => item.id !== id));
  const index = ordered.findIndex((item) => item.id === collision.id);
  const current = items.find((item) => item.id === id);
  // 较晚的移动排在碰撞点之后；较早的移动排在之前。
  const afterCollision = !current?.posTs || ts >= (collision.posTs || '');
  if (afterCollision) {
    return positionBetween(collision.pos, ordered[index + 1]?.pos || null);
  }
  return positionBetween(index > 0 ? ordered[index - 1].pos : null, collision.pos);
}

// ---------- 示例数据 ----------
export function createSeedDoc(at = new Date().toISOString()) {
  const p1 = positionBetween(null, null);
  const p2 = positionBetween(p1, null);
  const b11 = positionBetween(null, null);
  const b12 = positionBetween(b11, null);
  const b13 = positionBetween(b12, null);
  const b21 = positionBetween(null, null);
  const b22 = positionBetween(b21, null);

  return {
    schema: 1,
    rev: 0,
    fieldClock: {},
    trip: {
      id: 'trip',
      title: '海风与山径',
      purpose: '用五章记录一次以海岸、古道和同行人为线索的旅行，而不是堆放照片。',
    },
    chapters: {
      ch_harbor: {
        id: 'ch_harbor',
        title: '第一章：白石港的清晨',
        summary: '林岚与我在港口集合；这里也是整条路线的起点。',
        pos: p1,
        posTs: at,
      },
      ch_ridge: {
        id: 'ch_ridge',
        title: '第二章：翻过鹰嘴岩',
        summary: '从白石港沿山脊向上，精确营地只对亲密朋友公开。',
        pos: p2,
        posTs: at,
      },
    },
    blocks: {
      b_harbor_text: {
        id: 'b_harbor_text',
        chapterId: 'ch_harbor',
        type: 'text',
        text: '林岚和我在六点半到达白石港。备用联系方式：lan@example.com。',
        personIds: ['p_lan'],
        pos: b11,
      },
      b_harbor_photo: {
        id: 'b_harbor_photo',
        chapterId: 'ch_harbor',
        type: 'photo',
        photoId: 'ph_harbor',
        pos: b12,
      },
      b_harbor_map: {
        id: 'b_harbor_map',
        chapterId: 'ch_harbor',
        type: 'map',
        nodeId: 'n_harbor',
        pos: b13,
      },
      b_ridge_text: {
        id: 'b_ridge_text',
        chapterId: 'ch_ridge',
        type: 'text',
        text: '午后到达营地，GPS 记录为 24.55550,118.11110。林岚先去取水。',
        personIds: ['p_lan'],
        pos: b21,
      },
      b_ridge_map: {
        id: 'b_ridge_map',
        chapterId: 'ch_ridge',
        type: 'map',
        nodeId: 'n_camp',
        pos: b22,
      },
    },
    photos: {
      ph_harbor: {
        id: 'ph_harbor',
        name: '港口晨光',
        caption: '林岚在白石港码头检查路线。',
        nodeId: 'n_harbor',
        personIds: ['p_lan'],
        regions: [{ personId: 'p_lan', x: 0.34, y: 0.22, w: 0.22, h: 0.42 }],
        exif: { lat: 24.5555, lng: 118.1111 },
        mediaId: 'ph_harbor.original',
        derivativeId: 'ph_harbor.v0.safe',
        mediaVersion: 0,
        status: 'ready',
      },
    },
    nodes: {
      n_harbor: {
        id: 'n_harbor',
        name: '白石港码头',
        address: '白石港渔业路 12 号',
        lat: 24.5555,
        lng: 118.1111,
        chapterId: 'ch_harbor',
        status: 'active',
      },
      n_camp: {
        id: 'n_camp',
        name: '鹰嘴岩营地',
        address: '鹰嘴岩北侧避风处',
        lat: 24.5555,
        lng: 118.1111,
        chapterId: 'ch_ridge',
        status: 'active',
      },
    },
    people: {
      p_lan: {
        id: 'p_lan',
        name: '林岚',
        contact: 'lan@example.com / +86 138-0000-1234',
      },
    },
    consents: {
      p_lan: { personId: 'p_lan', status: 'granted', version: 1, grantedAt: at, updatedAt: at },
    },
    shares: {},
    snapshots: {},
    generations: {},
    activeGenerationId: null,
    copies: {
      copy_this_browser: {
        id: 'copy_this_browser',
        label: '本机受控离线缓存',
        kind: 'controlled',
        knownGenerationId: null,
        purgeRequired: false,
        purgedAt: null,
        lastSeenAt: null,
      },
      copy_downloaded: {
        id: 'copy_downloaded',
        label: '访客已下载的 JPEG / PDF / 转发附件',
        kind: 'external',
        knownGenerationId: null,
        state: 'unreachable',
      },
    },
    mediaJobs: {},
    tombs: {},
    audit: [],
  };
}

// ---------- 文本与位置投影 ----------
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceAll(text, term, replacement) {
  if (!term || term.length < 2) return text;
  return text.replace(new RegExp(escapeRegExp(term), 'g'), replacement);
}

export function coarsePoint(lat, lng) {
  return {
    lat: Math.round(lat * 10) / 10,
    lng: Math.round(lng * 10) / 10,
    precision: '约 10 公里范围',
  };
}

export function projectText(doc, raw, options = {}) {
  if (!raw) return '';
  const allow = { names: true, contacts: true, preciseLocation: true, ...options.allow };
  let text = String(raw);

  for (const person of Object.values(doc.people || {})) {
    const withdrawn = doc.consents[person.id]?.status === 'withdrawn';
    if (withdrawn) {
      text = replaceAll(text, person.name, REPLACEMENTS.withdrawn);
      text = replaceAll(text, person.contact, REPLACEMENTS.withdrawn);
    } else {
      if (!allow.names) text = replaceAll(text, person.name, '同行人');
      if (!allow.contacts) text = replaceAll(text, person.contact, REPLACEMENTS.contact);
    }
  }

  if (!allow.contacts) {
    text = text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, REPLACEMENTS.contact);
    text = text.replace(/(?:\+?\d[\d\s-]{7,}\d)/g, REPLACEMENTS.contact);
  }
  if (!allow.preciseLocation) {
    text = text.replace(/-?\d{1,2}\.\d{3,}\s*[,，]\s*-?\d{1,3}\.\d{3,}/g, REPLACEMENTS.coordinate);
  }
  for (const node of Object.values(doc.nodes || {})) {
    if (node.status === 'removed') {
      text = replaceAll(text, node.name, REPLACEMENTS.node);
      text = replaceAll(text, node.address, REPLACEMENTS.node);
    }
  }
  return text;
}

export function hashString(value) {
  let h = 1779033703 ^ value.length;
  for (let i = 0; i < value.length; i++) {
    h = Math.imul(h ^ value.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

const MISSING = {
  photo: '［照片引用已失效］',
  node: '［地图节点已失效］',
};

export function buildSnapshot(doc, share, generationId) {
  const selectedChapters = new Set(share.chapterIds || []);
  const units = new Set(share.unitIds || []);
  const allow = { names: true, contacts: false, preciseLocation: false, ...share.allow };
  const chapters = {};
  const blocks = {};
  const photos = {};
  const nodes = {};
  const index = [];
  const removedRefs = [];

  const chapterList = sortedByPosition(Object.values(doc.chapters)).filter((c) => selectedChapters.has(c.id));
  for (const chapter of chapterList) {
    const title = projectText(doc, chapter.title, { allow });
    const summary = projectText(doc, chapter.summary, { allow });
    chapters[chapter.id] = { id: chapter.id, title, summary, pos: chapter.pos };
    index.push({ ref: `chapter:${chapter.id}`, type: 'chapter', chapterId: chapter.id, text: title });
  }

  const visibleBlocks = sortedByPosition(Object.values(doc.blocks)).filter((block) => {
    if (!selectedChapters.has(block.chapterId)) return false;
    if (share.mode === 'snapshot' && !units.has(block.id)) return false;
    if (block.type === 'map') {
      const node = doc.nodes[block.nodeId];
      if (!node || node.status === 'removed') {
        removedRefs.push({ type: 'map-block', blockId: block.id, nodeId: block.nodeId });
        return false;
      }
    }
    if (block.type === 'photo' && !doc.photos[block.photoId]) {
      removedRefs.push({ type: 'photo-block', blockId: block.id, photoId: block.photoId });
      return false;
    }
    return true;
  });

  for (const block of visibleBlocks) {
    const base = { id: block.id, chapterId: block.chapterId, type: block.type, pos: block.pos };
    if (block.type === 'text') {
      const text = projectText(doc, block.text, { allow });
      blocks[block.id] = { ...base, text };
      index.push({ ref: `block:${block.id}`, type: 'paragraph', chapterId: block.chapterId, text });
    } else if (block.type === 'photo') {
      const photo = doc.photos[block.photoId];
      blocks[block.id] = { ...base, photoId: block.photoId };
      const visiblePhoto = projectPhoto(doc, photo, allow);
      photos[photo.id] = visiblePhoto;
      index.push({
        ref: `photo:${photo.id}`,
        type: 'photo',
        chapterId: block.chapterId,
        text: visiblePhoto.caption,
      });
    } else if (block.type === 'map') {
      const node = doc.nodes[block.nodeId];
      blocks[block.id] = { ...base, nodeId: node.id };
      const projected = projectNode(node, allow);
      nodes[node.id] = projected;
      index.push({ ref: `node:${node.id}`, type: 'node', chapterId: block.chapterId, text: projected.name });
    }
  }

  // 白名单模式也允许直接选中尚未放入段落的照片/节点。
  if (share.mode === 'snapshot') {
    for (const id of units) {
      if (id.startsWith('ph_') && doc.photos[id] && !photos[id]) {
        photos[id] = projectPhoto(doc, doc.photos[id], allow);
      }
      if (id.startsWith('n_') && doc.nodes[id] && doc.nodes[id].status !== 'removed' && !nodes[id]) {
        nodes[id] = projectNode(doc.nodes[id], allow);
      }
    }
  }

  const payload = JSON.stringify({ chapters, blocks, photos, nodes, allow, generationId });
  return {
    id: `${share.id}@${generationId}`,
    shareId: share.id,
    generationId,
    mode: share.mode,
    publishedAt: share.publishedAt || new Date().toISOString(),
    allow,
    chapters,
    blocks,
    photos,
    nodes,
    index,
    removedRefs,
    contentHash: hashString(payload),
  };
}

function projectPhoto(doc, photo, allow) {
  const people = [];
  const withdrawnPersonIds = [];
  for (const personId of photo.personIds || []) {
    const person = doc.people[personId];
    const withdrawn = doc.consents[personId]?.status === 'withdrawn';
    if (withdrawn) withdrawnPersonIds.push(personId);
    people.push(withdrawn || !allow.names ? '同行人' : person?.name || '同行人');
  }
  const linkedNode = photo.nodeId ? doc.nodes[photo.nodeId] : null;
  const precise = allow.preciseLocation && linkedNode?.status !== 'removed';
  return {
    id: photo.id,
    name: projectText(doc, photo.name, { allow }),
    caption: projectText(doc, photo.caption, { allow }),
    nodeId: linkedNode?.status === 'removed' ? null : photo.nodeId,
    people,
    derivativeId: photo.derivativeId || `${photo.id}.processing`,
    mediaState: withdrawnPersonIds.length ? 'regenerated-blur' : photo.status || 'ready',
    withdrawnPersonIds,
    location: precise
      ? { lat: photo.exif?.lat ?? linkedNode?.lat, lng: photo.exif?.lng ?? linkedNode?.lng, precision: 'exact' }
      : { ...coarsePoint(photo.exif?.lat ?? linkedNode?.lat ?? 0, photo.exif?.lng ?? linkedNode?.lng ?? 0), gpsStripped: true },
  };
}

function projectNode(node, allow) {
  if (allow.preciseLocation) {
    return { id: node.id, name: node.name, lat: node.lat, lng: node.lng, precision: 'exact' };
  }
  const coarse = coarsePoint(node.lat, node.lng);
  return { id: node.id, name: node.name, ...coarse };
}

export function publishAll(doc, generationId, at = new Date().toISOString(), reason = 'publish') {
  const next = clone(doc);
  next.activeGenerationId = generationId;
  next.generations[generationId] = {
    id: generationId,
    at,
    reason,
    parentGenerationId: doc.activeGenerationId || null,
    shareIds: [],
  };

  for (const share of Object.values(next.shares)) {
    if (share.status !== 'active') continue;
    share.publishedAt = at;
    share.generationId = generationId;
    share.snapshotId = `${share.id}@${generationId}`;
    const snapshot = buildSnapshot(next, share, generationId);
    next.snapshots[snapshot.id] = snapshot;
    next.generations[generationId].shareIds.push(share.id);
  }

  for (const copy of Object.values(next.copies)) {
    if (copy.kind === 'controlled') {
      copy.oldGenerationId = copy.knownGenerationId;
      copy.purgeRequired = copy.knownGenerationId && copy.knownGenerationId !== generationId;
      copy.knownGenerationId = generationId;
    } else {
      copy.knownGenerationId = copy.knownGenerationId || generationId;
      copy.state = 'unreachable';
    }
  }

  next.audit.push({ at, type: 'publish', generationId, reason });
  return next;
}

// ---------- 许可撤回影响分析与级联 ----------
export function analyzeConsentImpact(doc, personId) {
  const photoIds = new Set();
  const blockIds = new Set();
  const person = doc.people[personId];
  for (const photo of Object.values(doc.photos || {})) {
    if ((photo.personIds || []).includes(personId)) photoIds.add(photo.id);
  }
  for (const block of Object.values(doc.blocks || {})) {
    if ((block.personIds || []).includes(personId)) blockIds.add(block.id);
    if (block.type === 'photo' && photoIds.has(block.photoId)) blockIds.add(block.id);
    if (person && (block.text || '').includes(person.name)) blockIds.add(block.id);
  }
  const snapshotIds = Object.values(doc.shares || {})
    .filter((s) => s.status === 'active' && s.snapshotId)
    .map((s) => s.snapshotId);
  return {
    personId,
    photoIds: [...photoIds],
    blockIds: [...blockIds],
    snapshotIds,
    indexIds: snapshotIds,
    controlledCopyIds: Object.values(doc.copies || {}).filter((c) => c.kind === 'controlled').map((c) => c.id),
    externalCopyIds: Object.values(doc.copies || {}).filter((c) => c.kind === 'external').map((c) => c.id),
  };
}

export function withdrawConsent(doc, personId, generationId, at = new Date().toISOString()) {
  if (!doc.people[personId]) throw new Error(`未知同行人: ${personId}`);
  const impact = analyzeConsentImpact(doc, personId);
  const next = clone(doc);
  const old = next.consents[personId] || { version: 0 };
  next.consents[personId] = {
    personId,
    status: 'withdrawn',
    version: (old.version || 0) + 1,
    updatedAt: at,
    withdrawnAt: at,
  };

  for (const photoId of impact.photoIds) {
    const photo = next.photos[photoId];
    photo.mediaVersion += 1;
    photo.derivativeId = `${photo.id}.v${photo.mediaVersion}.blur`;
    photo.regeneratedAt = at;
    const jobId = `job_${photoId}_v${photo.mediaVersion}`;
    next.mediaJobs[jobId] = {
      id: jobId,
      photoId,
      kind: 'withdrawn-person-blur',
      targetDerivativeId: photo.derivativeId,
      personId,
      state: 'queued',
      progress: 0,
      attempts: 0,
      createdAt: at,
      updatedAt: at,
    };
  }

  for (const blockId of impact.blockIds) {
    next.blocks[blockId].regeneratedAt = at;
  }

  next.audit.push({ at, type: 'consent-withdrawn', personId, impact });
  return publishAll(next, generationId, at, `consent-withdrawn:${personId}`);
}

// ---------- 操作归约 ----------
export function applyOp(input, op) {
  const doc = clone(input);
  doc.rev += 1;
  const ts = tsOf(op);
  switch (op.type) {
    case 'setTrip': {
      for (const [key, value] of Object.entries(op.patch || {})) {
        const path = `trip.${key}`;
        if (shouldSet(doc, path, ts)) {
          doc.trip[key] = value;
          markField(doc, path, ts);
        }
      }
      return doc;
    }
    case 'addChapter': {
      const c = op.chapter;
      if (!doc.chapters[c.id]) doc.chapters[c.id] = { ...c, posTs: ts };
      return doc;
    }
    case 'moveChapter': {
      const chapter = doc.chapters[op.chapterId];
      if (chapter && (!chapter.posTs || ts >= chapter.posTs)) {
        chapter.pos = op.pos;
        chapter.posTs = ts;
      }
      return doc;
    }
    case 'updateChapter': {
      const chapter = doc.chapters[op.chapterId];
      if (chapter) for (const [k, v] of Object.entries(op.patch || {})) {
        const path = `chapter.${op.chapterId}.${k}`;
        if (shouldSet(doc, path, ts)) { chapter[k] = v; markField(doc, path, ts); }
      }
      return doc;
    }
    case 'addBlock': {
      const b = op.block;
      if (!doc.blocks[b.id]) doc.blocks[b.id] = { ...b };
      return doc;
    }
    case 'moveBlock': {
      const block = doc.blocks[op.blockId];
      if (block && (!block.posTs || ts >= block.posTs)) {
        block.chapterId = op.chapterId;
        block.pos = op.pos;
        block.posTs = ts;
      }
      return doc;
    }
    case 'updateBlock': {
      const block = doc.blocks[op.blockId];
      if (block) for (const [k, v] of Object.entries(op.patch || {})) {
        const path = `block.${op.blockId}.${k}`;
        if (shouldSet(doc, path, ts)) { block[k] = v; markField(doc, path, ts); }
      }
      return doc;
    }
    case 'addPhoto':
      if (!doc.photos[op.photo.id]) doc.photos[op.photo.id] = { ...op.photo };
      return doc;
    case 'updatePhoto': {
      const photo = doc.photos[op.photoId];
      if (photo) for (const [k, v] of Object.entries(op.patch || {})) {
        const path = `photo.${op.photoId}.${k}`;
        if (shouldSet(doc, path, ts)) { photo[k] = v; markField(doc, path, ts); }
      }
      return doc;
    }
    case 'addNode':
      if (!doc.nodes[op.node.id]) doc.nodes[op.node.id] = { ...op.node };
      return doc;
    case 'updateNode': {
      const node = doc.nodes[op.nodeId];
      if (node) for (const [k, v] of Object.entries(op.patch || {})) {
        const path = `node.${op.nodeId}.${k}`;
        if (shouldSet(doc, path, ts)) { node[k] = v; markField(doc, path, ts); }
      }
      return doc;
    }
    case 'removeNode': {
      const node = doc.nodes[op.nodeId];
      if (node) {
        node.status = 'removed';
        node.removedAt = op.at;
      }
      return doc;
    }
    case 'addPerson':
      if (!doc.people[op.person.id]) {
        doc.people[op.person.id] = { ...op.person };
        doc.consents[op.person.id] = { personId: op.person.id, status: 'granted', version: 1, updatedAt: op.at };
      }
      return doc;
    case 'updatePerson': {
      const person = doc.people[op.personId];
      if (person) for (const [k, v] of Object.entries(op.patch || {})) {
        const path = `person.${op.personId}.${k}`;
        if (shouldSet(doc, path, ts)) { person[k] = v; markField(doc, path, ts); }
      }
      return doc;
    }
    case 'withdrawConsent':
      return withdrawConsent(input, op.personId, op.generationId, op.at);
    case 'addShare': {
      if (!doc.shares[op.share.id]) doc.shares[op.share.id] = { status: 'active', ...op.share };
      return doc;
    }
    case 'updateShare': {
      const share = doc.shares[op.shareId];
      if (share) Object.assign(share, op.patch || {}, { updatedAt: op.at });
      return doc;
    }
    case 'publish':
      return publishAll(input, op.generationId, op.at, op.reason || 'publish');
    case 'queueMediaJob': {
      if (!doc.mediaJobs[op.job.id]) doc.mediaJobs[op.job.id] = { ...op.job };
      return doc;
    }
    case 'checkinCopy': {
      const copy = doc.copies[op.copyId];
      if (copy) {
        copy.lastSeenAt = op.at;
        copy.knownGenerationId = op.generationId || copy.knownGenerationId;
        if (copy.knownGenerationId === doc.activeGenerationId) {
          copy.purgeRequired = false;
          copy.purgedAt = op.at;
        }
      }
      return doc;
    }
    default:
      return doc;
  }
}

export function applyOps(doc, ops) {
  return [...ops].sort((a, b) => tsOf(a).localeCompare(tsOf(b)) || a.id.localeCompare(b.id)).reduce(applyOp, doc);
}

// ---------- 离线冲突检测、清理与三路合并 ----------
function existsRefs(doc, op) {
  if ((op.type === 'moveChapter' || op.type === 'updateChapter') && !doc.chapters[op.chapterId]) return false;
  if ((op.type === 'moveBlock' || op.type === 'updateBlock') && !doc.blocks[op.blockId]) return false;
  if (op.type.startsWith('updatePhoto') && !doc.photos[op.photoId]) return false;
  if ((op.type === 'updateNode' || op.type === 'removeNode') && !doc.nodes[op.nodeId]) return false;
  return true;
}

export function scrubInvalidContent(op, doc) {
  const safe = clone(op);
  const removed = [];
  const scrubText = (text, path) => {
    const before = text || '';
    let after = before;
    const hasWithdrawn = Object.values(doc.people || {}).some((person) => doc.consents[person.id]?.status === 'withdrawn');
    for (const person of Object.values(doc.people || {})) {
      if (doc.consents[person.id]?.status === 'withdrawn') {
        after = replaceAll(after, person.name, REPLACEMENTS.withdrawn);
        after = replaceAll(after, person.contact, REPLACEMENTS.withdrawn);
      }
    }
    // 撤回不是字段可见性设置：即使旧离线稿拆分填写邮箱/电话，也不能原样回传。
    if (hasWithdrawn) {
      after = after
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, REPLACEMENTS.withdrawn)
        .replace(/(?:\+?\d[\d\s-]{7,}\d)/g, REPLACEMENTS.withdrawn);
    }
    if (after !== before) removed.push({ path, kind: 'withdrawn-person-info' });
    return after;
  };
  if (safe.type === 'addBlock' || safe.type === 'updateBlock') {
    const target = safe.block || safe.patch;
    if (target && 'text' in target) target.text = scrubText(target.text, 'block.text');
  }
  if (safe.type === 'addPhoto' || safe.type === 'updatePhoto') {
    const target = safe.photo || safe.patch;
    if (target?.personIds) {
      const filtered = target.personIds.filter((id) => doc.consents[id]?.status !== 'withdrawn');
      if (filtered.length !== target.personIds.length) removed.push({ path: 'photo.personIds', kind: 'withdrawn-person-presence' });
      target.personIds = filtered;
    }
    if (target?.regions) target.regions = target.regions.filter((r) => doc.consents[r.personId]?.status !== 'withdrawn');
  }
  if (removed.length) {
    safe.id = `${op.id}:safe`;
    safe.originOpId = op.id;
    safe.scrubbed = true;
    // 安全改写代表服务端接收时的新决定，避免旧时间戳让撤回后的字段 LWW 判定跳过更新。
    safe.at = new Date().toISOString();
    safe.ts = safe.at;
  }
  return { op: safe, changed: removed.length > 0, removed };
}

function fixMoveCollision(doc, op) {
  if (!['moveChapter', 'moveBlock'].includes(op.type)) return op;
  const isChapter = op.type === 'moveChapter';
  const collection = isChapter ? Object.values(doc.chapters) : Object.values(doc.blocks);
  const id = isChapter ? op.chapterId : op.blockId;
  const sameScope = collection.filter((item) => isChapter || item.chapterId === op.chapterId);
  const collision = sameScope.find((item) => item.id !== id && item.pos === op.pos);
  if (!collision) return op;
  const safe = clone(op);
  safe.pos = positionAround(sameScope, id, op.pos, tsOf(op));
  safe.adjustedFromCollision = true;
  return safe;
}

export function rebase(baseDoc, remoteOps, localOps) {
  const remote = applyOps(clone(baseDoc), remoteOps);
  let merged = clone(remote);
  const conflicts = [];
  const acceptedRemote = clone(remoteOps);
  const acceptedLocal = [];

  for (const original of [...localOps].sort((a, b) => tsOf(a).localeCompare(tsOf(b)) || a.id.localeCompare(b.id))) {
    if (!existsRefs(merged, original)) {
      conflicts.push({
        code: 'DELETED_REFERENCE',
        op: original,
        message: '引用的章节、照片或地图节点已在另一台设备删除，操作未合入。',
        resolution: '保留其他设备的删除结果，并把该操作列为冲突。',
      });
      continue;
    }
    const scrubbed = scrubInvalidContent(original, merged);
    let op = fixMoveCollision(merged, scrubbed.op);
    if (scrubbed.changed) {
      conflicts.push({
        code: 'WITHDRAWN_INFO_REUPLOAD',
        op: original,
        safeOp: op,
        removed: scrubbed.removed,
        message: '离线稿包含已被同行人撤回的姓名、联系方式或同框信息，服务器没有接收原文。',
        resolution: '已将本地离线稿替换为重新生成的遮蔽版本，并从待上传队列移除原文。',
      });
    }
    if (op.adjustedFromCollision) {
      conflicts.push({
        code: 'CONCURRENT_REORDER',
        op: original,
        safeOp: op,
        message: '两个标签页同时把内容移到同一位置。',
        resolution: '按操作时间插入相邻空位；仅调整位置，照片、图注和地图引用不变。',
      });
    }
    merged = applyOp(merged, op);
    acceptedLocal.push(op);
  }

  return { doc: merged, acceptedRemote, acceptedLocal, conflicts, remoteDoc: remote };
}

export function checkinCopy(doc, copyId, generationId, at = new Date().toISOString()) {
  return applyOp(doc, { id: uid('op_checkin'), type: 'checkinCopy', copyId, generationId, at, ts: at });
}
