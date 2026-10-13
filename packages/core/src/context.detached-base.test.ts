import { execFileSync } from 'node:child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { Context } from './context';
import { VectorDatabase } from './vectordb';

const git = (repo: string, ...args: string[]): string =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf-8' });

/**
 * The managed base checkout is DETACHED at origin/<base> (the base branch itself
 * is usually checked out in someone's worktree, and following origin must not
 * move theirs). A marker in that worktree's own git dir makes it index as the
 * base branch; no other worktree of the repo is affected.
 */
describe('a detached worktree marked with codeindex-branch', () => {
    let tempRoot: string;
    let repo: string;
    let managed: string;
    let plainDetached: string;

    beforeEach(async () => {
        tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-context-detached-'));
        repo = path.join(tempRoot, 'repo');
        managed = path.join(tempRoot, 'managed-base');
        plainDetached = path.join(tempRoot, 'plain-detached');
        await fs.mkdir(repo, { recursive: true });
        git(repo, 'init', '-b', 'main');
        git(repo, 'config', 'user.email', 'test@example.com');
        git(repo, 'config', 'user.name', 'Test');
        await fs.writeFile(path.join(repo, 'a.ts'), 'export const a = 1;\n');
        git(repo, 'add', '.');
        git(repo, 'commit', '-m', 'base');
        git(repo, 'worktree', 'add', '--detach', managed, 'main');
        git(repo, 'worktree', 'add', '--detach', plainDetached, 'main');
        const gitDir = git(managed, 'rev-parse', '--absolute-git-dir').trim();
        await fs.writeFile(path.join(gitDir, 'codeindex-branch'), 'main\n');
    });

    afterEach(async () => {
        await fs.rm(tempRoot, { recursive: true, force: true });
    });

    const newContext = () => new Context({ vectorDatabase: {} as jest.Mocked<VectorDatabase>, embedding: {} as any });

    it('indexes as the base branch, into the shared collection', () => {
        const context = newContext() as any;
        expect(context.resolveBranch(managed)).toBe('main');
        expect(context.isOverlayBranch(managed)).toBe(false);
        expect(context.getCollectionName(managed)).toBe(context.getCollectionName(repo));
    });

    it('leaves other detached worktrees of the repo alone', () => {
        const context = newContext() as any;
        expect(context.resolveBranch(plainDetached)).toBe('HEAD');
        expect(context.isOverlayBranch(plainDetached)).toBe(true);
        expect(context.resolveBranch(repo)).toBe('main');
    });
});
