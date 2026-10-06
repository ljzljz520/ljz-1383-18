// media.js — 媒体异步处理 + 崩溃恢复。处理中断不会导致图注与照片错配（引用按ID，状态占位）。
const db = require('./db');
const crypto = require('crypto');
const uid = () => crypto.randomUUID();
const now = () => Date.now();

const MAX_ATTEMPTS = 3;
let injectCrash = false; // 测试用：在处理中途模拟崩溃
function _setInjectCrash(v) { injectCrash = v; }

function enqueueMedia(mediaId) {
  db.run('INSERT INTO jobs(id,kind,payload,status,attempts,created_at,updated_at) VALUES(?,?,?,?,0,?,?)',
    [uid(), 'process_media', JSON.stringify({ media_id: mediaId }), 'pending', now(), now()]);
}

// 处理一个 pending 任务。返回处理结果。
function processNextJob() {
  const job = db.get("SELECT * FROM jobs WHERE status='pending' ORDER BY created_at LIMIT 1");
  if (!job) return null;
  db.run("UPDATE jobs SET status='running', attempts=attempts+1, updated_at=? WHERE id=?", [now(), job.id]);
  const payload = JSON.parse(job.payload);
  try {
    if (job.kind === 'process_media') {
      const m = db.get('SELECT * FROM media WHERE id=?', [payload.media_id]);
      if (!m) throw new Error('media not found');
      // —— 模拟处理：生成尺寸与缩略变体 ——
      const width = 1600, height = 1067;
      if (injectCrash) { // 崩溃点：已标记 running 但未完成，进程“死掉”
        const err = new Error('simulated crash during media processing');
        err.simulated = true; throw err;
      }
      db.persist(); // 落盘（事务外单步）
      db.run("UPDATE media SET status='ready', width=?, height=?, updated_at=? WHERE id=?", [width, height, now(), m.id]);
      db.run('INSERT INTO derivatives(id,album_id,kind,ref_type,ref_id,generation,payload,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
        [uid(), m.album_id, 'image_variant', 'media', m.id, 0, JSON.stringify({ kind: 'thumbnail', source: m.id }), 'current', now()]);
      db.run("UPDATE jobs SET status='done', updated_at=? WHERE id=?", [now(), job.id]);
      db.persist();
      return { job: job.id, status: 'done', media_id: m.id };
    }
    db.run("UPDATE jobs SET status='done', updated_at=? WHERE id=?", [now(), job.id]);
    return { job: job.id, status: 'done' };
  } catch (e) {
    const j = db.get('SELECT attempts FROM jobs WHERE id=?', [job.id]);
    if (e.simulated) { // 模拟崩溃：保持 running，等待 recover
      db.persist();
      const err = new Error('crash'); err.simulated = true; throw err;
    }
    if (j.attempts >= MAX_ATTEMPTS) {
      db.run("UPDATE jobs SET status='failed', error=?, updated_at=? WHERE id=?", [e.message, now(), job.id]);
      if (payload.media_id) db.run("UPDATE media SET status='failed', updated_at=? WHERE id=?", [now(), payload.media_id]);
    } else {
      db.run("UPDATE jobs SET status='pending', error=?, updated_at=? WHERE id=?", [e.message, now(), job.id]);
    }
    db.persist();
    return { job: job.id, status: 'error', error: e.message };
  }
}

// 启动/重连时恢复：把崩溃残留的 running 任务重置为 pending 重跑
function recoverJobs() {
  const stuck = db.all("SELECT * FROM jobs WHERE status='running'");
  for (const j of stuck) {
    if (j.attempts >= MAX_ATTEMPTS) {
      db.run("UPDATE jobs SET status='failed', error='exceeded retries after crash', updated_at=? WHERE id=?", [now(), j.id]);
      const p = JSON.parse(j.payload);
      if (p.media_id) db.run("UPDATE media SET status='failed', updated_at=? WHERE id=?", [now(), p.media_id]);
    } else {
      db.run("UPDATE jobs SET status='pending', updated_at=? WHERE id=?", [now(), j.id]);
    }
  }
  db.persist();
  return stuck.length;
}

module.exports = { enqueueMedia, processNextJob, recoverJobs, _setInjectCrash };
