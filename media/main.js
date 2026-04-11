(function () {
  const vscode = acquireVsCodeApi();
  const bootstrap = window.__RELAY_BOOTSTRAP__;

  const state = {
    orgUrl: bootstrap.savedState.orgUrl || "",
    activeTheme: bootstrap.savedState.activeTheme || "githubdark",
    authConfigured: true,
    loadingProjects: false
  };

  const elements = {
    orgUrl: document.getElementById("org-url"),
    connectButton: document.getElementById("connect-button"),
    projectList: document.getElementById("project-list"),
    cachePill: document.getElementById("cache-pill"),
    messageBanner: document.getElementById("message-banner"),
    themeList: document.getElementById("theme-list"),
    themeCss: document.getElementById("theme-css")
  };

  init().catch((error) => {
    renderBanner(error.message || String(error));
  });

  async function init() {
    elements.orgUrl.value = state.orgUrl;
    bindEvents();
    renderThemes();
    applyTheme(state.activeTheme);
    await emit("relay.ui.sidebar.boot", { activeTheme: state.activeTheme }, "span");
    const session = await apiGet("/api/session");
    setAuthState(session.authConfigured, session.message);
    if (state.orgUrl) {
      await loadProjects(false);
    }
  }

  function bindEvents() {
    elements.connectButton.addEventListener("click", () => {
      void loadProjects(true).catch(handleLoadError);
    });
    elements.cachePill.addEventListener("click", () => {
      if (!state.orgUrl || !state.authConfigured || state.loadingProjects) {
        return;
      }
      void loadProjects(true).catch(handleLoadError);
    });
  }

  async function loadProjects(forceRefresh) {
    if (!state.authConfigured || state.loadingProjects) {
      return;
    }

    state.orgUrl = elements.orgUrl.value.trim();
    persistState();
    renderBanner("");
    setLoadingState(true);
    try {
      const url = `/api/org/projects?orgUrl=${encodeURIComponent(state.orgUrl)}${forceRefresh ? "&refresh=1" : ""}`;
      const response = await apiGet(url);
      renderProjects(response.projects);
      setCachePill(response.cached, response.lastRefresh);
      await emit("relay.ui.sidebar.projects.loaded", {
        count: response.projects.length,
        cached: response.cached
      }, "span");
    } finally {
      setLoadingState(false);
    }
  }

  function renderProjects(projects) {
    if (!projects.length) {
      elements.projectList.innerHTML = '<div class="empty-state empty-state--compact">No projects returned.</div>';
      return;
    }

    elements.projectList.innerHTML = "";
    for (const project of projects) {
      const card = document.createElement("div");
      card.className = "project-group";
      card.innerHTML = `
        <div class="project-group__title">
          <strong>${escapeHtml(project.name)}</strong>
        </div>
        <div class="project-group__meta muted">${escapeHtml(project.description || project.state || "Project")}</div>
        <div class="project-subnav">
          <button class="project-subnav__item" data-view="definitions">Definitions</button>
          <button class="project-subnav__item" data-view="artifacts">Artifacts</button>
        </div>
      `;
      for (const subview of card.querySelectorAll("[data-view]")) {
        subview.addEventListener("click", () => {
          highlightProject(card, subview.getAttribute("data-view"));
          vscode.postMessage({
            type: "openProject",
            project: project.name,
            view: subview.getAttribute("data-view")
          });
        });
      }
      elements.projectList.appendChild(card);
    }
  }

  function renderThemes() {
    const themeConfig = {
      githubdark: ["#2f81f7", "#30363d"],
      neon: ["#ff4fd8", "#56d7ff"],
      nightwave: ["#26b4ff", "#2effc8"],
      ember: ["#ff7a4f", "#ffcc5c"]
    };
    elements.themeList.innerHTML = "";
    for (const themeId of bootstrap.themeIds) {
      const swatch = document.createElement("button");
      swatch.className = "theme-swatch";
      swatch.style.background = `linear-gradient(135deg, ${themeConfig[themeId][0]}, ${themeConfig[themeId][1]})`;
      if (themeId === state.activeTheme) {
        swatch.classList.add("is-active");
      }
      swatch.addEventListener("click", () => {
        state.activeTheme = themeId;
        applyTheme(themeId);
        renderThemes();
        persistState();
        vscode.postMessage({
          type: "themeChanged",
          themeId
        });
      });
      elements.themeList.appendChild(swatch);
    }
  }

  function applyTheme(themeId) {
    elements.themeCss.setAttribute("href", bootstrap.themeUrls[themeId]);
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
      throw new Error(payload.error || `Request failed with ${response.status}`);
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

  function setCachePill(cached, lastRefresh) {
    elements.cachePill.textContent = `${cached ? "Cached" : "Fresh"} · ${formatDate(lastRefresh)}`;
  }

  function renderBanner(message) {
    elements.messageBanner.innerHTML = message
      ? `<div class="banner">${escapeHtml(message)}</div>`
      : "";
  }

  function setAuthState(authConfigured, message) {
    state.authConfigured = authConfigured;
    elements.connectButton.disabled = !authConfigured;
    elements.orgUrl.disabled = !authConfigured;

    if (!authConfigured) {
      elements.cachePill.textContent = "Auth Required";
      elements.projectList.innerHTML = '<div class="empty-state empty-state--compact">Set `ADO_TOKEN` and restart VS Code to load projects.</div>';
      renderBanner(message || "ADO_TOKEN is not set. Restart VS Code with ADO_TOKEN in the environment.");
      return;
    }

    elements.cachePill.textContent = "Idle";
  }

  function setLoadingState(isLoading) {
    state.loadingProjects = isLoading;
    elements.connectButton.disabled = isLoading || !state.authConfigured;
    elements.connectButton.textContent = isLoading ? "Loading..." : "Load Projects";
  }

  function handleLoadError(error) {
    const message = error?.message || String(error);
    if (/ADO_TOKEN/i.test(message)) {
      setAuthState(false, message);
      return;
    }
    renderBanner(message);
  }

  function highlightProject(activeCard, view) {
    for (const element of elements.projectList.querySelectorAll(".project-group")) {
      element.classList.remove("is-active");
      for (const subview of element.querySelectorAll(".project-subnav__item")) {
        subview.classList.remove("is-active");
      }
    }
    activeCard.classList.add("is-active");
    const target = activeCard.querySelector(`[data-view="${view}"]`);
    if (target) {
      target.classList.add("is-active");
    }
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
