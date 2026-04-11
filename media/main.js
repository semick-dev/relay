(function () {
  const vscode = acquireVsCodeApi();
  const bootstrap = window.__RELAY_BOOTSTRAP__;

  const state = {
    orgUrl: bootstrap.savedState.orgUrl || "",
    activeTheme: bootstrap.savedState.activeTheme || "neon",
    selectedProject: "",
    selectedBuildId: null,
    visibleResource: null
  };

  const elements = {
    orgUrl: document.getElementById("org-url"),
    connectButton: document.getElementById("connect-button"),
    refreshButton: document.getElementById("refresh-button"),
    projectList: document.getElementById("project-list"),
    buildList: document.getElementById("build-list"),
    cachePill: document.getElementById("cache-pill"),
    mainTitle: document.getElementById("main-title"),
    mainStatus: document.getElementById("main-status"),
    messageBanner: document.getElementById("message-banner"),
    content: document.getElementById("content"),
    detailPanel: document.getElementById("detail-panel"),
    detailTitle: document.getElementById("detail-title"),
    detailBody: document.getElementById("detail-body"),
    closeDetail: document.getElementById("close-detail"),
    themeList: document.getElementById("theme-list"),
    themeCss: document.getElementById("theme-css")
  };

  init().catch((error) => {
    renderBanner(error.message || String(error), "error");
  });

  async function init() {
    elements.orgUrl.value = state.orgUrl;
    bindEvents();
    renderThemes();
    applyTheme(state.activeTheme);
    await emit("relay.ui.boot", { activeTheme: state.activeTheme }, "span");
    const session = await apiGet("/api/session");
    if (!session.authConfigured) {
      renderBanner(session.message, "error");
      elements.mainStatus.textContent = session.message;
      return;
    }
    if (state.orgUrl) {
      await loadProjects(false);
    }
  }

  function bindEvents() {
    elements.connectButton.addEventListener("click", () => {
      void loadProjects(true);
    });
    elements.refreshButton.addEventListener("click", () => {
      void refreshVisible();
    });
    elements.closeDetail.addEventListener("click", () => {
      closeDetail();
    });
  }

  async function loadProjects(forceRefresh) {
    state.orgUrl = elements.orgUrl.value.trim();
    persistState();
    renderBanner("", "info");
    elements.mainStatus.textContent = "Loading projects...";
    const url = `/api/org/projects?orgUrl=${encodeURIComponent(state.orgUrl)}${forceRefresh ? "&refresh=1" : ""}`;
    const response = await apiGet(url);
    setCachePill(response.cached, response.lastRefresh);
    renderProjects(response.projects);
    elements.mainStatus.textContent = `${response.projects.length} projects loaded.`;
    elements.mainTitle.textContent = "Choose a project";
    await emit("relay.ui.projects.loaded", {
      count: response.projects.length,
      cached: response.cached
    }, "span");
  }

  async function loadBuilds(project, forceRefresh) {
    state.selectedProject = project;
    state.visibleResource = { kind: "builds", project };
    elements.mainTitle.textContent = project;
    elements.mainStatus.textContent = "Loading recent builds...";
    const url = `/api/projects/${encodeURIComponent(project)}/builds?orgUrl=${encodeURIComponent(state.orgUrl)}${forceRefresh ? "&refresh=1" : ""}`;
    const response = await apiGet(url);
    renderBuilds(response.builds, response.projectName, response.cached, response.lastRefresh);
    setCachePill(response.cached, response.lastRefresh);
    await emit("relay.ui.builds.loaded", {
      project,
      count: response.builds.length,
      cached: response.cached
    }, "span");
  }

  async function loadBuild(buildId, forceRefresh) {
    state.selectedBuildId = buildId;
    state.visibleResource = { kind: "build", project: state.selectedProject, buildId };
    const url = `/api/builds/${buildId}?orgUrl=${encodeURIComponent(state.orgUrl)}&project=${encodeURIComponent(state.selectedProject)}${forceRefresh ? "&refresh=1" : ""}`;
    const response = await apiGet(url);
    openDetail(response.build);
    setCachePill(response.build.cached, response.build.lastRefresh);
    await emit("relay.ui.build.loaded", {
      buildId,
      cached: response.build.cached
    }, "span");
  }

  async function refreshVisible() {
    if (!state.visibleResource) {
      await loadProjects(true);
      return;
    }

    if (state.visibleResource.kind === "builds") {
      await apiPost("/api/cache/refresh", {
        resource: "builds",
        orgUrl: state.orgUrl,
        project: state.visibleResource.project
      });
      await loadBuilds(state.visibleResource.project, true);
      return;
    }

    if (state.visibleResource.kind === "build") {
      await apiPost("/api/cache/refresh", {
        resource: "build",
        orgUrl: state.orgUrl,
        project: state.visibleResource.project,
        buildId: state.visibleResource.buildId
      });
      await loadBuild(state.visibleResource.buildId, true);
      return;
    }

    await apiPost("/api/cache/refresh", {
      resource: "projects",
      orgUrl: state.orgUrl
    });
    await loadProjects(true);
  }

  function renderProjects(projects) {
    state.visibleResource = { kind: "projects" };
    state.selectedProject = "";
    state.selectedBuildId = null;
    closeDetail();
    if (!projects.length) {
      elements.projectList.innerHTML = '<div class="empty-state">No projects returned.</div>';
      return;
    }

    elements.projectList.innerHTML = "";
    for (const project of projects) {
      const button = document.createElement("button");
      button.className = "project-item";
      button.innerHTML = `
        <strong>${escapeHtml(project.name)}</strong>
        <div class="muted">${escapeHtml(project.description || project.state || "Project")}</div>
      `;
      button.addEventListener("click", () => {
        highlightProject(button);
        void loadBuilds(project.name, false);
      });
      elements.projectList.appendChild(button);
    }
  }

  function renderBuilds(builds, projectName, cached, lastRefresh) {
    elements.buildList.className = "build-list";
    if (!builds.length) {
      elements.buildList.classList.add("empty-state");
      elements.buildList.textContent = "No recent builds found.";
      return;
    }

    elements.buildList.classList.remove("empty-state");
    elements.buildList.innerHTML = "";
    for (const build of builds) {
      const item = document.createElement("button");
      item.className = "build-item";
      item.innerHTML = `
        <div class="build-item__top">
          <strong>#${escapeHtml(String(build.id))} · ${escapeHtml(build.buildNumber)}</strong>
          <span class="pill">${escapeHtml(build.result || build.status)}</span>
        </div>
        <div>${escapeHtml(build.definitionName)}</div>
        <div class="build-meta">
          <span>${escapeHtml(build.sourceBranch || "No branch")}</span>
          <span>${escapeHtml(build.requestedFor || "Unknown requester")}</span>
          <span>${escapeHtml(formatDate(build.finishTime || build.queueTime))}</span>
        </div>
      `;
      item.addEventListener("click", () => {
        void loadBuild(build.id, false);
      });
      elements.buildList.appendChild(item);
    }
    elements.mainStatus.textContent = `${projectName} · last 10 builds · ${cached ? "cached" : "fresh"} · ${formatDate(lastRefresh)}`;
  }

  function openDetail(build) {
    elements.content.classList.add("is-split");
    elements.detailPanel.classList.remove("is-hidden");
    elements.detailTitle.textContent = `#${build.id} · ${build.buildNumber}`;
    elements.detailBody.className = "detail-grid";
    elements.detailBody.innerHTML = [
      detailCard("Definition", build.definitionName),
      detailCard("Project", build.projectName),
      detailCard("Status", `${build.status} / ${build.result}`),
      detailCard("Branch", build.sourceBranch || "n/a"),
      detailCard("Requester", build.requestedFor || "n/a"),
      detailCard("Repository", build.repository || "n/a"),
      detailCard("Reason", build.reason || "n/a"),
      detailCard("Queued", formatDate(build.queueTime)),
      detailCard("Started", formatDate(build.startTime)),
      detailCard("Finished", formatDate(build.finishTime)),
      detailCard("Last Refresh", formatDate(build.lastRefresh)),
      detailCard("Cache", build.cached ? "cache hit" : "fresh fetch")
    ].join("");
  }

  function closeDetail() {
    elements.content.classList.remove("is-split");
    elements.detailPanel.classList.add("is-hidden");
    elements.detailBody.className = "detail-grid empty-state";
    elements.detailBody.textContent = "Choose a build to inspect.";
  }

  function renderThemes() {
    const themeConfig = {
      neon: ["#ff4fd8", "#56d7ff"],
      nightwave: ["#26b4ff", "#2effc8"],
      ember: ["#ff7a4f", "#ffcc5c"]
    };
    elements.themeList.innerHTML = "";
    for (const themeId of bootstrap.themeIds) {
      const swatch = document.createElement("button");
      swatch.className = "theme-swatch";
      swatch.style.background = `linear-gradient(135deg, ${themeConfig[themeId][0]}, ${themeConfig[themeId][1]})`;
      swatch.title = themeId;
      if (themeId === state.activeTheme) {
        swatch.classList.add("is-active");
      }
      swatch.addEventListener("click", () => {
        state.activeTheme = themeId;
        applyTheme(themeId);
        renderThemes();
        persistState();
        void emit("relay.ui.theme.switch", { themeId }, "span");
      });
      elements.themeList.appendChild(swatch);
    }
  }

  function applyTheme(themeId) {
    elements.themeCss.setAttribute("href", bootstrap.themeUrls[themeId]);
  }

  function setCachePill(cached, lastRefresh) {
    elements.cachePill.textContent = `${cached ? "Cached" : "Fresh"} · ${formatDate(lastRefresh)}`;
  }

  function renderBanner(message, level) {
    if (!message) {
      elements.messageBanner.innerHTML = "";
      return;
    }
    elements.messageBanner.innerHTML = `<div class="banner">${escapeHtml(message)}</div>`;
    void emit("relay.ui.banner", { level, message });
  }

  function persistState() {
    vscode.postMessage({
      type: "persistState",
      state: {
        activeTheme: state.activeTheme,
        orgUrl: state.orgUrl
      }
    });
  }

  async function apiGet(path) {
    const response = await fetch(`${bootstrap.apiBase}${path}`);
    const payload = await response.json();
    if (!response.ok || payload.ok === false) {
      const message = payload.error || `Request failed with ${response.status}`;
      renderBanner(message, "error");
      throw new Error(message);
    }
    return payload;
  }

  async function apiPost(path, body) {
    const response = await fetch(`${bootstrap.apiBase}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    const payload = await response.json();
    if (!response.ok || payload.ok === false) {
      const message = payload.error || `Request failed with ${response.status}`;
      renderBanner(message, "error");
      throw new Error(message);
    }
    return payload;
  }

  async function emit(name, attributes, kind = "log") {
    const payload = {
      kind,
      name,
      timestamp: new Date().toISOString(),
      level: "info",
      attributes
    };
    try {
      await fetch(`${bootstrap.telemetryBase}/api/telemetry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
    } catch (_) {
      return;
    }
  }

  function highlightProject(activeButton) {
    for (const element of elements.projectList.querySelectorAll(".project-item")) {
      element.classList.remove("is-active");
    }
    activeButton.classList.add("is-active");
  }

  function detailCard(label, value) {
    return `<div class="detail-card"><p class="eyebrow">${escapeHtml(label)}</p><div><code>${escapeHtml(value)}</code></div></div>`;
  }

  function formatDate(value) {
    if (!value) {
      return "n/a";
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return value;
    }
    return date.toLocaleString();
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }
})();
