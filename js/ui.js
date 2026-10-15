// v1.16 — the app's own pop-ups, messages and motion. Nothing here reads or writes saved data.
//
// The page is redrawn from scratch on most taps (app.js → shell()), so everything here lives outside
// #app: the question sheet and the message bar survive redraws, and bar animations compare the page
// before and after a redraw.

const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function motionAllowed() {
  return !!Element.prototype.animate && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

// ---------- Question sheet (replaces the browser's confirm() and alert()) ----------
let askDialog = null;
function askEl() {
  if (askDialog) return askDialog;
  askDialog = document.createElement("dialog");
  askDialog.className = "ask-sheet";
  askDialog.setAttribute("aria-labelledby", "ask-title");
  askDialog.setAttribute("aria-describedby", "ask-message");
  askDialog.innerHTML = `<div class="ask-card"><div class="ask-copy"><h2 id="ask-title"></h2><div id="ask-message" class="ask-message"></div></div><div class="ask-actions"><button type="button" class="btn" id="ask-ok">OK</button><button type="button" class="btn ghost" id="ask-cancel">Cancel</button></div></div>`;
  document.body.appendChild(askDialog);
  return askDialog;
}
let askQueue = Promise.resolve();
// Resolves true (the main button) or false (Cancel, a tap outside, Escape). Questions asked while one is
// showing wait their turn, so two never overlap. With { alertOnly: true } there is a single OK button.
export function askConfirm(title, message = "", { ok = "OK", cancel = "Cancel", danger = false, alertOnly = false } = {}) {
  const ask = () =>
    new Promise((resolve) => {
      const dlg = askEl();
      if (!dlg.showModal) {
        const text = [title, message].filter(Boolean).join("\n\n");
        if (alertOnly) {
          window.alert(text);
          return resolve(true);
        }
        return resolve(window.confirm(text));
      }
      // Put the keyboard away: the sheet is the only thing to answer, and closing it must not refocus a field.
      const focused = document.activeElement;
      if (focused?.matches?.("input, textarea, select")) focused.blur();
      dlg.querySelector("#ask-title").textContent = title;
      dlg.querySelector("#ask-message").innerHTML = String(message || "")
        .split(/\n{2,}/)
        .filter((p) => p.trim())
        .map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`)
        .join("");
      const okBtn = dlg.querySelector("#ask-ok"),
        cancelBtn = dlg.querySelector("#ask-cancel");
      okBtn.textContent = ok;
      okBtn.className = `btn${danger ? " danger" : ""}`;
      cancelBtn.textContent = cancel;
      cancelBtn.hidden = alertOnly;
      const openedAt = Date.now();
      let settled = false;
      const finish = (answer) => {
        if (settled) return;
        settled = true;
        okBtn.onclick = cancelBtn.onclick = dlg.onclick = dlg.oncancel = null;
        if (dlg.open) dlg.close();
        resolve(answer);
      };
      okBtn.onclick = () => finish(true);
      cancelBtn.onclick = () => finish(false);
      dlg.oncancel = (e) => {
        e.preventDefault();
        finish(alertOnly);
      };
      // Tapping the dimmed page means "no" — but not the end of the very tap that opened the sheet.
      dlg.onclick = (e) => {
        if (e.target === dlg && Date.now() - openedAt > 450) finish(alertOnly);
      };
      dlg.showModal();
      (alertOnly ? okBtn : cancelBtn).focus({ preventScroll: true });
    });
  const answer = askQueue.then(ask, ask);
  askQueue = answer.catch(() => {});
  return answer;
}
export function notify(title, message = "") {
  return askConfirm(title, message, { alertOnly: true });
}

// ---------- Errors ----------
// A problem with what was typed shows inside the open pop-up, right above its button, so nothing typed is
// lost. Anything else gets the message sheet.
export function showError(err) {
  const msg = String(err?.message || err || "Something went wrong.");
  const form = document.querySelector(".modal form");
  const submit = form?.querySelector("button:not([type=button]), button[type=submit]");
  if (form && submit) {
    let box = form.querySelector(".form-error");
    if (!box) {
      box = document.createElement("div");
      box.className = "form-error";
      box.setAttribute("role", "alert");
    }
    box.textContent = msg;
    submit.before(box);
    box.classList.remove("shake");
    void box.offsetWidth;
    if (motionAllowed()) box.classList.add("shake");
    box.scrollIntoView({ block: "nearest", behavior: motionAllowed() ? "smooth" : "auto" });
    return;
  }
  notify("Couldn't do that", msg);
}

// ---------- Message bar ----------
let toastEl = null,
  toastTimer = 0;
export function toast(text, tone = "") {
  if (!toastEl) {
    toastEl = document.createElement("div");
    toastEl.className = "toast";
    toastEl.setAttribute("role", "status");
    toastEl.setAttribute("aria-live", "polite");
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = text;
  toastEl.className = `toast show${tone ? ` ${tone}` : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2600);
}

// ---------- Bars and rings ----------
// Every bar fill carries data-bar="<key>" and every ring segment data-arc="<key>". When a screen is opened
// they fill from empty; after a change on the same screen (an expense saved) they move from where they
// were to where they are now; a bar that wasn't there before grows from data-from (or empty). Nothing
// animates when nothing changed, so opening a pop-up stays still. data-axis="y" bars grow upwards.
const BAR_SEL = "[data-bar]",
  ARC_SEL = "[data-arc]";
export function snapshotBars(scope) {
  const bars = new Map(),
    arcs = new Map();
  scope.querySelectorAll(BAR_SEL).forEach((el) => bars.set(el.dataset.bar, el.dataset.axis === "y" ? el.style.height : el.style.width));
  scope.querySelectorAll(ARC_SEL).forEach((el) =>
    arcs.set(el.dataset.arc, [el.getAttribute("stroke-dasharray"), el.getAttribute("stroke-dashoffset")]),
  );
  return { bars, arcs };
}
let barWatcher = null;
const pending = new Map();
function watch(el, anim) {
  if (!("IntersectionObserver" in window)) return false;
  barWatcher ||= new IntersectionObserver(
    (entries) => {
      let n = 0;
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        const a = pending.get(e.target);
        barWatcher.unobserve(e.target);
        pending.delete(e.target);
        if (!a) return;
        a.effect?.updateTiming?.({ delay: Math.min(n++, 8) * 40 });
        a.play();
      });
    },
    { threshold: 0.2 },
  );
  anim.pause();
  anim.currentTime = 0;
  pending.set(el, anim);
  barWatcher.observe(el);
  return true;
}
export function animateBars(scope, before, entering) {
  if (entering) {
    barWatcher?.disconnect();
    pending.clear();
  }
  if (!motionAllowed()) return;
  const ease = "cubic-bezier(.2,.8,.2,1)";
  let n = 0;
  scope.querySelectorAll(BAR_SEL).forEach((el) => {
    const prop = el.dataset.axis === "y" ? "height" : "width",
      to = el.style[prop],
      known = before?.bars.has(el.dataset.bar),
      from = entering ? "0%" : known ? before.bars.get(el.dataset.bar) : el.dataset.from || "0%";
    if (!to || from == null || from === to || ((entering || !known) && !(parseFloat(to) > 0) && !el.dataset.from)) return;
    if (!el.getClientRects().length) return;
    const r = el.getBoundingClientRect(),
      onScreen = r.bottom > 0 && r.top < window.innerHeight;
    const anim = el.animate([{ [prop]: from || "0%" }, { [prop]: to }], {
      duration: entering ? 650 : el.dataset.from ? 900 : 520,
      delay: entering && onScreen ? Math.min(n++, 10) * 40 : 0,
      easing: ease,
      fill: "backwards",
    });
    if (entering && !onScreen) watch(el, anim);
  });
  // Ring segments: on opening, sweep round one after another; after a change, grow or shrink in place.
  const segs = [...scope.querySelectorAll(ARC_SEL)];
  const circ = (el) => Number(String(el.getAttribute("stroke-dasharray") || "0 0").split(/[ ,]+/)[1]) || 0;
  segs.forEach((el) => {
    const dash = el.getAttribute("stroke-dasharray"),
      off = el.getAttribute("stroke-dashoffset") || "0",
      C = circ(el),
      len = Number(String(dash).split(/[ ,]+/)[0]) || 0;
    if (!C) return;
    if (entering) {
      const start = Math.abs(Number(off)) / C;
      el.animate([{ strokeDasharray: `0 ${C}` }, { strokeDasharray: dash }], {
        duration: Math.max(120, (len / C) * 900),
        delay: 120 + start * 900,
        easing: "linear",
        fill: "backwards",
      });
      return;
    }
    const prev = before?.arcs.get(el.dataset.arc);
    const [pDash, pOff] = prev || [`0 ${C}`, off];
    if (pDash === dash && pOff === off) return;
    el.animate(
      [
        { strokeDasharray: pDash, strokeDashoffset: pOff },
        { strokeDasharray: dash, strokeDashoffset: off },
      ],
      { duration: 520, easing: ease, fill: "backwards" },
    );
  });
}

// ---------- Keyboard ----------
// On phones, keep a pop-up's bottom edge above the on-screen keyboard while you type in it.
export function watchKeyboard() {
  const vv = window.visualViewport;
  if (!vv) return;
  const update = () => {
    const el = document.activeElement,
      typing = el?.closest?.(".modal, dialog[open]") && el.matches("input, textarea, select");
    const gap = Math.round(window.innerHeight - vv.height - vv.offsetTop);
    document.documentElement.style.setProperty("--kb", typing && gap > 120 ? `${gap}px` : "0px");
  };
  vv.addEventListener("resize", update);
  vv.addEventListener("scroll", update);
  document.addEventListener("focusin", update);
  document.addEventListener("focusout", () => setTimeout(update, 60));
}
