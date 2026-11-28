/* Private to the guest's isolated world. Only rendered, non-editable labels become translation inputs. */
(() => {
  const { ipcRenderer } = require("electron");
  const skip =
    "script,style,template,noscript,code,pre,math,.katex,mjx-container,textarea,select,option,[contenteditable]:not([contenteditable=false]),[translate=no]";
  const selector =
    "button,a,label,span,p,div,td,th,dt,dd,li,strong,b,i,em,summary,h1,h2,h3,h4,output,text,tspan,[title],[aria-label],[placeholder],[role=tooltip],iframe,canvas";
  const captioned = "input:is([type=button],[type=submit],[type=reset])";
  const attrs = ["title", "aria-label", "placeholder"];
  const captions = new Map();
  let captionId = 0;
  function removeCaption(el) {
    const item = captions.get(el);
    if (!item) return;
    for (const [key, value, priority] of item.styles) el.style.setProperty(key, value, priority);
    item.label.remove();
    captions.delete(el);
  }
  function showCaption(el, text) {
    let item = captions.get(el);
    if (!text || !CSS.supports("left", "anchor(center)")) {
      removeCaption(el);
      return;
    }
    if (!item) {
      const css = getComputedStyle(el);
      const anchor = "--easyread-caption-" + ++captionId;
      const previous = css.anchorName;
      const styles = ["anchor-name", "-webkit-text-fill-color"].map((key) => [
        key,
        el.style.getPropertyValue(key),
        el.style.getPropertyPriority(key),
      ]);
      const label = el.ownerDocument.createElement("span");
      label.setAttribute("translate", "no");
      label.setAttribute("aria-hidden", "true");
      label.style.cssText =
        "position:absolute;pointer-events:none;left:anchor(center);top:anchor(center);translate:-50% -50%;width:max-content;max-width:anchor-size(width);overflow:hidden;white-space:nowrap;text-align:center";
      Object.assign(label.style, {
        positionAnchor: anchor,
        font: css.font,
        color: css.color,
        zIndex: css.zIndex,
      });
      el.style.setProperty(
        "anchor-name",
        previous && previous !== "none" ? previous + ", " + anchor : anchor,
      );
      el.style.setProperty("-webkit-text-fill-color", "transparent", "important");
      el.after(label);
      item = { label, styles };
      captions.set(el, item);
    }
    if (item.label.textContent !== text) item.label.textContent = text;
  }
  const roots = new Map(),
    onscreen = new Set(),
    candidates = new Set(),
    originals = new Map();
  let seen = new WeakSet();
  const requested = new Map(),
    frames = new Map();
  let state,
    io,
    timer,
    enabled = false,
    shown = false;
  const clean = (s) =>
    String(s || "")
      .replace(/[\u202a-\u202e\u2066-\u2069]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  const useful = (s) => s.length >= 2 && s.length <= 1500 && /\p{L}/u.test(s);
  const blocked = (el) => el.closest(skip) || el.isContentEditable;
  function apply(el, collect) {
    if (!el.isConnected || blocked(el) || !state) return;
    if (!el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) return;
    if (el.matches(captioned)) {
      const key = clean(el.value);
      if (useful(key)) {
        if (enabled) showCaption(el, state.display(key));
        if (!state.known(key)) collect(key);
      } else removeCaption(el);
    } else if (captions.has(el)) removeCaption(el);
    for (const node of el.childNodes) {
      if (node.nodeType !== 3) continue;
      const key = clean(state.source(node));
      if (!useful(key)) continue;
      if (state.known(key)) {
        if (enabled) state.translate(node);
      } else collect(key);
    }
    for (const attr of attrs) {
      const value = el.getAttribute(attr);
      if (!value || (attr === "aria-label" && el.ownerSVGElement)) continue;
      const map = originals.get(el),
        old = map?.get(attr);
      const source = old?.value === value ? old.source : value,
        key = clean(source);
      if (!useful(key)) continue;
      const target = state.display(source);
      if (!target) {
        if (!state.known(key)) collect(key);
        continue;
      }
      if (target === value) continue;
      if (!map) originals.set(el, new Map());
      originals.get(el).set(attr, { source, value: target });
      el.setAttribute(attr, target);
    }
  }
  function visit(el) {
    if (seen.has(el) || blocked(el)) return;
    if (el.localName === "iframe") {
      const attach = () => {
        try {
          if (el.contentDocument?.body) watch(el.contentDocument.body);
        } catch {}
      };
      if (!frames.has(el)) {
        frames.set(el, attach);
        el.addEventListener("load", attach);
        attach();
      }
    }
    if (el.shadowRoot) watch(el.shadowRoot);
    if (!el.matches(captioned)) {
      // Labels can also be direct children of custom elements, legends and fieldsets.
      if (
        !attrs.some((attr) => el.hasAttribute(attr)) &&
        !Array.from(el.childNodes).some((n) => n.nodeType === 3 && useful(clean(n.data)))
      )
        return;
    }
    seen.add(el);
    io.observe(el);
  }
  function discover(root) {
    if (root.nodeType === 1) {
      if (blocked(root)) return;
      visit(root);
    }
    const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode: (n) => (n.matches(skip) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    for (let el; (el = w.nextNode()); ) visit(el);
  }
  function watch(root) {
    if (!root || roots.has(root)) return;
    const observer = new MutationObserver((records) => {
      let cleanup = false;
      for (const r of records) {
        if (r.type === "childList") {
          if (r.removedNodes.length) cleanup = true;
          for (const n of r.addedNodes) if (n.nodeType === 1) discover(n);
        }
        const el = r.target.nodeType === 3 ? r.target.parentElement : r.target;
        if (el?.nodeType === 1 && !seen.has(el)) visit(el);
        if (el && onscreen.has(el)) candidates.add(el);
      }
      if (cleanup) {
        for (const el of captions.keys()) if (!el.isConnected) removeCaption(el);
        for (const [key, obs] of roots)
          if (
            !key.isConnected ||
            (key.ownerDocument !== document && !key.ownerDocument?.defaultView?.frameElement?.isConnected)
          ) {
            obs.disconnect();
            roots.delete(key);
          }
        for (const [frame, attach] of frames)
          if (!frame.isConnected) {
            frame.removeEventListener("load", attach);
            frames.delete(frame);
          }
      }
      if (candidates.size) later();
    });
    roots.set(root, observer);
    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: [...attrs, "type", "value", "hidden", "open", "visibility"],
    });
    discover(root);
  }
  function batch(manual = false) {
    const result = new Set();
    let length = 0;
    const now = Date.now();
    const accept = (key) => {
      if (
        result.has(key) ||
        (!manual && (requested.get(key) || 0) > now) ||
        result.size >= 80 ||
        length + key.length > 11000
      )
        return;
      result.add(key);
      length += key.length;
    };
    if (shown && state) {
      if (manual && !io) {
        const scan = (root) => {
          for (const el of root.querySelectorAll(selector + "," + captioned)) {
            if (result.size >= 80) break;
            const box = el.getBoundingClientRect(),
              win = el.ownerDocument.defaultView;
            if (
              !box.width ||
              !box.height ||
              box.bottom < 0 ||
              box.right < 0 ||
              box.top >= win.innerHeight ||
              box.left >= win.innerWidth
            )
              continue;
            apply(el, accept);
            if (el.shadowRoot) scan(el.shadowRoot);
            if (el.localName === "iframe" && el.contentDocument?.body) scan(el.contentDocument.body);
          }
        };
        scan(document.body);
      } else for (const el of manual ? onscreen : candidates) apply(el, accept);
      for (const s of globalThis.easyreadCanvas?.labels() || [])
        if (useful(s) && !state.known(s) && !state.target(s)) accept(s);
    }
    if (!manual) {
      candidates.clear();
      for (const [s, until] of requested) if (until <= now) requested.delete(s);
      for (const s of result) requested.set(s, now + 75000);
      while (requested.size > 2000) requested.delete(requested.keys().next().value);
      if (result.size) ipcRenderer.send("easyread:label-batch", [...result]);
    }
    return [...result];
  }
  function later() {
    if (!timer && shown && enabled)
      timer = setTimeout(() => {
        timer = 0;
        batch();
      }, 400);
  }
  globalThis.easyreadLabels = {
    collect: () => batch(true),
    sync(model, visible, language) {
      state = model;
      shown = visible;
      enabled = !!language;
      globalThis.easyreadCanvas?.sync(model, shown && enabled);
      if (!enabled || !shown) for (const el of captions.keys()) removeCaption(el);
      if ((!shown || !enabled) && io) {
        clearTimeout(timer);
        timer = 0;
        io.disconnect();
        io = null;
        for (const observer of roots.values()) observer.disconnect();
        for (const [frame, attach] of frames) frame.removeEventListener("load", attach);
        roots.clear();
        frames.clear();
        candidates.clear();
        onscreen.clear();
        seen = new WeakSet();
      }
      if (!io && shown && enabled && document.body) {
        io = new IntersectionObserver((entries) => {
          for (const { target, isIntersecting } of entries) {
            if (!io || !seen.has(target)) continue;
            if (isIntersecting) {
              onscreen.add(target);
              candidates.add(target);
            } else {
              onscreen.delete(target);
              candidates.delete(target);
              if (!target.isConnected) {
                io.unobserve(target);
                seen.delete(target);
              }
            }
          }
          later();
        });
        watch(document.body);
      }
      for (const [el, attrs] of originals) {
        if (!el.isConnected) {
          originals.delete(el);
          continue;
        }
        if (!enabled) {
          for (const [k, rec] of attrs) if (el.getAttribute(k) === rec.value) el.setAttribute(k, rec.source);
          originals.delete(el);
        }
      }
      if (shown && enabled) {
        for (const el of onscreen) candidates.add(el);
        later();
      }
    },
    canvasChanged() {
      later();
    },
  };
})();
