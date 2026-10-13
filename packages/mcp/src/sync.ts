import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Context, FileSynchronizer, envManager } from "@zilliz/claude-context-core";
import { SnapshotManager } from "./snapshot.js";
import type { RequestSplitterType } from "./config.js";
import { createRequestSplitter, resolveRequestSplitterType } from "./splitter.js";
import { SyncLease } from "./sync-lease.js";

// First sync after startup: a short settle delay, spread by up to
// INITIAL_SYNC_JITTER_MS so sessions started together do not wake together.
const DEFAULT_INITIAL_SYNC_DELAY_MS = 5_000;
const INITIAL_SYNC_JITTER_MS = 30_000;
// Only the lease owner syncs, and the branch overlay is refreshed lazily on
// every search, so the background pass is a backstop for base checkouts — it
// does not need to run every five minutes.
const DEFAULT_SYNC_INTERVAL_MS = 15 * 60 * 1000;
const MIN_SYNC_INTERVAL_MS = 1_000;
// Each interval is drawn from [1 - j, 1 + j] x the configured one.
const DEFAULT_SYNC_JITTER = 0.2;
// How often a standby checks whether the owner has gone. Cheap: one stat.
const STANDBY_POLL_MS = 60_000;
// Owner heartbeat; well inside the lease's stale window (sync-lease.ts) and the
// 10-minute window older builds use to reclaim the same lock.
const LEASE_HEARTBEAT_MS = 30_000;

function isBackgroundSyncEnabled(): boolean {
    const value = envManager.get("CLAUDE_CONTEXT_BACKGROUND_SYNC");
    if (!value) {
        return true;
    }

    switch (value.trim().toLowerCase()) {
        case "1":
        case "true":
        case "yes":
        case "on":
            return true;
        case "0":
        case "false":
        case "no":
        case "off":
            return false;
        default:
            console.warn(
                `[SYNC-DEBUG] Invalid CLAUDE_CONTEXT_BACKGROUND_SYNC value '${value}'. ` +
                "Expected true/false. Background sync will remain enabled."
            );
            return true;
    }
}

function getBackgroundSyncIntervalMs(): number {
    const value = envManager.get("CLAUDE_CONTEXT_SYNC_INTERVAL_MS");
    if (!value) {
        return DEFAULT_SYNC_INTERVAL_MS;
    }

    const intervalMs = Number.parseInt(value, 10);
    if (!Number.isFinite(intervalMs) || intervalMs < MIN_SYNC_INTERVAL_MS) {
        console.warn(
            `[SYNC-DEBUG] Invalid CLAUDE_CONTEXT_SYNC_INTERVAL_MS value '${value}'. ` +
            `Falling back to ${DEFAULT_SYNC_INTERVAL_MS}ms.`
        );
        return DEFAULT_SYNC_INTERVAL_MS;
    }

    return intervalMs;
}

function getSyncJitter(): number {
    const value = envManager.get("CLAUDE_CONTEXT_SYNC_JITTER");
    const jitter = value === undefined ? NaN : Number.parseFloat(value);
    return Number.isFinite(jitter) && jitter >= 0 && jitter < 1 ? jitter : DEFAULT_SYNC_JITTER;
}

/** `ms` spread uniformly over [1 - jitter, 1 + jitter], never below the floor. */
export function jittered(ms: number, jitter: number, random: () => number = Math.random): number {
    const factor = 1 - jitter + 2 * jitter * random();
    return Math.max(MIN_SYNC_INTERVAL_MS, Math.round(ms * factor));
}

export interface SyncManagerOptions {
    lease?: SyncLease;
}

export class SyncManager {
    private context: Context;
    private snapshotManager: SnapshotManager;
    private isSyncing: boolean = false;
    private readonly lease: SyncLease;
    private triggerWatcher: fs.FSWatcher | null = null;
    private triggerDebounceTimer: NodeJS.Timeout | null = null;
    private syncTimer: NodeJS.Timeout | null = null;
    private heartbeatTimer: NodeJS.Timeout | null = null;
    private stopped: boolean = false;

    constructor(context: Context, snapshotManager: SnapshotManager, options: SyncManagerOptions = {}) {
        this.context = context;
        this.snapshotManager = snapshotManager;
        this.lease = options.lease ?? new SyncLease();
    }

    /**
     * Whether this process may run a sync now: it owns the machine-wide lease,
     * taking it over if the previous owner is gone. Starting the heartbeat on
     * the first acquisition keeps the lease ours for the rest of our life.
     */
    private ensureSyncOwner(): boolean {
        const wasHeld = this.lease.isHeld();
        if (!this.lease.tryAcquire()) {
            const owner = this.lease.readOwner();
            console.log(`[SYNC-DEBUG] Standing by: background sync is owned by pid ${owner?.pid ?? 'unknown'}.`);
            return false;
        }
        if (!wasHeld) {
            console.log(`[SYNC] This process (pid ${process.pid}) now owns background sync for the machine.`);
            this.startHeartbeat();
        }
        return true;
    }

    private startHeartbeat(): void {
        if (this.heartbeatTimer) return;
        this.heartbeatTimer = setInterval(() => {
            if (!this.lease.heartbeat()) {
                console.warn('[SYNC] Lost the background-sync lease; standing by.');
                this.stopHeartbeat();
            }
        }, LEASE_HEARTBEAT_MS);
        this.heartbeatTimer.unref?.();
    }

    private stopHeartbeat(): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    /**
     * Ordinary checkouts that have the base branch checked out, in repositories
     * whose base index is maintained from a managed checkout. Syncing one would
     * write base-branch rows from wherever a developer left it — weeks behind
     * origin, say — over the managed checkout's fresh ones. The snapshot cannot
     * be relied on to drop such an entry: every running server re-adds the
     * entries it loaded at startup whenever it saves.
     */
    private unmanagedBaseCheckouts(codebases: string[]): Set<string> {
        const managedRepos = new Set<string>();
        const unmanaged: Array<[string, string]> = [];
        for (const codebasePath of codebases) {
            if (!fs.existsSync(codebasePath)) continue;
            const repo = this.context.repositoryId(codebasePath);
            if (repo === null) continue;
            const role = this.context.baseCheckoutRole(codebasePath);
            if (role === 'managed') managedRepos.add(repo);
            else if (role === 'unmanaged') unmanaged.push([codebasePath, repo]);
        }
        return new Set(unmanaged.filter(([, repo]) => managedRepos.has(repo)).map(([p]) => p));
    }

    public async handleSyncIndex(): Promise<void> {
        const syncStartTime = Date.now();
        console.log(`[SYNC-DEBUG] handleSyncIndex() called at ${new Date().toISOString()}`);

        const indexedCodebases = this.snapshotManager.getIndexedCodebases();

        if (indexedCodebases.length === 0) {
            console.log('[SYNC-DEBUG] No codebases indexed. Skipping sync.');
            return;
        }

        console.log(`[SYNC-DEBUG] Found ${indexedCodebases.length} indexed codebases:`, indexedCodebases);
        const skipped = this.unmanagedBaseCheckouts(indexedCodebases);

        if (this.isSyncing) {
            console.log('[SYNC-DEBUG] Index sync already in progress. Skipping.');
            return;
        }

        if (!this.ensureSyncOwner()) {
            return;
        }

        this.isSyncing = true;
        console.log(`[SYNC-DEBUG] Starting index sync for all ${indexedCodebases.length} codebases...`);

        try {
            let totalStats = { added: 0, removed: 0, modified: 0 };

            for (let i = 0; i < indexedCodebases.length; i++) {
                const codebasePath = indexedCodebases[i];
                const codebaseStartTime = Date.now();
                if (skipped.has(codebasePath)) {
                    console.log(`[SYNC] Skipping '${codebasePath}': it has the base branch checked out, but its repository's base index follows a managed checkout.`);
                    continue;
                }

                console.log(`[SYNC-DEBUG] [${i + 1}/${indexedCodebases.length}] Starting sync for codebase: '${codebasePath}'`);

                // Check if codebase path still exists
                try {
                    const pathExists = fs.existsSync(codebasePath);
                    console.log(`[SYNC-DEBUG] Codebase path exists: ${pathExists}`);

                    if (!pathExists) {
                        console.warn(`[SYNC-DEBUG] Codebase path '${codebasePath}' no longer exists. Skipping sync.`);
                        continue;
                    }
                } catch (pathError: any) {
                    console.error(`[SYNC-DEBUG] Error checking codebase path '${codebasePath}':`, pathError);
                    continue;
                }

                try {
                    console.log(`[SYNC-DEBUG] Calling context.reindexByChange() for '${codebasePath}'`);
                    const codebaseInfo = this.snapshotManager.getCodebaseInfo(codebasePath);
                    const requestSplitterType: RequestSplitterType = resolveRequestSplitterType(codebaseInfo?.requestSplitter);
                    const requestIgnorePatterns = codebaseInfo?.requestIgnorePatterns || [];
                    const requestCustomExtensions = codebaseInfo?.requestCustomExtensions || [];
                    const stats = await this.context.reindexByChange(
                        codebasePath,
                        undefined,
                        requestIgnorePatterns,
                        requestCustomExtensions,
                        createRequestSplitter(requestSplitterType)
                    );
                    const codebaseElapsed = Date.now() - codebaseStartTime;

                    console.log(`[SYNC-DEBUG] Reindex stats for '${codebasePath}':`, stats);
                    console.log(`[SYNC-DEBUG] Codebase sync completed in ${codebaseElapsed}ms`);

                    // Accumulate total stats
                    totalStats.added += stats.added;
                    totalStats.removed += stats.removed;
                    totalStats.modified += stats.modified;

                    if (stats.added > 0 || stats.removed > 0 || stats.modified > 0) {
                        console.log(`[SYNC] Sync complete for '${codebasePath}'. Added: ${stats.added}, Removed: ${stats.removed}, Modified: ${stats.modified} (${codebaseElapsed}ms)`);
                    } else {
                        console.log(`[SYNC] No changes detected for '${codebasePath}' (${codebaseElapsed}ms)`);
                    }
                } catch (error: any) {
                    const codebaseElapsed = Date.now() - codebaseStartTime;
                    console.error(`[SYNC-DEBUG] Error syncing codebase '${codebasePath}' after ${codebaseElapsed}ms:`, error);
                    console.error(`[SYNC-DEBUG] Error stack:`, error.stack);

                    if (error.message.includes('Failed to query Milvus')) {
                        // Collection maybe deleted manually, delete the snapshot file
                        await FileSynchronizer.deleteSnapshot(codebasePath);
                    }

                    // Log additional error details
                    if (error.code) {
                        console.error(`[SYNC-DEBUG] Error code: ${error.code}`);
                    }
                    if (error.errno) {
                        console.error(`[SYNC-DEBUG] Error errno: ${error.errno}`);
                    }

                    // Continue with next codebase even if one fails
                }
            }

            const totalElapsed = Date.now() - syncStartTime;
            console.log(`[SYNC-DEBUG] Total sync stats across all codebases: Added: ${totalStats.added}, Removed: ${totalStats.removed}, Modified: ${totalStats.modified}`);
            console.log(`[SYNC-DEBUG] Index sync completed for all codebases in ${totalElapsed}ms`);
            console.log(`[SYNC] Index sync completed for all codebases. Total changes - Added: ${totalStats.added}, Removed: ${totalStats.removed}, Modified: ${totalStats.modified}`);
        } catch (error: any) {
            const totalElapsed = Date.now() - syncStartTime;
            console.error(`[SYNC-DEBUG] Error during index sync after ${totalElapsed}ms:`, error);
            console.error(`[SYNC-DEBUG] Error stack:`, error.stack);
        } finally {
            this.isSyncing = false;
            const totalElapsed = Date.now() - syncStartTime;
            console.log(`[SYNC-DEBUG] handleSyncIndex() finished at ${new Date().toISOString()}, total duration: ${totalElapsed}ms`);
        }
    }

    public startBackgroundSync(): void {
        console.log('[SYNC-DEBUG] startBackgroundSync() called');

        // Set up the trigger file watcher first, independent of polling.
        this.setupTriggerWatcher();

        if (!isBackgroundSyncEnabled()) {
            console.log('[SYNC-DEBUG] Background sync is disabled via CLAUDE_CONTEXT_BACKGROUND_SYNC=false.');
            return;
        }

        const intervalMs = getBackgroundSyncIntervalMs();
        const jitter = getSyncJitter();
        this.stopped = false;

        const firstDelay = Math.min(
            DEFAULT_INITIAL_SYNC_DELAY_MS + Math.round(Math.random() * INITIAL_SYNC_JITTER_MS),
            intervalMs
        );
        console.log(`[SYNC-DEBUG] Background sync: first check in ${firstDelay}ms, then every ~${intervalMs}ms (±${Math.round(jitter * 100)}%) while this process owns the machine-wide lease.`);
        this.scheduleTick(firstDelay, intervalMs, jitter);
    }

    /**
     * One self-rescheduling timer instead of a fixed setInterval: the owner
     * waits a jittered interval between passes, a standby re-checks the lease
     * every minute so it can take over promptly when the owner exits.
     */
    private scheduleTick(delayMs: number, intervalMs: number, jitter: number): void {
        if (this.stopped) return;
        this.syncTimer = setTimeout(async () => {
            let owner = false;
            try {
                owner = this.ensureSyncOwner();
                if (owner) {
                    console.log('[SYNC-DEBUG] Executing scheduled background sync');
                    await this.handleSyncIndex();
                }
            } catch (error) {
                // A rejection here has no caller to propagate to; escaping as an
                // unhandled rejection would take the whole server down.
                const errorMessage = error instanceof Error ? error.message : String(error);
                if (errorMessage.includes('Failed to query collection')) {
                    console.log('[SYNC-DEBUG] Collection not yet established; will retry on the next cycle.');
                } else {
                    console.error('[SYNC-DEBUG] Background sync failed:', error);
                }
            }
            const next = owner ? jittered(intervalMs, jitter) : jittered(Math.min(STANDBY_POLL_MS, intervalMs), jitter);
            this.scheduleTick(next, intervalMs, jitter);
        }, delayMs);
        this.syncTimer.unref?.();
    }

    /**
     * Stop syncing and hand the lease back so a standby can take over at once
     * rather than after the stale window. Idempotent; safe from an exit handler.
     */
    public stopBackgroundSync(): void {
        this.stopped = true;
        if (this.syncTimer) {
            clearTimeout(this.syncTimer);
            this.syncTimer = null;
        }
        this.stopHeartbeat();
        try {
            this.lease.release();
        } catch (error) {
            console.warn('[SYNC-DEBUG] Could not release the background-sync lease:', error);
        }
    }

    /**
     * Read CLAUDE_CONTEXT_TRIGGER_WATCHER. Default ON — the watcher is cheap and only
     * fires when an external process explicitly touches the trigger file. Users who want
     * zero filesystem watching (e.g. read-only filesystems, sandboxed envs) can disable it.
     */
    private isTriggerWatcherEnabled(): boolean {
        const v = (envManager.get('CLAUDE_CONTEXT_TRIGGER_WATCHER') ?? '').trim().toLowerCase();
        if (!v) return true;
        if (['1', 'true', 'yes', 'on'].includes(v)) return true;
        if (['0', 'false', 'no', 'off'].includes(v)) return false;
        console.warn(
            `[SYNC-DEBUG] Invalid CLAUDE_CONTEXT_TRIGGER_WATCHER value '${v}'. ` +
            'Expected true/false. Trigger watcher will remain enabled.'
        );
        return true;
    }

    /**
     * Watch for trigger file changes to enable instant re-index.
     * Claude Code PostToolUse hooks can touch ~/.context/.sync-trigger
     * after Write/Edit operations to trigger immediate re-indexing.
     */
    private setupTriggerWatcher(): void {
        if (!this.isTriggerWatcherEnabled()) {
            console.log('[SYNC-DEBUG] Trigger watcher disabled via CLAUDE_CONTEXT_TRIGGER_WATCHER');
            return;
        }

        // Guard against double-initialization (hot reload, repeated test setup).
        if (this.triggerWatcher) {
            console.log('[SYNC-DEBUG] Trigger watcher already active, skipping re-init');
            return;
        }

        const contextDir = path.join(os.homedir(), '.context');
        const triggerFile = '.sync-trigger';
        const triggerPath = path.join(contextDir, triggerFile);

        try {
            // Ensure context dir exists before watching (snapshot manager
            // also creates it, but be defensive in case watcher starts first).
            fs.mkdirSync(contextDir, { recursive: true });

            // Pass encoding so `filename` is consistently a string across platforms
            // (default can be Buffer on some Node builds).
            const watcher = fs.watch(contextDir, { encoding: 'utf8' }, (_event, filename) => {
                // With encoding: 'utf8', filename is `string | null`. null happens on
                // some platforms when the underlying event lacks a name; treat as no-op.
                if (typeof filename !== 'string' || filename !== triggerFile) return;

                if (this.triggerDebounceTimer) clearTimeout(this.triggerDebounceTimer);
                this.triggerDebounceTimer = setTimeout(() => {
                    console.log('[SYNC] 🔔 Trigger file detected, starting instant re-index...');
                    // Fire-and-forget with explicit catch so an unhandled rejection
                    // can't crash the process from inside the setTimeout callback.
                    void this.handleSyncIndex().catch((error) => {
                        const errorMessage = error instanceof Error ? error.message : String(error);
                        if (errorMessage.includes('Failed to query collection')) {
                            console.log('[SYNC-DEBUG] Collection not yet established during trigger sync; will retry on next cycle.');
                        } else {
                            console.error('[SYNC-DEBUG] Triggered sync failed with unexpected error:', error);
                        }
                    });
                }, 2000);
            });

            // fs.watch can emit `error` asynchronously (e.g. dir deleted, fs unmounted).
            // Without a listener this would crash the process.
            watcher.on('error', (err) => {
                console.warn('[SYNC-DEBUG] Trigger watcher error:', err instanceof Error ? err.message : String(err));
                this.stopTriggerWatcher();
            });

            this.triggerWatcher = watcher;
            console.log(`[SYNC-DEBUG] Trigger watcher active on ${triggerPath}`);
        } catch (error) {
            if (error instanceof Error) {
                console.warn('[SYNC-DEBUG] Could not set up trigger watcher:', error.message);
                if (error.stack) console.warn(error.stack);
            } else {
                console.warn('[SYNC-DEBUG] Could not set up trigger watcher:', String(error));
            }
        }
    }

    /** Stop the watcher (idempotent). Useful for tests or graceful shutdown. */
    public stopTriggerWatcher(): void {
        if (this.triggerDebounceTimer) {
            clearTimeout(this.triggerDebounceTimer);
            this.triggerDebounceTimer = null;
        }
        if (this.triggerWatcher) {
            try { this.triggerWatcher.close(); } catch { /* already closed */ }
            this.triggerWatcher = null;
        }
    }
}
