(function () {
  const vscode = acquireVsCodeApi();
  const bootstrap = window.__RELAY_BOOTSTRAP__;

  const state = {
    orgUrl: bootstrap.savedState.orgUrl || "",
    activeTheme: bootstrap.savedState.activeTheme || "neon",
    selectedProject: bootstrap.initialProject || "",
    selectedBuildId: null,
    visibleResource: null
  };

  const elements = {
    buildList: document.getElementById("build-list"),
    mainTitle: document.getElementById("main-title"),
    mainStatus: document.getElementById("main-status"),
    messageBanner: document.getElementById("message-banner"),
    content: document.getElementById("content"),
    detailPanel: document.getElementById("detail-panel"),
    detailTitle: document.getElementById("detail-title"),
    detailBody: document.getElementById("detail-body"),
    closeDetail: document.getElementById("close-detail"),
    themeCss: document.getElementById("theme-css")
  };

  window.addEventListener("message", (event) => {
    const message = event.data || {};
    if (message.type === "openProject" && typeof message.project === "string") {
      void loadBuilds(message.project, false);
    }
    if (message.type === "themeChanged" && bootstrap.themeUrls[message.themeId]) {
      state.activeTheme = message.themeId;
      applyTheme(message.themeId);
    }
  });

  init().catch((error) => {
    renderBanner(error.message || String(error));
  });

  async function init() {
    bindEvents();
    applyTheme(state.activeTheme);
    await emit("relay.ui.panel.boot", { activeTheme: state.activeTheme }, "span");
    if (!state.orgUrl) {
      renderBanner("No organization URL is set. Use the Relay sidebar first.");
      return;
    }
    const session = await apiGet("/api/session");
    if (!session.authConfigured) {
      renderBanner(session.message);
      elements.mainStatus.textContent = session.message;
      return;
    }
    if (state.selectedProject) {
      await loadBuilds(state.selectedProject, false);
    }
  }

  function bindEvents() {
    elements.closeDetail.addEventListener("click", closeDetail);
  }

  async function loadBuilds(project, forceRefresh) {
    state.selectedProject = project;
    state.visibleResource = { kind: "builds", project };
    elements.mainTitle.textContent = project;
    elements.mainStatus.textContent = "Loading recent builds...";
    setTitle(`Relay: ${project}`);
    const url = `/api/projects/${encodeURIComponent(project)}/builds?orgUrl=${encodeURIComponent(state.orgUrl)}${forceRefresh ? "&refresh=1" : ""}`;
    const response = await apiGet(url);
    renderBuilds(response.builds, response.projectName, response.cached, response.lastRefresh);
    await emit("relay.ui.panel.builds.loaded", {
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
    await emit("relay.ui.panel.build.loaded", {
      buildId,
      cached: response.build.cached
    }, "span");
  }

  function renderBuilds(builds, projectName, cached, lastRefresh) {
    elements.buildList.className = "build-list";
    if (!builds.length) {
      elements.buildList.classList.add("empty-state");
      elements.buildList.textContent = "No recent builds found.";
      return;
    }

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

  function setTitle(title) {
    vscode.postMessage({
      type: "setTitle",
      title
    });
  }

  function applyTheme(themeId) {
    elements.themeCss.setAttribute("href", bootstrap.themeUrls[themeId]);
  }

  function renderBanner(message) {
    elements.messageBanner.innerHTML = message
      ? `<div class="banner">${escapeHtml(message)}</div>`
      : "";
  }

  async function apiGet(path) {
    const response = await fetch(`${bootstrap.apiBase}${path}`);
    const payload = await response.json();
    if (!response.ok || payload.ok === false) {
      const message = payload.error || `Request failed with ${response.status}`;
      renderBanner(message);
      throw new Error(message);
    }
    return payload;
  }

  async function emit(name, attributes, kind = "log") {
    try {
      await fetch(`${bootstrap.telemetryBase}/api/telemetry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind,
          name,
          timestamp: new Date().toISOString(),
          level: "info",
          attributes
        })
      });
    } catch (_) {
      return;
    }
  }

  function detailCard(label, value) {
    return `<div class="detail-card"><p class="eyebrow">${escapeHtml(label)}</p><div><code>${escapeHtml(value)}</code></div></div>`;
  }

  function formatDate(value) {
    if (!value) {
      return "n/a";
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
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
