import { execFileSync } from 'node:child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { Context } from './context';

const git = (repo: string, ...args: string[]): string =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf-8' });

/**
 * A branch's overlay is what the BRANCH changed, measured from where it left
 * base — not everything that differs from base's moving tip.
 */
describe('touched files of a branch overlay', () => {
    let tempRoot: string;
    let repo: string;

    beforeEach(async () => {
        tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-context-touched-'));
        repo = path.join(tempRoot, 'repo');
        await fs.mkdir(repo, { recursive: true });
        git(repo, 'init', '-b', 'main');
        git(repo, 'config', 'user.email', 'test@example.com');
        git(repo, 'config', 'user.name', 'Test');
        await fs.writeFile(path.join(repo, 'base.ts'), 'export const base = 1;\n');
        await fs.writeFile(path.join(repo, 'feature.ts'), 'export const feature = 1;\n');
        git(repo, 'add', '.');
        git(repo, 'commit', '-m', 'base');
        git(repo, 'checkout', '-b', 'feature');
        await fs.writeFile(path.join(repo, 'feature.ts'), 'export const feature = 2;\n');
        git(repo, 'commit', '-am', 'feature edit');
        // Base moves on after the branch was cut.
        git(repo, 'checkout', 'main');
        await fs.writeFile(path.join(repo, 'base.ts'), 'export const base = 2;\n');
        await fs.writeFile(path.join(repo, 'later.ts'), 'export const later = 1;\n');
        git(repo, 'add', '.');
        git(repo, 'commit', '-m', 'base moves');
        git(repo, 'checkout', 'feature');
    });

    afterEach(async () => {
        await fs.rm(tempRoot, { recursive: true, force: true });
    });

    const touched = (): string[] => {
        const context = new Context({ vectorDatabase: {} as any, embedding: {} as any }) as any;
        return [...context.touchedFiles(repo)].map((f: string) => path.relative(repo, f)).sort();
    };

    it('counts only what the branch changed, not what base gained since', () => {
        expect(touched()).toEqual(['feature.ts']);
    });

    it('measures from origin/<base> when it exists, even if local base is stale', () => {
        git(repo, 'update-ref', 'refs/remotes/origin/main', 'main');
        git(repo, 'update-ref', 'refs/heads/main', 'main~1'); // local main left behind
        expect(touched()).toEqual(['feature.ts']);
    });

    it('includes untracked files', async () => {
        await fs.writeFile(path.join(repo, 'scratch.ts'), 'export {};\n');
        expect(touched()).toEqual(['feature.ts', 'scratch.ts']);
    });
});
