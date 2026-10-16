/**
 * 把平台的思维导图树转成 **dsh-mindmap 插件认的 markdown**。
 *
 * 插件的规则（照它的说明写的）：
 *   · 文件名（去掉 .md）= 根节点标题
 *   · `#` 标题按层级嵌套：H1 是根的子节点，H2 挂在前面那个 H1 下面
 *   · 列表项按 2 空格缩进决定父子；`-` 后面留空 → 占位节点
 *   · 围栏代码块 → 一个叶子节点；普通段落 → 挂在最近的标题下
 *
 * 平台的树是 { label, children: [...] }。对应关系：
 *   根 label        → 文件名
 *   根的第 1 层子节点 → `#` 标题
 *   第 2 层及更深     → 逐级缩进的列表项
 *
 * 这个文件**不碰 Node 内置模块**，纯字符串处理，静态版也能用。
 */

/** markdown 里有特殊含义、会破坏标题/列表结构的字符，转义掉 */
function safeText(raw) {
  return String(raw ?? '')
    .replace(/[\r\n]+/g, ' ') // 换行会把一个节点劈成两个
    .replace(/\s+/g, ' ')
    .trim();
}

/** 标题里不能出现的：开头的 # 会让层级错乱 */
function headingText(raw) {
  return safeText(raw)
    .replace(/^#+\s*/, '')
    .replace(/#+\s*$/, '')
    .trim();
}

/** 列表项里不能出现的：换行已处理，行首再挡一次 - * + */
function listText(raw) {
  return safeText(raw)
    .replace(/^[-*+]\s+/, '')
    .trim();
}

/**
 * 文件名。插件的根节点就是这个文件名，所以直接用根的 label。
 * 去掉文件系统不接受的字符（Windows 上这些都不能出现在文件名里）。
 */
export function mindmapFileName(label, { fallback = '思维导图' } = {}) {
  const base = safeText(label)
    // eslint-disable-next-line no-useless-escape
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/^\.+/, '') // 开头的点会被当成隐藏文件
    .replace(/\.+$/, '') // 结尾的点在 Windows 上会被吃掉
    .slice(0, 60)
    .trim();
  return base || fallback;
}

/**
 * 树 → markdown 正文。
 * @param {{title?:string, root?:{label?:string, children?:Array}}} mm
 * @returns {string} 以换行结尾的 markdown；没有可用节点时返回空串
 */
export function mindmapToMarkdown(mm) {
  const root = mm?.root;
  if (!root || !root.children?.length) return '';

  const lines = [];
  const top = root.children || [];

  for (const branch of top) {
    const label = headingText(branch?.label);
    if (!label) continue;
    lines.push(`# ${label}`);
    // 第 2 层开始用列表，逐级多缩进 2 格（插件按 2 空格算父子）
    for (const leaf of branch?.children || []) {
      // 空 label 写成占位节点：插件会画成一个待填的节点，
      // 比直接丢掉更忠实于模型给的结构
      lines.push('- ' + listText(leaf?.label));
      for (const sub of leaf?.children || []) {
        lines.push('  - ' + listText(sub?.label));
        for (const deep of sub?.children || []) {
          lines.push('    - ' + listText(deep?.label));
          for (const deeper of deep?.children || []) {
            lines.push('      - ' + listText(deeper?.label));
          }
        }
      }
    }
    lines.push(''); // 分支之间空一行，插件那边更好读
  }

  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
  return text ? text + '\n' : '';
}

/** 这份脑图能不能导出（有没有内容） */
export function mindmapExportable(mm) {
  return Boolean(mindmapToMarkdown(mm));
}
