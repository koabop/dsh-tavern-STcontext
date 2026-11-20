import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [ref, destination = '.'] = process.argv.slice(2);
if (ref !== 'HEAD' && !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(ref || '')) {
  throw new Error('用法：npm run package:release -- <v版本标签 | HEAD> [输出目录]');
}

const cwd = fileURLToPath(new URL('../', import.meta.url));
const git = (...args) => execFileSync('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
const revision = ref === 'HEAD' ? ref : 'refs/tags/' + ref;
const commit = git('rev-parse', '--verify', revision + '^{commit}').toString().trim();
const at = file => git('show', commit + ':' + file);
const pkg = JSON.parse(at('package.json'));
if (pkg.name !== 'dsh-tavern-STcontext' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version)) {
  throw new Error('package.json 的包名或版本无效');
}
if (ref !== 'HEAD' && ref !== 'v' + pkg.version) throw new Error('发布标签与 package.json 版本不一致');

const manifest = JSON.parse(at('lib/vendor/manifest.json'));
for (const [name, expected] of Object.entries(manifest.hashes)) {
  if (createHash('sha256').update(at('lib/vendor/' + name)).digest('hex') !== expected) {
    throw new Error('运行文件校验失败：' + name);
  }
}

const notices = git('ls-tree', '--name-only', '-z', commit).toString().split('\0')
  .filter(name => /^(LICENSE|COPYING|NOTICE)(?:\.[\w-]+)?$/i.test(name));
const archive = git('archive', '--format=zip', '-9', commit, '--', 'package.json', 'index.mjs', 'client.js', 'lib', ...notices);
const output = resolve(destination);
const file = `${pkg.name}-v${pkg.version}.zip`;
mkdirSync(output, { recursive: true });
writeFileSync(join(output, file), archive);
console.log(JSON.stringify({ file, version: pkg.version, commit, size: archive.length,
  sha256: createHash('sha256').update(archive).digest('hex') }, null, 2));
