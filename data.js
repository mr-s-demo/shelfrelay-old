// Backup, restore, basic-data file, clear.
import { api, state, esc, $, toast, run, confirmDlg, pickFile, saveFile, loadMe } from "./core.js";
import { loadImages } from "./store.js";

const stampName = () => new Date().toISOString().slice(0, 10);

// Phones: share sheet (save to Files, LINE...). Computers: download.
async function deliver(name, text) {
  try {
    const f = new File([text], name, { type: "application/json" });
    if (navigator.canShare && navigator.canShare({ files: [f] }) && matchMedia("(pointer: coarse)").matches) {
      await navigator.share({ files: [f] });
      return;
    }
  } catch (e) {
    if (e && e.name === "AbortError") return;
  }
  saveFile(name, text);
  toast("已下載");
}

export async function viewData(_, el) {
  const me = state.me;
  el.innerHTML = `<h1>我的資料</h1>
    <div class="notice">資料只存在這台裝置的這個瀏覽器。清除瀏覽資料、換裝置或換瀏覽器就看不到；iPhone 的 Safari 若約 7 天沒打開這個網站，也可能自動清掉。重要的請備份。</div>
    <section class="card"><h2>備份與還原</h2>
      <p class="muted small">備份包含交接單、商品、櫃體和照片。還原會<b>取代</b>這台裝置目前的資料。</p>
      <button class="btn primary block" id="full">💾 下載備份檔</button>
      <button class="btn block" id="restore">📂 從備份檔還原</button></section>
    <section class="card"><h2>給夥伴同一份基本資料</h2>
      <p class="muted small">基本資料檔只有商品、倉位、櫃體和照片、人員名單，不含交接單。夥伴加入後，相同貨號、倉位或櫃號會更新，其他資料保留。</p>
      <button class="btn block" id="master">📤 匯出基本資料檔</button>
      <button class="btn block" id="merge">📥 加入基本資料檔</button></section>
    <section class="card"><h2>顯示名稱</h2>
      <form id="f" class="row gap"><input class="input grow" name="s" maxlength="40" placeholder="店名，可留空" value="${esc(me.store_name)}">
      <button class="btn">儲存</button></form>
      <a class="btn block" href="#/start">👤 換名字（目前：${esc(me.operator_name)}）</a></section>
    <section class="card"><h2>清除</h2>
      <button class="btn block" id="sample">放入範例資料</button>
      <button class="btn danger block" id="clear">清除這台裝置的全部資料</button></section>`;

  $("#full", el).addEventListener("click", () => run(async () =>
    deliver(`ShelfRelay備份_${stampName()}.json`, await api("/backup?full"))));
  $("#master", el).addEventListener("click", () => run(async () =>
    deliver(`ShelfRelay基本資料_${stampName()}.json`, await api("/backup?master"))));
  $("#restore", el).addEventListener("click", async () => {
    const file = await pickFile({ accept: ".json,.txt,application/json,text/plain" });
    if (!file) return;
    if (!(await confirmDlg("還原會取代這台裝置目前的全部資料，確定？", { ok: "還原", danger: true }))) return;
    const r = await run(() => api("/restore", { method: "POST", file }));
    if (!r) return;
    await loadImages();
    toast(`已還原 ${r.handoffs} 張交接單、${r.products} 項商品`);
    location.hash = "#/";
  });
  $("#merge", el).addEventListener("click", async () => {
    const file = await pickFile({ accept: ".json,.txt,application/json,text/plain" });
    if (!file) return;
    const r = await run(() => api("/merge", { method: "POST", file }));
    if (!r) return;
    await loadImages();
    toast(`已加入商品 ${r.products}、倉位 ${r.locations}、櫃體 ${r.cabinets}、人員 ${r.staff}`);
  });
  $("#f", el).addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!(await run(() => api("/settings", { method: "POST", body: { store_name: new FormData(e.target).get("s") } })))) return;
    await loadMe();
    $("#store").textContent = state.me.store_name || "ShelfRelay 進貨交接";
    toast("已儲存");
  });
  $("#sample", el).addEventListener("click", async () => {
    if (await run(() => api("/start", { method: "POST", body: { sample: true } }))) {
      toast("已放入範例資料");
      location.hash = "#/";
    }
  });
  $("#clear", el).addEventListener("click", async () => {
    if (!(await confirmDlg("會刪除這台裝置上的全部交接單、商品、櫃體和照片，無法還原。確定？", { ok: "全部刪除", danger: true }))) return;
    if (await run(() => api("/clear", { method: "POST" }))) {
      toast("已清除");
      location.hash = "#/";
    }
  });
}
