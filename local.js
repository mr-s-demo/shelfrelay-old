// The app's data rules, running in the browser. Views call api("/handoffs/3", {...}) and it lands here.
import { tx, fail, ApiError, newId, storageMode, askPersist, loadImages, imageIds } from "./store.js";
import { parseFile, parseInt1, parseNum, MAX_ROWS } from "./importer.js";
import { encodeImage } from "./image.js";
import { seed, drawSample } from "./seed.js";
import { pack, linkFor, handoffPayload, reportPayload } from "./link.js";
import { exportBackup, readBackup, restoreAll, mergeMaster } from "./backup.js";

export const RETENTION_DAYS = 90;
export const ACTIONS = { add: "上架", remove: "撤下", move: "移位" };
export const PROBLEMS = { no_space: "放不下", out_of_stock: "缺貨", wrong_item: "品項不符", other: "其他" };
const DAY = 86400000;

// ---------- small helpers ----------

const p2 = (n) => String(n).padStart(2, "0");
export const dateStr = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
export const stamp = (d = new Date()) => `${dateStr(d)}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
const trim = (v) => String(v ?? "").trim();
const low = (v) => String(v ?? "").toLowerCase();
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function ins(d, table, rec) {
  const row = { id: d.next++, ...rec };
  d[table].push(row);
  return row.id;
}
export const byId = (d, table, id) => d[table].find((r) => r.id === id);
const live = (d, table, id, msg) => {
  const r = byId(d, table, id);
  if (!r || r.deleted) fail(msg);
  return r;
};
const drop = (d, table, test) => { d[table] = d[table].filter((r) => !test(r)); };

const parseDay = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
  if (!m) return null;
  const t = new Date(+m[1], m[2] - 1, +m[3]);
  return dateStr(t) === s ? t : null;
};
export function dateLabel(s) {
  const t = parseDay(s);
  return t ? `${t.getMonth() + 1}/${t.getDate()}（${"日一二三四五六"[t.getDay()]}）` : s;
}
export const daysLeft = (created, now = Date.now()) =>
  Math.max(0, Math.ceil((new Date(created).getTime() + RETENTION_DAYS * DAY - now) / DAY)) || 0;

// ---------- shelves ----------

export const layerOf = (d, lid) => {
  if (!lid) return null;
  const layer = byId(d, "layers", lid);
  const cab = layer && byId(d, "cabinets", layer.cabinet_id);
  return cab ? { layer, cab } : null;
};
const liveLayer = (d, lid) => {
  const x = layerOf(d, lid);
  return x && !x.layer.deleted && !x.cab.deleted ? x : null;
};

export function cabinetFull(d, cid) {
  const cab = byId(d, "cabinets", cid);
  if (!cab) return null;
  const layers = d.layers.filter((l) => l.cabinet_id === cid && !l.deleted)
    .sort((a, b) => a.sort - b.sort || a.y - b.y || a.id - b.id)
    .map((l) => ({
      ...l, label: `${cab.code}-${l.code}`,
      placements: d.placements.filter((p) => p.layer_id === l.id).map((p) => {
        const pr = byId(d, "products", p.product_id) || {};
        return { ...p, sku: pr.sku || "", name: pr.name || "", short_name: pr.short_name || "", image: pr.image || null };
      }),
    }));
  return { ...cab, layers };
}
const geometry = (c) => ({
  id: c.id, code: c.code, name: c.name, image: c.image || null, img_w: c.img_w || null, img_h: c.img_h || null,
  layers: c.layers.map((l) => ({ id: l.id, code: l.code, label: l.label, x: l.x, y: l.y, w: l.w, h: l.h })),
});

// ---------- handoffs ----------

function getHandoff(d, hid, statuses, own = false) {
  const h = byId(d, "handoffs", hid);
  if (!h) fail("找不到交接單，可能已刪除或到期");
  if (own && h.received) fail("這是別人傳來的交接單，不能修改內容");
  if (statuses && !statuses.includes(h.status)) {
    fail({ draft: "這張交接單還沒送出", sent: "這張交接單已送出", done: "這張交接單已完成" }[h.status]);
  }
  return h;
}
function getItem(d, hid, iid) {
  const it = byId(d, "items", iid);
  if (!it || it.handoff_id !== hid) fail("找不到這個項目");
  return it;
}
const itemsOf = (d, hid) => d.items.filter((i) => i.handoff_id === hid).sort((a, b) => a.sort - b.sort || a.id - b.id);

function enriched(d, hid) {
  return itemsOf(d, hid).map((i) => {
    if (i.ext) return { ...i, ...i.ext, name: i.ext.display, product_image: null };
    const p = i.product_id ? byId(d, "products", i.product_id) : null;
    const a = layerOf(d, i.layer_id);
    const b = layerOf(d, i.to_layer_id);
    const loc = i.location_id ? byId(d, "locations", i.location_id) : null;
    const name = p ? p.name : i.name;
    return {
      ...i, name, sku: p ? p.sku : i.sku, display: (p && p.short_name) || name, product_image: (p && p.image) || null,
      location_code: loc ? loc.code : null,
      layer_code: a && a.layer.code, cabinet_code: a && a.cab.code, cabinet_id: a && a.cab.id,
      label: a ? `${a.cab.code}-${a.layer.code}` : "",
      to_layer_code: b && b.layer.code, to_cabinet_code: b && b.cab.code, to_cabinet_id: b && b.cab.id,
      to_label: b ? `${b.cab.code}-${b.layer.code}` : "",
    };
  });
}

function handoffCabinets(d, h, items) {
  if (h.received) return h.cabinets;
  const ids = [...new Set(items.flatMap((i) => [i.cabinet_id, i.to_cabinet_id]).filter(Boolean))];
  return ids.map((id) => {
    const snap = h.status !== "draft" && h.snapshot && h.snapshot[id];
    if (snap) return snap;
    const c = cabinetFull(d, id);
    return c && geometry(c);
  }).filter(Boolean).sort((a, b) => cmp(a.code, b.code));
}

const progress = (items) => ({
  total: items.length, done: items.filter((i) => i.done).length, problems: items.filter((i) => i.problem_type).length,
});

function shareBody(h, items) {
  const cabs = [...new Set(items.flatMap((i) => [i.cabinet_code, i.to_cabinet_code]).filter(Boolean))].sort();
  const lines = [`【進貨交接】${dateLabel(h.handoff_date)}交班：${h.giver_name || "（未填）"} → 接班：${h.receiver_name || "（未指定）"}`];
  if (cabs.length) lines.push(`動到櫃位：${cabs.join("、")}`);
  const first = items.filter((i) => i.action !== "add").sort((a, b) => cmp(a.label, b.label));
  const adds = items.filter((i) => i.action === "add")
    .sort((a, b) => cmp(a.label || "~", b.label || "~") || cmp(a.display, b.display));
  if (first.length) {
    lines.push("", "① 先撤下／移位");
    for (const i of first) {
      const dest = i.action === "remove" ? `回倉${i.location_code ? ` ${i.location_code}` : ""}` : `移到 ${i.to_label || "？"}`;
      lines.push(`・${i.label || "？"} ${i.display} → ${dest}`);
    }
  }
  if (adds.length) {
    lines.push("", first.length ? "② 上架" : "上架");
    for (const i of adds) {
      lines.push(`・${i.label || "（未指定櫃層）"} ${i.display} ×${i.qty} 箱${i.location_code ? `（倉位 ${i.location_code}）` : ""}`);
    }
  }
  if (h.note) lines.push("", `備註：${h.note}`);
  return lines.join("\n");
}

function validate(h, items) {
  const errors = [];
  const warnings = [];
  if (!h.receiver_name) errors.push("請選擇接班人");
  if (!items.length) errors.push("交接單沒有任何項目");
  for (const i of items) {
    const name = i.display || i.sku;
    if (!i.product_id) errors.push(`${i.sku} ${name}：尚未建立商品資料`);
    if (!i.layer_id) errors.push(`${name}：未指定櫃層`);
    if (i.action === "move" && !i.to_layer_id) errors.push(`${name}：未指定移到哪一層`);
    if (i.auto_filled) warnings.push(`${name}：位置為系統自動帶入，尚未確認`);
  }
  return [errors, warnings];
}

function detail(d, h) {
  const items = enriched(d, h.id);
  const [send_errors, send_warnings] = h.received ? [[], []] : validate(h, items);
  const { snapshot, ...rest } = h;
  return {
    ...rest, items, cabinets: handoffCabinets(d, h, items), progress: progress(items),
    date_label: dateLabel(h.handoff_date), days_left: daysLeft(h.created_at), send_errors, send_warnings,
    share_body: shareBody(h, items),
  };
}

// Compressing a link is asynchronous, so it happens after the transaction.
async function withLink(h) {
  if (h.received) return { ...h, share_text: h.share_body, share_link: "" };
  if (h.status === "draft") {
    return { ...h, share_link: "", share_text: `${h.share_body}\n\n待辦連結：（送出後會附上）` };
  }
  const link = linkFor("v", await pack(handoffPayload(h)));
  return { ...h, share_link: link, share_text: `${h.share_body}\n\n待辦連結：${link}` };
}

async function withReport(h, by) {
  const p = h.progress;
  const left = h.items.filter((i) => !i.done && !i.problem_type);
  const probs = h.items.filter((i) => i.problem_type);
  const lines = [`【交接回報】${h.date_label} 回報：${by || "（未填）"}`,
    `完成 ${p.done}/${p.total} 項${p.total && p.done === p.total ? " ✅ 全部完成" : ""}`];
  if (probs.length) {
    lines.push("", "⚠ 有問題");
    for (const i of probs) lines.push(`・${i.label || ""} ${i.display}：${PROBLEMS[i.problem_type]}${i.problem_note ? `（${i.problem_note}）` : ""}`);
  }
  if (left.length) {
    lines.push("", "還沒完成");
    for (const i of left) lines.push(`・${i.label || ""} ${i.display}`);
  }
  if (h.received) lines.push("", `交班人點這裡更新進度：${linkFor("r", await pack(reportPayload(h, by, stamp())))}`);
  return { text: lines.join("\n") };
}

// ---------- placements ----------

function applyItem(d, it) {
  const info = { created: [], deleted: [] };
  if (!it.product_id || !it.layer_id) return info;
  const put = (layer_id) => {
    if (!d.placements.some((p) => p.layer_id === layer_id && p.product_id === it.product_id)) {
      info.created.push(ins(d, "placements", { layer_id, product_id: it.product_id, qty: Math.max(1, it.qty), updated_at: stamp() }));
    }
  };
  const take = (layer_id) => {
    info.deleted.push(...d.placements.filter((p) => p.layer_id === layer_id && p.product_id === it.product_id));
    drop(d, "placements", (p) => p.layer_id === layer_id && p.product_id === it.product_id);
  };
  if (it.action === "add") put(it.layer_id);
  else if (it.action === "remove") take(it.layer_id);
  else if (it.to_layer_id) { take(it.layer_id); put(it.to_layer_id); }
  return info;
}

function setDone(d, it, on, by, at = stamp()) {
  if (on && !it.done) {
    Object.assign(it, { done: 1, done_by: by, done_at: at, applied_info: applyItem(d, it) });
  } else if (!on && it.done) {
    const info = it.applied_info || {};
    drop(d, "placements", (p) => (info.created || []).includes(p.id));
    for (const p of info.deleted || []) if (!byId(d, "placements", p.id)) d.placements.push(p);
    Object.assign(it, { done: 0, done_by: null, done_at: null, applied_info: null });
  }
}

// ---------- items ----------

const skuOf = (d, sku) => d.products.find((p) => !p.deleted && low(p.sku) === low(sku));
const nextSort = (d, hid) => Math.max(0, ...itemsOf(d, hid).map((i) => i.sort)) + 1;
const lastOf = (list) => list[list.length - 1];

// Fill layer/location from history.
function autofill(d, pid, layer_id, location_id, action = "add") {
  let filled = false;
  if (!pid) return [layer_id, location_id, filled];
  if (!layer_id) {
    let r = lastOf(d.placements.filter((p) => p.product_id === pid && liveLayer(d, p.layer_id)).sort((a, b) => a.id - b.id));
    if (!r && action === "add") {
      r = lastOf(d.items.filter((i) => i.product_id === pid && i.action === "add" && liveLayer(d, i.layer_id)
        && (byId(d, "handoffs", i.handoff_id) || {}).status !== "draft").sort((a, b) => a.id - b.id));
    }
    if (r) { layer_id = r.layer_id; filled = true; }
  }
  if (!location_id) {
    const r = lastOf(d.items.filter((i) => i.product_id === pid && i.location_id
      && !(byId(d, "locations", i.location_id) || { deleted: 1 }).deleted).sort((a, b) => a.id - b.id));
    if (r) { location_id = r.location_id; filled = true; }
  }
  return [layer_id, location_id, filled];
}

function newItem(hid, rec) {
  return {
    handoff_id: hid, action: "add", product_id: null, sku: "", name: "", qty: 1, location_id: null, layer_id: null,
    to_layer_id: null, note: "", photo: null, auto_filled: 0, done: 0, done_by: null, done_at: null, applied_info: null,
    problem_type: null, problem_note: "", problem_by: null, sort: 0, created_at: stamp(), ...rec,
  };
}
const touch = (h) => { h.updated_at = stamp(); };

function importRows(body, keys) {
  const m = body.mapping || {};
  const col = (r, k) => (m[k] != null && m[k] < r.length ? trim(r[m[k]]) : "");
  const rows = (body.rows || []).slice(0, MAX_ROWS);
  const names = {};
  for (const k of keys) if (m[k] != null && body.headers && body.headers[m[k]]) names[k] = body.headers[m[k]];
  return { m, col, rows, names };
}

// ---------- 90 days ----------

export function purge(d, now = Date.now()) {
  const cut = stamp(new Date(now - RETENTION_DAYS * DAY));
  const old = (r) => (r.updated_at || r.created_at || "") < cut;
  drop(d, "handoffs", (h) => h.created_at < cut);
  const keep = new Set(d.handoffs.map((h) => h.id));
  drop(d, "items", (i) => !keep.has(i.handoff_id));
  drop(d, "placements", old);
  const used = { product_id: new Set(), location_id: new Set(), layer: new Set() };
  for (const i of d.items) {
    used.product_id.add(i.product_id);
    used.location_id.add(i.location_id);
    used.layer.add(i.layer_id).add(i.to_layer_id);
  }
  for (const p of d.placements) { used.product_id.add(p.product_id); used.layer.add(p.layer_id); }
  const usedCabs = new Set(d.layers.filter((l) => used.layer.has(l.id)).map((l) => l.cabinet_id));
  drop(d, "products", (p) => old(p) && !used.product_id.has(p.id));
  drop(d, "locations", (l) => old(l) && !used.location_id.has(l.id));
  drop(d, "cabinets", (c) => old(c) && !usedCabs.has(c.id));
  const cabs = new Set(d.cabinets.map((c) => c.id));
  drop(d, "layers", (l) => !cabs.has(l.cabinet_id));
  drop(d, "staff", old);
}

export function usedImages(d) {
  const s = new Set();
  for (const t of ["products", "cabinets"]) for (const r of d[t]) if (r.image) s.add(r.image);
  for (const i of d.items) if (i.photo) s.add(i.photo);
  for (const h of d.handoffs) {
    if (h.done_photo) s.add(h.done_photo);
    for (const c of Object.values(h.snapshot || {})) if (c.image) s.add(c.image);
  }
  return s;
}

// ---------- routes ----------

const ROUTES = [];
const on = (method, path, fn) => ROUTES.push({
  method, fn, re: new RegExp(`^${path.replace(/:(\w+)/g, "(\\d+)")}$`),
});

on("GET", "/me", (d) => ({
  operator_name: d.settings.operator_name || "", store_name: d.settings.store_name || "", started: !!d.settings.started,
  retention_days: RETENTION_DAYS, storage: storageMode(), operators: d.settings.operators || [],
}));
on("POST", "/operator", (d, { body }) => {
  const name = trim(body.name).slice(0, 30);
  if (!name) fail("請輸入名字");
  d.settings.operator_name = name;
  d.settings.operators = [name, ...(d.settings.operators || []).filter((n) => n !== name)].slice(0, 12);
  return { ok: true };
});
on("POST", "/settings", (d, { body }) => {
  d.settings.store_name = trim(body.store_name).slice(0, 40);
  return { ok: true };
});
on("POST", "/start", (d, { body, extra, img }) => {
  if (body.sample) seed(d, extra, img);
  d.settings.started = 1;
  return { ok: true };
});

// handoffs
on("GET", "/handoffs", (d, { q }) => {
  const done = q.scope === "done";
  return d.handoffs.filter((h) => (h.status === "done") === done)
    .sort((a, b) => cmp(b.handoff_date, a.handoff_date) || b.id - a.id)
    .map((h) => {
      const items = enriched(d, h.id);
      const { snapshot, cabinets, ...rest } = h;
      return {
        ...rest, progress: progress(items), date_label: dateLabel(h.handoff_date), days_left: daysLeft(h.created_at),
        cabinets: [...new Set(items.flatMap((i) => [i.cabinet_code, i.to_cabinet_code]).filter(Boolean))].sort(),
      };
    });
});
on("POST", "/handoffs", (d, { me }) => {
  const t = new Date();
  if (t.getHours() >= 12) t.setDate(t.getDate() + 1);
  return { id: ins(d, "handoffs", {
    uid: newId(), received: 0, handoff_date: dateStr(t), giver_name: me, receiver_name: "", status: "draft", note: "",
    done_photo: null, snapshot: null, created_at: stamp(), updated_at: stamp(), sent_at: null, done_at: null, done_by: null,
  }) };
});
on("GET", "/handoffs/:id", (d, { p }) => detail(d, getHandoff(d, p[0])));
on("PATCH", "/handoffs/:id", (d, { p, body }) => {
  const h = getHandoff(d, p[0], ["draft"], true);
  if ("handoff_date" in body && !parseDay(body.handoff_date)) fail("日期格式錯誤");
  for (const k of ["handoff_date", "giver_name", "receiver_name", "note"]) if (k in body) h[k] = trim(body[k]).slice(0, k === "note" ? 500 : 30);
  touch(h);
  return { ok: true };
});
on("DELETE", "/handoffs/:id", (d, { p }) => {
  getHandoff(d, p[0]);
  drop(d, "handoffs", (h) => h.id === p[0]);
  drop(d, "items", (i) => i.handoff_id === p[0]);
  return { ok: true };
});
on("POST", "/handoffs/:id/import", (d, { p, body }) => {
  const h = getHandoff(d, p[0], ["draft"], true);
  const { m, col, rows, names } = importRows(body, ["sku", "name", "qty"]);
  if (m.sku == null) fail("請指定貨號欄位");
  const agg = new Map();
  for (const r of rows) {
    const sku = col(r, "sku");
    if (!sku) continue;
    const qty = m.qty != null ? parseInt1(col(r, "qty")) : 1;
    const ex = agg.get(low(sku));
    if (ex) ex.qty += qty;
    else agg.set(low(sku), { sku, name: col(r, "name"), qty });
  }
  if (!agg.size) fail("沒有可匯入的資料（貨號欄是空的）");
  const stats = { created: 0, updated: 0, unmatched: 0 };
  let sort = nextSort(d, h.id);
  for (const rec of agg.values()) {
    const pr = skuOf(d, rec.sku);
    const ex = itemsOf(d, h.id).find((i) => i.action === "add"
      && (pr ? i.product_id === pr.id : !i.product_id && low(i.sku) === low(rec.sku)));
    if (ex) { ex.qty = rec.qty; stats.updated++; continue; }
    const [layer_id, location_id, filled] = autofill(d, pr && pr.id, null, null);
    ins(d, "items", newItem(h.id, {
      product_id: pr ? pr.id : null, sku: pr ? pr.sku : rec.sku, name: pr ? pr.name : rec.name, qty: rec.qty,
      layer_id, location_id, auto_filled: filled ? 1 : 0, sort: sort++,
    }));
    stats.created++;
    if (!pr) stats.unmatched++;
  }
  d.settings.mapping_handoff = names;
  touch(h);
  return stats;
});
on("POST", "/handoffs/:id/send", (d, { p, me }) => {
  const h = getHandoff(d, p[0], ["draft"], true);
  const items = enriched(d, h.id);
  const [errors] = validate(h, items);
  if (errors.length) fail(`還不能送出：${errors.slice(0, 5).join("；")}${errors.length > 5 ? "…" : ""}`);
  const snapshot = {};
  for (const c of handoffCabinets(d, h, items)) snapshot[c.id] = c;
  for (const i of itemsOf(d, h.id)) i.auto_filled = 0;
  Object.assign(h, { status: "sent", sent_at: stamp(), snapshot, giver_name: h.giver_name || me });
  touch(h);
  return { ok: true };
});
on("POST", "/handoffs/:id/reopen", (d, { p }) => {
  const h = getHandoff(d, p[0], ["sent"], true);
  if (itemsOf(d, h.id).some((i) => i.done)) fail("已經開始勾選，不能退回草稿");
  Object.assign(h, { status: "draft", sent_at: null, snapshot: null });
  touch(h);
  return { ok: true };
});
on("POST", "/handoffs/:id/complete", (d, { p, me, image, img }) => {
  const h = getHandoff(d, p[0], ["sent"]);
  const left = itemsOf(d, h.id).filter((i) => !i.done && !i.problem_type).length;
  if (left) fail(`還有 ${left} 項沒完成也沒回報問題`);
  if (image) { img.put(image.id, image.buf); h.done_photo = image.id; }
  Object.assign(h, { status: "done", done_at: stamp(), done_by: me });
  touch(h);
  return { ok: true };
});

// items
on("POST", "/handoffs/:id/items", (d, { p, body }) => {
  const h = getHandoff(d, p[0], ["draft"], true);
  const action = body.action || "add";
  if (!ACTIONS[action]) fail("動作不正確");
  const pr = body.product_id ? live(d, "products", body.product_id, "找不到商品") : body.sku ? skuOf(d, trim(body.sku)) : null;
  if (!pr && action !== "add") fail("撤下與移位需要選擇既有商品");
  if (!pr && !trim(body.sku)) fail("請選擇商品或輸入貨號");
  for (const lid of [body.layer_id, body.to_layer_id]) if (lid && !liveLayer(d, lid)) fail("櫃層不存在");
  if (action !== "add" && !body.layer_id) fail("請指定商品目前所在的櫃層");
  const [layer_id, location_id, filled] = autofill(d, pr && pr.id, body.layer_id || null, null, action);
  const id = ins(d, "items", newItem(h.id, {
    action, product_id: pr ? pr.id : null, sku: pr ? pr.sku : trim(body.sku).slice(0, 60), name: pr ? pr.name : trim(body.sku).slice(0, 60),
    qty: Math.max(1, body.qty || 1), layer_id, to_layer_id: body.to_layer_id || null, location_id,
    auto_filled: filled ? 1 : 0, sort: nextSort(d, h.id),
  }));
  touch(h);
  return { id };
});
on("PATCH", "/handoffs/:id/items/:iid", (d, { p, body }) => {
  const h = getHandoff(d, p[0], ["draft"], true);
  const it = getItem(d, p[0], p[1]);
  if ("qty" in body) it.qty = Math.min(1e6, Math.max(1, Math.trunc(body.qty) || 1));
  for (const k of ["layer_id", "to_layer_id"]) {
    if (!(k in body)) continue;
    if (body[k] && !liveLayer(d, body[k])) fail("櫃層不存在");
    it[k] = body[k] || null;
    it.auto_filled = 0;
  }
  if ("location_id" in body) {
    if (body.location_id) live(d, "locations", body.location_id, "倉位不存在");
    it.location_id = body.location_id || null;
    it.auto_filled = 0;
  }
  touch(h);
  return { ok: true };
});
on("DELETE", "/handoffs/:id/items/:iid", (d, { p }) => {
  const h = getHandoff(d, p[0], ["draft"], true);
  getItem(d, p[0], p[1]);
  drop(d, "items", (i) => i.id === p[1]);
  touch(h);
  return { ok: true };
});
on("POST", "/handoffs/:id/items/:iid/resolve", (d, { p, body }) => {
  getHandoff(d, p[0], ["draft"], true);
  const it = getItem(d, p[0], p[1]);
  if (it.product_id) fail("這個項目已對應到商品");
  let pr;
  if (body.product_id) pr = live(d, "products", body.product_id, "找不到商品");
  else {
    const name = trim(body.name || it.name);
    if (!name) fail("請輸入品名");
    pr = skuOf(d, it.sku) || byId(d, "products", addProduct(d, { sku: it.sku, name, short_name: trim(body.short_name) }));
  }
  const [layer_id, location_id, filled] = autofill(d, pr.id, it.layer_id, it.location_id, it.action);
  Object.assign(it, { product_id: pr.id, sku: pr.sku, name: pr.name, layer_id, location_id, auto_filled: filled || it.auto_filled ? 1 : 0 });
  return { product_id: pr.id };
});
on("POST", "/handoffs/:id/items/:iid/photo", (d, { p, image, img }) => {
  getHandoff(d, p[0], ["draft", "sent"]);
  const it = getItem(d, p[0], p[1]);
  if (!image) fail("請選擇照片");
  if (it.photo) img.del(it.photo);
  img.put(image.id, image.buf);
  it.photo = image.id;
  return { photo: image.id };
});
on("POST", "/handoffs/:id/items/:iid/check", (d, { p, body, me }) => {
  getHandoff(d, p[0], ["sent"]);
  setDone(d, getItem(d, p[0], p[1]), !!body.value, me);
  return { ok: true };
});
on("POST", "/handoffs/:id/items/:iid/problem", (d, { p, body, me }) => {
  getHandoff(d, p[0], ["sent"]);
  const it = getItem(d, p[0], p[1]);
  if (body.type && !PROBLEMS[body.type]) fail("問題類型不正確");
  Object.assign(it, { problem_type: body.type || null, problem_note: body.type ? trim(body.note).slice(0, 300) : "",
    problem_by: body.type ? me : null });
  return { ok: true };
});
on("POST", "/handoffs/:id/confirm-auto", (d, { p }) => {
  getHandoff(d, p[0], ["draft"], true);
  for (const i of itemsOf(d, p[0])) i.auto_filled = 0;
  return { ok: true };
});

// ---------- links from other people ----------

const findUid = (d, uid, received) => d.handoffs.find((h) => h.uid === uid && !!h.received === received);

on("POST", "/received/find", (d, { body }) => {
  const own = findUid(d, body.uid, false);
  const got = findUid(d, body.uid, true);
  return { own_id: own ? own.id : null, received_id: got ? got.id : null,
    changed: !!got && got.sent_at !== body.sent_at, status: got ? got.status : null };
});
on("POST", "/received", (d, { body: b }) => {
  const head = { handoff_date: b.handoff_date, giver_name: b.giver_name, receiver_name: b.receiver_name, note: b.note,
    sent_at: b.sent_at, cabinets: b.cabinets };
  let h = findUid(d, b.uid, true);
  const old = h ? itemsOf(d, h.id) : [];
  if (h) {
    Object.assign(h, head, { status: "sent", done_at: null, done_by: null });
    touch(h);
    drop(d, "items", (i) => i.handoff_id === h.id);
  } else {
    h = byId(d, "handoffs", ins(d, "handoffs", { uid: b.uid, received: 1, status: "sent", done_photo: null, snapshot: null,
      created_at: stamp(), updated_at: stamp(), done_at: null, done_by: null, ...head }));
  }
  b.items.forEach((x, n) => {
    const o = old.find((i) => i.key === x.key && i.action === x.action) || {}; // keep ticks when the giver sent a newer version
    ins(d, "items", newItem(h.id, {
      key: x.key, action: x.action, sku: x.sku, name: x.ext.display, qty: x.qty, ext: x.ext, sort: n + 1,
      done: o.done || 0, done_by: o.done_by || null, done_at: o.done_at || null, photo: o.photo || null,
      problem_type: o.problem_type || null, problem_note: o.problem_note || "", problem_by: o.problem_by || null,
    }));
  });
  return { id: h.id };
});
on("POST", "/report/find", (d, { body }) => {
  const h = findUid(d, body.uid, false);
  if (!h) return { id: null };
  return { id: h.id, status: h.status, date_label: dateLabel(h.handoff_date),
    items: enriched(d, h.id).map((i) => ({ key: i.id, display: i.display, label: i.label, done: i.done })) };
});
on("POST", "/report", (d, { body: b }) => {
  const h = findUid(d, b.uid, false);
  if (!h) fail("這台裝置沒有這張交接單");
  if (h.status === "draft") fail("這張交接單已退回草稿，不能套用回報");
  const items = itemsOf(d, h.id);
  let n = 0;
  for (const r of b.items) {
    const it = items.find((i) => i.id === r.key);
    if (!it) continue;
    n++;
    if (r.done) setDone(d, it, true, b.by, b.at || stamp());
    Object.assign(it, { problem_type: r.problem_type || null, problem_note: r.problem_note, problem_by: r.problem_type ? b.by : null });
  }
  if (b.complete && h.status === "sent" && items.every((i) => i.done || i.problem_type)) {
    Object.assign(h, { status: "done", done_at: b.at || stamp(), done_by: b.by });
  }
  touch(h);
  return { id: h.id, applied: n };
});

// ---------- staff (names to choose as receiver) ----------

const sameName = (d, name, not = 0) => d.staff.some((s) => s.active && s.name === name && s.id !== not);

on("GET", "/staff", (d) => [...d.staff].sort((a, b) => b.active - a.active || a.id - b.id));
on("POST", "/staff", (d, { body }) => {
  const name = trim(body.name).slice(0, 30);
  if (!name) fail("請輸入姓名");
  if (sameName(d, name)) fail("名單中已有此姓名");
  return { id: ins(d, "staff", { name, active: 1, created_at: stamp(), updated_at: stamp() }) };
});
on("PATCH", "/staff/:id", (d, { p, body }) => {
  const s = byId(d, "staff", p[0]) || fail("找不到人員");
  const name = "name" in body ? trim(body.name).slice(0, 30) : s.name;
  const active = "active" in body ? (body.active ? 1 : 0) : s.active;
  if (!name) fail("請輸入姓名");
  if (active && sameName(d, name, s.id)) fail("名單中已有此姓名");
  Object.assign(s, { name, active, updated_at: stamp() });
  return { ok: true };
});

// ---------- products ----------

export function addProduct(d, r) {
  return ins(d, "products", { sku: "", name: "", short_name: "", image: null, width: null, depth: null, height: null,
    weight: null, deleted: 0, created_at: stamp(), updated_at: stamp(), ...r });
}
const size = (v) => (Number.isFinite(v) ? v : null);

on("GET", "/products", (d, { q }) => {
  const term = low(trim(q.q));
  const all = d.products.filter((p) => !p.deleted);
  const hit = term ? all.filter((p) => [p.sku, p.name, p.short_name].some((v) => low(v).includes(term))) : all;
  return { items: hit.sort((a, b) => cmp(a.sku, b.sku)).slice(0, +q.limit || 300), total: all.length };
});
on("GET", "/products/:id", (d, { p }) => ({
  ...live(d, "products", p[0], "找不到商品"),
  places: d.placements.filter((x) => x.product_id === p[0]).map((x) => liveLayer(d, x.layer_id)).filter(Boolean)
    .map((x) => `${x.cab.code}-${x.layer.code}`),
}));
function productFields(d, body, id = 0) {
  const r = { sku: trim(body.sku).slice(0, 60), name: trim(body.name).slice(0, 120), short_name: trim(body.short_name).slice(0, 30) };
  for (const k of ["width", "depth", "height", "weight"]) r[k] = size(body[k]);
  if (!r.sku || !r.name) fail("貨號與品名都要填");
  const same = skuOf(d, r.sku);
  if (same && same.id !== id) fail(`貨號 ${r.sku} 已存在`);
  return r;
}
on("POST", "/products", (d, { body }) => ({ id: addProduct(d, productFields(d, body)) }));
on("PATCH", "/products/:id", (d, { p, body }) => {
  const pr = live(d, "products", p[0], "找不到商品");
  Object.assign(pr, productFields(d, { ...pr, ...body }, pr.id), { updated_at: stamp() });
  return { ok: true };
});
on("DELETE", "/products/:id", (d, { p }) => {
  Object.assign(live(d, "products", p[0], "找不到商品"), { deleted: 1, updated_at: stamp() });
  drop(d, "placements", (x) => x.product_id === p[0]);
  return { ok: true };
});
on("POST", "/products/:id/image", (d, { p, image, img }) => {
  const pr = live(d, "products", p[0], "找不到商品");
  if (!image) fail("請選擇照片");
  if (pr.image) img.del(pr.image);
  img.put(image.id, image.buf);
  Object.assign(pr, { image: image.id, updated_at: stamp() });
  return { image: image.id };
});
on("POST", "/products/import", (d, { body }) => {
  const { m, col, rows, names } = importRows(body, ["sku", "name", "short_name", "width", "depth", "height", "weight"]);
  if (m.sku == null || m.name == null) fail("請指定貨號與品名欄位");
  const out = { created: 0, updated: 0, skipped: 0 };
  const map = new Map(d.products.filter((x) => !x.deleted).map((x) => [low(x.sku), x]));
  for (const r of rows) {
    const sku = col(r, "sku").slice(0, 60);
    const rec = { name: col(r, "name").slice(0, 120) };
    if (!sku || !rec.name) { out.skipped++; continue; }
    if (m.short_name != null) rec.short_name = col(r, "short_name").slice(0, 30);
    for (const k of ["width", "depth", "height", "weight"]) if (m[k] != null) rec[k] = parseNum(col(r, k));
    const ex = map.get(low(sku));
    if (!ex) {
      map.set(low(sku), byId(d, "products", addProduct(d, { sku, ...rec })));
      out.created++;
    } else if (Object.entries(rec).every(([k, v]) => ex[k] === v)) out.skipped++;
    else { Object.assign(ex, rec, { updated_at: stamp() }); out.updated++; }
  }
  d.settings.mapping_product = names;
  return out;
});

// ---------- warehouse locations ----------

const locTaken = (d, code, not = 0) => d.locations.some((l) => !l.deleted && low(l.code) === low(code) && l.id !== not);
export const addLocation = (d, code, description) => ins(d, "locations", {
  code, description, sort: 0, deleted: 0, created_at: stamp(), updated_at: stamp() });

on("GET", "/locations", (d) => d.locations.filter((l) => !l.deleted).sort((a, b) => cmp(a.code, b.code)));
on("POST", "/locations", (d, { body }) => {
  const code = trim(body.code).slice(0, 40);
  if (!code) fail("請輸入倉位代碼");
  if (locTaken(d, code)) fail(`倉位 ${code} 已存在`);
  return { id: addLocation(d, code, trim(body.description).slice(0, 80)) };
});
on("POST", "/locations/bulk", (d, { body }) => {
  let created = 0;
  let skipped = 0;
  for (const line of String(body.text || "").split(/\r?\n/).map(trim).filter(Boolean).slice(0, MAX_ROWS)) {
    const m = /^([^,，\s]+)[,，\s]*(.*)$/.exec(line);
    if (!m || locTaken(d, m[1])) { skipped++; continue; }
    addLocation(d, m[1].slice(0, 40), trim(m[2]).slice(0, 80));
    created++;
  }
  return { created, skipped };
});
on("PATCH", "/locations/:id", (d, { p, body }) => {
  const l = live(d, "locations", p[0], "找不到倉位");
  const code = trim(body.code).slice(0, 40);
  if (!code || locTaken(d, code, l.id)) fail("倉位代碼空白或已存在");
  Object.assign(l, { code, description: trim(body.description).slice(0, 80), updated_at: stamp() });
  return { ok: true };
});
on("DELETE", "/locations/:id", (d, { p }) => {
  Object.assign(live(d, "locations", p[0], "找不到倉位"), { deleted: 1, updated_at: stamp() });
  return { ok: true };
});

// ---------- cabinets ----------

const cabTaken = (d, code, not = 0) => d.cabinets.some((c) => !c.deleted && low(c.code) === low(code) && c.id !== not);
export const addCabinet = (d, r) => ins(d, "cabinets", {
  code: "", name: "", image: null, img_w: null, img_h: null, deleted: 0, created_at: stamp(), updated_at: stamp(), ...r });
const getCab = (d, id) => live(d, "cabinets", id, "找不到櫃體");
const clamp = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);

export function saveLayers(d, cid, layers) {
  const have = d.layers.filter((l) => l.cabinet_id === cid && !l.deleted);
  const keep = new Set();
  layers.forEach((l, sort) => {
    const rec = { code: trim(l.code).slice(0, 10), x: clamp(l.x), y: clamp(l.y), w: clamp(l.w), h: clamp(l.h), sort };
    const ex = have.find((x) => x.id === l.id);
    if (ex) { Object.assign(ex, rec); keep.add(ex.id); }
    else keep.add(ins(d, "layers", { cabinet_id: cid, deleted: 0, ...rec }));
  });
  for (const l of have) {
    if (keep.has(l.id)) continue;
    l.deleted = 1;
    drop(d, "placements", (p) => p.layer_id === l.id);
  }
}

on("GET", "/cabinets", (d) => d.cabinets.filter((c) => !c.deleted).sort((a, b) => cmp(a.code, b.code)).map((c) => cabinetFull(d, c.id)));
on("GET", "/cabinets/:id", (d, { p }) => { getCab(d, p[0]); return cabinetFull(d, p[0]); });
function cabFields(d, body, id = 0) {
  const code = trim(body.code).toUpperCase().slice(0, 30);
  if (!code) fail("請輸入櫃號");
  if (cabTaken(d, code, id)) fail(`櫃號 ${code} 已存在`);
  return { code, name: trim(body.name).slice(0, 60) };
}
on("POST", "/cabinets", (d, { body }) => ({ id: addCabinet(d, cabFields(d, body)) }));
on("PATCH", "/cabinets/:id", (d, { p, body }) => {
  const c = getCab(d, p[0]);
  Object.assign(c, cabFields(d, { ...c, ...body }, c.id), { updated_at: stamp() });
  return { ok: true };
});
on("DELETE", "/cabinets/:id", (d, { p }) => {
  Object.assign(getCab(d, p[0]), { deleted: 1, updated_at: stamp() });
  return { ok: true };
});
on("POST", "/cabinets/:id/image", (d, { p, image, img }) => {
  const c = getCab(d, p[0]);
  if (!image) fail("請選擇照片");
  img.put(image.id, image.buf); // the old photo may still belong to a sent handoff; unused ones are cleaned at start
  Object.assign(c, { image: image.id, img_w: image.w, img_h: image.h, updated_at: stamp() });
  return { image: image.id };
});
on("PUT", "/cabinets/:id/layers", (d, { p, body }) => {
  const c = getCab(d, p[0]);
  const codes = body.layers.map((l) => trim(l.code));
  if (codes.some((x) => !x)) fail("層編號不可空白");
  if (new Set(codes).size !== codes.length) fail("層編號不可重複");
  if (codes.length > 80) fail("層板太多");
  saveLayers(d, c.id, body.layers);
  c.updated_at = stamp();
  return cabinetFull(d, c.id);
});
on("POST", "/cabinets/:id/placements", (d, { p, body }) => {
  const x = liveLayer(d, body.layer_id);
  if (!x || x.cab.id !== p[0]) fail("層不存在");
  live(d, "products", body.product_id, "找不到商品");
  if (d.placements.some((r) => r.layer_id === body.layer_id && r.product_id === body.product_id)) fail("此層已有這項商品");
  ins(d, "placements", { layer_id: body.layer_id, product_id: body.product_id, qty: 1, updated_at: stamp() });
  return { ok: true };
});
on("DELETE", "/placements/:id", (d, { p }) => { drop(d, "placements", (x) => x.id === p[0]); return { ok: true }; });

// ---------- everything on this device ----------

on("POST", "/clear", (d, { img, extra }) => {
  const { operator_name, operators, store_name } = d.settings;
  for (const id of extra) img.del(id);
  for (const t of ["staff", "products", "locations", "cabinets", "layers", "placements", "handoffs", "items"]) d[t] = [];
  d.settings = { operator_name, operators, store_name, started: 1 };
  return { ok: true };
});
on("POST", "/restore", (d, ctx) => restoreAll(d, ctx));
on("POST", "/merge", (d, ctx) => mergeMaster(d, ctx));

// ---------- entry point ----------

const MAX_SIDE = [[/^\/products\/\d+\/image$/, 600], [/./, 1400]];

export async function handle(path, { method = "GET", body = {}, file = null } = {}) {
  const [pathname, query = ""] = path.split("?");
  if (method === "POST" && pathname === "/import/parse") {
    const parsed = await parseFile(file);
    const saved = await tx(false, (d) => ({ handoff: d.settings.mapping_handoff, product: d.settings.mapping_product }));
    return { ...parsed, saved: JSON.parse(JSON.stringify(saved)) };
  }
  if (method === "GET" && pathname === "/backup") return exportBackup(query === "master");
  const rep = /^\/handoffs\/(\d+)\/report$/.exec(pathname);
  if (rep) {
    const x = await tx(false, (d) => ({ h: detail(d, getHandoff(d, +rep[1], ["sent", "done"])), me: d.settings.operator_name }));
    return withReport(x.h, x.me);
  }
  const route = ROUTES.find((r) => r.method === method && r.re.test(pathname));
  if (!route) fail(`不支援的操作 ${method} ${pathname}`);
  const p = route.re.exec(pathname).slice(1).map(Number);
  const q = Object.fromEntries(query.split("&").filter(Boolean).map((s) => {
    const [k, v = ""] = s.split("=");
    return [k, decodeURIComponent(v)];
  }));
  let image = null;
  let extra = null;
  if (file && /\/(image|photo|complete)$/.test(pathname)) {
    image = await encodeImage(file, MAX_SIDE.find(([re]) => re.test(pathname))[1]);
    image.id = newId(16);
  }
  if (pathname === "/start" && body.sample) extra = await sampleImage();
  if (pathname === "/restore" || pathname === "/merge") extra = await readBackup(file);
  if (pathname === "/clear" || pathname === "/restore") {
    const ids = await imageIds();
    extra = pathname === "/clear" ? ids : { ...extra, oldImages: ids };
  }
  const write = method !== "GET" && !pathname.endsWith("/find");
  const out = await tx(write, (d, img) => route.fn(d, { p, q, body, me: d.settings.operator_name || "", image, img, extra }));
  if (write) askPersist();
  if (method === "GET" && /^\/handoffs\/\d+$/.test(pathname)) return withLink(JSON.parse(JSON.stringify(out)));
  // A copy, so a view can never change stored data by accident.
  return JSON.parse(JSON.stringify(out));
}

async function sampleImage() {
  const image = await drawSample();
  return { ...image, id: newId(16) };
}

// Runs once when the page opens: drop what is past 90 days and photos nothing uses, then make photo links.
export async function boot() {
  const ids = await imageIds().catch(() => []);
  await tx(true, (d, img) => {
    purge(d);
    const used = usedImages(d);
    for (const id of ids) if (!used.has(id)) img.del(id);
  });
  await loadImages();
}

export { ApiError };
