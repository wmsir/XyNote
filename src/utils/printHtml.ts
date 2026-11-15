/**
 * 打印一份完整的 HTML 文档：用户在系统打印对话框里选择「另存为 PDF」即可导出 PDF。
 * 放在隐藏的 iframe 里打印，不影响当前界面。
 */
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
