/**
 * dsh-task Browser half。
 *
 * 列表页：顶部「+ 新建定时任务」长按钮 + 任务卡片（描述 / 状态 / CRON /
 * 提示词截断 / 上次执行时间 + 日志·删除）；新建与编辑共用一个弹窗（样式对齐
 * 官方 Modal：bg-layer-2 卡面 + bg-mask-1 遮罩）；日志为独立整页（时间倒序）。
 * 任务 id 用 UUID 自动生成，不展示。
 *
 * 所有颜色都走 DSH 主题 token（--dsw-alias-*），因此浅色/深色主题都正确。
 */
window.__ModuleLoader__.load({
  id: 'dsh-task',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState } = React
    const NS = 'dsh-task'

    const OVERLAPS = ['skip', 'allow', 'queue']
    const PROMPT_LIMIT = 50

    const style = {
      page: { display: 'flex', flexDirection: 'column', gap: '12px' },
      bar: { display: 'flex', gap: '8px', alignItems: 'center' },
      bigButton: { width: '100%', padding: '13px 16px', borderRadius: '10px', border: '1px dashed var(--dsw-alias-border-l2)', background: 'transparent', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer', fontSize: '14px', fontFamily: 'inherit' },
      card: { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '10px', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '8px', cursor: 'pointer', background: 'var(--dsw-alias-bg-layer-1)' },
      cardHead: { display: 'flex', gap: '8px', alignItems: 'center', justifyContent: 'space-between' },
      cardTitle: { fontSize: '15px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      tag: { padding: '2px 9px', borderRadius: '10px', fontSize: '11px', lineHeight: '18px', flex: '0 0 auto' },
      tagOn: { background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-state-success-primary)' },
      tagOff: { background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-secondary)' },
      cardCron: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', fontFamily: 'Consolas, monospace' },
      cardPrompt: { fontSize: '12.5px', color: 'var(--dsw-alias-label-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      cardFoot: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' },
      last: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      acts: { display: 'flex', gap: '8px', flex: '0 0 auto' },
      // 卡片三按钮：调试与日志同一款中性描边，删除用红色描边
      button: { display: 'inline-flex', alignItems: 'center', gap: '5px', padding: '5px 12px', borderRadius: '8px', fontSize: '12.5px', fontFamily: 'inherit', cursor: 'pointer', background: 'var(--dsw-alias-interactive-bg-hover)', color: 'var(--dsw-alias-label-primary)', border: '1px solid var(--dsw-alias-border-l4)' },
      logBtn: { display: 'inline-flex', alignItems: 'center', gap: '5px', padding: '5px 12px', borderRadius: '8px', fontSize: '12.5px', fontFamily: 'inherit', cursor: 'pointer', background: 'transparent', color: 'var(--dsw-alias-label-primary)', border: '1px solid var(--dsw-alias-border-l4)' },
      dangerBtn: { display: 'inline-flex', alignItems: 'center', gap: '5px', padding: '5px 12px', borderRadius: '8px', fontSize: '12.5px', fontFamily: 'inherit', cursor: 'pointer', background: 'transparent', color: 'var(--dsw-alias-state-error-primary)', border: '1px solid var(--dsw-alias-border-l4)' },
      // 弹窗：结构对齐官方 Modal（fixed 居中根 + 绝对遮罩 + 相对卡面）
      modalRoot: { position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' },
      modalMask: { position: 'absolute', inset: 0, background: 'var(--dsw-alias-bg-mask-1)', backdropFilter: 'var(--dsw-mask-blur)' },
      dialog: { position: 'relative', zIndex: 1, width: 'min(580px, 100%)', maxHeight: '88vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', background: 'var(--dsw-alias-bg-layer-2)', borderRadius: '24px', paddingBottom: '24px', boxShadow: 'var(--dsw-elevation-prominent)' },
      dlgHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', padding: '22px 14px 12px 24px' },
      dlgTitle: { margin: 0, fontSize: '16px', lineHeight: '24px', fontWeight: 500, color: 'var(--dsw-alias-label-primary)' },
      close: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '28px', height: '28px', border: 'none', borderRadius: '8px', background: 'transparent', cursor: 'pointer', color: 'var(--dsw-alias-label-secondary)', fontSize: '15px', fontFamily: 'inherit' },
      dlgBody: { display: 'flex', flexDirection: 'column', gap: '13px', padding: '0 24px' },
      field: { display: 'flex', flexDirection: 'column', gap: '6px' },
      flabel: { fontSize: '12.5px', color: 'var(--dsw-alias-label-secondary)' },
      input: { boxSizing: 'border-box', width: '100%', padding: '7px 10px', borderRadius: '8px', border: '0.5px solid var(--dsw-alias-border-l4)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', fontSize: '13.5px', fontFamily: 'inherit' },
      check: { display: 'flex', gap: '8px', alignItems: 'center', fontSize: '13px', color: 'var(--dsw-alias-label-primary)' },
      dlgFoot: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '8px', padding: '20px 24px 0' },
      primary: { border: 'none', borderRadius: '8px', padding: '8px 22px', background: 'var(--dsw-alias-button-primary-fill)', color: 'var(--dsw-alias-label-primary-foreground)', cursor: 'pointer', fontSize: '13.5px', fontFamily: 'inherit' },
      ghost: { border: '0.5px solid var(--dsw-alias-border-l4)', borderRadius: '8px', padding: '8px 22px', background: 'transparent', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer', fontSize: '13.5px', fontFamily: 'inherit' },
      error: { color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px' },
      ok: { color: 'var(--dsw-alias-state-success-primary)', fontSize: '12px' },
      hint: { color: 'var(--dsw-alias-label-secondary)', fontSize: '13px' },
      // 日志页
      pageHead: { display: 'flex', alignItems: 'center', gap: '6px' },
      back: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '28px', height: '28px', borderRadius: '8px', border: 'none', background: 'transparent', color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer', fontSize: '16px', fontFamily: 'inherit' },
      pageTitle: { fontSize: '17px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      count: { marginLeft: 'auto', fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' },
      logCard: { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '10px', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '9px', background: 'var(--dsw-alias-bg-layer-1)' },
      logHead: { display: 'flex', alignItems: 'center', gap: '10px' },
      logTime: { fontSize: '13px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)', fontFamily: 'Consolas, monospace' },
      logStatus: { fontSize: '11px', padding: '1px 8px', borderRadius: '10px', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-state-success-primary)', flex: '0 0 auto' },
      logStatusErr: { color: 'var(--dsw-alias-state-error-primary)' },
      logDur: { marginLeft: 'auto', fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' },
      // 日志区块标签：彩色小标签（Pill）
      blockK: { display: 'inline-block', width: 'fit-content', padding: '2px 9px', borderRadius: '6px', fontSize: '11px', fontWeight: 600, background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 13%, transparent)', color: 'var(--dsw-alias-label-secondary)' },
      blockKReply: { background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 16%, transparent)', color: 'var(--dsw-alias-state-success-primary)' },
      blockKErr: { background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 16%, transparent)', color: 'var(--dsw-alias-state-error-primary)' },
      promptBox: { fontSize: '12.5px', color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.55, whiteSpace: 'pre-wrap' },
      resultText: { fontSize: '12.5px', color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.55, whiteSpace: 'pre-wrap' },
      errText: { fontSize: '12.5px', color: 'var(--dsw-alias-state-error-primary)', lineHeight: 1.55, whiteSpace: 'pre-wrap' },
    }

    function emptyTask() {
      return { id: crypto.randomUUID(), enabled: true, description: '', sessionId: '', prompt: '', cron: '', overlap: 'skip' }
    }

    function truncate(text, n) {
      const s = String(text ?? '')
      return s.length > n ? `${s.slice(0, n)}…` : s
    }

    function Field({ label, value, onChange, placeholder }) {
      return h('label', { style: style.field },
        h('span', { style: style.flabel }, label),
        h('input', { style: style.input, value: value ?? '', placeholder, onChange: (e) => onChange(e.target.value) }))
    }

    function SessionSelect({ value, sessions, onChange }) {
      const opts = sessions ?? []
      const current = value ?? ''
      const hasCurrent = current !== '' && !opts.some((s) => s.sessionId === current)
      return h('select', { style: style.input, value: current, onChange: (e) => onChange(e.target.value) },
        h('option', { value: '' }, '— 选择会话 —'),
        hasCurrent ? h('option', { value: current }, current) : null,
        opts.map((s) => h('option', { key: s.sessionId, value: s.sessionId }, s.displayTitle)))
    }

    function fmtTime(iso) {
      if (!iso) return ''
      const d = new Date(iso)
      if (Number.isNaN(d.getTime())) return String(iso)
      const p = (n) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    }

    function lastRunText(task) {
      if (task.lastRunAt === undefined || task.lastRunAt === null) return '从未执行'
      const secs = Number.isFinite(task.lastDurationMs) ? ` · ${(task.lastDurationMs / 1000).toFixed(1)}s` : ''
      return `上次执行 ${fmtTime(task.lastRunAt)}${secs}`
    }

    function TaskSection({ callRpc }) {
      const [tasks, setTasks] = useState(null)
      const [sessions, setSessions] = useState([])
      const [error, setError] = useState(null)
      const [notice, setNotice] = useState(null)
      const [saving, setSaving] = useState(false)
      const [view, setView] = useState('list')
      const [modal, setModal] = useState(null)
      const [logTaskId, setLogTaskId] = useState(null)
      const [logs, setLogs] = useState(null)

      const load = useCallback(async () => {
        setError(null)
        try {
          const [res, sres] = await Promise.all([
            callRpc('get', {}),
            callRpc('sessions', {}),
          ])
          if (res?.ok !== true) throw new Error(res?.error?.message ?? 'get failed')
          setTasks(res.value.tasks ?? [])
          if (sres?.ok === true) setSessions(sres.value.sessions ?? [])
        } catch (e) {
          setError(String(e?.message ?? e))
        }
      }, [callRpc])

      useEffect(() => { void load() }, [load])

      const loadLogs = useCallback(async (taskId) => {
        setLogs(null)
        setError(null)
        try {
          const res = await callRpc('logs', { taskId, limit: 200 })
          if (res?.ok !== true) throw new Error(res?.error?.message ?? 'logs failed')
          setLogs(res.value.logs ?? [])
        } catch (e) {
          setError(String(e?.message ?? e))
        }
      }, [callRpc])

      const openNew = () => { setNotice(null); setModal({ mode: 'new', id: null, form: emptyTask() }) }
      const openEdit = (task) => { setNotice(null); setModal({ mode: 'edit', id: task.id, form: { ...task } }) }
      const closeModal = () => setModal(null)
      const updForm = (patch) => setModal((m) => (m === null ? m : { ...m, form: { ...m.form, ...patch } }))
      const openLog = (taskId) => { setLogTaskId(taskId); setView('log'); void loadLogs(taskId) }

      const runTask = useCallback(async (taskId) => {
        setNotice(null)
        setError(null)
        try {
          const res = await callRpc('run', { taskId })
          if (res?.ok !== true) throw new Error(res?.error?.message ?? 'run failed')
          setNotice('已触发执行')
        } catch (e) {
          setError(String(e?.message ?? e))
        }
      }, [callRpc])

      const saveModal = useCallback(async () => {
        if (modal === null) return
        setSaving(true)
        setError(null)
        try {
          const list = [...(tasks ?? [])]
          if (modal.mode === 'new') list.push(modal.form)
          else {
            const idx = list.findIndex((t) => t.id === modal.id)
            if (idx >= 0) list[idx] = modal.form
            else list.push(modal.form)
          }
          const res = await callRpc('set', { tasks: list })
          if (res?.ok !== true) throw new Error(res?.error?.message ?? 'set failed')
          setTasks(res.value.tasks ?? [])
          setNotice('已保存')
          setModal(null)
        } catch (e) {
          setError(String(e?.message ?? e))
        } finally {
          setSaving(false)
        }
      }, [callRpc, tasks, modal])

      const removeOne = useCallback(async (taskId) => {
        if (!window.confirm('确定删除这个任务？')) return
        setSaving(true)
        setError(null)
        try {
          const res = await callRpc('set', { tasks: (tasks ?? []).filter((t) => t.id !== taskId) })
          if (res?.ok !== true) throw new Error(res?.error?.message ?? 'set failed')
          setTasks(res.value.tasks ?? [])
          setNotice('已删除')
        } catch (e) {
          setError(String(e?.message ?? e))
        } finally {
          setSaving(false)
        }
      }, [callRpc, tasks])

      // ---- 日志页 ----
      if (view === 'log') {
        return h('section', { style: style.page },
          h('div', { style: style.pageHead },
            h('button', { type: 'button', style: style.back, onClick: () => setView('list'), 'aria-label': '返回' }, '\u2190'),
            h('span', { style: style.pageTitle }, '任务日志'),
            logs !== null && logs.length > 0 ? h('span', { style: style.count }, `最近 ${logs.length} 条`) : null),
          error !== null ? h('div', { style: style.error }, String(error)) : null,
          logs === null ? h('div', { style: style.hint }, '加载中…') : null,
          logs !== null && logs.length === 0 ? h('div', { style: style.hint }, '暂无日志') : null,
          (logs ?? []).map((rec, i) => h('div', { key: i, style: style.logCard },
            h('div', { style: style.logHead },
              h('span', { style: style.logTime }, fmtTime(rec.ts)),
              h('span', { style: rec.completed ? style.logStatus : { ...style.logStatus, ...style.logStatusErr } }, String(rec.status ?? '')),
              h('span', { style: style.logDur }, Number.isFinite(rec.durationMs) ? `${rec.durationMs} ms` : '')),
            h('div', { style: style.field },
              h('span', { style: style.blockK }, '提示词'),
              h('div', { style: style.promptBox }, String(rec.prompt ?? '—'))),
            rec.result ? h('div', { style: style.field },
              h('span', { style: { ...style.blockK, ...style.blockKReply } }, '回复'),
              h('div', { style: style.resultText }, String(rec.result))) : null,
            rec.error ? h('div', { style: style.field },
              h('span', { style: { ...style.blockK, ...style.blockKErr } }, '错误'),
              h('div', { style: style.errText }, String(rec.error))) : null)))
      }

      // ---- 新建/编辑弹窗 ----
      const modalElement = modal === null ? null : h('div', { style: style.modalRoot },
        h('div', { style: style.modalMask }),
        h('div', { style: style.dialog },
          h('div', { style: style.dlgHead },
            h('h3', { style: style.dlgTitle }, modal.mode === 'new' ? '新建定时任务' : '编辑定时任务'),
            h('button', { type: 'button', style: style.close, onClick: closeModal, 'aria-label': '关闭' }, '\u2715')),
          h('div', { style: style.dlgBody },
            error !== null ? h('div', { style: style.error }, String(error)) : null,
            Field({ label: '任务描述', value: modal.form.description, onChange: (v) => updForm({ description: v }), placeholder: '每日晨报' }),
            h('label', { style: style.field },
              h('span', { style: style.flabel }, '指定 SESSION'),
              h(SessionSelect, { value: modal.form.sessionId, sessions, onChange: (v) => updForm({ sessionId: v }) })),
            Field({ label: 'CRON 表达式', value: modal.form.cron, onChange: (v) => updForm({ cron: v }), placeholder: '30 8 * * *' }),
            h('label', { style: style.field },
              h('span', { style: style.flabel }, 'OVERLAP'),
              h('select', { style: style.input, value: modal.form.overlap ?? 'skip', onChange: (e) => updForm({ overlap: e.target.value }) },
                OVERLAPS.map((o) => h('option', { key: o, value: o }, o)))),
            h('label', { style: style.field },
              h('span', { style: style.flabel }, '提示词'),
              h('textarea', { rows: 10, style: { ...style.input, resize: 'vertical' }, value: modal.form.prompt ?? '', onChange: (e) => updForm({ prompt: e.target.value }) })),
            h('label', { style: style.check },
              h('input', { type: 'checkbox', checked: modal.form.enabled !== false, onChange: (e) => updForm({ enabled: e.target.checked }) }),
              '启用')),
          h('div', { style: style.dlgFoot },
            h('button', { type: 'button', style: style.ghost, onClick: closeModal }, '取消'),
            h('button', { type: 'button', style: style.primary, disabled: saving, onClick: () => void saveModal() }, saving ? '保存中…' : '保存'))))

      // ---- 列表页 ----
      return h('section', { style: style.page },
        h('button', { type: 'button', style: style.bigButton, onClick: openNew }, '+ 新建定时任务'),
        error !== null ? h('div', { style: style.error }, String(error)) : null,
        notice !== null ? h('div', { style: style.ok }, notice) : null,
        tasks === null ? h('div', { style: style.hint }, '加载中…') : null,
        tasks !== null && tasks.length === 0 ? h('div', { style: style.hint }, '还没有任务，点上方按钮新建') : null,
        (tasks ?? []).map((task) => h('div', { key: task.id, style: style.card, onClick: () => openEdit(task) },
          h('div', { style: style.cardHead },
            h('span', { style: style.cardTitle }, task.description || '(未命名任务)'),
            h('span', { style: { ...style.tag, ...(task.enabled !== false ? style.tagOn : style.tagOff) } }, task.enabled !== false ? '启用' : '停用')),
          h('div', { style: style.cardCron }, `CRON  ${task.cron || '—'}`),
          task.prompt ? h('div', { style: style.cardPrompt }, truncate(task.prompt, PROMPT_LIMIT)) : null,
          h('div', { style: style.cardFoot },
            h('span', { style: style.last }, lastRunText(task)),
            h('span', { style: style.acts },
              h('button', { type: 'button', style: style.button, onClick: (e) => { e.stopPropagation(); void runTask(task.id) } }, '调试'),
              h('button', { type: 'button', style: style.logBtn, onClick: (e) => { e.stopPropagation(); openLog(task.id) } }, '日志'),
              h('button', { type: 'button', style: style.dangerBtn, disabled: saving, onClick: (e) => { e.stopPropagation(); void removeOne(task.id) } }, '删除'))))),
        modalElement)
    }

    return {
      inject: ['slots', 'connection', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, 'zh', {}))
        const callRpc = (method, payload, signal) => ctx.connection.rpc.call('/api', 'dsh-task', { method, payload }, signal)
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'dsh-task',
          order: 30,
          label: () => '定时任务',
          locale: NS,
          inject: () => ({ callRpc }),
        }, TaskSection))
      },
    }
  },
})
