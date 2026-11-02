import Blockquote from '@tiptap/extension-blockquote';

export const NoteQuote = Blockquote.extend({
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement('blockquote');
      const contentDOM = document.createElement('div');
      const controls = document.createElement('div');
      const toggle = document.createElement('button');
      const source = document.createElement('a');
      contentDOM.className = 'pn-quote-content';
      controls.className = 'pn-quote-controls';
      controls.contentEditable = 'false';
      toggle.type = 'button';
      controls.append(toggle, source); dom.append(contentDOM, controls);
      let expanded = false, href = '', title = '';
      const measure = () => {
        const line = parseFloat(getComputedStyle(contentDOM).lineHeight);
        const long = !!href && contentDOM.scrollHeight > line * 2 + 2;
        dom.classList.toggle('pn-quote-collapsed', long && !expanded);
        controls.hidden = !href; toggle.hidden = !long;
        toggle.textContent = window.PR.t(expanded ? '收起引用' : '展开引用');
        toggle.setAttribute('aria-expanded', String(expanded));
        source.href = href; source.textContent = title;
      };
      const read = current => {
        href = ''; title = '';
        const anchors = [], pages = [];
        current.descendants(child => {
          const link = child.marks.find(mark => mark.type.name === 'link' && /^#b-[\w-]+$/.test(mark.attrs.href));
          if (link) { if (!href) href = link.attrs.href; anchors.push(link.attrs.href.slice(3)); const page = window.PR.blockById[link.attrs.href.slice(3)]?.page; if (page) pages.push(page); }
        });
        const unique = [...new Set(pages)].sort((a, b) => a - b);
        title = unique.length ? '↗ ' + window.PR.t('第 {page} 页', { page: unique.length === 1 ? unique[0] : unique[0] + '–' + unique[unique.length - 1] }) : window.PR.t('来源');
        source.dataset.noteSources = [...new Set(anchors)].join(' ');
        dom.classList.toggle('pn-source-quote', !!href);
        requestAnimationFrame(measure);
      };
      toggle.addEventListener('mousedown', event => event.preventDefault());
      toggle.addEventListener('click', () => { expanded = !expanded; measure(); });
      contentDOM.addEventListener('focusin', () => { expanded = true; measure(); });
      const observer = new ResizeObserver(measure); observer.observe(contentDOM);
      read(node);
      return {
        dom, contentDOM,
        update(next) { if (next.type !== node.type) return false; node = next; read(next); return true; },
        ignoreMutation(mutation) { return controls.contains(mutation.target) || mutation.type === 'attributes' && mutation.target === dom; },
        stopEvent(event) { return controls.contains(event.target); },
        destroy() { observer.disconnect(); },
      };
    };
  },
});
