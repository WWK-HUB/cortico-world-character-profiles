/**
 * 角色档案 — WebUI 面板客户端（预构建产物：自包含 ES module，无构建步骤）。
 *
 * 契约（宿主 web/shared/client-panel.ts）：default 导出 { panels: { <panelId>: { mount(ctx) } } }；
 * 只往 ctx.root 写 DOM；数据面走 ctx.invoke(method, args) → 服务端 panelInvoke。
 */

const TEXT = {
  zh: {
    worldLabel: '角色档案',
    currentRole: '当前角色',
    noRegistry: '还没有角色注册表：先正常启动一次伴侣，让扩展完成首次登记。',
    roles: '角色',
    colRole: '角色',
    colFigure: '绑定外观',
    colState: '状态',
    colDocs: '文档',
    colActions: '操作',
    unbound: '未绑定',
    switchTo: '切换',
    bind: '绑定外观',
    unbind: '解绑',
    docs: '人设',
    rename: '改名',
    createTitle: '创建新角色',
    createDesc: '创建一个全新角色：人设、记忆、会话、附件从空白开始；模型连接与已装扩展与当前角色共享。',
    nameLabel: '角色名字',
    figureLabel: '初始外观（可稍后绑定）',
    figureNone: '不指定',
    create: '创建角色',
    restoreOriginal: '恢复原始角色',
    confirmSwitch: (name) => `切换到「${name}」会重启伴侣，当前对话中断。继续？`,
    confirmRestore: '恢复原始角色会重启伴侣，当前对话中断。继续？',
    busySwitch: '切换已排定：伴侣正在重启，稍后自动刷新。',
    docsTitle: (name) => `${name} 的人设文档`,
    docsDesc:
      '保存立即写盘；工作区有 Git 时每次保存自动生成一个版本（面板内可看到提交号）。' +
      '生效时机：模型在「新会话/新对话」或重载系统前缀后读到最新人设（控制台配置区提供前缀重载入口）；当前进行中的对话不会中途更换。',
    personaEntry: '人设（CONSTITUTION.md）',
    partnerEntry: '用户认识（PARTNER.md）',
    personaDesc: '这两份文件进模型系统前缀；其余 Markdown 是普通笔记，按需用文件工具读写。',
    newDoc: '新建文档',
    save: '保存',
    back: '返回列表',
    docNameLabel: '文件名（.md / .txt，可用子目录如 notes/trip.md）',
    confirmLeave: '文档有未保存的改动，离开将丢失。确定丢弃草稿并离开？',
    stayTitle: '未保存的改动',
    renamePrompt: (current) => `「${current}」的新名字`,
    journalTitle: '切换事务',
    journalDesc: '当前切换状态与原因。出错时这里给出解释与恢复入口。',
    statusLabel: '状态',
    errorLabel: '原因',
    pointerLabel: '指针',
    clearError: '清除错误记录',
    intentAmbiguous: '登记时两端数据内容不一致（register-ambiguous）：扩展已保留两端并跳过登记，需要人工判定。未删除任何数据。',
    orphans: (ids) => `磁盘上存在不在注册表里的角色目录：${ids.join('、')}。它们不会被自动改动。`,
    logTail: '扩展日志（最近 8 条）',
    empty: '（无）',
    refresh: '刷新',
    conflictTitle: '保存冲突',
    reloadLatest: '载入磁盘最新内容',
    saveAsCopy: '另存为副本',
    stealConfirm: (figure, owner) => `外观「${figure}」已绑定给「${owner}」。改绑会解除原绑定（原角色不再被这个外观触发）。继续改绑？`,
    wornConfirm: (figure) =>
      `外观「${figure}」正被当前角色穿着：绑定后点击装扮页的它不会触发切换。要「绑定并立即切换」吗？（取消则仅绑定，稍后可用「切换」按钮）`,
    bindSwitchOk: '已绑定并排定切换：伴侣正在重启，稍后自动刷新。',
    docConflictNote: (name) => `「${name}」在你读取后被别人修改过（冲突）。磁盘内容未覆盖；可载入最新内容合并，或另存为副本。`,
    docNeedsRevision: (name) => `「${name}」已存在。为防止覆盖别人的修改，请先在列表里打开它再保存，或另存为副本。`,
  },
};

const T = (key, ...args) => {
  const table = TEXT.zh;
  const value = table[key];
  return typeof value === 'function' ? value(...args) : value ?? key;
};

const STATUS_TEXT = {
  prepared: '已排定，等待伴侣重启生效',
  repointed: '已指向目标角色，等待目标启动确认',
  applied: '已生效（当前角色即切换目标）',
  reverted: '已回滚到源角色',
  failed: '切换失败',
  blocked: '被阻塞（目标不完整或部署被占用）',
  'blocked-disabled': '扩展停用期间：未提交的目标不切换，已恢复源角色',
  'disabled-pending': '扩展已停用：有未完成的切换被搁置',
};

function figureLabel(f) {
  return f && f.name && f.name !== f.id ? `${f.name}（${f.id}）` : String(f?.id ?? '');
}

/** 绑定外观抽屉：下拉选（figures 可用时）+ 手输兜底；冲突/穿着歧义在这里收口。 */
function openBindDrawer(ctx, role, figures, lastState, onDone, beforeSwitch = async () => true) {
  const ui = ctx.ui;
  const pick = ui.input({ value: role.figure ?? '', placeholder: 'figure id' });
  const holder = ui.h('div');
  if (figures.length) {
    const sel = ui.select({ options: figures.map((f) => ({ value: f.id, label: figureLabel(f) })) });
    sel.value = role.figure ?? '';
    sel.addEventListener('change', () => { pick.value = sel.value; });
    holder.appendChild(ui.field(T('figureLabel'), sel));
  }
  holder.appendChild(ui.field('figure id', pick));
  const bar = ui.rowbar();
  bar.appendChild(ui.button(T('bind'), {
    variant: 'primary', size: 'sm',
    onClick: async () => {
      const figure = pick.value.trim();
      if (!figure) { ui.toast('外观 id 不能为空', 'bad'); return; }
      try {
        // 客户端先按面板状态预判两类需要确认的情形（服务端仍会复核并返回结构化冲突）。
        const activeRole = (lastState?.roles ?? []).find((r) => r.active);
        const owner = (lastState?.roles ?? []).find((r) => r.id !== role.id && r.figure === figure);
        let allowSteal = false;
        if (owner) {
          if (!(await ui.confirm({ title: T('bind'), body: T('stealConfirm', figure, owner.label || owner.id) }))) return;
          allowSteal = true;
        }
        const wornByActive = activeRole && activeRole.id !== role.id && activeRole.configFigure === figure;
        let switchNow = false;
        if (wornByActive && await ui.confirm({ title: '绑定并切换', body: T('wornConfirm', figure) })) {
          if (!(await beforeSwitch())) return;
          switchNow = true;
        }
        const result = await ctx.invoke('bindFigure', [{ id: role.id, figure, allowSteal, switchNow }]);
        if (!result.ok && result.conflict === 'figure-owned') {
          // 预判与磁盘状态竞速：按服务端结构化冲突再确认一次。
          if (!(await ui.confirm({ title: T('bind'), body: result.detail }))) { onDone(); return; }
          const retry = await ctx.invoke('bindFigure', [{ id: role.id, figure, allowSteal: true, switchNow }]);
          ui.toast(retry.detail ?? '', retry.ok ? 'ok' : 'bad');
          if (retry.ok && retry.scheduled) ui.toast(T('bindSwitchOk'), 'ok');
          if (retry.ok) { drawer.dispose(); onDone(); }
          return;
        }
        ui.toast(result.detail ?? '', result.ok ? 'ok' : 'bad');
        if (result.ok && result.scheduled) ui.toast(T('bindSwitchOk'), 'ok');
        if (result.ok) { drawer.dispose(); onDone(); }
      } catch (err) { ui.toast(String(err.message ?? err), 'bad'); }
    },
  }));
  holder.appendChild(bar);
  const drawer = ui.drawer(`${T('bind')}：${role.label}`, holder);
  return drawer;
}

function openRenameDrawer(ctx, role, onDone) {
  const ui = ctx.ui;
  const input = ui.input({ value: role.label });
  const holder = ui.h('div');
  holder.appendChild(ui.field(T('renamePrompt', role.label), input));
  const bar = ui.rowbar();
  bar.appendChild(ui.button(T('rename'), {
    variant: 'primary', size: 'sm',
    onClick: async () => {
      try {
        const result = await ctx.invoke('rename', [{ id: role.id, label: input.value.trim() }]);
        ui.toast(result.detail ?? '', result.ok ? 'ok' : 'bad');
        if (result.ok) { drawer.dispose(); onDone(); }
      } catch (err) { ui.toast(String(err.message ?? err), 'bad'); }
    },
  }));
  holder.appendChild(bar);
  const drawer = ui.drawer(T('rename'), holder);
}

/** 面板：profiles —— 角色清单与管理。 */
const profilesPanel = {
  mount(ctx) {
    const ui = ctx.ui;
    const root = ctx.root;
    let figures = [];
    let lastState = null;
    /** 当前打开的编辑器（R7：唯一 dirty 事实来源）；null = 不在编辑器里。 */
    let editor = null;
    /** 文档列表视图也占住 docSheet：否则 4s 轮询 refresh 会把列表藏掉（UI 闭环实测抓到）。 */
    let docsView = false;
    let viewRequest = 0;
    async function beforeSwitch() {
      if (editor?.saving) { ui.toast('保存尚未完成，请稍后再切换角色。', 'bad'); return false; }
      if (editor && editor.area.value !== editor.saved) return ui.confirm({ title: T('stayTitle'), body: T('confirmLeave') });
      return true;
    }

    const head = ui.sheet({ title: T('worldLabel'), desc: '创建角色、编辑人设、绑定外观；在原生装扮页点击已绑定的外观即切换完整角色。未绑定的外观与同一外观的配色、服装变化只执行普通换装。' });
    const currentLine = ui.msgline();
    head.body.appendChild(currentLine);
    const restoreBar = ui.rowbar();
    restoreBar.appendChild(ui.button(T('restoreOriginal'), {
      variant: 'danger', size: 'sm',
      onClick: async () => {
        if (!(await ui.confirm({ title: T('restoreOriginal'), body: T('confirmRestore'), danger: true }))) return;
        if (!(await beforeSwitch())) return;
        try {
          const result = await ctx.invoke('restoreOriginal');
          ui.toast(result.detail ?? '', result.ok ? 'ok' : 'bad');
          if (result.ok) ui.toast(T('busySwitch'), 'ok');
          refresh();
        } catch (err) { ui.toast(String(err.message ?? err), 'bad'); }
      },
    }));
    head.body.appendChild(restoreBar);
    root.appendChild(head.el);

    const listSheet = ui.sheet({ title: T('roles') });
    const listBox = ui.h('div');
    listSheet.body.appendChild(listBox);
    root.appendChild(listSheet.el);

    const createSheet = ui.sheet({ title: T('createTitle'), desc: T('createDesc') });
    const nameInput = ui.input({ placeholder: T('nameLabel') });
    const figureSelect = ui.select({ options: [] });
    const createMsg = ui.msgline();
    createSheet.body.appendChild(ui.field(T('nameLabel'), nameInput));
    createSheet.body.appendChild(ui.field(T('figureLabel'), figureSelect));
    const createBar = ui.rowbar();
    createBar.appendChild(ui.button(T('create'), {
      variant: 'primary', size: 'md',
      onClick: async () => {
        const label = nameInput.value.trim();
        if (!label) { createMsg.textContent = T('nameLabel'); createMsg.classList.add('bad'); return; }
        createMsg.classList.remove('bad');
        createMsg.textContent = '…';
        try {
          let result = await ctx.invoke('create', [{ label, figure: figureSelect.value || null, allowSteal: false }]);
          // 初始外观已被占用：确认后带 allowSteal 重试（R3 的第三入口）。
          if (!result.ok && result.conflict === 'figure-owned') {
            if (!(await ui.confirm({ title: T('createTitle'), body: result.detail }))) {
              createMsg.textContent = '已取消：请换一个初始外观。';
              return;
            }
            result = await ctx.invoke('create', [{ label, figure: figureSelect.value || null, allowSteal: true }]);
          }
          createMsg.textContent = result.detail ?? (result.ok ? '已创建' : '创建失败');
          if (!result.ok) createMsg.classList.add('bad'); else { nameInput.value = ''; refresh(); }
        } catch (err) {
          createMsg.classList.add('bad');
          createMsg.textContent = String(err.message ?? err);
        }
      },
    }));
    createSheet.body.appendChild(createBar);
    createSheet.body.appendChild(createMsg);
    root.appendChild(createSheet.el);

    const docSheet = ui.sheet({ title: '人设与笔记', desc: T('docsDesc') });
    const docBox = ui.h('div');
    docSheet.body.appendChild(docBox);
    docSheet.el.style.display = 'none';
    root.appendChild(docSheet.el);

    async function loadFigures() {
      try {
        const data = await ctx.invoke('figures');
        figures = Array.isArray(data?.figures) ? data.figures : [];
        figureSelect.innerHTML = '';
        const none = ui.h('option', null, T('figureNone'));
        none.value = '';
        figureSelect.appendChild(none);
        for (const f of figures) {
          const opt = ui.h('option', null, figureLabel(f));
          opt.value = f.id;
          figureSelect.appendChild(opt);
        }
      } catch { /* 下拉留空 */ }
    }

    function roleActions(role) {
      const bar = ui.rowbar();
      bar.appendChild(ui.button(T('switchTo'), { size: 'sm', onClick: async () => {
        if (!(await ui.confirm({ title: T('switchTo'), body: T('confirmSwitch', role.label) }))) return;
        if (!(await beforeSwitch())) return;
        try {
          const result = await ctx.invoke('switchTo', [{ id: role.id }]);
          ui.toast(result.detail ?? '', result.ok ? 'ok' : 'bad');
          if (result.ok) ui.toast(T('busySwitch'), 'ok');
        } catch (err) { ui.toast(String(err.message ?? err), 'bad'); }
      } }));
      bar.appendChild(ui.button(T('bind'), { size: 'sm', onClick: () => openBindDrawer(ctx, role, figures, lastState, refresh, beforeSwitch) }));
      bar.appendChild(ui.button(T('unbind'), { size: 'sm', variant: 'danger', onClick: async () => {
        if (!(await ui.confirm({ title: T('unbind'), body: '只解除「点击外观切换」的映射；角色档案与外观都保留。' }))) return;
        try {
          const result = await ctx.invoke('unbindFigure', [{ id: role.id }]);
          ui.toast(result.detail ?? '', result.ok ? 'ok' : 'bad');
          refresh();
        } catch (err) { ui.toast(String(err.message ?? err), 'bad'); }
      } }));
      bar.appendChild(ui.button(T('docs'), { size: 'sm', onClick: () => openDocs(role) }));
      bar.appendChild(ui.button(T('rename'), { size: 'sm', onClick: () => openRenameDrawer(ctx, role, refresh) }));
      return bar;
    }

    function renderRoles(state) {
      listBox.replaceChildren();
      if (!state.roles.length) {
        listBox.appendChild(ui.placeholder(T('noRegistry')));
        currentLine.textContent = state.lamp ? state.lamp.hint : '';
        return;
      }
      const table = ui.table({ head: [T('colRole'), T('colFigure'), T('colState'), T('colDocs'), T('colActions')] });
      for (const role of state.roles) {
        const row = table.addRow([
          role.label,
          role.figure ?? T('unbound'),
          role.active ? '●' : '·',
          String(role.docs),
          { el: roleActions(role) },
        ]);
        table.body.appendChild(row);
      }
      listBox.appendChild(table.el);
      if (state.orphans?.length) listBox.appendChild(ui.msgline(T('orphans', state.orphans), true));
      const activeRole = state.roles.find((r) => r.active);
      currentLine.textContent = `${T('currentRole')}：${activeRole ? activeRole.label : T('empty')}${state.lamp ? ` — ${state.lamp.hint}` : ''}`;
    }

    async function refresh() {
      try {
        const state = await ctx.invoke('state');
        lastState = state;
        if (!editor && !docsView) { docSheet.el.style.display = 'none'; }
        renderRoles(state);
      } catch (err) {
        listBox.replaceChildren(ui.placeholder(String(err.message ?? err)));
      }
    }

    /** R7：离开编辑器的唯一出口——dirty 确认；取消则留在编辑器，确认才丢弃草稿。 */
    async function leaveEditor(then) {
      if (editor?.saving) { ui.toast('保存尚未完成，请稍后再离开。', 'bad'); return; }
      if (editor && editor.area.value !== editor.saved) {
        const discard = await ui.confirm({ title: T('stayTitle'), body: T('confirmLeave') });
        if (!discard) return;
      }
      editor = null;
      viewRequest += 1;
      docSheet.el.style.display = 'none';
      refresh();
      if (then) then();
    }

    async function openDocs(role) {
      // 已在别的编辑器里：走统一 dirty 检查再进列表。
      if (editor) { await leaveEditor(() => openDocs(role)); return; }
      editor = null;
      docsView = true;
      const request = ++viewRequest;
      docSheet.el.style.display = '';
      docBox.replaceChildren();
      docBox.appendChild(ui.msgline(T('docsTitle', role.label)));
      const backBar = ui.rowbar();
      backBar.appendChild(ui.button(T('back'), { size: 'sm', onClick: () => { viewRequest += 1; editor = null; docsView = false; docSheet.el.style.display = 'none'; refresh(); } }));
      backBar.appendChild(ui.button(T('newDoc'), { size: 'sm', onClick: () => showEditor(role, null) }));
      docBox.appendChild(backBar);
      try {
        const data = await ctx.invoke('listDocs', [{ id: role.id }]);
        if (request !== viewRequest) return;
        if (!data?.ok) { docBox.appendChild(ui.msgline(data?.detail ?? '无法读取文档列表', true)); return; }
        const docs = data?.docs ?? [];
        // 改进：人设/用户认识专用入口（不要求用户猜文件名），与普通笔记分开。
        const personaBar = ui.rowbar();
        personaBar.appendChild(ui.button(T('personaEntry'), { size: 'sm', variant: 'primary', onClick: () => showEditor(role, 'CONSTITUTION.md', true) }));
        personaBar.appendChild(ui.button(T('partnerEntry'), { size: 'sm', onClick: () => showEditor(role, 'PARTNER.md', true) }));
        docBox.appendChild(personaBar);
        docBox.appendChild(ui.msgline(T('personaDesc')));
        if (!docs.length) {
          docBox.appendChild(ui.placeholder('（还没有其他文档）'));
          return;
        }
        const table = ui.table({ head: ['文件', '大小', '更新于', ''] });
        for (const doc of docs) {
          const row = table.addRow([doc.name, String(doc.bytes), doc.updatedAt.slice(0, 19).replace('T', ' ')]);
          const bar = ui.rowbar();
          bar.appendChild(ui.button('编辑', { size: 'sm', onClick: () => showEditor(role, doc.name) }));
          row.appendChild(bar);
          table.body.appendChild(row);
        }
        docBox.appendChild(table.el);
      } catch (err) {
        if (request !== viewRequest) return;
        docBox.appendChild(ui.msgline(String(err.message ?? err), true));
      }
    }

    async function showEditor(role, name, createMissing = false) {
      if (editor) { await leaveEditor(() => showEditor(role, name, createMissing)); return; }
      const request = ++viewRequest;
      let content = '';
      let revision;
      if (name) {
        try {
          const data = await ctx.invoke('readDoc', [{ id: role.id, name }]);
          if (request !== viewRequest) return;
          if (!data?.ok && !(createMissing && data?.missing === true)) { ui.toast(data?.detail ?? '读不到文档', 'bad'); return; }
          content = data.content ?? '';
          revision = data.revision;
        } catch (err) { if (request === viewRequest) ui.toast(String(err.message ?? err), 'bad'); return; }
      }
      const current = { role, name, saved: content, revision, area: null, saving: false };
      editor = current;
      docsView = false;
      docSheet.el.style.display = '';
      docBox.replaceChildren();
      docBox.appendChild(ui.msgline(T('docsTitle', role.label)));
      const nameInput2 = ui.input({ value: name ?? '', placeholder: T('docNameLabel'), disabled: Boolean(name) });
      const area = ui.textarea({ rows: 14, value: content });
      current.area = area;
      const msg = ui.msgline();
      const conflictBar = ui.rowbar();
      conflictBar.style.display = 'none';
      /** 冲突后的两个出路：载入最新内容（丢弃本地草稿）或另存为副本（保留草稿）。 */
      async function reloadLatest() {
        if (editor !== current || current.saving) return;
        if (!(await ui.confirm({ title: T('reloadLatest'), body: '载入磁盘最新内容会丢弃当前草稿。继续？' }))) return;
        if (editor !== current || current.saving) return;
        current.saving = true;
        area.disabled = true;
        const docName = nameInput2.value.trim();
        try {
          const data = await ctx.invoke('readDoc', [{ id: role.id, name: docName }]);
          if (editor !== current) return;
          if (!data?.ok) { ui.toast(data?.detail ?? '读不到文档', 'bad'); return; }
          area.value = data.content ?? '';
          current.saved = area.value;
          current.revision = data.revision;
          conflictBar.style.display = 'none';
          msg.classList.remove('bad');
          msg.textContent = '已载入磁盘最新内容（本地草稿已替换）。';
        } catch (err) { ui.toast(String(err.message ?? err), 'bad'); }
        finally { current.saving = false; area.disabled = false; }
      }
      async function saveAsCopy() {
        if (editor !== current || current.saving) return;
        const base = (nameInput2.value.trim() || '未命名.md').replace(/\.(md|txt)$/i, '');
        const ext = /\.txt$/i.test(nameInput2.value.trim()) ? '.txt' : '.md';
        const copyName = `${base}-副本-${new Date().toISOString().replace(/[:T.Z-]/g, '')}${ext}`;
        await save(copyName, true);
      }
      conflictBar.appendChild(ui.button(T('reloadLatest'), { size: 'sm', onClick: reloadLatest }));
      conflictBar.appendChild(ui.button(T('saveAsCopy'), { size: 'sm', onClick: saveAsCopy }));
      const bar = ui.rowbar();
      bar.appendChild(ui.button(T('back'), { size: 'sm', onClick: () => leaveEditor(() => openDocs(role)) }));
      async function save(copyName, asCopy = false) {
        if (editor !== current || current.saving) return;
        const docName = asCopy ? copyName : nameInput2.value.trim();
        if (!docName) { msg.textContent = T('docNameLabel'); msg.classList.add('bad'); return; }
        const sentContent = area.value;
        current.saving = true;
        nameInput2.disabled = true;
        saveButton.disabled = true;
        try {
          const payload = { id: role.id, name: docName, content: sentContent };
          if (!asCopy && current.revision) payload.baseRevision = current.revision;
          const result = await ctx.invoke('writeDoc', [payload]);
          if (editor !== current) return;
          msg.classList.remove('bad');
          msg.textContent = result.detail ?? '';
          if (!result.ok) {
            msg.classList.add('bad');
            if (result.conflict && current.revision) {
              // 打开之后被别人改过：结构化冲突，给「载入最新 / 另存副本」两条出路。
              ui.toast(T('docConflictNote', docName), 'bad');
              conflictBar.style.display = '';
            } else if (result.conflict) {
              // 新建同名文件被拒（R2：不默认覆盖已存在内容）。
              ui.toast(T('docNeedsRevision', docName), 'bad');
              conflictBar.style.display = '';
            }
            return;
          }
          // 保存成功：dirty 基线更新为刚保存的内容，revision 换成服务端指纹。
          current.saved = sentContent;
          current.revision = result.revision;
          current.name = docName;
          nameInput2.value = docName;
          conflictBar.style.display = 'none';
        } catch (err) { msg.classList.add('bad'); msg.textContent = String(err.message ?? err); }
        finally {
          current.saving = false;
          saveButton.disabled = false;
          nameInput2.disabled = Boolean(current.name);
        }
      }
      const saveButton = ui.button(T('save'), {
        variant: 'primary', size: 'sm',
        onClick: () => save(),
      });
      bar.appendChild(saveButton);
      docBox.appendChild(ui.field(T('docNameLabel'), nameInput2));
      docBox.appendChild(area);
      docBox.appendChild(bar);
      docBox.appendChild(conflictBar);
      docBox.appendChild(msg);
    }

    // R7：整个面板只挂一个 guard，返回值由「是否真的在编辑器里有未保存草稿」决定——
    // 离开编辑器后自然不再拦截（旧实现对废弃表单的 guard 不释放，会虚假拦截）。
    ctx.guardLeave(() => editor?.saving ? '保存尚未完成，离开可能无法看到保存结果。' : (editor && editor.area && editor.area.value !== editor.saved ? T('confirmLeave') : null));

    ctx.interval(() => { if (!editor) refresh(); }, 4000);
    loadFigures().then(() => { if (lastState) renderRoles(lastState); });
    refresh();
  },
};

/** 面板：switch-state —— 切换事务与错误说明。 */
const switchStatePanel = {
  mount(ctx) {
    const ui = ctx.ui;
    const root = ctx.root;
    const sheet = ui.sheet({ title: T('journalTitle'), desc: T('journalDesc') });
    const box = ui.h('div');
    sheet.body.appendChild(box);
    root.appendChild(sheet.el);

    function explain(state) {
      const lines = [];
      const journal = state.journal;
      if (state.pending) {
        lines.push(`进行中：${state.pending.from ?? '-'} → ${state.pending.to}（${STATUS_TEXT[state.pending.status] ?? state.pending.status}）`);
      } else if (journal) {
        lines.push(STATUS_TEXT[journal.status] ?? journal.status);
      } else {
        lines.push('没有切换事务记录。');
      }
      if (journal?.error) lines.push(`原因：${journal.error}`);
      if (journal?.bootFailures) lines.push(`连续启动失败：${journal.bootFailures} 次（到 2 次会自动回源）`);
      if (state.intent?.stage === 'ambiguous') lines.push(T('intentAmbiguous'));
      return lines;
    }

    async function refresh() {
      try {
        const state = await ctx.invoke('state');
        box.replaceChildren();
        box.appendChild(ui.kv([
          { k: T('statusLabel'), v: state.journal?.status ?? T('empty') },
          { k: T('pointerLabel'), v: state.pointer ?? T('empty') },
          { k: T('currentRole'), v: state.active ?? T('empty') },
        ]));
        const bad = state.journal && ['reverted', 'failed', 'blocked'].includes(state.journal.status);
        const explainLine = ui.msgline(explain(state).join('\n'), Boolean(bad));
        box.appendChild(explainLine);
        const bar = ui.rowbar();
        bar.appendChild(ui.button(T('refresh'), { size: 'sm', onClick: () => refresh() }));
        if (state.journal?.error && !state.pending) {
          bar.appendChild(ui.button(T('clearError'), { size: 'sm', onClick: async () => {
            try {
              const result = await ctx.invoke('clearError');
              ui.toast(result.detail ?? '', result.ok ? 'ok' : 'bad');
              refresh();
            } catch (err) { ui.toast(String(err.message ?? err), 'bad'); }
          } }));
        }
        if (state.hasOriginal && state.active !== (state.originalRoleId || 'original')) {
          bar.appendChild(ui.button(T('restoreOriginal'), { variant: 'danger', size: 'sm', onClick: async () => {
            if (!(await ui.confirm({ title: T('restoreOriginal'), body: T('confirmRestore'), danger: true }))) return;
            try {
              const result = await ctx.invoke('restoreOriginal');
              ui.toast(result.detail ?? '', result.ok ? 'ok' : 'bad');
              if (result.ok) ui.toast(T('busySwitch'), 'ok');
              refresh();
            } catch (err) { ui.toast(String(err.message ?? err), 'bad'); }
          } }));
        }
        box.appendChild(bar);
        if (state.logTail?.length) {
          const log = ui.log({ maxHeight: '180px', empty: '' });
          for (const line of state.logTail) {
            let entry = line;
            try {
              const parsed = JSON.parse(line);
              entry = `${String(parsed.at ?? '').slice(11, 19)} ${parsed.phase ?? ''}${parsed.result?.action ? ` ${parsed.result.action}` : ''}${parsed.result?.detail ? ` — ${parsed.result.detail}` : ''}${parsed.error ? ` ${parsed.error}` : ''}`;
            } catch { /* 原样显示 */ }
            log.append(entry, 'dim');
          }
          const logSheet = ui.foldSheet('cp-log-tail', { title: T('logTail'), defaultOpen: false });
          logSheet.body.appendChild(log.el);
          box.appendChild(logSheet.el);
        }
      } catch (err) {
        box.replaceChildren(ui.placeholder(String(err.message ?? err)));
      }
    }

    ctx.interval(() => refresh(), 3000);
    refresh();
  },
};

export default {
  panels: {
    profiles: profilesPanel,
    'switch-state': switchStatePanel,
  },
};
