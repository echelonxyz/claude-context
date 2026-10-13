import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SyncLease } from "./sync-lease.js";
import { SyncManager } from "./sync.js";

/**
 * The periodic sync is fire-and-forget: there is no caller to propagate to, so a
 * rejection escaping it becomes an unhandled rejection. Node promotes that to a
 * fatal uncaught exception, which killed the MCP server minutes into a session
 * whenever the vector backend went away — taking every registered tool with it.
 *
 * Driven with the real timer at the 1s floor rather than mock timers, so it runs
 * identically on the Node 18 a developer may have locally and the 20/22/24 matrix CI uses.
 */
test("a failing periodic sync is contained instead of escaping as an unhandled rejection", async () => {
    const previousInterval = process.env.CLAUDE_CONTEXT_SYNC_INTERVAL_MS;
    process.env.CLAUDE_CONTEXT_SYNC_INTERVAL_MS = "1000";

    const escaped: unknown[] = [];
    const onUnhandled = (reason: unknown) => escaped.push(reason);
    process.on("unhandledRejection", onUnhandled);

    // A private lease, so the test neither touches ~/.context nor defers to a
    // real MCP server that happens to own sync on this machine.
    const leaseDir = await mkdtemp(path.join(os.tmpdir(), "claude-context-sync-"));
    const lease = new SyncLease({ lockPath: path.join(leaseDir, "mcp-sync.lock") });
    const manager = new SyncManager({} as any, {} as any, { lease });
    let ticks = 0;
    (manager as any).handleSyncIndex = async () => {
        ticks += 1;
        throw new Error("14 UNAVAILABLE: connect ECONNREFUSED 127.0.0.1:19530");
    };
    // The trigger watcher touches the real filesystem; the interval is the subject here.
    (manager as any).setupTriggerWatcher = () => { };

    try {
        manager.startBackgroundSync();
        await new Promise((resolve) => setTimeout(resolve, 2_500));

        assert.ok(ticks >= 1, `the periodic sync should have run at least once (ran ${ticks})`);
        assert.deepEqual(escaped, [], "no rejection may escape the periodic sync");
    } finally {
        process.off("unhandledRejection", onUnhandled);
        manager.stopBackgroundSync();
        await rm(leaseDir, { recursive: true, force: true });
        if (previousInterval === undefined) delete process.env.CLAUDE_CONTEXT_SYNC_INTERVAL_MS;
        else process.env.CLAUDE_CONTEXT_SYNC_INTERVAL_MS = previousInterval;
    }
});
