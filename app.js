const STORAGE_KEY = "summer-board-prototype-v1";
const PROFILE_STORAGE_KEY = "summer-board-active-profile-v1";
const DAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"];
const PARENT = { id: "parent", name: "おかあ", color: "#e9969f" };
const CHILD_DISPLAY = {
  child1: { name: "りょう", color: "#72a9dc" },
  child2: { name: "しゅん", color: "#69b98b" }
};
const cloud = {
  client: null,
  user: null,
  familyId: null,
  ready: false,
  syncing: false,
  refreshTimer: null,
  profileToken: null,
  activeProfile: null,
  members: [],
  pinsConfigured: false
};

function toDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDateKey(key) {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function createInitialState() {
  const today = new Date();
  const todayKey = toDateKey(today);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return {
    people: [
      { id: "child1", name: "りょう", color: "#72a9dc" },
      { id: "child2", name: "しゅん", color: "#69b98b" }
    ],
    selectedPerson: "child1",
    selectedDate: todayKey,
    calendarDate: todayKey,
    monthlyHelpDate: todayKey,
    monthlyHelpMode: "table",
    manageFilter: "all",
    tasks: [
      { id: crypto.randomUUID(), title: "算数ドリル 2ページ", category: "study", assignee: "child1", scheduleType: "weekly", weekdays: [1, 2, 3, 4, 5], active: true },
      { id: crypto.randomUUID(), title: "音読", category: "study", assignee: "both", scheduleType: "daily", weekdays: [], active: true },
      { id: crypto.randomUUID(), title: "読書 20分", category: "study", assignee: "child2", scheduleType: "weekly", weekdays: [1, 3, 5], active: true },
      { id: crypto.randomUUID(), title: "食器を片づける", category: "help", assignee: "both", scheduleType: "daily", weekdays: [], active: true },
      { id: crypto.randomUUID(), title: "お風呂そうじ", category: "help", assignee: "child1", scheduleType: "weekly", weekdays: [2, 4, 6], active: true },
      { id: crypto.randomUUID(), title: "洗濯ものをたたむ", category: "help", assignee: "child2", scheduleType: "weekly", weekdays: [1, 3, 5], active: true }
    ],
    completions: {},
    helpRequests: {},
    dailyNotes: {},
    events: [
      { id: crypto.randomUUID(), date: todayKey, title: "夏休みの予定を家族で確認", startTime: "19:00", endTime: "19:30", owner: "family" },
      { id: crypto.randomUUID(), date: toDateKey(tomorrow), title: "塾", startTime: "10:00", endTime: "11:00", owner: "child1" }
    ]
  };
}

let state = loadState();
let currentView = "today";
let toastTimer;
const dailyNoteTimers = {};

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved?.tasks && saved?.people) {
      saved.people = normalizePeople(saved.people);
      saved.tasks = saved.tasks.map(task => ({
        ...task,
        scheduleType: task.scheduleType || (task.weekdays?.length === 7 ? "daily" : "weekly"),
        weekdays: task.weekdays || [],
        dateMoves: task.dateMoves || []
      }));
      saved.dailyNotes = saved.dailyNotes || {};
      saved.helpRequests = saved.helpRequests || {};
      saved.monthlyHelpDate = saved.monthlyHelpDate || saved.calendarDate || toDateKey(new Date());
      saved.monthlyHelpMode = saved.monthlyHelpMode || "table";
      return saved;
    }
    return createInitialState();
  } catch {
    return createInitialState();
  }
}

function normalizePeople(people) {
  return people.map(person => CHILD_DISPLAY[person.id] ? { ...person, ...CHILD_DISPLAY[person.id] } : person);
}

function saveState(message) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  setSaveStatus(cloud.ready ? "家族と同期済み" : "この端末に保存中");
  if (message) showToast(message);
}

function setSaveStatus(message, isError = false) {
  const status = document.getElementById("saveStatus");
  status.innerHTML = `<span${isError ? ' class="status-error"' : ""}></span> ${message}`;
}

function scheduleForCloud(task) {
  return {
    weekdays: task.weekdays || [],
    onceDate: task.onceDate || "",
    anytimeStartDate: task.anytimeStartDate || "",
    biweeklyStartDate: task.biweeklyStartDate || "",
    dateMoves: task.dateMoves || []
  };
}

function taskFromCloud(row) {
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    assignee: row.assignee_key,
    scheduleType: row.schedule_type,
    weekdays: row.schedule?.weekdays || [],
    onceDate: row.schedule?.onceDate || "",
    anytimeStartDate: row.schedule?.anytimeStartDate || "",
    biweeklyStartDate: row.schedule?.biweeklyStartDate || "",
    dateMoves: row.schedule?.dateMoves || [],
    active: row.active
  };
}

function eventFromCloud(row) {
  return {
    id: row.id,
    date: row.event_date,
    title: row.title,
    startTime: row.start_time ? row.start_time.slice(0, 5) : "",
    endTime: row.end_time ? row.end_time.slice(0, 5) : "",
    owners: row.owner_keys || ["family"],
    externalUid: row.external_uid || ""
  };
}

function cloudCompletionRows() {
  return Object.entries(state.completions)
    .filter(([, complete]) => complete)
    .map(([key]) => {
      const [completedOn, memberKey, taskId] = key.split(":");
      return { family_id: cloud.familyId, task_id: taskId, member_key: memberKey, completed_on: completedOn };
    });
}

function dailyNoteKey(dateKey, personId, category) {
  return `${dateKey}:${personId}:${category}`;
}

function dailyNoteValue(dateKey, personId, category) {
  return state.dailyNotes?.[dailyNoteKey(dateKey, personId, category)] || "";
}

function dailyNoteFromCloud(row) {
  return [dailyNoteKey(row.note_date, row.member_key, row.category), row.body || ""];
}

function cloudDailyNoteRows() {
  return Object.entries(state.dailyNotes || {})
    .filter(([, body]) => body.trim())
    .map(([key, body]) => {
      const [note_date, member_key, category] = key.split(":");
      return { family_id: cloud.familyId, note_date, member_key, category, body: body.trim() };
    });
}

function taskToCloudRow(task) {
  return {
    id: task.id,
    family_id: cloud.familyId,
    title: task.title,
    category: task.category,
    assignee_key: task.assignee,
    schedule_type: task.scheduleType,
    schedule: scheduleForCloud(task),
    active: task.active
  };
}

function eventToCloudRow(item) {
  return {
    id: item.id,
    family_id: cloud.familyId,
    event_date: item.date,
    title: item.title,
    start_time: item.startTime || null,
    end_time: item.endTime || null,
    owner_keys: eventOwnerIds(item),
    external_uid: item.externalUid || null
  };
}

async function runCloudWrite(writeAction) {
  if (!cloud.ready) return;
  cloud.syncing = true;
  setSaveStatus("同期中…");
  try {
    const result = await writeAction();
    if (result?.error) throw result.error;
    setSaveStatus("家族と同期済み");
  } catch (error) {
    console.error(error);
    setSaveStatus("同期できませんでした", true);
    showToast("同期できませんでした。通信を確認してください");
  } finally {
    cloud.syncing = false;
  }
}

function syncTask(task) {
  return runCloudWrite(() => cloud.client.rpc("save_family_task", { p_token: cloud.profileToken, p_task: taskToCloudRow(task) }));
}

function deleteCloudTask(taskId) {
  return runCloudWrite(() => cloud.client.rpc("delete_family_task", { p_token: cloud.profileToken, p_task_id: taskId }));
}

function syncEvent(item) {
  return runCloudWrite(() => cloud.client.rpc("save_family_event", { p_token: cloud.profileToken, p_event: eventToCloudRow(item) }));
}

function syncEvents(items) {
  if (!items.length) return Promise.resolve();
  return Promise.all(items.map(syncEvent));
}

function deleteCloudEvent(eventId) {
  return runCloudWrite(() => cloud.client.rpc("delete_family_event", { p_token: cloud.profileToken, p_event_id: eventId }));
}

function syncCompletion(taskId, memberKey, completedOn, completed) {
  return runCloudWrite(() => cloud.client.rpc("set_family_task_completion", {
    p_token: cloud.profileToken, p_task_id: taskId, p_member_key: memberKey,
    p_completed_on: completedOn, p_completed: completed
  }));
}

function syncHelpRequest(taskId, memberKey, requestedOn, cancel = false) {
  return runCloudWrite(() => cloud.client.rpc("set_family_help_request", {
    p_token: cloud.profileToken, p_task_id: taskId, p_member_key: memberKey,
    p_requested_on: requestedOn, p_cancel: cancel
  }));
}

function decideHelpRequest(taskId, memberKey, requestedOn, approve) {
  return runCloudWrite(() => cloud.client.rpc("decide_family_help_request", {
    p_token: cloud.profileToken, p_task_id: taskId, p_member_key: memberKey,
    p_requested_on: requestedOn, p_approve: approve
  }));
}

function syncDailyNote(dateKey, memberKey, category, body) {
  return runCloudWrite(() => cloud.client.rpc("save_family_daily_note", {
    p_token: cloud.profileToken, p_note_date: dateKey, p_member_key: memberKey,
    p_category: category, p_body: body.trim()
  }));
}

async function loadCloudState() {
  const [profileResult, taskResult, eventResult, completionResult, requestResult] = await Promise.all([
    cloud.client.from("family_members").select("profile_key, display_name, color, role, sort_order, permissions, pin_set_at").eq("family_id", cloud.familyId).order("sort_order"),
    cloud.client.from("tasks").select("*").eq("family_id", cloud.familyId),
    cloud.client.from("calendar_events").select("*").eq("family_id", cloud.familyId),
    cloud.client.from("task_completions").select("task_id, member_key, completed_on").eq("family_id", cloud.familyId),
    cloud.client.from("help_requests").select("task_id, member_key, requested_on, status, requested_at").eq("family_id", cloud.familyId)
  ]);
  const error = [profileResult, taskResult, eventResult, completionResult, requestResult].find(result => result.error)?.error;
  if (error) throw error;

  const children = normalizePeople(profileResult.data.filter(member => member.role === "child").map(member => ({ id: member.profile_key, name: member.display_name, color: member.color })));
  if (children.length) state.people = children;
  state.tasks = taskResult.data.map(taskFromCloud);
  state.events = eventResult.data.map(eventFromCloud);
  state.completions = Object.fromEntries(completionResult.data.map(row => [completionKey(row.completed_on, row.member_key, row.task_id), true]));
  state.helpRequests = Object.fromEntries(requestResult.data.map(row => [requestKey(row.requested_on, row.member_key, row.task_id), row]));
  cloud.members = profileResult.data.map(member => ({
    id: member.profile_key,
    name: CHILD_DISPLAY[member.profile_key]?.name || member.display_name,
    color: CHILD_DISPLAY[member.profile_key]?.color || member.color,
    role: member.role,
    permissions: member.permissions || {}
  }));
  cloud.pinsConfigured = profileResult.data.length > 0 && profileResult.data.every(member => Boolean(member.pin_set_at));
  const { data: noteRows, error: noteError } = await cloud.client
    .from("daily_notes").select("note_date, member_key, category, body").eq("family_id", cloud.familyId);
  if (!noteError) state.dailyNotes = Object.fromEntries(noteRows.map(dailyNoteFromCloud));
  if (!state.people.some(person => person.id === state.selectedPerson)) state.selectedPerson = state.people[0]?.id || "child1";
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

async function removeMissingCloudRows(table, ids) {
  const { data, error } = await cloud.client.from(table).select("id").eq("family_id", cloud.familyId);
  if (error) throw error;
  const missing = data.filter(row => !ids.has(row.id));
  await Promise.all(missing.map(row => cloud.client.from(table).delete().eq("id", row.id)));
}

async function syncCloudState() {
  if (!cloud.ready || cloud.syncing) return;
  cloud.syncing = true;
  setSaveStatus("同期中…");
  try {
    const taskRows = state.tasks.map(taskToCloudRow);
    const eventRows = state.events.map(eventToCloudRow);
    const completionRows = cloudCompletionRows();
    const dailyNoteRows = cloudDailyNoteRows();
    if (taskRows.length) {
      const { error } = await cloud.client.from("tasks").upsert(taskRows);
      if (error) throw error;
    }
    if (eventRows.length) {
      const { error } = await cloud.client.from("calendar_events").upsert(eventRows);
      if (error) throw error;
    }
    if (completionRows.length) {
      const { error } = await cloud.client.from("task_completions").upsert(completionRows);
      if (error) throw error;
    }
    if (dailyNoteRows.length) {
      const { error } = await cloud.client.from("daily_notes").upsert(dailyNoteRows);
      if (error) throw error;
    }
    await removeMissingCloudRows("tasks", new Set(state.tasks.map(task => task.id)));
    await removeMissingCloudRows("calendar_events", new Set(state.events.map(item => item.id)));

    const { data: currentCompletions, error: completionError } = await cloud.client
      .from("task_completions").select("task_id, member_key, completed_on").eq("family_id", cloud.familyId);
    if (completionError) throw completionError;
    const wanted = new Set(completionRows.map(row => `${row.completed_on}:${row.member_key}:${row.task_id}`));
    await Promise.all(currentCompletions
      .filter(row => !wanted.has(`${row.completed_on}:${row.member_key}:${row.task_id}`))
      .map(row => cloud.client.from("task_completions").delete().eq("task_id", row.task_id).eq("member_key", row.member_key).eq("completed_on", row.completed_on)));
    setSaveStatus("家族と同期済み");
  } catch (error) {
    console.error(error);
    setSaveStatus("同期できませんでした", true);
    showToast("同期できませんでした。通信を確認してください");
  } finally {
    cloud.syncing = false;
  }
}

async function refreshCloudState() {
  if (!cloud.ready || cloud.syncing || document.querySelector("dialog[open]")) return;
  try {
    await loadCloudState();
    renderAll();
    setSaveStatus("家族と同期済み");
  } catch (error) {
    console.error(error);
    setSaveStatus("更新を確認できませんでした", true);
  }
}

function showAuthMessage(message) {
  document.getElementById("authMessage").textContent = message;
}

function canPersistAuthSession() {
  const testKey = "summer-board-auth-storage-test";
  try {
    localStorage.setItem(testKey, "ok");
    localStorage.removeItem(testKey);
    return true;
  } catch (error) {
    console.error("認証情報の保存領域を利用できません。", error);
    return false;
  }
}

async function verifyPersistedSession(expectedUserId) {
  const { data, error } = await cloud.client.auth.getSession();
  if (error) throw error;
  return data.session?.user?.id === expectedUserId;
}

function isParent() {
  return cloud.activeProfile?.role === "parent";
}

function isOwnProfile(personId) {
  return isParent() || cloud.activeProfile?.id === personId;
}

function canManageTask(task) {
  if (isParent()) return true;
  return cloud.activeProfile?.permissions?.manage_study === true && task?.category === "study" && task.assignee === cloud.activeProfile.id;
}

function profileStorage() {
  try { return JSON.parse(localStorage.getItem(PROFILE_STORAGE_KEY)) || null; } catch { return null; }
}

function showProfileScreen() {
  document.getElementById("profileScreen").hidden = false;
  document.getElementById("pinUnlockForm").hidden = true;
  document.getElementById("profileGrid").hidden = false;
  document.getElementById("profileTitle").textContent = "プロフィールを選ぶ";
  document.getElementById("profileLead").textContent = "自分のアイコンを選んでください。";
  document.getElementById("profileGrid").innerHTML = cloud.members.map(member => `<button class="profile-choice" style="--person-color:${member.color}" data-unlock-profile="${member.id}" type="button"><span>${member.role === "parent" ? "🐱" : "🐾"}</span><strong>${escapeHtml(member.name)}</strong></button>`).join("");
}

function showPinSetup() {
  document.getElementById("profileScreen").hidden = false;
  document.getElementById("profileGrid").hidden = true;
  document.getElementById("pinUnlockForm").hidden = true;
  document.getElementById("pinSetupForm").hidden = false;
  document.getElementById("profileTitle").textContent = "家族のPINを設定";
  document.getElementById("profileLead").textContent = "PINを忘れたときは親プロフィールから再設定できます。";
  document.getElementById("pinSetupFields").innerHTML = cloud.members.map(member => `<label>${escapeHtml(member.name)}（${member.role === "parent" ? "親" : "子ども"}）<input name="${member.id}" type="password" inputmode="numeric" autocomplete="off" pattern="[0-9]{4}" maxlength="4" required /></label>`).join("");
}

function activateProfile(profile, token) {
  cloud.activeProfile = profile;
  cloud.profileToken = token;
  localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify({ token, profileId: profile.id }));
  if (profile.role === "child") state.selectedPerson = profile.id;
  document.getElementById("profileScreen").hidden = true;
  document.getElementById("pinSetupForm").hidden = true;
  const button = document.getElementById("currentProfileButton");
  button.hidden = false;
  button.style.setProperty("--person-color", profile.color);
  document.getElementById("currentProfileName").textContent = `現在：${profile.name}`;
  document.getElementById("currentProfileDot").style.background = profile.color;
  renderAll();
}

async function restoreOrChooseProfile() {
  if (!cloud.pinsConfigured) { showPinSetup(); return; }
  const saved = profileStorage();
  if (saved?.token) {
    const { data } = await cloud.client.rpc("resume_family_profile", { p_token: saved.token });
    const profile = cloud.members.find(member => member.id === data?.profile_key);
    if (profile) { activateProfile(profile, saved.token); return; }
  }
  localStorage.removeItem(PROFILE_STORAGE_KEY);
  showProfileScreen();
}

async function startFamilySession(user) {
  cloud.user = user;
  showAuthMessage("家族のデータを準備しています…");
  const { data: membership, error: membershipError } = await cloud.client
    .from("family_users").select("family_id").eq("user_id", user.id).maybeSingle();
  if (membershipError) throw membershipError;
  let createdFamily = false;
  if (membership?.family_id) {
    cloud.familyId = membership.family_id;
  } else {
    const { data, error } = await cloud.client.rpc("bootstrap_family", { p_family_name: "わが家" });
    if (error) throw error;
    cloud.familyId = data;
    createdFamily = true;
  }
  if (createdFamily) {
    cloud.ready = true;
    await syncCloudState();
  } else {
    await loadCloudState();
    cloud.ready = true;
  }
  document.getElementById("authScreen").hidden = true;
  document.getElementById("signOutButton").hidden = false;
  setSaveStatus("家族と同期済み");
  await restoreOrChooseProfile();
  clearInterval(cloud.refreshTimer);
  cloud.refreshTimer = window.setInterval(refreshCloudState, 12000);
}

async function initializeOnlineApp() {
  const config = window.SUMMER_BOARD_SUPABASE;
  if (!config?.url || !config?.publishableKey || !window.supabase) {
    showAuthMessage("接続の設定が見つかりませんでした。");
    return;
  }
  if (!canPersistAuthSession()) {
    showAuthMessage("この端末ではログイン状態を保存できません。プライベートブラウズやSafariの設定を確認してください。");
    return;
  }
  cloud.client = window.supabase.createClient(config.url, config.publishableKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storage: window.localStorage
    }
  });
  const { data: { session }, error: sessionError } = await cloud.client.auth.getSession();
  if (sessionError) {
    console.error("ログイン状態を復元できませんでした。", sessionError);
    showAuthMessage("保存したログイン状態を読み込めませんでした。もう一度ログインしてください。");
  }
  if (session?.user) {
    try {
      await startFamilySession(session.user);
    } catch (error) {
      console.error(error);
      showAuthMessage("準備中に問題がありました。もう一度ログインしてください。");
    }
  } else if (!sessionError) {
    showAuthMessage("初めてなら「家族用ログインを作る」を押してください。");
  }
  cloud.client.auth.onAuthStateChange(async (_event, session) => {
    if (session?.user && !cloud.ready) {
      try { await startFamilySession(session.user); } catch (error) { console.error(error); showAuthMessage("準備中に問題がありました。"); }
    }
  });
}

function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 1800);
}

function personById(id) {
  return state.people.find(person => person.id === id);
}

function ownerDetails(owner) {
  if (owner === "family") return { name: "家族", color: "#f0a64b" };
  if (owner === PARENT.id) return PARENT;
  return personById(owner) || { name: "家族", color: "#f0a64b" };
}

function eventOwnerIds(event) {
  return event.owners?.length ? event.owners : [event.owner || "family"];
}

function eventStartTime(event) {
  return event.startTime || event.time || "";
}

function formatEventTime(event) {
  const start = eventStartTime(event);
  const end = event.endTime || "";
  if (start && end) return `${start}〜${end}`;
  if (start) return start;
  if (end) return `〜${end}`;
  return "";
}

function escapeIcsText(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
}

function unescapeIcsText(value) {
  return String(value).replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
}

function foldIcsLine(line) {
  const encoder = new TextEncoder();
  const folded = [];
  let current = "";
  for (const character of line) {
    const prefix = folded.length ? " " : "";
    if (current && encoder.encode(prefix + current + character).length > 74) {
      folded.push(`${folded.length ? " " : ""}${current}`);
      current = character;
    } else {
      current += character;
    }
  }
  folded.push(`${folded.length ? " " : ""}${current}`);
  return folded.join("\r\n");
}

function compactIcsDate(dateKey) {
  return dateKey.replace(/-/g, "");
}

function compactIcsTime(time) {
  return time.replace(":", "") + "00";
}

function nextDateKey(dateKey) {
  const date = parseDateKey(dateKey);
  date.setDate(date.getDate() + 1);
  return toDateKey(date);
}

function buildIcsCalendar(events) {
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Summer Board//JA",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH"
  ];
  events.forEach(event => {
    const start = eventStartTime(event);
    const end = event.endTime || "";
    const ownerNames = eventOwnerIds(event).map(owner => ownerDetails(owner).name).join("、");
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${escapeIcsText(event.externalUid || `summer-board-${event.id}@local`)}`);
    lines.push(`DTSTAMP:${timestamp}`);
    lines.push(`SUMMARY:${escapeIcsText(event.title)}`);
    if (start) {
      lines.push(`DTSTART:${compactIcsDate(event.date)}T${compactIcsTime(start)}`);
      if (end) {
        const endDate = end <= start ? nextDateKey(event.date) : event.date;
        lines.push(`DTEND:${compactIcsDate(endDate)}T${compactIcsTime(end)}`);
      }
    } else {
      lines.push(`DTSTART;VALUE=DATE:${compactIcsDate(event.date)}`);
      lines.push(`DTEND;VALUE=DATE:${compactIcsDate(nextDateKey(event.date))}`);
      if (end) lines.push(`X-SUMMER-END-TIME:${end}`);
    }
    lines.push(`DESCRIPTION:${escapeIcsText(`夏やすみボード担当: ${ownerNames}`)}`);
    lines.push(`X-SUMMER-OWNERS:${eventOwnerIds(event).join(",")}`);
    lines.push("END:VEVENT");
  });
  lines.push("END:VCALENDAR");
  return lines.map(foldIcsLine).join("\r\n") + "\r\n";
}

function getIcsProperty(lines, propertyName) {
  const line = lines.find(item => item.split(":", 1)[0].split(";", 1)[0].toUpperCase() === propertyName);
  if (!line) return null;
  const separator = line.indexOf(":");
  return { key: line.slice(0, separator), value: line.slice(separator + 1) };
}

function parseIcsTemporal(property) {
  if (!property) return null;
  const value = property.value.trim();
  const dateOnly = property.key.toUpperCase().includes("VALUE=DATE") || /^\d{8}$/.test(value);
  if (dateOnly) return { date: `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`, time: "", dateOnly: true };
  const match = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/);
  if (!match) return null;
  if (value.endsWith("Z")) {
    const local = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5])));
    return { date: toDateKey(local), time: `${String(local.getHours()).padStart(2, "0")}:${String(local.getMinutes()).padStart(2, "0")}`, dateOnly: false };
  }
  return { date: `${match[1]}-${match[2]}-${match[3]}`, time: `${match[4]}:${match[5]}`, dateOnly: false };
}

function parseIcsCalendar(text) {
  const unfolded = text.replace(/\r?\n[ \t]/g, "");
  const blocks = unfolded.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/gi) || [];
  return blocks.map(block => {
    const lines = block.split(/\r?\n/);
    const summary = getIcsProperty(lines, "SUMMARY");
    const start = parseIcsTemporal(getIcsProperty(lines, "DTSTART"));
    if (!summary || !start) return null;
    const endProperty = getIcsProperty(lines, "DTEND");
    const end = parseIcsTemporal(endProperty);
    const uid = getIcsProperty(lines, "UID")?.value.trim() || "";
    const customOwners = getIcsProperty(lines, "X-SUMMER-OWNERS")?.value.split(",").filter(Boolean) || [];
    const knownOwnerIds = new Set(["family", PARENT.id, ...state.people.map(person => person.id)]);
    const owners = customOwners.filter(owner => knownOwnerIds.has(owner));
    const customEndTime = getIcsProperty(lines, "X-SUMMER-END-TIME")?.value || "";
    return {
      id: crypto.randomUUID(),
      externalUid: uid,
      date: start.date,
      title: unescapeIcsText(summary.value),
      startTime: start.dateOnly ? "" : start.time,
      endTime: start.dateOnly ? customEndTime : (end?.time || ""),
      owners: owners.length ? owners : ["family"]
    };
  }).filter(Boolean);
}

function eventFingerprint(event) {
  return [event.date, eventStartTime(event), event.endTime || "", event.title.trim()].join("|");
}

function importIcsEvents(importedEvents) {
  const knownUids = new Set(state.events.flatMap(event => [event.externalUid, `summer-board-${event.id}@local`]).filter(Boolean));
  const knownFingerprints = new Set(state.events.map(eventFingerprint));
  let importedCount = 0;
  let skippedCount = 0;
  const addedEvents = [];
  importedEvents.forEach(event => {
    if ((event.externalUid && knownUids.has(event.externalUid)) || knownFingerprints.has(eventFingerprint(event))) {
      skippedCount += 1;
      return;
    }
    state.events.push(event);
    addedEvents.push(event);
    if (event.externalUid) knownUids.add(event.externalUid);
    knownFingerprints.add(eventFingerprint(event));
    importedCount += 1;
  });
  return { importedCount, skippedCount, addedEvents };
}

function formatLongDate(key) {
  const date = parseDateKey(key);
  return `${date.getMonth() + 1}月${date.getDate()}日（${DAY_LABELS[date.getDay()]}）`;
}

function appliesToPerson(task, personId) {
  return task.assignee === "both" || task.assignee === personId;
}

function dateDayNumber(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
}

function anytimeCompletionDate(taskId, personId) {
  const suffix = `:${personId}:${taskId}`;
  return Object.keys(state.completions).filter(key => state.completions[key] && key.endsWith(suffix)).map(key => key.slice(0, 10)).sort()[0] || "";
}

function taskMatchesBaseDate(task, dateKey, personId) {
  if (task.scheduleType === "once") return task.onceDate === dateKey;
  if (task.scheduleType === "anytime") {
    if (!task.anytimeStartDate || dateKey < task.anytimeStartDate) return false;
    const completedDate = anytimeCompletionDate(task.id, personId);
    return !completedDate || dateKey <= completedDate;
  }
  if (task.scheduleType === "daily") return true;
  if (task.scheduleType === "biweekly") {
    if (!task.biweeklyStartDate) return false;
    const difference = dateDayNumber(dateKey) - dateDayNumber(task.biweeklyStartDate);
    return difference >= 0 && difference % 14 === 0;
  }
  return (task.weekdays || []).includes(parseDateKey(dateKey).getDay());
}

function taskMoveForDisplayedDate(task, dateKey) {
  return (task.dateMoves || []).find(move => move.to === dateKey);
}

function taskMatchesDate(task, dateKey, personId) {
  if (taskMoveForDisplayedDate(task, dateKey)) return true;
  if ((task.dateMoves || []).some(move => move.from === dateKey)) return false;
  return taskMatchesBaseDate(task, dateKey, personId);
}

function tasksFor(dateKey, personId) {
  return state.tasks.filter(task => task.active && taskMatchesDate(task, dateKey, personId) && appliesToPerson(task, personId));
}

function taskScheduleDescription(task) {
  if (task.scheduleType === "once") return `一度だけ：${task.onceDate ? formatLongDate(task.onceDate) : "日付未設定"}`;
  if (task.scheduleType === "anytime") return `いつやってもOK：${task.anytimeStartDate ? formatLongDate(task.anytimeStartDate) : "開始日未設定"}から完了まで`;
  if (task.scheduleType === "daily") return "毎日";
  if (task.scheduleType === "biweekly") return `隔週：${task.biweeklyStartDate ? formatLongDate(task.biweeklyStartDate) : "開始日未設定"}から`;
  const weekdays = task.weekdays || [];
  return weekdays.length === 7 ? "毎日" : weekdays.map(day => `${DAY_LABELS[day]}曜`).join("・");
}

function completionKey(dateKey, personId, taskId) {
  return `${dateKey}:${personId}:${taskId}`;
}

function requestKey(dateKey, personId, taskId) {
  return `${dateKey}:${personId}:${taskId}`;
}

function helpRequest(taskId, dateKey, personId) {
  return state.helpRequests?.[requestKey(dateKey, personId, taskId)] || null;
}

function isTaskDone(taskId, dateKey, personId) {
  return Boolean(state.completions[completionKey(dateKey, personId, taskId)]);
}

function isDone(taskId) {
  return isTaskDone(taskId, state.selectedDate, state.selectedPerson);
}

function renderAll() {
  renderPersonSwitch();
  renderToday();
  renderCalendar();
  renderMonthlyHelp();
  renderManage();
  fillOwnerControls();
  applyProfilePermissions();
}

function applyProfilePermissions() {
  if (!cloud.activeProfile) return;
  const parent = isParent();
  document.querySelectorAll("[data-open-event], [data-edit-event], [data-delete-event], [data-copy-event]").forEach(element => { element.hidden = !parent; });
  document.getElementById("icsImportButton").hidden = !parent;
  document.getElementById("backupImportButton").hidden = !parent;
  document.getElementById("backupExportButton").hidden = !parent;
  document.getElementById("signOutButton").hidden = !parent;
  document.querySelector('[data-nav="manage"]').hidden = !parent && cloud.activeProfile?.permissions?.manage_study !== true;
  document.getElementById("openTaskButton").hidden = !parent && cloud.activeProfile?.permissions?.manage_study !== true;
  document.getElementById("resetPinButton").hidden = !parent;
  document.querySelectorAll(".daily-note textarea").forEach(textarea => {
    textarea.disabled = !isOwnProfile(state.selectedPerson);
  });
}

function monthDateKeys(anchorKey) {
  const anchor = parseDateKey(anchorKey);
  const year = anchor.getFullYear();
  const month = anchor.getMonth();
  const days = new Date(year, month + 1, 0).getDate();
  return Array.from({ length: days }, (_, index) => toDateKey(new Date(year, month, index + 1)));
}

function renderMonthlyHelp() {
  const anchor = parseDateKey(state.monthlyHelpDate || state.calendarDate);
  const dates = monthDateKeys(toDateKey(anchor));
  const person = personById(state.selectedPerson);
  const helpTasks = state.tasks.filter(task => task.active && task.category === "help" && appliesToPerson(task, state.selectedPerson) && dates.some(date => taskMatchesDate(task, date, state.selectedPerson)));
  const scheduled = dates.flatMap(date => tasksFor(date, state.selectedPerson).filter(task => task.category === "help").map(task => ({ date, task })));
  const completed = scheduled.filter(item => isTaskDone(item.task.id, item.date, state.selectedPerson)).length;
  const percent = scheduled.length ? Math.round(completed / scheduled.length * 100) : 0;

  document.getElementById("monthlyHelpTitle").textContent = `${anchor.getFullYear()}年 ${anchor.getMonth() + 1}月`;
  document.getElementById("monthlyHelpTotal").textContent = `${completed} / ${scheduled.length}こ`;
  document.getElementById("monthlyHelpPercent").textContent = `${percent}%`;
  document.getElementById("monthlyPersonSwitch").innerHTML = state.people.map(item => `<button class="person-chip ${item.id === state.selectedPerson ? "active" : ""}" style="--person-color:${item.color}" data-monthly-person="${item.id}" type="button">${item.name}</button>`).join("");
  document.querySelectorAll("[data-record-mode]").forEach(button => button.classList.toggle("active", button.dataset.recordMode === state.monthlyHelpMode));

  const content = document.getElementById("monthlyHelpContent");
  if (!scheduled.length) {
    content.innerHTML = `<p class="empty-state">${person?.name || "この人"}のお手伝いは、この月にはありません</p>`;
    return;
  }
  content.innerHTML = state.monthlyHelpMode === "daily" ? monthlyDailyHtml(dates) : monthlyTableHtml(dates, helpTasks);
}

function monthlyTableHtml(dates, helpTasks) {
  const header = dates.map(date => { const parsed = parseDateKey(date); return `<th><span>${parsed.getDate()}</span><small>${DAY_LABELS[parsed.getDay()]}</small></th>`; }).join("");
  const rows = helpTasks.map(task => `<tr><th class="record-task-name">${escapeHtml(task.title)}</th>${dates.map(date => {
    if (!taskMatchesDate(task, date, state.selectedPerson)) return '<td class="not-scheduled">－</td>';
    return `<td class="${isTaskDone(task.id, date, state.selectedPerson) ? "record-done" : "record-undone"}">${isTaskDone(task.id, date, state.selectedPerson) ? "✓" : "○"}</td>`;
  }).join("")}</tr>`).join("");
  return `<section class="panel monthly-table-panel"><div class="record-legend"><span><i class="done-dot"></i>できた</span><span>○ 未チェック</span><span>－ 対象外</span></div><div class="monthly-table-scroll"><table class="monthly-record-table"><thead><tr><th>お手伝い</th>${header}</tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

function monthlyDailyHtml(dates) {
  const todayKey = toDateKey(new Date());
  const cards = dates.map(date => {
    const tasks = tasksFor(date, state.selectedPerson).filter(task => task.category === "help");
    if (!tasks.length) return "";
    const completed = tasks.filter(task => isTaskDone(task.id, date, state.selectedPerson)).length;
    const rows = tasks.map(task => `<li class="${isTaskDone(task.id, date, state.selectedPerson) ? "done" : ""}"><span>${isTaskDone(task.id, date, state.selectedPerson) ? "✓" : "○"}</span>${escapeHtml(task.title)}</li>`).join("");
    const open = date === todayKey || (date < todayKey && completed < tasks.length);
    return `<details class="daily-record-card" ${open ? "open" : ""}><summary><span>${formatLongDate(date)}</span><strong>${completed} / ${tasks.length}${completed === tasks.length ? " ✓" : ""}</strong></summary><ul>${rows}</ul></details>`;
  }).join("");
  return `<div class="daily-record-list">${cards}</div>`;
}

function renderPersonSwitch() {
  document.getElementById("personSwitch").innerHTML = state.people.map(person => `
    <button class="person-chip ${state.selectedPerson === person.id ? "active" : ""}" style="--person-color:${person.color}" data-person="${person.id}" type="button">${person.name}</button>
  `).join("");
}

function renderToday() {
  const selected = parseDateKey(state.selectedDate);
  const todayKey = toDateKey(new Date());
  document.getElementById("todayTodayButton").hidden = state.selectedDate === todayKey;
  document.getElementById("todayLabel").textContent = state.selectedDate === todayKey ? "きょう" : state.selectedDate < todayKey ? "この日の記録" : "これからの予定";
  document.getElementById("selectedDateTitle").textContent = formatLongDate(state.selectedDate);

  const tasks = tasksFor(state.selectedDate, state.selectedPerson);
  const completed = tasks.filter(task => isDone(task.id)).length;
  const percent = tasks.length ? Math.round((completed / tasks.length) * 100) : 0;
  document.getElementById("progressPercent").textContent = `${percent}%`;
  document.getElementById("progressRing").style.setProperty("--progress", `${percent * 3.6}deg`);
  document.getElementById("progressText").textContent = `${completed}こ / ${tasks.length}こ`;
  document.getElementById("encouragement").textContent = tasks.length === 0 ? "今日はのんびりデー" : percent === 100 ? "ぜんぶできた！おつかれさま 🎉" : completed ? "いい調子！あと少し" : "ひとつずつ、いってみよう";

  renderTodayEvents();
  renderTaskCategory("study", tasks);
  renderTaskCategory("help", tasks);
}

function renderTodayEvents() {
  const events = state.events.filter(event => event.date === state.selectedDate).sort((a, b) => (eventStartTime(a) || "99:99").localeCompare(eventStartTime(b) || "99:99"));
  document.getElementById("todayEvents").innerHTML = eventListHtml(events);
}

function eventListHtml(events) {
  if (!events.length) return '<p class="empty-state">予定はまだありません</p>';
  return events.map(event => {
    const owners = eventOwnerIds(event).map(ownerDetails);
    const displayTime = formatEventTime(event);
    return `<article class="event-item">
      <span class="event-owner-list">${owners.map(owner => `<span class="event-owner" style="--owner-color:${owner.color}">${owner.name}</span>`).join("")}</span>
      ${displayTime ? `<time class="event-time">${displayTime}</time>` : ""}
      <p class="event-title">${escapeHtml(event.title)}</p>
      <span class="event-actions">
        <button class="copy-small" type="button" data-copy-event="${event.id}" aria-label="予定をコピー">⧉</button>
        <button class="edit-small" type="button" data-edit-event="${event.id}" aria-label="予定を編集">✎</button>
        <button class="delete-small" type="button" data-delete-event="${event.id}" aria-label="予定を削除">×</button>
      </span>
    </article>`;
  }).join("");
}

function renderTaskCategory(category, tasks) {
  const categoryTasks = tasks.filter(task => task.category === category);
  const list = document.getElementById(category === "study" ? "studyTaskList" : "helpTaskList");
  const count = document.getElementById(category === "study" ? "studyCount" : "helpCount");
  const completed = categoryTasks.filter(task => isDone(task.id)).length;
  count.textContent = `${completed} / ${categoryTasks.length}`;
  list.innerHTML = categoryTasks.length ? categoryTasks.map(task => {
    const done = isDone(task.id);
    const request = category === "help" ? helpRequest(task.id, state.selectedDate, state.selectedPerson) : null;
    const requested = request?.status === "pending";
    const canOperate = isParent() || (isOwnProfile(state.selectedPerson) && (category === "help" || cloud.activeProfile?.permissions?.complete_study === true));
    const meta = done ? (isParent() ? "タップして完了を取り消す" : "完了しました") : requested ? (isParent() ? "確認待ち・タップして完了" : "確認待ち・タップで申請取消") : category === "help" ? (isParent() ? "タップして完了にする" : "タップして完了を申請") : "タップしてできた！にする";
    return `<button class="task-card ${done ? "done" : ""} ${requested ? "requested" : ""}" type="button" data-toggle-task="${task.id}" ${canOperate ? "" : "disabled"}>
      <span class="task-check">${requested ? "…" : "✓"}</span>
      <span class="task-main"><span class="task-title">${escapeHtml(task.title)}</span><span class="task-meta">${meta}</span></span>
    </button>`;
  }).join("") : '<p class="empty-state">この日のやることはありません</p>';
  const note = document.getElementById(`${category}DailyNote`);
  if (document.activeElement !== note) note.value = dailyNoteValue(state.selectedDate, state.selectedPerson, category);
}

function renderCalendar() {
  const anchor = parseDateKey(state.calendarDate);
  const year = anchor.getFullYear();
  const month = anchor.getMonth();
  document.getElementById("calendarMonthTitle").textContent = `${year}年 ${month + 1}月`;
  document.getElementById("calendarSelectedDate").textContent = formatLongDate(state.selectedDate);
  document.getElementById("calendarEvents").innerHTML = eventListHtml(state.events.filter(event => event.date === state.selectedDate));
  renderCalendarHelp();

  const first = new Date(year, month, 1);
  const gridStart = new Date(year, month, 1 - first.getDay());
  const todayKey = toDateKey(new Date());
  const cells = [];
  for (let index = 0; index < 42; index += 1) {
    const date = new Date(gridStart);
    date.setDate(gridStart.getDate() + index);
    const key = toDateKey(date);
    const events = state.events.filter(event => event.date === key);
    cells.push(`<button class="calendar-day ${date.getMonth() !== month ? "other-month" : ""} ${key === state.selectedDate ? "selected" : ""} ${key === todayKey ? "today" : ""}" type="button" data-calendar-day="${key}">
      <span class="day-number">${date.getDate()}</span>
      <span class="calendar-dot-row">${events.flatMap(event => eventOwnerIds(event).map(owner => `<i class="calendar-dot" style="--dot-color:${ownerDetails(owner).color}"></i>`)).slice(0, 6).join("")}</span>
      ${events[0] ? `<span class="calendar-event-preview">${escapeHtml(events[0].title)}</span>` : ""}
    </button>`);
  }
  document.getElementById("calendarGrid").innerHTML = cells.join("");
}

function renderCalendarHelp() {
  document.getElementById("calendarHelpLists").innerHTML = state.people.map(person => {
    const helpTasks = tasksFor(state.selectedDate, person.id).filter(task => task.category === "help");
    const completed = helpTasks.filter(task => isTaskDone(task.id, state.selectedDate, person.id)).length;
    const taskList = helpTasks.length ? helpTasks.map(task => {
      const done = isTaskDone(task.id, state.selectedDate, person.id);
      const request = helpRequest(task.id, state.selectedDate, person.id);
      const requested = request?.status === "pending";
      const move = taskMoveForDisplayedDate(task, state.selectedDate);
      const canOperate = isParent() || (isOwnProfile(person.id) && !done);
      const meta = done ? (isParent() ? "完了済み・タップで取消" : "親が確認済み") : requested ? (isParent() ? "確認待ち・タップして完了" : "確認待ち・タップで申請取消") : isParent() ? "タップして完了にする" : isOwnProfile(person.id) ? "タップして完了を申請" : "未申請";
      return `<div class="calendar-help-task-row">
        <button class="task-card calendar-help-task ${done ? "done" : ""} ${requested ? "requested" : ""}" type="button" ${canOperate ? `data-toggle-calendar-task="${task.id}" data-calendar-person="${person.id}"` : "disabled"}>
          <span class="task-check">${requested ? "…" : "✓"}</span>
          <span class="task-main"><span class="task-title">${escapeHtml(task.title)}</span><span class="task-meta">${move ? `${formatLongDate(move.from)}から移動・${meta}` : meta}</span></span>
        </button>
        <button class="task-move-button" type="button" data-move-task="${task.id}" data-calendar-person="${person.id}" aria-label="${move ? "移動先を変更" : "今回だけ移動"}" title="${move ? "移動先を変更" : "今回だけ移動"}" ${isParent() ? "" : "hidden"}>
          <span aria-hidden="true">→</span>
        </button>
      </div>`;
    }).join("") : '<p class="calendar-help-empty">この日のお手伝いはありません</p>';
    return `<section class="calendar-person-help" style="--person-color:${person.color}">
      <div class="calendar-person-heading"><span class="calendar-person-name">${person.name}</span><span class="calendar-person-count">${completed} / ${helpTasks.length}</span></div>
      <div class="calendar-help-tasks">${taskList}</div>
    </section>`;
  }).join("");
}

function renderManage() {
  const filters = isParent() ? [{ id: "all", name: "すべて" }, ...state.people.map(person => ({ id: person.id, name: person.name })), { id: "both", name: "ふたり" }] : [{ id: cloud.activeProfile?.id, name: "自分の勉強" }];
  if (!isParent()) state.manageFilter = cloud.activeProfile?.id || state.manageFilter;
  document.getElementById("manageFilters").innerHTML = filters.map(filter => `<button class="filter-chip ${state.manageFilter === filter.id ? "active" : ""}" type="button" data-manage-filter="${filter.id}">${filter.name}</button>`).join("");
  const tasks = state.tasks.filter(task => (state.manageFilter === "all" || task.assignee === state.manageFilter) && (isParent() || canManageTask(task)));
  document.getElementById("manageTaskList").innerHTML = tasks.length ? tasks.map(task => {
    const assignee = task.assignee === "both" ? "ふたり" : personById(task.assignee)?.name;
    const schedule = taskScheduleDescription(task);
    return `<article class="manage-card ${task.active ? "" : "inactive"}">
      <div class="manage-card-top"><div><span class="category-label ${task.category === "help" ? "help" : ""}">${task.category === "study" ? "宿題・勉強" : "お手伝い"}</span><h3>${escapeHtml(task.title)}</h3></div>
      <div class="manage-actions"><button type="button" data-edit-task="${task.id}" aria-label="編集">✎</button>${isParent() ? `<button type="button" data-delete-task="${task.id}" aria-label="削除">×</button>` : ""}</div></div>
      <p>${assignee}　／　${schedule}${task.active ? "" : "　／　お休み中"}</p>
    </article>`;
  }).join("") : '<p class="empty-state">登録されたやることはありません</p>';
  renderApprovals();
}

function renderApprovals() {
  const panel = document.getElementById("approvalPanel");
  panel.hidden = !isParent();
  if (!isParent()) return;
  const requests = Object.values(state.helpRequests || {}).filter(request => request.status === "pending");
  panel.classList.toggle("is-empty", requests.length === 0);
  document.getElementById("approvalCount").textContent = `${requests.length}件`;
  document.getElementById("approvalList").innerHTML = requests.length ? requests.map(request => {
    const task = state.tasks.find(item => item.id === request.task_id);
    const person = personById(request.member_key);
    return `<article class="approval-item"><p>${escapeHtml(task?.title || "お手伝い")}<small>${escapeHtml(person?.name || request.member_key)}・${formatLongDate(request.requested_on)}</small></p><div class="approval-actions"><button class="secondary-button" data-reject-help="${request.task_id}" data-request-person="${request.member_key}" data-request-date="${request.requested_on}" type="button">差し戻す</button><button class="primary-button" data-approve-help="${request.task_id}" data-request-person="${request.member_key}" data-request-date="${request.requested_on}" type="button">確認して完了</button></div></article>`;
  }).join("") : "";
}

function fillOwnerControls() {
  const owners = [{ id: "family", name: "家族みんな", color: "#f0a64b" }, PARENT, ...state.people];
  document.getElementById("eventOwnerChecks").innerHTML = owners.map(owner => `<label><input type="checkbox" value="${owner.id}"><span style="--owner-choice-color:${owner.color}">${owner.name}</span></label>`).join("");
  document.getElementById("taskAssignee").innerHTML = `${state.people.map(person => `<option value="${person.id}">${person.name}</option>`).join("")}<option value="both">ふたり</option>`;
}

function switchView(view) {
  currentView = view;
  document.querySelectorAll(".view").forEach(element => element.classList.toggle("active", element.dataset.view === view));
  document.querySelectorAll("[data-nav]").forEach(button => button.classList.toggle("active", button.dataset.nav === view));
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function moveSelectedDate(days) {
  const date = parseDateKey(state.selectedDate);
  date.setDate(date.getDate() + days);
  state.selectedDate = toDateKey(date);
  state.calendarDate = state.selectedDate;
  saveState();
  renderAll();
}

function moveCalendarMonth(offset) {
  const date = parseDateKey(state.calendarDate);
  date.setDate(1);
  date.setMonth(date.getMonth() + offset);
  state.calendarDate = toDateKey(date);
  renderCalendar();
}

function moveRecordMonth(offset) {
  const date = parseDateKey(state.monthlyHelpDate);
  date.setDate(1);
  date.setMonth(date.getMonth() + offset);
  state.monthlyHelpDate = toDateKey(date);
  saveState();
  renderMonthlyHelp();
}

function openEventDialog(eventId, mode = "edit") {
  document.getElementById("eventForm").reset();
  const savedEvent = eventId ? state.events.find(item => item.id === eventId) : null;
  const isCopy = Boolean(savedEvent && mode === "copy");
  document.getElementById("eventId").value = isCopy ? "" : (savedEvent?.id || "");
  document.getElementById("eventMode").value = isCopy ? "copy" : (savedEvent ? "edit" : "new");
  document.getElementById("eventDialogTitle").textContent = isCopy ? "予定・メモをコピー" : (savedEvent ? "予定・メモを編集" : "予定・メモを追加");
  document.getElementById("saveEventButton").textContent = isCopy ? "コピーを保存" : (savedEvent ? "変更を保存" : "保存する");
  document.getElementById("eventDate").value = savedEvent?.date || state.selectedDate;
  document.getElementById("eventTitle").value = savedEvent?.title || "";
  document.getElementById("eventStartTime").value = savedEvent ? eventStartTime(savedEvent) : "";
  document.getElementById("eventEndTime").value = savedEvent?.endTime || "";
  const selectedOwners = savedEvent ? eventOwnerIds(savedEvent) : ["family"];
  document.querySelectorAll('#eventOwnerChecks input[type="checkbox"]').forEach(input => {
    input.checked = selectedOwners.includes(input.value);
  });
  document.getElementById("eventDialog").showModal();
  setTimeout(() => document.getElementById(isCopy ? "eventDate" : "eventTitle").focus(), 50);
}

function updateTaskScheduleFields() {
  const scheduleType = document.getElementById("taskScheduleType").value;
  document.getElementById("onceScheduleFields").hidden = scheduleType !== "once";
  document.getElementById("anytimeScheduleFields").hidden = scheduleType !== "anytime";
  document.getElementById("dailyScheduleHint").hidden = scheduleType !== "daily";
  document.getElementById("weeklyScheduleFields").hidden = scheduleType !== "weekly";
  document.getElementById("biweeklyScheduleFields").hidden = scheduleType !== "biweekly";
}

function openTaskDialog(taskId) {
  document.getElementById("taskForm").reset();
  const task = taskId ? state.tasks.find(item => item.id === taskId) : null;
  if (task && !canManageTask(task)) { showToast("この項目は編集できません"); return; }
  document.getElementById("taskDialogTitle").textContent = task ? "やることを編集" : "やることを追加";
  document.getElementById("taskId").value = task?.id || "";
  document.getElementById("taskTitle").value = task?.title || "";
  document.getElementById("taskCategory").value = task?.category || "study";
  document.getElementById("taskAssignee").value = task?.assignee || state.selectedPerson;
  document.getElementById("taskActive").checked = task ? task.active : true;
  document.getElementById("taskScheduleType").value = task?.scheduleType || "once";
  document.getElementById("taskOnceDate").value = task?.onceDate || state.selectedDate;
  document.getElementById("taskAnytimeStartDate").value = task?.anytimeStartDate || state.selectedDate;
  document.getElementById("taskBiweeklyStartDate").value = task?.biweeklyStartDate || state.selectedDate;
  document.getElementById("weekdayChecks").innerHTML = DAY_LABELS.map((label, index) => `<label><input type="checkbox" value="${index}" ${(task?.weekdays || [1,2,3,4,5]).includes(index) ? "checked" : ""}><span>${label}</span></label>`).join("");
  updateTaskScheduleFields();
  document.getElementById("taskCategory").disabled = !isParent();
  document.getElementById("taskAssignee").disabled = !isParent();
  document.getElementById("taskDialog").showModal();
  setTimeout(() => document.getElementById("taskTitle").focus(), 50);
}

function openTaskMoveDialog(taskId, personId) {
  const task = state.tasks.find(item => item.id === taskId);
  if (!task) return;
  const existingMove = taskMoveForDisplayedDate(task, state.selectedDate);
  document.getElementById("moveTaskId").value = task.id;
  document.getElementById("moveTaskPerson").value = personId;
  document.getElementById("moveTaskFromDate").value = existingMove?.from || state.selectedDate;
  document.getElementById("moveTaskName").textContent = task.title;
  document.getElementById("moveTaskDateDescription").textContent = `${formatLongDate(existingMove?.from || state.selectedDate)}のお手伝いを移動します。`;
  document.getElementById("moveTaskToDate").value = existingMove?.to || state.selectedDate;
  document.getElementById("cancelTaskMoveButton").hidden = !existingMove;
  document.getElementById("taskMoveDialog").showModal();
}

function escapeHtml(value) {
  return value.replace(/[&<>'"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#039;", '"': "&quot;" })[character]);
}

document.addEventListener("click", event => {
  const target = event.target.closest("button");
  if (!target) return;
  if (target.dataset.unlockProfile) {
    const profile = cloud.members.find(member => member.id === target.dataset.unlockProfile);
    document.getElementById("profileGrid").hidden = true;
    document.getElementById("pinUnlockForm").hidden = false;
    document.getElementById("pinProfileName").textContent = `${profile?.name || "プロフィール"}のPIN`;
    document.getElementById("pinUnlockForm").dataset.profileId = target.dataset.unlockProfile;
    document.getElementById("profilePin").value = "";
    document.getElementById("profilePin").focus();
    return;
  }
  if (target.dataset.nav) switchView(target.dataset.nav);
  if (target.dataset.monthlyPerson) { state.selectedPerson = target.dataset.monthlyPerson; saveState(); renderAll(); }
  if (target.dataset.recordMode) { state.monthlyHelpMode = target.dataset.recordMode; saveState(); renderMonthlyHelp(); }
  if (target.dataset.person) { state.selectedPerson = target.dataset.person; saveState(); renderAll(); }
  if (target.dataset.toggleTask) {
    const taskId = target.dataset.toggleTask;
    const task = state.tasks.find(item => item.id === taskId);
    const personId = state.selectedPerson;
    const completedOn = state.selectedDate;
    const key = completionKey(completedOn, personId, taskId);
    if (task?.category === "help" && !isParent()) {
      const existing = helpRequest(taskId, completedOn, personId);
      if (!isOwnProfile(personId)) { showToast("自分のお手伝いだけ申請できます"); return; }
      if (isTaskDone(taskId, completedOn, personId)) { showToast("親が確認済みです"); return; }
      if (existing?.status === "pending") delete state.helpRequests[key];
      else state.helpRequests[key] = { task_id: taskId, member_key: personId, requested_on: completedOn, status: "pending", requested_at: new Date().toISOString() };
      saveState(existing?.status === "pending" ? "申請を取り消しました" : "できた！を申請しました 🐾");
      syncHelpRequest(taskId, personId, completedOn, existing?.status === "pending");
      renderToday();
      return;
    }
    state.completions[key] = !state.completions[key];
    if (!state.completions[key]) delete state.completions[key];
    if (task?.category === "help" && state.completions[key]) delete state.helpRequests[key];
    saveState(state.completions[key] ? "できた！にしました 🎉" : "チェックを戻しました");
    syncCompletion(taskId, personId, completedOn, Boolean(state.completions[key]));
    renderToday();
  }
  if (target.dataset.approveHelp || target.dataset.rejectHelp) {
    const taskId = target.dataset.approveHelp || target.dataset.rejectHelp;
    const personId = target.dataset.requestPerson;
    const date = target.dataset.requestDate;
    const approve = Boolean(target.dataset.approveHelp);
    const key = requestKey(date, personId, taskId);
    if (approve) state.completions[completionKey(date, personId, taskId)] = true;
    delete state.helpRequests[key];
    saveState(approve ? "確認して完了にしました 🎉" : "差し戻しました");
    decideHelpRequest(taskId, personId, date, approve);
    renderAll();
  }
  if (target.dataset.toggleCalendarTask) {
    const taskId = target.dataset.toggleCalendarTask;
    const personId = target.dataset.calendarPerson;
    const completedOn = state.selectedDate;
    const key = completionKey(completedOn, personId, taskId);
    if (!isParent()) {
      if (!isOwnProfile(personId)) { showToast("自分のお手伝いだけ申請できます"); return; }
      const existing = helpRequest(taskId, completedOn, personId);
      if (existing?.status === "pending") delete state.helpRequests[key];
      else state.helpRequests[key] = { task_id: taskId, member_key: personId, requested_on: completedOn, status: "pending", requested_at: new Date().toISOString() };
      saveState(existing?.status === "pending" ? "申請を取り消しました" : "できた！を申請しました 🐾");
      syncHelpRequest(taskId, personId, completedOn, existing?.status === "pending");
      renderAll();
      return;
    }
    state.completions[key] = !state.completions[key];
    if (!state.completions[key]) delete state.completions[key];
    if (state.completions[key]) delete state.helpRequests[key];
    saveState(state.completions[key] ? "できた！にしました 🎉" : "チェックを戻しました");
    syncCompletion(taskId, personId, completedOn, Boolean(state.completions[key]));
    renderAll();
  }
  if (target.dataset.moveTask) openTaskMoveDialog(target.dataset.moveTask, target.dataset.calendarPerson);
  if (target.hasAttribute("data-open-event") && isParent()) openEventDialog();
  if (target.dataset.copyEvent) openEventDialog(target.dataset.copyEvent, "copy");
  if (target.dataset.editEvent) openEventDialog(target.dataset.editEvent);
  if (target.dataset.deleteEvent) {
    const deletedEventId = target.dataset.deleteEvent;
    state.events = state.events.filter(item => item.id !== deletedEventId);
    saveState("予定を削除しました"); renderAll();
    deleteCloudEvent(deletedEventId);
  }
  if (target.dataset.calendarDay) { state.selectedDate = target.dataset.calendarDay; state.calendarDate = target.dataset.calendarDay; saveState(); renderAll(); }
  if (target.dataset.manageFilter) { state.manageFilter = target.dataset.manageFilter; saveState(); renderManage(); }
  if (target.dataset.editTask) openTaskDialog(target.dataset.editTask);
  if (target.dataset.deleteTask) {
    if (window.confirm("この「やること」を削除しますか？")) {
      const deletedTaskId = target.dataset.deleteTask;
      state.tasks = state.tasks.filter(item => item.id !== deletedTaskId);
      Object.keys(state.completions).filter(key => key.endsWith(`:${deletedTaskId}`)).forEach(key => { delete state.completions[key]; });
      saveState("削除しました");
      deleteCloudTask(deletedTaskId);
      renderAll();
    }
  }
});

document.getElementById("currentProfileButton").addEventListener("click", () => {
  cloud.activeProfile = null;
  cloud.profileToken = null;
  localStorage.removeItem(PROFILE_STORAGE_KEY);
  showProfileScreen();
});

document.getElementById("backToProfilesButton").addEventListener("click", showProfileScreen);

document.getElementById("pinUnlockForm").addEventListener("submit", async event => {
  event.preventDefault();
  const profileId = event.currentTarget.dataset.profileId;
  const pin = document.getElementById("profilePin").value;
  const { data, error } = await cloud.client.rpc("unlock_family_profile", { p_profile_key: profileId, p_pin: pin });
  if (error || !data?.token) { document.getElementById("profileMessage").textContent = "PINが違います。もう一度確認してください。"; return; }
  const profile = cloud.members.find(member => member.id === profileId);
  document.getElementById("profileMessage").textContent = "";
  activateProfile(profile, data.token);
});

document.getElementById("pinSetupForm").addEventListener("submit", async event => {
  event.preventDefault();
  const pins = Object.fromEntries(cloud.members.map(member => [member.id, new FormData(event.currentTarget).get(member.id)]));
  const { data, error } = await cloud.client.rpc("setup_family_profile_pins", { p_pins: pins });
  if (error || !data?.token) { document.getElementById("profileMessage").textContent = error?.message || "PINを設定できませんでした。"; return; }
  await loadCloudState();
  const parent = cloud.members.find(member => member.role === "parent");
  activateProfile(parent, data.token);
});

document.getElementById("previousDayButton").addEventListener("click", () => moveSelectedDate(-1));
document.getElementById("nextDayButton").addEventListener("click", () => moveSelectedDate(1));
document.getElementById("todayTodayButton").addEventListener("click", () => {
  const todayKey = toDateKey(new Date());
  state.selectedDate = todayKey;
  state.calendarDate = todayKey;
  saveState("今日に戻りました");
  renderAll();
});
document.getElementById("previousMonthButton").addEventListener("click", () => moveCalendarMonth(-1));
document.getElementById("nextMonthButton").addEventListener("click", () => moveCalendarMonth(1));
document.getElementById("calendarTodayButton").addEventListener("click", () => {
  const todayKey = toDateKey(new Date());
  state.selectedDate = todayKey;
  state.calendarDate = todayKey;
  saveState("今日に戻りました");
  renderAll();
});
document.getElementById("openMonthlyHelpButton").addEventListener("click", () => {
  state.monthlyHelpDate = state.calendarDate;
  saveState();
  renderMonthlyHelp();
  switchView("monthly-help");
});
document.getElementById("backToCalendarButton").addEventListener("click", () => switchView("calendar"));
document.getElementById("previousRecordMonthButton").addEventListener("click", () => moveRecordMonth(-1));
document.getElementById("nextRecordMonthButton").addEventListener("click", () => moveRecordMonth(1));
document.getElementById("icsExportButton").addEventListener("click", () => {
  if (!state.events.length) { showToast("書き出す予定がありません"); return; }
  const blob = new Blob([buildIcsCalendar(state.events)], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `夏やすみボード-${toDateKey(new Date())}.ics`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  showToast(`${state.events.length}件の予定を書き出しました`);
});
document.getElementById("icsImportButton").addEventListener("click", () => {
  document.getElementById("icsImportInput").click();
});
document.getElementById("icsImportInput").addEventListener("change", async event => {
  const input = event.target;
  const file = input.files?.[0];
  if (!file) return;
  try {
    const importedEvents = parseIcsCalendar(await file.text());
    if (!importedEvents.length) { showToast("読み込める予定が見つかりませんでした"); return; }
    const result = importIcsEvents(importedEvents);
    if (result.importedCount) {
      state.selectedDate = importedEvents[0].date;
      state.calendarDate = importedEvents[0].date;
      saveState(`${result.importedCount}件の予定を読み込みました`);
      syncEvents(result.addedEvents);
      renderAll();
    } else {
      showToast("すべて登録済みの予定です");
    }
  } catch {
    showToast("ICSファイルを読み込めませんでした");
  } finally {
    input.value = "";
  }
});
document.getElementById("openTaskButton").addEventListener("click", () => openTaskDialog());
document.getElementById("resetPinButton").addEventListener("click", async () => {
  if (!isParent()) return;
  const choices = cloud.members.map((member, index) => `${index + 1}: ${member.name}`).join("\n");
  const selected = window.prompt(`PINを再設定する人の番号を入力してください。\n${choices}`);
  const member = cloud.members[Number(selected) - 1];
  if (!member) return;
  const pin = window.prompt(`${member.name}の新しい4桁PINを入力してください。`);
  if (!/^\d{4}$/.test(pin || "")) { showToast("PINは4桁の数字にしてください"); return; }
  const { error } = await cloud.client.rpc("reset_family_profile_pin", { p_token: cloud.profileToken, p_profile_key: member.id, p_new_pin: pin });
  showToast(error ? "PINを変更できませんでした" : `${member.name}のPINを変更しました`);
});
document.getElementById("taskScheduleType").addEventListener("change", updateTaskScheduleFields);

["study", "help"].forEach(category => {
  document.getElementById(`${category}DailyNote`).addEventListener("input", event => {
    const noteDate = state.selectedDate;
    const personId = state.selectedPerson;
    const key = dailyNoteKey(noteDate, personId, category);
    state.dailyNotes[key] = event.target.value;
    saveState();
    clearTimeout(dailyNoteTimers[category]);
    dailyNoteTimers[category] = setTimeout(() => {
      syncDailyNote(noteDate, personId, category, state.dailyNotes[key]);
    }, 700);
  });
});

document.getElementById("eventOwnerChecks").addEventListener("change", event => {
  if (!event.target.matches('input[type="checkbox"]') || !event.target.checked) return;
  const checkboxes = [...document.querySelectorAll('#eventOwnerChecks input[type="checkbox"]')];
  if (event.target.value === "family") {
    checkboxes.filter(input => input !== event.target).forEach(input => { input.checked = false; });
  } else {
    const familyCheckbox = checkboxes.find(input => input.value === "family");
    if (familyCheckbox) familyCheckbox.checked = false;
  }
});

document.getElementById("eventForm").addEventListener("submit", event => {
  if (event.submitter?.value === "cancel") return;
  event.preventDefault();
  const title = document.getElementById("eventTitle").value.trim();
  const date = document.getElementById("eventDate").value;
  if (!title || !date) return;
  const owners = [...document.querySelectorAll('#eventOwnerChecks input:checked')].map(input => input.value);
  if (!owners.length) { showToast("予定の人を1人以上選んでください"); return; }
  const savedEvent = {
    id: document.getElementById("eventId").value || crypto.randomUUID(),
    date,
    title,
    startTime: document.getElementById("eventStartTime").value,
    endTime: document.getElementById("eventEndTime").value,
    owners
  };
  const savedEventIndex = state.events.findIndex(item => item.id === savedEvent.id);
  const eventMode = document.getElementById("eventMode").value;
  if (savedEventIndex >= 0 && state.events[savedEventIndex].externalUid) savedEvent.externalUid = state.events[savedEventIndex].externalUid;
  if (savedEventIndex >= 0) state.events[savedEventIndex] = savedEvent; else state.events.push(savedEvent);
  state.selectedDate = date;
  state.calendarDate = date;
  saveState(eventMode === "copy" ? "予定をコピーしました" : (savedEventIndex >= 0 ? "予定を変更しました" : "予定を追加しました"));
  syncEvent(savedEvent);
  document.getElementById("eventDialog").close();
  renderAll();
});

document.getElementById("taskForm").addEventListener("submit", event => {
  if (event.submitter?.value === "cancel") return;
  event.preventDefault();
  const title = document.getElementById("taskTitle").value.trim();
  const scheduleType = document.getElementById("taskScheduleType").value;
  const weekdays = [...document.querySelectorAll("#weekdayChecks input:checked")].map(input => Number(input.value));
  const onceDate = document.getElementById("taskOnceDate").value;
  const anytimeStartDate = document.getElementById("taskAnytimeStartDate").value;
  const biweeklyStartDate = document.getElementById("taskBiweeklyStartDate").value;
  if (!title) return;
  if (scheduleType === "once" && !onceDate) { showToast("実行日を選んでください"); return; }
  if (scheduleType === "anytime" && !anytimeStartDate) { showToast("表示を始める日を選んでください"); return; }
  if (scheduleType === "weekly" && !weekdays.length) { showToast("表示する曜日を選んでください"); return; }
  if (scheduleType === "biweekly" && !biweeklyStartDate) { showToast("最初にやる日を選んでください"); return; }
  const task = {
    id: document.getElementById("taskId").value || crypto.randomUUID(),
    title,
    category: document.getElementById("taskCategory").value,
    assignee: document.getElementById("taskAssignee").value,
    scheduleType,
    weekdays: scheduleType === "weekly" ? weekdays : [],
    onceDate: scheduleType === "once" ? onceDate : "",
    anytimeStartDate: scheduleType === "anytime" ? anytimeStartDate : "",
    biweeklyStartDate: scheduleType === "biweekly" ? biweeklyStartDate : "",
    active: document.getElementById("taskActive").checked,
    dateMoves: state.tasks.find(item => item.id === document.getElementById("taskId").value)?.dateMoves || []
  };
  const index = state.tasks.findIndex(item => item.id === task.id);
  if (index >= 0) state.tasks[index] = task; else state.tasks.push(task);
  saveState(index >= 0 ? "変更を保存しました" : "やることを追加しました");
  syncTask(task);
  document.getElementById("taskDialog").close();
  renderAll();
});

document.getElementById("taskMoveForm").addEventListener("submit", event => {
  if (event.submitter?.value === "cancel") return;
  event.preventDefault();
  const task = state.tasks.find(item => item.id === document.getElementById("moveTaskId").value);
  const personId = document.getElementById("moveTaskPerson").value;
  const from = document.getElementById("moveTaskFromDate").value;
  const to = document.getElementById("moveTaskToDate").value;
  if (!task || !to) return;
  if (from === to) { showToast("移動先は別の日を選んでください"); return; }
  if (taskMatchesBaseDate(task, to, personId)) { showToast("そのお手伝いは移動先にも予定されています"); return; }
  if ((task.dateMoves || []).some(move => move.from !== from && move.to === to)) { showToast("同じお手伝いがすでにその日へ移動されています"); return; }
  task.dateMoves = [...(task.dateMoves || []).filter(move => move.from !== from), { from, to }];
  state.selectedDate = to;
  state.calendarDate = to;
  saveState(`${formatLongDate(to)}へ移動しました`);
  syncTask(task);
  document.getElementById("taskMoveDialog").close();
  renderAll();
});

document.getElementById("cancelTaskMoveButton").addEventListener("click", () => {
  const task = state.tasks.find(item => item.id === document.getElementById("moveTaskId").value);
  const from = document.getElementById("moveTaskFromDate").value;
  if (!task) return;
  task.dateMoves = (task.dateMoves || []).filter(move => move.from !== from);
  state.selectedDate = from;
  state.calendarDate = from;
  saveState("移動を取り消しました");
  syncTask(task);
  document.getElementById("taskMoveDialog").close();
  renderAll();
});

document.getElementById("backupExportButton").addEventListener("click", () => {
  const backup = {
    app: "summer-board",
    version: 1,
    exportedAt: new Date().toISOString(),
    state
  };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `夏やすみボード-バックアップ-${toDateKey(new Date())}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  showToast("バックアップを保存しました");
});

document.getElementById("backupImportButton").addEventListener("click", () => {
  document.getElementById("backupImportInput").click();
});

document.getElementById("backupImportInput").addEventListener("change", async event => {
  const input = event.target;
  const file = input.files?.[0];
  if (!file) return;
  try {
    const backup = JSON.parse(await file.text());
    const importedState = backup?.app === "summer-board" ? backup.state : backup;
    if (!importedState?.tasks || !importedState?.people || !importedState?.events || !importedState?.completions) throw new Error("invalid backup");
    if (!window.confirm("現在のデータをバックアップの内容に置き換えますか？")) return;
    importedState.people = importedState.people.map(person => person.id === "child2" ? { ...person, color: "#69b98b" } : person);
    importedState.tasks = importedState.tasks.map(task => ({
      ...task,
      scheduleType: task.scheduleType || (task.weekdays?.length === 7 ? "daily" : "weekly"),
      weekdays: task.weekdays || [],
      dateMoves: task.dateMoves || []
    }));
    importedState.dailyNotes = importedState.dailyNotes || {};
    state = importedState;
    saveState("バックアップを読み込みました");
    syncCloudState();
    renderAll();
  } catch {
    showToast("バックアップファイルを読み込めませんでした");
  } finally {
    input.value = "";
  }
});

document.getElementById("authForm").addEventListener("submit", async event => {
  event.preventDefault();
  if (!cloud.client) return;
  const email = document.getElementById("authEmail").value.trim();
  const password = document.getElementById("authPassword").value;
  showAuthMessage("ログインしています…");
  const { data, error } = await cloud.client.auth.signInWithPassword({ email, password });
  if (error) {
    showAuthMessage("ログインできませんでした。メールアドレスとパスワードを確認してください。");
    return;
  }
  try {
    const persisted = await verifyPersistedSession(data.session?.user?.id);
    if (!persisted) {
      showAuthMessage("ログインできましたが、この端末にログイン状態を保存できませんでした。Safariの設定を確認してください。");
    }
  } catch (sessionError) {
    console.error("ログイン状態を保存できませんでした。", sessionError);
    showAuthMessage("ログインできましたが、ログイン状態の保存確認に失敗しました。");
  }
});

document.getElementById("signUpButton").addEventListener("click", async () => {
  if (!cloud.client) return;
  const form = document.getElementById("authForm");
  if (!form.reportValidity()) return;
  const email = document.getElementById("authEmail").value.trim();
  const password = document.getElementById("authPassword").value;
  showAuthMessage("家族用ログインを作っています…");
  const { data, error } = await cloud.client.auth.signUp({ email, password });
  if (error) {
    showAuthMessage("作成できませんでした。別のメールアドレスか、8文字以上のパスワードを試してください。");
  } else if (!data.session) {
    showAuthMessage("確認メールを送りました。メール内のリンクを開いてから、ここでログインしてください。");
  }
});

document.getElementById("signOutButton").addEventListener("click", async () => {
  if (!isParent() || !cloud.client || !window.confirm("この端末からログアウトしますか？")) return;
  await cloud.client.auth.signOut();
  cloud.ready = false;
  clearInterval(cloud.refreshTimer);
  cloud.user = null;
  cloud.familyId = null;
  cloud.activeProfile = null;
  cloud.profileToken = null;
  localStorage.removeItem(PROFILE_STORAGE_KEY);
  document.getElementById("signOutButton").hidden = true;
  document.getElementById("authPassword").value = "";
  document.getElementById("authScreen").hidden = false;
  showAuthMessage("ログアウトしました。");
});

window.addEventListener("focus", refreshCloudState);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refreshCloudState();
});

renderAll();
initializeOnlineApp();
