/* Paint and erase plain highlights by character range, including older overlapping marks. */
(function (PR) {
  "use strict";
  const spans = note => note.parts?.length ? note.parts : [note];
  const overlaps = (a, b) => a.el === b.el && a.start < b.end && b.start < a.end;
  const touches = (ranges, other) => ranges.some(a => other.some(b => overlaps(a, b)));

  function union(ranges) {
    const sorted = [...ranges].sort((a, b) => a.el === b.el ? a.start - b.start :
      (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    const result = [];
    for (const range of sorted) {
      const last = result[result.length - 1];
      if (last && last.el === range.el && range.start <= last.end) last.end = Math.max(last.end, range.end);
      else result.push({ ...range });
    }
    return result;
  }

  // Keep the portions on either side as independent notes after erasing a selection.
  function outside(ranges, cuts) {
    const groups = [[]];
    for (const range of ranges) {
      let start = range.start;
      for (const cut of cuts.filter(c => overlaps(c, range))) {
        if (cut.start > start) groups[groups.length - 1].push({ ...range, start, end: cut.start });
        groups.push([]);
        start = Math.max(start, cut.end);
      }
      if (start < range.end) groups[groups.length - 1].push({ ...range, start });
    }
    return groups.filter(group => group.length);
  }

  function anchored(note, ranges) {
    const parts = ranges.map(({ part, text, start, end }) => ({
      anchor: part.anchor, key: part.key, ...(part.side ? { side: part.side } : {}),
      ...(part.math ? { math: true } : {}), start, quote: text.slice(start, end),
      prefix: text.slice(Math.max(0, start - 32), start), suffix: text.slice(end, end + 32),
    }));
    const result = { ...note };
    delete result.parts; delete result.side; delete result.math;
    Object.assign(result, parts[0]);
    if (parts.length > 1) {
      result.parts = parts;
      result.quote = parts.map(p => p.quote.trim()).join("\n");
    }
    return result;
  }

  const pen = n => n.style === "underline" ? "underline" : "marker";
  const annotated = n => !!(n.body?.trim() || n.media_refs?.length || PR.repliesTo(n.id).length);
  const contains = (ranges, part) => ranges.some(r => r.el === part.el && r.start <= part.start && r.end >= part.end);

  function removeMark(n) {
    if (annotated(n)) PR.saveNote({ ...n, unmarked: true });
    else PR.commit({ op: "note_del", id: n.id });
  }

  PR.toggleHighlight = function (note, resolve, intent = "toggle") {
    const selected = spans(note).map(resolve);
    const candidates = PR.myNotes().filter(n => n.kind === "highlight" && !n.unmarked);
    if (selected.some(r => !r)) {
      if (intent === "erase") removeMark(note);
      else PR.saveNote(note);
      return { id: note.id, erased: intent === "erase" };
    }
    const cache = new Map();
    function intersecting(ranges, n) {
      if (!spans(n).some(p => ranges.some(r => r.part.anchor === p.anchor))) return null;
      if (!cache.has(n)) cache.set(n, spans(n).map(resolve));
      const old = cache.get(n);
      return old.every(Boolean) && touches(ranges, old) ? old : null;
    }
    const same = candidates.filter(n => pen(n) === pen(note) && (n.color || "yellow") === (note.color || "yellow"));
    const merged = new Set();
    let paint = union(selected);
    let previousSize;
    do {
      previousSize = merged.size;
      for (const n of same) {
        if (merged.has(n)) continue;
        const old = intersecting(paint, n);
        if (old) { merged.add(n); paint = union([...paint, ...old]); }
      }
    } while (merged.size !== previousSize);
    const covered = union([...merged].flatMap(n => cache.get(n)));
    const erased = intent === "erase" || (intent === "toggle" && selected.every(s => contains(covered, s)));
    const cuts = erased ? union(selected) : paint;
    // Retain the original ID when restyling a whole mark. Keep an attached
    // note's quotation intact when only part of its painted range changes.
    const reusable = !erased ? candidates.filter(n => {
      const old = intersecting(cuts, n);
      return old && old.every(r => contains(cuts, r)) &&
        (!annotated(n) || cuts.every(r => contains(old, r)));
    }) : [];
    const keeper = reusable.find(n => n.id === note.id) || reusable.find(annotated) || reusable[0];
    let undoId = keeper?.id || note.id;
    PR.groupAnnotations(() => {
      for (const n of candidates) {
        if (n === keeper) continue;
        const old = intersecting(cuts, n);
        if (!old) continue;
        if (erased) undoId = n.id;
        const remaining = outside(old, cuts);
        const attached = annotated(n);
        if (!remaining.length || attached) removeMark(n);
        remaining.forEach((group, i) => {
          const base = i || attached ? {
            id: PR.uid("n"), kind: "highlight", color: n.color, style: n.style, body: "", created: PR.nowIso(),
          } : n;
          PR.saveNote(anchored(base, group));
        });
      }
      if (!erased) {
        const base = keeper || (candidates.some(n => n.id === note.id)
          ? { id: PR.uid("n"), kind: "highlight", created: PR.nowIso(), body: "" } : note);
        const result = anchored(base, paint);
        result.color = note.color || "yellow";
        if (pen(note) === "underline") result.style = "underline";
        else delete result.style;
        undoId = result.id;
        PR.saveNote(result);
      }
    });
    return { id: undoId, erased };
  };
})(window.PR);
