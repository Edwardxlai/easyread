const { isIP } = require('node:net');

function publicAddress(address) {
  if (isIP(address) === 6) return /^[23][0-9a-f]{3}:/i.test(address) && !address.startsWith('2001:db8:');
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b < 32) || (a === 192 && [0, 168].includes(b)) ||
    (a === 198 && ([18, 19].includes(b) || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113));
}

function webUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port &&
        host.includes('.') && !isIP(host) && !/\.(local|localhost|internal|test|onion)$/.test(host)) return url;
  } catch { /* Invalid URL. */ }
  return null;
}

function isolateSession(session, source, offline = false) {
  const resolving = new Map();
  function canResolve(url) {
    const host = url.hostname;
    if (!resolving.has(host)) {
      const pending = session.resolveHost(host)
        .then(async ({ endpoints }) => {
          const addresses = endpoints.map(endpoint => endpoint.address);
          if (!addresses.length) return false;
          if (addresses.every(publicAddress)) return true;
          // A system proxy may return synthetic DNS records. Accept its IPv4
          // benchmark range only when Chromium will use a local proxy exclusively.
          const fake = /^198\.(18|19)\./;
          if (!addresses.some(address => fake.test(address)) ||
              !addresses.every(address => publicAddress(address) || fake.test(address) || /^fdfe:dcba:9876:/i.test(address))) return false;
          const routes = (await session.resolveProxy(url.href)).split(';').map(route => route.trim());
          return routes.every(route => /^(PROXY|HTTPS|SOCKS5) (127\.0\.0\.1|localhost|\[::1\]):\d+$/i.test(route));
        })
        .catch(() => false)
        .finally(() => resolving.delete(host));
      resolving.set(host, pending);
    }
    return resolving.get(host);
  }
  session.setPermissionRequestHandler((_contents, _permission, done) => done(false));
  session.setPermissionCheckHandler(() => false);
  session.on('will-download', event => event.preventDefault());
  session.webRequest.onBeforeRequest((details, done) => {
    const isMain = details.resourceType === 'mainFrame';
    if (!isMain && /^(data:|blob:https:)/i.test(details.url)) return done({ cancel: false });
    const url = webUrl(details.url);
    if (!url || (isMain && url.origin !== source.origin) || !['GET', 'HEAD', 'OPTIONS'].includes(details.method)) {
      return done({ cancel: true });
    }
    if (offline) {
      url.hash = '';
      const redirect = offline.files[url.href]?.redirect;
      if (redirect && webUrl(redirect) && offline.files[redirect]) return done({redirectURL:redirect});
      return done({cancel:false}); // The local HTTPS handler supplies all response bodies.
    }
    canResolve(url).then(allowed => done({ cancel: !allowed }));
  });
}

module.exports = { webUrl, publicAddress, isolateSession };
