import type { ChatMessage } from './openrouter';

export type SuggestionPatch = { find: string; replace: string };
export type Suggestion = {
  path: string;
  content: string;
  status: 'pending' | 'accepted' | 'rejected';
  /** Change kind. Absent on suggestions saved by v1 (treated as 'replace'). */
  kind?: 'replace' | 'create' | 'patch' | 'delete';
  patches?: SuggestionPatch[];
  /** Set when a patch/delete could not be applied, so the UI can explain why. */
  applyError?: string;
};
export type WorkMessage = ChatMessage & { id: string; suggestions?: Suggestion[] };
export type Conversation = { id: string; title: string; messages: WorkMessage[]; updatedAt: number };
export type ProjectFile = { path: string; content: string; blob?: Blob; mimeType?: string; size?: number };
export type DeviceDirectoryHandle = FileSystemDirectoryHandle & {
  values(): AsyncIterableIterator<FileSystemHandle & { name: string; kind: 'directory' | 'file' }>;
  queryPermission(options: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission(options: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
};
export type ProjectWorkspace = {
  id: string;
  name: string;
  files: ProjectFile[];
  conversations: Conversation[];
  activeConversationId: string;
  selectedFile: string;
  selectedContext: string[];
  directoryHandle?: DeviceDirectoryHandle;
  /** GitHub sync target for this project (owner/name + branch + last synced commit). */
  githubRepo?: string;
  githubBranch?: string;
  lastSyncedSha?: string;
  /** Deploy targets for this project. */
  deployNetlifySiteId?: string;
  deployVercelProject?: string;
  lastDeployUrl?: string;
  /** Mission Mode missions run against this project (agent works on copyFiles inside each mission). */
  missions?: Mission[];
};
export type MissionPreset = 'supervised' | 'careful' | 'deep';
export type MissionStatus = 'planning' | 'awaiting-plan-approval' | 'running' | 'waiting-user' | 'verifying' | 'blocked' | 'completed' | 'failed' | 'abandoned' | 'merged' | 'discarded';
export type MissionStep = { id: string; title: string; status: 'pending' | 'active' | 'done' | 'failed' | 'skipped'; detail?: string };
export type MissionEvent = { id: string; at: number; kind: 'system' | 'action' | 'observation' | 'plan' | 'change' | 'approval' | 'verification' | 'note' | 'report'; text: string; tool?: string; ok?: boolean };
export type MissionFileChange = { path: string; before: string | null; after: string | null };
export type MissionCheckpoint = { id: string; label: string; atEvent: number; changes: MissionFileChange[] };
export type MissionPending =
  | { kind: 'plan' }
  | { kind: 'change'; rationale: string; suggestions: Suggestion[] }
  | { kind: 'question'; question: string }
  | { kind: 'tool'; tool: string; args: Record<string, unknown>; rationale: string; summary: string; pattern: string };
export type Mission = {
  id: string;
  goal: string;
  modeId: string;
  modelId: string;
  preset: MissionPreset;
  status: MissionStatus;
  steps: MissionStep[];
  events: MissionEvent[];
  baseFiles: ProjectFile[];
  copyFiles: ProjectFile[];
  checkpoints: MissionCheckpoint[];
  messages: ChatMessage[];
  pending?: MissionPending;
  remembered: string[];
  /** LangGraph-style graph state: current node + superstep counter (state is checkpointed every superstep). */
  graphNode?: string;
  supersteps?: number;
  budget: { maxSteps: number; maxRepairs: number; maxMinutes: number; usedSteps: number; usedRepairs: number; startedAt: number };
  verifications: Array<{ name: string; ok: boolean; evidence: string }>;
  report?: string;
  createdAt: number;
  updatedAt: number;
};

export type WorkbenchState = { projects: ProjectWorkspace[]; activeProjectId: string };

const DATABASE_NAME = 'opencode-workbench-local';
const DATABASE_VERSION = 1;
const STORE_NAME = 'workspace';
const WORKSPACE_KEY = 'current';
const LEGACY_STORAGE_KEY = 'opencode-workbench-v1';

export function makeId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function makeConversation(): Conversation {
  return { id: makeId(), title: 'Untitled conversation', messages: [], updatedAt: Date.now() };
}

const STARTER_FILES: ProjectFile[] = [
  { path: 'src', content: '' },
  { path: 'src/App.tsx', content: `import { useState } from "react";\n\nexport default function App() {\n  const [count, setCount] = useState(0);\n\n  return (\n    <main className="page">\n      <h1>A small thing, done well.</h1>\n      <p>Start with the shape of the idea.</p>\n      <button onClick={() => setCount(count + 1)}>\n        Count: {count}\n      </button>\n    </main>\n  );\n}\n` },
  { path: 'src/styles.css', content: `:root {\n  color: #25332d;\n  background: #f4f1e9;\n  font-family: system-ui, sans-serif;\n}\n\n.page {\n  max-width: 46rem;\n  margin: 10vh auto;\n  padding: 2rem;\n}\n` },
  { path: 'README.md', content: `# Fieldnotes UI\n\nA tiny interface for collecting useful thoughts.\n\n## Develop\n\nRun the project locally and make something worth keeping.\n` },
  { path: 'package.json', content: `{\n  "name": "fieldnotes-ui",\n  "private": true,\n  "scripts": {\n    "dev": "vite",\n    "build": "vite build"\n  }\n}\n` },
];

export function makeProject(name: string): ProjectWorkspace {
  const conversation = makeConversation();
  return {
    id: makeId(),
    name: name.trim() || 'Untitled project',
    files: STARTER_FILES.map((file) => ({ ...file })),
    conversations: [conversation],
    activeConversationId: conversation.id,
    selectedFile: 'src/App.tsx',
    selectedContext: ['src/App.tsx'],
  };
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open local workspace storage.'));
  });
}

function readLegacyWorkspace(): WorkbenchState | undefined {
  try {
    const parsed = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) || 'null') as Partial<ProjectWorkspace> | null;
    if (!parsed?.files?.length || !parsed.conversations?.length || !parsed.activeConversationId) return undefined;
    const id = makeId();
    const project: ProjectWorkspace = {
      id,
      name: 'fieldnotes-ui',
      files: parsed.files,
      conversations: parsed.conversations,
      activeConversationId: parsed.activeConversationId,
      selectedFile: parsed.selectedFile || parsed.files[0].path,
      selectedContext: parsed.selectedContext || [],
    };
    return { projects: [project], activeProjectId: id };
  } catch {
    return undefined;
  }
}

export async function loadWorkspaceState(): Promise<WorkbenchState> {
  const db = await openDatabase();
  try {
    const stored = await new Promise<WorkbenchState | undefined>((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(WORKSPACE_KEY);
      request.onsuccess = () => resolve(request.result as WorkbenchState | undefined);
      request.onerror = () => reject(request.error);
    });
    if (stored?.projects?.length && stored.projects.some((project) => project.id === stored.activeProjectId)) return stored;

    const workspace = readLegacyWorkspace() || (() => {
      const project = makeProject('fieldnotes-ui');
      return { projects: [project], activeProjectId: project.id };
    })();
    await persistWorkspaceState(workspace);
    return workspace;
  } finally {
    db.close();
  }
}

export async function persistWorkspaceState(workspace: WorkbenchState): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).put(workspace, WORKSPACE_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('Could not save the local workspace.'));
      transaction.onabort = () => reject(transaction.error || new Error('The local workspace save was cancelled.'));
    });
  } finally {
    db.close();
  }
}
