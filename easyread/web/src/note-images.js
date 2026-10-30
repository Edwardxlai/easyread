const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_NOTE_BYTES = 4 * 1024 * 1024;
const byteLength = text => new TextEncoder().encode(text).length;

// Upload, paste and drop all use the same bounded, all-or-nothing insertion.
export async function insertNoteImages(editor, files, position = editor.state.selection.from) {
  const PR = window.PR;
  const selected = Array.from(files).filter(file => file.type.startsWith('image/'));
  if (!selected.length || editor.isDestroyed) return false;
  const fail = message => { PR.toast(message); return false; };
  if (selected.some(file => file.size > MAX_IMAGE_BYTES)) {
    return fail(PR.t('笔记图片每张不能超过 2 MiB，请压缩后重试'));
  }
  // Reject oversized batches before allocating their base64 copies.
  const estimated = selected.reduce((sum, file) => sum + Math.ceil(file.size / 3) * 4 + byteLength(file.name || '') + 128, 0);
  if (byteLength(editor.getMarkdown()) + estimated > MAX_NOTE_BYTES) {
    return fail(PR.t('插入图片后笔记不能超过 4 MiB，请减少图片或压缩后重试'));
  }
  let at = position;
  const track = ({ transaction }) => { at = transaction.mapping.map(at, 1); };
  editor.on('transaction', track);
  try {
    const images = [];
    for (const file of selected) {
      const src = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Invalid image data'));
        reader.onerror = () => reject(reader.error || new Error('Image read failed'));
        reader.onabort = () => reject(new Error('Image read aborted'));
        reader.readAsDataURL(file);
      });
      if (editor.isDestroyed) return false;
      images.push({ type: 'image', attrs: { src, alt: file.name || PR.t('图片') } });
    }
    const added = images.reduce((sum, image) => sum + byteLength(image.attrs.src) + byteLength(image.attrs.alt) * 2 + 16, 0);
    if (byteLength(editor.getMarkdown()) + added > MAX_NOTE_BYTES) {
      return fail(PR.t('插入图片后笔记不能超过 4 MiB，请减少图片或压缩后重试'));
    }
    at = Math.max(0, Math.min(at, editor.state.doc.content.size));
    return editor.chain().focus().insertContentAt(at, images).run();
  } catch (_) {
    if (!editor.isDestroyed) fail(PR.t('读取笔记图片失败，请重新选择图片'));
    return false;
  } finally {
    editor.off('transaction', track);
  }
}
