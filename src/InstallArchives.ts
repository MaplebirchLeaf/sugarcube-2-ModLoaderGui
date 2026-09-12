const DATABASE_PREFIX = 'thalia-mod-install-';

/** Each installation owns a temporary Blob store; recursive planning retains only record IDs. */
export class InstallArchives {
    private database?: IDBDatabase;
    private readonly name = `${DATABASE_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2)}`;
    private nextId = 0;

    constructor(private readonly factory: IDBFactory = indexedDB) {}

    async open(): Promise<void> {
        this.database = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = this.factory.open(this.name, 1);
            request.onupgradeneeded = () => request.result.createObjectStore('archives');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        // A cleanup in another tab may request deletion. Keep this connection alive until our
        // finally block: IndexedDB waits for live connections rather than deleting active data.
        this.database.onversionchange = () => {};
        if (typeof this.factory.databases === 'function') {
            void this.factory.databases().then(databases => {
                for (const database of databases) {
                    if (database.name?.startsWith(DATABASE_PREFIX) && database.name !== this.name) {
                        const request = this.factory.deleteDatabase(database.name);
                        request.onerror = () => {}; // Best effort; retry on a later installation.
                    }
                }
            }).catch(() => {});
        }
    }

    async put(blob: Blob): Promise<number> {
        const id = this.nextId++;
        await this.transaction('readwrite', store => store.put(blob, id));
        return id;
    }

    async get(id: number): Promise<Blob> {
        const value = await this.transaction<Blob>('readonly', store => store.get(id));
        if (!(value instanceof Blob)) throw new Error('Temporary mod archive is missing. Retry the installation.');
        return value;
    }

    async remove(id: number): Promise<void> {
        await this.transaction('readwrite', store => store.delete(id));
    }

    private transaction<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest): Promise<T> {
        if (!this.database) return Promise.reject(new Error('Temporary archive storage is closed.'));
        return new Promise<T>((resolve, reject) => {
            const transaction = this.database!.transaction('archives', mode);
            let request: IDBRequest;
            try {
                request = operation(transaction.objectStore('archives'));
            } catch (error) {
                transaction.abort();
                reject(error);
                return;
            }
            transaction.oncomplete = () => resolve(request.result as T);
            transaction.onabort = transaction.onerror = () => reject(transaction.error || new Error('Temporary archive storage failed.'));
        });
    }

    async close(): Promise<void> {
        this.database?.close();
        this.database = undefined;
        await new Promise<void>((resolve, reject) => {
            const request = this.factory.deleteDatabase(this.name);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }
}
