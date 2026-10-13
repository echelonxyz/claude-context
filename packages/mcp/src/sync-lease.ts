import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * A machine-wide lease that names ONE MCP process as the background-sync owner.
 *
 * Every Claude Code session spawns its own MCP server, and each used to run its
 * own sync loop: ten processes waking every five minutes to contend for a
 * per-cycle lock, all doing one process' work (echelon-codeindex#2). Under the
 * lease, one process owns sync for as long as it lives and the rest stand by;
 * when the owner exits (or dies without releasing) a standby takes over.
 *
 * The lease is the same `~/.context/mcp-sync.lock` directory the per-cycle lock
 * used, held continuously and kept fresh by a heartbeat. That is deliberate:
 * an older build still running in a long-lived session sees a fresh lock, skips
 * its cycle, and so defers to the owner without knowing about leases at all.
 */

const DEFAULT_LEASE_STALE_MS = 3 * 60 * 1000;
const LEASE_STALE_ENV = "CLAUDE_CONTEXT_SYNC_LOCK_STALE_MS";

export interface LeaseOwner {
    pid: number;
    token: string;
    acquiredAt: string;
}

export interface SyncLeaseOptions {
    lockPath?: string;
    staleMs?: number;
    pid?: number;
    /** Liveness probe for a recorded owner pid; injectable for tests. */
    isAlive?: (pid: number) => boolean;
    now?: () => number;
}

function defaultIsAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error: any) {
        // EPERM: the process exists but belongs to someone else.
        return error?.code === "EPERM";
    }
}

function staleMsFromEnv(): number {
    const raw = process.env[LEASE_STALE_ENV];
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_LEASE_STALE_MS;
}

export class SyncLease {
    readonly lockPath: string;
    private readonly staleMs: number;
    private readonly pid: number;
    private readonly isAlive: (pid: number) => boolean;
    private readonly now: () => number;
    private token: string | null = null;

    constructor(options: SyncLeaseOptions = {}) {
        this.lockPath = options.lockPath ?? path.join(os.homedir(), ".context", "mcp-sync.lock");
        this.staleMs = options.staleMs ?? staleMsFromEnv();
        this.pid = options.pid ?? process.pid;
        this.isAlive = options.isAlive ?? defaultIsAlive;
        this.now = options.now ?? Date.now;
    }

    /** Whether this process currently holds the lease (and still owns the lock on disk). */
    isHeld(): boolean {
        if (!this.token) {
            return false;
        }
        const owner = this.readOwner();
        if (owner?.token !== this.token) {
            // Reclaimed from under us (we were stalled past the stale window).
            this.token = null;
            return false;
        }
        return true;
    }

    /**
     * Take the lease if it is free, stale, or held by a dead process. Returns
     * true when this process holds it afterwards.
     */
    tryAcquire(): boolean {
        if (this.isHeld()) {
            return true;
        }
        fs.mkdirSync(path.dirname(this.lockPath), { recursive: true });
        if (this.create()) {
            return true;
        }
        if (!this.isReclaimable()) {
            return false;
        }
        const graveyard = `${this.lockPath}.stale-${this.pid}-${this.now()}`;
        try {
            fs.renameSync(this.lockPath, graveyard);
            fs.rmSync(graveyard, { recursive: true, force: true });
        } catch {
            // Another standby reclaimed it first; whoever creates next wins.
        }
        return this.create();
    }

    /** Keep the lease fresh. Returns false if it has been lost. */
    heartbeat(): boolean {
        if (!this.isHeld()) {
            return false;
        }
        const t = new Date(this.now());
        try {
            fs.utimesSync(this.lockPath, t, t);
            return true;
        } catch {
            this.token = null;
            return false;
        }
    }

    /** Give the lease up, only if it is still ours. Idempotent. */
    release(): void {
        if (this.isHeld()) {
            fs.rmSync(this.lockPath, { recursive: true, force: true });
        }
        this.token = null;
    }

    readOwner(): LeaseOwner | null {
        try {
            return JSON.parse(fs.readFileSync(path.join(this.lockPath, "owner.json"), "utf8")) as LeaseOwner;
        } catch {
            return null;
        }
    }

    private create(): boolean {
        const token = `${this.pid}-${this.now()}-${Math.random().toString(36).slice(2)}`;
        try {
            fs.mkdirSync(this.lockPath);
        } catch (error: any) {
            if (error?.code === "EEXIST") {
                return false;
            }
            throw error;
        }
        const owner: LeaseOwner = { pid: this.pid, token, acquiredAt: new Date(this.now()).toISOString() };
        fs.writeFileSync(path.join(this.lockPath, "owner.json"), JSON.stringify(owner, null, 2));
        this.token = token;
        return true;
    }

    /**
     * A lease is up for grabs when its heartbeat has lapsed, or when the
     * recorded owner process is gone. A lock with no readable owner is only
     * reclaimed once stale: it may be a holder between mkdir and writing owner.json.
     */
    private isReclaimable(): boolean {
        let mtimeMs: number;
        try {
            mtimeMs = fs.statSync(this.lockPath).mtimeMs;
        } catch {
            return true; // vanished: free
        }
        if (this.now() - mtimeMs > this.staleMs) {
            return true;
        }
        const owner = this.readOwner();
        return owner !== null && owner.pid !== this.pid && !this.isAlive(owner.pid);
    }
}
