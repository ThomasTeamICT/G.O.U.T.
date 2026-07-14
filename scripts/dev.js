// Start API-server + Vite dev-server (en optioneel de mock-BRouter) samen.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const procs = [];
function run(name, cmd, args, env = {}) {
  const p = spawn(cmd, args, { stdio: 'inherit', env: { ...process.env, ...env } });
  p.on('exit', (code) => { if (code) process.exitCode = code; stop(); });
  procs.push(p);
  return p;
}
function stop() { for (const p of procs) p.kill('SIGTERM'); }
process.on('SIGINT', () => { stop(); process.exit(0); });

const env = {};
if (process.env.MOCK_BROUTER || process.argv.includes('--mock')) {
  run('mock', process.execPath, ['scripts/mock-brouter.js']);
  env.BROUTER_URL = 'http://localhost:17777';
}
run('server', process.execPath, ['--no-warnings', 'server/index.js'], env);
const viteBin = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
run('web', process.execPath, [viteBin, 'web']);
