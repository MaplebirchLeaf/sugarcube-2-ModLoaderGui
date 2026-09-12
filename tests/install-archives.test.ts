import {expect, test} from 'bun:test';
import {IDBFactory} from 'fake-indexeddb';
import {InstallArchives} from '../src/InstallArchives';
import {DependencyInstaller, DependencyManifest, DependencyStore} from '../src/DependencyInstaller';

test('temporary Blob storage preserves bytes and deletes its database on close', async () => {
    const factory = new IDBFactory();
    const archives = new InstallArchives(factory);
    await archives.open();
    const id = await archives.put(new Blob([new Uint8Array([0, 255, 4])]));
    expect(new Uint8Array(await (await archives.get(id)).arrayBuffer())).toEqual(new Uint8Array([0, 255, 4]));
    await archives.remove(id);
    await expect(archives.get(id)).rejects.toThrow('missing');
    await archives.close();
    expect(await factory.databases()).toEqual([]);
});

test('cleanup cannot delete another active installation and recovers abandoned databases', async () => {
    const factory = new IDBFactory();
    await new Promise<void>((resolve, reject) => {
        const request = factory.open('thalia-mod-install-abandoned');
        request.onsuccess = () => { request.result.close(); resolve(); };
        request.onerror = () => reject(request.error);
    });
    let firstName: string | undefined;
    let removed!: () => void;
    let blocked!: () => void;
    const abandonedRemoved = new Promise<void>(resolve => { removed = resolve; });
    const activeBlocked = new Promise<void>(resolve => { blocked = resolve; });
    const deleteDatabase = factory.deleteDatabase.bind(factory);
    factory.deleteDatabase = name => {
        const request = deleteDatabase(name);
        if (name === 'thalia-mod-install-abandoned') request.addEventListener('success', removed, {once: true});
        if (name === firstName) request.addEventListener('blocked', blocked, {once: true});
        return request;
    };
    const first = new InstallArchives(factory);
    const second = new InstallArchives(factory);
    await first.open();
    const firstId = await first.put(new Blob(['first']));
    firstName = (await factory.databases()).find(database => database.name !== 'thalia-mod-install-abandoned')?.name;
    await second.open();
    const secondId = await second.put(new Blob(['second']));
    // Wait for the actual deletion events rather than depending on timer/GC scheduling.
    await Promise.all([abandonedRemoved, activeBlocked]);
    expect(await (await first.get(firstId)).text()).toBe('first');
    expect(await (await second.get(secondId)).text()).toBe('second');
    expect((await factory.databases()).some(database => database.name === 'thalia-mod-install-abandoned')).toBe(false);
    await first.close();
    expect(await (await second.get(secondId)).text()).toBe('second');
    await second.close();
    expect(await factory.databases()).toEqual([]);
});

test('older WebViews without database enumeration still install and clean their own store', async () => {
    const factory = new IDBFactory();
    Object.defineProperty(factory, 'databases', {value: undefined});
    const archives = new InstallArchives(factory);
    await archives.open();
    const id = await archives.put(new Blob(['compatible']));
    expect(await (await archives.get(id)).text()).toBe('compatible');
    await archives.close();
});

function store(): DependencyStore<DependencyManifest> {
    return {
        list: async () => [], metadata: async () => undefined, loaded: () => undefined,
        matches: () => true,
        download: async () => new Uint8Array([1]),
        inspect: async () => ({name: 'dependency', version: '1'}),
        save: async () => {},
    };
}

test('staging failure removes temporary data before any mod becomes enabled', async () => {
    const factory = new IDBFactory();
    class FailingArchives extends InstallArchives {
        override async put(blob: Blob) {
            await super.put(blob);
            throw new Error('Temporary storage quota exceeded');
        }
    }
    const backend = store();
    let saves = 0;
    backend.save = async () => { ++saves; };
    await expect(new DependencyInstaller(backend, {}, new FailingArchives(factory)).install({name: 'root', version: '1'}, new Blob(['root']))).rejects.toThrow('quota exceeded');
    expect(saves).toBe(0);
    expect(await factory.databases()).toEqual([]);
});

test('a later graph error leaves every downloaded archive temporary', async () => {
    const factory = new IDBFactory();
    const backend = store();
    let saves = 0;
    backend.save = async () => { ++saves; };
    const root = {name: 'root', version: '1', dependenceInfo: [
        {modName: 'dependency', version: '1', downloadUrl: 'https://example.test/first'},
        {modName: 'missing', version: '1'},
    ]};
    await expect(new DependencyInstaller(backend, {}, new InstallArchives(factory)).install(root, new Blob(['root']))).rejects.toThrow('downloadUrl is empty');
    expect(saves).toBe(0);
    expect(await factory.databases()).toEqual([]);
});

test('recursive planning stages the whole graph before reading back one archive at a time', async () => {
    const factory = new IDBFactory();
    let staged = 0;
    let active = 0;
    class ObservedArchives extends InstallArchives {
        override async put(blob: Blob) { ++staged; return super.put(blob); }
        override async get(id: number) {
            expect(staged).toBe(6);
            expect(active).toBe(0);
            ++active;
            return super.get(id);
        }
        override async remove(id: number) {
            await super.remove(id);
            --active;
        }
    }
    const backend = store();
    const order: string[] = [];
    backend.download = async dependency => {
        expect(active).toBe(0);
        const data = new Uint8Array(2 * 1024 * 1024);
        data[0] = Number(dependency.modName);
        return data;
    };
    backend.inspect = async data => ({name: String(data[0]), version: '1', dependenceInfo: data[0] < 5
        ? [{modName: String(data[0] + 1), version: '1', downloadUrl: String(data[0] + 1)}] : []});
    backend.save = async manifest => {
        expect(active).toBe(1);
        order.push(manifest.name);
    };
    const root = {name: 'root', version: '1', dependenceInfo: [{modName: '1', version: '1', downloadUrl: '1'}]};
    await new DependencyInstaller(backend, {}, new ObservedArchives(factory)).install(root, new Blob(['root']));
    expect(order).toEqual(['5', '4', '3', '2', '1', 'root']);
    expect(active).toBe(0);
    expect(await factory.databases()).toEqual([]);
});
