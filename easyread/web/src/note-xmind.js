import { zipSync, strToU8 } from 'fflate';

export function exportXmind(root, filename) {
  let serial = 0;
  const topic = node => {
    const el = document.createElement('div'); el.innerHTML = node.content || '';
    const text = [...el.childNodes].map(child => child.textContent).join('\n').trim();
    const result = { id: 'topic-' + ++serial, class: 'topic', title: text };
    const link = el.querySelector('a[href]');
    if (link) {
      const href = link.getAttribute('href');
      if (href.startsWith('#b-')) {
        const PR = window.PR, hash = PR.state.paper.meta?.source_sha256;
        const query = new URLSearchParams(hash ? { sha256: hash } : { id: PR.pid });
        query.set('block', href.slice(1));
        result.href = 'easyread://open?' + query;
      } else result.href = href;
    }
    if (node.children?.length) result.children = { attached: node.children.map(topic) };
    return result;
  };
  const rootTopic = topic(root);
  rootTopic.structureClass = 'org.xmind.ui.logic.right';
  const files = {
    'content.json': [{ id: 'sheet-1', class: 'sheet', title: rootTopic.title, rootTopic }],
    'metadata.json': { creator: { name: 'EasyRead', version: '1.4.6' } },
    'manifest.json': { 'file-entries': { 'content.json': {}, 'metadata.json': {} } },
  };
  const data = zipSync(Object.fromEntries(Object.entries(files).map(([name, value]) => [name, strToU8(JSON.stringify(value))])));
  const url = URL.createObjectURL(new Blob([data], { type: 'application/octet-stream' }));
  const link = document.createElement('a'); link.href = url; link.download = filename + '.xmind'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
