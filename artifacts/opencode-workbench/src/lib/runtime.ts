// Full Node.js runtime in the tab, via StackBlitz WebContainers.
//
// WebContainer boots a real Node environment (npm, dev servers, builds)
// in a Web Worker/WASM stack. It requires cross-origin isolation
// (SharedArrayBuffer): GitHub Pages cannot send COOP/COEP headers, so the
// page ships coi-serviceworker (see index.html / public/), which
// synthesizes them and reloads the page once on first visit.
//
// The client library loads lazily from a CDN on first use — the heavy
// runtime itself streams from StackBlitz's infrastructure at boot.
// Licensing: WebContainer API is free for personal and open-source use;
// commercial production products should review StackBlitz's terms.

export type RuntimeFile = { path: string; content: string; blob?: Blob };

const API_CDN = 'https://cdn.jsdelivr.net/npm/@webcontainer/api@1.6.0/+esm';

export function isCrossOriginIsolated(): boolean {
  return typeof window !== 'undefined' && (window as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
}

/* ------------------------------------------------------------------ */
/* Mount tree                                                          */
/* ------------------------------------------------------------------ */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FileNode = any;

export async function buildFileTree(files: RuntimeFile[]): Promise<Record<string, FileNode>> {
  const root: Record<string, FileNode> = {};
  for (const file of files) {
    const parts = file.path.replace(/^\/+/, '').split('/').filter(Boolean);
    if (!parts.length) continue;
    let level = root;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const part = parts[index];
      if (!level[part]) level[part] = { directory: {} };
      level = level[part].directory as Record<string, FileNode>;
    }
    const name = parts[parts.length - 1];
    if (file.blob) {
      level[name] = { file: { contents: new Uint8Array(await file.blob.arrayBuffer()) } };
    } else {
      level[name] = { file: { contents: file.content } };
    }
  }
  return root;
}

/* ------------------------------------------------------------------ */
/* Boot + processes                                                    */
/* ------------------------------------------------------------------ */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let wcPromise: Promise<any> | null = null;
let serverReadyHandler: ((port: number, url: string) => void) | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function bootRuntime(onServerReady: (port: number, url: string) => void): Promise<any> {
  serverReadyHandler = onServerReady;
  if (!wcPromise) {
    wcPromise = (async () => {
      if (!isCrossOriginIsolated()) {
        throw new Error('The page is not cross-origin isolated, which WebContainers require. The isolation service worker reloads the page once on first visit — if you still see this, reload manually; if it persists, this browser cannot provide SharedArrayBuffer (a Chromium-based browser works best).');
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod: any = await import(/* @vite-ignore */ API_CDN);
      const WebContainer = mod.WebContainer ?? mod.default?.WebContainer;
      if (!WebContainer) throw new Error('The WebContainer client library did not expose its API.');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const wc: any = await WebContainer.boot();
      wc.on('server-ready', (port: number, url: string) => serverReadyHandler?.(port, url));
      return wc;
    })().catch((error) => {
      wcPromise = null;
      throw error;
    });
  }
  return wcPromise;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function mountProject(wc: any, files: RuntimeFile[]): Promise<void> {
  await wc.mount(await buildFileTree(files));
}

export function splitCommandLine(input: string): string[] {
  const parts: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(input)) !== null) {
    parts.push(match[1] ?? match[2] ?? match[3]);
  }
  return parts;
}

export type SpawnedProcess = { exit: Promise<number>; kill: () => void };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function spawnCommand(wc: any, commandLine: string, onOutput: (text: string) => void): Promise<SpawnedProcess> {
  const parts = splitCommandLine(commandLine.trim());
  if (!parts.length) throw new Error('Enter a command to run.');
  const proc = await wc.spawn(parts[0], parts.slice(1));
  proc.output.pipeTo(
    new WritableStream({
      write(data: string) {
        onOutput(data);
      },
    }),
  ).catch(() => {
    // stream closed when the process is killed
  });
  return { exit: proc.exit as Promise<number>, kill: () => proc.kill() };
}

/** Best first command for a project: its package.json dev/start script, if any. */
export function suggestedCommand(files: RuntimeFile[]): string {
  const pkg = files.find((file) => file.path === 'package.json' && !file.blob);
  if (pkg) {
    try {
      const parsed = JSON.parse(pkg.content) as { scripts?: Record<string, string> };
      if (parsed.scripts?.dev) return 'npm run dev';
      if (parsed.scripts?.start) return 'npm start';
    } catch {
      // malformed package.json — fall through
    }
  }
  return 'npm run dev';
}
