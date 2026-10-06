import {BootstrapBtnType, Field, GM_config, GM_configStruct} from './GM_config_TS/gm_config';
import inlineGMCss from './GM.css?inlineText';
import inlineBootstrap from 'bootstrap/dist/css/bootstrap.css?inlineText';

import type {SC2DataManager} from "../../../dist-BeforeSC2/SC2DataManager";
import type {ModUtils} from "../../../dist-BeforeSC2/Utils";
import type {ModBootJson, ModInfo} from "../../../dist-BeforeSC2/ModLoader";
import type {LogWrapper} from '../../../dist-BeforeSC2/ModLoadController';
import type {ModLoadFromSourceType} from '../../../dist-BeforeSC2/ModOrderContainer';
import {isArray, isNil, isString} from "lodash";
import {LoadingProgress} from "./LoadingProgress";
import {PassageTracer} from "./PassageTracer";
import {DebugExport} from "./DebugExport";
import {getStringTable, StringTableType} from './GUI_StringTable/StringTable';
import {ModLoadSwitch} from "./ModLoadSwitch";
import {KeyFilter} from "./KeyFilter";
import {ModSubUiAngularJsService} from "./ModSubUiAngularJsService";
import {ModManagerSubUi} from "./ModManagerSubUi";
import {checkAborted, Dependency, DependencyInstaller, DownloadOptions} from './DependencyInstaller';
import {MAX_ARCHIVE_BYTES, readArchive} from './Download';

const btnType: BootstrapBtnType = 'secondary';

// const StringTable = getStringTable();
const StringTable: StringTableType = new Proxy({}, {
    get: function (obj, prop: keyof StringTableType) {
        const s = getStringTable();
        return s[prop];
    },
}) as StringTableType;

const divModCss = `
#MyConfig_wrapper {
    padding: 1em;
}
`;

const nickName = (mi: ModInfo | undefined) => {
    if (!mi || !mi.nickName) {
        return '';
    }
    const s = StringTable.calcModNickName(mi.nickName);
    if (!s) {
        return '';
    }
    return mi.nickName ? `<${s}> ` : '';
};

type NativeDownload = {
    download(url: string, options?: DownloadOptions): Promise<ArrayBuffer>;
};

type CordovaRuntime = {
    require(moduleId: string): unknown;
};

function dependencyDownloadUrl(downloadUrl: string, proxyBaseUrl?: string): string {
    if (!proxyBaseUrl?.trim()) return downloadUrl;

    let url: URL;
    try {
        url = new URL(downloadUrl);
    } catch {
        return downloadUrl;
    }

    if (url.protocol !== 'https:' || url.hostname !== 'github.com') return downloadUrl;
    let parts: string[];
    try {
        parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    } catch {
        return downloadUrl;
    }
    if (parts.length !== 6 || parts[2] !== 'releases' || parts[3] !== 'download') return downloadUrl;
    if (!parts[5].toLowerCase().endsWith('.mod.zip')) return downloadUrl;

    const proxyPath = [parts[0], parts[1], parts[4], parts[5]].map(encodeURIComponent).join('/');
    return new URL(proxyPath, proxyBaseUrl).toString();
}

export class Gui {
    // avoid same Math.random
    static rIdP = 0;

    // get a unique string as id
    rId() {
        return '' + (++Gui.rIdP) + Math.random();
    }

    protected debugExport: DebugExport;

    protected modLoadSwitch: ModLoadSwitch;

    protected logger: LogWrapper;

    constructor(
        public gSC2DataManager: SC2DataManager,
        public gModUtils: ModUtils,
        public gLoadingProgress: LoadingProgress,
        public gPassageTracer: PassageTracer,
        public thisWin: Window,
    ) {
        this.logger = gModUtils.getLogger();
        this.init();
        this.gPassageTracer.addCallback((passageName) => {
            if (this.startBanner) {
                switch (passageName) {
                    case 'Start':
                        this.startBanner.style.display = 'block';
                        break;
                    default:
                        this.startBanner.style.display = 'none';
                        break;
                }
            }
            this.patchVersionString();
        });
        this.isHttpMode = location.protocol.startsWith('http');
        this.debugExport = new DebugExport(gSC2DataManager, gModUtils, gLoadingProgress);
        this.modLoadSwitch = new ModLoadSwitch(gSC2DataManager, gModUtils);
        this.modSubUiAngularJsService = new ModSubUiAngularJsService(gModUtils);
        this.modManagerSubUi = new ModManagerSubUi(this.modSubUiAngularJsService, this);
        const nn = this.gModUtils.getNowRunningModName();
        if (nn) {
            this.nowModName = nn;
            this.gModUtils.getMod(nn)!.modRef = this;
        } else {
            this.logger.error('[ModLoaderGui]: nowModName is undefined. error.');
        }
    }

    protected nowModName?: string;

    protected isHttpMode = true;

    protected rootNode?: HTMLDivElement;

    protected gui?: GM_configStruct;

    // public getStringTable() {
    //     return cloneDeep(StringTable);
    // }
    //
    // public setStringTable(stringTable: typeof StringTable) {
    //     StringTable = stringTable;
    // }

    protected logShowConfig = {
        noInfo: false, noWarning: false, noError: false,
    };

    private guiOpening?: Promise<void>;

    createGui(): Promise<void> {
        if (!this.guiOpening) {
            this.guiOpening = this.buildGui().finally(() => { this.guiOpening = undefined; });
        }
        return this.guiOpening;
    }

    private async buildGui() {
        if (!this.rootNode) {
            this.rootNode = document.createElement('div');
            // this.rootNode.id = 'rootNodeModLoaderGui';
            this.rootNode.style.cssText = 'z-index: 1002;';
            document.body.appendChild(this.rootNode);
        }
        const NowLoadedModeList = `ModLoader ${`{v:${this.gModUtils.version}}` || ''}\n`
            + this.getModListString().join('\n');
        const l = await this.listSideLoadMod2();
        const NowSideLoadModeList: string = l.join('\n');
        // const removeAbleModList = (await this.listSideLoadModInfo()).map(T => T.name);
        const removeAbleModList = await this.listSideLoadModNameCanUnload();
        console.log('NowLoadedModeList this.getModListString()', this.getModListString());
        console.log('NowLoadedModeList', NowLoadedModeList);
        console.log('NowSideLoadModeList', NowSideLoadModeList);
        if (this.gui && this.gui.isOpen) {
            console.log('createGui() (this.gui && this.gui.isOpen)');
            this.gui.close()
            this.modSubUiAngularJsService.release();
        }
        console.log('title', StringTable.title + (this.gModUtils.version || ''));
        this.gui = new GM_config({
            xgmExtendInfo: {
                xgmExtendMode: 'bootstrap',
                bootstrap: {
                    smallBtn: true,
                },
                buttonConfig: {
                    noSave: true,
                    noCancel: true,
                    noReset: true,
                },
            },
            'id': 'MyConfig',
            'title': StringTable.title + ((' v' + this.gModUtils.version) || ''),
            css: inlineGMCss + '\n' + (this.isHttpMode ? inlineBootstrap : divModCss),
            'frame': (this.isHttpMode ? undefined : this.rootNode),
            'fields': {
                'Close_b': {
                    label: StringTable.close,
                    type: 'button',
                    click: () => {
                        if (this.gui && this.gui.isOpen) {
                            this.gui.close();
                            this.modSubUiAngularJsService.release();
                        }
                    },
                    // cssStyleText: 'display: inline-block;',
                    cssClassName: 'd-inline',
                    xgmExtendField: {bootstrap: {btnType: btnType}},
                },
                'Reload_b': {
                    label: StringTable.reload,
                    type: 'button',
                    click: () => {
                        location.reload();
                    },
                    // cssStyleText: 'display: inline-block;',
                    cssClassName: 'd-inline',
                    xgmExtendField: {bootstrap: {btnType: btnType}},
                },
                [this.rId()]: {
                    section: GM_config.create(StringTable.SectionSafeMode),
                    type: 'br',
                },
                'EnableSafeMode_b': {
                    label: StringTable.EnableSafeMode,
                    type: 'button',
                    click: async () => {
                        console.log('EnableSafeMode_b');
                        // await 2 next tick
                        this.modLoadSwitch.enableSafeMode();
                        if (this.modLoadSwitch.isSafeModeOn()) {
                            this.gui!.fields['SafeModeState_R'].value = StringTable.SafeModeEnabled;
                        } else {
                            this.gui!.fields['SafeModeState_R'].value = StringTable.SafeModeDisabled;
                        }
                        this.gui!.fields['SafeModeState_R'].reload();
                    },
                    cssClassName: 'd-inline',
                    xgmExtendField: {bootstrap: {btnType: 'outline-danger'}},
                },
                'DisableSafeMode_b': {
                    label: StringTable.DisableSafeMode,
                    type: 'button',
                    click: async () => {
                        console.log('DisableSafeMode_b');
                        // await 2 next tick
                        this.modLoadSwitch.disableSafeMode();
                        if (this.modLoadSwitch.isSafeModeOn()) {
                            this.gui!.fields['SafeModeState_R'].value = StringTable.SafeModeEnabled;
                        } else {
                            this.gui!.fields['SafeModeState_R'].value = StringTable.SafeModeDisabled;
                        }
                        this.gui!.fields['SafeModeState_R'].reload();
                    },
                    cssClassName: 'd-inline',
                    xgmExtendField: {bootstrap: {btnType: 'outline-success'}},
                },
                'SafeModeState_R': {
                    label: StringTable.SafeModeState,
                    type: 'text',
                    value: '',
                    readonly: true,
                },
                // TODO language select section
                // [this.rId()]: {
                //     section: GM_config.create(StringTable.SectionLanguageSelect),
                //     type: 'br',
                // },
                [this.rId()]: {
                    section: GM_config.create(StringTable.SectionMod),
                    type: 'br',
                },
                'NowLoadedModeList_r': {
                    label: StringTable.NowLoadedModeList,
                    type: 'textarea',
                    default: NowLoadedModeList,
                    readonly: "readonly",
                },
                'NowSideLoadModeList_r': {
                    label: StringTable.NowSideLoadModeList,
                    type: 'textarea',
                    default: NowSideLoadModeList,
                    readonly: "readonly",
                },
                // TODO side load mod disable section
                // [this.rId()]: {
                //     section: GM_config.create(StringTable.SectionModDisable),
                //     type: 'br',
                // },
                // 'NowReadModeList_r': {
                //     label: StringTable.NowLoadedModeList,
                //     type: 'textarea',
                //     default: NowLoadedModeList,
                //     readonly: "readonly",
                // },
                [this.rId()]: {
                    section: GM_config.create(StringTable.SectionAddRemove),
                    type: 'br',
                },
                'AddMod_I': {
                    label: StringTable.SelectModZipFile,
                    type: 'file',
                    cssClassName: 'd-inline',
                    afterToNode: (node) => {
                        const input = node as HTMLInputElement;
                        input.multiple = true;
                        input.accept = '.zip,.modpack,.modpack.crypt';
                    },
                },
                'AddMod_b': {
                    label: StringTable.AddMod,
                    type: 'button',
                    click: async () => {
                        if (this.installation) return;
                        this.gui!.fields['AddMod_R'].value = StringTable.Installing;
                        this.gui!.fields['AddMod_R'].reload();
                        const vv = this.gui!.fields['AddMod_I'].toValue();
                        if (isNil(vv)) {
                            console.error('AddMod_b (!vv) : ');
                            return;
                        }
                        console.log(vv);
                        console.log((vv as any).files);
                        // @ts-ignore
                        const doc = this.gui!.frame?.contentDocument || this.gui!.frame;
                        if (!doc) {
                            console.error('AddMod_b (!doc) : ', this.gui!.frame);
                            return;
                        }
                        try {
                            const R = await this.loadAndAddMod((vv as any));
                            this.gui!.fields['AddMod_R'].value = R;
                            this.gui!.fields['AddMod_R'].reload();
                            // console.log('this.gModUtils.getModLoadController().listModLocalStorage()', this.gModUtils.getModLoadController().listModLocalStorage());
                            // const MyConfig_field_NowSideLoadModeList_r = doc.querySelector('#MyConfig_field_NowSideLoadModeList_r');
                            // if (MyConfig_field_NowSideLoadModeList_r) {
                            //     (MyConfig_field_NowSideLoadModeList_r as HTMLTextAreaElement).value =
                            //         this.gModUtils.getModLoadController().listModLocalStorage().join('\n');
                            // }
                        } catch (E: any) {
                            const m = E?.message || E?.toString() || E;
                            console.error('AddMod_b', E);
                            console.log(`Error: ${m}`);
                            this.gui!.fields['AddMod_R'].value = `Error: ${StringTable.errorMessage2I18N(m)}`;
                            this.gui!.fields['AddMod_R'].reload();
                        }
                        const l = await this.listSideLoadModNameCanUnload();
                        const MyConfig_field_RemoveMod_s = doc.querySelector('#MyConfig_field_RemoveMod_s');
                        if (MyConfig_field_RemoveMod_s) {
                            const select = (MyConfig_field_RemoveMod_s as HTMLSelectElement);
                            for (let a in select.options) {
                                select.options.remove(0);
                            }
                            for (const T of l) {
                                // select.options.add(new Option(`${T.name}${nickName(T.mod)}`, T.name));
                                // select.options.add(new Option(T.name, T.name));
                                select.options.add(new Option(T, T));
                            }
                        }
                        const MyConfig_field_NowSideLoadModeList_r = doc.querySelector('#MyConfig_field_NowSideLoadModeList_r');
                        if (MyConfig_field_NowSideLoadModeList_r) {
                            (MyConfig_field_NowSideLoadModeList_r as HTMLTextAreaElement).value = (await this.listSideLoadMod2()).join('\n');
                        }
                    },
                    // cssStyleText: 'display: inline-block;',
                    cssClassName: 'd-inline',
                    xgmExtendField: {bootstrap: {btnType: btnType}},
                },
                'CancelInstall_b': {
                    label: StringTable.CancelInstall,
                    type: 'button',
                    click: () => this.installationAbort?.abort(),
                    cssClassName: 'd-inline',
                    xgmExtendField: {bootstrap: {btnType: btnType}},
                },
                'AddMod_R': {
                    label: StringTable.AddModResult,
                    type: 'text',
                    value: '',
                    readonly: true,
                },
                [this.rId()]: {
                    type: 'br',
                },
                ['RemoveMod' + '_s']: {
                    label: StringTable.CanRemoveModList,
                    type: 'select',
                    labelPos: 'left',
                    options: removeAbleModList,
                    default: undefined,
                    cssClassName: 'd-inline',
                    afterToNode: async (node: HTMLElement, wrapper: HTMLElement | null, settings: Field, id: string, configId: string) => {
                        // const l = await this.listSideLoadModInfo();
                        // // @ts-ignore
                        // const doc = this.gui!.frame?.contentDocument || this.gui!.frame;
                        // if (!doc) {
                        //     console.error('RemoveMod_s (!doc) : ', this.gui!.frame);
                        //     return;
                        // }
                        // const RemoveMod_s_node = this.gui!.fields['RemoveMod_s'];
                        // RemoveMod_s_node.settings.options = (await this.listSideLoadModInfo()).map(T => T.name);
                        // console.log('RemoveMod afterToNode RemoveMod_s_node', RemoveMod_s_node);
                        // RemoveMod_s_node.reload();

                        // const MyConfig_field_RemoveMod_s = doc.querySelector('#MyConfig_field_RemoveMod_s');
                        // // console.log('RemoveMod afterToNode MyConfig_field_RemoveMod_s', MyConfig_field_RemoveMod_s);
                        // if (MyConfig_field_RemoveMod_s) {
                        //     const select = (MyConfig_field_RemoveMod_s as HTMLSelectElement);
                        //     // clean options
                        //     select.options.length = 0;
                        //     for (const T of l) {
                        //         console.log('RemoveMod afterToNode T', T);
                        //         select.options.add(new Option(`${T.name}${nickName(T.mod)}`, T.name));
                        //     }
                        // }
                    }
                },
                ['RemoveMod' + '_b']: {
                    label: StringTable.RemoveMod,
                    type: 'button',
                    click: async () => {
                        // @ts-ignore
                        const doc = this.gui!.frame?.contentDocument || this.gui!.frame;
                        if (!doc) {
                            console.error('RemoveMod_b (!doc) : ', this.gui!.frame);
                            return;
                        }
                        const vv = this.gui!.fields['RemoveMod_s'].toValue();
                        console.log('vv', vv);
                        if (isNil(vv) || !vv || !isString(vv)) {
                            console.error('RemoveMod_b (!vv) : ', [
                                isNil(vv), !vv, !isString(vv)
                            ]);
                            return;
                        }
                        await this.gModUtils.getModLoadController().removeModIndexDB(vv);
                        const MyConfig_field_RemoveMod_s = doc.querySelector('#MyConfig_field_RemoveMod_s');

                        const l = await this.listSideLoadModNameCanUnload();
                        if (MyConfig_field_RemoveMod_s) {
                            const select = (MyConfig_field_RemoveMod_s as HTMLSelectElement);
                            for (let a in select.options) {
                                select.options.remove(0);
                            }
                            for (const T of l) {
                                console.log('T', T);
                                // select.options.add(new Option(`${T.name}${nickName(T.mod)}`, T.name));
                                // select.options.add(new Option(T.name, T.name));
                                select.options.add(new Option(T, T));
                            }
                        }
                        const MyConfig_field_NowSideLoadModeList_r = doc.querySelector('#MyConfig_field_NowSideLoadModeList_r');
                        if (MyConfig_field_NowSideLoadModeList_r) {
                            (MyConfig_field_NowSideLoadModeList_r as HTMLTextAreaElement).value = (await this.listSideLoadMod2()).join('\n');
                        }
                    },
                    // cssStyleText: 'display: inline-block;',
                    cssClassName: 'd-inline',
                    xgmExtendField: {bootstrap: {btnType: btnType}},
                },
                [this.rId()]: {
                    section: GM_config.create(StringTable.SectionReadMe),
                    type: 'br',
                },
                ['ReadMe' + '_s']: {
                    label: StringTable.ReadMeSelect,
                    type: 'select',
                    labelPos: 'left',
                    options: this.gModUtils.getModListName(),
                    default: undefined,
                    cssClassName: 'd-inline',
                },
                ['ReadMe' + '_b']: {
                    label: StringTable.ReadMeButton,
                    type: 'button',
                    click: async () => {
                        // @ts-ignore
                        const doc = this.gui!.frame?.contentDocument || this.gui!.frame;
                        if (!doc) {
                            console.error('ReadMe_b (!doc) : ', this.gui!.frame);
                            return;
                        }
                        const vv = this.gui!.fields['ReadMe_s'].toValue();
                        console.log('vv', vv);
                        if (isNil(vv) || !vv || !isString(vv)) {
                            console.error('ReadMe_b (!vv) : ', [
                                isNil(vv), !vv, !isString(vv)
                            ]);
                            return;
                        }
                        const readMe = await this.getModTReadMe(vv).catch(E => {
                            console.error('getModTReadMe', E);
                            return '<Cannot Load>'
                        });
                        const bootJson = await this.getModTJson(vv);
                        // console.log('readMe', readMe);

                        (this.gui!.fields['ReadMe_r'].node as HTMLTextAreaElement).value = readMe;
                        (this.gui!.fields['BootJson_r'].node as HTMLTextAreaElement).value = bootJson;
                        // const MyConfig_field_ReadMe_r = doc.querySelector('#MyConfig_field_ReadMe_r');
                        // if (MyConfig_field_ReadMe_r) {
                        //     (MyConfig_field_ReadMe_r as HTMLTextAreaElement).value = readMe;
                        // }
                        // const MyConfig_field_BootJson_r = doc.querySelector('#MyConfig_field_BootJson_r');
                        // if (MyConfig_field_BootJson_r) {
                        //     (MyConfig_field_BootJson_r as HTMLTextAreaElement).value = bootJson;
                        // }
                    },
                    // cssStyleText: 'display: inline-block;',
                    cssClassName: 'd-inline',
                    xgmExtendField: {bootstrap: {btnType: btnType}},
                },
                'ReadMe_r': {
                    label: StringTable.ReadMeContent,
                    type: 'textarea',
                    default: '',
                    readonly: "readonly",
                },
                'BootJson_r': {
                    label: StringTable.ReadMeBootJsonContent,
                    type: 'textarea',
                    default: '',
                    readonly: "readonly",
                },
                [this.rId()]: {
                    section: GM_config.create(StringTable.ModConfig),
                    type: 'br',
                },
                [this.rId()]: {
                    type: 'div',
                    afterToNode: (node: HTMLElement, wrapper: HTMLElement | null, settings: Field, id: string, configId: string) => {
                        console.log('modSubUiAngularJsService', this.modSubUiAngularJsService.Ref);
                        this.modSubUiAngularJsService.bootstrap(node);
                    },
                },
                [this.rId()]: {
                    section: GM_config.create(StringTable.SectionLoadLog),
                    type: 'br',
                },
                'LoadLog_error_c': {
                    label: StringTable.LoadLogRadioNoError,
                    type: 'checkbox',
                    default: this.logShowConfig.noError,
                    cssClassName: 'd-inline',
                    cssStyleText: 'margin-right: 0.5em;',
                },
                'LoadLog_warning_c': {
                    label: StringTable.LoadLogRadioNoWarning,
                    type: 'checkbox',
                    default: this.logShowConfig.noWarning,
                    cssClassName: 'd-inline',
                    cssStyleText: 'margin-right: 0.5em;',
                },
                'LoadLog_info_c': {
                    label: StringTable.LoadLogRadioNoInfo,
                    type: 'checkbox',
                    default: this.logShowConfig.noInfo,
                    cssClassName: 'd-inline',
                    cssStyleText: 'margin-right: 0.5em;',
                },
                ['LoadLog_reload_b']: {
                    label: StringTable.LoadLogReloadButton,
                    type: 'button',
                    cssClassName: 'd-inline',
                    xgmExtendField: {bootstrap: {btnType: 'secondary'}},
                    click: async () => {
                        console.warn('LoadLog_error_c', [
                            this.gui!.fields['LoadLog_error_c'].value,
                            this.gui!.fields['LoadLog_error_c'].node,
                            (this.gui!.fields['LoadLog_error_c'].node as HTMLInputElement)!.checked,
                        ]);
                        this.logShowConfig.noError = !!(this.gui!.fields['LoadLog_error_c'].node as HTMLInputElement)!.checked;
                        this.logShowConfig.noWarning = !!(this.gui!.fields['LoadLog_warning_c'].node as HTMLInputElement)!.checked;
                        this.logShowConfig.noInfo = !!(this.gui!.fields['LoadLog_info_c'].node as HTMLInputElement)!.checked;

                        // @ts-ignore
                        const doc: Document = this.gui!.frame?.contentDocument || this.gui!.frame;
                        if (!doc) {
                            console.error('LoadLog_reload_b (!doc) : ', this.gui!.frame);
                            return;
                        }
                        const nId = doc.querySelector('#idLoadLogHtml');
                        console.log('loadLogNode', nId);
                        console.log('loadLogNode', nId?.parentNode);
                        if (nId && nId.parentNode) {
                            const pn = nId?.parentNode;
                            pn.removeChild(nId);
                            pn.appendChild(this.getLoadLogHtml());
                        }
                    },
                },
                'LoadLog_r': {
                    label: StringTable.LoadLog,
                    type: 'textarea',
                    // default: this.gLoadingProgress.getLoadLog().join('\n'),
                    readonly: "readonly",
                },
                [this.rId()]: {
                    section: GM_config.create(StringTable.SectionDebug),
                    type: 'br',
                },
                'DownloadExportData_b': {
                    label: StringTable.DownloadExportData,
                    type: 'button',
                    click: async () => {
                        this.debugExport.createDownload(
                            await this.debugExport.exportData(),
                            this.debugExport.calcExportName(),
                        )
                    },
                    // cssStyleText: 'display: inline-block;',
                    cssClassName: 'd-inline',
                    xgmExtendField: {bootstrap: {btnType: btnType}},
                },
                'DownloadExportData2_b': {
                    label: StringTable.DownloadExportData2,
                    type: 'button',
                    click: async () => {
                        this.debugExport.createDownload(
                            await this.debugExport.exportData(true),
                            this.debugExport.calcExportName(),
                        )
                    },
                    // cssStyleText: 'display: inline-block;',
                    cssClassName: 'd-inline',
                    xgmExtendField: {bootstrap: {btnType: btnType}},
                },
            },
            events: {
                save: (values) => {
                    // All the values that aren't saved are passed to this function
                    // for (i in values) alert(values[i]);
                },
                open: (doc) => {
                    console.log('this.modLoadSwitch.isSafeModeOn()', this.modLoadSwitch.isSafeModeOn());
                    console.log('this.modLoadSwitch.isSafeModeAutoOn()', this.modLoadSwitch.isSafeModeAutoOn());
                    this.gui!.fields['SafeModeState_R'].value = (
                        this.modLoadSwitch.isSafeModeOn() ?
                            (this.modLoadSwitch.isSafeModeAutoOn() ? StringTable.SafeModeAutoEnabled : StringTable.SafeModeEnabled) :
                            StringTable.SafeModeDisabled
                    );
                    this.gui!.fields['SafeModeState_R'].reload();

                    const loadLogNode = this.gui!.fields['LoadLog_r'].node;
                    console.log('loadLogNode', loadLogNode);
                    console.log('loadLogNode', loadLogNode?.parentNode);
                    if (loadLogNode && loadLogNode.parentNode) {
                        const pn = loadLogNode?.parentNode;
                        pn.removeChild(loadLogNode);
                        pn.appendChild(this.getLoadLogHtml());
                    }
                    if (this.isHttpMode) {
                        doc.addEventListener('keydown', async (event) => {
                            // console.log('keydown', event);
                            if (KeyFilter.open(event)) {
                                if (event.shiftKey) {
                                    if (this.gui && this.gui.isOpen) {
                                        this.gui.close();
                                        await this.modSubUiAngularJsService.release();
                                    }
                                    return;
                                }
                                if (this.gui && this.gui.isOpen) {
                                    this.gui.close();
                                    await this.modSubUiAngularJsService.release();
                                } else {
                                    await this.createGui();
                                    this.gui && this.gui.open();
                                }
                            }
                        });
                    }
                },
            },
        });
    }

    private getLoadLogHtml() {
        const n = document.createElement('div');
        n.style.cssText = 'font-family: "Consolas", monospace;';
        n.id = 'idLoadLogHtml';
        const ll = this.gLoadingProgress.getLoadLogHtml(this.logShowConfig);
        ll.filter(T => {
            switch (T.style.color) {
                case 'orange':
                    T.style.color = 'whitesmoke';
                    T.style.backgroundColor = 'chocolate';
                    break;
                case 'red':
                    T.style.color = 'whitesmoke';
                    T.style.backgroundColor = 'firebrick';
                    break;
                case 'gray':
                    T.style.color = 'mistyrose';
                    break;
                default:
                    break;
            }
        });
        n.append(...ll);
        return n;
    }

    public getModSubUiAngularJsService() {
        return this.modSubUiAngularJsService;
    }

    protected modSubUiAngularJsService: ModSubUiAngularJsService;
    protected modManagerSubUi: ModManagerSubUi;

    protected initOk = false;

    protected init() {
        if (this.initOk) {
            console.error('init() (this.initOk)');
            return;
        }
        this.initOk = true;

        this.thisWin.addEventListener('keydown', async (event) => {
            // console.log('keydown', event);
            if (KeyFilter.open(event)) {
                if (event.shiftKey) {
                    if (this.gui && this.gui.isOpen) {
                        this.gui.close();
                        this.modSubUiAngularJsService.release();
                    }
                    return;
                }
                if (this.gui && this.gui.isOpen) {
                    this.gui.close();
                    this.modSubUiAngularJsService.release();
                } else {
                    this.gui && this.gui.close();
                    await this.createGui();
                    this.gui && this.gui.open();
                }
            }
        });

        this.thisWin.addEventListener('keydown', async (event) => {
            if (KeyFilter.exportData(event)) {
                this.debugExport.createDownload(
                    await this.debugExport.exportData(),
                    this.debugExport.calcExportName(),
                )
            }
        });

        if (true) {
            this.startBanner = document.createElement('div');
            this.startBanner.id = 'startBannerModLoaderGui';
            this.startBanner.innerText = StringTable.title + (this.gModUtils.version || '');
            this.startBanner.style.cssText = 'position: fixed;left: 1px;bottom: calc(1px + 1em);max-width: 10em;' +
                'font-size: .75em;z-index: 1001;user-select: none;' +
                'border: gray dashed 2px;color: gray;padding: .25em;';
            this.startBanner.addEventListener('click', async () => {
                if (this.gui && this.gui.isOpen) {
                    this.gui.close();
                    this.modSubUiAngularJsService.release();
                } else {
                    this.gui && this.gui.close();
                    await this.createGui();
                    this.gui && this.gui.open();
                }
            });
            document.body.appendChild(this.startBanner);
        }
    }

    protected startBanner?: HTMLDivElement;

    protected matchVersion(version: string, range: string) {
        const semVerTools = this.gModUtils.getSemVerTools();
        return semVerTools.satisfies(
            semVerTools.parseVersion(version).version,
            semVerTools.parseRange(range),
        );
    }

    private installation?: Promise<string>;
    private installationAbort?: AbortController;

    private showInstallProgress(message: string) {
        const field = this.gui?.fields['AddMod_R'];
        if (!field) return;
        field.value = message;
        if (this.gui?.isOpen) field.reload();
    }

    protected async fetchDependencyArchive(dependency: Dependency, options: DownloadOptions) {
        if (!dependency.downloadUrl) throw new Error(`Dependency [${dependency.modName}] is missing and downloadUrl is empty.`);
        checkAborted(options.signal);
        const controller = new AbortController();
        const abort = () => controller.abort();
        options.signal?.addEventListener('abort', abort, {once: true});
        const timeout = setTimeout(abort, 120000);
        let lastProgress = 0;
        const downloadOptions: DownloadOptions = {
            signal: controller.signal,
            onProgress: (loaded, total) => {
                options.onProgress?.(loaded, total);
                const now = Date.now();
                if (now - lastProgress < 200 && loaded !== total) return;
                lastProgress = now;
                const size = `${(loaded / 1048576).toFixed(1)} MiB`;
                this.showInstallProgress(`${StringTable.Downloading} ${dependency.modName}: ${total ? `${Math.round(loaded / total * 100)}% (${size})` : size}`);
            },
        };
        this.showInstallProgress(`${StringTable.Downloading} ${dependency.modName}…`);
        try {
            const transport = this.thisWin.document.querySelector<HTMLMetaElement>('meta[name="thalia-mod-download-transport"]')?.content;
            if (transport === 'native') {
                const cordova = (this.thisWin as Window & {cordova?: CordovaRuntime}).cordova;
                if (!cordova) throw new Error(`Native downloader is unavailable for dependency [${dependency.modName}].`);
                const downloader = cordova.require('thalia-native-download.NativeDownload') as NativeDownload;
                return new Uint8Array(await downloader.download(dependency.downloadUrl, downloadOptions));
            }
            const proxyBaseUrl = this.thisWin.document.querySelector<HTMLMetaElement>('meta[name="thalia-mod-dependency-proxy"]')?.content;
            const response = await this.thisWin.fetch(dependencyDownloadUrl(dependency.downloadUrl, proxyBaseUrl), {signal: controller.signal});
            return await readArchive(response, downloadOptions);
        } catch (error) {
            if (controller.signal.aborted && !options.signal?.aborted) throw new Error(`Download timed out for [${dependency.modName}].`);
            throw error;
        } finally {
            clearTimeout(timeout);
            options.signal?.removeEventListener('abort', abort);
        }
    }

    loadAndAddMod(htmlFile: HTMLInputElement): Promise<string> {
        if (this.installation) return this.installation;
        this.installationAbort = new AbortController();
        this.installation = this.installFiles(htmlFile, this.installationAbort.signal).finally(() => {
            this.installation = undefined;
            this.installationAbort = undefined;
        });
        return this.installation;
    }

    private async installFiles(htmlFile: HTMLInputElement, signal: AbortSignal): Promise<string> {
        const files = Array.from(htmlFile.files || []);
        if (!files.length) throw new Error(StringTable.InvalidFile);
        const success: string[] = [];
        const failures: string[] = [];
        // IndexedDB mod-list updates must remain sequential.
        for (const file of files) {
            checkAborted(signal);
            try {
                success.push(await this.installFile(file, signal));
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                if (signal.aborted) throw new Error([...success, message].join(' | '));
                failures.push(`${file.name}: ${message}`);
            }
        }
        if (!success.length) throw new Error(failures.join('; '));
        return [...success, ...failures].join(' | ');
    }

    private async installFile(file: File, signal: AbortSignal): Promise<string> {
        if (file.size > MAX_ARCHIVE_BYTES) throw new Error('Mod archive exceeds 128 MiB.');
        const controller = this.gModUtils.getModLoadController();
        if (typeof controller.getStoredModInfoIndexDB !== 'function') {
            throw new Error('Update ModLoader to a Thalia build with stored mod metadata support before installing.');
        }
        const inspect = async (data: Uint8Array): Promise<ModBootJson> => {
            const manifest = await controller.checkModZipFileIndexDB(data);
            if (typeof manifest === 'string') throw new Error(manifest);
            return manifest;
        };
        const installer = new DependencyInstaller<ModBootJson>({
            list: async () => {
                const [enabled, disabled] = await Promise.all([controller.listModIndexDB(), controller.loadHiddenModList()]);
                const hidden = new Set(disabled);
                return [...new Set([...enabled, ...disabled])].map(name => ({name, disabled: hidden.has(name)}));
            },
            metadata: name => controller.getStoredModInfoIndexDB(name),
            loaded: name => this.gModUtils.getMod(name)?.bootJson,
            matches: (version, range) => this.matchVersion(version, range),
            download: (dependency, options) => this.fetchDependencyArchive(dependency, options),
            inspect,
            save: async (manifest, data) => {
                this.showInstallProgress(`${StringTable.Saving} ${manifest.name}…`);
                await controller.addModIndexDB(manifest.name, data, manifest);
            },
        }, {signal});
        try {
            // Keep the selected File as a Blob handle. The parsing helper's byte buffer dies
            // before recursive dependency planning starts.
            const inspectFile = async () => inspect(new Uint8Array(await file.arrayBuffer()));
            const manifest = await inspectFile();
            checkAborted(signal);
            await installer.install(manifest, file);
            return `${StringTable.InstallSuccess} ${installer.added.join(', ')}`;
        } catch (error) {
            const message = signal.aborted ? StringTable.InstallCancelled : error instanceof Error ? error.message : String(error);
            const partial = installer.added.length ? ` ${StringTable.AlreadySaved} ${installer.added.join(', ')}` : '';
            throw new Error(message + partial);
        }
    }

    async listSideLoadMod2() {
        const nameList = await this.gModUtils.getModLoadController().listModIndexDB() || [];
        const modList = this.gModUtils.getAllModInfoByFromType('IndexDB' as ModLoadFromSourceType);
        const idl = new Map<string, typeof modList[0]>(modList.map(T => [T.name, T]));
        const modNameVersionList = [];
        for (const T of nameList) {
            const modInfo = idl.get(T);
            if (modInfo) {
                modNameVersionList.push(`${T} {v:${modInfo.mod.version || '?'}}${nickName(modInfo.mod)}`);
            } else {
                modNameVersionList.push(`${T} {v:?}`);
            }
        }
        return modNameVersionList;
    }

    // async listSideLoadMod() {
    //     const nameList = await this.gModUtils.getModLoadController().listModIndexDB() || [];
    //     const idl = this.gSC2DataManager.getModLoader().getIndexDBLoader();
    //     const modNameVersionList = [];
    //     if (idl) {
    //         for (const T of nameList) {
    //             const mod = idl.modZipList.get(T);
    //             if (mod) {
    //                 modNameVersionList.push(`${T} {v:${mod[0].modInfo?.version || '?'}}`);
    //             } else {
    //                 modNameVersionList.push(`${T} {v:?}`);
    //             }
    //         }
    //     }
    //     return modNameVersionList;
    // }

    async listSideLoadModNameOnly() {
        return await this.gModUtils.getModLoadController().listModIndexDB() || [];
    }

    async listSideLoadModNameCanUnload() {
        const readonly = new Set(await this.gModUtils.getModLoadController().loadReadonlyModList());
        const nameList = [
            ...await this.gModUtils.getModLoadController().listModIndexDB(),
            ...await this.gModUtils.getModLoadController().loadHiddenModList(),
        ];
        return nameList.filter(T => !readonly.has(T));
    }

    // async listSideLoadModInfo(): Promise<{ name: string, mod: ModInfo, from: ModLoadFromSourceType }[]> {
    //     const mList = [
    //         // ...this.gModUtils.getAllModInfoByFromType('LocalStorage' as ModLoadFromSourceType),
    //         ...this.gModUtils.getAllModInfoByFromType('IndexDB' as ModLoadFromSourceType),
    //         // ...this.gModUtils.getAllModInfoByFromType('SideLazy' as ModLoadFromSourceType),
    //     ];
    //     const nameList = [
    //         ...await this.gModUtils.getModLoadController().listModIndexDB(),
    //         ...await this.gModUtils.getModLoadController().loadHiddenModList(),
    //     ];
    //     const nameSet = new Set(nameList);
    //     return mList.filter(T => nameSet.has(T.name));
    // }

    async listSideLoadHiddenModNameOnly() {
        return await this.gModUtils.getModLoadController().loadHiddenModList() || [];
    }

    getModListString() {
        const l = this.gModUtils.getModListName();
        const ll = this.gSC2DataManager.getModLoader().getLocalLoader();
        const rl = this.gSC2DataManager.getModLoader().getRemoteLoader();
        const lsl = this.gSC2DataManager.getModLoader().getLocalStorageLoader();
        const idl = this.gSC2DataManager.getModLoader().getIndexDBLoader();
        const lal = this.gSC2DataManager.getModLoader().getLazyLoader();
        const r: string[] = [];
        for (const T of l) {
            let f = false;
            const mi = this.gModUtils.getMod(T);
            const rr: string[] = [];
            if (ll && ll.modZipList.has(T)) {
                rr.push(`[Local] ${T} ${nickName(mi)}{v:${ll.modZipList.get(T)?.[0].modInfo?.version || '?'}}`);
                f = true;
            }
            if (rl && rl.modZipList.has(T)) {
                rr.push(`[Remote] ${T} ${nickName(mi)}{v:${rl.modZipList.get(T)?.[0].modInfo?.version || '?'}}`);
                f = true;
            }
            if (idl && idl.modZipList.has(T)) {
                rr.push(`[SideLoad IndexDB] ${T} ${nickName(mi)}{v:${idl.modZipList.get(T)?.[0].modInfo?.version || '?'}}`);
                f = true;
            }
            if (lsl && lsl.modZipList.has(T)) {
                rr.push(`[SideLoad LocalStorage] ${T} ${nickName(mi)}{v:${lsl.modZipList.get(T)?.[0].modInfo?.version || '?'}}`);
                f = true;
            }
            if (lal && lal.modZipList.has(T)) {
                rr.push(`[SideLoadLazy] ${T} ${nickName(mi)}{v:${lal.modZipList.get(T)?.[0].modInfo?.version || '?'}}`);
                f = true;
            }
            if (rr.length === 0) {
                const m = this.gModUtils.getModAndFromInfo(T);
                if (m) {
                    r.push(`[alias][${m.from}] ${T} [${m.name}] ${nickName(mi)}{v:${m.mod.bootJson.version || '?'}}`);
                } else {
                    r.push(`[?] [${T}] ${nickName(mi)}{v:?}`);
                }
                f = true;
            } else if (rr.length === 1) {
                r.push(...rr);
            } else {
                for (let i = 0; i < rr.length - 1; i++) {
                    r.push(rr[i] + ' [  Overwritten  ]');
                }
                r.push(rr[rr.length - 1]);
            }
            if (!f) {
                r.push(`[?] ${T} <${nickName(mi)}>`);
            }
        }
        return r;
    }

    async getModTReadMe(name: string) {
        const mod = this.gModUtils.getMod(name);
        // console.log('getModTReadMe()', this.gSC2DataManager.getModLoader().modCache);
        // console.log('getModTReadMe()', [name, mod]);
        if (!mod) {
            console.error('getModTReadMe() (!mod)', name);
            return StringTable.NoReadMeString;
        }
        const additionFile = mod.bootJson.additionFile;
        if (!additionFile || isArray(additionFile) && additionFile.length === 0) {
            console.error('getModTReadMe() (!additionFile || isArray(additionFile) && additionFile.length === 0)', [
                name, mod, additionFile
            ]);
            return StringTable.NoReadMeString;
        }
        const readme = additionFile.find(T => T.toLowerCase().startsWith('readme'));
        if (!readme) {
            console.error('getModTReadMe() (!readme)', name);
            this.logger.error(`getModTReadMe() (!zip) [${name}]`);
            return StringTable.NoReadMeString;
        }
        const zip = this.gModUtils.getModZip(name);
        if (!zip) {
            // never go there
            console.error('getModTReadMe() (!zip)', [name, mod]);
            this.logger.error(`getModTReadMe() (!zip) [${name}]`);
            return StringTable.NoReadMeString;
        }
        const readmeFile = zip.zip.file(readme);
        // console.log('readmeFile', readmeFile?.async('string'));
        return await readmeFile?.async('string') || StringTable.NoReadMeString;
    }

    async getModTJson(name: string) {
        const mod = this.gModUtils.getMod(name);
        if (!mod) {
            console.error('getModTJson() (!mod)', name);
            this.logger.error(`getModTJson() (!zip) [${name}]`);
            return StringTable.NoReadMeString;
        }
        return JSON.stringify(mod.bootJson, undefined, 2);
    }

    private readonly patchedVersionNodes = new WeakMap<Element, HTMLSpanElement>();

    patchHtmlNodeVersionString(gameVersionDisplayNode: HTMLElement | Element | undefined | null) {
        if (!gameVersionDisplayNode) {
            return;
        }
        const existing = this.patchedVersionNodes.get(gameVersionDisplayNode);
        const trailing = existing?.parentNode === gameVersionDisplayNode ? existing.previousSibling : gameVersionDisplayNode.lastChild;
        if (trailing?.nodeType === 3) trailing.textContent = trailing.textContent?.trimEnd() ?? '';
        if (existing) {
            if (existing.parentNode !== gameVersionDisplayNode) gameVersionDisplayNode.appendChild(existing);
            return;
        }
        const marker = gameVersionDisplayNode.ownerDocument.createElement('span');
        this.patchedVersionNodes.set(gameVersionDisplayNode, marker);
        marker.textContent = `-(ML-v${this.gModUtils.version})`;
        gameVersionDisplayNode.appendChild(marker);
        const clickCb = async (ev: MouseEvent | any) => {
            console.log(ev);
            if (this.gui && this.gui.isOpen) {
                this.gui.close();
                this.modSubUiAngularJsService.release();
            } else {
                await this.createGui();
                this.gui && this.gui.open();
            }
        };
        gameVersionDisplayNode.addEventListener('click', clickCb);
    }

    patchVersionString() {
        // console.log('patchVersionString()');
        // StartConfig.version = `${StartConfig.version}-(ML${('-v' + this.gModUtils.version || '')})`;
        // @ts-ignore
        // StartConfig.versionName = `${StartConfig.versionName}-(ML${('-v' + this.gModUtils.version || '')})`;

        const gameVersionDisplayNodeList = [
            // for DoL
            document.getElementById('gameVersionDisplay'),
            // for Cot
            document.querySelector('div#title-container span.version'),
        ];
        for (const n of gameVersionDisplayNodeList) {
            this.patchHtmlNodeVersionString(n);
        }
    }

}
