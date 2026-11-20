import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { window } from '@kit.ArkUI';
import { HarmonyRuntimeHolder } from '../bridge/HarmonyBridge';

const DOMAIN = 0x0000;
const TAG = 'XyNoteAbility';

export default class EntryAbility extends UIAbility {
  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    HarmonyRuntimeHolder.setContext(this.context);
    hilog.info(DOMAIN, TAG, 'XyNote HarmonyOS PC EntryAbility onCreate');
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    windowStage.getMainWindow().then((win: window.Window) => {
      HarmonyRuntimeHolder.setMainWindow(win);
      try {
        win.setWindowTitle('小悦笔记 (XyNote)').catch(() => {});
        // 鸿蒙 PC (2in1) 初始窗口尺寸对齐 Windows/macOS/Linux (1320 x 840)
        win.resize(1320, 840).catch(() => {});
      } catch {
        // 忽略平板全屏等模式下的 resize 限制
      }
    }).catch(() => {});

    windowStage.loadContent('pages/Index', (err) => {
      if (err.code) {
        hilog.error(DOMAIN, TAG, 'Failed to load Index: %{public}s', JSON.stringify(err));
      }
    });
  }
}
