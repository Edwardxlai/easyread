async page => {
 const check=(x,m)=>{if(!x)throw Error(m)};
 const original = await page.evaluate(() => window.PR.state.reader.paper_note?.body || '');
 await page.evaluate(() => { window.PR.openPaperNote(); });
 await page.locator('[data-note-mode=source]').click(); await page.locator('#paperNote').fill(''); await page.locator('[data-note-mode=rich]').click();
 await page.setViewportSize({width:1440,height:1000});
 await page.locator('#b-p1-1 .zh').evaluate(el=>{const r=document.createRange();r.setStart(el.firstChild,0);r.setEnd(el.firstChild,25);const s=getSelection();s.removeAllRanges();s.addRange(r);el.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));});
 await page.locator('[data-s=paper-note]').click();
 await page.waitForFunction(()=>document.querySelector('.pn-prose a[href="#b-p1-1"]'));
 check((await page.locator('#paperNote').inputValue()).includes('#b-p1-1'),'source not serialized');
 await page.locator('[data-note-expand]').click();
 await page.locator('.pn-prose a[href="#b-p1-1"]').click();
 check(!await page.locator('#notespanel').evaluate(el=>el.classList.contains('pn-expanded')),'fullscreen not exited');
 check(new URL(page.url()).hash==='#b-p1-1','source jump failed');
 await page.locator('[data-paper-note-source=p1-1]').click();
 check((await page.evaluate(()=>getSelection().toString())).includes('第 1 页'),'reverse jump failed');
 await page.reload();
 await page.locator('[data-paper-note-source=p1-1]').click();
 check((await page.evaluate(()=>getSelection().toString())).includes('第 1 页'),'reload lost reference');
 await page.locator('[data-note-mode=source]').click(); await page.locator('#paperNote').fill(original); await page.locator('[data-note-mode=rich]').click(); await page.evaluate(() => window.PR.finishPanelNote());
 return {quote:true,sourceJump:true,reverseJump:true,persistence:true};
}
