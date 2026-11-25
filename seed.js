// Invented sample data, so there is something to try. No real store data.
import { newId, fail } from "./store.js";
import { toJpeg } from "./image.js";
import { ins, stamp, dateStr, addProduct, addLocation, addCabinet, cabinetFull } from "./local.js";

const STAFF = ["示範員工 A", "示範員工 B", "示範員工 C"];
const LOCATIONS = [["A-01", "門邊第一架"], ["A-02", "門邊第二架"], ["B-01", "靠牆下層"]];
const PRODUCTS = [
  ["DEMO-001", "示範馬克杯 白", "馬克杯 白"], ["DEMO-002", "示範馬克杯 藍", "馬克杯 藍"],
  ["DEMO-003", "示範收納盒 小", "收納盒 小"], ["DEMO-004", "示範收納盒 大", "收納盒 大"],
  ["DEMO-005", "示範毛巾 灰", "毛巾 灰"], ["DEMO-006", "示範抱枕 綠", "抱枕 綠"],
];
// One shelf box per row: code, top, height (fractions of the picture)
const LAYERS = [["1", 0.10, 0.26], ["2", 0.38, 0.26], ["3", 0.66, 0.26]];

export async function drawSample() {
  const w = 900;
  const h = 1200;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d");
  const box = (color, x0, y0, x1, y1) => { g.fillStyle = color; g.fillRect(x0, y0, x1 - x0, y1 - y0); };
  box("#e8ecee", 0, 0, w, h);
  box("#806c54", 50, 60, w - 50, h - 50);
  box("#cebea8", 60, 70, w - 60, h - 60);
  const colors = ["#5e81a0", "#c47a5c", "#7a966c", "#9684a8", "#d2b260"];
  LAYERS.forEach(([, top, height], row) => {
    const y1 = (top + height) * h;
    box("#f0e8dc", 75, top * h, w - 75, y1);
    box("#967e62", 75, y1 - 14, w - 75, y1);
    for (let i = 0; i < 5; i++) {
      const bh = 120 + 34 * ((i + row) % 3);
      const x = 112 + i * 140;
      box(colors[(i + row) % 5], x, y1 - 14 - bh, x + 96, y1 - 14);
    }
  });
  return { buf: await toJpeg(c), w, h };
}

export function seed(d, image, img) {
  if (d.products.some((p) => !p.deleted && p.sku === PRODUCTS[0][0])) fail("已經有範例資料了");
  if (image) img.put(image.id, image.buf);
  const t = { created_at: stamp(), updated_at: stamp() };
  for (const name of STAFF) if (!d.staff.some((s) => s.active && s.name === name)) ins(d, "staff", { name, active: 1, ...t });
  const locs = LOCATIONS.map(([code, text]) => addLocation(d, code, text));
  const prods = PRODUCTS.map(([sku, name, short_name]) => addProduct(d, { sku, name, short_name }));
  const cab = addCabinet(d, { code: "示範01", name: "示範櫃", image: image ? image.id : null,
    img_w: image ? image.w : null, img_h: image ? image.h : null });
  const layers = LAYERS.map(([code, y, h], sort) => ins(d, "layers", { cabinet_id: cab, code, x: 0.08, y, w: 0.84, h, sort, deleted: 0 }));
  ins(d, "placements", { layer_id: layers[0], product_id: prods[4], qty: 1, updated_at: t.updated_at });
  ins(d, "placements", { layer_id: layers[1], product_id: prods[5], qty: 1, updated_at: t.updated_at });

  const full = cabinetFull(d, cab);
  const snap = { id: cab, code: full.code, name: full.name, image: full.image, img_w: full.img_w, img_h: full.img_h,
    layers: full.layers.map(({ id, code, label, x, y, w, h }) => ({ id, code, label, x, y, w, h })) };
  const add = (status, day, items) => {
    const when = new Date();
    when.setDate(when.getDate() + day);
    const sent = status === "sent";
    const hid = ins(d, "handoffs", { uid: newId(), received: 0, handoff_date: dateStr(when), giver_name: STAFF[0],
      receiver_name: sent ? STAFF[1] : "", status, note: sent ? "這是示範交接單，可以放心試用" : "", done_photo: null,
      snapshot: sent ? { [cab]: snap } : null, sent_at: sent ? stamp() : null, done_at: null, done_by: null, ...t });
    items.forEach(([action, pi, li, to, loc, qty], n) => ins(d, "items", {
      handoff_id: hid, action, product_id: prods[pi], sku: PRODUCTS[pi][0], name: PRODUCTS[pi][1], qty,
      layer_id: li === null ? null : layers[li], to_layer_id: to === null ? null : layers[to],
      location_id: loc === null ? null : locs[loc], note: "", photo: null, auto_filled: 0, done: 0, done_by: null, done_at: null,
      applied_info: null, problem_type: null, problem_note: "", problem_by: null, sort: n + 1, created_at: t.created_at }));
  };
  add("sent", 0, [["remove", 4, 0, null, 2, 1], ["move", 5, 1, 2, null, 1], ["add", 0, 0, null, 0, 2],
    ["add", 1, 0, null, 0, 1], ["add", 2, 1, null, 1, 3]]);
  add("draft", 1, [["add", 3, null, null, null, 2], ["add", 2, 1, null, 1, 1]]);
}
