import { Editor, Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { TableKit } from '@tiptap/extension-table';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import Image from '@tiptap/extension-image';
import Highlight from '@tiptap/extension-highlight';
import { InlineMath, BlockMath } from '@tiptap/extension-mathematics';
import { Markmap } from 'markmap-view';
import { mountNoteToolbar } from './note-toolbar';
import { insertNoteImages } from './note-images';

const PR = window.PR;
const NoteInlineMath = InlineMath.extend({
  markdownTokenizer: {
    name: 'inlineMath', level: 'inline',
    start: src => src.search(/\$|\\\(/),
    tokenize: src => {
      const match = src.match(/^(?:\$([^$\n]+)\$(?!\$)|\\\(([\s\S]+?)\\\))/);
      return match ? { type: 'inlineMath', raw: match[0], latex: (match[1] || match[2]).trim() } : undefined;
    },
  },
});
const NoteBlockMath = BlockMath.extend({
  markdownTokenizer: {
    name: 'blockMath', level: 'block',
    start: src => src.search(/\$\$|\\\[/),
    tokenize: src => {
      const match = src.match(/^(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])/);
      return match ? { type: 'blockMath', raw: match[0], latex: (match[1] || match[2]).trim() } : undefined;
    },
  },
});

const NoteHighlight = Highlight.extend({
  renderMarkdown(node, h) {
    const color = node.attrs?.color, text = h.renderChildren(node);
    if (!color) return `==${text}==`;
    const background = color.startsWith('var(') ? getComputedStyle(document.documentElement).getPropertyValue(color.slice(4, -1)).trim() : color;
    return `<mark data-color="${PR.esc(color)}" style="background-color:${PR.esc(background)};color:inherit">${text}</mark>`;
  },
});

const NoteComposition = Extension.create({
  name: 'noteComposition',
  addProseMirrorPlugins() {
    return [new Plugin({
      // 组合输入中的退格会产生空事务；避免它重写 DOM 选区并中断输入法。
      filterTransaction: tr => !(
        this.editor.view.composing && !tr.docChanged && !tr.selectionSet && !tr.storedMarksSet && Object.keys(tr.meta).length === 0
      ),
    })];
  },
});

function createEditor({ element, content, onChange, onSelection, onMathClick }) {
  let composing = false, compositionTimer, instance;
  const publish = editor => { if (!composing && !editor.view.composing) onChange(editor.getMarkdown()); };
  instance = new Editor({
    element,
    extensions: [
      NoteComposition,
      StarterKit.configure({ link: { openOnClick: false } }),
      Markdown.configure({ markedOptions: { gfm: true, breaks: true }, indentation: { style: 'space', size: 2 } }),
      TableKit, TaskList, TaskItem.configure({ nested: true }), Image.configure({ allowBase64: true }), NoteHighlight.configure({ multicolor: true }),
      NoteInlineMath.configure({ katexOptions: { throwOnError: false, trust: false }, onClick: (node, pos) => onMathClick(node, pos, false) }),
      NoteBlockMath.configure({ katexOptions: { throwOnError: false, trust: false }, onClick: (node, pos) => onMathClick(node, pos, true) }),
    ],
    content, contentType: 'markdown',
    editorProps: {
      handleDOMEvents: {
        compositionstart() { composing = true; clearTimeout(compositionTimer); return false; },
        compositionend(view) {
          clearTimeout(compositionTimer);
          compositionTimer = setTimeout(() => { composing = false; if (!view.isDestroyed) publish(instance); }, 0);
          return false;
        },
      },
      handlePaste(view, event) {
        const files = [...(event.clipboardData?.files || [])].filter(file => file.type.startsWith('image/'));
        if (!files.length) return false;
        event.preventDefault(); insertNoteImages(instance, files); return true;
      },
      handleDrop(view, event, _slice, moved) {
        const files = [...(event.dataTransfer?.files || [])].filter(file => file.type.startsWith('image/'));
        if (moved || !files.length) return false;
        event.preventDefault(); const position = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
        insertNoteImages(instance, files, position); return true;
      },
      attributes: { class: 'pn-prose', role: 'textbox', 'aria-multiline': 'true', 'aria-label': PR.t('论文笔记富文本'), 'data-placeholder': PR.t('记录核心论点、方法和你的思考。') } },
    onDestroy: () => { clearTimeout(compositionTimer); },
    onUpdate: ({ editor }) => publish(editor),
    onSelectionUpdate: ({ editor }) => { if (!composing && !editor.view.composing) onSelection(editor); },
  });
  return instance;
}

function inline(node) {
  if (node.type === 'inlineMath') return PR.tex(node.attrs.latex, false);
  if (node.type === 'hardBreak') return '<br>';
  if (node.type === 'image') {
    const { src, alt } = node.attrs, label = PR.esc(alt || PR.t('图片'));
    return src ? `<img class="pn-map-image" draggable="false" src="${PR.esc(src)}" alt="${label}" width="160" height="110">` : label;
  }
  let html = node.type === 'text' ? PR.esc(node.text) : (node.content || []).map(inline).join('');
  for (const mark of node.marks || []) {
    const tag = { bold: 'strong', italic: 'em', underline: 'u', strike: 's', code: 'code' }[mark.type];
    if (tag) html = `<${tag}>${html}</${tag}>`;
    if (mark.type === 'highlight') {
      const color = mark.attrs?.color;
      html = color ? `<mark style="background-color:${PR.esc(color)};color:inherit">${html}</mark>` : `<mark>${html}</mark>`;
    }
  }
  return html;
}

// 标题建立层级，段落和列表保留在所属标题下；Markmap 负责布局与交互。
function toMindMap(doc, title) {
  const ranges = new WeakMap();
  const containers = new Set(['paragraph', 'heading', 'codeBlock', 'blockquote', 'bulletList', 'orderedList', 'taskList', 'listItem', 'taskItem', 'table', 'tableRow', 'tableHeader', 'tableCell']);
  function index(node, from) {
    let size = node.type === 'text' ? node.text.length : 1;
    if (containers.has(node.type)) {
      let next = from + 1;
      for (const child of node.content || []) next += index(child, next);
      size = next - from + 1;
    }
    ranges.set(node, { from, to: from + size, type: node.type });
    return size;
  }
  let offset = 0;
  for (const node of doc.content || []) offset += index(node, offset);
  const root = { content: PR.esc(title), children: [], level: 0 };
  const headings = [root];
  function append(node, parent) {
    if (['bulletList', 'orderedList', 'taskList'].includes(node.type)) {
      (node.content || []).forEach((item, index) => {
        const parts = item.content || [];
        const first = parts[0];
        let content = first ? inline(first) : '';
        if (node.type === 'orderedList') content = ((node.attrs?.start || 1) + index) + '. ' + content;
        if (node.type === 'taskList') content = (item.attrs?.checked ? '☑ ' : '☐ ') + content;
        const branch = { content, children: [], payload: ranges.get(first || item) };
        parent.children.push(branch);
        parts.slice(1).forEach(part => append(part, branch));
      });
      return;
    }
    if (node.type === 'blockquote') {
      (node.content || []).forEach(part => append(part, parent));
      return;
    }
    if (node.type === 'horizontalRule') return;
    let content;
    if (node.type === 'blockMath') content = PR.tex(node.attrs.latex, true);
    else if (node.type === 'codeBlock') content = '<pre><code>' + PR.esc((node.content || []).map(n => n.text || '').join('')) + '</code></pre>';
    else if (node.type === 'table') content = '<table>' + (node.content || []).map(row => '<tr>' + (row.content || []).map(cell => '<td>' + inline(cell) + '</td>').join('') + '</tr>').join('') + '</table>';
    else content = inline(node);
    if (content.trim()) parent.children.push({ content, children: [], payload: ranges.get(node) });
  }
  for (const node of doc.content || []) {
    if (node.type === 'heading') {
      const level = node.attrs.level;
      while (headings.length > 1 && headings[headings.length - 1].level >= level) headings.pop();
      const branch = { content: inline(node), children: [], level, payload: ranges.get(node) };
      headings[headings.length - 1].children.push(branch);
      headings.push(branch);
    } else append(node, headings[headings.length - 1]);
  }
  return root.children.length === 1 && root.children[0].level === 1 ? root.children[0] : root;
}

function findMapNode(root, position) {
  let match = null;
  function visit(node, ancestors) {
    const range = node.payload;
    if (range && position >= range.from && position < range.to) match = { node, ancestors };
    for (const child of node.children || []) visit(child, [...ancestors, node]);
  }
  if (root) visit(root, []);
  return match;
}

PR.noteLibraries = { createEditor, Markmap, toMindMap, findMapNode, mountNoteToolbar, insertNoteImages };
