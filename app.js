// Hash router, app shell, name screen, home.
import { api, loadMe, state, esc, $, toast, run, fmtTime } from "./core.js";
import { boot } from "./local.js";
import { loadImages, storageMode } from "./store.js";
import { viewEdit, viewRun, viewCard, viewIncoming, viewReport } from "./handoff.js";
import { viewSetup, viewCabinetEditor } from "./setup.js";
import { viewData } from "./data.js";

let pending = ""; // page to open after typing a name
const main = () => $("#main");

const ROUTES = [
  [/^#\/v\/([\w-]+)$/, viewIncoming],
  [/^#\/r\/([\w-]+)$/, viewReport],
  [/^#\/start$/, viewStart, { open: true }],
  [/^#\/h\/(\d+)\/edit(?:\/([1-4]))?$/, (m, el) => viewEdit(+m[1], +(m[2] || 1), el)],
  [/^#\/h\/(\d+)\/card$/, (m, el) => viewCard(+m[1], el)],
  [/^#\/h\/(\d+)$/, (m, el) => viewRun(+m[1], el)],
  [/^#\/history$/, viewDoneList],
  [/^#\/setup(?:\/(\w+))?$/, (m, el) => viewSetup(m[1] || "products", el)],
  [/^#\/setup\/cabinet\/(\d+)$/, (m, el) => viewCabinetEditor(+m[1], el)],
  [/^#\/data$/, viewData],
  [/^#\/?$/, viewHome],
];

function renderShell() {
  const me = state.me;
  $("#store").textContent = (me && me.store_name) || "ShelfRelay 進貨交接";
  const banner = $("#banner");
  banner.hidden = !me;
  if (me) {
    banner.innerHTML = storageMode() === "memory"
      ? "<b>這個瀏覽器不能儲存資料</b>，關掉頁面就會消失。請關閉無痕模式，或改用 Safari／Chrome 開啟"
      : `資料只存在這台裝置，${me.retention_days} 天後自動刪除・<a href="#/data">備份</a>`;
  }
  const named = !!(me && me.operator_name);
  const op = $("#operator");
  op.hidden = !named;
  if (named) op.textContent = `👤 ${me.operator_name}`;
  const nav = $("#nav");
  nav.hidden = !named;
  if (!named) return;
  const h = location.hash || "#/";
  nav.innerHTML = [["#/", "🏠", "交接"], ["#/history", "🗂️", "紀錄"], ["#/setup", "🧰", "設定"], ["#/data", "💾", "我的資料"]]
    .map(([href, ic, t]) => {
      const on = href === "#/" ? h === "#/" || /^#\/[hvr]\//.test(h) : h.startsWith(href);
      return `<a href="${href}" class="${on ? "on" : ""}"><span>${ic}</span>${t}</a>`;
    }).join("");
}

let turn = 0;
async function route() {
  const mine = ++turn;
  const hash = location.hash || "#/";
  const found = ROUTES.find(([re]) => re.test(hash));
  if (!found) {
    location.replace("#/");
    return;
  }
  const [re, fn, opt = {}] = found;
  // A fresh box per page, so click handlers of the previous page never stay behind.
  const el = document.createElement("div");
  try {
    await loadMe();
    await loadImages();
    if (mine !== turn) return;
    if (!opt.open && !state.me.operator_name) {
      pending = hash;
      location.replace("#/start");
      return;
    }
    renderShell();
    window.scrollTo(0, 0);
    main().replaceChildren(el);
    el.innerHTML = `<p class="muted center pad">載入中…</p>`;
    await fn(hash.match(re), el);
  } catch (e) {
    console.error(e);
    main().replaceChildren(el);
    el.innerHTML = `<div class="card"><p class="err">${esc(e.message || e)}</p><a class="btn" href="#/">回首頁</a></div>`;
  }
  if (mine === turn) renderShell();
}

// ---------- name ----------

async function viewStart(_, el) {
  const me = state.me;
  const first = !me.started;
  const fromLink = /^#\/[vr]\//.test(pending);
  el.innerHTML = `<div class="card narrow"><h1>${me.operator_name ? "換一個名字" : "你的名字？"}</h1>
    <p class="muted">會顯示在交接單和回報上，不用帳號密碼。</p>
    ${me.operators.length ? `<div class="grid-names">${me.operators.map((n) => `<button class="btn name ${n === me.operator_name ? "primary" : ""}" data-n="${esc(n)}">${esc(n)}</button>`).join("")}</div>` : ""}
    <form id="f"><input class="input" name="n" placeholder="名字或暱稱" maxlength="30" autocomplete="nickname" required>
    ${first && !fromLink ? `<label class="check"><input type="checkbox" name="sample" checked> 放入範例資料，先試試看</label>` : ""}
    <button class="btn primary block">開始使用</button></form>
    <p class="muted small">資料只存在這台裝置的瀏覽器，不會上傳。換裝置、換瀏覽器或清除瀏覽資料就看不到，請定期備份。</p></div>`;
  const go = async (name, sample) => {
    if (!(await run(() => api("/operator", { method: "POST", body: { name } })))) return;
    if (first && !fromLink) await run(() => api("/start", { method: "POST", body: { sample } }));
    toast(`你好，${name}`);
    const to = pending || "#/";
    pending = "";
    location.replace(to);
  };
  el.addEventListener("click", (e) => {
    const b = e.target.closest("[data-n]");
    if (b) go(b.dataset.n, false);
  });
  $("#f", el).addEventListener("submit", (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    go(String(fd.get("n")).trim(), !!fd.get("sample"));
  });
}

// ---------- home ----------

const STATUS = { draft: ["草稿", "s-draft"], sent: ["待完成", "s-sent"], done: ["已完成", "s-done"] };

function handoffRow(h) {
  const p = h.progress;
  const [st, cls] = STATUS[h.status];
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
  return `<a class="list-row hrow" href="${h.status === "draft" ? `#/h/${h.id}/edit` : `#/h/${h.id}`}">
    <span class="grow"><b>${esc(h.date_label)}</b> <span class="tag ${cls}">${st}</span>
      ${h.received ? `<span class="tag s-auto">收到的</span>` : ""}
      ${p.problems ? `<span class="tag s-prob">問題 ${p.problems}</span>` : ""}
      <small class="muted">交班 ${esc(h.giver_name || "未填")} → 接班 ${esc(h.receiver_name || "未指定")}
      ${h.cabinets.length ? `・${esc(h.cabinets.join("、"))}` : ""}・<span class="${h.days_left <= 7 ? "warn-inline" : ""}">${h.days_left} 天後刪除</span>
      ${h.status === "done" ? `・完成 ${esc(fmtTime(h.done_at))} ${esc(h.done_by || "")}` : ""}</small>
      ${h.status === "draft" ? "" : `<span class="bar"><i style="width:${pct}%"></i></span>`}</span>
    <span class="num">${p.done}/${p.total}</span></a>`;
}

async function viewHome(_, el) {
  const list = await api("/handoffs?scope=active");
  el.innerHTML = `<div class="hero"><button class="btn primary big" id="new">＋ 建立進貨交接</button></div>
    <h2>進行中</h2>
    <div class="list">${list.length ? list.map(handoffRow).join("") : `<p class="muted pad">目前沒有進行中的交接單。</p>`}</div>`;
  $("#new", el).addEventListener("click", async () => {
    const r = await run(() => api("/handoffs", { method: "POST" }));
    if (r) location.hash = `#/h/${r.id}/edit/1`;
  });
}

async function viewDoneList(_, el) {
  const list = await api("/handoffs?scope=done");
  el.innerHTML = `<h1>已完成的交接</h1>
    <div class="list">${list.length ? list.map(handoffRow).join("") : `<p class="muted pad">還沒有完成的交接單。</p>`}</div>`;
}

// ---------- start ----------

window.addEventListener("hashchange", route);
document.addEventListener("click", (e) => {
  if (e.target.closest("#operator")) location.hash = "#/start";
});
boot().catch((e) => {
  console.error(e);
  toast(e.message || String(e), "err");
}).then(route);
