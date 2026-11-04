/**
 * `cortico/world` 的最小类型桩——按宿主 0.2.9 构建源
 * 宿主 build/cortico/src/{world.ts,core/types.ts} 中
 * 本扩展实际用到的形状重建。仅供 `tsc --noEmit` 静态检查；运行时由宿主的
 * registerFrameworkResolver 把 `cortico/<path>` 映射到框架 `src/<path>`，类型桩不参与加载。
 *
 * 世界配置项用 webUi().config 的 ConfigGroup 声明（0.2.9 契约），见 panelConfigGroups()。
 */
declare module 'cortico/world' {
  export interface WorldSection {
    enabled: boolean;
  }

  export interface WorldContext<S extends WorldSection = WorldSection> {
    readonly id: string;
    /** worlds.<id> 的共享引用；每次读取的配置立即生效，构造时保存的值需重启实例。 */
    readonly cfg: S;
    readonly timezone: string;
    readonly botName: string;
    /** 部署目录（活动部署根，可能是联接路径）。 */
    readonly botDir: string;
    /** bot 代码包目录。 */
    readonly packageDir: string;
    /** 原生按 config.paths.data 解析出的 effective data 目录（含自定义/外部路径）。 */
    readonly dataDir: string;
    readonly repoRoot: string;
    secret(name: string): string;
    storeSecret(name: string, value: string): void;
    restart(): Promise<void>;
  }

  export interface WorldToolSpec {
    name: string;
    tags?: string[];
    description: string;
    inputSchema: Record<string, unknown>;
    run(input: Record<string, unknown>): unknown | Promise<unknown>;
  }

  /** World 实例：本扩展只用到 id / envPromptVars / tools / webUi / start / stop。 */
  export interface World {
    id: string;
    envPromptVars(): Record<string, string> | null | Promise<Record<string, string> | null>;
    tools(): WorldToolSpec[];
    /** 世界页声明：状态灯、徽章、面板、数据面与配置组（见宿主 core/types.ts WorldWebUiDecl）。 */
    webUi?(language?: string): WorldWebUiDecl;
    start(host: WorldHost): Promise<void>;
    stop(): Promise<void>;
  }

  export interface WorldLamp {
    label: string;
    state: 'online' | 'offline' | 'loading' | 'error';
    hint: string;
  }

  export interface WorldBadge {
    label: string;
    value: string | number;
    tone?: 'on' | 'off' | 'plain';
  }

  export interface WorldPanelDecl {
    id: string;
    title: string;
    description?: string;
    /** 允许经 HTTP GET 调用的方法；省略时本面板只接受 POST。 */
    getMethods?: readonly string[];
  }

  /** 配置组：JSON Schema 声明，WebUI 通用渲染（见宿主 core/config-schema.ts）。 */
  export interface ConfigGroup {
    id: string;
    owner: 'core' | 'persona' | `world:${string}` | `provider:${string}`;
    schema: {
      type: 'object';
      title: string;
      description?: string;
      properties: Record<string, Record<string, unknown>>;
    };
  }

  export interface WorldWebUiDecl {
    label?: string;
    lamps?: WorldLamp[];
    badges?: WorldBadge[];
    panels?: WorldPanelDecl[];
    invoke?(panel: string, method: string, args: unknown[]): Promise<unknown>;
    config?: ConfigGroup[];
    links?: Array<{ label: string; href: string; inheritTheme?: boolean }>;
  }

  /** 宿主句柄；本扩展的 start() 不消费它。 */
  export interface WorldHost {
    readonly [key: string]: unknown;
  }

  export interface WorldDefinition<S extends WorldSection = WorldSection> {
    id: string;
    label: string;
    defaults(): S;
    /** 0.2.9 期望 (kind, language) => {value,label}[]；见文件头契约差异说明。 */
    configOptions?(...args: unknown[]): Array<Record<string, unknown>>;
    create(ctx: WorldContext<S>): World;
  }
}

/** 宿主框架的路径模块（panel.ts 动态导入 repoRoot 定位应用根；真实 Core 里由解析器映射）。 */
declare module 'cortico/paths.ts' {
  export function repoRoot(): string;
}

/** API 6 exported native data lock; used for recovery mutex and stale-owner validation. */
declare module 'cortico/core/instance-lock.ts' {
  export function acquireInstanceLock(dataDir: string): { readonly owns: boolean; release(): void };
}
