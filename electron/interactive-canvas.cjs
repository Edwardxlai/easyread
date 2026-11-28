/* Keep 2D chart hit targets and drawing state intact. The page-world hook has no desktop capabilities. */
(() => {
  const { contextBridge } = require("electron");
  contextBridge.executeInMainWorld({
    func: () => {
      const proto = globalThis.CanvasRenderingContext2D?.prototype;
      if (!proto) return;
      const records = new Map(),
        ns = "http://www.w3.org/2000/svg";
      let dictionary = new Map(),
        mode = false,
        timer = 0;
      function queue() {
        if (!timer) timer = setTimeout(render, 140);
      }
      function svg(tag, attributes) {
        const el = document.createElementNS(ns, tag);
        for (const [name, value] of Object.entries(attributes)) el.setAttribute(name, value);
        return el;
      }
      function render() {
        timer = 0;
        for (const [c, r] of records) {
          if (!c.isConnected) {
            r.layer?.remove();
            records.delete(c);
            continue;
          }
          if (!mode) {
            r.layer?.remove();
            r.layer = null;
            r.signature = null;
            continue;
          }
          if (!r.dirty) continue;
          r.dirty = false;
          const layers = [];
          let base = c;
          while (
            base.parentElement &&
            ["transparent", "rgba(0, 0, 0, 0)"].includes(getComputedStyle(base).backgroundColor)
          )
            base = base.parentElement;
          const bg = getComputedStyle(base).backgroundColor;
          const color = getComputedStyle(c).color;
          const signature = JSON.stringify([
            mode,
            bg,
            color,
            c.width,
            c.height,
            c.clientWidth,
            c.clientHeight,
            c.offsetLeft,
            c.offsetTop,
            [...r.labels.values()].map((v) => [v, dictionary.get(v.source)]),
          ]);
          if (signature === r.signature) continue;
          r.signature = signature;
          for (const v of r.labels.values()) {
            const tr = dictionary.get(v.source);
            if (!tr || tr === v.source) continue;
            const text =
              mode === "original-first"
                ? v.source + " / " + tr
                : mode === "translation-first"
                  ? tr + " / " + v.source
                  : tr;
            const group = svg("g", { transform: "matrix(" + v.matrix.join(" ") + ")" });
            const w = v.right + v.left,
              h = v.up + v.down;
            if (!(w > 0 && h > 0)) continue;
            group.append(
              svg("rect", {
                x: v.x - v.left - 1,
                y: v.y - v.up - 1,
                width: w + 2,
                height: h + 2,
                fill: ["transparent", "rgba(0, 0, 0, 0)"].includes(bg) ? "white" : bg,
              }),
            );
            const label = svg("text", {
              x: v.x - v.left,
              y: v.y - v.up + h * 0.83,
              fill: color,
              "data-source": v.source,
            });
            label.style.font = v.font;
            label.textContent = text;
            const ctx = c.getContext("2d");
            ctx.save();
            ctx.font = v.font;
            const measure = ctx.measureText(text).width;
            ctx.restore();
            if (measure > w) {
              label.setAttribute("textLength", w);
              label.setAttribute("lengthAdjust", "spacingAndGlyphs");
            }
            group.append(label);
            layers.push(group);
          }
          if (!layers.length) {
            r.layer?.remove();
            r.layer = null;
            continue;
          }
          if (!r.layer) {
            r.layer = svg("svg", { "aria-hidden": "true", translate: "no", "data-easyread-canvas": "" });
            r.layer.style.cssText =
              "position:absolute;pointer-events:none;overflow:hidden;display:block;margin:0;padding:0";
            c.after(r.layer);
          }
          Object.assign(r.layer.style, {
            left: c.offsetLeft + "px",
            top: c.offsetTop + "px",
            width: c.clientWidth + "px",
            height: c.clientHeight + "px",
          });
          r.layer.setAttribute("viewBox", "0 0 " + c.width + " " + c.height);
          r.layer.replaceChildren(...layers);
        }
      }
      const recent = new Set();
      function record(ctx, args) {
        const c = ctx.canvas,
          raw = args[0];
        if (
          !(c instanceof HTMLCanvasElement) ||
          !c.isConnected ||
          typeof raw !== "string" ||
          raw.length > 220 ||
          !/\p{L}/u.test(raw)
        )
          return;
        let r = records.get(c);
        if (!r) {
          if (records.size >= 24) for (const old of records.keys()) if (!old.isConnected) records.delete(old);
          if (records.size >= 24) return;
          r = { labels: new Map(), dirty: false };
          records.set(c, r);
        }
        if (r.labels.size >= 384) return;
        const source = raw.trim().replace(/\s+/g, " ");
        const t = ctx.getTransform(),
          x = Number(args[1]),
          y = Number(args[2]);
        const key = [t.a, t.b, t.c, t.d, t.e + x * t.a + y * t.c, t.f + x * t.b + y * t.d]
          .map((n) => Math.round(n * 10) / 10)
          .join(",");
        const old = r.labels.get(key);
        if (old?.source === source && old.font === ctx.font) return;
        const m = ctx.measureText(raw);
        r.labels.set(key, {
          source,
          x,
          y,
          matrix: [t.a, t.b, t.c, t.d, t.e, t.f],
          font: ctx.font,
          left: m.actualBoundingBoxLeft,
          right: m.actualBoundingBoxRight,
          up: m.actualBoundingBoxAscent,
          down: m.actualBoundingBoxDescent,
        });
        r.dirty = true;
        if (!recent.has(source) && recent.size < 1500) {
          recent.add(source);
          if (!notifyTimer)
            notifyTimer = setTimeout(() => {
              notifyTimer = 0;
              window.dispatchEvent(new Event("easyread-canvas-labels"));
            }, 300);
        }
        if (mode) queue();
      }
      let notifyTimer = 0;
      for (const name of ["fillText", "strokeText"]) {
        const native = proto[name];
        proto[name] = function (...args) {
          const result = native.apply(this, args);
          record(this, args);
          return result;
        };
      }
      const clear = proto.clearRect;
      proto.clearRect = function (x, y, w, h) {
        const result = clear.call(this, x, y, w, h),
          r = records.get(this.canvas);
        if (r) {
          const t = this.getTransform(),
            left = t.a * x + t.e,
            top = t.d * y + t.f;
          if (!t.b && !t.c) {
            const right = left + w * t.a,
              bottom = top + h * t.d;
            for (const [k, l] of r.labels) {
              const [a, b, c, d, e, f] = l.matrix,
                px = a * l.x + c * l.y + e,
                py = b * l.x + d * l.y + f;
              if (px >= left && px <= right && py >= top && py <= bottom) r.labels.delete(k);
            }
            r.dirty = true;
            if (mode) queue();
          }
        }
        return result;
      };
      Object.defineProperty(window, "__easyreadChartText", {
        value: {
          labels() {
            const out = new Set();
            for (const [canvas, r] of records) {
              const b = canvas.getBoundingClientRect();
              if (canvas.isConnected && b.height && b.bottom >= 0 && b.top < innerHeight)
                for (const l of r.labels.values()) out.add(l.source);
            }
            return [...out].slice(0, 384);
          },
          apply(pairs, language) {
            dictionary = new Map(pairs);
            mode = language;
            for (const r of records.values()) r.dirty = true;
            queue();
          },
        },
      });
    },
  });
  const labels = () =>
    contextBridge.executeInMainWorld({ func: () => window.__easyreadChartText?.labels() || [] });
  let model, mode;
  function sync(s, enabled) {
    model = s;
    mode = enabled ? s.mode : false;
    const pairs = mode
      ? labels()
          .map((source) => [source, s.target(source)])
          .filter((p) => p[1])
      : [];
    contextBridge.executeInMainWorld({
      func: (pairs, mode) => window.__easyreadChartText?.apply(pairs, mode),
      args: [pairs, mode],
    });
  }
  window.addEventListener("easyread-canvas-labels", () => {
    if (model && mode) {
      sync(model, true);
      globalThis.easyreadLabels?.canvasChanged();
    }
  });
  window.addEventListener(
    "scrollend",
    () => {
      if (model && mode) {
        sync(model, true);
        globalThis.easyreadLabels?.canvasChanged();
      }
    },
    { passive: true },
  );
  globalThis.easyreadCanvas = { labels, sync };
})();
