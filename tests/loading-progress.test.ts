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
