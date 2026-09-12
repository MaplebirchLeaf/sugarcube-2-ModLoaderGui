import {afterEach, describe, expect, test} from 'bun:test';
import 'fake-indexeddb/auto';
import {DependencyInstaller, DependencyManifest, DependencyStore} from '../src/DependencyInstaller';
import {MAX_ARCHIVE_BYTES, readArchive} from '../src/Download';

afterEach(async () => {
    expect((await indexedDB.databases()).filter(database => database.name?.startsWith('thalia-mod-install-'))).toEqual([]);
});

const data = new Uint8Array([1]);
const rootFile = new Blob([data]);
function manifest(name: string, dependencies: string[] = [], version = '1'): DependencyManifest {
    return {name, version, dependenceInfo: dependencies.map(modName => ({modName, version: '1', downloadUrl: modName}))};
}
function fixture(mods: DependencyManifest[], stored: {manifest: DependencyManifest; disabled?: boolean}[] = []) {
    const saved: string[] = [];
    const requested: string[] = [];
    const store: DependencyStore<DependencyManifest> = {
        list: async () => stored.map(item => ({name: item.manifest.name, disabled: !!item.disabled})),
        metadata: async name => stored.find(item => item.manifest.name === name)?.manifest,
        loaded: () => undefined,
        matches: (version, range) => version === range,
        download: async dependency => {
            requested.push(dependency.modName);
            return new Uint8Array([mods.findIndex(mod => mod.name === dependency.modName || mod.alias?.includes(dependency.modName))]);
        },
        inspect: async bytes => mods[bytes[0]],
        save: async mod => { saved.push(mod.name); },
    };
    return {store, saved, requested};
}

describe('dependency installation', () => {
    test('installs transitive dependencies before parents and downloads shared aliases once', async () => {
        const shared = {...manifest('shared'), alias: ['shared-alias']};
        const {store, saved, requested} = fixture([manifest('B', ['shared']), manifest('C', ['shared-alias']), shared]);
        await new DependencyInstaller(store).install(manifest('A', ['B', 'C']), rootFile);
        expect(saved).toEqual(['shared', 'B', 'C', 'A']);
        expect(requested).toEqual(['B', 'shared', 'C']);
    });

    test('rejects circular dependencies without writing the cycle', async () => {
        const {store, saved} = fixture([manifest('B', ['A'])]);
        await expect(new DependencyInstaller(store).install(manifest('A', ['B']), rootFile)).rejects.toThrow('Circular dependency: A -> B -> A');
        expect(saved).toEqual([]);
    });

    test('a child reusing its parent URL with the wrong name fails without waiting on itself', async () => {
        const b = manifest('B', ['C']);
        b.dependenceInfo![0].downloadUrl = 'B';
        const {store, saved, requested} = fixture([b]);
        await expect(new DependencyInstaller(store).install(manifest('A', ['B']), rootFile)).rejects.toThrow('Dependency name mismatch');
        expect(saved).toEqual([]);
        expect(requested).toEqual(['B']);
    });

    test('validates persisted versions and respects disabled aliases without downloading', async () => {
        const old = fixture([], [{manifest: manifest('B', [], '0')}]);
        await expect(new DependencyInstaller(old.store).install(manifest('A', ['B']), rootFile)).rejects.toThrow('version mismatch');
        expect(old.requested).toEqual([]);
        const disabled = fixture([], [{manifest: {...manifest('B'), alias: ['alias']}, disabled: true}]);
        await expect(new DependencyInstaller(disabled.store).install(manifest('A', ['alias']), rootFile)).rejects.toThrow('is disabled');
        expect(disabled.requested).toEqual([]);
    });

    test('storage failure rejects instead of reporting success and records partial saves', async () => {
        const {store} = fixture([manifest('B')]);
        store.save = async mod => { if (mod.name === 'A') throw new Error('Quota exceeded'); };
        const installer = new DependencyInstaller(store);
        await expect(installer.install(manifest('A', ['B']), rootFile)).rejects.toThrow('Quota exceeded');
        expect(installer.added).toEqual(['B@1']);
    });

    test('cancelled downloads never install an archive even when transport returns late', async () => {
        const {store, saved} = fixture([manifest('B')]);
        const abort = new AbortController();
        store.download = async () => { abort.abort(); return new Uint8Array([0]); };
        await expect(new DependencyInstaller(store, {signal: abort.signal}).install(manifest('A', ['B']), rootFile)).rejects.toThrow('cancelled');
        expect(saved).toEqual([]);
    });

    test('checks requirements of already stored but not loaded dependencies', async () => {
        const {store, saved} = fixture([manifest('C')], [{manifest: manifest('B', ['C'])}]);
        await new DependencyInstaller(store).install(manifest('A', ['B']), rootFile);
        expect(saved).toEqual(['C', 'A']);
    });
});

describe('bounded browser downloads', () => {
    test('reports progress and returns binary bytes unchanged', async () => {
        const progress: number[] = [];
        const bytes = new Uint8Array([0, 255, 10]);
        const result = await readArchive(new Response(bytes, {headers: {'Content-Length': '3'}}), {onProgress: loaded => progress.push(loaded)});
        expect(result).toEqual(bytes);
        expect(progress).toEqual([3]);
    });

    test('rejects oversize Content-Length before consuming the response', async () => {
        await expect(readArchive(new Response(data, {headers: {'Content-Length': String(MAX_ARCHIVE_BYTES + 1)}}))).rejects.toThrow('128 MiB');
    });

    test('enforces the size cap without a Content-Length and closes the stream', async () => {
        const chunk = new Uint8Array(1024 * 1024);
        let cancelled = false;
        const response = new Response(new ReadableStream({
            pull(controller) { controller.enqueue(chunk); },
            cancel() { cancelled = true; },
        }));
        await expect(readArchive(response)).rejects.toThrow('128 MiB');
        expect(cancelled).toBe(true);
    });

    test('cancellation stops a pending body read', async () => {
        const abort = new AbortController();
        let cancelled = false;
        const response = new Response(new ReadableStream({cancel() { cancelled = true; }}));
        const pending = readArchive(response, {signal: abort.signal});
        abort.abort();
        await expect(pending).rejects.toThrow('cancelled');
        expect(cancelled).toBe(true);
    });
});
