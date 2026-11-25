// Draw the annotated cabinet card (photo + colored layer marks + numbered list) on a canvas.
import { fileUrl } from "./core.js";

const C = {
  add: "#15803d",
  remove: "#dc2626",
  move: "#ea580c",
  ink: "#1f2937",
  muted: "#6b7280",
  line: "#e5e7eb",
  bg: "#ffffff",
};
const FONT = `"Noto Sans TC","Microsoft JhengHei","PingFang TC","Heiti TC",sans-serif`;

// Entries for one cabinet, in display order (remove/move first, then add).
export function cabinetEntries(cab, items) {
  const out = [];
  const first = items.filter((i) => i.action !== "add");
  const adds = items.filter((i) => i.action === "add");
  for (const it of first) {
    if (it.action === "remove" && it.cabinet_id === cab.id) {
      out.push({ kind: "remove", layer: it.layer_id, chip: `撤下 ${it.display}`,
        text: `撤下 ${it.label} ${it.display} → 回倉${it.location_code ? " " + it.location_code : ""}`, item: it });
    }
    if (it.action === "move" && it.cabinet_id === cab.id) {
      out.push({ kind: "move", layer: it.layer_id, chip: `移出 ${it.display}`,
        text: `移位 ${it.label} ${it.display} → ${it.to_label || "？"}`, item: it });
    }
    if (it.action === "move" && it.to_cabinet_id === cab.id && it.to_layer_id) {
      out.push({ kind: "move", layer: it.to_layer_id, chip: `移入 ${it.display}`,
        text: `移入 ${it.to_label} ${it.display}（從 ${it.label}）`, item: it });
    }
  }
  for (const it of adds) {
    if (it.cabinet_id === cab.id) {
      out.push({ kind: "add", layer: it.layer_id, chip: `上架 ${it.display} ×${it.qty}`,
        text: `上架 ${it.label} ${it.display} ×${it.qty}`, item: it });
    }
  }
  return out.map((e, i) => ({ ...e, n: i + 1 }));
}

function loadImage(src) {
  return new Promise((resolve) => {
    if (!src) return resolve(null);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function fit(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + "…").width > maxW) t = t.slice(0, -1);
  return t + "…";
}

function numBadge(ctx, n, cx, cy, r, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.font = `700 ${Math.round(r * 1.15)}px ${FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(n), cx, cy + 1);
  ctx.textAlign = "left";
}

function strokeLayer(ctx, kind, x, y, w, h) {
  ctx.save();
  ctx.lineWidth = 6;
  ctx.strokeStyle = C[kind];
  if (kind === "remove") ctx.setLineDash([18, 10]);
  ctx.strokeRect(x, y, w, h);
  ctx.restore();
}

export async function drawCard(cab, items, meta = {}) {
  const W = 1080;
  const pad = 36;
  const entries = cabinetEntries(cab, items);
  const img = cab.image ? await loadImage(fileUrl(cab.image)) : null;
  const ratio = cab.img_w && cab.img_h ? cab.img_h / cab.img_w : img ? img.height / img.width : 1.25;
  let imgW = W - pad * 2;
  let imgH = imgW * ratio;
  const maxH = 1400;
  if (imgH > maxH) {
    imgH = maxH;
    imgW = imgH / ratio;
  }
  const imgX = (W - imgW) / 2;
  const headH = 132;
  const lineH = 58;
  const listH = entries.length * lineH + 30;
  const legendH = 92;
  const H = Math.round(headH + imgH + 28 + listH + legendH + 24);

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);

  // header
  ctx.fillStyle = C.ink;
  ctx.textBaseline = "alphabetic";
  ctx.font = `800 64px ${FONT}`;
  ctx.fillText(cab.code, pad, 78);
  const codeW = ctx.measureText(cab.code).width;
  ctx.font = `500 30px ${FONT}`;
  ctx.fillStyle = C.muted;
  ctx.fillText(fit(ctx, cab.name || "", W - pad * 2 - codeW - 24), pad + codeW + 20, 76);
  ctx.font = `600 30px ${FONT}`;
  ctx.fillStyle = C.ink;
  const sub = `${meta.date_label || ""} 進貨交接${meta.giver_name ? `・交班 ${meta.giver_name}` : ""}`;
  ctx.fillText(fit(ctx, sub, W - pad * 2), pad, 118);

  // photo
  const top = headH;
  if (img) {
    ctx.drawImage(img, imgX, top, imgW, imgH);
  } else {
    ctx.fillStyle = "#f3f4f6";
    ctx.fillRect(imgX, top, imgW, imgH);
  }
  const byLayer = {};
  for (const e of entries) (byLayer[e.layer] ||= []).push(e);

  for (const l of cab.layers || []) {
    const x = imgX + l.x * imgW;
    const y = top + l.y * imgH;
    const w = l.w * imgW;
    const h = l.h * imgH;
    const es = byLayer[l.id] || [];
    ctx.save();
    ctx.lineWidth = 2;
    ctx.strokeStyle = !img ? "#9ca3af" : es.length ? "rgba(255,255,255,.9)" : "rgba(255,255,255,.55)";
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
    // layer code tag
    ctx.font = `700 24px ${FONT}`;
    const tag = `${l.code}`;
    const tw = ctx.measureText(tag).width + 16;
    ctx.fillStyle = "rgba(17,24,39,.72)";
    roundRect(ctx, x + 4, y + 4, tw, 32, 6);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.fillText(tag, x + 12, y + 28);
    if (!es.length) continue;
    const kinds = [...new Set(es.map((e) => e.kind))];
    kinds.forEach((k, i) => strokeLayer(ctx, k, x + i * 7, y + i * 7, w - i * 14, h - i * 14));

    // chips
    const fs = Math.max(22, Math.min(34, h * 0.2));
    ctx.font = `700 ${fs}px ${FONT}`;
    const chipH = fs + 16;
    const avail = h - 44;
    const full = es.length * (chipH + 6) <= avail && w > 180;
    if (full) {
      let cy = y + 42;
      for (const e of es) {
        const label = fit(ctx, `${e.n} ${e.chip}`, w - 36);
        const cw = ctx.measureText(label).width + 22;
        ctx.fillStyle = e.kind === "remove" ? "#fff" : C[e.kind];
        roundRect(ctx, x + 10, cy, cw, chipH, 10);
        ctx.fill();
        if (e.kind === "remove") {
          ctx.save();
          ctx.setLineDash([8, 5]);
          ctx.lineWidth = 3;
          ctx.strokeStyle = C.remove;
          ctx.stroke();
          ctx.restore();
        }
        ctx.fillStyle = e.kind === "remove" ? C.remove : "#fff";
        ctx.fillText(label, x + 21, cy + chipH / 2 + fs * 0.36);
        cy += chipH + 6;
      }
    } else {
      const r = Math.max(16, Math.min(26, h * 0.18));
      let cx = x + tw + 14 + r;
      let cy = y + 4 + r;
      for (const e of es) {
        if (cx + r > x + w - 4) {
          cx = x + 10 + r;
          cy += r * 2 + 6;
        }
        numBadge(ctx, e.n, cx, cy, r, C[e.kind]);
        cx += r * 2 + 6;
      }
    }
  }

  // numbered list
  let y = top + imgH + 28;
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(pad, y);
  ctx.lineTo(W - pad, y);
  ctx.stroke();
  y += 14;
  for (const e of entries) {
    numBadge(ctx, e.n, pad + 20, y + lineH / 2, 19, C[e.kind]);
    ctx.font = `600 31px ${FONT}`;
    ctx.fillStyle = C.ink;
    ctx.textBaseline = "middle";
    ctx.fillText(fit(ctx, e.text, W - pad * 2 - 56), pad + 54, y + lineH / 2 + 1);
    ctx.textBaseline = "alphabetic";
    y += lineH;
  }

  // legend
  y = H - legendH;
  const items3 = [["add", "上架（綠框）"], ["remove", "撤下（紅虛線）"], ["move", "移位（橘框）"]];
  let lx = pad;
  ctx.font = `600 27px ${FONT}`;
  for (const [k, t] of items3) {
    strokeLayer(ctx, k, lx, y + 22, 46, 34);
    ctx.fillStyle = C.ink;
    ctx.fillText(t, lx + 58, y + 50);
    lx += 58 + ctx.measureText(t).width + 36;
  }
  return { canvas, entries };
}

export function canvasToBlob(canvas) {
  return new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.9));
}
