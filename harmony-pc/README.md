# 小悦笔记 XyNote · 鸿蒙 PC (HarmonyOS PC) 原生工程

本目录为 **HarmonyOS 5 (API 12+) Stage Model (`2in1` / PC & 平板)** 原生工程，基于 **ArkTS + ArkWeb + `@kit.CoreFileKit`** 构建，完整复用小悦笔记前端工作区与导出引擎。

## 已内置的鸿蒙 PC 原生能力

- **原生 PC 自由窗口**：配置 `deviceTypes: ["2in1", "tablet"]`、`supportWindowMode: ["fullscreen", "split", "floating"]`，默认 1320×840 窗口，最小 900×600。
- **沙箱原生文件持久化**：通过 `window.__XYNOTE_HARMONY__.readStorage / writeStorage` 将笔记数据原子写入 `context.filesDir/XyNote-data/workspace.json`，不依赖易被清理的 WebView 缓存。
- **原生文件导出保存**：通过 `@kit.CoreFileKit` `DocumentViewPicker` 直接将 PDF / 思维导图 (`.opml`) / Word (`.docx`) / Markdown / HTML / PNG 等导出保存到鸿蒙 PC 本地目录。
- **Markdown 文件关联声明**：在 `module.json5` 中声明 `text/markdown` 与 `text/plain` 接收能力。
- **版本更新检测**：自动连接 `https://fwpt.cn/downloads/xynote/latest.json` 检查新版本。

## 编译与打包 `.hap` / `.app` 步骤

1. **同步最新前端产物到鸿蒙工程**（在仓库根目录执行，如已下载官方发布的 `XyNote-*-harmonyos-pc-project.zip` 则已预先同步好，可跳过）：
   ```bash
   npm ci
   npm run build:harmony
   ```
2. **使用 DevEco Studio 5.0+ 打开本目录**：
   - 启动 **DevEco Studio** → 选择 `Open` → 选中 `harmony-pc/` 目录。
3. **配置签名**：
   - 打开 `File → Project Structure → Signing Configs`，登录华为开发者账号并勾选 **Automatically generate signature**（本地调试 `.hap`），或导入 AppGallery Connect 正式发布证书（上架华为应用市场 `.app`）。
4. **运行或打包**：
   - 连接鸿蒙 PC 真机或模拟器点击 **Run**；
   - 或菜单栏 `Build → Build Hap(s)/APP(s) → Build Hap(s)` 生成 `entry/build/default/outputs/default/entry-default-signed.hap`。
