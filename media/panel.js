(function () {
  const vscode = acquireVsCodeApi();
  const bootstrap = window.__RELAY_BOOTSTRAP__;

  const state = {
    orgUrl: bootstrap.savedState.orgUrl || "",
    activeTheme: bootstrap.savedState.activeTheme || "githubdark",
    selectedProject: bootstrap.initialProject || "",
    loadedDefinitionsProject: "",
    selectedDefinition: null,
    definitions: [],
    definitionsLoading: false,
    definitionFilter: "",
    definitionBuilds: [],
    definitionBuildsMeta: null,
    buildFilter: "all",
    currentBuild: null,
    currentTimeline: [],
    currentTimelineMeta: null,
    currentTask: null,
    currentArtifacts: [],
    currentArtifactsMeta: null,
    artifactTargetFolder: "",
    artifactNotice: "",
    navState: null
  };

  const elements = {
    buildList: document.getElementById("build-list"),
    mainTitle: document.getElementById("main-title"),
    mainStatus: document.getElementById("main-status"),
    messageBanner: document.getElementById("message-banner"),
    content: document.getElementById("content"),
    mainCachePill: document.getElementById("main-cache-pill"),
    detailPanel: document.getElementById("detail-panel"),
    detailTitle: document.getElementById("detail-title"),
    detailBody: document.getElementById("detail-body"),
    detailCachePill: document.getElementById("detail-cache-pill"),
    closeDetail: document.getElementById("close-detail"),
    themeCss: document.getElementById("theme-css"),
    toolbar: document.getElementById("toolbar")
  };

  window.addEventListener("message", (event) => {
    const message = event.data || {};
    if (message.type === "openProject" && typeof message.project === "string") {
      void openProject(message.project, message.view || "definitions");
    }
    if (message.type === "themeChanged" && bootstrap.themeUrls[message.themeId]) {
      state.activeTheme = message.themeId;
      applyTheme(message.themeId);
    }
    if (message.type === "folderChosen" && typeof message.folder === "string") {
      state.artifactTargetFolder = message.folder;
      if (state.currentBuild) {
        openArtifactsPane();
      }
    }
  });

  window.addEventListener("popstate", (event) => {
    if (event.state) {
      void restoreNavState(event.state, false);
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
      await openProject(state.selectedProject, bootstrap.initialView || "definitions");
    }
  }

  function bindEvents() {
    elements.closeDetail.addEventListener("click", () => {
      closeTaskPane();
    });
    elements.mainCachePill.addEventListener("click", () => {
      void refreshMainPane();
    });
    elements.detailCachePill.addEventListener("click", () => {
      void refreshDetailPane();
    });
  }

  async function openProject(project, view) {
    state.selectedProject = project;
    state.selectedDefinition = null;
    state.currentBuild = null;
    state.definitionBuilds = [];
    setTitle(`Relay: ${project}`);

    if (view === "artifacts") {
      commitNavState({ mode: "artifacts", project }, true);
      renderArtifactsPlaceholder();
      return;
    }

    await loadDefinitions(false);
    commitNavState({ mode: "definitions", project }, true);
    renderDefinitionsScreen();
  }

  async function loadDefinitions(forceRefresh) {
    state.definitionsLoading = true;
    elements.mainStatus.textContent = "Preparing build definitions...";
    try {
      await apiPost(`/api/projects/${encodeURIComponent(state.selectedProject)}/definitions/precache`, {
        orgUrl: state.orgUrl,
        limitedRefresh: true
      });
      await pollDefinitionsStatus();
      const url = `/api/projects/${encodeURIComponent(state.selectedProject)}/definitions?orgUrl=${encodeURIComponent(state.orgUrl)}${forceRefresh ? "&refresh=1" : ""}`;
      const response = await apiGet(url);
      state.definitions = response.definitions;
      state.loadedDefinitionsProject = state.selectedProject;
      state.definitionsMeta = response;
    } finally {
      state.definitionsLoading = false;
    }
  }

  async function openDefinition(definition, replaceHistory) {
    state.selectedDefinition = definition;
    state.currentBuild = null;
    state.currentTask = null;
    await loadDefinitionBuilds(definition.id, true);
    commitNavState({
      mode: "definitionBuilds",
      project: state.selectedProject,
      definitionId: definition.id
    }, replaceHistory);
    renderDefinitionsScreen();
  }

  async function loadDefinitionBuilds(definitionId, forceRefresh) {
    state.buildFilter = state.buildFilter || "all";
    const url = `/api/projects/${encodeURIComponent(state.selectedProject)}/builds?orgUrl=${encodeURIComponent(state.orgUrl)}&definitionId=${definitionId}${forceRefresh ? "&refresh=1" : ""}`;
    const response = await apiGet(url);
    state.definitionBuilds = response.builds;
    state.definitionBuildsMeta = response;
  }

  async function openBuild(buildId, replaceHistory) {
    const url = `/api/builds/${buildId}?orgUrl=${encodeURIComponent(state.orgUrl)}&project=${encodeURIComponent(state.selectedProject)}`;
    const response = await apiGet(url);
    state.currentBuild = response.build;
    state.currentTask = null;
    state.currentArtifacts = [];
    state.artifactNotice = "";
    const timelineResponse = await apiGet(`/api/builds/${buildId}/timeline?orgUrl=${encodeURIComponent(state.orgUrl)}&project=${encodeURIComponent(state.selectedProject)}`);
    state.currentTimeline = timelineResponse.timeline;
    state.currentTimelineMeta = timelineResponse;
    commitNavState({
      mode: "build",
      project: state.selectedProject,
      definitionId: state.selectedDefinition?.id,
      buildId
    }, replaceHistory);
    renderBuildPage();
    await emit("relay.ui.panel.build.loaded", {
      buildId,
      cached: response.build.cached
    }, "span");
  }

  async function restoreNavState(navState, replaceHistory) {
    state.selectedProject = navState.project;

    if (navState.mode === "artifacts") {
      commitNavState(navState, replaceHistory);
      renderArtifactsPlaceholder();
      return;
    }

    if (!state.definitions.length || state.loadedDefinitionsProject !== navState.project) {
      await loadDefinitions(false);
    }

    if (navState.mode === "definitions") {
      state.selectedDefinition = null;
      state.currentBuild = null;
      commitNavState(navState, replaceHistory);
      renderDefinitionsScreen();
      return;
    }

    const definition = resolveDefinitionReference(String(navState.definitionId ?? ""));
    if (!definition) {
      renderBanner("Could not restore the selected definition.");
      renderDefinitionsScreen();
      return;
    }

    state.selectedDefinition = definition;

    if (navState.mode === "definitionBuilds") {
      await loadDefinitionBuilds(definition.id, false);
      commitNavState(navState, replaceHistory);
      renderDefinitionsScreen();
      return;
    }

    await loadDefinitionBuilds(definition.id, false);
    await openBuild(navState.buildId, replaceHistory);
  }

  async function pollDefinitionsStatus() {
    renderDefinitionsToolbar();
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

  function renderDefinitionsScreen() {
    elements.content.classList.toggle("is-split", Boolean(state.selectedDefinition));
    elements.detailPanel.classList.toggle("is-hidden", !state.selectedDefinition);
    elements.mainTitle.textContent = state.selectedProject;
    elements.detailTitle.textContent = state.selectedDefinition
      ? `${state.selectedDefinition.name} · builds`
      : "Definition builds";
    renderDefinitionsToolbar();
    renderDefinitionsTree();
    setMainCachePill(state.definitionsMeta?.cached, state.definitionsMeta?.lastRefresh, "Refresh definitions");

    if (!state.selectedDefinition) {
      elements.detailBody.className = "detail-pane detail-pane--placeholder";
      elements.detailBody.innerHTML = `<div class="empty-state">Choose a definition to load its builds.</div>`;
      elements.mainStatus.textContent = `${state.selectedProject} · ${state.definitions.length} definitions`;
      setDetailCachePill(null, null, "No detail cache");
      return;
    }

    renderDefinitionBuildsPane();
  }

  function renderDefinitionsToolbar() {
    elements.toolbar.className = "toolbar toolbar--definitions";
    elements.toolbar.innerHTML = `
      <div class="definitions-toolbar">
        <input id="definition-filter" class="definitions-filter" type="text" placeholder="Filter definitions like python* or api" value="${escapeAttr(state.definitionFilter)}" />
        <div id="definitions-loading" class="definitions-loading ${state.definitionsLoading ? "" : "is-hidden"}">
          <span class="spinner"></span>
          <span id="definitions-loading-label">Loading definitions...</span>
        </div>
      </div>
    `;
    const input = document.getElementById("definition-filter");
    input.addEventListener("input", () => {
      state.definitionFilter = input.value;
      renderDefinitionsTree();
    });
  }

  function updateDefinitionsProgress(status) {
    const host = document.getElementById("definitions-loading");
    const label = document.getElementById("definitions-loading-label");
    if (!host || !label) {
      return;
    }
    if (state.definitionsLoading && status.running) {
      host.classList.remove("is-hidden");
      const total = Math.max(status.totalCount || status.loadedCount || 1, 1);
      label.textContent = `Loading definitions... ${status.loadedCount}/${total}`;
      return;
    }
    host.classList.add("is-hidden");
  }

  function renderDefinitionsTree() {
    const filtered = state.definitions.filter((definition) => matchesWildcard(definition.name, state.definitionFilter));
    const tree = buildDefinitionTree(filtered);
    elements.buildList.className = "definition-tree";
    elements.buildList.innerHTML = tree || '<div class="empty-state">No definitions match the current filter.</div>';
    for (const button of elements.buildList.querySelectorAll("[data-definition-id]")) {
      button.addEventListener("click", () => {
        const definition = resolveDefinitionReference(button.getAttribute("data-definition-id"));
        if (definition) {
          void openDefinition(definition, false);
        }
      });
    }
    elements.mainStatus.textContent = `${state.selectedProject} · ${filtered.length} definitions`;
  }

  function renderDefinitionBuildsPane() {
    elements.detailBody.className = "detail-pane";
    elements.detailBody.innerHTML = `
      <div class="selector-shell">
        <label class="eyebrow" for="definition-selector">Definition</label>
        <div class="selector-row">
          <input id="definition-selector" class="definitions-filter" type="text" value="${escapeAttr(`${state.selectedDefinition.id} · ${state.selectedDefinition.name}`)}" />
          <button id="definition-selector-open" class="button button--primary">Load</button>
          <button id="definition-selector-back" class="button button--ghost">Back</button>
        </div>
      </div>
      <div class="definition-builds-meta muted">
        #${escapeHtml(String(state.selectedDefinition.id))} ·
        ${(state.definitionBuildsMeta?.cached ? "cached" : "fresh")} ·
        ${escapeHtml(String(state.definitionBuildsMeta?.builds?.length ?? state.definitionBuilds.length))} builds ·
        ${escapeHtml(formatDate(state.definitionBuildsMeta?.lastRefresh))}
      </div>
      <div class="filter-row">
        <button class="filter-chip ${state.buildFilter === "all" ? "is-active" : ""}" data-filter="all">All</button>
        <button class="filter-chip ${state.buildFilter === "inProgress" ? "is-active" : ""}" data-filter="inProgress">In Progress</button>
        <button class="filter-chip ${state.buildFilter === "failed" ? "is-active" : ""}" data-filter="failed">Failed / Cancelled</button>
        <button class="filter-chip ${state.buildFilter === "success" ? "is-active" : ""}" data-filter="success">Success</button>
      </div>
      <div id="definition-build-list" class="build-list"></div>
    `;
    setDetailCachePill(state.definitionBuildsMeta?.cached, state.definitionBuildsMeta?.lastRefresh, "Refresh build list");

    document.getElementById("definition-selector-open").addEventListener("click", () => {
      void applyDefinitionSelection();
    });
    document.getElementById("definition-selector").addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void applyDefinitionSelection();
      }
    });
    document.getElementById("definition-selector-back").addEventListener("click", () => {
      history.back();
    });

    for (const button of elements.detailBody.querySelectorAll("[data-filter]")) {
      button.addEventListener("click", () => {
        state.buildFilter = button.getAttribute("data-filter");
        renderDefinitionBuildsPane();
      });
    }

    renderDefinitionBuildList();
  }

  function renderDefinitionBuildList() {
    const host = document.getElementById("definition-build-list");
    const total = state.definitionBuilds.length;
    const filtered = state.definitionBuilds.filter((build) => matchesBuildFilter(build, state.buildFilter));
    if (!total) {
      host.className = "build-list empty-state";
      host.textContent = `No builds returned for definition #${state.selectedDefinition.id}.`;
      return;
    }
    if (!filtered.length) {
      host.className = "build-list empty-state";
      host.textContent = "Builds were returned, but none match the selected state filter.";
      return;
    }

    host.className = "build-list";
    host.innerHTML = filtered.map((build) => `
      <button class="build-item" data-build-id="${build.id}">
        <span class="build-item__corner ${buildStatusClass(build)}" title="${escapeAttr(build.result || build.status)}"></span>
        <div class="build-item__top">
          <strong>#${escapeHtml(String(build.id))} · ${escapeHtml(build.buildNumber)} · ${escapeHtml(build.definitionName)}</strong>
        </div>
        <div class="build-item__title">${escapeHtml(truncateCommitMessage(build.commitMessage))}</div>
        <div class="build-meta">
          <span>${escapeHtml(build.sourceBranch || "No branch")}</span>
          <span>${escapeHtml(build.requestedFor || "Unknown requester")}</span>
          <span>${escapeHtml(formatDate(build.finishTime || build.queueTime))}</span>
        </div>
      </button>
    `).join("");

    for (const button of host.querySelectorAll("[data-build-id]")) {
      button.addEventListener("click", () => {
        void openBuild(Number(button.getAttribute("data-build-id")), false);
      });
    }
  }

  async function applyDefinitionSelection() {
    const raw = document.getElementById("definition-selector").value.trim();
    const definition = resolveDefinitionReference(raw);
    if (!definition) {
      renderBanner("Definition not found. Use an exact id, substring, or wildcard like python*.");
      return;
    }
    renderBanner("");
    await openDefinition(definition, false);
  }

  function renderBuildPage() {
    elements.content.classList.remove("is-split");
    elements.detailPanel.classList.add("is-hidden");
    elements.toolbar.className = "toolbar is-hidden";
    elements.mainTitle.textContent = `#${state.currentBuild.id} · ${state.currentBuild.buildNumber}`;
    elements.mainStatus.textContent = `${state.currentBuild.definitionName} · ${state.currentBuild.status} / ${state.currentBuild.result}`;
    setMainCachePill(state.currentTimelineMeta?.cached ?? state.currentBuild.cached, state.currentTimelineMeta?.lastRefresh ?? state.currentBuild.lastRefresh, "Refresh build");
    setDetailCachePill(null, null, "No detail cache");
    elements.buildList.className = "build-page";
    elements.buildList.innerHTML = `
      <div class="build-page__topbar">
        <button id="build-page-back" class="button button--ghost">Back</button>
      </div>
      <details class="build-summary" open>
        <summary>Build Details</summary>
        <div class="build-summary__actions">
          <button id="build-artifacts-button" class="button button--ghost">Artifacts</button>
        </div>
        <div class="build-summary__grid">
          ${detailCard("Definition", state.currentBuild.definitionName)}
          ${detailCard("Project", state.currentBuild.projectName)}
          ${detailCard("Status", `${state.currentBuild.status} / ${state.currentBuild.result}`)}
          ${detailCard("Branch", state.currentBuild.sourceBranch || "n/a")}
          ${detailCard("Requester", state.currentBuild.requestedFor || "n/a")}
          ${detailCard("Repository", state.currentBuild.repository || "n/a")}
          ${detailCard("Reason", state.currentBuild.reason || "n/a")}
          ${detailCard("Started", formatDate(state.currentBuild.queueTime))}
        </div>
      </details>
      <section class="task-tree-shell">
        <div class="section-head">
          <h3>Build Details</h3>
          <span class="muted">${escapeHtml(state.currentTimelineMeta?.cached ? "cached timeline" : "fresh timeline")}</span>
        </div>
        <div class="task-tree">${renderTimelineTree(state.currentTimeline)}</div>
      </section>
    `;
    document.getElementById("build-page-back").addEventListener("click", () => history.back());
    document.getElementById("build-artifacts-button").addEventListener("click", () => {
      void loadArtifacts(false);
    });
    for (const button of elements.buildList.querySelectorAll("[data-task-name][data-log-id]")) {
      button.addEventListener("click", () => {
        void openTaskPane(
          button.getAttribute("data-task-name"),
          Number(button.getAttribute("data-log-id")),
          Number(button.getAttribute("data-log-lines") || "0")
        );
      });
    }
  }

  async function openTaskPane(taskName, logId, logLineCount = 0, forceRefresh = false) {
    state.currentTask = {
      taskName,
      logId,
      logLineCount
    };
    elements.content.classList.add("is-split");
    elements.detailPanel.classList.remove("is-hidden");
    elements.detailTitle.textContent = taskName;
    elements.detailBody.className = "detail-pane";
    elements.detailBody.innerHTML = `
      <div class="task-pane">
        <p class="eyebrow">Task</p>
        <h3>${escapeHtml(taskName)}</h3>
        <div class="banner">Loading task output...</div>
      </div>
    `;
    const info = await apiGet(`/api/builds/${state.currentBuild.id}/logs/${logId}/meta?orgUrl=${encodeURIComponent(state.orgUrl)}&project=${encodeURIComponent(state.selectedProject)}`);
    if (info.shouldDelayDownload && !forceRefresh) {
      setDetailCachePill(info.cached, info.lastRefresh, "Refresh task output");
      elements.detailBody.innerHTML = `
        <div class="task-pane">
          <p class="eyebrow">Task</p>
          <h3>${escapeHtml(taskName)}</h3>
          <div class="definition-builds-meta muted">${info.cached ? "cached" : "not downloaded"} · ${escapeHtml(String(info.lineCount || logLineCount || 0))} lines</div>
          <div class="banner">This task log is large, so Relay will only download it when you ask.</div>
          <button id="task-download-button" class="button button--primary">Download Task Output</button>
          <div id="task-download-progress" class="progress-wrap is-hidden">
            <div class="progress-meta">
              <span>Downloading task output</span>
              <span id="task-download-label">Starting</span>
            </div>
            <div class="progress-bar"><div id="task-download-bar" class="progress-bar__fill progress-bar__fill--indeterminate"></div></div>
          </div>
        </div>
      `;
      document.getElementById("task-download-button").addEventListener("click", async () => {
        const progress = document.getElementById("task-download-progress");
        const label = document.getElementById("task-download-label");
        progress.classList.remove("is-hidden");
        label.textContent = "Downloading";
        await openTaskPane(taskName, logId, logLineCount, true);
      });
      return;
    }

    const response = await apiGet(`/api/builds/${state.currentBuild.id}/logs/${logId}?orgUrl=${encodeURIComponent(state.orgUrl)}&project=${encodeURIComponent(state.selectedProject)}${forceRefresh ? "&refresh=1" : ""}`);
    setDetailCachePill(response.cached, response.lastRefresh, "Refresh task output");
    elements.detailBody.innerHTML = response.inline
      ? `
        <div class="task-pane">
          <p class="eyebrow">Task</p>
          <h3>${escapeHtml(taskName)}</h3>
          <div class="definition-builds-meta muted">${response.cached ? "cached" : "fresh"} · ${formatBytes(response.sizeBytes)} · ${escapeHtml(formatDate(response.lastRefresh))}</div>
          <pre class="task-log">${escapeHtml(response.content || "")}</pre>
        </div>
      `
      : `
        <div class="task-pane">
          <p class="eyebrow">Task</p>
          <h3>${escapeHtml(taskName)}</h3>
          <div class="definition-builds-meta muted">${response.cached ? "cached" : "fresh"} · ${formatBytes(response.sizeBytes)} · ${escapeHtml(formatDate(response.lastRefresh))}</div>
          <div class="banner">Task output is larger than 1MB.</div>
          <div class="detail-card">
            <p class="eyebrow">Local Path</p>
            <code>${escapeHtml(response.downloadPath || "")}</code>
          </div>
          <div class="button-row">
            <button id="task-show-log-button" class="button button--primary">Show Log</button>
          </div>
        </div>
      `;
    const showButton = document.getElementById("task-show-log-button");
    if (showButton && response.downloadPath) {
      showButton.addEventListener("click", () => {
        vscode.postMessage({
          type: "openLogFile",
          path: response.downloadPath
        });
      });
    }
  }

  async function loadArtifacts(forceRefresh) {
    const response = await apiGet(`/api/builds/${state.currentBuild.id}/artifacts?orgUrl=${encodeURIComponent(state.orgUrl)}&project=${encodeURIComponent(state.selectedProject)}${forceRefresh ? "&refresh=1" : ""}`);
    state.currentArtifacts = response.artifacts;
    state.currentArtifactsMeta = response;
    openArtifactsPane();
  }

  function openArtifactsPane() {
    elements.content.classList.add("is-split");
    elements.detailPanel.classList.remove("is-hidden");
    elements.detailTitle.textContent = "Artifacts";
    setDetailCachePill(state.currentArtifactsMeta?.cached, state.currentArtifactsMeta?.lastRefresh, "Refresh artifacts");
    elements.detailBody.className = "detail-pane";
    elements.detailBody.innerHTML = `
      <div class="selector-shell">
        <label class="eyebrow" for="artifact-folder">Target Folder</label>
        <div class="selector-row selector-row--artifacts">
          <input id="artifact-folder" class="definitions-filter" type="text" value="${escapeAttr(state.artifactTargetFolder)}" placeholder="Choose a folder to download into" />
          <button id="artifact-folder-pick" class="button button--ghost">Choose</button>
        </div>
      </div>
      <div class="definition-builds-meta muted">
        ${state.currentArtifactsMeta?.cached ? "cached" : "fresh"} ·
        ${escapeHtml(String(state.currentArtifacts.length))} artifacts ·
        ${escapeHtml(formatDate(state.currentArtifactsMeta?.lastRefresh))}
      </div>
      ${state.artifactNotice ? `<div class="banner">${escapeHtml(state.artifactNotice)}</div>` : ""}
      <div id="artifact-list" class="artifact-list"></div>
    `;
    document.getElementById("artifact-folder").addEventListener("input", (event) => {
      state.artifactTargetFolder = event.target.value;
    });
    document.getElementById("artifact-folder-pick").addEventListener("click", () => {
      vscode.postMessage({ type: "chooseFolder" });
    });
    renderArtifactList();
  }

  function renderArtifactList() {
    const host = document.getElementById("artifact-list");
    if (!host) {
      return;
    }
    if (!state.currentArtifacts.length) {
      host.className = "build-list empty-state";
      host.textContent = "No artifacts were published for this build.";
      return;
    }
    host.className = "artifact-list";
    host.innerHTML = state.currentArtifacts.map((artifact) => `
      <div class="artifact-item">
        <div>
          <div class="artifact-item__name">${escapeHtml(artifact.name)}</div>
          <div class="build-meta">
            <span>${escapeHtml(artifact.downloadedPath || artifact.resourceType || "artifact")}</span>
          </div>
        </div>
        ${artifact.downloadedPath
          ? `<div class="artifact-item__downloaded" title="Downloaded">✓</div>`
          : `<button class="button button--primary" data-artifact-name="${escapeAttr(artifact.name)}">Download</button>`}
      </div>
    `).join("");
    for (const button of host.querySelectorAll("[data-artifact-name]")) {
      button.addEventListener("click", () => {
        void downloadArtifact(button.getAttribute("data-artifact-name"));
      });
    }
  }

  async function downloadArtifact(artifactName) {
    if (!state.artifactTargetFolder) {
      state.artifactNotice = "Choose a target folder before downloading an artifact.";
      openArtifactsPane();
      return;
    }
    state.artifactNotice = "";
    const response = await apiPost(`/api/builds/${state.currentBuild.id}/artifacts/download?orgUrl=${encodeURIComponent(state.orgUrl)}&project=${encodeURIComponent(state.selectedProject)}`, {
      artifactName,
      targetFolder: state.artifactTargetFolder
    });
    await loadArtifacts(true);
  }

  function closeTaskPane() {
    if (state.currentBuild) {
      state.currentTask = null;
      renderBuildPage();
      return;
    }
    history.back();
  }

  function renderArtifactsPlaceholder() {
    elements.content.classList.remove("is-split");
    elements.detailPanel.classList.add("is-hidden");
    elements.toolbar.className = "toolbar is-hidden";
    elements.mainTitle.textContent = state.selectedProject;
    elements.mainStatus.textContent = `${state.selectedProject} · Artifacts`;
    setMainCachePill(null, null, "No artifact cache");
    setDetailCachePill(null, null, "No detail cache");
    elements.buildList.className = "build-list empty-state";
    elements.buildList.innerHTML = "Artifacts view is planned but not implemented yet.";
  }

  function renderTimelineTree(nodes, depth = 0, lineage = []) {
    if (!nodes.length) {
      return '<div class="empty-state">No timeline records returned for this build.</div>';
    }
    return nodes.map((node, index) => {
      const type = node.type.toLowerCase();
      const statusClass = timelineStatusClass(node.result, node.state);
      const statusLabel = compactTimelineStatus(node.result, node.state);
      const connector = `${lineage.join("")}${index === nodes.length - 1 ? "└─" : "├─"}`;
      const label = `
        <span class="task-row__ascii">${escapeHtml(connector)}</span>
        <span class="task-row__dot ${statusClass}"></span>
        <span class="task-row__label">${escapeHtml(node.name)}</span>
        <span class="task-row__meta">${escapeHtml(node.type)} · ${escapeHtml(statusLabel)}</span>
      `;

      const row = node.logId
        ? `<button class="task-row" data-task-name="${escapeAttr(node.name)}" data-log-id="${node.logId}" data-log-lines="${node.logLineCount || 0}">${label}</button>`
        : `<div class="task-row task-row--static">${label}</div>`;

      return `
        <div class="task-tree-node">
          ${row}
          ${node.children.length ? `<div class="task-tree-node__children">${renderTimelineTree(node.children, depth + 1, [...lineage, index === nodes.length - 1 ? "  " : "│ "])}</div>` : ""}
        </div>
      `;
    }).join("");
  }

  function timelineStatusClass(result, state) {
    const normalizedResult = String(result || "").toLowerCase();
    const normalizedState = String(state || "").toLowerCase();
    if (normalizedResult === "succeeded") {
      return "task-row__dot--success";
    }
    if (normalizedResult === "failed" || normalizedResult === "canceled") {
      return "task-row__dot--failed";
    }
    if (normalizedResult === "skipped" || normalizedState === "pending" || normalizedState === "inprogress" || normalizedState === "queued") {
      return "task-row__dot--neutral";
    }
    return "task-row__dot--neutral";
  }

  function compactTimelineStatus(result, state) {
    const normalizedResult = String(result || "").toLowerCase();
    const normalizedState = String(state || "").toLowerCase();
    if (normalizedResult === "succeeded") {
      return "ok";
    }
    if (normalizedResult === "failed") {
      return "fail";
    }
    if (normalizedResult === "canceled") {
      return "cancel";
    }
    if (normalizedResult === "skipped") {
      return "skip";
    }
    if (normalizedState === "inprogress") {
      return "run";
    }
    if (normalizedState === "pending") {
      return "wait";
    }
    return normalizedResult || normalizedState || "n/a";
  }

  async function refreshMainPane() {
    if (!state.selectedProject) {
      return;
    }
    if (state.currentBuild) {
      await openBuild(state.currentBuild.id, true);
      return;
    }
    await loadDefinitions(true);
    renderDefinitionsScreen();
  }

  async function refreshDetailPane() {
    if (state.currentBuild && elements.detailTitle.textContent === "Artifacts") {
      await loadArtifacts(true);
      return;
    }
    if (state.currentTask && state.currentBuild) {
      await openTaskPane(state.currentTask.taskName, state.currentTask.logId, state.currentTask.logLineCount, true);
      return;
    }
    if (state.currentBuild) {
      return;
    }
    if (!state.selectedDefinition) {
      return;
    }
    await loadDefinitionBuilds(state.selectedDefinition.id, true);
    renderDefinitionBuildsPane();
  }

  function commitNavState(next, replaceHistory) {
    state.navState = next;
    if (replaceHistory) {
      history.replaceState(next, "");
    } else {
      history.pushState(next, "");
    }
  }

  function resolveDefinitionReference(raw) {
    if (!raw) {
      return null;
    }
    const trimmed = String(raw).trim();
    const numeric = Number(trimmed.split("·")[0].trim());
    if (Number.isFinite(numeric) && numeric > 0) {
      return state.definitions.find((definition) => definition.id === numeric) || null;
    }

    const wildcardMatches = state.definitions.filter((definition) => matchesWildcard(definition.name, trimmed));
    if (wildcardMatches.length === 1) {
      return wildcardMatches[0];
    }

    const substringMatches = state.definitions.filter((definition) => definition.name.toLowerCase().includes(trimmed.toLowerCase()));
    if (substringMatches.length === 1) {
      return substringMatches[0];
    }

    return null;
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

  function buildStatusClass(build) {
    const result = String(build.result || "").toLowerCase();
    const status = String(build.status || "").toLowerCase();
    if (result === "succeeded") {
      return "build-item__corner--success";
    }
    if (result === "failed" || result === "canceled") {
      return "build-item__corner--failed";
    }
    if (status === "inprogress" || status === "notstarted" || status === "postponed") {
      return "build-item__corner--running";
    }
    return "build-item__corner--neutral";
  }

  function truncateCommitMessage(value) {
    const text = String(value || "").trim();
    if (!text) {
      return "No commit message";
    }
    if (text.length <= 72) {
      return text;
    }
    return `${text.slice(0, 69)}...`;
  }

  function buildDefinitionTree(definitions) {
    const root = createFolderNode();
    for (const definition of definitions) {
      const segments = definition.path.split("\\").filter(Boolean);
      let cursor = root;
      for (const segment of segments) {
        if (!cursor.folders[segment]) {
          cursor.folders[segment] = createFolderNode();
        }
        cursor = cursor.folders[segment];
      }
      cursor.definitions.push(definition);
    }
    return renderFolderNode(root, []);
  }

  function renderFolderNode(node, lineage) {
    const folderEntries = Object.entries(node.folders)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, folder], index, all) => {
        const connector = `${lineage.join("")}${index === all.length - 1 && node.definitions.length === 0 ? "└─" : "├─"}`;
        const nextLineage = [...lineage, index === all.length - 1 && node.definitions.length === 0 ? "  " : "│ "];
        return `
          <div class="definition-tree-node">
            <div class="definition-row definition-row--folder">
              <span class="definition-row__ascii">${escapeHtml(connector)}</span>
              <span class="definition-row__label">${escapeHtml(name)}</span>
            </div>
            <div class="definition-tree-node__children">
              ${renderFolderNode(folder, nextLineage)}
            </div>
          </div>
        `;
      })
      .join("");

    const definitionHtml = node.definitions
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((definition, index, all) => definitionCard(
        definition,
        `${lineage.join("")}${index === all.length - 1 ? "└─" : "├─"}`
      ))
      .join("");

    return `${folderEntries}${definitionHtml}`;
  }

  function definitionCard(definition, connector) {
    const selected = state.selectedDefinition?.id === definition.id ? " is-active" : "";
    return `
      <button class="definition-row definition-row--item${selected}" data-definition-id="${definition.id}">
        <span class="definition-row__ascii">${escapeHtml(connector)}</span>
        <span class="definition-row__label">${escapeHtml(definition.name)}</span>
        <span class="definition-row__meta">#${escapeHtml(String(definition.id))} · rev ${escapeHtml(String(definition.revision))} · ${escapeHtml(definition.queueStatus || "enabled")}</span>
      </button>
    `;
  }

  function createFolderNode() {
    return {
      folders: {},
      definitions: []
    };
  }

  function matchesWildcard(value, pattern) {
    if (!pattern) {
      return true;
    }
    const trimmed = pattern.trim();
    if (!trimmed) {
      return true;
    }
    if (!trimmed.includes("*")) {
      return value.toLowerCase().includes(trimmed.toLowerCase());
    }
    const escaped = trimmed.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    const regex = new RegExp(`^${escaped}$`, "i");
    return regex.test(value);
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

  function setMainCachePill(cached, lastRefresh, title) {
    setCachePill(elements.mainCachePill, cached, lastRefresh, title, "");
  }

  function setDetailCachePill(cached, lastRefresh, title) {
    setCachePill(elements.detailCachePill, cached, lastRefresh, title, "Task");
  }

  function setCachePill(element, cached, lastRefresh, title, prefix) {
    element.title = title;
    if (cached === null || cached === undefined) {
      element.textContent = prefix ? `${prefix} · Idle` : "Idle";
      element.disabled = true;
      element.classList.add("is-disabled");
      return;
    }
    element.disabled = false;
    element.classList.remove("is-disabled");
    const label = `${cached ? "Cached" : "Fresh"} · ${formatDate(lastRefresh)}`;
    element.textContent = prefix ? `${prefix} · ${label}` : label;
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

  function formatBytes(value) {
    if (value < 1024) {
      return `${value} B`;
    }
    if (value < 1024 * 1024) {
      return `${(value / 1024).toFixed(1)} KB`;
    }
    return `${(value / (1024 * 1024)).toFixed(2)} MB`;
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
