// Everything is kept in this browser only (IndexedDB). Nothing is sent anywhere.
// Each change runs inside one transaction: read -> change -> write, so two open tabs cannot overwrite each other.

export class ApiError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
export const fail = (message, code = "bad") => { throw new ApiError(code, message); };

const DB_NAME = "shelfrelay-web";
let idb = null;
let mode = ""; // "" until opened, then "idb" or "memory"
const mem = { data: null, images: new Map() };
const urls = new Map(); // image id -> object URL

export const blank = () => ({
  v: 1, next: 1, staff: [], products: [], locations: [], cabinets: [], layers: [], placements: [],
  handoffs: [], items: [], settings: {},
});

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    const timer = setTimeout(() => reject(new Error("timeout")), 6000);
    req.onupgradeneeded = () => {
      req.result.createObjectStore("kv");
      req.result.createObjectStore("images");
    };
    req.onerror = () => { clearTimeout(timer); reject(req.error); };
    req.onsuccess = () => {
      clearTimeout(timer);
      const db = req.result;
      db.onversionchange = () => { db.close(); idb = null; };
      db.onclose = () => { idb = null; };
      resolve(db);
    };
  });
}

async function ready() {
  if (mode === "memory") return;
  if (mode === "idb" && idb) return;
  try {
    idb = await openDb();
    mode = "idb";
  } catch (e) {
    // Once real data was in use, never continue on an empty in-memory copy.
    if (mode === "idb") throw new ApiError("storage", "暫時讀不到這台裝置的資料，請重新整理頁面");
    mode = "memory";
  }
}

export const storageMode = () => mode;

// fn(data, img) must be synchronous. img.put(id, ArrayBuffer), img.del(id).
export async function tx(write, fn) {
  await ready();
  const ops = [];
  const img = { put: (id, buf) => ops.push([id, buf]), del: (id) => ops.push([id, null]) };
  if (mode === "memory") {
    const data = mem.data ? JSON.parse(mem.data) : blank();
    const out = fn(data, img);
    if (write) {
      mem.data = JSON.stringify(data);
      for (const [id, buf] of ops) buf ? mem.images.set(id, buf) : mem.images.delete(id);
      syncUrls(ops);
    }
    return out;
  }
  let t;
  try {
    t = idb.transaction(["kv", "images"], write ? "readwrite" : "readonly");
  } catch (e) { // the browser closed the connection while the page was in the background
    idb = null;
    await ready();
    t = idb.transaction(["kv", "images"], write ? "readwrite" : "readonly");
  }
  const out = await new Promise((resolve, reject) => {
    let result;
    let failed = null;
    const kv = t.objectStore("kv");
    const get = kv.get("data");
    get.onsuccess = () => {
      try {
        const data = get.result || blank();
        result = fn(data, img);
        if (!write) return;
        kv.put(data, "data");
        const store = t.objectStore("images");
        for (const [id, buf] of ops) buf ? store.put(buf, id) : store.delete(id);
      } catch (e) {
        failed = e;
        try { t.abort(); } catch { /* already finished */ }
      }
    };
    t.oncomplete = () => resolve(result);
    t.onabort = () => {
      const full = t.error && t.error.name === "QuotaExceededError";
      reject(failed || new ApiError("storage", full
        ? "這台裝置的儲存空間不足，請刪除舊的交接單或照片" : "無法寫入這台裝置，請重新整理後再試"));
    };
  });
  if (write) syncUrls(ops);
  return out;
}

const makeUrl = (buf) => URL.createObjectURL(new Blob([buf], { type: "image/jpeg" }));

function syncUrls(ops) {
  for (const [id, buf] of ops) {
    if (urls.has(id)) URL.revokeObjectURL(urls.get(id));
    if (buf) urls.set(id, makeUrl(buf));
    else urls.delete(id);
  }
}

const done = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

export async function imageIds() {
  await ready();
  if (mode === "memory") return [...mem.images.keys()];
  return done(idb.transaction("images").objectStore("images").getAllKeys());
}

export async function imageData(id) {
  await ready();
  if (mode === "memory") return mem.images.get(id) || null;
  return (await done(idb.transaction("images").objectStore("images").get(id))) || null;
}

// Make a link for every stored photo (also those another tab just added).
export async function loadImages() {
  for (const id of await imageIds()) {
    if (urls.has(id)) continue;
    const buf = await imageData(id);
    if (buf) urls.set(id, makeUrl(buf));
  }
}

export const imageUrl = (id) => urls.get(id) || "";

export function newId(n = 12) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return [...a].map((b) => "abcdefghijkmnpqrstuvwxyz23456789"[b & 31]).join("");
}

// Ask the browser not to clear this site's data by itself. It may refuse; that is fine.
let asked = false;
export function askPersist() {
  if (asked) return;
  asked = true;
  try {
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  } catch { /* not supported */ }
}
