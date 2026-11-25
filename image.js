// Every photo is redrawn as a smaller JPEG before it is stored. That also removes the GPS data phones add.
import { fail } from "./store.js";

function loadFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve([img, url]);
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("image")); };
    img.src = url;
  });
}

export const toJpeg = (canvas, quality = 0.82) => new Promise((resolve, reject) => {
  canvas.toBlob((b) => (b ? b.arrayBuffer().then(resolve, reject) : reject(new Error("canvas"))), "image/jpeg", quality);
});

export async function encodeImage(file, maxSide) {
  let img;
  let url;
  try {
    [img, url] = await loadFile(file);
  } catch {
    fail("無法讀取圖片，請改用 JPG 或 PNG");
  }
  try {
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(img.naturalWidth * scale));
    c.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const g = c.getContext("2d");
    g.fillStyle = "#fff";
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(img, 0, 0, c.width, c.height);
    return { buf: await toJpeg(c), w: c.width, h: c.height };
  } catch {
    return fail("圖片處理失敗，請換一張較小的照片");
  } finally {
    URL.revokeObjectURL(url);
  }
}
