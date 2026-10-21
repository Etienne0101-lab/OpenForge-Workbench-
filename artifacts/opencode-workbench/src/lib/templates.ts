// One-click starter scaffolds. Each template is a small but complete,
// runnable project — a serious starting point the assistant can build on.

export type TemplateFile = { path: string; content: string };
export type ProjectTemplate = {
  id: string;
  name: string;
  description: string;
  files: TemplateFile[];
};

export const PROJECT_TEMPLATES: ProjectTemplate[] = [
  {
    id: 'ml-training',
    name: 'ML Training Pipeline (PyTorch)',
    description: 'Config-driven training with checkpointing, metrics, and a clean model/data split.',
    files: [
      {
        path: 'config.yaml',
        content: `# Training configuration — everything reproducible lives here.
seed: 42
data:
  dataset: mnist
  batch_size: 128
  num_workers: 2
model:
  hidden_dim: 256
  dropout: 0.1
train:
  epochs: 10
  lr: 0.001
  weight_decay: 0.0001
  checkpoint_dir: checkpoints
`,
      },
      {
        path: 'model.py',
        content: `"""Model definitions. Keep architectures here, training logic in train.py."""
import torch
from torch import nn


class MLP(nn.Module):
    def __init__(self, input_dim: int = 784, hidden_dim: int = 256, num_classes: int = 10, dropout: float = 0.1):
        super().__init__()
        self.net = nn.Sequential(
            nn.Flatten(),
            nn.Linear(input_dim, hidden_dim),
            nn.ReLU(),
            nn.Dropout(dropout),
            nn.Linear(hidden_dim, hidden_dim),
            nn.ReLU(),
            nn.Linear(hidden_dim, num_classes),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.net(x)
`,
      },
      {
        path: 'data.py',
        content: `"""Dataset loading. All transforms and splits are explicit and seeded."""
import torch
from torch.utils.data import DataLoader
from torchvision import datasets, transforms


def make_loaders(dataset: str, batch_size: int, num_workers: int, seed: int):
    if dataset != "mnist":
        raise ValueError(f"Unsupported dataset: {dataset}")
    transform = transforms.Compose([transforms.ToTensor(), transforms.Normalize((0.1307,), (0.3081,))])
    generator = torch.Generator().manual_seed(seed)
    train_set = datasets.MNIST("data", train=True, download=True, transform=transform)
    val_set = datasets.MNIST("data", train=False, download=True, transform=transform)
    train_loader = DataLoader(train_set, batch_size=batch_size, shuffle=True, num_workers=num_workers, generator=generator)
    val_loader = DataLoader(val_set, batch_size=batch_size, num_workers=num_workers)
    return train_loader, val_loader
`,
      },
      {
        path: 'train.py',
        content: `"""Train with config, metrics, and checkpoint/resume as defaults.

Usage: python train.py --config config.yaml
"""
import argparse
import json
import random
from pathlib import Path

import numpy as np
import torch
import yaml
from torch import nn

from data import make_loaders
from model import MLP


def set_seed(seed: int) -> None:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)


@torch.no_grad()
def evaluate(model, loader, device) -> float:
    model.eval()
    correct = total = 0
    for x, y in loader:
        pred = model(x.to(device)).argmax(dim=1).cpu()
        correct += (pred == y).sum().item()
        total += y.size(0)
    return correct / total


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default="config.yaml")
    parser.add_argument("--resume", default=None, help="Checkpoint path to resume from")
    args = parser.parse_args()

    cfg = yaml.safe_load(Path(args.config).read_text())
    set_seed(cfg["seed"])
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

    train_loader, val_loader = make_loaders(
        cfg["data"]["dataset"], cfg["data"]["batch_size"], cfg["data"]["num_workers"], cfg["seed"]
    )
    model = MLP(hidden_dim=cfg["model"]["hidden_dim"], dropout=cfg["model"]["dropout"]).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=cfg["train"]["lr"], weight_decay=cfg["train"]["weight_decay"])
    loss_fn = nn.CrossEntropyLoss()

    start_epoch = 0
    if args.resume:
        state = torch.load(args.resume, map_location=device)
        model.load_state_dict(state["model"])
        optimizer.load_state_dict(state["optimizer"])
        start_epoch = state["epoch"] + 1

    ckpt_dir = Path(cfg["train"]["checkpoint_dir"])
    ckpt_dir.mkdir(parents=True, exist_ok=True)
    history = []
    for epoch in range(start_epoch, cfg["train"]["epochs"]):
        model.train()
        total_loss = 0.0
        for x, y in train_loader:
            optimizer.zero_grad()
            loss = loss_fn(model(x.to(device)), y.to(device))
            loss.backward()
            optimizer.step()
            total_loss += loss.item()
        val_acc = evaluate(model, val_loader, device)
        record = {"epoch": epoch, "train_loss": total_loss / len(train_loader), "val_accuracy": val_acc}
        history.append(record)
        print(json.dumps(record))
        torch.save({"epoch": epoch, "model": model.state_dict(), "optimizer": optimizer.state_dict(), "config": cfg}, ckpt_dir / "last.pt")

    (ckpt_dir / "history.json").write_text(json.dumps(history, indent=2))


if __name__ == "__main__":
    main()
`,
      },
      { path: 'requirements.txt', content: 'torch\ntorchvision\nnumpy\npyyaml\n' },
      {
        path: 'README.md',
        content: `# ML Training Pipeline

Config-driven PyTorch training with seeded data loading, per-epoch metrics,
and checkpoint/resume.

## Run

\`\`\`sh
pip install -r requirements.txt
python train.py --config config.yaml
python train.py --config config.yaml --resume checkpoints/last.pt
\`\`\`

## Layout

- \`train.py\` — training loop, evaluation, checkpointing
- \`model.py\` — architectures only
- \`data.py\` — datasets, transforms, splits
- \`config.yaml\` — every hyperparameter, in one place

Next steps to ask the assistant for: experiment tracking, mixed precision,
a held-out test evaluation, or exporting the model for serving.
`,
      },
    ],
  },
  {
    id: 'fastapi-ml-service',
    name: 'FastAPI ML Service',
    description: 'Typed inference API with a model registry, health checks, and a Dockerfile.',
    files: [
      {
        path: 'app/main.py',
        content: `"""FastAPI inference service.

Run: uvicorn app.main:app --reload  ·  Docs: http://localhost:8000/docs
"""
from fastapi import FastAPI, HTTPException

from app.model import ModelRegistry
from app.schemas import HealthResponse, PredictRequest, PredictResponse

app = FastAPI(title="ML Service", version="0.1.0")
registry = ModelRegistry()


@app.on_event("startup")
def load_models() -> None:
    registry.load()


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(status="ok", model_loaded=registry.ready)


@app.post("/predict", response_model=PredictResponse)
def predict(request: PredictRequest) -> PredictResponse:
    if not registry.ready:
        raise HTTPException(status_code=503, detail="Model is not loaded yet")
    label, confidence, scores = registry.predict(request.features)
    return PredictResponse(label=label, confidence=confidence, scores=scores)
`,
      },
      {
        path: 'app/model.py',
        content: `"""Model loading and inference. Swap the stub for a real model in load()."""
import math


class ModelRegistry:
    def __init__(self) -> None:
        self.ready = False
        self.classes = ["negative", "neutral", "positive"]

    def load(self) -> None:
        # Load weights here (joblib, torch.load, ONNX session, ...).
        self.ready = True

    def predict(self, features: list[float]) -> tuple[str, float, dict[str, float]]:
        # Deterministic stand-in scoring so the service runs end to end
        # before a real model exists. Replace with real inference.
        raw = [math.tanh(sum(features) * w) for w in (-0.7, 0.1, 0.8)]
        exps = [math.exp(v) for v in raw]
        total = sum(exps)
        probs = [v / total for v in exps]
        best = max(range(len(probs)), key=lambda i: probs[i])
        return self.classes[best], probs[best], dict(zip(self.classes, probs))
`,
      },
      {
        path: 'app/schemas.py',
        content: `from pydantic import BaseModel, Field


class PredictRequest(BaseModel):
    features: list[float] = Field(..., min_length=1, description="Feature vector")


class PredictResponse(BaseModel):
    label: str
    confidence: float
    scores: dict[str, float]


class HealthResponse(BaseModel):
    status: str
    model_loaded: bool
`,
      },
      { path: 'app/__init__.py', content: '' },
      { path: 'requirements.txt', content: 'fastapi\nuvicorn[standard]\npydantic\n' },
      {
        path: 'Dockerfile',
        content: `FROM python:3.12-slim
WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
`,
      },
      {
        path: 'README.md',
        content: `# FastAPI ML Service

Typed inference API: \`GET /health\`, \`POST /predict\`, interactive docs at \`/docs\`.

## Run

\`\`\`sh
pip install -r requirements.txt
uvicorn app.main:app --reload
# or: docker build -t ml-service . && docker run -p 8000:8000 ml-service
\`\`\`

Replace the stub scorer in \`app/model.py\` with a real model to go live.
`,
      },
    ],
  },
  {
    id: 'react-ts-app',
    name: 'React + TypeScript App',
    description: 'Minimal Vite-style React app skeleton with a component split and typed state.',
    files: [
      { path: 'package.json', content: `{\n  "name": "react-ts-app",\n  "private": true,\n  "type": "module",\n  "scripts": { "dev": "vite", "build": "vite build", "typecheck": "tsc --noEmit" },\n  "dependencies": { "react": "^19.1.0", "react-dom": "^19.1.0" },\n  "devDependencies": { "@vitejs/plugin-react": "^5.0.0", "typescript": "~5.9.0", "vite": "^7.0.0" }\n}\n` },
      {
        path: 'index.html',
        content: `<!DOCTYPE html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>React + TS App</title>\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.tsx"></script>\n  </body>\n</html>\n`,
      },
      {
        path: 'src/main.tsx',
        content: `import { createRoot } from 'react-dom/client';\nimport App from './App';\nimport './styles.css';\n\ncreateRoot(document.getElementById('root')!).render(<App />);\n`,
      },
      {
        path: 'src/App.tsx',
        content: `import { useState } from 'react';\nimport { Counter } from './components/Counter';\n\nexport default function App() {\n  const [name, setName] = useState('world');\n  return (\n    <main className="page">\n      <h1>Hello, {name}.</h1>\n      <p>A small React + TypeScript starting point — ask the assistant to grow it.</p>\n      <label>\n        Your name{' '}\n        <input value={name} onChange={(event) => setName(event.target.value)} />\n      </label>\n      <Counter />\n    </main>\n  );\n}\n`,
      },
      {
        path: 'src/components/Counter.tsx',
        content: `import { useState } from 'react';\n\nexport function Counter() {\n  const [count, setCount] = useState(0);\n  return (\n    <button type="button" onClick={() => setCount(count + 1)}>\n      Count: {count}\n    </button>\n  );\n}\n`,
      },
      { path: 'src/styles.css', content: `:root { color: #1d2733; background: #f6f4ee; font-family: system-ui, sans-serif; }\n.page { max-width: 44rem; margin: 8vh auto; padding: 2rem; display: grid; gap: 1rem; }\ninput { padding: 0.4rem 0.6rem; }\nbutton { padding: 0.5rem 0.9rem; cursor: pointer; }\n` },
      { path: 'README.md', content: '# React + TypeScript App\n\nMinimal Vite + React + TS skeleton.\n\n```sh\nnpm install\nnpm run dev\n```\n' },
    ],
  },
  {
    id: 'data-pipeline',
    name: 'Data Pipeline (Python ETL)',
    description: 'Idempotent ETL with transforms, data-quality checks, and tests.',
    files: [
      {
        path: 'etl.py',
        content: `"""Idempotent ETL: extract -> transform -> load, safe to re-run.

Usage: python etl.py --source data/raw.csv --target data/clean.parquet
"""
import argparse
import hashlib
from pathlib import Path

import pandas as pd

from transforms import add_derived_columns, clean_orders
from quality import run_checks


def extract(path: Path) -> pd.DataFrame:
    return pd.read_csv(path, parse_dates=["ordered_at"])


def load(df: pd.DataFrame, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    # Write-then-rename so a failed run never leaves a partial file.
    tmp = target.with_suffix(".tmp.parquet")
    df.to_parquet(tmp, index=False)
    tmp.replace(target)


def fingerprint(df: pd.DataFrame) -> str:
    return hashlib.sha256(pd.util.hash_pandas_object(df, index=True).values.tobytes()).hexdigest()[:12]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--target", required=True)
    args = parser.parse_args()

    raw = extract(Path(args.source))
    clean = add_derived_columns(clean_orders(raw))
    run_checks(clean)
    load(clean, Path(args.target))
    print(f"Wrote {len(clean):,} rows to {args.target} (fingerprint {fingerprint(clean)})")


if __name__ == "__main__":
    main()
`,
      },
      {
        path: 'transforms.py',
        content: `"""Pure transforms — no I/O, trivially testable."""
import pandas as pd


def clean_orders(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    out = out.drop_duplicates(subset=["order_id"])
    out = out[out["amount"] > 0]
    out["customer_email"] = out["customer_email"].str.strip().str.lower()
    return out.reset_index(drop=True)


def add_derived_columns(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    out["order_month"] = out["ordered_at"].dt.to_period("M").astype(str)
    out["is_large_order"] = out["amount"] >= 500
    return out
  `,
      },
      {
        path: 'quality.py',
        content: `"""Data-quality gates. Fail loudly before bad data reaches the target."""
import pandas as pd


class DataQualityError(RuntimeError):
    pass


def run_checks(df: pd.DataFrame) -> None:
    if df.empty:
        raise DataQualityError("Dataset is empty")
    if df["order_id"].duplicated().any():
        raise DataQualityError("Duplicate order_id values remain after cleaning")
    if df["amount"].isna().any() or (df["amount"] <= 0).any():
        raise DataQualityError("Non-positive or missing amounts found")
    null_rate = df["customer_email"].isna().mean()
    if null_rate > 0.01:
        raise DataQualityError(f"customer_email null rate {null_rate:.1%} exceeds 1%")
`,
      },
      {
        path: 'tests/test_transforms.py',
        content: `import pandas as pd

from transforms import clean_orders


def test_clean_orders_dedupes_and_filters():
    df = pd.DataFrame(
        {
            "order_id": [1, 1, 2],
            "amount": [10.0, 10.0, -5.0],
            "customer_email": [" A@x.com ", "a@x.com", "b@x.com"],
            "ordered_at": pd.to_datetime(["2026-01-01", "2026-01-01", "2026-01-02"]),
        }
    )
    out = clean_orders(df)
    assert len(out) == 1
    assert out.iloc[0]["customer_email"] == "a@x.com"
`,
      },
      { path: 'requirements.txt', content: 'pandas\npyarrow\npytest\n' },
      { path: 'README.md', content: '# Data Pipeline (ETL)\n\nIdempotent extract → transform → load with data-quality gates and tests.\n\n```sh\npip install -r requirements.txt\npython etl.py --source data/raw.csv --target data/clean.parquet\npytest\n```\n' },
    ],
  },
  {
    id: 'node-api',
    name: 'Node API (Express + TypeScript)',
    description: 'Typed Express API with routing, validation, and error handling done properly.',
    files: [
      { path: 'package.json', content: `{\n  "name": "node-api",\n  "private": true,\n  "type": "module",\n  "scripts": { "dev": "tsx watch src/index.ts", "build": "tsc", "start": "node dist/index.js", "typecheck": "tsc --noEmit" },\n  "dependencies": { "express": "^5.1.0", "zod": "^3.25.0" },\n  "devDependencies": { "@types/express": "^5.0.0", "@types/node": "^24.0.0", "tsx": "^4.20.0", "typescript": "~5.9.0" }\n}\n` },
      {
        path: 'src/index.ts',
        content: `import express from 'express';\nimport { itemsRouter } from './routes/items.js';\n\nconst app = express();\napp.use(express.json({ limit: '256kb' }));\n\napp.get('/health', (_req, res) => res.json({ status: 'ok' }));\napp.use('/items', itemsRouter);\n\napp.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {\n  console.error(err);\n  res.status(500).json({ error: 'Internal server error' });\n});\n\nconst port = Number(process.env.PORT ?? 3000);\napp.listen(port, () => console.log(\`API listening on :\${port}\`));\n`,
      },
      {
        path: 'src/routes/items.ts',
        content: `import { Router } from 'express';\nimport { z } from 'zod';\n\nconst CreateItem = z.object({ name: z.string().min(1).max(120), price: z.number().nonnegative() });\ntype Item = z.infer<typeof CreateItem> & { id: string };\n\nconst items = new Map<string, Item>();\n\nexport const itemsRouter = Router();\n\nitemsRouter.get('/', (_req, res) => res.json([...items.values()]));\n\nitemsRouter.post('/', (req, res) => {\n  const parsed = CreateItem.safeParse(req.body);\n  if (!parsed.success) {\n    res.status(400).json({ error: 'Invalid item', details: parsed.error.flatten() });\n    return;\n  }\n  const item: Item = { id: crypto.randomUUID(), ...parsed.data };\n  items.set(item.id, item);\n  res.status(201).json(item);\n});\n\nitemsRouter.get('/:id', (req, res) => {\n  const item = items.get(req.params.id);\n  if (!item) {\n    res.status(404).json({ error: 'Item not found' });\n    return;\n  }\n  res.json(item);\n});\n`,
      },
      { path: 'tsconfig.json', content: '{\n  "compilerOptions": {\n    "target": "ES2022",\n    "module": "NodeNext",\n    "moduleResolution": "NodeNext",\n    "outDir": "dist",\n    "strict": true,\n    "skipLibCheck": true\n  },\n  "include": ["src"]\n}\n' },
      { path: 'README.md', content: '# Node API (Express + TypeScript)\n\n```sh\nnpm install\nnpm run dev   # http://localhost:3000/health\n```\n\nIn-memory store by design — swap the Map for a database when you outgrow it.\n' },
    ],
  },
  {
    id: 'fullstack-express-sqlite',
    name: 'Full-Stack Web App (Express + SQLite)',
    description: 'Zero-build full-stack app: Express API + SQLite (built into Node) + a served web client with working CRUD.',
    files: [
      { path: 'package.json', content: `{\n  "name": "fullstack-web-app",\n  "private": true,\n  "type": "module",\n  "scripts": { "start": "node server/index.js", "dev": "node --watch server/index.js" },\n  "dependencies": { "express": "^5.1.0" }\n}\n` },
      {
        path: 'server/index.js',
        content: `import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const db = new DatabaseSync(process.env.DATABASE_PATH || 'app.sqlite');
db.exec(\`CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  price REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)\`);
const seed = db.prepare('SELECT COUNT(*) AS count FROM items').get();
if (seed.count === 0) {
  const insert = db.prepare('INSERT INTO items (name, price) VALUES (?, ?)');
  insert.run('Trail mug', 18); insert.run('Field notebook', 12); insert.run('Canvas tote', 26);
}

const app = express();
app.use(express.json({ limit: '256kb' }));

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
app.get('/api/items', (_req, res) => {
  res.json(db.prepare('SELECT * FROM items ORDER BY id DESC').all());
});
app.post('/api/items', (req, res) => {
  const { name, price } = req.body ?? {};
  if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'name is required' });
  const result = db.prepare('INSERT INTO items (name, price) VALUES (?, ?)').run(name.trim(), Number(price) || 0);
  return res.status(201).json(db.prepare('SELECT * FROM items WHERE id = ?').get(result.lastInsertRowid));
});
app.delete('/api/items/:id', (req, res) => {
  const result = db.prepare('DELETE FROM items WHERE id = ?').run(req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'item not found' });
  return res.status(204).end();
});

const here = dirname(fileURLToPath(import.meta.url));
app.use(express.static(join(here, '..', 'public')));
const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(\`Full-stack app on http://localhost:\${port}\`));
`,
      },
      {
        path: 'public/index.html',
        content: `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Items — Full-Stack Demo</title>
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <main class="page">
      <h1>Items</h1>
      <p class="sub">Served by Express, stored in SQLite, rendered in your browser.</p>
      <form id="add-form">
        <input id="name" placeholder="New item name" required />
        <input id="price" type="number" step="0.01" min="0" placeholder="Price" />
        <button type="submit">Add item</button>
      </form>
      <p id="status" role="status"></p>
      <ul id="items"></ul>
    </main>
    <script src="app.js"></script>
  </body>
</html>
`,
      },
      {
        path: 'public/app.js',
        content: `const list = document.querySelector('#items');
const status = document.querySelector('#status');

async function load() {
  status.textContent = 'Loading…';
  try {
    const items = await (await fetch('/api/items')).json();
    status.textContent = items.length ? '' : 'No items yet — add the first one.';
    list.innerHTML = '';
    for (const item of items) {
      const row = document.createElement('li');
      row.innerHTML = \`<span></span><b></b>\`;
      row.querySelector('span').textContent = item.name;
      row.querySelector('b').textContent = \`$\${Number(item.price).toFixed(2)}\`;
      const del = document.createElement('button');
      del.textContent = 'Delete';
      del.onclick = async () => { await fetch(\`/api/items/\${item.id}\`, { method: 'DELETE' }); load(); };
      row.append(del);
      list.append(row);
    }
  } catch {
    status.textContent = 'Could not reach the API. Is the server running? (The workbench preview has no backend — run npm start locally.)';
  }
}

document.querySelector('#add-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = document.querySelector('#name').value;
  const price = document.querySelector('#price').value;
  await fetch('/api/items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, price }) });
  event.target.reset();
  load();
});

load();
`,
      },
      { path: 'public/styles.css', content: `:root { font-family: system-ui, sans-serif; color: #1d2733; background: #f6f4ee; }\n.page { max-width: 40rem; margin: 6vh auto; padding: 1.5rem; display: grid; gap: 1rem; }\n.sub { color: #5b6672; }\nform { display: flex; gap: 0.5rem; flex-wrap: wrap; }\ninput { padding: 0.45rem 0.6rem; }\nbutton { padding: 0.45rem 0.8rem; cursor: pointer; }\nul { list-style: none; padding: 0; display: grid; gap: 0.4rem; }\nli { display: flex; gap: 0.75rem; align-items: baseline; background: #fff; border: 1px solid #e2ded2; border-radius: 8px; padding: 0.6rem 0.8rem; }\nli b { margin-left: auto; }\n` },
      { path: '.env.example', content: 'PORT=3000\nDATABASE_PATH=app.sqlite\n' },
      { path: 'README.md', content: '# Full-Stack Web App (Express + SQLite)\n\nOne process serves the API and the web client. SQLite is built into modern Node (node:sqlite) — no native dependencies, no build step.\n\n```sh\nnpm install\nnpm start          # http://localhost:3000\nnpm run dev        # same, with --watch reloads\n```\n\n- API: GET/POST /api/items, DELETE /api/items/:id, GET /api/health\n- Data: app.sqlite file, created and seeded on first run\n- Client: public/ — plain HTML/CSS/JS, no build\n\nIn the workbench, use the Database panel to explore the same schema (items) with SQL.\n' },
    ],
  },
  {
    id: 'fullstack-fastapi-react',
    name: 'Full-Stack (FastAPI + React + Postgres)',
    description: 'Monorepo: FastAPI backend with SQLAlchemy models and schemas, typed React frontend client, docker-compose Postgres.',
    files: [
      {
        path: 'docker-compose.yml',
        content: `services:\n  db:\n    image: postgres:16-alpine\n    environment:\n      POSTGRES_USER: app\n      POSTGRES_PASSWORD: app\n      POSTGRES_DB: app\n    ports: ["5432:5432"]\n    volumes: ["db-data:/var/lib/postgresql/data"]\n  api:\n    build: ./backend\n    environment:\n      DATABASE_URL: postgresql+psycopg://app:app@db:5432/app\n    ports: ["8000:8000"]\n    depends_on: [db]\nvolumes:\n  db-data:\n`,
      },
      {
        path: 'backend/app/main.py',
        content: `"""FastAPI backend. Run: uvicorn app.main:app --reload (from backend/)."""
import os

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import Base, engine, get_session
from app.models import Item
from app.schemas import ItemCreate, ItemOut

Base.metadata.create_all(engine)

app = FastAPI(title="Full-Stack API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ORIGINS", "http://localhost:5173").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.get("/items", response_model=list[ItemOut])
def list_items(session: Session = Depends(get_session)) -> list[Item]:
    return list(session.scalars(select(Item).order_by(Item.id.desc())))


@app.post("/items", response_model=ItemOut, status_code=201)
def create_item(payload: ItemCreate, session: Session = Depends(get_session)) -> Item:
    item = Item(name=payload.name.strip(), price=payload.price)
    session.add(item)
    session.commit()
    session.refresh(item)
    return item


@app.delete("/items/{item_id}", status_code=204)
def delete_item(item_id: int, session: Session = Depends(get_session)) -> None:
    item = session.get(Item, item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="item not found")
    session.delete(item)
    session.commit()
`,
      },
      {
        path: 'backend/app/db.py',
        content: `import os
from collections.abc import Iterator

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./app.sqlite")


class Base(DeclarativeBase):
    pass


engine = create_engine(DATABASE_URL, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False)


def get_session() -> Iterator[Session]:
    with SessionLocal() as session:
        yield session
`,
      },
      {
        path: 'backend/app/models.py',
        content: `from sqlalchemy import Float, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class Item(Base):
    __tablename__ = "items"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    price: Mapped[float] = mapped_column(Float, default=0)
`,
      },
      {
        path: 'backend/app/schemas.py',
        content: `from pydantic import BaseModel, Field


class ItemCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    price: float = Field(default=0, ge=0)


class ItemOut(BaseModel):
    id: int
    name: str
    price: float

    model_config = {"from_attributes": True}
`,
      },
      { path: 'backend/app/__init__.py', content: '' },
      { path: 'backend/requirements.txt', content: 'fastapi\nuvicorn[standard]\nsqlalchemy\npsycopg[binary]\npydantic\n' },
      { path: 'backend/Dockerfile', content: 'FROM python:3.12-slim\nWORKDIR /srv\nCOPY requirements.txt .\nRUN pip install --no-cache-dir -r requirements.txt\nCOPY app ./app\nEXPOSE 8000\nCMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]\n' },
      {
        path: 'frontend/src/api.ts',
        content: `export type Item = { id: number; name: string; price: number };\n\nconst base = import.meta.env.VITE_API_URL ?? 'http://localhost:8000';\n\nexport async function listItems(): Promise<Item[]> {\n  const response = await fetch(\`\${base}/items\`);\n  if (!response.ok) throw new Error(\`API \${response.status}\`);\n  return response.json();\n}\n\nexport async function createItem(name: string, price: number): Promise<Item> {\n  const response = await fetch(\`\${base}/items\`, {\n    method: 'POST',\n    headers: { 'Content-Type': 'application/json' },\n    body: JSON.stringify({ name, price }),\n  });\n  if (!response.ok) throw new Error(\`API \${response.status}\`);\n  return response.json();\n}\n\nexport async function deleteItem(id: number): Promise<void> {\n  await fetch(\`\${base}/items/\${id}\`, { method: 'DELETE' });\n}\n`,
      },
      {
        path: 'frontend/src/App.tsx',
        content: `import { useEffect, useState } from 'react';\nimport { createItem, deleteItem, listItems, type Item } from './api';\n\nexport default function App() {\n  const [items, setItems] = useState<Item[]>([]);\n  const [name, setName] = useState('');\n  const [error, setError] = useState('');\n\n  const load = async () => {\n    try { setItems(await listItems()); setError(''); }\n    catch { setError('Could not reach the API — is the backend running on :8000?'); }\n  };\n  useEffect(() => { void load(); }, []);\n\n  return (\n    <main style={{ maxWidth: '40rem', margin: '6vh auto', fontFamily: 'system-ui', display: 'grid', gap: '1rem', padding: '1rem' }}>\n      <h1>Items</h1>\n      {error && <p role="alert">{error}</p>}\n      <form onSubmit={async (event) => { event.preventDefault(); if (name.trim()) { await createItem(name.trim(), 0); setName(''); void load(); } }}>\n        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="New item name" />{' '}\n        <button type="submit">Add item</button>\n      </form>\n      <ul>\n        {items.map((item) => (\n          <li key={item.id}>{item.name}{' '}<button type="button" onClick={async () => { await deleteItem(item.id); void load(); }}>Delete</button></li>\n        ))}\n      </ul>\n    </main>\n  );\n}\n`,
      },
      { path: 'frontend/src/main.tsx', content: `import { StrictMode } from 'react';\nimport { createRoot } from 'react-dom/client';\nimport App from './App';\n\ncreateRoot(document.getElementById('root')!).render(\n  <StrictMode>\n    <App />\n  </StrictMode>,\n);\n` },
      { path: 'frontend/index.html', content: `<!DOCTYPE html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>Items — Full-Stack</title>\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.tsx"></script>\n  </body>\n</html>\n` },
      { path: 'frontend/package.json', content: `{\n  "name": "frontend",\n  "private": true,\n  "type": "module",\n  "scripts": { "dev": "vite", "build": "vite build" },\n  "dependencies": { "react": "^19.1.0", "react-dom": "^19.1.0" },\n  "devDependencies": { "@vitejs/plugin-react": "^5.0.0", "typescript": "~5.9.0", "vite": "^7.0.0" }\n}\n` },
      { path: 'README.md', content: '# Full-Stack (FastAPI + React + Postgres)\n\n```sh\ndocker compose up --build     # db + api on :8000\ncd frontend && npm install && npm run dev   # UI on :5173\n```\n\nWithout Docker, the API falls back to a local SQLite file (DATABASE_URL unset):\n\n```sh\ncd backend && pip install -r requirements.txt && uvicorn app.main:app --reload\n```\n\nLayers: backend/app (routes in main.py, models, schemas, db session) - frontend/src (typed API client in api.ts, UI in App.tsx) - Postgres via compose in production shape, SQLite for zero-friction local runs.\n\nPreview note: the workbench preview can render the frontend, but its API calls need the backend running — the UI says so when it cannot connect.\n' },
    ],
  },
];
