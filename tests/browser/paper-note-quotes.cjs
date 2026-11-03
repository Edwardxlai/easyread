async page => {

 if (!await page.locator('body').evaluate(el => el.classList.contains('np-open'))) await page.getByRole('button',{name:'笔记',exact:true}).click(); await page.locator('[data-np=paper]').click();
 await page.locator('[data-note-mode=source]').click();
 const original = await page.locator('#paperNote').inputValue();
 const anchor = await page.locator('#paper .blk').first().getAttribute('data-id');
 const text='> '+ '这是一个长段落引用，用来验证只展示两行并且保留完整文字。'.repeat(12)+' [第 1 页](#b-'+anchor+')';
 await page.locator('#paperNote').fill(text); await page.locator('[data-note-mode=rich]').click();
 await page.waitForSelector('.pn-quote-collapsed');
 const box=page.locator('.pn-quote-content');
 const before=await box.boundingBox();
 await page.getByRole('button',{name:'展开引用',exact:true}).click();
 if((await box.boundingBox()).height<=before.height)throw Error('not expanded');
 await page.getByRole('button',{name:'收起引用',exact:true}).click();
 if(await page.locator('#paperNote').inputValue()!==text)throw Error('content changed');
 await page.locator('.pn-quote-controls a').click();
 if(!page.url().endsWith('#b-'+anchor))throw Error('source failed');
 await page.locator('[data-note-mode=source]').click(); await page.locator('#paperNote').fill(original); await page.locator('[data-note-mode=rich]').click();
 return {collapsedHeight:before.height,expand:true,source:true,contentPreserved:true};
}
