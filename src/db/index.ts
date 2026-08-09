import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema";
import path from "path";
import fs from "fs";

const dataDir = path.join(process.cwd(), "data");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, "macro.db");
const url = `file:${dbPath.replace(/\\/g, "/")}`;

let client: Client | null = null;

export function getClient(): Client {
  if (!client) {
    client = createClient({ url });
    // Allow waiting when Next.js and ingest share the same SQLite file
    void client.execute("PRAGMA busy_timeout = 8000");
    void client.execute("PRAGMA journal_mode = WAL");
  }
  return client;
}

export function getDb() {
  return drizzle(getClient(), { schema });
}

export type AppDb = ReturnType<typeof getDb>;
