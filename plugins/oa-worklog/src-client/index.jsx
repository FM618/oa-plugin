/**
 * @fm618/oa-worklog —— client 半部
 *
 * 列表 / 甘特双模式（甘特为周视图：x 轴 7 日列，y 轴 00:00~24:00）。
 * 数据全部经 runtime.invoke 走 host 半部，浏览器拿不到地址与令牌。
 */
const React = require('react')

const MODULE = {
  id: 'worklog',
  title: '工作日志',
  order: 10,
  capability: 'worklog.use',
  icon: 'list-pen',
}

const WEEKDAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
const GANTT_TICKS = Array.from({ length: 25 }, (_, h) => h)
const GANTT_HEIGHT = 760

// ── 时间工具 ────────────────────────────────────────────────────────
const pad2 = (n) => String(n).padStart(2, '0')

// 24 小时制：小时全列，分钟按 5 分钟粒度（工作日志以整块时间为主）
// 注意：必须定义在 pad2 之后——const 不提升，放在前面会 TDZ 报错
const HOURS = Array.from({ length: 24 }, (_, h) => pad2(h))
const MINUTES = Array.from({ length: 12 }, (_, i) => pad2(i * 5))

function toDateStr(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

function todayStr() {
  return toDateStr(new Date())
}

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number)
  return toDateStr(new Date(y, m - 1, d + n))
}

/** 所在周的周一 */
function weekStartOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  return addDays(dateStr, -((dt.getDay() + 6) % 7))
}

/** ISO → 当日分钟数 */
function minsOfIso(iso) {
  const d = new Date(iso)
  return d.getHours() * 60 + d.getMinutes()
}

function hmOfMins(mins) {
  return `${pad2(Math.floor(mins / 60))}:${pad2(mins % 60)}`
}

function fmtMinutes(total) {
  const h = Math.floor(total / 60)
  const m = total % 60
  if (h === 0) return `${m} 分钟`
  return m === 0 ? `${h} 小时` : `${h} 小时 ${m} 分`
}

function durationOf(item) {
  return Math.max(0, minsOfIso(item.endAt) - minsOfIso(item.startAt))
}

/** ISO → HH:mm（表单回填；只取时刻，日期由 workDate 单独管） */
function hhmm(iso) {
  const d = new Date(iso)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** 同日重叠记录按开始时间贪心分配到子列 */
function assignDayColumns(entries) {
  const sorted = entries
    .map((e) => ({ entry: e, start: minsOfIso(e.startAt), end: minsOfIso(e.endAt) }))
    .sort((a, b) => a.start - b.start || a.end - b.end)
  const colEnds = []
  const bars = sorted.map((item) => {
    let col = colEnds.findIndex((end) => end <= item.start)
    if (col === -1) {
      col = colEnds.length
      colEnds.push(item.end)
    } else {
      colEnds[col] = item.end
    }
    return { ...item, col }
  })
  return { bars, colCount: Math.max(1, colEnds.length) }
}

// ── 未登录时的示例数据 ──────────────────────────────────────────────
/**
 * 构造本周的示例记录：覆盖周一到周五，故意留两处时间重叠，
 * 让用户一眼看到甘特的"并排"能力。
 */
function buildDemoWeek() {
  const monday = weekStartOf(todayStr())
  const make = (dayOffset, sh, sm, eh, em, content) => {
    const date = addDays(monday, dayOffset)
    const start = new Date(`${date}T${pad2(sh)}:${pad2(sm)}:00`)
    const end = new Date(`${date}T${pad2(eh)}:${pad2(em)}:00`)
    return {
      id: `demo-${dayOffset}-${sh}${sm}`,
      workDate: date,
      startAt: start.toISOString(),
      endAt: end.toISOString(),
      content,
    }
  }
  return [
    make(0, 9, 0, 10, 0, '周会：同步本周计划'),
    make(0, 10, 0, 12, 0, '梳理插件与 OA 服务器的接口'),
    make(1, 9, 30, 11, 30, '联调工作日志接口'),
    make(1, 10, 30, 12, 0, '并行处理权限问题（与上一条重叠）'),
    make(2, 9, 0, 11, 0, '甘特视图坐标换算与重叠分列'),
    make(2, 14, 0, 17, 0, '补充校验规则与错误文案'),
    make(3, 9, 0, 12, 0, '整理发布前的检查清单'),
    make(3, 15, 0, 16, 30, '代码评审'),
    make(4, 9, 30, 12, 0, '迭代回顾与下周排期'),
  ]
}

// ── 主面板 ──────────────────────────────────────────────────────────
function WorklogPanel({ runtime }) {
  // 状态放进本地 state：登录/登出时要触发重新加载，而不是只重渲染
  const [status, setStatus] = React.useState(runtime.status)
  React.useEffect(() => {
    setStatus(runtime.status)
    return runtime.onStatus(() => setStatus(runtime.status))
  }, [runtime])

  const [weekStart, setWeekStart] = React.useState(weekStartOf(todayStr()))
  // 默认甘特（周视图一眼看全一周的分布）；想逐条看再切列表
  const [mode, setMode] = React.useState('gantt')
  const [items, setItems] = React.useState([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState('')
  const [selected, setSelected] = React.useState(null)
  const [editing, setEditing] = React.useState(null)

  const load = React.useCallback(async () => {
    if (runtime.status !== 'authenticated') {
      setItems([])
      setLoading(false)
      return
    }
    setLoading(true)
    setError('')
    try {
      const page = await runtime.invoke('worklog.list', {
        query: { from: weekStart, to: addDays(weekStart, 6), page: 1, size: 100 },
      })
      setItems(page.items || [])
    } catch (e) {
      setError(e.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }, [runtime, weekStart])

  // status 变化（登录成功）时要重新拉一次，否则面板会停在未登录时的空数据
  React.useEffect(() => { void load() }, [load, status])

  if (runtime.status !== 'authenticated') {
    const demoWeek = weekStartOf(todayStr())
    const demo = buildDemoWeek()
    return React.createElement(
      'div',
      { style: styles.page },
      React.createElement(
        'div',
        { style: styles.locked },   // position: relative，遮罩的定位基准
        React.createElement(
          'div',
          { style: styles.preview, 'aria-hidden': true },   // 示例：只展示，不交互
          React.createElement(
            'div',
            { style: styles.header },
            React.createElement('h2', { style: styles.title }, '工作日志'),
            React.createElement(
              'div',
              { style: styles.weekNav },
              React.createElement('button', { style: styles.ghost, disabled: true }, '‹'),
              React.createElement('span', { style: styles.weekLabel }, `${demoWeek.slice(5)} ~ ${addDays(demoWeek, 6).slice(5)}`),
              React.createElement('button', { style: styles.ghost, disabled: true }, '›'),
            ),
            React.createElement('div', { style: styles.spacer }),
            React.createElement('span', { style: styles.badge }, '示例数据'),
          ),
          React.createElement(GanttView, { items: demo, weekStart: demoWeek, onOpen: () => {} }),
          React.createElement(SummaryBar, { items: demo, hover: null }),
        ),
        React.createElement(
          'div',
          { style: styles.overlay },
          React.createElement(
            'div',
            { style: styles.overlayCard },
            React.createElement('div', { style: styles.overlayTitle }, '登录后开始记录你的工作'),
            React.createElement(
              'div',
              { style: styles.overlayBody },
              '请到「设置 → OA 连接」设置并登录系统。',
            ),
            runtime.status === 'offline'
              ? React.createElement(
                  'div',
                  { style: styles.noticeWarn },
                  '当前连不上服务器，请先在「OA 连接」里检查地址与网络。',
                )
              : null,
          ),
        ),
      ),
    )
  }

  if (!runtime.has('worklog.use')) {
    return React.createElement(
      'div',
      { style: styles.page },
      React.createElement('h2', { style: styles.title }, '工作日志'),
      React.createElement('div', { style: styles.empty }, '当前账号没有工作日志权限，请联系管理员分配。'),
    )
  }

  async function remove(item) {
    if (!window.confirm(`删除 ${item.workDate} ${hmOfMins(minsOfIso(item.startAt))}-${hmOfMins(minsOfIso(item.endAt))} 的日志？`)) return
    try {
      await runtime.invoke('worklog.delete', { params: { id: item.id } })
      setSelected((cur) => (cur && cur.id === item.id ? null : cur))
      await load()
    } catch (e) {
      setError(e.message || '删除失败')
    }
  }

  const weekLabel = `${weekStart.slice(5)} ~ ${addDays(weekStart, 6).slice(5)}`

  return React.createElement(
    'div',
    { style: styles.page },
    React.createElement(
      'div',
      { style: styles.header },
      React.createElement('h2', { style: styles.title }, '工作日志'),
      React.createElement(
        'div',
        { style: styles.weekNav },
        React.createElement('button', { style: styles.ghost, onClick: () => setWeekStart(addDays(weekStart, -7)) }, '‹'),
        React.createElement('span', { style: styles.weekLabel }, weekLabel),
        React.createElement('button', { style: styles.ghost, onClick: () => setWeekStart(addDays(weekStart, 7)) }, '›'),
        React.createElement('button', { style: styles.ghost, onClick: () => setWeekStart(weekStartOf(todayStr())) }, '本周'),
      ),
      React.createElement('div', { style: styles.spacer }),
      React.createElement(
        'div',
        { style: styles.segmented },
        ['list', 'gantt'].map((m) =>
          React.createElement(
            'button',
            {
              key: m,
              style: mode === m ? styles.segOn : styles.segOff,
              onClick: () => setMode(m),
            },
            m === 'list' ? '列表' : '甘特',
          ),
        ),
      ),
      React.createElement('button', { style: styles.primary, onClick: () => setEditing({}) }, '＋ 记一条'),
    ),
    error ? React.createElement('div', { style: styles.error }, error) : null,
    selected && !editing
      ? React.createElement(DetailCard, {
          item: selected,
          onEdit: () => setEditing(selected),
          onDelete: () => remove(selected),
          onClose: () => setSelected(null),
        })
      : null,
    editing
      ? React.createElement(WorklogForm, {
          runtime,
          initial: editing.id ? editing : null,
          onCancel: () => setEditing(null),
          onSaved: async () => { setEditing(null); setSelected(null); await load() },
        })
      : null,
    loading
      ? React.createElement('div', { style: styles.empty }, '加载中…')
      : mode === 'list'
        ? React.createElement(ListView, { items, onOpen: setSelected, onEdit: setEditing, onDelete: remove })
        : React.createElement(GanttView, { items, weekStart, onOpen: setSelected }),
    !loading && items.length === 0
      ? React.createElement(
          'div',
          { style: styles.emptyInline },
          '本周还没有记录 —— 点右上角「＋ 记一条」开始。',
        )
      : null,
  )
}

// ── 列表 ────────────────────────────────────────────────────────────
function ListView({ items, onOpen, onEdit, onDelete }) {
  const byDay = new Map()
  for (const item of items) {
    if (!byDay.has(item.workDate)) byDay.set(item.workDate, [])
    byDay.get(item.workDate).push(item)
  }
  const days = [...byDay.keys()].sort().reverse()

  if (days.length === 0) {
    return React.createElement('div', { style: styles.empty }, '本周还没有记录。')
  }

  return React.createElement(
    'div',
    { style: styles.list },
    days.map((day) => {
      const entries = byDay.get(day).slice().sort((a, b) => minsOfIso(a.startAt) - minsOfIso(b.startAt))
      const total = entries.reduce((sum, e) => sum + durationOf(e), 0)
      return React.createElement(
        'div',
        { key: day, style: styles.dayCard },
        React.createElement(
          'div',
          { style: styles.dayHead },
          React.createElement('span', { style: styles.dayTitle }, `${day} ${weekdayCn(day)}`),
          React.createElement('span', { style: styles.badge }, `${entries.length} 条`),
          React.createElement('span', { style: styles.spacer }),
          React.createElement('span', { style: styles.dayTotal }, `合计 ${fmtMinutes(total)}`),
        ),
        entries.map((item) =>
          React.createElement(
            'div',
            { key: item.id, style: styles.row },
            React.createElement('span', { style: styles.rowTime }, `${hmOfMins(minsOfIso(item.startAt))}-${hmOfMins(minsOfIso(item.endAt))}`),
            React.createElement('span', { style: styles.badge }, fmtMinutes(durationOf(item))),
            React.createElement(
              'button',
              { style: styles.rowContentButton, onClick: () => onOpen(item), title: '查看详情' },
              item.content,
            ),
            React.createElement('button', { style: styles.link, onClick: () => onEdit(item) }, '编辑'),
            React.createElement('button', { style: styles.linkDanger, onClick: () => onDelete(item) }, '删除'),
          ),
        ),
      )
    }),
  )
}

function weekdayCn(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  return WEEKDAY_LABELS[((new Date(y, m - 1, d).getDay() + 6) % 7)]
}

// ── 甘特（周视图）───────────────────────────────────────────────────
function GanttView({ items, weekStart, onOpen }) {
  const [hover, setHover] = React.useState(null)
  const today = todayStr()
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))
  const byDay = new Map()
  for (const item of items) {
    if (!byDay.has(item.workDate)) byDay.set(item.workDate, [])
    byDay.get(item.workDate).push(item)
  }

  return React.createElement(
    'div',
    { style: styles.ganttWrap },
    React.createElement(
      'div',
      { style: styles.ganttGrid },
      React.createElement('div', { style: styles.ganttCorner }),
      days.map((day, index) =>
        React.createElement(
          'div',
          {
            key: day,
            style: {
              ...styles.ganttDayHead,
              ...(index > 0 ? styles.divider : null),
              ...(day === today ? styles.ganttToday : null),
            },
          },
          React.createElement('div', { style: day === today ? { fontWeight: 600 } : null }, WEEKDAY_LABELS[index]),
          React.createElement('div', { style: styles.ganttDayDate }, day.slice(5)),
        ),
      ),
      React.createElement(
        'div',
        { style: styles.ganttTimeCol },
        GANTT_TICKS.map((h) => React.createElement('span', { key: h, style: { ...styles.ganttTick, ...tickStyle(h) } }, `${pad2(h)}:00`)),
      ),
      React.createElement(
        'div',
        { style: { ...styles.ganttBody, height: GANTT_HEIGHT } },
        GANTT_TICKS.slice(1, -1).map((h) =>
          React.createElement('span', { key: h, style: { ...styles.ganttHLine, top: `${(h / 24) * 100}%` } }),
        ),
        React.createElement(
          'div',
          { style: styles.ganttCols },
          days.map((day, index) => {
            const { bars, colCount } = assignDayColumns(byDay.get(day) || [])
            return React.createElement(
              'div',
              {
                key: day,
                style: {
                  ...styles.ganttCol,
                  ...(index > 0 ? styles.divider : null),
                  ...(day === today ? styles.ganttColToday : null),
                },
              },
              bars.map((bar) =>
                React.createElement(
                  'button',
                  {
                    key: bar.entry.id,
                    style: {
                      ...styles.ganttBar,
                      top: `${(bar.start / 1440) * 100}%`,
                      height: `${Math.max(((bar.end - bar.start) / 1440) * 100, 1.4)}%`,
                      left: `calc(${(bar.col / colCount) * 100}% + 2px)`,
                      width: `calc(${100 / colCount}% - 4px)`,
                    },
                    onMouseEnter: () => setHover({ bar, day }),
                    onMouseLeave: () => setHover(null),
                    onClick: () => onOpen(bar.entry),
                  },
                  React.createElement('span', { style: styles.ganttBarText }, `${hmOfMins(bar.start)}-${hmOfMins(bar.end)}`),
                ),
              ),
            )
          }),
        ),
      ),
    ),
    React.createElement(SummaryBar, { items, hover }),
  )
}

/**
 * 摘要条：默认显示本周统计，悬停某条时切换为该条的摘要。
 * 两种态高度一致，避免悬停时页面跳动。
 */
function SummaryBar({ items, hover }) {
  const totalMinutes = items.reduce((sum, item) => sum + durationOf(item), 0)
  const activeDays = new Set(items.map((item) => item.workDate)).size

  if (hover) {
    const { bar, day } = hover
    const minutes = bar.end - bar.start
    return React.createElement(
      'div',
      { style: { ...styles.summary, ...styles.summaryActive } },
      React.createElement('span', { style: styles.summaryDate }, `${day.slice(5)} ${weekdayCn(day)}`),
      React.createElement('span', { style: styles.summaryTime }, `${hmOfMins(bar.start)} – ${hmOfMins(bar.end)}`),
      React.createElement('span', { style: styles.summaryBadge }, fmtMinutes(minutes)),
      React.createElement('span', { style: styles.summaryText, title: bar.entry.content }, bar.entry.content),
      React.createElement('span', { style: styles.summaryHint }, '点击查看详情'),
    )
  }

  if (items.length === 0) {
    return React.createElement(
      'div',
      { style: styles.summary },
      React.createElement('span', { style: styles.summaryMuted }, '本周暂无记录'),
    )
  }

  return React.createElement(
    'div',
    { style: styles.summary },
    React.createElement('span', { style: styles.summaryWeek }, '本周'),
    React.createElement('span', { style: styles.summaryStat }, `${items.length} 条`),
    React.createElement('span', { style: styles.summaryDot }, '·'),
    React.createElement('span', { style: styles.summaryStat }, `合计 ${fmtMinutes(totalMinutes)}`),
    React.createElement('span', { style: styles.summaryDot }, '·'),
    React.createElement('span', { style: styles.summaryStat }, `${activeDays} 天有记录`),
    activeDays > 0
      ? React.createElement(
          React.Fragment,
          null,
          React.createElement('span', { style: styles.summaryDot }, '·'),
          React.createElement('span', { style: styles.summaryStat }, `日均 ${fmtMinutes(Math.round(totalMinutes / activeDays))}`),
        )
      : null,
    React.createElement('span', { style: styles.spacer }),
    React.createElement('span', { style: styles.summaryMuted }, '悬停条带看摘要'),
  )
}

function tickStyle(h) {
  if (h === 0) return { top: 0 }
  if (h === 24) return { top: '100%', transform: 'translateY(-100%)' }
  return { top: `${(h / 24) * 100}%`, transform: 'translateY(-50%)' }
}

// ── 详情 ────────────────────────────────────────────────────────────
/** 只读详情：甘特/列表点开先看这个，要改再点「编辑」 */
function DetailCard({ item, onEdit, onDelete, onClose }) {
  const start = minsOfIso(item.startAt)
  const end = minsOfIso(item.endAt)
  return React.createElement(
    'div',
    { style: styles.detail },
    React.createElement(
      'div',
      { style: styles.detailHead },
      React.createElement('span', { style: styles.detailTitle }, `${item.workDate} ${weekdayCn(item.workDate)}`),
      React.createElement('span', { style: styles.detailTime }, `${hmOfMins(start)} – ${hmOfMins(end)}`),
      React.createElement('span', { style: styles.badge }, fmtMinutes(end - start)),
      React.createElement('span', { style: styles.spacer }),
      React.createElement('button', { style: styles.primary, onClick: onEdit }, '编辑'),
      React.createElement('button', { style: styles.linkDanger, onClick: onDelete }, '删除'),
      React.createElement('button', { style: styles.link, onClick: onClose }, '关闭'),
    ),
    React.createElement('div', { style: styles.detailContent }, item.content),
    React.createElement(
      'div',
      { style: styles.detailMeta },
      `创建于 ${fmtDateTime(item.createdAt)}${item.updatedAt && item.updatedAt !== item.createdAt ? ` · 更新于 ${fmtDateTime(item.updatedAt)}` : ''}`,
    ),
  )
}

/** 本地时间，显式 24 小时制 */
function fmtDateTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return `${toDateStr(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

// ── 表单 ────────────────────────────────────────────────────────────
/** 显式 24 小时制时间控件：两次下拉，不依赖浏览器 locale，也没有 AM/PM */
function TimeField({ value, onChange }) {
  const [hour, minute] = value.split(':')
  // 编辑历史数据时，若原值不在 5 分钟格点上，把它补进选项，避免被静默改掉
  const minuteOptions = MINUTES.includes(minute) ? MINUTES : [...MINUTES, minute].sort()
  return React.createElement(
    'span',
    { style: styles.timeField },
    React.createElement(
      'select',
      {
        style: styles.timeSelect,
        value: hour,
        onChange: (e) => onChange(`${e.target.value}:${minute}`),
        'aria-label': '小时',
      },
      HOURS.map((h) => React.createElement('option', { key: h, value: h }, h)),
    ),
    React.createElement('span', { style: styles.timeColon }, ':'),
    React.createElement(
      'select',
      {
        style: styles.timeSelect,
        value: minute,
        onChange: (e) => onChange(`${hour}:${e.target.value}`),
        'aria-label': '分钟',
      },
      minuteOptions.map((m) => React.createElement('option', { key: m, value: m }, m)),
    ),
  )
}
function WorklogForm({ runtime, initial, onCancel, onSaved }) {
  const base = initial || {}
  const [workDate, setWorkDate] = React.useState(base.workDate || todayStr())
  // 只有时刻：日期由 workDate 决定，跨天在结构上就不可能
  const [startTime, setStartTime] = React.useState(base.startAt ? hhmm(base.startAt) : '09:00')
  const [endTime, setEndTime] = React.useState(base.endAt ? hhmm(base.endAt) : '10:00')
  const [content, setContent] = React.useState(base.content || '')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')

  async function submit(event) {
    event.preventDefault()
    setError('')
    if (endTime <= startTime) {
      setError('结束时间必须晚于开始时间')
      return
    }
    setBusy(true)
    // 日期与时刻在同一条本地时间串里拼装，天然同日
    const payload = {
      workDate,
      startAt: new Date(`${workDate}T${startTime}:00`).toISOString(),
      endAt: new Date(`${workDate}T${endTime}:00`).toISOString(),
      content: content.trim(),
    }
    try {
      if (initial && initial.id) {
        await runtime.invoke('worklog.update', { params: { id: initial.id }, body: payload })
      } else {
        await runtime.invoke('worklog.create', { body: payload })
      }
      await onSaved()
    } catch (e) {
      setError(e.message || '保存失败')
    } finally {
      setBusy(false)
    }
  }

  return React.createElement(
    'form',
    { style: styles.form, onSubmit: submit },
    React.createElement(
      'div',
      { style: styles.formRow },
      React.createElement('input', {
        style: styles.input, type: 'date', value: workDate, max: todayStr(),
        onChange: (e) => setWorkDate(e.target.value),
      }),
      React.createElement(TimeField, { value: startTime, onChange: setStartTime }),
      React.createElement('span', { style: styles.dash }, '–'),
      React.createElement(TimeField, { value: endTime, onChange: setEndTime }),
    ),
    React.createElement('textarea', {
      style: styles.textarea,
      rows: 3,
      maxLength: 800,
      placeholder: '这段时间做了什么（1~800 字）',
      value: content,
      onChange: (e) => setContent(e.target.value),
    }),
    error ? React.createElement('div', { style: styles.error }, error) : null,
    React.createElement(
      'div',
      { style: styles.formActions },
      React.createElement('button', { style: { ...styles.primary, opacity: busy ? 0.6 : 1 }, type: 'submit', disabled: busy }, busy ? '保存中…' : '保存'),
      React.createElement('button', { style: styles.link, type: 'button', onClick: onCancel }, '取消'),
    ),
  )
}

// ── 样式 ────────────────────────────────────────────────────────────
const styles = {
  page: { padding: '20px 28px', fontFamily: 'system-ui, -apple-system, "PingFang SC", sans-serif', color: '#1f2329', minWidth: 0 },
  header: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' },
  title: { fontSize: 20, fontWeight: 600, margin: 0, marginRight: 6 },
  weekNav: { display: 'flex', alignItems: 'center', gap: 4 },
  weekLabel: { fontSize: 13, color: '#646a73', fontVariantNumeric: 'tabular-nums', minWidth: 96, textAlign: 'center' },
  spacer: { flex: 1 },
  segmented: { display: 'flex', border: '1px solid #d0d3d9', borderRadius: 6, overflow: 'hidden' },
  segOn: { padding: '4px 12px', border: 'none', background: '#1f6feb', color: '#fff', fontSize: 13, cursor: 'pointer' },
  segOff: { padding: '4px 12px', border: 'none', background: '#fff', color: '#4e5969', fontSize: 13, cursor: 'pointer' },
  primary: { height: 30, padding: '0 14px', border: 'none', borderRadius: 6, background: '#1f6feb', color: '#fff', cursor: 'pointer', fontSize: 13 },
  ghost: { height: 26, minWidth: 26, padding: '0 8px', border: '1px solid #d0d3d9', borderRadius: 6, background: '#fff', color: '#4e5969', cursor: 'pointer', fontSize: 13 },
  link: { background: 'none', border: 'none', color: '#1f6feb', cursor: 'pointer', fontSize: 13, padding: 0 },
  linkDanger: { background: 'none', border: 'none', color: '#d93026', cursor: 'pointer', fontSize: 13, padding: 0 },
  error: { color: '#d93026', fontSize: 13, margin: '8px 0' },
  empty: { color: '#8f959e', fontSize: 14, padding: '32px 0' },
  emptyInline: { color: '#8f959e', fontSize: 12, padding: '8px 2px 0' },
  badge: { fontSize: 11, color: '#4e5969', background: '#f2f3f5', borderRadius: 4, padding: '1px 5px', whiteSpace: 'nowrap' },
  list: { display: 'grid', gap: 10, alignContent: 'start' },
  dayCard: { background: '#fff', border: '1px solid #e5e6eb', borderRadius: 8, padding: '10px 14px' },
  dayHead: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' },
  dayTitle: { fontSize: 14, fontWeight: 600 },
  dayTotal: { fontSize: 12, color: '#646a73' },
  row: { display: 'flex', alignItems: 'baseline', gap: 10, padding: '6px 0', borderTop: '1px solid #f2f3f5' },
  rowTime: { fontSize: 12, color: '#646a73', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
  rowContentButton: { flex: 1, minWidth: 0, padding: 0, border: 'none', background: 'none', textAlign: 'left', cursor: 'pointer', fontSize: 14, color: '#1f2329', fontFamily: 'inherit', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  detail: { background: '#fff', border: '1px solid #d6e4ff', borderLeft: '3px solid #1f6feb', borderRadius: 8, padding: '10px 14px', marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 6 },
  detailHead: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  detailTitle: { fontSize: 14, fontWeight: 600 },
  detailTime: { fontSize: 13, color: '#4e5969', fontVariantNumeric: 'tabular-nums' },
  detailContent: { fontSize: 14, whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.6 },
  detailMeta: { fontSize: 12, color: '#8f959e' },
  form: { padding: 14, background: '#f7f8fa', border: '1px solid #e5e6eb', borderRadius: 8, marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 10 },
  formRow: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  formActions: { display: 'flex', gap: 12, alignItems: 'center' },
  input: { height: 30, padding: '0 8px', border: '1px solid #d0d3d9', borderRadius: 6, fontSize: 13, background: '#fff' },
  textarea: { padding: 10, border: '1px solid #d0d3d9', borderRadius: 6, fontSize: 14, resize: 'vertical', fontFamily: 'inherit' },
  dash: { color: '#8f959e' },
  locked: { position: 'relative', borderRadius: 10, overflow: 'hidden' },
  preview: { filter: 'saturate(0.9)', pointerEvents: 'none', userSelect: 'none', padding: '4px 4px 0' },
  overlay: { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(250,251,252,.72)', backdropFilter: 'blur(2px)', WebkitBackdropFilter: 'blur(2px)', padding: 24 },
  overlayCard: { maxWidth: 440, textAlign: 'center', background: '#fff', border: '1px solid #e5e6eb', borderRadius: 12, padding: '26px 28px', boxShadow: '0 12px 32px rgba(15,23,42,.10)', display: 'flex', flexDirection: 'column', gap: 10 },
  overlayTitle: { fontSize: 17, fontWeight: 600, color: '#1f2329' },
  overlayBody: { fontSize: 13, color: '#4e5969', lineHeight: 1.75 },
  noticeWarn: { fontSize: 12, color: '#8a6d3b', background: '#fff8e6', border: '1px solid #ffe0a3', borderRadius: 6, padding: '6px 10px', marginTop: 10 },
  timeField: { display: 'inline-flex', alignItems: 'center', gap: 2 },
  timeSelect: { height: 30, padding: '0 4px', border: '1px solid #d0d3d9', borderRadius: 6, fontSize: 13, background: '#fff', fontVariantNumeric: 'tabular-nums' },
  timeColon: { color: '#8f959e', fontSize: 13 },
  // 甘特
  ganttWrap: { display: 'grid', gap: 6 },
  ganttGrid: { display: 'grid', gridTemplateColumns: '52px repeat(7, minmax(40px, 1fr))', border: '1px solid #e5e6eb', borderRadius: 8, overflow: 'hidden', background: '#fff' },
  ganttCorner: { borderRight: '1px solid #e5e6eb', borderBottom: '1px solid #e5e6eb' },
  ganttDayHead: { borderBottom: '1px solid #e5e6eb', padding: '4px 0', textAlign: 'center', fontSize: 12, lineHeight: '17px' },
  ganttToday: { background: 'rgba(31,111,235,.08)' },
  ganttDayDate: { fontSize: 11, color: '#8f959e', fontVariantNumeric: 'tabular-nums' },
  divider: { borderLeft: '1px solid #f0f1f3' },
  ganttTimeCol: { position: 'relative', borderRight: '1px solid #e5e6eb' },
  ganttTick: { position: 'absolute', right: 6, fontSize: 11, color: '#8f959e', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
  ganttBody: { position: 'relative', gridColumn: '2 / 9', background: '#fafbfc' },
  ganttHLine: { position: 'absolute', left: 0, right: 0, height: 1, background: '#eef0f2' },
  ganttCols: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, display: 'grid', gridTemplateColumns: 'repeat(7, minmax(40px, 1fr))' },
  ganttCol: { position: 'relative', minWidth: 0 },
  ganttColToday: { background: 'rgba(31,111,235,.04)' },
  ganttBar: { position: 'absolute', borderRadius: 4, border: '1px solid rgba(31,111,235,.5)', background: 'rgba(31,111,235,.18)', cursor: 'pointer', overflow: 'hidden', padding: '0 3px', minHeight: 10, textAlign: 'left' },
  ganttBarText: { display: 'block', fontSize: 10, lineHeight: '11px', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', color: '#1d3d7a' },
  summary: { display: 'flex', alignItems: 'center', gap: 8, minHeight: 38, padding: '0 14px', background: '#f7f8fa', border: '1px solid #e5e6eb', borderRadius: 8, fontSize: 12, color: '#4e5969', overflow: 'hidden' },
  summaryActive: { background: '#f2f7ff', borderColor: '#cfe0ff' },
  summaryWeek: { fontSize: 12, fontWeight: 600, color: '#1f2329' },
  summaryStat: { fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
  summaryDot: { color: '#c9cdd4' },
  summaryMuted: { color: '#8f959e', whiteSpace: 'nowrap' },
  summaryDate: { fontSize: 12, fontWeight: 600, color: '#1f6feb', background: '#e8f1ff', borderRadius: 4, padding: '1px 6px', whiteSpace: 'nowrap' },
  summaryTime: { fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', color: '#1f2329' },
  summaryBadge: { fontSize: 11, color: '#1d3d7a', background: '#e8f1ff', borderRadius: 4, padding: '1px 6px', whiteSpace: 'nowrap' },
  summaryText: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  summaryHint: { color: '#8f959e', whiteSpace: 'nowrap' },
}

// ── 注册 ────────────────────────────────────────────────────────────
function register(runtime) {
  runtime.registerModule({ ...MODULE, panel: WorklogPanel })
}

if (typeof window !== 'undefined') {
  if (window.__OA_RUNTIME__) {
    register(window.__OA_RUNTIME__)
  } else {
    window.addEventListener('oa-runtime:ready', (event) => register(event.detail), { once: true })
  }
}

export const inject = []
export function apply() {
  console.log('[oa-worklog] client half ready')
}
