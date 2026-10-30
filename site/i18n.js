/* 誰でも見られるページの言語切り替え(日本語 / English)。
 *
 *   I18N.t("日本語", "English")  … 今の言語の方を返す
 *   I18N.lang                    … "ja" か "en"
 *   I18N.button(要素)            … 「Language」ボタンを置く(押すと言語を選べる)
 *   I18N.onChange(関数)          … 言語が変わったら呼ばれる(描き直し用)
 *
 * HTML に書いた文章は data-en="英語" を付けておけば自動で切り替わる
 * (日本語は元の中身を使う)。入力欄の placeholder は data-en-placeholder。
 * 選んだ言語はこの端末に覚えておく。初めての人はスマホの言語設定で決める。
 */
window.I18N = (function () {
  const KEY = "supaken.lang";
  const LANGS = [{ id: "ja", name: "日本語" }, { id: "en", name: "English" }];
  const subs = [];

  let lang = (() => {
    try {
      const v = localStorage.getItem(KEY);
      if (LANGS.some((l) => l.id === v)) return v;
    } catch {}
    return /^ja\b/i.test(navigator.language || "") ? "ja" : "en";
  })();

  const t = (ja, en) => (lang === "en" ? en : ja);

  function apply(root) {
    document.documentElement.lang = lang;
    (root || document).querySelectorAll("[data-en]").forEach((el) => {
      if (el.dataset.ja == null) el.dataset.ja = el.innerHTML;
      el.innerHTML = lang === "en" ? el.dataset.en : el.dataset.ja;
    });
    (root || document).querySelectorAll("[data-en-placeholder]").forEach((el) => {
      if (el.dataset.jaPlaceholder == null) el.dataset.jaPlaceholder = el.placeholder;
      el.placeholder = lang === "en" ? el.dataset.enPlaceholder : el.dataset.jaPlaceholder;
    });
    document.querySelectorAll(".lang-menu [data-lang]").forEach((b) => b.classList.toggle("on", b.dataset.lang === lang));
  }

  function set(next) {
    if (!LANGS.some((l) => l.id === next) || next === lang) return;
    lang = next;
    try { localStorage.setItem(KEY, lang); } catch {}
    apply();
    subs.forEach((fn) => { try { fn(lang); } catch {} });
  }

  const CSS = `
  .lang-wrap { position: relative; flex-shrink: 0; }
  .lang-btn { font-size: 12px !important; padding: 6px 10px !important; display: inline-flex !important; align-items: center; gap: 5px; }
  .lang-btn svg { width: 14px; height: 14px; fill: currentColor; }
  .lang-menu {
    position: absolute; right: 0; top: calc(100% + 6px); z-index: 50; min-width: 140px; padding: 6px;
    border-radius: 12px; background: #0b1f4a; border: 2px solid var(--panel-edge, #3a6fd8);
    box-shadow: 0 8px 20px rgba(0,0,0,0.45);
  }
  .lang-menu[hidden] { display: none; }
  .lang-menu button {
    display: block; width: 100%; text-align: left; font: inherit; font-size: 13px; font-weight: 800;
    color: var(--ink, #fff); background: none; border: 0; border-radius: 8px; padding: 9px 10px; cursor: pointer;
  }
  .lang-menu button.on { color: #3d2600; background: linear-gradient(180deg, var(--gold-lite, #ffe89a), var(--gold, #ffd23f)); }
  .lang-menu button.on::after { content: " ✓"; }
  `;
  const GLOBE = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm6.9 6h-3a15.7 15.7 0 0 0-1.4-3.6A8 8 0 0 1 18.9 8zM12 4c.8 1.1 1.5 2.5 1.9 4h-3.8c.4-1.5 1.1-2.9 1.9-4zM4.3 14a8 8 0 0 1 0-4h3.4a16.5 16.5 0 0 0 0 4zm.8 2h3a15.7 15.7 0 0 0 1.4 3.6A8 8 0 0 1 5.1 16zm3-8h-3a8 8 0 0 1 4.4-3.6A15.7 15.7 0 0 0 8.1 8zM12 20c-.8-1.1-1.5-2.5-1.9-4h3.8c-.4 1.5-1.1 2.9-1.9 4zm2.3-6H9.7a14.7 14.7 0 0 1 0-4h4.6a14.7 14.7 0 0 1 0 4zm.2 5.6a15.7 15.7 0 0 0 1.4-3.6h3a8 8 0 0 1-4.4 3.6zm1.8-5.6a16.5 16.5 0 0 0 0-4h3.4a8 8 0 0 1 0 4z"/></svg>`;

  function button(host) {
    if (!document.getElementById("i18n-css")) {
      const st = document.createElement("style");
      st.id = "i18n-css";
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    const wrap = document.createElement("span");
    wrap.className = "lang-wrap";
    wrap.innerHTML = `<button class="cr-btn lang-btn" type="button" aria-haspopup="true">${GLOBE}Language</button>
      <div class="lang-menu" hidden>${LANGS.map((l) => `<button type="button" data-lang="${l.id}">${l.name}</button>`).join("")}</div>`;
    const btn = wrap.querySelector(".lang-btn");
    const menu = wrap.querySelector(".lang-menu");
    btn.onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; };
    menu.querySelectorAll("[data-lang]").forEach((b) => {
      b.onclick = () => { menu.hidden = true; set(b.dataset.lang); };
    });
    document.addEventListener("click", () => { menu.hidden = true; });
    host.appendChild(wrap);
    apply();
    return wrap;
  }

  // ページを読んだらすぐ、HTML に書いた文章を今の言語にする
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => apply());
  else apply();

  return {
    get lang() { return lang; },
    LANGS, t, set, apply, button,
    onChange(fn) { subs.push(fn); },
    // 日時の表示に使う言語(toLocaleString 用)
    get locale() { return lang === "en" ? "en-US" : "ja-JP"; },
  };
})();
