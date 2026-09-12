type PassageCallback = (passageName: string) => void;

export class PassageTracer {
    private readonly callbacks = new Set<PassageCallback>();

    constructor(public thisW: Window) {
        this.thisW.jQuery(this.thisW.document).on(':passageend', (event: JQuery.TriggeredEvent) => {
            const passage = (event as JQuery.TriggeredEvent & {passage?: {title?: string}}).passage;
            this.newPassageCome(passage?.title);
        });
    }

    addCallback(callback: PassageCallback) { this.callbacks.add(callback); }
    removeCallback(callback: PassageCallback) { this.callbacks.delete(callback); }

    newPassageCome(passageName?: string) {
        const name = passageName || this.thisW.document.querySelector('.passage[data-passage]')?.getAttribute('data-passage');
        if (!name) return;
        for (const callback of this.callbacks) callback(name);
    }
}
