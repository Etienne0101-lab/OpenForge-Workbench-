// In-browser Python execution via Pyodide (CPython compiled to WebAssembly).
//
// The runtime loads lazily from the Pyodide CDN on first use. Before each
// run, the project's text files are mounted into a virtual /project
// directory (imports between project modules work, relative file reads
// work), and stdout/stderr are captured. Code runs on the page's main
// thread — a script with an infinite loop will block the tab, which the
// UI says plainly. Extra packages can be installed from Python itself:
//   import micropip; await micropip.install('some-package')

export type PythonRunResult = { stdout: string; stderr: string; error?: string };
export type PythonProjectFile = { path: string; content: string; blob?: Blob };

const INDEX_URL = 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pyodidePromise: Promise<any> | null = null;
let stdoutBuffer = '';
let stderrBuffer = '';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadPythonRuntime(): Promise<any> {
  if (!pyodidePromise) {
    pyodidePromise = (async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod: any = await import(/* @vite-ignore */ `${INDEX_URL}pyodide.mjs`);
      const pyodide = await mod.loadPyodide({ indexURL: INDEX_URL });
      pyodide.setStdout({ batched: (text: string) => { stdoutBuffer += `${text}\n`; } });
      pyodide.setStderr({ batched: (text: string) => { stderrBuffer += `${text}\n`; } });
      return pyodide;
    })().catch((error) => {
      pyodidePromise = null;
      throw error;
    });
  }
  return pyodidePromise;
}

export async function ensurePython(): Promise<void> {
  await loadPythonRuntime();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function syncProjectFiles(pyodide: any, files: PythonProjectFile[]): void {
  const FS = pyodide.FS;
  try {
    FS.mkdirTree('/project');
  } catch {
    // already exists
  }
  for (const file of files) {
    if (file.blob) continue;
    const target = `/project/${file.path.replace(/^\/+/, '')}`;
    const dir = target.slice(0, target.lastIndexOf('/'));
    if (dir && dir !== '/project') {
      try {
        FS.mkdirTree(dir);
      } catch {
        // already exists
      }
    }
    try {
      FS.writeFile(target, file.content, { encoding: 'utf8' });
    } catch {
      // skip files the virtual FS rejects (unusual names)
    }
  }
}

export async function runPython(code: string, files: PythonProjectFile[]): Promise<PythonRunResult> {
  const pyodide = await loadPythonRuntime();
  syncProjectFiles(pyodide, files);
  stdoutBuffer = '';
  stderrBuffer = '';
  try {
    await pyodide.runPythonAsync(`
import os, sys
os.chdir('/project')
if '/project' not in sys.path:
    sys.path.insert(0, '/project')
`);
    await pyodide.runPythonAsync(code);
    return { stdout: stdoutBuffer, stderr: stderrBuffer };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Pyodide tracebacks end with the exception line; keep the tail readable.
    const lines = message.split('\n').filter((line) => line.trim().length > 0);
    return { stdout: stdoutBuffer, stderr: stderrBuffer, error: lines.slice(-12).join('\n') || message };
  }
}

export const SAMPLE_PY = `"""Runs on real CPython (Pyodide) right in this tab."""
import math


def primes_below(limit: int) -> list[int]:
    sieve = bytearray(b"\\x01") * (limit + 1)
    sieve[0:2] = b"\\x00\\x00"
    for i in range(2, int(limit ** 0.5) + 1):
        if sieve[i]:
            step = i
            start = i * i
            sieve[start:limit + 1:step] = b"\\x00" * ((limit - start) // step + 1)
    return [i for i in range(limit + 1) if sieve[i]]


print("Primes below 50:", primes_below(50))
print("Sum of squares 1..10 =", sum(i * i for i in range(1, 11)))
print("sqrt(2) =", math.sqrt(2))
print("Project files are mounted at /project — imports between them work.")
`;
