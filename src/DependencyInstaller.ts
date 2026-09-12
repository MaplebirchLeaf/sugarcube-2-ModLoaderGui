export interface Dependency {
    modName: string;
    version: string;
    downloadUrl?: string;
}

export interface DependencyManifest {
    name: string;
    version: string;
    alias?: string[];
    dependenceInfo?: Dependency[];
}

export interface DownloadOptions {
    signal?: AbortSignal;
    onProgress?: (loaded: number, total: number) => void;
}

export interface DependencyStore<T extends DependencyManifest> {
    list(): Promise<{name: string; disabled: boolean}[]>;
    metadata(name: string): Promise<T | undefined>;
    loaded(name: string): T | undefined;
    matches(version: string, range: string): boolean;
    download(dependency: Dependency, options: DownloadOptions): Promise<Uint8Array>;
    inspect(data: Uint8Array): Promise<T>;
    save(manifest: T, data: Uint8Array): Promise<void>;
}

export function checkAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw new DOMException('Installation cancelled.', 'AbortError');
}

/** One serial installation owns its dependency graph, downloads and cancellation. */
export class DependencyInstaller<T extends DependencyManifest> {
    readonly added: string[] = [];
    private readonly known = new Map<string, {manifest: T; disabled: boolean}>();
    private readonly visiting = new Set<string>();
    private readonly complete = new Set<string>();
    private readonly downloads = new Map<string, T>();

    constructor(private readonly store: DependencyStore<T>, private readonly options: DownloadOptions = {}) {}

    async install(manifest: T, data: Uint8Array): Promise<void> {
        for (const stored of await this.store.list()) {
            checkAborted(this.options.signal);
            const metadata = await this.store.metadata(stored.name);
            if (metadata) this.remember(metadata, stored.disabled);
        }
        await this.visit(manifest, data);
    }

    private remember(manifest: T, disabled = false): void {
        for (const name of [manifest.name, ...manifest.alias || []]) this.known.set(name, {manifest, disabled});
    }

    private validate(dependency: Dependency, manifest: T): void {
        if (manifest.name !== dependency.modName && !manifest.alias?.includes(dependency.modName)) {
            throw new Error(`Dependency name mismatch. Required [${dependency.modName}], got [${manifest.name}].`);
        }
        if (!this.store.matches(manifest.version, dependency.version)) {
            throw new Error(`Dependency [${dependency.modName}] version mismatch. Required [${dependency.version}], found [${manifest.version}].`);
        }
    }

    private async dependency(dependency: Dependency): Promise<void> {
        checkAborted(this.options.signal);
        if (dependency.modName === 'ModLoader' || dependency.modName === 'GameVersion') return;
        const existing = this.known.get(dependency.modName);
        if (existing?.disabled) throw new Error(`Dependency [${dependency.modName}] is disabled. Enable it before installing.`);
        const manifest = existing?.manifest || this.store.loaded(dependency.modName);
        if (manifest) {
            this.validate(dependency, manifest);
            await this.visit(manifest);
            return;
        }
        if (!dependency.downloadUrl) throw new Error(`Dependency [${dependency.modName}] is missing and downloadUrl is empty.`);
        const cached = this.downloads.get(dependency.downloadUrl);
        if (cached) {
            this.validate(dependency, cached);
            await this.visit(cached);
            return;
        }
        const data = await this.store.download(dependency, this.options);
        checkAborted(this.options.signal);
        const downloaded = await this.store.inspect(data);
        this.validate(dependency, downloaded);
        // Cache metadata before traversing children: a malformed shared URL must not await itself.
        this.downloads.set(dependency.downloadUrl, downloaded);
        await this.visit(downloaded, data);
    }

    private async visit(manifest: T, data?: Uint8Array): Promise<void> {
        checkAborted(this.options.signal);
        if (this.visiting.has(manifest.name)) throw new Error(`Circular dependency: ${[...this.visiting, manifest.name].join(' -> ')}`);
        if (this.complete.has(manifest.name) && !data) return;
        if (this.visiting.size >= 64) throw new Error('Dependency nesting exceeds 64 mods.');
        this.visiting.add(manifest.name);
        this.remember(manifest);
        try {
            for (const dependency of manifest.dependenceInfo || []) await this.dependency(dependency);
            checkAborted(this.options.signal);
            if (data) {
                await this.store.save(manifest, data);
                this.added.push(`${manifest.name}@${manifest.version}`);
            }
            this.complete.add(manifest.name);
        } finally {
            this.visiting.delete(manifest.name);
        }
    }
}
