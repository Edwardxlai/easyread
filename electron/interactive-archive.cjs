const fs = require('node:fs/promises');
const path = require('node:path');
const { createReadStream } = require('node:fs');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { createHash, randomUUID } = require('node:crypto');
const { webUrl } = require('./interactive-network.cjs');

const maxFiles = 512, maxBytes = 512 * 1024 * 1024, maxFile = 128 * 1024 * 1024;
const indexFile = dir => path.join(dir, 'index.json');

async function read(dir, source) {
  try {
    const index = JSON.parse(await fs.readFile(indexFile(dir), 'utf8'));
    if (index.source === source && index.files?.[source]) return index;
  } catch {}
  return null;
}

async function collect(entry) {
  const { dir, urls, url, contents } = entry;
  const session = contents.session;
  const discovered = await contents.executeJavaScriptInIsolatedWorld(999, [{code:
    "Array.from(document.querySelectorAll('img[src],source[src],script[src],link[rel=stylesheet],iframe[src]')).slice(0,512).map(e=>e.currentSrc||e.src||e.href)"}]);
  const candidates = new Set([url.href, ...urls.keys(), ...discovered.filter(value => webUrl(value))]);
  const files = Object.create(null), skipped = [];
  let bytes = 0, missed = 0;
  await fs.mkdir(dir, {recursive: true});
  const iterator = candidates.values();
  let attempted = 0;
  async function worker() {
    for (const target of iterator) {
      if (attempted++ >= maxFiles) break;
      if (entry.abort.signal.aborted) throw new Error('Page closed');
      if (bytes >= maxBytes) { missed++; continue; }
      const redirect = urls.get(target);
      if (redirect && webUrl(redirect)) { files[target] = {redirect}; candidates.add(redirect); continue; }
      const signal = AbortSignal.any([entry.abort.signal, AbortSignal.timeout(120000)]);
      let response, reserved = 0;
      try {
        response = await session.fetch(target, {credentials:'omit', redirect:'manual', signal, cache:'force-cache'});
        if ([301,302,303,307,308].includes(response.status)) {
          const location = response.headers.get('location');
          const next = location && webUrl(new URL(location, target).href);
          if (!next) throw new Error('Unavailable redirect');
          files[target] = {redirect:next.href};
          candidates.add(next.href);
          await response.body?.cancel();
          continue;
        }
        if (response.status !== 200 || Number(response.headers.get('content-length')) > maxFile ||
            /private|no-store/i.test(response.headers.get('cache-control') || '') ||
            /(?:^|,)\s*(?:\*|cookie)\s*(?:,|$)/i.test(response.headers.get('vary') || '') ||
            response.headers.has('set-cookie')) throw new Error('Not public');
        const hash = createHash('sha256');
        const temporary = path.join(dir, randomUUID()+'.tmp');
        const counter = new Transform({transform(chunk, _, done) {
          if (reserved + chunk.length > maxFile || bytes + chunk.length > maxBytes) return done(new Error('Resource limit'));
          reserved += chunk.length;
          bytes += chunk.length;
          hash.update(chunk);
          done(null, chunk);
        }});
        let blob;
        try {
          const handle = await fs.open(temporary, 'wx');
          await pipeline(Readable.fromWeb(response.body), counter, handle.createWriteStream(), {signal});
          blob = hash.digest('hex');
          await fs.rename(temporary, path.join(dir,blob));
        } finally { await fs.unlink(temporary).catch(()=>{}); }
        const headers = Object.fromEntries(response.headers);
        for (const name of ['content-length','content-encoding','transfer-encoding','connection','set-cookie','report-to','nel','alt-svc','link']) delete headers[name];
        files[target] = {blob, headers};
      } catch (error) {
        bytes -= reserved;
        skipped.push({url:target, reason:error.message, status:response?.status});
        missed++;
        await response?.body?.cancel().catch(() => {});
      }
    }
  }
  const workers = await Promise.allSettled([worker(), worker()]);
  const failed = workers.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
  if (!files[url.href]?.blob || !/html/i.test(files[url.href].headers['content-type'] || '')) throw new Error('无法保存网页正文');
  if (entry.abort.signal.aborted) throw new Error('Page closed');
  // A later visit may exercise different lazy controls on the same document revision.
  const previous = await read(dir, url.href);
  if (previous?.files[url.href]?.blob === files[url.href].blob) {
    for (const [key, item] of Object.entries(previous.files)) {
      if (files[key] || candidates.has(key) || Object.keys(files).length >= maxFiles) continue;
      const length = item.blob && /^[0-9a-f]{64}$/.test(item.blob) ? (await fs.stat(path.join(dir,item.blob)).catch(()=>null))?.size : 0;
      if (length == null || bytes + length > maxBytes) continue;
      files[key] = item;
      bytes += length;
    }
  }
  const index = {source:url.href, files, skipped, bytes, missed:missed + Math.max(0,candidates.size-maxFiles)};
  const temp = path.join(dir, randomUUID()+'.tmp');
  await fs.writeFile(temp, JSON.stringify(index));
  await fs.rename(temp,indexFile(dir));
  const kept = new Set(Object.values(files).map(item => item.blob));
  for (const name of await fs.readdir(dir)) {
    if (/^[0-9a-f]{64}$/.test(name) && !kept.has(name)) await fs.unlink(path.join(dir,name)).catch(()=>{});
  }
  return {count:Object.keys(files).length, missed:index.missed};
}

const writers = new Map();
function save(entry) {
  const prior = writers.get(entry.dir) || Promise.resolve();
  const task = prior.catch(() => {}).then(() => collect(entry)).finally(() => {
    if (writers.get(entry.dir) === task) writers.delete(entry.dir);
  });
  writers.set(entry.dir, task);
  return task;
}

function prepareMedia(index) {
  // Media elements seek against the original URL. Serve public CDN aliases at
  // that address so Chromium receives the actual 206 status and byte range.
  for (const [source, item] of Object.entries(index.files)) {
    const target = item.redirect && index.files[item.redirect];
    if (!target?.blob) continue;
    const origin = new URL(source).origin;
    const cors = target.headers['access-control-allow-origin'];
    if (new URL(item.redirect).origin !== origin && cors !== '*' && cors !== origin) continue;
    if (!/^(audio\/[\w.+-]+|video\/[\w.+-]+|image\/(?:png|jpe?g|webp|gif|avif))(?:;|$)/i.test(target.headers['content-type'] || '')) continue;
    index.files[source] = {blob:target.blob, headers:{...target.headers,
      'content-security-policy':"sandbox; default-src 'none'", 'x-content-type-options':'nosniff'}};
  }
}

function replay(session, dir, index, onMiss) {
  prepareMedia(index);
  session.enableNetworkEmulation({offline:true});
  session.protocol.handle('https', async request => {
    const url = new URL(request.url); url.hash = '';
    const item = index.files[url.href];
    if (!item || !['GET','HEAD'].includes(request.method)) {onMiss(); return Response.error();}
    if (item.redirect && webUrl(item.redirect)) return Response.redirect(item.redirect, 302);
    if (!/^[0-9a-f]{64}$/.test(item.blob)) return Response.error();
    try {
      const file = path.join(dir, item.blob), {size} = await fs.stat(file);
      const headers = new Headers(item.headers);
      headers.set('accept-ranges', 'bytes');
      const range = request.headers.get('range');
      const match = range && /^bytes=(\d*)-(\d*)$/.exec(range);
      let start = 0, end = size - 1;
      if (range) {
        if (match) {
          start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
          end = match[1] && match[2] ? Math.min(end, Number(match[2])) : end;
        }
        if (!match || !(match[1] || match[2]) || start > end || start >= size) {
          return new Response(null, {status:416, headers:{'content-range':'bytes */' + size}});
        }
        headers.set('content-range', 'bytes ' + start + '-' + end + '/' + size);
      }
      headers.set('content-length', String(end - start + 1));
      const body = size && request.method !== 'HEAD' ? Readable.toWeb(createReadStream(file, {start,end})) : null;
      return new Response(body, {status:range ? 206 : 200, headers});
    } catch { onMiss(); return Response.error(); }
  });
}

module.exports = { read, save, replay, maxFiles };
