import * as path from "path";

/**
 * Truncate content to specified length
 */
export function truncateContent(content: string, maxLength: number): string {
    if (content.length <= maxLength) {
        return content;
    }
    return content.substring(0, maxLength) + '...';
}

/**
 * Ensure path is absolute. If relative path is provided, resolve it properly.
 */
export function ensureAbsolutePath(inputPath: string): string {
    // If already absolute, return as is
    if (path.isAbsolute(inputPath)) {
        return inputPath;
    }

    // For relative paths, resolve to absolute path
    const resolved = path.resolve(inputPath);
    return resolved;
}

export function trackCodebasePath(codebasePath: string): void {
    const absolutePath = ensureAbsolutePath(codebasePath);
    console.log(`[TRACKING] Tracked codebase path: ${absolutePath} (not marked as indexed)`);
}

/**
 * Markers of "the vector database is not reachable", as opposed to any other
 * failure. The Milvus gRPC client reports an unreachable backend as status 14
 * UNAVAILABLE wrapping a socket-level cause, so match on both layers.
 */
const BACKEND_UNREACHABLE_MARKERS = [
    'UNAVAILABLE',
    'ECONNREFUSED',
    'ENOTFOUND',
    'ETIMEDOUT',
    'EHOSTUNREACH',
    'No connection established',
    'Connection refused',
];

export function isBackendUnreachableError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    // gRPC status 14 is UNAVAILABLE; the SDK exposes it as a numeric `code`.
    if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 14) {
        return true;
    }
    return BACKEND_UNREACHABLE_MARKERS.some((marker) => message.includes(marker));
}

/**
 * Turn a tool failure into text the caller can act on.
 *
 * A down backend used to surface as "check if the codebase has been indexed
 * first", which points at the one thing that is *not* wrong — the index is
 * intact and the address simply refuses connections. An agent that reads the
 * old message re-indexes, fails again, and concludes the tool is useless.
 */
export function describeToolError(error: unknown, action: string): string {
    const message = error instanceof Error ? error.message : String(error);
    if (isBackendUnreachableError(error)) {
        const address = process.env.MILVUS_ADDRESS || 'the configured MILVUS_ADDRESS';
        return `Error ${action}: the code index backend at ${address} is unreachable (${message}). ` +
            `The index itself is fine — the vector database is not running. Start it with \`codeindex up\`, ` +
            `then retry. Do NOT re-index: that will fail the same way.`;
    }
    return `Error ${action}: ${message}`;
}