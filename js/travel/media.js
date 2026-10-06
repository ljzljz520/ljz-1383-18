import { idbGet, idbPut, now } from './repository.js';

const palette = [
  ['#0ea5e9', '#8b5cf6'],
  ['#f59e0b', '#ef4444'],
  ['#10b981', '#0f766e'],
];

function colorFor(id) {
  let sum = 0;
  for (const char of id) sum += char.charCodeAt(0);
  return palette[sum % palette.length];
}

export function drawOriginal(photoId, title) {
  const canvas = document.createElement('canvas');
  canvas.width = 900;
  canvas.height = 540;
  const ctx = canvas.getContext('2d');
  const [a, b] = colorFor(photoId);
  const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
  gradient.addColorStop(0, a);
  gradient.addColorStop(1, b);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'rgba(255,255,255,.92)';
  ctx.font = 'bold 42px system-ui, sans-serif';
  ctx.fillText(title || photoId, 48, 90);
  ctx.font = '24px system-ui, sans-serif';
  ctx.fillText('ORIGINAL · 含 EXIF / 人像区域', 48, 470);
  ctx.beginPath();
  ctx.arc(650, 250, 92, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,225,180,.95)';
  ctx.fill();
  return canvas;
}

export function drawSafe(originalCanvas, title, mode = 'safe') {
  const canvas = document.createElement('canvas');
  canvas.width = originalCanvas.width;
  canvas.height = originalCanvas.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(originalCanvas, 0, 0);

  if (mode === 'blur') {
    const face = { x: 555, y: 155, w: 190, h: 190 };
    ctx.filter = 'blur(22px)';
    ctx.drawImage(originalCanvas, face.x, face.y, face.w, face.h, face.x, face.y, face.w, face.h);
    ctx.filter = 'none';
    ctx.fillStyle = 'rgba(15,23,42,.58)';
    ctx.fillRect(40, 408, 500, 72);
    ctx.fillStyle = '#fff';
    ctx.font = '24px system-ui, sans-serif';
    ctx.fillText('许可撤回：同框区域已重新遮蔽', 62, 455);
  }

  // 衍生物不复制 EXIF；同时加版本水印，旧缓存可被 Service Worker 识别。
  ctx.fillStyle = 'rgba(2,6,23,.38)';
  ctx.fillRect(650, 460, 210, 42);
  ctx.fillStyle = '#fff';
  ctx.font = '20px monospace';
  ctx.fillText(mode === 'blur' ? 'redacted v+1' : 'gps stripped', 665, 488);
  return canvas;
}

function canvasToBlob(canvas) {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.86));
}

export async function createOriginalBlob(photoId, title) {
  const blob = await canvasToBlob(drawOriginal(photoId, title));
  await idbPut(`${photoId}.original`, blob);
  return blob;
}

export async function processMediaJob(repo, jobId, { steps = 8 } = {}) {
  const doc = repo.doc;
  const job = doc.mediaJobs[jobId];
  if (!job) throw new Error(`未知媒体任务 ${jobId}`);
  if (job.state === 'done') return idbGet(job.targetDerivativeId);

  const photo = doc.photos[job.photoId];
  let originalBlob = await idbGet(`${photo.id}.original`);
  if (!originalBlob) originalBlob = await createOriginalBlob(photo.id, photo.name);
  const source = await createImageBitmap(originalBlob);
  const originalCanvas = document.createElement('canvas');
  originalCanvas.width = source.width;
  originalCanvas.height = source.height;
  originalCanvas.getContext('2d').drawImage(source, 0, 0);

  const start = job.progress || 0;
  for (let progress = start; progress <= 100; progress += Math.ceil(100 / steps)) {
    await new Promise((resolve) => setTimeout(resolve, 130));
    if (repo.shouldInterrupt()) {
      repo.updateJob(jobId, { state: 'interrupted', progress });
      repo.clearInterrupt();
      throw Object.assign(new Error('媒体处理被中断'), { code: 'MEDIA_INTERRUPTED', progress });
    }
    repo.updateJob(jobId, { state: 'processing', progress: Math.min(progress, 96), attempts: (job.attempts || 0) + 1 });
  }

  const safe = drawSafe(originalCanvas, photo.name, job.kind.includes('withdrawn') ? 'blur' : 'safe');
  const blob = await canvasToBlob(safe);
  await idbPut(job.targetDerivativeId, blob);
  repo.updateJob(jobId, { state: 'done', progress: 100, finishedAt: now() });
  return blob;
}
