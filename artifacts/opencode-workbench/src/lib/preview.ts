// Live preview for the workbench: turns the current project into a single
// self-contained HTML document rendered in a sandboxed iframe.
//
// Two strategies:
//  - bundle: for JS/TS/React projects, esbuild-wasm (loaded lazily from a
//    CDN) bundles the entry module against a virtual filesystem built from
//    the project files. Bare imports (react, lodash, ...) stay external and
//    resolve through an import map to esm.sh.
//  - static: for plain HTML projects, relative stylesheets/scripts are
//    inlined and images become data URLs.
//
// The result runs with sandbox="allow-scripts" (opaque origin): previewed
// code can never touch the workbench's own storage or keys.

export type PreviewFile = { path: string; content: string; blob?: Blob; mimeType?: string };
export type PreviewResult = { html: string; strategy: 'bundle' | 'static' };

const ESBUILD_VERSION = '0.25.0';
const CDN = 'https://cdn.jsdelivr.net/npm';

function normalize(path: string): string {
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

function dirOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? '' : path.slice(0, index);
}

const TEXT_EXT = /\.(tsx?|jsx?|mjs|cjs|json|css|html?|md|svg|txt)$/i;

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/* ------------------------------------------------------------------ */
/* esbuild-wasm loading (singleton)                                    */
/* ------------------------------------------------------------------ */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let esbuildPromise: Promise<any> | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadEsbuild(): Promise<any> {
  if (!esbuildPromise) {
    esbuildPromise = (async () => {
      const url = `${CDN}/esbuild-wasm@${ESBUILD_VERSION}/+esm`;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod: any = await import(/* @vite-ignore */ url);
      const esbuild = mod.default ?? mod;
      await esbuild.initialize({
        wasmURL: `${CDN}/esbuild-wasm@${ESBUILD_VERSION}/esbuild.wasm`,
        worker: false,
      });
      return esbuild;
    })().catch((error) => {
      esbuildPromise = null;
      throw error;
    });
  }
  return esbuildPromise;
}

function esmUrl(spec: string): string {
  if (spec === 'react') return 'https://esm.sh/react@19.1.0';
  if (spec === 'react/jsx-runtime') return 'https://esm.sh/react@19.1.0/jsx-runtime';
  if (spec === 'react-dom') return 'https://esm.sh/react-dom@19.1.0?external=react';
  if (spec === 'react-dom/client') return 'https://esm.sh/react-dom@19.1.0/client?external=react';
  return `https://esm.sh/${spec}`;
}

/* ------------------------------------------------------------------ */
/* Entry / shell detection                                             */
/* ------------------------------------------------------------------ */

function findHtml(files: PreviewFile[]): PreviewFile | undefined {
  const htmls = files.filter((file) => /\.html?$/i.test(file.path) && !file.blob);
  return (
    htmls.find((file) => file.path === 'index.html') ||
    htmls.sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path))[0]
  );
}

function moduleScriptSrc(html: string): string | null {
  const tags = html.match(/<script\b[^>]*>/gi) || [];
  for (const tag of tags) {
    if (!/type\s*=\s*["']module["']/i.test(tag)) continue;
    const src = /src\s*=\s*["']([^"']+)["']/i.exec(tag);
    if (src && !/^https?:\/\//i.test(src[1])) return src[1];
  }
  return null;
}

function shellBody(html: string | undefined): string {
  if (!html) return '<div id="root"></div>';
  const body = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1] || '<div id="root"></div>';
  return body.replace(/<script\b[\s\S]*?(<\/script>|\/?>)/gi, '').trim() || '<div id="root"></div>';
}

const ENTRY_CANDIDATES = [
  'src/main.tsx', 'src/main.ts', 'src/main.jsx', 'src/main.js',
  'src/index.tsx', 'src/index.ts', 'src/index.jsx', 'src/index.js',
  'src/App.tsx', 'src/App.jsx', 'main.tsx', 'main.ts', 'index.tsx', 'index.ts',
];

/* ------------------------------------------------------------------ */
/* Bundle strategy                                                     */
/* ------------------------------------------------------------------ */

async function buildBundlePreview(files: PreviewFile[], entryPath: string, htmlFile: PreviewFile | undefined): Promise<PreviewResult> {
  const esbuild = await loadEsbuild();
  const textFiles = new Map<string, string>();
  for (const file of files) {
    if (!file.blob) textFiles.set(normalize(file.path), file.content);
  }
  // Binary assets (images) become data URLs the bundle can import.
  const assetFiles = new Map<string, string>();
  for (const file of files) {
    if (file.blob && file.blob.size <= 2_000_000 && /^(image\/|font\/)/.test(file.mimeType || file.blob.type || '')) {
      assetFiles.set(normalize(file.path), await blobToDataUrl(file.blob));
    }
  }

  const externals = new Set<string>();
  const resolveRelative = (importer: string, spec: string): string | null => {
    const base = spec.startsWith('/')
      ? normalize(spec)
      : normalize(`${dirOf(importer) ? `${dirOf(importer)}/` : ''}${spec}`);
    const candidates = [base];
    for (const ext of ['.tsx', '.ts', '.jsx', '.js', '.json', '.css', '.svg']) candidates.push(base + ext);
    for (const ext of ['.tsx', '.ts', '.jsx', '.js']) candidates.push(`${base}/index${ext}`);
    for (const candidate of candidates) {
      if (textFiles.has(candidate) || assetFiles.has(candidate)) return candidate;
    }
    return null;
  };

  const vfsPlugin = {
    name: 'workbench-vfs',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setup(build: any) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      build.onResolve({ filter: /.*/ }, (args: any) => {
        if (args.kind === 'entry-point') return { path: normalize(entryPath), namespace: 'vfs' };
        if (args.path.startsWith('.') || args.path.startsWith('/')) {
          const resolved = resolveRelative(args.importer || entryPath, args.path);
          if (!resolved) return { errors: [{ text: `Preview cannot resolve "${args.path}" from ${args.importer}` }] };
          return { path: resolved, namespace: 'vfs' };
        }
        externals.add(args.path);
        return { path: args.path, external: true };
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      build.onLoad({ filter: /.*/, namespace: 'vfs' }, (args: any) => {
        const path: string = args.path;
        if (assetFiles.has(path)) {
          return { contents: `export default ${JSON.stringify(assetFiles.get(path))};`, loader: 'js' };
        }
        const contents = textFiles.get(path);
        if (contents === undefined) return { errors: [{ text: `Preview file missing: ${path}` }] };
        if (/\.css$/i.test(path)) {
          return {
            contents: `const css = ${JSON.stringify(contents)};\nconst style = document.createElement('style');\nstyle.textContent = css;\ndocument.head.appendChild(style);\nexport default css;`,
            loader: 'js',
          };
        }
        if (/\.svg$/i.test(path)) return { contents, loader: 'text' };
        if (/\.json$/i.test(path)) return { contents, loader: 'json' };
        if (/\.tsx$/i.test(path)) return { contents, loader: 'tsx' };
        if (/\.ts$/i.test(path)) return { contents, loader: 'ts' };
        if (/\.jsx$/i.test(path)) return { contents, loader: 'jsx' };
        return { contents, loader: 'js' };
      });
    },
  };

  const result = await esbuild.build({
    entryPoints: [entryPath],
    bundle: true,
    format: 'esm',
    write: false,
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"' },
    plugins: [vfsPlugin],
    logLevel: 'silent',
  });
  const code: string = result.outputFiles[0].text;
  const imports: Record<string, string> = {};
  for (const spec of externals) imports[spec] = esmUrl(spec);
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<script type="importmap">${JSON.stringify({ imports })}</script>
<style>html,body{margin:0;padding:0}</style>
</head><body>${shellBody(htmlFile?.content)}
<script type="module">${code.replace(/<\/script>/gi, '<\\/script>')}</script>
</body></html>`;
  return { html, strategy: 'bundle' };
}

/* ------------------------------------------------------------------ */
/* Static strategy                                                     */
/* ------------------------------------------------------------------ */

async function buildStaticPreview(files: PreviewFile[], htmlFile: PreviewFile): Promise<PreviewResult> {
  const baseDir = dirOf(normalize(htmlFile.path));
  const byPath = new Map(files.map((file) => [normalize(file.path), file]));
  const resolve = (rel: string): PreviewFile | undefined => byPath.get(normalize(baseDir ? `${baseDir}/${rel}` : rel)) || byPath.get(normalize(rel));
  let html = htmlFile.content;

  // Inline stylesheets
  html = html.replace(/<link\b[^>]*rel\s*=\s*["']stylesheet["'][^>]*>/gi, (tag) => {
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!href || /^https?:\/\//i.test(href)) return tag;
    const file = resolve(href);
    return file && !file.blob ? `<style>\n${file.content}\n</style>` : tag;
  });
  // Inline classic scripts
  html = html.replace(/<script\b([^>]*?)src\s*=\s*["']([^"']+)["']([^>]*)>([\s\S]*?)<\/script>/gi, (whole, _pre, src, _post, _inner) => {
    if (/^https?:\/\//i.test(src) || /type\s*=\s*["']module["']/i.test(whole)) return whole;
    const file = resolve(src);
    return file && !file.blob ? `<script>\n${file.content.replace(/<\/script>/gi, '<\\/script>')}\n</script>` : whole;
  });
  // Images from binary files → data URLs
  const imgSources = new Set<string>();
  for (const match of html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
    const rel = match[1];
    if (!/^https?:|data:|^#|^mailto:/i.test(rel)) imgSources.add(rel);
  }
  for (const rel of imgSources) {
    const file = resolve(rel);
    if (file?.blob && file.blob.size <= 2_000_000) {
      const dataUrl = await blobToDataUrl(file.blob);
      html = html.split(`"${rel}"`).join(`"${dataUrl}"`).split(`'${rel}'`).join(`'${dataUrl}'`);
    }
  }
  return { html, strategy: 'static' };
}

/* ------------------------------------------------------------------ */

export async function buildPreview(files: PreviewFile[]): Promise<PreviewResult> {
  if (!files.length) throw new Error('This workspace has no files to preview yet.');
  const htmlFile = findHtml(files);
  const textPaths = new Set(files.filter((file) => !file.blob).map((file) => normalize(file.path)));

  let entry: string | null = null;
  if (htmlFile) {
    const src = moduleScriptSrc(htmlFile.content);
    if (src) {
      const resolved = normalize(`${dirOf(normalize(htmlFile.path)) ? `${dirOf(normalize(htmlFile.path))}/` : ''}${src}`);
      if (textPaths.has(resolved)) entry = resolved;
    }
  }
  if (!entry) entry = ENTRY_CANDIDATES.find((candidate) => textPaths.has(candidate)) || null;

  if (entry && TEXT_EXT.test(entry) && /\.(tsx?|jsx?|mjs)$/i.test(entry)) {
    try {
      return await buildBundlePreview(files, entry, htmlFile);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Bundling failed.';
      const detail = (error as { errors?: Array<{ text?: string }> })?.errors?.map((item) => item.text).filter(Boolean).join('\n');
      throw new Error(detail ? `${message}\n${detail}` : message);
    }
  }
  if (htmlFile) return buildStaticPreview(files, htmlFile);
  throw new Error('No previewable entry found. Add an index.html, or a src/main.tsx / src/App.tsx entry, to preview this project.');
}
