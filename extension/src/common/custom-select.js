/**
 * Replaces the visual UI of <select> with a fully styled dropdown
 * (Instrument style). The native element stays in the DOM (hidden) so all
 * existing code keeps working: .value reads/writes, .options, and "change"
 * events behave exactly as before.
 */

const SYNC_EVENT = "bt:select-sync";
const openWraps = new Set();
const observedRoots = new WeakSet();
const boundDocs = new WeakSet();
let patchesInstalled = false;

const COMPACT_SELECTOR = [
  ".bt-position-select",
  ".bt-suggestion-provider-select",
  ".bt-selection-source-select",
  ".bt-selection-target-select",
  ".bt-selection-provider-select"
].join(", ");

// Programmatic sets (select.value = x, option.selected = true) don't emit
// events — patch the setters once per realm so custom UI stays in sync.
function installSyncPatches() {
  if (patchesInstalled || typeof HTMLSelectElement === "undefined") return;
  patchesInstalled = true;

  const patch = (proto, prop, getSelect) => {
    const d = Object.getOwnPropertyDescriptor(proto, prop);
    if (!d || !d.set || !d.get) return;
    Object.defineProperty(proto, prop, {
      configurable: true,
      enumerable: d.enumerable,
      get: d.get,
      set(v) {
        d.set.call(this, v);
        const s = getSelect(this);
        if (s) s.dispatchEvent(new CustomEvent(SYNC_EVENT));
      }
    });
  };

  patch(HTMLSelectElement.prototype, "value", (el) => el);
  patch(HTMLSelectElement.prototype, "selectedIndex", (el) => el);
  patch(HTMLOptionElement.prototype, "selected", (el) => el.closest("select"));
}

function bindDocument(doc) {
  if (boundDocs.has(doc)) return;
  boundDocs.add(doc);
  doc.addEventListener(
    "pointerdown",
    (e) => {
      for (const w of [...openWraps]) {
        if (!w.contains(e.target)) setOpen(w, false);
      }
    },
    true
  );
  doc.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      for (const w of [...openWraps]) setOpen(w, false);
    }
  });
  // Pickers are anchored to their control — re-check flip on viewport resize.
  doc.defaultView?.addEventListener("resize", () => {
    for (const w of [...openWraps]) setOpen(w, false);
  });
}

function setOpen(wrap, open) {
  const state = wrapState.get(wrap);
  if (!state || state.open === open) return;
  state.open = open;
  const { btn, list, select } = state;
  list.hidden = !open;
  btn.setAttribute("aria-expanded", String(open));
  wrap.classList.toggle("is-open", open);
  if (open) {
    openWraps.add(wrap);
    // Flip upward when there is more room above than below.
    const r = btn.getBoundingClientRect();
    const win = (wrap.ownerDocument || document).defaultView;
    const below = win ? win.innerHeight - r.bottom : 400;
    const above = r.top;
    list.classList.toggle("is-dropup", below < 260 && above > below);
    state.activeIndex = select.selectedIndex;
    markActive(state);
    list.querySelector(".is-selected")?.scrollIntoView({ block: "nearest" });
  } else {
    openWraps.delete(wrap);
  }
}

function markActive(state) {
  state.list
    .querySelectorAll(".bt-select-option")
    .forEach((el, i) =>
      el.classList.toggle("is-active", i === state.activeIndex)
    );
}

function moveActive(state, delta) {
  const count = state.list.childElementCount;
  if (!count) return;
  state.activeIndex = (state.activeIndex + delta + count) % count;
  markActive(state);
  state.list.children[state.activeIndex]?.scrollIntoView({ block: "nearest" });
}

const wrapState = new WeakMap();

export function enhanceSelect(select) {
  if (
    !(select instanceof HTMLSelectElement) ||
    select.dataset.btSelect !== undefined ||
    select.multiple ||
    select.size > 1
  ) {
    return;
  }
  installSyncPatches();
  const doc = select.ownerDocument;
  bindDocument(doc);

  const tabIndex = select.tabIndex;
  select.dataset.btSelect = "";
  select.classList.add("bt-native-select");
  select.tabIndex = -1;
  select.setAttribute("aria-hidden", "true");

  const wrap = doc.createElement("div");
  wrap.className = "bt-select";
  if (select.matches(COMPACT_SELECTOR))
    wrap.classList.add("bt-select--compact");

  const btn = doc.createElement("button");
  btn.type = "button";
  btn.className = "bt-select-btn";
  if (tabIndex < 0) btn.tabIndex = -1;
  btn.setAttribute("aria-haspopup", "listbox");
  btn.setAttribute("aria-expanded", "false");
  btn.innerHTML =
    '<span class="bt-select-label"></span>' +
    '<svg class="bt-select-caret" viewBox="0 0 10 6" aria-hidden="true">' +
    '<path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" ' +
    'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>' +
    "</svg>";

  const list = doc.createElement("div");
  list.className = "bt-select-list";
  list.setAttribute("role", "listbox");
  list.hidden = true;

  select.parentNode.insertBefore(wrap, select);
  wrap.append(select, btn, list);

  const state = { btn, list, select, open: false, activeIndex: 0 };
  wrapState.set(wrap, state);

  const label = btn.querySelector(".bt-select-label");

  const sync = () => {
    const cur = select.options[select.selectedIndex];
    label.textContent = cur ? cur.textContent : "";
    list
      .querySelectorAll(".bt-select-option")
      .forEach((el, i) =>
        el.classList.toggle("is-selected", i === select.selectedIndex)
      );
    wrap.classList.toggle("is-disabled", select.disabled);
  };

  const rebuild = () => {
    list.textContent = "";
    [...select.options].forEach((opt, i) => {
      const item = doc.createElement("button");
      item.type = "button";
      item.className = "bt-select-option";
      item.setAttribute("role", "option");
      item.disabled = opt.disabled;
      item.innerHTML =
        '<svg class="bt-select-check" viewBox="0 0 10 10" aria-hidden="true">' +
        '<path d="M1.8 5.2 4 7.4 8.2 2.8" fill="none" stroke="currentColor" ' +
        'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>' +
        "</svg><span></span>";
      item.lastElementChild.textContent = opt.textContent;
      item.addEventListener("click", () => {
        select.selectedIndex = i;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        setOpen(wrap, false);
        btn.focus();
      });
      list.appendChild(item);
    });
    sync();
  };

  btn.addEventListener("click", () => setOpen(wrap, !state.open));

  btn.addEventListener("keydown", (e) => {
    if (!state.open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
        e.preventDefault();
        setOpen(wrap, true);
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveActive(state, 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveActive(state, -1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      list.children[state.activeIndex]?.click();
    } else if (e.key === "Home") {
      e.preventDefault();
      state.activeIndex = 0;
      markActive(state);
    } else if (e.key === "End") {
      e.preventDefault();
      state.activeIndex = list.childElementCount - 1;
      markActive(state);
    } else if (e.key === "Tab") {
      setOpen(wrap, false);
    }
  });

  select.addEventListener("change", sync);
  select.addEventListener(SYNC_EVENT, sync);

  new MutationObserver(() => {
    rebuild();
  }).observe(select, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["disabled", "selected", "label", "hidden"]
  });

  rebuild();
}

/**
 * Enhances every <select> under root. With observe=true (default) a
 * MutationObserver also enhances selects added later — needed for
 * dynamically-rendered rows (domain lists, provider forms).
 */
export function enhanceSelects(root = document.body, { observe = true } = {}) {
  if (!root) return;
  installSyncPatches();
  bindDocument(root.ownerDocument || document);

  const scan = (node) => {
    if (node instanceof HTMLSelectElement) {
      enhanceSelect(node);
    } else if (node instanceof HTMLElement || node === root.ownerDocument) {
      node.querySelectorAll?.("select").forEach(enhanceSelect);
    }
  };

  scan(root);
  if (!observe || observedRoots.has(root)) return;
  observedRoots.add(root);
  new MutationObserver((muts) => {
    for (const m of muts) m.addedNodes.forEach(scan);
  }).observe(root, { childList: true, subtree: true });
}
