// Backup file: everything on this device (with photos), or only the basic data to hand to a partner.
import { tx, imageData, blank, fail, ApiError, newId } from "./store.js";
import { ins, byId, stamp, addProduct, addLocation, addCabinet, saveLayers, usedImages, purge } from "./local.js";

const APP = "shelfrelay-web";
const MAX_FILE = 300 * 1024 * 1024;

// ---------- write ----------

function b64(buf) {
  const a = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < a.length; i += 8192) s += String.fromCharCode(...a.subarray(i, i + 8192));
  return btoa(s);
}
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)).buffer;

export async function exportBackup(masterOnly) {
  const data = await tx(false, (d) => JSON.parse(JSON.stringify(d)));
  if (masterOnly) {
    data.handoffs = [];
    data.items = [];
    data.settings = {};
    for (const t of ["products", "locations", "cabinets", "layers"]) data[t] = data[t].filter((r) => !r.deleted);
    data.staff = data.staff.filter((s) => s.active);
  }
  const images = {};
  for (const id of usedImages(data)) {
    const buf = await imageData(id);
    if (buf) images[id] = b64(buf);
  }
  return JSON.stringify({ app: APP, version: 1, kind: masterOnly ? "master" : "full", exported_at: stamp(), data, images });
}

// ---------- read: a file may come from anyone, so each value is checked and rebuilt ----------

const S = (max, def = "") => (v) => (typeof v === "string" ? v.slice(0, max) : def);
const N = (min, max, def = null) => (v) => (Number.isFinite(v) && v >= min && v <= max ? v : def);
const I = (def = null) => (v) => (Number.isInteger(v) && v > 0 && v < 1e9 ? v : def);
const B = (v) => (v ? 1 : 0);
const T = (v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(v) ? v : null);
const D = (v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : "2000-01-01");
const ONE = (...list) => (v) => (list.includes(v) ? v : list[0]);
const IMG = (v) => (typeof v === "string" && /^[a-z0-9]{6,40}$/.test(v) ? v : null);
const LIST = (shape, max) => (v) => (Array.isArray(v) ? v.slice(0, max).filter((x) => x && typeof x === "object").map((x) => rec(shape, x)) : []);
const rec = (shape, v) => Object.fromEntries(Object.entries(shape).map(([k, f]) => [k, f(v[k])]));
const dates = { created_at: T, updated_at: T };
const pos = N(0, 1, 0);

const CAB = { id: I(0), code: S(30), name: S(60), image: IMG, img_w: N(1, 20000), img_h: N(1, 20000), schematic: (v) => v === true,
  layers: LIST({ id: I(0), code: S(10), label: S(50), x: pos, y: pos, w: pos, h: pos }, 80) };
const EXT = { display: S(120), location_code: S(40, null), cabinet_id: I(), cabinet_code: S(30, null), layer_id: I(),
  layer_code: S(10, null), label: S(50), to_cabinet_id: I(), to_cabinet_code: S(30, null), to_layer_id: I(),
  to_layer_code: S(10, null), to_label: S(50) };
const PLACE = { id: I(0), layer_id: I(0), product_id: I(0), qty: N(1, 1e6, 1), updated_at: T };

const TABLES = {
  staff: { id: I(0), name: S(30), active: B, ...dates },
  products: { id: I(0), sku: S(60), name: S(120), short_name: S(30), image: IMG, width: N(-1e6, 1e6), depth: N(-1e6, 1e6),
    height: N(-1e6, 1e6), weight: N(-1e6, 1e6), deleted: B, ...dates },
  locations: { id: I(0), code: S(40), description: S(80), sort: N(0, 1e6, 0), deleted: B, ...dates },
  cabinets: { id: I(0), code: S(30), name: S(60), image: IMG, img_w: N(1, 20000), img_h: N(1, 20000), deleted: B, ...dates },
  layers: { id: I(0), cabinet_id: I(0), code: S(10), x: pos, y: pos, w: pos, h: pos, sort: N(0, 1e6, 0), deleted: B },
  placements: PLACE,
  handoffs: { id: I(0), uid: (v) => (typeof v === "string" && /^[a-z0-9]{6,20}$/.test(v) ? v : newId()), received: B, handoff_date: D,
    giver_name: S(30), receiver_name: S(30), status: ONE("draft", "sent", "done"), note: S(500), done_photo: IMG,
    cabinets: (v) => LIST(CAB, 40)(v),
    snapshot: (v) => (v && typeof v === "object" ? Object.fromEntries(LIST(CAB, 40)(Object.values(v)).map((c) => [c.id, c])) : null),
    sent_at: T, done_at: T, done_by: S(30, null), ...dates },
  items: { id: I(0), handoff_id: I(0), key: I(), action: ONE("add", "remove", "move"), product_id: I(), sku: S(60), name: S(120),
    qty: N(1, 1e6, 1), location_id: I(), layer_id: I(), to_layer_id: I(), note: S(300), photo: IMG, auto_filled: B, done: B,
    done_by: S(30, null), done_at: T, problem_type: ONE(null, "no_space", "out_of_stock", "wrong_item", "other"),
    problem_note: S(300), problem_by: S(30, null), sort: N(0, 1e6, 0), created_at: T,
    ext: (v) => (v && typeof v === "object" ? rec(EXT, v) : undefined),
    applied_info: (v) => (v && typeof v === "object"
      ? { created: (Array.isArray(v.created) ? v.created : []).map(I(0)), deleted: LIST(PLACE, 500)(v.deleted) } : null) },
};

const isJpeg = (buf) => {
  const a = new Uint8Array(buf);
  return a[0] === 0xff && a[1] === 0xd8 && a[2] === 0xff;
};

export async function readBackup(file) {
  try {
    if (file.size > MAX_FILE) fail("備份檔過大");
    const j = JSON.parse(await file.text());
    if (j.app !== APP || j.version !== 1 || !j.data || typeof j.data !== "object") fail("這不是 ShelfRelay 的備份檔");
    const data = blank();
    let top = 0;
    const now = stamp();
    for (const [t, shape] of Object.entries(TABLES)) {
      const seen = new Set();
      data[t] = LIST(shape, 20000)(j.data[t]).filter((r) => r.id && !seen.has(r.id) && seen.add(r.id));
      for (const r of data[t]) {
        top = Math.max(top, r.id);
        if ("created_at" in r && !r.created_at) r.created_at = now;
        if ("updated_at" in r && !r.updated_at) r.updated_at = now;
      }
    }
    for (const i of data.items) {
      if (!i.ext) delete i.ext;
      for (const p of (i.applied_info && i.applied_info.deleted) || []) top = Math.max(top, p.id);
    }
    data.next = top + 1;
    const s = j.data.settings || {};
    data.settings = { operator_name: S(30)(s.operator_name), store_name: S(40)(s.store_name), started: 1,
      operators: (Array.isArray(s.operators) ? s.operators : []).map(S(30)).filter(Boolean).slice(0, 12) };
    const images = new Map();
    for (const id of usedImages(data)) {
      const raw = j.images && j.images[id];
      if (typeof raw !== "string") continue;
      const buf = unb64(raw);
      if (isJpeg(buf)) images.set(id, buf);
    }
    const fix = (r, k) => { if (r[k] && !images.has(r[k])) r[k] = null; };
    for (const r of [...data.products, ...data.cabinets]) fix(r, "image");
    for (const i of data.items) fix(i, "photo");
    for (const h of data.handoffs) {
      fix(h, "done_photo");
      for (const c of Object.values(h.snapshot || {})) fix(c, "image");
    }
    return { kind: j.kind === "master" ? "master" : "full", data, images };
  } catch (e) {
    throw e instanceof ApiError ? e : new ApiError("bad", "無法讀取備份檔，檔案可能不完整");
  }
}

// ---------- apply ----------

export function restoreAll(d, { extra, img }) {
  if (extra.kind !== "full") fail("這是「基本資料」檔，請用「加入基本資料」");
  for (const id of extra.oldImages) if (!extra.images.has(id)) img.del(id);
  for (const [id, buf] of extra.images) img.put(id, buf);
  const name = d.settings.operator_name;
  for (const k of Object.keys(d)) delete d[k];
  Object.assign(d, extra.data);
  d.settings.operator_name ||= name || "";
  purge(d);
  return { handoffs: d.handoffs.length, products: d.products.filter((p) => !p.deleted).length };
}

// Add another person's basic data: same SKU / location / cabinet code is updated, nothing else is touched.
export function mergeMaster(d, { extra, img }) {
  const src = extra.data;
  const same = (a, b) => a.toLowerCase() === b.toLowerCase();
  const out = { products: 0, locations: 0, cabinets: 0, staff: 0 };
  const pmap = new Map();
  const photo = (id) => {
    if (!id) return null;
    const nid = newId(16);
    img.put(nid, extra.images.get(id));
    return nid;
  };
  for (const p of src.products) {
    if (p.deleted || !p.sku || !p.name) continue;
    const { id, image, deleted, created_at, updated_at, ...rest } = p;
    let ex = d.products.find((x) => !x.deleted && same(x.sku, p.sku));
    if (ex) Object.assign(ex, rest, { updated_at: stamp() });
    else ex = byId(d, "products", addProduct(d, rest));
    const pic = photo(image);
    if (pic) ex.image = pic;
    pmap.set(id, ex.id);
    out.products++;
  }
  for (const l of src.locations) {
    if (l.deleted || !l.code) continue;
    const ex = d.locations.find((x) => !x.deleted && same(x.code, l.code));
    if (ex) Object.assign(ex, { description: l.description, updated_at: stamp() });
    else addLocation(d, l.code, l.description);
    out.locations++;
  }
  for (const c of src.cabinets) {
    if (c.deleted || !c.code) continue;
    let ex = d.cabinets.find((x) => !x.deleted && same(x.code, c.code));
    if (!ex) ex = byId(d, "cabinets", addCabinet(d, { code: c.code }));
    const pic = photo(c.image);
    Object.assign(ex, { name: c.name, updated_at: stamp() }, pic ? { image: pic, img_w: c.img_w, img_h: c.img_h } : {});
    const mine = d.layers.filter((l) => l.cabinet_id === ex.id && !l.deleted);
    const layers = src.layers.filter((l) => l.cabinet_id === c.id && !l.deleted && l.code).sort((a, b) => a.sort - b.sort);
    saveLayers(d, ex.id, layers.map((l) => ({ ...l, id: (mine.find((m) => m.code === l.code) || {}).id })));
    for (const l of layers) {
      const to = d.layers.find((m) => m.cabinet_id === ex.id && !m.deleted && m.code === l.code);
      for (const p of src.placements) {
        const pid = p.layer_id === l.id && pmap.get(p.product_id);
        if (pid && !d.placements.some((x) => x.layer_id === to.id && x.product_id === pid)) {
          ins(d, "placements", { layer_id: to.id, product_id: pid, qty: p.qty, updated_at: stamp() });
        }
      }
    }
    out.cabinets++;
  }
  for (const s of src.staff) {
    if (!s.active || !s.name || d.staff.some((x) => x.active && x.name === s.name)) continue;
    ins(d, "staff", { name: s.name, active: 1, created_at: stamp(), updated_at: stamp() });
    out.staff++;
  }
  d.settings.started = 1;
  return out;
}
