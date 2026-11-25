// Put a whole handoff (or a result report) inside a link. The part after # is never sent to any server.
import { ApiError } from "./store.js";

const ACTS = ["add", "remove", "move"];
const PROBS = ["", "no_space", "out_of_stock", "wrong_item", "other"];
const MAX_TEXT = 300000;
const BAD = () => new ApiError("link", "這個連結不完整或已損壞，請對方重新傳一次");

function toB64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64(s) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function pump(bytes, stream, max) {
  const w = stream.writable.getWriter();
  w.write(bytes).catch(() => {});
  w.close().catch(() => {});
  const r = stream.readable.getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await r.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      r.cancel().catch(() => {});
      throw BAD();
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

export async function pack(obj) {
  const raw = new TextEncoder().encode(JSON.stringify(obj));
  if (typeof CompressionStream !== "undefined") {
    try {
      return "1" + toB64(await pump(raw, new CompressionStream("deflate-raw"), Infinity));
    } catch { /* older browser: send it uncompressed */ }
  }
  return "0" + toB64(raw);
}

export async function unpack(code) {
  try {
    let bytes = fromB64(code.slice(1));
    if (code[0] === "1") {
      if (typeof DecompressionStream === "undefined") {
        throw new ApiError("link", "這個瀏覽器太舊，打不開交接連結，請更新後再試");
      }
      bytes = await pump(bytes, new DecompressionStream("deflate-raw"), MAX_TEXT);
    } else if (code[0] !== "0" || bytes.length > MAX_TEXT) throw BAD();
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (e) {
    throw e instanceof ApiError ? e : BAD();
  }
}

// openExternalBrowser=1: LINE then opens the phone's own browser instead of its built-in one.
export const linkFor = (kind, code) =>
  `${location.origin}${location.pathname.replace(/index\.html$/, "")}?openExternalBrowser=1#/${kind}/${code}`;

// ---------- handoff ----------

const r3 = (n) => Math.round(n * 1000) / 1000;

export function handoffPayload(h) {
  const cabs = h.cabinets;
  const pos = (cid, lid) => {
    const c = cabs.findIndex((x) => x.id === cid);
    return c < 0 ? [-1, -1] : [c, cabs[c].layers.findIndex((l) => l.id === lid)];
  };
  return {
    v: 1, u: h.uid, d: h.handoff_date, g: h.giver_name, r: h.receiver_name, n: h.note, s: h.sent_at,
    c: cabs.map((c) => [c.code, c.name, c.img_w || 0, c.img_h || 0,
      c.layers.map((l) => [l.code, r3(l.x), r3(l.y), r3(l.w), r3(l.h)])]),
    i: h.items.map((i) => [i.id, ACTS.indexOf(i.action), i.sku, i.display, i.qty,
      ...pos(i.cabinet_id, i.layer_id), ...pos(i.to_cabinet_id, i.to_layer_id), i.location_code || ""]),
  };
}

const str = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
const int = (v, a, b, def) => (Number.isInteger(v) && v >= a && v <= b ? v : def);
const frac = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
const arr = (v, n) => (Array.isArray(v) ? v.slice(0, n) : []);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

// Links come from other people, so every value is checked and rebuilt, never used as is.
export function readHandoff(p) {
  if (!p || typeof p !== "object" || p.v !== 1 || !/^[a-z0-9]{6,20}$/.test(p.u || "") || !DATE.test(p.d || "")) throw BAD();
  const cabinets = arr(p.c, 40).map((c, ci) => {
    const code = str(c && c[0], 30);
    return {
      id: ci + 1, code, name: str(c && c[1], 60), image: null,
      img_w: int(c && c[2], 1, 20000, null), img_h: int(c && c[3], 1, 20000, null), schematic: true,
      layers: arr(c && c[4], 80).map((l, li) => ({
        id: (ci + 1) * 1000 + li + 1, code: str(l && l[0], 10), label: `${code}-${str(l && l[0], 10)}`,
        x: frac(l && l[1]), y: frac(l && l[2]), w: frac(l && l[3]), h: frac(l && l[4]),
      })),
    };
  });
  const at = (ci, li) => {
    const c = cabinets[int(ci, 0, 1e6, -1)];
    const l = c && c.layers[int(li, 0, 1e6, -1)];
    return l ? [c, l] : [null, null];
  };
  const items = arr(p.i, 500).filter(Array.isArray).map((i) => {
    const [c1, l1] = at(i[5], i[6]);
    const [c2, l2] = at(i[7], i[8]);
    return {
      key: int(i[0], 1, 1e9, 0), action: ACTS[int(i[1], 0, 2, 0)], sku: str(i[2], 60), qty: int(i[4], 1, 1e6, 1),
      ext: {
        display: str(i[3], 120) || str(i[2], 60), location_code: str(i[9], 40) || null,
        cabinet_id: c1 && c1.id, cabinet_code: c1 && c1.code, layer_id: l1 && l1.id, layer_code: l1 && l1.code,
        label: l1 ? l1.label : "", to_cabinet_id: c2 && c2.id, to_cabinet_code: c2 && c2.code,
        to_layer_id: l2 && l2.id, to_layer_code: l2 && l2.code, to_label: l2 ? l2.label : "",
      },
    };
  });
  if (!items.length) throw BAD();
  return {
    uid: p.u, handoff_date: p.d, giver_name: str(p.g, 30), receiver_name: str(p.r, 30), note: str(p.n, 500),
    sent_at: STAMP.test(p.s || "") ? p.s : null, cabinets, items,
  };
}

// ---------- result report ----------

export function reportPayload(h, by, at) {
  return {
    v: 1, u: h.uid, b: by, t: at, c: h.status === "done" ? 1 : 0,
    i: h.items.filter((i) => i.key && (i.done || i.problem_type))
      .map((i) => [i.key, i.done ? 1 : 0, Math.max(0, PROBS.indexOf(i.problem_type || "")), i.problem_note || ""]),
  };
}

export function readReport(p) {
  if (!p || typeof p !== "object" || p.v !== 1 || !/^[a-z0-9]{6,20}$/.test(p.u || "")) throw BAD();
  return {
    uid: p.u, by: str(p.b, 30), at: STAMP.test(p.t || "") ? p.t : null, complete: p.c === 1,
    items: arr(p.i, 500).filter(Array.isArray).map((i) => ({
      key: int(i[0], 1, 1e9, 0), done: i[1] === 1, problem_type: PROBS[int(i[2], 0, 4, 0)], problem_note: str(i[3], 300),
    })),
  };
}
