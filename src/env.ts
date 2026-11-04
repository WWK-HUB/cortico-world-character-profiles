/**
 * 部署环境读取（独立小模块）。
 *
 * 为什么单独一个文件：CORTICO_HOME 是宿主 Core 在拉起扩展进程时注入的部署根
 * （见 Coopanion core/boot.ts），是本扩展与宿主的全部接合点。把「环境变量的
 * 读取 + 安全校验」收敛在一个无副作用的模块里，引导代码只消费校验过的值，
 * 不再把原始环境取值散布到文件系统操作里。
 */
import { isAbsolute, resolve } from 'node:path';

/**
 * 宿主注入的部署根（CORTICO_HOME）。
 *
 * 显式校验，全部针对**原始输入**（Codex 审查：先 resolve 再 isAbsolute 会把
 * `relative-home` 折叠成 `<cwd>/relative-home` 而被误接受）：
 *  - 原始字符串必须是绝对路径（盘符/UNC，按平台语义）；
 *  - 原始字符串不含向上穿越（..）段——resolve() 会把 .. 折叠进绝对路径，
 *    所以穿越检查必须在折叠前做；
 *  - 校验不过返回 null，调用方完全不动磁盘。
 */
export function corticoHome(): string | null {
  const raw = process.env.CORTICO_HOME;
  if (!raw || !raw.trim()) return null;
  if (raw.split(/[\\/]+/).includes('..')) return null;
  // 原始取值就必须已经是绝对路径；相对路径一律拒绝，绝不用 cwd 补全后放行。
  if (!isAbsolute(raw)) return null;
  const resolved = resolve(raw);
  if (!isAbsolute(resolved)) return null;
  return resolved;
}

/** 测试探针开关：CORTICO_PROBE_* 系列只在本扩展自己的测试里使用。 */
export function probeEnv(name: string): string | undefined {
  return process.env[name];
}
