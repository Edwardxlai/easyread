/* Connect the isolated article's text ranges to the ordinary reader commands. */
(function (PR) {
  "use strict";
  const bridge = window.easyreadDesktop && window.parent !== window && window.parent.easyreadInteractive;
  if (!bridge) return;
  const send = (command,data) => bridge.selection(PR.pid,command,data).catch(() => {});
  let token, lastMarks, backdrop;
  const dynamicTexts = new Map();
  const highlightRoots = new Map();
  PR.resolveLiveHighlight = (part, findQuote) => {
    if (!document.body.classList.contains("web-inline")) return null;
    const side = part.side || "zh";
    const key = (part.key || part.anchor) + "/" + side;
    const block = PR.blockById[part.anchor];
    const text = part.key?.startsWith("live-") ? dynamicTexts.get(key)
      : block?.web_runs?.map(run => side === "en" ? run.en : run.zh ?? run.en).join("");
    if (!text) return null;
    const start = findQuote(text, part.quote, part.prefix, part.suffix, part.start);
    if (start < 0) return null;
    if (!highlightRoots.has(key)) highlightRoots.set(key, document.createElement("span"));
    return {part, el:highlightRoots.get(key), text, start, end:start + part.quote.length};
  };
  PR.clearLiveSelection = current => { if (current === token) token = null; void send("clear",current); };
  PR.syncLiveMarks = force => {
    if (!document.body.classList.contains("web-inline")) return;
    const marks = PR.myNotes().filter(n => n.quote && !n.unmarked).flatMap(n =>
      (n.parts?.length ? n.parts : [n]).map(p => ({
        id:n.id,anchor:p.anchor,key:p.key || p.anchor,start:p.start || 0,quote:p.quote,side:p.side || "zh",
        style:n.style === "underline" ? "underline" : "marker",
        color:["yellow","green","blue","pink"].includes(n.color) ? n.color : "yellow"
      })));
    const signature = JSON.stringify(marks);
    if (force !== true && signature === lastMarks) return;
    lastMarks = signature;
    void send("marks",marks);
  };
  PR.on("original-marks", PR.debounce(() => PR.syncLiveMarks(), 20));
  PR.revealLiveMark = id => {
    if (!document.body.classList.contains("web-inline")) return false;
    void send("reveal",id); return true;
  };
  PR.displayLiveSelection = (bar, current) => {
    const r = bar.getBoundingClientRect(), frame = window.frameElement.getBoundingClientRect();
    const rect = {x:frame.x+r.x,y:frame.y+r.y,width:r.width,height:r.height};
    void send("toolbar",{token:current, rect, html:bar.innerHTML,shortcuts:!!PR.keysOn,theme:document.documentElement.dataset.theme || "light"});
  };
  async function keepPageBehindPopover() {
    const bounds = PR.inlineWebBounds();
    if (!bounds) return;
    const url = await send("backdrop");
    if (!url || !document.body.classList.contains("web-inline")) return;
    const offset = window.frameElement.getBoundingClientRect();
    if (!backdrop) {
      backdrop = document.createElement("img");
      backdrop.alt = ""; backdrop.className = "web-popover-backdrop";
      document.body.prepend(backdrop);
      new MutationObserver(() => {
        if (!document.querySelector("#popover.open")) backdrop.removeAttribute("src");
      }).observe(document.getElementById("popover"),{attributes:true,attributeFilter:["class"]});
    }
    Object.assign(backdrop.style,{left:bounds.x-offset.x+"px",top:bounds.y-offset.y+"px",width:bounds.width+"px",height:bounds.height+"px"});
    backdrop.src = url;
  }
  const partText = (b, side) => (b?.web_runs || []).map(r => side === "en" ? r.en : (r.zh ?? r.en)).join("");
  PR.receiveLiveSelection = async message => {
    if (message.shortcut && message.token === token) {
      if (message.shortcut === "escape") {
        PR.clearLiveSelection(token); PR.closeLiveSelection();
      } else {
        const action = {1:"yellow",2:"green",3:"blue",4:"pink",n:"note",q:"question"}[message.shortcut];
        if (action) PR.selectionAction(["n","q"].includes(message.shortcut) ? action : "highlight", ["n","q"].includes(message.shortcut) ? undefined : action);
      }
      return;
    }
    if (Number.isInteger(message.index)) {
      if (message.token !== token) return;
      const bar = document.getElementById("selbar");
      const button = bar.querySelectorAll("button")[message.index];
      if (!bar.classList.contains("open") || !button) return;
      if (["en","translate"].includes(button.dataset.s)) await keepPageBehindPopover();
      if (message.token !== token) return;
      window.focus();
      button.click();
      return;
    }
    token = message.token;
    const data = message.selection, bounds = PR.inlineWebBounds();
    if (!data || !bounds) { PR.closeLiveSelection(); return; }
    const r = data.rect, scale = message.scale || 1, f = window.frameElement.getBoundingClientRect();
    const rect = new DOMRect(bounds.x-f.x+r.x*scale,bounds.y-f.y+r.y*scale,r.width*scale,r.height*scale);
    if (data.mark) {
      const note = PR.myNotes().find(n => n.id === data.mark);
      if (note) {
        if (note.kind === "highlight") await keepPageBehindPopover();
        else if (!PR.notesPanelOpen()) PR.toggleNotesPanel(true);
        PR.noteMarkClick({getBoundingClientRect:()=>rect},note);
      }
      return;
    }
    const parts = [];
    for (const raw of data.parts || []) {
      if (raw.key?.startsWith("live-") && raw.value) {
        if (dynamicTexts.size >= 160) dynamicTexts.delete(dynamicTexts.keys().next().value);
        dynamicTexts.set(raw.key + "/" + raw.side, raw.value);
      }
      const block = PR.blockById[raw.anchor];
      const text = partText(block,raw.side);
      const start = text && text.slice(raw.start,raw.start+raw.quote.length) !== raw.quote && text.indexOf(raw.quote) >= 0
        ? text.indexOf(raw.quote) : raw.start;
      const prev = parts.at(-1);
      if (prev && text && prev.key === raw.key && (prev.side || "zh") === raw.side && start >= prev.start+prev.quote.length) {
        prev.quote = text.slice(prev.start,start+raw.quote.length);
        prev.suffix = text.slice(start+raw.quote.length,start+raw.quote.length+32);
      } else {
        parts.push({anchor:block ? block.id : "head", key:raw.key, start, quote:raw.quote,
          prefix:text ? text.slice(Math.max(0,start-32),start) : raw.prefix,
          suffix:text ? text.slice(start+raw.quote.length,start+raw.quote.length+32) : raw.suffix,
          ...(raw.side === "en" ? {side:"en"} : {})});
      }
    }
    if (!parts.length || parts.length>20) return;
    const first = parts[0];
    PR.showSelectionBar({...first, ...(parts.length>1 ? {parts,quote:parts.map(p=>p.quote).join("\n")} : {}),
      rect,liveToken:token,originalSurface:true,sourceText:PR.blockById[first.anchor]?.en || data.parts[0].original});
  };
})(window.PR);
