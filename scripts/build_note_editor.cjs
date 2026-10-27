const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');
const sass = require('sass');

async function build() {
  const ui = path.resolve(__dirname, '../easyread/web/src/tiptap-ui');
  const styles = new Set();
  const result = await esbuild.build({
    entryPoints: [path.resolve(__dirname, '../easyread/web/src/note-libraries.js')],
    outfile: path.resolve(__dirname, '../easyread/web/vendor/note-libraries.js'),
    alias: { katex: path.resolve(__dirname, '../easyread/web/src/note-katex.js'), '@': ui },
    bundle: true, minify: true, format: 'iife', target: 'es2022', jsx: 'automatic',
    legalComments: 'linked', metafile: true,
    plugins: [{ name: 'note-ui-styles', setup(context) {
      context.onLoad({ filter: /\.scss$/ }, args => {
        styles.add(args.path);
        return { contents: '', loader: 'js' };
      });
    } }],
  });
  const uses = ['styles/_variables.scss', 'styles/_keyframe-animations.scss'].map(file => path.join(ui, file));
  uses.push(...styles);
  let css = sass.compileString(uses.map(file => '@use ' + JSON.stringify(path.relative(ui, file)) + ';').join('\n'), { loadPaths: [ui], style: 'compressed', logger: sass.Logger.silent }).css;
  // 官网主题变量与当前阅读页的深色模式共用；不改变页面排版。
  css = css.replace(/:root\{([^{}]*)\}/g, (_, body) => ':root{' + body.split(';').filter(value => value.trim().startsWith('--')).join(';') + '}')
    .replace(/\.dark\b/g, '[data-theme="dark"]').replace(/--white\b/g, '--tt-white').replace(/--black\b/g, '--tt-black');
  fs.writeFileSync(path.resolve(__dirname, '../easyread/web/vendor/note-libraries.css'), css);
  const packages = new Set(Object.keys(result.metafile.inputs).map(file => file.match(/node_modules\/((?:@[^/]+\/)?[^/]+)\//)?.[1]).filter(Boolean));
  const licenses = [...packages].sort().map(name => {
    const dir = path.resolve(__dirname, '../node_modules', name);
    const info = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const license = fs.readdirSync(dir).find(file => /^license(?:[.-].*)?$/i.test(file));
    const notice = license ? fs.readFileSync(path.join(dir, license), 'utf8') : [info.license, typeof info.author === 'string' ? info.author : info.author?.name, typeof info.repository === 'string' ? info.repository : info.repository?.url].filter(Boolean).join('\n');
    return name + ' ' + info.version + '\n\n' + notice;
  });
  licenses.push('Tiptap UI Components\nhttps://github.com/ueberdosis/tiptap-ui-components\n\n' + fs.readFileSync(path.join(ui, 'LICENSE'), 'utf8'));
  fs.writeFileSync(path.resolve(__dirname, '../easyread/web/vendor/note-libraries.LICENSE.txt'), licenses.join('\n\n---\n\n'));
}
build().catch(error => { console.error(error); process.exitCode = 1; });
