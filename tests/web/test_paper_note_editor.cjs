const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function libraries() {
  const PR = {
    t: s => s,
    esc: s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
    tex: (s, display) => '<math display="' + display + '">' + s + '</math>',
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../easyread/web/vendor/note-libraries.js'), 'utf8'), {
    window: { PR }, self: {}, TextEncoder, TextDecoder, setTimeout, clearTimeout,
  });
  return PR.noteLibraries;
}
const text = value => ({ type: 'text', text: value });
const para = value => ({ type: 'paragraph', content: [text(value)] });
const heading = (value, level = 1) => ({ type: 'heading', attrs: { level }, content: [text(value)] });
const list = (...items) => ({ type: 'bulletList', content: items.map(content => ({ type: 'listItem', content })) });

test('Markmap keeps paragraphs, nested lists and lower headings under their heading', () => {
  const { toMindMap } = libraries();
  const doc = { content: [heading('方法'), para('问题说明'), list([para('数据'), list([para('训练集')], [para('测试集')])]), heading('结果', 2), para('主要结论'), heading('待办'), para('复现实验')] };
  const map = toMindMap(doc, '论文');
  assert.deepEqual(Array.from(map.children, n => n.content), ['方法', '待办']);
  const method = map.children[0];
  assert.deepEqual(Array.from(method.children, n => n.content), ['问题说明', '数据', '结果']);
  assert.deepEqual(Array.from(method.children[1].children, n => n.content), ['训练集', '测试集']);
  assert.equal(method.children[2].children[0].content, '主要结论');
  assert.equal(map.children[1].children[0].content, '复现实验');
});

test('a single title becomes the root, while a prose-only note still has content', () => {
  const { toMindMap } = libraries();
  const map = toMindMap({ content: [heading('阅读笔记'), para('第一段'), para('第二段')] }, '论文');
  assert.equal(map.content, '阅读笔记');
  assert.deepEqual(Array.from(map.children, n => n.content), ['第一段', '第二段']);
  assert.equal(toMindMap({ content: [para('没有标题的笔记')] }, '论文').children[0].content, '没有标题的笔记');
  assert.equal(toMindMap({ content: [para('')] }, '论文').children.length, 0);
});

test('formatting, equations and code remain visible without interpreting literal HTML', () => {
  const { toMindMap } = libraries();
  const map = toMindMap({ content: [
    { type: 'paragraph', content: [{ ...text('<img>'), marks: [{ type: 'bold' }] }, { type: 'inlineMath', attrs: { latex: 'x=y' } }] },
    { type: 'blockMath', attrs: { latex: 'E=mc^2' } },
    { type: 'codeBlock', content: [text('# code\n<script>')] },
  ] }, '论文');
  assert.equal(map.children[0].content, '<strong>&lt;img&gt;</strong><math display="false">x=y</math>');
  assert.equal(map.children[1].content, '<math display="true">E=mc^2</math>');
  assert.equal(map.children[2].content, '<pre><code># code\n&lt;script&gt;</code></pre>');
});

test('ordered lists, tasks, tables and images keep their note content', () => {
  const { toMindMap } = libraries();
  const map = toMindMap({ content: [
    { type: 'orderedList', attrs: { start: 3 }, content: [{ type: 'listItem', content: [para('步骤')] }] },
    { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [para('已完成')] }] },
    { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableHeader', content: [para('方法')] }, { type: 'tableCell', content: [para('DPO')] }] }] },
    { type: 'image', attrs: { alt: '实验图', src: '/image.png' } },
  ] }, '论文');
  assert.equal(map.children[0].content, '3. 步骤');
  assert.equal(map.children[1].content, '☑ 已完成');
  assert.ok(map.children[2].content.includes('<td>方法</td><td>DPO</td>'));
  assert.equal(map.children[3].content, '实验图');
});

test('source ranges distinguish repeated text and follow nested list positions', () => {
  const { toMindMap, findMapNode } = libraries();
  const map = toMindMap({ content: [heading('标题'), para('相同内容'), para('相同内容')] }, '论文');
  assert.equal(map.children[0].payload.from, 4);
  assert.equal(map.children[1].payload.from, 10);
  assert.equal(findMapNode(map, 11).node, map.children[1]);
  assert.equal(findMapNode(map, 5).node, map.children[0]);
  const nested = toMindMap({ content: [list([para('父项'), list([para('子项')])])] }, '论文');
  const match = findMapNode(nested, 9);
  assert.equal(match.node.content, '子项');
  assert.equal(match.node.payload.from, 8);
  assert.equal(match.ancestors[1].content, '父项');
});

test('node positions move with inserted content, while atomic equations use one position', () => {
  const { toMindMap, findMapNode } = libraries();
  const map = toMindMap({ content: [{ type: 'blockMath', attrs: { latex: 'x=1' } }, para('内容')] }, '论文');
  assert.equal(map.children[0].payload.from, 0);
  assert.equal(map.children[0].payload.to, 1);
  assert.equal(map.children[1].payload.from, 1);
  const changed = toMindMap({ content: [para('新增段落'), { type: 'blockMath', attrs: { latex: 'x=1' } }, para('内容')] }, '论文');
  assert.equal(changed.children[1].payload.from, 6);
  assert.equal(findMapNode(changed, 8).node.content, '内容');
});
