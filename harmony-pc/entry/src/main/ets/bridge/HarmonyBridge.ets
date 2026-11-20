import { common, Want } from '@kit.AbilityKit';
import { fileIo as fs, picker } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';
import { window } from '@kit.ArkUI';

/**
 * 保持鸿蒙 PC 主窗口与 UIAbilityContext 引用，供 ArkWeb JSBridge 调用
 */
export class HarmonyRuntimeHolder {
  private static abilityContext: common.UIAbilityContext | null = null;
  private static mainWindow: window.Window | null = null;

  static setContext(ctx: common.UIAbilityContext): void {
    HarmonyRuntimeHolder.abilityContext = ctx;
  }

  static getContext(): common.UIAbilityContext | null {
    return HarmonyRuntimeHolder.abilityContext;
  }

  static setMainWindow(win: window.Window): void {
    HarmonyRuntimeHolder.mainWindow = win;
  }

  static getMainWindow(): window.Window | null {
    return HarmonyRuntimeHolder.mainWindow;
  }
}

/**
 * 注入到 ArkWeb 的 `window.__XYNOTE_HARMONY__` 原生桥接对象
 */
export class HarmonyBridge {
  readonly platform: string = 'harmonyos-pc';
  readonly appVersion: string = '0.8.10';

  private getDataFilePath(): string | null {
    const ctx = HarmonyRuntimeHolder.getContext();
    if (!ctx) return null;
    const dataDir = `${ctx.filesDir}/XyNote-data`;
    try {
      if (!fs.accessSync(dataDir)) {
        fs.mkdirSync(dataDir);
      }
    } catch {
      try {
        fs.mkdirSync(dataDir);
      } catch {
        return null;
      }
    }
    return `${dataDir}/workspace.json`;
  }

  /** 从鸿蒙沙箱原生文件系统读取笔记库 JSON，避免 WebView 缓存清理导致丢数据 */
  readStorage(): string {
    const filePath = this.getDataFilePath();
    if (!filePath) return '';
    try {
      if (!fs.accessSync(filePath)) return '';
      return fs.readTextSync(filePath);
    } catch {
      return '';
    }
  }

  /** 将笔记库 JSON 原子写入鸿蒙沙箱 `XyNote-data/workspace.json` */
  writeStorage(json: string): boolean {
    const filePath = this.getDataFilePath();
    if (!filePath) return false;
    try {
      const tmpPath = `${filePath}.tmp`;
      const file = fs.openSync(tmpPath, fs.OpenMode.CREATE | fs.OpenMode.WRITE_ONLY | fs.OpenMode.TRUNC);
      fs.writeSync(file.fd, json);
      fs.closeSync(file);
      fs.renameSync(tmpPath, filePath);
      return true;
    } catch {
      return false;
    }
  }

  /** 调用鸿蒙 PC 原生文件保存对话框（DocumentViewPicker）导出 PDF/Markdown/OPML/DOCX/PNG 等 */
  async saveFile(filename: string, contentBase64: string, _mimeType: string): Promise<string> {
    const ctx = HarmonyRuntimeHolder.getContext();
    if (!ctx) return '';
    try {
      const saveOpts = new picker.DocumentSaveOptions();
      saveOpts.newFileNames = [filename || 'xynote-export.md'];
      const docPicker = new picker.DocumentViewPicker(ctx);
      const uris = await docPicker.save(saveOpts);
      if (!uris || uris.length === 0) return '';
      const targetUri = uris[0];
      const helper = new util.Base64Helper();
      const bytes = helper.decodeSync(contentBase64);
      const file = fs.openSync(targetUri, fs.OpenMode.WRITE_ONLY | fs.OpenMode.TRUNC);
      fs.writeSync(file.fd, bytes.buffer);
      fs.closeSync(file);
      return targetUri;
    } catch {
      return '';
    }
  }

  /** 通过鸿蒙系统浏览器打开外部链接 */
  async openExternalUrl(url: string): Promise<boolean> {
    const ctx = HarmonyRuntimeHolder.getContext();
    if (!ctx || !url) return false;
    try {
      const want: Want = {
        action: 'ohos.want.action.viewData',
        entities: ['entity.system.browsable'],
        uri: url
      };
      await ctx.startAbility(want);
      return true;
    } catch {
      return false;
    }
  }

  /** 鸿蒙 PC 窗口最小化 / 最大化 / 关闭控制 */
  async windowAction(action: string): Promise<void> {
    const win = HarmonyRuntimeHolder.getMainWindow();
    if (!win) return;
    try {
      if (action === 'minimize') {
        await win.minimize();
      } else if (action === 'toggleMaximize') {
        await win.maximize();
      } else if (action === 'close') {
        await win.destroyWindow();
      }
    } catch {
      // 忽略当前窗口模式不支持的操作
    }
  }
}
