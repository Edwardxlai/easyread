/* 分类的层级：分类名就是路径，用“/”隔开，比如“机器学习/Transformer”。论文的 tags 里存完整路径。
   父分类不用单独存：有“A/B”就有“A”。点父分类时列出它和所有子分类里的论文。
   这里只放纯函数（不碰页面），侧栏、列表、详情、批量操作都用它。 */
(function (PR) {
  "use strict";
  const SEP = "/";
  const T = {};

  T.SEP = SEP;
  T.MAX_NAME = 30;   // 每一级名字的长度
  T.MAX_PATH = 120;  // 整条路径（library-nav.js 校验 tag 不超过 128）
  T.parts = (c) => String(c).split(SEP);
  T.leaf = (c) => T.parts(c).pop();
  T.parent = (c) => { const p = T.parts(c); p.pop(); return p.join(SEP); };
  T.depth = (c) => T.parts(c).length - 1;
  T.under = (tag, c) => tag === c || String(tag).startsWith(c + SEP);  // tag 是 c 本身或它的子孙
  T.label = (c) => T.parts(c).join(" › ");

  /* 用户输入的名字整理成路径：去掉每级首尾空格、空的级；每级截到 MAX_NAME */
  T.clean = (s) => String(s || "").split(SEP).map((x) => x.trim().slice(0, T.MAX_NAME)).filter(Boolean).join(SEP).slice(0, T.MAX_PATH);

  /* 补齐祖先，并按树的顺序排好：同一层按在 list 里第一次出现（自己或子孙）的先后，父在前、子紧跟 */
  T.ordered = function (list) {
    const first = new Map();
    list.forEach((c, i) => {
      const p = T.parts(c);
      for (let k = 1; k <= p.length; k++) { const a = p.slice(0, k).join(SEP); if (!first.has(a)) first.set(a, i); }
    });
    const all = Array.from(first.keys());
    const kids = (par) => all.filter((c) => T.parent(c) === par && c !== par).sort((a, b) => first.get(a) - first.get(b));
    const out = [];
    const walk = (par) => kids(par).forEach((c) => { out.push(c); walk(c); });
    walk("");
    return out;
  };
  T.children = (list, c) => list.filter((x) => T.parent(x) === c && x !== c);
  T.hasChildren = (list, c) => list.some((x) => x !== c && T.under(x, c));

  /* 直接放在 c 里的论文（tags 里有 c 本身，不算子分类里的） */
  T.direct = (items, c) => items.filter((i) => (i.tags || []).includes(c));

  /* 侧栏分类树要画的行，像资源管理器：展开一个分类，先列子分类，再列直接属于它的论文。
     cats：T.ordered 排好的全部分类；items：论文（按想显示的顺序）。
     o.open(c) 展开没有，o.skip(c) 不画（连子树），o.limit 每个分类先显示几篇，o.full(c) 这个分类显示全部。
     返回 {type:"cat", c, depth, kids, open} / {type:"paper", item, cat, depth} / {type:"more", cat, n, depth} */
  T.rows = function (cats, items, o) {
    const open = o.open || (() => false), skip = o.skip || (() => false), full = o.full || (() => false);
    const direct = o.tags ? (c) => items.filter((i) => o.tags(i).includes(c)) : (c) => T.direct(items, c);
    const limit = o.limit || Infinity;
    const out = [];
    const walk = (par) => T.children(cats, par).forEach((c) => {
      if (skip(c)) return;
      const depth = T.depth(c), papers = direct(c);
      const kids = T.hasChildren(cats, c) || papers.length > 0, isOpen = kids && open(c);
      out.push({ type: "cat", c, depth, kids, open: isOpen });
      if (!isOpen) return;
      walk(c);
      const shown = full(c) ? papers : papers.slice(0, limit);
      shown.forEach((item) => out.push({ type: "paper", item, cat: c, depth: depth + 1 }));
      if (shown.length < papers.length) out.push({ type: "more", cat: c, n: papers.length - shown.length, depth: depth + 1 });
    });
    walk("");
    return out;
  };

  /* 把 from 这棵子树整体换到 to 下面（改名、移动都用它） */
  T.move = (tag, from, to) => (T.under(tag, from) ? to + String(tag).slice(from.length) : tag);

  /* 在 list 里把 c（连同子孙）挪到前一个 / 后一个兄弟的位置 */
  T.shift = function (list, c, d) {
    const order = T.ordered(list);
    const sibs = T.children(order, T.parent(c));
    const i = sibs.indexOf(c), j = i + d;
    if (i < 0 || j < 0 || j >= sibs.length) return order;
    // 树序里相邻兄弟的子树是挨着的两段，对调这两段
    const a = sibs[Math.min(i, j)], b = sibs[Math.max(i, j)];
    const A = order.filter((x) => T.under(x, a)), B = order.filter((x) => T.under(x, b));
    const at = order.indexOf(a);
    return order.slice(0, at).concat(B, A, order.slice(at + A.length + B.length));
  };

  PR.catTree = T;
})(window.PR);
