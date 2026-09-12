import type {ModUtils} from "../../../dist-BeforeSC2/Utils";
import type {
    ModSubUiAngularJsModeExportInterface
} from '../../ModSubUiAngularJs/dist-ts/ModSubUiAngularJsModeExportInterface';
import {ModSubUiAngularJsServiceLifeTimeCallback} from "./ModSubUiAngularJsServiceInterface";

type AngularDirectiveFactory = ((...args: any[]) => any) | readonly unknown[];

interface AngularModuleLike {
    directive(name: string, factory: AngularDirectiveFactory): unknown;
}

interface AngularStaticLike {
    module(name: string, requires?: readonly string[], configFn?: unknown): AngularModuleLike;
}

type CompatibleModSubUi = ModSubUiAngularJsModeExportInterface & {
    getNg?: () => AngularStaticLike;
};


export class ModSubUiAngularJsService {

    protected lifeTimeCallbackTable: Map<string, ModSubUiAngularJsServiceLifeTimeCallback> = new Map<string, ModSubUiAngularJsServiceLifeTimeCallback>();

    protected get modSubUiAngularJs(): ModSubUiAngularJsModeExportInterface | undefined {
        // console.log('get modSubUiAngularJs', this.modUtils.getMod('ModSubUiAngularJs'));
        return this.modUtils.getMod('ModSubUiAngularJs')?.modRef as any
    }

    get Ref() {
        // return undefined;
        return this.modSubUiAngularJs;
    }

    constructor(
        public modUtils: ModUtils,
    ) {
    }

    addLifeTimeCallback(name: string, callback: ModSubUiAngularJsServiceLifeTimeCallback) {
        if (this.lifeTimeCallbackTable.has(name)) {
            console.error(`[ModSubUiAngularJsService] addLifeTimeCallback: name already exists:`, [name]);
            throw new Error(`[ModSubUiAngularJsService] addLifeTimeCallback: name already exists: [${name}]`);
        }
        this.lifeTimeCallbackTable.set(name, callback);
    }

    removeLifeTimeCallback(name: string) {
        this.lifeTimeCallbackTable.delete(name);
    }

    async bootstrap(el: HTMLElement) {
        const ref = this.Ref;
        if (!ref) {
            // ignore
            return;
        }
        ref.installBuildInComponent();
        for (const c of this.lifeTimeCallbackTable.values()) {
            c.whenCreate && await c.whenCreate(ref);
        }
        console.log('bootstrapModGuiConfig', [el, ref, ref.appContainerManager]);
        this.bootstrapModGuiConfig(ref, el);
    }

    /** Keeps the legacy renderer working when its directive factory is minified. */
    private bootstrapModGuiConfig(ref: ModSubUiAngularJsModeExportInterface, el: HTMLElement): void {
        const angular = (ref as CompatibleModSubUi).getNg?.();
        if (!angular) {
            ref.bootstrapModGuiConfig(el);
            return;
        }

        const originalModule = angular.module;
        const restoreDirectives: (() => void)[] = [];
        angular.module = function (name: string, requires?: readonly string[], configFn?: unknown) {
            const module = originalModule.call(this, name, requires, configFn);
            if (name !== 'ModGuiConfig' || !requires) return module;

            const originalDirective = module.directive;
            module.directive = function (directiveName: string, factory: AngularDirectiveFactory) {
                const compatibleFactory = directiveName === 'dynamicComponent' && typeof factory === 'function'
                    ? ['$compile', factory]
                    : factory;
                return originalDirective.call(this, directiveName, compatibleFactory);
            };
            restoreDirectives.push(() => { module.directive = originalDirective; });
            return module;
        };
        try {
            ref.bootstrapModGuiConfig(el);
        } finally {
            for (const restore of restoreDirectives) restore();
            angular.module = originalModule;
        }
    }

    async release() {
        if (!this.Ref) {
            // ignore
            return;
        }
        for (const c of this.lifeTimeCallbackTable.values()) {
            c.whenDestroy && await c.whenDestroy(this.Ref);
        }
        console.log('releaseModGuiConfig', [this.Ref, this.Ref.appContainerManager]);
        this.Ref.releaseModGuiConfig();
    }

}
