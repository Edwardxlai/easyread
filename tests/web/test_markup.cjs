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

test("links exact alphanumeric labels and unique author-year citations, leaving ambiguity alone", () => {
  const PR = markup();
  const refs = [
    {id: "VSP+17", text: "Ashish Vaswani, Noam Shazeer, et al. Attention is All You Need. 2017."},
    {id: "2", text: "Jane Smith and John Doe. A study. 2020."},
    {id: "3", text: "J. Smith, P. Doe. Another study. 2021."},
    {id: "4", text: "John Smith, R. Roe. A further study. 2021."},
    {id: "5", text: "Jane Jones, An older study. 2019. Accessed 2021."},
  ];
  PR.refById = Object.fromEntries(refs.map(r => [r.id, r]));
  PR.buildCitationIndex(refs);
  let html = PR.md("[VSP+17, 2], Vaswani et al., 2017 and Smith (2020); Smith et al., 2021.");
  assert.equal((html.match(/data-ref="VSP\+17"/g) || []).length, 2);
  assert.equal((html.match(/data-ref="2"/g) || []).length, 2);
  assert.ok(html.includes('href="#ref-VSP+17"'));
  assert.ok(html.includes('Smith et al., 2021'));
  assert.ok(!html.includes('data-ref="3"'));
  assert.ok(!html.includes('data-ref="4"'));
  assert.ok(!PR.md('Jones, 2021').includes('class="cite"'));
  assert.ok(!PR.md('`Vaswani et al., 2017`').includes('class="cite"'));
  assert.ok(!PR.md('[feature-2]').includes('class="cite"'));
});
