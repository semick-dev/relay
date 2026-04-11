(function () {
  const vscode = acquireVsCodeApi();
  const bootstrap = window.__RELAY_BOOTSTRAP__;

  const state = {
    orgUrl: bootstrap.savedState.orgUrl || "",
    activeTheme: bootstrap.savedState.activeTheme || "neon",
    selectedProject: bootstrap.initialProject || "",
    currentView: bootstrap.initialView || "builds",
    selectedBuildId: null,
    visibleResource: null,
    buildFilter: "all",
    definitions: [],
    definitionFilter: ""
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
    themeCss: document.getElementById("theme-css"),
    toolbar: document.getElementById("toolbar")
  };

  window.addEventListener("message", (event) => {
    const message = event.data || {};
    if (message.type === "openProject" && typeof message.project === "string") {
      void openProject(message.project, message.view || "builds");
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
      await openProject(state.selectedProject, state.currentView);
    }
  }

  function bindEvents() {
    elements.closeDetail.addEventListener("click", closeDetail);
  }

  async function openProject(project, view) {
    state.selectedProject = project;
    state.currentView = view;
    state.selectedBuildId = null;
    closeDetail();
    setTitle(`Relay: ${project}`);
    elements.mainTitle.textContent = project;

    if (view === "definitions") {
      await loadDefinitions(false);
      return;
    }

    if (view === "artifacts") {
      renderArtifactsPlaceholder();
      return;
    }

    await loadBuilds(false);
  }

  async function loadBuilds(forceRefresh) {
    state.visibleResource = { kind: "builds", project: state.selectedProject };
    elements.mainStatus.textContent = "Loading recent builds...";
    renderBuildToolbar();
    const url = `/api/projects/${encodeURIComponent(state.selectedProject)}/builds?orgUrl=${encodeURIComponent(state.orgUrl)}${forceRefresh ? "&refresh=1" : ""}`;
    const response = await apiGet(url);
    state.builds = response.builds;
    renderBuilds(response.builds, response.projectName, response.cached, response.lastRefresh);
    await emit("relay.ui.panel.builds.loaded", {
      project: state.selectedProject,
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

  async function loadDefinitions(forceRefresh) {
    state.visibleResource = { kind: "definitions", project: state.selectedProject };
    elements.mainStatus.textContent = "Preparing build definitions...";
    renderDefinitionsToolbar();
    elements.buildList.className = "build-list empty-state";
    elements.buildList.textContent = "Loading definitions...";
    await apiPost(`/api/projects/${encodeURIComponent(state.selectedProject)}/definitions/precache`, {
      orgUrl: state.orgUrl,
      limitedRefresh: true
    });
    await pollDefinitionsStatus();
    const url = `/api/projects/${encodeURIComponent(state.selectedProject)}/definitions?orgUrl=${encodeURIComponent(state.orgUrl)}${forceRefresh ? "&refresh=1" : ""}`;
    const response = await apiGet(url);
    state.definitions = response.definitions;
    renderDefinitions(response.definitions, response.cached, response.lastRefresh);
    await emit("relay.ui.panel.definitions.loaded", {
      project: state.selectedProject,
      count: response.definitions.length,
      cached: response.cached
    }, "span");
  }

  async function pollDefinitionsStatus() {
    let attempts = 0;
    while (attempts < 120) {
      const status = await apiGet(`/api/projects/${encodeURIComponent(state.selectedProject)}/definitions/status?orgUrl=${encodeURIComponent(state.orgUrl)}`);
      updateDefinitionsProgress(status);
      if (!status.running) {
        if (status.error) {
          throw new Error(status.error);
        }
        return;
      }
      await sleep(350);
      attempts += 1;
    }
  }

  function renderBuildToolbar() {
    elements.toolbar.className = "toolbar";
    elements.toolbar.innerHTML = `
      <div class="filter-row">
        <button class="filter-chip ${state.buildFilter === "all" ? "is-active" : ""}" data-filter="all">All</button>
        <button class="filter-chip ${state.buildFilter === "inProgress" ? "is-active" : ""}" data-filter="inProgress">In Progress</button>
        <button class="filter-chip ${state.buildFilter === "failed" ? "is-active" : ""}" data-filter="failed">Failed / Cancelled</button>
        <button class="filter-chip ${state.buildFilter === "success" ? "is-active" : ""}" data-filter="success">Success</button>
      </div>
    `;
    for (const button of elements.toolbar.querySelectorAll("[data-filter]")) {
      button.addEventListener("click", () => {
        state.buildFilter = button.getAttribute("data-filter");
        renderBuildToolbar();
        renderBuilds(state.builds || [], state.selectedProject, true, new Date().toISOString());
      });
    }
  }

  function renderDefinitionsToolbar() {
    elements.toolbar.className = "toolbar toolbar--definitions";
    elements.toolbar.innerHTML = `
      <div class="definitions-toolbar">
        <input id="definition-filter" class="definitions-filter" type="text" placeholder="Filter definitions with wildcards like python*" value="${escapeAttr(state.definitionFilter)}" />
        <div class="progress-wrap">
          <div class="progress-meta">
            <span>Definition cache warmup</span>
            <span id="definitions-progress-label">Idle</span>
          </div>
          <div class="progress-bar"><div id="definitions-progress-bar" class="progress-bar__fill" style="width:0%"></div></div>
        </div>
      </div>
    `;
    const input = document.getElementById("definition-filter");
    input.addEventListener("input", () => {
      state.definitionFilter = input.value;
      renderDefinitions(state.definitions, true, new Date().toISOString());
    });
  }

  function updateDefinitionsProgress(status) {
    if (elements.toolbar.classList.contains("is-hidden")) {
      renderDefinitionsToolbar();
    }
    const label = document.getElementById("definitions-progress-label");
    const bar = document.getElementById("definitions-progress-bar");
    if (!label || !bar) {
      return;
    }
    const total = Math.max(status.totalCount || status.loadedCount || 1, 1);
    const pct = Math.max(5, Math.min(100, Math.round((status.loadedCount / total) * 100)));
    label.textContent = status.running
      ? `${status.loadedCount}/${total} cached`
      : `${status.loadedCount} cached`;
    bar.style.width = `${pct}%`;
  }

  function renderBuilds(builds, projectName, cached, lastRefresh) {
    const filtered = builds.filter((build) => matchesBuildFilter(build, state.buildFilter));
    elements.buildList.className = "build-list";
    if (!filtered.length) {
      elements.buildList.classList.add("empty-state");
      elements.buildList.textContent = "No builds match the selected state filter.";
      return;
    }

    elements.buildList.innerHTML = "";
    for (const build of filtered) {
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

  function renderDefinitions(definitions, cached, lastRefresh) {
    const filtered = definitions.filter((definition) => matchesWildcard(definition.name, state.definitionFilter));
    const tree = buildDefinitionTree(filtered);
    elements.buildList.className = "definition-tree";
    elements.buildList.innerHTML = tree.html || '<div class="empty-state">No definitions match the current filter.</div>';
    for (const summary of elements.buildList.querySelectorAll("summary")) {
      summary.addEventListener("click", () => {
        summary.parentElement.classList.toggle("is-open");
      });
    }
    elements.mainStatus.textContent = `${state.selectedProject} · ${filtered.length} definitions · ${cached ? "cached" : "fresh"} · ${formatDate(lastRefresh)}`;
  }

  function renderArtifactsPlaceholder() {
    elements.toolbar.className = "toolbar is-hidden";
    elements.buildList.className = "build-list empty-state";
    elements.buildList.innerHTML = "Artifacts view is planned but not implemented yet.";
    elements.mainStatus.textContent = `${state.selectedProject} · Artifacts`;
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

  function matchesBuildFilter(build, filter) {
    if (filter === "all") {
      return true;
    }
    if (filter === "inProgress") {
      return build.status === "inProgress" || build.status === "notStarted" || build.status === "postponed";
    }
    if (filter === "failed") {
      return build.result === "failed" || build.result === "canceled";
    }
    return build.result === "succeeded";
  }

  function buildDefinitionTree(definitions) {
    const root = {};
    for (const definition of definitions) {
      const segments = definition.path.split("\\").filter(Boolean);
      let cursor = root;
      for (const segment of segments) {
        cursor[segment] = cursor[segment] || { __folders: {}, __definitions: [] };
        cursor = cursor[segment].__folders;
      }
      cursor.__definitions = cursor.__definitions || [];
      cursor.__definitions.push(definition);
    }
    return {
      html: renderDefinitionNodes(root, 0)
    };
  }

  function renderDefinitionNodes(node, depth) {
    const folders = Object.entries(node)
      .filter(([key]) => key !== "__definitions")
      .sort(([left], [right]) => left.localeCompare(right));
    const definitions = (node.__definitions || []).sort((left, right) => left.name.localeCompare(right.name));
    let html = "";
    for (const [name, folder] of folders) {
      html += `
        <details class="folder-node" ${depth < 1 ? "open" : ""}>
          <summary>${escapeHtml(name)}</summary>
          <div class="folder-node__body">
            ${renderDefinitionNodes(folder.__folders, depth + 1)}
            ${(folder.__definitions || []).map((definition) => definitionCard(definition)).join("")}
          </div>
        </details>
      `;
    }
    html += definitions.map((definition) => definitionCard(definition)).join("");
    return html;
  }

  function definitionCard(definition) {
    return `
      <button class="definition-item">
        <div class="definition-item__name">${escapeHtml(definition.name)}</div>
        <div class="build-meta">
          <span>rev ${escapeHtml(String(definition.revision))}</span>
          <span>${escapeHtml(definition.queueStatus || "enabled")}</span>
          <span>${escapeHtml(formatDate(definition.latestBuild?.finishTime))}</span>
        </div>
      </button>
    `;
  }

  function matchesWildcard(value, pattern) {
    if (!pattern) {
      return true;
    }
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    const regex = new RegExp(`^${escaped}$`, "i");
    return regex.test(value);
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

  function escapeAttr(value) {
    return escapeHtml(value).replaceAll("`", "&#96;");
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();
