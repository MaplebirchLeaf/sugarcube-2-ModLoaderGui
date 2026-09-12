import {checkAborted, DownloadOptions} from './DependencyInstaller';

export const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;

/** Read incrementally so cancellation and size limits apply before buffering the full response. */
export async function readArchive(response: Response, options: DownloadOptions = {}): Promise<Uint8Array> {
    if (!response.ok) throw new Error(`Download failed: ${response.status} ${response.statusText}`);
    const contentLength = Number(response.headers.get('Content-Length'));
    const total = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : 0;
    if (total > MAX_ARCHIVE_BYTES) {
        await response.body?.cancel();
        throw new Error('Mod archive exceeds 128 MiB.');
    }
    checkAborted(options.signal);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('The download response has no readable body.');
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    const abort = () => { void reader.cancel().catch(() => undefined); };
    options.signal?.addEventListener('abort', abort, {once: true});
    try {
        while (true) {
            checkAborted(options.signal);
            const {done, value} = await reader.read();
            checkAborted(options.signal);
            if (done) break;
            loaded += value.byteLength;
            if (loaded > MAX_ARCHIVE_BYTES) throw new Error('Mod archive exceeds 128 MiB.');
            chunks.push(value);
            options.onProgress?.(loaded, total);
        }
        const archive = new Uint8Array(loaded);
        let offset = 0;
        for (const chunk of chunks) { archive.set(chunk, offset); offset += chunk.length; }
        return archive;
    } finally {
        options.signal?.removeEventListener('abort', abort);
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
    }
}
