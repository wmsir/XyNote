import "./polyfills/legacyWebKit";
import React from "react";
import ReactDOM from "react-dom/client";
import "katex/dist/katex.min.css";
import App from "./App";
import "./styles/global.css";
import { initUiLanguage } from "./i18n/domTranslator";
import { markPlatformOnBody } from "./utils/platform";
import { installWebviewGuards } from "./utils/webviewGuards";
import { WindowControls } from "./components/shell/WindowControls";

interface RootErrorBoundaryState {
  error: Error | null;
}

class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  RootErrorBoundaryState
> {
  state: RootErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): RootErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error("[XyNote] Uncaught render error:", error, info);
  }

  render(): React.ReactNode {
    if (!this.state.error) {
      return this.props.children;
    }
    const detail = `${this.state.error.name}: ${this.state.error.message}`;
    return (
      <>
      {/* 无边框窗口：出错页也保留拖动区和关闭按钮 */}
      <div data-tauri-drag-region className="nb-error-titlebar">
        <WindowControls />
      </div>
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          background: "#f8fafc",
          color: "#0f172a",
          fontFamily: "-apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif",
        }}
      >
        <div
          style={{
            maxWidth: 520,
            width: "100%",
            background: "#ffffff",
            border: "1px solid #e2e8f0",
            borderRadius: 12,
            padding: 24,
            boxShadow: "0 8px 30px rgba(15, 23, 42, 0.08)",
          }}
        >
          <h2 style={{ margin: "0 0 8px", fontSize: 18 }}>小悦笔记界面加载异常</h2>
          <p style={{ margin: "0 0 12px", fontSize: 13, color: "#475569", lineHeight: 1.6 }}>
            检测到渲染错误，本地笔记数据安全未受影响。您可以点击下方按钮重新加载：
          </p>
          <pre
            style={{
              margin: "0 0 16px",
              padding: 12,
              background: "#f1f5f9",
              borderRadius: 8,
              fontSize: 12,
              overflowX: "auto",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {detail}
          </pre>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              padding: "8px 16px",
              borderRadius: 8,
              border: "none",
              background: "#4f46e5",
              color: "#ffffff",
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            重新加载应用
          </button>
        </div>
      </div>
      </>
    );
  }
}

markPlatformOnBody();
installWebviewGuards();

// 英文界面先加载词典再渲染，避免先闪出中文
void initUiLanguage().finally(() => {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <RootErrorBoundary>
        <App />
      </RootErrorBoundary>
    </React.StrictMode>
  );
});
