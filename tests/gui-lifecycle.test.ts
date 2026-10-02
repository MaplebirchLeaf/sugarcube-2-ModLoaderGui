import {afterEach, expect, mock, test} from 'bun:test';
import {resolve} from 'node:path';

mock.module(resolve(import.meta.dir, '../src/GM.css?inlineText'), () => ({default: ''}));
mock.module(resolve(import.meta.dir, '../node_modules/bootstrap/dist/css/bootstrap.css?inlineText'), () => ({default: ''}));
const {Gui} = await import('../src/Gui');
const {ModSubUiAngularJsService} = await import('../src/ModSubUiAngularJsService');
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
afterEach(() => {
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
});

test('concurrent install calls share one operation and cancellation signal', async () => {
    const gui = Object.create(Gui.prototype) as any;
    let calls = 0;
    let signal: AbortSignal | undefined;
    let complete!: (value: string) => void;
    gui.installFiles = (_: unknown, currentSignal: AbortSignal) => {
        ++calls;
        signal = currentSignal;
        return new Promise<string>(resolve => { complete = resolve; });
    };
    const first = gui.loadAndAddMod({});
    const second = gui.loadAndAddMod({});
    expect(first).toBe(second);
    expect(calls).toBe(1);
    gui.installationAbort.abort();
    expect(signal?.aborted).toBe(true);
    complete('done');
    await first;
    expect(gui.installation).toBeUndefined();
    expect(gui.installationAbort).toBeUndefined();
});

test('native download receives progress and abort without using browser fetch', async () => {
    Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {language: 'en-US'}});
    const gui = Object.create(Gui.prototype) as any;
    const abort = new AbortController();
    const progress: number[] = [];
    let forwardedSignal: AbortSignal | undefined;
    gui.thisWin = {
        navigator: {onLine: false},
        document: {querySelector: () => ({content: 'native'})},
        cordova: {require: (name: string) => {
            expect(name).toBe('thalia-native-download.NativeDownload');
            return {download: (_: string, options: {signal: AbortSignal; onProgress: (loaded: number, total: number) => void}) => {
                forwardedSignal = options.signal;
                options.onProgress(2, 10);
                return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {once: true}));
            }};
        }},
        fetch: () => { throw new Error('Native path must not use browser fetch.'); },
    };
    const pending = gui.fetchDependencyArchive({modName: 'B', version: '1', downloadUrl: 'https://github.com/o/r/releases/download/t/B.mod.zip'}, {
        signal: abort.signal, onProgress: (loaded: number) => progress.push(loaded),
    });
    abort.abort();
    await expect(pending).rejects.toThrow('Aborted');
    expect(forwardedSignal?.aborted).toBe(true);
    expect(progress).toEqual([2]);
});

test('repeated GUI opens share one construction task', async () => {
    const gui = Object.create(Gui.prototype) as any;
    let builds = 0;
    let complete!: () => void;
    gui.buildGui = () => { ++builds; return new Promise<void>(resolve => { complete = resolve; }); };
    const first = gui.createGui();
    expect(gui.createGui()).toBe(first);
    expect(builds).toBe(1);
    complete();
    await first;
    expect(gui.guiOpening).toBeUndefined();
});

test('legacy Mod Config renderer receives minification-safe AngularJS injection', () => {
    const service = Object.create(ModSubUiAngularJsService.prototype) as any;
    let registered: unknown;
    const originalDirective = function (_name: string, factory: unknown) {
        registered = factory;
    };
    const module = {directive: originalDirective};
    const originalModule = function () { return module; };
    const angular = {module: originalModule};
    const factory = function (minifiedCompileName: unknown) { return minifiedCompileName; };
    const ref = {
        getNg: () => angular,
        bootstrapModGuiConfig: () => angular.module('ModGuiConfig', []).directive('dynamicComponent', factory),
    };

    service.bootstrapModGuiConfig(ref, {});

    expect(registered).toEqual(['$compile', factory]);
    expect(angular.module).toBe(originalModule);
    expect(module.directive).toBe(originalDirective);
});

test('version decoration is idempotent and preserves existing children and listeners', () => {
    const gui = Object.create(Gui.prototype) as any;
    gui.patchedVersionNodes = new WeakMap();
    gui.gModUtils = {version: 'test'};
    let handlers = 1;
    const original = {textContent: 'original'};
    const children: any[] = [original];
    const node = {
        ownerDocument: {createElement: () => ({textContent: '', parentNode: undefined})},
        appendChild: (child: any) => { children.push(child); child.parentNode = node; },
        addEventListener: () => { ++handlers; },
    };
    gui.patchHtmlNodeVersionString(node);
    gui.patchHtmlNodeVersionString(node);
    expect(children).toHaveLength(2);
    expect(children[0]).toBe(original);
    expect(handlers).toBe(2);
    const marker = children.pop();
    marker.parentNode = undefined;
    gui.patchHtmlNodeVersionString(node);
    expect(children).toHaveLength(2);
    expect(children[1]).toBe(marker);
    expect(handlers).toBe(2);
});


test('multiple selected files install sequentially and retain partial success', async () => {
    const gui = Object.create(Gui.prototype) as any;
    const files = [{name: 'A.zip'}, {name: 'B.zip'}, {name: 'C.zip'}];
    const calls: string[] = [];
    let active = 0;
    gui.installFile = async (file: {name: string}) => {
        expect(active).toBe(0);
        active++;
        calls.push(file.name);
        await Promise.resolve();
        active--;
        if (file.name === 'B.zip') throw new Error('invalid archive');
        return `installed ${file.name}`;
    };
    const result = await gui.installFiles({files}, new AbortController().signal);
    expect(calls).toEqual(['A.zip', 'B.zip', 'C.zip']);
    expect(result).toContain('installed A.zip');
    expect(result).toContain('installed C.zip');
    expect(result).toContain('B.zip: invalid archive');
});

test('cancelling a multi-file import stops before subsequent files', async () => {
    const gui = Object.create(Gui.prototype) as any;
    const abort = new AbortController();
    const calls: string[] = [];
    gui.installFile = async (file: {name: string}) => {
        calls.push(file.name);
        abort.abort();
        throw new Error('cancelled');
    };
    await expect(gui.installFiles({files: [{name: 'A.zip'}, {name: 'B.zip'}]}, abort.signal)).rejects.toThrow('cancelled');
    expect(calls).toEqual(['A.zip']);
});
