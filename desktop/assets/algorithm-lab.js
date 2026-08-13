(() => {
  const q = (selector) => document.querySelector(selector);
  const esc = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"})[char]);
  const labApi = async (url, options = {}) => {
    const response = await fetch(url, {cache:"no-store", headers:{"Content-Type":"application/json", ...(options.headers || {})}, ...options});
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.detail || `${response.status} ${response.statusText}`);
    }
    return response.status === 204 ? null : response.json();
  };
  const notify = (message) => {
    const el = q("#toast");
    if (!el) return;
    el.textContent = message;
    el.classList.add("show");
    window.setTimeout(() => el.classList.remove("show"), 2800);
  };

  let projects = [];
  let sessions = [];
  let active = false;
  let activeSessionId = null;
  let selectedSessionId = null;
  let pollTimer = null;

  const actionNames = {none:"未识别", still:"保持静止", open_hand:"张手", fist:"握拳", pinch:"捏合", squat:"下蹲", jump:"跳跃"};
  const errorNames = {miss:"漏识别", missed:"漏识别", wrong_action:"识别错误", static_false_trigger:"静止误触", outside_action_window:"阶段外误触", false_positive:"误触", duplicate:"重复触发", confusion:"手势混淆", success:"命中", ok:"命中", none:"—"};

  function metricsHtml(name, metrics, candidate = false) {
    const total = Number(metrics?.total_count ?? metrics?.total ?? metrics?.expected_total ?? 0);
    const success = Number(metrics?.success ?? metrics?.success_count ?? 0);
    const values = [
      ["成功", `${success}/${total}`], ["漏识别", metrics?.missed_count ?? metrics?.misses ?? metrics?.miss_count ?? 0],
      ["静止误触", metrics?.static_false_triggers ?? metrics?.false_positives ?? metrics?.false_positive_count ?? 0], ["重复触发", metrics?.duplicate_triggers ?? metrics?.duplicates ?? metrics?.duplicate_count ?? 0],
      ["平均延迟", `${Math.round(metrics?.average_latency_ms ?? metrics?.avg_latency_ms ?? 0)} ms`], ["P95 延迟", `${Math.round(metrics?.p95_latency_ms ?? 0)} ms`],
    ];
    return `<article class="lab-variant ${candidate ? "candidate" : ""}"><div class="lab-variant-head"><b>${esc(name)}</b><span>${candidate ? "候选参数" : "当前默认参数"}</span></div><div class="lab-metrics">${values.map(([label,value]) => `<div class="lab-metric"><strong>${esc(value)}</strong><small>${esc(label)}</small></div>`).join("")}</div></article>`;
  }

  function renderConfusion(matrix) {
    matrix = matrix?.counts || matrix || {};
    const rows = ["fist", "pinch", "open_hand"];
    const cols = ["fist", "pinch", "open_hand", "none"];
    q("#labConfusion").innerHTML = `<table class="lab-confusion-table"><thead><tr><th>实际＼识别</th>${cols.map((name) => `<th>${esc(actionNames[name] || "未识别")}</th>`).join("")}</tr></thead><tbody>${rows.map((actual) => `<tr><th>${esc(actionNames[actual])}</th>${cols.map((predicted) => `<td>${Number(matrix?.[actual]?.[predicted] ?? 0)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  }

  function timelineActual(event, variant) {
    const value = event?.[variant];
    if (typeof value === "string") return value;
    return value?.recognized ?? value?.actual ?? value?.action ?? "none";
  }

  function renderTimeline(events) {
    q("#labTimeline").innerHTML = (events || []).map((event, index) => {
      const error = event.error_type || event.current?.error_type || event.error || "ok";
      const isError = !["success", "ok", "none", ""].includes(error);
      return `<tr data-event-id="${esc(event.id ?? index)}"><td>${((event.at_ms ?? event.time_ms ?? 0) / 1000).toFixed(2)}s</td><td>${esc(actionNames[event.expected] || event.expected_name || event.expected || "—")}</td><td>${esc(actionNames[timelineActual(event,"current")] || timelineActual(event,"current"))}</td><td>${esc(actionNames[timelineActual(event,"candidate")] || timelineActual(event,"candidate"))}</td><td class="${isError ? "lab-error" : "lab-ok"}">${esc(errorNames[error] || error)}</td></tr>`;
    }).join("") || `<tr><td colspan="5">本次没有事件</td></tr>`;
    q("#labTimeline").querySelectorAll("[data-event-id]").forEach((row) => row.addEventListener("click", () => loadEventDetail(row.dataset.eventId)));
  }

  async function loadEventDetail(eventId) {
    if (!selectedSessionId) return;
    try {
      const detail = await labApi(`/api/algorithm-tests/sessions/${encodeURIComponent(selectedSessionId)}/events/${encodeURIComponent(eventId)}`);
      const lines = (detail.frames || detail.timeline || []).map((frame) => {
        const raw = frame.raw_signals || frame.raw || {};
        const signals = frame.signals || frame.current_signals || {};
        const picked = {fist_score:raw.left_fist_score ?? raw.right_fist_score, pinch:raw.left_pinch_amount ?? raw.right_pinch_amount, squat:raw.squat_score, jump:raw.jump_score};
        const pose = frame.pose_landmarks || {};
        const keypoints = {nose:pose["0"], left_wrist:pose["15"], right_wrist:pose["16"], left_hip:pose["23"], right_hip:pose["24"]};
        const hands = (frame.hands || []).map((hand) => ({side:hand.handedness, gesture:hand.gesture, wrist:hand.landmarks?.[0], thumb:hand.landmarks?.[4], index:hand.landmarks?.[8]}));
        return `${String(Math.round(frame.elapsed_ms ?? frame.at_ms ?? 0)).padStart(5)} ms  ${JSON.stringify(signals)}\n  原始=${JSON.stringify(picked)}  关键点=${JSON.stringify(keypoints)}  手=${JSON.stringify(hands)}`;
      });
      q("#labEventDetail").textContent = `${detail.expected_name || actionNames[detail.expected] || "事件"}\n${lines.join("\n") || "附近没有可用帧"}`;
    } catch (error) { notify(error.message); }
  }

  async function showSession(id) {
    try {
      const session = await labApi(`/api/algorithm-tests/sessions/${encodeURIComponent(id)}`);
      selectedSessionId = id;
      const comparison = session.comparison || session.results || {};
      const current = comparison.current || session.current || {};
      const candidate = comparison.candidate || session.candidate || {};
      q("#labResultTitle").textContent = session.name || session.project_name || "测试结果";
      q("#labCompare").innerHTML = metricsHtml("当前参数", current.metrics || current) + metricsHtml(candidate.name || "候选参数", candidate.metrics || candidate, true);
      renderTimeline(comparison.timeline || session.timeline || current.timeline || []);
      renderConfusion(comparison.confusion_matrix || candidate.confusion_matrix || current.confusion_matrix || session.confusion_matrix || {});
      q("#labEventDetail").textContent = "点击错误事件查看前后关键点信号";
      q("#labResults").hidden = false;
    } catch (error) { notify(error.message); }
  }

  function renderSessions(payload) {
    sessions = payload.sessions || payload || [];
    if (payload.storage_path) q("#labStoragePath").textContent = payload.storage_path;
    q("#labSessionList").innerHTML = sessions.map((session) => `<div class="lab-session-row"><div><b>${esc(session.name || session.project_name || session.id)}</b><br><small>${esc(session.created_at || "")} · ${Number(session.frame_count || 0)} 帧</small></div><small>${esc(session.project_name || session.project_id || "")}</small><div class="lab-session-actions"><button class="ghost" data-open-session="${esc(session.id)}">查看</button><button class="ghost" data-rename-session="${esc(session.id)}">重命名</button><a href="/api/algorithm-tests/sessions/${encodeURIComponent(session.id)}/export/json">JSON</a><a href="/api/algorithm-tests/sessions/${encodeURIComponent(session.id)}/export/csv">CSV</a><button class="ghost" data-delete-session="${esc(session.id)}">删除</button></div></div>`).join("") || `<div class="lab-event-detail">还没有本地测试会话</div>`;
    q("#labSessionList").querySelectorAll("[data-open-session]").forEach((el) => el.addEventListener("click", () => showSession(el.dataset.openSession)));
    q("#labSessionList").querySelectorAll("[data-rename-session]").forEach((el) => el.addEventListener("click", async () => {
      const item = sessions.find((value) => value.id === el.dataset.renameSession);
      const name = prompt("会话名称", item?.name || item?.project_name || "真人测试");
      if (!name) return;
      await labApi(`/api/algorithm-tests/sessions/${encodeURIComponent(el.dataset.renameSession)}`, {method:"PATCH", body:JSON.stringify({name})});
      await loadSessions();
    }));
    q("#labSessionList").querySelectorAll("[data-delete-session]").forEach((el) => el.addEventListener("click", async () => {
      if (!confirm("删除这个本地测试会话？")) return;
      await labApi(`/api/algorithm-tests/sessions/${encodeURIComponent(el.dataset.deleteSession)}`, {method:"DELETE"});
      if (selectedSessionId === el.dataset.deleteSession) q("#labResults").hidden = true;
      await loadSessions();
    }));
  }

  async function loadSessions() { renderSessions(await labApi("/api/algorithm-tests/sessions")); }

  function renderActive(state) {
    active = !!state.active;
    q("#labSetup").querySelectorAll("input,select,button").forEach((el) => { el.disabled = active; });
    q("#labLive").hidden = !active;
    if (!active) return;
    activeSessionId = state.session_id || activeSessionId;
    q("#labLiveProject").textContent = state.project_name || "真人测试";
    q("#labInstruction").textContent = state.instruction || state.prompt || "按提示动作";
    q("#labCountdown").textContent = `${Math.max(0, Number(state.remaining_ms || 0) / 1000).toFixed(1)} 秒`;
    q("#labProgress").style.width = `${Math.max(0, Math.min(1, Number(state.progress || 0))) * 100}%`;
    q("#labFrameCount").textContent = `已记录 ${Number(state.frame_count || 0)} 帧 · 游戏输出已强制释放`;
  }

  async function pollActive() {
    try {
      const state = await labApi("/api/algorithm-tests/active");
      const wasActive = active;
      renderActive(state);
      if (wasActive && !state.active) {
        await loadSessions();
        const completed = state.completed_session_id || activeSessionId;
        if (completed) await showSession(completed);
        activeSessionId = null;
        notify("真人测试已保存，游戏输出保持关闭");
      }
    } catch (error) { if (active) notify(error.message); }
  }

  async function openLab() {
    q("#algorithmLabDialog").showModal();
    try {
      const catalog = await labApi("/api/algorithm-tests/projects");
      projects = catalog.projects || catalog;
      q("#labProject").innerHTML = projects.map((item) => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join("");
      if (catalog.storage_path) q("#labStoragePath").textContent = catalog.storage_path;
      await Promise.all([loadSessions(), pollActive()]);
      clearInterval(pollTimer);
      pollTimer = setInterval(pollActive, 250);
    } catch (error) { notify(error.message); }
  }

  q("#openAlgorithmLab").addEventListener("click", openLab);
  q("#closeAlgorithmLab").addEventListener("click", async () => {
    if (active && !confirm("测试仍在进行。结束、保存并保持游戏输出关闭？")) return;
    if (active) await labApi("/api/algorithm-tests/stop", {method:"POST"}).catch((error) => notify(error.message));
    clearInterval(pollTimer);
    q("#algorithmLabDialog").close();
  });
  q("#startAlgorithmLab").addEventListener("click", async () => {
    try {
      q("#labResults").hidden = true;
      const state = await labApi("/api/algorithm-tests/start", {method:"POST", body:JSON.stringify({project_id:q("#labProject").value, slot:Number(q("#labSlot").value), repetitions:Number(q("#labRepetitions").value), candidate_preset:q("#labCandidatePreset").value})});
      renderActive(state);
      notify("影子模式已锁定，开始记录真实关键点");
    } catch (error) { notify(error.message); }
  });
  q("#stopAlgorithmLab").addEventListener("click", async () => {
    try { const result = await labApi("/api/algorithm-tests/stop", {method:"POST"}); renderActive({active:false}); await loadSessions(); if (result?.id || result?.session_id) await showSession(result.id || result.session_id); } catch (error) { notify(error.message); }
  });
  q("#replayAlgorithmLab").addEventListener("click", async () => {
    if (!selectedSessionId) return;
    try {
      const result = await labApi(`/api/algorithm-tests/sessions/${encodeURIComponent(selectedSessionId)}/replay`, {method:"POST", body:JSON.stringify({candidate_preset:q("#labCandidatePreset").value})});
      await showSession(result.id || result.session_id || selectedSessionId);
      notify("已用同一真实关键点流重新比较");
    } catch (error) { notify(error.message); }
  });
})();
