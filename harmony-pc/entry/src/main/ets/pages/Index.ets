import { webview } from '@kit.ArkWeb';
import { HarmonyBridge } from '../bridge/HarmonyBridge';

@Entry
@Component
struct Index {
  private controller: webview.WebviewController = new webview.WebviewController();
  private bridge: HarmonyBridge = new HarmonyBridge();

  aboutToAppear(): void {
    webview.WebviewController.setWebDebuggingAccess(false);
  }

  build() {
    Column() {
      Web({
        src: $rawfile('web/index.html'),
        controller: this.controller
      })
        .width('100%')
        .height('100%')
        .javaScriptAccess(true)
        .domStorageAccess(true)
        .databaseAccess(true)
        .fileAccess(true)
        .imageAccess(true)
        .mixedMode(MixedMode.Compatible)
        .javaScriptProxy({
          object: this.bridge,
          name: '__XYNOTE_HARMONY__',
          methodList: [
            'readStorage',
            'writeStorage',
            'saveFile',
            'openExternalUrl',
            'windowAction'
          ],
          controller: this.controller
        })
    }
    .width('100%')
    .height('100%')
  }
}
