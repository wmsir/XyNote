/**
 * 打印一份完整的 HTML 文档：用户在系统打印对话框里选择「另存为 PDF」即可导出 PDF。
 * 放在隐藏的 iframe 里打印，不影响当前界面。
 *
 * 浏览器默认会在页眉页脚印上网址（tauri.localhost）、日期和页码。把 @page 边距设为 0
 * 后浏览器就没有地方印这些内容；页边距改由每页重复的表头 / 表尾留白来提供。
 */
const PRINT_CSS = `
  @page { margin: 0; }
  @media print {
    html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }
    footer { display: none !important; }
    table.xy-print-frame { width: 100%; border-collapse: collapse; border: 0; margin: 0; font-size: inherit; }
    table.xy-print-frame > thead > tr > td,
    table.xy-print-frame > tfoot > tr > td { height: 16mm; padding: 0; border: 0; }
    table.xy-print-frame > tbody > tr > td { padding: 0 18mm; border: 0; }
    table.xy-print-frame main { max-width: none; padding: 0; margin: 0; }
  }
`;

/** 用每页重复的表头 / 表尾包住正文，作为页边距 */
function wrapForPrint(doc: Document): void {
  const style = doc.createElement("style");
  style.textContent = PRINT_CSS;
  doc.head.appendChild(style);
  const table = doc.createElement("table");
  table.className = "xy-print-frame";
  table.innerHTML = "<thead><tr><td></td></tr></thead><tfoot><tr><td></td></tr></tfoot><tbody><tr><td></td></tr></tbody>";
  const cell = table.querySelector("tbody td") as HTMLElement;
  while (doc.body.firstChild) cell.appendChild(doc.body.firstChild);
  doc.body.appendChild(table);
}
export function printHtmlDocument(html: string, title: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;";
    document.body.appendChild(frame);
    const cleanup = () => setTimeout(() => frame.remove(), 1000);
    frame.onload = () => {
      const win = frame.contentWindow;
      if (!win) {
        cleanup();
        reject(new Error("无法打开打印"));
        return;
      }
      try {
        win.document.title = title;
        wrapForPrint(win.document);
        // 等图片解码完再打印
        const images = Array.from(win.document.images);
        Promise.all(
          images.map((img) =>
            img.complete ? Promise.resolve() : new Promise((r) => img.addEventListener("load", r, { once: true }))
          )
        ).then(() => {
          win.focus();
          win.print();
          cleanup();
          resolve();
        });
      } catch (e) {
        cleanup();
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    };
    frame.srcdoc = html;
  });
}
