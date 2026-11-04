# 更新记录

按版本倒序。本文件只记录可核对的事实；早期条目按发布顺序排列，未逐条核对日期。

## 0.3.7 — 2026-11-04

- 新增 `src/profile-api.ts`：无 bootstrap 副作用的 `./profile-api` 导出（`PROFILE_PROTOCOL = 1`），
  提供能力协商、角色列表与快照、存储描述、人设文档读写与群聊共享、单/多人模式、
  角色租约、外观归属写回。
- 新增 `src/position-resume.ts`：多人模式结束、单宠 Core 启动后，按
  `runtime-ownership/<roleId>.position-transfer.json` 标记恢复 `rememberPosition` 开关，
  成功后删除标记，失败保留供下次重试。
- 新增 `src/native-presentation.mjs` 与类型声明：原生展示字段白名单（`skin`/`window`/
  `roam`/`selfAdjust`/`touch`/`sound`/`sounds`/`speech` 等），`captureDisplay` 带递增 revision，
  `acceptDisplay` 要求同 schema、同 roleId 且 revision 连续。
- `src/index.ts` 增加 6 行胶水：多人模式下等待（`waitForSingleMode`）与位置恢复的启停。
- `package.json` 的 `exports` 增加 `./profile-api`；`types/cortico-world.d.ts` 增加
  `cortico/core/instance-lock.ts` 的 `acquireInstanceLock` 声明。
- 已知事项：「连续两次 `World.start` 失败自动回源」逻辑仍在，但宿主自 0.2.13 起改为
  跳过启动失败的 World 并让 Core 照常启动，因此该路径在新宿主上难以复现；
  真实 Core 隔离用例中「连续两次启动失败」的三条断言不再成立（另三条通过，
  含安装树 4932 个文件哈希不变）。

## 0.3.4

- 增加必要的 role-presentation 能力：展示与原生声音字段的白名单读取、带修订写回。
- 位置记忆关闭时的移交使用 `runtime-ownership/<roleId>.position-transfer.json` 记录原开关；
  中断保留标记，下次单 Core 启动重试。不允许用超时夺取租约或恢复两个可写 Core。
- 迁移与回退按多角色交接执行：先结束多人、核对所有原生进程退出，再保留数据卸载，
  禁止直接删除角色目录。

## 0.3.3

- 接受原有合法的外置有效 `memory`/`data`，规范化物理目录并检查跨角色、跨控制目录重叠；
  快照、租约、恢复、单角色重新注册共用同一份存储描述。
- 共享文档管理与提示词编译分离：缺失引用可解除且不重建文件，保留 revision 冲突。
- 新增无 bootstrap 副作用的 `./profile-api`：能力协商、稳定角色快照、显式群聊人设共享、
  单/多人模式及角色租约、外观归属写回。
- 单角色重启在多人模式下等待；旧协调器死亡时，仅在原生角色进程均确认退出后恢复。
  没有模式文件时保持原单角色行为。

## 0.2.7

- `switchDelayMs()` 缺省 `0ms` → `400ms`：规避 `Number('') === 0` 把空配置当成「不等待」。
- `CORTICO_HOME` 读取收敛到 `env.ts`，拒绝相对路径与 `..` 段，且校验先于 `resolve`。
- 9 处类型级修正，`tsc --strict` 全绿。

## 0.2.5

- 已有相对记忆/数据目录保留原内容，并固定为所属角色的真实绝对路径；
  后台晚写不再跟随活动角色联接换向。
- 文档读写拒绝父目录联接、Windows 设备名和路径别名，避免跨角色访问。
- 新角色可直接创建人设与用户认识文档；异步保存期间继续输入仍保留为未保存草稿。
- 保存冲突可以安全另存副本；已被外部删除的文档不会被旧编辑器自动复活。
- 切换期间拒绝第二个切换及角色配置修改；重启标记写入失败时保留当前 Core 运行。
- 原生换装切换后保留来源角色的配色与服装；创建角色在存储准备完毕后才提交注册表。

## 0.2.3

- `createRole` 回滚改为「改动前快照注册表、失败原样还原」，修掉失败后把改绑走的外观
  留在错误角色上的问题。
- `runEvidence` 与确认轮询加异常兜底，避免目录被清时抛出未捕获异常拖垮 Core。
- `readLogTail` 改为定位读尾部窗口，不再整文件读入。
- 文档保存的 Git 调用加 10 秒超时与 `GIT_OPTIONAL_LOCKS=0`，超时如实上报。
- 切换事务写入改用 tmp+rename 重试，时间戳用 ISO 字符串。
- 新增 `DOC_MAX_DEPTH = 3`，读写与枚举使用同一条深度规则。
- 非字符串 `content` 原样交给校验拒绝，不再拼成空串清空文档。
- 有进行中的切换事务时拒绝新的离线切换，避免覆写成 applied。
- 「停用搁置」状态也跳过存储准备，兑现「停用不动数据」。

## 0.2.1

- 首个可用版本：多角色部署根、原生装扮点击切换、管理面板、
  三角色外观互斥、启动失败回源与恢复矩阵。
