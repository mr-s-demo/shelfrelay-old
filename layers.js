// Cabinet stage (photo + layer boxes) and the drag-to-draw layer editor.
import { esc, fileUrl } from "./core.js";

// marks: { [layerId]: "add" | "remove" | "move" | "sel" ... } adds CSS classes.
export function stageHTML(cab, { marks = {}, badges = {}, clickable = false } = {}) {
  const ratio = cab.img_w && cab.img_h ? (cab.img_h / cab.img_w) * 100 : 133;
  const img = cab.image
    ? `<img src="${fileUrl(cab.image)}" alt="${esc(cab.code)}" draggable="false">`
    : `<div class="stage-empty">${cab.schematic ? "" : "尚未上傳櫃體照片"}</div>`;
  const boxes = (cab.layers || []).map((l) => {
    const cls = [].concat(marks[l.id] || []).map((m) => `m-${m}`).join(" ");
    const badge = badges[l.id] ? `<span class="layer-badge">${esc(badges[l.id])}</span>` : "";
    return `<${clickable ? "button" : "div"} class="layer ${cls}" data-layer="${l.id}"
      style="left:${l.x * 100}%;top:${l.y * 100}%;width:${l.w * 100}%;height:${l.h * 100}%">
      <span class="layer-code">${esc(cab.code)}-${esc(l.code)}</span>${badge}</${clickable ? "button" : "div"}>`;
  }).join("");
  return `<div class="stage" style="padding-top:${ratio}%">${img}<div class="stage-layers">${boxes}</div></div>`;
}

// Interactive editor. layers: [{id?, code, x, y, w, h}] ratios 0-1.
export function mountEditor(root, cab, onChange) {
  let layers = (cab.layers || []).map((l) => ({ id: l.id, code: l.code, x: l.x, y: l.y, w: l.w, h: l.h }));
  let sel = -1;
  const ratio = cab.img_w && cab.img_h ? (cab.img_h / cab.img_w) * 100 : 133;
  root.innerHTML = `<div class="stage editor" style="padding-top:${ratio}%">
      ${cab.image ? `<img src="${fileUrl(cab.image)}" alt="" draggable="false">` : `<div class="stage-empty">先上傳櫃體照片</div>`}
      <div class="stage-layers" data-surface></div></div>`;
  const surface = root.querySelector("[data-surface]");

  const emit = () => onChange && onChange(layers, sel);
  const draw = () => {
    surface.innerHTML = layers.map((l, i) => `<div class="layer edit ${i === sel ? "m-sel" : ""}" data-i="${i}"
        style="left:${l.x * 100}%;top:${l.y * 100}%;width:${l.w * 100}%;height:${l.h * 100}%">
        <span class="layer-code">${esc(cab.code)}-${esc(l.code)}</span>
        ${i === sel ? `<span class="handle" data-h="nw"></span><span class="handle" data-h="ne"></span>
          <span class="handle" data-h="sw"></span><span class="handle" data-h="se"></span>` : ""}</div>`).join("");
  };

  const pt = (e) => {
    const r = surface.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  let drag = null;
  surface.addEventListener("pointerdown", (e) => {
    const p = pt(e);
    const handle = e.target.closest("[data-h]");
    const box = e.target.closest("[data-i]");
    if (handle && sel >= 0) {
      drag = { mode: "resize", h: handle.dataset.h, start: p, orig: { ...layers[sel] } };
    } else if (box) {
      sel = +box.dataset.i;
      drag = { mode: "move", start: p, orig: { ...layers[sel] } };
    } else {
      const code = String(nextCode(layers));
      layers.push({ code, x: p.x, y: p.y, w: 0.001, h: 0.001 });
      sel = layers.length - 1;
      drag = { mode: "new", start: p, orig: { ...layers[sel] } };
    }
    surface.setPointerCapture(e.pointerId);
    draw();
    emit();
    e.preventDefault();
  });
  surface.addEventListener("pointermove", (e) => {
    if (!drag || sel < 0) return;
    const p = pt(e);
    const o = drag.orig;
    const l = layers[sel];
    if (drag.mode === "move") {
      l.x = clamp(o.x + p.x - drag.start.x, 0, 1 - o.w);
      l.y = clamp(o.y + p.y - drag.start.y, 0, 1 - o.h);
    } else if (drag.mode === "new") {
      l.x = Math.min(drag.start.x, p.x);
      l.y = Math.min(drag.start.y, p.y);
      l.w = Math.abs(p.x - drag.start.x);
      l.h = Math.abs(p.y - drag.start.y);
    } else {
      let x1 = o.x, y1 = o.y, x2 = o.x + o.w, y2 = o.y + o.h;
      if (drag.h.includes("w")) x1 = p.x;
      if (drag.h.includes("e")) x2 = p.x;
      if (drag.h.includes("n")) y1 = p.y;
      if (drag.h.includes("s")) y2 = p.y;
      l.x = Math.min(x1, x2); l.w = Math.abs(x2 - x1);
      l.y = Math.min(y1, y2); l.h = Math.abs(y2 - y1);
    }
    draw();
  });
  const end = () => {
    if (!drag) return;
    if (drag.mode === "new" && (layers[sel].w < 0.03 || layers[sel].h < 0.02)) {
      layers.splice(sel, 1);
      sel = -1;
    }
    drag = null;
    draw();
    emit();
  };
  surface.addEventListener("pointerup", end);
  surface.addEventListener("pointercancel", end);

  draw();
  return {
    get layers() { return layers; },
    get selected() { return sel; },
    select(i) { sel = i; draw(); emit(); },
    setCode(i, code) { layers[i].code = code; draw(); emit(); },
    remove(i) { layers.splice(i, 1); sel = -1; draw(); emit(); },
    // Evenly split the photo into n horizontal shelves (top = 1).
    split(n, { top = 0, bottom = 1, left = 0, right = 1 } = {}) {
      const keepIds = layers.map((l) => l.id).filter(Boolean);
      const h = (bottom - top) / n;
      layers = Array.from({ length: n }, (_, i) => ({
        id: keepIds[i], code: String(i + 1), x: left, y: top + i * h, w: right - left, h,
      }));
      sel = -1;
      draw();
      emit();
    },
  };
}

function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
function nextCode(layers) {
  const nums = layers.map((l) => parseInt(l.code, 10)).filter((n) => !isNaN(n));
  return nums.length ? Math.max(...nums) + 1 : 1;
}
