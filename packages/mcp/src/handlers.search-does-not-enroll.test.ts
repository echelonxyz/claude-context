import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ToolHandlers } from "./handlers.js";
import { SnapshotManager } from "./snapshot.js";

/**
 * echelon-codeindex#3: collections are per repository, so the shared collection
 * "has rows" for every worktree of the repo. A search from a worktree that was
 * never indexed must be served from that collection WITHOUT registering the
 * worktree as indexed — registration enrols the whole tree in background sync.
 */
test("searching an untracked worktree of an indexed repo serves results and registers nothing", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "claude-context-enroll-"));
    const homeDir = path.join(tempRoot, "home");
    const worktree = path.join(tempRoot, "repo-worktree");
    await mkdir(homeDir, { recursive: true });
    await mkdir(worktree, { recursive: true });
    const originalHome = process.env.HOME;
    process.env.HOME = homeDir;

    try {
        const snapshotManager = new SnapshotManager();
        let searchedPath: string | undefined;
        const context = {
            hasIndex: async () => true, // the repo's shared collection exists
            getEmbedding: () => ({ getProvider: () => "test" }),
            semanticSearch: async (p: string) => {
                searchedPath = p;
                return [{ content: "def gate(): ...", relativePath: "src/gate.py", startLine: 1, endLine: 2, language: "python", score: 1 }];
            },
            pendingOverlayNotice: () => null,
            baseStalenessNotice: () => null,
            getCollectionName: () => "hybrid_code_chunks_x",
            getVectorDatabase: () => ({ getCollectionRowCount: async () => 247_535 }),
        } as any;
        const handlers = new ToolHandlers(context, snapshotManager);
        (handlers as any).syncIndexedCodebasesFromCloud = async () => { };

        const result = await handlers.handleSearchCode({ path: worktree, query: "where is the gate" });

        assert.equal(result.isError, undefined, result.content[0].text);
        assert.match(result.content[0].text, /src\/gate\.py/);
        assert.equal(searchedPath, worktree);
        assert.deepEqual(snapshotManager.getIndexedCodebases(), [], "the search must not enrol the worktree");
        assert.equal(snapshotManager.getCodebaseStatus(worktree), "not_found");
    } finally {
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
        await rm(tempRoot, { recursive: true, force: true });
    }
});

test("get_indexing_status says an untracked worktree of an indexed repo is searchable", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "claude-context-status-shared-"));
    const homeDir = path.join(tempRoot, "home");
    const worktree = path.join(tempRoot, "repo-worktree");
    await mkdir(homeDir, { recursive: true });
    await mkdir(worktree, { recursive: true });
    const originalHome = process.env.HOME;
    process.env.HOME = homeDir;

    try {
        const context = {
            hasIndex: async () => true,
            baseStalenessNotice: () => "⚠️ The shared base index is 42 commits behind main",
        } as any;
        const handlers = new ToolHandlers(context, new SnapshotManager());
        (handlers as any).syncIndexedCodebasesFromCloud = async () => { };

        const result = await handlers.handleGetIndexingStatus({ path: worktree });

        assert.match(result.content[0].text, /searchable through its repository's shared index/);
        assert.match(result.content[0].text, /42 commits behind/);
        assert.doesNotMatch(result.content[0].text, /is not indexed/);
    } finally {
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
        await rm(tempRoot, { recursive: true, force: true });
    }
});
