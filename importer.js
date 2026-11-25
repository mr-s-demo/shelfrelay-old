// Read CSV / XLSX files in the browser into a header row plus data rows (all strings).
import { ApiError, fail } from "./store.js";

export const MAX_ROWS = 5000;
const MAX_FILE = 20 * 1024 * 1024;
const MAX_UNZIP = 60 * 1024 * 1024;
const SKU_KEYS = ["貨號", "品號", "料號", "商品編號", "商品代號", "編號", "代號", "sku", "條碼", "item"];
const NAME_KEYS = ["品名", "商品名稱", "名稱", "品項", "name", "description"];
const QTY_KEYS = ["箱數", "數量", "進貨數", "件數", "qty", "quantity"];
const SHORT_KEYS = ["簡稱", "短名", "short"];

export async function parseFile(file) {
  if (file.size > MAX_FILE) fail("檔案過大");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const name = (file.name || "").toLowerCase();
  let table;
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) table = await parseXlsx(bytes);
  else if (bytes[0] === 0xd0 && bytes[1] === 0xcf) fail("不支援舊版 .xls，請另存為 .xlsx 或 CSV");
  else if (/\.xls[xm]?$/.test(name)) fail("無法讀取這個 Excel 檔，請另存為 .xlsx 或 CSV");
  else table = parseCsv(decode(bytes));
  return shape(table);
}

export function shape(table) {
  table = table.map((r) => r.map((c) => String(c ?? "").trim())).filter((r) => r.some((c) => c));
  if (!table.length) fail("檔案沒有資料");
  if (table.length - 1 > MAX_ROWS) fail(`資料超過 ${MAX_ROWS} 列，請分批匯入`);
  const width = table.reduce((m, r) => Math.max(m, r.length), 0);
  const fill = (r) => r.concat(Array(width - r.length).fill(""));
  const headers = fill(table[0]).map((h, i) => h || `第${i + 1}欄`);
  return {
    headers, rows: table.slice(1).map(fill),
    guess: { sku: guess(headers, SKU_KEYS), name: guess(headers, NAME_KEYS), qty: guess(headers, QTY_KEYS),
      short_name: guess(headers, SHORT_KEYS) },
  };
}

export function decode(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("big5").decode(bytes);
  }
}

export function parseCsv(text) {
  text = text.replace(/^﻿/, "");
  const line = text.slice(0, 4096).split(/\r?\n/).find((l) => l.trim()) || "";
  const count = (ch) => line.split(ch).length - 1;
  const sep = ["\t", ";"].reduce((a, b) => (count(b) > count(a) ? b : a), ",");
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') cell += ch;
      else if (text[i + 1] === '"') { cell += '"'; i++; }
      else quoted = false;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === sep) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// ---------- xlsx (a zip of XML files) ----------

async function inflate(bytes) {
  if (typeof DecompressionStream === "undefined") fail("這個瀏覽器太舊，不能讀 Excel，請改用 CSV");
  const s = new DecompressionStream("deflate-raw");
  const w = s.writable.getWriter();
  w.write(bytes).catch(() => {});
  w.close().catch(() => {});
  const r = s.readable.getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await r.read();
    if (done) break;
    size += value.length;
    if (size > MAX_UNZIP) {
      r.cancel().catch(() => {});
      fail("Excel 內容過大，請分批匯入");
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

function zipEntries(b) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let end = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 66000); i--) {
    if (v.getUint32(i, true) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error("zip");
  const total = v.getUint16(end + 10, true);
  let p = v.getUint32(end + 16, true);
  const out = {};
  for (let n = 0; n < total; n++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error("zip");
    const nameLen = v.getUint16(p + 28, true);
    const name = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nameLen));
    out[name] = { method: v.getUint16(p + 10, true), size: v.getUint32(p + 20, true), at: v.getUint32(p + 42, true) };
    p += 46 + nameLen + v.getUint16(p + 30, true) + v.getUint16(p + 32, true);
  }
  return {
    has: (name) => name in out,
    async text(name) {
      const e = out[name];
      if (!e) return null;
      const start = e.at + 30 + v.getUint16(e.at + 26, true) + v.getUint16(e.at + 28, true);
      const raw = b.subarray(start, start + e.size);
      if (e.method !== 0 && e.method !== 8) throw new Error("zip");
      return new TextDecoder().decode(e.method === 8 ? await inflate(raw) : raw);
    },
  };
}

const xml = (text) => {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error("xml");
  return doc;
};
const tags = (node, name) => [...node.getElementsByTagNameNS("*", name)];
// All text of a string item, without the phonetic (rPh) hints.
const textOf = (node) => tags(node, "t").filter((t) => t.parentNode.localName !== "rPh").map((t) => t.textContent).join("");

function colIndex(ref) {
  let n = 0;
  for (const ch of ref) {
    const c = ch.charCodeAt(0) - 64;
    if (c < 1 || c > 26) break;
    n = n * 26 + c;
  }
  return n - 1;
}

function numText(s) {
  const n = Number(s);
  return s.trim() !== "" && Number.isFinite(n) ? String(n) : s;
}

async function firstSheetPath(zip) {
  try {
    const book = xml(await zip.text("xl/workbook.xml"));
    const sheet = tags(book, "sheet")[0];
    const rid = [...sheet.attributes].find((a) => a.localName === "id" && a.name !== "id" || a.name === "r:id").value;
    const rel = tags(xml(await zip.text("xl/_rels/workbook.xml.rels")), "Relationship").find((r) => r.getAttribute("Id") === rid);
    const target = rel.getAttribute("Target");
    const path = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
    if (zip.has(path)) return path;
  } catch { /* fall back to the usual name */ }
  return "xl/worksheets/sheet1.xml";
}

export async function parseXlsx(bytes) {
  try {
    const zip = zipEntries(bytes);
    const sharedText = await zip.text("xl/sharedStrings.xml");
    const shared = sharedText ? tags(xml(sharedText), "si").map(textOf) : [];
    const sheet = await zip.text(await firstSheetPath(zip));
    if (!sheet) fail("Excel 裡沒有工作表");
    const out = [];
    for (const row of tags(xml(sheet), "row")) {
      if (out.length > MAX_ROWS * 2) fail(`資料超過 ${MAX_ROWS} 列，請分批匯入`);
      const cells = [];
      let next = 0;
      for (const c of tags(row, "c")) {
        const ref = c.getAttribute("r");
        const i = ref ? colIndex(ref) : next;
        if (i < 0 || i > 500) continue;
        next = i + 1;
        const type = c.getAttribute("t") || "n";
        const v = tags(c, "v")[0];
        const raw = v ? v.textContent : "";
        while (cells.length < i) cells.push("");
        cells[i] = type === "s" ? shared[+raw] ?? "" : type === "inlineStr" ? textOf(c) : type === "n" ? numText(raw)
          : type === "e" ? "" : raw;
      }
      out.push(cells);
    }
    return out;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError("bad", "無法讀取這個 Excel 檔，請另存為 .xlsx 或 CSV 再試");
  }
}

function guess(headers, keys) {
  const low = headers.map((h) => h.toLowerCase());
  for (const k of keys) { const i = low.indexOf(k.toLowerCase()); if (i >= 0) return i; }
  for (const k of keys) { const i = low.findIndex((h) => h.includes(k.toLowerCase())); if (i >= 0) return i; }
  return null;
}

export function parseInt1(s, def = 1) {
  const t = String(s).replace(/,/g, "").trim();
  const n = t === "" ? NaN : Math.trunc(Number(t));
  return Number.isFinite(n) && n > 0 ? n : def;
}

export function parseNum(s) {
  const t = String(s).replace(/,/g, "").trim();
  const n = t === "" ? NaN : Number(t);
  return Number.isFinite(n) ? n : null;
}
