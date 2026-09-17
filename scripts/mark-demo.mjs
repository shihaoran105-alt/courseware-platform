/** 给某个项目打上 shared 标记（所有人可读、仅创建者可写），用作公开演示项目 */
import fs from 'node:fs';
import path from 'node:path';
import { CACHE_DIR } from '../server/config.mjs';

const id = process.argv[2];
const mode = process.argv[3] || 'share'; // share | list | unshare

if (!id || id === 'list') {
  const files = fs.existsSync(CACHE_DIR) ? fs.readdirSync(CACHE_DIR).filter((f) => f.endsWith('.json')) : [];
  console.log('可用项目（id / 名称 / 文件数 / owner / shared）:');
  for (const f of files) {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f), 'utf8'));
      console.log(`  ${p.id}  ${p.shared ? '[共享]' : '[私有]'}  ${p.name}  文件${p.files?.length || 0}  owner=${p.owner || '(无)'}`);
    } catch {
      /* 忽略坏文件 */
    }
  }
  if (!id) {
    console.log('\n用法:');
    console.log('  node scripts/mark-demo.mjs list                     # 列出所有项目');
    console.log('  node scripts/mark-demo.mjs <projectId>              # 标记为公开演示（只读）');
    console.log('  node scripts/mark-demo.mjs <projectId> unshare      # 取消公开');
  }
  process.exit(0);
}

const file = path.join(CACHE_DIR, `${id}.json`);
if (!fs.existsSync(file)) {
  console.error(`找不到项目 ${id}`);
  process.exit(1);
}
const project = JSON.parse(fs.readFileSync(file, 'utf8'));
project.shared = mode !== 'unshare';
// 共享项目没有 owner，任何人（包括部署者）都不能改，避免误删
if (project.shared) project.owner = project.owner || '__demo__';
fs.writeFileSync(file, JSON.stringify(project), 'utf8');
console.log(`已${project.shared ? '设为公开演示' : '取消公开'}：${project.name}（${id}）`);
