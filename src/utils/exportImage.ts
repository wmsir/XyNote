/**
 * 页面导出为图片（PNG）：把导出用的 HTML 放进看不见的 iframe 排版，
 * 再通过 SVG foreignObject 画到 canvas 上。页面太长时自动切成多张。
 */

/** 每张图最大高度（CSS 像素）；超出后分成多张，避免超过 canvas 尺寸上限 */
const MAX_SLICE_CSS = 7000;
const WIDTH = 860;
const SCALE = 2;

function waitForImages(doc: Document): Promise<void> {
  const imgs = Array.from(doc.images).filter((img) => !img.complete);
  return Promise.all(
    imgs.map(
      (img) =>
        new Promise<void>((resolve) => {
          img.addEventListener("load", () => resolve(), { once: true });
          img.addEventListener("error", () => resolve(), { once: true });
          window.setTimeout(resolve, 4000);
        })
    )
  ).then(() => undefined);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "sync";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("页面渲染成图片失败"));
    img.src = src;
  });
}

/** 返回每张图片的 base64（data URL） */
export async function renderHtmlToPngParts(html: string): Promise<string[]> {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.cssText = `position:fixed;left:-10000px;top:0;width:${WIDTH}px;height:600px;border:0;visibility:hidden;`;
  document.body.appendChild(iframe);
  try {
    await new Promise<void>((resolve) => {
      iframe.onload = () => resolve();
      iframe.srcdoc = html;
    });
    const doc = iframe.contentDocument;
    if (!doc) throw new Error("页面渲染成图片失败");
    // 导出的页脚在图片里没必要
    doc.querySelectorAll("footer").forEach((f) => f.remove());
    // 网络图片无法画进图片（也会让画布不可导出），换成说明文字
    doc.querySelectorAll("img").forEach((img) => {
      const src = img.getAttribute("src") ?? "";
      if (!src.startsWith("data:")) {
        const span = doc.createElement("span");
        span.textContent = `[图片] ${img.getAttribute("alt") || src}`;
        span.style.color = "#8c959f";
        img.replaceWith(span);
      }
    });
    await waitForImages(doc);
    if (doc.fonts?.ready) await doc.fonts.ready.catch(() => undefined);

    const height = Math.ceil(Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight));
    iframe.style.height = `${height}px`;

    // 把样式和内容序列化成 XHTML 放进 SVG
    const styles = Array.from(doc.querySelectorAll("style"))
      .map((s) => s.textContent ?? "")
      .join("\n");
    const bodyXhtml = new XMLSerializer().serializeToString(doc.body);
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}">` +
      `<foreignObject x="0" y="0" width="100%" height="100%">` +
      `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${WIDTH}px;background:#fff;">` +
      `<style>${styles.replace(/<\/style/gi, "")}</style>${bodyXhtml}</div>` +
      `</foreignObject></svg>`;
    const img = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);

    const parts: string[] = [];
    for (let y = 0; y < height; y += MAX_SLICE_CSS) {
      const h = Math.min(MAX_SLICE_CSS, height - y);
      const canvas = document.createElement("canvas");
      canvas.width = WIDTH * SCALE;
      canvas.height = h * SCALE;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("页面渲染成图片失败");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, y, WIDTH, h, 0, 0, canvas.width, canvas.height);
      parts.push(canvas.toDataURL("image/png"));
    }
    return parts;
  } finally {
    iframe.remove();
  }
}
