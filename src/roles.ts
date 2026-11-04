/**
 * 角色部署根（role deployment roots）——纯扩展、零数据复制、Windows 友好。
 *
 * 磁盘布局（`<CORTICO_HOME>` 由 Core 注入，见 core/boot.ts）：
 *
 *   <home>/
 *     companion            ← **目录联接（junction）**，指向 roles/<active>/companion
 *     roles/
 *       index.json         ← 注册表：active / roles[] / 每个角色绑定的 figure
 *       active             ← 指针文件（单行角色 id），切换的权威记录
 *       journal.json       ← 切换日志：prepared → repointed → applied / failed / blocked
 *       <roleId>/companion ← 角色的持久目录，数据永远原地不动
 *
 * 为什么是联接而不是复制：Windows 上对正在使用的部署根做 rename 会 EPERM/ENOTEMPTY，
 * 而「清空活动目录 + 复制目标」一旦中断就会丢数据（Codex review 复现：重放会覆盖
 * 唯一完整副本）。联接方案下切换只替换一个 reparse point，中断后按指针重放即可。
 *
 * 顺序约束：`companion.ts` 在 loadExtensions(528) 之前已解析 deploymentRoot，
 * 所以本扩展只能在 import 期影响「下一次」读取——这也是切换必须伴随一次受控重启的原因。
 */
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import type { Dirent } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

export const DEPLOYMENT_DIRNAME = 'companion';
export const ROLES_DIRNAME = 'roles';
export const ACTIVE_POINTER = 'active';
/** 首次登记的两阶段意图文件：rename 之后、联接/指针写完之前崩溃，下次启动据此补完。 */
export const REGISTER_INTENT = 'register.intent.json';
export const ROLE_MARKER = '.role-id';
export const RESTART_FLAG = '.restart-request';
/** figures 迁移提交的恢复标记（写在角色 data 根下）：`unlink 联接 → rename stage` 之间中断时据此续做。 */
export const FIGURES_MIGRATION_MARK = '.figures-migration.json';

export interface RoleRecord {
  /** 首次登记时被清理的继承绝对路径（memory/data）。 */
  pathsReset?: string[];
  id: string;
  label: string;
  /** 绑定到本角色的原生 Dress figure id。 */
  figures: string[];
  createdAt: string;
}

export interface RoleIndex {
  version: 1;
  active: string;
  /** 原始角色的身份不依赖目录名；旧注册表默认仍为 original。 */
  originalRoleId?: string;
  roles: RoleRecord[];
}

export type JournalStatus =
  | 'prepared'
  | 'repointed'
  | 'applied'
  | 'failed'
  | 'blocked'
  | 'blocked-disabled'
  | 'reverted';

export interface SwitchJournal {
  status: JournalStatus;
  from: string | null;
  to: string;
  at: string;
  pid?: number;
  error?: string;
  /** 触发切换的原生 figure（仅取证：皮肤归属以 index 绑定为准）。 */
  figure?: string | null;
  /**
   * 原生装扮事件发生**前**源角色正穿着的 figure（R1 修复：解绑角色恢复反弹）。
   * 原生持久化会把用户刚点的 figure 写进源角色 config——回放离开源角色时用它
   * 把源角色的外观还原到事件前的值，避免残留的目标 figure 在恢复源角色后被
   * 当成一次新的装扮请求再次排定切换。
   */
  sourceFigure?: string | null;
  /** Full pre-selection skin, including the source role's palette and outfit. */
  sourceSkin?: Record<string, unknown>;
  /** 重放时把崩溃残留的真实目录挪到哪里留档（绝不删除）。 */
  parked?: string;
  /** 上一次 boot 结束时进程自己记下的退出码（正常退出才有；被 SIGKILL 不会有）。 */
  bootExit?: { code: number | null; at: string; pid?: number; bootAt?: string; tag?: string };
  /**
   * 上一次 boot 的**真实 ready 凭据**：那次启动的进程自己在退出时写下，含它自己的
   * pid、它实际加载的 data 目录与它自己写出（worlds 里含本世界）的 run id。
   * 只有这份自证凭据能让恢复器在「轮询窗口错过」时提交，不能拿「某个更新一点的
   * run.json」冒名顶替（Codex：不可用来源不明的文件绕过提交门控）。
   */
  bootReady?: { at: string; bootAt: string; pid: number; dataDir: string; runId: string; runFile: string; tag?: string };
  /** 连续「目标启动失败」次数：达到上限就回源，不再无限重试同一个失败目标。 */
  bootFailures?: number;
}

/** 连续启动失败的容忍上限；第 MAX 次失败后的下一次启动直接回源。 */
const MAX_BOOT_FAILURES = 2;

export interface RolePaths {
  home: string;
  activeDir: string;
  rolesDir: string;
  indexFile: string;
  pointerFile: string;
  intentFile: string;
  journalFile: string;
  roleDir(id: string): string;
}

export function rolePaths(home: string): RolePaths {
  const rolesDir = join(home, ROLES_DIRNAME);
  return {
    home,
    activeDir: join(home, DEPLOYMENT_DIRNAME),
    rolesDir,
    indexFile: join(rolesDir, 'index.json'),
    pointerFile: join(rolesDir, ACTIVE_POINTER),
    intentFile: join(rolesDir, REGISTER_INTENT),
    journalFile: join(rolesDir, 'journal.json'),
    roleDir: (id: string) => join(rolesDir, id, DEPLOYMENT_DIRNAME),
  };
}

/** 解析活动联接后的真实角色目录；联接缺失/不可读时回退到给定路径。 */
export function physicalBotDir(botDir: string): string {
  try {
    return realpathSync.native(botDir);
  } catch {
    return botDir;
  }
}

/** botDir 是 `<home>/companion`，home 是它的父目录。 */
export function homeOf(botDir: string): string {
  return dirname(botDir);
}

// ───────────────────────────── 通用读写 ─────────────────────────────

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** 命中回执的行前缀（测试脚本按它读到「已到命中点、可以杀了」）。 */
export const PROBE_HIT_PREFIX = '@@PROBE-HIT';

/**
 * 写入点中断注入（仅测试用，不属于产品行为）：
 *  - `CORTICO_PROBE_CRASH=<point>`：在该点 SIGKILL 自己（进程自杀式硬杀）；
 *  - `CORTICO_PROBE_PAUSE=<point>`：在该点打印命中回执后原地挂住，由**外部持有者**
 *    （父进程）来杀。这样「中断」由测试脚本亲手执行，命中点仍然是被测代码里的真实位置，
 *    不必为了造现场去复制一遍登记流程。
 */
function crashPoint(point: string): void {
  if (process.env.CORTICO_PROBE_PAUSE === point) {
    // 命中回执必须**同步**写出去：下面会阻塞主线程，异步 stdout 可能来不及 flush。
    try {
      writeSync(1, `${PROBE_HIT_PREFIX} ${JSON.stringify({ point, pid: process.pid, at: new Date().toISOString() })}\n`);
    } catch {
      /* 回执失败也要挂住，父进程的超时逻辑会处理 */
    }
    // 真挂住：这里绝不能返回，否则命中点之后的写入会照旧执行，「中断」就是假的。
    // Atomics.wait 同步阻塞、不烧 CPU；父进程 SIGKILL 后本进程直接消失，不会走到下面一行。
    const hold = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(hold, 0, 0, 5 * 60 * 1000);
    throw new Error(`探针命中点 ${point} 等待外部杀进程超时（未被 SIGKILL）`);
  }
  if (process.env.CORTICO_PROBE_CRASH !== point) return;
  process.kill(process.pid, 'SIGKILL');
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameWithRetry(tmp, file);
}

/**
 * Windows 下 rename 落位可能撞上并发读者（确认轮询 200ms、WebUI 面板 3~4s 轮询、
 * 测试/恢复脚本都在读 journal/index）短暂持有的读句柄，瞬时 EPERM/EBUSY。
 * 这些写入点都在事务关键路径上：短退避重试（~200ms 内），重试耗尽才如实抛错，
 * 绝不把「没写进去」洗成成功（g1 实测抓到过一次瞬时 EPERM 把用户换装丢了）。
 */
function renameWithRetry(from: string, to: string, attempts = 8): void {
  let lastError: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') throw error;
      lastError = error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15 * (i + 1));
    }
  }
  throw lastError;
}

export function readIndex(home: string): RoleIndex | null {
  const index = readJson<RoleIndex>(rolePaths(home).indexFile);
  if (!index || typeof index.active !== 'string' || !Array.isArray(index.roles)) return null;
  return index;
}

export function writeIndex(home: string, index: RoleIndex): void {
  writeJson(rolePaths(home).indexFile, index);
}

export function newIndex(active: string, label: string, figures: string[] = []): RoleIndex {
  return {
    version: 1,
    active,
    originalRoleId: active,
    roles: [{ id: active, label, figures: [...figures], createdAt: new Date().toISOString() }],
  };
}

export function readJournal(home: string): SwitchJournal | null {
  return readJson<SwitchJournal>(rolePaths(home).journalFile);
}

export function writeJournal(home: string, journal: SwitchJournal): void {
  writeJson(rolePaths(home).journalFile, journal);
}

export function readPointer(home: string): string | null {
  try {
    return readFileSync(rolePaths(home).pointerFile, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

export function writePointer(home: string, id: string): void {
  const file = rolePaths(home).pointerFile;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, `${id}\n`, 'utf8');
  crashPoint('pointer-before-rename');
  renameWithRetry(`${file}.tmp`, file);
}

/** 活动部署根当前形态；联接则解析出真实路径。 */
export function activeTarget(home: string): { kind: 'link' | 'dir' | 'missing'; target: string | null } {
  const active = rolePaths(home).activeDir;
  try {
    const stat = lstatSync(active);
    if (stat.isSymbolicLink()) {
      return { kind: 'link', target: resolve(dirname(active), readlinkSync(active)) };
    }
    return { kind: 'dir', target: active };
  } catch {
    return { kind: 'missing', target: null };
  }
}

export function activeRoleId(home: string): string | null {
  const t = activeTarget(home);
  return t.target ? basename(dirname(t.target)) : null;
}

function samePath(a: string, b: string): boolean {
  const norm = (value: string) => resolve(value).replace(/[\\/]+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

function figureOfConfig(dir: string): string | null {
  const config = readJson<Record<string, any>>(join(dir, 'config.json'));
  const figure = config?.worlds?.['desktop-pet']?.skin?.figure;
  return typeof figure === 'string' && figure ? figure : null;
}

/**
 * 部署根**内容清单**：相对路径 → `file:<sha256>` / `link:<目标>`。
 *
 * 这是「某个副本到底有没有数据」的唯一判定依据（Codex：只读 config.json 就宣布完整是错的）。
 * 不跟随联接（联接按目标字符串记账，改指别处必然体现为不同摘要）；任何一项读不出来
 * 都返回 null —— 读不全就当「不可判定」，绝不当成完整。
 */
function dirManifest(dir: string): Map<string, string> | null {
  const out = new Map<string, string>();
  const walk = (current: string, rel: string): boolean => {
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = join(current, entry.name);
      const nextRel = rel ? `${rel}/${entry.name}` : entry.name;
      let stat;
      try {
        stat = lstatSync(abs);
      } catch {
        return false;
      }
      if (stat.isSymbolicLink()) {
        try {
          out.set(nextRel, `link:${readlinkSync(abs).replace(/\\/g, '/').toLowerCase()}`);
        } catch {
          return false;
        }
        continue;
      }
      if (stat.isDirectory()) {
        if (!walk(abs, nextRel)) return false;
        continue;
      }
      if (!stat.isFile()) continue;
      try {
        out.set(nextRel, `file:${createHash('sha256').update(readFileSync(abs)).digest('hex')}`);
      } catch {
        return false;
      }
    }
    return true;
  };
  return walk(resolve(dir), '') ? out : null;
}

/** 部署根清单：连 config.json 都读不出来就不算部署（返回 null）。 */
function deploymentManifest(dir: string): Map<string, string> | null {
  if (!existsSync(dir)) return null;
  const manifest = dirManifest(dir);
  if (!manifest) return null;
  if (readJson<Record<string, unknown>>(join(dir, 'config.json')) === null) return null;
  return manifest;
}

/** sup 是否**逐文件覆盖** sub（同名同内容）。用于判定哪一端是完整副本。 */
function manifestCovers(sup: Map<string, string>, sub: Map<string, string>): boolean {
  for (const [key, value] of sub) {
    if (sup.get(key) !== value) return false;
  }
  return true;
}

/**
 * 目标角色目录是否可用作切换目标。
 *
 * 旧实现只要求 config.json 可解析——一份「只有一个 config.json + 空 data/」的中断副本
 * 会被当成完整角色放行（Codex 复现）。现在要求部署清单里除 config.json 外至少还有一个
 * 真实文件；登记/恢复流程自己判定过「这一端覆盖了源端全部内容」时不走这个保守门槛。
 */
function targetLooksComplete(home: string, id: string): boolean {
  const dir = rolePaths(home).roleDir(id);
  const manifest = deploymentManifest(dir);
  if (!manifest) return false;
  return manifest.size >= 2;
}

// ─────────────────── 每角色真实存储 + shared figures + 旧重启标记 ───────────────────

/** 共享外观根（`<home>/figures`）：所有角色都能看见的公共包。 */
export const SHARED_FIGURES_DIRNAME = 'figures';

/** 某角色自己的真实 memory/data（绝对路径，不随活动联接改变）。 */
export function roleMemoryDir(home: string, id: string): string {
  return join(rolePaths(home).roleDir(id), 'memory');
}

export function roleDataDir(home: string, id: string): string {
  return join(rolePaths(home).roleDir(id), 'data');
}

/**
 * 某角色**按它自己的 config.json 解析**出来的 data 目录（`paths.data` 可指向 home 之外）。
 * 与原生 `deploy.ts` 的 abs() 语义一致：相对路径相对该角色部署根解析。
 * 切换证据必须锚定这个目录，而不是硬编码 `<role>/data`。
 */
export function roleEffectiveDataDir(home: string, id: string): string {
  const root = rolePaths(home).roleDir(id);
  let configured: unknown;
  try {
    configured = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'))?.paths?.data;
  } catch {
    configured = undefined;
  }
  if (typeof configured === 'string' && configured.trim()) {
    const value = configured.trim();
    return isAbsolute(value) ? resolve(value) : resolve(root, value);
  }
  return join(root, 'data');
}

/**
 * 某份部署**按它自己的 config.json 解析**出来的 data 目录（物理路径，`paths.data`
 * 可指向 home 之外）。instance.lock 与 runs/ 都落在这个目录里；硬编码
 * `<部署根>/data` 在自定义数据路径上根本找不到占用者，等于放过一次危险的并发写。
 */
export function deploymentDataDir(botDir: string): string {
  const root = physicalBotDir(botDir);
  let configured: unknown;
  try {
    configured = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'))?.paths?.data;
  } catch {
    configured = undefined;
  }
  if (typeof configured === 'string' && configured.trim()) {
    const value = configured.trim();
    return isAbsolute(value) ? resolve(value) : resolve(root, value);
  }
  return join(root, 'data');
}

/**
 * 把一个目录**改名留档**（绝不删除）：`roles/.<prefix>-<时间>[-n]`。
 * 失败返回 null —— 调用方必须据此放弃本次搬动，而不是改为删除。
 */
function parkAside(rolesDir: string, from: string, prefix: string): string | null {
  mkdirSync(rolesDir, { recursive: true });
  for (let n = 0; n < 1000; n += 1) {
    const to = join(rolesDir, `.${prefix}-${Date.now()}${n ? `-${n}` : ''}`);
    if (existsSync(to)) continue;
    try {
      renameSync(from, to);
      return to;
    } catch {
      return null;
    }
  }
  return null;
}

/** child 是否在 parent 内（大小写不敏感，Windows 友好）。 */
function within(parent: string, child: string): boolean {
  const a = resolve(parent).toLowerCase().replace(/[\\/]+$/, '');
  const b = resolve(child).toLowerCase().replace(/[\\/]+$/, '');
  return b === a || b.startsWith(`${a}${sep}`);
}

export interface StorageResult {
  ok: boolean;
  action: string;
  detail?: string;
  roleId?: string;
  memory?: string;
  data?: string;
  custom?: string[];
  /** pinRoleStorage 的判定轨迹（审计用：每个键的取值与克隆判定依据）。 */
  trace?: Array<Record<string, unknown>>;
  figures?: { action: string; detail?: string };
  markersRemoved?: string[];
  reverted?: { action: string; detail?: string };
}

function removeMarker(file: string): boolean {
  try {
    unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * 清理旧的 `.restart-request`：监督进程（app/core-host.cjs:148）在 Core 退出时读这个
 * 标记决定是否重启；它读完后不删，于是这个标记会在之后任何一次正常退出/停用再次触发
 * 重启。import 期（Core 已经被拉起、标记早就被读过）是安全边界，此时可以清。
 */
export function clearStaleRestartMarkers(home: string): string[] {
  const p = rolePaths(home);
  const removed: string[] = [];
  const candidates = [join(p.activeDir, 'data', RESTART_FLAG)];
  try {
    for (const entry of readdirSync(p.rolesDir, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        candidates.push(join(p.roleDir(entry.name), 'data', RESTART_FLAG));
      }
    }
  } catch {
    /* roles/ 还不存在 */
  }
  for (const file of candidates) {
    if (removeMarker(file)) removed.push(file);
  }
  return removed;
}

/**
 * 把该角色 config.paths.memory/data 固定成**该角色真实绝对路径**。
 *
 * 规则（Codex review：不能把既有自定义路径静默指空目录；新角色不得共享旧绝对指向）：
 *  - 已存在的相对/绝对目录 → 保留内容，解析为真实绝对路径，避免后台写入跟随活动联接；
 *  - 绝对路径且存在、且在本角色目录之外、且没有其他角色钉着同一位置 → 用户自定义：保留并记录；
 *  - 绝对路径指向其他角色的部署根、或与另一角色 config 钉着同值 → 克隆残留：改回本角色默认；
 *  - 绝对路径指向别处但目录不存在 → 不猜，按角色自有目录处理；
 *  - 写入失败（含注入故障）→ 返回 ok:false，调用方必须拒绝目标并回源，不能继续启动。
 */
export function pinRoleStorage(home: string, id: string, options: { authoritative?: boolean } = {}): {
  ok: boolean;
  action: string;
  detail?: string;
  memory?: string;
  data?: string;
  custom?: string[];
  trace?: Array<Record<string, unknown>>;
} {
  const p = rolePaths(home);
  const botDir = p.roleDir(id);
  const configFile = join(botDir, 'config.json');
  if (!existsSync(botDir)) return { ok: false, action: 'no-dir', detail: botDir };
  const config = readJson<Record<string, any>>(configFile);
  if (!config) return { ok: false, action: 'no-config', detail: `角色 ${id} 缺少可读 config：${configFile}` };
  const own: Record<'memory' | 'data', string> = {
    // 原生 Cormini 的缺省路径是 workspace。缺省 config 不能指向新空目录，
    // 否则已有的人设、PARTNER、交接笔记与 Git 历史会被静默遗忘。
    memory: join(botDir, 'workspace'),
    data: join(botDir, 'data'),
  };
  const custom: string[] = [];
  const trace: Array<Record<string, unknown>> = [];
  const physical = (file: string): string => {
    try { return realpathSync.native(file); } catch { return resolve(file); }
  };
  // 别的角色的部署根：从已有角色克隆出来的角色会把「原角色的绝对路径」带过来，
  // 那不是用户自定义，而是克隆残留，必须改回本角色默认，否则两个角色共用一份 storage。
  const otherRoots = (() => {
    try {
      return readdirSync(p.rolesDir)
        .filter((name) => name !== id && existsSync(join(p.rolesDir, name, DEPLOYMENT_DIRNAME)))
        .map((name) => physical(resolve(p.rolesDir, name, DEPLOYMENT_DIRNAME)));
    } catch {
      return [];
    }
  })();
  // 另一角色 config 里钉着的同值外部绝对路径同样是克隆残留（原角色自定义目录被整份
  // 复制给新角色）：必须改回本角色默认，否则新旧角色共享同一份 memory/data。
  const otherPins = (() => {
    const set = new Set<string>();
    for (const root of otherRoots) {
      const otherConfig = readJson<Record<string, any>>(join(root, 'config.json'));
      for (const key of ['memory', 'data'] as const) {
        const raw = otherConfig?.paths?.[key];
        if (typeof raw === 'string' && raw.trim()) set.add(physical(resolve(root, raw.trim())));
      }
    }
    return set;
  })();
  const rootEntries = (() => {
    try {
      return readdirSync(p.rolesDir);
    } catch (error) {
      return [`ERR:${String(error)}`];
    }
  })();
  trace.push({ __roots: p.rolesDir, entries: rootEntries, otherRoots });
  const decide = (key: 'memory' | 'data'): string => {
    const raw = config?.paths?.[key];
    if (typeof raw !== 'string' || !raw.trim()) return own[key];
    const value = raw.trim();
    const absolute = physical(resolve(botDir, value));
    const pinnedElsewhere = [...otherPins].some((pin) => samePath(pin, absolute));
    // 活动角色是外部自定义路径的权威（用户的真实配置）；其余角色出现同值路径 =
    // 克隆残留。顺序敏感：必须先钉活动角色、再钉其余，否则归属会翻转（见 R1）。
    const cloned =
      otherRoots.some((root) => within(root, absolute)) ||
      (!options.authoritative && pinnedElsewhere);
    trace.push({ key, raw: value, absolute, cloned, authoritative: Boolean(options.authoritative), otherRoots, pinnedElsewhere });
    if (cloned) return own[key];
    // 保留原目录的内容，但禁止把相对路径交给宿主：宿主以可换向的 companion 为基准。
    if (within(physical(botDir), absolute)) return existsSync(absolute) ? absolute : own[key];
    // 目录不存在的外部路径 → 不猜（可能是迁移残留），按角色自有目录处理。
    if (!existsSync(absolute)) return own[key];
    // 存在的外部绝对路径且未被其他角色钉着：用户自定义，保留并记录。
    custom.push(key);
    return absolute;
  };
  const memory = decide('memory');
  const data = decide('data');
  try {
    mkdirSync(memory, { recursive: true });
    mkdirSync(data, { recursive: true });
    if (process.env.CORTICO_PROBE_FAIL_PIN === 'config-write') {
      throw new Error('注入故障：角色路径写入失败');
    }
    const next = { ...config, paths: { ...(config.paths ?? {}), memory, data } };
    if (config.paths?.memory !== memory || config.paths?.data !== data) {
      writeJson(configFile, next);
    }
  } catch (error) {
    return { ok: false, action: 'write-failed', detail: String(error), memory, data, custom };
  }
  return {
    ok: true,
    action: custom.length ? 'pinned-custom' : 'pinned',
    memory,
    data,
    custom,
    trace,
  };
}

/**
 * figures 无损共享（Codex review：EEXIST、私有包不能丢、共享包必须仍可见）：
 *  - 角色还没有 figures → 建联接指向 `<home>/figures`；
 *  - 已有空真实目录 → 换成联接（空目录无数据，安全）；
 *  - 已有非空真实目录（私有包）→ **保留**，不 merge、不删；共享包通过
 *    `COOPANION_PACK_ROOTS=<home>/figures` 这个发现根仍然可见（见 index.ts）；
 *  - 已是联接但指错 → 重指。
 */
export interface FigureLibraryResult {
  action: string;
  shared: string[];
  private: string[];
  migrated?: string[];
  conflicts?: Array<{ id: string; kept: 'role' }>;
  legacyTarget?: string | null;
  detail?: string;
}

/**
 * 一个包目录的**有效内容摘要**；读不到返回 null。
 *
 * 只比 figure.json 是错的（Codex 复现：同 manifest、不同 figure.js/图片的两个包被判为
 * 同一个，迁移时跳过复制，原角色实际外观被共享包替换）。这里递归遍历包内全部普通文件，
 * 按「相对路径 + 文件 sha256」排序聚合后再 sha256；不跟随联接/符号链接，也不含 mtime。
 */
function packContentDigest(dir: string): string | null {
  if (!existsSync(join(dir, 'figure.json'))) return null;
  const parts: string[] = [];
  const walk = (current: string, rel: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      parts.push(`${rel || '.'}\0unreadable-dir`);
      return;
    }
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = join(current, entry.name);
      const nextRel = rel ? `${rel}/${entry.name}` : entry.name;
      let stat;
      try {
        stat = lstatSync(abs);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) {
        parts.push(`${nextRel}\0symlink`);
        continue;
      }
      if (stat.isDirectory()) {
        walk(abs, nextRel);
        continue;
      }
      if (!stat.isFile()) continue;
      try {
        const body = readFileSync(abs);
        parts.push(`${nextRel}\0${createHash('sha256').update(body).digest('hex')}`);
      } catch {
        parts.push(`${nextRel}\0unreadable-file`);
      }
    }
  };
  try {
    walk(resolve(dir), '');
  } catch {
    return null;
  }
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

/** 目标目录里的包 id（含 figure.json 的子目录）。 */
function packIdsOf(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, 'figure.json')))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * 把共享根里尚未出现在角色 figures 的包**复制**进角色目录（角色私有包优先，不覆盖）。
 *
 * 为什么不用联接：宿主 pack 扫描按目录项类型过滤，Windows junction 会被当成符号链接跳过，
 * 链接进去的共享包对 /api/figures 不可见（真实 Core 实测：packs 只有内置包）。复制的是
 * 共享/公开包，不是源角色的私密数据，因此不违反「不复制角色私密数据」。
 */
function copySharedPacks(shared: string, figures: string): { linked: string[]; failed?: string } {
  const linked: string[] = [];
  let entries: Array<{ name: string; isDirectory(): boolean; isSymbolicLink(): boolean }> = [];
  try {
    entries = readdirSync(shared, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const dest = join(figures, entry.name);
    if (existsSync(dest)) continue;
    try {
      cpSync(join(shared, entry.name), dest, { recursive: true });
      linked.push(entry.name);
    } catch (error) {
      return { linked, failed: `${entry.name}: ${String(error)}` };
    }
  }
  return { linked };
}

interface FiguresMigrationMark {
  state: 'prepared';
  at: string;
  legacyTarget: string;
  stage: string;
  packs: string[];
  staged: string[];
}

function figuresMigrationMarkPath(root: string): string {
  return join(root, FIGURES_MIGRATION_MARK);
}

function readFiguresMigrationMark(root: string): FiguresMigrationMark | null {
  try {
    const raw = JSON.parse(readFileSync(figuresMigrationMarkPath(root), 'utf8')) as FiguresMigrationMark;
    if (!raw || raw.state !== 'prepared') return null;
    if (typeof raw.legacyTarget !== 'string' || typeof raw.stage !== 'string') return null;
    return raw;
  } catch {
    return null;
  }
}

function clearFiguresMigrationMark(root: string): void {
  try {
    rmSync(figuresMigrationMarkPath(root), { force: true });
  } catch {
    /* 标记删不掉不影响正确性：下次读到「已提交」会再清一次 */
  }
}

/** `{ exists, isLink }`；不跟随联接。 */
function figuresState(figures: string): { exists: boolean; isLink: boolean } {
  try {
    return { exists: true, isLink: lstatSync(figures).isSymbolicLink() };
  } catch {
    return { exists: false, isLink: false };
  }
}

/**
 * 迁移提交中断后的续做（Codex 审查：`unlinkSync(figures)` 与 `renameSync(stage, figures)`
 * 之间存在 figures 完全不存在的窗口，硬中断后旧实现直接删 stage，原角色外观永久丢失）。
 *
 * 续做只有三种确定性结局，都保证「原角色外观仍然可见」：
 *  - figures 已是真实目录 → 提交其实成功了，清标记；
 *  - stage 还在而 figures 缺 → 直接 rename 落位（完成提交）；rename 仍失败则恢复联接；
 *  - stage 与 figures 都没了 → 恢复指向旧目标的联接，退回正常迁移流程。
 */
function resumeFiguresMigration(
  figures: string,
  root: string,
): { resumed: boolean; action?: string; detail?: string; legacyTarget?: string | null } {
  const mark = readFiguresMigrationMark(root);
  if (!mark) return { resumed: false };
  const legacyTarget = mark.legacyTarget;
  const stageExists = existsSync(mark.stage);
  const state = figuresState(figures);
  if (state.exists && !state.isLink) {
    clearFiguresMigrationMark(root);
    return { resumed: true, action: 'migration-resumed', detail: '提交已完成（figures 已是真实目录），清理标记', legacyTarget };
  }
  if (stageExists && !state.exists) {
    try {
      renameSync(mark.stage, figures);
      clearFiguresMigrationMark(root);
      return { resumed: true, action: 'migration-resumed', detail: '中断在 unlink 与 rename 之间：stage 已落位', legacyTarget };
    } catch (error) {
      try {
        symlinkSync(legacyTarget, figures, 'junction');
      } catch {
        /* 连联接都恢复不了：如实报失败，绝不假装成功 */
      }
      return { resumed: true, action: 'figure-migrate-failed', detail: `续提交失败：${String(error)}`, legacyTarget };
    }
  }
  if (!stageExists && !state.exists) {
    try {
      symlinkSync(legacyTarget, figures, 'junction');
    } catch {
      /* 同上 */
    }
    clearFiguresMigrationMark(root);
    return { resumed: true, action: 'migration-restored', detail: 'stage 丢失，已恢复指向旧目标的联接', legacyTarget };
  }
  // 联接仍在（提交尚未开始或已回滚）：清标记，重新走一次完整迁移。
  clearFiguresMigrationMark(root);
  return { resumed: true, action: 'migration-restarted', detail: '联接仍在，重跑迁移', legacyTarget };
}


/**
 * figures 无损共享与迁移（Codex 审查 2026-10-25：旧整目录联接目标包可见性回归）。
 *
 *  - 角色还没有 figures → 建真实目录 + 共享包联接；
 *  - 普通真实目录 → 不递归删除，只补共享包联接，角色私有包优先；
 *  - 联接且指向 canonical 共享根 → 换成真实目录后补联接（包都在共享根，无丢失）；
 *  - 联接但指向旧的 legacy 目录 → 拆联接前先读旧目标与包入口：
 *      · 共享根没有该 id → 先复制到共享根临时目录、再改名落位（原子化，失败可重试）；
 *      · 共享根已有同 id 但内容不同 → 不覆盖共享包，把旧包复制进角色自己的
 *        figures 目录，保留该角色的有效选择，并记录冲突；
 *      · 整包迁移成功后才 unlink 联接本身，再改名成真实目录；中途失败只清临时目录，
 *        联接与旧目标原样保留，下次启动可重试；
 *      · 全程绝不沿联接删除旧目标。
 */
export function ensureRoleFigureLibrary(home: string, id: string, dataRoot: string): FigureLibraryResult {
  const shared = join(home, SHARED_FIGURES_DIRNAME);
  const figures = join(dataRoot, 'figures');
  const root = resolve(dataRoot);
  const stage = join(root, `.figures-next-${Date.now()}`);
  let stageCreated = false;
  try {
    mkdirSync(shared, { recursive: true });
    // 上次提交（unlink 联接 → rename stage）中断过就先续做，再判断当前状态。
    const resumed = resumeFiguresMigration(figures, root);
    if (resumed.resumed && resumed.action === 'figure-migrate-failed') {
      return {
        action: 'figure-migrate-failed',
        shared: [],
        private: figuresState(figures).exists ? packsIn(figures) : [],
        detail: resumed.detail ?? '续做 figures 迁移失败',
        legacyTarget: resumed.legacyTarget ?? null,
      };
    }

    let legacyTarget: string | null = null;
    let isLink = false;
    try {
      isLink = lstatSync(figures).isSymbolicLink();
    } catch {
      isLink = false;
    }

    if (isLink) {
      try {
        legacyTarget = realpathSync(figures);
      } catch {
        legacyTarget = null;
      }
      const canonical = (() => {
        try {
          return realpathSync(shared);
        } catch {
          return resolve(shared);
        }
      })();
      const fromLegacy = legacyTarget && resolve(legacyTarget) !== resolve(canonical);
      if (!fromLegacy) {
        // 指向标准共享根：包都在共享根，拆联接不会丢包。
        unlinkSync(figures);
      } else {
        const legacyPacks = packIdsOf(resolve(legacyTarget!));
        mkdirSync(stage);
        stageCreated = true;
        const migrated: string[] = [];
        const conflicts: Array<{ id: string; kept: 'role' }> = [];
        for (const packId of legacyPacks) {
          const source = join(resolve(legacyTarget!), packId);
          const sharedDest = join(shared, packId);
          if (existsSync(sharedDest)) {
            // 只有「整包有效内容」真的一样才跳过；摘要取不到按不同处理（宁可多留一份，
            // 也不让原角色的外观被共享包悄悄替换）。
            const sharedDigest = packContentDigest(sharedDest);
            const sourceDigest = packContentDigest(source);
            if (sharedDigest && sourceDigest && sharedDigest === sourceDigest) continue;
            // 同 ID 不同内容：共享包不覆盖，旧包进角色自己的目录，保证原角色选择仍有效。
            cpSync(source, join(stage, packId), { recursive: true });
            conflicts.push({ id: packId, kept: 'role' });
            continue;
          }
          const temp = join(shared, `.migrate-${packId}-${Date.now()}`);
          try {
            if (process.env.CORTICO_PROBE_FAIL_FIGURE === 'copy') {
              throw new Error('注入故障：figures 迁移写失败');
            }
            cpSync(source, temp, { recursive: true });
            renameSync(temp, sharedDest);
            migrated.push(packId);
          } catch (error) {
            rmSync(temp, { recursive: true, force: true });
            rmSync(stage, { recursive: true, force: true });
            stageCreated = false;
            return {
              action: 'figure-migrate-failed',
              shared: [],
              private: [],
              detail: `迁移 ${packId} 失败：${String(error)}`,
              legacyTarget,
            };
          }
        }
        // 迁移与角色私有副本都写好之后，才拆联接本身（只删链接，不动旧目标）。
        // 先落恢复标记（要落位的 stage、旧目标、包清单），再 unlink → rename：
        // 这中间硬中断时 figures 完全不存在，下次启动按标记把 stage 落位或恢复联接，
        // 原角色外观不会永久丢失。
        try {
          writeFileSync(
            figuresMigrationMarkPath(root),
            `${JSON.stringify(
              {
                state: 'prepared',
                at: new Date().toISOString(),
                legacyTarget: resolve(legacyTarget!),
                stage,
                packs: legacyPacks,
                staged: packIdsOf(stage),
              },
              null,
              2,
            )}\n`,
            'utf8',
          );
          unlinkSync(figures);
          if (process.env.CORTICO_PROBE_FAIL_FIGURE === 'commit') {
            throw new Error('注入故障：unlink 之后、rename 之前中断');
          }
          renameSync(stage, figures);
          stageCreated = false;
          clearFiguresMigrationMark(root);
        } catch (error) {
          // 回到「联接指向旧目标」这个已知良好状态；stage 是本次新建目录，可以删。
          if (!figuresState(figures).exists) {
            try {
              symlinkSync(resolve(legacyTarget!), figures, 'junction');
            } catch {
              /* 恢复不了就如实报失败，绝不假装成功 */
            }
          }
          rmSync(stage, { recursive: true, force: true });
          stageCreated = false;
          clearFiguresMigrationMark(root);
          return {
            action: 'figure-migrate-failed',
            shared: migrated,
            private: figuresState(figures).exists ? packsIn(figures) : [],
            detail: `替换联接失败：${String(error)}`,
            legacyTarget,
          };
        }
        const linked = copySharedPacks(shared, figures);
        if (linked.failed) {
          return {
            action: 'figure-link-failed',
            shared: linked.linked,
            private: packsIn(figures),
            detail: linked.failed,
            migrated,
            conflicts,
            legacyTarget,
          };
        }
        return { action: 'migrated-legacy', shared: linked.linked, private: packsIn(figures), migrated, conflicts, legacyTarget };
      }
    }

    mkdirSync(figures, { recursive: true });
    if (lstatSync(figures).isSymbolicLink()) {
      return { action: 'figure-migrate-failed', shared: [], private: [], detail: 'figures 迁移失败：仍是联接', legacyTarget };
    }
    const linked = copySharedPacks(shared, figures);
    if (linked.failed) {
      return { action: 'figure-link-failed', shared: linked.linked, private: packsIn(figures), detail: linked.failed, legacyTarget };
    }
    return { action: linked.linked.length ? 'linked-shared' : 'kept', shared: linked.linked, private: packsIn(figures), legacyTarget };
  } catch (error) {
    if (stageCreated) rmSync(stage, { recursive: true, force: true });
    return { action: 'error', shared: [], private: [], detail: String(error), legacyTarget: null };
  }
}

/** 角色 figures 目录里的包 id（真实目录）。 */
function packsIn(figures: string): string[] {
  return packIdsOf(figures);
}

/**
 * import 期总入口：清旧重启标记 → 固定当前角色真实路径 → 处理 figures。
 *
 * 路径固定失败时：有未完成事务就回源（reverted 并记录原因），没有就只报错，
 * 绝不把失败洗成成功继续启动。
 */
export function prepareDeploymentStorage(
  home: string,
  options: { enabled?: boolean } = {},
): StorageResult {
  // 第一道闸（在任何写之前）：活动根还有活的占用者时，清重启标记 / 写 config.paths /
  // 建 figures 目录这些写操作都会落到正在运行的实例正在读的配置上。旧实现先清标记、
  // 再钉路径，被 `locked` 拦下的那次启动照样改写了磁盘（Codex 复现）。
  const guard = lockOwnerAlive(rolePaths(home).activeDir);
  if (guard.alive) {
    return { ok: false, action: 'skipped-locked', detail: guard.detail ?? '活动部署根被占用' };
  }
  const journal = readJournal(home);
  const pending = journal && (journal.status === 'prepared' || journal.status === 'repointed');
  const roleId = pending ? journal!.to : activeRoleId(home);
  const markersRemoved = clearStaleRestartMarkers(home);
  if (!roleId) {
    return { ok: false, action: 'no-role', detail: '没有活动角色可固定路径', markersRemoved };
  }
  // 每个角色都要有自己的绝对 memory/data（不只是当前角色）；否则克隆来的绝对路径会让
  // 多个角色共用同一份存储，切换后表现为「旧数据没了」或「串到新角色」。
  const allIds = [...new Set([roleId, ...roleDirsOnDisk(home)])].filter((id) =>
    existsSync(rolePaths(home).roleDir(id)),
  );
  const pins = new Map<string, ReturnType<typeof pinRoleStorage>>();
  // 先钉活动角色（外部自定义路径的权威来源），再钉其余角色（同值路径按克隆残留重置）。
  pins.set(roleId, pinRoleStorage(home, roleId, { authoritative: true }));
  for (const id of allIds) {
    if (id === roleId || pins.has(id)) continue;
    pins.set(id, pinRoleStorage(home, id));
  }
  const pin = pins.get(roleId)!;
  const figures = ensureRoleFigureLibrary(home, roleId, pin.data ?? roleDataDir(home, roleId));
  // figures 迁移/补链失败同样不能带着半成品继续启动或提交：与路径固定失败同一处置
  // （有事务就回源）。旧实现只认 figure-migrate-failed，figure-link-failed 与 error
  // 会被当成成功继续，切换带着缺包的 figures 落位。
  const figureFailed =
    figures.action === 'figure-migrate-failed' || figures.action === 'figure-link-failed' || figures.action === 'error';
  for (const id of allIds) {
    if (id === roleId) continue;
    const other = pins.get(id)!;
    ensureRoleFigureLibrary(home, id, other.data ?? roleDataDir(home, id));
  }
  if (!pin.ok || figureFailed) {
    const detail = !pin.ok ? `${pin.action}: ${pin.detail ?? ''}` : `外观库准备失败（${figures.action}）：${figures.detail ?? ''}`;
    if (pending) {
      const reverted = revertSwitchToSource(home, journal!, detail);
      return {
        ok: false,
        action: 'storage-rejected',
        detail,
        roleId,
        figures,
        markersRemoved,
        reverted,
      };
    }
    // 非 pending 但活动联接已指向失败目标（离线切换后首次启动）：回源，别带着坏路径启动。
    if (journal && journal.from !== journal.to && activeRoleId(home) === journal.to) {
      const reverted = revertSwitchToSource(home, journal, detail);
      return {
        ok: false,
        action: 'storage-reverted-source',
        detail,
        roleId,
        figures,
        markersRemoved,
        reverted,
      };
    }
    return {
      ok: false,
      action: 'storage-rejected',
      detail: `${pin.action}: ${pin.detail ?? ''}`,
      roleId,
      figures,
      markersRemoved,
    };
  }
  return {
    ok: true,
    action: pin.action,
    roleId,
    memory: pin.memory,
    data: pin.data,
    custom: pin.custom,
    trace: pin.trace,
    figures,
    markersRemoved,
  };
}

// ───────────────────────────── 联接 ─────────────────────────────

/** 把 `<home>/companion` 指向 `<home>/roles/<id>/companion`（删旧联接再建新联接）。 */
function linkTo(home: string, id: string): void {
  const p = rolePaths(home);
  const target = p.roleDir(id);
  if (!existsSync(target)) throw new Error(`角色 ${id} 没有部署目录：${target}`);
  mkdirSync(p.rolesDir, { recursive: true });
  try {
    unlinkSync(p.activeDir);
  } catch {
    /* 不存在 */
  }
  crashPoint('link-after-unlink');
  if (existsSync(p.activeDir)) throw new Error(`活动部署根不是联接，拒绝覆盖：${p.activeDir}`);
  if (process.env.CORTICO_PROBE_FAIL_LINK === '1') throw new Error('注入故障：建立联接失败');
  symlinkSync(target, p.activeDir, 'junction');
}

/** 给角色副本钉上它自己的 figure（不改其它字段）。 */
export function writeRoleConfig(home: string, id: string, config: Record<string, unknown>): void {
  writeJson(join(rolePaths(home).roleDir(id), 'config.json'), config);
}

export function pinRoleFigure(home: string, id: string, figure: string | null): void {
  if (!figure) return;
  const file = join(rolePaths(home).roleDir(id), 'config.json');
  const config = readJson<Record<string, any>>(file);
  if (!config) throw new Error(`角色 ${id} 的配置无法读取，未改变外观`);
  const worlds = (config.worlds ??= {});
  const pet = (worlds['desktop-pet'] ??= {});
  const skin = (pet.skin ??= {});
  skin.figure = figure;
  writeJson(file, config);
}

function restoreRoleSkin(home: string, id: string, skin: Record<string, unknown>): void {
  const file = join(rolePaths(home).roleDir(id), 'config.json');
  const config = readJson<Record<string, any>>(file);
  if (!config) throw new Error(`角色 ${id} 的配置无法读取，未恢复外观`);
  ((config.worlds ??= {})['desktop-pet'] ??= {}).skin = skin;
  writeJson(file, config);
}

function boundFigure(home: string, id: string): string | null {
  return readIndex(home)?.roles.find((r) => r.id === id)?.figures?.[0] ?? null;
}

/**
 * 首次启用：把 seed() 刚建好的真实目录搬成 `roles/<id>/companion`，再改成联接。
 *
 * 只搬一次。rename 失败时退化为「复制 → 校验 → 删源」，校验不过就保留原目录、
 * 不登记——宁可不启用，也不制造半残副本。
 */
export function registerDeployment(home: string): RoleIndex | null {
  const p = rolePaths(home);
  // 首次登记同样要先确认没有活的 Core 占着活动根，否则会把正在用的目录 rename 走。
  if (lockOwnerAlive(p.activeDir).alive) return null;
  if (readIndex(home)) return null;
  const state = activeTarget(home);
  if (state.kind === 'missing') return null;
  const figure = state.kind === 'dir' ? figureOfConfig(p.activeDir) : null;
  if (state.kind === 'link') {
    // 已有联接却没有注册表：按联接目标反推角色 id。
    const target = state.target ?? '';
    const id = target.split(/[\\/]/).slice(-2)[0] || 'original';
    const created = newIndex(id, id === 'original' ? '原始角色' : id, figure ? [figure] : []);
    writePointer(home, id);
    writeIndex(home, created);
    return created;
  }
  const id = 'original';
  const dest = p.roleDir(id);
  mkdirSync(dirname(dest), { recursive: true });
  // 意图文件只当「这次登记走到哪一步」的留档，**不再当判定依据**：中断恢复一律比较
  // 两端的真实内容清单（见 recoverRegistration），任何 stage 都不会导致删数据。
  writeJson(p.intentFile, { id, at: new Date().toISOString(), stage: 'moving', plan: 'rename' });
  // 目标位置如果已经有内容，绝不删除：那可能是上一次崩溃留下的唯一一份数据。
  // 挪到 .orphan-<时间> 留档后继续（人可查），而不是 rm。
  let moved = false;
  try {
    if (existsSync(dest) && readdirSync(dest).length > 0) {
      if (!parkAside(p.rolesDir, dest, 'orphan')) throw new Error(`roles/${id} 已有内容且无法留档：${dest}`);
    }
    renameSync(p.activeDir, dest);
    moved = true;
    crashPoint('register-after-rename');
    writeJson(p.intentFile, { id, at: new Date().toISOString(), stage: 'moved' });
  } catch {
    moved = false;
  }
  /** 复制退化路径里被改成留档名的源目录（回滚时优先还原它）。 */
  let sourceBackup: string | null = null;
  if (!moved) {
    // 复制退化路径的前提是「源端是完整部署」。源端读不全就什么都不做：宁可本次不启用，
    // 也不制造半残副本；旧实现复制出一个只有 config.json 的目录后就把源 rmSync 掉了，
    // 那一步中断 = 唯一完整副本消失。
    const source = deploymentManifest(p.activeDir);
    if (!source) {
      rmSync(p.intentFile, { force: true });
      throw new Error(`首次登记失败：活动部署根内容不完整（${p.activeDir}），未改动任何数据`);
    }
    const staging = join(p.rolesDir, `.staging-${Date.now()}`);
    writeJson(p.intentFile, { id, at: new Date().toISOString(), stage: 'copying', staging });
    try {
      cpSync(p.activeDir, staging, { recursive: true, force: true, errorOnExist: false });
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      rmSync(p.intentFile, { force: true });
      throw new Error(`首次登记失败：复制到暂存目录出错，原目录未动：${String(error)}`);
    }
    crashPoint('register-after-staging');
    const staged = deploymentManifest(staging);
    if (!staged || !manifestCovers(staged, source)) {
      rmSync(staging, { recursive: true, force: true });
      rmSync(p.intentFile, { force: true });
      throw new Error('首次登记失败：暂存副本与源内容不一致（已保留原目录，本次不登记）');
    }
    if (existsSync(dest) && readdirSync(dest).length > 0) {
      if (!parkAside(p.rolesDir, dest, 'orphan')) {
        rmSync(staging, { recursive: true, force: true });
        rmSync(p.intentFile, { force: true });
        throw new Error(`roles/${id} 已有内容且无法留档：${dest}`);
      }
    }
    // 暂存目录内容已逐文件核对等于源端，才原子改名成角色目录。
    renameSync(staging, dest);
    writeJson(p.intentFile, { id, at: new Date().toISOString(), stage: 'copied' });
    crashPoint('register-after-copy');
    // 源目录**改名留档，绝不 rm**。改名失败也不删：两端内容都完整，下一次启动按清单收敛。
    sourceBackup = parkAside(p.rolesDir, p.activeDir, 'source-backup');
    if (!sourceBackup) {
      writeJson(p.intentFile, { id, at: new Date().toISOString(), stage: 'copied-source-kept', source: p.activeDir });
      throw new Error('首次登记失败：无法把原目录改成留档名（两端数据都保留，本次不登记）');
    }
    writeJson(p.intentFile, { id, at: new Date().toISOString(), stage: 'source-parked', parked: sourceBackup });
  }
  // 登记提交前固定存储：config 写失败（磁盘故障/注入）必须拒绝启用并整体回滚，
  // 不能「登记成功 + 路径没固定」地静默半启用（Codex R2：写失败不能吞错后继续）。
  // 刻意放在 linkTo 之前：联接是提交点，回滚时活动位还空着，rename 原路还回即可。
  // 回滚优先还原「留档的源目录」，其次才用复制出来的 dest。
  const restoreSource = (): void => {
    try {
      if (existsSync(p.activeDir)) return;
      if (sourceBackup && existsSync(sourceBackup)) {
        renameSync(sourceBackup, p.activeDir);
        return;
      }
      if (existsSync(dest)) renameSync(dest, p.activeDir);
    } catch {
      /* 回滚失败时保留 roles/ 里的副本：数据还在，只是未登记 */
    }
  };
  const pinned = pinRoleStorage(home, id);
  if (!pinned.ok) {
    restoreSource();
    rmSync(p.intentFile, { force: true });
    throw new Error(`首次登记失败：存储固定未完成（${pinned.action}${pinned.detail ? `: ${pinned.detail}` : ''}），已回滚原目录，本次不启用角色档案`);
  }
  try {
    linkTo(home, id);
    crashPoint('register-after-link');
  } catch (error) {
    // 建联接失败时活动根可能已经空着：把源目录（或角色目录）还回去，
    // 绝不能留下「唯一一份角色数据在 roles/ 里、活动根却是空的」这种局面。
    restoreSource();
    throw new Error(`首次登记失败：建立联接出错，已尝试恢复原目录：${String(error)}`);
  }
  const created = newIndex(id, '原始角色', figure ? [figure] : []);
  writePointer(home, id);
  writeIndex(home, created);
  if (figure) pinRoleFigure(home, id, figure);
  rmSync(p.intentFile, { force: true });
  return created;
}

/**
 * 首次登记的**提交收敛**：把「活动联接 + 指针 + 注册表 + 形象」全部落到 id 上。
 *
 * 旧实现的恢复分支在「活动根是真目录」时只 park 就 return，忘了建联接——数据被
 * 改名留档后角色反而没了活动根（Codex 复现）。收敛路径统一走这里，任何成功结局
 * 都必须四件齐备。
 */
function finishRegistration(home: string, id: string, dest: string): { action: string; detail?: string; parked?: string } {
  const p = rolePaths(home);
  let parked: string | undefined;
  const state = activeTarget(home);
  if (state.kind === 'link' && state.target && samePath(state.target, dest)) {
    // 联接已经指向目标：不需要动（再走 linkTo 会白白拆建一次）。
  } else {
    if (state.kind === 'dir') {
      // seed() 补出来的普通目录不是任何角色的数据，改名留档，不删除。
      const moved = parkAside(p.rolesDir, p.activeDir, 'parked');
      if (!moved) return { action: 'register-ambiguous', detail: `活动根无法留档，拒绝登记：${p.activeDir}` };
      parked = moved;
    }
    linkTo(home, id);
  }
  if (readPointer(home) !== id) writePointer(home, id);
  const figure = boundFigure(home, id) ?? figureOfConfig(dest);
  const index = readIndex(home);
  if (!index) {
    writeIndex(home, newIndex(id, id === 'original' ? '原始角色' : id, figure ? [figure] : []));
  } else if (!index.roles.some((role) => role.id === id)) {
    index.roles.push({ id, label: id === 'original' ? '原始角色' : id, figures: figure ? [figure] : [], createdAt: new Date().toISOString() });
    index.active = id;
    writeIndex(home, index);
  } else if (index.active !== id) {
    index.active = id;
    writeIndex(home, index);
  }
  if (figure) pinRoleFigure(home, id, figure);
  rmSync(p.intentFile, { force: true });
  return { action: 'register-recovered', detail: id, ...(parked ? { parked } : {}) };
}

/**
 * 首次登记的中断恢复。
 *
 * 判定**只看磁盘上两端的真实内容清单**，不看意图文件的 stage，也不只看 config.json 是否存在：
 *  - 目标端完整、源端也完整且相同           → 源端改名留档，以目标端提交（rename 已落地）；
 *  - 目标端逐文件覆盖源端（源端被删了一半） → 以目标端提交，残缺源端留档（Codex 反例的正确结局）；
 *  - 源端逐文件覆盖目标端（复制中断）       → 残缺目标端留档，交回正常登记（源端完好、原子 rename）；
 *  - 两端各有对方没有的内容 / 两端都读不全 → **两边都保留**，写明确的拒绝记录，本次不登记、不碰存储。
 * 任何分支都不删除数据，也绝不静默造一个默认空角色。
 */
function recoverRegistration(home: string): { action: string; detail?: string; skipStorage?: boolean } | null {
  const p = rolePaths(home);
  const rawIntent = readJson<Record<string, unknown>>(p.intentFile);
  if (!rawIntent) return null;
  const id = typeof rawIntent.id === 'string' && rawIntent.id ? rawIntent.id : 'original';
  const dest = p.roleDir(id);
  const state = activeTarget(home);
  const sourceDir = state.kind === 'dir' ? p.activeDir : null;
  const srcMan = sourceDir ? deploymentManifest(sourceDir) : null;
  const destMan = deploymentManifest(dest);
  const evidence = {
    id,
    stage: typeof rawIntent.stage === 'string' ? rawIntent.stage : null,
    srcFiles: srcMan ? srcMan.size : null,
    destFiles: destMan ? destMan.size : null,
    active: state.kind,
  };
  const refuse = (detail: string): { action: string; detail: string; skipStorage: boolean } => {
    writeJson(p.intentFile, { ...rawIntent, at: new Date().toISOString(), stage: 'ambiguous', evidence });
    return { action: 'register-ambiguous', detail, skipStorage: true };
  };

  if (destMan && !srcMan) {
    // 目标端是唯一完整的一份（rename 已落地 / 源被删 / 源不可读）：以目标端提交。
    return finishRegistration(home, id, dest);
  }
  if (destMan && srcMan) {
    const destCoversSrc = manifestCovers(destMan, srcMan);
    const srcCoversDest = manifestCovers(srcMan, destMan);
    if (destCoversSrc && srcCoversDest) {
      // 两端内容相同（复制已完整）：源端改名留档，以目标端提交。
      return finishRegistration(home, id, dest);
    }
    if (destCoversSrc) return finishRegistration(home, id, dest);
    if (srcCoversDest) {
      // 目标端只是源端的一部分（复制被打断）：把残缺目标端留档，交回正常登记，
      // 由正常路径把**完整的源端**原子 rename 成角色目录。
      const parked = parkAside(p.rolesDir, dest, 'partial');
      if (!parked) return refuse(`残缺目标端无法留档，保留两端不登记：${dest}`);
      rmSync(p.intentFile, { force: true });
      return null;
    }
    return refuse(`两端内容不一致（源 ${srcMan.size} 文件 / 目标 ${destMan.size} 文件），保留两端等待人工判定`);
  }
  if (!destMan && srcMan) {
    // 目标端没有可用部署：意图只是空承诺，源端完好，交回正常登记。
    rmSync(p.intentFile, { force: true });
    return null;
  }
  // 两端都没有可用部署：活动根若是空目录（seed 刚补出来的）就当无事发生；否则显式拒绝。
  let leftover = 0;
  if (sourceDir) {
    try {
      leftover = readdirSync(sourceDir).length;
    } catch {
      leftover = 0;
    }
  }
  if (!sourceDir || leftover === 0) {
    rmSync(p.intentFile, { force: true });
    return null;
  }
  return refuse(`活动根与目标端都没有可读部署，保留两端不登记：${sourceDir}`);
}

/**
 * 记录一次待执行的切换。真正改联接发生在下一次启动的 import 期，
 * 因为此刻 Core 已经打开着活动部署根里的文件。
 */
/** 已有一个切换在途（prepared/repointed）：新目标必须让位，不能覆盖第一个目标。 */
export function pendingSwitch(home: string): SwitchJournal | null {
  const journal = readJournal(home);
  return journal && (journal.status === 'prepared' || journal.status === 'repointed') ? journal : null;
}

export function beginSwitch(
  home: string,
  to: string,
  from: string | null,
  figure: string | null = null,
  sourceFigure: string | null = null,
  sourceSkin?: Record<string, unknown>,
): SwitchJournal {
  const journal: SwitchJournal = {
    status: 'prepared',
    from: from ?? null,
    to,
    at: new Date().toISOString(),
    pid: process.pid,
    figure: figure ?? null,
    ...(sourceFigure !== null ? { sourceFigure } : {}),
    ...(sourceSkin ? { sourceSkin: JSON.parse(JSON.stringify(sourceSkin)) } : {}),
  };
  writeJournal(home, journal);
  return journal;
}

/**
 * instance.lock 的占用者是否仍然活着。
 *
 * Core 自己会接管「pid 已死」的陈旧锁，所以这里只判断活着的情况：
 * 活着就绝不碰联接（旧进程还在用这份数据），交给上层报 blocked。
 */
export function lockOwnerAlive(botDir: string): { alive: boolean; pid: number | null; detail?: string } {
  const file = join(deploymentDataDir(botDir), 'instance.lock');
  const payload = readJson<{ pid?: unknown; startedAt?: unknown }>(file);
  if (!payload) return { alive: false, pid: null };
  const pid = Number(payload.pid);
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return { alive: false, pid: null };
  let alive = false;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch (error) {
    alive = (error as NodeJS.ErrnoException)?.code === 'EPERM';
  }
  if (!alive) return { alive: false, pid };
  // 保守判定：只要 PID 还能响应就视为占用。锁年龄不能作为「已退出」的证据——
  // 一个正常跑了几小时的旧 Core 的锁同样是旧的，放行它会同时写坏两份数据。
  const startedAt = Date.parse(String(payload.startedAt ?? ''));
  const age = Number.isFinite(startedAt) ? `${Math.round((Date.now() - startedAt) / 1000)}s 前写入` : '写入时间未知';
  return { alive: true, pid, detail: `pid ${pid} 仍持有 ${file}（${age}）` };
}

/**
 * 把「目标没起来」的进行中切换回滚到源角色（源目录完整时才做；否则记 failed）。
 * 目标角色目录原样保留在 roles/<to>/companion，可能残留的临时目录挪到 .parked-* 留档。
 */
function revertSwitchToSource(home: string, journal: SwitchJournal, reason: string): { action: string; detail?: string } {
  const p = rolePaths(home);
  const from = journal.from;
  if (from && targetLooksComplete(home, from)) {
    const state = activeTarget(home);
    if (state.kind === 'dir') {
      const parked = join(p.rolesDir, `.parked-${Date.now()}`);
      renameSync(p.activeDir, parked);
      journal.parked = parked;
    }
    linkTo(home, from);
    if (readPointer(home) !== from) writePointer(home, from);
    const pinned = boundFigure(home, from);
    if (journal.sourceSkin) restoreRoleSkin(home, from, journal.sourceSkin);
    else if (journal.sourceFigure ?? pinned) pinRoleFigure(home, from, journal.sourceFigure ?? pinned);
    const index = readIndex(home);
    if (index && index.active !== from) {
      index.active = from;
      if (!index.roles.some((role) => role.id === from)) {
        index.roles.push({ id: from, label: from, figures: pinned ? [pinned] : [], createdAt: new Date().toISOString() });
      }
      writeIndex(home, index);
    }
    writeJournal(home, {
      ...journal,
      status: 'reverted',
      error: reason,
      bootExit: undefined,
      bootReady: undefined,
      bootFailures: undefined,
    });
    return { action: 'switch-reverted', detail: `${journal.to} -> ${from}` };
  }
  writeJournal(home, {
    ...journal,
    status: 'failed',
    error: `${reason}；源 ${from ?? '-'} 不可用`,
    bootExit: undefined,
    bootReady: undefined,
    bootFailures: undefined,
  });
  return { action: 'switch-failed', detail: `target ${journal.to} uncommitted` };
}

/**
 * 「上一次启动确实完成了启动」这份自证是否可信。
 *
 * 只凭「run.json 的 mtime 比 journal.at 新」是不够的：任何被更新过、被复制进来、
 * 或属于别的角色的 run.json 都能冒充（Codex 明确拒绝这种门控）。这里要求证据同时满足：
 *  - runFile 恰好是**目标角色有效 data 目录**下的 `runs/<runId>/run.json`（外部自定义
 *    data 路径也走同一条规则：data 目录按目标角色 config 解析）；
 *  - 该 run.json 的 mtime 落在**那次启动的窗口内**（≥ 它自己的 boot 时刻）；
 *  - 该 run.json 里列出了本世界；
 *  - Core 的 `runs/index.jsonl` 里有同一 runId、且 `pid` 恰好等于自证里 pid 的启动行。
 *    pid 由 Core 在构造时写入 index、run.json 由同一进程就绪后写入，两者对上才是同一次启动，
 *    因此陈旧 run.json / 别的 pid / 别的角色都无法通过。
 */
function authenticBootReady(home: string, journal: SwitchJournal): { ok: boolean; runFile?: string; detail: string } {
  const ready = journal.bootReady;
  if (!ready) return { ok: false, detail: '没有启动自证记录' };
  if (typeof ready.runId !== 'string' || !RUN_ID_RE.test(ready.runId)) {
    return { ok: false, detail: `自证 runId 形态不对：${String(ready.runId)}` };
  }
  if (!Number.isInteger(ready.pid) || ready.pid <= 0) return { ok: false, detail: `自证 pid 无效：${String(ready.pid)}` };
  const dataDir = roleEffectiveDataDir(home, journal.to);
  const expected = join(dataDir, 'runs', ready.runId, 'run.json');
  // 记录里的路径与「按目标角色 config 解析出的 data 目录」必须一致：防止另一角色/另一
  // data 目录的 run.json 冒充本次启动证据；同时也证明外部自定义 data 路径被正确解析。
  if (typeof ready.runFile !== 'string' || !samePath(ready.runFile, expected) || !within(dataDir, ready.runFile)) {
    return { ok: false, detail: `自证 run.json 不在目标角色的 data 目录：${String(ready.runFile)} ≠ ${expected}` };
  }
  if (typeof ready.dataDir === 'string' && !samePath(ready.dataDir, dataDir)) {
    return { ok: false, detail: `自证 data 目录与目标角色不一致：${ready.dataDir} ≠ ${dataDir}` };
  }
  const bootAt = Date.parse(ready.bootAt);
  const exitAt = Date.parse(ready.at);
  // 与「当前确认」「退出自证」共用同一身份判据：宿主启动索引里这个 run 的 pid 必须正好
  // 是自证里的 pid（= 真正去启动目标的那个进程），run.json 也必须落在那次启动的窗口内。
  // 光有「一个 mtime 更新的 run.json」永远不够。
  const identity = verifyRunIdentity(dataDir, {
    runId: ready.runId,
    runFile: ready.runFile,
    worldId: 'character-profiles',
    sinceMs: Number.isFinite(bootAt) ? bootAt : undefined,
    untilMs: Number.isFinite(exitAt) ? exitAt : undefined,
    expectPid: ready.pid,
  });
  if (!identity.ok) return { ok: false, detail: identity.reason };
  return { ok: true, runFile: identity.runFile, detail: `pid ${identity.pid} 的 run ${identity.runId} 已启动完成` };
}

/** 把「目标启动已完成」的切换提交成 applied（同时收敛指针与注册表）。 */
function commitBootReady(home: string, journal: SwitchJournal, detail: string): { action: string; detail: string } {
  if (readPointer(home) !== journal.to) writePointer(home, journal.to);
  const index = readIndex(home);
  if (index && index.active !== journal.to) {
    index.active = journal.to;
    writeIndex(home, index);
  }
  writeJournal(home, {
    ...journal,
    status: 'applied',
    error: undefined,
    bootExit: undefined,
    bootReady: undefined,
    bootFailures: undefined,
  });
  return { action: 'switch-applied-late', detail: `${journal.from ?? '-'} -> ${journal.to}（${detail}）` };
}

/**
 * import 期入口：先重放未完成的切换（崩溃恢复），再对指针修联接，最后首次登记。
 * 永不抛出——扩展坏了不能连带起不来伴侣。
 */
export function bootstrapDeployment(
  botDir: string,
  options: { enabled?: boolean } = {},
): { action: string; detail?: string; skipStorage?: boolean } {
  const home = homeOf(botDir);
  try {
    const p = rolePaths(home);
    const enabled = options.enabled !== false;
    const journal = readJournal(home);
    // 只要活动根还有活的占用者，任何形态的修复（重放、修联接、首次登记）都不做。
    const owner = lockOwnerAlive(p.activeDir);
    if (owner.alive) {
      // 占用者还活着时**连自己的状态文件都不碰**（旧实现在这里写 journal，等于和活着的
      // Core 抢同一份数据）。结论只经返回值与 import 期的诊断日志留痕，状态留给下一次
      // 启动重新判定——journal 仍是 prepared/repointed，不影响语义。
      return { action: 'locked', detail: owner.detail, skipStorage: true };
    }

    // 首次登记的中断（rename 之后、联接/指针之前崩溃）先补完：数据已在 roles/<id>/companion。
    const recovered = recoverRegistration(home);
    if (recovered) return recovered;

    if (journal && journal.status === 'repointed') {
      // 上次启动改完联接但没写出 applied：要区分三种结局。
      //  - 那次启动**确实完成了启动**（它自己在退出钩子里留下了自证：pid 与 Core 的
      //    runs/index.jsonl 对得上、run.json 在目标角色自己的 data 目录里、含本世界）
      //    → 提交 applied。健康但慢的启动（确认轮询窗口已过）也走这里，不再被当成失败回源；
      //  - 进程把自己正常结束掉了（退出钩子记了 bootExit，例如目标某个 World 的 start() 每次抛错）
      //    → 累计一次启动失败并重试；连续 MAX_BOOT_FAILURES 次仍是同一失败，必须回源，
      //      不能把用户永远钉在一个起不来的目标上（zcode 要求：确定性失败要能恢复原角色）；
      //  - 没有可信记录（被 SIGKILL/崩溃/自证不可信）→ 目标起没起来说不清，回滚源。
      // 新鲜度：退出记录比自证新，说明最近一次启动是失败的，按失败处理；反过来按成功处理。
      const exitAt = journal.bootExit ? Date.parse(String(journal.bootExit.at ?? '')) : Number.NaN;
      const readyAt = journal.bootReady ? Date.parse(journal.bootReady.at) : Number.NaN;
      const readyIsFresher =
        !!journal.bootReady &&
        !(journal.bootExit && Number.isFinite(exitAt) && Number.isFinite(readyAt) && exitAt >= readyAt);
      let bootReadyReject: string | null = null;
      if (readyIsFresher) {
        const ready = authenticBootReady(home, journal);
        if (ready.ok) {
          const state = activeTarget(home);
          if (state.kind === 'link' && state.target && samePath(state.target, p.roleDir(journal.to))) {
            return commitBootReady(home, journal, ready.detail);
          }
          // 自证可信但活动联接不指向目标：不能凭它宣称已切换，交回下面的失败/回滚逻辑。
          bootReadyReject = `启动自证可信但活动联接不是 ${journal.to}：${ready.detail}`;
          writeJournal(home, { ...journal, error: bootReadyReject });
        } else {
          // 自证不可信：明确记下来，绝不用它绕开提交门控。
          bootReadyReject = `启动自证不可信，不据此提交：${ready.detail}`;
          writeJournal(home, { ...journal, error: bootReadyReject });
        }
      }
      if (journal.bootExit) {
        const failures = (journal.bootFailures ?? 0) + 1;
        const code = journal.bootExit.code;
        if (failures >= MAX_BOOT_FAILURES) {
          return revertSwitchToSource(
            home,
            journal,
            `目标 ${journal.to} 连续 ${failures} 次启动失败（退出码 ${code ?? '-'}），已回源 ${journal.from ?? '-'}`,
          );
        }
        writeJournal(home, {
          ...journal,
          bootFailures: failures,
          bootExit: undefined,
          bootReady: undefined,
          error: `目标 ${journal.to} 启动失败（退出码 ${code ?? '-'}），第 ${failures} 次；下一次启动重试`,
        });
        return { action: 'switch-retry', detail: `${journal.from ?? '-'} -> ${journal.to} (failures=${failures})` };
      }
      return revertSwitchToSource(
        home,
        journal,
        bootReadyReject ?? `目标 ${journal.to} 未完成启动（未见该进程的 run.json），已回滚源 ${journal.from ?? '-'}`,
      );
    }

    if (journal && journal.status === 'prepared') {
      // 停用时不做普通重放（没有世界会提交它，重放只会反复改联接）。但活动根已经
      // 不是指向任何角色的联接时，说明崩溃点落在旧联接已拆/新目录被 seed 补成真
      // 目录之间——这一步必须恢复，否则下次启用也没有联接可用：角色数据不会丢，
      // 但用户看到的是 seed 出来的空人格。恢复只修联接，不提交 applied。
      const broken = activeTarget(home).kind !== 'link';
      // 严格区分两种「不完整」：prepared 意味着目标从未提交（指针仍在源角色）。
      // 停用期间若 seed 把 companion 补成了默认普通目录，恢复必须是「回到已提交的源」，
      // 绝不能顺势 linkTo(journal.to)——那就是一次未被批准的切换（zcode T2 组合问题）。
      if (!enabled && (broken || activeRoleId(home) !== journal.from)) {
        const state = activeTarget(home);
        let parked: string | undefined;
        if (state.kind === 'dir') {
          // seed 出来的默认人格不是任何角色的数据，留档不删。
          parked = join(rolePaths(home).rolesDir, `.parked-${Date.now()}`);
          renameSync(rolePaths(home).activeDir, parked);
        } else if (state.kind === 'link') {
          unlinkSync(rolePaths(home).activeDir);
        }
        // prepared 日志的 from 由 beginSwitch 写入，必为源角色 id（离线切换写的 applied 才允许 null）。
        linkTo(home, journal.from as string);
        writePointer(home, journal.from as string);
        writeJournal(home, {
          ...journal,
          status: 'blocked-disabled',
          parked,
          error: `扩展停用：未提交的目标 ${journal.to} 不切换，已恢复源 ${journal.from}`,
        });
        return {
          action: 'blocked-disabled',
          detail: `${journal.from} -> ${journal.to}（停用，恢复源，不切目标）`,
        };
      }
      if (!enabled && !broken) return { action: 'disabled-pending', detail: journal.to };
      if (!targetLooksComplete(home, journal.to)) {
        writeJournal(home, { ...journal, status: 'blocked', error: `目标角色 ${journal.to} 的部署目录不完整` });
        return { action: 'switch-blocked', detail: `target ${journal.to} incomplete` };
      }
      const lock = lockOwnerAlive(p.activeDir);
      if (lock.alive) {
        writeJournal(home, { ...journal, status: 'blocked', error: lock.detail });
        return { action: 'switch-blocked', detail: lock.detail };
      }
      // 崩溃可能正好落在「旧联接已拆、新联接未建」之间；下一次启动 seed() 会先把
      // `<home>/companion` 补成真实目录。那不是任何角色的数据（角色数据始终在
      // roles/<id>/companion 里），搬到 .parked-* 留档，不删除，然后照常建联接。
      const state = activeTarget(home);
      if (state.kind === 'dir') {
        const parked = join(p.rolesDir, `.parked-${Date.now()}`);
        renameSync(p.activeDir, parked);
        journal.parked = parked;
        writeJournal(home, { ...journal });
      }
      linkTo(home, journal.to);
      writePointer(home, journal.to);
      if (journal.figure) pinRoleFigure(home, journal.to, journal.figure);
      // 旧角色必须保留它自己的皮肤：Core 关机前可能刚把新 figure 写进它的 config。
      // R1（解绑角色恢复反弹）：原生装扮事件会把「用户刚点的 figure」持久化进源角色
      // config——源角色已解绑时 boundFigure 为空，残留的 figure 会在恢复源角色后被
      // rearm 当成一次新的装扮请求，A→B→A 又弹回 B。事务里记录的事件前穿着
      // （sourceFigure）优先；旧日志没有该字段时退回源角色绑定的 figure。
      if (journal.from && journal.from !== journal.to) {
        const previous = journal.sourceFigure ?? boundFigure(home, journal.from);
        if (journal.sourceSkin) restoreRoleSkin(home, journal.from, journal.sourceSkin);
        else if (previous) pinRoleFigure(home, journal.from, previous);
      }
      writeJournal(home, { ...journal, status: 'repointed' });
      return { action: 'switch-repointed', detail: `${journal.from ?? '-'} -> ${journal.to}` };
    }

    const pointer = readPointer(home);
    const state = activeTarget(home);
    if (pointer && state.kind === 'link' && state.target && !samePath(state.target, p.roleDir(pointer))) {
      // 指针与联接不一致（上次改联接时崩溃）→ 以指针为准修好联接。
      linkTo(home, pointer);
      return { action: 'link-repaired', detail: pointer };
    }
    if (pointer && state.kind === 'missing') {
      linkTo(home, pointer);
      return { action: 'link-created', detail: pointer };
    }
    if (pointer && state.kind === 'dir') {
      // 联接丢失后 seed() 补出来的真实目录不是角色数据，留档后按指针重建联接。
      const parked = join(p.rolesDir, `.parked-${Date.now()}`);
      renameSync(p.activeDir, parked);
      linkTo(home, pointer);
      return { action: 'stub-parked', detail: parked };
    }
    const created = registerDeployment(home);
    if (created) return { action: 'registered', detail: created.active };
    return { action: 'unchanged', detail: pointer ?? undefined };
  } catch (error) {
    return { action: 'bootstrap-error', detail: String(error) };
  }
}

/**
 * 世界启动后确认：此刻 Core 已经从新角色目录成功读出配置并跑起来了，
 * 才把日志推进到 applied；也不在 import 期就宣布 applied。
 */
export function confirmApplied(
  botDir: string,
  evidence?: { runFile: string; runId?: string; worldId?: string; pid?: number },
): { action: string; detail?: string } {
  const home = homeOf(botDir);
  try {
    const journal = readJournal(home);
    const state = activeTarget(home);
    if (state.kind !== 'link' || !state.target) return { action: 'not-a-link', detail: String(state.kind) };
    const roleFromLink = state.target.split(/[\\/]/).slice(-2)[0] ?? '';
    const pointer = readPointer(home);
    const id = pointer ?? roleFromLink;
    const index = readIndex(home) ?? newIndex(id, id);
    if (index.active !== id) {
      index.active = id;
      writeIndex(home, index);
    }
    // 形象只在「缺失」时补回角色绑定的值，绝不覆盖已经写好的具体形象。
    //
    // 旧实现无条件 pin，会与原生装扮保存赛跑：用户在装扮页保存另一个角色的形象后，
    // 紧接着的 import 把活跃角色的 config 又刷回自己的包，用户刚做的选择被抹掉，
    // 原生切换派发（watchFigureChange）也就不可能触发。切换链路本身
    // （linkTo / revertSwitchToSource / bootstrap 的 repointed 分支）都显式 pin 目标角色的形象，
    // 所以这里不再重复刷写，一致性由切换路径负责。
    const pinned = boundFigure(home, id);
    if (pinned && !figureOfConfig(rolePaths(home).roleDir(id))) pinRoleFigure(home, id, pinned);
    // 只有「日志目标就是当前真正挂上的角色」才允许推进到 applied；
    // import 期判定 blocked（目标目录残缺）的日志必须原样保留，不能被这里洗白。
    if (journal && journal.status !== 'applied') {
      // 只允许把「进行中的切换」提交成 applied；blocked/failed 等结论原样保留。
      const pending = journal.status === 'prepared' || journal.status === 'repointed';
      if (!pending || journal.to !== id) {
        return { action: 'journal-pending', detail: `${journal.status}: ${journal.from ?? '-'} -> ${journal.to}, active ${id}` };
      }
      // create() 不等于目标 Core + 全部 World 成功启动；必须以「目标进程自己写出的
      // run.json 里包含本世界」为准，才允许把日志推进到 applied（可被杀）。缺证据不提交。
      if (!evidence) {
        return { action: 'no-evidence', detail: '缺少目标进程 run.json 证据，不提交 applied' };
      }
      const worldId = evidence.worldId ?? 'character-profiles';
      // 身份必须当场重核一遍：轮询拿到的是「文件路径」，而文件是谁写的、是不是这次启动
      // 写的，只有按目标角色自己的 data 目录 + 宿主启动索引里的 pid 才能定性。
      // 给别人的 run.json 挂一条 applied，等于把一次没发生的成功记成成功。
      const targetDataDir = roleEffectiveDataDir(home, journal.to);
      const journalAt = Date.parse(String(journal.at ?? ''));
      const identity = verifyRunIdentity(targetDataDir, {
        runFile: evidence.runFile,
        runId: evidence.runId,
        worldId,
        sinceMs: Number.isFinite(journalAt) ? journalAt : 0,
        expectPid: evidence.pid ?? process.pid,
      });
      if (!identity.ok) {
        return { action: 'evidence-untrusted', detail: identity.reason };
      }
      crashPoint('journal-before-applied');
      writeJournal(home, { ...journal, status: 'applied', error: undefined, bootExit: undefined, bootFailures: undefined });
      return { action: 'applied', detail: `${journal.from ?? '-'} -> ${journal.to}` };
    }
    return { action: 'confirmed', detail: id };
  } catch (error) {
    return { action: 'confirm-error', detail: String(error) };
  }
}

/** 手动（离线）切换：要求目标角色目录完整、活动根没有被占用；改完联接后由用户重启伴侣。 */
export function switchOffline(home: string, to: string): void {
  const index = readIndex(home);
  if (!index) throw new Error('还没有注册表：先启动一次伴侣让扩展完成首次登记');
  // 有进行中的切换事务时不能直接覆写 journal：那会把排定的目标连同它的失败计数一并洗掉。
  const pending = pendingSwitch(home);
  if (pending) {
    throw new Error(`有切换事务进行中（${pending.from ?? '-'} -> ${pending.to}，${pending.status}），等它完成后再离线切换`);
  }
  if (!targetLooksComplete(home, to)) throw new Error(`角色 ${to} 没有完整的部署目录`);
  const lock = lockOwnerAlive(rolePaths(home).activeDir);
  if (lock.alive) throw new Error(`活动部署根仍被 pid ${lock.pid} 占用，无法离线切换`);
  linkTo(home, to);
  writePointer(home, to);
  const pinned = boundFigure(home, to);
  if (pinned) pinRoleFigure(home, to, pinned);
  index.active = to;
  writeIndex(home, index);
  writeJournal(home, { status: 'applied', from: null, to, at: new Date().toISOString(), pid: process.pid });
}

/** 角色目录列表（离线工具/后续 UI 用）。 */
export function listRoles(home: string): RoleRecord[] {
  return readIndex(home)?.roles ?? [];
}

/** 磁盘上已经存在的角色目录 id（判定孤儿）。 */
export function roleDirsOnDisk(home: string): string[] {
  const p = rolePaths(home);
  if (!existsSync(p.rolesDir)) return [];
  return readdirSync(p.rolesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(p.rolesDir, entry.name, DEPLOYMENT_DIRNAME)))
    .map((entry) => entry.name);
}

/** 默认的新角色名生成（阶段 1 仅用于测试与手册，不做 UI）。 */
export function nextProfileName(existing: string[]): string {
  let n = 1;
  while (existing.includes(`role-${n}`)) n += 1;
  return `role-${n}`;
}

/** run.json 里是否列出了这个世界（=目标进程真的把这个世界挂起来了）。 */
function runFileMentions(file: string, worldId: string): boolean {
  try {
    const data = readJson<{ worlds?: unknown }>(file);
    return Array.isArray(data?.worlds) && data.worlds.includes(worldId);
  } catch {
    return false;
  }
}

const RUN_ID_RE = /^r-\d{8}-\d{6}-[0-9a-f]{4}$/;

/** 一次「启动完成」证据的身份结论：哪个 run、在哪个 data 目录、宿主启动索引记的 pid。 */
export type RunIdentity =
  | { ok: true; runId: string; runFile: string; dataDir: string; pid: number; startedAt: string | null }
  | { ok: false; reason: string };

/**
 * 「这份 run.json 真能证明某次启动完成」的**唯一**判据。
 *
 * 三个入口必须共用它，任何一条路径只看 mtime / 世界名就提交都是缺陷：
 *  - 当前启动的确认轮询（index.ts scheduleConfirmation → confirmApplied）；
 *  - 退出自证（recordBootExit 写 bootReady）；
 *  - 下次启动的迟到恢复（authenticBootReady）。
 *
 * 同时成立才算数：
 *  1. 形态：runId 是 `r-YYYYMMDD-HHMMSS-xxxx`，run.json 就落在**该 data 目录**的
 *     `runs/<runId>/run.json`（不认外部路径，也不认另一个角色的 data 目录）；
 *  2. 内容：run.json 的 worlds 含本世界（= 本世界真的挂起来了，而不是 Core 只构造了一半）；
 *  3. 窗口：mtime 落在给定启动窗口内（排除上一轮/陈旧 run，也排除来源不明的更晚文件）；
 *  4. 出处：宿主 Core 自己在 `runs/index.jsonl` 里写了这个 run 的启动行，且行里的 pid
 *     等于 `expectPid`（给了的话）。Core 在构造时、世界启动之前写这一行，扩展运行时它
 *     就在同一进程里，所以「当前这次启动」的唯一合法 pid 就是 process.pid。
 *     伪造一份 run.json 但启动索引里没有对应 pid 行 → 一律不可信。
 */
export function verifyRunIdentity(
  dataDir: string,
  candidate: {
    runId?: string;
    runFile?: string;
    worldId?: string;
    sinceMs?: number;
    untilMs?: number;
    expectPid?: number;
  },
): RunIdentity {
  const worldId = candidate.worldId ?? 'character-profiles';
  const runId = candidate.runId ?? (candidate.runFile ? basename(dirname(candidate.runFile)) : '');
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) {
    return { ok: false, reason: `runId 形态不对：${String(runId)}` };
  }
  const runFile = join(dataDir, 'runs', runId, 'run.json');
  if (candidate.runFile !== undefined && !samePath(candidate.runFile, runFile)) {
    return { ok: false, reason: `run.json 不在该 data 目录的 runs/${runId} 下：${candidate.runFile}` };
  }
  if (!existsSync(runFile)) return { ok: false, reason: `run.json 不存在：${runFile}` };
  if (!runFileMentions(runFile, worldId)) return { ok: false, reason: `run ${runId} 没有把世界 ${worldId} 挂起来` };
  let mtime = 0;
  try {
    mtime = lstatSync(runFile).mtimeMs;
  } catch {
    return { ok: false, reason: `读不到 run.json 的 mtime：${runFile}` };
  }
  if (Number.isFinite(candidate.sinceMs) && mtime < (candidate.sinceMs as number) - 1000) {
    return { ok: false, reason: `run ${runId} 早于本次启动（mtime ${new Date(mtime).toISOString()}）` };
  }
  if (Number.isFinite(candidate.untilMs) && mtime > (candidate.untilMs as number) + 60_000) {
    return { ok: false, reason: `run ${runId} 比给定窗口还晚，来源不明` };
  }
  const indexFile = join(dataDir, 'runs', 'index.jsonl');
  let lines: string[] = [];
  try {
    lines = readFileSync(indexFile, 'utf8').split('\n').filter((line) => line.trim() !== '');
  } catch {
    return { ok: false, reason: `读不到 ${indexFile}` };
  }
  for (const line of lines) {
    let row: { run?: unknown; pid?: unknown; startedAt?: unknown } | null = null;
    try {
      row = JSON.parse(line) as { run?: unknown; pid?: unknown; startedAt?: unknown };
    } catch {
      continue;
    }
    if (row?.run !== runId) continue;
    const pid = Number(row.pid);
    if (!Number.isInteger(pid) || pid <= 0) {
      return { ok: false, reason: `run ${runId} 的启动行没有有效 pid：${String(row.pid)}` };
    }
    if (candidate.expectPid !== undefined && pid !== candidate.expectPid) {
      return { ok: false, reason: `run ${runId} 是 pid ${pid} 启动的，不是本次启动（pid ${candidate.expectPid}）` };
    }
    return { ok: true, runId, runFile, dataDir, pid, startedAt: typeof row.startedAt === 'string' ? row.startedAt : null };
  }
  return { ok: false, reason: `runs/index.jsonl 里没有 run ${runId} 的启动行` };
}

/**
 * 找「本次启动、包含本世界、身份可核」的 run.json。Core 在 `bot.start()` 末尾写
 * `<dataDir>/runs/<runId>/run.json`，文件名形如 `r-20261024-040102-abcd`。
 *
 * `expectPid` 给了就只认「启动索引里 pid 正好是它」的 run：当前进程的轮询与退出自证
 * 传 process.pid，于是别人的 run.json（旧启动、另一个角色、手写伪造）一个都不会被当证据。
 * 迟到恢复不按当前 pid 判断（那时启动进程已死），它用 journal.bootReady 自报的 pid 交给
 * verifyRunIdentity 对账。
 */
export function runEvidence(
  dataDir: string,
  sinceMs: number,
  worldId: string,
  options: { expectPid?: number; untilMs?: number } = {},
): { runFile: string; runId: string; pid: number } | null {
  const dir = join(dataDir, 'runs');
  if (!existsSync(dir)) return null;
  const candidates: { runId: string; mtime: number }[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    // existsSync 与 readdir 之间目录可能被清/失访：当作没有证据，绝不把异常抛给轮询方。
    return null;
  }
  for (const name of names) {
    if (!RUN_ID_RE.test(name)) continue;
    const file = join(dir, name, 'run.json');
    if (!existsSync(file)) continue;
    try {
      candidates.push({ runId: name, mtime: lstatSync(file).mtimeMs });
    } catch {
      continue;
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  for (const item of candidates) {
    const identity = verifyRunIdentity(dataDir, {
      runId: item.runId,
      worldId,
      sinceMs,
      untilMs: options.untilMs,
      expectPid: options.expectPid,
    });
    if (!identity.ok) continue;
    return { runFile: identity.runFile, runId: identity.runId, pid: identity.pid };
  }
  return null;
}

/** 只读探测：给验证脚本看 run.json 证据是否存在（不改变任何状态）。 */
export function probeRunEvidence(botDir: string, sinceMs: number, worldId: string): unknown {
  return runEvidence(join(botDir, 'data'), sinceMs, worldId);
}

/**
 * 进程退出兜底（只在还有 pending 切换、且本次启动没写出 run.json 时记录）：
 * 正常退出说明是目标启动失败（可重放重试，连续失败到上限后回源）；SIGKILL 不会走到这里，恢复器据此回滚。
 *
 * 身份核对（Codex 要求）：`journal.pid` 是「发起这次切换」的进程。发起方自己被
 * SIGTERM 结束掉时也会走 exit 钩子，它的退出码不能冒充「目标启动失败」——
 * 只有不是发起方的进程（即真正去启动目标的那个进程）才允许写 bootExit。
 * run.json 证据也必须用「本次启动时刻」（sinceMs），而不是 journal.at。
 */
/**
 * 从 data 目录反推 CORTICO_HOME，兼容两种真实形态：
 *  - `<home>/companion/data`（联接/未重定向）：dirname² 即 home；
 *  - `<home>/roles/<id>/companion/data`（切换重定向后的物理路径，退出钩子传的就是它）：
 *    dirname² 是 `roles/<id>`，必须再上溯两层；只认磁盘上确实存在 journal 的那个候选。
 */
function homeForDataDir(dataDir: string): string {
  const parts = dataDir.split(/[\\/]+/).filter(Boolean);
  if (parts.length >= 5 && parts[parts.length - 2] === DEPLOYMENT_DIRNAME && parts[parts.length - 4] === ROLES_DIRNAME) {
    const candidate = parts.slice(0, parts.length - 4).join('/');
    if (candidate && existsSync(join(candidate, ROLES_DIRNAME, 'journal.json'))) return candidate;
  }
  return dirname(dirname(dataDir));
}

export function recordBootExit(
  dataDir: string,
  code: number | null,
  options: { sinceMs?: number; home?: string } = {},
): void {
  // 传入的是「本次启动真正加载的 data 目录」（物理路径），不是 botDir/data 拼出来的路径：
  // 换向外壳之后 botDir 可能已指向别的角色，退出记录若跟着联接走就会记到新角色头上。
  // journal 仍只在 <home>/roles/journal.json 一份；home 由调用方按部署上下文显式给出，
  // 没给才回退按 dataDir 形态反推（外部自定义 data 路径下反推会猜错）。
  const home = options.home ?? homeForDataDir(dataDir);
  try {
    const journal = readJournal(home);
    if (!journal || (journal.status !== 'prepared' && journal.status !== 'repointed')) return;
    if (typeof journal.pid === 'number' && journal.pid === process.pid) return;
    const since = options.sinceMs ?? Date.parse(journal.at ?? '');
    const sinceMs = Number.isFinite(since) ? since : 0;
    // 只认「启动索引里记的 pid 就是本进程」的 run.json：退出钩子绝不把别人的 run
    // （旧启动、另一个角色、手写伪造）写成有效自证——那样一次没发生的成功会被记成成功，
    // 还会把真实的失败记录（bootExit/失败计数）冲掉。本进程没有可信自证就走下面的失败分支。
    const evidence = runEvidence(dataDir, sinceMs, 'character-profiles', { expectPid: process.pid });
    if (evidence) {
      // 这次启动**确实完成了启动**：本进程自己写出的 run.json 里含本世界。留一条自证记录，
      // 下一次启动在「确认轮询已经超时」的情况下据此提交切换，而不是把健康启动当失败回滚
      // （旧行为：轮询 20s 超时 → 进程正常退出 → 下次启动「没退出记录」→ 无条件回源）。
      writeJournal(home, {
        ...journal,
        bootReady: {
          at: new Date().toISOString(),
          bootAt: new Date(sinceMs).toISOString(),
          pid: evidence.pid,
          dataDir,
          runId: evidence.runId,
          runFile: evidence.runFile,
          tag: process.env.CORTICO_PROBE_RUN_TAG || undefined,
        },
        bootExit: undefined,
        bootFailures: 0,
      });
      return;
    }
    writeJournal(home, {
      ...journal,
      bootExit: {
        code,
        at: new Date().toISOString(),
        pid: process.pid,
        bootAt: new Date(sinceMs).toISOString(),
        // 探针可给每本次启动打标签（CORTICO_PROBE_RUN_TAG）：用来断言「记录的确实是这次启动」。
        tag: process.env.CORTICO_PROBE_RUN_TAG || undefined,
      },
    });
  } catch {
    /* 退出路径尽力而为，不抛 */
  }
}
