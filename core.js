// Shared helpers: data access, escaping, toast, sheets, dialogs, files, clipboard.
import { handle, ApiError, PROBLEMS, ACTIONS } from "./local.js";
import { imageUrl } from "./store.js";

export const state = { me: null };
export { ApiError };

export const api = (path, opts) => handle(path, opts);

export async function loadMe() {
  state.me = await api("/me");
  return state.me;
}

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const fileUrl = (id) => (id ? imageUrl(id) : "");

export function fmtTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

let toastTimer;
export function toast(msg, kind = "") {
  let el = $("#toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ""), kind === "err" ? 4200 : 2200);
}

export function showError(e) {
  console.error(e);
  toast(e.message || String(e), "err");
}

// Run an async action with error toast; returns result or undefined.
export async function run(fn) {
  try {
    return await fn();
  } catch (e) {
    showError(e);
    return undefined;
  }
}

// Bottom sheet. Returns { el, close }. onClose resolves when closed.
export function sheet(html, { title = "", wide = false } = {}) {
  const back = document.createElement("div");
  back.className = "sheet-back";
  back.innerHTML = `<div class="sheet ${wide ? "wide" : ""}" role="dialog" aria-modal="true">
    <div class="sheet-head"><strong>${esc(title)}</strong><button class="icon-btn" data-close aria-label="關閉">✕</button></div>
    <div class="sheet-body">${html}</div></div>`;
  document.body.appendChild(back);
  document.body.classList.add("no-scroll");
  let resolveClosed;
  const closed = new Promise((r) => (resolveClosed = r));
  const close = (value) => {
    back.remove();
    if (!$(".sheet-back")) document.body.classList.remove("no-scroll");
    resolveClosed(value);
  };
  back.addEventListener("click", (e) => {
    if (e.target === back || e.target.closest("[data-close]")) close();
  });
  return { el: back.querySelector(".sheet-body"), close, closed };
}

export function confirmDlg(message, { ok = "確定", danger = false } = {}) {
  const s = sheet(`<p class="pre">${esc(message)}</p>
    <div class="row gap end"><button class="btn ghost" data-close>取消</button>
    <button class="btn ${danger ? "danger" : "primary"}" data-ok>${esc(ok)}</button></div>`, { title: "確認" });
  s.el.querySelector("[data-ok]").addEventListener("click", () => s.close(true));
  return s.closed.then((v) => v === true);
}

export function alertDlg(title, html) {
  const s = sheet(`${html}<div class="row end"><button class="btn primary" data-close>知道了</button></div>`, { title });
  return s.closed;
}

export function pickFile({ accept = "image/*", capture = false } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    if (capture) input.capture = "environment";
    input.addEventListener("change", () => resolve(input.files[0] || null));
    input.click();
  });
}

export async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* fall through to legacy copy */
    }
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

export function debounce(fn, ms = 250) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

export const ACTION_LABEL = ACTIONS;
export const PROBLEM_LABEL = PROBLEMS;

// Searchable product picker inside a sheet. Resolves to a product or null.
export function pickProduct({ title = "選擇商品", allowSku = false } = {}) {
  const s = sheet(`<input class="input" type="search" placeholder="輸入貨號或品名搜尋" data-q autofocus>
    <div class="list" data-res><p class="muted">輸入關鍵字開始搜尋</p></div>`, { title });
  const q = s.el.querySelector("[data-q]");
  const res = s.el.querySelector("[data-res]");
  let items = [];
  const search = debounce(async () => {
    const term = q.value.trim();
    if (!term) return;
    const data = await run(() => api(`/products?q=${encodeURIComponent(term)}&limit=40`));
    if (!data) return;
    items = data.items;
    res.innerHTML = items.length
      ? items.map((p, i) => `<button class="list-row" data-i="${i}">
          ${p.image ? `<img class="thumb" src="${fileUrl(p.image)}" alt="">` : `<span class="thumb ph"></span>`}
          <span class="grow"><b>${esc(p.short_name || p.name)}</b><small class="muted">${esc(p.sku)}・${esc(p.name)}</small></span></button>`).join("")
      : `<p class="muted">找不到「${esc(term)}」</p>${allowSku ? `<button class="btn" data-sku>直接用貨號「${esc(term)}」加入</button>` : ""}`;
  });
  q.addEventListener("input", search);
  setTimeout(() => q.focus(), 50);
  res.addEventListener("click", (e) => {
    const b = e.target.closest("[data-i]");
    if (b) s.close(items[+b.dataset.i]);
    if (e.target.closest("[data-sku]")) s.close({ sku: q.value.trim(), _new: true });
  });
  return s.closed.then((v) => v || null);
}

// Hand text to LINE etc. with the phone's share sheet, or copy it.
export async function shareOrCopy(text) {
  if (navigator.share) {
    try {
      await navigator.share({ text });
      return;
    } catch (e) {
      if (e && e.name === "AbortError") return;
    }
  }
  toast((await copyText(text)) ? "已複製，貼到 LINE 即可" : "無法自動複製，請長按文字複製", "");
}

export function saveFile(name, text, type = "application/json") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
