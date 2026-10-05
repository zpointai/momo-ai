// Audit-only observer. Never bundled in the desktop application.
/* eslint-disable @typescript-eslint/no-require-imports -- Synchronous CommonJS hook injected at the packaged main module's first statement. */
// Records API class and destination only: no request bodies, headers or credentials.
const audit = globalThis.__momoNetworkAudit = { phase: 'startup', events: [], workers: [], children: [] };
const record = (kind, host, port) => audit.events.push({ at: Date.now(), phase: audit.phase, kind, host: String(host ?? 'unknown'), port: port == null ? null : String(port) });
const destination = input => {
  try { const u = new URL(typeof input === 'string' ? input : input?.url ?? input?.href ?? input?.origin); return [u.hostname, u.port]; } catch { return [input?.hostname ?? input?.host ?? 'localhost', input?.port]; }
};
const wrap = (object, name, getDestination, kind = name) => {
  const original = object[name]; if (typeof original !== 'function') return;
  object[name] = function (...args) { record(kind, ...getDestination(args)); return Reflect.apply(original, this, args); };
};
wrap(globalThis, 'fetch', args => destination(args[0]));
require('node:diagnostics_channel').channel('undici:request:create').subscribe(({ request }) => record('undici', ...destination(request.origin)));
for (const name of ['http', 'https']) {
  const module = require('node:' + name);
  for (const method of ['request', 'get']) {
    const original = module[method];
    module[method] = function (...args) { record(name + '.' + method, ...destination(args[0])); return Reflect.apply(original, this, args); };
  }
}
wrap(require('node:net').Socket.prototype, 'connect', args => {
  let input = Array.isArray(args[0]) ? args[0] : args;
  if (typeof input[0] === 'object') return input[0].path ? ['local-pipe', null] : [input[0].host ?? 'localhost', input[0].port];
  return typeof input[0] === 'string' && !/^\d+$/.test(input[0]) ? ['local-pipe', null] : [input[1] ?? 'localhost', input[0]];
}, 'net.connect');
wrap(require('node:tls'), 'connect', args => typeof args[0] === 'object' ? [args[0].host ?? 'localhost', args[0].port] : [args[1] ?? 'localhost', args[0]], 'tls.connect');
const dns = require('node:dns');
for (const object of [dns, dns.promises, dns.Resolver.prototype, dns.promises.Resolver.prototype]) {
  for (const name of Object.getOwnPropertyNames(object).filter(n => /^(lookup|resolve|reverse)/.test(n))) {
    const original = object[name]; if (typeof original !== 'function') continue;
    object[name] = function (...args) { record('dns.' + name, args[0]); return Reflect.apply(original, this, args); };
  }
}
const udp = require('node:dgram');
wrap(udp.Socket.prototype, 'send', args => {
  const longs = typeof args[1] === 'number' && typeof args[2] === 'number' && typeof args[3] === 'number';
  return [args[longs ? 4 : 2] ?? 'connected-peer', args[longs ? 3 : 1]];
}, 'dgram.send');
wrap(udp.Socket.prototype, 'connect', args => [args[1] ?? 'localhost', args[0]], 'dgram.connect');
if (globalThis.WebSocket) {
  const Original = globalThis.WebSocket;
  globalThis.WebSocket = class extends Original { constructor(url, ...args) { record('WebSocket', ...destination(url)); super(url, ...args); } };
}
const cp = require('node:child_process');
for (const method of ['spawn', 'execFile', 'fork', 'exec', 'spawnSync', 'execFileSync', 'execSync']) {
  const original = cp[method];
  cp[method] = function (...args) {
    const child = Reflect.apply(original, this, args);
    audit.children.push({ at: Date.now(), phase: audit.phase, method, executable: require('node:path').basename(String(args[0])).slice(0,100), pid: child?.pid ?? null });
    return child;
  };
}
const threads = require('node:worker_threads'); const OriginalWorker = threads.Worker;
threads.Worker = class extends OriginalWorker {
  constructor(file, options) {
    // Node's cached startup arguments otherwise pause the storage worker too.
    // Explicitly remove only the audit debugger flag; no product code changes.
    super(file, { ...options, execArgv: (options?.execArgv ?? process.execArgv).filter(arg => !arg.startsWith('--inspect')) });
    audit.workers.push({ at: Date.now(), file: require('node:path').basename(String(file)), threadId: this.threadId });
  }
};
globalThis.__auditRequire = require;
