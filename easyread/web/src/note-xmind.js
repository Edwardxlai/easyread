import { zipSync, strToU8 } from 'fflate';

export async function exportXmind(root, filename) {
  let serial = 0;
  const resources = {}, pending = [];
  const topic = node => {
    const el = document.createElement('div'); el.innerHTML = node.content || '';
    const text = [...el.childNodes].map(child => child.textContent).join('\n').trim();
    const result = { id: 'topic-' + ++serial, class: 'topic', title: text };
    const images = [...el.querySelectorAll('img[src]')];
    images.forEach((image, index) => {
      const destination = index === 0 ? result : { id: 'topic-' + ++serial, class: 'topic', title: image.alt || '' };
      if (index > 0) { result.children ||= { attached: [] }; result.children.attached.push(destination); }
      pending.push((async () => {
        const response = await fetch(image.src);
        if (!response.ok) throw new Error('Image export failed: ' + response.status);
        const blob = await response.blob();
        const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg' }[blob.type] || 'png';
        const path = 'resources/' + destination.id + '.' + extension;
        resources[path] = new Uint8Array(await blob.arrayBuffer());
        const imageUrl = URL.createObjectURL(blob);
        const original = new Image();
        try {
          original.src = imageUrl;
          await original.decode();
          const scale = Math.min(1, 320 / original.naturalWidth, 220 / original.naturalHeight);
          destination.image = {
            src: 'xap:' + path,
            width: Math.max(1, Math.round(original.naturalWidth * scale)),
            height: Math.max(1, Math.round(original.naturalHeight * scale)),
          };
        } finally { URL.revokeObjectURL(imageUrl); }
      })());
    });
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
    if (node.children?.length) result.children = { attached: [...(result.children?.attached || []), ...node.children.map(topic)] };
    return result;
  };
  const rootTopic = topic(root);
  rootTopic.structureClass = 'org.xmind.ui.logic.right';
  await Promise.all(pending);
  const files = {
    'content.json': [{ id: 'sheet-1', class: 'sheet', title: rootTopic.title, rootTopic }],
    'metadata.json': { creator: { name: 'EasyRead', version: '1.4.6' } },
    'manifest.json': { 'file-entries': { 'content.json': {}, 'metadata.json': {}, ...Object.fromEntries(Object.keys(resources).map(path => [path, {}])) } },
  };
  const data = zipSync({ ...resources, ...Object.fromEntries(Object.entries(files).map(([name, value]) => [name, strToU8(JSON.stringify(value))])) });
  const url = URL.createObjectURL(new Blob([data], { type: 'application/octet-stream' }));
  const link = document.createElement('a'); link.href = url; link.download = filename + '.xmind'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
