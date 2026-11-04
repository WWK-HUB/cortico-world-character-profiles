/**
 * character-profiles —— 多角色档案的世界扩展（Stage 1 可行性探针）。
 *
 * 职责只有三件事：
 *   1. import 期：把「已记录但未生效」的角色切换补完（重放），并把活动部署根
 *      的联接对到指针指向的角色；
 *   2. 世界工具 + 原生装扮监听：原生 Dress 保存 figure（POST /api/skin → persist
 *      写回 config.json）落到磁盘后，若该 figure 绑定了别的角色就准备切换；
 *   3. 启动后确认：Core 已经从新角色目录成功读出配置，才把切换记为 applied。
 *
 * 不复制角色数据、不修改 Coopanion 安装文件；所有状态都在 `<CORTICO_HOME>/roles/`。
 */
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unwatchFile, watchFile, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { WorldDefinition, WorldHost } from 'cortico/world';
import { corticoHome } from './env.js';
import { startDshBridgeMonitor } from './dsh-bridge.js';
import {
  bindFigureCore,
  panelConfigGroups,
  panelDecls,
  panelFigures,
  panelInvoke,
  panelLamp,
  type PanelDeps,
} from './panel.js';
import {
  beginSwitch,
  bootstrapDeployment,
  confirmApplied,
  runEvidence,
  homeOf,
  listRoles,
  nextProfileName,
  pendingSwitch,
  readIndex,
  readJournal,
  readPointer,
  recordBootExit,
  pinRoleStorage,
  prepareDeploymentStorage,
  roleDirsOnDisk,
  rolePaths,
  switchOffline,
  verifyRunIdentity,
  writeJournal,
} from './roles.js';
import type { SwitchJournal } from './roles.js';
import { waitForSingleMode } from './profile-api.js';
import {startPositionResume} from './position-resume.js';

// A restarted single Core waits here while the independent multi supervisor owns profiles.
// This occurs before bootstrap or loadDeployment. Existing 0.2.x behavior is unchanged without a mode file.
const multiModeHome = corticoHome();
if (multiModeHome) await waitForSingleMode(multiModeHome);

/** 世界 id；配置里 `worlds['character-profiles']` 的开关同步沿用它。 */
export const CHARACTER_PROFILES_ID = 'character-profiles';

/** 原生桌宠 world 的 id（皮肤字段住在它的配置段里）。 */
const DESKTOP_PET_ID = 'desktop-pet';

const CONFIG_FILE = 'config.json';

/** 本进程 import 时刻：提交 applied 时用它过滤「本次启动」写出的 run.json。 */
const BOOT_AT_IMPORT = Date.now();

/** create() 拿到的部署根，start() 里用它排定「ready 之后才提交」的确认。 */
let botDirForConfirm: string | null = null;
/** 本次进程真正加载的 data 目录（物理路径）：重启标记、启动确认、退出记录都锚定它。 */
let assignedDataDir: string | null = null;
/** 本次进程的部署 home 身份：来自已验证的 CORTICO_HOME / 部署上下文，不靠 dataDir 反推。 */
let assignedHome: string | null = null;
/**
 * 引导期判定「活动根被活着的 Core 占用」时为 true：这次的进程根本没打开过目标，
 * 退出时**不许**记退出码——否则「被占用没启动」会被下一次启动读成「目标启动失败」，
 * 白白累计失败次数甚至回滚一次其实没问题的切换（同一份 journal 还归占用者管）。
 */
let bootRecordSuppressed = false;

/**
 * 把 botDir 解析成「原生配置里 effective 的 data 目录」，而不是硬编码 realpath(botDir)/data。
 * 与原生 deploy.ts 的 abs() 语义一致：config.paths.data 相对路径按部署根解析，绝对路径原样使用。
 */
export function resolveDataDir(botDir: string): string {
  let realBot = botDir;
  try {
    realBot = realpathSync.native(botDir);
  } catch {
    /* 联接还没建立时用原路径 */
  }
  let configured: unknown;
  try {
    configured = JSON.parse(readFileSync(join(realBot, CONFIG_FILE), 'utf8'))?.paths?.data;
  } catch {
    configured = undefined;
  }
  if (typeof configured === 'string' && configured.trim()) {
    return isAbsolute(configured) ? resolve(configured) : resolve(realBot, configured);
  }
  return join(realBot, 'data');
}

function dataDirOf(botDir: string): string {
  return assignedDataDir ?? resolveDataDir(botDir);
}

// 进程离开时若还有 pending 切换且本次没写出 run.json，记下退出码：
// 恢复器据此区分「确定性启动失败（可重放）」与「被杀/崩溃（回滚源）」。
process.on('exit', (code) => {
  if (assignedDataDir && !bootRecordSuppressed) {
    recordBootExit(assignedDataDir, code, {
      sinceMs: BOOT_AT_IMPORT,
      ...(assignedHome ? { home: assignedHome } : {}),
    });
  }
});

/** 已挂上的原生装扮监听；stop() 统一摘掉，避免热重载后叠加。 */
const watched = new Set<string>();

// ───────────────────────────── import 期：切换重放 ─────────────────────────────

/**
 * 扩展 import 期在我们的 WorldDefinition 构造前执行（此刻 Core 还没构造 bot，
 * 活动部署根还没被打开）。顺序刻意是「先修联接、后注册」：崩溃恢复优先于首次启用。
 * 任何异常都只记录、不外抛——扩展坏了不能连带起不来伴侣。
 */
export function bootstrapAtImport(botDir: string, enabled: boolean): Record<string, unknown> {
  // 先落一个可用的 data 目录，保证 import 中途抛错时退出钩子也能记退出码；
  // 重放结束后再按「重放后的目标角色」重新解析（见函数末尾）。
  assignedDataDir = resolveDataDir(botDir);
  const home = homeOf(botDir);
  const result = bootstrapDeployment(botDir, { enabled });
  bootRecordSuppressed = result.action === 'locked';
  // 混合方案：每个角色有自己的完整部署根 + 活动联接；存储（memory/data）固定到
  // 该角色的真实目录，外观走共享 figures 根 + 角色私有 figures。必须在原生
  // loadDeployment 打开活动根之前做，否则读写会指回旧角色。
  //
  // 门控：引导期一旦判定「活动根被活着的 Core 占用」（locked）、「两端数据冲突、需要人工
  // 判定」（register-ambiguous）或「停用搁置」（disabled-pending），就**一律跳过**存储准备
  // ——固定 config、迁移形象、清理重启标记都会写用户数据，占用者还在跑的时候写等于和它抢
  // 数据（Codex：locked 时扩展一个字节都不该写）；停用搁置时写则违背「停用不动数据」。
  // 此前这里无条件调用，是缺陷成因。
  let storage: unknown = null;
  if (result.skipStorage === true || result.action === 'disabled-pending') {
    storage = { ok: false, action: 'storage-skipped', detail: `bootstrap 结论 ${result.action}：占用/冲突/停用搁置时不写存储` };
  } else {
    try {
      storage = prepareDeploymentStorage(home, { enabled });
    } catch (error) {
      // 混合存储的失败不能把整个 import 拖垮：否则连登记失败这种可解释错误都不会
      // 落日志（G1e 就是要看这条日志）。记下来、让 Core 继续用原生路径。
      storage = { ok: false, action: 'storage-error', detail: String(error) };
    }
  }
  const journal = readJournal(home);
  const pointer = readPointer(home);
  const index = readIndex(home);
  log(home, {
    phase: 'import',
    result,
    storage,
    journalStatus: journal?.status ?? null,
    pointer,
    active: index?.active ?? null,
    roles: index?.roles.map((r) => r.id) ?? [],
    pid: process.pid,
  });
  // 重放可能刚把联接换到目标角色：此刻重解析，后续重启标记/确认/退出记录都跟着它。
  assignedDataDir = resolveDataDir(botDir);
  return { ...result, storage, journalStatus: journal?.status ?? null, pointer, active: index?.active ?? null };
}

/**
 * 把共享 figures 根加进原生外观包的发现路径（`COOPANION_PACK_ROOTS`）：
 * 角色私有 figures 是非空真实目录时不做联接/合并，共享包靠这个根仍然可见。
 */

/**
 * 模块加载即执行：只有世界真的被启用（`worlds['character-profiles'].enabled` 为真）
 * 才碰磁盘。仅靠环境变量不算停用——停用必须让扩展完全不动数据。
 */
(function bootAtImport(): void {
  // CORTICO_HOME 由宿主注入；corticoHome() 已做过穿越校验（拒绝 .. 段与非绝对路径），
  // 校验不过返回 null，这里完全不动磁盘。
  const home = corticoHome();
  if (!home) return;
  assignedHome = home;
  const botDir = join(home, 'companion');
    botDirForConfirm = botDir;
  try {
    const config = JSON.parse(readFileSync(join(botDir, CONFIG_FILE), 'utf8')) as Record<string, any>;
    const enabled = config?.worlds?.[CHARACTER_PROFILES_ID]?.enabled === true;
    // 已启用：正常引导。未启用：只有磁盘上留有这套扩展的状态（注册表/切换日志）
    // 时才继续——那是崩溃恢复（例如联接换向的间隙里被 seed() 重建成了普通目录），
    // 不是「替用户管理角色」。全新数据目录两者都没有，于是完全不碰磁盘。
    const leftover = existsSync(join(home, 'roles', 'index.json')) || existsSync(join(home, 'roles', 'journal.json'));
    if (!enabled && !leftover) return;
    bootstrapAtImport(botDir, enabled);
  } catch (error) {
    log(home, { phase: 'import-skip', error: String(error) });
  }
})();

function log(home: string, payload: Record<string, unknown>): void {
  try {
    const dir = join(home, 'character-profiles');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'extension.log');
    // 改进（审查：日志无限增长且面板每次全量读取）：超过 512KB 就轮转成 .1
    // （直接覆盖上一代），保证取证日志只保留「当前代 + 上一代」。
    try {
      if (existsSync(file) && statSync(file).size > 512 * 1024) {
        rmSync(`${file}.1`, { force: true });
        renameSync(file, `${file}.1`);
      }
    } catch {
      /* 轮转失败就继续追加，不影响主流程 */
    }
    appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...payload })}\n`, 'utf8');
  } catch {
    /* 取证日志写失败不影响主流程 */
  }
}

// ───────────────────────────── 配置读写 ─────────────────────────────

function readConfig(file: string): Record<string, any> | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>;
  } catch {
    return null;
  }
}

function figureOf(config: Record<string, any> | null): string | null {
  const figure = config?.worlds?.[DESKTOP_PET_ID]?.skin?.figure;
  return typeof figure === 'string' && figure ? figure : null;
}

// ───────────────────────────── 角色列表（只读）─────────────────────────────

interface ProfileEntry {
  id: string;
  label: string;
  figure: string | null;
  configFile: string;
  compose: { world: string; enabled: boolean }[];
}

function listProfiles(botDir: string): ProfileEntry[] {
  const home = homeOf(botDir);
  const index = readIndex(home);
  const ids = new Set<string>(index?.roles.map((r) => r.id) ?? []);
  for (const id of roleDirsOnDisk(home)) ids.add(id);
  return [...ids].map((id) => {
    const configFile = join(rolePaths(home).roleDir(id), CONFIG_FILE);
    const config = readConfig(configFile);
    const worlds = (config?.worlds ?? {}) as Record<string, any>;
    const compose = Object.entries(worlds)
      .filter(([, section]) => section && typeof section === 'object' && 'enabled' in section)
      .map(([worldId, section]) => ({ world: worldId, enabled: Boolean(section.enabled) }));
    return {
      id,
      label: String(config?.displayName ?? id),
      figure: figureOf(config) ?? index?.roles.find((r) => r.id === id)?.figures?.[0] ?? null,
      configFile,
      compose,
    };
  });
}

// ───────────────────────────── 切换调度 ─────────────────────────────

function matchRole(
  roles: { id: string; label: string; figures?: string[] }[],
  value: string,
): { id: string; label: string; figures?: string[] } | null {
  const wanted = value.trim().toLowerCase();
  return roles.find((role) => role.id === wanted) ?? roles.find((role) => role.label.toLowerCase() === wanted) ?? null;
}

/**
 * 记录一次「下次启动生效」的切换：只写切换日志 + 重启标记，不在这里改联接
 * （Core 已经打开着活动部署根，此刻换向会让运行中的实例写到另一个角色目录里）。
 */
function scheduleSwitch(
  botDir: string,
  roleLabel: string,
  figure: string | null,
  sourceFigure: string | null = null,
  sourceSkin?: Record<string, unknown>,
): { scheduled: boolean; detail: string; busy?: boolean; pending?: SwitchJournal | null } {
  const home = homeOf(botDir);
  const index = readIndex(home);
  if (!index) return { scheduled: false, detail: '角色注册表还没建立：先正常启动一次伴侣' };
  const target = matchRole(index.roles, roleLabel);
  if (!target) {
    return { scheduled: false, detail: `没有匹配的角色：${roleLabel}；可用：${index.roles.map((r) => r.id).join(', ')}` };
  }
  const pending = pendingSwitch(home);
  if (pending) {
    const detail = `已有切换在进行中（${pending.from} -> ${pending.to}，${pending.status}）：拒绝目标 ${target.id}，保留第一个目标`;
    log(home, { phase: 'switch-busy', rejected: target.id, figure, pending });
    return { scheduled: false, busy: true, detail, pending };
  }
  if (target.id === index.active) return { scheduled: false, detail: `${target.id} 已经是当前角色` };
  // 路径写入同样可能失败：失败就不切换（保持源角色），并留下可解释的事务记录。
  const storage = pinRoleStorage(home, target.id);
  if (!storage.ok) {
    // 与其余日志同一写入通道（tmp+rename+重试）；`at` 用 ISO 字符串，别处会 Date.parse 它。
    writeJournal(home, {
      status: 'reverted',
      from: index.active,
      to: target.id,
      at: new Date().toISOString(),
      error: `目标存储无法固定：${storage.detail ?? storage.action}`,
    });
    log(home, { phase: 'switch-storage-failed', target: target.id, storage });
    return { scheduled: false, detail: `目标存储无法固定：${storage.detail ?? storage.action}` };
  }
  const journal = beginSwitch(home, target.id, index.active, figure ?? target.figures?.[0] ?? null, sourceFigure, sourceSkin);
  try {
    scheduleRestart(botDir);
  } catch (error) {
    const detail = `无法请求重启，保留当前角色：${String(error)}`;
    writeJournal(home, { ...journal, status: 'reverted', error: detail });
    log(home, { phase: 'switch-restart-failed', detail });
    return { scheduled: false, detail };
  }
  log(home, { phase: 'switch-scheduled', journal });
  return { scheduled: true, detail: JSON.stringify(journal) };
}

/** 重启前等待的毫秒数：默认 400；探针用 CORTICO_PROBE_SWITCH_DELAY_MS 拉长窗口做阶段观测。 */
function switchDelayMs(): number {
  const raw = Number(process.env.CORTICO_PROBE_SWITCH_DELAY_MS ?? '');
  // 未设置/非法/0 都落回默认 400：Number('') 是 0，旧写法把「没设变量」当成「0ms 窗口」，
  // 重启前不给任何宽限（真实 Core 证据登记的 minor 缺陷 switch-delay-default-is-zero）。
  return Number.isFinite(raw) && raw > 0 ? raw : 400;
}

/** 交给 Core 的受控重启通道：标记文件 + SIGTERM（由 CoreHost 监督进程拉起重放）。 */
function scheduleRestart(botDir: string): void {
  // No restart flag means CoreHost will not relaunch us. Fail before scheduling any signal.
  const dataDir = dataDirOf(botDir);
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, '.restart-request'), new Date().toISOString(), 'utf8');
  setTimeout(() => {
    try {
      process.kill(process.pid, 'SIGTERM');
    } catch {
      /* 已经退出则忽略 */
    }
  }, switchDelayMs()).unref?.();
}

// ───────────────────────────── 世界定义 ─────────────────────────────

interface ProfilesState {
  enabled: boolean;
  dshAutoDiscover?: boolean;
  /** 图层来源：'pet' 跟随原生桌宠装扮；'own' 用本扩展自己的端点（探针用）。 */
  figureSource?: 'pet' | 'own';
}

const definition: WorldDefinition<ProfilesState> = {
  id: CHARACTER_PROFILES_ID,
  label: '角色档案',
  defaults: () => ({ enabled: false, figureSource: 'pet', dshAutoDiscover: false }),
  // 配置项通过 webUi().config 的 ConfigGroup 声明（0.2.9 契约），见 panelConfigGroups()。

  create(ctx) {
    const home = homeOf(ctx.botDir);
    let stopDshMonitor: (() => void) | null = null;
    let stopPositionResume: (()=>void)|null=null;

    botDirForConfirm = ctx.botDir;
    assignedHome = corticoHome() ?? dirname(ctx.botDir);
    // ctx.dataDir 是原生 loadDeployment 按配置解析出的 effective data 目录（含自定义/外部路径）；
    // 拿不到才回退按 config.json 自行解析，绝不硬编码 realpath(botDir)/data。
    assignedDataDir = (ctx as { dataDir?: string }).dataDir ?? resolveDataDir(ctx.botDir);
    // 面板数据面依赖：requestSwitch 复用与原生装扮监听同一条切换事务。
    const panelDeps: PanelDeps = {
      home,
      botDir: ctx.botDir,
      requestSwitch: (roleLabel: string, figure: string | null) => scheduleSwitch(ctx.botDir, roleLabel, figure),
    };
    // create() 只做「不改提交」的修正（active/皮肤/注册表一致性）；
    // pending 的 committed 一律等到 run.json 证明目标进程真的起来了才提交。
    const repair = confirmApplied(ctx.botDir);
    // 记录原生 ctx 给出的 effective dataDir（验证锁/ctx/run.json 都锚定它）。
    log(home, { phase: 'start', repair, dataDir: assignedDataDir, ctxDataDir: (ctx as { dataDir?: string }).dataDir ?? null, pid: process.pid });

    // 原生 Dress 保存监听：figure 改到另一个角色绑定的 id 时，准备下一次启动的切换。
    if (ctx.cfg.figureSource !== 'own') {
      const configFile = join(ctx.botDir, CONFIG_FILE);
      let lastSkin = readConfig(configFile)?.worlds?.[DESKTOP_PET_ID]?.skin ?? {};
      let lastFigure = typeof lastSkin.figure === 'string' ? lastSkin.figure : null;
      watchFile(configFile, { interval: 400 }, () => {
        const config = readConfig(configFile);
        if (!config) return;
        const skin = config.worlds?.[DESKTOP_PET_ID]?.skin ?? {};
        const figure = figureOf(config);
        const sourceSkin = lastSkin;
        lastSkin = skin;
        if (figure === lastFigure) return;
        // R1：事件前源角色穿着的外观（原生持久化马上会把它覆盖掉），随事务记录，
        // 回放离开源角色时还原，解绑角色恢复后不再残留目标 figure。
        const sourceFigure = lastFigure;
        lastFigure = figure;
        if (!figure) return;
        const index = readIndex(home);
        const target = index?.roles.find((role) => role.figures.includes(figure));
        if (!index || !target || target.id === index.active) return;
        log(home, { phase: 'native-skin-detected', figure, sourceFigure, target: target.id });
        try {
          scheduleSwitch(ctx.botDir, target.id, figure, sourceFigure, sourceSkin);
        } catch (error) {
          log(homeOf(ctx.botDir), { phase: 'native-skin-schedule-failed', reason: String(error && (error as Error).stack ? (error as Error).stack : error) });
        }
      });
      watched.add(configFile);
    }

    return {
      id: CHARACTER_PROFILES_ID,

      envPromptVars() {
        const index = readIndex(home);
        const roles = index?.roles.map((r) => `${r.id}${r.id === index.active ? '(当前)' : ''}`).join('、') ?? '无';
        return { profiles: roles, active_profile: index?.active ?? '未知' };
      },

      webUi() {
        const lamp = panelLamp(home);
        const index = readIndex(home);
        const activeRecord = index?.roles.find((r) => r.id === index.active);
        return {
          label: '角色档案',
          lamps: [{ label: '角色', state: lamp.state, hint: lamp.hint }],
          badges: activeRecord ? [{ label: '当前角色', value: String(activeRecord.label ?? activeRecord.id), tone: 'on' as const }] : [],
          panels: panelDecls(),
          invoke: (panel: string, method: string, args: unknown[]) => panelInvoke(panelDeps, panel, method, args),
          config: panelConfigGroups(),
        };
      },

      tools() {
        return [
          {
            name: 'character',
            tags: ['profile'],
            description:
              '多角色档案：列出角色、切换角色或指定默认形象图。切换会重启伴侣，当前对话中断；环境变量只在下一条消息生效。',
            inputSchema: {
              type: 'object',
              properties: {
                action: { type: 'string', enum: ['list', 'switch', 'figure'], description: 'list 查看；switch 切换；figure 为角色指定默认形象图。' },
                role: { type: 'string', description: '角色 id 或名字（switch / figure 必填）。' },
                figure: { type: 'string', description: 'figure 的 id（figure 必填）。' },
                force: { type: 'boolean', description: 'figure 改绑确认：该外观已绑定给别的角色时，必须显式传 true 才会解除原绑定并改绑。' },
              },
              required: ['action'],
            },
            async run(input: Record<string, unknown>) {
              const action = String(input.action ?? '');
              if (action === 'list') {
                const index = readIndex(home);
                return {
                  ok: true,
                  active: index?.active ?? null,
                  roles: listProfiles(ctx.botDir),
                  pending: readJournal(home),
                  pointer: readPointer(home),
                };
              }
              if (action === 'switch') {
                const role = String(input.role ?? '');
                const result = scheduleSwitch(ctx.botDir, role, null);
                return { ok: result.scheduled, ...result };
              }
              if (action === 'figure') {
                const roleLabel = String(input.role ?? '');
                const figure = String(input.figure ?? '').trim();
                const index = readIndex(home);
                if (!index) return { ok: false, detail: '角色注册表还没建立' };
                const entry = matchRole(index.roles, roleLabel) as { id: string; label: string } | null;
                if (!entry) return { ok: false, detail: `没有这个角色：${roleLabel}` };
                if (!figure) return { ok: false, detail: 'figure 不能为空' };
                // R3：与面板同一条绑定服务 + 外观存在性校验，不再直接改注册表
                // （旧实现 record.figures=[figure] 会造成一个外观同时归两个角色）。
                // 已被穿着/绑定的外观视为真实存在（枚举器覆盖不到的包也放行）。
                const known = index.roles.some((r) => r.figures.includes(figure))
                  || roleDirsOnDisk(home).some((id) => figureOf(readConfig(join(rolePaths(home).roleDir(id), CONFIG_FILE))) === figure);
                if (!known) {
                  const available = await panelFigures(panelDeps);
                  if (available.length && !available.some((f) => f.id === figure)) {
                    return { ok: false, detail: `没有这个外观：${figure}；可用：${available.map((f) => f.id).join(', ')}` };
                  }
                }
                const result = bindFigureCore(home, entry.id, figure, { allowSteal: input.force === true });
                if (!result.ok && result.conflict === 'figure-owned') {
                  return {
                    ok: false,
                    conflict: result.conflict,
                    owner: result.owner ?? null,
                    detail: `${result.detail} 如确认要改绑（解除 ${result.owner} 的绑定），请用相同参数加 force:true 重试。`,
                  };
                }
                return { ok: result.ok, detail: result.detail, ...(result.wornByActive ? { wornByActive: true } : {}) };
              }
              return { ok: false, detail: `未知 action：${action}` };
            },
          },
        ];
      },

      async start(host: WorldHost) {
        void host;
        stopPositionResume=startPositionResume(home,message=>log(home,{phase:'position-resume',message}));
        scheduleConfirmation();
        stopDshMonitor = startDshBridgeMonitor(ctx.botDir, message => log(home, { phase: 'dsh-bridge', message }));
      },

      async stop() {
        stopPositionResume?.();stopPositionResume=null;
        stopDshMonitor?.();
        stopDshMonitor = null;
        stopConfirmation();
        for (const file of watched) unwatchFile(file);
        watched.clear();
      },
    };
  },
};

export default definition;
export { listRoles, switchOffline, nextProfileName, scheduleSwitch };

/**
 * 等到目标进程**真正写出 run.json**（Core 在 bot.start() 末尾、世界与面板都挂好之后写）
 * 才提交切换。create() 在启动中途被调用——那时 Core 可能随后就崩，提交早了就丢证据。
 */
// A rejected second request stays rejected. Reading a whole config file's mtime cannot
// prove another Dress click: ordinary configuration writes and startup also change it.

let confirmTimer: NodeJS.Timeout | null = null;

function stopConfirmation(): void {
  if (confirmTimer) clearInterval(confirmTimer);
  confirmTimer = null;
}

/**
 * 诊断用（不参与判定）：本次启动窗口里已经出现的 run.json 里，哪一个身份核不过、为什么。
 * 只为了让「有文件却不提交」留下可审计的回执，而不是静默不动。
 */
function untrustedBootEvidence(dataDir: string): string | null {
  try {
    const dir = join(dataDir, 'runs');
    if (!existsSync(dir)) return null;
    for (const name of readdirSync(dir)) {
      if (!/^r-\d{8}-\d{6}-[0-9a-f]{4}$/.test(name)) continue;
      const file = join(dir, name, 'run.json');
      if (!existsSync(file)) continue;
      if (lstatSync(file).mtimeMs < BOOT_AT_IMPORT) continue;
      const check = verifyRunIdentity(dataDir, {
        runId: name,
        worldId: CHARACTER_PROFILES_ID,
        sinceMs: BOOT_AT_IMPORT,
        expectPid: process.pid,
      });
      if (!check.ok) return `run ${name}（${dataDir}）不可信：${check.reason}`;
    }
  } catch {
    /* 诊断用，读不到就算了 */
  }
  return null;
}

function scheduleConfirmation(): void {
  const botDir = botDirForConfirm;
  if (!botDir) return;
  if (confirmTimer) return; // start() 可能被调用多次，别叠加轮询
  const home = homeOf(botDir);
  const dataDir = dataDirOf(botDir);
  let committed = false;
  let warned = false;
  let rejected = false;
  let pollErrorLogged = false;
  let tries = 0;
  const attempt = (why: string): void => {
    if (committed) return;
    // 只认「宿主启动索引里 pid 就是本进程」的 run.json：别人的 run（旧启动、另一个
    // 角色、手写伪造）在任何一轮轮询里都不能把切换提交成 applied。慢启动继续等。
    const evidence = runEvidence(dataDir, BOOT_AT_IMPORT, CHARACTER_PROFILES_ID, { expectPid: process.pid });
    if (!evidence) {
      // 本次启动窗口里出现了 run.json、但身份核不过：留一条可审计回执（只记一次），
      // 免得「明明有文件却不提交」变成无从追查的静默行为。
      if (!rejected) {
        const reason = untrustedBootEvidence(dataDir);
        if (reason) {
          rejected = true;
          log(home, { phase: 'confirm-evidence-rejected', reason, pid: process.pid });
        }
      }
      return;
    }
    // 探针用：目标 Core 已写出 run.json、但提交尚未发生的那一瞬间硬杀本进程，
    // 验证「提交前崩溃不会留下错误的 applied」。只在测试环境变量下触发。
    if (process.env.CORTICO_PROBE_CRASH_AFTER_RUNJSON === '1') {
      log(home, { phase: 'crash-after-runjson', runId: evidence.runId, pid: process.pid });
      process.kill(process.pid, 'SIGKILL');
    }
    const result = confirmApplied(botDir, { runFile: evidence.runFile, runId: evidence.runId, worldId: CHARACTER_PROFILES_ID, pid: evidence.pid });
    const done = result.action === 'applied' || result.action === 'confirmed';
    if (done) committed = true;
    log(home, { phase: done ? 'confirmed' : 'confirm-pending', why, tries, runId: evidence.runId, result, pid: process.pid });
  };
  // 不再设 20s（100 次）上限：健康但慢的启动常常晚于 20s 才写出 run.json，旧实现在这里
  // 收手（只记 confirm-timeout），随后进程正常退出、下次启动「没有退出记录」→ 把一次
  // 成功的切换当失败回滚（Codex 复现的健康慢启动被误回源）。改为一直等到见到证据或世界
  // stop()；间隔 200ms 且 unref，不拖住进程退出。
  const timer = setInterval(() => {
    tries += 1;
    if (committed) {
      stopConfirmation();
      return;
    }
    try {
      attempt('poll');
    } catch (error) {
      // 轮询里的读盘异常（如 runs/ 目录恰好被清掉）绝不能变成 uncaughtException 拖垮 Core；
      // 只记一次可审计回执，下一轮继续。
      if (!pollErrorLogged) {
        pollErrorLogged = true;
        log(home, { phase: 'confirm-poll-error', reason: String(error), pid: process.pid });
      }
    }
    if (committed) stopConfirmation();
    else if (tries === 300 && !warned) {
      warned = true;
      log(home, { phase: 'confirm-slow', tries, pid: process.pid });
    }
  }, 200);
  timer.unref?.();
  confirmTimer = timer;
}

/** 只读：给验证脚本/后续 UI 看本次启动是否已见到**可信**证据（不触发提交）。 */
export function confirmationEvidence(dataDir: string): unknown {
  return runEvidence(dataDir, BOOT_AT_IMPORT, CHARACTER_PROFILES_ID, { expectPid: process.pid });
}
