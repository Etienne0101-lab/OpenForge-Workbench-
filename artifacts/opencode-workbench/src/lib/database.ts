// In-browser SQLite workbench (sql.js / SQLite compiled to WebAssembly).
//
// The engine loads lazily from a CDN on first use; the database itself
// lives only in page memory. Export/import (.sqlite files) is how work
// persists between sessions — nothing is uploaded anywhere.

export type SqlResultSet = { columns: string[]; values: unknown[][] };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sqlPromise: Promise<any> | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let database: any = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadSql(): Promise<any> {
  if (!sqlPromise) {
    sqlPromise = (async () => {
      const url = 'https://cdn.jsdelivr.net/npm/sql.js@1.13.0/+esm';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod: any = await import(/* @vite-ignore */ url);
      const initSqlJs = mod.default ?? mod;
      return initSqlJs({
        locateFile: (file: string) => `https://cdn.jsdelivr.net/npm/sql.js@1.13.0/dist/${file}`,
      });
    })().catch((error) => {
      sqlPromise = null;
      throw error;
    });
  }
  return sqlPromise;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getDatabase(): Promise<any> {
  const SQL = await loadSql();
  if (!database) database = new SQL.Database();
  return database;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function importDatabase(bytes: Uint8Array): Promise<any> {
  const SQL = await loadSql();
  database = new SQL.Database(bytes);
  return database;
}

export function resetDatabase(): void {
  try {
    database?.close();
  } catch {
    // already closed
  }
  database = null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function runSql(db: any, sql: string): SqlResultSet[] {
  const results = db.exec(sql) as Array<{ columns: string[]; values: unknown[][] }>;
  return results.map((result) => ({ columns: result.columns, values: result.values }));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function listTables(db: any): string[] {
  try {
    const results = runSql(db, "SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name");
    return (results[0]?.values || []).map((row) => String(row[0]));
  } catch {
    return [];
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function exportDatabase(db: any): Uint8Array {
  return db.export() as Uint8Array;
}

export const SAMPLE_SQL = `-- Sample: a tiny schema you can run, query, and iterate on.
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  price REAL NOT NULL,
  stock INTEGER DEFAULT 0
);
INSERT INTO products (name, price, stock) VALUES
  ('Widget', 9.99, 120),
  ('Gadget', 24.50, 34),
  ('Doohickey', 4.75, 0);
SELECT * FROM products WHERE stock > 0 ORDER BY price;
`;
