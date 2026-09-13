import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { hostname, homedir } from "node:os";
import { withPerKeyLock } from "../storage/per-key-mutex.js";
import type { ProxyConfig } from "../types.js";

export interface HistoryReference {
  asset_id: string;
  revision_id: string;
  name: string;
  card: string;
  last_read: number;
}
export interface HistoryEntry {
  id: string;
  anchor: string;
  content: string;
  refs: string[];
  created: number;
  kind: "append" | "checkpoint";
  active: boolean;
  retired_reason?: string;
}
export interface AssetHistoryState {
  runtime?: { workspace: string; maxTurn: number; turns: {anchor: string; seq: number}[]; recentMessages: string[] };
  schema: 1;
  updated: number;
  generation: number;
  lastPrefix: string;
  lastMessages: string[];
  references: Record<string, HistoryReference>;
  liveRefs: string[];
  /** Explicit per-session suppression; never inferred from a summary or hash. */
  suppressedRefs?: string[];
  entries: HistoryEntry[];
}
export function emptyHistory(): AssetHistoryState {
  return { schema: 1, updated: 0, generation: 0, lastPrefix: "", lastMessages: [], references: {}, liveRefs: [], entries: [] };
}
export function historyDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}
export function historyScope(parts: { space: string; user: string; team: string; agent: string; task: string; session: string; source: string }): string {
  return historyDigest(["asset-history-v1", parts.space, parts.user, parts.team, parts.agent, parts.task, parts.session, parts.source]);
}

/** Local durable single-host ledger. No credentials or client message bodies.
 * An exclusive file lock also prevents accidental concurrent writers. Locks of
 * dead processes on the same host are recoverable; foreign-host locks are never
 * stolen. Multi-host shared deployments must supply a transactional store.
 */
export class AssetHistoryStore {
  constructor(readonly directory: string) {}

  private file(scope: string) {
    if (!/^[a-f0-9]{64}$/.test(scope)) throw new Error("invalid_asset_history_scope");
    return join(this.directory, `${scope}.json`);
  }

  async read(scope: string): Promise<AssetHistoryState> {
    try {
      const raw = await fs.readFile(this.file(scope), "utf8");
      if (Buffer.byteLength(raw) > 8_000_000) throw new Error("asset_history_capacity");
      const value = JSON.parse(raw) as AssetHistoryState;
      if (value.schema !== 1 || !Array.isArray(value.entries) || !Array.isArray(value.liveRefs)
          || !value.references || !Array.isArray(value.lastMessages)) throw new Error("invalid_asset_history_record");
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyHistory();
      throw error; // corruption is not an empty history
    }
  }

  async transaction<T>(scope: string, work: (state: AssetHistoryState) => Promise<T>): Promise<T> {
    return withPerKeyLock(`asset-history:${this.directory}:${scope}`, async () => {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      const path = this.file(scope), lock = `${path}.lock`;
      const owner = JSON.stringify({ pid: process.pid, host: hostname(), token: randomUUID() });
      let handle;
      try { handle = await fs.open(lock, "wx", 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        // Recovery is intentionally serialized by a second exclusive lock.
        let recovery;
        try {
          recovery = await fs.open(`${lock}.recovery`, "wx", 0o600);
          const old = JSON.parse(await fs.readFile(lock, "utf8"));
          if (old.host !== hostname() || !Number.isInteger(old.pid)) throw new Error("asset_history_writer_busy");
          try { process.kill(old.pid, 0); throw new Error("asset_history_writer_busy"); }
          catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; }
          await fs.unlink(lock);
          handle = await fs.open(lock, "wx", 0o600);
        } finally {
          if (recovery) { await recovery.close(); await fs.unlink(`${lock}.recovery`); }
        }
      }
      try {
        await handle.writeFile(owner); await handle.sync();
        const state = await this.read(scope);
        const result = await work(state);
        if (state.entries.length > 2048 || Object.keys(state.references).length > 512) throw new Error("asset_history_capacity");
        const raw = JSON.stringify(state);
        if (Buffer.byteLength(raw) > 8_000_000) throw new Error("asset_history_capacity");
        const temp = `${path}.${randomUUID()}.tmp`;
        const output = await fs.open(temp, "wx", 0o600);
        try { await output.writeFile(raw); await output.sync(); }
        finally { await output.close(); }
        try { await fs.rename(temp, path); }
        catch (error) { await fs.unlink(temp).catch(() => {}); throw error; }
        return result;
      } finally {
        await handle.close();
        if (await fs.readFile(lock, "utf8").catch(() => "") === owner) await fs.unlink(lock);
      }
    });
  }
}

export function configuredHistoryStore(config: ProxyConfig): AssetHistoryStore | undefined {
  if (!config.injection?.teamAssets?.progressiveDisclosure || config.injection.teamAssets.historyEnabled === false) return;
  // Never silently pretend that a local ledger is shared across COS workers.
  if (config.storage?.enabled && config.storage.backend === "cos") throw new Error("asset_history_requires_single_host_or_shared_transactional_store; set historyEnabled=false for COS deployments");
  const directory = config.injection.teamAssets.historyDirectory || join(
    process.env.PROXY_DATA_DIR || config.storage?.fs?.fsRoot || join(homedir(), ".memory-tencentdb/proxy-state"), "asset-history",
  );
  return new AssetHistoryStore(directory);
}
