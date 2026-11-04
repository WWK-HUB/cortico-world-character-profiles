/** Role-scoped discovery for DSH Desktop's changing loopback port. No messages are sent. */
import { execFile } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
const exec = promisify(execFile);

export function loopbackBridge(value: unknown): URL | null {
  try {
    const url = new URL(String(value));
    return url.protocol === 'ws:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      && url.pathname === '/coopanion/pet' && !url.username && !url.password ? url : null;
  } catch { return null; }
}

export interface ReconcileDeps {
  current(): { url: string } | null;
  ports(): Promise<number[]>;
  probe(port: number): Promise<boolean>;
  update(url: string): Promise<void>;
}

export async function reconcileBridge(deps: ReconcileDeps): Promise<boolean> {
  const before = deps.current();
  const url = loopbackBridge(before?.url);
  if (!url || await deps.probe(Number(url.port || 80))) return false;
  // More than one DSH host is ambiguous: never retarget the person's work silently.
  const valid: number[] = [];
  for (const port of [...new Set(await deps.ports())].slice(0, 12)) {
    if (Number.isInteger(port) && port > 0 && port < 65536 && await deps.probe(port)) valid.push(port);
  }
  if (valid.length !== 1 || deps.current()?.url !== before!.url) return false;
  await deps.update(`ws://127.0.0.1:${valid[0]}/coopanion/pet`);
  return true;
}

export function startDshBridgeMonitor(botDir: string, warn: (message: string) => void): () => void {
  const physical = realpathSync.native(botDir);
  const controller = new AbortController();
  let stopped = false, running = false;
  const read = (file: string): any => JSON.parse(readFileSync(file, 'utf8'));
  const current = () => {
    try {
      if (stopped || realpathSync.native(botDir) !== physical) return null;
      const config = read(join(physical, 'config.json'));
      if (config.worlds?.['character-profiles']?.dshAutoDiscover !== true || config.worlds?.fatfish?.bridgeEnabled !== true) return null;
      return { url: String(config.worlds.fatfish.url), config };
    } catch { return null; }
  };
  const request = async (url: string, options: RequestInit = {}) => {
    const response = await fetch(url, { ...options, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(4000)]) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json() as Promise<any>;
  };
  const deps: ReconcileDeps = {
    current,
    probe: async port => {
      try { const status = await request(`http://127.0.0.1:${port}/coopanion/status`); return status.ok === true && status.v === 1; }
      catch { return false; }
    },
    ports: async () => {
      if (process.platform !== 'win32' || !current()) return [];
      // Only sockets owned by DSH Desktop itself, never arbitrary local services.
      const command = "$ids=@(Get-CimInstance Win32_Process -Filter \"Name = 'DeepSeek Harness.exe'\" | Select-Object -ExpandProperty ProcessId); if($ids.Count -gt 0){ @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -in $ids -and $_.LocalAddress -eq '127.0.0.1' } | Select-Object -ExpandProperty LocalPort) | ConvertTo-Json -Compress }";
      const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command],
        { windowsHide: true, timeout: 12000, signal: controller.signal });
      const value = stdout.trim() ? JSON.parse(stdout) : [];
      return (Array.isArray(value) ? value : [value]).map(Number);
    },
    update: async url => {
      const snapshot = current();
      if (!snapshot) return;
      const port = snapshot.config.web?.port ?? 17788;
      if (!Number.isInteger(port) || port < 1 || port > 65535) return;
      const base = `http://127.0.0.1:${port}`;
      const lifecycle = await request(base + '/api/run/lifecycle');
      if (!lifecycle.ready || !current()) return;
      // Check physical identity after every asynchronous wait. Only change the URL,
      // never enable another role's bridge if a switch races with this request.
      const latest = await request(base + '/api/run/lifecycle');
      if (latest.bootId !== lifecycle.bootId || !current()) return;
      await request(base + '/api/config', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ group: 'world:fatfish.bridge', values: { 'worlds.fatfish.url': url } }) });
      if (!current()) return;
      const after = await request(base + '/api/run/lifecycle');
      if (after.bootId !== lifecycle.bootId || !current()) return;
      await request(base + '/api/worlds/restart', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'fatfish' }) });
      warn('已自动连接本机 DSH：' + url);
    },
  };
  const tick = async () => {
    if (stopped || running || !current()) return;
    running = true;
    try { await reconcileBridge(deps); } catch (error) { if (!stopped) warn('DSH 自动连接暂不可用：' + String(error)); }
    finally { running = false; }
  };
  const timer = setInterval(() => { void tick(); }, 10000).unref();
  void tick();
  return () => { stopped = true; controller.abort(); clearInterval(timer); };
}
