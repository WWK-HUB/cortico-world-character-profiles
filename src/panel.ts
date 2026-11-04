/**
 * 角色管理面板（阶段二）：世界实例 webUi() 的数据面与声明。
 *
 * 面板只做三类事，全部复用 roles.ts 已验证的机制，不引入新的磁盘写法：
 *  - 查看：活动角色、角色清单、可用外观、切换日志与人话解释；
 *  - 管理：创建角色（全新部署骨架，不复制任何角色私密数据）、改名、绑定/解除绑定
 *    外观、排定切换、恢复原始角色；
 *  - 编辑：角色工作区（= 该角色 memory 目录）里的 Markdown 人设文档。
 *
 * 不提供删除角色：停用与解除绑定都不能删除角色档案（用户硬性约束）。
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, extname, join, resolve, sep } from 'node:path';
import type { ConfigGroup } from 'cortico/world';
import {
  ensureRoleFigureLibrary,
  pendingSwitch,
  pinRoleFigure,
  pinRoleStorage,
  readIndex,
  readJournal,
  readPointer,
  roleDataDir,
  roleDirsOnDisk,
  roleEffectiveDataDir,
  rolePaths,
  writeIndex,
  writeJournal,
  writeRoleConfig,
  type SwitchJournal,
} from './roles.js';

/** 面板数据面依赖：由 index.ts 的 create() 注入，避免与 index.ts 循环导入。 */
export interface PanelDeps {
  home: string;
  botDir: string;
  /** 排定一次「下次启动生效」的切换（复用 index.ts 的 scheduleSwitch 事务）。 */
  requestSwitch(roleLabel: string, figure: string | null): { scheduled: boolean; detail: string };
}

/** 面板面板 id：客户端 bundle 的 panels 键与服务端声明共用。 */
export const PANEL_PROFILES = 'profiles';
export const PANEL_SWITCH = 'switch-state';

/** 面板声明的服务端面板清单（webUi().panels）。 */
export function panelDecls(): Array<{ id: string; title: string; description?: string; getMethods?: readonly string[] }> {
  return [
    {
      id: PANEL_PROFILES,
      title: '角色档案',
      description: '创建角色、编辑人设、绑定外观、切换与恢复原始角色。',
      getMethods: ['state', 'figures'],
    },
    {
      id: PANEL_SWITCH,
      title: '切换状态',
      description: '当前切换事务、错误原因与恢复入口。',
      getMethods: ['state'],
    },
  ];
}

/** 世界页顶部状态灯文案（webUi().lamps 由 index.ts 组装）。 */
export interface PanelLamp {
  state: 'online' | 'offline' | 'loading' | 'error';
  hint: string;
}

/** 由切换日志推导的总体状态灯。 */
export function panelLamp(home: string): PanelLamp {
  const journal = readJournal(home);
  const pending = pendingSwitch(home);
  if (pending) {
    return {
      state: 'loading',
      hint: pending.status === 'prepared'
        ? `切换 ${pending.from ?? '-'} -> ${pending.to} 已排定，等待伴侣重启`
        : `已指向 ${pending.to}，等待目标启动确认`,
    };
  }
  if (journal && (journal.status === 'reverted' || journal.status === 'failed')) {
    return { state: 'error', hint: journal.error ?? `上次切换未生效（${journal.status}）` };
  }
  if (journal && journal.status === 'blocked') {
    return { state: 'error', hint: journal.error ?? '切换被阻塞' };
  }
  const index = readIndex(home);
  if (!index) return { state: 'offline', hint: '还没有角色注册表：先正常启动一次伴侣' };
  return { state: 'online', hint: `当前角色：${index.active}` };
}

// ───────────────────────────── 状态读取 ─────────────────────────────

export interface PanelRole {
  id: string;
  label: string;
  /** 绑定的外观（index 记录；解除绑定后为 null）。 */
  figure: string | null;
  /** 角色当前 config 里的 figure（可能与绑定不同：解绑后保留上次外观）。 */
  configFigure: string | null;
  createdAt: string | null;
  active: boolean;
  /** 角色工作区里的 Markdown 文档数（人设编辑入口）。 */
  docs: number;
}

export interface PanelState {
  active: string | null;
  originalRoleId: string;
  pointer: string | null;
  roles: PanelRole[];
  /** 磁盘上有目录但不在注册表里的角色 id（孤儿提示，不自动动它）。 */
  orphans: string[];
  journal: SwitchJournal | null;
  lamp: PanelLamp;
  /** 原始角色是否存在（恢复入口）。 */
  hasOriginal: boolean;
  /** 本扩展自己的诊断日志尾部（import 期结论，供排查）。 */
  logTail: string[];
}

function figureOfConfig(config: Record<string, any> | null): string | null {
  const figure = config?.worlds?.['desktop-pet']?.skin?.figure;
  return typeof figure === 'string' && figure ? figure : null;
}

function readRoleConfig(home: string, id: string): Record<string, any> | null {
  try {
    return JSON.parse(readFileSync(join(rolePaths(home).roleDir(id), 'config.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 改进（审查：面板每 3~4 秒全量读取日志、遍历全部角色工作区）：
 *  - 日志只读文件尾部（16KB 窗口内取最后 8 行），不再整文件同步读；
 *  - 文档计数带 15 秒 TTL 缓存（新绑定/改名走 index/config，每次都现读，不受缓存影响；
 *    面板保存文档成功时主动失效本角色计数）。
 */
export function readLogTail(home: string, maxBytes = 16 * 1024, lines = 8): string[] {
  const file = join(home, 'character-profiles', 'extension.log');
  let stat;
  try {
    stat = statSync(file);
  } catch {
    return [];
  }
  const size = stat.size;
  if (size === 0) return [];
  const start = Math.max(0, size - maxBytes);
  let chunk: string;
  let fh: number | undefined;
  try {
    // 只读尾部窗口：open+read 定位到 start，不把整个日志文件读进内存（面板 3~4s 轮询一次）。
    fh = openSync(file, 'r');
    const buf = Buffer.alloc(Math.min(maxBytes, size));
    const bytesRead = readSync(fh, buf, 0, buf.length, start);
    chunk = buf.subarray(0, bytesRead).toString('utf8');
  } catch {
    return [];
  } finally {
    if (fh !== undefined) {
      try {
        closeSync(fh);
      } catch {
        /* 句柄已失效就不管 */
      }
    }
  }
  const all = chunk.split('\n').filter(Boolean);
  return all.slice(-lines);
}

const docsCountCache = new Map<string, { count: number; at: number }>();
const DOCS_CACHE_TTL_MS = 15_000;

function invalidateDocsCache(home: string, id: string): void {
  docsCountCache.delete(`${home}::${id}`);
}

/** 角色工作区 = 该角色自己 memory 目录（config.paths.memory 固定后的值）。 */
export function roleWorkspace(home: string, id: string): string {
  const config = readRoleConfig(home, id);
  const configured = config?.paths?.memory;
  const root = rolePaths(home).roleDir(id);
  if (typeof configured === 'string' && configured.trim() && !configured.includes('..')) {
    return resolve(root, configured.trim());
  }
  return join(root, 'workspace');
}

function countDocs(home: string, id: string): number {
  const key = `${home}::${id}`;
  const cached = docsCountCache.get(key);
  if (cached && Date.now() - cached.at < DOCS_CACHE_TTL_MS) return cached.count;
  let count = 0;
  const walk = (dir: string, depth: number): void => {
    if (depth > DOC_MAX_DEPTH) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === '.git') continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs, depth + 1);
      else if (entry.isFile() && /\.(md|txt)$/i.test(entry.name)) {
        const rel = resolve(abs).slice(resolve(roleWorkspace(home, id)).length + 1);
        if (docPath(home, id, rel).ok) count += 1;
      }
    }
  };
  const workspace = roleWorkspace(home, id);
  if (ensureRealParents(workspace, join(workspace, 'CONSTITUTION.md')).ok) walk(workspace, 0);
  docsCountCache.set(key, { count, at: Date.now() });
  return count;
}

export function panelState(deps: PanelDeps): PanelState {
  const { home } = deps;
  const index = readIndex(home);
  const ids = new Set<string>(index?.roles.map((r) => r.id) ?? []);
  for (const id of roleDirsOnDisk(home)) ids.add(id);
  const roles: PanelRole[] = [...ids].map((id) => {
    const record = index?.roles.find((r) => r.id === id);
    const config = readRoleConfig(home, id);
    return {
      id,
      label: String(config?.displayName ?? record?.label ?? id),
      figure: record?.figures?.[0] ?? null,
      configFigure: figureOfConfig(config),
      createdAt: record?.createdAt ?? null,
      active: (index?.active ?? null) === id,
      docs: countDocs(home, id),
    };
  });
  roles.sort((a, b) => (a.active ? -1 : b.active ? 1 : a.id.localeCompare(b.id)));
  return {
    active: index?.active ?? null,
    originalRoleId: index?.originalRoleId ?? 'original',
    pointer: readPointer(home),
    roles,
    orphans: roleDirsOnDisk(home).filter((id) => !index?.roles.some((r) => r.id === id)),
    journal: readJournal(home),
    lamp: panelLamp(home),
    hasOriginal: ids.has(index?.originalRoleId ?? 'original'),
    logTail: readLogTail(home),
  };
}

// ───────────────────────────── 外观清单 ─────────────────────────────

export interface PanelFigure {
  id: string;
  /** 包 manifest 里的名字（读不到 manifest 就用 id）。 */
  name: string;
  source: 'builtin' | 'role' | 'shared';
}

/** 从内置桌宠包与各 figures 目录枚举可用外观（与桌宠装扮页同一发现规则：含 figure.json 的目录）。 */
export async function panelFigures(deps: PanelDeps): Promise<PanelFigure[]> {
  const out = new Map<string, PanelFigure>();
  const addPackDir = (dir: string, source: PanelFigure['source']): void => {
    if (!existsSync(join(dir, 'figure.json'))) return;
    const id = basename(dir);
    if (out.has(id)) return;
    let name = id;
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'figure.json'), 'utf8'));
      const names = manifest?.name ?? manifest?.names;
      name = (typeof names === 'string' && names) || (typeof names?.zh === 'string' && names.zh) || (typeof manifest?.id === 'string' ? manifest.id : id);
    } catch {
      /* 读不到 manifest 就用目录名 */
    }
    out.set(id, { id, name, source });
  };
  const addRoot = (dir: string, source: PanelFigure['source']): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) addPackDir(join(dir, entry.name), source);
    }
  };
  // 内置包（coo / whale）：桌宠扩展 web/ 下的单包目录。应用根从框架 paths.repoRoot() 推导
  // （宿主的 cortico/* 解析器只在真实 Core 里注册；模块夹具环境动态导入失败就跳过内置项）。
  try {
    const paths = (await import('cortico/paths.ts')) as { repoRoot(): string };
    const petWeb = join(resolve(paths.repoRoot(), '..', '..', 'node_modules', 'cortico-world-desktop-pet', 'web'));
    for (const name of ['coo', 'whale']) addPackDir(join(petWeb, name), 'builtin');
  } catch {
    /* 找不到内置包就算了：角色已绑定的外观与各 figures 目录仍然可见 */
  }
  // 各角色的私有 figures 与共享根。活动部署的 data figures 就是当前角色在装扮页看到的。
  for (const id of roleDirsOnDisk(deps.home)) {
    addRoot(join(roleEffectiveDataDir(deps.home, id), 'figures'), 'role');
  }
  addRoot(join(deps.home, 'figures'), 'shared');
  return [...out.values()];
}

// ───────────────────────────── 角色创建 ─────────────────────────────

// 角色 id 一律自动生成（role-N），不暴露自定义 id 输入，避免与磁盘目录名冲突。

function nextRoleId(home: string, taken: Set<string>): string {
  let n = 1;
  while (taken.has(`role-${n}`)) n += 1;
  return `role-${n}`;
}

/**
 * 创建一个全新角色：部署骨架（deployment.json + config.json + 空 memory/data），
 * 世界与 provider 配置沿用当前部署（provider 端点在 CORTICO_HOME/providers，天然共享），
 * 不带任何路径覆盖（pinRoleStorage 随后把它自己的 memory/data 写进自己的目录）。
 * 绝不复制源角色的工作区、Git 历史、会话或附件。
 */
export function createRole(deps: PanelDeps, input: { label: string; figure?: string | null; allowSteal?: boolean }): { ok: boolean; detail: string; id?: string; conflict?: 'figure-owned'; owner?: string | null } {
  const { home, botDir } = deps;
  if (pendingSwitch(home)) return { ok: false, detail: '切换尚未完成，请完成后再创建角色。' };
  const index = readIndex(home);
  if (!index) return { ok: false, detail: '角色注册表还没建立：先正常启动一次伴侣' };
  const label = String(input.label ?? '').trim();
  if (!label) return { ok: false, detail: '角色名字不能为空' };
  if (label.length > 40) return { ok: false, detail: '角色名字太长（≤40 字）' };
  const figure = typeof input.figure === 'string' && input.figure ? input.figure : null;
  // R3：初始外观与其他入口共用同一条唯一性规则——已被占用的外观先返回结构化冲突
  // （客户端确认后带 allowSteal 重试），而不是悄悄把别人的绑定摘掉。
  if (figure) {
    const owner = index.roles.find((r) => r.figures.includes(figure)) ?? null;
    if (owner && !input.allowSteal) {
      return {
        ok: false,
        conflict: 'figure-owned',
        owner: owner.id,
        detail: `外观 ${figure} 已绑定给 ${owner.id}。确认后新角色将改绑它并解除原绑定。`,
      };
    }
  }
  const taken = new Set<string>([...index.roles.map((r) => r.id), ...roleDirsOnDisk(home)]);
  const id = nextRoleId(home, taken);
  const dir = rolePaths(home).roleDir(id);
  try {
    mkdirSync(join(dir, 'workspace'), { recursive: true });
    mkdirSync(join(dir, 'data'), { recursive: true });
    // bot 包沿用当前部署的 deployment.json（同一代码包，多部署共用）。
    let botName = 'cormini';
    try {
      const deployment = JSON.parse(readFileSync(join(botDir, 'deployment.json'), 'utf8'));
      if (typeof deployment?.bot === 'string' && deployment.bot) botName = deployment.bot;
    } catch {
      /* 用默认 bot 名 */
    }
    writeFileSync(join(dir, 'deployment.json'), `${JSON.stringify({ bot: botName }, null, 2)}\n`, 'utf8');
    // 世界与 provider 配置沿用当前部署；paths 不带（pinRoleStorage 会写本角色自己的）。
    const activeConfig = readRoleConfig(home, index.active) ?? JSON.parse(readFileSync(join(botDir, 'config.json'), 'utf8'));
    const config = JSON.parse(JSON.stringify(activeConfig ?? {})) as Record<string, any>;
    delete config.paths;
    config.displayName = label;
    const worlds = (config.worlds ??= {});
    // 外部 DSH 会话不属于角色的本地 data；新角色不得继承源角色的连接。
    if (worlds.fatfish) worlds.fatfish.bridgeEnabled = false;
    const pet = (worlds['desktop-pet'] ??= {});
    pet.skin ??= {};
    if (figure) pet.skin.figure = figure;
    else delete pet.skin.figure;
    (worlds['character-profiles'] ??= {}).enabled = true;
    // 新角色不应该继承源角色当前生效的会话/状态游标：data 是空目录，天然干净。
    writeFileSync(join(dir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  } catch (error) {
    // 半成品骨架不是角色数据：回滚本次创建（目录是刚建的，删除只 touching 本次产物）。
    try {
      rmSync(rolePaths(home).roleDir(id), { recursive: true, force: true });
    } catch {
      /* 留档比误删好 */
    }
    return { ok: false, detail: `创建失败（已回滚，未影响现有角色）：${String(error)}` };
  }
  const pinned = pinRoleStorage(home, id);
  if (!pinned.ok) {
    try {
      rmSync(rolePaths(home).roleDir(id), { recursive: true, force: true });
    } catch {
      /* 同上 */
    }
    return { ok: false, detail: `角色存储固定失败（已回滚）：${pinned.detail ?? pinned.action}` };
  }
  const library = ensureRoleFigureLibrary(home, id, roleDataDir(home, id));
  if (['figure-migrate-failed', 'figure-link-failed', 'error'].includes(library.action)) {
    // Keep the unregistered directory for inspection; never register incomplete storage.
    return { ok: false, detail: `外观库准备失败，角色未登记；已保留目录 ${id}：${library.detail ?? library.action}` };
  }
  // 上方已确认唯一性冲突；新目录准备完成后才一次提交角色和绑定。
  try {
    // Prepare all new-role files before the one atomic registry commit. A failed
    // initial figure pin must never remove another role's existing binding.
    if (figure) {
      if (process.env.CORTICO_PROBE_FAIL_FIGUREPIN === '1') throw new Error('注入故障：角色外观写入失败');
      pinRoleFigure(home, id, figure);
    }
    index.roles.push({ id, label, figures: [], createdAt: new Date().toISOString() });
    if (figure) {
      index.roles = index.roles.map((r) => (r.id === id ? { ...r, figures: [figure] } : { ...r, figures: r.figures.filter((f) => f !== figure) }));
    }
    writeIndex(home, index);
  } catch (error) {
    // Registry writes are atomic. Preserve the prepared directory even if a
    // filesystem reports an uncertain commit result; no registered root is deleted.
    return { ok: false, detail: `创建提交失败，已保留目录 ${id} 供恢复：${String(error)}` };
  }
  return { ok: true, detail: `已创建角色 ${label}（${id}）；绑定外观后可在装扮页点击切换`, id };
}

// ───────────────────────────── 绑定 / 解绑 / 改名 ─────────────────────────────

function findRole(home: string, id: string): { index: NonNullable<ReturnType<typeof readIndex>>; recordId: string } | { error: string } {
  if (pendingSwitch(home)) return { error: '切换尚未完成，请完成后再更改角色或外观绑定。' };
  const index = readIndex(home);
  if (!index) return { error: '角色注册表还没建立：先正常启动一次伴侣' };
  if (!index.roles.some((r) => r.id === id)) return { error: `没有这个角色：${id}` };
  if (!existsSync(rolePaths(home).roleDir(id))) return { error: `角色目录不存在：${id}` };
  return { index, recordId: id };
}

export interface BindResult {
  ok: boolean;
  detail: string;
  /** 结构化冲突：figure-owned = 该外观已绑定给别的角色（确认后可 force 改绑）。 */
  conflict?: 'figure-owned';
  /** figure-owned 冲突时的当前所有者。 */
  owner?: string | null;
  /** 该外观正被当前活动角色穿着：绑定后点击装扮页的它不会触发切换，需要显式「绑定并切换」。 */
  wornByActive?: boolean;
  /** switchNow 时切换是否已排定。 */
  scheduled?: boolean;
}

export interface BindOptions {
  /** 外观已绑定给别的角色时，是否确认改绑（解除原绑定）。默认 false：返回结构化冲突。 */
  allowSteal?: boolean;
  /** 绑定后立即排定切换到该角色（R4：当前穿着外观被转绑后，装扮页点击同一 id 不会触发切换）。 */
  switchNow?: boolean;
}

/**
 * 外观绑定的**唯一**提交服务（R3）：面板绑定、创建角色初始外观、模型工具 figure 三个入口
 * 全部走这里，保证「一个 figure 最多归一个角色」与注册表/角色配置不出现半写状态。
 *
 * 事务顺序：先在内存里改注册表并原子写盘；写盘失败不碰任何角色配置；随后固定目标角色
 * config 的皮肤（失败则回滚注册表再报错），不返回虚假成功。
 */
export function bindFigureCore(
  home: string,
  id: string,
  figure: string,
  options: BindOptions = {},
  requestSwitch?: (roleId: string) => { scheduled: boolean; detail: string },
): BindResult {
  const found = findRole(home, id);
  if ('error' in found) return { ok: false, detail: found.error };
  const clean = String(figure ?? '').trim();
  if (!clean) return { ok: false, detail: '外观 id 不能为空' };
  const index = found.index;
  const owner = index.roles.find((r) => r.id !== id && r.figures.includes(clean)) ?? null;
  if (owner && !options.allowSteal) {
    return {
      ok: false,
      conflict: 'figure-owned',
      owner: owner.id,
      detail: `外观 ${clean} 已绑定给 ${owner.id}。确认改绑会解除原绑定；也可以先给 ${owner.id} 换一个外观。`,
    };
  }
  // R4：目标外观正被当前活动角色穿着（而它不是绑定目标）时，绑定后装扮页点击同一 id
  // 不会触发切换（watcher 只认 figure 变化）。这个状态只能靠显式「绑定并切换」收口。
  const activeId = index.active;
  let wornByActive = false;
  if (activeId && activeId !== id) {
    const activeConfig = readRoleConfig(home, activeId);
    wornByActive = figureOfConfig(activeConfig) === clean;
  }
  const previous = JSON.parse(JSON.stringify(index)) as typeof index;
  try {
    index.roles = index.roles.map((r) => (r.id === id ? { ...r, figures: [clean] } : { ...r, figures: r.figures.filter((f) => f !== clean) }));
    writeIndex(home, index);
    if (process.env.CORTICO_PROBE_FAIL_FIGUREPIN === '1') {
      throw new Error('注入故障：角色外观写入失败');
    }
    pinRoleFigure(home, id, clean);
  } catch (error) {
    // 回滚注册表，绝不留下「index 说绑了、config 没固定」的半写状态。
    let rolledBack = true;
    try {
      writeIndex(home, previous);
    } catch {
      rolledBack = false;
    }
    return { ok: false, detail: `绑定失败（${rolledBack ? '注册表已恢复' : '注册表恢复也失败，请检查磁盘权限后重试；未删除角色数据'}）：${String(error)}` };
  }
  let scheduled: boolean | undefined;
  let detail = `${id} 已绑定外观 ${clean}` + (owner ? `（已解除 ${owner.id} 的绑定）` : '') + '；在装扮页点击它即切换到该角色';
  if (options.switchNow && requestSwitch) {
    const switchResult = requestSwitch(id);
    scheduled = switchResult.scheduled;
    detail += switchResult.scheduled
      ? '；已排定切换，伴侣重启后生效'
      : `；切换未排定：${switchResult.detail}`;
  } else if (wornByActive) {
    detail += '。注意：该外观正被当前角色穿着，装扮页点击它不会触发切换，请用面板的「切换」或「绑定并切换」。';
  }
  return { ok: true, detail, wornByActive, ...(scheduled !== undefined ? { scheduled } : {}) };
}

/** 面板绑定入口（保持旧签名兼容；冲突策略见 bindFigureCore）。 */
export function bindFigure(deps: PanelDeps, id: string, figure: string, options: BindOptions = {}): BindResult {
  return bindFigureCore(deps.home, id, figure, options, (roleId) => deps.requestSwitch(roleId, null));
}

export function renameRole(deps: PanelDeps, id: string, label: string): { ok: boolean; detail: string } {
  const found = findRole(deps.home, id);
  if ('error' in found) return { ok: false, detail: found.error };
  const clean = String(label ?? '').trim();
  if (!clean) return { ok: false, detail: '角色名字不能为空' };
  if (clean.length > 40) return { ok: false, detail: '角色名字太长（≤40 字）' };
  const configFile = join(rolePaths(deps.home).roleDir(id), 'config.json');
  let previous: Record<string, any> | undefined;
  try {
    const config = JSON.parse(readFileSync(configFile, 'utf8'));
    previous = JSON.parse(JSON.stringify(config));
    config.displayName = clean;
    writeRoleConfig(deps.home, id, config);
    found.index.roles = found.index.roles.map((r) => (r.id === id ? { ...r, label: clean } : r));
    writeIndex(deps.home, found.index);
  } catch (error) {
    let note = '';
    if (previous) {
      try { writeRoleConfig(deps.home, id, previous); }
      catch (rollback) { note = `；配置恢复也失败：${String(rollback)}`; }
    }
    return { ok: false, detail: `改名失败：${String(error)}${note}` };
  }
  return { ok: true, detail: `已改名为 ${clean}` };
}

/** 解除绑定：只移除「点击外观切换」的映射；角色档案与它当前的外观都不动。 */
export function unbindFigure(deps: PanelDeps, id: string): { ok: boolean; detail: string } {
  const found = findRole(deps.home, id);
  if ('error' in found) return { ok: false, detail: found.error };
  const previous = found.index.roles.find((r) => r.id === id)?.figures?.[0] ?? null;
  found.index.roles = found.index.roles.map((r) => (r.id === id ? { ...r, figures: [] } : r));
  try { writeIndex(deps.home, found.index); }
  catch (error) { return { ok: false, detail: `解绑失败：${String(error)}` }; }
  return { ok: true, detail: previous ? `${id} 已解除外观 ${previous} 的绑定（档案与外观都保留）` : `${id} 本来就没有绑定的外观` };
}

// ───────────────────────────── 切换 / 恢复 ─────────────────────────────

export function switchToRole(deps: PanelDeps, id: string): { ok: boolean; detail: string } {
  const found = findRole(deps.home, id);
  if ('error' in found) return { ok: false, detail: found.error };
  if ((readIndex(deps.home)?.active ?? null) === id) return { ok: false, detail: `${id} 已经是当前角色` };
  const result = deps.requestSwitch(id, null);
  return { ok: result.scheduled, detail: result.detail };
}

export function restoreOriginal(deps: PanelDeps): { ok: boolean; detail: string } {
  const index = readIndex(deps.home);
  if (!index) return { ok: false, detail: '角色注册表还没建立' };
  const originalId = index.originalRoleId ?? 'original';
  if (!panelState(deps).hasOriginal) return { ok: false, detail: '原始角色的档案不存在' };
  if (index.active === originalId) return { ok: false, detail: '当前已经是原始角色' };
  const result = deps.requestSwitch(originalId, null);
  return { ok: result.scheduled, detail: result.detail };
}

// ───────────────────────────── 人设文档编辑 ─────────────────────────────

const DOC_EXT = new Set(['.md', '.txt']);

/**
 * 文档相对路径允许的最大子目录深度。docPath（读/写校验）与 listDocs/countDocs（枚举）
 * 必须共用同一条规则：枚举只到 3 层而读/写不限深，会出现「写得出、读得到、列表里永远没有」
 * 的黑洞文档。
 */
const DOC_MAX_DEPTH = 3;

/** 内容修订指纹：保存冲突检测用它对比「打开时」与「磁盘当前」的内容。 */
function contentRevision(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 32);
}

/** child 是否在 parent 内（大小写不敏感，Windows 友好；与 roles.ts 的 within 同规则）。 */
function withinDir(parent: string, child: string): boolean {
  const a = resolve(parent).toLowerCase().replace(/[\\/]+$/, '');
  const b = resolve(child).toLowerCase().replace(/[\\/]+$/, '');
  return b === a || b.startsWith(`${a}${sep}`);
}

/** Windows 保留设备名（不含扩展名部分）。 */
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * 文档相对路径的**共用**规范化（R6：列表/读取/保存必须同一条规则）。
 *
 * 旧实现只认单段文件名，listDocs 却会递归列出 `notes/trip.md` —— 列得出、读不了。
 * 现在支持合法子目录（含中文），同时拒绝：绝对路径（盘符 / 开头斜杠）、任何 `.`/`..`
 * 段（真正的上级穿越）、Windows 非法字符与保留设备名、超长路径。
 */
function docPath(home: string, id: string, name: string): { ok: true; file: string; rel: string; workspace: string } | { ok: false; detail: string } {
  const raw = String(name ?? '').trim();
  if (!raw) return { ok: false, detail: '文档名不能为空' };
  if (raw.length > 260) return { ok: false, detail: '文档路径太长（≤260 字符）' };
  if (/^[a-zA-Z]:/.test(raw) || raw.startsWith('/') || raw.startsWith('\\\\') || raw.startsWith('//')) {
    return { ok: false, detail: '文档路径必须是工作区内的相对路径，不接受绝对路径' };
  }
  const segs = raw.split(/[\\/]+/);
  for (const s of segs) {
    if (!s || s === '.' || s === '..') return { ok: false, detail: `文档路径不合法（不接受空段/./..）：${name}` };
    if (s.startsWith('.')) return { ok: false, detail: `文档路径不接受以点开头的隐藏段：${name}` };
    if (/[<>:"|?*\u0000-\u001f]/.test(s)) return { ok: false, detail: `文档路径含不合法字符：${name}` };
    if (/[. ]$/.test(s)) return { ok: false, detail: `路径段不能以点或空格结尾：${s}` };
    if (RESERVED_NAME.test(s.split('.')[0])) return { ok: false, detail: `文档路径使用了 Windows 保留设备名：${s}` };
  }
  if (segs.length - 1 > DOC_MAX_DEPTH) {
    return { ok: false, detail: `文档路径太深（最多 ${DOC_MAX_DEPTH} 层子目录）：${name}` };
  }
  const fileName = segs[segs.length - 1];
  if (!DOC_EXT.has(extname(fileName).toLowerCase())) {
    return { ok: false, detail: '只支持 .md / .txt 文档' };
  }
  const workspace = resolve(roleWorkspace(home, id));
  const file = resolve(workspace, ...segs);
  if (!withinDir(workspace, file)) {
    return { ok: false, detail: '文档路径越出了角色工作区' };
  }
  return { ok: true, file, rel: segs.join('/'), workspace };
}

/**
 * 确保目标父目录是**真实目录**且都在工作区内（R6 安全边界）：
 * 任何一级已存在的路径段如果是符号链接/联接就拒绝——既不能穿过它写出去，
 * 也不能沿它读取其他角色的内容。缺失的中间目录按真实目录创建。
 */
function ensureRealParents(workspace: string, file: string, create = false): { ok: true } | { ok: false; detail: string; missing?: boolean } {
  const rel = resolve(file).slice(resolve(workspace).length + 1);
  const segs = rel.split(/[\\/]+/).filter(Boolean);
  segs.pop(); // 最后一段是文件本身，由调用方单独检查
  let current = resolve(workspace);
  // Include the workspace itself: a replaced root junction must not redirect an editor into another role.
  for (const seg of ['', ...segs]) {
    if (seg) current = join(current, seg);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { ok: false, detail: `无法读取文档目录：${String(error)}` };
      if (!create) return { ok: false, missing: true, detail: '文档目录不存在' };
      try {
        mkdirSync(current, { recursive: true });
        continue;
      } catch (error) {
        return { ok: false, detail: `无法创建子目录：${String(error)}` };
      }
    }
    if (stat.isSymbolicLink()) return { ok: false, detail: `文档路径经过链接（拒绝读写）：${seg}` };
    if (!stat.isDirectory()) return { ok: false, detail: `路径段不是目录：${seg}` };
  }
  return { ok: true };
}

/** 已存在的目标本身必须是真实普通文件（拒绝链接与目录冒充）。 */
function checkExistingFile(file: string): { ok: true; content: string | null } | { ok: false; detail: string } {
  let stat;
  try {
    stat = lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, content: null };
    return { ok: false, detail: `无法检查文档：${String(error)}` };
  }
  if (stat.isSymbolicLink()) return { ok: false, detail: '目标是链接，拒绝读写' };
  if (!stat.isFile()) return { ok: false, detail: '目标不是普通文档文件' };
  try {
    return { ok: true, content: readFileSync(file, 'utf8') };
  } catch (error) {
    return { ok: false, detail: `读不到文档：${String(error)}` };
  }
}

export interface DocInfo {
  name: string;
  bytes: number;
  updatedAt: string;
}

export function listDocs(deps: PanelDeps, id: string): { ok: boolean; detail?: string; docs?: DocInfo[] } {
  if (!roleDirsOnDisk(deps.home).includes(id)) return { ok: false, detail: `角色目录不存在：${id}` };
  const docs: DocInfo[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > DOC_MAX_DEPTH) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || entry.name === '.git') continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs, depth + 1);
        continue;
      }
      if (!entry.isFile() || !DOC_EXT.has(extname(entry.name).toLowerCase())) continue;
      const rel = resolve(abs).slice(resolve(roleWorkspace(deps.home, id)).length + 1).replace(/\\/g, '/');
      if (!docPath(deps.home, id, rel).ok) continue;
      try {
        const stat = statSync(abs);
        docs.push({
          name: rel,
          bytes: stat.size,
          updatedAt: new Date(stat.mtimeMs).toISOString(),
        });
      } catch {
        /* 读不到的跳过 */
      }
    }
  };
  const workspace = roleWorkspace(deps.home, id);
  const rootCheck = ensureRealParents(workspace, join(workspace, 'CONSTITUTION.md'));
  if (!rootCheck.ok) return rootCheck.missing ? { ok: true, docs } : { ok: false, detail: rootCheck.detail };
  walk(workspace, 0);
  return { ok: true, docs };
}

export interface ReadDocResult {
  ok: boolean;
  detail?: string;
  content?: string;
  name?: string;
  /** 保存时的冲突检测凭据：磁盘内容的 sha256 指纹（R2）。 */
  revision?: string;
  bytes?: number;
  /** Only a verified absent path is safe to offer as a new document. */
  missing?: boolean;
}

export function readDoc(deps: PanelDeps, id: string, name: string): ReadDocResult {
  if (!roleDirsOnDisk(deps.home).includes(id)) return { ok: false, detail: `角色目录不存在：${id}` };
  const path = docPath(deps.home, id, name);
  if (!path.ok) return { ok: false, detail: path.detail };
  const parents = ensureRealParents(path.workspace, path.file);
  if (!parents.ok) return { ok: false, detail: parents.detail, ...(parents.missing ? { missing: true } : {}) };
  const existing = checkExistingFile(path.file);
  if (!existing.ok) return { ok: false, detail: existing.detail };
  const content = existing.content;
  if (content === null) return { ok: false, missing: true, detail: `文档不存在：${path.rel}` };
  return { ok: true, name: path.rel, content, revision: contentRevision(content), bytes: Buffer.byteLength(content, 'utf8') };
}

export interface WriteDocResult {
  ok: boolean;
  detail?: string;
  /** 冲突/缺失凭据时返回磁盘当前内容的指纹，客户端可据此决定重新载入。 */
  conflict?: boolean;
  currentRevision?: string;
  revision?: string;
  name?: string;
  /** R5：本次保存是否生成了 Git 版本；没有 Git 时为 false（如实降级，不虚称有版本）。 */
  committed?: boolean;
  /** 生成的 Git 提交号（committed 为 true 时）。 */
  commit?: string;
}

/**
 * 保存人设文档（R2 + R5 + R6）。
 *
 *  - 原子写：同目录临时文件 + rename，任何失败都不截断原文档；
 *  - 冲突门控：覆盖已存在内容必须带 `baseRevision`（readDoc 返回的指纹）；
 *    磁盘内容与打开时不一致 → 结构化冲突，磁盘上的新内容一个字节都不动；
 *    新建同名文件同样不能默认覆盖（没有 revision 就不让写已存在的文件）；
 *  - Git 版本：工作区有 .git 时保存即提交该文件（受控、带独立作者），成功返回提交号；
 *    没有 Git 或提交失败都如实说明，绝不虚称「已存为版本」。
 */
export function writeDoc(
  deps: PanelDeps,
  id: string,
  name: string,
  content: string,
  baseRevision?: string,
): WriteDocResult {
  if (!roleDirsOnDisk(deps.home).includes(id)) return { ok: false, detail: `角色目录不存在：${id}` };
  if (typeof content !== 'string') return { ok: false, detail: '文档内容必须是文本' };
  const path = docPath(deps.home, id, name);
  if (!path.ok) return { ok: false, detail: path.detail };
  // 链接边界：父目录链与目标本身都不允许穿过/冒充。
  const parents = ensureRealParents(path.workspace, path.file, !baseRevision);
  if (!parents.ok && parents.missing && baseRevision) return { ok: false, conflict: true, detail: '保存冲突：文档已被删除，请另存为新文件。' };
  if (!parents.ok) return { ok: false, detail: parents.detail };
  const existing = checkExistingFile(path.file);
  if (!existing.ok) return { ok: false, detail: existing.detail };
  if (existing.content === null && baseRevision) return { ok: false, conflict: true, detail: '保存冲突：文档已被删除，请另存为新文件。' };
  if (existing.content !== null) {
    const currentRevision = contentRevision(existing.content);
    // 没有 baseRevision 的覆盖写一律拒绝（旧客户端静默覆盖是丢失更新的成因）。
    if (!baseRevision) {
      return {
        ok: false,
        conflict: true,
        currentRevision,
        detail: `${path.rel} 已存在。为防止覆盖其他编辑器或模型的修改，请先读取（拿到 revision）再保存。`,
      };
    }
    if (baseRevision !== currentRevision) {
      return {
        ok: false,
        conflict: true,
        currentRevision,
        detail: `保存冲突：${path.rel} 在你读取之后被其他人/模型修改过。磁盘上的新内容已保留，你的草稿未写入；可重新载入后合并，或另存为副本。`,
      };
    }
  }
  // 原子写：先写同目录临时文件，成功后 rename 落位。
  const tmp = `${path.file}.tmp-${process.pid}-${Date.now()}`;
  try {
    if (process.env.CORTICO_PROBE_FAIL_DOC === 'write') {
      throw new Error('注入故障：文档写入失败');
    }
    writeFileSync(tmp, content, 'utf8');
    renameSync(tmp, path.file);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* 临时文件清理失败不影响错误上报 */
    }
    return { ok: false, detail: `保存失败（原文档未改动）：${String(error)}` };
  }
  invalidateDocsCache(deps.home, id);
  const revision = contentRevision(content);
  // R5：Git 版本提交（工作区有 .git 才做；单独提交这一个文件，不带工作区其他改动）。
  let committed = false;
  let commit: string | undefined;
  let gitNote = '';
  if (existsSync(join(path.workspace, '.git'))) {
    // git 跑在 Core 进程内、WebUI 请求路径上：必须带超时——慢仓库/index.lock 争用/挂起的
    // git 会同步阻塞事件循环，把整个伴侣拖死。GIT_OPTIONAL_LOCKS=0 顺带减少锁争用。
    const git = (...args: string[]) =>
      spawnSync('git', ['-C', path.workspace, '-c', 'user.name=character-profiles', '-c', 'user.email=character-profiles@extension.local', '-c', 'commit.gpgsign=false', ...args], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10_000,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      });
    const outOf = (r: ReturnType<typeof git>): string =>
      String(r.error ?? `${r.stderr ?? ''}${r.stdout ?? ''}`).trim();
    try {
      const added = git('add', '--', path.rel);
      if (added.status !== 0) {
        gitNote = `；Git 版本提交失败：${outOf(added) || 'git add 失败'}`;
      } else {
        const done = git('commit', '-m', `角色档案面板保存 ${path.rel}`, '--', path.rel);
        const out = `${done.stdout ?? ''}${done.stderr ?? ''}`;
        if (done.status !== 0 && !/nothing to commit/.test(out)) {
          gitNote = `；Git 版本提交失败：${outOf(done)}`;
        } else {
          const head = git('rev-parse', 'HEAD');
          if (head.status === 0 && /^[\da-f]{40}/.test((head.stdout ?? '').trim())) {
            committed = !/nothing to commit/.test(out);
            commit = (head.stdout ?? '').trim().slice(0, 40);
            gitNote = committed ? `；已存为版本 ${commit!.slice(0, 8)}` : '；内容与上个版本相同，未产生新版本';
          } else {
            gitNote = '；Git 版本提交失败：读不到提交号';
          }
        }
      }
    } catch (error) {
      gitNote = `；Git 版本提交失败：${String(error)}`;
    }
  } else {
    gitNote = '；工作区没有 Git，本次保存未生成版本';
  }
  return { ok: true, detail: `已保存 ${path.rel}${gitNote}`, revision, name: path.rel, committed, ...(commit ? { commit } : {}) };
}

// ───────────────────────────── 数据面分发 ─────────────────────────────

/** webUi().invoke 的实现：语义、参数校验、返回形状全在这里。 */
export async function panelInvoke(deps: PanelDeps, panel: string, method: string, args: unknown[]): Promise<unknown> {
  const arg = (i: number): Record<string, unknown> => (args[i] && typeof args[i] === 'object' ? args[i] as Record<string, unknown> : {});
  const str = (value: unknown): string => (typeof value === 'string' ? value : '');

  if (panel === PANEL_PROFILES) {
    // 外观存在性校验（R3）：三个入口共用。清单取不到（模块夹具环境）时跳过；
    // 清单非空时绑定不存在的 id 一律拒绝，防止手误把角色绑到空外观上。例外：该外观
    // 正被某个角色穿着或已绑定在注册表里——它显然在装扮页真实存在（枚举器覆盖不到
    // 的包，如其他扩展提供的形象），放行，否则「转绑当前穿着外观」会被卡死（R4）。
    const validateFigure = async (figure: string): Promise<string | null> => {
      if (!figure) return '外观 id 不能为空';
      const known = readIndex(deps.home)?.roles.some((r) => r.figures.includes(figure))
        || roleDirsOnDisk(deps.home).some((id) => figureOfConfig(readRoleConfig(deps.home, id)) === figure);
      if (known) return null;
      const available = await panelFigures(deps);
      if (available.length && !available.some((f) => f.id === figure)) {
        return `没有这个外观：${figure}；可用：${available.map((f) => f.id).join(', ')}`;
      }
      return null;
    };
    switch (method) {
      case 'state':
        return panelState(deps);
      case 'figures':
        return { figures: await panelFigures(deps) };
      case 'create': {
        const a = arg(0);
        const figure = str(a.figure);
        if (figure) {
          const invalid = await validateFigure(figure);
          if (invalid) return { ok: false, detail: invalid };
        }
        return createRole(deps, { label: str(a.label), figure: figure || null, allowSteal: a.allowSteal === true });
      }
      case 'rename': {
        const a = arg(0);
        return renameRole(deps, str(a.id), str(a.label));
      }
      case 'bindFigure': {
        const a = arg(0);
        const figure = str(a.figure).trim();
        const invalid = await validateFigure(figure);
        if (invalid) return { ok: false, detail: invalid };
        return bindFigure(deps, str(a.id), figure, { allowSteal: a.allowSteal === true, switchNow: a.switchNow === true });
      }
      case 'unbindFigure': {
        const a = arg(0);
        return unbindFigure(deps, str(a.id));
      }
      case 'switchTo': {
        const a = arg(0);
        return switchToRole(deps, str(a.id));
      }
      case 'restoreOriginal':
        return restoreOriginal(deps);
      case 'listDocs': {
        const a = arg(0);
        return listDocs(deps, str(a.id));
      }
      case 'readDoc': {
        const a = arg(0);
        return readDoc(deps, str(a.id), str(a.name));
      }
      case 'writeDoc': {
        const a = arg(0);
        // 非字符串内容原样传给 writeDoc 拒绝（它有自己的运行时校验）；
        // 旧写法在这里拼成 ''，配合有效的 baseRevision 会把文档清空写盘。
        return writeDoc(
          deps,
          str(a.id),
          str(a.name),
          a.content as string,
          typeof a.baseRevision === 'string' && a.baseRevision ? a.baseRevision : undefined,
        );
      }
      default:
        throw new Error(`未知方法：${method}`);
    }
  }

  if (panel === PANEL_SWITCH) {
    switch (method) {
      case 'state': {
        const home = deps.home;
        let intent: unknown = null;
        try {
          intent = JSON.parse(readFileSync(rolePaths(home).intentFile, 'utf8'));
        } catch {
          /* 没有 intent */
        }
        return { ...panelState(deps), intent, pending: pendingSwitch(home) };
      }
      case 'clearError': {
        // 只清「已经没有进行中事务」的陈旧错误标记；prepared/repointed 的 journal 不动，
        // 没有错误记录时也不伪造一次“清除成功”。
        const home = deps.home;
        const journal = readJournal(home);
        if (!journal) return { ok: false, detail: '没有切换日志' };
        if (pendingSwitch(home)) return { ok: false, detail: '切换事务还在进行中，不能清错误标记' };
        if (!journal.error && !journal.bootExit && !journal.bootFailures) {
          return { ok: false, detail: '当前没有错误记录可清除' };
        }
        writeJournal(home, { ...journal, error: undefined, bootExit: undefined, bootReady: undefined, bootFailures: undefined });
        return { ok: true, detail: '已清除错误记录' };
      }
      case 'restoreOriginal':
        return restoreOriginal(deps);
      default:
        throw new Error(`未知方法：${method}`);
    }
  }

  throw new Error(`未知面板：${panel}`);
}

// ───────────────────────────── 配置组 ─────────────────────────────

/** 世界配置组（0.2.9 ConfigGroup 契约；取代阶段 1 的旧式 configOptions 行）。 */
export function panelConfigGroups(): ConfigGroup[] {
  return [
    {
      id: 'character-profiles',
      owner: 'world:character-profiles',
      schema: {
        type: 'object',
        title: '角色档案',
        description: '启用后可在多个角色之间切换；切换会重启伴侣。',
        properties: {
          'worlds.character-profiles.enabled': {
            type: 'boolean',
            title: '启用角色档案',
            description: '开启后本扩展接管多角色部署根；关闭则完全不动数据。',
            'x-hot': false,
          },
          'worlds.character-profiles.dshAutoDiscover': {
            type: 'boolean',
            title: '自动连接本机 DSH',
            description: '本角色开启 DSH 桥接时，自动跟随本机 DSH 的地址变化；DSH 需要保持运行。',
            'x-hot': false,
          },
        },
      },
    },
  ];
}

/** 生成新角色时的默认名（面板展示用）。 */
export function suggestRoleLabel(home: string): string {
  const index = readIndex(home);
  const taken = new Set((index?.roles ?? []).map((r) => r.label));
  let n = 1;
  while (taken.has(`新角色 ${n}`)) n += 1;
  return `新角色 ${n}`;
}
