import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, useLocation, Router as WouterRouter } from 'wouter';
import { fetchModels, formatModelMeta, hasSavedModelChoice, isUnusableResponse, loadModelId, loadOpenRouterKey, pickFreeFallbacks, preferredFreeDefault, sanitizeAssistantText, saveModelId, saveOpenRouterKey, streamOpenRouterChat, FREE_ROUTER_ID, RECOMMENDED_MODEL_IDS } from '@/lib/openrouter';
import type { ChatMessage, ModelInfo, ProjectFileContext } from '@/lib/openrouter';
import { EXPERT_MODES, getMode, loadModeId, saveModeId } from '@/lib/modes';
import { buildRepoMap, contextBudgetChars, perFileCapChars, rankFilesByRelevance } from '@/lib/project-map';
import { PROJECT_TEMPLATES } from '@/lib/templates';
import {
  AlertCircle, ArrowDownToLine, ArrowUpFromLine, Archive, Bot, Check,
  Clipboard, Code2, Download, File as FileIcon, FileCode2, FilePlus2, Folder, FolderOpen, FolderPlus, GitBranch,
  HardDrive, KeyRound, LayoutTemplate,
  MessageSquare, PanelLeft, Plus, Send, ShieldCheck,
  Sparkles, Square, Trash2, X,
} from 'lucide-react';
import { unzipSync, zipSync } from 'fflate';
import {
  loadWorkspaceState, makeConversation, makeId, makeProject, persistWorkspaceState,
} from '@/lib/workspace-store';
import type { ProjectFile, ProjectWorkspace, Suggestion, WorkbenchState, WorkMessage } from '@/lib/workspace-store';
import type { DeviceDirectoryHandle } from '@/lib/workspace-store';

const MAX_IMPORT_FILES = 1500;
const MAX_IMPORT_BYTES = 100 * 1024 * 1024;
const MAX_SINGLE_FILE_BYTES = 50 * 1024 * 1024;
const STARTER_FILE_PATHS = new Set(['src/App.tsx', 'src/styles.css', 'README.md', 'package.json']);
const TEXT_EXTENSIONS = new Set(['txt', 'md', 'mdx', 'csv', 'tsv', 'json', 'jsonc', 'jsonl', 'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'css', 'scss', 'less', 'html', 'htm', 'xml', 'svg', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'log', 'sql', 'sh', 'bash', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'vue', 'svelte', 'astro', 'gradle', 'properties', 'gitignore', 'editorconfig']);
function shouldSkipImportPath(path: string) {
  const parts = path.replaceAll('\\', '/').split('/');
  return parts.some((part) => ['node_modules', '.git', '.next', 'dist', 'build', 'coverage', '.turbo'].includes(part.toLowerCase()));
}
function isSensitivePath(path: string) {
  const basename = path.split('/').pop() || '';
  return /^\.env(?:\.[^/]*)?$/i.test(basename)
    || /(?:^|[._-])(?:secret|secrets|credential|credentials|password|token|private[-_]?key)(?:[._-]|$)/i.test(basename)
    || /^id_(?:rsa|ed25519)$/i.test(basename)
    || /\.(?:pem|key|p12|pfx)$/i.test(basename);
}
function normalizeImportPath(input: string): string | null {
  const path = input.replaceAll('\\', '/');
  if (!path || /[\u0000-\u001f\u007f]/.test(path) || path.startsWith('/') || /^[a-z]:\//i.test(path)) return null;
  const parts = path.split('/').filter(Boolean);
  if (!parts.length || parts.some((part) => part === '.' || part === '..' || part.includes('\0'))) return null;
  return parts.join('/');
}
function isTextFile(path: string, mimeType: string, bytes: Uint8Array) {
  const extension = getExtension(path);
  if (TEXT_EXTENSIONS.has(extension) || mimeType.startsWith('text/')) return true;
  if (/^(?:application\/(?:json|xml|javascript|x-javascript|sql|x-sh|toml)|image\/svg\+xml)$/.test(mimeType)) return true;
  if (/^(?:application\/(?:pdf|zip|gzip|wasm|octet-stream|x-executable)|image\/|audio\/|video\/|font\/)/.test(mimeType)) return false;
  const sample = bytes.subarray(0, Math.min(bytes.length, 8192));
  if (sample.includes(0)) return false;
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(sample);
    const controls = (decoded.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g) || []).length;
    return controls / Math.max(decoded.length, 1) < 0.01;
  } catch {
    return false;
  }
}
function projectFileFromBytes(path: string, bytes: Uint8Array, mimeType = ''): ProjectFile {
  const type = mimeType || 'application/octet-stream';
  if (isTextFile(path, type, bytes)) {
    return { path, content: new TextDecoder('utf-8', { fatal: false }).decode(bytes), mimeType: type, size: bytes.byteLength };
  }
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return { path, content: '', blob: new Blob([buffer], { type }), mimeType: type, size: bytes.byteLength };
}
function fileBytes(file: ProjectFile) {
  return file.blob ? file.blob : new Blob([file.content], { type: file.mimeType || 'text/plain;charset=utf-8' });
}
function isDirectoryEntry(file: ProjectFile, files: ProjectFile[]) {
  return files.some((candidate) => candidate.path.startsWith(`${file.path}/`));
}
async function importArchiveEntries(
  bytes: Uint8Array,
  archivePath: string,
  additions: ProjectFile[],
  onSkipped: () => void,
  alreadyImportedBytes: number,
) {
  const acceptedPaths = new Map<string, string>();
  let archiveFiles = 0;
  let archiveBytes = 0;
  let rejectedSize = '';
  const unzipped = unzipSync(bytes, {
    filter: (info) => {
      if (info.name.endsWith('/')) return false;
      const entryPath = normalizeImportPath(info.name);
      if (!entryPath || shouldSkipImportPath(entryPath)) { onSkipped(); return false; }
      archiveFiles++;
      archiveBytes += info.originalSize;
      if (info.originalSize > MAX_SINGLE_FILE_BYTES || additions.length + archiveFiles > MAX_IMPORT_FILES || archiveBytes + alreadyImportedBytes > MAX_IMPORT_BYTES) {
        rejectedSize = `Archive contents exceed the ${formatSize(MAX_IMPORT_BYTES)} total or ${formatSize(MAX_SINGLE_FILE_BYTES)} per-file import limit.`;
        return false;
      }
      acceptedPaths.set(info.name, entryPath);
      return true;
    },
  });
  if (rejectedSize) throw new Error(rejectedSize);
  for (const [sourcePath, entryBytes] of Object.entries(unzipped)) {
    const entryPath = acceptedPaths.get(sourcePath);
    if (!entryPath) continue;
    const expandedPath = normalizeImportPath(`${archivePath.replace(/\.zip$/i, '')}/${entryPath}`);
    if (!expandedPath || shouldSkipImportPath(expandedPath)) { onSkipped(); continue; }
    additions.push(projectFileFromBytes(expandedPath, entryBytes));
  }
  return archiveBytes;
}
function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function getExtension(path: string) { return path.split('/').pop()?.split('.').pop()?.toLowerCase() || ''; }
function fileIcon(path: string) {
  const ext = getExtension(path);
  if (['tsx', 'ts', 'jsx', 'js', 'css', 'html'].includes(ext)) return <FileCode2 />;
  if (ext === 'md') return <FileIcon />;
  return <FileCode2 />;
}
function suggestionsFrom(text: string): { body: string; suggestions: Suggestion[] } {
  const suggestions: Suggestion[] = [];
  let body = text;
  // Targeted patches: <<<PATCH path>>> with FIND/REPLACE pairs
  body = body.replace(/<<<PATCH\s+([^>\n]+)>>>\s*\n([\s\S]*?)\n<<<END PATCH>>>/g, (_match, path: string, inner: string) => {
    const patches: Array<{ find: string; replace: string }> = [];
    const pairRe = /<<<FIND>>>\s*\n([\s\S]*?)\n<<<REPLACE>>>\s*\n([\s\S]*?)(?=\n<<<FIND>>>|\s*$)/g;
    let m: RegExpExecArray | null;
    while ((m = pairRe.exec(inner)) !== null) {
      patches.push({ find: m[1], replace: m[2] });
    }
    if (patches.length) {
      suggestions.push({ path: path.trim(), content: '', patches, kind: 'patch', status: 'pending' });
    }
    return '';
  });
  // Deletes: <<<DELETE path>>>
  body = body.replace(/<<<DELETE\s+([^>\n]+)>>>(?:\s*\n<<<END DELETE>>>)?/g, (_match, path: string) => {
    suggestions.push({ path: path.trim(), content: '', kind: 'delete', status: 'pending' });
    return '';
  });
  // Full files: <<<FILE path>>> ... <<<END FILE>>>
  body = body.replace(/<<<FILE\s+([^>\n]+)>>>\s*\n([\s\S]*?)\n<<<END FILE>>>/g, (_match, path: string, content: string) => {
    suggestions.push({ path: path.trim(), content, kind: 'replace', status: 'pending' });
    return '';
  });
  return { body: body.trim(), suggestions };
}
const CODE_TOKEN_RE = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|\b(const|let|var|function|return|if|else|elif|for|while|do|import|from|export|default|class|extends|implements|new|delete|async|await|try|except|catch|finally|throw|raise|typeof|instanceof|in|of|switch|case|break|continue|def|print|None|True|False|lambda|with|as|pass|yield|global|public|private|protected|static|void|fn|pub|struct|impl|trait|match|mut|package|func|go|defer|type|interface|enum|record|sealed|data|object|val|vararg|when|namespace|using|bool|int|float|double|string|char|long|short|byte|select|where|group|by|join|on|union|create|table|insert|update|values|into)\b|\b(\d[\d_]*(?:\.\d+)?)\b/g;

function highlightCode(code: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let key = 0;
  CODE_TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CODE_TOKEN_RE.exec(code)) !== null) {
    if (match.index > last) nodes.push(code.slice(last, match.index));
    const cls = match[1] ? 'tok-com' : match[2] ? 'tok-str' : match[3] ? 'tok-kw' : 'tok-num';
    nodes.push(<span key={key++} className={cls}>{match[0]}</span>);
    last = match.index + match[0].length;
  }
  if (last < code.length) nodes.push(code.slice(last));
  return nodes;
}

function MessageContent({ content }: { content: string }) {
  const parts = content.split(/(```[\s\S]*?```)/g);
  return <div className="message-body">{parts.map((part, index) => {
    if (part.startsWith('```')) {
      const code = part.replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '');
      return <pre key={index}><code>{highlightCode(code)}</code></pre>;
    }
    return part.split('\n').map((line, lineIndex) => line ? <p key={`${index}-${lineIndex}`}>{line}</p> : null);
  })}</div>;
}

function BinaryFileViewer({ file, onDownload }: { file: ProjectFile; onDownload: (file: ProjectFile) => void }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (!file.blob) { setUrl(''); return; }
    const nextUrl = URL.createObjectURL(file.blob);
    setUrl(nextUrl);
    return () => URL.revokeObjectURL(nextUrl);
  }, [file.blob]);
  return <div className="binary-preview" data-testid="binary-file-viewer">
    <div className="binary-preview-card">
      <Archive />
      <strong>{file.path.split('/').pop()}</strong>
      <span>{file.mimeType || 'Unknown file type'} · {formatSize(file.size ?? file.blob?.size ?? 0)}</span>
      {url && file.mimeType?.startsWith('image/') && <img className="binary-image-preview" src={url} alt={`Preview of ${file.path}`} />}
      {url && file.mimeType?.startsWith('audio/') && <audio controls preload="metadata" src={url}>Audio preview unavailable.</audio>}
      {url && file.mimeType?.startsWith('video/') && <video controls preload="metadata" src={url}>Video preview unavailable.</video>}
      {url && (file.mimeType === 'application/pdf' || file.path.toLowerCase().endsWith('.pdf')) && <iframe className="pdf-preview" title={`Preview of ${file.path}`} src={url} />}
      <button className="solid-button" onClick={() => onDownload(file)} data-testid="button-download-current-file"><Download size={14} /> Download file</button>
    </div>
  </div>;
}

function Home() {
  const [workspace, setWorkspace] = useState<WorkbenchState>(() => {
    const project = makeProject('fieldnotes-ui');
    return { projects: [project], activeProjectId: project.id };
  });
  const [storageReady, setStorageReady] = useState(false);
  const [localSaveStatus, setLocalSaveStatus] = useState<'saving' | 'saved'>('saved');
  const [draft, setDraft] = useState('');
  const [modelId, setModelId] = useState<string>(() => loadModelId());
  const [modeId, setModeIdState] = useState<string>(() => loadModeId());
  const setModeId = (id: string) => { setModeIdState(id); saveModeId(id); };
  const [modelQuery, setModelQuery] = useState('');
  const [templateOpen, setTemplateOpen] = useState(false);
  const [lastContext, setLastContext] = useState('');
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [newFileOpen, setNewFileOpen] = useState(false);
  const [newFilePath, setNewFilePath] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [modalError, setModalError] = useState('');
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [fileBusy, setFileBusy] = useState(false);
  const [apiKey, setApiKey] = useState<string>(() => loadOpenRouterKey());
  const [keyDraft, setKeyDraft] = useState('');
  const [keyEditing, setKeyEditing] = useState(false);
  const { data: models, isLoading: modelsLoading, isError: modelsError, refetch: refetchModels } = useQuery({
    queryKey: ['openrouter-models', apiKey ? 'key' : 'public'],
    queryFn: () => fetchModels(apiKey),
    retry: false,
    staleTime: 5 * 60 * 1000,
  });
  const saveKey = () => {
    const trimmed = keyDraft.trim();
    if (!trimmed) return;
    setApiKey(trimmed);
    saveOpenRouterKey(trimmed);
    setKeyDraft('');
    setKeyEditing(false);
    setError('');
  };
  const clearKey = () => {
    setApiKey('');
    saveOpenRouterKey('');
    setKeyDraft('');
    setKeyEditing(true);
  };
  const abortRef = useRef<AbortController | null>(null);
  const streamRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const state = useMemo(() => workspace.projects.find((project) => project.id === workspace.activeProjectId) || workspace.projects[0], [workspace]);

  const conversation = useMemo(() => state.conversations.find((item) => item.id === state.activeConversationId) || state.conversations[0], [state.conversations, state.activeConversationId]);
  const currentFile = state.files.find((file) => file.path === state.selectedFile);
  const actualModels = models as ModelInfo[] | undefined;
  const userPickedModel = useRef(hasSavedModelChoice());
  useEffect(() => {
    if (userPickedModel.current || !actualModels?.length || modelId !== FREE_ROUTER_ID) return;
    const preferred = preferredFreeDefault(actualModels);
    if (preferred) {
      userPickedModel.current = true;
      setModelId(preferred);
      saveModelId(preferred);
    }
  }, [actualModels, modelId]);
  const [editorScroll, setEditorScroll] = useState(0);
  useEffect(() => { setEditorScroll(0); }, [state.selectedFile]);
  const selectedModel = actualModels?.find((model) => model.id === modelId);
  const recommendedModels = (actualModels || []).filter((model) => RECOMMENDED_MODEL_IDS.includes(model.id))
    .sort((a, b) => RECOMMENDED_MODEL_IDS.indexOf(a.id) - RECOMMENDED_MODEL_IDS.indexOf(b.id));
  const freeModels = (actualModels || []).filter((model) => model.isFree && !RECOMMENDED_MODEL_IDS.includes(model.id));
  const visibleModels = (actualModels || []).filter((model) => {
    if (RECOMMENDED_MODEL_IDS.includes(model.id)) return false;
    if (!modelQuery.trim()) return true;
    const q = modelQuery.trim().toLowerCase();
    return model.id.toLowerCase().includes(q) || model.name.toLowerCase().includes(q);
  });
  const orderedFiles = useMemo(() => [...state.files].filter(file => file.content || !state.files.some(item => item.path.startsWith(`${file.path}/`))).sort((a, b) => a.path.localeCompare(b.path)), [state.files]);

  useEffect(() => {
    let live = true;
    void loadWorkspaceState().then((saved) => {
      if (live) setWorkspace(saved);
    }).catch((storageError) => {
      if (live) setError(storageError instanceof Error ? `Local storage could not be opened: ${storageError.message}` : 'Local workspace storage could not be opened.');
    }).finally(() => { if (live) setStorageReady(true); });
    return () => { live = false; };
  }, []);
  useEffect(() => {
    if (!storageReady) return;
    setLocalSaveStatus('saving');
    const timer = window.setTimeout(() => {
      void persistWorkspaceState(workspace).then(() => setLocalSaveStatus('saved')).catch((storageError) => {
        setError(storageError instanceof Error ? `Local changes could not be saved: ${storageError.message}` : 'Local changes could not be saved.');
      });
    }, 700);
    return () => window.clearTimeout(timer);
  }, [workspace, storageReady]);
  useEffect(() => {
    if (folderInputRef.current) {
      (folderInputRef.current as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true;
    }
  }, []);
  useEffect(() => { streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight, behavior: 'smooth' }); }, [conversation?.messages.length, streaming]);
  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(''), 2600);
    return () => window.clearTimeout(timeout);
  }, [toast]);
  useEffect(() => {
    if (actualModels?.length && !actualModels.some((model) => model.id === modelId) && modelId !== 'openrouter/free') {
      setModelId('openrouter/free');
    }
  }, [actualModels, modelId]);

  const updateState = useCallback((updater: (previous: ProjectWorkspace) => ProjectWorkspace) => setWorkspace((previous) => ({
    ...previous,
    projects: previous.projects.map((project) => project.id === previous.activeProjectId ? updater(project) : project),
  })), []);
  const updateActiveMessages = useCallback((updater: (messages: WorkMessage[]) => WorkMessage[]) => {
    updateState((previous) => ({ ...previous, conversations: previous.conversations.map((item) => item.id === previous.activeConversationId ? { ...item, messages: updater(item.messages), updatedAt: Date.now() } : item) }));
  }, [updateState]);
  const updateFile = (path: string, content: string) => updateState((previous) => ({ ...previous, files: previous.files.map((file) => file.path === path ? { ...file, content, size: new Blob([content]).size, mimeType: file.mimeType || 'text/plain;charset=utf-8' } : file) }));
  const createProjectFromTemplate = (templateId: string) => {
    const template = PROJECT_TEMPLATES.find((item) => item.id === templateId);
    if (!template) return;
    let name = template.name;
    let suffix = 2;
    while (workspace.projects.some((project) => project.name.toLowerCase() === name.toLowerCase())) { name = `${template.name} ${suffix}`; suffix += 1; }
    const project = makeProject(name);
    project.files = template.files.map((file) => ({ ...file }));
    project.selectedFile = template.files.find((file) => file.content)?.path || template.files[0]?.path || '';
    project.selectedContext = project.selectedFile ? [project.selectedFile] : [];
    setWorkspace((previous) => ({ projects: [...previous.projects, project], activeProjectId: project.id }));
    setTemplateOpen(false);
    setToast(`Created "${name}" from a template.`);
  };
  const createProject = () => {
    if (streaming || fileBusy) { setError('Wait for the current operation to finish before creating a project.'); return; }
    const name = newProjectName.trim();
    if (!name) { setModalError('Give the project a name.'); return; }
    if (workspace.projects.some((project) => project.name.toLowerCase() === name.toLowerCase())) { setModalError('A project with that name already exists.'); return; }
    const project = makeProject(name);
    setWorkspace((previous) => ({ projects: [...previous.projects, project], activeProjectId: project.id }));
    setNewProjectName('');
    setModalError('');
    setNewProjectOpen(false);
    setToast(`Created “${project.name}”.`);
  };
  const switchProject = (projectId: string) => {
    if (streaming) { setError('Stop the current response before switching projects.'); return; }
    setWorkspace((previous) => previous.projects.some((project) => project.id === projectId) ? { ...previous, activeProjectId: projectId } : previous);
    setDraft('');
    setError('');
  };
  const createProjectDialog = () => {
    if (streaming || fileBusy) return;
    setNewProjectName('');
    setModalError('');
    setNewProjectOpen(true);
  };
  const newConversation = () => {
    const item = makeConversation();
    updateState((previous) => ({ ...previous, conversations: [item, ...previous.conversations], activeConversationId: item.id }));
    setDraft('');
  };
  const removeConversation = (id: string) => updateState((previous) => {
    const remaining = previous.conversations.filter((item) => item.id !== id);
    const replacement = remaining.length ? remaining : [makeConversation()];
    return { ...previous, conversations: replacement, activeConversationId: previous.activeConversationId === id ? replacement[0].id : previous.activeConversationId };
  });
  const createFile = () => {
    const path = normalizeImportPath(newFilePath.trim());
    if (!path || path.endsWith('/')) { setModalError('Enter a file path such as src/utils.ts.'); return; }
    if (shouldSkipImportPath(path)) { setModalError('Generated or dependency folders cannot be added to this workspace.'); return; }
    if (state.files.some((file) => file.path === path)) { setModalError('A file with that path already exists.'); return; }
    updateState((previous) => ({ ...previous, files: [...previous.files, { path, content: '' }], selectedFile: path }));
    setNewFileOpen(false); setNewFilePath(''); setModalError('');
  };
  const importProjectFiles = async (inputFiles: FileList | File[]) => {
    const selectedFiles = Array.from(inputFiles);
    if (!selectedFiles.length) return;
    if (selectedFiles.length > MAX_IMPORT_FILES) { setError(`Choose no more than ${MAX_IMPORT_FILES.toLocaleString()} files at a time.`); return; }
    setFileBusy(true);
    setError('');
    let skippedCount = 0;
    let totalBytes = 0;
    let archivesNotExpanded = 0;
    const additions: ProjectFile[] = [];
    try {
      for (const file of selectedFiles) {
        const relativePath = ('webkitRelativePath' in file && (file as File & { webkitRelativePath?: string }).webkitRelativePath) || file.name;
        const path = normalizeImportPath(relativePath);
        if (!path || shouldSkipImportPath(path)) { skippedCount++; continue; }
        if (file.size > MAX_SINGLE_FILE_BYTES) throw new Error(`${path} is larger than the ${formatSize(MAX_SINGLE_FILE_BYTES)} per-file limit.`);
        totalBytes += file.size;
        if (totalBytes > MAX_IMPORT_BYTES) throw new Error(`This selection exceeds the ${formatSize(MAX_IMPORT_BYTES)} import limit.`);
        const bytes = new Uint8Array(await file.arrayBuffer());
        additions.push(projectFileFromBytes(path, bytes, file.type));
        if (!/\.zip$/i.test(path)) continue;
        try {
          totalBytes += await importArchiveEntries(bytes, path, additions, () => skippedCount++, totalBytes);
        } catch (archiveError) {
          if (archiveError instanceof Error && archiveError.message.startsWith('Archive contents exceed')) throw archiveError;
          archivesNotExpanded++;
        }
      }
      if (!additions.length) {
        setToast(skippedCount ? 'No files imported; generated or unsafe paths were skipped. Sensitive files remain available locally but are never sent as AI context.' : 'No files to import.');
        return;
      }
      updateState((previous) => {
        const map = new Map(previous.files.map((file) => [file.path, file]));
        additions.forEach((file) => map.set(file.path, file));
        const firstText = additions.find((file) => !file.blob);
        const first = firstText || additions[0];
        return { ...previous, files: [...map.values()], selectedFile: first.path };
      });
      setToast(`${additions.length} file${additions.length === 1 ? '' : 's'} imported${skippedCount ? `; ${skippedCount} generated or unsafe file${skippedCount === 1 ? '' : 's'} skipped` : ''}${archivesNotExpanded ? `; ${archivesNotExpanded} ZIP archive${archivesNotExpanded === 1 ? ' was' : 's were'} kept as downloads but not expanded` : ''}. Sensitive files stay local and cannot be sent to AI.`);
    } catch (importError) {
      setError(importError instanceof Error ? `Upload failed: ${importError.message}` : 'Upload failed. Check that the file is readable.');
    } finally {
      setFileBusy(false);
    }
  };
  const chooseProjectFolder = async () => {
    if (streaming) { setError('Stop the current response before opening another project folder.'); return; }
    const pickerWindow = window as Window & { showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<DeviceDirectoryHandle> };
    if (!pickerWindow.showDirectoryPicker) {
      setToast('Direct folder access is unavailable here. The fallback folder picker imports files read-only.');
      folderInputRef.current?.click();
      return;
    }
    setFileBusy(true);
    try {
      const handle = await pickerWindow.showDirectoryPicker({ mode: 'readwrite' });
      const imported: ProjectFile[] = [];
      let totalBytes = 0;
      let skippedCount = 0;
      let archivesNotExpanded = 0;
      const visit = async (directory: DeviceDirectoryHandle, parentPath = ''): Promise<void> => {
        for await (const entry of directory.values()) {
          const path = normalizeImportPath(parentPath ? `${parentPath}/${entry.name}` : entry.name);
          if (!path || shouldSkipImportPath(path)) { skippedCount++; continue; }
          if (entry.kind === 'directory') {
            await visit(await directory.getDirectoryHandle(entry.name) as DeviceDirectoryHandle, path);
          } else {
            const file = await directory.getFileHandle(entry.name).then((fileHandle) => fileHandle.getFile());
            if (file.size > MAX_SINGLE_FILE_BYTES) throw new Error(`${path} is larger than the ${formatSize(MAX_SINGLE_FILE_BYTES)} per-file limit.`);
            totalBytes += file.size;
            if (totalBytes > MAX_IMPORT_BYTES || imported.length >= MAX_IMPORT_FILES) throw new Error(`Folder contents exceed the ${formatSize(MAX_IMPORT_BYTES)} or ${MAX_IMPORT_FILES.toLocaleString()} file import limit.`);
            const bytes = new Uint8Array(await file.arrayBuffer());
            imported.push(projectFileFromBytes(path, bytes, file.type));
            if (/\.zip$/i.test(path)) {
              try {
                totalBytes += await importArchiveEntries(bytes, path, imported, () => skippedCount++, totalBytes);
              } catch (archiveError) {
                if (archiveError instanceof Error && archiveError.message.startsWith('Archive contents exceed')) throw archiveError;
                archivesNotExpanded++;
              }
              if (totalBytes > MAX_IMPORT_BYTES) throw new Error(`Folder and archive contents exceed the ${formatSize(MAX_IMPORT_BYTES)} import limit.`);
            }
          }
        }
      };
      await visit(handle);
      if (!imported.length) throw new Error('The selected folder has no importable files.');
      const project = makeProject(handle.name);
      project.files = imported;
      project.directoryHandle = handle;
      project.selectedFile = imported.find((file) => !file.blob)?.path || imported[0].path;
      project.selectedContext = [];
      setWorkspace((previous) => ({ projects: [...previous.projects, project], activeProjectId: project.id }));
      setDraft('');
      setToast(`Opened ${imported.length} files from “${handle.name}”${skippedCount ? `; ${skippedCount} generated or unsafe paths skipped` : ''}${archivesNotExpanded ? `; ${archivesNotExpanded} ZIP archive${archivesNotExpanded === 1 ? ' was' : 's were'} kept but not expanded` : ''}. Sensitive files stay local and cannot be sent to AI.`);
    } catch (folderError) {
      if (folderError instanceof DOMException && folderError.name === 'AbortError') return;
      setError(folderError instanceof Error ? `Folder could not be opened: ${folderError.message}` : 'Folder could not be opened.');
    } finally {
      setFileBusy(false);
    }
  };
  const downloadFile = async (file: ProjectFile) => {
    const url = URL.createObjectURL(fileBytes(file));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = file.path.split('/').pop() || 'download';
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    setToast(`${file.path} downloaded.`);
  };
  const exportProject = async () => {
    setFileBusy(true);
    try {
      const entries = Object.create(null) as Record<string, Uint8Array>;
      let totalBytes = 0;
      for (const file of state.files) {
        if (isDirectoryEntry(file, state.files)) continue;
        const bytes = new Uint8Array(await fileBytes(file).arrayBuffer());
        totalBytes += bytes.byteLength;
        if (totalBytes > MAX_IMPORT_BYTES) throw new Error(`Project is larger than the ${formatSize(MAX_IMPORT_BYTES)} export limit.`);
        entries[file.path] = bytes;
      }
      const archive = zipSync(entries, { level: 6 });
      const url = URL.createObjectURL(new Blob([archive], { type: 'application/zip' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${state.name.trim().replace(/[^a-z0-9._-]+/gi, '-') || 'project'}.zip`;
      anchor.style.display = 'none';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      setToast(`${Object.keys(entries).length} project files downloaded as ZIP.`);
    } catch (exportError) {
      setError(exportError instanceof Error ? `Download failed: ${exportError.message}` : 'Project download failed.');
    } finally {
      setFileBusy(false);
    }
  };
  const saveFolderChanges = async () => {
    const directory = state.directoryHandle;
    if (!directory) { setToast('Open a local folder first to enable write-back.'); return; }
    const files = state.files.filter((file) => !isDirectoryEntry(file, state.files));
    if (!window.confirm(`Write ${files.length} files from “${state.name}” to the selected device folder? Files with matching names will be overwritten. Files removed in the workbench will not be deleted.`)) return;
    setFileBusy(true);
    try {
      const permission = await directory.requestPermission({ mode: 'readwrite' });
      if (permission !== 'granted') throw new Error('Folder write permission was not granted.');
      for (const file of files) {
        const pathParts = file.path.split('/');
        const filename = pathParts.pop();
        if (!filename) continue;
        let target = directory;
        for (const part of pathParts) target = await target.getDirectoryHandle(part, { create: true }) as DeviceDirectoryHandle;
        const handle = await target.getFileHandle(filename, { create: true });
        const writable = await handle.createWritable();
        await writable.write(fileBytes(file));
        await writable.close();
      }
      setToast(`Wrote ${files.length} files to the selected device folder.`);
    } catch (writeError) {
      setError(writeError instanceof Error ? `Could not write project files: ${writeError.message}` : 'Could not write project files.');
    } finally {
      setFileBusy(false);
    }
  };
  const importPastedFiles = () => {
    try {
      const parsed = JSON.parse(importText) as ProjectFile[] | { files: ProjectFile[] };
      const sourceFiles = Array.isArray(parsed) ? parsed : parsed.files;
      if (!Array.isArray(sourceFiles) || !sourceFiles.length || sourceFiles.some((file) => typeof file.path !== 'string' || typeof file.content !== 'string')) throw new Error();
      const files = sourceFiles.filter((file) => !shouldSkipImportPath(file.path));
      if (!files.length) { setModalError('This snapshot contains no importable project files.'); return; }
      const safeFiles = files.flatMap((file) => {
        const path = normalizeImportPath(file.path);
        return path && typeof file.content === 'string' ? [{ ...file, path, blob: undefined, mimeType: 'text/plain;charset=utf-8', size: new Blob([file.content]).size }] : [];
      });
      if (!safeFiles.length) { setModalError('The snapshot contains no safe project file paths.'); return; }
      updateState((previous) => {
        const map = new Map(previous.files.map((file) => [file.path, file]));
        safeFiles.forEach((file) => map.set(file.path, file));
        return { ...previous, files: [...map.values()], selectedFile: safeFiles[0].path };
      });
      setImportOpen(false); setImportText(''); setModalError(''); setToast(`${safeFiles.length} project files imported${safeFiles.length < sourceFiles.length ? `; ${sourceFiles.length - safeFiles.length} generated or unsafe path${sourceFiles.length - safeFiles.length === 1 ? '' : 's'} skipped` : ''}.`);
    } catch { setModalError('Paste a JSON array of { "path", "content" } files, or a { "files": [...] } object.'); }
  };
  const copyText = async (content: string) => {
    try { await navigator.clipboard.writeText(content); setToast('Copied to clipboard.'); }
    catch { setToast('Clipboard access is unavailable in this browser.'); }
  };
  const markSuggestion = (messageId: string, suggestionIndex: number, update: Partial<Suggestion>) => {
    updateState((previous) => ({
      ...previous,
      conversations: previous.conversations.map((item) => item.id === previous.activeConversationId ? { ...item, messages: item.messages.map((msg) => msg.id === messageId ? { ...msg, suggestions: msg.suggestions?.map((entry, index) => index === suggestionIndex ? { ...entry, ...update } : entry) } : msg) } : item),
    }));
  };
  const acceptSuggestion = (messageId: string, suggestionIndex: number) => {
    const message = conversation?.messages.find((item) => item.id === messageId);
    const suggestion = message?.suggestions?.[suggestionIndex];
    if (!suggestion) return;
    const path = normalizeImportPath(suggestion.path);
    if (!path || shouldSkipImportPath(path)) { setError('That suggested file path is unsafe or restricted.'); return; }
    const kind = suggestion.kind || 'replace';
    if (kind === 'delete') {
      updateState((previous) => {
        const files = previous.files.filter((file) => file.path !== path);
        return {
          ...previous, files,
          selectedFile: previous.selectedFile === path ? files.find((file) => !files.some((candidate) => candidate.path.startsWith(`${file.path}/`)))?.path || '' : previous.selectedFile,
          selectedContext: previous.selectedContext.filter((item) => item !== path),
          conversations: previous.conversations.map((item) => item.id === previous.activeConversationId ? { ...item, messages: item.messages.map((msg) => msg.id === messageId ? { ...msg, suggestions: msg.suggestions?.map((entry, index) => index === suggestionIndex ? { ...entry, status: 'accepted' as const } : entry) } : msg) } : item),
        };
      });
      setToast(`${path} deleted after review.`);
      return;
    }
    if (kind === 'patch') {
      const current = state.files.find((file) => file.path === path);
      if (!current || current.blob) { setError(`Patch target ${path} is not an editable text file in this workspace.`); return; }
      let content = current.content;
      for (const patch of suggestion.patches || []) {
        const at = content.indexOf(patch.find);
        if (at === -1) {
          markSuggestion(messageId, suggestionIndex, { applyError: 'A FIND block no longer matches the file exactly, so this patch was not applied. Ask the assistant to re-propose it as a full file.' });
          setError(`Patch for ${path} did not apply cleanly — nothing was changed.`);
          return;
        }
        content = content.slice(0, at) + patch.replace + content.slice(at + patch.find.length);
      }
      updateState((previous) => ({
        ...previous,
        files: previous.files.map((file) => file.path === path ? { ...file, content, size: new Blob([content]).size } : file),
        selectedFile: path,
        conversations: previous.conversations.map((item) => item.id === previous.activeConversationId ? { ...item, messages: item.messages.map((msg) => msg.id === messageId ? { ...msg, suggestions: msg.suggestions?.map((entry, index) => index === suggestionIndex ? { ...entry, status: 'accepted' as const, applyError: undefined } : entry) } : msg) } : item),
      }));
      setToast(`${path} patched after review.`);
      return;
    }
    updateState((previous) => {
      const exists = previous.files.some((file) => file.path === path);
      const textFile: ProjectFile = { path, content: suggestion.content, mimeType: 'text/plain;charset=utf-8', size: new Blob([suggestion.content]).size };
      const files = exists ? previous.files.map((file) => file.path === path ? textFile : file) : [...previous.files, textFile];
      return {
        ...previous, files, selectedFile: path,
        conversations: previous.conversations.map((item) => item.id === previous.activeConversationId ? { ...item, messages: item.messages.map((msg) => msg.id === messageId ? { ...msg, suggestions: msg.suggestions?.map((entry, index) => index === suggestionIndex ? { ...entry, status: 'accepted' } : entry) } : msg) } : item),
      };
    });
    setToast(`${path} updated after review.`);
  };
  const acceptAllSuggestions = (messageId: string) => {
    const message = conversation?.messages.find((item) => item.id === messageId);
    message?.suggestions?.forEach((entry, index) => {
      if (entry.status === 'pending') acceptSuggestion(messageId, index);
    });
  };
  const rejectSuggestion = (messageId: string, suggestionIndex: number) => updateActiveMessages((messages) => messages.map((message) => message.id === messageId ? { ...message, suggestions: message.suggestions?.map((suggestion, index) => index === suggestionIndex ? { ...suggestion, status: 'rejected' } : suggestion) } : message));

  const sendMessage = async (value = draft) => {
    const text = value.trim();
    if (!text || streaming || !conversation) return;
    if (!modelId) { setError('Choose a model before sending.'); return; }
    if (!apiKey) { setError('Add your OpenRouter API key first — use the key field in the sidebar or under the chat. Your key is stored only in your browser and sent only to OpenRouter.'); setKeyEditing(true); return; }
    setError('');
    setDraft('');
    const userMessage: WorkMessage = { id: makeId(), role: 'user', content: text };
    const assistantId = makeId();
    const targetConversationId = conversation.id;
    const assistantMessage: WorkMessage = { id: assistantId, role: 'assistant', content: '' };
    updateState((previous) => ({
      ...previous,
      conversations: previous.conversations.map((item) => item.id === previous.activeConversationId ? {
        ...item, title: item.messages.length ? item.title : text.slice(0, 38), updatedAt: Date.now(), messages: [...item.messages, userMessage, assistantMessage],
      } : item),
    }));
    setStreaming(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const messages: ChatMessage[] = [
        ...conversation.messages.slice(-38).map(({ role, content }) => ({ role, content: content.slice(0, 20000) })),
        { role: 'user', content: text },
      ];
      const budget = contextBudgetChars(selectedModel?.contextLength ?? null);
      const cap = perFileCapChars(budget);
      const isLeaf = (file: ProjectFile) => !state.files.some((candidate) => candidate.path.startsWith(`${file.path}/`));
      const eligible = state.files.filter((file) => !file.blob && !isSensitivePath(file.path) && isLeaf(file));
      const selectedPaths = new Set(state.selectedContext);
      const manualFiles = eligible.filter((file) => selectedPaths.has(file.path));
      const manualPaths = new Set(manualFiles.map((file) => file.path));
      const autoFiles = rankFilesByRelevance(eligible.filter((file) => !manualPaths.has(file.path)), `${text} ${state.selectedFile}`);
      const files: ProjectFileContext[] = [];
      let usedChars = 0;
      for (const file of [...manualFiles, ...autoFiles]) {
        const content = file.content.slice(0, cap);
        if (files.length && usedChars + content.length > budget) break;
        files.push({ path: file.path, content });
        usedChars += content.length + file.path.length;
      }
      const autoCount = files.filter((file) => !manualPaths.has(file.path)).length;
      const repoMap = buildRepoMap(state.files);
      setLastContext(`${files.length} file${files.length === 1 ? '' : 's'} in context${autoCount ? ` · ${autoCount} auto-selected` : ''} · ${Math.max(1, Math.round(usedChars / 1000))}k chars · repo map of ${state.files.length} files`);
      // Attempt chain: free models fail in characteristic ways (empty
      // streams, stalls, agent-harness tool-call markup). When the chosen
      // model is free, line up reliable free fallbacks and move on
      // automatically instead of dead-ending the user.
      const attempts: string[] = [modelId];
      if (modelId === FREE_ROUTER_ID || selectedModel?.isFree) {
        for (const fallback of pickFreeFallbacks(actualModels || [], modelId, 3)) {
          if (!attempts.includes(fallback)) attempts.push(fallback);
        }
      }
      const setAssistantContent = (content: string) => {
        updateState((previous) => ({ ...previous, conversations: previous.conversations.map((item) => item.id === targetConversationId ? { ...item, messages: item.messages.map((message) => message.id === assistantId ? { ...message, content } : message) } : item) }));
      };
      let accumulated = '';
      let answeredBy = '';
      let salvage = '';
      let lastError: unknown = null;
      for (const attemptModel of attempts) {
        accumulated = '';
        setAssistantContent('');
        try {
          const raw = await streamOpenRouterChat({
            apiKey,
            model: attemptModel,
            modeId,
            repoMap,
            messages,
            files,
            maxContextChars: budget,
            signal: controller.signal,
            onDelta: (chunk) => { accumulated += chunk; setAssistantContent(sanitizeAssistantText(accumulated)); },
          });
          const cleaned = sanitizeAssistantText(raw);
          if (isUnusableResponse(raw, cleaned)) {
            if (cleaned.trim().length > salvage.length) salvage = cleaned;
            lastError = new Error('That model returned an empty or tool-call-only response.');
            continue;
          }
          accumulated = cleaned;
          answeredBy = attemptModel;
          lastError = null;
          break;
        } catch (attemptError) {
          if (attemptError instanceof DOMException && attemptError.name === 'AbortError') throw attemptError;
          lastError = attemptError;
          const attemptMessage = attemptError instanceof Error ? attemptError.message : '';
          if (/rejected that API key|too large/i.test(attemptMessage)) throw attemptError;
        }
      }
      if (!answeredBy && salvage.trim().length >= 60) {
        // Every model struggled, but one produced real prose once its
        // tool-call markup was stripped — deliver that rather than nothing.
        accumulated = salvage;
        answeredBy = attempts[attempts.length - 1];
      }
      if (!answeredBy) {
        throw lastError instanceof Error && /stalled|empty/i.test(lastError.message)
          ? new Error('Free models are overloaded right now — every model tried stalled or returned nothing usable. Wait a moment and send again, or pick a specific model (the Recommended group is far more reliable).')
          : (lastError instanceof Error ? lastError : new Error('The request failed. Try again, or pick a different model.'));
      }
      if (answeredBy !== modelId) setToast(`The first model didn't answer properly — ${answeredBy} responded instead.`);
      const parsed = suggestionsFrom(accumulated);
      updateState((previous) => ({ ...previous, conversations: previous.conversations.map((item) => item.id === targetConversationId ? { ...item, messages: item.messages.map((message) => message.id === assistantId ? { ...message, content: parsed.body || (parsed.suggestions.length ? 'Proposed changes are ready for your review below.' : 'That model returned an empty response. Try sending again, or pick a different model — free models do this when overloaded.'), suggestions: parsed.suggestions } : message) } : item) }));
    } catch (chatError) {
      if (chatError instanceof DOMException && chatError.name === 'AbortError') {
        updateState((previous) => ({ ...previous, conversations: previous.conversations.map((item) => item.id === targetConversationId ? { ...item, messages: item.messages.map((message) => message.id === assistantId ? { ...message, content: message.content || 'Response stopped.' } : message) } : item) }));
      } else {
        const message = chatError instanceof Error ? chatError.message : 'Something interrupted the response.';
        setError(message);
        updateState((previous) => ({ ...previous, conversations: previous.conversations.map((item) => item.id === targetConversationId ? { ...item, messages: item.messages.filter((message) => message.id !== assistantId) } : item) }));
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  };
  const stopStream = () => abortRef.current?.abort();
  const toggleContext = (path: string) => updateState((previous) => ({
    ...previous, selectedContext: previous.selectedContext.includes(path) ? previous.selectedContext.filter((item) => item !== path) : [...previous.selectedContext, path],
  }));
  const folderNames = useMemo(() => {
    const dirs = new Set<string>();
    state.files.forEach((file) => { const pieces = file.path.split('/'); if (pieces.length > 1) dirs.add(pieces.slice(0, -1).join('/')); });
    return dirs;
  }, [state.files]);
  const removeFile = (path: string) => {
    if (!window.confirm(`Remove ${path} from this browser workspace?`)) return;
    updateState((previous) => {
      const files = previous.files.filter((file) => file.path !== path);
      return { ...previous, files, selectedFile: previous.selectedFile === path ? files.find((file) => !files.some((candidate) => candidate.path.startsWith(`${file.path}/`)))?.path || '' : previous.selectedFile, selectedContext: previous.selectedContext.filter((item) => item !== path) };
    });
  };

  return (
    <div className="app-shell">
      <aside className="rail">
        <div className="brand" data-testid="brand-opencode">
          <div className="brand-mark">o</div><div><div className="brand-name">opencode</div><div className="brand-sub">WORKBENCH / 01</div></div>
        </div>
        <div className="rail-label">Workspace</div>
        <div className="project-switcher">
          <select value={state.id} onChange={(event) => switchProject(event.target.value)} aria-label="Switch project" data-testid="select-project" disabled={streaming || fileBusy}>
            {workspace.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
          <button className="icon-button" title="Create a new project" aria-label="Create a new project" onClick={createProjectDialog} disabled={streaming || fileBusy} data-testid="button-new-project"><FolderPlus /></button>
        </div>
        <div className="rail-key" data-testid="sidebar-openrouter-key">
          <div className="rail-key-head"><KeyRound /><span>OpenRouter API Key</span></div>
          {apiKey && !keyEditing ? <>
            <div className="provider-note"><ShieldCheck /><span>Key saved in this browser.<br />Every OpenRouter model unlocked.</span></div>
            <div className="key-actions"><button className="plain-button" onClick={() => setKeyEditing(true)} data-testid="button-change-key">Change key</button><button className="plain-button" onClick={clearKey} data-testid="button-clear-key">Remove</button></div>
          </> : <>
            <div className="provider-note"><span>Paste your key to enable the assistant. It is stored only in this browser and sent only to OpenRouter.</span></div>
            <div className="key-form"><input type="password" value={keyDraft} onChange={(event) => setKeyDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') saveKey(); }} placeholder="sk-or-..." aria-label="OpenRouter API key" data-testid="input-openrouter-key" /><button className="solid-button" onClick={saveKey} disabled={!keyDraft.trim()} data-testid="button-save-key">Save API key</button></div>
          </>}
        </div>
        <div className="rail-action active" aria-current="page" data-testid="current-workspace"><FolderOpen /><span>Project files</span></div>
        <button className="rail-action" onClick={newConversation} data-testid="button-new-conversation"><Plus /><span>New conversation</span></button>
        <div className="rail-label">Recent threads</div>
        <div className="conversation-list">
          {state.conversations.map((item) => <div className="rail-action conversation-item" key={item.id}>
            <button className={`rail-action conversation-item ${item.id === conversation?.id ? 'active' : ''}`} onClick={() => updateState((previous) => ({ ...previous, activeConversationId: item.id }))} data-testid={`conversation-${item.id}`}><MessageSquare /><span>{item.title}</span></button>
            <button className="delete-conversation" title="Delete conversation" aria-label="Delete conversation" onClick={() => removeConversation(item.id)} data-testid={`delete-conversation-${item.id}`}><X size={12} /></button>
          </div>)}
        </div>
        <div className="rail-foot">
          <div className="provider-note"><ShieldCheck /><span>Senior-level assistance.<br />Your key stays in your browser.</span></div>
          <small>PROVIDER AVAILABILITY VARIES</small>
        </div>
      </aside>
      <main className="work-area">
        <header className="topbar">
          <div className="crumbs"><span>workspaces</span><span>/</span><b>{state.name}</b><span className="crumb-dot" /></div>
          <div className="top-actions">
            <div className="connection" title={modelsError ? 'Could not reach OpenRouter' : 'Model list status'}><i />{actualModels?.length ? 'OpenRouter ready' : 'Workbench'}</div>
            <button className="plain-button" onClick={() => void exportProject()} disabled={fileBusy || !state.files.length} data-testid="button-export-project"><ArrowDownToLine /> ZIP</button>
            <button className="icon-button" title="Upload any files, including ZIP archives" aria-label="Upload files" onClick={() => fileInputRef.current?.click()} disabled={fileBusy} data-testid="button-import-files"><ArrowUpFromLine /></button>
            <button className="icon-button" title="Open a device folder with read/write permission" aria-label="Open local folder" onClick={() => void chooseProjectFolder()} disabled={fileBusy} data-testid="button-import-folder"><HardDrive /></button>
            {state.directoryHandle && <button className="icon-button" title="Write project files to the selected device folder" aria-label="Save changes to device folder" onClick={() => void saveFolderChanges()} disabled={fileBusy} data-testid="button-save-local-folder"><Download /></button>}
            <input ref={fileInputRef} type="file" multiple hidden onChange={(event) => { if (event.target.files) void importProjectFiles(event.target.files); event.target.value = ''; }} data-testid="input-import-files" />
            <input ref={folderInputRef} type="file" multiple hidden onChange={(event) => { if (event.target.files) void importProjectFiles(event.target.files); event.target.value = ''; }} data-testid="input-import-folder" />
          </div>
        </header>
        <div className="workspace-grid">
          <section className="editor-pane">
            <div className="pane-heading">
              <div><div className="eyebrow">Your project</div><div className="section-title">Project files</div><div className="file-support-note">Any file type · ZIP expands · 50 MB/file · 100 MB/import</div></div>
              <div className="pane-tools">
                <button className="icon-button" title="New project from a template" aria-label="New project from a template" onClick={() => { setModalError(''); setTemplateOpen(true); }} data-testid="button-templates"><LayoutTemplate /></button>
                <button className="icon-button" title="Add a file" aria-label="Add a file" onClick={() => { setModalError(''); setNewFileOpen(true); }} data-testid="button-add-file"><FilePlus2 /></button>
                <button className="icon-button" title="Import project JSON" onClick={() => { setModalError(''); setImportOpen(true); }} data-testid="button-import-json"><ArrowUpFromLine /></button>
                <button className="icon-button" title="Download project ZIP" onClick={() => void exportProject()} disabled={fileBusy || !state.files.length} data-testid="button-save-project"><Archive /></button>
              </div>
            </div>
            <div className="file-tree">
              <div className="tree-top"><span>{state.name}</span><button onClick={() => { setModalError(''); setNewFileOpen(true); }} aria-label="Create file" data-testid="button-tree-add-file"><Plus /></button></div>
              {folderNames.size > 0 && [...folderNames].sort().map((directory) => <div key={directory} className="file-row" style={{ paddingLeft: 6 }}><Folder /><span>{directory}</span></div>)}
              {orderedFiles.filter((file) => file.content || !folderNames.has(file.path)).map((file) => (
                <div key={file.path} style={{ display: 'flex', alignItems: 'center' }}>
                  <button className={`file-row ${state.selectedFile === file.path ? 'selected' : ''}`} style={{ flex: 1, minWidth: 0 }} onClick={() => updateState((previous) => ({ ...previous, selectedFile: file.path }))} data-testid={`file-${file.path.replace(/[^a-zA-Z0-9]+/g, '-')}`}>
                    {fileIcon(file.path)}<span>{file.path.includes('/') ? file.path.split('/').slice(1).join('/') : file.path}</span><span className="file-ext">{file.blob ? formatSize(file.size ?? file.blob.size) : getExtension(file.path).toUpperCase()}</span>
                  </button>
                  <input type="checkbox" title={isSensitivePath(file.path) ? 'Potential secrets stay in this browser and cannot be sent to AI' : file.blob ? 'Binary files cannot be sent as text context' : 'Include this file as assistant context'} aria-label={`Include ${file.path} as context`} checked={state.selectedContext.includes(file.path)} onChange={() => toggleContext(file.path)} disabled={!!file.blob || isSensitivePath(file.path)} data-testid={`context-${file.path.replace(/[^a-zA-Z0-9]+/g, '-')}`} />
                  {!STARTER_FILE_PATHS.has(file.path) && <button className="tiny-action" title="Remove file" onClick={() => removeFile(file.path)} data-testid={`remove-file-${file.path.replace(/[^a-zA-Z0-9]+/g, '-')}`}><Trash2 /></button>}
                </div>
              ))}
              {!state.files.length && <div className="empty-editor"><div>No files in this workspace.<br />Import a folder or create a file.</div></div>}
            </div>
            {currentFile ? <div className="editor-wrap">
              <div className="editor-tabs"><div className="editor-tab">{fileIcon(currentFile.path)}{currentFile.path}</div><span className="save-label">{currentFile.blob ? formatSize(currentFile.size ?? currentFile.blob.size) : localSaveStatus === 'saving' ? 'saving…' : 'saved locally'}</span></div>
              {currentFile.blob ? <BinaryFileViewer file={currentFile} onDownload={(file) => void downloadFile(file)} /> : <div className="code-frame"><div className="line-gutter" aria-hidden="true"><div style={{ transform: `translateY(-${editorScroll}px)` }}>{currentFile.content.split('\n').map((_line, lineIndex) => <div key={lineIndex}>{lineIndex + 1}</div>)}</div></div><textarea className="code-editor" spellCheck={false} value={currentFile.content} onChange={(event) => updateFile(currentFile.path, event.target.value)} onScroll={(event) => setEditorScroll(event.currentTarget.scrollTop)} onKeyDown={(event) => { if (event.key === 'Tab') { event.preventDefault(); const el = event.currentTarget; const start = el.selectionStart; const end = el.selectionEnd; updateFile(currentFile.path, el.value.slice(0, start) + '  ' + el.value.slice(end)); requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = start + 2; }); } }} aria-label={`Edit ${currentFile.path}`} data-testid="input-code-editor" /></div>}
              <div className="editor-footer"><span><GitBranch /> local</span><span>{currentFile.blob ? `${formatSize(currentFile.size ?? currentFile.blob.size)} · ${currentFile.mimeType || 'binary file'}` : `${currentFile.content.split('\n').length} lines · UTF-8`}</span></div>
            </div> : <div className="editor-wrap"><div className="empty-editor"><div>Select a file to inspect or edit it here.</div></div></div>}
            <div className="editor-bottom"><span><PanelLeft /> &nbsp;{state.directoryHandle ? `DEVICE FOLDER · ${state.directoryHandle.name}` : 'LOCAL WORKSPACE'}</span><strong>{formatSize(state.files.reduce((total, file) => total + (file.size ?? file.blob?.size ?? new Blob([file.content]).size), 0))} · saved in this browser</strong></div>
          </section>
          <section className="chat-pane">
            <div className="chat-head">
              <div className="chat-title"><div className="chat-symbol"><Sparkles /></div><div><strong>Assistant</strong><small>{getMode(modeId).label} · OpenRouter</small></div></div>
              <span className="mode-tagline">{getMode(modeId).tagline}</span>
            </div>
            <div className="chat-controls">
              <label className="control-field"><span>Mode</span>
                <select value={modeId} onChange={(event) => setModeId(event.target.value)} aria-label="Expert mode" data-testid="select-mode">
                  {EXPERT_MODES.map((mode) => <option key={mode.id} value={mode.id}>{mode.label}</option>)}
                </select>
              </label>
              <label className="control-field grow"><span>Model</span>
                {modelsLoading ? <div className="loading-models" /> : <select className="model-select" value={modelId} onChange={(event) => { userPickedModel.current = true; setModelId(event.target.value); saveModelId(event.target.value, true); }} aria-label="Choose a model" data-testid="select-model">
                  <option value="openrouter/free">OpenRouter Free (automatic routing — variable quality)</option>
                  {selectedModel && modelQuery && !visibleModels.some((model) => model.id === selectedModel.id) && !recommendedModels.some((model) => model.id === selectedModel.id) && !freeModels.some((model) => model.id === selectedModel.id) && <option value={selectedModel.id}>{selectedModel.name} (selected)</option>}
                  {recommendedModels.length > 0 && <optgroup label="Recommended">{recommendedModels.map((model) => <option value={model.id} key={model.id}>{model.name}{formatModelMeta(model) ? ` · ${formatModelMeta(model)}` : ''}</option>)}</optgroup>}
                  {freeModels.length > 0 && <optgroup label="Free models">{freeModels.slice(0, 80).map((model) => <option value={model.id} key={model.id}>{model.name}{formatModelMeta(model) ? ` · ${formatModelMeta(model)}` : ''}</option>)}</optgroup>}
                  <optgroup label={modelQuery ? 'Search results' : 'All models'}>{visibleModels.slice(0, modelQuery ? 200 : 500).map((model) => <option value={model.id} key={model.id}>{model.name}{formatModelMeta(model) ? ` · ${formatModelMeta(model)}` : ''}</option>)}</optgroup>
                </select>}
              </label>
              <label className="control-field"><span>Find</span>
                <input value={modelQuery} onChange={(event) => setModelQuery(event.target.value)} placeholder="Search models…" aria-label="Search models" data-testid="input-model-search" />
              </label>
            </div>
            {(modelId === FREE_ROUTER_ID || selectedModel?.isFree) && <div className="controls-note">You are on a free model — quality and speed vary a lot. If one fails, stalls, or answers with tool-call markup, the workbench automatically retries other free models. For senior-level work, a Recommended frontier model is far more consistent.</div>}
            <div className="chat-stream" ref={streamRef} data-testid="chat-messages">
              {!conversation?.messages.length && <div className="welcome">
                <div className="welcome-mark"><Code2 /></div>
                <h1>Senior engineering, in a tab.</h1>
                <p>Architecture, code, ML systems, data, security — choose a mode and a model, and put the whole project to work. The assistant sees a map of every file and proposes reviewable change sets, never silent edits.</p>
                <div className="prompt-chips">
                  {['Architect a system for my idea', 'Review this project like a principal engineer', 'Design an ML training pipeline', 'Find the riskiest bug in this code'].map((prompt) => <button className="prompt-chip" key={prompt} onClick={() => sendMessage(prompt)} data-testid={`prompt-${prompt.toLowerCase().replace(/[^a-z]+/g, '-')}`}>{prompt}</button>)}
                </div>
              </div>}
              {conversation?.messages.map((message) => <div className={`message ${message.role}`} key={message.id} data-testid={`message-${message.role}-${message.id}`}>
                {message.role === 'assistant' && <div className="message-meta"><span className="assistant-dot"><Bot /></span><span>opencode assistant</span><button className="tiny-action" onClick={() => copyText(message.content)} title="Copy response" data-testid={`copy-${message.id}`}><Clipboard /> Copy</button></div>}
                <MessageContent content={message.content} />
                {message.suggestions?.map((suggestion, index) => {
                  const kind = suggestion.kind || 'replace';
                  const kindLabel = kind === 'delete' ? 'Delete file' : kind === 'patch' ? `Patch · ${suggestion.patches?.length || 0} edit${(suggestion.patches?.length || 0) === 1 ? '' : 's'}` : state.files.some((file) => file.path === suggestion.path) ? 'Replace file' : 'New file';
                  return <div className="suggestion" key={`${suggestion.path}-${index}`} data-testid={`suggestion-${message.id}-${index}`}>
                  <div className="suggestion-head"><span className="suggestion-file"><FileCode2 />{suggestion.path}</span><span className="kind-badge">{kindLabel}</span><span className="review-status">{suggestion.status === 'pending' ? 'Review required' : suggestion.status}</span></div>
                  {kind === 'delete' ? <div className="suggestion-note">Accepting removes this file from the workspace.</div> : kind === 'patch' ? <div className="patch-list">{(suggestion.patches || []).map((patch, patchIndex) => <div className="patch-part" key={patchIndex}><div className="patch-label">Find</div><pre>{patch.find}</pre><div className="patch-label">Replace with</div><pre>{highlightCode(patch.replace)}</pre></div>)}</div> : <pre>{highlightCode(suggestion.content)}</pre>}
                  {suggestion.applyError && <div className="suggestion-error">{suggestion.applyError}</div>}
                  {suggestion.status === 'pending' && <div className="suggestion-actions">
                    <button onClick={() => rejectSuggestion(message.id, index)} data-testid={`reject-edit-${message.id}-${index}`}>Reject</button>
                    <button className="accept" onClick={() => acceptSuggestion(message.id, index)} data-testid={`accept-edit-${message.id}-${index}`}><Check size={11} /> {kind === 'delete' ? 'Accept delete' : 'Accept edit'}</button>
                  </div>}
                </div>; })}
                {(message.suggestions?.filter((entry) => entry.status === 'pending').length ?? 0) >= 2 && <div className="suggestion-actions changeset-actions"><span>{message.suggestions?.filter((entry) => entry.status === 'pending').length} changes pending review</span><button className="accept" onClick={() => acceptAllSuggestions(message.id)} data-testid={`accept-all-${message.id}`}>Accept all changes</button></div>}
              </div>)}
              {streaming && <div className="thinking"><span className="thinking-pulse" />Writing a response…</div>}
            </div>
            {!apiKey && <div className="error-banner" role="alert"><span>Add your OpenRouter API key — use the key field under the chat or in the sidebar. It is stored only in this browser.</span></div>}
            {modelsError && <div className="error-banner" role="alert"><span>Could not load the OpenRouter model catalog. Retry before choosing a model.</span><button onClick={() => refetchModels()} data-testid="button-retry-models">Retry</button></div>}
            {error && <div className="error-banner" role="alert"><span><AlertCircle size={13} /> {error}</span><button onClick={() => setError('')} data-testid="button-dismiss-error">Dismiss</button></div>}
            <div className="composer-wrap">
              <div className="chat-key-bar" data-testid="chat-openrouter-key">
                <span className="chat-key-label"><KeyRound size={13} /> OpenRouter API key</span>
                {apiKey && !keyEditing ? <>
                  <span className="chat-key-status">Saved in this browser ····{apiKey.slice(-4)}</span>
                  <button className="plain-button" onClick={() => setKeyEditing(true)} data-testid="button-change-key-chat">Change</button>
                  <button className="plain-button" onClick={clearKey} data-testid="button-clear-key-chat">Remove</button>
                </> : <>
                  <input type="password" value={keyDraft} onChange={(event) => setKeyDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') saveKey(); }} placeholder="sk-or-..." aria-label="OpenRouter API key" data-testid="input-openrouter-key-chat" />
                  <button className="solid-button" onClick={saveKey} disabled={!keyDraft.trim()} data-testid="button-save-key-chat">Save key</button>
                </>}
              </div>
              <div className="context-strip"><FolderOpen /><b>{state.selectedContext.length}</b> file{state.selectedContext.length === 1 ? '' : 's'} included as context{state.selectedContext.length ? ` · ${state.selectedContext.slice(0, 2).join(', ')}${state.selectedContext.length > 2 ? '…' : ''}` : ''}{lastContext ? ` · ${lastContext}` : ''}</div>
              <div className="composer">
                <textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendMessage(); } }} placeholder="Ask about your code…" aria-label="Message the assistant" data-testid="input-chat-message" />
                <div className="composer-controls"><span className="composer-hint">Enter to send · Shift + Enter for a new line</span><button className={`send-button ${streaming ? 'stop' : ''}`} title={streaming ? 'Stop response' : 'Send message'} onClick={() => streaming ? stopStream() : void sendMessage()} disabled={!streaming && (!draft.trim() || modelsLoading || (!actualModels?.length && modelId !== 'openrouter/free'))} data-testid="button-send-message">{streaming ? <Square /> : <Send />}</button></div>
              </div>
              <div className="provider-disclaimer">Models, pricing, and rate limits are controlled by OpenRouter and its providers. Frontier models use your OpenRouter credits; free models are rate-limited.</div>
            </div>
          </section>
        </div>
      </main>
      {newProjectOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setNewProjectOpen(false); }}>
        <div className="modal" role="dialog" aria-modal="true" aria-labelledby="new-project-title">
          <h2 id="new-project-title">Start a new project</h2><p>Create a separate local workspace. Its files and conversations stay separate from your other projects.</p>
          <input autoFocus value={newProjectName} onChange={(event) => setNewProjectName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') createProject(); }} placeholder="Project name" aria-label="Project name" data-testid="input-new-project-name" />
          {modalError && <div className="modal-error">{modalError}</div>}
          <div className="modal-actions"><button className="plain-button" onClick={() => setNewProjectOpen(false)} data-testid="button-cancel-new-project">Cancel</button><button className="solid-button" onClick={createProject} data-testid="button-create-project">Create project</button></div>
        </div>
      </div>}
      {templateOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setTemplateOpen(false); }}>
        <div className="modal" role="dialog" aria-modal="true" aria-labelledby="template-title">
          <h2 id="template-title">Start from a template</h2><p>Each template is a small, complete, runnable project in its own workspace — a serious starting point the assistant can grow with you.</p>
          <div className="template-list">
            {PROJECT_TEMPLATES.map((template) => <button key={template.id} className="template-item" onClick={() => createProjectFromTemplate(template.id)} data-testid={`template-${template.id}`}><strong>{template.name}</strong><span>{template.description}</span><small>{template.files.length} files</small></button>)}
          </div>
          <div className="modal-actions"><button className="plain-button" onClick={() => setTemplateOpen(false)} data-testid="button-cancel-template">Cancel</button></div>
        </div>
      </div>}
      {newFileOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setNewFileOpen(false); }}>
        <div className="modal" role="dialog" aria-modal="true" aria-labelledby="new-file-title">
          <h2 id="new-file-title">Add a project file</h2><p>Choose a path relative to the workspace root. The file stays in this browser unless you connect a local folder and confirm a save.</p>
          <input autoFocus value={newFilePath} onChange={(event) => setNewFilePath(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') createFile(); }} placeholder="src/components/Widget.tsx" data-testid="input-new-file-path" />
          {modalError && <div className="modal-error">{modalError}</div>}
          <div className="modal-actions"><button className="plain-button" onClick={() => setNewFileOpen(false)} data-testid="button-cancel-new-file">Cancel</button><button className="solid-button" onClick={createFile} data-testid="button-create-file">Create file</button></div>
        </div>
      </div>}
      {importOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setImportOpen(false); }}>
        <div className="modal" role="dialog" aria-modal="true" aria-labelledby="import-json-title">
          <h2 id="import-json-title">Import a project snapshot</h2><p>Paste a JSON array of text file objects, or an object containing a files array. Use Upload for files and ZIP archives, or Open local folder for permission-based device access.</p>
          <textarea value={importText} onChange={(event) => setImportText(event.target.value)} placeholder={'[\n  { "path": "src/main.ts", "content": "..." }\n]'} data-testid="input-import-json" />
          {modalError && <div className="modal-error">{modalError}</div>}
          <div className="modal-actions"><button className="plain-button" onClick={() => setImportOpen(false)} data-testid="button-cancel-import">Cancel</button><button className="solid-button" onClick={importPastedFiles} data-testid="button-confirm-import">Import files</button></div>
        </div>
      </div>}
      {toast && <div className="toast-note" role="status" data-testid="status-toast">{toast}</div>}
    </div>
  );
}

const queryClient = new QueryClient();
function Router() {
  return <RoutedErrorBoundary><Switch><Route path="/" component={Home} /><Route component={NotFound} /></Switch></RoutedErrorBoundary>;
}
function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}
function App() {
  return <QueryClientProvider client={queryClient}><TooltipProvider><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><Router /></WouterRouter><Toaster /></TooltipProvider></QueryClientProvider>;
}
export default App;
