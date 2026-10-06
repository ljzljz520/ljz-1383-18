import { spawn } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function startServer(port) {
  const server = spawn(process.execPath, ['api-server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return { server, base, stop: () => server.kill() };
    } catch {}
    await wait(100);
  }
  server.kill();
  throw new Error(`Test API server failed to start on port ${port}`);
}
