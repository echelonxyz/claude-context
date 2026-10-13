import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SyncLease } from "./sync-lease.js";

async function withLockPath(run: (lockPath: string) => Promise<void> | void): Promise<void> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "claude-context-lease-"));
    try {
        await run(path.join(dir, "mcp-sync.lock"));
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

const alive = () => true;
const dead = () => false;

test("one process owns the lease; a second stands by while the owner is alive", () =>
    withLockPath((lockPath) => {
        const owner = new SyncLease({ lockPath, pid: 1001, isAlive: alive });
        const standby = new SyncLease({ lockPath, pid: 1002, isAlive: alive });

        assert.equal(owner.tryAcquire(), true);
        assert.equal(standby.tryAcquire(), false);
        assert.equal(owner.tryAcquire(), true, "re-acquiring a held lease is a no-op success");
        assert.equal(standby.readOwner()?.pid, 1001);
    }));

test("a standby takes over at once when the owner process is gone", () =>
    withLockPath((lockPath) => {
        new SyncLease({ lockPath, pid: 1001, isAlive: alive }).tryAcquire();
        const standby = new SyncLease({ lockPath, pid: 1002, isAlive: dead });

        assert.equal(standby.tryAcquire(), true);
        assert.equal(standby.readOwner()?.pid, 1002);
    }));

test("a lease whose heartbeat lapsed is reclaimed even if the pid looks alive", () =>
    withLockPath((lockPath) => {
        let now = 1_000_000;
        const owner = new SyncLease({ lockPath, pid: 1001, isAlive: alive, staleMs: 60_000, now: () => now });
        assert.equal(owner.tryAcquire(), true);
        const past = new Date(now - 120_000);
        fs.utimesSync(lockPath, past, past);

        const standby = new SyncLease({ lockPath, pid: 1002, isAlive: alive, staleMs: 60_000, now: () => now });
        assert.equal(standby.tryAcquire(), true);
        assert.equal(owner.isHeld(), false, "the old owner notices it lost the lease");
        assert.equal(owner.heartbeat(), false);
    }));

test("the heartbeat keeps the lease fresh against the stale window", () =>
    withLockPath((lockPath) => {
        let now = Date.now();
        const owner = new SyncLease({ lockPath, pid: 1001, isAlive: alive, staleMs: 60_000, now: () => now });
        owner.tryAcquire();
        now += 50_000;
        assert.equal(owner.heartbeat(), true);
        now += 50_000; // 100s since acquire, 50s since heartbeat
        const standby = new SyncLease({ lockPath, pid: 1002, isAlive: alive, staleMs: 60_000, now: () => now });
        assert.equal(standby.tryAcquire(), false);
    }));

test("release removes only our own lease", () =>
    withLockPath((lockPath) => {
        const owner = new SyncLease({ lockPath, pid: 1001, isAlive: alive });
        const other = new SyncLease({ lockPath, pid: 1002, isAlive: alive });
        owner.tryAcquire();
        other.release();
        assert.equal(fs.existsSync(lockPath), true, "a non-owner's release is a no-op");
        owner.release();
        assert.equal(fs.existsSync(lockPath), false);
        assert.equal(other.tryAcquire(), true);
    }));

test("an older build's per-cycle lock (live owner, fresh mtime) is respected", () =>
    withLockPath((lockPath) => {
        // Exactly what the pre-lease build writes while it syncs.
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, "owner.json"),
            JSON.stringify({ pid: 4242, token: "4242-1-x", acquiredAt: new Date().toISOString() }));
        const lease = new SyncLease({ lockPath, pid: 1001, isAlive: (pid) => pid === 4242 });
        assert.equal(lease.tryAcquire(), false);
    }));
