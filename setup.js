// Master data: products, warehouse locations, cabinets (+ layer editor), staff.
import {
  api, state, esc, $, $$, toast, run, sheet, confirmDlg, pickFile, fileUrl, debounce, pickProduct,
} from "./core.js";
import { stageHTML, mountEditor } from "./layers.js";

const TABS = [["products", "商品"], ["locations", "倉位"], ["cabinets", "櫃體"], ["staff", "人員"]];

export async function viewSetup(tab, el) {
  if (!TABS.some(([k]) => k === tab)) tab = "products";
  el.innerHTML = `<h1>設定</h1>
    <p class="muted small">這裡的資料只存在這台裝置。要給夥伴同一份，請到「<a href="#/data">我的資料</a>」匯出基本資料檔。</p>
    <nav class="tabs">${TABS.map(([k, t]) => `<a href="#/setup/${k}" class="${k === tab ? "on" : ""}">${t}</a>`).join("")}</nav>
    <div id="tabbody"></div>`;
  const body = $("#tabbody", el);
  await { products, locations, cabinets, staff }[tab](body);
}

// ---------- products ----------

async function products(body) {
  body.innerHTML = `<div class="row gap"><input class="input grow" type="search" id="q" placeholder="搜尋貨號或品名">
      <button class="btn primary" id="new">＋ 新增</button></div>
    <button class="btn block" id="imp">📄 從 CSV／Excel 匯入商品</button>
    <p class="muted small" id="count"></p><div class="list" id="list"></div>`;
  let items = [];
  const load = async () => {
    const q = $("#q", body).value.trim();
    const d = await api(`/products?q=${encodeURIComponent(q)}&limit=300`);
    items = d.items;
    $("#count", body).textContent = `共 ${d.total} 項${d.total > items.length ? `，顯示前 ${items.length} 項` : ""}`;
    $("#list", body).innerHTML = items.length ? items.map((p, i) => `<button class="list-row" data-i="${i}">
        ${p.image ? `<img class="thumb" src="${fileUrl(p.image)}" alt="">` : `<span class="thumb ph">無圖</span>`}
        <span class="grow"><b>${esc(p.short_name || p.name)}</b><small class="muted">${esc(p.sku)}・${esc(p.name)}</small></span></button>`).join("")
      : `<p class="muted pad">沒有商品。可以匯入商品清單，或在交接時遇到新貨號再建立。</p>`;
  };
  await load();
  $("#q", body).addEventListener("input", debounce(load, 300));
  $("#new", body).addEventListener("click", () => productSheet(null, load));
  $("#imp", body).addEventListener("click", () => importProducts(load));
  $("#list", body).addEventListener("click", (e) => {
    const b = e.target.closest("[data-i]");
    if (b) productSheet(items[+b.dataset.i], load);
  });
}

async function productSheet(p, reload) {
  const detail = p ? await api(`/products/${p.id}`) : null;
  const v = (k) => esc(detail && detail[k] != null ? detail[k] : "");
  const s = sheet(`${p ? `<div class="row gap">${detail.image ? `<img class="thumb lg" src="${fileUrl(detail.image)}" alt="">` : `<span class="thumb lg ph">無圖</span>`}
      <button class="btn" data-img>📷 ${detail.image ? "更換" : "上傳"}商品圖</button></div>` : ""}
    <label>貨號<input class="input" data-k="sku" value="${v("sku")}" required></label>
    <label>品名<input class="input" data-k="name" value="${v("name")}" required></label>
    <label>簡稱（標註圖上顯示，建議 6 字內）<input class="input" data-k="short_name" value="${v("short_name")}" maxlength="12"></label>
    <div class="grid4"><label>寬 cm<input class="input" data-k="width" inputmode="decimal" value="${v("width")}"></label>
    <label>深 cm<input class="input" data-k="depth" inputmode="decimal" value="${v("depth")}"></label>
    <label>高 cm<input class="input" data-k="height" inputmode="decimal" value="${v("height")}"></label>
    <label>重 kg<input class="input" data-k="weight" inputmode="decimal" value="${v("weight")}"></label></div>
    ${detail && detail.places.length ? `<p class="muted small">目前陳列：${esc(detail.places.join("、"))}</p>` : ""}
    <button class="btn primary block" data-save>儲存</button>
    ${p ? `<button class="btn ghost danger-text block" data-del>刪除商品</button>` : ""}`, { title: p ? "編輯商品" : "新增商品" });
  s.el.addEventListener("click", async (e) => {
    if (e.target.closest("[data-save]")) {
      const b = {};
      for (const i of $$("[data-k]", s.el)) {
        const k = i.dataset.k;
        const val = i.value.trim();
        b[k] = ["width", "depth", "height", "weight"].includes(k) ? (val === "" ? null : +val) : val;
      }
      if (!b.sku || !b.name) return toast("貨號與品名必填", "err");
      const r = await run(() => api(p ? `/products/${p.id}` : "/products", { method: p ? "PATCH" : "POST", body: b }));
      if (r) { s.close(); toast("已儲存"); reload(); }
    }
    if (e.target.closest("[data-img]")) {
      const f = await pickFile({ capture: false });
      if (!f) return;
      if (await run(() => api(`/products/${p.id}/image`, { method: "POST", file: f }))) {
        s.close(); toast("圖片已更新"); reload();
      }
    }
    if (e.target.closest("[data-del]")) {
      if (!(await confirmDlg(`刪除「${p.name}」？刪除後無法還原。`, { ok: "刪除", danger: true }))) return;
      if (await run(() => api(`/products/${p.id}`, { method: "DELETE" }))) { s.close(); reload(); }
    }
  });
}

async function importProducts(reload) {
  const file = await pickFile({ accept: ".csv,.xlsx,.xlsm,text/csv" });
  if (!file) return;
  const p = await run(() => api("/import/parse", { method: "POST", file }));
  if (!p) return;
  if (!p.rows.length) return toast("檔案裡沒有資料列", "err");
  const saved = p.saved.product || {};
  const idx = (k) => (saved[k] && p.headers.includes(saved[k]) ? p.headers.indexOf(saved[k]) : p.guess[k] ?? null);
  const fields = [["sku", "貨號（必填）"], ["name", "品名（必填）"], ["short_name", "簡稱"], ["width", "寬"], ["depth", "深"], ["height", "高"], ["weight", "重量"]];
  const opts = (sel) => `<option value="">（不使用）</option>` + p.headers.map((hd, i) => `<option value="${i}" ${sel === i ? "selected" : ""}>${esc(hd || `第 ${i + 1} 欄`)}</option>`).join("");
  const s = sheet(`<p class="muted small">${esc(file.name)}・${p.rows.length} 列。同貨號會更新資料。</p>
    ${fields.map(([k, t]) => `<label>${t}<select class="input" data-map="${k}">${opts(idx(k))}</select></label>`).join("")}
    <div class="table-wrap"><table class="tbl"><tr>${p.headers.map((hd) => `<th>${esc(hd)}</th>`).join("")}</tr>
    ${p.rows.slice(0, 5).map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</table></div>
    <button class="btn primary block" data-go>匯入</button>`, { title: "匯入商品", wide: true });
  $("[data-go]", s.el).addEventListener("click", async () => {
    const mapping = {};
    for (const sel of $$("[data-map]", s.el)) mapping[sel.dataset.map] = sel.value === "" ? null : +sel.value;
    if (mapping.sku === null || mapping.name === null) return toast("請指定貨號與品名欄位", "err");
    const r = await run(() => api("/products/import", { method: "POST", body: { mapping, headers: p.headers, rows: p.rows } }));
    if (!r) return;
    s.close();
    toast(`新增 ${r.created}、更新 ${r.updated}、略過 ${r.skipped}`);
    reload();
  });
}

// ---------- locations ----------

async function locations(body) {
  const list = await api("/locations");
  body.innerHTML = `<form class="row gap" id="f"><input class="input" name="code" placeholder="倉位代碼，如 B-1-1" required style="flex:1">
      <input class="input" name="desc" placeholder="說明（可留空）" style="flex:1"><button class="btn primary">新增</button></form>
    <button class="btn block" id="bulk">一次貼上多筆</button>
    <p class="muted small">倉位會顯示在上架清單上，建議用「區-排-層」格式。共 ${list.length} 個。</p>
    <div class="list">${list.map((l) => `<div class="list-row"><span class="grow"><b>${esc(l.code)}</b>
      <small class="muted">${esc(l.description || "")}</small></span>
      <button class="btn sm" data-edit="${l.id}">改</button><button class="icon-btn" data-del="${l.id}" aria-label="刪除">✕</button></div>`).join("")
      || `<p class="muted pad">還沒有倉位。</p>`}</div>`;
  const reload = () => locations(body);
  $("#f", body).addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    if (await run(() => api("/locations", { method: "POST", body: { code: fd.get("code").trim(), description: fd.get("desc").trim() } }))) reload();
  });
  $("#bulk", body).addEventListener("click", () => {
    const s = sheet(`<p class="muted small">每行一個倉位；代碼與說明之間用空白、逗號或 Tab 分隔。可直接從 Excel 複製兩欄貼上。</p>
      <textarea class="input" rows="10" data-t placeholder="B-1-1 沙發區\nB-1-2\nB-2-1 燈具"></textarea>
      <button class="btn primary block" data-go>新增</button>`, { title: "批次新增倉位" });
    $("[data-go]", s.el).addEventListener("click", async () => {
      const r = await run(() => api("/locations/bulk", { method: "POST", body: { text: $("[data-t]", s.el).value } }));
      if (r) { s.close(); toast(`新增 ${r.created}，略過 ${r.skipped}（重複或空白）`); reload(); }
    });
  });
  body.onclick = async (e) => {
    const d = e.target.closest("[data-del]");
    if (d) {
      const l = list.find((x) => x.id === +d.dataset.del);
      if (!(await confirmDlg(`刪除倉位 ${l.code}？`, { ok: "刪除", danger: true }))) return;
      if (await run(() => api(`/locations/${l.id}`, { method: "DELETE" }))) reload();
    }
    const ed = e.target.closest("[data-edit]");
    if (ed) {
      const l = list.find((x) => x.id === +ed.dataset.edit);
      const s = sheet(`<label>代碼<input class="input" data-c value="${esc(l.code)}"></label>
        <label>說明<input class="input" data-d value="${esc(l.description || "")}"></label>
        <button class="btn primary block" data-go>儲存</button>`, { title: "編輯倉位" });
      $("[data-go]", s.el).addEventListener("click", async () => {
        if (await run(() => api(`/locations/${l.id}`, { method: "PATCH",
          body: { code: $("[data-c]", s.el).value.trim(), description: $("[data-d]", s.el).value.trim() } }))) { s.close(); reload(); }
      });
    }
  };
}

// ---------- cabinets ----------

async function cabinets(body) {
  const list = await api("/cabinets");
  body.innerHTML = `<form class="row gap" id="f"><input class="input" name="code" placeholder="櫃號，如 A01" required style="flex:1">
      <input class="input" name="name" placeholder="名稱，如 客廳展示櫃" style="flex:1.4"><button class="btn primary">新增</button></form>
    <p class="muted small">新增後拍一張正面照，在照片上框出每一層，之後交接時就能直接點層板。</p>
    <div class="cab-grid">${list.map((c) => `<a class="cab-card" href="#/setup/cabinet/${c.id}">
      ${c.image ? stageHTML(c) : `<div class="stage-empty sq">尚未上傳照片</div>`}
      <b>${esc(c.code)}</b><small class="muted">${esc(c.name || "")}・${c.layers.length} 層</small></a>`).join("")
      || `<p class="muted pad">還沒有櫃體。</p>`}</div>`;
  $("#f", body).addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const r = await run(() => api("/cabinets", { method: "POST", body: { code: fd.get("code").trim(), name: fd.get("name").trim() } }));
    if (r) location.hash = `#/setup/cabinet/${r.id}`;
  });
}

export async function viewCabinetEditor(cid, el) {
  let cab = await api(`/cabinets/${cid}`);
  let editor = null;
  let dirty = false;
  const draw = () => {
    el.innerHTML = `<div class="page-head"><a class="back" href="#/setup/cabinets">‹ 櫃體列表</a>
        <h1>${esc(cab.code)} <small class="muted">${esc(cab.name || "")}</small></h1></div>
      <section class="card"><div class="row gap wrap">
        <button class="btn" id="photo">📷 ${cab.image ? "重拍" : "上傳"}櫃體照片</button>
        <button class="btn" id="meta">改櫃號／名稱</button>
        <button class="btn ghost danger-text" id="del">刪除櫃體</button></div></section>
      <section class="card"><h2>層板</h2>
        <p class="muted small">在照片上拖曳畫框新增一層；點框可移動，拉四角調整大小。或用「平均切成」快速切出水平層板（由上往下 1、2、3…）。</p>
        <div class="row gap wrap"><span>平均切成</span>${[2, 3, 4, 5, 6].map((n) => `<button class="btn sm" data-split="${n}">${n} 層</button>`).join("")}</div>
        <div id="ed"></div>
        <div id="selbar"></div>
        <button class="btn primary block" id="save">儲存層板</button></section>
      <section class="card"><h2>目前陳列</h2>
        <p class="muted small">交接單「完成」時會自動更新。這裡可手動修正，撤下與移位會用到。</p>
        <div id="pl"></div></section>`;
    editor = mountEditor($("#ed", el), cab, (layers, sel) => {
      dirty = true;
      const bar = $("#selbar", el);
      if (sel < 0) {
        bar.innerHTML = `<p class="muted small">${layers.length} 層${dirty ? "（尚未儲存）" : ""}</p>`;
        return;
      }
      if (bar.dataset.sel === String(sel) && bar.querySelector("input")) return;
      bar.dataset.sel = String(sel);
      bar.innerHTML = `<div class="row gap"><label class="grow">層號<input class="input" id="lcode" value="${esc(layers[sel].code)}" maxlength="10"></label>
        <button class="btn danger" id="ldel">刪除這層</button></div>`;
      $("#lcode", bar).addEventListener("input", (e) => editor.setCode(editor.selected, e.target.value.trim()));
      $("#ldel", bar).addEventListener("click", () => { bar.dataset.sel = ""; editor.remove(editor.selected); });
    });
    dirty = false;
    $("#selbar", el).innerHTML = `<p class="muted small">${cab.layers.length} 層</p>`;
    drawPlacements();
  };
  const drawPlacements = () => {
    const box = $("#pl", el);
    box.innerHTML = cab.layers.length ? cab.layers.map((l) => `<div class="pl-layer"><div class="row between"><b>${esc(l.label)}</b>
        <button class="btn sm" data-addpl="${l.id}">＋ 商品</button></div>
        ${l.placements.map((p) => `<div class="list-row sm">${p.image ? `<img class="thumb sm" src="${fileUrl(p.image)}" alt="">` : ""}
          <span class="grow">${esc(p.short_name || p.name)} <small class="muted">${esc(p.sku)}・${p.qty}</small></span>
          <button class="icon-btn" data-delpl="${p.id}" aria-label="移除">✕</button></div>`).join("") || `<p class="muted small">（空）</p>`}</div>`).join("")
      : `<p class="muted">先畫層板並儲存。</p>`;
  };
  draw();

  el.onclick = async (e) => {
    const t = e.target;
    const sp = t.closest("[data-split]");
    if (sp) {
      if (editor.layers.length && !(await confirmDlg("會取代目前畫好的層板，確定？", { ok: "取代" }))) return;
      editor.split(+sp.dataset.split);
      return;
    }
    if (t.closest("#save")) {
      const layers = editor.layers.map((l) => ({ id: l.id, code: l.code, x: l.x, y: l.y, w: l.w, h: l.h }));
      if (layers.some((l) => !l.code)) return toast("每一層都要有層號", "err");
      const codes = layers.map((l) => l.code);
      if (new Set(codes).size !== codes.length) return toast("層號不能重複", "err");
      const r = await run(() => api(`/cabinets/${cid}/layers`, { method: "PUT", body: { layers } }));
      if (r) { cab = r; toast("層板已儲存"); draw(); }
      return;
    }
    if (t.closest("#photo")) {
      const f = await pickFile({ capture: true });
      if (!f) return;
      if (await run(() => api(`/cabinets/${cid}/image`, { method: "POST", file: f }))) {
        cab = await api(`/cabinets/${cid}`);
        toast("照片已更新");
        draw();
      }
      return;
    }
    if (t.closest("#meta")) {
      const s = sheet(`<label>櫃號<input class="input" data-c value="${esc(cab.code)}"></label>
        <label>名稱<input class="input" data-n value="${esc(cab.name || "")}"></label>
        <button class="btn primary block" data-go>儲存</button>`, { title: "櫃體資料" });
      $("[data-go]", s.el).addEventListener("click", async () => {
        if (await run(() => api(`/cabinets/${cid}`, { method: "PATCH",
          body: { code: $("[data-c]", s.el).value.trim(), name: $("[data-n]", s.el).value.trim() } }))) {
          s.close();
          cab = await api(`/cabinets/${cid}`);
          draw();
        }
      });
      return;
    }
    if (t.closest("#del")) {
      if (!(await confirmDlg(`刪除櫃體 ${cab.code}？刪除後無法還原。`, { ok: "刪除", danger: true }))) return;
      if (await run(() => api(`/cabinets/${cid}`, { method: "DELETE" }))) location.hash = "#/setup/cabinets";
      return;
    }
    const ap = t.closest("[data-addpl]");
    if (ap) {
      const p = await pickProduct({ title: "這層放了什麼商品" });
      if (!p) return;
      if (await run(() => api(`/cabinets/${cid}/placements`, { method: "POST", body: { layer_id: +ap.dataset.addpl, product_id: p.id, qty: 1 } }))) {
        cab = await api(`/cabinets/${cid}`);
        drawPlacements();
      }
      return;
    }
    const dp = t.closest("[data-delpl]");
    if (dp) {
      if (await run(() => api(`/placements/${dp.dataset.delpl}`, { method: "DELETE" }))) {
        cab = await api(`/cabinets/${cid}`);
        drawPlacements();
      }
    }
  };
}

// ---------- staff ----------

async function staff(body) {
  const list = await api("/staff");
  body.innerHTML = `<form class="row gap" id="f"><input class="input grow" name="n" placeholder="姓名或暱稱" required maxlength="30">
      <button class="btn primary">新增</button></form>
    <p class="muted small">這份名單是送出交接時「接班人」的選項，只存在這台裝置。</p>
    <div class="list">${list.map((s) => `<div class="list-row ${s.active ? "" : "off"}"><span class="grow"><b>${esc(s.name)}</b>
      ${s.active ? "" : `<small class="muted">已停用</small>`}${s.name === state.me.operator_name ? `<small class="muted">（目前操作人）</small>` : ""}</span>
      <button class="btn sm" data-ren="${s.id}">改名</button>
      <button class="btn sm" data-act="${s.id}" data-v="${s.active ? 0 : 1}">${s.active ? "停用" : "啟用"}</button></div>`).join("")
      || `<p class="muted pad">名單是空的。</p>`}</div>`;
  const reload = () => staff(body);
  $("#f", body).addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = new FormData(e.target).get("n").trim();
    if (await run(() => api("/staff", { method: "POST", body: { name } }))) reload();
  });
  body.onclick = async (e) => {
    const a = e.target.closest("[data-act]");
    if (a) {
      if (await run(() => api(`/staff/${a.dataset.act}`, { method: "PATCH", body: { active: a.dataset.v === "1" } }))) reload();
    }
    const r = e.target.closest("[data-ren]");
    if (r) {
      const s0 = list.find((x) => x.id === +r.dataset.ren);
      const s = sheet(`<input class="input" data-n value="${esc(s0.name)}" maxlength="30">
        <p class="muted small">舊紀錄上的名字不會改變。</p><button class="btn primary block" data-go>儲存</button>`, { title: "改名" });
      $("[data-go]", s.el).addEventListener("click", async () => {
        if (await run(() => api(`/staff/${s0.id}`, { method: "PATCH", body: { name: $("[data-n]", s.el).value.trim() } }))) { s.close(); reload(); }
      });
    }
  };
}
