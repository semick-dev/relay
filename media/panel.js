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
    definitionBuildsLoading: false,
    definitionBuildsRequestId: 0,
    definitionBuildsTab: "list",
    definitionQueueLoading: false,
    definitionQueuePrepared: false,
    definitionQueueRequestId: 0,
    definitionQueueMetadata: null,
    definitionQueueBranch: "",
    definitionQueueParameters: [],
    definitionQueueVariables: [],
    definitionQueueRunning: false,
    definitionQueueError: "",
    definitionQueueNotice: "",
    definitionFilter: "",
    definitionTreeExpanded: {},
    definitionBuilds: [],
    definitionBuildsMeta: null,
    buildFilter: "all",
    currentTaskFilter: "",
    currentTaskFilterMode: "all",
    timelineTreeExpanded: {},
    currentBuildLoading: false,
    currentBuildRequestId: 0,
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
    mainPanel: document.getElementById("main-panel"),
    mainKind: document.getElementById("main-kind"),
    mainTitle: document.getElementById("main-title"),
    mainStatus: document.getElementById("main-status"),
    mainStatusCorner: document.getElementById("main-status-corner"),
    messageBanner: document.getElementById("message-banner"),
    content: document.getElementById("content"),
    mainCachePill: document.getElementById("main-cache-pill"),
    detailPanel: document.getElementById("detail-panel"),
    detailStatusCorner: document.getElementById("detail-status-corner"),
    detailKind: document.getElementById("detail-kind"),
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
      renderBanner("No organization URL is set. Use the Azure DevOps Relay sidebar first.");
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
    state.definitionTreeExpanded = {};
    state.timelineTreeExpanded = {};
    setTitle(`Azure DevOps Relay: ${project}`);

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
    resetDefinitionQueueState();
    commitNavState({
      mode: "definitionBuilds",
      project: state.selectedProject,
      definitionId: definition.id
    }, replaceHistory);
    renderDefinitionsScreen();
    await loadDefinitionBuilds(definition.id, true);
    if (state.selectedDefinition?.id === definition.id) {
      renderDefinitionsScreen();
    }
  }

  async function loadDefinitionBuilds(definitionId, forceRefresh) {
    const requestId = state.definitionBuildsRequestId + 1;
    state.definitionBuildsRequestId = requestId;
    state.definitionBuildsLoading = true;
    if (state.selectedDefinition?.id === definitionId) {
      renderDefinitionBuildsPane();
    }
    state.buildFilter = state.buildFilter || "all";
    try {
      const url = `/api/projects/${encodeURIComponent(state.selectedProject)}/builds?orgUrl=${encodeURIComponent(state.orgUrl)}&definitionId=${definitionId}${forceRefresh ? "&refresh=1" : ""}`;
      const response = await apiGet(url);
      if (state.definitionBuildsRequestId !== requestId) {
        return;
      }
      state.definitionBuilds = response.builds;
      state.definitionBuildsMeta = response;
    } finally {
      if (state.definitionBuildsRequestId === requestId) {
        state.definitionBuildsLoading = false;
      }
    }
  }

  async function openBuild(buildId, replaceHistory) {
    const summaryBuild = state.definitionBuilds.find((build) => build.id === buildId) || null;
    const requestId = state.currentBuildRequestId + 1;
    state.currentBuildRequestId = requestId;
    state.currentBuildLoading = true;
    state.currentBuild = {
      id: buildId,
      buildNumber: summaryBuild?.buildNumber || `#${buildId}`,
      definitionName: summaryBuild?.definitionName || state.selectedDefinition?.name || "Build",
      commitMessage: summaryBuild?.commitMessage,
      sourceBranch: summaryBuild?.sourceBranch,
      requestedFor: summaryBuild?.requestedFor,
      queueTime: summaryBuild?.queueTime,
      finishTime: summaryBuild?.finishTime,
      projectName: state.selectedProject,
      status: "loading",
      result: "loading",
      cached: false,
      lastRefresh: ""
    };
    state.currentTask = null;
    state.currentTimeline = [];
    state.currentTimelineMeta = null;
    state.timelineTreeExpanded = {};
    state.currentArtifacts = [];
    state.artifactNotice = "";
    commitNavState({
      mode: "build",
      project: state.selectedProject,
      definitionId: state.selectedDefinition?.id,
      buildId
    }, replaceHistory);
    renderBuildPage();
    try {
      const url = `/api/builds/${buildId}?orgUrl=${encodeURIComponent(state.orgUrl)}&project=${encodeURIComponent(state.selectedProject)}`;
      const response = await apiGet(url);
      if (state.currentBuildRequestId !== requestId) {
        return;
      }
      state.currentBuild = {
        ...response.build,
        commitMessage: response.build.commitMessage || summaryBuild?.commitMessage,
        sourceBranch: response.build.sourceBranch || summaryBuild?.sourceBranch,
        requestedFor: response.build.requestedFor || summaryBuild?.requestedFor,
        queueTime: response.build.queueTime || summaryBuild?.queueTime,
        finishTime: response.build.finishTime || summaryBuild?.finishTime
      };
      const timelineResponse = await apiGet(`/api/builds/${buildId}/timeline?orgUrl=${encodeURIComponent(state.orgUrl)}&project=${encodeURIComponent(state.selectedProject)}`);
      if (state.currentBuildRequestId !== requestId) {
        return;
      }
      state.currentTimeline = timelineResponse.timeline;
      state.currentTimelineMeta = timelineResponse;
      state.currentBuildLoading = false;
      renderBuildPage();
      await emit("relay.ui.panel.build.loaded", {
        buildId,
        cached: response.build.cached
      }, "span");
    } finally {
      if (state.currentBuildRequestId === requestId) {
        state.currentBuildLoading = false;
      }
    }
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
      state.currentTask = null;
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
      state.currentBuild = null;
      state.currentTask = null;
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
    clearBuildPageChrome();
    elements.content.classList.toggle("is-split", Boolean(state.selectedDefinition));
    elements.detailPanel.classList.toggle("is-hidden", !state.selectedDefinition);
    elements.mainKind.textContent = "Definitions";
    elements.mainTitle.textContent = state.selectedProject;
    elements.detailKind.textContent = state.selectedDefinition ? "Builds" : "Build";
    elements.detailTitle.textContent = state.selectedDefinition
      ? state.selectedDefinition.name
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
    const applyDefinitionFilter = () => {
      state.definitionFilter = input.value;
      renderDefinitionsTree();
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        applyDefinitionFilter();
      }
    });
    input.addEventListener("blur", () => {
      applyDefinitionFilter();
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
    const definitionTree = buildDefinitionTreeNodes(state.definitions);
    const filteredTree = projectTree(
      definitionTree,
      state.definitionFilter,
      (node) => node.kind === "definition" && matchesWildcard(node.definition.name, state.definitionFilter)
    );
    elements.buildList.className = "definition-tree";
    elements.buildList.innerHTML = filteredTree.nodes.length
      ? renderTreeNodes(filteredTree.nodes, {
          treeType: "definitions",
          expandedState: state.definitionTreeExpanded,
          autoExpandedIds: filteredTree.autoExpandedIds,
          defaultExpanded: (node) => node.kind === "definitions-root",
          renderRow: renderDefinitionTreeRow
        })
      : '<div class="empty-state">No definitions match the current filter.</div>';
    bindTreeInteractions(elements.buildList, {
      treeType: "definitions",
      expandedState: state.definitionTreeExpanded,
      autoExpandedIds: filteredTree.autoExpandedIds,
      defaultExpanded: (node) => node.kind === "definitions-root",
      findNode: (id) => findTreeNodeById(filteredTree.nodes, id),
      onActivate: (node) => {
        if (node.kind === "definition") {
          void openDefinition(node.definition, false);
        }
      },
      rerender: () => renderDefinitionsTree()
    });
    elements.mainStatus.textContent = `${state.selectedProject} · ${filteredTree.matchCount} definitions`;
  }

  function renderDefinitionBuildsPane() {
    elements.detailBody.className = "detail-pane";
    if (state.definitionBuildsLoading) {
      setDetailCachePill(null, null, "Loading build list");
      elements.detailBody.innerHTML = `
        <div class="detail-pane detail-pane--loading">
          <div class="loading-state">
            <span class="spinner loading-state__spinner"></span>
            <div class="loading-state__label">Loading builds...</div>
          </div>
        </div>
      `;
      return;
    }
    elements.detailBody.innerHTML = `
      <div class="selector-shell">
        <label class="eyebrow" for="definition-selector">Definition</label>
        <div class="selector-row">
          <input id="definition-selector" class="definitions-filter" type="text" value="${escapeAttr(`${state.selectedDefinition.id} · ${state.selectedDefinition.name}`)}" />
          <button id="definition-selector-open" class="button button--primary">Load</button>
        </div>
      </div>
      <div class="definition-builds-meta muted">
        #${escapeHtml(String(state.selectedDefinition.id))} ·
        ${(state.definitionBuildsMeta?.cached ? "cached" : "fresh")} ·
        ${escapeHtml(String(state.definitionBuildsMeta?.builds?.length ?? state.definitionBuilds.length))} builds ·
        ${escapeHtml(formatDate(state.definitionBuildsMeta?.lastRefresh))}
      </div>
      <div class="definition-builds-tabs" role="tablist" aria-label="Definition tools">
        <button class="filter-chip ${state.definitionBuildsTab === "list" ? "is-active" : ""}" data-definition-tab="list" role="tab" aria-selected="${state.definitionBuildsTab === "list"}">List Builds for Definition</button>
        <button class="filter-chip ${state.definitionBuildsTab === "queue" ? "is-active" : ""}" data-definition-tab="queue" role="tab" aria-selected="${state.definitionBuildsTab === "queue"}">Queue Definition</button>
      </div>
      <div class="definition-builds-tabpanel">
        ${state.definitionBuildsTab === "list" ? `
          <div class="filter-row">
            <button class="filter-chip ${state.buildFilter === "all" ? "is-active" : ""}" data-filter="all">All</button>
            <button class="filter-chip ${state.buildFilter === "inProgress" ? "is-active" : ""}" data-filter="inProgress">In Progress</button>
            <button class="filter-chip ${state.buildFilter === "failed" ? "is-active" : ""}" data-filter="failed">Failed / Cancelled</button>
            <button class="filter-chip ${state.buildFilter === "success" ? "is-active" : ""}" data-filter="success">Success</button>
          </div>
          <div id="definition-build-list" class="build-list definition-build-list"></div>
        ` : `
          ${renderDefinitionQueueTab()}
        `}
      </div>
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
    for (const button of elements.detailBody.querySelectorAll("[data-definition-tab]")) {
      button.addEventListener("click", () => {
        state.definitionBuildsTab = button.getAttribute("data-definition-tab");
        state.definitionQueueError = "";
        renderDefinitionBuildsPane();
      });
    }
    for (const button of elements.detailBody.querySelectorAll("[data-filter]")) {
      button.addEventListener("click", () => {
        state.buildFilter = button.getAttribute("data-filter");
        renderDefinitionBuildsPane();
      });
    }

    if (state.definitionBuildsTab === "list") {
      renderDefinitionBuildList();
    } else {
      bindDefinitionQueueTab();
    }
  }

  function renderDefinitionQueueTab() {
    return `
      <div class="queue-definition">
        <div class="queue-definition__intro muted">Provide a branch or PR merge ref, then prepare the queue inputs for this definition.</div>
        <div class="queue-definition__branch-row">
          <textarea id="queue-branch-input" class="queue-definition__textarea queue-definition__textarea--single" placeholder="refs/heads/main or refs/pull/123/merge"${state.definitionQueueLoading || state.definitionQueueRunning ? " disabled" : ""}>${escapeHtml(state.definitionQueueBranch)}</textarea>
          <button id="queue-prepare-button" class="button button--primary"${state.definitionQueueLoading || state.definitionQueueRunning ? " disabled" : ""}>${state.definitionQueueLoading ? "Preparing..." : "Prepare for Queue"}</button>
        </div>
        ${state.definitionQueuePrepared && state.definitionQueueMetadata && !state.definitionQueueMetadata.isYaml ? `
          <div class="empty-state empty-state--compact">Only YAML-backed definitions are supported for queueing.</div>
        ` : ""}
        ${state.definitionQueuePrepared && state.definitionQueueMetadata?.parameterError ? renderDismissibleMessage("queue-parameter-error", state.definitionQueueMetadata.parameterError, "error") : ""}
        ${state.definitionQueueLoading ? `
          <div class="detail-pane detail-pane--loading definition-builds-placeholder">
            <div class="loading-state">
              <span class="spinner loading-state__spinner"></span>
              <div class="loading-state__label">Loading queue metadata...</div>
            </div>
          </div>
        ` : ""}
        ${state.definitionQueuePrepared && !state.definitionQueueLoading && state.definitionQueueMetadata?.isYaml ? `
          <div class="queue-definition__section">
            <div class="section-title">Parameters</div>
            <div class="queue-definition__fields">
              ${state.definitionQueueParameters.length
                ? state.definitionQueueParameters.map((parameter, index) => `
                  <label class="queue-definition__field">
                    <span class="eyebrow">${escapeHtml(parameter.name)}</span>
                    <textarea class="queue-definition__textarea" data-queue-parameter-index="${index}" placeholder="${escapeAttr(parameter.label || parameter.name)}">${escapeHtml(parameter.value || "")}</textarea>
                  </label>
                `).join("")
                : '<div class="empty-state empty-state--compact">No queue parameters exposed for this definition.</div>'}
            </div>
          </div>
          <div class="queue-definition__section">
            <div class="section-title">
              <span>Variables</span>
              <button id="queue-add-variable" class="button button--ghost" type="button">Add Variable</button>
            </div>
            <div class="queue-definition__variable-list">
              ${state.definitionQueueVariables.map((variable, index) => `
                <div class="queue-definition__variable-row">
                  <textarea class="queue-definition__textarea queue-definition__textarea--single" data-queue-variable-name-index="${index}" placeholder="Variable name">${escapeHtml(variable.name || "")}</textarea>
                  <textarea class="queue-definition__textarea queue-definition__textarea--single" data-queue-variable-value-index="${index}" placeholder="Variable value">${escapeHtml(variable.value || "")}</textarea>
                  <button class="button button--ghost" type="button" data-queue-variable-remove-index="${index}">Remove</button>
                </div>
              `).join("")}
            </div>
          </div>
          <div class="queue-definition__actions">
            <button id="queue-run-button" class="button button--primary queue-definition__run"${state.definitionQueueRunning ? " disabled" : ""}>${state.definitionQueueRunning ? "Queueing..." : "Run"}</button>
          </div>
        ` : ""}
        ${state.definitionQueueNotice ? renderDismissibleMessage("queue-notice", state.definitionQueueNotice, "success") : ""}
        ${state.definitionQueueError ? `
          <div id="queue-error" class="queue-definition__error">
            <button id="queue-error-close" class="message-close" type="button" aria-label="Close error">×</button>
            <pre class="queue-definition__error-body">${escapeHtml(state.definitionQueueError)}</pre>
          </div>
        ` : ""}
      </div>
    `;
  }

  function bindDefinitionQueueTab() {
    const branchInput = document.getElementById("queue-branch-input");
    if (branchInput) {
      branchInput.addEventListener("input", () => {
        state.definitionQueueBranch = branchInput.value;
        clearDefinitionQueueFeedback();
      });
      branchInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          void prepareDefinitionQueue();
        }
      });
    }

    const prepareButton = document.getElementById("queue-prepare-button");
    if (prepareButton) {
      prepareButton.addEventListener("click", () => {
        void prepareDefinitionQueue();
      });
    }

    const addVariableButton = document.getElementById("queue-add-variable");
    if (addVariableButton) {
      addVariableButton.addEventListener("click", () => {
        state.definitionQueueVariables.push({ name: "", value: "" });
        clearDefinitionQueueFeedback();
        renderDefinitionBuildsPane();
      });
    }

    const runButton = document.getElementById("queue-run-button");
    if (runButton) {
      runButton.addEventListener("click", () => {
        void runDefinitionQueue();
      });
    }

    for (const textarea of elements.detailBody.querySelectorAll("[data-queue-parameter-index]")) {
      textarea.addEventListener("input", () => {
        const index = Number(textarea.getAttribute("data-queue-parameter-index"));
        if (Number.isFinite(index) && state.definitionQueueParameters[index]) {
          state.definitionQueueParameters[index].value = textarea.value;
          clearDefinitionQueueFeedback();
        }
      });
    }

    for (const textarea of elements.detailBody.querySelectorAll("[data-queue-variable-name-index]")) {
      textarea.addEventListener("input", () => {
        const index = Number(textarea.getAttribute("data-queue-variable-name-index"));
        if (Number.isFinite(index) && state.definitionQueueVariables[index]) {
          state.definitionQueueVariables[index].name = textarea.value;
          clearDefinitionQueueFeedback();
        }
      });
    }

    for (const textarea of elements.detailBody.querySelectorAll("[data-queue-variable-value-index]")) {
      textarea.addEventListener("input", () => {
        const index = Number(textarea.getAttribute("data-queue-variable-value-index"));
        if (Number.isFinite(index) && state.definitionQueueVariables[index]) {
          state.definitionQueueVariables[index].value = textarea.value;
          clearDefinitionQueueFeedback();
        }
      });
    }

    for (const button of elements.detailBody.querySelectorAll("[data-queue-variable-remove-index]")) {
      button.addEventListener("click", () => {
        const index = Number(button.getAttribute("data-queue-variable-remove-index"));
        if (Number.isFinite(index)) {
          state.definitionQueueVariables.splice(index, 1);
          clearDefinitionQueueFeedback();
          renderDefinitionBuildsPane();
        }
      });
    }

    const queueErrorClose = document.getElementById("queue-error-close");
    if (queueErrorClose) {
      queueErrorClose.addEventListener("click", () => {
        state.definitionQueueError = "";
        renderDefinitionBuildsPane();
      });
    }

    const queueParameterErrorClose = document.getElementById("queue-parameter-error-close");
    if (queueParameterErrorClose) {
      queueParameterErrorClose.addEventListener("click", () => {
        if (state.definitionQueueMetadata) {
          state.definitionQueueMetadata.parameterError = "";
          renderDefinitionBuildsPane();
        }
      });
    }

    const queueNoticeClose = document.getElementById("queue-notice-close");
    if (queueNoticeClose) {
      queueNoticeClose.addEventListener("click", () => {
        state.definitionQueueNotice = "";
        renderDefinitionBuildsPane();
      });
    }
  }

  async function prepareDefinitionQueue() {
    if (!state.selectedDefinition) {
      return;
    }
    const requestId = state.definitionQueueRequestId + 1;
    state.definitionQueueRequestId = requestId;
    state.definitionQueuePrepared = false;
    state.definitionQueueLoading = true;
    state.definitionQueueError = "";
    state.definitionQueueNotice = "";
    renderDefinitionBuildsPane();
    try {
      const sourceBranch = state.definitionQueueBranch.trim();
      const response = await apiGet(`/api/projects/${encodeURIComponent(state.selectedProject)}/definitions/${state.selectedDefinition.id}/queue-metadata?orgUrl=${encodeURIComponent(state.orgUrl)}${sourceBranch ? `&sourceBranch=${encodeURIComponent(sourceBranch)}` : ""}`, { showBanner: false });
      if (state.definitionQueueRequestId !== requestId) {
        return;
      }
      state.definitionQueueMetadata = response.definition;
      state.definitionQueuePrepared = true;
      if (!state.definitionQueueBranch && response.definition.defaultBranch) {
        state.definitionQueueBranch = response.definition.defaultBranch;
      }
      state.definitionQueueParameters = (response.definition.parameters || []).map((parameter) => ({
        name: parameter.name,
        value: parameter.defaultValue || "",
        label: parameter.label || parameter.name
      }));
      state.definitionQueueVariables = (response.definition.variables || []).map((variable) => ({
        name: variable.name,
        value: variable.value || ""
      }));
    } catch (error) {
      if (state.definitionQueueRequestId === requestId) {
        state.definitionQueueError = error?.message || String(error);
      }
    } finally {
      if (state.definitionQueueRequestId === requestId) {
        state.definitionQueueLoading = false;
        renderDefinitionBuildsPane();
      }
    }
  }

  async function runDefinitionQueue() {
    if (!state.selectedDefinition) {
      return;
    }
    state.definitionQueueRunning = true;
    state.definitionQueueError = "";
    state.definitionQueueNotice = "";
    renderDefinitionBuildsPane();
    try {
      const parameterMap = Object.fromEntries(
        state.definitionQueueParameters
          .filter((parameter) => parameter.name)
          .map((parameter) => [parameter.name, parameter.value || ""])
      );
      const variableMap = Object.fromEntries(
        state.definitionQueueVariables
          .filter((variable) => variable.name.trim())
          .map((variable) => [variable.name.trim(), variable.value || ""])
      );
      const response = await apiPost(`/api/projects/${encodeURIComponent(state.selectedProject)}/definitions/${state.selectedDefinition.id}/queue?orgUrl=${encodeURIComponent(state.orgUrl)}`, {
        sourceBranch: state.definitionQueueBranch.trim() || undefined,
        parameters: parameterMap,
        variables: variableMap
      }, { showBanner: false });
      await loadDefinitionBuilds(state.selectedDefinition.id, true);
      await openBuild(response.build.id, false);
    } catch (error) {
      state.definitionQueueError = error?.message || String(error);
    } finally {
      state.definitionQueueRunning = false;
      renderDefinitionBuildsPane();
    }
  }

  function clearDefinitionQueueFeedback() {
    state.definitionQueueError = "";
    state.definitionQueueNotice = "";
    const error = document.getElementById("queue-error");
    if (error) {
      error.remove();
    }
    const notice = document.getElementById("queue-notice");
    if (notice) {
      notice.remove();
    }
  }

  function resetDefinitionQueueState() {
    state.definitionBuildsTab = "list";
    state.definitionQueueLoading = false;
    state.definitionQueuePrepared = false;
    state.definitionQueueRequestId = 0;
    state.definitionQueueMetadata = null;
    state.definitionQueueBranch = "";
    state.definitionQueueParameters = [];
    state.definitionQueueVariables = [];
    state.definitionQueueRunning = false;
    state.definitionQueueError = "";
    state.definitionQueueNotice = "";
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
        <div class="build-item__title"${buildCommitMessageTitle(build.commitMessage, 30)}>${escapeHtml(truncateCommitMessage(build.commitMessage, 30))}</div>
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
    await openDefinition(definition, true);
  }

  function closeDefinitionBuildsPane() {
    state.selectedDefinition = null;
    state.currentBuild = null;
    state.currentTask = null;
    state.definitionBuildsLoading = false;
    state.definitionBuilds = [];
    state.definitionBuildsMeta = null;
    commitNavState({ mode: "definitions", project: state.selectedProject }, true);
    renderDefinitionsScreen();
  }

  function renderBuildPage() {
    elements.content.classList.remove("is-split");
    elements.detailPanel.classList.add("is-hidden");
    elements.toolbar.className = "toolbar is-hidden";
    elements.mainPanel.classList.add("is-build-page");
    elements.mainKind.textContent = "Build";
    elements.mainStatusCorner.className = `panel-corner ${buildStatusClass(state.currentBuild)}`;
    elements.mainTitle.textContent = `#${state.currentBuild.id} · ${state.currentBuild.buildNumber}`;
    elements.mainStatus.textContent = "";
    setMainCachePill(state.currentTimelineMeta?.cached ?? state.currentBuild.cached, state.currentTimelineMeta?.lastRefresh ?? state.currentBuild.lastRefresh, "Refresh build");
    setDetailCachePill(null, null, "No detail cache");
    elements.buildList.className = "build-page";
    if (state.currentBuildLoading) {
      elements.buildList.innerHTML = `
        <div class="build-page__topbar">
          <button id="build-artifacts-button" class="button button--ghost">Artifacts</button>
          <button id="build-page-back" class="button button--ghost">Back</button>
        </div>
        <div class="build-page__subtitle muted"${buildCommitMessageTitle(state.currentBuild.commitMessage, 70)}>${escapeHtml(truncateCommitMessage(state.currentBuild.commitMessage, 70))}</div>
        <div class="detail-pane detail-pane--loading">
          <div class="loading-state">
            <span class="spinner loading-state__spinner"></span>
            <div class="loading-state__label">Loading build details...</div>
          </div>
        </div>
      `;
      document.getElementById("build-page-back").addEventListener("click", () => history.back());
      return;
    }
    elements.buildList.innerHTML = `
      <div class="build-page__topbar">
        <button id="build-artifacts-button" class="button button--ghost">Artifacts</button>
        <button id="build-page-back" class="button button--ghost">Back</button>
      </div>
      <div class="build-page__link-row">
        <a class="build-page__link eyebrow" href="${escapeAttr(buildWebUrl())}" target="_blank" rel="noreferrer">Open In Azure DevOps</a>
      </div>
      <div class="build-page__subtitle muted"${buildCommitMessageTitle(state.currentBuild.commitMessage, 70)}>${escapeHtml(truncateCommitMessage(state.currentBuild.commitMessage, 70))}</div>
      <details class="build-summary" open>
        <summary></summary>
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
          <div class="section-head__title">
            <h3>Build Timeline</h3>
            <span class="muted">${escapeHtml(state.currentTimelineMeta?.cached ? "cached timeline" : "fresh timeline")}</span>
          </div>
          <div class="task-filter-controls">
            <button id="task-filter-all" class="task-filter-toggle${state.currentTaskFilterMode === "all" ? " is-active" : ""}" type="button" title="Show all tasks" aria-label="Show all tasks">◎</button>
            <button id="task-filter-errors" class="task-filter-toggle${state.currentTaskFilterMode === "errors" ? " is-active" : ""}" type="button" title="Filter to errored tasks" aria-label="Filter to errored tasks">!</button>
            <input id="task-filter" class="definitions-filter task-filter" type="text" placeholder="Filter tasks like test* or publish" value="${escapeAttr(state.currentTaskFilter)}" />
          </div>
        </div>
        <div id="task-tree" class="task-tree"></div>
      </section>
    `;
    document.getElementById("build-page-back").addEventListener("click", () => history.back());
    document.getElementById("build-artifacts-button").addEventListener("click", () => {
      void loadArtifacts(false);
    });
    const taskFilter = document.getElementById("task-filter");
    if (taskFilter) {
      const applyTaskFilter = () => {
        state.currentTaskFilter = taskFilter.value;
        state.currentTaskFilterMode = state.currentTaskFilter === buildErroredTaskFilterValue(state.currentTimeline) ? "errors" : "all";
        renderTimelineSection();
      };
      taskFilter.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          applyTaskFilter();
        }
      });
      taskFilter.addEventListener("blur", () => {
        applyTaskFilter();
      });
    }
    const taskFilterAll = document.getElementById("task-filter-all");
    if (taskFilterAll) {
      taskFilterAll.addEventListener("click", () => {
        state.currentTaskFilterMode = "all";
        state.currentTaskFilter = "";
        const input = document.getElementById("task-filter");
        if (input) {
          input.value = "";
        }
        renderTimelineSection();
      });
    }
    const taskFilterErrors = document.getElementById("task-filter-errors");
    if (taskFilterErrors) {
      taskFilterErrors.addEventListener("click", () => {
        state.currentTaskFilterMode = "errors";
        state.currentTaskFilter = buildErroredTaskFilterValue(state.currentTimeline);
        const input = document.getElementById("task-filter");
        if (input) {
          input.value = state.currentTaskFilter;
        }
        renderTimelineSection();
      });
    }
    renderTimelineSection();
  }

  function clearBuildPageChrome() {
    elements.mainPanel.classList.remove("is-build-page");
    elements.mainStatusCorner.className = "panel-corner is-hidden";
    elements.detailPanel.classList.remove("is-task-pane");
    elements.detailStatusCorner.className = "panel-corner is-hidden";
    elements.detailKind.textContent = "Build";
  }

  function buildWebUrl() {
    const org = String(state.orgUrl || "").replace(/\/+$/, "");
    const project = encodeURIComponent(state.selectedProject || "");
    const buildId = encodeURIComponent(String(state.currentBuild?.id || ""));
    return `${org}/${project}/_build/results?buildId=${buildId}`;
  }

  async function openTaskPane(taskName, logId, logLineCount = 0, taskStatusClass = "task-row__dot--neutral", taskStartTime = "", taskFinishTime = "", forceRefresh = false) {
    state.currentTask = {
      taskName,
      logId,
      logLineCount,
      taskStatusClass,
      taskStartTime,
      taskFinishTime
    };
    elements.content.classList.add("is-split");
    elements.detailPanel.classList.remove("is-hidden");
    elements.detailPanel.classList.add("is-task-pane");
    elements.detailStatusCorner.className = `panel-corner ${mapTaskStatusCornerClass(taskStatusClass)}`;
    elements.detailKind.textContent = "Task";
    elements.detailTitle.textContent = taskName;
    elements.detailBody.className = "detail-pane";
    elements.detailBody.innerHTML = `
      <div class="task-pane">
        <div class="banner">Loading task output...</div>
      </div>
    `;
    const info = await apiGet(`/api/builds/${state.currentBuild.id}/logs/${logId}/meta?orgUrl=${encodeURIComponent(state.orgUrl)}&project=${encodeURIComponent(state.selectedProject)}`);
    if (info.shouldDelayDownload && !forceRefresh) {
      setDetailCachePill(info.cached, info.lastRefresh, "Refresh task output");
      elements.detailBody.innerHTML = `
        <div class="task-pane">
          <div class="task-pane__meta-row">
            <div class="definition-builds-meta muted">${formatTaskTiming(taskStartTime, taskFinishTime)} · ${info.cached ? "cached" : "not downloaded"} · ${formatTaskLogMeta(info.sizeBytes, info.lineCount || logLineCount)}</div>
            ${renderInlineCachePill(info.cached, info.lastRefresh, "Refresh task output")}
          </div>
          <div class="banner">Task output is larger than 1MB.</div>
          ${info.downloadPath ? `
            <div class="detail-card">
              <p class="eyebrow">Local Path</p>
              <code>${escapeHtml(info.downloadPath)}</code>
            </div>
            <div class="button-row">
              <button id="task-show-log-button" class="button button--primary">Show Log</button>
            </div>
          ` : `
            <button id="task-download-button" class="button button--primary">Download Task Output</button>
            <div id="task-download-progress" class="progress-wrap is-hidden">
              <div class="progress-meta">
                <span>Downloading task output</span>
                <span id="task-download-label">Starting</span>
              </div>
              <div class="progress-bar"><div id="task-download-bar" class="progress-bar__fill progress-bar__fill--indeterminate"></div></div>
            </div>
          `}
        </div>
      `;
      bindInlineTaskCachePill(taskName, logId, logLineCount, taskStatusClass);
      const downloadButton = document.getElementById("task-download-button");
      if (downloadButton) {
        downloadButton.addEventListener("click", async () => {
          const progress = document.getElementById("task-download-progress");
          const label = document.getElementById("task-download-label");
          progress.classList.remove("is-hidden");
          label.textContent = "Downloading";
          await openTaskPane(taskName, logId, logLineCount, taskStatusClass, taskStartTime, taskFinishTime, true);
        });
      }
      const showButton = document.getElementById("task-show-log-button");
      if (showButton && info.downloadPath) {
        showButton.addEventListener("click", () => {
          vscode.postMessage({
            type: "openLogFile",
            path: info.downloadPath
          });
        });
      }
      return;
    }

    const response = await apiGet(`/api/builds/${state.currentBuild.id}/logs/${logId}?orgUrl=${encodeURIComponent(state.orgUrl)}&project=${encodeURIComponent(state.selectedProject)}${forceRefresh ? "&refresh=1" : ""}`);
    setDetailCachePill(response.cached, response.lastRefresh, "Refresh task output");
    elements.detailBody.innerHTML = response.inline
      ? `
        <div class="task-pane">
          <div class="task-pane__meta-row">
            <div class="definition-builds-meta muted">${formatTaskTiming(taskStartTime, taskFinishTime)} · ${response.cached ? "cached" : "fresh"} · ${formatBytes(response.sizeBytes)}</div>
            ${renderInlineCachePill(response.cached, response.lastRefresh, "Refresh task output")}
          </div>
          <pre class="task-log">${escapeHtml(response.content || "")}</pre>
        </div>
      `
      : `
        <div class="task-pane">
          <div class="task-pane__meta-row">
            <div class="definition-builds-meta muted">${formatTaskTiming(taskStartTime, taskFinishTime)} · ${response.downloadPath ? (response.cached ? "cached" : "fresh") : "not downloaded"} · ${formatBytes(response.sizeBytes)}</div>
            ${renderInlineCachePill(response.cached, response.lastRefresh, "Refresh task output")}
          </div>
          <div class="banner">Task output is larger than 1MB.</div>
          ${response.downloadPath ? `
            <div class="detail-card">
              <p class="eyebrow">Local Path</p>
              <code>${escapeHtml(response.downloadPath)}</code>
            </div>
            <div class="button-row">
              <button id="task-show-log-button" class="button button--primary">Show Log</button>
            </div>
          ` : `
            <button id="task-download-button" class="button button--primary">Download Task Output</button>
            <div id="task-download-progress" class="progress-wrap is-hidden">
              <div class="progress-meta">
                <span>Downloading task output</span>
                <span id="task-download-label">Starting</span>
              </div>
              <div class="progress-bar"><div id="task-download-bar" class="progress-bar__fill progress-bar__fill--indeterminate"></div></div>
            </div>
          `}
        </div>
      `;
    bindInlineTaskCachePill(taskName, logId, logLineCount, taskStatusClass, taskStartTime, taskFinishTime);
    const downloadButton = document.getElementById("task-download-button");
    if (downloadButton) {
      downloadButton.addEventListener("click", async () => {
        const progress = document.getElementById("task-download-progress");
        const label = document.getElementById("task-download-label");
        progress.classList.remove("is-hidden");
        label.textContent = "Downloading";
        await openTaskPane(taskName, logId, logLineCount, taskStatusClass, taskStartTime, taskFinishTime, true);
      });
    }
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
    clearBuildPageChrome();
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

  function formatTaskLogMeta(sizeBytes, lineCount) {
    if (typeof sizeBytes === "number") {
      return formatBytes(sizeBytes);
    }
    if (typeof lineCount === "number" && lineCount > 0) {
      return `${lineCount} lines`;
    }
    return "size unknown";
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
    if (state.selectedDefinition && !state.currentBuild) {
      closeDefinitionBuildsPane();
      return;
    }
    if (state.currentBuild) {
      state.currentTask = null;
      renderBuildPage();
      return;
    }
    history.back();
  }

  function renderArtifactsPlaceholder() {
    clearBuildPageChrome();
    elements.content.classList.remove("is-split");
    elements.detailPanel.classList.add("is-hidden");
    elements.toolbar.className = "toolbar is-hidden";
    elements.mainKind.textContent = "Project";
    elements.mainTitle.textContent = state.selectedProject;
    elements.mainStatus.textContent = `${state.selectedProject} · Artifacts`;
    setMainCachePill(null, null, "No artifact cache");
    setDetailCachePill(null, null, "No detail cache");
    elements.buildList.className = "build-list empty-state";
    elements.buildList.innerHTML = "Artifacts view is planned but not implemented yet.";
  }

  function renderTimelineSection() {
    const host = document.getElementById("task-tree");
    if (!host) {
      return;
    }
    const timelineTree = buildTimelineTreeNodes(state.currentTimeline);
    const filteredTree = projectTree(
      timelineTree,
      state.currentTaskFilter,
      (node) => node.kind === "task" && matchesTimelineTaskFilter(node.timelineNode, state.currentTaskFilter)
    );
    host.innerHTML = filteredTree.nodes.length
      ? renderTreeNodes(filteredTree.nodes, {
          treeType: "timeline",
          expandedState: state.timelineTreeExpanded,
          autoExpandedIds: filteredTree.autoExpandedIds,
          defaultExpanded: (node) => node.kind !== "job" && node.kind !== "deployment",
          renderRow: renderTimelineTreeRow
        })
      : '<div class="empty-state">No timeline records returned for this build.</div>';
    bindTreeInteractions(host, {
      treeType: "timeline",
      expandedState: state.timelineTreeExpanded,
      autoExpandedIds: filteredTree.autoExpandedIds,
      defaultExpanded: (node) => node.kind !== "job" && node.kind !== "deployment",
      findNode: (id) => findTreeNodeById(filteredTree.nodes, id),
      onActivate: (node) => {
        if (node.kind === "task" && node.timelineNode.logId) {
          void openTaskPane(
            node.timelineNode.name,
            node.timelineNode.logId,
            node.timelineNode.logLineCount || 0,
            timelineStatusClass(node.timelineNode.result, node.timelineNode.state),
            node.timelineNode.startTime || "",
            node.timelineNode.finishTime || ""
          );
        }
      },
      rerender: () => renderTimelineSection()
    });
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

  function matchesTimelineTaskFilter(node, pattern) {
    return matchesWildcard(node.name, pattern);
  }

  function buildErroredTaskFilterValue(nodes) {
    const names = collectErroredTaskNames(nodes);
    return names.join(",");
  }

  function collectErroredTaskNames(nodes, names = new Set()) {
    for (const node of nodes || []) {
      if (isErroredTimelineNode(node)) {
        names.add(node.name);
      }
      if (node.children?.length) {
        collectErroredTaskNames(node.children, names);
      }
    }
    return Array.from(names).sort((left, right) => left.localeCompare(right));
  }

  function isErroredTimelineNode(node) {
    const normalizedResult = String(node.result || "").toLowerCase();
    const normalizedState = String(node.state || "").toLowerCase();
    return normalizedResult === "failed"
      || normalizedResult === "canceled"
      || normalizedResult === "cancelled"
      || normalizedResult === "timeout"
      || normalizedState === "canceled"
      || normalizedState === "cancelled";
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
      await openTaskPane(
        state.currentTask.taskName,
        state.currentTask.logId,
        state.currentTask.logLineCount,
        state.currentTask.taskStatusClass,
        state.currentTask.taskStartTime,
        state.currentTask.taskFinishTime,
        true
      );
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

  function truncateCommitMessage(value, maxLength = 72) {
    const text = String(value || "").trim();
    if (!text) {
      return "No commit message";
    }
    if (text.length <= maxLength) {
      return text;
    }
    return `${text.slice(0, Math.max(maxLength - 3, 1))}...`;
  }

  function buildCommitMessageTitle(value, maxLength = 72) {
    const text = String(value || "").trim();
    if (!text || text.length <= maxLength) {
      return "";
    }
    return ` title="${escapeAttr(text)}"`;
  }

  function buildDefinitionTreeNodes(definitions) {
    const root = createDefinitionFolderNode("definitions-root", "All Matching Build Definitions");
    for (const definition of definitions) {
      const segments = definition.path.split("\\").filter(Boolean);
      let cursor = root;
      let pathKey = "";
      for (const segment of segments) {
        pathKey = `${pathKey}/${segment}`;
        let folderNode = cursor.children.find((child) => child.kind === "folder" && child.label === `${segment}/`);
        if (!folderNode) {
          folderNode = createDefinitionFolderNode(`folder:${pathKey}`, `${segment}/`);
          cursor.children.push(folderNode);
        }
        cursor = folderNode;
      }
      cursor.children.push({
        id: `definition:${definition.id}`,
        kind: "definition",
        label: definition.name,
        meta: `#${definition.id} · rev ${definition.revision} · ${definition.queueStatus || "enabled"}`,
        children: [],
        definition
      });
    }
    sortDefinitionTree(root);
    return [root];
  }

  function createDefinitionFolderNode(id, label) {
    return {
      id,
      kind: id === "definitions-root" ? "definitions-root" : "folder",
      label,
      children: []
    };
  }

  function sortDefinitionTree(node) {
    node.children.sort((left, right) => {
      const leftOrder = left.kind === "definition" ? 1 : 0;
      const rightOrder = right.kind === "definition" ? 1 : 0;
      if (leftOrder !== rightOrder) {
        return leftOrder - rightOrder;
      }
      return left.label.localeCompare(right.label);
    });
    for (const child of node.children) {
      if (child.children.length) {
        sortDefinitionTree(child);
      }
    }
  }

  function buildTimelineTreeNodes(nodes) {
    return nodes.map((node) => ({
      id: `timeline:${node.id}`,
      kind: timelineNodeKind(node),
      label: node.name,
      meta: `${node.type} · ${compactTimelineStatus(node.result, node.state)}`,
      statusClass: timelineStatusClass(node.result, node.state),
      children: buildTimelineTreeNodes(node.children || []),
      timelineNode: node
    }));
  }

  function projectTree(nodes, filterText, matchesNode) {
    if (!filterText || !String(filterText).trim()) {
      return {
        nodes,
        autoExpandedIds: new Set(),
        matchCount: countLeafNodes(nodes)
      };
    }

    const autoExpandedIds = new Set();
    let matchCount = 0;
    const filteredNodes = nodes
      .map((node) => projectTreeNode(node, filterText, matchesNode, autoExpandedIds, (count) => {
        matchCount += count;
      }))
      .filter(Boolean);

    return {
      nodes: filteredNodes,
      autoExpandedIds,
      matchCount
    };
  }

  function projectTreeNode(node, filterText, matchesNode, autoExpandedIds, onMatchCount) {
    const childMatches = node.children
      .map((child) => projectTreeNode(child, filterText, matchesNode, autoExpandedIds, onMatchCount))
      .filter(Boolean);
    const selfMatches = matchesNode(node, filterText);
    if (selfMatches) {
      onMatchCount(1);
    }
    if (!selfMatches && !childMatches.length) {
      return null;
    }
    if (childMatches.length) {
      autoExpandedIds.add(node.id);
    }
    return {
      ...node,
      children: childMatches
    };
  }

  function renderTreeNodes(nodes, options, lineage = []) {
    return nodes.map((node, index) => {
      const connector = `${lineage.join("")}${index === nodes.length - 1 ? "└─" : "├─"}`;
      const expanded = isTreeNodeExpanded(node, options.expandedState, options.autoExpandedIds, options.defaultExpanded);
      const nextLineage = [...lineage, index === nodes.length - 1 ? "  " : "│ "];
      return `
        <div class="${options.treeType === "timeline" ? "task-tree-node" : "definition-tree-node"}">
          ${options.renderRow(node, {
            connector,
            expanded,
            hasChildren: node.children.length > 0
          })}
          ${node.children.length && expanded ? `<div class="${options.treeType === "timeline" ? "task-tree-node__children" : "definition-tree-node__children"}">${renderTreeNodes(node.children, options, nextLineage)}</div>` : ""}
        </div>
      `;
    }).join("");
  }

  function renderDefinitionTreeRow(node, treeState) {
    const selected = node.kind === "definition" && state.selectedDefinition?.id === node.definition.id ? " is-active" : "";
    const rowClass = node.kind === "definition" ? "definition-row definition-row--item" : "definition-row definition-row--folder";
    const role = treeState.hasChildren ? "toggle" : "activate";
    const tag = node.kind === "definition" || treeState.hasChildren ? "button" : "div";
    const parentClass = treeState.hasChildren ? " definition-row--parent" : "";
    const expandedClass = treeState.hasChildren && treeState.expanded ? " is-expanded" : "";
    const toggle = treeState.hasChildren
      ? `<span class="tree-toggle" aria-hidden="true">${treeState.expanded ? "−" : "+"}</span>`
      : "";
    const label = node.kind === "definition"
      ? `<span class="definition-row__marker" aria-hidden="true">◇</span><span class="definition-row__text">${escapeHtml(node.label)}</span>`
      : `<span class="definition-row__text">${escapeHtml(node.label)}</span>`;
    return `
      <${tag} class="${rowClass}${parentClass}${expandedClass}${selected}" data-tree-node-id="${escapeAttr(node.id)}" data-tree-role="${role}">
        <span class="definition-row__ascii">${escapeHtml(treeState.connector)}</span>
        ${toggle}
        <span class="definition-row__label">${label}</span>
        <span class="definition-row__meta">${escapeHtml(node.meta || "")}</span>
      </${tag}>
    `;
  }

  function renderTimelineTreeRow(node, treeState) {
    const role = treeState.hasChildren ? "toggle" : node.timelineNode?.logId ? "activate" : "none";
    const tag = role === "none" ? "div" : "button";
    const staticClass = role === "none" ? " task-row--static" : "";
    const parentClass = treeState.hasChildren ? " task-row--parent" : "";
    const expandedClass = treeState.hasChildren && treeState.expanded ? " is-expanded" : "";
    const toggle = treeState.hasChildren
      ? `<span class="tree-toggle" aria-hidden="true">${treeState.expanded ? "−" : "+"}</span>`
      : "";
    return `
      <${tag}
        class="task-row${staticClass}${parentClass}${expandedClass}"
        data-tree-node-id="${escapeAttr(node.id)}"
        data-tree-role="${role}">
        <span class="task-row__ascii">${escapeHtml(treeState.connector)}</span>
        ${toggle}
        <span class="task-row__dot ${node.statusClass}"></span>
        <span class="task-row__label">${escapeHtml(node.label)}</span>
        <span class="task-row__meta">${escapeHtml(node.meta || "")}</span>
      </${tag}>
    `;
  }

  function bindTreeInteractions(host, options) {
    for (const element of host.querySelectorAll("[data-tree-node-id]")) {
      element.addEventListener("click", () => {
        const node = options.findNode(element.getAttribute("data-tree-node-id"));
        if (!node) {
          return;
        }
        const role = element.getAttribute("data-tree-role");
        if (role === "toggle") {
          toggleTreeNode(node, options.expandedState, options.autoExpandedIds, options.defaultExpanded);
          options.rerender();
          return;
        }
        if (role === "activate") {
          options.onActivate(node);
        }
      });
    }
  }

  function toggleTreeNode(node, expandedState, autoExpandedIds, defaultExpanded) {
    const current = isTreeNodeExpanded(node, expandedState, autoExpandedIds, defaultExpanded);
    expandedState[node.id] = !current;
  }

  function isTreeNodeExpanded(node, expandedState, autoExpandedIds, defaultExpanded) {
    if (autoExpandedIds.has(node.id)) {
      return true;
    }
    if (Object.prototype.hasOwnProperty.call(expandedState, node.id)) {
      return expandedState[node.id];
    }
    return defaultExpanded(node);
  }

  function findTreeNodeById(nodes, id) {
    for (const node of nodes) {
      if (node.id === id) {
        return node;
      }
      const nested = findTreeNodeById(node.children, id);
      if (nested) {
        return nested;
      }
    }
    return null;
  }

  function countLeafNodes(nodes) {
    let count = 0;
    for (const node of nodes) {
      if (!node.children.length && (node.kind === "definition" || node.kind === "task")) {
        count += 1;
        continue;
      }
      count += countLeafNodes(node.children);
    }
    return count;
  }

  function timelineNodeKind(node) {
    const type = String(node.type || "").toLowerCase();
    if (type === "stage") {
      return "stage";
    }
    if (type === "deployment") {
      return "deployment";
    }
    if (type === "job") {
      return "job";
    }
    if (type === "phase") {
      return "phase";
    }
    return "task";
  }

  function matchesWildcard(value, pattern) {
    if (!pattern) {
      return true;
    }
    const trimmed = pattern.trim();
    if (!trimmed) {
      return true;
    }
    const parts = trimmed.split(",").map((part) => part.trim()).filter(Boolean);
    if (!parts.length) {
      return true;
    }
    return parts.some((part) => {
      if (!part.includes("*")) {
        return value.toLowerCase().includes(part.toLowerCase());
      }
      const escaped = part.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
      const regex = new RegExp(`^${escaped}$`, "i");
      return regex.test(value);
    });
  }

  async function apiGet(path, options = {}) {
    const response = await fetch(`${bootstrap.apiBase}${path}`);
    const payload = await response.json();
    if (!response.ok || payload.ok === false) {
      const message = payload.error || `Request failed with ${response.status}`;
      if (options.showBanner !== false) {
        renderBanner(message);
      }
      throw new Error(message);
    }
    return payload;
  }

  async function apiPost(path, body, options = {}) {
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
      if (options.showBanner !== false) {
        renderBanner(message);
      }
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
      ? renderDismissibleMessage("global-banner", message, "default")
      : "";
    const close = document.getElementById("global-banner-close");
    if (close) {
      close.addEventListener("click", () => {
        renderBanner("");
      });
    }
  }

  function renderDismissibleMessage(id, message, kind) {
    const className = kind === "success"
      ? "banner banner--success"
      : kind === "error"
        ? "banner banner--error"
        : "banner";
    return `
      <div id="${escapeAttr(id)}" class="${className}">
        <div class="banner__body">${escapeHtml(message)}</div>
        <button id="${escapeAttr(`${id}-close`)}" class="message-close" type="button" aria-label="Close message">×</button>
      </div>
    `;
  }

  function setMainCachePill(cached, lastRefresh, title) {
    setCachePill(elements.mainCachePill, cached, lastRefresh, title, "");
  }

  function setDetailCachePill(cached, lastRefresh, title) {
    setCachePill(elements.detailCachePill, cached, lastRefresh, title, "");
  }

  function renderInlineCachePill(cached, lastRefresh, title) {
    return `<button id="task-inline-cache-pill" class="pill pill--button" title="${escapeAttr(title)}">${escapeHtml(formatCachePillLabel(cached, lastRefresh, ""))}</button>`;
  }

  function bindInlineTaskCachePill(taskName, logId, logLineCount, taskStatusClass, taskStartTime, taskFinishTime) {
    const button = document.getElementById("task-inline-cache-pill");
    if (!button) {
      return;
    }
    button.addEventListener("click", () => {
      void openTaskPane(taskName, logId, logLineCount, taskStatusClass, taskStartTime, taskFinishTime, true);
    });
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
    element.textContent = formatCachePillLabel(cached, lastRefresh, prefix);
  }

  function formatCachePillLabel(cached, lastRefresh, prefix) {
    const label = `${cached ? "Cached" : "Fresh"} · ${formatDate(lastRefresh)}`;
    return prefix ? `${prefix} · ${label}` : label;
  }

  function detailCard(label, value) {
    const text = String(value || "n/a");
    const valueClass = isTechnicalValue(text) ? "detail-card__value detail-card__value--technical" : "detail-card__value";
    return `<div class="detail-card"><p class="eyebrow">${escapeHtml(label)}</p><div class="${valueClass}" title="${escapeAttr(text)}">${escapeHtml(text)}</div></div>`;
  }

  function isTechnicalValue(value) {
    return value.startsWith("refs/") || value.includes("/") || value.includes("#");
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

  function formatTaskTiming(startTime, finishTime) {
    if (!startTime && !finishTime) {
      return "runtime unknown";
    }
    if (!startTime || !finishTime) {
      return `started ${formatDate(startTime || finishTime)}`;
    }
    const start = new Date(startTime);
    const finish = new Date(finishTime);
    const durationMs = finish.getTime() - start.getTime();
    return `${formatDate(startTime)} · ${formatDuration(durationMs)}`;
  }

  function formatDuration(durationMs) {
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      return "duration unknown";
    }
    const totalSeconds = Math.floor(durationMs / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) {
      return `${hours}h ${minutes}m ${seconds}s`;
    }
    if (minutes > 0) {
      return `${minutes}m ${seconds}s`;
    }
    return `${seconds}s`;
  }

  function mapTaskStatusCornerClass(statusClass) {
    if (statusClass === "task-row__dot--success") {
      return "build-item__corner--success";
    }
    if (statusClass === "task-row__dot--failed") {
      return "build-item__corner--failed";
    }
    return "build-item__corner--neutral";
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
