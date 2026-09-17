/** 语音转写测试：node scripts/test-stt.mjs <音频文件> [--provider local|xfyun|groq|openai] */
import { transcribe, sttState, findWhisperCli, findWhisperModel } from '../server/stt.mjs';
import { probeDuration, ffmpegState } from '../server/media-tools.mjs';

// 允许命令行临时切换服务商，方便逐个验证
const pFlag = process.argv.indexOf('--provider');
if (pFlag !== -1 && process.argv[pFlag + 1]) process.env.STT_PROVIDER = process.argv[pFlag + 1];

const file = process.argv[2];
if (!file || file.startsWith('--')) {
  console.error('用法: node scripts/test-stt.mjs <音频文件> [--provider local|xfyun|groq|openai]');
  process.exit(1);
}

const st = sttState();
console.log('=== 环境 ===');
console.log('  服务商     :', st.provider);
console.log('  说明       :', st.note);
console.log('  whisper-cli:', findWhisperCli() || '(无)');
console.log('  模型       :', findWhisperModel() || '(无)');
console.log('  ffmpeg     :', ffmpegState().available ? '可用' : '不可用');
console.log('  音频时长   :', Math.round(await probeDuration(file)), '秒');
console.log('\n=== 开始转写 ===');

const t0 = Date.now();
try {
  const r = await transcribe(file, { onProgress: (m) => console.log('  ·', m) });
  const secs = (Date.now() - t0) / 1000;
  const audio = await probeDuration(file);
  console.log(`\n✅ 成功 | 服务商=${r.provider} | 语言=${r.language || '(未返回)'} | 用时 ${secs.toFixed(1)}s`);
  if (audio > 0) console.log(`   速度：${(audio / secs).toFixed(1)}x 实时（${audio.toFixed(0)}s 音频用 ${secs.toFixed(1)}s）`);
  console.log('\n完整文本：');
  console.log('  ' + r.text);
  console.log('\n分句（带时间戳）：');
  r.segments.slice(0, 12).forEach((s, i) => console.log(`  ${String(i + 1).padStart(2)}. [${s.start.toFixed(1)}s - ${s.end.toFixed(1)}s] ${s.text}`));
  if (r.segments.length > 12) console.log(`  … 共 ${r.segments.length} 句`);
} catch (e) {
  console.log(`\n❌ 失败（用时 ${((Date.now() - t0) / 1000).toFixed(1)}s）:`);
  console.log('  ' + e.message);
}
