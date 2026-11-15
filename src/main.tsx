import React from "react";
import ReactDOM from "react-dom/client";
import "katex/dist/katex.min.css";
import App from "./App";
import "./styles/global.css";
import { initUiLanguage } from "./i18n/domTranslator";

// 英文界面先加载词典再渲染，避免先闪出中文
void initUiLanguage().finally(() => {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
});
