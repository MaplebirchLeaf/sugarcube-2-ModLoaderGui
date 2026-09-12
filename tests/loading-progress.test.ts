import {afterEach, expect, mock, spyOn, test} from 'bun:test';
import {LoadingProgress} from '../src/LoadingProgress';

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
afterEach(() => {
    mock.restore();
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else Reflect.deleteProperty(globalThis, 'document');
});

test('hidden runtime logging retains bounded history without DOM or idle timers', () => {
    let created = 0;
    let scheduled = 0;
    Object.defineProperty(globalThis, 'document', {configurable: true, value: {
        createElement: () => { ++created; return {style: {}, replaceChildren() {}}; },
        body: {appendChild() {}},
    }});
    spyOn(globalThis, 'setTimeout').mockImplementation(() => { ++scheduled; return 1 as any; });
    spyOn(globalThis, 'clearTimeout').mockImplementation(() => {});
    const controller = {addLifeTimeCircleHook() {}, logRecordBeforeAnyLogHookRegister: []};
    const progress = new LoadingProgress({getModLoadController: () => controller} as any, {version: 'test'} as any);
    progress.logInfo('loading');
    expect(scheduled).toBe(1);
    progress.allStart();
    for (let index = 0; index < 10000; ++index) progress.logWarning(String(index));
    expect(progress.logList).toHaveLength(LoadingProgress.maxRecords);
    expect(progress.logList.at(-1)?.str).toContain('9999');
    expect(created).toBe(1);
    expect(scheduled).toBe(1);
    expect(progress.getLoadLog()[0]).toContain('8001 older records discarded');
    expect(progress.getLoadLogHtml()).toHaveLength(LoadingProgress.maxVisibleRecords + 1);
});

function loadingViewport(height: number, padding = 0) {
    const listeners = new Set<() => void>();
    const timers = new Map<number, () => void>();
    let nextTimer = 0;
    let viewportHeight = height;
    const nodes: any[] = [];
    Object.defineProperty(globalThis, 'document', {configurable: true, value: {
        createElement: () => {
            const node = {
                style: {cssText: ''}, innerText: '', children: [] as any[],
                get clientHeight() { return viewportHeight; },
                replaceChildren(...children: any[]) { this.children = children; },
            };
            nodes.push(node);
            return node;
        },
        body: {appendChild() {}},
        defaultView: {
            getComputedStyle: () => ({lineHeight: '15px', paddingTop: `${padding}px`, paddingBottom: `${padding}px`}),
            addEventListener: (_name: string, callback: () => void) => listeners.add(callback),
            removeEventListener: (_name: string, callback: () => void) => listeners.delete(callback),
        },
    }});
    spyOn(globalThis, 'setTimeout').mockImplementation(callback => {
        const id = ++nextTimer;
        timers.set(id, callback as () => void);
        return id as any;
    });
    spyOn(globalThis, 'clearTimeout').mockImplementation(id => { timers.delete(Number(id)); });
    const controller = {addLifeTimeCircleHook() {}, logRecordBeforeAnyLogHookRegister: []};
    const progress = new LoadingProgress({getModLoadController: () => controller} as any, {version: 'test'} as any);
    return {
        progress, nodes, listeners, timers,
        resize(value: number) { viewportHeight = value; for (const listener of listeners) listener(); },
        flush() {
            const pending = [...timers.values()];
            timers.clear();
            for (const callback of pending) callback();
        },
    };
}

test('loading logs fill a tall viewport instead of stopping after thirty records', () => {
    const fixture = loadingViewport(900);
    for (let i = 0; i < 1000; ++i) fixture.progress.logInfo(`record-${i}`);
    expect(fixture.timers.size).toBe(1);
    fixture.flush();
    const overlay = fixture.nodes[0];
    expect(overlay.children).toHaveLength(60);
    expect(overlay.children.at(-1).innerText).toContain('record-999');
    expect(fixture.nodes).toHaveLength(61);
    fixture.progress.allStart();
});

test('orientation changes resize the bounded log view and startup removes resize work', () => {
    const fixture = loadingViewport(900);
    for (let i = 0; i < 1000; ++i) fixture.progress.logInfo(`record-${i}`);
    fixture.flush();
    fixture.resize(150);
    fixture.flush();
    expect(fixture.nodes[0].children).toHaveLength(10);
    expect(fixture.nodes[0].children.at(-1).innerText).toContain('record-999');
    fixture.resize(15000);
    fixture.flush();
    expect(fixture.nodes[0].children).toHaveLength(LoadingProgress.maxVisibleRecords);
    fixture.resize(300);
    expect(fixture.timers.size).toBe(1);
    fixture.progress.allStart();
    expect(fixture.timers.size).toBe(0);
    expect(fixture.listeners.size).toBe(0);
    const created = fixture.nodes.length;
    fixture.resize(900);
    fixture.progress.logInfo('after startup');
    fixture.flush();
    expect(fixture.nodes).toHaveLength(created);
    expect(fixture.nodes[0].children).toHaveLength(0);
});

test('loading rows fit completely inside a viewport with padding and a partial final line', () => {
    const fixture = loadingViewport(903, 3);
    for (let i = 0; i < 1000; ++i) fixture.progress.logInfo(`record-${i}`);
    fixture.flush();
    expect(fixture.nodes[0].children).toHaveLength(59);
    expect(fixture.nodes[0].children.at(-1).innerText).toContain('record-999');
    fixture.progress.allStart();
});
