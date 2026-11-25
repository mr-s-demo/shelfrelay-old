// Giver wizard (4 steps), receiver checklist, and card/share view.
import {
  api, state, esc, $, $$, toast, run, sheet, confirmDlg, pickFile, copyText, shareOrCopy,
  fileUrl, fmtTime, pickProduct, ACTION_LABEL, PROBLEM_LABEL,
} from "./core.js";
import { stageHTML } from "./layers.js";
import { dateLabel } from "./local.js";
import { unpack, readHandoff, readReport } from "./link.js";
import { drawCard, canvasToBlob, cabinetEntries } from "./card.js";

const STEPS = ["清單", "櫃位", "倉位箱數", "送出"];
const ACT_CLS = { add: "t-add", remove: "t-remove", move: "t-move" };

const actTag = (a) => `<span class="tag ${ACT_CLS[a]}">${ACTION_LABEL[a]}</span>`;

function marksFor(items, cabId, { doneAware = false } = {}) {
  const marks = {};
  const badges = {};
  const add = (lid, m, b) => {
    (marks[lid] ||= []).push(m);
    badges[lid] = badges[lid] ? `${badges[lid]}、${b}` : b;
  };
  for (const it of items) {
    const done = doneAware && it.done ? " ✓" : "";
    if (it.cabinet_id === cabId && it.layer_id) {
      add(it.layer_id, it.action, `${it.action === "move" ? "移出" : ACTION_LABEL[it.action]} ${it.display}${it.action === "add" ? ` ×${it.qty}` : ""}${done}`);
      if (doneAware && it.done) marks[it.layer_id].push("done");
    }
    if (it.action === "move" && it.to_cabinet_id === cabId && it.to_layer_id) {
      add(it.to_layer_id, "move", `移入 ${it.display}${done}`);
    }
  }
  return { marks, badges };
}

const LEGEND = `<div class="legend"><span><i class="lg add"></i>上架</span><span><i class="lg remove"></i>撤下</span><span><i class="lg move"></i>移位</span></div>`;

// ---------- layer picker ----------

async function pickLayer(cabs, { title = "選擇櫃層", currentId = null, productId = null, allowClear = false } = {}) {
  if (!cabs.length) {
    toast("還沒有櫃體，請先到「設定 → 櫃體」建立", "err");
    return undefined;
  }
  const findCab = (lid) => cabs.find((c) => c.layers.some((l) => l.id === lid));
  let cur = findCab(currentId) || cabs.find((c) => productId && c.layers.some((l) => l.placements.some((p) => p.product_id === productId))) || cabs[0];
  const s = sheet(`<div class="chips" data-cabs></div><div data-stage></div>
    <p class="muted small">點照片上的層板選擇。${productId ? "標「目前在此」的是這個商品現在的位置。" : ""}</p>
    ${allowClear ? `<button class="btn ghost block" data-clear>清除櫃層</button>` : ""}`, { title, wide: true });
  const draw = () => {
    $("[data-cabs]", s.el).innerHTML = cabs.map((c) => `<button class="chip ${c.id === cur.id ? "on" : ""}" data-c="${c.id}">${esc(c.code)}${c.name ? ` ${esc(c.name)}` : ""}</button>`).join("");
    const marks = {};
    const badges = {};
    for (const l of cur.layers) {
      if (l.id === currentId) marks[l.id] = "sel";
      const here = l.placements.map((p) => p.short_name || p.name);
      if (productId && l.placements.some((p) => p.product_id === productId)) badges[l.id] = "目前在此";
      else if (here.length) badges[l.id] = here.slice(0, 2).join("、") + (here.length > 2 ? "…" : "");
    }
    $("[data-stage]", s.el).innerHTML = cur.layers.length
      ? stageHTML(cur, { marks, badges, clickable: true })
      : `<p class="muted pad">這個櫃體還沒畫層板，請到「設定 → 櫃體」編輯。</p>`;
  };
  draw();
  s.el.addEventListener("click", (e) => {
    const c = e.target.closest("[data-c]");
    if (c) {
      cur = cabs.find((x) => x.id === +c.dataset.c);
      draw();
      return;
    }
    const l = e.target.closest("[data-layer]");
    if (l) {
      const layer = cur.layers.find((x) => x.id === +l.dataset.layer);
      s.close({ id: layer.id, label: layer.label });
    }
    if (e.target.closest("[data-clear]")) s.close({ id: null, label: "" });
  });
  return s.closed;
}

function layersWithProduct(cabs, pid) {
  const out = [];
  for (const c of cabs) for (const l of c.layers) if (l.placements.some((p) => p.product_id === pid)) out.push(l);
  return out;
}

// ---------- giver wizard ----------

export async function viewEdit(hid, step, el) {
  const ctx = { hid, step, el, cabs: null, locs: null };
  await renderEdit(ctx);
}

async function renderEdit(ctx) {
  const { hid, el } = ctx;
  const h = await api(`/handoffs/${hid}`);
  if (h.status !== "draft") {
    location.hash = `#/h/${hid}`;
    return;
  }
  ctx.h = h;
  if (!ctx.cabs) ctx.cabs = await api("/cabinets");
  const unresolved = h.items.filter((i) => !i.product_id).length;
  const noLayer = h.items.filter((i) => !i.layer_id || (i.action === "move" && !i.to_layer_id)).length;
  const auto = h.items.filter((i) => i.auto_filled).length;
  const flags = [unresolved, noLayer + auto, 0, h.send_errors.length];
  el.innerHTML = `<div class="page-head">
      <a href="#/" class="back">‹ 首頁</a>
      <h1>${esc(h.date_label)} 進貨交接 <span class="tag s-draft">草稿</span></h1>
      <p class="muted small">交班 ${esc(h.giver_name || state.me.operator_name)}・${h.items.length} 項</p>
    </div>
    <nav class="steps">${STEPS.map((t, i) => `<a href="#/h/${hid}/edit/${i + 1}" class="${ctx.step === i + 1 ? "on" : ""}">
      <b>${i + 1}</b>${t}${flags[i] ? `<em>${flags[i]}</em>` : ""}</a>`).join("")}</nav>
    <div id="stepbody"></div>`;
  const body = $("#stepbody", el);
  const fn = [step1, step2, step3, step4][ctx.step - 1] || step1;
  await fn(ctx, body);
}

const reload = (ctx) => renderEdit(ctx);
const nextBtn = (ctx, label) => `<a class="btn primary block" href="#/h/${ctx.hid}/edit/${ctx.step + 1}">${label} →</a>`;

function itemLine(it, extra = "") {
  return `<div class="list-row item" data-iid="${it.id}">
    ${it.product_image ? `<img class="thumb" src="${fileUrl(it.product_image)}" alt="">` : `<span class="thumb ph">${actTag(it.action)}</span>`}
    <span class="grow"><b>${esc(it.display || it.sku)}</b>${it.product_image ? ` ${actTag(it.action)}` : ""}
      <small class="muted">${esc(it.sku)}${it.action === "add" ? `・${it.qty} 箱` : ""}${it.label ? `・${esc(it.label)}` : ""}${it.to_label ? ` → ${esc(it.to_label)}` : ""}</small>
      ${!it.product_id ? `<small class="warn">⚠ 商品資料庫沒有這個貨號</small>` : ""}</span>${extra}</div>`;
}

// Step 1: import list / manual add
async function step1(ctx, body) {
  const { h, hid } = ctx;
  body.innerHTML = `<section class="card">
      <h2>匯入進貨清單</h2>
      <p class="muted small">支援 CSV、Excel（.xlsx）。同貨號會自動合併箱數；欄位對應會記住，下次直接套用。</p>
      <button class="btn primary block" id="imp">📄 選擇檔案匯入</button>
    </section>
    <section class="card">
      <h2>手動加入</h2>
      <div class="row gap wrap"><button class="btn" data-add="add">＋ 上架</button>
      <button class="btn" data-add="remove">＋ 撤下</button><button class="btn" data-add="move">＋ 移位</button></div>
    </section>
    <h2>本次項目（${h.items.length}）</h2>
    <div class="list">${h.items.length ? h.items.map((it) => itemLine(it, `${!it.product_id ? `<button class="btn sm" data-resolve="${it.id}">建立商品</button>` : ""}
      <button class="icon-btn" data-del="${it.id}" aria-label="刪除">✕</button>`)).join("") : `<p class="muted pad">還沒有項目，匯入清單或手動加入。</p>`}</div>
    ${h.items.length ? nextBtn(ctx, "下一步：指定櫃位") : ""}
    <button class="btn ghost danger-text block" id="deldraft">刪除這張草稿</button>`;

  $("#imp", body).addEventListener("click", () => importFlow(ctx));
  $("#deldraft", body).addEventListener("click", async () => {
    if (!(await confirmDlg("確定刪除這張草稿？刪除後無法還原。", { ok: "刪除", danger: true }))) return;
    if (await run(() => api(`/handoffs/${hid}`, { method: "DELETE" }))) location.hash = "#/";
  });
  body.addEventListener("click", async (e) => {
    const a = e.target.closest("[data-add]");
    if (a) return manualAdd(ctx, a.dataset.add);
    const d = e.target.closest("[data-del]");
    if (d) {
      if (await run(() => api(`/handoffs/${hid}/items/${d.dataset.del}`, { method: "DELETE" }))) reload(ctx);
      return;
    }
    const r = e.target.closest("[data-resolve]");
    if (r) return resolveFlow(ctx, h.items.find((i) => i.id === +r.dataset.resolve));
  });
}

async function importFlow(ctx) {
  const file = await pickFile({ accept: ".csv,.xlsx,.xlsm,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  if (!file) return;
  const p = await run(() => api("/import/parse", { method: "POST", file }));
  if (!p) return;
  if (!p.rows.length) return toast("檔案裡沒有資料列", "err");
  const saved = p.saved.handoff || {};
  const idx = (k) => {
    if (saved[k] && p.headers.includes(saved[k])) return p.headers.indexOf(saved[k]);
    return p.guess[k];
  };
  const fields = [["sku", "貨號（必填）"], ["name", "品名"], ["qty", "箱數"]];
  const opts = (sel) => `<option value="">（不使用）</option>` + p.headers.map((hd, i) => `<option value="${i}" ${sel === i ? "selected" : ""}>${esc(hd || `第 ${i + 1} 欄`)}</option>`).join("");
  const s = sheet(`<p class="muted small">${esc(file.name)}・${p.rows.length} 列。請確認欄位對應：</p>
    ${fields.map(([k, t]) => `<label>${t}<select class="input" data-map="${k}">${opts(idx(k))}</select></label>`).join("")}
    <div class="table-wrap"><table class="tbl"><tr>${p.headers.map((hd) => `<th>${esc(hd)}</th>`).join("")}</tr>
    ${p.rows.slice(0, 5).map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</table></div>
    <button class="btn primary block" data-go>匯入 ${p.rows.length} 列</button>`, { title: "欄位對應", wide: true });
  $("[data-go]", s.el).addEventListener("click", async () => {
    const mapping = {};
    for (const sel of $$("[data-map]", s.el)) mapping[sel.dataset.map] = sel.value === "" ? null : +sel.value;
    if (mapping.sku === null) return toast("請指定貨號欄位", "err");
    const r = await run(() => api(`/handoffs/${ctx.hid}/import`, { method: "POST",
      body: { mapping, headers: p.headers, rows: p.rows } }));
    if (!r) return;
    s.close();
    toast(`新增 ${r.created} 項、更新 ${r.updated} 項${r.unmatched ? `，${r.unmatched} 項需建立商品` : ""}`);
    ctx.cabs = null;
    reload(ctx);
  });
}

async function resolveFlow(ctx, it) {
  const s = sheet(`<p>貨號 <b>${esc(it.sku)}</b> 不在商品資料庫。</p>
    <label>品名<input class="input" data-name value="${esc(it.name)}"></label>
    <label>簡稱（顯示在標註圖上，可留空）<input class="input" data-short maxlength="12"></label>
    <button class="btn primary block" data-new>建立商品</button>
    <button class="btn block" data-pick>改成對應到既有商品</button>`, { title: "建立商品" });
  s.el.addEventListener("click", async (e) => {
    if (e.target.closest("[data-new]")) {
      const r = await run(() => api(`/handoffs/${ctx.hid}/items/${it.id}/resolve`, { method: "POST",
        body: { name: $("[data-name]", s.el).value, short_name: $("[data-short]", s.el).value } }));
      if (r) { s.close(); reload(ctx); }
    }
    if (e.target.closest("[data-pick]")) {
      s.close();
      const p = await pickProduct({ title: "對應到哪個商品" });
      if (!p) return;
      const r = await run(() => api(`/handoffs/${ctx.hid}/items/${it.id}/resolve`, { method: "POST", body: { product_id: p.id } }));
      if (r) reload(ctx);
    }
  });
}

async function manualAdd(ctx, action) {
  const p = await pickProduct({ title: `${ACTION_LABEL[action]}哪個商品`, allowSku: action === "add" });
  if (!p) return;
  if (p._new) {
    if (await run(() => api(`/handoffs/${ctx.hid}/items`, { method: "POST", body: { action, sku: p.sku } }))) reload(ctx);
    return;
  }
  const payload = { action, product_id: p.id };
  if (action !== "add") {
    ctx.cabs = await api("/cabinets");
    const here = layersWithProduct(ctx.cabs, p.id);
    let from = here.length === 1 ? { id: here[0].id } : await pickLayer(ctx.cabs, { title: `${p.short_name || p.name} 目前在哪一層`, productId: p.id });
    if (!from || !from.id) return;
    payload.layer_id = from.id;
    if (action === "move") {
      const to = await pickLayer(ctx.cabs, { title: "要移到哪一層" });
      if (to && to.id) payload.to_layer_id = to.id;
    }
  }
  if (await run(() => api(`/handoffs/${ctx.hid}/items`, { method: "POST", body: payload }))) reload(ctx);
}

// Step 2: layers
async function step2(ctx, body) {
  const { h, hid, cabs } = ctx;
  const auto = h.items.filter((i) => i.auto_filled);
  const btn = (it, field, label) => {
    const has = field === "to" ? it.to_label : it.label;
    return `<button class="btn sm ${has ? "" : "need"}" data-pick="${it.id}" data-f="${field}">${has ? esc(has) : label}</button>`;
  };
  body.innerHTML = `${auto.length ? `<div class="notice">🔁 ${auto.length} 項位置是依上次紀錄自動帶入（標「自動」），請確認。
      <button class="btn sm" id="okall">全部確認</button></div>` : ""}
    <p class="muted small">點按鈕在櫃體照片上選層板。</p>
    <div class="list">${h.items.map((it) => `<div class="list-row item">
      <span class="grow"><b>${esc(it.display || it.sku)}</b> ${actTag(it.action)} ${it.auto_filled ? `<span class="tag s-auto">自動</span>` : ""}
      <small class="muted">${esc(it.sku)}${it.action === "add" ? `・${it.qty} 箱` : ""}</small></span>
      <span class="col end">${btn(it, "from", it.action === "add" ? "選上架層" : "選目前層")}
      ${it.action === "move" ? `<small class="muted">移到</small>${btn(it, "to", "選目標層")}` : ""}</span></div>`).join("")}</div>
    ${h.cabinets.length ? `<h2>櫃體預覽</h2>${LEGEND}${h.cabinets.map((c) => {
      const { marks, badges } = marksFor(h.items, c.id);
      return `<div class="card"><h3>${esc(c.code)} ${esc(c.name || "")}</h3>${stageHTML(c, { marks, badges })}</div>`;
    }).join("")}` : ""}
    ${nextBtn(ctx, "下一步：倉位與箱數")}`;
  const ok = $("#okall", body);
  if (ok) ok.addEventListener("click", async () => {
    if (await run(() => api(`/handoffs/${hid}/confirm-auto`, { method: "POST", body: {} }))) reload(ctx);
  });
  body.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-pick]");
    if (!b) return;
    const it = h.items.find((i) => i.id === +b.dataset.pick);
    const to = b.dataset.f === "to";
    const r = await pickLayer(cabs, {
      title: to ? `${it.display} 移到哪一層` : `${it.display}${it.action === "add" ? " 上架到哪一層" : " 目前在哪一層"}`,
      currentId: to ? it.to_layer_id : it.layer_id, productId: to ? null : it.product_id,
    });
    if (!r) return;
    const patch = to ? { to_layer_id: r.id } : { layer_id: r.id };
    if (await run(() => api(`/handoffs/${hid}/items/${it.id}`, { method: "PATCH", body: patch }))) reload(ctx);
  });
}

// Step 3: warehouse location + qty
async function step3(ctx, body) {
  const { h, hid } = ctx;
  if (!ctx.locs) ctx.locs = await api("/locations");
  const locs = ctx.locs;
  const rows = h.items.filter((i) => i.action !== "move");
  const sel = (it) => `<select class="input sm" data-loc="${it.id}"><option value="">${it.action === "add" ? "未指定倉位" : "回倉（不指定）"}</option>
    ${locs.map((l) => `<option value="${l.id}" ${l.id === it.location_id ? "selected" : ""}>${esc(l.code)}${l.description ? ` ${esc(l.description)}` : ""}</option>`).join("")}</select>`;
  body.innerHTML = `${locs.length ? "" : `<div class="notice">還沒有倉位資料，<a href="#/setup/locations">到設定建立倉位</a>（可一次貼上多筆）。</div>`}
    <p class="muted small">填上架品的箱數，倉位可填可不填；撤下品可指定回哪個倉位。</p>
    <div class="list">${rows.map((it) => `<div class="list-row item">
      <span class="grow"><b>${esc(it.display || it.sku)}</b> ${actTag(it.action)} ${it.auto_filled ? `<span class="tag s-auto">自動</span>` : ""}
      <small class="muted">${esc(it.label || "未指定櫃層")}</small></span>
      <span class="col end">${sel(it)}
      ${it.action === "add" ? `<span class="stepper"><button class="icon-btn" data-q="${it.id}" data-d="-1">−</button>
        <b>${it.qty}</b><button class="icon-btn" data-q="${it.id}" data-d="1">＋</button><small>箱</small></span>` : ""}</span></div>`).join("") || `<p class="muted pad">沒有需要倉位的項目。</p>`}</div>
    ${nextBtn(ctx, "下一步：確認送出")}`;
  body.addEventListener("change", async (e) => {
    const s = e.target.closest("[data-loc]");
    if (!s) return;
    const v = s.value ? +s.value : null;
    if (await run(() => api(`/handoffs/${hid}/items/${s.dataset.loc}`, { method: "PATCH", body: { location_id: v } }))) toast("已更新倉位");
  });
  body.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-q]");
    if (!b) return;
    const it = h.items.find((i) => i.id === +b.dataset.q);
    const qty = Math.max(1, it.qty + +b.dataset.d);
    if (qty === it.qty) return;
    if (await run(() => api(`/handoffs/${hid}/items/${it.id}`, { method: "PATCH", body: { qty } }))) reload(ctx);
  });
}

// Step 4: receiver + send
async function step4(ctx, body) {
  const { h, hid } = ctx;
  const staff = (await api("/staff")).filter((s) => s.active && s.name !== state.me.operator_name);
  body.innerHTML = `<section class="card">
      <label>交接日期<input class="input" type="date" id="date" value="${esc(h.handoff_date)}"></label>
      <label>交班人<input class="input" id="giver" value="${esc(h.giver_name || state.me.operator_name)}" maxlength="30"></label>
      <p class="label">接班人（下一位處理的人）</p>
      <div class="grid-names">${staff.map((s) => `<button class="btn name ${s.name === h.receiver_name ? "primary" : ""}" data-r="${esc(s.name)}">${esc(s.name)}</button>`).join("")}</div>
      <input class="input" id="recv" placeholder="或直接輸入名字" value="${esc(staff.some((s) => s.name === h.receiver_name) ? "" : h.receiver_name)}" maxlength="30">
      <label>備註<textarea class="input" id="note" rows="2" placeholder="例如：B 區走道有棧板，請小心">${esc(h.note)}</textarea></label>
    </section>
    ${h.send_errors.length ? `<div class="notice err"><b>還不能送出：</b><ul>${h.send_errors.map((m) => `<li>${esc(m)}</li>`).join("")}</ul></div>` : ""}
    ${h.send_warnings.length ? `<div class="notice"><b>提醒：</b><ul>${h.send_warnings.map((m) => `<li>${esc(m)}</li>`).join("")}</ul></div>` : ""}
    <h2>分享文字預覽</h2><pre class="share">${esc(h.share_text)}</pre>
    <button class="btn primary block big" id="send" ${h.send_errors.length ? "disabled" : ""}>送出交接，產生標註圖</button>`;
  const save = async (patch) => {
    if (await run(() => api(`/handoffs/${hid}`, { method: "PATCH", body: patch }))) reload(ctx);
  };
  $("#date", body).addEventListener("change", (e) => save({ handoff_date: e.target.value }));
  $("#giver", body).addEventListener("change", (e) => save({ giver_name: e.target.value }));
  $("#recv", body).addEventListener("change", (e) => save({ receiver_name: e.target.value }));
  $("#note", body).addEventListener("change", (e) => save({ note: e.target.value }));
  body.addEventListener("click", (e) => {
    const b = e.target.closest("[data-r]");
    if (b) save({ receiver_name: b.dataset.r });
  });
  $("#send", body).addEventListener("click", async () => {
    if (h.send_warnings.length && !(await confirmDlg(`還有 ${h.send_warnings.length} 個提醒，確定送出？`, { ok: "送出" }))) return;
    const r = await run(() => api(`/handoffs/${hid}/send`, { method: "POST" }));
    if (r) {
      toast("已送出");
      location.hash = `#/h/${hid}/card`;
    }
  });
}

// ---------- receiver checklist ----------

export async function viewRun(hid, el) {
  const render = async () => {
    const h = await api(`/handoffs/${hid}`);
    if (h.status === "draft") {
      location.hash = `#/h/${hid}/edit/1`;
      return;
    }
    drawRun(h, el, render);
  };
  await render();
}

function stepsCount(items) {
  return { total: items.length, done: items.filter((i) => i.done).length };
}

function problemLine(it) {
  return it.problem_type ? `<small class="prob">⚠ ${esc(PROBLEM_LABEL[it.problem_type])}${it.problem_note ? `：${esc(it.problem_note)}` : ""}${it.problem_by ? `（${esc(it.problem_by)}）` : ""}</small>` : "";
}

function checkRow(it, title, sub, { thumb = false, tag = "", locked = false } = {}) {
  const on = it.done;
  return `<div class="check-row ${on ? "on" : ""}">
    <button class="cbox" data-check="${it.id}" data-v="${on ? 0 : 1}" ${locked ? "disabled" : ""} aria-label="勾選 ${esc(title)}">${on ? "✓" : ""}</button>
    ${thumb ? (it.product_image ? `<img class="thumb" src="${fileUrl(it.product_image)}" alt="">` : `<span class="thumb ph">商品圖</span>`) : ""}
    <span class="grow"><b>${esc(title)}</b><small class="muted">${sub}</small>${problemLine(it)}
      ${it.photo ? `<a href="${fileUrl(it.photo)}" target="_blank" rel="noopener"><img class="photo-sm" src="${fileUrl(it.photo)}" alt="現場照"></a>` : ""}
      ${on && it.done_by ? `<small class="muted">✓ ${esc(it.done_by)} ${esc(fmtTime(it.done_at))}</small>` : ""}</span>
    ${tag}</div>`;
}

const fromLoc = (it) => (it.location_code ? `・倉位 ${esc(it.location_code)}` : "");

function drawRun(h, el, render) {
  const items = h.items;
  const first = items.filter((i) => i.action !== "add").sort((a, b) => (a.label || "").localeCompare(b.label || ""));
  const adds = items.filter((i) => i.action === "add");
  const sc = stepsCount(items);
  const finished = h.status === "done";
  const locked = finished;
  const pct = sc.total ? Math.round((sc.done / sc.total) * 100) : 0;
  const pending = items.filter((i) => !i.done && !i.problem_type).length;
  const cabCodes = h.cabinets.map((c) => c.code);

  const removedOn = {};
  for (const r of items) if (r.action !== "add" && r.layer_id) (removedOn[r.layer_id] ||= []).push(r.display);

  const groups = h.cabinets.map((c) => ({ c, list: adds.filter((i) => i.cabinet_id === c.id) })).filter((g) => g.list.length);
  const noCab = adds.filter((i) => !i.cabinet_id);

  el.innerHTML = `<div class="run-head">
      <small>${h.received ? "收到的・" : ""}交班：${esc(h.giver_name || "未填")}・${esc(fmtTime(h.sent_at))} 送出・接班：${esc(h.receiver_name)}</small>
      <h1>${esc(h.date_label)} 進貨交接</h1>
      <div class="row between"><span>完成 ${sc.done} / ${sc.total}</span><span>${cabCodes.length} 櫃：${esc(cabCodes.join("、"))}</span></div>
      <span class="bar light"><i style="width:${pct}%"></i></span>
    </div>
    ${finished ? `<div class="notice ok">✅ 已由 ${esc(h.done_by || "")} 於 ${esc(fmtTime(h.done_at))} 完成
      ${h.done_photo ? `<a href="${fileUrl(h.done_photo)}" target="_blank" rel="noopener"><img class="photo-done" src="${fileUrl(h.done_photo)}" alt="完成照"></a>` : ""}</div>` : ""}
    ${h.note ? `<div class="notice">📝 ${esc(h.note)}</div>` : ""}
    ${first.length ? `<h2 class="sec"><i class="n n1">1</i>先撤下／移位 <small>騰出空間</small></h2>
      ${first.map((it) => checkRow(it, it.display, it.action === "remove"
        ? `${esc(it.label)} 撤下 → 回倉${it.location_code ? ` ${esc(it.location_code)}` : ""}`
        : `${esc(it.label)} → 移到 ${esc(it.to_label || "？")}`, { tag: `<span class="tag ${ACT_CLS[it.action]}">${ACTION_LABEL[it.action]}</span>`, locked })).join("")}` : ""}
    ${adds.length ? `<h2 class="sec"><i class="n n3">${first.length ? 2 : 1}</i>上架 <small>依櫃位看標註圖</small></h2>
      ${groups.map((g) => `<div class="group"><div class="row between"><b>${esc(g.c.code)} 櫃</b>
        <button class="link" data-stage="${g.c.id}">看標註圖 →</button></div>
        ${g.list.map((it) => checkRow(it, `${it.display} ×${it.qty} 箱`,
          `放 ${esc(it.layer_code)} 層${removedOn[it.layer_id] ? `，原${esc(removedOn[it.layer_id].join("、"))}的位置` : ""}${fromLoc(it)}`,
          { thumb: !!it.product_image, tag: `<span class="tag t-add">上架</span>`, locked })).join("")}</div>`).join("")}
      ${noCab.map((it) => checkRow(it, `${it.display} ×${it.qty} 箱`, `未指定櫃層${fromLoc(it)}`, { thumb: !!it.product_image, tag: `<span class="tag t-add">上架</span>`, locked })).join("")}` : ""}
    ${locked ? "" : `<button class="btn block" id="prob">⚠️ 回報問題（放不下／缺貨）</button>
      <button class="btn block" id="photo">📷 拍現場照</button>
      <button class="btn primary block big" id="done" ${pending ? "disabled" : ""}>📷 ${pending ? `還有 ${pending} 項未完成` : "全部完成，拍完成照"}</button>`}
    <button class="btn block ${finished ? "primary big" : ""}" id="report">📤 傳送目前結果</button>
    <p class="muted small center">勾選只存在這台裝置，對方不會自動看到；做完請按「傳送目前結果」。<br>這張交接單 ${h.days_left} 天後自動刪除</p>
    <div class="row gap center wrap">${h.received ? "" : `<a class="btn sm" href="#/h/${h.id}/card">標註圖與分享文字</a>`}
    ${!h.received && !locked && !items.some((i) => i.done) ? `<button class="btn sm" id="reopen">退回草稿修改</button>` : ""}
    <button class="btn sm danger-text" id="remove">刪除</button></div>`;

  el.onclick = async (e) => {
    const c = e.target.closest("[data-check]");
    if (c && !c.disabled) {
      c.disabled = true;
      const ok = await run(() => api(`/handoffs/${h.id}/items/${c.dataset.check}/check`, { method: "POST",
        body: { field: "done", value: c.dataset.v === "1" } }));
      if (ok) render();
      else c.disabled = false;
      return;
    }
    const st = e.target.closest("[data-stage]");
    if (st) {
      const cab = h.cabinets.find((x) => x.id === +st.dataset.stage);
      const { marks, badges } = marksFor(items, cab.id, { doneAware: true });
      const entries = cabinetEntries(cab, items);
      sheet(`${stageHTML(cab, { marks, badges })}${LEGEND}
        <ol class="entries">${entries.map((x) => `<li class="k-${x.kind}">${esc(x.text)}${x.item.done ? " ✓" : ""}</li>`).join("")}</ol>`, { title: `${cab.code} 標註圖`, wide: true });
      return;
    }
    if (e.target.closest("#prob")) return problemSheet(h, render);
    if (e.target.closest("#photo")) return photoSheet(h, render);
    if (e.target.closest("#done")) return completeSheet(h, render);
    if (e.target.closest("#report")) return reportSheet(h);
    if (e.target.closest("#remove")) {
      if (!(await confirmDlg("從這台裝置刪除這張交接單？刪除後無法還原。", { ok: "刪除", danger: true }))) return;
      if (await run(() => api(`/handoffs/${h.id}`, { method: "DELETE" }))) location.hash = "#/";
      return;
    }
    if (e.target.closest("#reopen")) {
      if (!(await confirmDlg("退回草稿後可以再修改。已經傳出去的連結不會跟著變，改完要重新傳一次。確定？", { ok: "退回草稿" }))) return;
      if (await run(() => api(`/handoffs/${h.id}/reopen`, { method: "POST" }))) location.hash = `#/h/${h.id}/edit/1`;
    }
  };
}

function itemOptions(items, selected) {
  return items.map((i) => `<option value="${i.id}" ${i.id === selected ? "selected" : ""}>${ACTION_LABEL[i.action]}・${esc(i.display)}${i.label ? `（${esc(i.label)}）` : ""}${i.problem_type ? " ⚠" : ""}</option>`).join("");
}

function problemSheet(h, render) {
  const s = sheet(`<label>哪一項<select class="input" data-item>${itemOptions(h.items)}</select></label>
    <p class="label">問題</p>
    <div class="grid-names">${Object.entries(PROBLEM_LABEL).map(([k, t]) => `<button class="btn name" data-t="${k}">${t}</button>`).join("")}</div>
    <label>說明<textarea class="input" data-note rows="2" placeholder="例如：2 層只放得下 1 箱，另 1 箱放回 B-1-1"></textarea></label>
    <button class="btn primary block" data-go>送出回報</button>
    <button class="btn ghost block" data-clear>取消這項的問題回報</button>`, { title: "回報問題" });
  let type = "";
  const sel = $("[data-item]", s.el);
  const sync = () => {
    const it = h.items.find((i) => i.id === +sel.value);
    type = it.problem_type || "";
    $("[data-note]", s.el).value = it.problem_note || "";
    $$("[data-t]", s.el).forEach((b) => b.classList.toggle("primary", b.dataset.t === type));
  };
  sync();
  sel.addEventListener("change", sync);
  s.el.addEventListener("click", async (e) => {
    const t = e.target.closest("[data-t]");
    if (t) {
      type = t.dataset.t;
      $$("[data-t]", s.el).forEach((b) => b.classList.toggle("primary", b === t));
    }
    const go = e.target.closest("[data-go]");
    const clear = e.target.closest("[data-clear]");
    if (go && !type) return toast("請選擇問題類型", "err");
    if (go || clear) {
      const ok = await run(() => api(`/handoffs/${h.id}/items/${sel.value}/problem`, { method: "POST",
        body: { type: clear ? "" : type, note: clear ? "" : $("[data-note]", s.el).value } }));
      if (ok) { s.close(); toast(clear ? "已取消回報" : "已回報"); render(); }
    }
  });
}

function photoSheet(h, render) {
  const s = sheet(`<label>拍哪一項<select class="input" data-item>${itemOptions(h.items)}</select></label>
    <button class="btn primary block" data-go>📷 拍照或選照片</button>
    <p class="muted small">照片只存在這台裝置，要給別人看請另外傳。</p>`, { title: "拍現場照" });
  $("[data-go]", s.el).addEventListener("click", async () => {
    const f = await pickFile({ capture: true });
    if (!f) return;
    const ok = await run(() => api(`/handoffs/${h.id}/items/${$("[data-item]", s.el).value}/photo`, { method: "POST", file: f }));
    if (ok) { s.close(); toast("照片已存在這台裝置"); render(); }
  });
}

function completeSheet(h, render) {
  const probs = h.items.filter((i) => i.problem_type).length;
  const s = sheet(`<p>${probs ? `有 ${probs} 項回報問題。` : "全部項目都完成了。"}完成照會存在這台裝置：</p>
    <button class="btn primary block big" data-photo>📷 拍完成照並完成</button>
    <button class="btn block" data-skip>不拍照，直接完成</button>`, { title: "完成交接" });
  const finish = async (file) => {
    const ok = await run(() => api(`/handoffs/${h.id}/complete`, { method: "POST", file }));
    if (ok) { s.close(); toast("交接完成 🎉"); await render(); reportSheet(h); }
  };
  s.el.addEventListener("click", async (e) => {
    if (e.target.closest("[data-photo]")) {
      const f = await pickFile({ capture: true });
      if (f) finish(f);
    }
    if (e.target.closest("[data-skip]")) finish(null);
  });
}

async function reportSheet(h) {
  const r = await run(() => api(`/handoffs/${h.id}/report`));
  if (!r) return;
  const s = sheet(`<p class="muted small">${h.received ? "把這段文字傳給交班人。對方在建立這張交接單的裝置點連結，就能更新進度。" : "把這段文字傳給需要知道結果的人。"}</p>
    <textarea class="input share" rows="9" readonly data-txt>${esc(r.text)}</textarea>
    <button class="btn primary block" data-copy>📋 複製文字</button>
    ${navigator.share ? `<button class="btn block" data-share>分享…</button>` : ""}`, { title: "傳送目前結果" });
  s.el.addEventListener("click", async (e) => {
    if (e.target.closest("[data-copy]")) toast((await copyText(r.text)) ? "已複製，貼到 LINE 即可" : "無法自動複製，請長按文字複製");
    if (e.target.closest("[data-share]")) shareOrCopy(r.text);
  });
}

// ---------- links from other people ----------

export async function viewIncoming(m, el) {
  const p = readHandoff(await unpack(m[1]));
  const found = await api("/received/find", { method: "POST", body: { uid: p.uid, sent_at: p.sent_at } });
  if (found.own_id) {
    el.innerHTML = `<div class="card narrow"><h1>這是你自己建立的交接單</h1>
      <p class="muted">這個連結是要傳給別人的。</p><a class="btn primary block" href="#/h/${found.own_id}">打開我的交接單</a></div>`;
    return;
  }
  if (found.received_id && !found.changed) {
    location.replace(`#/h/${found.received_id}`);
    return;
  }
  const line = (i) => `<li>${ACTION_LABEL[i.action]}・${esc(i.ext.display)}${i.action === "add" ? ` ×${i.qty} 箱` : ""}
    <small class="muted">${esc(i.ext.label || "")}${i.ext.to_label ? ` → ${esc(i.ext.to_label)}` : ""}${i.ext.location_code ? `・倉位 ${esc(i.ext.location_code)}` : ""}</small></li>`;
  el.innerHTML = `<div class="run-head"><small>收到交接單・交班：${esc(p.giver_name || "未填")} → 接班：${esc(p.receiver_name || "未指定")}</small>
      <h1>${esc(dateLabel(p.handoff_date))} 進貨交接</h1><div>共 ${p.items.length} 項</div></div>
    ${found.changed ? `<div class="notice">這張交接單之前收過，對方後來更新了內容。更新後，同一項目的勾選會保留。</div>` : ""}
    ${p.note ? `<div class="notice">📝 ${esc(p.note)}</div>` : ""}
    <button class="btn primary block big" id="take">${found.changed ? "更新成新內容" : "收下，開始勾選"}</button>
    ${found.changed ? `<a class="btn block" href="#/h/${found.received_id}">不更新，看原本的</a>` : ""}
    <section class="card"><h2>內容</h2><ul class="plain">${p.items.map(line).join("")}</ul></section>
    <p class="muted small">收下後會存在這台裝置的瀏覽器。請確認是認識的人傳來的。</p>`;
  $("#take", el).addEventListener("click", async () => {
    const r = await run(() => api("/received", { method: "POST", body: p }));
    if (r) location.replace(`#/h/${r.id}`);
  });
}

export async function viewReport(m, el) {
  const p = readReport(await unpack(m[1]));
  const h = await api("/report/find", { method: "POST", body: { uid: p.uid } });
  if (!h.id) {
    el.innerHTML = `<div class="card narrow"><h1>這台裝置沒有這張交接單</h1>
      <p>請在建立交接單的手機或電腦，用同一個瀏覽器打開這個連結。如果交接單已刪除或超過 90 天，就不能套用。</p>
      <a class="btn block" href="#/">回首頁</a></div>`;
    return;
  }
  const rows = p.items.map((r) => ({ r, it: h.items.find((i) => i.key === r.key) })).filter((x) => x.it);
  el.innerHTML = `<div class="run-head"><small>收到回報・${esc(p.by || "未填")} ${esc(fmtTime(p.at))}</small>
      <h1>${esc(h.date_label)} 進貨交接</h1><div>回報完成 ${rows.filter((x) => x.r.done).length} / ${h.items.length} 項</div></div>
    ${h.status === "draft" ? `<div class="notice err">這張交接單已退回草稿，不能套用回報。</div>` : `<button class="btn primary block big" id="apply">套用到我的交接單</button>`}
    <section class="card"><h2>回報內容</h2>${rows.length ? `<ul class="plain">${rows.map(({ r, it }) => `<li>${r.done ? "✅" : "⬜"} ${esc(it.label)} ${esc(it.display)}
      ${r.problem_type ? `<small class="prob">⚠ ${esc(PROBLEM_LABEL[r.problem_type])}${r.problem_note ? `：${esc(r.problem_note)}` : ""}</small>` : ""}</li>`).join("")}</ul>` : `<p class="muted">沒有可對應的項目。</p>`}</section>
    <a class="btn block" href="#/h/${h.id}">不套用，看我的交接單</a>`;
  const b = $("#apply", el);
  if (b) b.addEventListener("click", async () => {
    const r = await run(() => api("/report", { method: "POST", body: p }));
    if (r) { toast(`已更新 ${r.applied} 項`); location.replace(`#/h/${r.id}`); }
  });
}

// ---------- card + share ----------

export async function viewCard(hid, el) {
  const h = await api(`/handoffs/${hid}`);
  el.innerHTML = `<div class="page-head"><a class="back" href="${h.status === "draft" ? `#/h/${hid}/edit/4` : `#/h/${hid}`}">‹ 回交接單</a>
      <h1>${esc(h.date_label)} 標註圖與分享</h1>
      ${h.status === "draft" ? `<p class="notice">尚未送出，以下是預覽。</p>` : ""}</div>
    <section class="card"><h2>1. 分享文字</h2>
      <textarea class="input share" id="txt" rows="10" readonly>${esc(h.share_text)}</textarea>
      <div class="row gap"><button class="btn primary grow" id="copy">📋 複製文字</button>
      ${navigator.share ? `<button class="btn grow" id="sharetxt">分享…</button>` : ""}</div>
      ${h.share_link.length > 4000 ? `<p class="notice">內容較多，連結有 ${h.share_link.length} 個字。如果對方點不開，請改傳下面的標註圖。</p>` : ""}
      <p class="muted small">貼到 LINE 群組，對方點連結就能看到清單並在自己的手機勾選，不用帳號。交接內容就包在連結裡，拿到連結的人都看得到，傳出去後無法收回。連結不含照片，請一起傳下面的標註圖。</p></section>
    <section class="card"><h2>2. 櫃位標註圖（${h.cabinets.length} 張）</h2>
      <p class="muted small">長按圖片可儲存或轉傳；電腦可按「下載」。</p>
      <div id="cards">${h.cabinets.length ? `<p class="muted">繪製中…</p>` : `<p class="muted">這張交接單沒有指定櫃層。</p>`}</div></section>
    ${h.status === "sent" ? `<a class="btn block" href="#/h/${hid}">前往勾選清單 →</a>` : ""}`;
  $("#copy", el).addEventListener("click", async () => {
    const ok = await copyText(h.share_text);
    if (ok) toast("已複製，貼到 LINE 即可");
    else {
      const ta = $("#txt", el);
      ta.focus();
      ta.select();
      toast("無法自動複製，文字已選取，請長按複製", "err");
    }
  });
  const st = $("#sharetxt", el);
  if (st) st.addEventListener("click", () => navigator.share({ text: h.share_text }).catch(() => {}));

  const box = $("#cards", el);
  const blobs = [];
  const parts = [];
  for (const cab of h.cabinets) {
    const { canvas } = await drawCard(cab, h.items, { date_label: h.date_label, giver_name: h.giver_name });
    const blob = await canvasToBlob(canvas);
    const url = URL.createObjectURL(blob);
    const name = `${h.handoff_date}_${cab.code}.jpg`;
    blobs.push(new File([blob], name, { type: "image/jpeg" }));
    parts.push(`<figure class="cardimg"><img src="${url}" alt="${esc(cab.code)} 標註圖">
      <figcaption class="row gap"><b class="grow">${esc(cab.code)}</b><a class="btn sm" href="${url}" download="${esc(name)}">下載</a></figcaption></figure>`);
  }
  if (h.cabinets.length) {
    const canFiles = navigator.canShare && blobs.length && navigator.canShare({ files: blobs });
    box.innerHTML = parts.join("") + (canFiles ? `<button class="btn primary block" id="shareimg">分享全部圖片…</button>` : "");
    const si = $("#shareimg", box);
    if (si) si.addEventListener("click", () => navigator.share({ files: blobs, text: h.share_text }).catch(() => {}));
  }
}
