// Browser-test harness: builds the real Go server with this client embedded, runs it on a
// loopback port with a throwaway data directory and synthetic data, and can swap it for
// another build (an update) or for the Phase 2 spike's static files on the same origin.
//
// Nothing here touches the repository's working tree: each build happens in a temporary copy
// of server/, with web/dist placed in its web/static.

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const WEB = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
export const REPO = resolve(WEB, '..');
export const PASSWORD = 'synthetic e2e password, not a secret';

const work = mkdtempSync(join(tmpdir(), 'hohe-e2e-'));
const builds = new Map<string, string>();

/** Build the client with `version` and a server binary embedding it. Cached per version. */
export function buildServer(version: string): string {
  const have = builds.get(version);
  if (have) return have;
  const dir = join(work, `build-${version}`);
  const dist = join(dir, 'dist');
  execFileSync('npx', ['vite', 'build', '--outDir', dist, '--emptyOutDir'], {
    cwd: WEB,
    env: { ...process.env, HOHE_VERSION: version },
    stdio: 'pipe',
  });
  const src = join(dir, 'server');
  cpSync(join(REPO, 'server'), src, { recursive: true });
  rmSync(join(src, 'web', 'static'), { recursive: true, force: true });
  cpSync(dist, join(src, 'web', 'static'), { recursive: true });
  const bin = join(dir, 'hohe');
  execFileSync('go', ['build', '-ldflags', `-X main.version=${version} -X main.commit=e2e`, '-o', bin, './cmd/hohe'], {
    cwd: src,
    stdio: 'pipe',
  });
  builds.set(version, bin);
  return bin;
}

let hash = '';
function passwordHash(bin: string): string {
  if (!hash) hash = execFileSync(bin, ['hash-password'], { input: PASSWORD + '\n' }).toString().trim();
  return hash;
}

export class Hohe {
  private proc: ChildProcess | null = null;
  private spike: Server | null = null;
  readonly dataDir: string;
  readonly config: string;
  log = '';

  constructor(
    readonly port: number,
    name: string,
  ) {
    this.dataDir = join(work, `data-${name}`);
    mkdirSync(this.dataDir, { recursive: true });
    this.config = join(work, `config-${name}.json`);
  }

  get url() {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(version = 'e2e-1') {
    await this.stop();
    const bin = buildServer(version);
    writeFileSync(
      this.config,
      JSON.stringify({
        listen: `127.0.0.1:${this.port}`,
        dataDir: this.dataDir,
        persistent: false,
        loginPasswordBcrypt: passwordHash(bin),
        captureTokens: [],
        secureCookies: false,
        publicOrigin: this.url,
        sessionDays: 90,
      }),
    );
    this.proc = spawn(bin, ['serve', '--config', this.config], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc.stdout!.on('data', (d) => (this.log += d));
    this.proc.stderr!.on('data', (d) => (this.log += d));
    await this.waitFor('/healthz');
  }

  /** Serve the Phase 2 spike's static client at the same origin (its API is not needed). */
  async startSpike() {
    await this.stop();
    const root = join(REPO, 'spike', 'web', 'static');
    const types: Record<string, string> = {
      '.html': 'text/html',
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.png': 'image/png',
      '.webmanifest': 'application/manifest+json',
    };
    this.spike = createServer((req, res) => {
      const p = new URL(req.url ?? '/', this.url).pathname;
      let f = join(root, p === '/' ? 'index.html' : p);
      if (!f.startsWith(root) || !existsSync(f) || statSync(f).isDirectory()) f = join(root, 'index.html');
      res.setHeader('Content-Type', types[extname(f)] ?? 'application/octet-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.end(readFileSync(f));
    });
    await new Promise<void>((r) => this.spike!.listen(this.port, '127.0.0.1', r));
  }

  async stop() {
    if (this.proc) {
      const p = this.proc;
      this.proc = null;
      await new Promise<void>((r) => {
        p.once('exit', () => r());
        p.kill('SIGTERM');
      });
    }
    if (this.spike) {
      const s = this.spike;
      this.spike = null;
      s.closeAllConnections();
      await new Promise<void>((r) => s.close(() => r()));
    }
  }

  private async waitFor(path: string) {
    for (let i = 0; i < 100; i++) {
      try {
        const r = await fetch(this.url + path);
        if (r.ok) return;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`server did not start:\n${this.log}`);
  }

  /** Read the server's state directly, as a separate logged-in client. */
  async serverState(): Promise<{ tasks: { id: string; title: string; priority: string; state: string; revisions: Record<string, number> }[]; placements: { id: string; taskId: string; letter: string; rank: number; outcome: string; day: string }[]; conflicts: unknown[] }> {
    const login = await fetch(this.url + '/api/login', {
      method: 'POST',
      headers: { 'X-HOHE-Client': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD, device: 'e2e-checker' }),
    });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
    const r = await fetch(this.url + '/api/state', { headers: { Cookie: cookie } });
    return (await r.json()).state;
  }
}

export function cleanup() {
  rmSync(work, { recursive: true, force: true });
}
