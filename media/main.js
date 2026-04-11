(function () {
  const vscode = acquireVsCodeApi();
  const bootstrap = window.__RELAY_BOOTSTRAP__;

  const state = {
    orgUrl: bootstrap.savedState.orgUrl || "",
    activeTheme: bootstrap.savedState.activeTheme || "neon"
  };

  const elements = {
    orgUrl: document.getElementById("org-url"),
    connectButton: document.getElementById("connect-button"),
    refreshButton: document.getElementById("refresh-button"),
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
    if (!session.authConfigured) {
      renderBanner(session.message);
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
      void loadProjects(true);
    });
  }

  async function loadProjects(forceRefresh) {
    state.orgUrl = elements.orgUrl.value.trim();
    persistState();
    renderBanner("");
    const url = `/api/org/projects?orgUrl=${encodeURIComponent(state.orgUrl)}${forceRefresh ? "&refresh=1" : ""}`;
    const response = await apiGet(url);
    renderProjects(response.projects);
    setCachePill(response.cached, response.lastRefresh);
    await emit("relay.ui.sidebar.projects.loaded", {
      count: response.projects.length,
      cached: response.cached
    }, "span");
  }

  function renderProjects(projects) {
    if (!projects.length) {
      elements.projectList.innerHTML = '<div class="empty-state empty-state--compact">No projects returned.</div>';
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
        vscode.postMessage({
          type: "openProject",
          project: project.name
        });
      });
      elements.projectList.appendChild(button);
    }
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

  function highlightProject(activeButton) {
    for (const element of elements.projectList.querySelectorAll(".project-item")) {
      element.classList.remove("is-active");
    }
    activeButton.classList.add("is-active");
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
