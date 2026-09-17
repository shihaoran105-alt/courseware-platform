/** 抽取层冒烟测试：node scripts/test-extract.mjs <文件...> */
import fs from 'node:fs/promises';
import path from 'node:path';
import { extractFile, buildContext, fileToText } from '../server/extract/index.mjs';

const files = process.argv.slice(2);
if (!files.length) {
  console.error('用法: node scripts/test-extract.mjs <文件...>');
  process.exit(1);
}

for (const f of files) {
  const abs = path.resolve(f);
  const name = path.basename(abs);
  const t0 = Date.now();
  try {
    const buffer = await fs.readFile(abs);
    const res = await extractFile({ buffer, originalName: name, storedPath: abs, mediaBase: '/media' });
    res.originalName = name;
    res.text = fileToText(res);
    const ms = Date.now() - t0;
    console.log(`\n=== ${name} ===`);
    console.log(`kind=${res.kind} blocks=${res.blocks.length} chars=${res.text.length} 用时=${ms}ms`);
    console.log(`meta=${JSON.stringify(res.meta)}`);
    console.log(`前 3 个 block:`);
    for (const b of res.blocks.slice(0, 3)) {
      console.log(`  [${b.label}] ${String(b.text).slice(0, 160).replace(/\n/g, ' / ')}`);
    }
    if (res.media?.length) console.log(`媒体文件: ${res.media.length} 个`);
    const ctx = buildContext([res], 2000);
    console.log(`上下文样例长度(截断到2000): ${ctx.length}`);
  } catch (err) {
    console.error(`\n=== ${name} === 失败: ${err.message}`);
    console.error(err.stack?.split('\n').slice(0, 4).join('\n'));
  }
}
