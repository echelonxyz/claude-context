import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SyncLease } from "./sync-lease.js";
import { jittered, SyncManager } from "./sync.js";

/**
 * Several MCP servers on one machine (one per Claude Code session) must produce
 * ONE background sync, not one each (echelon-codeindex#2). Driven with real
 * timers at the 1s interval floor.
 */
test("of several servers on one machine, only the lease owner syncs", async () => {
    const previousInterval = process.env.CLAUDE_CONTEXT_SYNC_INTERVAL_MS;
    process.env.CLAUDE_CONTEXT_SYNC_INTERVAL_MS = "1000";
    const leaseDir = await mkdtemp(path.join(os.tmpdir(), "claude-context-owner-"));
    const lockPath = path.join(leaseDir, "mcp-sync.lock");

    const snapshot = { getIndexedCodebases: () => ["/does/not/exist"] } as any;
    const runs = new Map<number, number>();
    const managers = [1, 2, 3].map((pid) => {
        const lease = new SyncLease({ lockPath, pid, isAlive: () => true });
        const manager = new SyncManager({} as any, snapshot, { lease });
        (manager as any).setupTriggerWatcher = () => { };
        // Count passes that got past the ownership gate.
        (manager as any).ensureSyncOwnerOriginal = (manager as any).ensureSyncOwner;
        (manager as any).ensureSyncOwner = function () {
            const owns = this.ensureSyncOwnerOriginal();
            if (owns) runs.set(pid, (runs.get(pid) ?? 0) + 1);
            return owns;
        };
        return manager;
    });

    try {
        managers.forEach((m) => m.startBackgroundSync());
        await new Promise((resolve) => setTimeout(resolve, 3_500));

        assert.equal(runs.size, 1, `exactly one server may sync; saw ${JSON.stringify([...runs])}`);
        const [ownerPid] = [...runs.keys()];

        // The owner leaves; a standby must take over without waiting out a stale window.
        managers[ownerPid - 1].stopBackgroundSync();
        assert.equal(fs.existsSync(lockPath), false, "a stopping owner hands the lease back");
        runs.clear();
        await new Promise((resolve) => setTimeout(resolve, 2_500));
        assert.equal(runs.size, 1, "one standby takes over");
        assert.notEqual([...runs.keys()][0], ownerPid);
    } finally {
        managers.forEach((m) => m.stopBackgroundSync());
        await rm(leaseDir, { recursive: true, force: true });
        if (previousInterval === undefined) delete process.env.CLAUDE_CONTEXT_SYNC_INTERVAL_MS;
        else process.env.CLAUDE_CONTEXT_SYNC_INTERVAL_MS = previousInterval;
    }
});

test("intervals are spread around the configured one, never below the floor", () => {
    assert.equal(jittered(600_000, 0.2, () => 0), 480_000);
    assert.equal(jittered(600_000, 0.2, () => 1), 720_000);
    assert.equal(jittered(600_000, 0, () => 0.7), 600_000);
    assert.equal(jittered(1_000, 0.5, () => 0), 1_000);
});
