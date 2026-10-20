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
];
