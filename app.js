import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = 'https://kqeplnnvuyseplkfmovy.supabase.co'
const SUPABASE_KEY = 'sb_publishable_0ZLcuKNJp1t7wzLVFRiEIA_Qh3MgWs6'

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const PALETTE = ['#2563eb', '#ea580c', '#0d9488', '#db2777', '#7c3aed', '#ca8a04', '#dc2626', '#16a34a', '#0891b2', '#475569']
const DOWS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

const today = new Date()
const state = {
  session: null,
  me: null,               // my profile row
  profiles: [],
  calendars: [],
  memberships: [],        // mine (or everyone's if owner)
  events: [],
  viewYear: today.getFullYear(),
  viewMonth: today.getMonth(),
  selected: dkey(today),
  hidden: new Set(JSON.parse(localStorage.getItem('wd_hidden') || '[]')),
  channel: null,
  loading: false,
}

const app = document.getElementById('app')
window.__wd = state // debugging aid

/* ---------------- helpers ---------------- */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
function pad(n) { return String(n).padStart(2, '0') }
function dkey(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }
function fromKey(k) { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d) }
function fmtTime(d) { return `${pad(d.getHours())}:${pad(d.getMinutes())}` }
function niceDate(k) {
  const d = fromKey(k)
  return `${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`
}
function genPassword() {
  const bytes = crypto.getRandomValues(new Uint8Array(4))
  return 'Diary-' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 6)
}
function calById(id) { return state.calendars.find((c) => c.id === id) }
function profById(id) { return state.profiles.find((p) => p.id === id) }
function initials(p) { return (p?.name || p?.email || '?').trim().slice(0, 1).toUpperCase() }
function isOwner() { return !!state.me?.is_owner }
function canEdit(calId) {
  if (isOwner()) return true
  return state.memberships.some((m) => m.calendar_id === calId && m.user_id === state.me?.id && m.role === 'editor')
}
function editableCalendars() { return state.calendars.filter((c) => canEdit(c.id)) }
function toast(msg) {
  document.querySelectorAll('.toast').forEach((t) => t.remove())
  const el = document.createElement('div')
  el.className = 'toast'
  el.textContent = msg
  document.body.appendChild(el)
  setTimeout(() => el.remove(), 2600)
}

async function adminCall(body) {
  const { data, error } = await supabase.functions.invoke('admin', { body })
  if (error) {
    let msg = error.message
    try { const j = await error.context.json(); msg = j.error || msg } catch { /* keep msg */ }
    throw new Error(msg)
  }
  if (data?.error) throw new Error(data.error)
  return data
}

/* ---------------- data ---------------- */

async function loadAll() {
  state.loading = true
  const [profs, cals, mems] = await Promise.all([
    supabase.from('profiles').select('*').order('name'),
    supabase.from('calendars').select('*').order('position'),
    supabase.from('memberships').select('*'),
  ])
  state.profiles = profs.data || []
  state.calendars = cals.data || []
  state.memberships = mems.data || []
  state.me = state.profiles.find((p) => p.id === state.session.user.id) || null
  await loadEvents()
  state.loading = false
}

function gridRange() {
  const first = new Date(state.viewYear, state.viewMonth, 1)
  const start = new Date(first)
  start.setDate(1 - ((first.getDay() + 6) % 7)) // back to Monday
  const end = new Date(start)
  end.setDate(start.getDate() + 42)
  return [start, end]
}

async function loadEvents() {
  const [start, end] = gridRange()
  const { data } = await supabase
    .from('events')
    .select('*')
    .lte('starts_at', end.toISOString())
    .gte('ends_at', start.toISOString())
    .order('starts_at')
  state.events = data || []
}

function subscribeRealtime() {
  if (state.channel) supabase.removeChannel(state.channel)
  let timer = null
  const refresh = () => {
    clearTimeout(timer)
    timer = setTimeout(async () => { await loadAll(); renderMain() }, 250)
  }
  state.channel = supabase
    .channel('db-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'events' }, refresh)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'calendars' }, refresh)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'memberships' }, refresh)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, refresh)
    .subscribe()
}

/* ---------------- event helpers ---------------- */

function eventDays(ev) {
  // list of date keys this event touches (capped for safety)
  const days = []
  let d = new Date(ev.starts_at)
  d = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const last = new Date(ev.ends_at)
  for (let i = 0; i < 62 && d <= last; i++) {
    days.push(dkey(d))
    d.setDate(d.getDate() + 1)
  }
  return days
}

function eventsOn(key) {
  const list = state.events.filter((ev) => !state.hidden.has(ev.calendar_id) && eventDays(ev).includes(key))
  return list.sort((a, b) => (b.all_day - a.all_day) || (new Date(a.starts_at) - new Date(b.starts_at)))
}

/* ---------------- auth screen ---------------- */

function renderAuth() {
  app.innerHTML = `
    <div class="auth-wrap">
      <form class="auth-card" id="loginForm">
        <img class="logo" src="./icon.svg" alt="">
        <h1>Work Diary</h1>
        <p>Airborne Construction &amp; Beech House</p>
        <label>Email</label>
        <input type="email" id="loginEmail" autocomplete="username" required autocapitalize="none">
        <label>Password</label>
        <input type="password" id="loginPw" autocomplete="current-password" required>
        <div class="auth-error" id="loginErr"></div>
        <button class="btn" type="submit">Sign in</button>
      </form>
    </div>`
  document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault()
    const err = document.getElementById('loginErr')
    err.textContent = ''
    const btn = e.target.querySelector('.btn')
    btn.disabled = true
    btn.textContent = 'Signing in…'
    const { error } = await supabase.auth.signInWithPassword({
      email: document.getElementById('loginEmail').value.trim(),
      password: document.getElementById('loginPw').value,
    })
    if (error) {
      err.textContent = error.message === 'Invalid login credentials' ? 'Wrong email or password.' : error.message
      btn.disabled = false
      btn.textContent = 'Sign in'
    }
  })
}

/* ---------------- main screen ---------------- */

function renderMain() {
  const monthTitle = `${MONTHS[state.viewMonth]} <span>${state.viewYear}</span>`
  const [gridStart] = gridRange()

  let cells = ''
  const d = new Date(gridStart)
  for (let i = 0; i < 42; i++) {
    const key = dkey(d)
    const inMonth = d.getMonth() === state.viewMonth
    const isToday = key === dkey(new Date())
    const isSel = key === state.selected
    const colors = [...new Set(eventsOn(key).map((ev) => calById(ev.calendar_id)?.color || '#999'))].slice(0, 4)
    cells += `
      <button class="day ${inMonth ? '' : 'dim'} ${isToday ? 'today' : ''} ${isSel ? 'sel' : ''}" data-day="${key}">
        <span class="num">${d.getDate()}</span>
        <span class="dots">${colors.map((c) => `<i style="background:${c}"></i>`).join('')}</span>
      </button>`
    d.setDate(d.getDate() + 1)
  }

  const chips = state.calendars.map((c) => `
    <button class="chip ${state.hidden.has(c.id) ? 'off' : ''}" data-togglecal="${c.id}">
      <span class="dot" style="background:${c.color}"></span>${esc(c.name)}
    </button>`).join('')

  const dayEvents = eventsOn(state.selected)
  const agenda = dayEvents.length
    ? dayEvents.map((ev) => {
        const cal = calById(ev.calendar_id)
        const s = new Date(ev.starts_at)
        const who = profById(ev.created_by)
        const when = ev.all_day ? '<b>all day</b>' : `<b>${fmtTime(s)}</b>${fmtTime(new Date(ev.ends_at))}`
        const meta = [cal?.name, ev.location, who ? `added by ${who.name || who.email}` : null].filter(Boolean).join(' · ')
        return `
          <button class="evt" data-evt="${ev.id}">
            <span class="bar" style="background:${cal?.color || '#999'}"></span>
            <span class="when">${when}</span>
            <span class="body">
              <span class="t">${esc(ev.title)}</span>
              <span class="m">${esc(meta)}</span>
            </span>
          </button>`
      }).join('')
    : '<div class="empty">Nothing on this day</div>'

  app.innerHTML = `
    <div class="topbar">
      <h1>${monthTitle}</h1>
      <button class="todaybtn" id="todayBtn">Today</button>
      <button class="iconbtn" id="prevBtn" aria-label="Previous month">‹</button>
      <button class="iconbtn" id="nextBtn" aria-label="Next month">›</button>
      <button class="iconbtn" id="settingsBtn" aria-label="Settings">⚙︎</button>
    </div>
    <div class="chips">${chips}</div>
    <div class="cal-card">
      <div class="dow">${DOWS.map((x) => `<span>${x}</span>`).join('')}</div>
      <div class="grid">${cells}</div>
    </div>
    <div class="agenda">
      <h2>${niceDate(state.selected)}</h2>
      ${agenda}
    </div>
    ${editableCalendars().length ? '<button class="fab" id="addBtn" aria-label="Add event">+</button>' : ''}
  `

  document.getElementById('prevBtn').onclick = () => shiftMonth(-1)
  document.getElementById('nextBtn').onclick = () => shiftMonth(1)
  document.getElementById('todayBtn').onclick = () => {
    const t = new Date()
    state.viewYear = t.getFullYear(); state.viewMonth = t.getMonth(); state.selected = dkey(t)
    loadEvents().then(renderMain)
  }
  document.getElementById('settingsBtn').onclick = openSettings
  const addBtn = document.getElementById('addBtn')
  if (addBtn) addBtn.onclick = () => openEventSheet(null)
  app.querySelectorAll('[data-day]').forEach((b) => (b.onclick = () => { state.selected = b.dataset.day; renderMain() }))
  app.querySelectorAll('[data-togglecal]').forEach((b) => (b.onclick = () => {
    const id = b.dataset.togglecal
    state.hidden.has(id) ? state.hidden.delete(id) : state.hidden.add(id)
    localStorage.setItem('wd_hidden', JSON.stringify([...state.hidden]))
    renderMain()
  }))
  app.querySelectorAll('[data-evt]').forEach((b) => (b.onclick = () => {
    const ev = state.events.find((x) => x.id === b.dataset.evt)
    if (ev) openEventSheet(ev)
  }))
}

function shiftMonth(delta) {
  const d = new Date(state.viewYear, state.viewMonth + delta, 1)
  state.viewYear = d.getFullYear()
  state.viewMonth = d.getMonth()
  loadEvents().then(renderMain)
}

/* ---------------- sheets ---------------- */

function openSheet(html) {
  closeSheet()
  const ov = document.createElement('div')
  ov.className = 'overlay'
  ov.innerHTML = `<div class="sheet">${html}</div>`
  ov.addEventListener('click', (e) => { if (e.target === ov) closeSheet() })
  document.body.appendChild(ov)
  return ov
}
function closeSheet() { document.querySelectorAll('.overlay').forEach((o) => o.remove()) }

function swatchesHtml(selected) {
  return `<div class="swatches">${PALETTE.map((c) =>
    `<button type="button" class="swatch ${c === selected ? 'sel' : ''}" data-color="${c}" style="background:${c}"></button>`).join('')}</div>`
}
function wireSwatches(root) {
  root.querySelectorAll('.swatch').forEach((s) => (s.onclick = () => {
    root.querySelectorAll('.swatch').forEach((x) => x.classList.remove('sel'))
    s.classList.add('sel')
  }))
}
function pickedColor(root) { return root.querySelector('.swatch.sel')?.dataset.color || PALETTE[0] }

/* ---------------- event sheet ---------------- */

function openEventSheet(ev) {
  const editing = !!ev
  const editable = editing ? canEdit(ev.calendar_id) : true
  const cals = editing && !editable ? state.calendars : editableCalendars()
  const start = editing ? new Date(ev.starts_at) : (() => {
    const d = fromKey(state.selected); const now = new Date()
    d.setHours(now.getHours() + 1, 0, 0, 0); return d
  })()
  const end = editing ? new Date(ev.ends_at) : new Date(start.getTime() + 60 * 60 * 1000)
  const allDay = editing ? ev.all_day : false
  const who = editing ? profById(ev.created_by) : null

  const ov = openSheet(`
    <div class="sheet-head">
      <h2>${editing ? (editable ? 'Edit event' : 'Event') : 'New event'}</h2>
      <button class="close" data-close>Close</button>
    </div>
    <form id="evtForm">
      <label>Title</label>
      <input id="evTitle" required maxlength="120" value="${editing ? esc(ev.title) : ''}" ${editable ? '' : 'disabled'} placeholder="e.g. Site visit — Duxford">
      <label>Calendar</label>
      <select id="evCal" ${editable && (!editing || canEdit(ev.calendar_id)) ? '' : 'disabled'}>
        ${cals.map((c) => `<option value="${c.id}" ${editing && ev.calendar_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
      </select>
      <div class="switchrow">
        <label>All day</label>
        <input type="checkbox" class="switch" id="evAllDay" ${allDay ? 'checked' : ''} ${editable ? '' : 'disabled'}>
      </div>
      <div class="row2">
        <div><label id="evDateLbl">Date</label><input type="date" id="evDate" value="${dkey(start)}" ${editable ? '' : 'disabled'}></div>
        <div id="evEndDateWrap" style="display:${allDay ? '' : 'none'}"><label>End date</label><input type="date" id="evEndDate" value="${dkey(end)}" ${editable ? '' : 'disabled'}></div>
      </div>
      <div class="row2" id="evTimes" style="display:${allDay ? 'none' : ''}">
        <div><label>Start</label><input type="time" id="evStart" value="${fmtTime(start)}" ${editable ? '' : 'disabled'}></div>
        <div><label>End</label><input type="time" id="evEnd" value="${fmtTime(end)}" ${editable ? '' : 'disabled'}></div>
      </div>
      <label>Location</label>
      <input id="evLoc" maxlength="200" value="${editing ? esc(ev.location) : ''}" ${editable ? '' : 'disabled'} placeholder="Address or place">
      <label>Notes</label>
      <textarea id="evNotes" rows="2" maxlength="2000" ${editable ? '' : 'disabled'}>${editing ? esc(ev.notes) : ''}</textarea>
      ${who ? `<div class="meta-line">Added by ${esc(who.name || who.email)}</div>` : ''}
      <div class="form-error" id="evErr"></div>
      ${editable ? '<button class="btn" type="submit">Save</button>' : ''}
      ${editing && editable ? '<button class="btn danger" type="button" id="evDelete">Delete event</button>' : ''}
    </form>
  `)

  ov.querySelector('[data-close]').onclick = closeSheet
  const allDayEl = ov.querySelector('#evAllDay')
  allDayEl.onchange = () => {
    ov.querySelector('#evTimes').style.display = allDayEl.checked ? 'none' : ''
    ov.querySelector('#evEndDateWrap').style.display = allDayEl.checked ? '' : 'none'
  }

  if (!editable) return

  ov.querySelector('#evtForm').onsubmit = async (e) => {
    e.preventDefault()
    const errEl = ov.querySelector('#evErr')
    errEl.textContent = ''
    const dateStr = ov.querySelector('#evDate').value
    if (!dateStr) { errEl.textContent = 'Pick a date.'; return }
    const [y, m, dd] = dateStr.split('-').map(Number)
    let startsAt, endsAt
    if (allDayEl.checked) {
      const endStr = ov.querySelector('#evEndDate').value || dateStr
      const [ey, em, ed] = endStr.split('-').map(Number)
      startsAt = new Date(y, m - 1, dd, 0, 0, 0)
      endsAt = new Date(ey, em - 1, ed, 23, 59, 59)
      if (endsAt < startsAt) { errEl.textContent = 'End date is before start date.'; return }
    } else {
      const [sh, sm] = (ov.querySelector('#evStart').value || '09:00').split(':').map(Number)
      const [eh, em2] = (ov.querySelector('#evEnd').value || '10:00').split(':').map(Number)
      startsAt = new Date(y, m - 1, dd, sh, sm)
      endsAt = new Date(y, m - 1, dd, eh, em2)
      if (endsAt <= startsAt) endsAt = new Date(endsAt.getTime() + 24 * 60 * 60 * 1000) // runs past midnight
    }
    const row = {
      calendar_id: ov.querySelector('#evCal').value,
      title: ov.querySelector('#evTitle').value.trim(),
      location: ov.querySelector('#evLoc').value.trim(),
      notes: ov.querySelector('#evNotes').value.trim(),
      all_day: allDayEl.checked,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
    }
    const q = editing
      ? supabase.from('events').update(row).eq('id', ev.id)
      : supabase.from('events').insert({ ...row, created_by: state.me.id })
    const { error } = await q
    if (error) { errEl.textContent = error.message; return }
    closeSheet()
    state.selected = dateStr
    const nd = fromKey(dateStr)
    state.viewYear = nd.getFullYear(); state.viewMonth = nd.getMonth()
    await loadEvents()
    renderMain()
    toast(editing ? 'Event updated' : 'Event added')
  }

  const del = ov.querySelector('#evDelete')
  if (del) del.onclick = async () => {
    if (!confirm('Delete this event?')) return
    const { error } = await supabase.from('events').delete().eq('id', ev.id)
    if (error) { ov.querySelector('#evErr').textContent = error.message; return }
    closeSheet()
    await loadEvents()
    renderMain()
    toast('Event deleted')
  }
}

/* ---------------- settings ---------------- */

function openSettings() {
  const ownerSections = isOwner() ? `
    <div class="section">
      <h3>Calendars</h3>
      <div class="list">
        ${state.calendars.map((c) => `
          <button class="list-item" data-editcal="${c.id}">
            <span class="dot" style="background:${c.color}"></span>
            <span class="grow">${esc(c.name)}</span>
            <span class="chev">›</span>
          </button>`).join('')}
        <button class="list-item" data-addcal><span class="grow" style="color:var(--accent);font-weight:600">+ Add calendar</span></button>
      </div>
    </div>
    <div class="section">
      <h3>People</h3>
      <div class="list">
        ${state.profiles.map((p) => `
          <button class="list-item" data-editperson="${p.id}">
            <span class="avatar" style="background:${p.color}">${initials(p)}</span>
            <span class="grow">${esc(p.name || p.email)}${p.is_owner ? ' 👑' : ''}<div class="sub">${esc(p.email)}</div></span>
            <span class="chev">›</span>
          </button>`).join('')}
        <button class="list-item" data-addperson><span class="grow" style="color:var(--accent);font-weight:600">+ Add person</span></button>
      </div>
    </div>` : ''

  const ov = openSheet(`
    <div class="sheet-head"><h2>Settings</h2><button class="close" data-close>Close</button></div>
    <div class="section">
      <h3>My details</h3>
      <label>Name</label>
      <input id="myName" value="${esc(state.me?.name || '')}" maxlength="60">
      <label>My colour</label>
      ${swatchesHtml(state.me?.color)}
      <button class="btn secondary slim" id="saveMe" style="margin-top:12px">Save my details</button>
      <label>Change password</label>
      <div class="pwbox">
        <input id="myPw" type="text" placeholder="New password (min 8 characters)" autocomplete="new-password">
        <button class="btn secondary slim" id="savePw" type="button">Change</button>
      </div>
      <div class="form-error" id="meErr"></div>
    </div>
    ${ownerSections}
    <button class="btn danger" id="signOut">Sign out</button>
  `)

  ov.querySelector('[data-close]').onclick = closeSheet
  wireSwatches(ov)

  ov.querySelector('#saveMe').onclick = async () => {
    const { error } = await supabase.from('profiles')
      .update({ name: ov.querySelector('#myName').value.trim(), color: pickedColor(ov) })
      .eq('id', state.me.id)
    if (error) { ov.querySelector('#meErr').textContent = error.message; return }
    await loadAll(); renderMain(); toast('Saved')
  }
  ov.querySelector('#savePw').onclick = async () => {
    const pw = ov.querySelector('#myPw').value
    if (pw.length < 8) { ov.querySelector('#meErr').textContent = 'Password needs at least 8 characters.'; return }
    const { error } = await supabase.auth.updateUser({ password: pw })
    ov.querySelector('#meErr').textContent = error ? error.message : ''
    if (!error) { ov.querySelector('#myPw').value = ''; toast('Password changed') }
  }
  ov.querySelector('#signOut').onclick = async () => { await supabase.auth.signOut() }

  if (isOwner()) {
    ov.querySelectorAll('[data-editcal]').forEach((b) => (b.onclick = () => openCalendarSheet(calById(b.dataset.editcal))))
    const addCal = ov.querySelector('[data-addcal]'); if (addCal) addCal.onclick = () => openCalendarSheet(null)
    ov.querySelectorAll('[data-editperson]').forEach((b) => (b.onclick = () => openPersonSheet(profById(b.dataset.editperson))))
    const addP = ov.querySelector('[data-addperson]'); if (addP) addP.onclick = () => openPersonSheet(null)
  }
}

function openCalendarSheet(cal) {
  const ov = openSheet(`
    <div class="sheet-head"><h2>${cal ? 'Edit calendar' : 'New calendar'}</h2><button class="close" data-close>Close</button></div>
    <label>Name</label>
    <input id="calName" value="${cal ? esc(cal.name) : ''}" maxlength="60" placeholder="e.g. Airborne Jobs">
    <label>Colour</label>
    ${swatchesHtml(cal?.color || PALETTE[0])}
    <div class="form-error" id="calErr"></div>
    <button class="btn" id="calSave">Save</button>
    ${cal ? '<button class="btn danger" id="calDelete">Delete calendar and all its events</button>' : ''}
  `)
  ov.querySelector('[data-close]').onclick = () => { closeSheet(); openSettings() }
  wireSwatches(ov)
  ov.querySelector('#calSave').onclick = async () => {
    const name = ov.querySelector('#calName').value.trim()
    if (!name) { ov.querySelector('#calErr').textContent = 'Give it a name.'; return }
    const row = { name, color: pickedColor(ov) }
    const q = cal
      ? supabase.from('calendars').update(row).eq('id', cal.id)
      : supabase.from('calendars').insert({ ...row, position: state.calendars.length })
    const { error } = await q
    if (error) { ov.querySelector('#calErr').textContent = error.message; return }
    await loadAll(); renderMain(); closeSheet(); openSettings(); toast('Saved')
  }
  const del = ov.querySelector('#calDelete')
  if (del) del.onclick = async () => {
    if (!confirm(`Delete "${cal.name}" and every event on it? This cannot be undone.`)) return
    const { error } = await supabase.from('calendars').delete().eq('id', cal.id)
    if (error) { ov.querySelector('#calErr').textContent = error.message; return }
    await loadAll(); renderMain(); closeSheet(); openSettings(); toast('Calendar deleted')
  }
}

function roleFor(personId, calId) {
  return state.memberships.find((m) => m.user_id === personId && m.calendar_id === calId)?.role || ''
}

function rolesGridHtml(personId) {
  return `<div class="rolegrid">${state.calendars.map((c) => `
    <span class="cname"><span class="dot" style="background:${c.color};width:10px;height:10px;border-radius:50%;display:inline-block"></span>${esc(c.name)}</span>
    <select data-rolecal="${c.id}">
      <option value="" ${roleFor(personId, c.id) === '' ? 'selected' : ''}>No access</option>
      <option value="viewer" ${roleFor(personId, c.id) === 'viewer' ? 'selected' : ''}>Can view</option>
      <option value="editor" ${roleFor(personId, c.id) === 'editor' ? 'selected' : ''}>Can edit</option>
    </select>`).join('')}</div>`
}

function collectRoles(ov) {
  return [...ov.querySelectorAll('[data-rolecal]')]
    .map((s) => ({ calendar_id: s.dataset.rolecal, role: s.value }))
    .filter((m) => m.role)
}

function openPersonSheet(person) {
  const isMe = person && person.id === state.me.id
  const ov = openSheet(person ? `
    <div class="sheet-head"><h2>${esc(person.name || person.email)}</h2><button class="close" data-close>Close</button></div>
    <div class="meta-line">${esc(person.email)}${person.is_owner ? ' — owner (sees and edits everything)' : ''}</div>
    ${person.is_owner ? '' : `
      <div class="section"><h3>Calendar access</h3>${rolesGridHtml(person.id)}
      <button class="btn" id="saveRoles" style="margin-top:14px">Save access</button></div>`}
    <div class="section"><h3>Reset password</h3>
      <div class="pwbox">
        <input id="newPw" type="text" value="${genPassword()}">
        <button class="btn secondary slim" id="resetPw">Set</button>
      </div>
      <div class="meta-line">Set it, then text or tell them the new password.</div>
    </div>
    <div class="form-error" id="pErr"></div>
    ${isMe || person.is_owner ? '' : '<button class="btn danger" id="removePerson">Remove this person</button>'}
  ` : `
    <div class="sheet-head"><h2>Add person</h2><button class="close" data-close>Close</button></div>
    <label>Name</label>
    <input id="pName" maxlength="60" placeholder="e.g. Nicole">
    <label>Email (this becomes their login)</label>
    <input id="pEmail" type="email" autocapitalize="none" placeholder="name@example.com">
    <label>Password (share it with them; they can change it later)</label>
    <div class="pwbox"><input id="pPw" type="text" value="${genPassword()}"></div>
    <label>Their colour</label>
    ${swatchesHtml(PALETTE[3])}
    <div class="section"><h3>Calendar access</h3>${rolesGridHtml('new')}</div>
    <div class="form-error" id="pErr"></div>
    <button class="btn" id="createPerson">Create login</button>
  `)
  ov.querySelector('[data-close]').onclick = () => { closeSheet(); openSettings() }
  if (!person) wireSwatches(ov)

  const errEl = () => ov.querySelector('#pErr')

  if (person) {
    const saveRoles = ov.querySelector('#saveRoles')
    if (saveRoles) saveRoles.onclick = async () => {
      try {
        await adminCall({ action: 'set_memberships', user_id: person.id, memberships: collectRoles(ov) })
        await loadAll(); renderMain(); toast('Access updated')
      } catch (e) { errEl().textContent = e.message }
    }
    ov.querySelector('#resetPw').onclick = async () => {
      const pw = ov.querySelector('#newPw').value
      if (pw.length < 8) { errEl().textContent = 'Password needs at least 8 characters.'; return }
      try {
        await adminCall({ action: 'set_password', user_id: person.id, password: pw })
        toast('Password set — let them know')
      } catch (e) { errEl().textContent = e.message }
    }
    const rm = ov.querySelector('#removePerson')
    if (rm) rm.onclick = async () => {
      if (!confirm(`Remove ${person.name || person.email}? They will no longer be able to sign in.`)) return
      try {
        await adminCall({ action: 'delete_user', user_id: person.id })
        await loadAll(); renderMain(); closeSheet(); openSettings(); toast('Person removed')
      } catch (e) { errEl().textContent = e.message }
    }
  } else {
    ov.querySelector('#createPerson').onclick = async () => {
      const email = ov.querySelector('#pEmail').value.trim().toLowerCase()
      const name = ov.querySelector('#pName').value.trim()
      const pw = ov.querySelector('#pPw').value
      if (!name || !email) { errEl().textContent = 'Name and email are both needed.'; return }
      if (pw.length < 8) { errEl().textContent = 'Password needs at least 8 characters.'; return }
      const roles = collectRoles(ov)
      if (!roles.length) { errEl().textContent = 'Give them access to at least one calendar.'; return }
      try {
        await adminCall({ action: 'create_user', email, password: pw, name, color: pickedColor(ov), memberships: roles })
        await loadAll(); renderMain(); closeSheet(); openSettings()
        toast(`${name} added — their password is ${pw}`)
      } catch (e) { errEl().textContent = e.message }
    }
  }
}

/* ---------------- boot ---------------- */

async function start() {
  const { data: { session } } = await supabase.auth.getSession()
  state.session = session
  supabase.auth.onAuthStateChange(async (event, sess) => {
    const hadSession = !!state.session
    state.session = sess
    if (event === 'SIGNED_IN' && !hadSession) {
      await loadAll(); subscribeRealtime(); renderMain()
    }
    if (event === 'SIGNED_OUT') {
      if (state.channel) supabase.removeChannel(state.channel)
      renderAuth()
    }
  })
  if (session) {
    await loadAll()
    subscribeRealtime()
    renderMain()
  } else {
    renderAuth()
  }
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {})
start()
