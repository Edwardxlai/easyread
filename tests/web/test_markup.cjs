const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

function markup(realKatex = false) {
  const PR = {
    t: (s, v) => v ? s.replace(/\{(\w+)\}/g, (m, k) => v[k]) : s, esc: text => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;") };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../easyread/web/js/common/markup.js"), "utf8"), {
    window: { PR }, URL, katex: realKatex ? require("../../easyread/web/vendor/katex/katex.min.js") : { renderToString: tex => '<math>' + PR.esc(tex) + '</math>' },
  });
  return PR;
}

test("title formulas render with real KaTeX while citations and HTML stay inert", () => {
  const PR = markup(true);
  PR.refById = { 13: { text: "Reference thirteen" } };
  const html = PR.titleHtml(String.raw`$\mathrm{Harness}^{2}$ [13] <img src=x onerror=alert(1)>`);
  assert.ok(html.includes('class="katex"'));
  assert.ok(!html.includes('class="cite"'));
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;img'));
  const body = PR.md("Text $^{13}$ and reference [13].");
  assert.equal((body.match(/data-ref="13"/g) || []).length, 1);
  assert.ok(body.includes('class="katex"'));
});

test("footnotes and same-number references have separate destinations", () => {
  const PR = markup();
  const blocks = [{id:"p2", page:2}, {id:"p3", page:3},
    {id:"note2", type:"para", role:"footnote", num:"13", page:2},
    {id:"note3", type:"para", role:"footnote", num:"13", page:3}];
  PR.blockById = Object.fromEntries(blocks.map(b => [b.id, b]));
  PR.buildFootnoteIndex(blocks);
  PR.refById = {13: {}, 2: {}};
  const html = PR.md("Footnote[^13], bibliography [13] and [2].", PR.footnoteOptions("p2"));
  assert.ok(html.includes('href="#b-note2"'));
  assert.ok(html.includes('data-ref="13"'));
  assert.ok(html.includes('data-ref="2"'));
  assert.ok(PR.md("[^13]", PR.footnoteOptions("p3")).includes('href="#b-note3"'));
  assert.equal(PR.md("[^13]"), "<sup>13</sup>"); // ambiguous without a page
  assert.equal(PR.md("[^99]"), "<sup>99</sup>"); // missing target never links to references
  assert.equal(PR.md("`[^13]`"), "<code>[^13]</code>");
  PR.buildFootnoteIndex([blocks[2]]);
  assert.ok(PR.md("[^13]").includes('href="#b-note2"')); // unique note across pages
  PR.buildFootnoteIndex([blocks[2], {...blocks[2],id:"duplicate"}]);
  assert.equal(PR.md("[^13]", PR.footnoteOptions("p2")), "<sup>13</sup>");
});

test("author-year citations link by the key of their printed label, whatever the style lists before et al.", () => {
  const PR = markup();
  const refs = ["Jimenez-2024", "Chen-Jiang-2025", "Chen-2026a", "Chen-2026b", "DaSilva-2025", "JYW+24", "13", "Smith-2020", "Smith-Lee-2020"].map(id => ({ id }));
  PR.refById = Object.fromEntries(refs.map(r => [r.id, r]));
  PR.buildCiteIndex(refs);
  const cites = (html) => [...html.matchAll(/<a class="cite" data-ref="([^"]+)">([^<]+)<\/a>/g)].map(m => m[1] + ":" + m[2]);
  // Several citations in one bracket each link; the brackets stay text.
  const group = PR.md("[[Jimenez et al., 2024](#cite:Jimenez-2024), [Chen 和 Jiang，2025](#cite:chen-jiang-2025)]");
  assert.deepEqual(cites(group), ["Jimenez-2024:Jimenez et al., 2024", "Chen-Jiang-2025:Chen 和 Jiang，2025"]);
  assert.ok(group.startsWith("[<a") && group.endsWith("</a>]"));
  // Year suffixes tell same-author entries apart; case, punctuation and accents do not matter.
  assert.deepEqual(cites(PR.md("[Chen 等人（2026b）](#cite:Chen-2026b) [Da Silva 等（2025）](#cite:DáSilva-2025)")), ["Chen-2026b:Chen 等人（2026b）", "DaSilva-2025:Da Silva 等（2025）"]);
  // A style that names three authors still finds the entry by first author and year, but only when one entry fits.
  assert.deepEqual(cites(PR.md("[Jimenez, Yang, and Wettig 2024](#cite:Jimenez-Yang-Wettig-2024)")), ["Jimenez-2024:Jimenez, Yang, and Wettig 2024"]);
  assert.equal(PR.md("[Smith, Jones, and Lee 2020](#cite:Smith-Jones-Lee-2020)"), "Smith, Jones, and Lee 2020");
  assert.deepEqual(cites(PR.md("[JYW+24](#cite:JYW+24)")), ["JYW+24:JYW+24"]);
  assert.equal(PR.md("[Nobody, 2019](#cite:Nobody-2019)"), "Nobody, 2019");  // not in the list (yet): words only
  assert.equal(PR.md("[Jimenez et al., 2024](#cite:Jimenez-2024)", { cite: false }), "Jimenez et al., 2024");
  // Only numbered and alphabetic lists print a label in front of entries.
  assert.deepEqual(["13", "JYW+24", "Jimenez-2024", "r0a1b2c3d"].map(PR.refLabel), ["[13]", "[JYW+24]", "", ""]);
});

test("inline external links preserve labels and URLs without linking code or unsafe schemes", () => {
  const PR = markup();
  const html = PR.md("Read [here](https://example.com/docs?q=1&lang=en), [此处](https://example.com/other), and `[here](https://example.com/code)`.");
  assert.equal((html.match(/class=\"external-link\"/g) || []).length, 2);
  assert.ok(html.includes('href="https://example.com/docs?q=1&amp;lang=en"'));
  assert.ok(html.includes('rel="noopener noreferrer">here</a>'));
  assert.ok(html.includes('<code>[here](https://example.com/code)</code>'));
  assert.equal(PR.plain("Read [here](https://example.com/)"), "Read here");
  for (const url of ["javascript:alert(1)", "data:text/html,evil", "file:///etc/passwd", "//example.com"]) {
    assert.ok(!PR.md("[here](" + url + ")").includes("<a "));
  }
  assert.ok(PR.md('[<img src=x>](https://example.com/)').includes('&lt;img src=x&gt;'));
});

test("bilingual headings render without requiring blank lines before the answer", () => {
  const html = markup().mdBlocks("## English (ASD-STE100)\nThe device calculates $y=Wx$.\n## 中文解释\n器件计算 $y=Wx$。");
  assert.equal((html.match(/class="md-h"/g) || []).length, 2);
  assert.ok(!html.includes("##"));
  assert.ok(html.indexOf("English") < html.indexOf("中文解释"));
  assert.equal((html.match(/<math>y=Wx<\/math>/g) || []).length, 2);
});

test("both inline math delimiter styles render inside Chinese text and bold text", () => {
  const html = markup().md(String.raw`衰减常数 **\(\alpha\)**，相位常数 $\beta$，因子 \(\left|\frac{\sinh q}{q}\right|\)。`);
  assert.ok(html.includes(String.raw`<strong><math>\alpha</math></strong>`));
  assert.ok(html.includes(String.raw`<math>\beta</math>`));
  assert.ok(html.includes(String.raw`<math>\left|\frac{\sinh q}{q}\right|</math>`));
  assert.ok(!html.includes(String.raw`\(`));
});

test("display math is extracted before paragraph splitting, including blank lines within TeX", () => {
  const tex = String.raw`\frac{1}{L}\int_0^L e^{-(a+j\beta)z}\,dz`;
  for (const [left, right] of [["$$", "$$"], ["\\[", "\\]"]]) {
    const html = markup().mdBlocks("积分：\n" + left + "\n" + tex + "\n\n= I\n" + right + "\n\n取模后。\n" + left + String.raw`\left|\frac{\sinh q}{q}\right|` + right);
    assert.equal((html.match(/class="eq"/g) || []).length, 2);
    assert.ok(html.includes('<div class="eq"><math>' + tex + '\n\n= I</math></div>'));
    assert.ok(html.includes("<p>取模后。</p>"));
    assert.ok(!html.includes(left));
  }
});

test("titles preserve literal punctuation, links and code while rendering only math", () => {
  const PR = markup(true);
  const literal = 'A * B * C **D** [Benchmark](https://example.com) `$x$`';
  assert.equal(PR.titleHtml(literal), literal);
  for (const formula of ["$x$", "$$x$$", String.raw`\(x\)`, String.raw`\[x\]`]) {
    const html = PR.titleHtml(literal + " " + formula);
    assert.ok(html.startsWith(literal + " "));
    assert.ok(html.includes('class="katex"'));
    assert.ok(!html.includes('class="katex-display"'));
    assert.ok(!html.includes("<a "));
  }
});

test("table pipes inside parenthesized math or code do not create extra cells", () => {
  const html = markup().mdBlocks(String.raw`| 变量 | 定义 |
| --- | --- |
| \(q\) | \(\left|\frac{\sinh q}{q}\right|\) |
| 代码 | \`a|b\` |
| 文字 | a\|b |`.replace(/\\`/g, "`"));
  assert.equal((html.match(/<td/g) || []).length, 6);
  assert.ok(html.includes(String.raw`<math>\left|\frac{\sinh q}{q}\right|</math>`));
  assert.ok(html.includes("<code>a|b</code>"));
  assert.ok(html.includes("<td>a|b</td>"));
});

test("math delimiter examples inside code remain literal and HTML stays escaped", () => {
  const html = markup().mdBlocks("格式 `\\(x\\)` 或 `$x$`。\n\n```tex\n\\[x\\]\n\n$$<script>$$\n```\n\n正文 \\(y\\)。");
  assert.ok(html.includes("<code>\\(x\\)</code>"));
  assert.ok(html.includes("<code>$x$</code>"));
  assert.ok(html.includes("<pre><code>\\[x\\]\n\n$$&lt;script&gt;$$\n</code></pre>"));
  assert.equal((html.match(/<math>/g) || []).length, 1);
  assert.ok(!html.includes("<script>"));
});

test("paper paragraphs preserve nested backticks, indentation and literal code symbols", () => {
  const code = 'def run():\n    print("```", "`value`", "$HOME", "<script>")\n';
  const html = markup().md("````python\n" + code + "````\n\nListing 1: Agent loop.");
  assert.equal((html.match(/<pre><code>/g) || []).length, 1);
  assert.ok(html.includes('<pre><code>def run():\n    print(&quot;```&quot;, &quot;`value`&quot;, &quot;$HOME&quot;, &quot;&lt;script&gt;&quot;)\n</code></pre>'));
  assert.ok(html.endsWith("Listing 1: Agent loop."));
  assert.ok(!html.includes("<math>"));
  assert.ok(!html.includes("<script>"));
});

test("unfinished streamed delimiters stay readable until the matching close arrives", () => {
  const PR = markup();
  const answer = "积分：\n\\[\n\\frac{1}{L}\\int_0^L e^{-(a+j\\beta)z}\\,dz\n\\]";
  for (let i = 0; i < answer.length; i++) {
    const html = PR.mdBlocks(answer.slice(0, i));
    assert.ok(!html.includes("<math>"));
  }
  assert.equal((PR.mdBlocks(answer).match(/<math>/g) || []).length, 1);
  assert.ok(!PR.md(String.raw`价格 \$5；未闭合 \(x；转义 \\(y\\)`).includes("<math>"));
});

test("the integral, logarithm and hyperbolic expressions use the bundled KaTeX renderer", () => {
  const html = markup(true).mdBlocks(String.raw`\(\alpha\) 与 $\beta$。
\[
20\lg\left\{e^{-\alpha L/4}R^{1/2}\right\}.
\]
\[
\frac{1}{L}\int_0^L e^{-(a+j\beta)z}\,dz
\]
$$\left|\frac{\sinh q}{q}\right|$$`);
  assert.equal((html.match(/class="katex"/g) || []).length, 5);
  assert.equal((html.match(/class="katex-display"/g) || []).length, 3);
  assert.ok(!html.includes("katex-error"));
});

test("headings can precede tables and lists; their text still escapes HTML", () => {
  const html = markup().mdBlocks("## <script>unsafe</script>\n| Metric | Value |\n| --- | --- |\n| Error | 2% |\n## 中文解释\n- 误差为 **2%**。\n- 保留原值。");
  assert.ok(html.includes('&lt;script&gt;unsafe&lt;/script&gt;'));
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes('<table class="tbl">'));
  assert.ok(html.includes("<ul>"));
  assert.ok(html.includes("<strong>2%</strong>"));
  assert.equal((html.match(/class="md-h"/g) || []).length, 2);
});

test("blank lines between numbered steps do not reset each displayed number to one", () => {
  const html = markup().mdBlocks("1. 准备器件。\n\n2. 输入 $x$。\n\n3. 读取结果。");
  assert.ok(html.includes('<ol><li>准备器件。</li></ol>'));
  assert.ok(html.includes('<ol start="2"><li>输入 <math>x</math>。</li></ol>'));
  assert.ok(html.includes('<ol start="3"><li>读取结果。</li></ol>'));
});

test("links into the paper go where their type and number say, never by guessing from the wording", () => {
  const PR = markup();
  PR.xindex = { tab: { 3: "tab3" }, lst: { 3: "p8-4" }, sec: { "C.1": "sC-1" }, eq: { 4: "eq4" }, fig: {}, alg: {} };
  const kinds = (html) => [...html.matchAll(/data-kind="(\w+)" data-key="([\w.]+)">([^<]+)</g)].map(m => m[1] + ":" + m[2] + ":" + m[3]);
  const html = PR.md("重复[列表 3](#lst:3)所示，见[表 3](#tab:3)、[附录 C.1](#sec:C.1)、式 [(4)](#eq:4)，[图 9](#fig:9)。");
  assert.deepEqual(kinds(html), ["lst:3:列表 3", "tab:3:表 3", "sec:C.1:附录 C.1", "eq:4:(4)"]);
  assert.ok(html.includes("，图 9。"), "a target not in the paper (yet) keeps only its words");
  assert.ok(!html.includes("(#"));
  assert.deepEqual(kinds(PR.md("重复列表 3 所示，见表 3 和 Table 3。")), ["tab:3:表 3", "tab:3:Table 3"]);
  assert.deepEqual(kinds(PR.md("表 3", { xref: false })), []);
  assert.deepEqual(kinds(PR.md("See Table 3, [Table 3](#lst:3) and `Table 3`")), ["tab:3:Table 3", "lst:3:Table 3"]);
  assert.equal(PR.md("[表 3](#tab:3)", { xref: false }), "表 3");  // places that must not link (captions in a preview, table cells)
  assert.equal(PR.md("[Figure 3](#) and [x](#foo:1)"), "Figure 3 and x");  // an uncompleted hint or unknown target is just words
  assert.ok(PR.md("[docs](https://example.com)").includes('class="external-link"'));  // web links unchanged
});

test("paper-note block anchors retain their destination alongside rich text citations", () => {
  const PR = markup();
  const link = "[来源](#b-p1-1)";
  assert.equal(PR.md(link), '<a href="#b-p1-1">来源</a>');
  assert.equal(PR.unlink(link + " [图](#fig:3)"), link + " 图");
});

test("Unicode citation keys retain surnames and ambiguous or empty keys cannot link", () => {
  const PR = markup();
  const refs = ["王-2024", "李-2024", "Garcia-2024", "García-2024", "李"].map(id => ({ id }));
  refs.push({id: "r00000001", cite_key: "Smith-2024"}, {id: "r00000002", cite_key: "Smith-2024"});
  PR.buildCiteIndex(refs);
  assert.match(PR.md("[王](#cite:王-2024)"), /data-ref="王-2024"/);
  assert.match(PR.md("[李](#cite:李)"), /data-ref="李"/);
  for (const key of ["赵-2024", "Garcia-2024", "Smith-2024", "Smith-Lee-2024", "", "???"])
    assert.equal(PR.md("[label](#cite:" + key + ")"), "label");
});

test("symbol footnote marks link like numbered ones and do not turn into italics", () => {
  const PR = markup();
  const blocks = [{ id: "p1", page: 1 }, { id: "fn-star", type: "para", role: "footnote", num: "∗", page: 1 },
    { id: "fn-dag", type: "para", role: "footnote", num: "†", page: 1 }, { id: "fn1", type: "para", role: "footnote", num: "1", page: 1 }];
  PR.blockById = Object.fromEntries(blocks.map(b => [b.id, b]));
  PR.buildFootnoteIndex(blocks);
  const html = PR.md("Ann Lee[^*], Bo Li[^†] wrote *this* work[^1].", PR.footnoteOptions("p1"));
  for (const id of ["fn-star", "fn-dag", "fn1"]) assert.ok(html.includes('data-footnote="b-' + id + '"'), id);
  assert.ok(html.includes("<em>this</em>"));
  assert.ok(html.includes("<sup>&#42;</sup>"));
  assert.ok(PR.md("x[^∗]", PR.footnoteOptions("p1")).includes('data-footnote="b-fn-star"'));  // ∗ and * are the same mark
});
